import { baselineVersion, db, DRAFT_VERSION_ID, makeId } from '../db';
import {
  adviceChanged,
  cloneThresholds,
  majorityCategory,
  validateThresholds,
  BASELINE_VERSION_ID,
  type PublishOutcome,
  type SampleCategory,
  type ThresholdSnapshot,
  type ThresholdVersion,
} from '../types/threshold';
import { classifyByAnalysis } from '../utils/classify';
import type { AnalysisRecord } from '../types/analysis';

/** 并发发布冲突：另一个页面/标签已经抢先发布 */
export class PublishConflictError extends Error {}

/** 跨标签页同步通道：发布/重新认定后通知其它页面重载 */
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('gbmeteorite-version') : null;

export function broadcastVersionChanged(reason: 'publish' | 'reaffirm' | 'draft'): void {
  channel?.postMessage({ reason, at: Date.now() });
}

export function onVersionChanged(handler: () => void): () => void {
  if (!channel) return () => undefined;
  const listener = () => handler();
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

/** 当前生效版本；任何异常都回退到内存中的最早区间，保证页面可用 */
export async function getCurrentVersion(): Promise<ThresholdVersion> {
  const meta = await db.meta.get('current');
  if (meta) {
    const v = await db.thresholdVersions.get(meta.currentVersionId);
    if (v && v.status === 'published') return v;
  }
  const baseline = await db.thresholdVersions.get(BASELINE_VERSION_ID);
  if (baseline) return baseline;
  // 极端情况下版本行缺失，返回内存基线，不阻塞录入
  return baselineVersion(Date.now());
}

export async function listVersions(): Promise<ThresholdVersion[]> {
  const rows = await db.thresholdVersions.toArray();
  return rows.sort((a, b) => {
    // 草稿始终排在最后
    if (a.status === 'draft') return 1;
    if (b.status === 'draft') return -1;
    return (b.sequence ?? 0) - (a.sequence ?? 0);
  });
}

export async function getDraft(): Promise<ThresholdVersion | undefined> {
  return db.thresholdVersions.get(DRAFT_VERSION_ID);
}

/** 新区间先存草稿：草稿可反复覆盖，已发布版本永不修改 */
export async function saveDraft(input: {
  thresholds: ThresholdSnapshot;
  note: string;
}): Promise<ThresholdVersion> {
  const errors = validateThresholds(input.thresholds);
  if (errors.length) throw new Error(errors.join('；'));

  const existing = await db.thresholdVersions.get(DRAFT_VERSION_ID);
  const draft: ThresholdVersion = existing
    ? { ...existing, thresholds: cloneThresholds(input.thresholds), note: input.note }
    : {
        id: DRAFT_VERSION_ID,
        code: null,
        note: input.note,
        status: 'draft',
        thresholds: cloneThresholds(input.thresholds),
        sequence: null,
        createdAt: Date.now(),
        publishedAt: null,
      };
  await db.thresholdVersions.put(draft);
  broadcastVersionChanged('draft');
  return draft;
}

export async function discardDraft(): Promise<void> {
  await db.thresholdVersions.delete(DRAFT_VERSION_ID);
  broadcastVersionChanged('draft');
}

/** 发布前预演（带历史版本映射）：统计将有多少检测记录结论失效、多少样本待重新认定 */
export function previewPublishWithVersions(
  thresholds: ThresholdSnapshot,
  analysis: AnalysisRecord[],
  versionMap: Map<string, ThresholdVersion>,
): {
  staleCount: number;
  pendingSampleIds: Set<string>;
  changes: { id: string; changed: boolean }[];
} {
  let staleCount = 0;
  const pendingSampleIds = new Set<string>();
  const changes: { id: string; changed: boolean }[] = [];
  for (const rec of analysis) {
    const oldVersion =
      (rec.frozenAdvice?.versionId && versionMap.get(rec.frozenAdvice.versionId)) || undefined;
    const oldAdvice =
      rec.frozenAdvice?.advice ??
      (oldVersion
        ? classifyByAnalysis(rec, oldVersion.thresholds)
        : classifyByAnalysis(rec, thresholds));
    const newAdvice = classifyByAnalysis(rec, thresholds);
    const changedFlag = adviceChanged(oldAdvice, newAdvice);
    changes.push({ id: rec.id, changed: changedFlag });
    if (changedFlag) {
      staleCount++;
      pendingSampleIds.add(rec.sampleId);
    }
  }
  return { staleCount, pendingSampleIds, changes };
}

/**
 * 原子发布草稿：
 *  1. 新建已发布版本行（已发布内容此后不可改）
 *  2. 全部样本 / 切片 / 检测记录在同一事务内共同绑定新版本
 *  3. 结论受影响的检测记录置 stale（原冻结结论保留），相关样本置 pending 并给出建议分类
 *  4. 推进 current 元信息（revision+1），删除草稿行
 * 任一步失败整个事务回滚，current 仍指向原版本、草稿也保留。
 * 两个页面/标签同时提交时，IDB 事务串行化 + 草稿行临界区保证只有一份生效。
 */
export async function publishDraft(): Promise<PublishOutcome> {
  // Dexie v4 不把事务回调返回值透出，结果用外层变量承接
  let outcome: PublishOutcome | null = null;
  await db.transaction(
    'rw',
    db.thresholdVersions,
    db.meta,
    db.analysis,
    db.samples,
    db.sections,
    async () => {
      const draft = await db.thresholdVersions.get(DRAFT_VERSION_ID);
      if (!draft) {
        throw new PublishConflictError('草稿已被另一个页面发布，当前仍以先发布的版本为准');
      }
      const errors = validateThresholds(draft.thresholds);
      if (errors.length) throw new Error(errors.join('；'));

      const meta = await db.meta.get('current');
      if (!meta) throw new Error('版本元信息缺失，无法发布');

      const now = Date.now();
      const newSequence = meta.sequence + 1;
      const published: ThresholdVersion = {
        id: makeId('threshold'),
        code: `v${newSequence}`,
        note: draft.note,
        status: 'published',
        // 快照随版本冻结
        thresholds: cloneThresholds(draft.thresholds),
        sequence: newSequence,
        createdAt: draft.createdAt,
        publishedAt: now,
      };
      // 新版本行先落库：此后该版本内容冻结，不可再改
      await db.thresholdVersions.add(published);

      const newSnap = published.thresholds;

      // 先读出现有数据，在 modify 回调之外完成统计与聚合，
      // Dexie 的 modify 回调不保证对外层局部变量的副作用可见。
      const allAnalysis = await db.analysis.toArray();
      const allSamples = await db.samples.toArray();
      const allSections = await db.sections.toArray();

      const sampleAgg = new Map<string, SampleCategory[]>();
      let staleAnalysisCount = 0;

      // 检测记录：共同绑定新版本；受影响的立即失效，原结论保留在 frozenAdvice
      const nextAnalysis = allAnalysis.map((rec) => {
        const oldAdvice = rec.frozenAdvice?.advice ?? classifyByAnalysis(rec, newSnap);
        const newAdvice = classifyByAnalysis(rec, newSnap);
        const wasPendingReview = rec.reviewState === 'pending-review';
        const wasStale = rec.reviewState === 'stale';
        const next: AnalysisRecord = { ...rec, thresholdVersionId: published.id };
        if (adviceChanged(oldAdvice, newAdvice)) {
          next.reviewState = 'stale';
          staleAnalysisCount++;
          const list = sampleAgg.get(rec.sampleId) ?? [];
          list.push(newAdvice.category);
          sampleAgg.set(rec.sampleId, list);
        } else if (wasStale || wasPendingReview) {
          // 已失效待认定 / 旧记录待核对：都保留原状态，必须由人工核对，不因再发布而自动翻案
          next.reviewState = rec.reviewState;
        } else {
          next.reviewState = 'confirmed';
        }
        return next;
      });
      if (nextAnalysis.length) await db.analysis.bulkPut(nextAnalysis);

      // 样本：共同绑定；受影响的给出建议分类，等待人工决定是否重新认定
      let pendingSampleCount = 0;
      const nextSamples = allSamples.map((sample) => {
        const next: typeof sample = { ...sample, thresholdVersionId: published.id };
        const cats = sampleAgg.get(sample.id);
        if (cats && cats.length > 0) {
          next.reviewState = 'pending';
          next.suggestedCategory = majorityCategory(cats) ?? sample.suggestedCategory;
          pendingSampleCount++;
        } else if (sample.reviewState === 'pending') {
          // 上一版尚待人工认定、本版又没有新增失效：不自动“洗白”，保留待认定状态
          pendingSampleCount++;
        }
        return next;
      });
      if (nextSamples.length) await db.samples.bulkPut(nextSamples);

      // 切片：共同绑定同一版本
      const nextSections = allSections.map((section) => ({
        ...section,
        thresholdVersionId: published.id,
      }));
      const reboundSectionCount = nextSections.length;
      if (nextSections.length) await db.sections.bulkPut(nextSections);

      await db.meta.put({
        key: 'current',
        currentVersionId: published.id,
        sequence: newSequence,
        revision: meta.revision + 1,
        updatedAt: now,
      });
      // 草稿行最后删除：并发的第二个发布会读不到该行而整体回滚
      await db.thresholdVersions.delete(DRAFT_VERSION_ID);

      outcome = {
        version: published,
        staleAnalysisCount,
        pendingSampleCount,
        reboundSectionCount,
      };
    },
  );

  broadcastVersionChanged('publish');
  return outcome!;
}

/**
 * 对单条检测记录做人工复核：
 *  - adoptNew=true：按当前版本重算并冻结为新结论（重新认定）
 *  - adoptNew=false：保留原冻结结论，仅将其标记为已核对/认定
 */
export async function reaffirmAnalysis(id: string, adoptNew: boolean): Promise<void> {
  await db.transaction('rw', db.analysis, db.samples, db.meta, db.thresholdVersions, async () => {
    const rec = await db.analysis.get(id);
    if (!rec) return;
    const current = await getCurrentVersion();
    const now = Date.now();

    if (adoptNew) {
      rec.frozenAdvice = {
        versionId: current.id,
        versionCode: current.code ?? 'v?',
        advice: classifyByAnalysis(rec, current.thresholds),
        frozenAt: now,
      };
    }
    rec.thresholdVersionId = current.id;
    rec.reviewState = 'confirmed';
    rec.reviewedAt = now;
    await db.analysis.put(rec);
    await refreshSampleReview(rec.sampleId);
  });
  broadcastVersionChanged('reaffirm');
}

/** 若样本下已无失效记录，则结束样本的待重新认定状态（不自动改分类） */
async function refreshSampleReview(sampleId: string): Promise<void> {
  const sample = await db.samples.get(sampleId);
  if (!sample || sample.reviewState !== 'pending') return;
  const remaining = await db.analysis
    .where('sampleId')
    .equals(sampleId)
    .filter((r) => r.reviewState === 'stale')
    .count();
  if (remaining === 0) {
    sample.reviewState = 'confirmed';
    sample.suggestedCategory = undefined;
    sample.reviewedAt = Date.now();
    await db.samples.put(sample);
  }
}

/**
 * 对样本分类做人工决定：
 *  - adopt=true：采用新版本建议分类（重新认定）
 *  - adopt=false：保留原分类，结束待认定状态
 */
export async function reaffirmSample(sampleId: string, adopt: boolean): Promise<void> {
  await db.transaction('rw', db.samples, db.analysis, async () => {
    const sample = await db.samples.get(sampleId);
    if (!sample) return;
    if (adopt && sample.suggestedCategory) {
      sample.category = sample.suggestedCategory;
    }
    sample.reviewState = 'confirmed';
    sample.suggestedCategory = undefined;
    sample.reviewedAt = Date.now();
    await db.samples.put(sample);
    // 样本级决定即代表对其下检测记录的结论一并完成人工核对
    await db.analysis
      .where('sampleId')
      .equals(sampleId)
      .filter((r) => r.reviewState === 'stale')
      .modify({ reviewState: 'confirmed', reviewedAt: Date.now() });
  });
  broadcastVersionChanged('reaffirm');
}

/** 录入新检测记录时绑定的版本与冻结结论 */
export async function freezeAdviceForInput(input: {
  fa: number;
  fs: number;
  ni: number;
  kamaciteBandwidth: number;
}): Promise<{ versionId: string; versionCode: string; frozenAdvice: AnalysisRecord['frozenAdvice'] }> {
  const current = await getCurrentVersion();
  return {
    versionId: current.id,
    versionCode: current.code ?? 'v?',
    frozenAdvice: {
      versionId: current.id,
      versionCode: current.code ?? 'v?',
      advice: classifyByAnalysis(input, current.thresholds),
      frozenAt: Date.now(),
    },
  };
}
