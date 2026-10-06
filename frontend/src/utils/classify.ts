import type {
  AdviceSnapshot,
  AnalysisValues,
  ThresholdSet,
  VersionedThresholdHit,
} from '../types/threshold';
import { THRESHOLD_KEYS } from '../types/threshold';
import type { ClassificationAdvice, SampleCategory } from '../types/sample';

/**
 * 依据指定版本的 Fa / Fs / Ni 与铁纹石带宽阈值给出分类建议。
 * 历史版本冻结，所以同一份检测数值在旧版本与新版本下可分别复现结论。
 */
export function classifyByAnalysis(input: AnalysisValues, thresholds: ThresholdSet): ClassificationAdvice {
  const { fa, fs, ni, kamaciteBandwidth } = input;
  const c = thresholds.classifier;
  const hits: string[] = [];
  let category: SampleCategory = 'chondrite';
  let confidence: ClassificationAdvice['confidence'] = 'low';

  const highNi = Number(ni) >= c.highNi;
  const lowNi = Number(ni) < c.lowNi;
  const wideBand = Number(kamaciteBandwidth) >= c.wideBand;
  const narrowBand = Number(kamaciteBandwidth) > 0 && Number(kamaciteBandwidth) < c.narrowBandMax;
  const moderateFa = Number(fa) >= c.chondriteFaMin && Number(fa) <= c.chondriteFaMax;
  const lowFa = Number(fa) < c.lowFaMax;
  const fsFaGap = Math.abs(Number(fs) - Number(fa));

  if (highNi && wideBand) {
    category = 'iron';
    confidence = 'high';
    hits.push(`Ni ${ni} wt% ≥ ${c.highNi} wt%，落入铁陨石常见区间`);
    hits.push(
      `铁纹石带宽 ${kamaciteBandwidth} mm ≥ ${c.wideBand} mm，指示粗粒八面体结构`,
    );
  } else if (highNi && narrowBand) {
    category = 'iron';
    confidence = 'medium';
    hits.push(
      `Ni ${ni} wt% 偏高，但铁纹石带宽 ${kamaciteBandwidth} mm < ${c.narrowBandMax} mm，偏六面体铁陨石`,
    );
  } else if (highNi && !wideBand && !narrowBand) {
    category = 'stony-iron';
    confidence = 'medium';
    hits.push(`Ni ${ni} wt% 高且金属占比可观，倾向石铁陨石过渡类型`);
  } else if (moderateFa && !highNi) {
    category = 'chondrite';
    confidence = 'high';
    hits.push(
      `橄榄石 Fa ${fa} mol% 落在 ${c.chondriteFaMin}–${c.chondriteFaMax} mol% 的普通球粒区间`,
    );
    if (lowNi) hits.push(`Ni ${ni} wt% < ${c.lowNi} wt%，符合石陨石特征`);
  } else if (lowFa && !highNi) {
    category = 'achondrite';
    confidence = fsFaGap > c.fsFaGap ? 'medium' : 'low';
    hits.push(`橄榄石 Fa ${fa} mol% 偏低，普通球粒特征不足`);
    if (fsFaGap > c.fsFaGap) {
      hits.push(
        `辉石 Fs 与 Fa 差值 ${fsFaGap.toFixed(1)} mol%，超过 ${c.fsFaGap} mol%，指示非平衡或混合样品`,
      );
    }
  } else {
    category = 'chondrite';
    confidence = 'low';
    hits.push('数值处在判别边界，建议补测 Ni 与金属相后再判定');
  }

  const summary =
    confidence === 'high'
      ? `建议归类为${labelOf(category)}，判据充分。`
      : confidence === 'medium'
        ? `倾向${labelOf(category)}，仍有一项判据不典型，建议复核。`
        : `暂按${labelOf(category)}记录，判据不足，需补测。`;

  return { category, confidence, summary, hits };
}

function labelOf(category: SampleCategory): string {
  switch (category) {
    case 'chondrite':
      return '球粒陨石';
    case 'iron':
      return '铁陨石';
    case 'stony-iron':
      return '石铁陨石';
    case 'achondrite':
      return '无球粒陨石';
    default:
      return '未定';
  }
}

/** 逐项计算某一版本下的阈值命中情况，供页面展示命中说明 */
export function evaluateThresholds(input: AnalysisValues, thresholds: ThresholdSet): VersionedThresholdHit[] {
  return THRESHOLD_KEYS.map((key) => {
    const t = thresholds.ranges[key];
    const value = Number(input[key]) || 0;
    return {
      key,
      label: t.label,
      value,
      unit: t.unit,
      inRange: value >= t.min && value <= t.max,
      description: t.description,
    };
  });
}

/** 把分类结论收敛为可持久化的快照 */
export function toAdviceSnapshot(advice: ClassificationAdvice): AdviceSnapshot {
  return {
    category: advice.category,
    confidence: advice.confidence,
    summary: advice.summary,
    hits: [...advice.hits],
  };
}

/** 两份结论的分类是否不同（发布后判断「受影响」的主判据） */
export function adviceCategoryChanged(a: AdviceSnapshot | null, b: AdviceSnapshot | null): boolean {
  return !!a && !!b && a.category !== b.category;
}

/** 两份结论的分类或置信度是否不同（用于并排展示高亮） */
export function adviceDiffers(a: AdviceSnapshot | null, b: AdviceSnapshot | null): boolean {
  return (
    !!a &&
    !!b &&
    (a.category !== b.category || a.confidence !== b.confidence)
  );
}
