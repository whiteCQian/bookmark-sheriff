import { DAY_MS, type CaptureContent, type FavoriteSource, type FavoriteRecord, type ReviewStatus, type Settings } from '../models/favorite';
import { contentKey, safeWebUrl, xPostIdentity } from '../utils/url';
import { StorageService } from './storage.service';
import type { CaptureResult } from '../models/capture';

export class FavoriteService {
  constructor(readonly storage: StorageService, private readonly now: () => number = Date.now) {}

  async capture(source: FavoriteSource, content: CaptureContent, capturedAt?: number): Promise<FavoriteRecord> {
    return (await this.captureWithResult(source, content, capturedAt)).record;
  }

  async captureWithResult(source: FavoriteSource, content: CaptureContent, capturedAt?: number): Promise<CaptureResult> {
    const originalUrl = safeWebUrl(content.originalUrl);
    const reviewUrl = safeWebUrl(content.reviewUrl);
    if (!originalUrl || !reviewUrl) throw new Error('收藏链接无效');
    const x = source === 'x' ? xPostIdentity(reviewUrl) : undefined;
    if (source === 'x' && (!x || xPostIdentity(originalUrl)?.postId !== x.postId || content.postId !== x.postId
      || typeof content.textPreview !== 'string' || Array.from(content.textPreview).length > 280)) throw new Error('X 帖子信息无效');
    const key = contentKey(reviewUrl);
    return this.storage.transaction(state => {
      const existing = state.favorites.find(item => item.contentKey === key);
      if (existing) {
        // A prior Chrome bookmark keeps its source, title and review progress.
        if (x && !existing.postId && xPostIdentity(existing.originalUrl)?.postId === x.postId) {
          existing.postId = x.postId; existing.textPreview = content.textPreview!;
        }
        return { record: existing, created: false };
      }
      const now = this.now();
      const createdAt = typeof capturedAt === 'number' && Number.isFinite(capturedAt) && capturedAt >= 0 && capturedAt <= now ? capturedAt : now;
      const record: FavoriteRecord = {
        title: content.title.trim().slice(0, 500) || originalUrl,
        originalUrl, reviewUrl, contentType: content.contentType,
        ...(content.bvId ? { bvId: content.bvId } : {}),
        ...(content.episode ? { episode: content.episode } : {}),
        ...(safeWebUrl(content.coverUrl) ? { coverUrl: safeWebUrl(content.coverUrl) } : {}),
        ...(x ? { postId: x.postId, textPreview: content.textPreview! } : {}),
        id: crypto.randomUUID(), source, contentKey: key, createdAt,
        reviewAt: createdAt + state.settings.defaultReviewDays * DAY_MS, status: 'pending',
      };
      state.favorites.unshift(record);
      return { record, created: true };
    });
  }

  /** A cover update cannot edit the title, reminder generation or review progress. */
  async setCover(id: string, coverUrl: string, expectedKey: string): Promise<boolean> {
    const safe = safeWebUrl(coverUrl);
    if (!safe) return false;
    return this.storage.transaction(state => {
      const item = state.favorites.find(record => record.id === id && record.contentKey === expectedKey);
      if (!item) return false;
      item.coverUrl = safe;
      return true;
    });
  }

  async update(id: string, patch: { title?: string; note?: string; reviewAt?: number; status?: ReviewStatus }): Promise<void> {
    if (patch.title !== undefined && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 500)) throw new Error('标题须为 1–500 个字符');
    if (patch.note !== undefined && (typeof patch.note !== 'string' || patch.note.length > 10000)) throw new Error('备注不能超过 10000 个字符');
    if (patch.reviewAt !== undefined && (!Number.isFinite(patch.reviewAt) || patch.reviewAt <= this.now() || patch.reviewAt > this.now() + 3650 * DAY_MS)) throw new Error('请选择未来十年内的提醒时间');
    if (patch.status !== undefined && !['pending', 'completed', 'ignored'].includes(patch.status)) throw new Error('复盘状态无效');
    await this.storage.transaction(state => {
      const item = state.favorites.find(record => record.id === id);
      if (!item) throw new Error('记录已被删除，请刷新');
      if (patch.title !== undefined) { item.title = patch.title.trim(); item.titleEdited = true; }
      if (patch.note !== undefined) item.note = patch.note;
      if (patch.status !== undefined) item.status = patch.status;
      if (patch.reviewAt !== undefined) {
        item.reviewAt = patch.reviewAt;
        item.status = 'pending';
        delete item.notifiedAt;
        delete item.notificationClaimedAt;
        delete item.notificationRetryAt;
        delete item.notificationError;
      }
    });
  }

  async remove(id: string): Promise<void> {
    await this.storage.transaction(state => { state.favorites = state.favorites.filter(item => item.id !== id); });
  }

  async settings(patch: Partial<Settings>): Promise<void> {
    if (patch.reminderMode !== undefined && !['single', 'digest'].includes(patch.reminderMode)) throw new Error('提醒方式无效');
    if (patch.defaultReviewDays !== undefined && (!Number.isInteger(patch.defaultReviewDays) || patch.defaultReviewDays < 1 || patch.defaultReviewDays > 365)) throw new Error('默认提醒间隔须为 1–365 天');
    for (const key of ['notificationsEnabled', 'bilibiliEnabled', 'zhihuEnabled', 'xEnabled'] as const) {
      if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error('设置值无效');
    }
    await this.storage.transaction(state => { state.settings = { ...state.settings, ...patch }; });
  }

  async clear(): Promise<void> {
    await this.storage.transaction(state => { state.favorites = []; state.diagnostics = []; delete state.quarantine; delete state.digestDelivery; });
  }
}
