import { DEFAULT_SETTINGS, type AppState, type Diagnostic, type FavoriteRecord, type QuarantinedItem } from '../models/favorite';
import { contentKey, safeWebUrl, xPostIdentity } from '../utils/url';

const DATA_ERROR = '本地数据格式异常，未覆盖原数据。请检查扩展版本。';
const MAX_DATE = 8_640_000_000_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE;
export type RecordValidationCache = Map<string, { reason?: string; key?: string }>;

function favoriteError(value: unknown): string | undefined {
  if (!object(value)) return '记录不是对象';
  if (!text(value.id, 256) || !(value.id as string).trim()) return '记录 ID 无效';
  if (!['chrome', 'bilibili', 'zhihu', 'x'].includes(value.source as string)) return '收藏来源无效';
  if (!text(value.title, 500) || !(value.title as string).trim()) return '标题无效';
  if (!safeWebUrl(value.originalUrl) || !safeWebUrl(value.reviewUrl)) return '收藏链接无效';
  if (!['article', 'video', 'course', 'unknown'].includes(value.contentType as string)) return '内容类型无效';
  if (!['pending', 'completed', 'ignored'].includes(value.status as string)) return '复盘状态无效';
  if (!time(value.createdAt) || !time(value.reviewAt)) return '收藏或提醒时间无效';
  for (const field of ['description', 'note', 'summary'] as const) {
    if (value[field] !== undefined && !text(value[field], 10_000)) return `${field} 字段无效`;
  }
  if (value.coverUrl !== undefined && !safeWebUrl(value.coverUrl)) return '封面链接无效';
  if (value.bvId !== undefined && (typeof value.bvId !== 'string' || !/^BV[0-9a-zA-Z]{10}$/.test(value.bvId))) return 'BV 号无效';
  if (value.episode !== undefined && (!Number.isInteger(value.episode) || (value.episode as number) < 1 || (value.episode as number) >= 100_000)) return '分集序号无效';
  for (const field of ['notifiedAt', 'notificationClaimedAt', 'notificationRetryAt'] as const) {
    if (value[field] !== undefined && !time(value[field])) return `${field} 字段无效`;
  }
  if (value.notificationError !== undefined && !text(value.notificationError, 500)) return '通知错误信息无效';
  if (value.titleEdited !== undefined && typeof value.titleEdited !== 'boolean') return '标题编辑标记无效';
  if (value.source === 'x' || value.postId !== undefined || value.textPreview !== undefined) {
    const original = xPostIdentity(value.originalUrl as string);
    const review = xPostIdentity(value.reviewUrl as string);
    if (!original || !review || typeof value.postId !== 'string' || original.postId !== value.postId || review.postId !== value.postId) return 'X 帖子身份无效';
    if (typeof value.textPreview !== 'string' || Array.from(value.textPreview).length > 280) return 'X 文本预览无效';
  }
  return undefined;
}

function validDiagnostic(value: unknown): value is Diagnostic {
  return object(value) && time(value.at) && text(value.message, 500);
}

function validDigest(value: unknown): boolean {
  if (!object(value) || typeof value.id !== 'string' || !/^bookmind:digest:[\w-]{1,128}$/.test(value.id)
    || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
    || !time(value.claimedAt) || !Array.isArray(value.members) || !value.members.length) return false;
  const date = new Date(`${value.day}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.day) return false;
  if (value.deliveredAt !== undefined && !time(value.deliveredAt)) return false;
  if (value.retryAt !== undefined && (!time(value.retryAt) || value.deliveredAt !== undefined)) return false;
  const ids = new Set<string>();
  return value.members.every(member => {
    if (!object(member) || !text(member.id, 256) || !(member.id as string).trim() || !time(member.reviewAt) || ids.has(member.id as string)) return false;
    ids.add(member.id as string);
    return true;
  });
}

/** Pure read repair. Persist it in the next successful transaction, not in reads. */
export function normalizeStoredState(input: unknown, cache: RecordValidationCache = new Map()): AppState {
  // Validate each unchanged record once per worker. The cache contains only the
  // current read's fingerprints and validation results, never mutable records.
  const previous = new Map(cache);
  cache.clear();
  const raw = structuredClone(input);
  if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.favorites) || !Array.isArray(raw.diagnostics)) throw new Error(DATA_ERROR);
  if (raw.quarantine !== undefined && (!Array.isArray(raw.quarantine) || raw.quarantine.some(item => (
    !object(item) || !['favorite', 'settings', 'diagnostic', 'reminder'].includes(item.kind as string)
    || typeof item.reason !== 'string' || !Object.hasOwn(item, 'value')
  )))) throw new Error(DATA_ERROR);

  const quarantine = (raw.quarantine ?? []) as QuarantinedItem[];
  const previousCount = quarantine.length;
  if (raw.digestDelivery !== undefined && !validDigest(raw.digestDelivery)) {
    quarantine.push({ kind: 'reminder', reason: '集中提醒投递记录格式无效', value: raw.digestDelivery });
    delete raw.digestDelivery;
  }
  const favorites: FavoriteRecord[] = [];
  const ids = new Set<string>();
  for (const value of raw.favorites) {
    const fingerprint = JSON.stringify(value);
    const validated = previous.get(fingerprint) ?? (() => {
      const reason = favoriteError(value);
      return { reason, key: reason ? undefined : contentKey((value as FavoriteRecord).reviewUrl) };
    })();
    cache.set(fingerprint, validated);
    let reason = validated.reason;
    if (!reason && ids.has((value as FavoriteRecord).id)) reason = '记录 ID 重复';
    if (reason) {
      quarantine.push({ kind: 'favorite', reason, value });
      continue;
    }
    const item = value as FavoriteRecord;
    // Recompute legacy keys without changing ID, URLs, status or reminder state.
    item.contentKey = validated.key!;
    ids.add(item.id);
    favorites.push(item);
  }

  const settings = { ...DEFAULT_SETTINGS };
  const invalidSettings: string[] = [];
  if (object(raw.settings)) {
    const days = raw.settings.defaultReviewDays;
    if (typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365) settings.defaultReviewDays = days;
    else invalidSettings.push('defaultReviewDays');
    for (const key of ['notificationsEnabled', 'bilibiliEnabled'] as const) {
      if (typeof raw.settings[key] === 'boolean') settings[key] = raw.settings[key];
      else invalidSettings.push(key);
    }
    // Added after schema v1 shipped: a missing switch is a normal upgrade.
    if (raw.settings.zhihuEnabled !== undefined) {
      if (typeof raw.settings.zhihuEnabled === 'boolean') settings.zhihuEnabled = raw.settings.zhihuEnabled;
      else invalidSettings.push('zhihuEnabled');
    }
    if (raw.settings.xEnabled !== undefined) {
      if (typeof raw.settings.xEnabled === 'boolean') settings.xEnabled = raw.settings.xEnabled;
      else invalidSettings.push('xEnabled');
    }
    if (raw.settings.reminderMode !== undefined) {
      if (raw.settings.reminderMode === 'single' || raw.settings.reminderMode === 'digest') settings.reminderMode = raw.settings.reminderMode;
      else invalidSettings.push('reminderMode');
    }
  } else invalidSettings.push('settings');
  if (invalidSettings.length) quarantine.push({ kind: 'settings', reason: `无效设置已恢复默认值：${invalidSettings.join('、')}`, value: raw.settings ?? null });

  const diagnostics: Diagnostic[] = [];
  for (const value of raw.diagnostics) {
    if (validDiagnostic(value) && diagnostics.length < 10) diagnostics.push(value);
    else quarantine.push({ kind: 'diagnostic', reason: validDiagnostic(value) ? '超出最近 10 条运行记录' : '运行记录格式无效', value });
  }
  if (quarantine.length > previousCount) {
    diagnostics.unshift({ at: Date.now(), message: `发现 ${quarantine.length - previousCount} 项异常本地数据，已隔离并保留原值；正常收藏与提醒继续运行。` });
    diagnostics.splice(10);
  }
  const result = { ...raw, schemaVersion: 1, favorites, settings, diagnostics } as AppState;
  if (quarantine.length || raw.quarantine !== undefined) result.quarantine = quarantine;
  return result;
}
