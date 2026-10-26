import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptureFeedback } from '../src/components/CaptureFeedback';
import { CAPTURE_FEEDBACK_KEY, failedNotice, type CaptureNotice } from '../src/models/capture';

let root: Root;
let container: HTMLDivElement;
let notice: CaptureNotice | undefined;
let changed: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
const get = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  notice = { kind: 'saved', title: '已记入 BookMind Next', detail: '文章标题\n复盘时间：10月27日 12:00', at: Date.now(), recordId: 'one' };
  get.mockReset().mockImplementation(async () => ({ [CAPTURE_FEEDBACK_KEY]: notice }));
  vi.stubGlobal('chrome', { storage: {
    session: { get }, onChanged: { addListener: (listener: typeof changed) => { changed = listener; }, removeListener: vi.fn() },
  } });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

it('会话回执在系统提示之外保留成功/重复/失败说明，清空后消失', async () => {
  await act(async () => { root.render(<CaptureFeedback />); });
  expect(container.textContent).toContain('已记入 BookMind Next');
  notice = { ...notice!, kind: 'duplicate', title: 'BookMind 中已有这条收藏', detail: '未重复添加' };
  await act(async () => { changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'session'); });
  expect(container.textContent).toContain('未重复添加');
  notice = failedNotice();
  await act(async () => { changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'session'); });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain('BookMind 未能保存');
  notice = undefined;
  await act(async () => { changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'session'); });
  expect(container.childElementCount).toBe(0);
});

it('忽略不相关存储事件与损坏回执，过期读取不会覆盖新结果', async () => {
  let release!: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await act(async () => { root.render(<CaptureFeedback />); });
  await act(async () => { changed({ other: {} }, 'session'); changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'local'); });
  expect(get).toHaveBeenCalledTimes(1);
  notice = failedNotice();
  await act(async () => { changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'session'); });
  await act(async () => { release({ [CAPTURE_FEEDBACK_KEY]: { ...notice, title: '过时的结果' } }); });
  expect(container.textContent).not.toContain('过时的结果');
  expect(container.textContent).toContain('未能保存');
  get.mockResolvedValue({ [CAPTURE_FEEDBACK_KEY]: { ...notice, at: Infinity } });
  await act(async () => { changed({ [CAPTURE_FEEDBACK_KEY]: {} }, 'session'); });
  expect(container.childElementCount).toBe(0);
});
