import { DAY_MS, type AppState, type DigestDelivery, type FavoriteRecord } from '../models/favorite';
import { safeWebUrl } from '../utils/url';
import { FavoriteService } from './favorite.service';

export const REMINDER_ALARM = 'bookmind.next-review';
export const WATCHDOG_ALARM = 'bookmind.reminder-watchdog';
export const CLAIM_TTL_MS = 60_000;
export const NOTIFICATION_RETRY_MS = 5 * 60_000;
const WATCHDOG_MINUTES = 5;
const MAX_DELIVERIES_PER_WAKE = 50;
const NOTIFICATION_PREFIX = 'bookmind:review:';
export const DIGEST_NOTIFICATION_PREFIX = 'bookmind:digest:';

export interface ReminderPort {
  getAlarm(name: string): Promise<{ periodInMinutes?: number } | undefined>;
  createAlarm(name: string, info: { when?: number; periodInMinutes?: number }): Promise<void>;
  clearAlarm(name: string): Promise<unknown>;
  getNotifications(): Promise<Record<string, unknown>>;
  createNotification(id: string, options: chrome.notifications.NotificationCreateOptions): Promise<unknown>;
  clearNotification(id: string): Promise<unknown>;
  open(url: string): Promise<unknown>;
  iconUrl: string;
  dashboardUrl?: string;
}

interface NotificationIdentity { id: string; reviewAt: number }

function notificationId(record: Pick<FavoriteRecord, 'id' | 'reviewAt'>): string {
  return `${NOTIFICATION_PREFIX}${encodeURIComponent(record.id)}:${record.reviewAt}`;
}

function parseNotificationId(value: string): NotificationIdentity | undefined {
  if (!value.startsWith(NOTIFICATION_PREFIX)) return undefined;
  const match = value.slice(NOTIFICATION_PREFIX.length).match(/^([^:]+):([^:]+)$/);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]);
    const reviewAt = Number(match[2]);
    if (!id || !Number.isFinite(reviewAt) || reviewAt < 0) return undefined;
    // Reject alternative spellings so a notification has exactly one identity.
    if (notificationId({ id, reviewAt }) !== value) return undefined;
    return { id, reviewAt };
  } catch { return undefined; }
}

function matches(record: FavoriteRecord | undefined, identity: NotificationIdentity): record is FavoriteRecord {
  return !!record && record.status === 'pending' && record.reviewAt === identity.reviewAt;
}

function nextAttempt(record: FavoriteRecord): number {
  return Math.max(record.reviewAt, record.notificationRetryAt ?? 0,
    record.notificationClaimedAt === undefined ? 0 : record.notificationClaimedAt + CLAIM_TTL_MS);
}

function clearAttempt(record: FavoriteRecord): void {
  delete record.notificationClaimedAt;
  delete record.notificationRetryAt;
  delete record.notificationError;
}

function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextMidnight(at: number): number {
  const date = new Date(at);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

function digestThrottled(state: AppState, now: number): boolean {
  const digest = state.digestDelivery;
  // Clock rollback must not create another batch for an earlier local day.
  return digest?.deliveredAt !== undefined && (digest.day >= localDay(now) || digest.deliveredAt > now);
}

function digestContains(digest: DigestDelivery | undefined, record: FavoriteRecord): boolean {
  return digest?.deliveredAt === undefined && !!digest?.members.some(member => member.id === record.id && member.reviewAt === record.reviewAt);
}

function digestRecords(state: AppState, digest: DigestDelivery): FavoriteRecord[] {
  const members = new Map(digest.members.map(member => [member.id, member.reviewAt]));
  return state.favorites.filter(record => record.status === 'pending'
    && members.get(record.id) === record.reviewAt && record.notifiedAt === undefined);
}

function acknowledgeDigest(state: AppState, digest: DigestDelivery, now: number): void {
  digest.deliveredAt ??= now;
  digest.day = localDay(digest.deliveredAt);
  delete digest.retryAt;
  const members = new Map(digest.members.map(member => [member.id, member.reviewAt]));
  for (const record of state.favorites) {
    if (members.get(record.id) !== record.reviewAt) continue;
    // Delivery is known even when the clock moved back after submission.
    if (record.status === 'pending') record.notifiedAt ??= now;
    clearAttempt(record);
  }
}

/**
 * Persistent reminder state lives on each favorite; alarms are rebuildable wakeups.
 * Chrome notification delivery and storage cannot commit atomically. A visible stable
 * notification ID repairs an interrupted acknowledgement. If it disappeared before
 * recovery, the expired claim is retried and may display once more.
 */
export class ReminderService {
  private queue: Promise<unknown> = Promise.resolve();
  private watchdogReady = false;

  constructor(
    private readonly favorites: FavoriteService,
    private readonly port: ReminderPort,
    private readonly now: () => number = Date.now,
  ) {}

  private serialize(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileInternal());
  }

  handleAlarm(name: string): Promise<void> {
    return name === REMINDER_ALARM || name === WATCHDOG_ALARM ? this.reconcile() : Promise.resolve();
  }

  handleClick(id: string): Promise<void> {
    return this.serialize(async () => {
      if (id.startsWith(DIGEST_NOTIFICATION_PREFIX)) { await this.openDigest(id); return; }
      const identity = parseNotificationId(id);
      if (!identity) return;
      const url = await this.favorites.storage.transaction(state => {
        const record = state.favorites.find(item => item.id === identity.id);
        if (!state.settings.notificationsEnabled || !matches(record, identity) || record.reviewAt > this.now()
          || (record.notifiedAt === undefined && record.notificationClaimedAt === undefined)) return undefined;
        const target = safeWebUrl(record.reviewUrl);
        if (!target) return undefined;
        // A click is proof of delivery, including a click after a worker restart.
        record.notifiedAt ??= this.now();
        clearAttempt(record);
        return target;
      });
      if (url) await this.port.open(url);
      await this.port.clearNotification(id);
      // Opening content does not complete, postpone, or reactivate a review task.
    });
  }

  handleButton(id: string, index: number): Promise<void> {
    return this.serialize(async () => {
      if (id.startsWith(DIGEST_NOTIFICATION_PREFIX)) { if (index === 0) await this.openDigest(id); return; }
      const identity = parseNotificationId(id);
      if (!identity || (index !== 0 && index !== 1)) return;
      const updated = await this.favorites.storage.transaction(state => {
        const record = state.favorites.find(item => item.id === identity.id);
        if (!state.settings.notificationsEnabled || !matches(record, identity) || record.reviewAt > this.now()
          || (record.notifiedAt === undefined && record.notificationClaimedAt === undefined)) return false;
        if (index === 0) record.status = 'completed';
        else {
          record.reviewAt = this.now() + DAY_MS;
          record.status = 'pending';
          delete record.notifiedAt;
        }
        clearAttempt(record);
        return true;
      });
      await this.port.clearNotification(id);
      // Call the internal method while holding the queue to avoid nested-queue deadlock.
      if (updated) await this.reconcileInternal();
    });
  }

  private async openDigest(id: string): Promise<void> {
    const open = await this.favorites.storage.transaction(state => {
      const digest = state.digestDelivery;
      if (!state.settings.notificationsEnabled || digest?.id !== id
        || !digest.members.some(member => matches(state.favorites.find(record => record.id === member.id), member) && member.reviewAt <= this.now())) return false;
      // A real click can repair the create-success / acknowledgement gap.
      acknowledgeDigest(state, digest, this.now());
      return true;
    });
    if (open) {
      const fallback = new URL(this.port.iconUrl);
      fallback.pathname = '/dashboard.html'; fallback.search = '?view=due'; fallback.hash = '';
      await this.port.open(this.port.dashboardUrl ?? fallback.href);
    }
    await this.port.clearNotification(id);
  }

  private async reconcileInternal(): Promise<void> {
    // Verify alarms on each worker's first wake; they are not the source of truth.
    if (!this.watchdogReady || (await this.port.getAlarm(WATCHDOG_ALARM))?.periodInMinutes !== WATCHDOG_MINUTES) {
      await this.port.createAlarm(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_MINUTES });
      this.watchdogReady = true;
    }
    try {
      const visible = await this.port.getNotifications();
      const staleIds = await this.favorites.storage.transaction(state => {
        const records = new Map(state.favorites.map(record => [record.id, record]));
        const stale: string[] = [];
        for (const id of Object.keys(visible)) {
          if (id.startsWith(DIGEST_NOTIFICATION_PREFIX)) {
            const digest = state.digestDelivery;
            if (digest?.id !== id) { stale.push(id); continue; }
            // Recovery applies in either mode, including when the user disabled
            // notifications after create succeeded but before its acknowledgement.
            acknowledgeDigest(state, digest, this.now());
            const relevant = digest.members.some(member => matches(records.get(member.id), member) && member.reviewAt <= this.now());
            if (!state.settings.notificationsEnabled || !relevant || digest.day < localDay(this.now())) stale.push(id);
            continue;
          }
          if (!id.startsWith(NOTIFICATION_PREFIX)) continue;
          const identity = parseNotificationId(id);
          const record = identity ? records.get(identity.id) : undefined;
          if (!state.settings.notificationsEnabled || !identity || !matches(record, identity)) {
            stale.push(id);
          } else if (record.reviewAt <= this.now()) {
            // A surviving notification repairs a create-success / storage-failure gap.
            record.notifiedAt ??= this.now();
            clearAttempt(record);
          }
        }
        return stale;
      });
      for (const id of staleIds) await this.port.clearNotification(id);

      let state = await this.favorites.storage.snapshot();
      if (!state.settings.notificationsEnabled) return;
      // A previously submitted digest keeps its frozen identity across mode
      // changes. Never release its members to the individual delivery path.
      if (state.digestDelivery && state.digestDelivery.deliveredAt === undefined) await this.deliverDigest(false);
      state = await this.favorites.storage.snapshot();
      // An uncertain individual submission must also recover using its original
      // ID, rather than becoming a second delivery inside a new digest.
      const recovering = state.favorites.filter(record => record.status === 'pending' && record.notifiedAt === undefined
        && record.notificationClaimedAt !== undefined && !digestContains(state.digestDelivery, record)
        && nextAttempt(record) <= this.now()).slice(0, MAX_DELIVERIES_PER_WAKE);
      for (const record of recovering) await this.deliver(record.id, record.reviewAt, true);
      state = await this.favorites.storage.snapshot();
      if (!state.settings.notificationsEnabled) return;
      if (state.settings.reminderMode === 'digest') { await this.deliverDigest(true); return; }
      const due = state.favorites.filter(record => record.status === 'pending' && record.notifiedAt === undefined
        && !digestContains(state.digestDelivery, record) && Number.isFinite(record.reviewAt) && nextAttempt(record) <= this.now())
        .sort((a, b) => a.reviewAt - b.reviewAt).slice(0, MAX_DELIVERIES_PER_WAKE);
      for (const candidate of due) await this.deliver(candidate.id, candidate.reviewAt);
    } finally {
      // Also retain a retry wakeup if notification enumeration or cleanup failed.
      await this.scheduleNext();
    }
  }

  private async deliver(id: string, reviewAt: number, recovering = false): Promise<void> {
    const identity = { id, reviewAt };
    const claimed = await this.favorites.storage.transaction(state => {
      const record = state.favorites.find(item => item.id === id);
      if (!state.settings.notificationsEnabled || !matches(record, identity) || record.notifiedAt !== undefined
        || nextAttempt(record) > this.now() || digestContains(state.digestDelivery, record)
        || (recovering ? record.notificationClaimedAt === undefined : state.settings.reminderMode === 'digest')) return undefined;
      record.notificationClaimedAt = this.now();
      delete record.notificationRetryAt;
      delete record.notificationError;
      return record;
    });
    if (!claimed) return;

    // User edits can commit while any Chrome API promise is in flight.
    const before = await this.favorites.storage.snapshot();
    if (!before.settings.notificationsEnabled || !matches(before.favorites.find(item => item.id === id), identity)
      || (!recovering && before.settings.reminderMode === 'digest')) {
      await this.releaseClaim(identity, claimed.notificationClaimedAt!);
      return;
    }

    const noticeId = notificationId(claimed);
    try {
      await this.port.createNotification(noticeId, {
        type: 'basic', iconUrl: this.port.iconUrl, title: '该回来复盘了',
        message: claimed.title.slice(0, 500) || '打开收藏内容，继续学习。',
        contextMessage: 'BookMind Next · 收藏复盘',
        buttons: [{ title: '完成复盘' }, { title: '延期 1 天' }],
        priority: 0,
      });
    } catch (error) {
      await this.favorites.storage.transaction(state => {
        const record = state.favorites.find(item => item.id === id);
        if (!record || record.reviewAt !== reviewAt || record.notificationClaimedAt !== claimed.notificationClaimedAt) return;
        clearAttempt(record);
        if (state.settings.notificationsEnabled && record.status === 'pending' && record.notifiedAt === undefined) {
          record.notificationRetryAt = this.now() + NOTIFICATION_RETRY_MS;
          record.notificationError = (error instanceof Error ? error.message : '通知发送失败，请检查 Chrome 通知权限').slice(0, 500);
        }
      });
      return;
    }

    // Do not treat a persistence failure as a delivery failure: retain the claim so
    // the next worker can inspect the stable notification ID before deciding to retry.
    const keep = await this.favorites.storage.transaction(state => {
      const record = state.favorites.find(item => item.id === id);
      if (!state.settings.notificationsEnabled || !matches(record, identity)) return false;
      record.notifiedAt ??= this.now();
      clearAttempt(record);
      return true;
    });
    if (!keep) {
      await this.port.clearNotification(noticeId);
      await this.releaseClaim(identity, claimed.notificationClaimedAt!);
    }
  }

  private async releaseClaim(identity: NotificationIdentity, claimedAt: number): Promise<void> {
    await this.favorites.storage.transaction(state => {
      const record = state.favorites.find(item => item.id === identity.id);
      if (record?.reviewAt === identity.reviewAt && record.notificationClaimedAt === claimedAt) delete record.notificationClaimedAt;
    });
  }

  private async deliverDigest(allowNew: boolean): Promise<void> {
    const attempt = await this.favorites.storage.transaction(state => {
      if (!state.settings.notificationsEnabled) return undefined;
      let digest = state.digestDelivery;
      if (digest && digest.deliveredAt === undefined) {
        if (!digestRecords(state, digest).length) {
          for (const member of digest.members) {
            const record = state.favorites.find(item => item.id === member.id);
            if (record?.reviewAt === member.reviewAt) clearAttempt(record);
          }
          delete state.digestDelivery;
          return undefined;
        }
        if ((digest.retryAt ?? digest.claimedAt + CLAIM_TTL_MS) > this.now()) return undefined;
      } else {
        if (!allowNew || state.settings.reminderMode !== 'digest' || digestThrottled(state, this.now())) return undefined;
        const due = state.favorites.filter(record => record.status === 'pending' && record.notifiedAt === undefined
          && record.notificationClaimedAt === undefined && nextAttempt(record) <= this.now());
        if (!due.length) return undefined;
        digest = {
          id: `${DIGEST_NOTIFICATION_PREFIX}${crypto.randomUUID()}`, day: localDay(this.now()),
          members: due.map(({ id, reviewAt }) => ({ id, reviewAt })), claimedAt: this.now(),
        };
        state.digestDelivery = digest;
      }
      digest.claimedAt = this.now();
      digest.day = localDay(this.now());
      delete digest.retryAt;
      for (const record of digestRecords(state, digest)) {
        record.notificationClaimedAt = digest.claimedAt;
        delete record.notificationRetryAt;
        delete record.notificationError;
      }
      return structuredClone(digest);
    });
    if (!attempt) return;

    const before = await this.favorites.storage.snapshot();
    if (!before.settings.notificationsEnabled || before.digestDelivery?.id !== attempt.id) return;
    const remaining = digestRecords(before, attempt);
    if (!remaining.length) {
      await this.favorites.storage.transaction(state => {
        if (state.digestDelivery?.id !== attempt.id) return;
        for (const member of attempt.members) {
          const record = state.favorites.find(item => item.id === member.id);
          if (record?.reviewAt === member.reviewAt) clearAttempt(record);
        }
        delete state.digestDelivery;
      });
      return;
    }
    try {
      await this.port.createNotification(attempt.id, {
        type: 'basic', iconUrl: this.port.iconUrl, title: '收藏到期，一起回来看看',
        message: `${remaining.length} 条收藏已到期，打开收藏库集中处理。`,
        contextMessage: 'BookMind Next · 集中提醒', buttons: [{ title: '查看待复盘' }], priority: 0,
      });
    } catch (error) {
      await this.favorites.storage.transaction(state => {
        const digest = state.digestDelivery;
        if (digest?.id !== attempt.id || digest.claimedAt !== attempt.claimedAt || digest.deliveredAt !== undefined) return;
        digest.retryAt = this.now() + NOTIFICATION_RETRY_MS;
        for (const record of digestRecords(state, digest)) {
          clearAttempt(record);
          record.notificationRetryAt = digest.retryAt;
          record.notificationError = (error instanceof Error ? error.message : '集中通知发送失败，请检查 Chrome 通知权限').slice(0, 500);
        }
      });
      return;
    }
    // A successful create is acknowledged even if the mode changed in flight.
    // Generation checks prevent an old batch from consuming postponed reminders.
    const keep = await this.favorites.storage.transaction(state => {
      const digest = state.digestDelivery;
      if (digest?.id !== attempt.id || digest.claimedAt !== attempt.claimedAt) return false;
      acknowledgeDigest(state, digest, this.now());
      return state.settings.notificationsEnabled && digest.members.some(member => matches(state.favorites.find(record => record.id === member.id), member));
    });
    if (!keep) await this.port.clearNotification(attempt.id);
  }

  private async scheduleNext(): Promise<void> {
    const state = await this.favorites.storage.snapshot();
    let next = Infinity;
    if (state.settings.notificationsEnabled) {
      const digest = state.digestDelivery;
      if (digest && digest.deliveredAt === undefined && digestRecords(state, digest).length) {
        next = Math.min(next, digest.retryAt ?? digest.claimedAt + CLAIM_TTL_MS);
      }
      for (const record of state.favorites) {
        if (record.status === 'pending' && record.notifiedAt === undefined && Number.isFinite(record.reviewAt) && !digestContains(digest, record)) {
          let attemptAt = nextAttempt(record);
          if (state.settings.reminderMode === 'digest' && record.notificationClaimedAt === undefined && digestThrottled(state, this.now())) {
            attemptAt = Math.max(attemptAt, nextMidnight(this.now()));
          }
          next = Math.min(next, attemptAt);
        }
      }
    }
    await this.port.clearAlarm(REMINDER_ALARM);
    if (Number.isFinite(next)) {
      // Chrome can delay alarms; expired tasks are always rechecked against storage.
      await this.port.createAlarm(REMINDER_ALARM, { when: Math.max(this.now() + 30_000, next) });
    }
  }
}
