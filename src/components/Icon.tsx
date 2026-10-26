export type IconName = 'bookmark' | 'arrow' | 'clock' | 'check' | 'search' | 'settings' | 'grid' | 'leaf' | 'close' | 'link' | 'more' | 'shield' | 'play';
const paths: Record<IconName, string> = {
  bookmark: 'M6 4h12v17l-6-4-6 4V4Z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'm5 12 4 4L19 6',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  leaf: 'M19 4C10 3 4 7 5 13c1 6 9 8 13 1 2-3 1-7 1-10ZM5 21c1-7 4-11 10-14',
  close: 'm6 6 12 12M6 18 18 6',
  link: 'M9 15 15 9m-4-3 2-2a5 5 0 0 1 7 7l-3 3M7 10l-3 3a5 5 0 0 0 7 7l2-2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
  play: 'm9 5 11 7-11 7V5Z',
};
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
