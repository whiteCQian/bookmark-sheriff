import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/models/favorite';
import { DAY_MS } from '../src/models/favorite';
import { StorageService } from '../src/services/storage.service';
import { FavoriteService } from '../src/services/favorite.service';
import { updateFavoritesBatch, type BatchChange } from '../src/services/batch.service';
import { createMessageRouter } from '../src/services/message-router';

const now = 1_700_000_000_000;
async function setup() {
  let data: AppState | undefined;
  const write = vi.fn(async (state: AppState) => { data = structuredClone(state); });
  const storage = new StorageService({ read: async () => data, write });
  const favorites = new FavoriteService(storage, () => now);
  const records = await Promise.all(['a', 'b', 'c'].map(suffix => favorites.capture('chrome', {
    title: suffix, originalUrl: `https://example.com/${suffix}#part`, reviewUrl: `https://example.com/${suffix}`, contentType: 'unknown',
  })));
  write.mockClear();
  return { favorites, storage, write, records, raw: () => structuredClone(data!) };
}
afterEach(() => vi.unstubAllGlobals());

describe('批量处理：单次持久化事务', () => {
  it('完成和忽略只影响冻结的选择，每批只写一次', async () => {
    const h = await setup();
    await updateFavoritesBatch(h.favorites, [h.records[0].id, h.records[1].id], { kind: 'complete' }, now);
    expect(h.write).toHaveBeenCalledTimes(1);
    const byTitle = Object.fromEntries((await h.storage.snapshot()).favorites.map(item => [item.title, item.status]));
    expect(byTitle).toEqual({ a: 'completed', b: 'completed', c: 'pending' });
    await updateFavoritesBatch(h.favorites, [h.records[0].id], { kind: 'ignore' }, now);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect((await h.storage.snapshot()).favorites.find(item => item.title === 'a')?.status).toBe('ignored');
  });
  it('延期采用同一新计划并清理旧投递标记，保留URL、备注、旧字段与非选中记录', async () => {
    const h = await setup();
    await h.storage.transaction(state => {
      const item = state.favorites.find(item => item.id === h.records[0].id)!;
      Object.assign(item, { note: '保留', description: '旧描述', coverUrl: 'https://example.com/old.png', status: 'completed', notifiedAt: now, notificationClaimedAt: now, notificationRetryAt: now + 10, notificationError: 'old' });
    });
    h.write.mockClear();
    const before = h.raw();
    await updateFavoritesBatch(h.favorites, [h.records[0].id, h.records[1].id], { kind: 'postpone', reviewAt: now + DAY_MS }, now);
    const state = await h.storage.snapshot();
    const a = state.favorites.find(item => item.title === 'a')!;
    expect(a).toMatchObject({ status: 'pending', reviewAt: now + DAY_MS, note: '保留', description: '旧描述', originalUrl: 'https://example.com/a#part' });
    for (const field of ['notifiedAt', 'notificationClaimedAt', 'notificationRetryAt', 'notificationError']) expect(a).not.toHaveProperty(field);
    expect(state.favorites.find(item => item.title === 'c')).toEqual(before.favorites.find(item => item.title === 'c'));
    expect(h.write).toHaveBeenCalledOnce();
  });
  it('重复ID不会重复更新或新增记录', async () => {
    const h = await setup();
    await updateFavoritesBatch(h.favorites, [h.records[0].id, h.records[0].id], { kind: 'complete' }, now);
    expect(h.write).toHaveBeenCalledOnce();
    expect((await h.storage.snapshot()).favorites).toHaveLength(3);
  });
  it('任一ID已删除则全批失败，无部分提交', async () => {
    const h = await setup(); const before = h.raw();
    await expect(updateFavoritesBatch(h.favorites, [h.records[0].id, 'missing'], { kind: 'complete' }, now)).rejects.toThrow('已被删除');
    expect(h.raw()).toEqual(before); expect(h.write).not.toHaveBeenCalled();
  });
  it('配额写入失败保留整批原数据，之后可重试', async () => {
    const h = await setup(); const before = h.raw();
    h.write.mockRejectedValueOnce(new Error('quota'));
    const ids = h.records.map(item => item.id);
    await expect(updateFavoritesBatch(h.favorites, ids, { kind: 'ignore' }, now)).rejects.toThrow('quota');
    expect(h.raw()).toEqual(before);
    await updateFavoritesBatch(h.favorites, ids, { kind: 'ignore' }, now);
    expect((await h.storage.snapshot()).favorites.every(item => item.status === 'ignored')).toBe(true);
  });
  it.each([[], [''], [null], 'a', undefined])('拒绝无效选择 %j', async ids => {
    const h = await setup();
    await expect(updateFavoritesBatch(h.favorites, ids as string[], { kind: 'complete' }, now)).rejects.toThrow('有效收藏');
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each([null, { kind: 'delete' }, { kind: 'postpone', reviewAt: NaN }, { kind: 'postpone', reviewAt: now }, { kind: 'postpone', reviewAt: now + 3651 * DAY_MS }])('拒绝无效动作/时间 %j', async change => {
    const h = await setup();
    await expect(updateFavoritesBatch(h.favorites, [h.records[0].id], change as BatchChange, now)).rejects.toThrow();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('并发新收藏不会自动加入批量选择或被覆盖', async () => {
    const h = await setup();
    await Promise.all([
      updateFavoritesBatch(h.favorites, h.records.map(item => item.id), { kind: 'complete' }, now),
      h.favorites.capture('chrome', { title: 'new', originalUrl: 'https://example.com/new', reviewUrl: 'https://example.com/new', contentType: 'unknown' }),
    ]);
    const state = await h.storage.snapshot();
    expect(state.favorites).toHaveLength(4);
    expect(state.favorites.find(item => item.title === 'new')?.status).toBe('pending');
  });
  it('后台批量消息仅管理页可用，完成后只调用一次调度刷新', async () => {
    const h = await setup();
    vi.stubGlobal('chrome', { runtime: { id: 'test', getURL: (value: string) => `chrome-extension://test/${value}` } });
    const changed = vi.fn(async () => {});
    const route = createMessageRouter(h.favorites, changed, async () => {});
    const message = { type: 'BATCH_UPDATE_FAVORITES', ids: [h.records[0].id], change: { kind: 'complete' } };
    await expect(route(message, { id: 'test', url: 'https://www.bilibili.com/video/BV1xx411c7mD/', frameId: 0 })).rejects.toThrow('仅扩展管理页面');
    expect(h.write).not.toHaveBeenCalled();
    await route(message, { id: 'test', url: 'chrome-extension://test/dashboard.html' });
    expect(h.write).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce();
  });
});
