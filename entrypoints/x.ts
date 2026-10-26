import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createXBookmarkDetector } from '../src/detectors/x-bookmark';
import { xPostIdentity } from '../src/utils/url';
import { failedNotice, isCaptureNotice, CAPTURE_TOAST_ID } from '../src/models/capture';
import { showCaptureToast } from '../src/ui/capture-toast';

interface PageStatus { code: string; at: number }

/** A query used to identify a feed must survive; share/tracking parameters need not. */
function documentIdentity(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'x.com' || url.port || url.username || url.password) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['s', 't', 'ref_src', 'ref_url'].includes(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return undefined; }
}

/** Injected only after X opt-in and optional host access. */
export default defineUnlistedScript(() => {
  if (window.top !== window || !documentIdentity(location.href)) return;
  const page = window as Window & { __bookmindXDispose?: () => void };
  try { page.__bookmindXDispose?.(); } catch { /* An old context cannot block this one. */ }
  let disposed = false;
  let settingsVersion = 0;
  let enabled = false;
  let delivery: (PageStatus & { document: string }) | undefined;
  const mark = (code: string, document: string) => { delivery = { code, at: Date.now(), document }; };
  const contextAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!contextAlive() || /extension context invalidated/i.test(message)) {
      if (!disposed) {
        dispose();
        showCaptureToast({ kind: 'unconfirmed', title: 'BookMind 已更新，请刷新此页', detail: '当前页面的旧监听已停止。刷新后恢复自动记录，X 上的收藏不受影响。', at: Date.now() });
      }
      return;
    }
    if (!disposed) console.warn('[BookMind Next] X 实验性收藏监听：', error);
  };
  const detector = createXBookmarkDetector({
    document, window, enabled: false, onError: report,
    onBookmark: async event => {
      const sourceDocument = documentIdentity(location.href);
      const captured = xPostIdentity(event.url);
      // A feed can save a different post from the URL of the document itself.
      if (!sourceDocument || !captured || captured.postId !== event.postId) return;
      const bookmark = { url: event.url, postId: event.postId, preview: event.preview, action: event.action };
      if (!(await refreshSettings()) || disposed || documentIdentity(location.href) !== sourceDocument) return;
      const samePage = () => !disposed && documentIdentity(location.href) === sourceDocument;
      try {
        mark(bookmark.action === 'add' ? 'saving' : 'removing', sourceDocument);
        const response = await chrome.runtime.sendMessage({ type: 'X_BOOKMARK', ...bookmark });
        if (response?.ok === false) {
          mark('save_failed', sourceDocument);
          if (samePage() && bookmark.action === 'add') showCaptureToast(failedNotice());
          report(response.error ?? 'X 收藏处理失败');
        } else {
          const notice = response?.data?.captureNotice;
          const confirmed = bookmark.action === 'add' ? typeof response?.data?.id === 'string'
            && isCaptureNotice(notice) && notice.recordId === response.data.id && ['saved', 'duplicate'].includes(notice.kind)
            : response?.data?.action === 'remove' && response.data.confirmed === true && response.data.postId === bookmark.postId;
          if (response?.ok !== true || !confirmed) {
            mark('unconfirmed', sourceDocument);
            if (samePage() && bookmark.action === 'add') showCaptureToast(failedNotice(true));
            report('X 收藏处理结果未确认');
          } else {
            mark(bookmark.action === 'add' ? 'saved' : 'removed', sourceDocument);
            if (samePage() && bookmark.action === 'add') showCaptureToast(notice);
          }
        }
      } catch (error) {
        mark('unconfirmed', sourceDocument);
        if (samePage() && bookmark.action === 'add') showCaptureToast(failedNotice(true));
        report(error);
      }
    },
  });

  async function refreshSettings(): Promise<boolean> {
    if (disposed) return false;
    if (!contextAlive()) { report(new Error('Extension context invalidated')); return false; }
    const current = ++settingsVersion;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_SETTINGS' });
      if (disposed) return false;
      if (current !== settingsVersion) return enabled;
      enabled = response?.ok === true && response.data?.xEnabled === true;
      detector.setEnabled(enabled);
      return enabled;
    } catch (error) {
      if (!disposed && current === settingsVersion) { enabled = false; detector.setEnabled(false); report(error); }
      return false;
    }
  }

  const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local') void refreshSettings(); };
  const focused = () => { void refreshSettings(); };
  const visible = () => { if (!document.hidden) void refreshSettings(); };
  const statusMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
    if (disposed || !contextAlive() || (message as { type?: string })?.type !== 'BOOKMIND_X_STATUS'
      || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    const detected = detector.getStatus();
    const currentDelivery = delivery;
    const sent: PageStatus = enabled && currentDelivery && currentDelivery.document === documentIdentity(location.href)
      && currentDelivery.at >= detected.at ? currentDelivery : detected;
    respond({ version: chrome.runtime.getManifest().version, page: { code: sent.code, at: sent.at } });
  };
  chrome.runtime.onMessage.addListener(statusMessage);
  chrome.storage.onChanged.addListener(changed);
  window.addEventListener('focus', focused);
  document.addEventListener('visibilitychange', visible);
  function dispose() {
    if (disposed) return;
    disposed = true;
    settingsVersion++;
    detector.dispose();
    try { chrome.runtime.onMessage.removeListener(statusMessage); } catch { /* Invalid old context. */ }
    try { chrome.storage.onChanged.removeListener(changed); } catch { /* Always finish DOM cleanup. */ }
    window.removeEventListener('focus', focused);
    document.removeEventListener('visibilitychange', visible);
    const toast = document.getElementById(CAPTURE_TOAST_ID);
    if (toast) { window.clearTimeout(Number(toast.dataset.dismissTimer)); toast.remove(); }
  }
  page.__bookmindXDispose = dispose;
  void refreshSettings();
});
