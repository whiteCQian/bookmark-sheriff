import { afterEach, expect, it, vi } from 'vitest';
import { STORAGE_KEY } from '../src/services/storage.service';
import type { AppState } from '../src/models/favorite';
import { DAY_MS } from '../src/models/favorite';
import { CAPTURE_FEEDBACK_KEY, CAPTURE_NOTIFICATION_ID } from '../src/models/capture';

vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: () => void) => main }));
import background from '../entrypoints/background';

function event() {
  const listeners: ((...args: any[]) => unknown)[] = [];
  return { addListener: (listener: (...args: any[]) => unknown) => listeners.push(listener), emit: (...args: any[]) => listeners.map(listener => listener(...args)) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('后台接线：原生书签事件→持久化→alarm通知→点击原文→明确完成', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T00:00:00+08:00'));
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  const alarms = new Map<string, { when?: number; periodInMinutes?: number }>();
  const notices: Record<string, unknown> = {};
  const api = {
    runtime: { id: 'bookmind-id', getURL: (path: string) => `chrome-extension://bookmind-id/${path}`, onMessage: event(), onStartup: event(), onInstalled: event() },
    bookmarks: { onCreated: event(), onImportBegan: event(), onImportEnded: event() },
    storage: {
      local: { get: async (key: string) => ({ [key]: structuredClone(local[key]) }), set: async (items: Record<string, unknown>) => { Object.assign(local, structuredClone(items)); }, setAccessLevel: vi.fn(async () => {}) },
      session: { get: async (key: string) => ({ [key]: session[key] }), set: async (items: Record<string, unknown>) => { Object.assign(session, items); } },
    },
    alarms: { get: async (name: string) => alarms.get(name), create: async (name: string, info: { when?: number; periodInMinutes?: number }) => { alarms.set(name, info); }, clear: async (name: string) => alarms.delete(name), onAlarm: event() },
    notifications: {
      getAll: async () => ({ ...notices }), create: vi.fn(async (id: string, options: unknown) => { notices[id] = options; return id; }), clear: async (id: string) => { delete notices[id]; return true; },
      onClicked: event(), onButtonClicked: event(),
    },
    scripting: { executeScript: vi.fn(async () => { throw new Error('无读取权限'); }), getRegisteredContentScripts: vi.fn(async () => []), registerContentScripts: vi.fn(async () => {}), unregisterContentScripts: vi.fn(async () => {}) },
    permissions: { contains: vi.fn(async () => false), onAdded: event(), onRemoved: event() },
    tabs: { query: async () => [{ id: 7 }], create: vi.fn(async (options: { url: string }) => options) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  };
  vi.stubGlobal('chrome', api);
  (background as unknown as () => void)();
  const dateAdded = Date.now() - 5_000;
  api.bookmarks.onCreated.emit('bookmark-1', { id: 'bookmark-1', title: '原生收藏的文章', url: 'https://example.com/read', dateAdded });
  const state = () => local[STORAGE_KEY] as AppState;
  await vi.waitFor(() => {
    expect(state().favorites).toHaveLength(1);
    expect(alarms.has('bookmind.next-review')).toBe(true);
  });
  expect(state().favorites[0]).toMatchObject({ title: '原生收藏的文章', status: 'pending', createdAt: dateAdded });
  expect(api.scripting.executeScript).not.toHaveBeenCalled();
  const reviewAt = state().favorites[0].reviewAt;
  expect(session[CAPTURE_FEEDBACK_KEY]).toMatchObject({ kind: 'saved', title: '已记入 BookMind Next' });
  expect(notices[CAPTURE_NOTIFICATION_ID]).toBeUndefined();
  expect(api.notifications.create).not.toHaveBeenCalled();
  expect(reviewAt - state().favorites[0].createdAt).toBe(3 * DAY_MS);
  vi.setSystemTime(reviewAt + 1);
  api.alarms.onAlarm.emit({ name: 'bookmind.next-review' });
  await vi.waitFor(() => expect(state().favorites[0].notifiedAt).toBeDefined());
  expect(api.notifications.create).toHaveBeenCalledTimes(1);
  const noticeId = Object.keys(notices).find(id => id.startsWith('bookmind:review:'))!;
  api.notifications.onClicked.emit(noticeId);
  await vi.waitFor(() => expect(api.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/read' }));
  expect(state().favorites[0].status).toBe('pending');
  const response = await new Promise<any>(resolve => {
    api.runtime.onMessage.emit({ type: 'UPDATE_FAVORITE', id: state().favorites[0].id, patch: { status: 'completed' } }, { id: 'bookmind-id', url: 'chrome-extension://bookmind-id/dashboard.html' }, resolve);
  });
  expect(response.ok).toBe(true);
  expect(state().favorites[0].status).toBe('completed');
  expect(alarms.has('bookmind.next-review')).toBe(false);
  expect(api.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  expect(api.notifications.create).toHaveBeenCalledTimes(1);
});
