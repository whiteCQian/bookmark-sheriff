export type FavoriteSource = 'chrome' | 'bilibili' | 'zhihu' | 'x';
export type ContentType = 'article' | 'video' | 'course' | 'unknown';
export type ReviewStatus = 'pending' | 'completed' | 'ignored';

/** Minimal data from a bookmark event or the page where saving succeeded. */
export interface CaptureContent {
  title: string;
  originalUrl: string;
  reviewUrl: string;
  contentType: ContentType;
  bvId?: string;
  episode?: number;
  coverUrl?: string;
  /** Explicitly requested X fields, read only from the saved post's own visible text. */
  postId?: string;
  textPreview?: string;
}

export interface FavoriteRecord extends CaptureContent {
  id: string;
  source: FavoriteSource;
  contentKey: string;
  createdAt: number;
  reviewAt: number;
  status: ReviewStatus;
  note?: string;
  /** Legacy v1 text fields remain local for upgrades, never collected or displayed. */
  description?: string;
  summary?: string;
  notifiedAt?: number;
  notificationClaimedAt?: number;
  notificationRetryAt?: number;
  notificationError?: string;
  titleEdited?: boolean;
}

export interface Settings {
  defaultReviewDays: number;
  notificationsEnabled: boolean;
  bilibiliEnabled: boolean;
  zhihuEnabled: boolean;
  xEnabled: boolean;
  reminderMode: 'single' | 'digest';
}

export interface DigestMember { id: string; reviewAt: number }
/** Frozen generations make notification recovery independent of the selected mode. */
export interface DigestDelivery {
  id: string;
  day: string;
  members: DigestMember[];
  claimedAt: number;
  retryAt?: number;
  deliveredAt?: number;
}

export interface Diagnostic { at: number; message: string }
export interface QuarantinedItem {
  kind: 'favorite' | 'settings' | 'diagnostic' | 'reminder';
  reason: string;
  /** Retain the original value locally for recovery; never schedule it. */
  value: unknown;
}
export interface AppState {
  schemaVersion: 1;
  favorites: FavoriteRecord[];
  settings: Settings;
  diagnostics: Diagnostic[];
  quarantine?: QuarantinedItem[];
  digestDelivery?: DigestDelivery;
}

export const DAY_MS = 86_400_000;
export const DEFAULT_SETTINGS: Settings = {
  defaultReviewDays: 3,
  notificationsEnabled: true,
  bilibiliEnabled: true,
  zhihuEnabled: false,
  xEnabled: false,
  reminderMode: 'single',
};
