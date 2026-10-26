import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, type AppState, type FavoriteRecord } from '../src/models/favorite';
import { FavoriteService } from '../src/services/favorite.service';
import { StorageService } from '../src/services/storage.service';
import { CLAIM_TTL_MS, NOTIFICATION_RETRY_MS, REMINDER_ALARM, ReminderService, WATCHDOG_ALARM } from '../src/services/reminder.service';

function setup() {
  let now = 1_700_000_000_000;
  const memory: {
    state?: AppState;
    failWhen?: (state: AppState) => boolean;
    onWrite?: (state: AppState) => void;
  } = {};
  const storage = new StorageService({
    read: async () => memory.state,
    write: async value => {
      if (memory.failWhen?.(value)) {
        memory.failWhen = undefined;
        throw new Error('模拟存储中断');
      }
      memory.state = structuredClone(value);
      memory.onWrite?.(value);
    },
  });
  const favorites = new FavoriteService(storage, () => now);
  const alarms = new Map<string, { when?: number; periodInMinutes?: number }>();
  const visible = new Map<string, chrome.notifications.NotificationCreateOptions>();
  const port = {
    getAlarm: vi.fn(async (name: string) => alarms.get(name)),
    createAlarm: vi.fn(async (name: string, info: { when?: number; periodInMinutes?: number }) => { alarms.set(name, info); }),
    clearAlarm: vi.fn(async (name: string) => alarms.delete(name)),
    getNotifications: vi.fn(async () => Object.fromEntries([...visible.keys()].map(id => [id, true]))),
    createNotification: vi.fn(async (id: string, options: chrome.notifications.NotificationCreateOptions) => { visible.set(id, options); return id; }),
    clearNotification: vi.fn(async (id: string) => visible.delete(id)),
    open: vi.fn(async (_url: string) => undefined),
    iconUrl: 'chrome-extension://bookmind/icon/128.png',
    dashboardUrl: 'chrome-extension://bookmind/dashboard.html?view=due',
  };
  const restart = () => new ReminderService(favorites, port, () => now);
  const reminders = restart();
  const capture = (suffix = 'read') => favorites.capture('chrome', {
    title: `文章 ${suffix}`, originalUrl: `https://example.com/${suffix}?utm_source=bookmark`,
    reviewUrl: `https://example.com/${suffix}`, contentType: 'article',
  });
  return {
    storage, favorites, memory, port, alarms, visible, reminders, restart, capture,
    time: () => now, advance: (delta: number) => { now += delta; },
    setTime: (value: number) => { now = value; },
  };
}

type Harness = ReturnType<typeof setup>;
function idFor(record: Pick<FavoriteRecord, 'id' | 'reviewAt'>) {
  return `bookmind:review:${encodeURIComponent(record.id)}:${record.reviewAt}`;
}
async function createDue(harness: Harness) {
  const record = await harness.capture();
  harness.setTime(record.reviewAt);
  return record;
}
async function firstRecord(harness: Harness) {
  return (await harness.storage.snapshot()).favorites[0];
}

describe('持久化调度与恢复', () => {
  it('未到期的重复 watchdog 检查不写回整库', async () => {
    const h = setup();
    await h.capture();
    const writes = vi.fn();
    h.memory.onWrite = writes;
    await h.reminders.reconcile();
    await h.reminders.handleAlarm(WATCHDOG_ALARM);
    expect(writes).not.toHaveBeenCalled();
    expect(h.port.createNotification).not.toHaveBeenCalled();
  });

  it('默认三天只创建最近到期 alarm 和五分钟 watchdog，不提前通知', async () => {
    const h = setup();
    const record = await h.capture();
    expect(record.reviewAt).toBe(h.time() + 3 * DAY_MS);
    await h.reminders.reconcile();
    expect(h.alarms.size).toBe(2);
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: record.reviewAt });
    expect(h.alarms.get(WATCHDOG_ALARM)).toEqual({ periodInMinutes: 5 });
    expect(h.port.createNotification).not.toHaveBeenCalled();
  });

  it('超过 500 条收藏仍最多使用两个 alarm，最近任务改期后重新选择', async () => {
    const h = setup();
    const record = await h.capture();
    await h.storage.transaction(state => {
      state.favorites = Array.from({ length: 650 }, (_, index) => ({ ...record, id: `batch-${index}`, reviewAt: record.reviewAt + index * 1000 }));
    });
    await h.reminders.reconcile();
    expect(h.alarms.size).toBe(2);
    expect(new Set(h.port.createAlarm.mock.calls.map(([name]) => name))).toEqual(new Set([REMINDER_ALARM, WATCHDOG_ALARM]));
    await h.favorites.update('batch-0', { reviewAt: record.reviewAt + DAY_MS });
    await h.reminders.reconcile();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: record.reviewAt + 1000 });
    expect(h.port.createNotification).not.toHaveBeenCalled();
  });

  it('超过 500 条逾期任务分批处理，每轮保留后续 wakeup 且已投递任务不重发', async () => {
    const h = setup();
    const record = await h.capture();
    await h.storage.transaction(state => {
      state.favorites = Array.from({ length: 600 }, (_, index) => ({ ...record, id: `overdue-${index}`, reviewAt: record.reviewAt + index }));
    });
    h.setTime(record.reviewAt + DAY_MS);
    await h.reminders.reconcile();
    const firstBatch = h.port.createNotification.mock.calls.length;
    expect(firstBatch).toBeGreaterThan(0);
    expect(firstBatch).toBeLessThanOrEqual(50);
    expect(h.port.createNotification.mock.calls[0][0]).toBe(idFor({ id: 'overdue-0', reviewAt: record.reviewAt }));
    expect(h.alarms.size).toBe(2);
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: h.time() + 30_000 });
    h.advance(30_000);
    await h.reminders.handleAlarm(REMINDER_ALARM);
    expect(h.port.createNotification).toHaveBeenCalledTimes(firstBatch * 2);
    const ids = h.port.createNotification.mock.calls.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(h.alarms.size).toBe(2);
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: h.time() + 30_000 });
  });

  it('休眠后丢失 alarms，新 service 从存储恢复逾期任务且重启不重复通知', async () => {
    const h = setup();
    const record = await h.capture();
    await h.reminders.reconcile();
    h.alarms.clear();
    h.setTime(record.reviewAt + 8 * DAY_MS);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect(h.alarms.get(WATCHDOG_ALARM)).toEqual({ periodInMinutes: 5 });
    expect(h.alarms.has(REMINDER_ALARM)).toBe(false);
    expect(await firstRecord(h)).toMatchObject({ status: 'pending', notifiedAt: h.time() });
    h.visible.clear(); // 用户关闭通知后，成功标记仍可防止重新显示。
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('并发重复 wake 串行处理同一到期任务', async () => {
    const h = setup();
    await createDue(h);
    await Promise.all(Array.from({ length: 12 }, (_, i) => h.reminders.handleAlarm(i % 2 ? WATCHDOG_ALARM : REMINDER_ALARM)));
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
  });

  it('无关 alarm 不访问调度 API，watchdog 丢失后再次修复', async () => {
    const h = setup();
    await h.reminders.handleAlarm('another-feature');
    expect(h.port.getNotifications).not.toHaveBeenCalled();
    expect(h.port.createAlarm).not.toHaveBeenCalled();
    await h.reminders.reconcile();
    h.alarms.delete(WATCHDOG_ALARM);
    await h.reminders.reconcile();
    expect(h.alarms.get(WATCHDOG_ALARM)).toEqual({ periodInMinutes: 5 });
  });

  it('completed 和 ignored 不投递；关闭通知保留数据，重新启用处理未投递的逾期任务', async () => {
    const h = setup();
    const first = await h.capture('completed');
    const second = await h.capture('ignored');
    const pending = await h.capture('pending');
    await h.favorites.update(first.id, { status: 'completed' });
    await h.favorites.update(second.id, { status: 'ignored' });
    h.setTime(pending.reviewAt + DAY_MS);
    await h.favorites.settings({ notificationsEnabled: false });
    await h.reminders.reconcile();
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect(h.alarms.has(REMINDER_ALARM)).toBe(false);
    expect((await h.storage.snapshot()).favorites).toHaveLength(3);
    await h.favorites.settings({ notificationsEnabled: true });
    await h.reminders.reconcile();
    expect(h.port.createNotification).toHaveBeenCalledExactlyOnceWith(idFor(pending), expect.any(Object));
  });
});

async function digestDue(h: Harness, count = 3) {
  await h.favorites.settings({ reminderMode: 'digest' });
  const record = await h.capture();
  await h.storage.transaction(state => {
    state.favorites = Array.from({ length: count }, (_, index) => ({ ...record, id: `digest-${index}` }));
  });
  h.setTime(record.reviewAt + 1);
  return (await h.storage.snapshot()).favorites;
}

describe('可选的每日集中提醒', () => {
  it('600 条到期只创建一条，持久化全部代次，关闭通知后重启也不重发', async () => {
    const h = setup(); await digestDue(h, 600);
    await h.reminders.reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    const state = await h.storage.snapshot();
    expect(state.digestDelivery?.members).toHaveLength(600);
    expect(state.digestDelivery?.deliveredAt).toBe(h.time());
    expect(state.favorites.every(record => record.notifiedAt === h.time() && record.notificationClaimedAt === undefined)).toBe(true);
    expect(h.port.createNotification).toHaveBeenCalledWith(state.digestDelivery!.id, expect.objectContaining({ message: expect.stringContaining('600 条') }));
    h.visible.clear(); await h.restart().reconcile(); await h.reminders.handleAlarm(WATCHDOG_ALARM);
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect(h.alarms.has(REMINDER_ALARM)).toBe(false);
  });

  it('同日本地新增到期任务延到下一日历午夜，午夜后仅投递新成员', async () => {
    const h = setup(); await digestDue(h);
    h.setTime(new Date(2026, 9, 24, 23, 50).getTime());
    await h.reminders.reconcile();
    const later = await h.capture('later');
    await h.favorites.update(later.id, { reviewAt: h.time() + 1 }); h.advance(1);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    const midnight = new Date(2026, 9, 25).getTime();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: midnight });
    h.setTime(midnight); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledTimes(2);
    expect((await h.storage.snapshot()).digestDelivery?.members).toEqual([{ id: later.id, reviewAt: later.createdAt + 1 }]);
    expect(h.visible.size).toBe(1);
  });

  it('时钟回拨不重发，等待下一个本地午夜而不每 30 秒尝试', async () => {
    const h = setup(); await digestDue(h); await h.reminders.reconcile();
    const later = await h.capture('clock'); await h.favorites.update(later.id, { reviewAt: h.time() + 1 }); h.advance(1);
    const before = h.time(); h.advance(-60_000);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    const next = new Date(h.time()); next.setHours(24, 0, 0, 0);
    expect(h.alarms.get(REMINDER_ALARM)?.when).toBe(Math.max(next.getTime(), before + 1));
  });

  it('创建成功但确认存储失败，切到单条模式后从可见 ID 恢复所有成员', async () => {
    const h = setup(); await digestDue(h);
    h.memory.failWhen = state => state.digestDelivery?.deliveredAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    const id = h.port.createNotification.mock.calls[0][0];
    expect((await h.storage.snapshot()).digestDelivery?.deliveredAt).toBeUndefined();
    await h.favorites.settings({ reminderMode: 'single' });
    await h.restart().reconcile(); h.visible.clear(); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect((await h.storage.snapshot()).favorites.every(record => record.notifiedAt === h.time())).toBe(true);
    expect((await h.storage.snapshot()).digestDelivery?.id).toBe(id);
  });

  it('创建后时钟回拨仍从可见 ID 确认原代次，不在原到期时间重复投递', async () => {
    const h = setup(); const [record] = await digestDue(h);
    h.memory.failWhen = state => state.digestDelivery?.deliveredAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow();
    h.advance(-DAY_MS); await h.restart().reconcile();
    expect((await h.storage.snapshot()).favorites.every(item => item.notifiedAt === h.time())).toBe(true);
    h.setTime(record.reviewAt + DAY_MS); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('只有认领而通知不可见时等待租约，切换模式仍使用同一摘要 ID 重试', async () => {
    const h = setup(); const records = await digestDue(h);
    await h.storage.transaction(state => {
      state.digestDelivery = { id: 'bookmind:digest:interrupted', day: '2023-11-17', claimedAt: h.time(), members: records.map(({ id, reviewAt }) => ({ id, reviewAt })) };
      state.favorites.forEach(record => { record.notificationClaimedAt = h.time(); });
    });
    await h.favorites.settings({ reminderMode: 'single' });
    await h.restart().reconcile(); expect(h.port.createNotification).not.toHaveBeenCalled();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: h.time() + CLAIM_TTL_MS });
    h.advance(CLAIM_TTL_MS); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledExactlyOnceWith('bookmind:digest:interrupted', expect.any(Object));
  });

  it('待确认摘要遇到时钟回拨保留原日志与租约，不被丢弃成新批次', async () => {
    const h = setup(); const records = await digestDue(h);
    const claimedAt = h.time();
    await h.storage.transaction(state => {
      state.digestDelivery = { id: 'bookmind:digest:clock-claim', day: '2023-11-17', claimedAt, members: records.map(({ id, reviewAt }) => ({ id, reviewAt })) };
    });
    h.advance(-DAY_MS); await h.restart().reconcile();
    expect((await h.storage.snapshot()).digestDelivery?.id).toBe('bookmind:digest:clock-claim');
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: claimedAt + CLAIM_TTL_MS });
  });

  it('API 失败保留冻结批次及稳定 ID，切换模式不绕过五分钟退避', async () => {
    const h = setup(); await digestDue(h);
    h.port.createNotification.mockRejectedValueOnce(new Error('系统阻止通知'));
    await h.reminders.reconcile();
    const id = h.port.createNotification.mock.calls[0][0];
    expect((await h.storage.snapshot()).digestDelivery).toMatchObject({ id, retryAt: h.time() + NOTIFICATION_RETRY_MS });
    await h.favorites.settings({ reminderMode: 'single' });
    h.advance(NOTIFICATION_RETRY_MS - 1); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    h.advance(1); await h.restart().reconcile();
    expect(h.port.createNotification.mock.calls.map(([noticeId]) => noticeId)).toEqual([id, id]);
    expect((await h.storage.snapshot()).favorites.every(record => record.notifiedAt === h.time())).toBe(true);
  });

  it('集中认领写入失败不发通知，随后可以恢复', async () => {
    const h = setup(); await digestDue(h);
    h.memory.failWhen = state => state.digestDelivery !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    expect(h.port.createNotification).not.toHaveBeenCalled();
    await h.restart().reconcile(); expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('单条未确认投递切换集中模式，先恢复原 ID，不生成第二条摘要', async () => {
    const h = setup(); await createDue(h);
    h.memory.failWhen = state => state.favorites[0]?.notifiedAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    await h.favorites.settings({ reminderMode: 'digest' });
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect((await h.storage.snapshot()).digestDelivery).toBeUndefined();
    h.visible.clear(); await h.restart().reconcile(); expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('单条仅认领且不可见时，切换集中模式不提前发送，租约后使用原单条 ID', async () => {
    const h = setup(); const record = await createDue(h);
    await h.storage.transaction(state => { state.favorites[0].notificationClaimedAt = h.time(); });
    await h.favorites.settings({ reminderMode: 'digest' });
    await h.reminders.reconcile(); expect(h.port.createNotification).not.toHaveBeenCalled();
    h.advance(CLAIM_TTL_MS); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledExactlyOnceWith(idFor(record), expect.any(Object));
    expect((await h.storage.snapshot()).digestDelivery).toBeUndefined();
  });

  it('投递期间切换模式仍确认同代次，来回切换均不重发', async () => {
    const h = setup(); await digestDue(h);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      h.visible.set(id, options); await h.favorites.settings({ reminderMode: 'single' }); return id;
    });
    await h.reminders.reconcile(); await h.restart().reconcile();
    await h.favorites.settings({ reminderMode: 'digest' }); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('单条创建等待期间切到集中模式，成功后不会再生成摘要', async () => {
    const h = setup(); await createDue(h);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      h.visible.set(id, options); await h.favorites.settings({ reminderMode: 'digest' }); return id;
    });
    await h.reminders.reconcile(); await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect((await h.storage.snapshot()).digestDelivery).toBeUndefined();
  });

  it.each(['click', 'button'] as const)('摘要 %s 只打开今日与逾期，不改变状态和提醒时间', async operation => {
    const h = setup(); await digestDue(h); await h.reminders.reconcile();
    const state = await h.storage.snapshot(); const id = state.digestDelivery!.id;
    if (operation === 'click') await h.restart().handleClick(id); else await h.restart().handleButton(id, 0);
    expect(h.port.open).toHaveBeenCalledExactlyOnceWith(h.port.dashboardUrl);
    expect((await h.storage.snapshot()).favorites).toEqual(state.favorites);
    expect(h.visible.has(id)).toBe(false);
    await h.restart().reconcile(); expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('摘要点击可修复未确认批次，未知通知、陈旧通知和未知按钮无操作', async () => {
    const h = setup(); await digestDue(h);
    h.memory.failWhen = state => state.digestDelivery?.deliveredAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow();
    const id = h.port.createNotification.mock.calls[0][0];
    await h.restart().handleButton(id, 1); await h.restart().handleClick('bookmind:digest:unknown');
    expect(h.port.open).not.toHaveBeenCalled();
    await h.restart().handleClick(id);
    expect((await h.storage.snapshot()).favorites.every(record => record.notifiedAt === h.time() && record.status === 'pending')).toBe(true);
    expect(h.port.open).toHaveBeenCalledOnce();
  });

  it.each(['completed', 'ignored', 'deleted', 'postponed', 'disabled', 'cleared'] as const)('摘要创建等待期间 %s，不污染新计划或复活数据', async change => {
    const h = setup(); const [record] = await digestDue(h, 1);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      h.visible.set(id, options);
      if (change === 'deleted') await h.favorites.remove(record.id);
      else if (change === 'cleared') await h.favorites.clear();
      else if (change === 'disabled') await h.favorites.settings({ notificationsEnabled: false });
      else if (change === 'postponed') await h.favorites.update(record.id, { reviewAt: h.time() + DAY_MS });
      else await h.favorites.update(record.id, { status: change });
      return id;
    });
    await h.reminders.reconcile();
    const state = await h.storage.snapshot();
    expect(h.visible.size).toBe(0);
    if (change === 'postponed') {
      expect(state.favorites[0]).toMatchObject({ reviewAt: h.time() + DAY_MS, status: 'pending' });
      expect(state.favorites[0].notifiedAt).toBeUndefined();
    }
    if (change === 'cleared') { expect(state.favorites).toEqual([]); expect(state.digestDelivery).toBeUndefined(); }
    if (change === 'disabled') {
      expect(state.favorites[0].notifiedAt).toBe(h.time());
      await h.favorites.settings({ notificationsEnabled: true }); await h.restart().reconcile();
      expect(h.port.createNotification).toHaveBeenCalledOnce();
    }
    if (change === 'completed' || change === 'ignored') {
      expect(state.favorites[0].status).toBe(change);
      expect(state.favorites[0].notifiedAt).toBeUndefined();
    }
  });

  it('集中认领后发送前的完成操作阻止旧摘要，并释放未发送批次', async () => {
    const h = setup(); const [record] = await digestDue(h, 1);
    let completion: Promise<void> | undefined;
    h.memory.onWrite = state => { if (state.digestDelivery && !completion) completion = h.favorites.update(record.id, { status: 'completed' }); };
    await h.reminders.reconcile(); await completion;
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect((await h.storage.snapshot()).digestDelivery).toBeUndefined();
  });

  it('部分成员投递时被延期，只标记仍匹配原代次的成员', async () => {
    const h = setup(); const [record] = await digestDue(h, 3);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      h.visible.set(id, options); await h.favorites.update(record.id, { reviewAt: h.time() + DAY_MS }); return id;
    });
    await h.reminders.reconcile();
    const state = await h.storage.snapshot();
    expect(state.favorites.filter(item => item.notifiedAt !== undefined)).toHaveLength(2);
    const postponed = state.favorites.find(item => item.id === record.id)!;
    expect(postponed.reviewAt).toBe(h.time() + DAY_MS);
    expect(postponed.notifiedAt).toBeUndefined();
  });

  it('关闭通知清除摘要展示但保留已投递记录，清空同时清日志与通知', async () => {
    const h = setup(); await digestDue(h); await h.reminders.reconcile();
    await h.favorites.settings({ notificationsEnabled: false }); await h.reminders.reconcile();
    expect(h.visible.size).toBe(0);
    expect((await h.storage.snapshot()).digestDelivery?.deliveredAt).toBe(h.time());
    await h.favorites.clear(); await h.reminders.reconcile();
    expect((await h.storage.snapshot()).digestDelivery).toBeUndefined();
    expect(h.alarms.has(REMINDER_ALARM)).toBe(false);
  });
});

describe('持久化通知投递与失败重试', () => {
  it('先保存认领再调用通知 API，成功后记录投递且通知含中文操作和扩展图标', async () => {
    const h = setup();
    const record = await createDue(h);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      expect(await firstRecord(h)).toMatchObject({ notificationClaimedAt: h.time(), status: 'pending' });
      expect((await firstRecord(h)).notifiedAt).toBeUndefined();
      h.visible.set(id, options);
      return id;
    });
    await h.reminders.reconcile();
    expect(h.port.createNotification).toHaveBeenCalledExactlyOnceWith(idFor(record), expect.objectContaining({
      type: 'basic', title: '该回来复盘了', message: record.title, iconUrl: h.port.iconUrl,
      buttons: [{ title: '完成复盘' }, { title: '延期 1 天' }],
    }));
    const saved = await firstRecord(h);
    expect(saved.notifiedAt).toBe(h.time());
    expect(saved.notificationClaimedAt).toBeUndefined();
    expect(saved.notificationRetryAt).toBeUndefined();
  });

  it('通知 API 拒绝持久化错误并在五分钟后重试，重启和提前 wake 不绕过退避', async () => {
    const h = setup();
    const record = await createDue(h);
    h.port.createNotification.mockRejectedValueOnce(new Error('系统通知被拒绝'));
    await h.reminders.reconcile();
    expect(await firstRecord(h)).toMatchObject({ notificationError: '系统通知被拒绝', notificationRetryAt: h.time() + NOTIFICATION_RETRY_MS });
    expect((await firstRecord(h)).notifiedAt).toBeUndefined();
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: h.time() + NOTIFICATION_RETRY_MS });
    h.advance(NOTIFICATION_RETRY_MS - 1);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    h.advance(1);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledTimes(2);
    expect(h.port.createNotification.mock.calls[1][0]).toBe(idFor(record));
    const saved = await firstRecord(h);
    expect(saved.notifiedAt).toBe(h.time());
    expect(saved.notificationError).toBeUndefined();
    expect(saved.notificationRetryAt).toBeUndefined();
  });

  it('成功显示但确认写入中断，重启使用可见通知 ID 恢复而不重复 create', async () => {
    const h = setup();
    const record = await createDue(h);
    h.memory.failWhen = state => state.favorites[0].notifiedAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    expect(h.visible.has(idFor(record))).toBe(true);
    expect(await firstRecord(h)).toMatchObject({ notificationClaimedAt: h.time() });
    expect((await firstRecord(h)).notifiedAt).toBeUndefined();
    h.advance(CLAIM_TTL_MS + 1000);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect((await firstRecord(h)).notifiedAt).toBe(h.time());
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
  });

  it('只有持久化 claim 而没有可见通知时，等 60 秒租约到期再恢复投递', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.storage.transaction(state => { state.favorites[0].notificationClaimedAt = h.time(); });
    await h.restart().reconcile();
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: h.time() + CLAIM_TTL_MS });
    h.advance(CLAIM_TTL_MS);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledExactlyOnceWith(idFor(record), expect.any(Object));
  });

  it('记录无法原子提交的边界：确认前中断且通知已消失，租约后可能再次显示', async () => {
    const h = setup();
    await createDue(h);
    h.memory.failWhen = state => state.favorites[0].notifiedAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    h.visible.clear();
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    h.advance(CLAIM_TTL_MS);
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledTimes(2);
    expect((await firstRecord(h)).notifiedAt).toBe(h.time());
  });

  it('claim 写入失败时不发送；失败后的队列与下一次 wake 仍可恢复', async () => {
    const h = setup();
    await createDue(h);
    h.memory.failWhen = state => state.favorites[0].notificationClaimedAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
    await h.reminders.reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('通知枚举失败不盲目发送，并保留 watchdog 和重试 wakeup', async () => {
    const h = setup();
    await createDue(h);
    h.port.getNotifications.mockRejectedValueOnce(new Error('通知 API 暂时失败'));
    await expect(h.reminders.reconcile()).rejects.toThrow('通知 API 暂时失败');
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect(h.alarms.get(WATCHDOG_ALARM)).toEqual({ periodInMinutes: 5 });
    expect(h.alarms.get(REMINDER_ALARM)?.when).toBeGreaterThan(h.time());
    await h.reminders.handleAlarm(REMINDER_ALARM);
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });
});

describe('通知清理和改期', () => {
  const changes: [string, (h: Harness, record: FavoriteRecord) => Promise<void>][] = [
    ['完成', (h, record) => h.favorites.update(record.id, { status: 'completed' })],
    ['忽略', (h, record) => h.favorites.update(record.id, { status: 'ignored' })],
    ['删除', (h, record) => h.favorites.remove(record.id)],
    ['禁用通知', h => h.favorites.settings({ notificationsEnabled: false })],
    ['修改提醒代次', (h, record) => h.favorites.update(record.id, { reviewAt: h.time() + DAY_MS })],
  ];
  it.each(changes)('%s 后清理旧通知', async (_name, change) => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    await change(h, record);
    await h.reminders.reconcile();
    expect(h.visible.has(idFor(record))).toBe(false);
    expect(h.port.clearNotification).toHaveBeenCalledWith(idFor(record));
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('改期清除旧投递标记，新时间到期生成新的通知 ID；旧通知事件不能修改新代次', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    const nextTime = h.time() + DAY_MS;
    await h.favorites.update(record.id, { reviewAt: nextTime });
    await h.reminders.reconcile();
    const before = await h.storage.snapshot();
    await h.reminders.handleClick(idFor(record));
    await h.reminders.handleButton(idFor(record), 0);
    await h.reminders.handleButton(idFor(record), 1);
    expect(await h.storage.snapshot()).toEqual(before);
    expect(h.port.open).not.toHaveBeenCalled();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: nextTime });
    h.setTime(nextTime);
    await h.reminders.handleAlarm(REMINDER_ALARM);
    expect(h.port.createNotification).toHaveBeenCalledTimes(2);
    expect(h.port.createNotification.mock.calls[1][0]).toBe(idFor({ id: record.id, reviewAt: nextTime }));
  });

  it('只清理本模块通知，清理 API 临时失败后下一次 wake 重试', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    h.visible.set('another-feature', { type: 'basic', title: '其他', message: '保留', iconUrl: h.port.iconUrl });
    await h.favorites.remove(record.id);
    h.port.clearNotification.mockRejectedValueOnce(new Error('清理暂时失败'));
    await expect(h.reminders.reconcile()).rejects.toThrow('清理暂时失败');
    expect(h.visible.has(idFor(record))).toBe(true);
    await h.reminders.handleAlarm(WATCHDOG_ALARM);
    expect(h.visible.has(idFor(record))).toBe(false);
    expect(h.visible.has('another-feature')).toBe(true);
  });
});

describe('通知交互', () => {
  it('点击只打开安全的复盘入口并清通知，状态仍为 pending 且不再次提醒', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    const before = await h.storage.snapshot();
    await h.reminders.handleClick(idFor(record));
    expect(h.port.open).toHaveBeenCalledExactlyOnceWith(record.reviewUrl);
    expect(h.visible.has(idFor(record))).toBe(false);
    expect(await h.storage.snapshot()).toEqual(before);
    expect((await firstRecord(h)).status).toBe('pending');
    await h.reminders.reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('完成按钮幂等，清通知和到期 alarm，不会打开内容', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    await h.reminders.handleButton(idFor(record), 0);
    const completed = await h.storage.snapshot();
    await h.reminders.handleButton(idFor(record), 0);
    expect(await h.storage.snapshot()).toEqual(completed);
    expect((await firstRecord(h)).status).toBe('completed');
    expect(h.alarms.has(REMINDER_ALARM)).toBe(false);
    expect(h.visible.has(idFor(record))).toBe(false);
    expect(h.port.open).not.toHaveBeenCalled();
  });

  it('延期按钮将提醒设为从当前时间起一天，重复按钮和 wake 不会再次延期或死锁', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    h.advance(2 * DAY_MS);
    const nextTime = h.time() + DAY_MS;
    await Promise.all([
      h.reminders.handleButton(idFor(record), 1),
      h.reminders.reconcile(),
      h.reminders.handleButton(idFor(record), 1),
      h.reminders.handleButton(idFor(record), 0),
    ]);
    expect(await firstRecord(h)).toMatchObject({ reviewAt: nextTime, status: 'pending' });
    expect((await firstRecord(h)).notifiedAt).toBeUndefined();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: nextTime });
    expect(h.port.createNotification).toHaveBeenCalledOnce();
    expect(h.visible.size).toBe(0);
  });

  it('invalid、未知、未投递、已禁用和旧代次通知事件都不能打开或修改记录', async () => {
    const h = setup();
    const record = await h.capture();
    const invalidIds = [
      'not-bookmind', 'bookmind:review:%XX:123', 'bookmind:review:missing:123',
      `bookmind:review:${record.id}:0${record.reviewAt}`, idFor({ id: record.id, reviewAt: record.reviewAt - 1 }), idFor(record),
    ];
    const before = await h.storage.snapshot();
    for (const id of invalidIds) {
      await h.reminders.handleClick(id);
      await h.reminders.handleButton(id, 0);
      await h.reminders.handleButton(id, 1);
    }
    expect(await h.storage.snapshot()).toEqual(before);
    expect(h.port.open).not.toHaveBeenCalled();
    h.setTime(record.reviewAt);
    await h.reminders.reconcile();
    await h.favorites.settings({ notificationsEnabled: false });
    const disabled = await h.storage.snapshot();
    await h.reminders.handleClick(idFor(record));
    await h.reminders.handleButton(idFor(record), 0);
    expect(await h.storage.snapshot()).toEqual(disabled);
    expect(h.port.open).not.toHaveBeenCalled();
  });

  it('未知按钮不改变记录；损坏数据中的危险链接不会被通知点击打开', async () => {
    const h = setup();
    const record = await createDue(h);
    await h.reminders.reconcile();
    const before = await h.storage.snapshot();
    await h.reminders.handleButton(idFor(record), 2);
    expect(await h.storage.snapshot()).toEqual(before);
    await h.storage.transaction(state => { state.favorites[0].reviewUrl = 'javascript:alert(1)'; });
    await h.reminders.handleClick(idFor(record));
    expect(h.port.open).not.toHaveBeenCalled();
    const repaired = await h.storage.snapshot();
    expect(repaired.favorites).toHaveLength(0);
    expect(repaired.quarantine?.[0]).toMatchObject({
      kind: 'favorite', value: { id: record.id, status: 'pending', reviewUrl: 'javascript:alert(1)' },
    });
  });

  it('确认尚未落库时直接点击可作为已投递证据恢复，不标记完成', async () => {
    const h = setup();
    const record = await createDue(h);
    h.memory.failWhen = state => state.favorites[0].notifiedAt !== undefined;
    await expect(h.reminders.reconcile()).rejects.toThrow('模拟存储中断');
    await h.restart().handleClick(idFor(record));
    expect(h.port.open).toHaveBeenCalledExactlyOnceWith(record.reviewUrl);
    expect(await firstRecord(h)).toMatchObject({ status: 'pending', notifiedAt: h.time() });
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
    await h.restart().reconcile();
    expect(h.port.createNotification).toHaveBeenCalledOnce();
  });

  it('记录 ID 特殊字符和有效的毫秒小数时间可以往返通知身份', async () => {
    const h = setup();
    const record = await h.capture();
    const identity = { id: 'local:包含空格 / %', reviewAt: record.reviewAt + 0.5 };
    await h.storage.transaction(state => { Object.assign(state.favorites[0], identity); });
    h.setTime(identity.reviewAt);
    await h.reminders.reconcile();
    expect(h.visible.has(idFor(identity))).toBe(true);
    await h.reminders.handleClick(idFor(identity));
    expect(h.port.open).toHaveBeenCalledExactlyOnceWith(record.reviewUrl);
    expect((await firstRecord(h)).status).toBe('pending');
  });
});

describe('收藏操作与通知 API 等待期间的竞态', () => {
  it('认领落库后、调用通知 API 前的完成操作阻止旧通知投递', async () => {
    const h = setup();
    const record = await createDue(h);
    let completion: Promise<void> | undefined;
    h.memory.onWrite = state => {
      if (state.favorites[0]?.notificationClaimedAt !== undefined && !completion) {
        completion = h.favorites.update(record.id, { status: 'completed' });
      }
    };
    await h.reminders.reconcile();
    await completion;
    expect(h.port.createNotification).not.toHaveBeenCalled();
    expect((await firstRecord(h)).status).toBe('completed');
    expect((await firstRecord(h)).notificationClaimedAt).toBeUndefined();
  });

  it.each([
    ['完成', (h: Harness, record: FavoriteRecord) => h.favorites.update(record.id, { status: 'completed' })],
    ['忽略', (h: Harness, record: FavoriteRecord) => h.favorites.update(record.id, { status: 'ignored' })],
    ['删除', (h: Harness, record: FavoriteRecord) => h.favorites.remove(record.id)],
    ['禁用', (h: Harness) => h.favorites.settings({ notificationsEnabled: false })],
    ['改期', (h: Harness, record: FavoriteRecord) => h.favorites.update(record.id, { reviewAt: h.time() + DAY_MS })],
  ] as const)('通知创建等待期间%s，完成后清理旧通知且不写旧代次成功标记', async (_name, change) => {
    const h = setup();
    const record = await createDue(h);
    h.port.createNotification.mockImplementationOnce(async (id, options) => {
      h.visible.set(id, options);
      await change(h, record);
      return id;
    });
    await h.reminders.reconcile();
    expect(h.visible.has(idFor(record))).toBe(false);
    expect(h.port.clearNotification).toHaveBeenCalledWith(idFor(record));
    const saved = await firstRecord(h);
    if (saved) {
      expect(saved.notifiedAt).toBeUndefined();
      expect(saved.notificationClaimedAt).toBeUndefined();
    }
  });

  it('通知创建失败期间改期，不把旧代次的失败和退避写到新任务', async () => {
    const h = setup();
    const record = await createDue(h);
    const nextTime = h.time() + DAY_MS;
    h.port.createNotification.mockImplementationOnce(async () => {
      await h.favorites.update(record.id, { reviewAt: nextTime });
      throw new Error('旧通知失败');
    });
    await h.reminders.reconcile();
    const saved = await firstRecord(h);
    expect(saved.reviewAt).toBe(nextTime);
    expect(saved.notificationError).toBeUndefined();
    expect(saved.notificationRetryAt).toBeUndefined();
    expect(h.alarms.get(REMINDER_ALARM)).toEqual({ when: nextTime });
  });
});
