import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZhihuDetectorOptions } from '../src/detectors/zhihu-favorite';
import { CAPTURE_TOAST_ID } from '../src/models/capture';

const mocks = vi.hoisted(() => ({ detector: vi.fn() }));
vi.mock('wxt/utils/define-unlisted-script', () => ({ defineUnlistedScript: (main: () => void) => ({ main }) }));
vi.mock('../src/detectors/zhihu-favorite', () => ({ createZhihuFavoriteDetector: mocks.detector }));
import script from '../entrypoints/zhihu';

const url = 'https://zhuanlan.zhihu.com/p/28852607';
let enabled: boolean;
let options: ZhihuDetectorOptions;
let events: Set<(...args: any[]) => void>;
let dispose: ReturnType<typeof vi.fn>;
let messageListeners: Set<(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => void>;
const sendMessage = vi.fn();
const page = window as Window & { __bookmindZhihuDispose?: () => void };
beforeEach(async () => {
  enabled = true; events = new Set(); messageListeners = new Set(); dispose = vi.fn();
  vi.stubGlobal('location', { href: url }); document.title = '页面最小标题';
  mocks.detector.mockImplementation((value: ZhihuDetectorOptions) => { options = value; return { setEnabled: vi.fn(), dispose, checkLocation: vi.fn(), getStatus: () => ({ code: 'ready', at: 1 }) }; });
  sendMessage.mockReset().mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { zhihuEnabled: enabled } } : { ok: true, data: { id: 'saved-record' } });
  vi.stubGlobal('chrome', { runtime: { sendMessage, id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, getManifest: () => ({ version: '0.2.3' }), onMessage: { addListener: (listener: any) => messageListeners.add(listener), removeListener: (listener: any) => messageListeners.delete(listener) } }, storage: { onChanged: { addListener: (listener: (...args: any[]) => void) => events.add(listener), removeListener: (listener: (...args: any[]) => void) => events.delete(listener) } } });
  (script as { main: () => void }).main(); await Promise.resolve();
});
afterEach(() => { page.__bookmindZhihuDispose?.(); delete page.__bookmindZhihuDispose; vi.unstubAllGlobals(); });

describe('授权后注入的知乎入口（Chrome消息模拟）', () => {
  it('只发送当前标题和URL，忽略事件传入的旧标题', async () => {
    location.href = `${url}?utm_source=entry#heading`;
    await options.onFavorite({ url, title: '旧标题' });
    expect(sendMessage).toHaveBeenCalledWith({ type: 'ZHIHU_FAVORITE', url: location.href, title: document.title });
  });
  it('发送前再次检查开关，撤销后不保存', async () => {
    enabled = false; await options.onFavorite({ url, title: '标题' });
    expect(sendMessage.mock.calls.some(([request]) => request.type === 'ZHIHU_FAVORITE')).toBe(false);
  });
  it('候选后切换详情页不把旧事件保存到新页面', async () => {
    location.href = url.replace('28852607', '28852608'); await options.onFavorite({ url, title: '标题' });
    expect(sendMessage.mock.calls.some(([request]) => request.type === 'ZHIHU_FAVORITE')).toBe(false);
  });
  it('后台保存失败显示扩展失败提示，连接中断只显示未确认', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { zhihuEnabled: true } } : { ok: false, error: 'quota' });
    await options.onFavorite({ url, title: '标题' });
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('BookMind 未能保存');
    sendMessage.mockImplementation(async message => { if (message.type === 'GET_CAPTURE_SETTINGS') return { ok: true, data: { zhihuEnabled: true } }; throw new Error('connection closed'); });
    await options.onFavorite({ url, title: '标题' });
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('无法确认'); warning.mockRestore();
  });
  it('再次注入先清理旧检测器与监听器，显式dispose也清理', async () => {
    expect(events.size).toBe(1);
    const oldDispose = dispose; (script as { main: () => void }).main(); await Promise.resolve();
    expect(oldDispose).toHaveBeenCalledOnce(); expect(events.size).toBe(1);
    expect(messageListeners.size).toBe(1);
    page.__bookmindZhihuDispose?.(); expect(events.size).toBe(0); expect(messageListeners.size).toBe(0);
  });
  it('只向扩展页面响应状态，成功入库后返回saved，缺少记录ID不能当保存成功', async () => {
    const listener = [...messageListeners][0]; const respond = vi.fn();
    listener({ type: 'BOOKMIND_ZHIHU_STATUS' }, { id: 'test', url }, respond); expect(respond).not.toHaveBeenCalled();
    await options.onFavorite({ url, title: '标题' });
    listener({ type: 'BOOKMIND_ZHIHU_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ version: '0.2.3', page: { code: 'saved' } });
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { zhihuEnabled: true } } : { ok: true });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await options.onFavorite({ url, title: '标题' }); listener({ type: 'BOOKMIND_ZHIHU_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ page: { code: 'unconfirmed' } }); warning.mockRestore();
  });
  it('旧页面disposer抛出上下文失效时，新脚本仍可启动并保存', async () => {
    page.__bookmindZhihuDispose?.();
    page.__bookmindZhihuDispose = () => { throw new Error('Extension context invalidated.'); };
    expect(() => (script as { main: () => void }).main()).not.toThrow(); await Promise.resolve();
    expect(messageListeners.size).toBe(1); await options.onFavorite({ url, title: '标题' });
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'ZHIHU_FAVORITE')).toBe(true);
  });
  it('focus读取设置遇上下文失效时清理监听，只显示一次刷新提示，不再请求后台', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1); expect(events.size).toBe(0); expect(messageListeners.size).toBe(0);
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('BookMind 已更新');
    const calls = sendMessage.mock.calls.length;
    window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); await options.onFavorite({ url, title: '标题' });
    expect(sendMessage).toHaveBeenCalledTimes(calls); expect(warning).not.toHaveBeenCalled(); warning.mockRestore();
  });
  it('runtime.id消失时直接停止，不能继续尝试发送消息', async () => {
    const calls = sendMessage.mock.calls.length; (chrome.runtime as { id?: string }).id = undefined;
    window.dispatchEvent(new Event('focus')); await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(calls); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('Chrome监听器移除抛错也必须完成DOM监听清理，清理后回调不再发送消息', async () => {
    chrome.runtime.onMessage.removeListener = vi.fn(() => { throw new Error('Extension context invalidated.'); });
    chrome.storage.onChanged.removeListener = vi.fn(() => { throw new Error('Extension context invalidated.'); });
    expect(() => page.__bookmindZhihuDispose?.()).not.toThrow();
    const calls = sendMessage.mock.calls.length; window.dispatchEvent(new Event('focus'));
    for (const listener of events) listener({}, 'local'); await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledTimes(calls); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('普通后台连接异常不误当扩展更新，保留后续恢复机会', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve();
    await options.onFavorite({ url, title: '标题' });
    expect(sendMessage.mock.calls.some(([message]) => message.type === 'ZHIHU_FAVORITE')).toBe(true); warning.mockRestore();
  });
});
