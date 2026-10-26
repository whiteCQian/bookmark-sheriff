import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FavoriteService } from '../src/services/favorite.service';
import { emptyState, StorageService } from '../src/services/storage.service';
import { XRegistrationService, X_ORIGINS, X_SCRIPT_ID } from '../src/services/x-registration.service';

let granted: boolean;
let scripts: chrome.scripting.RegisteredContentScript[];
let api: any;
function setup() {
  let data = emptyState();
  const storage = new StorageService({ read: async () => data, write: async value => { data = structuredClone(value); } });
  const favorites = new FavoriteService(storage);
  return { favorites, storage, sites: new XRegistrationService(favorites) };
}
beforeEach(() => {
  granted = false; scripts = [];
  api = {
    runtime: { getManifest: () => ({ version: 'test-x' }) },
    tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
    permissions: { contains: vi.fn(async () => granted) },
    scripting: {
      getRegisteredContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => structuredClone(scripts.filter(script => ids.includes(script.id)))),
      registerContentScripts: vi.fn(async (value: chrome.scripting.RegisteredContentScript[]) => { scripts.push(...value); }),
      unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => { scripts = scripts.filter(script => !ids.includes(script.id)); }),
      executeScript: vi.fn(async () => []),
    },
  };
  vi.stubGlobal('chrome', api);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('X 可选权限与动态注册（模拟Chrome API）', () => {
  it('默认关闭，即使已有权限也不注册', async () => {
    const { sites } = setup(); granted = true; await sites.reconcile();
    expect(api.scripting.registerContentScripts).not.toHaveBeenCalled(); expect(api.tabs.query).not.toHaveBeenCalled();
  });
  it('开启并授权后覆盖信息流和详情的SPA入口，并发幂等', async () => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    await Promise.all([sites.reconcile(), sites.reconcile(), sites.reconcile()]);
    expect(api.permissions.contains).toHaveBeenCalledWith({ origins: X_ORIGINS });
    expect(api.scripting.registerContentScripts).toHaveBeenCalledExactlyOnceWith([{
      id: X_SCRIPT_ID, matches: ['https://x.com/*'], js: ['x.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true,
    }]);
    expect(api.tabs.query).toHaveBeenCalledTimes(1);
  });
  it('拒绝/撤销权限关闭X设置及注册，保留记录与其他平台注册', async () => {
    const { favorites, storage, sites } = setup(); granted = true;
    const saved = await favorites.capture('chrome', { title: '既有书签', originalUrl: 'https://example.com/', reviewUrl: 'https://example.com/', contentType: 'unknown' });
    scripts.push({ id: 'bookmind-zhihu', matches: ['https://www.zhihu.com/*'], js: ['zhihu.js'] });
    await favorites.settings({ xEnabled: true }); await sites.reconcile(); granted = false; await sites.reconcile();
    expect((await storage.snapshot()).settings.xEnabled).toBe(false); expect((await storage.snapshot()).favorites).toEqual([saved]);
    expect(scripts.map(script => script.id)).toEqual(['bookmind-zhihu']);
    expect(api.scripting.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: [X_SCRIPT_ID] });
  });
  it('关闭不撤销已授权限，重新开启会重新激活旧页', async () => {
    const { favorites, sites } = setup(); granted = true;
    await favorites.settings({ xEnabled: true }); await sites.reconcile();
    await favorites.settings({ xEnabled: false }); await sites.reconcile(); expect(granted).toBe(true);
    await favorites.settings({ xEnabled: true }); await sites.reconcile(); expect(api.tabs.query).toHaveBeenCalledTimes(2);
  });
  it('授权查询失败按未授权处理', async () => {
    const { favorites, storage, sites } = setup(); await favorites.settings({ xEnabled: true });
    api.permissions.contains.mockRejectedValue(new Error('permission query failed')); await sites.reconcile();
    expect((await storage.snapshot()).settings.xEnabled).toBe(false); expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });
  it('只激活已打开的精确HTTPS x.com顶层页面，包括信息流和搜索', async () => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    api.tabs.query.mockResolvedValue([
      { id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://x.com/user/status/1234567890123456789' }, { id: 3, url: 'https://x.com/search?q=test' },
      { id: 4, url: 'https://twitter.com/home' }, { id: 5, url: 'https://x.com.evil.example/home' }, { id: 6, url: 'http://x.com/home' },
      { id: 7, url: 'https://x.com:444/home' }, { id: 8, url: 'https://name:password@x.com/home' }, { url: 'https://x.com/home' },
    ]);
    await sites.reconcile();
    expect(api.scripting.executeScript.mock.calls).toEqual([1, 2, 3].map(tabId => [{ target: { tabId, frameIds: [0] }, files: ['x.js'] }]));
  });
  it('Worker重新构造后探测同版本健康监听，不打断保存', async () => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://x.com/home' }]);
    api.tabs.sendMessage.mockResolvedValue({ version: 'test-x', page: { code: 'saving', at: 1000 } });
    await sites.reconcile(); await new XRegistrationService(favorites).reconcile();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'BOOKMIND_X_STATUS' }, { frameId: 0 });
  });
  it.each([
    undefined, { version: 'old-x', page: { code: 'ready', at: 1 } }, { version: 'test-x', page: { code: 'disabled', at: 1 } },
    { version: 'test-x', page: { code: 'ready', at: NaN } }, { version: 'test-x', page: { code: 1, at: 1 } },
  ])('不存在、旧版、禁用或非法回复时修复注入 %#', async reply => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://x.com/home' }]); api.tabs.sendMessage.mockResolvedValue(reply);
    await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
  it('单页失败不阻塞其他页，保留重试；下次仅修复仍失联页', async () => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    api.tabs.query.mockResolvedValue([{ id: 1, url: 'https://x.com/home' }, { id: 2, url: 'https://x.com/search?q=test' }]);
    const ready = new Set<number>();
    api.tabs.sendMessage.mockImplementation(async (tabId: number) => ready.has(tabId) ? { version: 'test-x', page: { code: 'ready', at: 1000 } } : undefined);
    api.scripting.executeScript.mockRejectedValueOnce(new Error('tab closed')).mockImplementation(async ({ target }: { target: { tabId: number } }) => { ready.add(target.tabId); return []; });
    await expect(sites.reconcile()).rejects.toThrow('请刷新'); expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
    await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(3);
    await sites.reconcile(); expect(api.scripting.executeScript).toHaveBeenCalledTimes(3);
  });
  it('注册失败不会破坏队列，下一次重试', async () => {
    const { favorites, sites } = setup(); granted = true; await favorites.settings({ xEnabled: true });
    api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('register failed'));
    await expect(sites.reconcile()).rejects.toThrow('register failed'); await sites.reconcile(); expect(scripts).toHaveLength(1);
  });
});
