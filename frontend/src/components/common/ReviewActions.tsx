import { useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Tooltip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HistoryIcon from '@mui/icons-material/History';
import RedoIcon from '@mui/icons-material/Redo';
import {
  ANALYSIS_REVIEW_STATE_LABELS,
  type AnalysisRecord,
} from '../../types/analysis';
import { useThresholdStore } from '../../stores/thresholdStore';
import { useToastStore } from '../../stores/uiStore';

/** 复核操作条：只在「待核对」状态出现，决定后记录离开待核对队列 */
export default function ReviewActions({
  rec,
  onResolved,
  compact = false,
}: {
  rec: AnalysisRecord;
  onResolved?: () => void;
  compact?: boolean;
}) {
  const resolve = useThresholdStore((s) => s.resolve);
  const notify = useToastStore((s) => s.notify);
  const [confirmAdopt, setConfirmAdopt] = useState(false);
  const [syncCategory, setSyncCategory] = useState(true);
  const [busy, setBusy] = useState(false);

  if (rec.reviewState !== 'pending') {
    return (
      <Box sx={{ mt: compact ? 0.5 : 0.75 }}>
        <Tooltip title="该记录已完成核对；新版本发布后若结论再次变化会重新进入待核对">
          <Button size="small" disabled startIcon={<CheckCircleIcon />}>
            {ANALYSIS_REVIEW_STATE_LABELS[rec.reviewState]}
          </Button>
        </Tooltip>
      </Box>
    );
  }

  const run = async (decision: 'current' | 'kept-original', updateSampleCategory = false) => {
    setBusy(true);
    try {
      await resolve({ analysisId: rec.id, decision, updateSampleCategory });
      notify(
        decision === 'kept-original'
          ? '已保留原结论，样本分类不改动'
          : '已标记为核对无误',
      );
      onResolved?.();
    } finally {
      setBusy(false);
    }
  };

  const confirmAdoptNew = async () => {
    setBusy(true);
    try {
      await resolve({
        analysisId: rec.id,
        decision: 'adopted-new',
        updateSampleCategory: syncCategory,
      });
      notify(syncCategory ? '已按新结论重新认定，样本分类已同步' : '已标记采用新结论');
      setConfirmAdopt(false);
      onResolved?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack direction="row" spacing={1} sx={{ mt: compact ? 0.75 : 1 }} flexWrap="wrap" useFlexGap>
      <Button
        size="small"
        variant="contained"
        color="primary"
        startIcon={<RedoIcon />}
        disabled={busy}
        onClick={() => setConfirmAdopt(true)}
      >
        按新结论重新认定
      </Button>
      <Button
        size="small"
        variant="outlined"
        startIcon={<HistoryIcon />}
        disabled={busy}
        onClick={() => void run('kept-original')}
      >
        保留原结论
      </Button>
      {rec.backfilled && !rec.previousAdvice ? (
        <Button size="small" disabled={busy} onClick={() => void run('current')}>
          回填核对无误
        </Button>
      ) : null}

      <Dialog open={confirmAdopt} onClose={() => (busy ? undefined : setConfirmAdopt(false))}>
        <DialogTitle>按新结论重新认定？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            原结论将保留在检测记录的历史快照中，记录标记为「已按新结论重新认定」。
          </DialogContentText>
          <Collapse in={rec.previousAdvice?.category !== rec.boundAdvice.category}>
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  checked={syncCategory}
                  onChange={(e) => setSyncCategory(e.target.checked)}
                  color="primary"
                />
              }
              label="同步把所属样本的正式分类改为新分类"
            />
          </Collapse>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmAdopt(false)} disabled={busy}>
            取消
          </Button>
          <Button variant="contained" onClick={() => void confirmAdoptNew()} disabled={busy}>
            确认重新认定
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
