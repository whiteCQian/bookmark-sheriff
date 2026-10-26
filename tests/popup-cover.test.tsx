import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PopupApp } from '../src/ui/PopupApp';
import type { AppRequest } from '../src/models/messages';
import type { CoverResult } from '../src/services/cover.service';
import { emptyState } from '../src/services/storage.service';

let root: Root;
let container: HTMLDivElement;
const sendMessage = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  sendMessage.mockReset().mockImplementation(async (request: AppRequest) => ({ ok: true, data: request.type === 'REFRESH_CURRENT_COVER' ? { status: 'unavailable' } : emptyState() }));
  vi.stubGlobal('chrome', { runtime: { sendMessage, getURL: (path: string) => `chrome-extension://test/${path}` }, storage: { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } });
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

it('Popup 只发送封面刷新和状态读取，授权不足静默展示基础收藏', async () => {
  await act(async () => { root.render(<PopupApp />); });
  expect(sendMessage.mock.calls.map(([request]) => request.type).sort()).toEqual(['GET_CURRENT_CAPTURE_STATUS', 'GET_STATE', 'REFRESH_CURRENT_COVER']);
  expect(container.textContent).toContain('0 条收藏');
  expect(container.textContent).not.toContain('网页信息');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('补封面请求挂起不阻塞列表，仅成功后刷新已有状态', async () => {
  let complete!: (result: { ok: boolean; data: CoverResult }) => void;
  sendMessage.mockImplementation(async (request: AppRequest) => request.type === 'REFRESH_CURRENT_COVER'
    ? new Promise(resolve => { complete = resolve; }) : { ok: true, data: emptyState() });
  await act(async () => { root.render(<PopupApp />); });
  expect(container.textContent).toContain('0 条收藏');
  expect(sendMessage.mock.calls.filter(([request]) => request.type === 'GET_STATE')).toHaveLength(1);
  await act(async () => { complete({ ok: true, data: { status: 'updated', recordId: 'existing' } }); });
  expect(sendMessage.mock.calls.filter(([request]) => request.type === 'GET_STATE')).toHaveLength(2);
  expect(sendMessage.mock.calls.every(([request]) => ['GET_STATE', 'REFRESH_CURRENT_COVER', 'GET_CURRENT_CAPTURE_STATUS'].includes(request.type))).toBe(true);
});

it('后台封面读取连接失败不会显示保存失败或创建收藏', async () => {
  sendMessage.mockImplementation(async (request: AppRequest) => request.type === 'REFRESH_CURRENT_COVER'
    ? Promise.reject(new Error('worker unavailable')) : { ok: true, data: emptyState() });
  await act(async () => { root.render(<PopupApp />); });
  expect(container.textContent).toContain('第一条收藏');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(sendMessage.mock.calls.some(([request]) => request.type === 'BILIBILI_FAVORITE' || request.type === 'ZHIHU_FAVORITE')).toBe(false);
});
