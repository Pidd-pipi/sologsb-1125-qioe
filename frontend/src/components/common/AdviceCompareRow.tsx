import { Box, Chip, Stack, Typography } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import HistoryToggleOffIcon from '@mui/icons-material/HistoryToggleOff';
import ClassificationBadge from './Badge';
import { ANALYSIS_REVIEW_STATE_LABELS, type AnalysisRecord } from '../../types/analysis';
import {
  type AdviceSnapshot,
  type ThresholdVersion,
} from '../../types/threshold';
import { classifyByAnalysis } from '../../utils/classify';

const CONFIDENCE_LABEL: Record<AdviceSnapshot['confidence'], string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

function ConfidenceChip({ value }: { value: AdviceSnapshot['confidence'] }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={value === 'high' ? 'success' : value === 'medium' ? 'warning' : 'default'}
      label={CONFIDENCE_LABEL[value]}
    />
  );
}

function AdviceColumn({
  title,
  advice,
  versionLabel,
  dimmed,
}: {
  title: string;
  advice: AdviceSnapshot;
  versionLabel?: string;
  dimmed?: boolean;
}) {
  return (
    <Box sx={{ flex: 1, minWidth: 0, opacity: dimmed ? 0.75 : 1 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" color="text.secondary">
          {title}
        </Typography>
        {versionLabel ? (
          <Chip size="small" variant="outlined" icon={<HistoryToggleOffIcon />} label={versionLabel} />
        ) : null}
      </Stack>
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
        <ClassificationBadge category={advice.category} showGroup={false} />
        <ConfidenceChip value={advice.confidence} />
      </Stack>
      {advice.summary ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {advice.summary}
        </Typography>
      ) : null}
    </Box>
  );
}

/**
 * 原结论与新结论并排展示：
 *  - 发布后受影响：previousAdvice（旧版本）→ boundAdvice（新版本）
 *  - 回填待核对：无 previousAdvice，展示按最早区间复算结论与标记
 */
export default function AdviceCompareRow({
  rec,
  boundVersion,
  showState = true,
}: {
  rec: AnalysisRecord;
  boundVersion?: ThresholdVersion | null;
  showState?: boolean;
}) {
  const oldAdvice = rec.previousAdvice;
  const newAdvice = rec.boundAdvice;
  const changed = !!oldAdvice && oldAdvice.category !== newAdvice.category;
  const confidenceChanged = !!oldAdvice && oldAdvice.confidence !== newAdvice.confidence;
  const oldVersionLabel = rec.previousThresholdVersionId
    ? versionShortLabel(rec.previousThresholdVersionId)
    : undefined;
  const newVersionLabel = boundVersion
    ? `第 ${boundVersion.revision} 版`
    : versionShortLabel(rec.thresholdVersionId);

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: changed ? 'warning.main' : 'divider',
        bgcolor: changed ? 'rgba(237,108,2,0.05)' : 'transparent',
      }}
    >
      <Stack direction="row" spacing={1} alignItems="stretch" flexWrap="wrap" useFlexGap>
        {oldAdvice ? (
          <>
            <AdviceColumn title="原结论" advice={oldAdvice} versionLabel={oldVersionLabel} dimmed />
            <Box sx={{ display: 'flex', alignItems: 'center', px: 0.5 }}>
              <ArrowForwardIcon color={changed ? 'warning' : 'disabled'} fontSize="small" />
            </Box>
            <AdviceColumn title="新结论（重算）" advice={newAdvice} versionLabel={newVersionLabel} />
          </>
        ) : (
          <AdviceColumn
            title={rec.backfilled ? '按最早区间回填' : '当前结论'}
            advice={newAdvice}
            versionLabel={newVersionLabel}
          />
        )}
      </Stack>
      <Stack direction="row" spacing={0.75} sx={{ mt: 0.75 }} flexWrap="wrap" useFlexGap>
        {showState ? (
          <Chip
            size="small"
            color={rec.reviewState === 'pending' ? 'warning' : rec.reviewState === 'current' ? 'success' : 'default'}
            label={ANALYSIS_REVIEW_STATE_LABELS[rec.reviewState]}
          />
        ) : null}
        {rec.backfilled ? <Chip size="small" variant="outlined" label="旧数据回填 · 待核对" /> : null}
        {changed ? (
          <Chip size="small" color="warning" variant="outlined" label="分类已变化，需决定是否重新认定" />
        ) : confidenceChanged ? (
          <Chip size="small" variant="outlined" label="置信度变化" />
        ) : null}
      </Stack>
    </Box>
  );
}

/** 按指定版本对检测记录重算结论（用于「若用当前生效版本会得到什么」） */
export function recomputeAdvice(rec: AnalysisRecord, version: ThresholdVersion): AdviceSnapshot {
  const advice = classifyByAnalysis(
    {
      fa: Number(rec.fa) || 0,
      fs: Number(rec.fs) || 0,
      ni: Number(rec.ni) || 0,
      kamaciteBandwidth: Number(rec.kamaciteBandwidth) || 0,
    },
    version.thresholds,
  );
  return {
    category: advice.category,
    confidence: advice.confidence,
    summary: advice.summary,
    hits: advice.hits,
  };
}

/** 版本 id 转短标签（正式版本 id 不含 revision，无法转时显示兜底文案） */
function versionShortLabel(id: string | null | undefined): string {
  if (!id) return '未知版本';
  if (id === 'threshold_version_initial') return '第 1 版（最早区间）';
  return '历史版本';
}
