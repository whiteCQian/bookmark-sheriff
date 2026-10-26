import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createZhihuFavoriteDetector } from '../src/detectors/zhihu-favorite';
import { zhihuIdentity } from '../src/utils/url';
import { failedNotice, CAPTURE_TOAST_ID } from '../src/models/capture';
import { showCaptureToast } from '../src/ui/capture-toast';
import type { ZhihuPageStatus, ZhihuStatusCode } from '../src/models/capture-status';

/** Injected only after explicit opt-in and optional host permission. */
export default defineUnlistedScript(() => {
  if (window.top !== window) return;
  const page = window as Window & { __bookmindZhihuDispose?: () => void };
  // A disposer left behind by an extension reload can itself touch an invalid
  // Chrome context. Its failure must not prevent the new listener from starting.
  try { page.__bookmindZhihuDispose?.(); } catch { /* New context must still start. */ }
  let disposed = false;
  let version = 0;
  let enabled = false;
  let delivery: ZhihuPageStatus | undefined;
  const markDelivery = (code: ZhihuStatusCode) => { delivery = { code, at: Date.now() }; };
  const contextAlive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!contextAlive() || /extension context invalidated/i.test(message)) {
      if (!disposed) {
        dispose();
        showCaptureToast({ kind: 'unconfirmed', title: 'BookMind 已更新，请刷新此页', detail: '当前页面的旧监听已停止。刷新后恢复自动记录，原网站收藏不受影响。', at: Date.now() });
      }
      return;
    }
    if (!disposed) console.warn('[BookMind Next] 知乎实验性收藏监听：', error);
  };
  const detector = createZhihuFavoriteDetector({
    document, window, enabled: false, onError: report,
    onFavorite: async event => {
      if (!(await refreshSettings()) || disposed) return;
      const captured = zhihuIdentity(event.url);
      const current = zhihuIdentity(location.href);
      if (!captured || captured.reviewUrl !== current?.reviewUrl) return;
      const samePage = () => !disposed && zhihuIdentity(location.href)?.reviewUrl === captured.reviewUrl;
      try {
        markDelivery('saving');
        const response = await chrome.runtime.sendMessage({ type: 'ZHIHU_FAVORITE', url: location.href, title: document.title });
        if (response?.ok === false) {
          markDelivery('save_failed');
          if (samePage()) showCaptureToast(failedNotice());
          report(response.error ?? '收藏记录保存失败');
        } else if (!response?.ok || typeof response.data?.id !== 'string') {
          markDelivery('unconfirmed');
          if (samePage()) showCaptureToast(failedNotice(true));
          report('收藏保存结果未确认');
        } else markDelivery('saved');
      } catch (error) {
        markDelivery('unconfirmed');
        if (samePage()) showCaptureToast(failedNotice(true));
        report(error);
      }
    },
  });
  async function refreshSettings(): Promise<boolean> {
    if (disposed) return false;
    if (!contextAlive()) { report(new Error('Extension context invalidated')); return false; }
    const current = ++version;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_SETTINGS' });
      if (disposed) return false;
      if (current !== version) return enabled;
      enabled = response?.ok === true && response.data?.zhihuEnabled === true;
      detector.setEnabled(enabled);
      return enabled;
    } catch (error) {
      if (!disposed && current === version) { enabled = false; detector.setEnabled(false); report(error); }
      return false;
    }
  }
  const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local') void refreshSettings(); };
  const focused = () => { void refreshSettings(); };
  const visible = () => { if (!document.hidden) void refreshSettings(); };
  const statusMessage = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => {
    if (disposed || !contextAlive() || (message as { type?: string })?.type !== 'BOOKMIND_ZHIHU_STATUS'
      || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    const detected = detector.getStatus();
    respond({ version: chrome.runtime.getManifest().version, page: enabled && delivery && delivery.at >= detected.at ? delivery : detected });
  };
  chrome.runtime.onMessage.addListener(statusMessage);
  chrome.storage.onChanged.addListener(changed);
  window.addEventListener('focus', focused);
  document.addEventListener('visibilitychange', visible);
  function dispose() {
    if (disposed) return;
    disposed = true;
    version++;
    detector.dispose();
    try { chrome.runtime.onMessage.removeListener(statusMessage); } catch { /* Invalidated Chrome context. */ }
    try { chrome.storage.onChanged.removeListener(changed); } catch { /* Always continue DOM cleanup. */ }
    window.removeEventListener('focus', focused);
    document.removeEventListener('visibilitychange', visible);
    const toast = document.getElementById(CAPTURE_TOAST_ID);
    if (toast) { window.clearTimeout(Number(toast.dataset.dismissTimer)); toast.remove(); }
  }
  page.__bookmindZhihuDispose = dispose;
  void refreshSettings();
});
