import type { ClassificationAdvice, SampleCategory } from './sample';

export type { SampleCategory };

/** 受版本化管理的四个检测量 */
export type MetricKey = 'fa' | 'fs' | 'ni' | 'kamaciteBandwidth';

export const METRIC_KEYS: MetricKey[] = ['fa', 'fs', 'ni', 'kamaciteBandwidth'];

export const METRIC_LABELS: Record<MetricKey, string> = {
  fa: '橄榄石 Fa',
  fs: '辉石 Fs',
  ni: 'Ni',
  kamaciteBandwidth: '铁纹石带宽',
};

export const METRIC_UNITS: Record<MetricKey, string> = {
  fa: 'mol%',
  fs: 'mol%',
  ni: 'wt%',
  kamaciteBandwidth: 'mm',
};

/** 单个检测量的分类区间：发布后不可修改 */
export interface MetricRange {
  key: MetricKey;
  label: string;
  min: number;
  max: number;
  unit: string;
  description: string;
}

/** 分类判定规则参数：classify 逻辑完全由这些参数驱动，保证任何历史版本都能重算 */
export interface ClassifierRules {
  /** 高铁陨石下限，Ni >= 该值视为高 Ni */
  highNiMin: number;
  /** 石陨石 Ni 上限，Ni < 该值视为低 Ni */
  lowNiMax: number;
  /** 粗粒八面体带宽下限，带宽 >= 该值视为宽带 */
  wideBandMin: number;
  /** 六面体带宽上界，0 < 带宽 < 该值视为窄带 */
  narrowBandMax: number;
  /** 普通球粒 Fa 区间（闭区间） */
  chondriteFaMin: number;
  chondriteFaMax: number;
  /** 无球粒倾向 Fa 上界，Fa < 该值视为低 Fa */
  lowFaMax: number;
  /** Fs-Fa 差值超过该值时，无球粒倾向置信度提升为中 */
  fsFaGapMedium: number;
}

/** 一整套阈值快照：四个区间 + 判定规则参数 */
export interface ThresholdSnapshot {
  ranges: MetricRange[];
  rules: ClassifierRules;
}

/** 版本状态：草稿 / 已发布（历史版本不可改） */
export type ThresholdVersionStatus = 'draft' | 'published';

/**
 * 阈值版本（ThresholdVersion）
 * 已发布版本的 thresholds 永不允许改动；调整区间必须新建草稿并发布。
 */
export interface ThresholdVersion {
  id: string;
  /** 展示用版本号，发布时按顺序生成 v1 / v2 ... */
  code: string | null;
  /** 草稿备注，发布后即冻结 */
  note: string;
  status: ThresholdVersionStatus;
  thresholds: ThresholdSnapshot;
  /** 发布序号：已发布版本单调递增；草稿为 null */
  sequence: number | null;
  createdAt: number;
  publishedAt: number | null;
}

/** 元信息表 key：仅一行 current */
export type MetaKey = 'current';

export interface MetaRow {
  key: MetaKey;
  /** 当前生效的已发布版本 id */
  currentVersionId: string;
  /** 发布序号水位，用于分配下一个版本号 */
  sequence: number;
  /** 乐观锁：每次发布 +1，用于并发发布互斥 */
  revision: number;
  updatedAt: number;
}

/** 检测记录的复核状态 */
export type AnalysisReviewState = 'confirmed' | 'stale' | 'pending-review';

/** 样本分类复核状态 */
export type SampleReviewState = 'confirmed' | 'pending';

/** 分类结论快照：随记录冻结，供原结论与新结论并排展示 */
export type AdviceSnapshot = ClassificationAdvice;

/**
 * 冻结结论：检测记录在录入或人工重新认定时的结论，连同当时版本一起存档。
 * 发布新版本不会改写它，保证旧报告随时能说清“当时依据哪一版区间”。
 */
export interface FrozenAdvice {
  /** 结论所依据的版本 id */
  versionId: string;
  /** 结论所依据的版本号（冗余存展示名，避免历史版本被清理后无法显示） */
  versionCode: string;
  advice: AdviceSnapshot;
  /** 认定时间 */
  frozenAt: number;
}

/** 发布结果统计 */
export interface PublishOutcome {
  version: ThresholdVersion;
  /** 结论发生变化、需要重新认定的检测记录数 */
  staleAnalysisCount: number;
  /** 需要人工复核分类的样本数 */
  pendingSampleCount: number;
  /** 重新绑定到新版本的切片数 */
  reboundSectionCount: number;
}

/** 系统基线版本 id（最早区间，旧数据回填目标） */
export const BASELINE_VERSION_ID = 'threshold_v1_baseline';

/** 基线版本号 */
export const BASELINE_SEQUENCE = 1;

/** 最早区间（系统启用时的 Fa / Fs / Ni / 铁纹石带宽阈值与判定参数） */
export const BASELINE_RULES: ClassifierRules = {
  highNiMin: 5,
  lowNiMax: 1,
  wideBandMin: 0.5,
  narrowBandMax: 0.2,
  chondriteFaMin: 15,
  chondriteFaMax: 30,
  lowFaMax: 12,
  fsFaGapMedium: 8,
};

export const BASELINE_THRESHOLDS: ThresholdSnapshot = {
  ranges: [
    {
      key: 'fa',
      label: METRIC_LABELS.fa,
      min: 0,
      max: 30,
      unit: METRIC_UNITS.fa,
      description: '普通球粒陨石橄榄石 Fa 通常 0–30 mol%，超出应考虑无球粒或铁陨石',
    },
    {
      key: 'fs',
      label: METRIC_LABELS.fs,
      min: 0,
      max: 30,
      unit: METRIC_UNITS.fs,
      description: '辉石 Fs 与 Fa 差值过大提示非平衡或混合样品',
    },
    {
      key: 'ni',
      label: METRIC_LABELS.ni,
      min: 0,
      max: 20,
      unit: METRIC_UNITS.ni,
      description: '铁陨石 Ni 多在 5–20 wt%，石陨石通常低于 1 wt%',
    },
    {
      key: 'kamaciteBandwidth',
      label: METRIC_LABELS.kamaciteBandwidth,
      min: 0,
      max: 2,
      unit: METRIC_UNITS.kamaciteBandwidth,
      description: '带宽 > 0.5 mm 偏粗粒八面体铁陨石，< 0.2 mm 偏六面体',
    },
  ],
  rules: { ...BASELINE_RULES },
};

/** 深拷贝一份阈值快照（草稿编辑时用，避免直接引用已发布版本对象） */
export function cloneThresholds(t: ThresholdSnapshot): ThresholdSnapshot {
  return {
    ranges: t.ranges.map((r) => ({ ...r })),
    rules: { ...t.rules },
  };
}

/** 取某个指标区间 */
export function rangeOf(t: ThresholdSnapshot, key: MetricKey): MetricRange {
  const r = t.ranges.find((x) => x.key === key);
  if (!r) throw new Error(`阈值快照缺少指标 ${key}`);
  return r;
}

/** 草稿/发布前校验：区间必须 min <= max、Fa 球粒区间合法等 */
export function validateThresholds(t: ThresholdSnapshot): string[] {
  const errors: string[] = [];
  for (const r of t.ranges) {
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) {
      errors.push(`${r.label} 区间必须是数字`);
    } else if (r.min > r.max) {
      errors.push(`${r.label} 区间下限不能大于上限`);
    }
  }
  const rules = t.rules;
  const checks: [boolean, string][] = [
    [rules.highNiMin > rules.lowNiMax, '高 Ni 下限应大于低 Ni 上界，否则两个区间重叠'],
    [rules.wideBandMin > rules.narrowBandMax, '窄带上界应小于宽带下限，否则带宽判据冲突'],
    [rules.chondriteFaMin <= rules.chondriteFaMax, '普通球粒 Fa 区间下限不能大于上限'],
    [rules.lowFaMax <= rules.chondriteFaMin, '低 Fa 上界应不大于球粒 Fa 下限'],
    [rules.fsFaGapMedium > 0, 'Fs-Fa 差值阈值必须为正数'],
  ];
  for (const [ok, msg] of checks) {
    if (!ok) errors.push(msg);
  }
  return errors;
}

/** 结论是否发生实质变化（分类或置信度变化）；命中描述差异不触发失效 */
export function adviceChanged(a: AdviceSnapshot, b: AdviceSnapshot): boolean {
  return a.category !== b.category || a.confidence !== b.confidence;
}

/** 发布时汇总受影响样本建议的新分类：取其失效记录新结论中出现最多的分类 */
export function majorityCategory(categories: SampleCategory[]): SampleCategory | null {
  if (!categories.length) return null;
  const counts = new Map<SampleCategory, number>();
  categories.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
}
