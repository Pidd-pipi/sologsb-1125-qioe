import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditNoteIcon from '@mui/icons-material/EditNote';
import PublishIcon from '@mui/icons-material/Publish';
import SaveIcon from '@mui/icons-material/Save';
import { Link as RouterLink } from 'react-router-dom';
import AdviceCompareRow from '../components/common/AdviceCompareRow';
import ReviewActions from '../components/common/ReviewActions';
import { useSampleStore } from '../stores/sampleStore';
import { useThresholdStore } from '../stores/thresholdStore';
import { useToastStore } from '../stores/uiStore';
import type { PublishPreview } from '../services/thresholdService';
import { PublishConflictError, previewPublish } from '../services/thresholdService';
import {
  THRESHOLD_KEYS,
  cloneThresholdSet,
  validateThresholdSet,
  type ClassifierParams,
  type ThresholdKey,
  type ThresholdSet,
  type ThresholdVersion,
} from '../types/threshold';
import { ANALYSIS_METHOD_LABELS } from '../types/analysis';
import { formatDate } from '../utils/format';

interface ThresholdFormState {
  name: string;
  note: string;
  min: Record<ThresholdKey, string>;
  max: Record<ThresholdKey, string>;
  classifier: Record<keyof ClassifierParams, string>;
  baseRevision: number;
  isExistingDraft: boolean;
}

const CLASSIFIER_FIELDS: { key: keyof ClassifierParams; label: string; unit: string; help: string }[] = [
  { key: 'highNi', label: '高镍阈值', unit: 'wt%', help: 'Ni ≥ 该值倾向铁陨石 / 石铁' },
  { key: 'lowNi', label: '低镍阈值', unit: 'wt%', help: 'Ni < 该值视为典型石陨石' },
  { key: 'wideBand', label: '粗粒带宽', unit: 'mm', help: '带宽 ≥ 该值为粗粒八面体' },
  { key: 'narrowBandMax', label: '窄带上限', unit: 'mm', help: '0 < 带宽 < 该值为六面体' },
  { key: 'chondriteFaMin', label: '球粒 Fa 下限', unit: 'mol%', help: '普通球粒 Fa 区间下界' },
  { key: 'chondriteFaMax', label: '球粒 Fa 上限', unit: 'mol%', help: '普通球粒 Fa 区间上界' },
  { key: 'lowFaMax', label: '低 Fa 上限', unit: 'mol%', help: 'Fa < 该值球粒特征不足' },
  { key: 'fsFaGap', label: 'Fs−Fa 差值', unit: 'mol%', help: '差值超过该值提示非平衡' },
];

function formFromVersion(v: ThresholdVersion, isExistingDraft: boolean): ThresholdFormState {
  const num = (x: number) => String(x);
  return {
    name: isExistingDraft ? v.name : `基于第 ${v.revision} 版的季度调整`,
    note: isExistingDraft ? v.note ?? '' : '',
    min: {
      fa: num(v.thresholds.ranges.fa.min),
      fs: num(v.thresholds.ranges.fs.min),
      ni: num(v.thresholds.ranges.ni.min),
      kamaciteBandwidth: num(v.thresholds.ranges.kamaciteBandwidth.min),
    },
    max: {
      fa: num(v.thresholds.ranges.fa.max),
      fs: num(v.thresholds.ranges.fs.max),
      ni: num(v.thresholds.ranges.ni.max),
      kamaciteBandwidth: num(v.thresholds.ranges.kamaciteBandwidth.max),
    },
    classifier: {
      highNi: num(v.thresholds.classifier.highNi),
      lowNi: num(v.thresholds.classifier.lowNi),
      wideBand: num(v.thresholds.classifier.wideBand),
      narrowBandMax: num(v.thresholds.classifier.narrowBandMax),
      chondriteFaMin: num(v.thresholds.classifier.chondriteFaMin),
      chondriteFaMax: num(v.thresholds.classifier.chondriteFaMax),
      lowFaMax: num(v.thresholds.classifier.lowFaMax),
      fsFaGap: num(v.thresholds.classifier.fsFaGap),
    },
    baseRevision: v.revision,
    isExistingDraft,
  };
}

/** `/thresholds` 探针阈值版本管理 */
export default function Thresholds() {
  const active = useThresholdStore((s) => s.active);
  const draft = useThresholdStore((s) => s.draft);
  const versions = useThresholdStore((s) => s.versions);
  const loaded = useThresholdStore((s) => s.loaded);
  const publishing = useThresholdStore((s) => s.publishing);
  const load = useThresholdStore((s) => s.load);
  const saveDraft = useThresholdStore((s) => s.saveDraft);
  const discardDraft = useThresholdStore((s) => s.discardDraft);
  const publish = useThresholdStore((s) => s.publish);
  const notify = useToastStore((s) => s.notify);

  const samples = useSampleStore((s) => s.samples);
  const analysis = useSampleStore((s) => s.analysis);
  const sections = useSampleStore((s) => s.sections);

  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<ThresholdFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preview, setPreview] = useState<PublishPreview | null>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // 草稿在外部（另一标签页）变化时，若编辑器未手动改过基线则跟随
  useEffect(() => {
    if (!loaded || !active) return;
    if (draft && (!form || (!form.isExistingDraft && !editorOpen))) {
      setForm(formFromVersion(draft, true));
      setEditorOpen(true);
    } else if (!draft && form?.isExistingDraft) {
      setForm(null);
      setEditorOpen(false);
    }
  }, [draft, active, loaded, form, editorOpen]);

  const pending = useMemo(() => analysis.filter((a) => a.reviewState === 'pending'), [analysis]);
  const backfilledCount = useMemo(() => analysis.filter((a) => a.backfilled).length, [analysis]);
  const published = useMemo(() => versions.filter((v) => v.status === 'published'), [versions]);

  const sampleById = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);
  const versionById = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);

  const startEditFromActive = () => {
    if (!active) return;
    setForm(formFromVersion(active, false));
    setEditorOpen(true);
    setError(null);
  };

  const buildSetFromForm = (f: ThresholdFormState): ThresholdSet | null => {
    if (!active) return null;
    const base = draft ?? active;
    const set = cloneThresholdSet(base.thresholds);
    for (const key of THRESHOLD_KEYS) {
      set.ranges[key].min = Number(f.min[key]);
      set.ranges[key].max = Number(f.max[key]);
    }
    for (const field of CLASSIFIER_FIELDS) {
      set.classifier[field.key] = Number(f.classifier[field.key]);
    }
    return set;
  };

  const handleSaveDraft = async () => {
    if (!form || !active) return;
    const set = buildSetFromForm(form);
    if (!set) return;
    const invalid = validateThresholdSet(set);
    if (invalid) {
      setError(invalid);
      return;
    }
    // 已存在草稿则以草稿为基线继续改；否则以当前生效版本为基线
    const base = draft ?? active;
    await saveDraft({ base, name: form.name, note: form.note, thresholds: set });
    setError(null);
    notify('新阈值区间已存为草稿，尚未影响任何检测结论');
  };

  const openPublishConfirm = async () => {
    if (!form || !active) return;
    const set = buildSetFromForm(form);
    if (!set) return;
    const invalid = validateThresholdSet(set);
    if (invalid) {
      setError(invalid);
      return;
    }
    const base = draft ?? active;
    // 先落草稿，再基于草稿做预演统计
    const savedDraft = await saveDraft({ base, name: form.name, note: form.note, thresholds: set });
    const pv = await previewPublish(savedDraft);
    setPreview(pv);
    setConfirmOpen(true);
    setError(null);
  };

  const handlePublish = async () => {
    if (!form) return;
    try {
      const result = await publish({ name: form.name, note: form.note });
      setConfirmOpen(false);
      setForm(null);
      setEditorOpen(false);
      notify(
        `第 ${result.version.revision} 版阈值已发布，${result.affectedAnalysisIds.length} 条检测记录的分类建议失效待重新认定`,
        result.affectedAnalysisIds.length > 0 ? 'warning' : 'success',
      );
    } catch (e) {
      if (e instanceof PublishConflictError) {
        setError(e.message);
        setConfirmOpen(false);
        await load();
      } else {
        setError(e instanceof Error ? e.message : '发布失败，原版本保留');
      }
    }
  };

  const handleDiscard = async () => {
    await discardDraft();
    setForm(null);
    setEditorOpen(false);
    setError(null);
    notify('草稿已放弃，生效版本未受影响');
  };

  if (!loaded) {
    return <Typography color="text.secondary">正在装载阈值版本…</Typography>;
  }

  return (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="h4">探针阈值版本</Typography>
        <Typography variant="body2" color="text.secondary">
          Fa / Fs / Ni 与铁纹石带宽的分类区间按季度版本化：已发布版本不可修改，调整先存草稿；
          发布时样本、切片与检测记录共同绑定同一版本。
        </Typography>
      </Box>

      {/* 当前生效版本概览 */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Chip color="success" size="small" label={`生效中 · 第 ${active?.revision ?? 1} 版`} />
              <Typography variant="h6">{active?.name ?? '初始阈值'}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              发布于 {active?.publishedAt ? formatDate(active.publishedAt) : '—'}
              {active?.publishedBy ? ` · ${active.publishedBy}` : ''}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            {pending.length > 0 ? (
              <Chip color="warning" label={`${pending.length} 条结论待核对`} component={RouterLink} to="#pending" clickable />
            ) : null}
            {!editorOpen ? (
              <Button variant="contained" startIcon={<EditNoteIcon />} onClick={startEditFromActive}>
                {draft ? '继续编辑草稿' : '基于当前版本起草新阈值'}
              </Button>
            ) : null}
          </Stack>
        </Stack>

        <Divider sx={{ my: 1.5 }} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {THRESHOLD_KEYS.map((key) => {
            const r = active?.thresholds.ranges[key];
            return (
              <Chip
                key={key}
                size="small"
                variant="outlined"
                label={r ? `${r.label} ${r.min}~${r.max} ${r.unit}` : key}
              />
            );
          })}
        </Stack>
      </Paper>

      {/* 草稿编辑器 */}
      <Collapse in={editorOpen}>
        <Paper variant="outlined" sx={{ p: 2.5, borderStyle: 'dashed', borderColor: 'primary.main' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
            <Typography variant="h6">
              {draft ? `编辑草稿（基于第 ${form?.baseRevision ?? draft.revision} 版）` : '新阈值草稿'}
            </Typography>
            <Tooltip title="放弃草稿：不影响已发布版本">
              <IconButton size="small" color="warning" onClick={() => void handleDiscard()}>
                <DeleteOutlineIcon />
              </IconButton>
            </Tooltip>
          </Stack>

          {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}
          {draft && active && draft.revision !== active.revision ? (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              草稿基于第 {draft.revision} 版，但当前已生效第 {active.revision} 版。
              发布将被拒绝以避免并发覆盖，请以当前生效版本重新起草。
            </Alert>
          ) : null}

          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                size="small"
                label="版本名称"
                value={form?.name ?? ''}
                onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                size="small"
                label="发布说明（可选）"
                value={form?.note ?? ''}
                onChange={(e) => setForm((f) => (f ? { ...f, note: e.target.value } : f))}
              />
            </Grid>
          </Grid>

          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
            四项指标常规区间
          </Typography>
          <Grid container spacing={1.5}>
            {form && active
              ? THRESHOLD_KEYS.map((key) => {
                  const cur = active.thresholds.ranges[key];
                  return (
                    <Grid item xs={12} sm={6} md={3} key={key}>
                      <Paper variant="outlined" sx={{ p: 1.25 }}>
                        <Typography variant="subtitle2">
                          {cur.label}
                          <Typography component="span" variant="caption" color="text.secondary">
                            {' '}（{cur.unit}）
                          </Typography>
                        </Typography>
                        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }} alignItems="center">
                          <TextField
                            size="small"
                            type="number"
                            label="下限"
                            value={form.min[key]}
                            onChange={(e) =>
                              setForm((f) =>
                                f ? { ...f, min: { ...f.min, [key]: e.target.value } } : f,
                              )
                            }
                            sx={{ width: 110 }}
                          />
                          <Typography>~</Typography>
                          <TextField
                            size="small"
                            type="number"
                            label="上限"
                            value={form.max[key]}
                            onChange={(e) =>
                              setForm((f) =>
                                f ? { ...f, max: { ...f.max, [key]: e.target.value } } : f,
                              )
                            }
                            sx={{ width: 110 }}
                          />
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          当前生效：{cur.min}~{cur.max}
                        </Typography>
                      </Paper>
                    </Grid>
                  );
                })
              : null}
          </Grid>

          <Typography variant="subtitle2" sx={{ mt: 2, mb: 1 }}>
            分类判别临界值
          </Typography>
          <Grid container spacing={1.5}>
            {form
              ? CLASSIFIER_FIELDS.map((field) => (
                  <Grid item xs={6} sm={4} md={3} key={field.key}>
                    <TextField
                      fullWidth
                      size="small"
                      type="number"
                      label={field.label}
                      helperText={field.help}
                      value={form.classifier[field.key]}
                      onChange={(e) =>
                        setForm((f) =>
                          f
                            ? {
                                ...f,
                                classifier: { ...f.classifier, [field.key]: e.target.value },
                              }
                            : f,
                        )
                      }
                      InputProps={{ endAdornment: <Typography variant="caption">{field.unit}</Typography> }}
                    />
                  </Grid>
                ))
              : null}
          </Grid>

          <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
            <Button variant="outlined" startIcon={<SaveIcon />} onClick={() => void handleSaveDraft()}>
              仅保存草稿
            </Button>
            <Button
              variant="contained"
              color="primary"
              startIcon={<PublishIcon />}
              disabled={publishing}
              onClick={() => void openPublishConfirm()}
            >
              {publishing ? '发布中…' : '检查影响并发布'}
            </Button>
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              发布是原子操作：任一步失败全部回滚，继续保留当前版本；两个页面同时发布时只有一份生效。
            </Typography>
          </Stack>
        </Paper>
      </Collapse>

      {/* 待核对队列 */}
      <Paper variant="outlined" id="pending" sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 0.5 }}>
          待核对结论（{pending.length}）
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          阈值更新后受影响的分类建议立即失效并按新版本重算，原结论与新结论并排展示，
          由人工决定是否重新认定；旧数据回填记录 {backfilledCount} 条，核对前一直挂起。
        </Typography>
        {pending.length === 0 ? (
          <Alert severity="success">暂无待核对结论。</Alert>
        ) : (
          <List disablePadding>
            {pending.map((rec) => {
              const sample = sampleById.get(rec.sampleId);
              return (
                <ListItem
                  key={rec.id}
                  divider
                  disableGutters
                  sx={{ display: 'block', py: 1.5 }}
                >
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.75 }} flexWrap="wrap" useFlexGap>
                    <ListItemText
                      primary={
                        <RouterLink to={`/samples/${rec.sampleId}`} style={{ color: 'inherit' }}>
                          {sample ? sample.sampleNo : '未知样本'}
                        </RouterLink>
                      }
                      secondary={`${ANALYSIS_METHOD_LABELS[rec.method]} · ${formatDate(rec.testedAt)} · Fa ${rec.fa} / Fs ${rec.fs} / Ni ${rec.ni} / 带宽 ${rec.kamaciteBandwidth}`}
                    />
                  </Stack>
                  <AdviceCompareRow rec={rec} boundVersion={versionById.get(rec.thresholdVersionId)} />
                  <ReviewActions rec={rec} />
                </ListItem>
              );
            })}
          </List>
        )}
      </Paper>

      {/* 已发布历史 */}
      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          历史版本（{published.length}，均不可改）
        </Typography>
        <List dense>
          {published.map((v) => (
            <ListItem key={v.id} divider sx={{ alignItems: 'flex-start' }}>
              <ListItemText
                primary={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip
                      size="small"
                      color={v.id === active?.id ? 'success' : 'default'}
                      label={`第 ${v.revision} 版`}
                    />
                    <Typography variant="subtitle2">{v.name}</Typography>
                    {v.id === active?.id ? <Chip size="small" label="生效中" /> : null}
                  </Stack>
                }
                secondary={
                  <Box sx={{ mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary" component="span">
                      发布于 {v.publishedAt ? formatDate(v.publishedAt) : '—'}
                      {v.note ? ` · ${v.note}` : ''}
                    </Typography>
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                      {THRESHOLD_KEYS.map((key) => {
                        const r = v.thresholds.ranges[key];
                        return (
                          <Chip
                            key={key}
                            size="small"
                            variant="outlined"
                            label={`${r.label} ${r.min}~${r.max}${r.unit}`}
                          />
                        );
                      })}
                    </Stack>
                  </Box>
                }
              />
            </ListItem>
          ))}
        </List>
        <Typography variant="caption" color="text.secondary">
          档案库共 {samples.length} 份样本、{sections.length} 张切片、{analysis.length} 条检测记录，
          发布时共同绑定同一版本。
        </Typography>
      </Paper>

      {/* 发布确认 */}
      <Dialog open={confirmOpen} onClose={() => (publishing ? undefined : setConfirmOpen(false))} maxWidth="sm" fullWidth>
        <DialogTitle>确认发布新阈值版本？</DialogTitle>
        <DialogContent>
          <DialogContentText>
            发布后第 {(active?.revision ?? 1) + 1} 版立即生效，已发布历史不可修改；
            样本、切片与全部检测记录将在同一事务中共同绑定新版本。
          </DialogContentText>
          {preview ? (
            <Box sx={{ mt: 2 }}>
              <Alert severity={preview.affectedAnalysisCount > 0 ? 'warning' : 'success'}>
                {preview.affectedAnalysisCount} 条检测记录结论将立即失效并按新阈值重算，
                涉及 {preview.affectedSampleCount} 份样本，进入待核对队列。
              </Alert>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                共同绑定：{preview.bindSampleCount} 份样本 · {preview.bindSectionCount} 张切片 ·{' '}
                {preview.bindAnalysisCount} 条检测记录。发布失败（含并发冲突）时全部回滚，保留当前第{' '}
                {active?.revision ?? 1} 版。
              </Typography>
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={publishing}>
            再改改
          </Button>
          <Button variant="contained" startIcon={<PublishIcon />} disabled={publishing} onClick={() => void handlePublish()}>
            {publishing ? '正在发布…' : '确认发布'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
