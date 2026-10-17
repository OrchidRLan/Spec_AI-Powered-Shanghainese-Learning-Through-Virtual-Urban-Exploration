import type { Bilingual, LearningText } from './types';

export type BCStationId = 'restaurant' | 'candy' | 'teahouse';
export type DishId = 'fish' | 'chicken' | 'tofu';
export type FlavorId = 'rose' | 'osmanthus' | 'mint';

/** A separately versioned supplement never changes an existing Nanxiang attempt. */
export interface BCLearningText extends LearningText {
  audio: { normal: string; slowPlaybackRate: 0.75 };
  summary?: { dish?: DishId; preference?: 'not_spicy'; flavor?: FlavorId; quantity?: 2; unit?: 'pack' };
  listeningFlavor?: FlavorId;
}

export interface BCStep {
  id: string;
  title: Bilingual;
  /** Null only when the saved order chooses a complete confirmation sentence. */
  hostEntryId: string | null;
  options: Array<{ id: string; entryId: string }>;
  summaryEntryIds?: Record<string, string>;
  requiresIntroduction?: boolean;
}

export interface BCStationPlan {
  id: BCStationId;
  title: Bilingual;
  taskTitle: Bilingual;
  taskDescription: Bilingual;
  estimatedMinutes: [number, number];
  completionEntryId: string;
  reviewEntryIds: string[];
  steps: BCStep[];
  listening?: {
    assignment: 'server-random-stable-per-attempt';
    flavorOrder: FlavorId[];
    /** Catalog of all variants, never an assignment for the current attempt. */
    introductionEntryIds: Record<FlavorId, string>;
    revealRequiresUserAction: true;
    audioOnlyUntilRevealed: true;
  };
}

export interface BCItem {
  id: string;
  title: Bilingual;
  description: Bilingual;
  entryId: string;
  choiceEntryId: string;
}

export interface BCContent {
  schemaVersion: 1;
  contentVersion: string;
  purpose: 'review-draft';
  status: 'draft';
  reviewStatus: 'pending';
  compatibleBaseContentVersions: string[];
  entries: BCLearningText[];
  stationPlans: BCStationPlan[];
  dishes: Array<BCItem & { id: DishId; spicy: boolean; recommended: boolean }>;
  flavors: Array<BCItem & { id: FlavorId }>;
  audioPolicy: {
    manifestPath: string;
    normalPlaybackRate: 1;
    slowPlaybackRate: 0.75;
    preservePitch: true;
    slowIsPlaybackMode: true;
    allTextIds: string[];
  };
}
