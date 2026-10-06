import { db, makeId } from '../db';
import type { AdviceReviewLog, AnalysisRecord, AnalysisReviewState } from '../types/analysis';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';
import {
  DRAFT_THRESHOLD_VERSION_ID,
  cloneThresholdSet,
  cloneVersion,
  type ThresholdSet,
  type ThresholdVersion,
} from '../types/threshold';
import {
  adviceDiffers,
  classifyByAnalysis,
  toAdviceSnapshot,
} from '../utils/classify';

/** 发布冲突：草稿基线已被另一份发布超越（两个页面同时提交时只有一份生效） */
export class PublishConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishConflictError';
  }
}

/** 跨标签页同步通道：发布 / 草稿 / 复核后通知其它页面重新装载 */
const CHANNEL_NAME = 'gbmeteorite-thresholds';
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export type ThresholdEventType = 'published' | 'draft-saved' | 'draft-discarded' | 'review-resolved';

export function emitThresholdEvent(type: ThresholdEventType): void {
  getChannel()?.postMessage({ type, at: Date.now() });
}

export function onThresholdEvent(handler: (type: ThresholdEventType) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  const listener = (e: MessageEvent<{ type: ThresholdEventType }>) => handler(e.data.type);
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/** 当前生效版本（revision 最大的 published 版本） */
export async function getActiveVersion(): Promise<ThresholdVersion | null> {
  const published = await db.thresholdVersions.where('status').equals('published').toArray();
  if (published.length === 0) return null;
  return published.reduce((a, b) => (a.revision >= b.revision ? a : b));
}

/** 当前草稿（全局至多一份） */
export async function getDraft(): Promise<ThresholdVersion | null> {
  return (await db.thresholdVersions.get(DRAFT_THRESHOLD_VERSION_ID)) ?? null;
}

/** 全部版本：已发布按版本号倒序，草稿置顶 */
export async function listVersions(): Promise<ThresholdVersion[]> {
  const all = await db.thresholdVersions.toArray();
  const drafts = all.filter((v) => v.status === 'draft');
  const published = all
    .filter((v) => v.status === 'published')
    .sort((a, b) => b.revision - a.revision);
  return [...drafts, ...published];
}

/** 以某版本为基线另存草稿（已发布历史版本本身不可改） */
export async function saveDraft(input: {
  base: ThresholdVersion;
  name: string;
  note?: string;
  thresholds: ThresholdSet;
}): Promise<ThresholdVersion> {
  const now = Date.now();
  const existing = await db.thresholdVersions.get(DRAFT_THRESHOLD_VERSION_ID);
  const draft: ThresholdVersion = {
    id: DRAFT_THRESHOLD_VERSION_ID,
    // 草稿基线版本号：发布时必须仍等于当前生效版本号，否则判为冲突
    revision: input.base.status === 'draft' ? input.base.revision : input.base.revision,
    status: 'draft',
    name: input.name.trim() || `基于第 ${input.base.revision} 版的草稿`,
    note: input.note?.trim() || undefined,
    thresholds: cloneThresholdSet(input.thresholds),
    publishedAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.thresholdVersions.put(draft);
  emitThresholdEvent('draft-saved');
  return draft;
}

/** 放弃草稿（不影响任何已发布版本与既有绑定） */
export async function discardDraft(): Promise<void> {
  await db.thresholdVersions.delete(DRAFT_THRESHOLD_VERSION_ID);
  emitThresholdEvent('draft-discarded');
}

export interface PublishPreview {
  /** 分类结论发生变化、发布后需重新认定的检测记录数 */
  affectedAnalysisCount: number;
  /** 受影响样本数（去重） */
  affectedSampleCount: number;
  /** 发布后将共同绑定新版本的记录规模 */
  bindSampleCount: number;
  bindSectionCount: number;
  bindAnalysisCount: number;
}

/** 预演发布：不写库，仅统计受影响范围 */
export async function previewPublish(draft: ThresholdVersion): Promise<PublishPreview> {
  const [samples, sections, analysis] = await Promise.all([
    db.samples.toArray(),
    db.sections.toArray(),
    db.analysis.toArray(),
  ]);
  const affectedSamples = new Set<string>();
  let affectedAnalysisCount = 0;
  for (const rec of analysis) {
    const newAdvice = toAdviceSnapshot(
      classifyByAnalysis(
        {
          fa: Number(rec.fa) || 0,
          fs: Number(rec.fs) || 0,
          ni: Number(rec.ni) || 0,
          kamaciteBandwidth: Number(rec.kamaciteBandwidth) || 0,
        },
        draft.thresholds,
      ),
    );
    if (adviceDiffers(rec.boundAdvice, newAdvice)) {
      affectedAnalysisCount += 1;
      affectedSamples.add(rec.sampleId);
    }
  }
  return {
    affectedAnalysisCount,
    affectedSampleCount: affectedSamples.size,
    bindSampleCount: samples.length,
    bindSectionCount: sections.length,
    bindAnalysisCount: analysis.length,
  };
}

export interface PublishResult {
  version: ThresholdVersion;
  affectedAnalysisIds: string[];
}

/**
 * 发布草稿（单事务原子完成，失败则全部回滚、保留原版本）：
 *  1. 乐观锁：草稿基线版本号必须等于当前生效版本号；
 *     两个页面同时提交时，事务串行执行，后到者会发现基线已被超越 → 抛 PublishConflictError
 *  2. 冻结出新版本，删除草稿
 *  3. 样本 / 切片 / 检测记录共同绑定新版本
 *  4. 结论受影响的检测记录：原结论快照保留为 previousAdvice，立即置「待核对」
 */
export async function publishDraft(input: {
  name: string;
  note?: string;
  publishedBy?: string;
}): Promise<PublishResult> {
  const now = Date.now();
  const affectedAnalysisIds: string[] = [];
  let newVersion: ThresholdVersion | null = null;

  await db.transaction(
    'rw',
    db.thresholdVersions,
    db.samples,
    db.sections,
    db.analysis,
    async () => {
      const draft = await db.thresholdVersions.get(DRAFT_THRESHOLD_VERSION_ID);

      // 事务内联查生效版本，避免非事务 Promise 混入 Dexie 事务
      const publishedList = await db.thresholdVersions
        .where('status')
        .equals('published')
        .toArray();
      const activeRevision = publishedList.reduce((m, v) => Math.max(m, v.revision), 0);

      if (!draft) {
        // 同一草稿被两个页面并发提交：先到者已发布并删除草稿，
        // 对后到者统一报冲突（只有一份生效），而非通用「草稿不存在」
        throw new PublishConflictError(
          activeRevision > 0
            ? `草稿已被另一份提交发布（当前第 ${activeRevision} 版），本次提交未生效。`
            : '草稿不存在或已被发布，无法重复提交',
        );
      }

      if (draft.revision !== activeRevision) {
        throw new PublishConflictError(
          `草稿基于第 ${draft.revision} 版，当前已生效第 ${activeRevision} 版，存在并发发布，请刷新后以最新版本另起草稿。`,
        );
      }

      const revision = activeRevision + 1;
      newVersion = {
        ...cloneVersion(draft),
        id: makeId('threshold_version'),
        revision,
        status: 'published',
        name: input.name.trim() || draft.name || `第 ${revision} 版阈值`,
        note: input.note?.trim() || draft.note,
        publishedBy: input.publishedBy?.trim() || draft.publishedBy,
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      // 先删草稿、再落新版本；任一步失败整事务回滚，草稿与旧版本都保留
      await db.thresholdVersions.delete(DRAFT_THRESHOLD_VERSION_ID);
      await db.thresholdVersions.add(newVersion);
      const newVersionId = newVersion.id;

      // 样本、切片共同绑定同一版本
      await db.samples.toCollection().modify((sample: MeteoriteSample) => {
        sample.thresholdVersionId = newVersionId;
        sample.updatedAt = now;
      });
      await db.sections.toCollection().modify((section: ThinSection) => {
        section.thresholdVersionId = newVersionId;
      });

      // 检测记录：复算结论，受影响者原结论保留并排展示、立即置待核对
      await db.analysis.toCollection().modify((rec: AnalysisRecord) => {
        const oldAdvice = rec.boundAdvice;
        const oldVersionId = rec.thresholdVersionId;
        const newAdvice = toAdviceSnapshot(
          classifyByAnalysis(
            {
              fa: Number(rec.fa) || 0,
              fs: Number(rec.fs) || 0,
              ni: Number(rec.ni) || 0,
              kamaciteBandwidth: Number(rec.kamaciteBandwidth) || 0,
            },
            newVersion!.thresholds,
          ),
        );
        const differed = adviceDiffers(oldAdvice, newAdvice);

        rec.thresholdVersionId = newVersionId;
        rec.previousThresholdVersionId = oldVersionId;
        rec.boundAdvice = newAdvice;
        rec.previousAdvice = differed ? oldAdvice : null;

        if (differed) {
          rec.reviewState = 'pending';
          rec.reviewChangedAt = now;
          affectedAnalysisIds.push(rec.id);
        } else if (rec.reviewState === 'kept-original' || rec.reviewState === 'adopted-new') {
          // 此前已人工处理、本次结论又无变化：恢复为已认定
          rec.reviewState = 'current';
          rec.reviewChangedAt = null;
        }
        // backfilled 的待核对记录即便结论无变化也继续保留「待核对」，等待人工确认回填无误
      });
    },
  );

  if (!newVersion) throw new Error('发布失败：未生成新版本');
  emitThresholdEvent('published');
  return { version: newVersion, affectedAnalysisIds };
}

export type ReviewDecision = Extract<AnalysisReviewState, 'current' | 'kept-original' | 'adopted-new'>;

/**
 * 人工复核决定：
 *  - current：核对无误（回填记录确认 / 无变化确认）
 *  - kept-original：保留原结论，样本分类不改动
 *  - adopted-new：按新结论重新认定，并把样本正式分类同步为新分类
 * 每次决定写一条审计日志。
 */
export async function resolveReview(input: {
  analysisId: string;
  decision: ReviewDecision;
  note?: string;
  updateSampleCategory?: boolean;
}): Promise<void> {
  await db.transaction('rw', db.analysis, db.samples, db.adviceReviewLogs, async () => {
    const rec = await db.analysis.get(input.analysisId);
    if (!rec) throw new Error('检测记录不存在');
    const now = Date.now();

    const patch: Partial<AnalysisRecord> = {
      reviewState: input.decision,
      reviewChangedAt: now,
    };
    await db.analysis.update(rec.id, patch);

    if (input.decision === 'adopted-new' && input.updateSampleCategory) {
      await db.samples.update(rec.sampleId, {
        category: rec.boundAdvice.category,
        updatedAt: now,
      });
    }

    const log: AdviceReviewLog = {
      id: makeId('review_log'),
      analysisId: rec.id,
      decision: input.decision,
      thresholdVersionId: rec.thresholdVersionId,
      previousThresholdVersionId: rec.previousThresholdVersionId ?? null,
      note: input.note?.trim() || undefined,
      createdAt: now,
    };
    await db.adviceReviewLogs.add(log);
  });
  emitThresholdEvent('review-resolved');
}

/** 读取某条检测记录的复核审计日志（倒序） */
export async function listReviewLogs(analysisId: string): Promise<AdviceReviewLog[]> {
  const logs = await db.adviceReviewLogs.where('analysisId').equals(analysisId).toArray();
  return logs.sort((a, b) => b.createdAt - a.createdAt);
}
