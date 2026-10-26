import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, FavoriteRecord } from '../src/models/favorite';
import { createMessageRouter } from '../src/services/message-router';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService } from '../src/services/storage.service';

const extensionId = 'bookmind-test-extension';
const extensionRoot = `chrome-extension://${extensionId}/`;
const videoUrl = 'https://www.bilibili.com/video/BV1ex411x7Em/?p=2';
const extensionSender: chrome.runtime.MessageSender = { id: extensionId, url: `${extensionRoot}options.html` };
const videoSender = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
  id: extensionId, url: videoUrl, frameId: 0, tab: { id: 42 } as chrome.tabs.Tab, ...overrides,
});
const captureRequest = { type: 'BILIBILI_FAVORITE', url: `${videoUrl}&spm_id_from=333.788`, title: '视频分集' };

function setup() {
  let data: AppState | undefined;
  const storage = new StorageService({
    read: async () => data,
    write: async value => { data = structuredClone(value); },
  });
  const favorites = new FavoriteService(storage, () => 1000);
  const changed = vi.fn(async () => undefined);
  const open = vi.fn(async (_url: string) => undefined);
  const route = createMessageRouter(favorites, changed, open);
  return { storage, favorites, changed, open, route };
}

async function addArticle(favorites: FavoriteService) {
  return favorites.capture('chrome', {
    title: '文章', originalUrl: 'https://example.com/read#source', reviewUrl: 'https://example.com/read', contentType: 'article',
  });
}

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { id: extensionId, getURL: (path: string) => `${extensionRoot}${path}` } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('扩展管理页面消息', () => {
  it('只有扩展页面能补充当前已收藏页封面，不恢复旧元数据接口', async () => {
    const { favorites, storage, changed, open } = setup();
    const refreshCurrentSavedPage = vi.fn(async () => ({ status: 'no_saved_record' as const }));
    const updateSaved = vi.fn(async () => undefined);
    const route = createMessageRouter(favorites, changed, open, undefined, { refreshCurrentSavedPage, updateSaved });
    expect(await route({ type: 'REFRESH_CURRENT_COVER' }, extensionSender)).toEqual({ status: 'no_saved_record' });
    await expect(route({ type: 'REFRESH_CURRENT_COVER' }, videoSender())).rejects.toThrow('仅扩展管理页面');
    await expect(route({ type: 'REFRESH_CURRENT_METADATA' }, extensionSender)).rejects.toThrow('未知操作');
    expect(refreshCurrentSavedPage).toHaveBeenCalledOnce();
    expect(updateSaved).not.toHaveBeenCalled();
    expect((await storage.snapshot()).favorites).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });
  it('返回可独立读取的完整状态，读取没有管理副作用', async () => {
    const { route, favorites, storage, changed, open } = setup();
    const record = await addArticle(favorites);
    const state = await route({ type: 'GET_STATE' }, extensionSender) as AppState;
    expect(state.favorites).toEqual([record]);
    expect(state.settings).toEqual({ defaultReviewDays: 3, notificationsEnabled: true, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
    state.favorites[0].title = '只修改返回值';
    expect((await storage.snapshot()).favorites[0].title).toBe('文章');
    expect(changed).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('允许编辑、完成、忽略及删除，成功变更后通知调度器', async () => {
    const { route, favorites, storage, changed } = setup();
    const record = await addArticle(favorites);
    await route({ type: 'UPDATE_FAVORITE', id: record.id, patch: { title: ' 新标题 ', note: '复盘笔记', status: 'completed' } }, extensionSender);
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ title: '新标题', note: '复盘笔记', status: 'completed' });
    await route({ type: 'UPDATE_FAVORITE', id: record.id, patch: { status: 'ignored' } }, extensionSender);
    expect((await storage.snapshot()).favorites[0].status).toBe('ignored');
    await route({ type: 'DELETE_FAVORITE', id: record.id }, extensionSender);
    expect((await storage.snapshot()).favorites).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('同扩展管理页位于浏览器标签页时仍允许读取和修改', async () => {
    const { route, storage, changed } = setup();
    const sender = { ...extensionSender, tab: { id: 42 } as chrome.tabs.Tab };
    await route({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays: 7 } }, sender);
    expect(await route({ type: 'GET_STATE' }, sender)).toEqual(await storage.snapshot());
    expect((await storage.snapshot()).settings.defaultReviewDays).toBe(7);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('打开原始复盘链接保留待复盘状态及提醒时间', async () => {
    const { route, favorites, storage, open, changed } = setup();
    const record = await addArticle(favorites);
    const before = await storage.snapshot();
    await route({ type: 'OPEN_FAVORITE', id: record.id }, extensionSender);
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/read');
    expect(await storage.snapshot()).toEqual(before);
    expect((await storage.snapshot()).favorites[0].status).toBe('pending');
    expect(changed).not.toHaveBeenCalled();
  });

  it('设置仅接受允许字段，清空移除收藏和诊断并保留设置', async () => {
    const { route, favorites, storage, changed } = setup();
    await addArticle(favorites);
    await storage.report('示例诊断');
    await route({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, injected: 'ignored' } }, extensionSender);
    expect((await storage.snapshot()).settings).toEqual({ defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' });
    await route({ type: 'CLEAR_DATA' }, extensionSender);
    expect(await storage.snapshot()).toEqual({
      schemaVersion: 1, favorites: [], diagnostics: [],
      settings: { defaultReviewDays: 7, notificationsEnabled: false, bilibiliEnabled: false, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' },
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it.each([
    { id: 'other-extension', url: `${extensionRoot}options.html` },
    { id: extensionId, url: 'https://example.com/options.html' },
    { id: extensionId, url: 'chrome-extension://another-extension/options.html' },
    { id: extensionId },
    videoSender(),
  ])('拒绝非管理页面读取和修改数据 %#', async sender => {
    const { route, favorites, storage, changed } = setup();
    await addArticle(favorites);
    const before = await storage.snapshot();
    for (const request of [{ type: 'GET_STATE' }, { type: 'CLEAR_DATA' }, { type: 'UPDATE_SETTINGS', patch: { bilibiliEnabled: false } }]) {
      await expect(route(request, sender)).rejects.toThrow('仅扩展管理页面可以执行此操作');
    }
    expect(await storage.snapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('B 站收藏消息来源与持久化', () => {
  it('站点记录提交后才补当前授权页封面，读取失败不会改报保存失败', async () => {
    const { favorites, storage, changed, open } = setup();
    const updateSaved = vi.fn(async (tabId: number, recordId: string) => {
      expect(tabId).toBe(42);
      expect((await storage.snapshot()).favorites[0].id).toBe(recordId);
      throw new Error('page unavailable');
    });
    const route = createMessageRouter(favorites, changed, open, undefined, { updateSaved, refreshCurrentSavedPage: async () => ({ status: 'unavailable' }) });
    const record = await route(captureRequest, videoSender()) as FavoriteRecord;
    await Promise.resolve();
    expect(updateSaved).toHaveBeenCalledWith(42, record.id);
    expect((await storage.snapshot()).favorites).toHaveLength(1);
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ title: captureRequest.title, status: 'pending', reviewAt: record.reviewAt });
    vi.spyOn(favorites, 'captureWithResult').mockRejectedValueOnce(new Error('quota'));
    await expect(route(captureRequest, videoSender())).rejects.toThrow('quota');
    expect(updateSaved).toHaveBeenCalledOnce();
  });
  it('提交成功后才发送提示，提示失败不把已保存记录变成保存失败', async () => {
    const { favorites, storage, changed, open } = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const capture = vi.fn(async (result: { record: FavoriteRecord; created: boolean }, tabId: number) => {
      expect((await storage.snapshot()).favorites[0].id).toBe(result.record.id);
      expect(result.created).toBe(true);
      expect(tabId).toBe(42);
      throw new Error('receipt failed');
    });
    const route = createMessageRouter(favorites, changed, open, { capture, clear: async () => {} });
    const record = await route(captureRequest, videoSender()) as FavoriteRecord;
    expect(record.id).toBeDefined();
    expect(capture).toHaveBeenCalledOnce();
    expect((await storage.snapshot()).favorites).toHaveLength(1);
    warning.mockRestore();
  });

  it('写入失败只发送失败提示；清空时清除会话回执', async () => {
    const { favorites, changed, open } = setup();
    const capture = vi.fn(async () => {});
    const failed = vi.fn(async () => {});
    const clear = vi.fn(async () => {});
    const route = createMessageRouter(favorites, changed, open, { capture, failed, clear });
    vi.spyOn(favorites, 'captureWithResult').mockRejectedValue(new Error('quota'));
    await expect(route(captureRequest, videoSender())).rejects.toThrow('quota');
    expect(capture).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(captureRequest.url, 42);
    expect(changed).not.toHaveBeenCalled();
    await route({ type: 'CLEAR_DATA' }, extensionSender);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('顶层视频页可读取最小采集设置，不能读取管理数据', async () => {
    const { route, favorites } = setup();
    await favorites.settings({ bilibiliEnabled: false, notificationsEnabled: false });
    expect(await route({ type: 'GET_CAPTURE_SETTINGS' }, videoSender())).toEqual({ bilibiliEnabled: false });
    await expect(route({ type: 'GET_STATE' }, videoSender())).rejects.toThrow('仅扩展管理页面可以执行此操作');
    await expect(route({ type: 'GET_CAPTURE_SETTINGS' }, extensionSender)).rejects.toThrow('无权读取设置');
  });

  it('有效顶层收藏保存最小分集数据；重复事件不重置复盘状态', async () => {
    const { route, favorites, storage, changed } = setup();
    const first = await route(captureRequest, videoSender()) as FavoriteRecord;
    expect(first).toMatchObject({
      title: '视频分集', source: 'bilibili', contentType: 'video', bvId: 'BV1ex411x7Em', episode: 2,
      reviewUrl: videoUrl, status: 'pending', contentKey: 'bilibili:BV1ex411x7Em:p2',
    });
    await favorites.update(first.id, { status: 'completed', note: '已经复盘' });
    const duplicate = await route({ ...captureRequest, title: '重复标题' }, videoSender()) as FavoriteRecord;
    expect(duplicate.id).toBe(first.id);
    expect((await storage.snapshot()).favorites).toHaveLength(1);
    expect((await storage.snapshot()).favorites[0]).toMatchObject({ status: 'completed', note: '已经复盘', title: '视频分集' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it.each([
    videoSender({ url: 'https://evil.example/video/BV1ex411x7Em/?p=2' }),
    videoSender({ url: 'https://www.bilibili.com.evil.example/video/BV1ex411x7Em/?p=2' }),
    videoSender({ url: 'http://www.bilibili.com/video/BV1ex411x7Em/?p=2' }),
    videoSender({ url: 'https://www.bilibili.com/' }),
    videoSender({ frameId: 1 }),
    videoSender({ frameId: undefined }),
    videoSender({ url: undefined }),
    videoSender({ tab: undefined }),
    extensionSender,
  ])('拒绝非法来源，且不保存或触发副作用 %#', async sender => {
    const { route, storage, changed } = setup();
    await expect(route(captureRequest, sender)).rejects.toThrow('收藏事件来源无效');
    expect((await storage.snapshot()).favorites).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it.each([
    'https://www.bilibili.com/video/BV1Q541167Qg/?p=2',
    'https://www.bilibili.com/video/BV1ex411x7Em/?p=3',
    'https://www.bilibili.com/video/BV1ex411x7Em/',
    'https://evil.example/video/BV1ex411x7Em/?p=2',
    'javascript:alert(1)',
  ])('拒绝跨视频、跨分集及无效收藏链接 %s', async url => {
    const { route, storage, changed } = setup();
    await expect(route({ ...captureRequest, url }, videoSender())).rejects.toThrow('视频页面已切换，请重新收藏');
    expect((await storage.snapshot()).favorites).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('禁用 B 站采集后有效事件也不会保存', async () => {
    const { route, favorites, storage, changed } = setup();
    await favorites.settings({ bilibiliEnabled: false });
    await expect(route(captureRequest, videoSender())).resolves.toBeUndefined();
    expect((await storage.snapshot()).favorites).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('消息错误反馈', () => {
  it.each([undefined, null, 'GET_STATE', 1, {}, []])('拒绝缺失消息类型的输入 %#', async raw => {
    const { route, changed } = setup();
    await expect(route(raw, extensionSender)).rejects.toThrow('消息格式无效');
    expect(changed).not.toHaveBeenCalled();
  });

  it('返回未知操作、无效 patch 和缺失记录的明确错误', async () => {
    const { route, changed, open } = setup();
    await expect(route({ type: 'UNKNOWN' }, extensionSender)).rejects.toThrow('未知操作');
    await expect(route({ type: 'UPDATE_FAVORITE', id: 'missing', patch: null }, extensionSender)).rejects.toThrow('更新内容无效');
    await expect(route({ type: 'UPDATE_SETTINGS', patch: 'invalid' }, extensionSender)).rejects.toThrow('设置内容无效');
    await expect(route({ type: 'UPDATE_FAVORITE', id: 'missing', patch: { status: 'completed' } }, extensionSender)).rejects.toThrow('记录已被删除，请刷新');
    await expect(route({ type: 'OPEN_FAVORITE', id: 'missing' }, extensionSender)).rejects.toThrow('找不到有效的原始链接');
    expect(changed).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('设置校验失败保持原数据，随后仍能处理有效消息', async () => {
    const { route, storage, changed } = setup();
    const before = await storage.snapshot();
    await expect(route({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays: 0 } }, extensionSender)).rejects.toThrow('默认提醒间隔须为 1–365 天');
    await expect(route({ type: 'UPDATE_SETTINGS', patch: { notificationsEnabled: 'yes' } }, extensionSender)).rejects.toThrow('设置值无效');
    expect(await storage.snapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
    await route({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays: 5 } }, extensionSender);
    expect((await storage.snapshot()).settings.defaultReviewDays).toBe(5);
    expect(changed).toHaveBeenCalledOnce();
  });
});

describe('移除的内容读取消息', () => {
  it('旧消息被拒绝且不读取页面、不改变收藏与提醒', async () => {
    const { route, favorites, storage, changed } = setup();
    await addArticle(favorites);
    const before = await storage.snapshot();
    await expect(route({ type: 'REFRESH_CURRENT_METADATA' }, extensionSender)).rejects.toThrow('未知操作');
    expect(await storage.snapshot()).toEqual(before);
    expect(changed).not.toHaveBeenCalled();
  });
});
