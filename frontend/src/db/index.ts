import Dexie, { type Table } from 'dexie';
import type { MeteoriteSample } from '../types/sample';
import type { FindRecord } from '../types/find';
import type { ThinSection } from '../types/section';
import type { AnalysisRecord } from '../types/analysis';
import {
  BASELINE_SEQUENCE,
  BASELINE_THRESHOLDS,
  BASELINE_VERSION_ID,
  type MetaRow,
  type ThresholdVersion,
} from '../types/threshold';
import { classifyByAnalysis } from '../utils/classify';

/** 库名固定为 gbmeteorite-db */
export const DB_NAME = 'gbmeteorite-db';

/** 唯一草稿行 id（同一时刻只允许一份未发布草稿，也是并发发布互斥的临界行） */
export const DRAFT_VERSION_ID = 'threshold_draft';

type VersionTables = Pick<
  MeteoriteDB,
  'thresholdVersions' | 'meta' | 'samples' | 'sections' | 'analysis'
>;

/**
 * 版本历史（IndexedDB 升级迁移）：
 *  - v1：建 samples / finds / sections 三张表
 *  - v2：新增 analysis 表，并为 analysis 加 sampleId 索引
 *  - v3：为 samples 补 updatedAt 字段，并按 id 回填旧记录
 *  - v4：新增 thresholdVersions / meta；samples / sections / analysis
 *        补 thresholdVersionId；analysis 补 reviewState + 冻结结论；
 *        无版本号的旧检测记录按最早区间回填并标记“待核对”
 */
export class MeteoriteDB extends Dexie {
  samples!: Table<MeteoriteSample, string>;
  finds!: Table<FindRecord, string>;
  sections!: Table<ThinSection, string>;
  analysis!: Table<AnalysisRecord, string>;
  thresholdVersions!: Table<ThresholdVersion, string>;
  meta!: Table<MetaRow, MetaRow['key']>;

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
          'id, sampleNo, category, chemicalGroup, totalWeight, createdAt, updatedAt, reviewState',
        finds: 'id, sampleId, region, createdAt',
        sections: 'id, sectionNo, sampleId, thickness, createdAt',
        analysis:
          'id, sampleId, sectionId, method, testedAt, createdAt, reviewState',
        thresholdVersions: 'id, status, sequence, publishedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await seedBaselineAndBackfill({
          thresholdVersions: tx.table('thresholdVersions'),
          meta: tx.table('meta'),
          samples: tx.table('samples'),
          sections: tx.table('sections'),
          analysis: tx.table('analysis'),
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

/** 最早区间版本行（基线，不可改） */
export function baselineVersion(now: number): ThresholdVersion {
  return {
    id: BASELINE_VERSION_ID,
    code: 'v1',
    note: '系统启用时的最早区间（Fa / Fs / Ni / 铁纹石带宽）',
    status: 'published',
    thresholds: BASELINE_THRESHOLDS,
    sequence: BASELINE_SEQUENCE,
    createdAt: now,
    publishedAt: now,
  };
}

/**
 * 建立基线版本与 current 元信息，并把无版本号的旧数据回填到最早区间：
 *  - samples / sections：绑定基线版本
 *  - analysis：绑定基线版本、冻结当时结论、reviewState 置 pending-review（待核对）
 * 幂等，可在升级事务或普通事务中调用。
 */
export async function seedBaselineAndBackfill(t: VersionTables): Promise<void> {
  const existed = await t.thresholdVersions.get(BASELINE_VERSION_ID);
  const now = Date.now();
  if (!existed) {
    await t.thresholdVersions.add(baselineVersion(now));
    const meta = await t.meta.get('current');
    if (!meta) {
      await t.meta.add({
        key: 'current',
        currentVersionId: BASELINE_VERSION_ID,
        sequence: BASELINE_SEQUENCE,
        revision: 0,
        updatedAt: now,
      });
    }
  }

  await t.samples.toCollection().modify((sample) => {
    if (!sample.thresholdVersionId) {
      sample.thresholdVersionId = BASELINE_VERSION_ID;
      sample.reviewState = 'confirmed';
    }
  });

  await t.sections.toCollection().modify((section) => {
    if (!section.thresholdVersionId) {
      section.thresholdVersionId = BASELINE_VERSION_ID;
    }
  });

  await t.analysis.toCollection().modify((rec) => {
    if (!rec.thresholdVersionId) {
      // 旧检测记录没有版本号：按最早区间回填，并标记待核对
      rec.thresholdVersionId = BASELINE_VERSION_ID;
      rec.reviewState = 'pending-review';
      if (!rec.frozenAdvice) {
        rec.frozenAdvice = {
          versionId: BASELINE_VERSION_ID,
          versionCode: 'v1',
          advice: classifyByAnalysis(rec, BASELINE_THRESHOLDS),
          frozenAt: typeof rec.createdAt === 'number' ? rec.createdAt : now,
        };
      }
    }
  });
}

/** 首次运行时灌入演示档案，保证页面有可检索内容 */
export async function seedIfEmpty(): Promise<void> {
  // 仅建立基线版本与 current（幂等），旧数据回填在插入种子之后再做，
  // 这样种子里故意不带版本号的历史遗留记录也会经历同一条回填路径。
  await db.transaction('rw', db.thresholdVersions, db.meta, async () => {
    const existed = await db.thresholdVersions.get(BASELINE_VERSION_ID);
    if (!existed) {
      await db.thresholdVersions.add(baselineVersion(Date.now()));
      const meta = await db.meta.get('current');
      if (!meta) {
        await db.meta.add({
          key: 'current',
          currentVersionId: BASELINE_VERSION_ID,
          sequence: BASELINE_SEQUENCE,
          revision: 0,
          updatedAt: Date.now(),
        });
      }
    }
  });

  const count = await db.samples.count();
  if (count > 0) {
    // 既有库：仍跑一遍回填，补齐任何遗漏版本号的记录
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
    return;
  }
  const now = Date.now();
  await db.transaction(
    'rw',
    [db.thresholdVersions, db.meta, db.samples, db.finds, db.sections, db.analysis],
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
        createdAt: now - 86400000 * 40,
        updatedAt: now - 86400000 * 40,
        thresholdVersionId: BASELINE_VERSION_ID,
        reviewState: 'confirmed',
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
        createdAt: now - 86400000 * 30,
        updatedAt: now - 86400000 * 30,
        thresholdVersionId: BASELINE_VERSION_ID,
        reviewState: 'confirmed',
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
        createdAt: now - 86400000 * 18,
        updatedAt: now - 86400000 * 18,
        thresholdVersionId: BASELINE_VERSION_ID,
        reviewState: 'confirmed',
      },
      {
        // 历史遗留样本：先无版本写入，由随后的 seedBaselineAndBackfill 回填并体现待核对
        id: 'sample_seed_legacy',
        sampleNo: 'MET-2019-legacy',
        totalWeight: 210.0,
        category: 'chondrite',
        chemicalGroup: 'L',
        weathering: 'W3',
        fallOrFind: 'find',
        storage: 'cabinet-a',
        note: '早期入库，检测记录原始无版本号',
        createdAt: now - 86400000 * 200,
        updatedAt: now - 86400000 * 200,
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
        createdAt: now - 86400000 * 35,
        thresholdVersionId: BASELINE_VERSION_ID,
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
        createdAt: now - 86400000 * 25,
        thresholdVersionId: BASELINE_VERSION_ID,
      },
    ]);
    await db.analysis.bulkAdd([
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
        createdAt: now - 86400000 * 20,
        thresholdVersionId: BASELINE_VERSION_ID,
        reviewState: 'confirmed',
        frozenAdvice: {
          versionId: BASELINE_VERSION_ID,
          versionCode: 'v1',
          advice: classifyByAnalysis(
            { fa: 18.6, fs: 16.2, ni: 0.8, kamaciteBandwidth: 0.02 },
            BASELINE_THRESHOLDS,
          ),
          frozenAt: now - 86400000 * 20,
        },
      },
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
        createdAt: now - 86400000 * 12,
        thresholdVersionId: BASELINE_VERSION_ID,
        reviewState: 'confirmed',
        frozenAdvice: {
          versionId: BASELINE_VERSION_ID,
          versionCode: 'v1',
          advice: classifyByAnalysis(
            { fa: 3.2, fs: 4.1, ni: 7.4, kamaciteBandwidth: 0.62 },
            BASELINE_THRESHOLDS,
          ),
          frozenAt: now - 86400000 * 12,
        },
      },
      {
        // 历史遗留：无版本号，插入后由 seedBaselineAndBackfill 按最早区间回填并置待核对
        id: 'analysis_seed_legacy',
        sampleId: 'sample_seed_legacy',
        target: 'sample',
        method: 'microprobe',
        fa: 11.2,
        fs: 14.8,
        ni: 0.6,
        kamaciteBandwidth: 0.01,
        testedAt: '2019-09-20',
        createdAt: now - 86400000 * 190,
      },
    ]);

    // 回填刚插入的无版本号历史记录
    await seedBaselineAndBackfill({
      thresholdVersions: db.thresholdVersions,
      meta: db.meta,
      samples: db.samples,
      sections: db.sections,
      analysis: db.analysis,
    });
  });
}
