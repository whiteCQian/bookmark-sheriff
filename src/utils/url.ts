export function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function bilibiliIdentity(value: string): { bvId: string; episode: number; reviewUrl: string } | undefined {
  const safe = safeWebUrl(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  if (url.hostname !== 'www.bilibili.com') return undefined;
  const bvId = url.pathname.match(/^\/video\/(BV[0-9a-zA-Z]{10})(?:\/|$)/)?.[1];
  if (!bvId) return undefined;
  const raw = url.searchParams.get('p');
  const episode = raw && /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) < 100000 ? Number(raw) : 1;
  const reviewUrl = new URL(`https://www.bilibili.com/video/${bvId}/`);
  if (episode > 1) reviewUrl.searchParams.set('p', String(episode));
  const position = url.searchParams.get('t');
  if (position && /^\d+(?:\.\d+)?$/.test(position) && Number.isFinite(Number(position)) && Number(position) <= Number.MAX_SAFE_INTEGER) {
    reviewUrl.searchParams.set('t', String(Number(position)));
  }
  return { bvId, episode, reviewUrl: reviewUrl.href };
}

export function contentKey(value: string): string {
  const safe = safeWebUrl(value);
  if (!safe) throw new Error('仅支持不含登录凭据的 HTTP(S) 网页链接');
  const bili = bilibiliIdentity(safe);
  if (bili) return `bilibili:${bili.bvId}:p${bili.episode}`;
  const zhihu = zhihuIdentity(safe);
  if (zhihu) return zhihu.reviewUrl;
  const x = xPostIdentity(safe);
  if (x) return `x:${x.postId}`;
  const url = new URL(safe);
  // Hash routers use the fragment as the page address. Ordinary section links
  // still share one review task, but #/ and #!/ routes must stay independent.
  if (!/^#!?\//.test(url.hash)) url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['spm_id_from', 'fbclid', 'gclid'].includes(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

export function zhihuIdentity(value: string): { kind: 'article' | 'answer'; id: string; questionId?: string; reviewUrl: string } | undefined {
  const safe = safeWebUrl(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  if (url.protocol !== 'https:' || url.port) return undefined;
  const article = url.hostname === 'zhuanlan.zhihu.com' && url.pathname.match(/^\/p\/([1-9]\d*)\/?$/);
  if (article) return { kind: 'article', id: article[1], reviewUrl: `https://zhuanlan.zhihu.com/p/${article[1]}` };
  const answer = url.hostname === 'www.zhihu.com' && url.pathname.match(/^\/question\/([1-9]\d*)\/answer\/([1-9]\d*)\/?$/);
  if (answer) return { kind: 'answer', id: answer[2], questionId: answer[1], reviewUrl: `https://www.zhihu.com/question/${answer[1]}/answer/${answer[2]}` };
  return undefined;
}

/** Numeric IDs remain strings: X snowflakes exceed JavaScript's safe integers. */
export function xPostIdentity(value: string): { postId: string; reviewUrl: string } | undefined {
  const safe = safeWebUrl(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  if (url.protocol !== 'https:' || url.hostname !== 'x.com' || url.port) return undefined;
  const match = url.pathname.match(/^\/([a-zA-Z0-9_]{1,15})\/status\/([1-9]\d{0,29})(?:\/(?:photo|video)\/[1-9]\d*)?\/?$/);
  if (match) return { postId: match[2], reviewUrl: `https://x.com/${match[1]}/status/${match[2]}` };
  const web = url.pathname.match(/^\/i\/web\/status\/([1-9]\d{0,29})\/?$/);
  return web ? { postId: web[1], reviewUrl: `https://x.com/i/status/${web[1]}` } : undefined;
}
