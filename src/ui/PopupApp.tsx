import { CaptureFeedback } from '../components/CaptureFeedback';
import { CurrentCaptureStatus } from '../components/CurrentCaptureStatus';
import { useEffect } from 'react';
import { Brand, EmptyState, Feedback, LoadingState } from '../components/Layout';
import { Icon } from '../components/Icon';
import type { FavoriteRecord } from '../models/favorite';
import { extensionUrl, request } from './api';
import type { CoverResult } from '../services/cover.service';
import { endOfToday, formatDate, sourceLabels } from './format';
import { useAction, useAppState, useReviewClock } from './hooks';

function MiniRecord({ item, busy, onOpen }: { item: FavoriteRecord; busy: boolean; onOpen: () => void }) {
  return <li className="mini-record"><span className={`mini-source source-${item.source}`}><Icon name={item.source === 'bilibili' ? 'play' : 'bookmark'} size={17} /></span><div><button className="title-link" aria-label={`打开：${item.title}`} disabled={busy} onClick={onOpen}>{item.title}</button><span>{sourceLabels[item.source]} · {formatDate(item.reviewAt)}</span></div><Icon name="arrow" size={16} /></li>;
}

export function PopupApp() {
  const { state, loading, error, refresh } = useAppState();
  const action = useAction(refresh);
  useEffect(() => {
    let active = true;
    // Opening the popup can grant activeTab. A cover read never creates a record.
    void request<CoverResult>({ type: 'REFRESH_CURRENT_COVER' }).then(result => {
      if (active && result.status === 'updated') void refresh();
    }).catch(() => undefined);
    return () => { active = false; };
  }, [refresh]);
  const now = useReviewClock(state?.favorites);
  const pending = state?.favorites.filter(item => item.status === 'pending') ?? [];
  const today = pending.filter(item => item.reviewAt <= endOfToday(now)).sort((a, b) => a.reviewAt - b.reviewAt);
  const recent = [...(state?.favorites ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  return <main className="popup"><header className="popup-header"><Brand compact /><a className="icon-button" href={extensionUrl('options')} target="_blank" rel="noreferrer" aria-label="打开偏好设置"><Icon name="settings" /></a></header><CaptureFeedback /><CurrentCaptureStatus /><Feedback error={error || action.error} retry={error ? () => { void refresh(); } : undefined} />{loading && !state ? <LoadingState /> : state && <><section className="popup-hero"><div><span className="eyebrow">给好内容，再一次机会</span><h1><strong>{pending.length}</strong> 条收藏，等你回来</h1><p>{today.length ? `${today.length} 条今日与逾期内容，找一条开始吧。` : '今天没有要复盘的内容，按自己的节奏来。'}</p></div><span className="popup-hero-art"><Icon name="leaf" size={54} /></span></section><section className="popup-section"><div className="section-heading"><h2>今日与逾期</h2><span>{today.length} 条</span></div>{today.length ? <ul className="mini-list">{today.slice(0, 3).map(item => <MiniRecord key={item.id} item={item} busy={action.busy} onOpen={() => { void action.run({ type: 'OPEN_FAVORITE', id: item.id }); }} />)}</ul> : <div className="popup-calm"><Icon name="check" size={20} /><p>暂时没有到期内容。<br /><span>下次收藏后，会自动安排提醒。</span></p></div>}{today.length > 3 && <a className="text-link" href={extensionUrl('dashboard', 'due')} target="_blank" rel="noreferrer">查看其余 {today.length - 3} 条 <Icon name="arrow" size={14} /></a>}</section><section className="popup-section recent-section"><div className="section-heading"><h2>最近收藏</h2><span>慢慢积累，也慢慢消化</span></div>{recent.length ? <ul className="mini-list">{recent.map(item => <MiniRecord key={item.id} item={item} busy={action.busy} onOpen={() => { void action.run({ type: 'OPEN_FAVORITE', id: item.id }); }} />)}</ul> : <EmptyState title="第一条收藏，从这里开始">点击 Chrome 的书签星标，或在 B站成功收藏视频，这里就会自动记录。</EmptyState>}</section><footer className="popup-footer"><a className="button primary" href={extensionUrl('dashboard')} target="_blank" rel="noreferrer">打开我的收藏库 <Icon name="arrow" size={17} /></a><span><Icon name="shield" size={13} />数据仅保存在本机</span></footer></>}</main>;
}
