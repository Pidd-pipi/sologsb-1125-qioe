import { create } from 'zustand';
import { db, makeId, seedIfEmpty } from '../db';
import { freezeAdviceForInput } from '../services/versionService';
import {
  BASELINE_THRESHOLDS,
  BASELINE_VERSION_ID,
  type ThresholdVersion,
} from '../types/threshold';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  /** 全部阈值版本（含草稿，按发布序号倒序） */
  versions: ThresholdVersion[];
  /** 当前生效版本 id */
  currentVersionId: string;
  loading: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  addSample: (input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt'>) => Promise<string>;
  updateSample: (id: string, patch: Partial<MeteoriteSample>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addFind: (input: Omit<FindRecord, 'id' | 'createdAt'>) => Promise<string>;
  addSection: (input: Omit<ThinSection, 'id' | 'createdAt'>) => Promise<string>;
  updateSection: (id: string, patch: Partial<ThinSection>) => Promise<void>;
  /** 录入检测记录：自动绑定当前生效版本并冻结当时结论 */
  addAnalysis: (input: Omit<AnalysisRecord, 'id' | 'createdAt'>) => Promise<string>;
  nextSampleSeq: () => number;
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  versions: [],
  currentVersionId: BASELINE_VERSION_ID,
  loading: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    await seedIfEmpty();
    const [samples, finds, sections, analysis, versions, meta] = await Promise.all([
      db.samples.toArray(),
      db.finds.toArray(),
      db.sections.toArray(),
      db.analysis.toArray(),
      db.thresholdVersions.toArray(),
      db.meta.get('current'),
    ]);
    samples.sort((a, b) => b.createdAt - a.createdAt);
    finds.sort((a, b) => b.createdAt - a.createdAt);
    sections.sort((a, b) => b.createdAt - a.createdAt);
    analysis.sort((a, b) => b.createdAt - a.createdAt);
    versions.sort((a, b) => {
      if (a.status === 'draft') return 1;
      if (b.status === 'draft') return -1;
      return (b.sequence ?? 0) - (a.sequence ?? 0);
    });
    set({
      samples,
      finds,
      sections,
      analysis,
      versions,
      currentVersionId: meta?.currentVersionId ?? BASELINE_VERSION_ID,
      loading: false,
      loaded: true,
    });
  },

  addSample: async (input) => {
    const now = Date.now();
    const record: MeteoriteSample = {
      ...input,
      id: makeId('sample'),
      createdAt: now,
      updatedAt: now,
      thresholdVersionId: get().currentVersionId,
      reviewState: 'confirmed',
    };
    await db.samples.add(record);
    set({ samples: [record, ...get().samples] });
    return record.id;
  },

  updateSample: async (id, patch) => {
    const updatedAt = Date.now();
    await db.samples.update(id, { ...patch, updatedAt });
    set({
      samples: get().samples.map((s) => (s.id === id ? { ...s, ...patch, updatedAt } : s)),
    });
  },

  removeSample: async (id) => {
    await db.transaction('rw', db.samples, db.finds, db.sections, db.analysis, async () => {
      await db.samples.delete(id);
      await db.finds.where('sampleId').equals(id).delete();
      await db.sections.where('sampleId').equals(id).delete();
      await db.analysis.where('sampleId').equals(id).delete();
    });
    set({
      samples: get().samples.filter((s) => s.id !== id),
      finds: get().finds.filter((f) => f.sampleId !== id),
      sections: get().sections.filter((s) => s.sampleId !== id),
      analysis: get().analysis.filter((a) => a.sampleId !== id),
    });
  },

  addFind: async (input) => {
    const record: FindRecord = { ...input, id: makeId('find'), createdAt: Date.now() };
    await db.finds.add(record);
    set({ finds: [record, ...get().finds] });
    return record.id;
  },

  addSection: async (input) => {
    const { currentVersionId } = get();
    const record: ThinSection = {
      ...input,
      id: makeId('section'),
      createdAt: Date.now(),
      thresholdVersionId: currentVersionId,
    };
    await db.sections.add(record);
    set({ sections: [record, ...get().sections] });
    return record.id;
  },

  updateSection: async (id, patch) => {
    await db.sections.update(id, patch);
    set({ sections: get().sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  },

  addAnalysis: async (input) => {
    const { currentVersionId } = get();
    const frozen = await freezeAdviceForInput({
      fa: Number(input.fa),
      fs: Number(input.fs),
      ni: Number(input.ni),
      kamaciteBandwidth: Number(input.kamaciteBandwidth),
    });
    const record: AnalysisRecord = {
      ...input,
      id: makeId('analysis'),
      createdAt: Date.now(),
      thresholdVersionId: frozen.versionId || currentVersionId,
      frozenAdvice: frozen.frozenAdvice,
      reviewState: 'confirmed',
      reviewedAt: Date.now(),
    };
    await db.analysis.add(record);
    set({ analysis: [record, ...get().analysis] });
    return record.id;
  },

  nextSampleSeq: () => {
    const year = new Date().getFullYear();
    const prefix = `MET-${year}-`;
    const used = get()
      .samples.map((s) => s.sampleNo)
      .filter((no) => no.startsWith(prefix))
      .map((no) => Number(no.slice(prefix.length)))
      .filter((n) => Number.isFinite(n));
    const max = used.length ? Math.max(...used) : 0;
    return max + 1;
  },
}));

/** 找不到当前版本时的兜底快照（理论上不会用到） */
export function fallbackThresholds() {
  return BASELINE_THRESHOLDS;
}
