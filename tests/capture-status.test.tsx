import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { currentCaptureStatus } from '../src/services/capture-status.service';
import { CurrentCaptureStatus } from '../src/components/CurrentCaptureStatus';

const url = 'https://www.zhihu.com/question/2073083082199011507/answer/2096980414967694847';
let api: any;
beforeEach(() => {
  api = {
    runtime: { getManifest: () => ({ version: '0.2.3' }), sendMessage: vi.fn() },
    tabs: { query: vi.fn(async () => [{ id: 42, url }]), sendMessage: vi.fn(async () => ({ version: '0.2.3', page: { code: 'row_pending', at: 1000, secret: 'discard' } })) },
    permissions: { contains: vi.fn(async () => true) },
    scripting: { getRegisteredContentScripts: vi.fn(async () => [{ id: 'bookmind-zhihu' }]) },
  };
  vi.stubGlobal('chrome', api); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });
describe('当前知乎页面只读诊断', () => {
  it('保留有限状态字段，使用顶层消息，不读写存储或触发收藏', async () => {
    expect(await currentCaptureStatus(true)).toEqual({ version: '0.2.3', enabled: true, permitted: true, registered: true, connection: 'connected', page: { code: 'row_pending', at: 1000 } });
    expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(42, { type: 'BOOKMIND_ZHIHU_STATUS' }, { frameId: 0 });
  });
  it('非详情页隐藏诊断且不向页面发送消息', async () => {
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://example.com/' }]);
    expect(await currentCaptureStatus(true)).toBeNull(); expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it.each([{ version: '0.2.2', page: { code: 'ready', at: 1 } }, { version: '0.2.3', page: { code: 'invented', at: 1 } }, { version: '0.2.3', page: { code: 'ready', at: NaN } }])('拒绝旧版本或非法状态 %#', async value => {
    api.tabs.sendMessage.mockResolvedValue(value); expect((await currentCaptureStatus(true))?.connection).toBe('missing');
  });
  it('页面未连接返回明确状态，权限和注册状态分别呈现', async () => {
    api.tabs.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    api.permissions.contains.mockResolvedValue(false); api.scripting.getRegisteredContentScripts.mockResolvedValue([]);
    expect(await currentCaptureStatus(false)).toMatchObject({ enabled: false, permitted: false, registered: false, connection: 'missing' });
  });
  it('Popup显示可读阶段和版本，读诊断不会提交新增消息', async () => {
    api.runtime.sendMessage.mockResolvedValue({ ok: true, data: await currentCaptureStatus(true) });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => { root.render(<CurrentCaptureStatus />); });
      expect(container.textContent).toContain('等待行与工具栏成功状态'); expect(container.textContent).toContain('row_pending');
      expect(container.textContent).toContain('0.2.3'); expect(api.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'GET_CURRENT_CAPTURE_STATUS' });
    } finally { await act(async () => { root.unmount(); }); }
  });
});

describe('当前X页面只读诊断', () => {
  beforeEach(() => {
    api.tabs.query.mockResolvedValue([{ id: 42, url: 'https://x.com/home' }]);
    api.scripting.getRegisteredContentScripts.mockResolvedValue([{ id: 'bookmind-x' }]);
    api.tabs.sendMessage.mockResolvedValue({ version: '0.2.3', page: { code: 'confirming', at: 1000, secret: 'discard' } });
  });
  it.each(['https://x.com/home', 'https://x.com/alice/status/2097401882574591186', 'https://x.com/search?q=test'])('X入口%s使用自己的授权/注册/顶层状态消息', async page => {
    api.tabs.query.mockResolvedValue([{ id: 42, url: page }]);
    expect(await currentCaptureStatus(false, true)).toEqual({ site: 'x', version: '0.2.3', enabled: true, permitted: true, registered: true, connection: 'connected', page: { code: 'confirming', at: 1000 } });
    expect(api.permissions.contains).toHaveBeenCalledExactlyOnceWith({ origins: ['https://x.com/*'] });
    expect(api.scripting.getRegisteredContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: ['bookmind-x'] });
    expect(api.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(42, { type: 'BOOKMIND_X_STATUS' }, { frameId: 0 });
  });
  it('X默认开关独立于知乎，并不因知乎已开启而误显示启用', async () => {
    expect(await currentCaptureStatus(true)).toMatchObject({ site: 'x', enabled: false });
  });
  it.each(['http://x.com/home', 'https://x.com.evil.test/home', 'https://name:password@x.com/home', 'https://x.com:444/home', 'https://twitter.com/home'])('非授权X来源%s不发页面消息', async page => {
    api.tabs.query.mockResolvedValue([{ id: 42, url: page }]); expect(await currentCaptureStatus(false, true)).toBeNull();
    expect(api.tabs.sendMessage).not.toHaveBeenCalled(); expect(api.permissions.contains).not.toHaveBeenCalled();
  });
  it.each([
    { version: 'old', page: { code: 'ready', at: 1 } },
    { version: '0.2.3', page: { code: 'invented', at: 1 } },
    { version: '0.2.3', page: { code: 'row_pending', at: 1 } },
    { version: '0.2.3', page: { code: 'ready', at: NaN } },
  ])('X旧版本、非法/其他站点状态不能显示为已连接 %#', async value => {
    api.tabs.sendMessage.mockResolvedValue(value); expect(await currentCaptureStatus(false, true)).toMatchObject({ site: 'x', connection: 'missing' });
  });
  it('失败或取消确认阶段可读，且没有帖子文本/URL泄漏字段', async () => {
    for (const code of ['failure', 'ambiguous', 'removed', 'save_failed', 'unconfirmed']) {
      api.tabs.sendMessage.mockResolvedValue({ version: '0.2.3', page: { code, at: 1000, preview: 'private text', url: 'https://x.com/private/status/123' } });
      expect((await currentCaptureStatus(false, true))?.page).toEqual({ code, at: 1000 });
    }
  });
  it.each([
    [{ enabled: false }, 'X监听未开启'],
    [{ permitted: false }, '缺少X站点权限'],
    [{ registered: false }, 'X脚本尚未注册'],
    [{ connection: 'missing' }, '当前页监听未连接'],
    [{ page: { code: 'failure', at: 1000 } }, 'X 报告操作失败'],
    [{ page: { code: 'removed', at: 1000 } }, '本地复盘任务保留'],
  ])('X Popup显示具体阶段和连接问题 %#，不会新增/修改收藏', async (patch, expected) => {
    api.runtime.sendMessage.mockResolvedValue({ ok: true, data: { ...(await currentCaptureStatus(false, true)), ...patch } });
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    try {
      await act(async () => { root.render(<CurrentCaptureStatus />); });
      expect(container.textContent).toContain('X监听状态'); expect(container.textContent).toContain(expected);
      expect(container.textContent).not.toContain('知乎监听状态');
      expect(api.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'GET_CURRENT_CAPTURE_STATUS' });
    } finally { await act(async () => { root.unmount(); }); }
  });
});
