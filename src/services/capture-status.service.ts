import { ZHIHU_STATUS_LABELS, X_STATUS_LABELS, type CurrentCaptureStatus, type ZhihuStatusCode, type XStatusCode } from '../models/capture-status';
import { safeWebUrl, zhihuIdentity } from '../utils/url';
import { hasZhihuPermission, ZHIHU_SCRIPT_ID } from './site-registration.service';
import { hasXPermission, X_SCRIPT_ID } from './x-registration.service';

/** Read-only diagnostics for the active detail page; never persists page content. */
export async function currentCaptureStatus(zhihuEnabled: boolean, xEnabled = false): Promise<CurrentCaptureStatus | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const safe = safeWebUrl(tab?.url);
  if (!safe) return null;
  const isX = new URL(safe).origin === 'https://x.com';
  if (!isX && !zhihuIdentity(safe)) return null;
  const version = chrome.runtime.getManifest().version;
  const permitted = await (isX ? hasXPermission() : hasZhihuPermission());
  const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [isX ? X_SCRIPT_ID : ZHIHU_SCRIPT_ID] })).length > 0;
  const base = { version, enabled: isX ? xEnabled : zhihuEnabled, permitted, registered, ...(isX ? { site: 'x' as const } : {}) };
  if (tab.id === undefined) return { ...base, connection: 'unavailable' };
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: isX ? 'BOOKMIND_X_STATUS' : 'BOOKMIND_ZHIHU_STATUS' }, { frameId: 0 });
    const page = result?.page as { code?: unknown; at?: unknown } | undefined;
    const labels = isX ? X_STATUS_LABELS : ZHIHU_STATUS_LABELS;
    if (result?.version !== version || !page || typeof page.code !== 'string' || !Object.hasOwn(labels, page.code)
      || typeof page.at !== 'number' || !Number.isFinite(page.at)) return { ...base, connection: 'missing' };
    return { ...base, connection: 'connected', page: { code: page.code as ZhihuStatusCode | XStatusCode, at: page.at } };
  } catch { return { ...base, connection: 'missing' }; }
}
