export interface PageCover { url: string; coverUrl?: string }

/** Injected in an already authorized page. Keep helpers self-contained for MV3. */
export function readPageCover(doc: Document = document): PageCover {
  const pageUrl = (doc.location?.href ?? doc.URL ?? '').slice(0, 8192);
  const imageUrl = (value: string | null | undefined): string | undefined => {
    if (!value?.trim() || value.length > 8192) return undefined;
    try {
      const image = new URL(value.trim(), pageUrl);
      if (!['https:', 'http:'].includes(image.protocol) || image.username || image.password) return undefined;
      if (/\/(?:transparent|blank|spacer|pixel)\.(?:png|gif|webp)(?:@|$)/i.test(image.pathname)) return undefined;
      return image.href;
    } catch { return undefined; }
  };
  for (const selector of ['meta[property="og:image"], meta[name="og:image"]', 'meta[name="twitter:image"], meta[property="twitter:image"]']) {
    const cover = imageUrl(doc.querySelector(selector)?.getAttribute('content'));
    if (cover) return { url: pageUrl, coverUrl: cover };
  }
  // Only known primary cover controls are eligible; never scan page images.
  let host = '';
  try { host = new URL(pageUrl).hostname; } catch { /* No cover for an invalid page address. */ }
  if (host === 'www.bilibili.com') {
    const poster = doc.querySelector('.bpx-player-container video[poster]')?.getAttribute('poster');
    const image = doc.querySelector('.bpx-player-video-poster img, img.bpx-player-video-poster');
    const cover = imageUrl(poster) || imageUrl(image?.getAttribute('src'));
    if (cover) return { url: pageUrl, coverUrl: cover };
    const element = doc.querySelector('.bpx-player-video-poster');
    const background = element && doc.defaultView?.getComputedStyle(element).backgroundImage;
    const backgroundUrl = typeof background === 'string' ? background.match(/^url\(["']?([^"']+?)["']?\)$/)?.[1] : undefined;
    const styledCover = imageUrl(backgroundUrl);
    if (styledCover) return { url: pageUrl, coverUrl: styledCover };
  } else if (host === 'zhuanlan.zhihu.com') {
    const cover = imageUrl(doc.querySelector('img.TitleImage, .Post-Header .TitleImage img')?.getAttribute('src'));
    if (cover) return { url: pageUrl, coverUrl: cover };
  }
  return { url: pageUrl };
}
