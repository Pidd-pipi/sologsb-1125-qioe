import { useMemo } from 'react';
import { useSampleStore } from '../stores/sampleStore';
import {
  BASELINE_THRESHOLDS,
  type ThresholdSnapshot,
  type ThresholdVersion,
} from '../types/threshold';

/** 当前生效的阈值版本（供录入页实时分类建议使用） */
export function useCurrentVersion(): ThresholdVersion | undefined {
  const versions = useSampleStore((s) => s.versions);
  const currentVersionId = useSampleStore((s) => s.currentVersionId);
  return useMemo(
    () => versions.find((v) => v.id === currentVersionId && v.status === 'published'),
    [versions, currentVersionId],
  );
}

/** 当前生效阈值快照；版本尚未载入时回退到内存中的最早区间 */
export function useCurrentThresholds(): ThresholdSnapshot {
  const v = useCurrentVersion();
  return v?.thresholds ?? BASELINE_THRESHOLDS;
}

/** 按 id 取任意历史版本（用于检测记录按当时版本复现结论） */
export function useVersionMap(): Map<string, ThresholdVersion> {
  const versions = useSampleStore((s) => s.versions);
  return useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);
}
