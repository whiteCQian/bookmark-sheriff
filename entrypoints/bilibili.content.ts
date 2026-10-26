import { defineContentScript } from 'wxt/utils/define-content-script';
import { createBilibiliFavoriteDetector } from '../src/detectors/bilibili-favorite';
import { bilibiliIdentity } from '../src/utils/url';
import { failedNotice, CAPTURE_TOAST_ID } from '../src/models/capture';
import { showCaptureToast } from '../src/ui/capture-toast';

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  allFrames: false,
  runAt: 'document_idle',
  main(ctx) {
    if (window.top !== window) return;
    let disposed = false;
    let requestVersion = 0;
    let captureEnabled = false;
    const report = (error: unknown) => { console.warn('[BookMind Next] B站收藏监听：', error); };
    const detector = createBilibiliFavoriteDetector({
      document, window, enabled: false, onError: report,
      onFavorite: async event => {
        // Recheck via the background: storage.local is restricted to trusted extension contexts.
        if (!(await refreshSettings()) || disposed) return;
        const captured = bilibiliIdentity(event.url);
        const current = bilibiliIdentity(location.href);
        if (!captured || !current || captured.bvId !== current.bvId || captured.episode !== current.episode) return;
        const samePage = () => {
          const page = bilibiliIdentity(location.href);
          return !disposed && page?.bvId === captured.bvId && page.episode === captured.episode;
        };
        try {
          const response = await chrome.runtime.sendMessage({ type: 'BILIBILI_FAVORITE', url: location.href, title: document.title });
          if (response?.ok === false) {
            if (samePage()) showCaptureToast(failedNotice());
            report(response.error ?? '收藏记录保存失败');
          } else if (!response?.ok) {
            if (samePage()) showCaptureToast(failedNotice(true));
            report('收藏保存结果未确认');
          }
        } catch (error) {
          if (samePage()) showCaptureToast(failedNotice(true));
          report(error);
        }
      },
    });
    async function refreshSettings(): Promise<boolean> {
      const version = ++requestVersion;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_SETTINGS' });
        if (disposed) return false;
        if (version !== requestVersion) return captureEnabled;
        captureEnabled = response?.ok === true && response.data?.bilibiliEnabled === true;
        detector.setEnabled(captureEnabled);
        if (!response?.ok) report(response?.error ?? '读取监听设置失败');
        return captureEnabled;
      } catch (error) {
        if (!disposed && version === requestVersion) { captureEnabled = false; detector.setEnabled(false); report(error); }
        return false;
      }
    }
    const onStorageChanged = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') void refreshSettings();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    ctx.addEventListener(window, 'wxt:locationchange', () => detector.checkLocation());
    ctx.addEventListener(window, 'focus', () => { void refreshSettings(); });
    ctx.addEventListener(document, 'visibilitychange', () => { if (!document.hidden) void refreshSettings(); });
    ctx.onInvalidated(() => {
      disposed = true;
      requestVersion++;
      detector.dispose();
      chrome.storage.onChanged.removeListener(onStorageChanged);
      const toast = document.getElementById(CAPTURE_TOAST_ID);
      if (toast) { window.clearTimeout(Number(toast.dataset.dismissTimer)); toast.remove(); }
    });
    void refreshSettings();
  },
});
