import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XBookmarkEvent } from '../src/detectors/x-bookmark';
import { CAPTURE_TOAST_ID } from '../src/models/capture';

const mocks = vi.hoisted(() => ({ detector: vi.fn() }));
vi.mock('wxt/utils/define-unlisted-script', () => ({ defineUnlistedScript: (main: () => void) => ({ main }) }));
vi.mock('../src/detectors/x-bookmark', () => ({ createXBookmarkDetector: mocks.detector }));
import script from '../entrypoints/x';

const postUrl = 'https://x.com/alice/status/1234567890123456789';
const event: XBookmarkEvent = { url: postUrl, postId: '1234567890123456789', preview: '指定帖子的可见预览', action: 'add' };
const saved = { id: 'saved-x', captureNotice: { kind: 'saved', title: '已记入 BookMind Next', detail: '指定帖子的可见预览\n复盘时间：10/29 10:00', at: 1000, recordId: 'saved-x' } };
let enabled: boolean;
let options: { onBookmark: (event: XBookmarkEvent) => void | Promise<void> };
let dispose: ReturnType<typeof vi.fn>;
let listeners: Set<(...args: any[]) => void>;
let messages: Set<(message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => void>;
const sendMessage = vi.fn();
const page = window as Window & { __bookmindXDispose?: () => void };
beforeEach(async () => {
  enabled = true; dispose = vi.fn(); listeners = new Set(); messages = new Set();
  vi.stubGlobal('location', { href: 'https://x.com/home' }); document.title = '不要作为帖子标题的X首页';
  mocks.detector.mockImplementation(value => { options = value; return { setEnabled: vi.fn(), dispose, getStatus: () => ({ code: 'ready', at: 1 }), checkLocation: vi.fn() }; });
  sendMessage.mockReset().mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: enabled } }
    : message.action === 'remove' ? { ok: true, data: { action: 'remove', confirmed: true, postId: message.postId } } : { ok: true, data: saved });
  vi.stubGlobal('chrome', {
    runtime: { id: 'test', sendMessage, getURL: (path: string) => `chrome-extension://test/${path}`, getManifest: () => ({ version: 'test-x' }), onMessage: { addListener: (listener: any) => messages.add(listener), removeListener: (listener: any) => messages.delete(listener) } },
    storage: { onChanged: { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) } },
  });
  (script as { main: () => void }).main(); await Promise.resolve();
});
afterEach(() => { page.__bookmindXDispose?.(); delete page.__bookmindXDispose; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
const bookmarkRequests = () => sendMessage.mock.calls.filter(([message]) => message.type === 'X_BOOKMARK').map(([message]) => message);

describe('X信息流与详情入口（Chrome消息模拟）', () => {
  it('信息流保存事件中的帖子地址/ID/预览，不把首页URL/标题当帖子', async () => {
    await options.onBookmark(event); expect(bookmarkRequests()).toEqual([{ type: 'X_BOOKMARK', ...event }]);
    const host = document.getElementById(CAPTURE_TOAST_ID)!;
    expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain('已记入 BookMind Next');
    expect(host.shadowRoot?.textContent).toContain('复盘时间');
    expect(host.shadowRoot?.textContent).not.toContain(document.title);
  });
  it('允许帖子详情中收藏其他回复的独立帖子地址', async () => {
    location.href = 'https://x.com/bob/status/9876543210987654321'; await options.onBookmark(event);
    expect(bookmarkRequests()).toEqual([{ type: 'X_BOOKMARK', ...event }]);
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('已记入 BookMind Next');
  });
  it('保存回执到达前不显示成功，回执等待期间切页不向新页弹提示', async () => {
    let finish!: (value: unknown) => void;
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } }
      : new Promise(resolve => { finish = resolve; }));
    const pending = options.onBookmark(event);
    await Promise.resolve(); await Promise.resolve();
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
    location.href = 'https://x.com/search?q=other';
    finish({ ok: true, data: saved }); await pending;
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
  });
  it('重复收藏显示后台原事务的重复回执，复用同一个可关闭网页提示', async () => {
    await options.onBookmark(event);
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } }
      : { ok: true, data: { ...saved, captureNotice: { ...saved.captureNotice, kind: 'duplicate', title: 'BookMind 中已有这条收藏', detail: '未重复添加，原复盘状态和提醒时间保持不变。' } } });
    await options.onBookmark(event);
    expect(document.querySelectorAll(`#${CAPTURE_TOAST_ID}`)).toHaveLength(1);
    const host = document.getElementById(CAPTURE_TOAST_ID)!;
    expect(host.shadowRoot?.textContent).toContain('未重复添加');
    (host.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
  });
  it.each([undefined, { ...saved.captureNotice, recordId: 'other' }, { ...saved.captureNotice, kind: 'failed' }])('缺失或不匹配的成功回执不弹保存成功 %#', async captureNotice => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } }
      : { ok: true, data: { id: 'saved-x', captureNotice } });
    await options.onBookmark(event);
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('无法确认');
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).not.toContain('已记入');
    warning.mockRestore();
  });
  it('设置刷新过程中切换页面，丢弃旧事件', async () => {
    sendMessage.mockImplementation(async message => {
      if (message.type === 'GET_CAPTURE_SETTINGS') { location.href = 'https://x.com/search?q=other'; return { ok: true, data: { xEnabled: true } }; }
      return { ok: true, data: saved };
    });
    await options.onBookmark(event); expect(bookmarkRequests()).toEqual([]);
  });
  it('相同pathname的搜索条件改变也会取消旧事件，分享跟踪参数/哈希改变可接受', async () => {
    location.href = 'https://x.com/search?q=one';
    sendMessage.mockImplementation(async message => {
      if (message.type === 'GET_CAPTURE_SETTINGS') { location.href = 'https://x.com/search?q=two'; return { ok: true, data: { xEnabled: true } }; }
      return { ok: true, data: saved };
    });
    await options.onBookmark(event); expect(bookmarkRequests()).toEqual([]);
    location.href = 'https://x.com/home';
    sendMessage.mockImplementation(async message => {
      if (message.type === 'GET_CAPTURE_SETTINGS') { location.href = 'https://x.com/home?utm_source=share#section'; return { ok: true, data: { xEnabled: true } }; }
      return { ok: true, data: saved };
    });
    await options.onBookmark(event); expect(bookmarkRequests()).toEqual([{ type: 'X_BOOKMARK', ...event }]);
  });
  it.each(['https://x.com/alice/status/999', 'https://x.com.evil.test/alice/status/1234567890123456789', 'javascript:alert(1)'])('地址或帖子ID不匹配时不发送 %s', async url => {
    await options.onBookmark({ ...event, url }); expect(bookmarkRequests()).toEqual([]);
  });
  it('撤销开关后不发送，不能凭检测器旧事件保存', async () => {
    enabled = false; await options.onBookmark(event); expect(bookmarkRequests()).toEqual([]);
  });
  it('后台失败或缺少记录ID显示失败/未确认，不误报saved', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } } : { ok: false, error: 'quota' });
    await options.onBookmark(event); expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('BookMind 未能保存');
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } } : { ok: true });
    await options.onBookmark(event); expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('无法确认'); warning.mockRestore();
  });
  it('取消收藏只发送remove，需明确回执；不显示新增提示或删除消息', async () => {
    await options.onBookmark({ ...event, action: 'remove' });
    expect(bookmarkRequests()).toEqual([{ type: 'X_BOOKMARK', ...event, action: 'remove' }]);
    const respond = vi.fn(); [...messages][0]({ type: 'BOOKMIND_X_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ page: { code: 'removed' } });
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMessage.mockImplementation(async message => message.type === 'GET_CAPTURE_SETTINGS' ? { ok: true, data: { xEnabled: true } } : { ok: true });
    await options.onBookmark({ ...event, action: 'remove' });
    [...messages][0]({ type: 'BOOKMIND_X_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ page: { code: 'unconfirmed' } }); warning.mockRestore();
  });
  it('状态只回应同扩展页面，丢弃内部document字段', async () => {
    await options.onBookmark(event); const respond = vi.fn(); const listener = [...messages][0];
    listener({ type: 'BOOKMIND_X_STATUS' }, { id: 'other', url: 'chrome-extension://test/popup.html' }, respond);
    listener({ type: 'BOOKMIND_X_STATUS' }, { id: 'test', url: 'https://x.com/home' }, respond); expect(respond).not.toHaveBeenCalled();
    listener({ type: 'BOOKMIND_X_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ version: 'test-x', page: { code: 'saved' } }); expect(respond.mock.lastCall?.[0].page).not.toHaveProperty('document');
    location.href = 'https://x.com/search?q=new'; listener({ type: 'BOOKMIND_X_STATUS' }, { id: 'test', url: 'chrome-extension://test/popup.html' }, respond);
    expect(respond.mock.lastCall?.[0]).toMatchObject({ page: { code: 'ready' } });
  });
  it('再次注入清理旧监听，旧disposer异常也不能阻止新入口启动', async () => {
    const old = dispose; (script as { main: () => void }).main(); await Promise.resolve();
    expect(old).toHaveBeenCalledTimes(1); expect(messages.size).toBe(1); expect(listeners.size).toBe(1);
    page.__bookmindXDispose?.(); page.__bookmindXDispose = () => { throw new Error('Extension context invalidated'); };
    expect(() => (script as { main: () => void }).main()).not.toThrow(); await Promise.resolve(); expect(messages.size).toBe(1);
  });
  it('失效上下文清理后focus不再请求后台，即使Chrome移除监听抛错也清理DOM', async () => {
    chrome.runtime.onMessage.removeListener = vi.fn(() => { throw new Error('Extension context invalidated'); });
    chrome.storage.onChanged.removeListener = vi.fn(() => { throw new Error('Extension context invalidated'); });
    sendMessage.mockRejectedValue(new Error('Extension context invalidated'));
    window.dispatchEvent(new Event('focus')); await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1); const calls = sendMessage.mock.calls.length;
    window.dispatchEvent(new Event('focus')); for (const listener of listeners) listener({}, 'local'); await options.onBookmark(event);
    expect(sendMessage).toHaveBeenCalledTimes(calls); expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('BookMind 已更新');
  });
});
