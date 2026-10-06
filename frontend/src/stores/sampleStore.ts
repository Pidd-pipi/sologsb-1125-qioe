import { create } from 'zustand';
import { db, ensureInitialVersion, makeId, seedIfEmpty } from '../db';
import { getActiveVersion } from '../services/thresholdService';
import type { AnalysisRecord } from '../types/analysis';
import type { FindRecord } from '../types/find';
import {
  INITIAL_THRESHOLD_SET,
  INITIAL_THRESHOLD_VERSION_ID,
} from '../types/threshold';
import type { MeteoriteSample } from '../types/sample';
import type { ThinSection } from '../types/section';
import { classifyByAnalysis, toAdviceSnapshot } from '../utils/classify';

export interface SampleState {
  samples: MeteoriteSample[];
  finds: FindRecord[];
  sections: ThinSection[];
  analysis: AnalysisRecord[];
  loading: boolean;
  loaded: boolean;
  loadAll: () => Promise<void>;
  addSample: (
    input: Omit<MeteoriteSample, 'id' | 'createdAt' | 'updatedAt' | 'thresholdVersionId'>,
  ) => Promise<string>;
  updateSample: (id: string, patch: Partial<MeteoriteSample>) => Promise<void>;
  removeSample: (id: string) => Promise<void>;
  addFind: (input: Omit<FindRecord, 'id' | 'createdAt'>) => Promise<string>;
  addSection: (
    input: Omit<ThinSection, 'id' | 'createdAt' | 'thresholdVersionId'>,
  ) => Promise<string>;
  updateSection: (id: string, patch: Partial<ThinSection>) => Promise<void>;
  addAnalysis: (
    input: Omit<
      AnalysisRecord,
      | 'id'
      | 'createdAt'
      | 'thresholdVersionId'
      | 'reviewState'
      | 'backfilled'
      | 'boundAdvice'
      | 'previousAdvice'
      | 'previousThresholdVersionId'
      | 'reviewChangedAt'
    >,
  ) => Promise<string>;
  nextSampleSeq: () => number;
}

/** 当前生效阈值版本 id（极端缺失时兜底初始版本） */
async function activeVersionId(): Promise<string> {
  const active = await getActiveVersion();
  return active?.id ?? INITIAL_THRESHOLD_VERSION_ID;
}

export const useSampleStore = create<SampleState>((set, get) => ({
  samples: [],
  finds: [],
  sections: [],
  analysis: [],
  loading: false,
  loaded: false,

  loadAll: async () => {
    set({ loading: true });
    await ensureInitialVersion();
    await seedIfEmpty();
    const [samples, finds, sections, analysis] = await Promise.all([
      db.samples.toArray(),
      db.finds.toArray(),
      db.sections.toArray(),
      db.analysis.toArray(),
    ]);
    samples.sort((a, b) => b.createdAt - a.createdAt);
    finds.sort((a, b) => b.createdAt - a.createdAt);
    sections.sort((a, b) => b.createdAt - a.createdAt);
    analysis.sort((a, b) => b.createdAt - a.createdAt);
    set({ samples, finds, sections, analysis, loading: false, loaded: true });
  },

  addSample: async (input) => {
    const now = Date.now();
    const record: MeteoriteSample = {
      ...input,
      id: makeId('sample'),
      thresholdVersionId: await activeVersionId(),
      createdAt: now,
      updatedAt: now,
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
    await db.transaction(
      'rw',
      db.samples,
      db.finds,
      db.sections,
      db.analysis,
      db.adviceReviewLogs,
      async () => {
        const analysisIds = (
          await db.analysis.where('sampleId').equals(id).primaryKeys()
        ) as string[];
        await db.samples.delete(id);
        await db.finds.where('sampleId').equals(id).delete();
        await db.sections.where('sampleId').equals(id).delete();
        await db.analysis.where('sampleId').equals(id).delete();
        if (analysisIds.length > 0) {
          await db.adviceReviewLogs.where('analysisId').anyOf(analysisIds).delete();
        }
      },
    );
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
    const record: ThinSection = {
      ...input,
      id: makeId('section'),
      thresholdVersionId: await activeVersionId(),
      createdAt: Date.now(),
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
    const active = await getActiveVersion();
    const now = Date.now();
    const advice = classifyByAnalysis(
      {
        fa: Number(input.fa) || 0,
        fs: Number(input.fs) || 0,
        ni: Number(input.ni) || 0,
        kamaciteBandwidth: Number(input.kamaciteBandwidth) || 0,
      },
      // 正常流程 active 一定存在；极端缺失时用初始版本兜底
      active?.thresholds ?? INITIAL_THRESHOLD_SET,
    );
    const record: AnalysisRecord = {
      ...input,
      id: makeId('analysis'),
      thresholdVersionId: active?.id ?? INITIAL_THRESHOLD_VERSION_ID,
      previousThresholdVersionId: null,
      reviewState: 'current',
      backfilled: false,
      boundAdvice: toAdviceSnapshot(advice),
      previousAdvice: null,
      reviewChangedAt: null,
      createdAt: now,
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
