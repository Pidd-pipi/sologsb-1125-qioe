import { create } from 'zustand';
import { ensureInitialVersion } from '../db';
import { useSampleStore } from './sampleStore';
import {
  discardDraft as discardDraftSvc,
  getActiveVersion,
  getDraft,
  listVersions,
  onThresholdEvent,
  previewPublish as previewPublishSvc,
  PublishConflictError,
  publishDraft as publishDraftSvc,
  resolveReview as resolveReviewSvc,
  saveDraft as saveDraftSvc,
  type PublishPreview,
  type PublishResult,
  type ReviewDecision,
} from '../services/thresholdService';
import type { ThresholdSet, ThresholdVersion } from '../types/threshold';

interface ThresholdState {
  versions: ThresholdVersion[];
  active: ThresholdVersion | null;
  draft: ThresholdVersion | null;
  loading: boolean;
  loaded: boolean;
  /** 同页提交锁：发布事务进行中禁止再次提交 */
  publishing: boolean;
  load: () => Promise<void>;
  saveDraft: (input: {
    base: ThresholdVersion;
    name: string;
    note?: string;
    thresholds: ThresholdSet;
  }) => Promise<ThresholdVersion>;
  discardDraft: () => Promise<void>;
  previewPublish: () => Promise<PublishPreview | null>;
  publish: (input: { name: string; note?: string; publishedBy?: string }) => Promise<PublishResult>;
  resolve: (input: {
    analysisId: string;
    decision: ReviewDecision;
    note?: string;
    updateSampleCategory?: boolean;
  }) => Promise<void>;
}

/** 发布后连带刷新业务数据（样本分类可能随「重新认定」改变） */
async function reloadAll() {
  const { load: loadThresholds } = useThresholdStore.getState();
  await Promise.all([loadThresholds(), useSampleStore.getState().loadAll()]);
}

export const useThresholdStore = create<ThresholdState>((set, get) => ({
  versions: [],
  active: null,
  draft: null,
  loading: false,
  loaded: false,
  publishing: false,

  load: async () => {
    set({ loading: true });
    // 先保证初始版本已落库，避免首屏与 sampleStore 并行装载时读空
    await ensureInitialVersion();
    const [versions, active, draft] = await Promise.all([
      listVersions(),
      getActiveVersion(),
      getDraft(),
    ]);
    set({ versions, active, draft, loading: false, loaded: true });
  },

  saveDraft: async (input) => {
    const draft = await saveDraftSvc(input);
    await get().load();
    return draft;
  },

  discardDraft: async () => {
    await discardDraftSvc();
    await get().load();
  },

  previewPublish: async () => {
    const { draft } = get();
    if (!draft) return null;
    return previewPublishSvc(draft);
  },

  publish: async (input) => {
    // 同页（同标签页）两次点击 / 两个组件同时提交：直接拦下第二份
    if (get().publishing) {
      const err = new PublishConflictError('已有一份发布正在提交，请等待其完成。');
      throw err;
    }
    set({ publishing: true });
    try {
      const result = await publishDraftSvc(input);
      // 事务已提交：本页立即刷新；跨页由 BroadcastChannel 事件触发
      await reloadAll();
      return result;
    } finally {
      set({ publishing: false });
    }
  },

  resolve: async (input) => {
    await resolveReviewSvc(input);
    await reloadAll();
  },
}));

/**
 * 跨标签页同步：另一个页面发布 / 存草稿 / 复核后，
 * 本页静默重新装载版本与业务数据，保证并发发布时双方看到的生效版本一致。
 */
if (typeof window !== 'undefined') {
  onThresholdEvent((type) => {
    const state = useThresholdStore.getState();
    if (!state.loaded) return;
    if (type === 'published' || type === 'review-resolved') {
      void reloadAll();
    } else {
      void state.load();
    }
  });
}
