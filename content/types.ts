export type Locale = 'zh' | 'en';
export type Bilingual<T = string> = Record<Locale, T>;
export type ReviewState = 'pending' | 'approved';
export type ContentStage = 'draft' | 'language-reviewed' | 'audio-reviewed' | 'approved';

export interface ContentReview {
  status: ContentStage;
  language: ReviewState;
  pronunciation: ReviewState;
  approximation: ReviewState;
  audio: ReviewState;
  recordIds: string[];
}

export interface PhraseSegment {
  id: string;
  hanzi: string;
  meaning: Bilingual;
  /** Draft citation readings are displayable; a non-null value is not approval. */
  pronunciation: string | null;
  approximateZh: string | null;
}

export interface LearningText {
  id: string;
  version: string;
  kind: 'expression' | 'dialogue' | 'support-term';
  stationIds: string[];
  /** null means a semantic draft has not yet been rewritten in Shanghainese. */
  hanzi: string | null;
  textKind: 'shanghainese-candidate' | 'semantic-draft' | 'reviewed-shanghainese';
  meaning: Bilingual;
  segments: PhraseSegment[];
  pronunciation: string | null;
  /** Identifies the spelling and citation-tone convention, including its limits. */
  pronunciationSchemeId?: string;
  /** This field and its UI affordance must never be shown in English mode. */
  approximateZh: string | null;
  pronunciationHelp: Bilingual<string | null>;
  referenceReading: {
    file: string | null;
    sha256: string | null;
    speakerId: string | null;
    recordedAt: string | null;
  };
  acceptableVariants: Array<{ hanzi: string; context: Bilingual }>;
  audio: { normal: string; slow?: string };
  sourceIds: string[];
  review: ContentReview;
  intent?: string;
  usage?: Bilingual;
  description?: Bilingual;
  trigger?: string;
  role?: 'server';
  parameters?: Record<string, string[]>;
  reviewFocus?: Bilingual;
  semanticValue?: { type: string; value: string | number | boolean };
}

export interface PronunciationScheme {
  id: string;
  name: Bilingual;
  version: string;
  toneNotation: 'citation-category-suffix';
  toneCategories: Record<string, string>;
  syllableSeparator: string;
  /** Teaching groups are not necessarily phonological tone-sandhi domains. */
  teachingGroupSeparator: string;
  /** An omitted number means unresolved, not an asserted neutral tone. */
  unnumberedSyllables: Array<{ hanzi: string; romanization: string; reason: string }>;
  sandhiStatus: ReviewState;
  sourceIds: string[];
  notice: Bilingual;
}

export interface AudioClip {
  id: string;
  textId: string;
  textVersion: string;
  speed: 'normal' | 'slow';
  status: 'pending' | 'generated' | 'approved';
  file: string | null;
  sha256: string | null;
  durationMs: number | null;
  source: 'tts' | 'human' | null;
  provider: string | null;
  deployment: 'hosted' | 'self-hosted' | 'human' | null;
  model: string | null;
  voice: string | null;
  voiceConfigVersion: string | null;
  generationConfig: Record<string, unknown> | null;
  generatedAt: string | null;
  reviewIds: string[];
}

export interface StationMetadata {
  id: 'restaurant' | 'candy' | 'nanxiang' | 'teahouse';
  version: string;
  name: Bilingual;
  taskTitle: Bilingual;
  taskDescription: Bilingual;
  recommendedOrder: number;
  estimatedMinutes: [number, number];
  /** References for future stations may be outside the Batch A teaching scope. */
  expressionIds: string[];
  implementedInBatchA: boolean;
  availableWithoutUnlock: boolean;
  sourceIds: string[];
  copyReview: { status: ReviewState; recordIds: string[] };
}

export interface ReviewRecord {
  id: string;
  contentId: string;
  contentVersion: string;
  stage: 'language' | 'pronunciation' | 'approximation' | 'audio' | 'editorial';
  subjectSha256: string;
  reviewerId: string;
  decision: 'approved' | 'changes-requested';
  reviewedAt: string;
  notes: string;
  evidence: {
    referenceAudio?: string;
    clipId?: string;
    sha256?: string;
    trialNotes?: string;
  };
}

export interface ReviewLedger {
  schemaVersion: 1;
  reviewers: Array<{
    id: string;
    displayName: string;
    fluentShanghainese: boolean;
    roles: Array<'language' | 'pronunciation' | 'approximation' | 'audio' | 'editorial' | 'release'>;
  }>;
  records: ReviewRecord[];
  releaseApprovals: Array<{
    id: string;
    contentVersion: string;
    packageSha256: string;
    reviewerId: string;
    decision: 'approved' | 'changes-requested';
    reviewedAt: string;
    notes: string;
  }>;
}
