import { expect, it, vi } from 'vitest';
import { registerChromeBookmarkDetector } from '../src/detectors/chrome-bookmark';

it('监听新增，排除文件夹、导入、非法协议；导入结束恢复监听', async () => {
  const listeners: Record<string, (...args: any[]) => void> = {};
  const api = Object.fromEntries(['onCreated', 'onImportBegan', 'onImportEnded'].map(name => [name, { addListener: (fn: (...args: any[]) => void) => { listeners[name] = fn; } }]));
  const sink = vi.fn(async () => {});
  let importing = false;
  registerChromeBookmarkDetector(api as unknown as typeof chrome.bookmarks, { read: async () => importing, write: async v => { importing = v; } }, sink, error => { throw error; });
  listeners.onCreated('folder', { id: 'folder', title: '文件夹' });
  listeners.onCreated('internal', { url: 'chrome://extensions' });
  listeners.onImportBegan();
  listeners.onCreated('import', { url: 'https://example.com/import' });
  listeners.onImportEnded();
  listeners.onCreated('normal', { id: 'normal', url: 'https://example.com/', title: '正常收藏' });
  await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
  expect(sink.mock.calls[0]).toEqual([{ id: 'normal', url: 'https://example.com/', title: '正常收藏' }]);
  expect(importing).toBe(false);
});
