import type { FrozenAdvice } from './threshold';

/** 检测方法 */
export type AnalysisMethod = 'microprobe' | 'sem-eds';

/** 检测对象类型 */
export type AnalysisTarget = 'sample' | 'section';

/** 分析检测结果（AnalysisRecord） */
export interface AnalysisRecord {
  id: string;
  /** 关联样本 id */
  sampleId: string;
  /** 关联切片 id（检测对象为切片时填写） */
  sectionId?: string;
  target: AnalysisTarget;
  method: AnalysisMethod;
  /** 橄榄石 Fa 值（mol%） */
  fa: number;
  /** 辉石 Fs 值（mol%） */
  fs: number;
  /** Ni 含量 wt% */
  ni: number;
  /** 铁纹石带宽 mm */
  kamaciteBandwidth: number;
  /** 检测日期 YYYY-MM-DD */
  testedAt: string;
  createdAt: number;
  /**
   * 结论所依据的阈值版本 id（v4 迁移新增）。
   * 录入时绑定当前生效版本；发布新版本后该字段保持不变，
   * 旧检测报告永远按当时版本复现结论。
   * 历史遗留记录（无版本号）回填为最早区间版本并置 pending-review。
   */
  thresholdVersionId?: string;
  /**
   * 录入（或最近一次人工重新认定）时冻结的结论及其版本。
   * 发布新版本不改写该字段，作为并排展示中的“原结论”。
   */
  frozenAdvice?: FrozenAdvice;
  /**
   * 复核状态（v4 迁移新增）：
   *  - confirmed：结论已认定，与所绑定版本一致
   *  - stale：新版本重算后结论变化，原建议已失效，等待人工决定是否重新认定
   *  - pending-review：旧数据无版本号，按最早区间回填，待核对
   */
  reviewState?: 'confirmed' | 'stale' | 'pending-review';
  /** 最近一次人工认定时间 */
  reviewedAt?: number;
}

export const ANALYSIS_METHOD_LABELS: Record<AnalysisMethod, string> = {
  microprobe: '电子探针',
  'sem-eds': 'SEM-EDS',
};

export const ANALYSIS_TARGET_LABELS: Record<AnalysisTarget, string> = {
  sample: '样本',
  section: '切片',
};

export const ANALYSIS_METHODS: AnalysisMethod[] = ['microprobe', 'sem-eds'];
export const ANALYSIS_TARGETS: AnalysisTarget[] = ['sample', 'section'];

export const ANALYSIS_REVIEW_LABELS: Record<NonNullable<AnalysisRecord['reviewState']>, string> = {
  confirmed: '已认定',
  stale: '结论失效待重新认定',
  'pending-review': '旧记录待核对',
};

/** 生成一条空检测记录骨架 */
export function emptyAnalysisDraft(sampleId: string): Omit<AnalysisRecord, 'id' | 'createdAt'> {
  return {
    sampleId,
    target: 'sample',
    method: 'microprobe',
    fa: 0,
    fs: 0,
    ni: 0,
    kamaciteBandwidth: 0,
    testedAt: new Date().toISOString().slice(0, 10),
  };
}
