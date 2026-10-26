import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, FavoriteRecord } from '../src/models/favorite';
import type { AppRequest, AppResponse } from '../src/models/messages';
import { STORAGE_KEY } from '../src/services/storage.service';
import { useAction, useAppState, useReviewClock } from '../src/ui/hooks';

// Hook lifecycle tests use jsdom and mocked Chrome APIs. They do not prove browser sleep behavior.
const start = new Date(2026, 9, 24, 12).getTime();
type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
let container: HTMLDivElement;
let root: Root | undefined;
let listeners: Set<ChangeListener>;
let sendMessage: ReturnType<typeof vi.fn<(request: AppRequest) => Promise<unknown>>>;
let app: ReturnType<typeof useAppState>;
let action: ReturnType<typeof useAction>;
let clock: number;

function state(title = '当前记录'): AppState {
  return {
    schemaVersion: 1, diagnostics: [],
    settings: { defaultReviewDays: 3, notificationsEnabled: true, bilibiliEnabled: true, zhihuEnabled: false, xEnabled: false, reminderMode: 'single' },
    favorites: [{
      id: 'one', title, source: 'chrome', contentType: 'article', contentKey: 'page:https://example.com/',
      originalUrl: 'https://example.com/', reviewUrl: 'https://example.com/',
      createdAt: start, reviewAt: start + 1_000, status: 'pending',
    }],
  };
}

function deferred() {
  let resolve!: (value: AppResponse<AppState>) => void;
  const promise = new Promise<AppResponse<AppState>>(done => { resolve = done; });
  return { promise, resolve };
}

function AppHarness() {
  app = useAppState();
  action = useAction(app.refresh);
  return <output>{app.state?.favorites[0]?.title ?? ''}|{app.error}|{String(app.loading)}</output>;
}

function ClockHarness({ favorites }: { favorites: FavoriteRecord[] }) {
  clock = useReviewClock(favorites);
  return <output>{clock}</output>;
}

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function mount(ui = <AppHarness />) {
  root = createRoot(container);
  await act(async () => { root!.render(ui); });
  await flush();
}
function invalidate(area = 'local', key = STORAGE_KEY) {
  for (const listener of listeners) listener({ [key]: { newValue: {} } }, area);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  listeners = new Set();
  sendMessage = vi.fn(async () => ({ ok: true, data: state() }));
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: { onChanged: { addListener: (listener: ChangeListener) => listeners.add(listener), removeListener: (listener: ChangeListener) => listeners.delete(listener) } },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('UI 状态刷新与时间边界', () => {
  it('同一轮操作确认与多个存储事件合并为一次后台读取，所有调用等待该读取完成', async () => {
    await mount();
    const read = deferred();
    sendMessage.mockImplementationOnce(() => read.promise);
    let done = false;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = app.refresh();
      second = app.refresh();
      invalidate();
      invalidate();
      void first.then(() => { done = true; });
    });
    expect(first).toBe(second);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(done).toBe(false);
    read.resolve({ ok: true, data: state('更新后的记录') });
    await flush();
    expect(done).toBe(true);
    expect(app.state?.favorites[0]?.title).toBe('更新后的记录');
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('读取期间发生变更时丢弃旧响应，将多个失效事件合并为一次后续读取', async () => {
    const oldRead = deferred();
    const newRead = deferred();
    sendMessage.mockImplementationOnce(() => oldRead.promise).mockImplementationOnce(() => newRead.promise);
    await mount();
    await act(async () => { invalidate(); invalidate(); void app.refresh(); });
    oldRead.resolve({ ok: true, data: state('已经过时的记录') });
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(app.state).toBeUndefined();
    expect(app.loading).toBe(true);
    expect(container.textContent).not.toContain('已经过时的记录');
    newRead.resolve({ ok: true, data: state('最新记录') });
    await flush();
    expect(app.state?.favorites[0]?.title).toBe('最新记录');
    expect(app.loading).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('失效的失败响应不覆盖后续成功，后续读取错误仍可重试', async () => {
    const oldRead = deferred();
    sendMessage.mockImplementationOnce(() => oldRead.promise);
    await mount();
    await act(async () => { invalidate(); });
    oldRead.resolve({ ok: false, error: '已失效的错误' });
    await flush();
    expect(app.error).toBe('');
    expect(app.state?.favorites[0]?.title).toBe('当前记录');
    sendMessage.mockResolvedValueOnce({ ok: false, error: '当前读取失败' });
    await act(async () => { await app.refresh(); });
    expect(app.error).toBe('当前读取失败');
    expect(app.state?.favorites[0]?.title).toBe('当前记录');
    await act(async () => { await app.refresh(); });
    expect(app.error).toBe('');
  });

  it('读取和操作确认同时完成时仍读取操作后的状态', async () => {
    await mount();
    const read = deferred();
    const acknowledgement = deferred();
    sendMessage.mockImplementationOnce(() => read.promise).mockImplementationOnce(() => acknowledgement.promise);
    let operation!: Promise<boolean>;
    await act(async () => {
      void app.refresh();
      await Promise.resolve();
      operation = action.run({ type: 'UPDATE_FAVORITE', id: 'one', patch: { note: '刚刚更新' } });
    });
    sendMessage.mockResolvedValue({ ok: true, data: state('操作后最新记录') });
    read.resolve({ ok: true, data: state('操作前的记录') });
    acknowledgement.resolve({ ok: true, data: state('操作后最新记录') });
    await flush();
    expect(await operation).toBe(true);
    expect(app.state?.favorites[0]?.title).toBe('操作后最新记录');
    expect(sendMessage.mock.calls.filter(([message]) => message.type === 'GET_STATE')).toHaveLength(3);
  });

  it('只响应 local 中指定存储键，并在卸载后清理订阅且忽略刷新', async () => {
    await mount();
    await act(async () => { invalidate('sync'); invalidate('local', 'other'); });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => { invalidate(); });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const refresh = app.refresh;
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(listeners.size).toBe(0);
    await refresh();
    invalidate();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('React 严格模式重新挂载 effect 后仍保持单个订阅和有效数据', async () => {
    await mount(<StrictMode><AppHarness /></StrictMode>);
    expect(listeners.size).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(app.state?.favorites[0]?.title).toBe('当前记录');
    expect(app.loading).toBe(false);
  });

  it('到最近待复盘边界才更新时间，忽略已完成和已忽略的时间', async () => {
    const favorite = state().favorites[0];
    await mount(<ClockHarness favorites={[
      { ...favorite, id: 'completed', status: 'completed', reviewAt: start + 10 },
      { ...favorite, id: 'ignored', status: 'ignored', reviewAt: start + 20 },
      favorite,
    ]} />);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(clock).toBe(start);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(clock).toBe(start + 1_001);
    expect(vi.getTimerCount()).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('午夜更新时间，聚焦和恢复可见时修正时钟，卸载后移除定时器', async () => {
    const midnight = new Date(2026, 9, 25).getTime();
    vi.setSystemTime(midnight - 50);
    await mount(<ClockHarness favorites={[]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(clock).toBe(midnight);
    vi.setSystemTime(midnight + 5_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(clock).toBe(midnight + 5_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.setSystemTime(midnight + 10_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(clock).toBe(midnight + 5_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(clock).toBe(midnight + 10_000);
    await act(async () => { root!.unmount(); });
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(midnight + 15_000);
    window.dispatchEvent(new Event('focus'));
    expect(clock).toBe(midnight + 10_000);
  });
});
