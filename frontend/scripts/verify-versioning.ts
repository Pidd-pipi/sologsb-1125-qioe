/* eslint-disable no-console */
// 逻辑验证脚本：用 fake-indexeddb 跑通版本化阈值的全部关键路径。
// 运行：npx tsx scripts/verify-versioning.ts
import './fake-setup';
import { db, seedBaselineAndBackfill } from '../src/db';
import {
  discardDraft,
  getCurrentVersion,
  publishDraft,
  reaffirmAnalysis,
  saveDraft,
  PublishConflictError,
  previewPublishWithVersions,
} from '../src/services/versionService';
import { classifyByAnalysis } from '../src/utils/classify';
import { BASELINE_THRESHOLDS, BASELINE_VERSION_ID, cloneThresholds } from '../src/types/threshold';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

async function main() {
  // ---------- 1. 旧数据回填：无版本号 -> 最早区间 + 待核对 ----------
  console.log('\n[1] 旧数据回填基线版本并标记待核对');
  await db.samples.bulkAdd([
    {
      id: 's1',
      sampleNo: 'MET-2020-001',
      totalWeight: 100,
      category: 'chondrite',
      chemicalGroup: 'H',
      weathering: 'W1',
      fallOrFind: 'find',
      storage: 'cabinet-a',
      createdAt: 1,
      updatedAt: 1,
    },
  ]);
  await db.sections.bulkAdd([
    {
      id: 'sec1',
      sectionNo: 'TS-1',
      sampleId: 's1',
      thickness: 30,
      preparation: 'resin',
      minerals: { olivine: 40, pyroxene: 30, feldspar: 10, metal: 20 },
      micrographs: [],
      quality: 'good',
      createdAt: 1,
    },
  ]);
  // 两条旧检测记录：一条边界值（Fa 18.6 Ni 0.8），一条铁陨石
  await db.analysis.bulkAdd([
    {
      id: 'a1',
      sampleId: 's1',
      target: 'sample',
      method: 'microprobe',
      fa: 18.6,
      fs: 16.2,
      ni: 0.8,
      kamaciteBandwidth: 0.02,
      testedAt: '2020-01-01',
      createdAt: 1,
    },
    {
      id: 'a2',
      sampleId: 's1',
      target: 'sample',
      method: 'microprobe',
      fa: 3.2,
      fs: 4.1,
      ni: 7.4,
      kamaciteBandwidth: 0.62,
      testedAt: '2020-02-01',
      createdAt: 2,
    },
  ]);

  await db.transaction(
    'rw',
    [db.thresholdVersions, db.meta, db.samples, db.sections, db.analysis],
    async () => {
      await seedBaselineAndBackfill({
        thresholdVersions: db.thresholdVersions,
        meta: db.meta,
        samples: db.samples,
        sections: db.sections,
        analysis: db.analysis,
      });
    },
  );
  const cur0 = await getCurrentVersion();
  assert(cur0.id === BASELINE_VERSION_ID && cur0.code === 'v1', '当前版本为最早区间 v1');
  const oldA1 = await db.analysis.get('a1');
  assert(oldA1!.thresholdVersionId === BASELINE_VERSION_ID, '旧检测记录回填基线版本号');
  assert(oldA1!.reviewState === 'pending-review', '无版本号旧记录标记为待核对');
  assert(!!oldA1!.frozenAdvice && oldA1!.frozenAdvice!.versionCode === 'v1', '旧记录冻结最早区间结论');
  const oldSec = await db.sections.get('sec1');
  assert(oldSec!.thresholdVersionId === BASELINE_VERSION_ID, '旧切片回填基线版本号');
  const oldSample = await db.samples.get('s1');
  assert(oldSample!.thresholdVersionId === BASELINE_VERSION_ID, '旧样本回填基线版本号');

  // ---------- 2. 草稿不影响现有结论 ----------
  console.log('\n[2] 草稿保存但不生效');
  const draftSnap = cloneThresholds(BASELINE_THRESHOLDS);
  draftSnap.rules.highNiMin = 5;
  draftSnap.rules.wideBandMin = 0.8; // 把宽带阈值从 0.5 提到 0.8
  draftSnap.ranges.find((r) => r.key === 'kamaciteBandwidth')!.max = 3;
  await saveDraft({ thresholds: draftSnap, note: '2026 Q1 调整' });
  const curAfterDraft = await getCurrentVersion();
  assert(curAfterDraft.id === BASELINE_VERSION_ID, '存草稿后当前版本仍是 v1');
  // 现有记录结论不被草稿改写
  const a1Still = await db.analysis.get('a1');
  assert(a1Still!.reviewState === 'pending-review', '草稿不改写旧记录状态');

  // ---------- 3. 发布前预演 ----------
  console.log('\n[3] 发布预演统计失效数');
  const allAnalysis = await db.analysis.toArray();
  const versions = await db.thresholdVersions.toArray();
  const vmap = new Map(versions.map((v) => [v.id, v]));
  const preview = previewPublishWithVersions(draftSnap, allAnalysis, vmap);
  // a2: Ni 7.4 >=5，带宽 0.62 在旧规则 >=0.5 -> iron/high；新规则 0.62 <0.8 且不窄 -> stony-iron/medium
  const newA2 = classifyByAnalysis(
    { fa: 3.2, fs: 4.1, ni: 7.4, kamaciteBandwidth: 0.62 },
    draftSnap,
  );
  const frozenA2 = (await db.analysis.get('a2'))!.frozenAdvice!.advice;
  assert(frozenA2.category === 'iron', '原结论：a2 为铁陨石');
  assert(newA2.category === 'stony-iron', '新结论：a2 变为石铁陨石');
  assert(preview.staleCount === 1, `预演：1 条结论将失效（实际 ${preview.staleCount}）`);
  assert(preview.pendingSampleIds.has('s1'), '预演：样本 s1 进入待重新认定');

  // ---------- 4. 原子发布：共同绑定 + 立即失效 + 并排对比数据齐全 ----------
  console.log('\n[4] 发布：样本/切片/检测共同绑定，受影响建议失效');
  const outcome = await publishDraft();
  assert(outcome.version.code === 'v2', '新版本号为 v2');
  assert(outcome.staleAnalysisCount === 1, '发布报告 1 条建议失效');
  assert(outcome.pendingSampleCount === 1, '发布报告 1 份样本待重新认定');
  assert(outcome.reboundSectionCount === 1, '发布报告 1 张切片重新绑定');
  const cur1 = await getCurrentVersion();
  assert(cur1.code === 'v2', '发布后当前版本切换为 v2');
  const s1v2 = await db.samples.get('s1');
  const sec1v2 = await db.sections.get('sec1');
  const a1v2 = await db.analysis.get('a1');
  const a2v2 = await db.analysis.get('a2');
  assert(s1v2!.thresholdVersionId === cur1.id, '样本绑定 v2');
  assert(sec1v2!.thresholdVersionId === cur1.id, '切片绑定 v2');
  assert(a1v2!.thresholdVersionId === cur1.id, '检测记录 a1 绑定 v2');
  assert(a2v2!.thresholdVersionId === cur1.id, '检测记录 a2 绑定 v2');
  assert(a2v2!.reviewState === 'stale', 'a2 建议立即失效(stale)');
  // 原结论必须保留
  assert(a2v2!.frozenAdvice!.advice.category === 'iron', 'a2 原结论(iron)保留用于并排展示');
  assert(a2v2!.frozenAdvice!.versionCode === 'v1', 'a2 原结论标注历史版本 v1');
  // 按新版本重算得到新结论
  const recomputedA2 = classifyByAnalysis(a2v2!, cur1.thresholds);
  assert(recomputedA2.category === 'stony-iron', 'a2 按 v2 重算为石铁陨石');
  // a1 结论未变；且它是 pending-review，状态不应被发布自动翻案
  assert(a1v2!.reviewState === 'pending-review', 'a1 结论未变且保留待核对（不自动翻案）');
  assert(s1v2!.reviewState === 'pending', '样本 s1 分类待重新认定');
  assert(s1v2!.suggestedCategory === 'stony-iron', '样本建议分类为石铁陨石');
  // v1 仍然存在且不可改语义
  const v1row = await db.thresholdVersions.get(BASELINE_VERSION_ID);
  assert(v1row!.status === 'published', '历史版本 v1 仍保留');
  assert(cur1.note === '2026 Q1 调整', 'v2 备注冻结');

  // ---------- 5. 人工重新认定 ----------
  console.log('\n[5] 人工决定是否重新认定');
  await reaffirmAnalysis('a2', true);
  const a2re = await db.analysis.get('a2');
  assert(a2re!.reviewState === 'confirmed', '采用新结论后 a2 变已认定');
  assert(a2re!.frozenAdvice!.versionCode === 'v2', '重新认定后冻结结论切换为 v2 版本');
  assert(a2re!.frozenAdvice!.advice.category === 'stony-iron', '冻结的新结论为石铁陨石');
  // a2 是 s1 唯一 stale 记录 -> 样本待认定解除
  const s1After = await db.samples.get('s1');
  assert(s1After!.reviewState === 'confirmed', '失效记录全部处理后样本退出待认定');
  assert(s1After!.category === 'chondrite', '样本正式分类未被自动改写（仍为原分类）');

  // 旧记录核对：保留原结论
  await reaffirmAnalysis('a1', false);
  const a1re = await db.analysis.get('a1');
  assert(a1re!.reviewState === 'confirmed', 'a1 核对无误后已认定');
  assert(a1re!.frozenAdvice!.versionCode === 'v1', '保留原结论时仍依据 v1');

  // ---------- 6. 已发布版本不可改：再次发布必须产生新版本 ----------
  console.log('\n[6] 已发布版本不可变，调整只能产生新版本');
  const snap3 = cloneThresholds(cur1.thresholds);
  snap3.rules.lowNiMax = 1.5;
  await saveDraft({ thresholds: snap3, note: '2026 Q2 调整' });
  const outcome3 = await publishDraft();
  assert(outcome3.version.code === 'v3', '再次发布产生 v3');
  const v2row = await db.thresholdVersions.get(cur1.id);
  assert(v2row!.thresholds.rules.wideBandMin === 0.8, 'v2 阈值未被改写（冻结）');
  assert(v2row!.note === '2026 Q1 调整', 'v2 备注不可改');

  // ---------- 7. 发布失败保留原版本与草稿（非法草稿回滚） ----------
  console.log('\n[7] 发布失败整体回滚，原版本与草稿保留');
  const beforeMeta = await db.meta.get('current');
  const badSnap = cloneThresholds(BASELINE_THRESHOLDS);
  badSnap.ranges.find((r) => r.key === 'ni')!.min = 99; // min>max 非法
  await saveDraft({ thresholds: snap3, note: '合法占位草稿' }); // 先存合法
  // 直接在库里把草稿改成非法（绕过 saveDraft 校验），验证 publish 事务回滚
  await db.thresholdVersions.update('threshold_draft', { thresholds: badSnap });
  let threw = false;
  try {
    await publishDraft();
  } catch {
    threw = true;
  }
  assert(threw, '非法草稿发布抛错');
  const afterMeta = await db.meta.get('current');
  assert(afterMeta!.currentVersionId === beforeMeta!.currentVersionId, '失败后 current 仍指向 v3');
  assert(afterMeta!.revision === beforeMeta!.revision, '失败后 revision 不变');
  const draftStill = await db.thresholdVersions.get('threshold_draft');
  assert(!!draftStill, '失败后草稿行保留');

  // ---------- 8. 两个页面同时提交：只有一份生效 ----------
  console.log('\n[8] 并发发布互斥：两份提交仅一份生效');
  await discardDraft();
  const snap4 = cloneThresholds((await getCurrentVersion()).thresholds);
  snap4.rules.highNiMin = 6;
  await saveDraft({ thresholds: snap4, note: '并发测试草稿' });
  const revBefore = (await db.meta.get('current'))!.revision;
  const results = await Promise.allSettled([publishDraft(), publishDraft()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert(fulfilled.length === 1, `恰好一份发布成功（成功 ${fulfilled.length}）`);
  assert(rejected.length === 1, `另一份被拒绝（失败 ${rejected.length}）`);
  assert(
    rejected[0]!.status === 'rejected' && rejected[0]!.reason instanceof PublishConflictError,
    '失败方为并发冲突错误',
  );
  const metaFinal = await db.meta.get('current');
  assert(metaFinal!.revision === revBefore + 1, 'revision 仅增加一次');
  const publishedCount = await db.thresholdVersions
    .where('status')
    .equals('published')
    .count();
  // v1 baseline + v2 + v3 + 并发成功的一个 = 4
  assert(publishedCount === 4, `已发布版本数为 4（实际 ${publishedCount}），没有重复发布`);
  const draftGone = await db.thresholdVersions.get('threshold_draft');
  assert(!draftGone, '草稿只被消费一次');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
