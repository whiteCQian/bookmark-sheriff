import { CAPTURE_FEEDBACK_KEY, CAPTURE_NOTIFICATION_ID, failedNotice, savedNotice, type CaptureFeedbackMode, type CaptureNotice, type CaptureResult } from '../models/capture';
import { contentKey } from '../utils/url';
import { showCaptureToast } from '../ui/capture-toast';

/** Confirmation is a consequence of a committed capture, never its prerequisite. */
export class CaptureFeedbackService {
  private queue: Promise<unknown> = Promise.resolve();

  show(result: CaptureResult, tabId?: number, mode: CaptureFeedbackMode = 'page'): Promise<void> {
    return this.enqueue(savedNotice(result), result.record.contentKey, tabId, mode);
  }

  failed(url: string, tabId?: number, mode: CaptureFeedbackMode = 'page'): Promise<void> {
    return this.enqueue(failedNotice(), contentKey(url), tabId, mode);
  }

  private enqueue(notice: CaptureNotice, key: string, tabId: number | undefined, mode: CaptureFeedbackMode): Promise<void> {
    const next = this.queue.then(() => this.present(notice, key, tabId, mode));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async present(notice: CaptureNotice, key: string, tabId: number | undefined, mode: CaptureFeedbackMode): Promise<void> {
    // A page that cannot show feedback still leaves its receipt in Popup.
    // Feedback never creates an OS notification or rolls back a favorite.
    try { await chrome.storage.session.set({ [CAPTURE_FEEDBACK_KEY]: notice }); } catch { /* Best effort. */ }
    try { await chrome.notifications.clear(CAPTURE_NOTIFICATION_ID); } catch { /* Clear a receipt left by an older version. */ }
    // X renders the committed receipt in its originating Content Script: a
    // timeline document URL does not identify the post that was bookmarked.
    if (mode === 'receipt') return;
    try {
      const tab = tabId === undefined ? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] : await chrome.tabs.get(tabId);
      if (tab?.id !== undefined && tab.url && contentKey(tab.url) === key) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: showCaptureToast, args: [notice, tab.url] });
      }
    } catch { /* No page access: Popup retains the receipt without a system notification. */ }
  }

  async handleClick(id: string): Promise<boolean> {
    if (id !== CAPTURE_NOTIFICATION_ID) return false;
    await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    await chrome.notifications.clear(id);
    return true;
  }

  async clear(): Promise<void> {
    // Run after prior presentations so clearing cannot resurrect a stale receipt.
    const next = this.queue.then(async () => {
      try { await chrome.storage.session.remove(CAPTURE_FEEDBACK_KEY); } catch { /* Best effort. */ }
      try { await chrome.notifications.clear(CAPTURE_NOTIFICATION_ID); } catch { /* Best effort. */ }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
