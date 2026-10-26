import type { ReactNode } from 'react';
import { extensionUrl } from '../ui/api';
import { Icon } from './Icon';

export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><Icon name="bookmark" size={22} /></span><div><strong>BookMind<span> Next</span></strong><small>收藏之后，记得回来</small></div></div>;
}

export function Layout({ page, children }: { page: 'dashboard' | 'options'; children: ReactNode }) {
  return <div className="app-layout"><aside className="sidebar"><Brand /><nav aria-label="主要导航"><a className={page === 'dashboard' ? 'nav-item active' : 'nav-item'} aria-current={page === 'dashboard' ? 'page' : undefined} href={extensionUrl('dashboard')}><Icon name="grid" />我的收藏<span>↗</span></a><a className={page === 'options' ? 'nav-item active' : 'nav-item'} aria-current={page === 'options' ? 'page' : undefined} href={extensionUrl('options')}><Icon name="settings" />偏好设置<span>↗</span></a></nav><div className="sidebar-note"><Icon name="leaf" size={25} /><p>留一点时间，<br />给值得重看的内容。</p><span>本机保存 · 无需账户</span></div><div className="sidebar-footer"><Icon name="shield" size={16} /> 你的收藏，留在你的浏览器</div></aside><main className="page-content">{children}</main></div>;
}

export function Feedback({ error, notice, retry }: { error?: string; notice?: string; retry?: () => void }) {
  return <>{error && <div className="feedback error" role="alert"><span>{error}</span>{retry && <button className="text-button" onClick={retry}>重新加载</button>}</div>}{notice && <div className="feedback success" role="status"><Icon name="check" size={17} />{notice}</div>}</>;
}

export function EmptyState({ title, children, filtered = false }: { title: string; children: ReactNode; filtered?: boolean }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={filtered ? 'search' : 'bookmark'} size={30} /></span><h2>{title}</h2><p>{children}</p>{!filtered && <span className="empty-tip">收藏 → 等待提醒 → 回来复盘</span>}</div>;
}

export function LoadingState() { return <div className="loading-state" role="status"><span className="loading-dot" />正在打开你的收藏库…</div>; }
