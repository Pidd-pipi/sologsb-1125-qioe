import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import { ANALYSIS_REVIEW_LABELS, type AnalysisRecord } from '../../types/analysis';

const REVIEW_COLOR = {
  confirmed: 'success',
  stale: 'error',
  'pending-review': 'warning',
} as const;

/** 检测记录复核状态徽标 */
export function AnalysisReviewBadge({ state }: { state: AnalysisRecord['reviewState'] }) {
  if (!state || state === 'confirmed') {
    return <Chip size="small" color="success" variant="outlined" label={ANALYSIS_REVIEW_LABELS.confirmed} />;
  }
  return (
    <Tooltip
      title={
        state === 'stale'
          ? '阈值版本更新后按新区间重算的结论与原结论不同，需要人工决定是否重新认定'
          : '该旧检测记录原本没有版本号，已按最早区间回填，请核对后认定'
      }
    >
      <Chip size="small" color={REVIEW_COLOR[state]} label={ANALYSIS_REVIEW_LABELS[state]} />
    </Tooltip>
  );
}

/** 样本分类复核状态徽标 */
export function SampleReviewBadge({ state }: { state: 'pending' | 'confirmed' | undefined }) {
  if (state !== 'pending') return null;
  return (
    <Tooltip title="其检测记录在最新阈值版本下结论失效，等待人工决定是否重新认定分类">
      <Chip size="small" color="warning" label="分类待重新认定" />
    </Tooltip>
  );
}

/** 展示一个阈值版本依据（版本号 + 备注） */
export function VersionTag({ code, note }: { code: string | null | undefined; note?: string }) {
  return (
    <Box component="span">
      <Chip size="small" variant="outlined" color="secondary" label={`依据 ${code ?? '未命名版本'}`} />
      {note ? (
        <Typography variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
          {note}
        </Typography>
      ) : null}
    </Box>
  );
}

/** 并排展示用的小结论块 */
export function ConclusionCell({
  title,
  color,
  badge,
  summary,
  versionCode,
  dimmed,
}: {
  title: string;
  color: string;
  badge: React.ReactNode;
  summary: string;
  versionCode?: string;
  dimmed?: boolean;
}) {
  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 200,
        p: 1.25,
        borderRadius: 1.5,
        border: '1px solid',
        borderColor: color,
        bgcolor: dimmed ? 'action.hover' : 'background.paper',
        opacity: dimmed ? 0.85 : 1,
      }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="overline" color="text.secondary" lineHeight={1}>
            {title}
          </Typography>
          {versionCode ? <Chip size="small" variant="outlined" label={versionCode} /> : null}
        </Stack>
        {badge}
        <Typography variant="body2">{summary}</Typography>
      </Stack>
    </Box>
  );
}
