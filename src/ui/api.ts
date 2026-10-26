import type { AppRequest, AppResponse } from '../models/messages';

export async function request<T = void>(message: AppRequest): Promise<T> {
  const response = await chrome.runtime.sendMessage(message) as AppResponse<T> | undefined;
  if (!response || typeof response.ok !== 'boolean') throw new Error('扩展暂时没有响应，请重新打开后重试。');
  if (!response.ok) throw new Error(response.error || '操作失败，请重试。');
  return response.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function extensionUrl(page: 'dashboard' | 'options', view?: 'due'): string {
  const url = chrome.runtime.getURL(`${page}.html`);
  return page === 'dashboard' && view === 'due' ? `${url}?view=due` : url;
}
