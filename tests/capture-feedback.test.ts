import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_FEEDBACK_KEY, CAPTURE_NOTIFICATION_ID, CAPTURE_TOAST_ID, failedNotice, savedNotice, type CaptureResult } from '../src/models/capture';
import { CaptureFeedbackService } from '../src/services/capture-feedback.service';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService } from '../src/services/storage.service';
import { showCaptureToast } from '../src/ui/capture-toast';
import type { AppState } from '../src/models/favorite';

const result: CaptureResult = { created: true, record: {
  id: 'one', title: '确认保存的文章', originalUrl: 'https://example.com/read', reviewUrl: 'https://example.com/read',
  contentKey: 'https://example.com/read', source: 'chrome', contentType: 'article', status: 'pending',
  createdAt: 1000, reviewAt: 1_790_000_000_000,
} };
let session: Record<string, unknown>;
let api: ReturnType<typeof mockApi>;
function mockApi() {
  return {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    storage: { session: {
      set: vi.fn(async (data: Record<string, unknown>) => { Object.assign(session, structuredClone(data)); }),
      remove: vi.fn(async (key: string) => { delete session[key]; }),
    } },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: result.record.reviewUrl }]),
      get: vi.fn(async (_id: number) => ({ id: 7, url: result.record.reviewUrl })),
      create: vi.fn(async (_options: unknown) => undefined),
    },
    scripting: { executeScript: vi.fn(async (_options: unknown) => [{ result: true }]) },
    notifications: { create: vi.fn(async (_id: string, _options: unknown) => undefined), clear: vi.fn(async (_id: string) => true) },
  };
}
beforeEach(() => { session = {}; api = mockApi(); vi.stubGlobal('chrome', api); });
afterEach(() => {
  document.getElementById(CAPTURE_TOAST_ID)?.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('收藏结果仅使用网页提示与会话回执', () => {
  it('保存后优先在同一页面显示提示，并保留 Popup 会话回执', async () => {
    await new CaptureFeedbackService().show(result);
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'saved', title: '已记入 BookMind Next', recordId: 'one' });
    expect(api.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, args: [expect.objectContaining({ kind: 'saved' }), result.record.reviewUrl] }));
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('无读取授权时只保留会话回执，不发系统通知或要求全站权限', async () => {
    api.tabs.query.mockResolvedValue([{ id: 7 } as never]);
    const service = new CaptureFeedbackService();
    await service.show(result);
    await service.show({ ...result, created: false });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'duplicate' });
  });

  it('注入失败或当前页已切换时不在错误页面报告保存，也不回退系统通知', async () => {
    const service = new CaptureFeedbackService();
    api.scripting.executeScript.mockRejectedValueOnce(new Error('not authorized'));
    await service.show(result);
    api.tabs.query.mockResolvedValue([{ id: 7, url: 'https://example.com/other' }]);
    await service.show(result);
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'saved', recordId: 'one' });
  });

  it('注入时页面再次导航而拒绝展示，也只保留回执', async () => {
    api.scripting.executeScript.mockResolvedValue([{ result: false }]);
    await new CaptureFeedbackService().show(result);
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'saved' });
  });

  it('X由原页面展示回执，后台不注入其他页面或创建系统通知，并清理旧版确认通知', async () => {
    const service = new CaptureFeedbackService();
    await service.show(result, 7, 'receipt');
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'saved', recordId: 'one' });
    await service.failed(result.record.reviewUrl, 7, 'receipt');
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'failed' });
    expect(api.tabs.get).not.toHaveBeenCalled();
    expect(api.tabs.query).not.toHaveBeenCalled();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(api.notifications.clear).toHaveBeenCalledWith(CAPTURE_NOTIFICATION_ID);
  });

  it('保存失败显示失败回执；会话与页面提示失败也不会让成功保存变成失败', async () => {
    const service = new CaptureFeedbackService();
    await service.failed(result.record.reviewUrl, 7);
    expect(api.tabs.get).toHaveBeenCalledWith(7);
    expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'failed', title: 'BookMind 未能保存这条收藏' });
    api.storage.session.set.mockRejectedValue(new Error('session unavailable'));
    api.scripting.executeScript.mockRejectedValue(new Error('no access'));
    api.notifications.clear.mockRejectedValue(new Error('OS blocked'));
    await expect(service.show(result)).resolves.toBeUndefined();
    expect(api.notifications.create).not.toHaveBeenCalled();
  });

  it('清空在提示队列后执行，不复活最近结果，通知点击只打开收藏库', async () => {
    const service = new CaptureFeedbackService();
    await Promise.all([service.show(result), service.clear()]);
    expect(session).toEqual({});
    expect(await service.handleClick('bookmind:review:one:123')).toBe(false);
    expect(api.tabs.create).not.toHaveBeenCalled();
    expect(await service.handleClick(CAPTURE_NOTIFICATION_ID)).toBe(true);
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/dashboard.html' });
    expect(result.record.status).toBe('pending');
  });

  it('新增或重复结论与写入同一事务提交，写入失败不会返回成功结果', async () => {
    let state: AppState | undefined;
    let fail = false;
    const favorites = new FavoriteService(new StorageService({
      read: async () => state,
      write: async value => { if (fail) throw new Error('quota'); state = structuredClone(value); },
    }));
    const captures = await Promise.all(Array.from({ length: 10 }, () => favorites.captureWithResult('chrome', result.record)));
    expect(captures.filter(item => item.created)).toHaveLength(1);
    expect(new Set(captures.map(item => item.record.id)).size).toBe(1);
    fail = true;
    await expect(favorites.captureWithResult('chrome', { ...result.record, reviewUrl: 'https://example.com/new' })).rejects.toThrow('quota');
    expect(state?.favorites).toHaveLength(1);
  });
});

describe('隔离页面提示', () => {
  it('可以脱离模块运行，Shadow DOM 隔离样式并把页面标题作为纯文本', () => {
    vi.useFakeTimers();
    const inject = new Function(`return (${showCaptureToast.toString()})`)() as typeof showCaptureToast;
    expect(inject({ ...savedNotice(result), detail: '<img src=x onerror=alert(1)>' })).toBe(true);
    const host = document.getElementById(CAPTURE_TOAST_ID)!;
    expect(host.shadowRoot?.querySelector('[role="status"]')?.textContent).toContain('已记入 BookMind Next');
    expect(host.shadowRoot?.querySelector('p')?.textContent).toContain('<img');
    expect(host.shadowRoot?.querySelector('img')).toBeNull();
    expect(host.style.position).toBe('fixed');
    vi.advanceTimersByTime(7000);
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
  });

  it('可关闭、重复提示替换旧提示，旧定时器不会删除新提示', () => {
    vi.useFakeTimers();
    showCaptureToast(savedNotice(result));
    vi.advanceTimersByTime(4000);
    showCaptureToast(failedNotice());
    vi.advanceTimersByTime(3000);
    const host = document.getElementById(CAPTURE_TOAST_ID)!;
    expect(host.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelectorAll(`#${CAPTURE_TOAST_ID}`)).toHaveLength(1);
    (host.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('页面导航后拒绝注入，无法确认的结果不会冒充已保存', () => {
    expect(showCaptureToast(savedNotice(result), 'https://example.com/not-current')).toBe(false);
    expect(document.getElementById(CAPTURE_TOAST_ID)).toBeNull();
    showCaptureToast(failedNotice(true));
    expect(document.getElementById(CAPTURE_TOAST_ID)?.shadowRoot?.textContent).toContain('无法确认');
  });
});
