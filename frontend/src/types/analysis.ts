import type { ClassificationAdvice } from './sample';
import type { AdviceSnapshot, ThresholdKey } from './threshold';

/** 检测方法 */
export type AnalysisMethod = 'microprobe' | 'sem-eds';

/** 检测对象类型 */
export type AnalysisTarget = 'sample' | 'section';

/**
 * 复核状态：
 *  - current：结论与绑定版本一致，已认定
 *  - pending：待人工复核（新发布后结论受影响，或旧数据按最早区间回填）
 *  - kept-original：人工决定保留原结论（原分类认定不动）
 *  - adopted-new：人工决定按新结论重新认定
 */
export type AnalysisReviewState = 'current' | 'pending' | 'kept-original' | 'adopted-new';

export const ANALYSIS_REVIEW_STATE_LABELS: Record<AnalysisReviewState, string> = {
  current: '已认定',
  pending: '待核对',
  'kept-original': '保留原结论',
  'adopted-new': '已按新结论重新认定',
};

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
  /** 绑定的阈值版本 id：结论的「当时依据」 */
  thresholdVersionId: string;
  /** 保存记录时的上一个绑定版本（发布前记录绑定的版本）；始终绑当前版本的新记录为 null */
  previousThresholdVersionId?: string | null;
  /** 复核状态 */
  reviewState: AnalysisReviewState;
  /** 旧数据没有版本号、按最早区间回填时置 true，永久标记待核对来源 */
  backfilled?: boolean;
  /** 绑定版本下的分类结论快照（历史不可改） */
  boundAdvice: AdviceSnapshot;
  /** 上一版本结论快照；发布后结论受影响时并排展示用，无变化为 null */
  previousAdvice: AdviceSnapshot | null;
  /** 复核为「待核对」的起始时间（发布时刻 / 回填时刻） */
  reviewChangedAt?: number | null;
  createdAt: number;
}

/** 人工复核决定日志：每次「保留原结论 / 重新认定」追加一条 */
export interface AdviceReviewLog {
  id: string;
  analysisId: string;
  /** 决定类型 */
  decision: AnalysisReviewState;
  /** 决定时生效版本 */
  thresholdVersionId: string;
  /** 决定时保留的原结论版本 */
  previousThresholdVersionId: string | null;
  note?: string;
  createdAt: number;
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

/**
 * @deprecated 阈值已改为版本化管理（见 types/threshold.ts 与 stores/thresholdStore）。
 * 仅保留类型别名供少量展示代码过渡，新代码应从当前生效版本取区间。
 */
export type AnalysisThresholdKey = ThresholdKey;

/** 单条检测记录的评估结果（按某一版本计算） */
export interface AnalysisEvaluation {
  hits: import('./threshold').VersionedThresholdHit[];
  advice: ClassificationAdvice;
}

/** 生成一条空检测记录骨架（阈值版本在保存时由 store 按当前生效版本绑定） */
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
    thresholdVersionId: '',
    reviewState: 'current',
    backfilled: false,
    boundAdvice: { category: 'chondrite', confidence: 'low', summary: '', hits: [] },
    previousAdvice: null,
  };
}
