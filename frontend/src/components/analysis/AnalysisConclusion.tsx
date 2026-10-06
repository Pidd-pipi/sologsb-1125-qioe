import { useState } from 'react';
import { Alert, Box, Button, Divider, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HistoryIcon from '@mui/icons-material/History';
import ClassificationBadge from '../common/Badge';
import type { AnalysisRecord } from '../../types/analysis';
import { CATEGORY_LABELS } from '../../types/sample';
import { classifyByAnalysis } from '../../utils/classify';
import { reaffirmAnalysis } from '../../services/versionService';
import { useSampleStore } from '../../stores/sampleStore';
import { useToastStore } from '../../stores/uiStore';
import { useCurrentVersion, useVersionMap } from '../../hooks/useThresholdVersion';
import { adviceChanged } from '../../types/threshold';
import { AnalysisReviewBadge, ConclusionCell } from './ReviewBadges';

/**
 * 单条检测记录的结论对比卡：
 *  - 左侧：录入/上次认定时冻结的原结论（带历史版本号）
 *  - 右侧：按当前生效版本立即重算的新结论
 * 结论不同或为旧回填记录时给出操作，由人决定是否重新认定。
 */
export default function AnalysisConclusion({ record }: { record: AnalysisRecord }) {
  const loadAll = useSampleStore((s) => s.loadAll);
  const notify = useToastStore((s) => s.notify);
  const versionMap = useVersionMap();
  const currentVersion = useCurrentVersion();
  const [busy, setBusy] = useState(false);

  // 原结论：优先用冻结快照；缺失时按记录绑定的历史版本重放
  const oldVersion = record.frozenAdvice?.versionId
    ? versionMap.get(record.frozenAdvice.versionId)
    : record.thresholdVersionId
      ? versionMap.get(record.thresholdVersionId)
      : undefined;
  const oldAdvice =
    record.frozenAdvice?.advice ??
    (oldVersion ? classifyByAnalysis(record, oldVersion.thresholds) : undefined);
  const oldCode = record.frozenAdvice?.versionCode ?? oldVersion?.code ?? 'v1';

  // 新结论：始终按当前版本立即重算
  const newAdvice = currentVersion
    ? classifyByAnalysis(record, currentVersion.thresholds)
    : undefined;
  const newCode = currentVersion?.code ?? '';

  const state = record.reviewState ?? 'confirmed';
  const differs = oldAdvice && newAdvice ? adviceChanged(oldAdvice, newAdvice) : false;
  const needsAction = state === 'stale' || state === 'pending-review';

  const act = async (adopt: boolean) => {
    setBusy(true);
    try {
      await reaffirmAnalysis(record.id, adopt);
      await loadAll();
      notify(adopt ? '已按当前版本重新认定该检测结论' : '已保留原结论并标记核对完成');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <AnalysisReviewBadge state={state} />
          {newAdvice && !differs && state === 'confirmed' ? (
            <Typography variant="caption" color="text.secondary">
              与当前版本结论一致
            </Typography>
          ) : null}
        </Stack>
      </Stack>

      {needsAction && differs ? (
        <Alert severity={state === 'stale' ? 'warning' : 'info'} sx={{ mt: 1 }}>
          {state === 'stale'
            ? '阈值更新后该分类建议已失效：请对比原结论与新结论，决定是否重新认定。'
            : '旧记录原本没有版本号，已按最早区间回填并待核对：请确认原结论是否成立。'}
        </Alert>
      ) : null}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.25}
        sx={{ mt: 1.25 }}
        alignItems="stretch"
      >
        {oldAdvice ? (
          <ConclusionCell
            title="原结论"
            color="divider"
            dimmed={differs}
            versionCode={oldCode}
            badge={<ClassificationBadge category={oldAdvice.category} showGroup={false} />}
            summary={`${oldAdvice.summary}（置信度${
              oldAdvice.confidence === 'high' ? '高' : oldAdvice.confidence === 'medium' ? '中' : '低'
            }）`}
          />
        ) : (
          <ConclusionCell
            title="原结论"
            color="divider"
            dimmed
            badge={<Typography variant="body2" color="text.secondary">无冻结结论</Typography>}
            summary="该记录缺少历史结论"
          />
        )}
        {newAdvice ? (
          <ConclusionCell
            title="新结论（当前版本）"
            color={differs ? 'warning.main' : 'success.main'}
            versionCode={newCode}
            badge={<ClassificationBadge category={newAdvice.category} showGroup={false} />}
            summary={`${newAdvice.summary}（置信度${
              newAdvice.confidence === 'high' ? '高' : newAdvice.confidence === 'medium' ? '中' : '低'
            }）`}
          />
        ) : null}
      </Stack>

      {differs && newAdvice && oldAdvice ? (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.75 }}>
          分类变化：{CATEGORY_LABELS[oldAdvice.category]} → {CATEGORY_LABELS[newAdvice.category]}
        </Typography>
      ) : null}

      {needsAction ? (
        <>
          <Divider sx={{ my: 1.25 }} />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              size="small"
              variant="contained"
              color="primary"
              startIcon={<CheckCircleIcon />}
              disabled={busy || !newAdvice}
              onClick={() => void act(true)}
            >
              采用新结论重新认定
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<HistoryIcon />}
              disabled={busy}
              onClick={() => void act(false)}
            >
              {state === 'pending-review' ? '核对无误，保留原结论' : '保留原结论'}
            </Button>
          </Stack>
        </>
      ) : null}
    </Box>
  );
}
