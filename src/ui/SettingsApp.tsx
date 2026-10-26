import { useEffect, useState, type FormEvent } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { Feedback, Layout, LoadingState } from '../components/Layout';
import { Icon } from '../components/Icon';
import { formatDate } from './format';
import { useAction, useAppState } from './hooks';
import { ZHIHU_ORIGINS } from '../services/site-registration.service';
import { X_ORIGINS } from '../services/x-registration.service';

function DefaultInterval({ value, busy, onSave }: { value: number; busy: boolean; onSave: (days: number) => Promise<boolean> }) {
  const [choice, setChoice] = useState([1, 3, 7].includes(value) ? String(value) : 'custom');
  const [custom, setCustom] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setChoice([1, 3, 7].includes(value) ? String(value) : 'custom'); setCustom(String(value)); }, [value]);
  function save(event: FormEvent) {
    event.preventDefault();
    const days = Number(choice === 'custom' ? custom : choice);
    if (!Number.isInteger(days) || days < 1 || days > 365) { setError('请输入 1–365 之间的整数天数。'); return; }
    setError(''); void onSave(days);
  }
  return <form onSubmit={save} noValidate><fieldset className="interval-choices" disabled={busy}><legend>收藏多久后提醒我</legend>{[{ value: '1', label: '1 天后', note: '趁热打铁' }, { value: '3', label: '3 天后', note: '留一点余地' }, { value: '7', label: '7 天后', note: '每周回顾' }, { value: 'custom', label: '自定义', note: '按你的节奏' }].map(option => <label className={`interval-option ${choice === option.value ? 'selected' : ''}`} key={option.value}><input type="radio" name="default-interval" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} /><strong>{option.label}</strong><span>{option.note}</span>{choice === option.value && <Icon name="check" size={16} />}</label>)}</fieldset>{choice === 'custom' && <div className="custom-days"><label htmlFor="custom-days">自定义提醒间隔</label><div><input id="custom-days" type="number" min={1} max={365} step={1} value={custom} onChange={event => setCustom(event.target.value)} aria-describedby="days-help" aria-invalid={!!error} /><span>天后</span></div><small id="days-help">1–365 天，仅影响之后新增的收藏。</small></div>}{error && <div className="feedback error" role="alert">{error}</div>}<div className="settings-save-row"><span>仅影响之后新增的收藏，已有计划保持原时间。</span><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存提醒偏好'}</button></div></form>;
}

function Toggle({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-toggle"><span><strong>{label}</strong><small>{description}</small></span><span className="switch"><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="switch-track" /></span></label>;
}

function StorageHealth({ count }: { count: number }) {
  if (!count) return null;
  return <section className="settings-card" aria-label="隔离数据">
    <div className="settings-section-title"><span className="settings-section-icon"><Icon name="shield" /></span><div><h2>已隔离 {count} 条异常数据</h2><p>这些数据无法安全读取，已暂停使用。</p></div></div>
    <p className="field-help">原始值仍保存在本机。隔离数据不会进入收藏列表或执行提醒，可通过下方「清空收藏与提醒」一并移除。</p>
  </section>;
}

export function SettingsApp() {
  const { state, loading, error, refresh } = useAppState();
  const action = useAction(refresh);
  const [clearOpen, setClearOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [permission, setPermission] = useState('正在读取…');
  const [version, setVersion] = useState('—');
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState('');
  const quarantinedCount = state?.quarantine?.length ?? 0;
  function toggleX(value: boolean) {
    setSiteError('');
    if (!value) { void action.run({ type: 'UPDATE_SETTINGS', patch: { xEnabled: false } }, 'X 收藏监听已关闭。'); return; }
    if (!chrome.permissions?.request) { setSiteError('当前环境无法申请 X 站点权限，监听保持关闭。'); return; }
    setSiteBusy(true);
    try {
      const authorization = chrome.permissions.request({ origins: [...X_ORIGINS] });
      void authorization.then(async granted => {
        if (!granted) { setSiteError('未获得 X 站点访问权限，监听保持关闭。'); return; }
        await action.run({ type: 'UPDATE_SETTINGS', patch: { xEnabled: true } }, 'X 实验性监听已开启。已打开页面如未生效，请刷新；只记录确认成功的收藏。');
      }).catch(() => { setSiteError('X 站点授权失败，监听保持关闭。'); }).finally(() => { setSiteBusy(false); });
    } catch { setSiteBusy(false); setSiteError('X 站点授权失败，监听保持关闭。'); }
  }
  function toggleZhihu(value: boolean) {
    setSiteError('');
    if (!value) { void action.run({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: false } }, '知乎实验性监听已关闭。'); return; }
    if (!chrome.permissions?.request) { setSiteError('当前环境无法申请知乎站点权限，监听保持关闭。'); return; }
    setSiteBusy(true);
    try {
      // Call synchronously inside the user gesture, before awaiting any work.
      const authorization = chrome.permissions.request({ origins: [...ZHIHU_ORIGINS] });
      void authorization.then(async granted => {
        if (!granted) { setSiteError('未获得知乎站点访问权限，监听保持关闭。'); return; }
        await action.run({ type: 'UPDATE_SETTINGS', patch: { zhihuEnabled: true } }, '知乎实验性监听已开启。已打开页面如未生效，请刷新；只有确认收藏成功后才记录。');
      }).catch(() => { setSiteError('知乎站点授权失败，监听保持关闭。'); }).finally(() => { setSiteBusy(false); });
    } catch { setSiteBusy(false); setSiteError('知乎站点授权失败，监听保持关闭。'); }
  }
  useEffect(() => {
    let active = true;
    try { setVersion(chrome.runtime.getManifest().version); } catch { /* Version is unavailable outside an installed extension. */ }
    if (chrome.notifications?.getPermissionLevel) {
      void chrome.notifications.getPermissionLevel().then(level => { if (active) setPermission(level === 'granted' ? '已允许' : level === 'denied' ? '已阻止' : '状态未知'); }).catch(() => { if (active) setPermission('暂时无法读取'); });
    } else setPermission('当前环境不支持读取');
    return () => { active = false; };
  }, []);
  return <Layout page="options"><header className="page-topline"><span>偏好设置</span><span className="local-badge"><span />按你的节奏</span></header><section className="page-hero settings-hero"><div><span className="eyebrow">一点设置，刚刚好</span><h1>让每一次提醒，都合时宜<span>。</span></h1><p>决定什么时候回来，其他的交给 BookMind。</p></div><div className="hero-bookmark" aria-hidden="true"><Icon name="settings" size={48} /></div></section><Feedback error={error || siteError || (!clearOpen ? action.error : '')} notice={action.notice} retry={error ? () => { void refresh(); } : undefined} />{loading && !state ? <LoadingState /> : state && <div className="settings-stack"><section className="settings-card"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="clock" /></span><div><h2>默认复盘节奏</h2><p>新收藏会自动安排一个提醒。</p></div></div><DefaultInterval value={state.settings.defaultReviewDays} busy={action.busy} onSave={days => action.run({ type: 'UPDATE_SETTINGS', patch: { defaultReviewDays: days } }, '默认提醒间隔已保存。')} /></section><section className="settings-card"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="bookmark" /></span><div><h2>收藏与提醒</h2><p>继续使用熟悉的收藏方式。</p></div></div><Toggle label="到期通知" description="在 Chrome 中显示到期提醒。关闭后仍保留你的收藏与计划。" checked={state.settings.notificationsEnabled} disabled={action.busy} onChange={value => { void action.run({ type: 'UPDATE_SETTINGS', patch: { notificationsEnabled: value } }, value ? '到期通知已开启。' : '到期通知已关闭。'); }} /><label className="reminder-mode"><span>提醒方式</span><select aria-label="提醒方式" value={state.settings.reminderMode ?? 'single'} disabled={action.busy} onChange={event => { void action.run({ type: 'UPDATE_SETTINGS', patch: { reminderMode: event.target.value as 'single' | 'digest' } }, '提醒方式已保存。'); }}><option value="single">单条提醒（沿用原设置）</option><option value="digest">每天集中一次</option></select><small>集中方式将到期内容放进一条通知，点击后一起处理；当天后续到期的内容留到次日提醒，收藏库随时可查看。</small></label><div className="permission-note"><span>Chrome 通知权限：<strong>{permission}</strong></span><small>系统通知权限或勿扰模式也可能影响通知显示。</small></div><Toggle label="B站原生收藏监听" description="实验性规则，登录后的真实收藏闭环尚未验证；普通 Chrome 书签始终保持监听。" checked={state.settings.bilibiliEnabled} disabled={action.busy} onChange={value => { void action.run({ type: 'UPDATE_SETTINGS', patch: { bilibiliEnabled: value } }, value ? 'B站收藏监听已开启。' : 'B站收藏监听已关闭。'); }} /><Toggle label="知乎原生收藏监听（实验性）" description="默认关闭。授权后自动记录文章或独立回答的成功收藏；实验性适配，站点改版可能影响识别。" checked={state.settings.zhihuEnabled} disabled={action.busy || siteBusy} onChange={toggleZhihu} /><Toggle label="X 原生收藏监听（实验性）" description="默认关闭，仅 x.com。确认成功后记录帖子链接、ID和最多280字文本预览；取消原站收藏保留复盘任务。" checked={state.settings.xEnabled} disabled={action.busy || siteBusy} onChange={toggleX} /></section><section className="settings-card about-card"><div className="settings-section-title"><span className="settings-section-icon"><Icon name="shield" /></span><div><h2>安心留在本机</h2><p>无需登录，不上传收藏记录。</p></div></div><div className="about-grid"><div><span>当前版本</span><strong>BookMind Next {version}</strong></div><div><span>运行方式</span><strong>Chrome 浏览器扩展 · 本地存储</strong></div></div><div className="privacy-note"><span>最小记录</span><p>记录标题、链接、来源、时间与可用封面，自动安排本地复盘提醒。X 收藏另保存帖子ID和短文本预览。封面仅从已授权页面获取，显示时会向原图片服务器请求。</p></div></section><section className="settings-card diagnostics-card"><details><summary><span><Icon name="more" />最近运行记录</span><span>{state.diagnostics.length} 条</span></summary><p className="field-help">最多保留最近 10 条异常，便于查看保存或提醒中遇到的问题。</p>{state.diagnostics.length ? <ul className="diagnostic-list">{state.diagnostics.slice(0, 10).map((diagnostic, index) => <li key={`${diagnostic.at}-${index}`}><time dateTime={new Date(diagnostic.at).toISOString()}>{formatDate(diagnostic.at)}</time><p>{diagnostic.message}</p></li>)}</ul> : <p className="diagnostics-empty">暂无异常记录。</p>}</details></section><StorageHealth count={quarantinedCount} /><section className="settings-card danger-zone"><div><h2>清空收藏与提醒</h2><p>移除本机的全部收藏、提醒、运行记录及隔离数据，保留偏好设置。</p></div><button className="button danger-outline" disabled={action.busy || (!state.favorites.length && !state.diagnostics.length && !quarantinedCount)} onClick={() => { action.clearFeedback(); setConfirmation(''); setClearOpen(true); }}>清空收藏与提醒</button></section><footer className="settings-footer"><Icon name="leaf" size={18} />把收藏的时间，留一点给复盘。</footer></div>}{clearOpen && <ConfirmDialog title="清空收藏与提醒？" detail="全部收藏、复盘提醒、运行记录及隔离数据将从本机移除，此操作无法撤销。你的偏好设置会保留。" confirmLabel="确认清空" disabled={confirmation !== '清空'} busy={action.busy} error={action.error} onClose={() => { setClearOpen(false); action.clearFeedback(); }} onConfirm={() => { void action.run({ type: 'CLEAR_DATA' }, '收藏与提醒已清空，偏好设置已保留。隔离数据与运行记录也已清除。').then(ok => { if (ok) setClearOpen(false); }); }}><label className="field-label" htmlFor="clear-confirmation">请输入「清空」以确认</label><input id="clear-confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></ConfirmDialog>}</Layout>;
}
