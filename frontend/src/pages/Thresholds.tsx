import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import PublishIcon from '@mui/icons-material/Publish';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VisibilityIcon from '@mui/icons-material/Visibility';
import EditIcon from '@mui/icons-material/Edit';
import LockIcon from '@mui/icons-material/Lock';
import { useSampleStore } from '../stores/sampleStore';
import { useToastStore } from '../stores/uiStore';
import {
  discardDraft,
  previewPublishWithVersions,
  publishDraft,
  saveDraft,
  PublishConflictError,
} from '../services/versionService';
import {
  cloneThresholds,
  validateThresholds,
  METRIC_KEYS,
  METRIC_LABELS,
  METRIC_UNITS,
  type ClassifierRules,
  type ThresholdSnapshot,
  type ThresholdVersion,
} from '../types/threshold';
import { classifyByAnalysis } from '../utils/classify';
import { CATEGORY_LABELS } from '../types/sample';
import { formatDate } from '../utils/format';

const RULE_FIELDS: { key: keyof ClassifierRules; label: string; step: number }[] = [
  { key: 'highNiMin', label: '高 Ni 下限（≥）', step: 0.1 },
  { key: 'lowNiMax', label: '低 Ni 上界（<）', step: 0.1 },
  { key: 'wideBandMin', label: '宽带下限（≥，mm）', step: 0.01 },
  { key: 'narrowBandMax', label: '窄带上界（<，mm）', step: 0.01 },
  { key: 'chondriteFaMin', label: '球粒 Fa 下限', step: 0.1 },
  { key: 'chondriteFaMax', label: '球粒 Fa 上限', step: 0.1 },
  { key: 'lowFaMax', label: '低 Fa 上界（<）', step: 0.1 },
  { key: 'fsFaGapMedium', label: 'Fs−Fa 差值阈值（>）', step: 0.1 },
];

/** `/thresholds` 阈值版本管理：草稿不生效，发布后冻结，并发发布只允许一份生效 */
export default function Thresholds() {
  const versions = useSampleStore((s) => s.versions);
  const currentVersionId = useSampleStore((s) => s.currentVersionId);
  const analysis = useSampleStore((s) => s.analysis);
  const samples = useSampleStore((s) => s.samples);
  const loadAll = useSampleStore((s) => s.loadAll);
  const notify = useToastStore((s) => s.notify);

  const draft = versions.find((v) => v.status === 'draft');
  const current = versions.find((v) => v.id === currentVersionId);

  const [editing, setEditing] = useState<ThresholdSnapshot | null>(null);
  const [note, setNote] = useState('');
  /** 编辑器是否有未落盘改动；发布只认已保存的草稿，杜绝用过期画面“补存即发” */
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [viewing, setViewing] = useState<ThresholdVersion | null>(null);

  // 以草稿为优先编辑对象；无草稿时以当前版本为蓝本新建
  useEffect(() => {
    if (draft) {
      setEditing(cloneThresholds(draft.thresholds));
      setNote(draft.note);
      setDirty(false);
    } else if (current) {
      setEditing(cloneThresholds(current.thresholds));
      setNote('');
      setDirty(false);
    }
    // 仅当草稿/当前版本切换（通常是刚保存或发布后）时用已持久化内容重置编辑器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, current?.id]);

  const versionMap = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);

  const validationErrors = editing ? validateThresholds(editing) : [];

  const preview = useMemo(() => {
    if (!editing) return null;
    return previewPublishWithVersions(editing, analysis, versionMap);
  }, [editing, analysis, versionMap]);

  const pendingSamples = useMemo(() => {
    if (!preview) return [];
    return samples.filter((s) => preview.pendingSampleIds.has(s.id));
  }, [preview, samples]);

  const startFromCurrent = () => {
    if (!current) return;
    setEditing(cloneThresholds(current.thresholds));
    setNote('');
    setDirty(true);
    setSaveError(null);
  };

  const handleSaveDraft = async () => {
    if (!editing) return;
    const errors = validateThresholds(editing);
    if (errors.length) {
      setSaveError(errors.join('；'));
      return;
    }
    setSaving(true);
    try {
      await saveDraft({ thresholds: editing, note: note.trim() });
      await loadAll();
      setSaveError(null);
      setDirty(false);
      notify('新区间已存为草稿，尚未发布，现有结论不受影响');
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    await discardDraft();
    await loadAll();
    notify('草稿已丢弃，当前生效版本不变');
  };

  const openConfirm = () => {
    if (!draft) {
      setPublishError('请先把新区间保存为草稿，再发布');
      return;
    }
    if (dirty) {
      setPublishError('编辑器有未保存改动，请先“保存草稿”，再发布；发布只认已存盘的草稿内容。');
      return;
    }
    setPublishError(null);
    setConfirmOpen(true);
  };

  const handlePublish = async () => {
    if (!draft) {
      setPublishError('草稿已被另一个页面发布，当前仍以先发布的版本为准');
      setConfirmOpen(false);
      return;
    }
    setPublishing(true);
    try {
      // 不在这里另存草稿：只发布已持久化的草稿行，保证并发时临界区判定可靠
      const outcome = await publishDraft();
      await loadAll();
      setConfirmOpen(false);
      setEditing(null);
      setDirty(false);
      notify(
        `已发布 ${outcome.version.code}：${outcome.staleAnalysisCount} 条检测建议失效、${outcome.pendingSampleCount} 份样本待重新认定，绑定切片 ${outcome.reboundSectionCount} 张`,
        'warning',
      );
    } catch (e) {
      if (e instanceof PublishConflictError) {
        await loadAll();
        setEditing(null);
        setDirty(false);
        setPublishError(
          '另一个页面已经抢先发布了版本，本次提交未生效，已保留先发布的版本。请查看最新版本后再决定是否新建草稿。',
        );
      } else {
        setPublishError(
          `发布失败，已整体回滚：原版本继续生效，草稿保留。${e instanceof Error ? e.message : String(e)}`,
        );
      }
      setConfirmOpen(false);
    } finally {
      setPublishing(false);
    }
  };

  const setRange = (key: (typeof METRIC_KEYS)[number], field: 'min' | 'max', value: number) => {
    setDirty(true);
    setEditing((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        ranges: prev.ranges.map((r) => (r.key === key ? { ...r, [field]: value } : r)),
      };
    });
  };

  const setRule = (key: keyof ClassifierRules, value: number) => {
    setDirty(true);
    setEditing((prev) => (prev ? { ...prev, rules: { ...prev.rules, [key]: value } } : prev));
  };

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">阈值版本管理</Typography>
        <Typography variant="body2" color="text.secondary">
          Fa / Fs / Ni / 铁纹石带宽的分类区间按版本冻结。新区间先存草稿（不影响现有结论），
          发布时样本、切片、检测记录共同绑定同一版本；已发布版本不可修改，调整需新建版本。
        </Typography>
      </Box>

      {publishError ? <Alert severity="error">{publishError}</Alert> : null}

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
          <LockIcon color="action" />
          <Typography variant="h6">当前生效版本</Typography>
          <Chip color="secondary" label={current?.code ?? '—'} />
          <Typography variant="body2" color="text.secondary">
            {current?.note}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            发布于 {current?.publishedAt ? formatDate(current.publishedAt) : '—'}
          </Typography>
        </Stack>
        {current ? (
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
            {current.thresholds.ranges.map((r) => (
              <Chip
                key={r.key}
                size="small"
                variant="outlined"
                label={`${r.label} ${r.min}~${r.max} ${r.unit}`}
              />
            ))}
          </Stack>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
          <EditIcon color="action" />
          <Typography variant="h6">
            {draft ? '编辑未发布草稿' : '新建草稿（以当前版本为蓝本）'}
          </Typography>
          {draft ? (
            <Chip size="small" color="warning" label={`草稿 · 创建于 ${formatDate(draft.createdAt)}`} />
          ) : null}
        </Stack>

        {editing ? (
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                四个检测量的分类区间
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>检测量</TableCell>
                    <TableCell sx={{ width: 160 }}>下限（含）</TableCell>
                    <TableCell sx={{ width: 160 }}>上限（含）</TableCell>
                    <TableCell>单位 / 说明</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {METRIC_KEYS.map((key) => {
                    const r = editing.ranges.find((x) => x.key === key)!;
                    return (
                      <TableRow key={key}>
                        <TableCell>{METRIC_LABELS[key]}</TableCell>
                        <TableCell>
                          <TextField
                            id={`draft-${key}-min`}
                            size="small"
                            type="number"
                            value={r.min}
                            onChange={(e) => setRange(key, 'min', Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            id={`draft-${key}-max`}
                            size="small"
                            type="number"
                            value={r.max}
                            onChange={(e) => setRange(key, 'max', Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary">
                            {METRIC_UNITS[key]} · {r.description}
                          </Typography>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                分类判定参数（决定建议归类的分支边界）
              </Typography>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                {RULE_FIELDS.map((f) => (
                  <TextField
                    key={f.key}
                    id={`draft-rule-${f.key}`}
                    size="small"
                    type="number"
                    inputProps={{ step: f.step }}
                    label={f.label}
                    value={editing.rules[f.key]}
                    onChange={(e) => setRule(f.key, Number(e.target.value))}
                    sx={{ width: 210 }}
                  />
                ))}
              </Stack>
            </Box>

            <TextField
              id="draft-note"
              size="small"
              label="版本说明（如：2026 Q1 季度区间调整）"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setDirty(true);
              }}
              fullWidth
            />

            {validationErrors.length ? (
              <Alert severity="error">
                {validationErrors.map((m) => (
                  <div key={m}>• {m}</div>
                ))}
              </Alert>
            ) : null}
            {saveError ? <Alert severity="error">{saveError}</Alert> : null}

            {preview ? (
              <Alert severity={preview.staleCount > 0 ? 'warning' : 'success'}>
                发布预演：按此草稿重算，共 {analysis.length} 条检测记录，其中{' '}
                <strong>{preview.staleCount}</strong> 条结论将立即失效并待重新认定，涉及{' '}
                <strong>{preview.pendingSampleIds.size}</strong> 份样本；其余记录与切片共同绑定新版本。
                {preview.staleCount === 0 ? '没有结论发生变化，发布仅更新绑定版本。' : ''}
              </Alert>
            ) : null}

            <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
              <Button
                variant="contained"
                startIcon={<SaveIcon />}
                onClick={handleSaveDraft}
                disabled={saving || validationErrors.length > 0}
                id="save-draft"
              >
                保存草稿（不生效）
              </Button>
              <Button
                variant="contained"
                color="warning"
                startIcon={<PublishIcon />}
                onClick={openConfirm}
                disabled={saving || publishing || validationErrors.length > 0 || !draft || dirty}
                id="publish-draft"
              >
                {dirty ? '请先保存草稿再发布' : '发布新版本'}
              </Button>
              {draft ? (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => void handleDiscard()}
                >
                  丢弃草稿
                </Button>
              ) : null}
              {!draft ? (
                <Button variant="text" onClick={startFromCurrent}>
                  重置为当前版本
                </Button>
              ) : null}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              发布是一次原子操作：若任一步失败则整体回滚，继续沿用原版本并保留草稿。两个页面同时提交时只有先提交的一份生效。
            </Typography>
          </Stack>
        ) : (
          <Alert severity="info">版本载入中…</Alert>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>
          历史版本（只读，不可改）
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>版本</TableCell>
              <TableCell>状态</TableCell>
              <TableCell>说明</TableCell>
              <TableCell>发布时间</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {versions.map((v) => (
              <TableRow key={v.id} selected={v.id === currentVersionId}>
                <TableCell>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <LockIcon fontSize="small" color={v.status === 'published' ? 'success' : 'warning'} />
                    <Typography variant="body2" fontWeight={v.id === currentVersionId ? 700 : 400}>
                      {v.code ?? '草稿'}
                    </Typography>
                    {v.id === currentVersionId ? <Chip size="small" label="当前" color="secondary" /> : null}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    color={v.status === 'published' ? 'success' : 'warning'}
                    variant={v.status === 'published' ? 'outlined' : 'filled'}
                    label={v.status === 'published' ? '已发布冻结' : '草稿'}
                  />
                </TableCell>
                <TableCell>{v.note}</TableCell>
                <TableCell>{v.publishedAt ? formatDate(v.publishedAt) : '—'}</TableCell>
                <TableCell align="right">
                  <Tooltip title="查看该版本阈值与规则">
                    <IconButton size="small" onClick={() => setViewing(v)}>
                      <VisibilityIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      {/* 发布确认 */}
      <Dialog open={confirmOpen} onClose={() => !publishing && setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>确认发布新阈值版本？</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Typography variant="body2">
              发布后该版本内容冻结不可修改；全部样本、切片与检测记录将共同绑定到新版本。
            </Typography>
            {preview ? (
              <>
                <Alert severity={preview.staleCount > 0 ? 'warning' : 'success'}>
                  {preview.staleCount} 条检测记录的分类建议将立即失效，{preview.pendingSampleIds.size}{' '}
                  份样本进入“待重新认定”。原结论会保留并与新结论并排展示。
                </Alert>
                {pendingSamples.length ? (
                  <Box>
                    <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                      受影响样本：
                    </Typography>
                    {pendingSamples.map((s) => {
                      const cats = analysis
                        .filter((a) => a.sampleId === s.id)
                        .map((a) => classifyByAnalysis(a, editing!));
                      const newCat = cats[0]?.category;
                      return (
                        <Typography key={s.id} variant="body2" color="text.secondary">
                          • {s.sampleNo}：{CATEGORY_LABELS[s.category]}
                          {newCat && newCat !== s.category
                            ? ` → 建议 ${CATEGORY_LABELS[newCat]}`
                            : '（建议分类不变）'}
                        </Typography>
                      );
                    })}
                  </Box>
                ) : null}
              </>
            ) : null}
            <Typography variant="caption" color="text.secondary">
              若此刻另一个页面也在发布，只有先完成的一份生效，失败的一方自动保留原版本与草稿。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={publishing}>
            取消
          </Button>
          <Button variant="contained" color="warning" onClick={() => void handlePublish()} disabled={publishing}>
            {publishing ? '发布中…' : '确认发布并绑定全部档案'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 版本只读查看 */}
      <Dialog open={!!viewing} onClose={() => setViewing(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          版本 {viewing?.code ?? '草稿'} 阈值快照
          {viewing?.id === currentVersionId ? '（当前生效）' : ''}
        </DialogTitle>
        <DialogContent>
          {viewing ? (
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary">
                {viewing.note} · {viewing.publishedAt ? formatDate(viewing.publishedAt) : '未发布'}
              </Typography>
              <Divider />
              {viewing.thresholds.ranges.map((r) => (
                <Typography key={r.key} variant="body2">
                  {r.label}：{r.min} ~ {r.max} {r.unit}
                </Typography>
              ))}
              <Divider />
              {RULE_FIELDS.map((f) => (
                <Typography key={f.key} variant="caption" color="text.secondary">
                  {f.label}：{viewing.thresholds.rules[f.key]}
                </Typography>
              ))}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewing(null)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
