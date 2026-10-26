import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppState, type FavoriteRecord } from '../src/models/favorite';
import { FavoriteService } from '../src/services/favorite.service';
import { emptyState, StorageService } from '../src/services/storage.service';
import { contentKey } from '../src/utils/url';

function record(patch: Partial<FavoriteRecord> = {}): FavoriteRecord {
  return {
    id: 'healthy', source: 'chrome', title: '保留的文章', contentType: 'article',
    originalUrl: 'https://example.com/#/article/1', reviewUrl: 'https://example.com/#/article/1',
    contentKey: 'https://example.com/', createdAt: 1000, reviewAt: 2000,
    status: 'pending', ...patch,
  };
}

function setup(initial: unknown = emptyState()) {
  let data = structuredClone(initial);
  const write = vi.fn(async (value: AppState) => { data = structuredClone(value); });
  const storage = new StorageService({ read: async () => data, write });
  return { storage, write, data: () => data as AppState, favorites: new FavoriteService(storage, () => 1000) };
}

describe('逐条本地数据校验与保留', () => {
  it('旧设置缺失提醒方式时默认单条，不隔离、不修改已有通知偏好与计划', async () => {
    const oldSettings = { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: true };
    const old = record({ status: 'completed', notifiedAt: 1500, note: '原备注' });
    const h = setup({ ...emptyState(), favorites: [old], settings: oldSettings });
    const state = await h.storage.snapshot();
    expect(state.settings).toEqual({ ...oldSettings, xEnabled: false, reminderMode: 'single' });
    expect(state.quarantine).toBeUndefined();
    expect(state.favorites[0]).toMatchObject({ status: 'completed', reviewAt: old.reviewAt, notifiedAt: 1500, note: '原备注' });
    expect(h.write).not.toHaveBeenCalled();
  });

  it('提醒方式只能显式更新为 single 或 digest，非法值不覆盖原设置', async () => {
    const h = setup();
    await h.favorites.settings({ reminderMode: 'digest' });
    expect((await h.storage.snapshot()).settings.reminderMode).toBe('digest');
    await expect(h.favorites.settings({ reminderMode: 'flood' as never })).rejects.toThrow('提醒方式无效');
    expect((await h.storage.snapshot()).settings.reminderMode).toBe('digest');
    await h.favorites.settings({ reminderMode: 'single' });
    expect((await h.storage.snapshot()).settings.reminderMode).toBe('single');
  });

  it('合法集中投递日志跨读取和编辑完整保留，清空时删除', async () => {
    const digestDelivery = { id: 'bookmind:digest:batch-1', day: '2026-10-24', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 2000 }], retryAt: 3000 };
    const h = setup({ ...emptyState(), favorites: [record()], digestDelivery });
    expect((await h.storage.snapshot()).digestDelivery).toEqual(digestDelivery);
    await h.favorites.update('healthy', { note: '提醒之外的正常编辑' });
    expect(h.data().digestDelivery).toEqual(digestDelivery);
    await h.favorites.clear();
    expect(h.data().digestDelivery).toBeUndefined();
    expect(h.data().settings).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    null,
    { id: 'bookmind:digest:bad', day: '2026-02-30', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 2000 }] },
    { id: 'javascript:bad', day: '2026-10-24', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 2000 }] },
    { id: 'bookmind:digest:bad', day: '2026-10-24', claimedAt: NaN, members: [{ id: 'healthy', reviewAt: 2000 }] },
    { id: 'bookmind:digest:bad', day: '2026-10-24', claimedAt: 1000, members: [] },
    { id: 'bookmind:digest:bad', day: '2026-10-24', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 'bad' }] },
    { id: 'bookmind:digest:bad', day: '2026-10-24', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 2000 }, { id: 'healthy', reviewAt: 2000 }] },
    { id: 'bookmind:digest:bad', day: '2026-10-24', claimedAt: 1000, members: [{ id: 'healthy', reviewAt: 2000 }], deliveredAt: 2000, retryAt: 3000 },
  ])('损坏集中日志被保留隔离，不丢失旧收藏：%j', async digestDelivery => {
    const h = setup({ ...emptyState(), favorites: [record()], digestDelivery });
    const state = await h.storage.snapshot();
    expect(state.favorites).toHaveLength(1);
    expect(state.digestDelivery).toBeUndefined();
    expect(state.quarantine).toEqual([{ kind: 'reminder', reason: expect.any(String), value: digestDelivery }]);
    expect(h.write).not.toHaveBeenCalled();
    await h.favorites.update('healthy', { note: '仍可复盘' });
    expect(h.data().favorites[0].note).toBe('仍可复盘');
    expect(h.data().quarantine?.[0].value).toEqual(digestDelivery);
    expect(h.data().digestDelivery).toBeUndefined();
    expect((await h.storage.snapshot()).quarantine).toHaveLength(1);
  });
  it.each([
    null, { ...record(), status: 'broken' }, { ...record(), title: null },
    { ...record(), reviewAt: NaN }, { ...record(), reviewAt: Infinity },
    { ...record(), reviewAt: 8_640_000_000_000_001 },
    { ...record(), originalUrl: 'javascript:alert(1)' },
    { ...record(), coverUrl: 'data:text/html,bad' },
    { ...record(), notificationClaimedAt: 'yesterday' },
    { ...record(), episode: -1 }, { ...record(), titleEdited: 'true' },
  ])('隔离异常记录且不阻塞健康记录：%j', async bad => {
    const h = setup({ ...emptyState(), favorites: [record(), bad] });
    const state = await h.storage.snapshot();
    expect(state.favorites).toHaveLength(1);
    expect(state.quarantine).toEqual([{ kind: 'favorite', reason: expect.any(String), value: bad }]);
    expect(h.write).not.toHaveBeenCalled();
    await h.favorites.update('healthy', { note: '仍然可以复盘' });
    expect(h.data().favorites[0].note).toBe('仍然可以复盘');
    expect(h.data().quarantine?.[0].value).toEqual(bad);
  });

  it('只修复无效设置字段，保留有效开关与原设置', async () => {
    const badSettings = { defaultReviewDays: 0, notificationsEnabled: false, bilibiliEnabled: true, zhihuEnabled: false };
    const h = setup({ ...emptyState(), settings: badSettings });
    const state = await h.storage.snapshot();
    expect(state.settings).toEqual({ ...DEFAULT_SETTINGS, notificationsEnabled: false });
    expect(state.quarantine?.[0]).toMatchObject({ kind: 'settings', value: badSettings });
    await h.favorites.settings({ defaultReviewDays: 7 });
    expect(h.data().settings.defaultReviewDays).toBe(7);
    const writes = h.write.mock.calls.length;
    await h.storage.transaction(() => undefined);
    expect(h.write).toHaveBeenCalledTimes(writes);
    expect((await h.storage.snapshot()).quarantine).toHaveLength(1);
  });

  it('损坏的运行记录与重复 ID 也被保留隔离', async () => {
    const diagnostic = { at: 'invalid', message: null };
    const h = setup({ ...emptyState(), favorites: [record(), record({ title: '重复 ID' })], diagnostics: [diagnostic] });
    const state = await h.storage.snapshot();
    expect(state.favorites).toHaveLength(1);
    expect(state.quarantine?.map(item => item.kind)).toEqual(['favorite', 'diagnostic']);
    expect(state.quarantine?.[1].value).toEqual(diagnostic);
    expect(state.diagnostics[0].message).toContain('2 项异常');
  });

  it.each([
    { schemaVersion: 2, favorites: [], settings: DEFAULT_SETTINGS, diagnostics: [] },
    { ...emptyState(), favorites: {} },
    { ...emptyState(), quarantine: [{ kind: 'favorite', reason: '缺少原值' }] },
  ])('未知版本或容器损坏仍拒绝覆盖', async initial => {
    const h = setup(initial);
    await expect(h.storage.transaction(() => undefined)).rejects.toThrow('未覆盖');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.data()).toEqual(initial);
  });

  it('清空操作同时移除隔离原值且保留设置', async () => {
    const h = setup({ ...emptyState(), favorites: [record(), null] });
    await h.favorites.clear();
    expect(h.data()).toEqual(emptyState());
  });

  it('写入失败保留原数据，随后可重试修复', async () => {
    const initial = { ...emptyState(), favorites: [record(), null] };
    const h = setup(initial);
    h.write.mockRejectedValueOnce(new Error('配额已满'));
    await expect(h.favorites.update('healthy', { note: '新备注' })).rejects.toThrow('配额');
    expect(h.data()).toEqual(initial);
    await h.favorites.update('healthy', { note: '重试成功' });
    expect(h.data().favorites[0].note).toBe('重试成功');
    expect(h.data().quarantine?.[0].value).toBeNull();
  });

  it('重复读取彼此隔离，同一 ID 的数据改变后重新校验', async () => {
    const h = setup({ ...emptyState(), favorites: [record()] });
    const first = await h.storage.snapshot();
    first.favorites[0].title = '只改返回副本';
    expect((await h.storage.snapshot()).favorites[0].title).toBe('保留的文章');
    // A caller or another extension version can change persisted data between reads.
    h.data().favorites[0].reviewAt = NaN;
    const changed = await h.storage.snapshot();
    expect(changed.favorites).toHaveLength(0);
    expect(changed.quarantine?.[0]).toMatchObject({ kind: 'favorite', reason: '收藏或提醒时间无效' });
  });
});

describe('旧记录标识兼容与无效写入抑制', () => {
  it('旧设置缺少知乎开关时正常升级为关闭，不隔离也不清空记录', async () => {
    const oldSettings = { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: true };
    const h = setup({ ...emptyState(), settings: oldSettings, favorites: [record()] });
    expect((await h.storage.snapshot()).settings).toEqual({ ...oldSettings, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
    expect((await h.storage.snapshot()).quarantine).toBeUndefined();
    expect((await h.storage.snapshot()).favorites).toHaveLength(1);
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each(['completed', 'ignored'] as const)('升级后 %s 记录的历史元数据、链接、提醒与备注在读取和编辑后完整保留', async status => {
    const old = record({
      status, description: '历史简介，升级后仅保留原值', coverUrl: 'https://example.com/legacy-cover.jpg',
      summary: '历史摘要', contentType: 'course', titleEdited: true,
      note: '历史个人备注', notifiedAt: 1500, notificationClaimedAt: 1400,
      notificationRetryAt: 1800, notificationError: '历史通知错误',
    });
    const h = setup({ ...emptyState(), favorites: [old] });
    const expected = { ...old, contentKey: 'https://example.com/#/article/1' };
    expect((await h.storage.snapshot()).favorites).toEqual([expected]);
    expect((await h.storage.snapshot()).quarantine).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
    await h.favorites.update(old.id, { title: '修改历史标题', note: '修改个人备注' });
    expect(h.data().favorites).toEqual([{ ...expected, title: '修改历史标题', note: '修改个人备注' }]);
    expect(h.data().quarantine).toBeUndefined();
  });
  it('旧 key 在读取时修复，下一事务一次落盘，保留复盘进度', async () => {
    const old = record({ status: 'completed', note: '个人备注', notifiedAt: 1500 });
    const h = setup({ ...emptyState(), favorites: [old] });
    const state = await h.storage.snapshot();
    expect(state.favorites[0]).toEqual({ ...old, contentKey: 'https://example.com/#/article/1' });
    expect(h.write).not.toHaveBeenCalled();
    await h.storage.transaction(() => undefined);
    expect(h.write).toHaveBeenCalledTimes(1);
    await h.favorites.capture('chrome', { ...old, reviewUrl: 'https://example.com/?utm_source=x#/article/1' });
    expect(h.write).toHaveBeenCalledTimes(1);
    await h.favorites.capture('chrome', { ...old, reviewUrl: 'https://example.com/#/article/2' });
    expect(h.data().favorites).toHaveLength(2);
    expect(h.data().favorites[1]).toMatchObject({ status: 'completed', note: '个人备注', reviewAt: 2000, notifiedAt: 1500 });
  });

  it('正常读取、相同设置、空事务与重复事件均不写回整库', async () => {
    const h = setup();
    const first = await h.favorites.capture('chrome', record());
    expect(h.write).toHaveBeenCalledTimes(1);
    await h.storage.snapshot();
    await h.storage.transaction(() => undefined);
    await h.favorites.settings({ defaultReviewDays: 3 });
    await h.favorites.capture('chrome', record());
    await h.favorites.update(first.id, { status: 'pending' });
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});

describe('URL 路由与普通锚点', () => {
  it('保留不同 #/ 与 #!/ 页面，去除入口追踪参数', () => {
    expect(contentKey('https://example.com/?utm_source=x#/article/1')).toBe('https://example.com/#/article/1');
    expect(contentKey('https://example.com/#/article/1')).not.toBe(contentKey('https://example.com/#/article/2'));
    expect(contentKey('https://example.com/#!/article/1')).not.toBe(contentKey('https://example.com/#!/article/2'));
    expect(contentKey('https://example.com/#/article/1?mode=full')).not.toBe(contentKey('https://example.com/#/article/1?mode=short'));
  });

  it('普通段落锚点仍合并，B站仍按 BV 与分集识别', () => {
    expect(contentKey('https://example.com/read#one')).toBe(contentKey('https://example.com/read#two'));
    expect(contentKey('https://www.bilibili.com/video/BV1ex411x7Em/?p=2#reply')).toBe('bilibili:BV1ex411x7Em:p2');
  });
});
