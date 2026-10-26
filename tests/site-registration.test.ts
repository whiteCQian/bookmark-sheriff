import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FavoriteService } from '../src/services/favorite.service';
import { emptyState, StorageService } from '../src/services/storage.service';
import { SiteRegistrationService, ZHIHU_ORIGINS, ZHIHU_SCRIPT_ID } from '../src/services/site-registration.service';

let granted: boolean;
let scripts: chrome.scripting.RegisteredContentScript[];
let api: { runtime: { getManifest: () => { version: string } }; tabs: { query: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> }; permissions: { contains: ReturnType<typeof vi.fn> }; scripting: { executeScript: ReturnType<typeof vi.fn>; getRegisteredContentScripts: ReturnType<typeof vi.fn>; registerContentScripts: ReturnType<typeof vi.fn>; unregisterContentScripts: ReturnType<typeof vi.fn> } };
function setup() {
  let data = emptyState();
  const storage = new StorageService({ read: async () => data, write: async value => { data = structuredClone(value); } });
  const favorites = new FavoriteService(storage);
  return { favorites, storage, sites: new SiteRegistrationService(favorites) };
}
beforeEach(() => {
  granted = false; scripts = [];
  api = {
    runtime: { getManifest: () => ({ version: '0.2.4' }) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
    permissions: { contains: vi.fn(async () => granted) },
    scripting: {
      executeScript: vi.fn(async () => []),
      getRegisteredContentScripts: vi.fn(async () => structuredClone(scripts)),
      registerContentScripts: vi.fn(async (value: chrome.scripting.RegisteredContentScript[]) => { scripts.push(...value); }),
      unregisterContentScripts: vi.fn(async () => { scripts = []; }),
    },
  };
  vi.stubGlobal('chrome', api);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('知乎实验性动态脚本注册（模拟Chrome权限API）', () => {
  it('默认关闭，即使站点权限已存在也不注册', async () => {
    const { sites } = setup(); granted = true;
    await sites.reconcile();
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
  it('开启且已授权时仅注册详情页脚本，重复及并发reconcile幂等', async () => {
    const { favorites, sites } = setup(); granted = true;
    await favorites.settings({ zhihuEnabled: true });
    await Promise.all([sites.reconcile(), sites.reconcile(), sites.reconcile()]);
    expect(api.permissions.contains).toHaveBeenCalledWith({ origins: ZHIHU_ORIGINS });
    expect(api.scripting.registerContentScripts).toHaveBeenCalledExactlyOnceWith([{
      id: ZHIHU_SCRIPT_ID, matches: ['https://zhuanlan.zhihu.com/p/*', 'https://www.zhihu.com/question/*/answer/*'],
      js: ['zhihu.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
    }]);
  });
  it('权限撤销后取消持久注册并将设置关闭，保留收藏记录', async () => {
    const { favorites, storage, sites } = setup(); granted = true;
    const record = await favorites.capture('chrome', { title: '旧收藏', originalUrl: 'https://example.com/', reviewUrl: 'https://example.com/', contentType: 'unknown' });
    await favorites.settings({ zhihuEnabled: true }); await sites.reconcile();
    granted = false; await sites.reconcile();
    expect(scripts).toEqual([]);
    expect(api.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: [ZHIHU_SCRIPT_ID] });
    expect((await storage.snapshot()).settings.zhihuEnabled).toBe(false);
    expect((await storage.snapshot()).favorites).toEqual([record]);
  });
  it('关闭设置时取消注册但不主动撤销已授予权限', async () => {
    const { favorites, sites } = setup(); granted = true;
    await favorites.settings({ zhihuEnabled: true }); await sites.reconcile();
    await favorites.settings({ zhihuEnabled: false }); await sites.reconcile();
    expect(scripts).toEqual([]); expect(granted).toBe(true);
  });
  it('权限查询失败按未授权处理，不注册', async () => {
    const { favorites, storage, sites } = setup();
    await favorites.settings({ zhihuEnabled: true });
    api.permissions.contains.mockRejectedValue(new Error('API unavailable'));
    await sites.reconcile();
    expect((await storage.snapshot()).settings.zhihuEnabled).toBe(false);
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
  it('注册错误可见且不会破坏队列，下一次可重试', async () => {
    const { favorites, sites } = setup(); granted = true;
    await favorites.settings({ zhihuEnabled: true });
    api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('registration failed'));
    await expect(sites.reconcile()).rejects.toThrow('registration failed');
    await sites.reconcile(); expect(scripts).toHaveLength(1);
  });
  it('开启后立刻注入已打开的详情页，排除问题列表、外站和无ID页，并发不重复注入', async () => {
    const { favorites, sites } = setup(); granted = true;
    api.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://zhuanlan.zhihu.com/p/123' },
      { id: 2, url: 'https://www.zhihu.com/question/123/answer/456' },
      { id: 3, url: 'https://www.zhihu.com/question/123' },
      { id: 4, url: 'https://example.com/p/123' }, { url: 'https://zhuanlan.zhihu.com/p/123' },
    ]);
    await favorites.settings({ zhihuEnabled: true });
    await Promise.all([sites.reconcile(), sites.reconcile()]);
    expect(api.scripting.executeScript.mock.calls).toEqual([
      [{ target: { tabId: 1, frameIds: [0] }, files: ['zhihu.js'] }],
      [{ target: { tabId: 2, frameIds: [0] }, files: ['zhihu.js'] }],
    ]);
  });
  it('持久注册已存在时新服务仍激活旧标签页，注入失败能重试且不阻塞其他页面', async () => {
    const { favorites, sites } = setup(); granted = true;
    scripts = [{ id: ZHIHU_SCRIPT_ID, js: ['zhihu.js'], matches: ['https://zhuanlan.zhihu.com/p/*'] }];
    api.tabs.query.mockResolvedValue([{ id: 1, url: 'https://zhuanlan.zhihu.com/p/123' }, { id: 2, url: 'https://zhuanlan.zhihu.com/p/456' }]);
    api.scripting.executeScript.mockRejectedValueOnce(new Error('tab closed'));
    await favorites.settings({ zhihuEnabled: true });
    await expect(sites.reconcile()).rejects.toThrow('请刷新');
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
    await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(4);
    await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(4);
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
  it('重新启用会重新激活旧页；未授权不查询或注入页面', async () => {
    const { favorites, sites } = setup();
    await sites.reconcile(); expect(api.tabs.query).not.toHaveBeenCalled();
    granted = true; await favorites.settings({ zhihuEnabled: true }); await sites.reconcile();
    await favorites.settings({ zhihuEnabled: false }); await sites.reconcile();
    await favorites.settings({ zhihuEnabled: true }); await sites.reconcile();
    expect(api.tabs.query).toHaveBeenCalledTimes(2);
  });
  it('后台重新构建服务后探测健康脚本，不能重新注入打断正在保存的收藏', async () => {
    const { favorites, sites } = setup(); granted = true;
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://zhuanlan.zhihu.com/p/123' }]);
    api.tabs.sendMessage.mockResolvedValue({ version: '0.2.4', page: { code: 'saving', at: 1000 } });
    await favorites.settings({ zhihuEnabled: true }); await sites.reconcile();
    await new SiteRegistrationService(favorites).reconcile();
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'BOOKMIND_ZHIHU_STATUS' }, { frameId: 0 });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it.each([{ version: '0.2.3', page: { code: 'saving', at: 1000 } }, { version: '0.2.4', page: { code: 'invented', at: 1 } }, { version: '0.2.4', page: { code: 'ready', at: NaN } }, { version: '0.2.4', page: { code: 'disabled', at: 1 } }])('旧版本、禁用或非法回复仍需修复注入 %#', async reply => {
    const { favorites, sites } = setup(); granted = true;
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://zhuanlan.zhihu.com/p/123' }]); api.tabs.sendMessage.mockResolvedValue(reply);
    await favorites.settings({ zhihuEnabled: true }); await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
});
