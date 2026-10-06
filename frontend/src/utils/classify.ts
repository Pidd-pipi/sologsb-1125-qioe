import type {
  MetricRange,
  ThresholdSnapshot,
} from '../types/threshold';
import type { AnalysisRecord } from '../types/analysis';
import type { ClassificationAdvice, SampleCategory } from '../types/sample';

/** 依据某一版本的阈值快照，由 Fa / Fs / Ni 与铁纹石带宽给出分类建议 */
export function classifyByAnalysis(
  input: Pick<AnalysisRecord, 'fa' | 'fs' | 'ni' | 'kamaciteBandwidth'>,
  thresholds: ThresholdSnapshot,
): ClassificationAdvice {
  const { fa, fs, ni, kamaciteBandwidth } = input;
  const r = thresholds.rules;
  const hits: string[] = [];
  let category: SampleCategory = 'chondrite';
  let confidence: ClassificationAdvice['confidence'] = 'low';

  const highNi = Number(ni) >= r.highNiMin;
  const lowNi = Number(ni) < r.lowNiMax;
  const wideBand = Number(kamaciteBandwidth) >= r.wideBandMin;
  const narrowBand =
    Number(kamaciteBandwidth) > 0 && Number(kamaciteBandwidth) < r.narrowBandMax;
  const moderateFa = Number(fa) >= r.chondriteFaMin && Number(fa) <= r.chondriteFaMax;
  const lowFa = Number(fa) < r.lowFaMax;
  const fsFaGap = Math.abs(Number(fs) - Number(fa));

  if (highNi && wideBand) {
    category = 'iron';
    confidence = 'high';
    hits.push(`Ni ${ni} wt% ≥ ${r.highNiMin} wt%，落入铁陨石常见区间`);
    hits.push(`铁纹石带宽 ${kamaciteBandwidth} mm ≥ ${r.wideBandMin} mm，指示粗粒八面体结构`);
  } else if (highNi && narrowBand) {
    category = 'iron';
    confidence = 'medium';
    hits.push(
      `Ni ${ni} wt% 偏高，但铁纹石带宽 ${kamaciteBandwidth} mm < ${r.narrowBandMax} mm，偏六面体铁陨石`,
    );
  } else if (highNi && !wideBand && !narrowBand) {
    category = 'stony-iron';
    confidence = 'medium';
    hits.push(`Ni ${ni} wt% 高且金属占比可观，倾向石铁陨石过渡类型`);
  } else if (moderateFa && !highNi) {
    category = 'chondrite';
    confidence = 'high';
    hits.push(
      `橄榄石 Fa ${fa} mol% 落在 ${r.chondriteFaMin}–${r.chondriteFaMax} mol% 的普通球粒区间`,
    );
    if (lowNi) hits.push(`Ni ${ni} wt% < ${r.lowNiMax} wt%，符合石陨石特征`);
  } else if (lowFa && !highNi) {
    category = 'achondrite';
    confidence = fsFaGap > r.fsFaGapMedium ? 'medium' : 'low';
    hits.push(`橄榄石 Fa ${fa} mol% 偏低（< ${r.lowFaMax} mol%），普通球粒特征不足`);
    if (fsFaGap > r.fsFaGapMedium) {
      hits.push(`辉石 Fs 与 Fa 差值 ${fsFaGap.toFixed(1)} mol%，指示非平衡或混合样品`);
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

/** 阈值命中说明（逐项），供页面展示命中情况 */
export interface ThresholdHit {
  key: MetricRange['key'];
  label: string;
  value: number;
  unit: string;
  inRange: boolean;
  description: string;
}

/** 依据某一版本逐项计算阈值命中情况 */
export function evaluateThresholds(
  input: Pick<AnalysisRecord, 'fa' | 'fs' | 'ni' | 'kamaciteBandwidth'>,
  thresholds: ThresholdSnapshot,
): ThresholdHit[] {
  return thresholds.ranges.map((t) => {
    const value = Number(input[t.key]) || 0;
    return {
      key: t.key,
      label: t.label,
      value,
      unit: t.unit,
      inRange: value >= t.min && value <= t.max,
      description: t.description,
    };
  });
}
