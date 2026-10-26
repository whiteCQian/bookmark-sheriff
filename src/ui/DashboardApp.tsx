import { useEffect, useMemo, useRef, useState } from 'react';
import { FavoriteCard } from '../components/FavoriteCard';
import { FavoriteEditor } from '../components/FavoriteEditor';
import { ConfirmDialog } from '../components/Dialog';
import { EmptyState, Feedback, Layout, LoadingState } from '../components/Layout';
import { Icon } from '../components/Icon';
import type { FavoriteRecord, FavoriteSource, ReviewStatus } from '../models/favorite';
import { useAction, useAppState, useReviewClock } from './hooks';
import { endOfToday } from './format';
import type { BatchChange } from '../services/batch.service';

type StatusFilter = ReviewStatus | 'all' | 'due' | 'today' | 'overdue';

function SelectionBar({ count, total, busy, all, partial, onAll, onClear, onChange }: {
  count: number; total: number; busy: boolean; all: boolean; partial: boolean;
  onAll: (value: boolean) => void; onClear: () => void; onChange: (change: BatchChange) => void;
}) {
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = partial; }, [partial]);
  return <div className="batch-bar" aria-label="批量处理">
    <label><input ref={selectAll} type="checkbox" aria-label="选择当前筛选的全部收藏" checked={all} disabled={busy || !total} onChange={event => onAll(event.target.checked)} />全选当前 {total} 条</label>
    <span aria-live="polite">已选 {count} 条</span>
    <button className="small-button complete" disabled={busy || !count} onClick={() => onChange({ kind: 'complete' })}>批量完成</button>
    <button className="small-button" disabled={busy || !count} onClick={() => onChange({ kind: 'ignore' })}>批量忽略</button>
    <select aria-label="批量延期" className="postpone-select" value="" disabled={busy || !count} onChange={event => { if (event.target.value) onChange({ kind: 'postpone', reviewAt: Date.now() + Number(event.target.value) * 86_400_000 }); }}><option value="">批量延期…</option><option value="1">1 天后</option><option value="3">3 天后</option><option value="7">7 天后</option></select>
    {count > 0 && <button className="small-button" disabled={busy} onClick={onClear}>清除选择</button>}
  </div>;
}

export function DashboardApp() {
  const { state, loading, error, refresh } = useAppState();
  const action = useAction(refresh);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<FavoriteSource | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>(() => {
    const view = new URLSearchParams(window.location.search).get('view');
    return view === 'due' || view === 'today' || view === 'overdue' ? view : 'all';
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<FavoriteRecord>();
  const [deleting, setDeleting] = useState<FavoriteRecord>();
  const favorites = state?.favorites ?? [];
  const now = useReviewClock(favorites);
  const todayEndsAt = endOfToday(now);
  const todayStartsAt = new Date(now).setHours(0, 0, 0, 0);
  const dueView = status === 'due' || status === 'today' || status === 'overdue';
  const items = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return favorites.filter(item => {
      const matchesStatus = status === 'all' || (dueView ? item.status === 'pending' && (status === 'today'
        ? item.reviewAt >= todayStartsAt && item.reviewAt <= todayEndsAt
        : status === 'overdue' ? item.reviewAt < now : item.reviewAt <= todayEndsAt) : item.status === status);
      return (source === 'all' || item.source === source) && matchesStatus
        && (!query || [item.title, item.note, item.textPreview, item.reviewUrl].some(value => value?.toLocaleLowerCase().includes(query)));
    }).sort((a, b) => dueView ? a.reviewAt - b.reviewAt || b.createdAt - a.createdAt : b.createdAt - a.createdAt);
  }, [favorites, source, status, search, todayStartsAt, todayEndsAt, dueView, now]);
  useEffect(() => { setSelected([]); }, [search, source, status]);
  useEffect(() => {
    const visible = new Set(items.map(item => item.id));
    setSelected(previous => {
      const kept = previous.filter(id => visible.has(id));
      return kept.length === previous.length ? previous : kept;
    });
  }, [items]);
  const allSelected = items.length > 0 && items.every(item => selected.includes(item.id));
  function batch(change: BatchChange) {
    const ids = [...selected];
    void action.run({ type: 'BATCH_UPDATE_FAVORITES', ids, change }, `已处理 ${ids.length} 条所选收藏。`).then(ok => { if (ok) setSelected([]); });
  }
  const pending = favorites.filter(item => item.status === 'pending');
  const dueToday = pending.filter(item => item.reviewAt <= todayEndsAt).length;
  const filtered = !!search.trim() || source !== 'all' || status !== 'all';
  return <Layout page="dashboard"><header className="page-topline"><span>我的收藏库</span><span className="local-badge"><span />本机保存</span></header><section className="page-hero"><div><span className="eyebrow">收藏，是好奇心的开始</span><h1>好内容，值得再见一面<span>。</span></h1><p>把当时的心动，变成今天的一点收获。</p></div><div className="hero-bookmark" aria-hidden="true"><Icon name="bookmark" size={56} /><span className="hero-spark">✦</span></div></section><Feedback error={error || (!editing && !deleting ? action.error : '')} notice={action.notice} retry={error ? () => { void refresh(); } : undefined} />{loading && !state ? <LoadingState /> : state && <><div className="stats-grid"><div className="stat-card"><span>全部收藏</span><strong>{favorites.length}</strong><Icon name="bookmark" size={22} /></div><div className="stat-card featured"><span>待复盘</span><strong>{pending.length}</strong><small>{dueToday} 条今日与逾期</small><Icon name="clock" size={22} /></div><div className="stat-card"><span>已完成</span><strong>{favorites.filter(item => item.status === 'completed').length}</strong><Icon name="check" size={22} /></div></div><section className="collection-section" aria-label="收藏列表"><div className="collection-heading"><div><h2>你的每一次「先收藏」</h2><p>{filtered ? `找到 ${items.length} 条匹配记录${dueView ? '，按提醒时间排序。' : ''}` : '按最近收藏排序，随时回来继续。'}</p></div><span className="total-chip">{items.length} 条</span></div><div className="filter-bar"><div className="search-box"><Icon name="search" size={19} /><input type="search" aria-label="搜索收藏" placeholder="搜索标题、备注或链接" value={search} onChange={event => setSearch(event.target.value)} /></div><label className="filter-control"><span className="sr-only">来源筛选</span><select aria-label="来源筛选" value={source} onChange={event => setSource(event.target.value as FavoriteSource | 'all')}><option value="all">全部来源</option><option value="chrome">Chrome 书签</option><option value="bilibili">哔哩哔哩</option><option value="zhihu">知乎</option><option value="x">X</option></select></label><label className="filter-control"><span className="sr-only">复盘状态筛选</span><select aria-label="复盘状态筛选" value={status} onChange={event => setStatus(event.target.value as StatusFilter)}><option value="all">全部状态</option><option value="due">今日与逾期</option><option value="today">今日到期</option><option value="overdue">已逾期</option><option value="pending">待复盘</option><option value="completed">已完成</option><option value="ignored">已忽略</option></select></label></div><SelectionBar count={selected.length} total={items.length} busy={action.busy} all={allSelected} partial={selected.length > 0 && !allSelected} onAll={value => setSelected(value ? items.map(item => item.id) : [])} onClear={() => setSelected([])} onChange={batch} />{items.length ? <div className="favorites-list">{items.map(item => <FavoriteCard key={item.id} item={item} selected={selected.includes(item.id)} onSelect={value => setSelected(previous => value ? [...previous.filter(id => id !== item.id), item.id] : previous.filter(id => id !== item.id))} now={now} busy={action.busy} onOpen={() => { void action.run({ type: 'OPEN_FAVORITE', id: item.id }); }} onEdit={() => { action.clearFeedback(); setEditing(item); }} onDelete={() => { action.clearFeedback(); setDeleting(item); }} onComplete={() => { void action.run({ type: 'UPDATE_FAVORITE', id: item.id, patch: { status: 'completed' } }, '已完成复盘，给自己的好奇心一个回应。'); }} onIgnore={() => { void action.run({ type: 'UPDATE_FAVORITE', id: item.id, patch: { status: 'ignored' } }, '已忽略这条提醒。'); }} onPostpone={at => { void action.run({ type: 'UPDATE_FAVORITE', id: item.id, patch: { reviewAt: at } }, '提醒时间已更新。'); }} />)}</div> : <EmptyState filtered={filtered} title={filtered ? '暂时没有匹配的收藏' : '留住值得回来的内容'}>{filtered ? '换个关键词，或调整来源与状态筛选。' : '像往常一样点击 Chrome 书签星标，或在 B站成功收藏视频。我们会记下来，并在合适的时候提醒你。'}</EmptyState>}</section></>}{editing && <FavoriteEditor item={editing} busy={action.busy} error={action.error} onClose={() => { setEditing(undefined); action.clearFeedback(); }} onSave={patch => action.run({ type: 'UPDATE_FAVORITE', id: editing.id, patch }, '收藏已更新。')} />}{deleting && <ConfirmDialog title="删除这条收藏？" detail={`「${deleting.title}」及其提醒将从 BookMind Next 中移除。`} confirmLabel="确认删除" busy={action.busy} error={action.error} onClose={() => { setDeleting(undefined); action.clearFeedback(); }} onConfirm={() => { void action.run({ type: 'DELETE_FAVORITE', id: deleting.id }, '收藏与对应提醒已删除。').then(ok => { if (ok) setDeleting(undefined); }); }} />}</Layout>;
}
