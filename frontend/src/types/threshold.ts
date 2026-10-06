import type { ClassificationAdvice } from './sample';

/** 受版本化管理的四项检测指标 */
export type ThresholdKey = 'fa' | 'fs' | 'ni' | 'kamaciteBandwidth';

/** 参与分类判别的原始数值 */
export interface AnalysisValues {
  fa: number;
  fs: number;
  ni: number;
  kamaciteBandwidth: number;
}

/** 单项指标的常规区间（用于阈值命中说明） */
export interface RangeThreshold {
  key: ThresholdKey;
  label: string;
  min: number;
  max: number;
  unit: string;
  description: string;
}

/** 分类判别参数：除四项区间外，还包含分类算法依赖的临界值 */
export interface ClassifierParams {
  /** Ni 达到此值视为「高镍」，倾向铁陨石 / 石铁 */
  highNi: number;
  /** Ni 低于此值视为典型石陨石 */
  lowNi: number;
  /** 铁纹石带宽达到此值视为粗粒八面体 */
  wideBand: number;
  /** 铁纹石带宽低于此值视为六面体结构 */
  narrowBandMax: number;
  /** Fa 普通球粒区间下界 */
  chondriteFaMin: number;
  /** Fa 普通球粒区间上界 */
  chondriteFaMax: number;
  /** Fa 低于此值视为普通球粒特征不足 */
  lowFaMax: number;
  /** |Fs − Fa| 超过此值提示非平衡 / 混合样品 */
  fsFaGap: number;
}

/**
 * 一整套不可改的分类阈值。
 * 区间与判别参数都在这里，历史版本一旦发布即冻结，只能另起新版本。
 */
export interface ThresholdSet {
  ranges: Record<ThresholdKey, RangeThreshold>;
  classifier: ClassifierParams;
}

/** 版本状态：草稿唯一，发布成功后变为 published */
export type ThresholdVersionStatus = 'draft' | 'published';

/** 阈值版本：published 记录为不可改的历史版本 */
export interface ThresholdVersion {
  /** 固定标识：初始版本 INITIAL_THRESHOLD_VERSION_ID，草稿固定 DRAFT_THRESHOLD_VERSION_ID；发布时草稿换用递增正式 id */
  id: string;
  /** 版本号：初始版本为 1，每发布一次 +1；草稿沿用其来源版本号 */
  revision: number;
  status: ThresholdVersionStatus;
  /** 版本名称，如「2024 年探针室季度区间」 */
  name: string;
  note?: string;
  thresholds: ThresholdSet;
  /** 发布时间（草稿为 null） */
  publishedAt: number | null;
  /** 发布说明 / 操作者备注 */
  publishedBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** 阈值命中说明（按指定版本计算） */
export interface VersionedThresholdHit {
  key: ThresholdKey;
  label: string;
  value: number;
  unit: string;
  inRange: boolean;
  description: string;
}

/** 一份分类结论快照：随检测记录保存，保证「当时依据」可追查 */
export interface AdviceSnapshot {
  category: ClassificationAdvice['category'];
  confidence: ClassificationAdvice['confidence'];
  summary: string;
  hits: string[];
}

export const THRESHOLD_KEYS: ThresholdKey[] = ['fa', 'fs', 'ni', 'kamaciteBandwidth'];

/** 初始（最早）阈值版本：旧数据回填与系统初始化都指向它 */
export const INITIAL_THRESHOLD_VERSION_ID = 'threshold_version_initial';
/** 草稿版本固定 id：全局至多一份草稿 */
export const DRAFT_THRESHOLD_VERSION_ID = 'threshold_version_draft';
/** 初始版本版本号 */
export const INITIAL_REVISION = 1;

/** 初始阈值：与历史代码内置常量一致，作为「最早区间」永久冻结 */
export const INITIAL_THRESHOLD_SET: ThresholdSet = {
  ranges: {
    fa: {
      key: 'fa',
      label: '橄榄石 Fa',
      min: 0,
      max: 30,
      unit: 'mol%',
      description: '普通球粒陨石橄榄石 Fa 通常 0–30 mol%，超出应考虑无球粒或铁陨石',
    },
    fs: {
      key: 'fs',
      label: '辉石 Fs',
      min: 0,
      max: 30,
      unit: 'mol%',
      description: '辉石 Fs 与 Fa 差值过大提示非平衡或混合样品',
    },
    ni: {
      key: 'ni',
      label: 'Ni',
      min: 0,
      max: 20,
      unit: 'wt%',
      description: '铁陨石 Ni 多在 5–20 wt%，石陨石通常低于 1 wt%',
    },
    kamaciteBandwidth: {
      key: 'kamaciteBandwidth',
      label: '铁纹石带宽',
      min: 0,
      max: 2,
      unit: 'mm',
      description: '带宽 > 0.5 mm 偏粗粒八面体铁陨石，< 0.2 mm 偏六面体',
    },
  },
  classifier: {
    highNi: 5,
    lowNi: 1,
    wideBand: 0.5,
    narrowBandMax: 0.2,
    chondriteFaMin: 15,
    chondriteFaMax: 30,
    lowFaMax: 12,
    fsFaGap: 8,
  },
};

/** 深拷贝一套阈值，供新建草稿时脱离原对象编辑 */
export function cloneThresholdSet(src: ThresholdSet): ThresholdSet {
  return {
    ranges: {
      fa: { ...src.ranges.fa },
      fs: { ...src.ranges.fs },
      ni: { ...src.ranges.ni },
      kamaciteBandwidth: { ...src.ranges.kamaciteBandwidth },
    },
    classifier: { ...src.classifier },
  };
}

/** 深拷贝一份完整版本（发布草稿时用，冻结后不再被草稿编辑波及） */
export function cloneVersion(src: ThresholdVersion): ThresholdVersion {
  return {
    ...src,
    thresholds: cloneThresholdSet(src.thresholds),
    note: src.note,
    publishedBy: src.publishedBy,
  };
}

/** 区间合法性校验：min ≤ max，且四项区间下界不小于 0；判别参数必须为有限数 */
export function validateThresholdSet(set: ThresholdSet): string | null {
  for (const key of THRESHOLD_KEYS) {
    const r = set.ranges[key];
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) {
      return `「${r.label}」区间必须为数字`;
    }
    if (r.min < 0) return `「${r.label}」下界不能小于 0`;
    if (r.min > r.max) return `「${r.label}」下界不能大于上界`;
  }
  const c = set.classifier;
  const numericParams: [keyof ClassifierParams, number][] = [
    ['highNi', c.highNi],
    ['lowNi', c.lowNi],
    ['wideBand', c.wideBand],
    ['narrowBandMax', c.narrowBandMax],
    ['chondriteFaMin', c.chondriteFaMin],
    ['chondriteFaMax', c.chondriteFaMax],
    ['lowFaMax', c.lowFaMax],
    ['fsFaGap', c.fsFaGap],
  ];
  for (const [, v] of numericParams) {
    if (!Number.isFinite(v)) return '分类判别参数必须全部为数字';
    if (v < 0) return '分类判别参数不能为负数';
  }
  if (c.lowNi > c.highNi) return '低镍阈值不能高于高镍阈值';
  if (c.narrowBandMax > c.wideBand) return '窄带阈值不能高于宽带阈值';
  if (c.lowFaMax > c.chondriteFaMin) return '低 Fa 上限不能高于普通球粒 Fa 下限';
  if (c.chondriteFaMin > c.chondriteFaMax) return '普通球粒 Fa 下限不能高于上限';
  return null;
}
