import type { FavoriteRecord } from './favorite';

export interface CaptureResult { record: FavoriteRecord; created: boolean }
export type CaptureFeedbackMode = 'page' | 'receipt';
export interface CaptureNotice {
  kind: 'saved' | 'duplicate' | 'failed' | 'unconfirmed';
  title: string;
  detail: string;
  at: number;
  recordId?: string;
}

export const CAPTURE_FEEDBACK_KEY = 'bookmind.capture-feedback';
export const CAPTURE_NOTIFICATION_ID = 'bookmind:capture-feedback';
export const CAPTURE_TOAST_ID = 'bookmind-next-capture-feedback';

export function savedNotice({ record, created }: CaptureResult, now = Date.now()): CaptureNotice {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(record.reviewAt);
  return {
    kind: created ? 'saved' : 'duplicate',
    title: created ? '已记入 BookMind Next' : 'BookMind 中已有这条收藏',
    detail: `${record.title.slice(0, 120)}\n${created ? `复盘时间：${date}` : '未重复添加，原复盘状态和提醒时间保持不变。'}`,
    at: now, recordId: record.id,
  };
}

export function failedNotice(unconfirmed = false, now = Date.now()): CaptureNotice {
  return {
    kind: unconfirmed ? 'unconfirmed' : 'failed',
    title: unconfirmed ? '暂时无法确认 BookMind 保存结果' : 'BookMind 未能保存这条收藏',
    detail: unconfirmed ? '请打开扩展的收藏库确认，原网站的收藏操作不受影响。' : '原网站的收藏操作不受影响，请打开扩展检查后重试。',
    at: now,
  };
}

export function isCaptureNotice(value: unknown): value is CaptureNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as CaptureNotice;
  return ['saved', 'duplicate', 'failed', 'unconfirmed'].includes(notice.kind)
    && typeof notice.title === 'string' && notice.title.length <= 200
    && typeof notice.detail === 'string' && notice.detail.length <= 500
    && Number.isFinite(notice.at) && notice.at >= 0 && notice.at <= 8_640_000_000_000_000;
}
