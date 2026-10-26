import { defineBackground } from 'wxt/utils/define-background';
import { registerChromeBookmarkDetector } from '../src/detectors/chrome-bookmark';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService, chromeStoragePort } from '../src/services/storage.service';
import { createMessageRouter } from '../src/services/message-router';
import { bilibiliIdentity } from '../src/utils/url';
import { ReminderService } from '../src/services/reminder.service';
import { CaptureFeedbackService } from '../src/services/capture-feedback.service';
import { CAPTURE_NOTIFICATION_ID } from '../src/models/capture';
import { SiteRegistrationService } from '../src/services/site-registration.service';
import { CoverService } from '../src/services/cover.service';
import { XRegistrationService } from '../src/services/x-registration.service';

export default defineBackground(() => {
  const storage = new StorageService(chromeStoragePort());
  const favorites = new FavoriteService(storage);
  const feedback = new CaptureFeedbackService();
  const sites = new SiteRegistrationService(favorites);
  const xSites = new XRegistrationService(favorites);
  const covers = new CoverService(favorites);
  const report = (error: unknown) => { console.error(error); void storage.report(error instanceof Error ? error.message : '收藏处理失败').catch(console.error); };
  const reminders = new ReminderService(favorites, {
    getAlarm: name => chrome.alarms.get(name),
    createAlarm: (name, info) => chrome.alarms.create(name, info),
    clearAlarm: name => chrome.alarms.clear(name),
    getNotifications: () => chrome.notifications.getAll(),
    createNotification: (id, options) => chrome.notifications.create(id, options),
    clearNotification: id => chrome.notifications.clear(id),
    open: url => chrome.tabs.create({ url }),
    iconUrl: chrome.runtime.getURL('icon/128.png'),
    dashboardUrl: chrome.runtime.getURL('dashboard.html?view=due'),
  });
  const changed = async () => {
    try { await sites.reconcile(); } catch (error) { report(error); }
    try { await xSites.reconcile(); } catch (error) { report(error); }
    try {
      await reminders.reconcile();
      const pending = (await storage.snapshot()).favorites.filter(item => item.status === 'pending').length;
      await chrome.action.setBadgeText({ text: pending ? String(pending) : '' });
      await chrome.action.setBadgeBackgroundColor({ color: '#1e5340' });
    } catch (error) { report(error); }
  };
  const route = createMessageRouter(favorites, changed, url => chrome.tabs.create({ url }), {
    capture: (result, tabId, mode) => feedback.show(result, tabId, mode), clear: () => feedback.clear(), failed: (url, tabId, mode) => feedback.failed(url, tabId, mode),
  }, covers);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    void route(message, sender).then(data => respond({ ok: true, data })).catch(error => {
      respond({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试' });
    });
    return true;
  });
  registerChromeBookmarkDetector(chrome.bookmarks, {
    read: async () => Boolean((await chrome.storage.session.get('bookmarkImporting')).bookmarkImporting),
    write: value => chrome.storage.session.set({ bookmarkImporting: value }),
  }, async bookmark => {
    const identity = bilibiliIdentity(bookmark.url!);
    let result;
    try {
      result = await favorites.captureWithResult('chrome', { title: bookmark.title || bookmark.url!, originalUrl: bookmark.url!, reviewUrl: identity?.reviewUrl ?? bookmark.url!, contentType: identity ? 'video' : 'unknown', bvId: identity?.bvId, episode: identity?.episode }, bookmark.dateAdded);
    } catch (error) { await feedback.failed(bookmark.url!); throw error; }
    await feedback.show(result);
    await changed();
    void covers.updateActiveSaved(result.record.id);
  }, report);
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(report);
  chrome.alarms.onAlarm.addListener(alarm => { void reminders.handleAlarm(alarm.name).catch(report); });
  chrome.notifications.onClicked.addListener(id => { void (id === CAPTURE_NOTIFICATION_ID ? feedback.handleClick(id) : reminders.handleClick(id)).catch(report); });
  chrome.notifications.onButtonClicked.addListener((id, index) => {
    if (id === CAPTURE_NOTIFICATION_ID) { if (index === 0) void feedback.handleClick(id).catch(report); }
    else void reminders.handleButton(id, index).then(changed).catch(report);
  });
  chrome.runtime.onStartup.addListener(() => { void changed(); });
  chrome.runtime.onInstalled.addListener(() => { void changed(); });
  chrome.permissions.onAdded.addListener(() => { void changed(); });
  chrome.permissions.onRemoved.addListener(() => { void changed(); });
  // 每次 Worker 被唤醒都从持久化状态恢复，不依赖上一次的内存或 alarm 保留。
  void changed();
});
