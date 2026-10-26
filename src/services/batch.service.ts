import { DAY_MS } from '../models/favorite';
import { FavoriteService } from './favorite.service';

export type BatchChange = { kind: 'complete' | 'ignore' } | { kind: 'postpone'; reviewAt: number };

/** Validate the entire frozen selection before changing any record. */
export async function updateFavoritesBatch(favorites: FavoriteService, ids: string[], change: BatchChange, now = Date.now()): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10_000
    || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new Error('请选择 1–10000 条有效收藏');
  if (!change || typeof change !== 'object' || !['complete', 'ignore', 'postpone'].includes(change.kind)) throw new Error('批量操作无效');
  if (change.kind === 'postpone' && (!Number.isFinite(change.reviewAt) || change.reviewAt <= now || change.reviewAt > now + 3650 * DAY_MS)) throw new Error('请选择未来十年内的提醒时间');
  const selected = new Set(ids);
  await favorites.storage.transaction(state => {
    const records = state.favorites.filter(item => selected.has(item.id));
    if (records.length !== selected.size) throw new Error('部分所选记录已被删除，请刷新后重新选择');
    for (const record of records) {
      if (change.kind === 'postpone') {
        record.reviewAt = change.reviewAt;
        record.status = 'pending';
        delete record.notifiedAt;
        delete record.notificationClaimedAt;
        delete record.notificationRetryAt;
        delete record.notificationError;
      } else record.status = change.kind === 'complete' ? 'completed' : 'ignored';
    }
  });
}
