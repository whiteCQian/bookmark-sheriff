import type { FavoriteRecord } from '../models/favorite';

export const statusLabels = { pending: '待复盘', completed: '已完成', ignored: '已忽略' } as const;
export const sourceLabels = { chrome: 'Chrome 书签', bilibili: '哔哩哔哩', zhihu: '知乎', x: 'X' } as const;
export const typeLabels = { article: '文章', video: '视频', course: '课程', unknown: '网页' } as const;

export function formatDate(value: number, withTime = true): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } as const : {}),
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } as const : {}),
  }).format(date);
}

export function toLocalDateTime(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function endOfToday(now = Date.now()): number {
  const date = new Date(now); date.setHours(23, 59, 59, 999); return date.getTime();
}

export function hostname(item: FavoriteRecord): string {
  try { return new URL(item.reviewUrl).hostname.replace(/^www\./, ''); } catch { return '原始网页'; }
}
