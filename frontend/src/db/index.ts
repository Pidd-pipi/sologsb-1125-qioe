import Dexie, { type Table } from 'dexie';
import type { MeteoriteSample } from '../types/sample';
import type { FindRecord } from '../types/find';
import type { ThinSection } from '../types/section';
import type { AdviceReviewLog, AnalysisRecord } from '../types/analysis';
import type { ThresholdVersion } from '../types/threshold';
import {
  DRAFT_THRESHOLD_VERSION_ID,
  INITIAL_REVISION,
  INITIAL_THRESHOLD_SET,
  INITIAL_THRESHOLD_VERSION_ID,
} from '../types/threshold';
import { classifyByAnalysis, toAdviceSnapshot } from '../utils/classify';

/** 库名固定为 gbmeteorite-db */
export const DB_NAME = 'gbmeteorite-db';

/**
 * 版本历史（IndexedDB 升级迁移）：
 *  - v1：建 samples / finds / sections 三张表
 *  - v2：新增 analysis 表，并为 analysis 加 sampleId 索引
 *  - v3：为 samples 补 updatedAt 字段，并按 id 回填旧记录
 *  - v4：阈值版本化
 *      · 新增 thresholdVersions / adviceReviewLogs 表
 *      · 写入冻结的初始阈值版本
 *      · 旧检测记录没有版本号：按最早区间回填、快照当时结论并标记待核对（backfilled）
 *      · 样本 / 切片统一绑定初始版本
 */
export class MeteoriteDB extends Dexie {
  samples!: Table<MeteoriteSample, string>;
  finds!: Table<FindRecord, string>;
  sections!: Table<ThinSection, string>;
  analysis!: Table<AnalysisRecord, string>;
  thresholdVersions!: Table<ThresholdVersion, string>;
  adviceReviewLogs!: Table<AdviceReviewLog, string>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
      finds: 'id, sampleId, region, createdAt',
      sections: 'id, sectionNo, sampleId, thickness, createdAt',
    });

    this.version(2)
      .stores({
        samples: 'id, sampleNo, category, chemicalGroup, totalWeight, createdAt',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // v2：旧记录补齐新表所需字段，避免读取时 undefined
        await tx
          .table<AnalysisRecord, string>('analysis')
          .toCollection()
          .modify((rec) => {
            if (typeof rec.createdAt !== 'number') rec.createdAt = Date.now();
          });
      });

    this.version(3)
      .stores({
        samples:
          'id, sampleNo, category, chemicalGroup, totalWeight, createdAt, updatedAt',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis: 'id, sampleId, sectionId, method, testedAt, createdAt',
      })
      .upgrade(async (tx) => {
        // v3：为样本表补 updatedAt，并按 id 回填旧记录
        await tx
          .table<MeteoriteSample, string>('samples')
          .toCollection()
          .modify((sample) => {
            if (typeof sample.updatedAt !== 'number') {
              sample.updatedAt =
                typeof sample.createdAt === 'number' ? sample.createdAt : Date.now();
            }
          });
      });

    this.version(4)
      .stores({
        samples:
          'id, sampleNo, category, chemicalGroup, totalWeight, thresholdVersionId, createdAt, updatedAt',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, thresholdVersionId, createdAt',
        analysis:
          'id, sampleId, sectionId, method, testedAt, thresholdVersionId, reviewState, createdAt',
        thresholdVersions: 'id, revision, status, publishedAt',
        adviceReviewLogs: 'id, analysisId, thresholdVersionId, createdAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();

        // 1) 写入冻结的「最早区间」初始版本（若缺失）
        const versions = tx.table<ThresholdVersion, string>('thresholdVersions');
        const existingInitial = await versions.get(INITIAL_THRESHOLD_VERSION_ID);
        if (!existingInitial) {
          await versions.add({
            id: INITIAL_THRESHOLD_VERSION_ID,
            revision: INITIAL_REVISION,
            status: 'published',
            name: '初始阈值（历史内置区间）',
            note: '系统内置的最早 Fa / Fs / Ni / 铁纹石带宽区间，旧检测记录按此版本回填。',
            thresholds: INITIAL_THRESHOLD_SET,
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        // 2) 旧样本 / 切片绑定初始版本
        await tx
          .table<MeteoriteSample, string>('samples')
          .toCollection()
          .modify((sample) => {
            if (!sample.thresholdVersionId) {
              sample.thresholdVersionId = INITIAL_THRESHOLD_VERSION_ID;
            }
            if (typeof sample.updatedAt !== 'number') {
              sample.updatedAt =
                typeof sample.createdAt === 'number' ? sample.createdAt : now;
            }
          });
        await tx
          .table<ThinSection, string>('sections')
          .toCollection()
          .modify((section) => {
            if (!section.thresholdVersionId) {
              section.thresholdVersionId = INITIAL_THRESHOLD_VERSION_ID;
            }
          });

        // 3) 旧检测记录没有版本号：按最早区间回填、复算结论快照，标记待核对
        await tx
          .table<AnalysisRecord, string>('analysis')
          .toCollection()
          .modify((rec) => {
            if (typeof rec.createdAt !== 'number') rec.createdAt = now;
            if (!rec.thresholdVersionId) {
              const advice = classifyByAnalysis(
                {
                  fa: Number(rec.fa) || 0,
                  fs: Number(rec.fs) || 0,
                  ni: Number(rec.ni) || 0,
                  kamaciteBandwidth: Number(rec.kamaciteBandwidth) || 0,
                },
                INITIAL_THRESHOLD_SET,
              );
              rec.thresholdVersionId = INITIAL_THRESHOLD_VERSION_ID;
              rec.previousThresholdVersionId = null;
              rec.boundAdvice = toAdviceSnapshot(advice);
              rec.previousAdvice = null;
              rec.reviewState = 'pending';
              rec.backfilled = true;
              rec.reviewChangedAt = now;
            }
          });
      });
  }
}

export const db = new MeteoriteDB();

/** 生成一个稳定的本地 id */
export function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/**
 * 兜底：保证初始版本一定存在。
 * v4 升级会写入初始版本；全新库则由 seedIfEmpty 写入，这里再防御一次。
 * 并发调用（首屏业务装载与阈值装载并行）共享同一个 Promise，避免重复 add 撞主键。
 */
let ensureInitialPromise: Promise<void> | null = null;
export function ensureInitialVersion(): Promise<void> {
  if (ensureInitialPromise) return ensureInitialPromise;
  ensureInitialPromise = (async () => {
    const existing = await db.thresholdVersions.get(INITIAL_THRESHOLD_VERSION_ID);
    if (existing) return;
    const now = Date.now();
    await db.thresholdVersions.add({
      id: INITIAL_THRESHOLD_VERSION_ID,
      revision: INITIAL_REVISION,
      status: 'published',
      name: '初始阈值（历史内置区间）',
      note: '系统内置的最早 Fa / Fs / Ni / 铁纹石带宽区间。',
      thresholds: INITIAL_THRESHOLD_SET,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  })().catch((err) => {
    // 并发下另一调用方已写入时，重置后允许重试
    ensureInitialPromise = null;
    throw err;
  });
  return ensureInitialPromise;
}

/** 首次运行时灌入演示档案，保证页面有可检索内容 */
export async function seedIfEmpty(): Promise<void> {
  await ensureInitialVersion();
  const count = await db.samples.count();
  if (count > 0) return;
  const now = Date.now();
  const versionId = INITIAL_THRESHOLD_VERSION_ID;
  await db.transaction(
    'rw',
    db.samples,
    db.finds,
    db.sections,
    db.analysis,
    db.thresholdVersions,
    async () => {
      await db.samples.bulkAdd([
        {
          id: 'sample_seed_1',
          sampleNo: 'MET-2024-001',
          totalWeight: 1250.4,
          category: 'chondrite',
          chemicalGroup: 'H',
          weathering: 'W1',
          fallOrFind: 'find',
          storage: 'cabinet-a',
          note: '撒哈拉回收，熔壳完整',
          thresholdVersionId: versionId,
          createdAt: now - 86400000 * 40,
          updatedAt: now - 86400000 * 40,
        },
        {
          id: 'sample_seed_2',
          sampleNo: 'MET-2024-002',
          totalWeight: 8420,
          category: 'iron',
          chemicalGroup: 'IAB',
          weathering: 'W0',
          fallOrFind: 'find',
          storage: 'cabinet-b',
          note: '八面体结构清晰',
          thresholdVersionId: versionId,
          createdAt: now - 86400000 * 30,
          updatedAt: now - 86400000 * 30,
        },
        {
          id: 'sample_seed_3',
          sampleNo: 'MET-2024-003',
          totalWeight: 318.9,
          category: 'achondrite',
          chemicalGroup: 'ungrouped',
          weathering: 'W2',
          fallOrFind: 'fall',
          storage: 'desiccator',
          note: '目击坠落，无熔壳',
          thresholdVersionId: versionId,
          createdAt: now - 86400000 * 18,
          updatedAt: now - 86400000 * 18,
        },
      ]);
      await db.finds.bulkAdd([
        {
          id: 'find_seed_1',
          sampleId: 'sample_seed_1',
          placeName: 'Dar al Gani 区域',
          region: '利比亚',
          longitude: 16.2,
          latitude: 27.4,
          coordinateSource: 'gps',
          environment: 'desert',
          finder: '野外队 A 组',
          createdAt: now - 86400000 * 40,
        },
        {
          id: 'find_seed_2',
          sampleId: 'sample_seed_2',
          placeName: 'Gobi 南缘',
          region: '中国 内蒙古',
          longitude: 108.6,
          latitude: 42.1,
          coordinateSource: 'literature',
          environment: 'desert',
          finder: '标本室交换',
          createdAt: now - 86400000 * 30,
        },
      ]);
      await db.sections.bulkAdd([
        {
          id: 'section_seed_1',
          sectionNo: 'TS-2024-001',
          sampleId: 'sample_seed_1',
          thickness: 30,
          preparation: 'resin',
          minerals: { olivine: 42, pyroxene: 28, feldspar: 12, metal: 18 },
          micrographs: ['met001_ppl.jpg', 'met001_xpl.jpg'],
          quality: 'good',
          thresholdVersionId: versionId,
          createdAt: now - 86400000 * 35,
        },
        {
          id: 'section_seed_2',
          sectionNo: 'TS-2024-002',
          sampleId: 'sample_seed_2',
          thickness: 60,
          preparation: 'epoxy',
          minerals: { olivine: 2, pyroxene: 5, feldspar: 1, metal: 92 },
          micrographs: ['met002_reflect.jpg'],
          quality: 'fair',
          thresholdVersionId: versionId,
          createdAt: now - 86400000 * 25,
        },
      ]);
      await db.analysis.bulkAdd([
        makeSeedAnalysis(
          {
            id: 'analysis_seed_1',
            sampleId: 'sample_seed_1',
            target: 'sample',
            method: 'microprobe',
            fa: 18.6,
            fs: 16.2,
            ni: 0.8,
            kamaciteBandwidth: 0.02,
            testedAt: '2024-06-12',
          },
          versionId,
          now - 86400000 * 20,
          now,
        ),
        makeSeedAnalysis(
          {
            id: 'analysis_seed_2',
            sampleId: 'sample_seed_2',
            target: 'sample',
            method: 'sem-eds',
            fa: 3.2,
            fs: 4.1,
            ni: 7.4,
            kamaciteBandwidth: 0.62,
            testedAt: '2024-07-03',
          },
          versionId,
          now - 86400000 * 12,
          now,
        ),
      ]);

      // 全新库不应残留草稿（例如旧库删表重建场景），防御性清理
      await db.thresholdVersions.delete(DRAFT_THRESHOLD_VERSION_ID);
    },
  );
}

/** 演示检测记录：模拟「旧数据没有版本号」，按最早区间回填并标记待核对 */
function makeSeedAnalysis(
  input: {
    id: string;
    sampleId: string;
    target: AnalysisRecord['target'];
    method: AnalysisRecord['method'];
    fa: number;
    fs: number;
    ni: number;
    kamaciteBandwidth: number;
    testedAt: string;
  },
  versionId: string,
  createdAt: number,
  backfilledAt: number,
): AnalysisRecord {
  const advice = classifyByAnalysis(
    {
      fa: input.fa,
      fs: input.fs,
      ni: input.ni,
      kamaciteBandwidth: input.kamaciteBandwidth,
    },
    INITIAL_THRESHOLD_SET,
  );
  return {
    ...input,
    sectionId: undefined,
    thresholdVersionId: versionId,
    previousThresholdVersionId: null,
    reviewState: 'pending',
    backfilled: true,
    boundAdvice: toAdviceSnapshot(advice),
    previousAdvice: null,
    reviewChangedAt: backfilledAt,
    createdAt,
  };
}
