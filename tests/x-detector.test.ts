// @vitest-environment-options {"url":"https://x.com/home"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createXBookmarkDetector } from '../src/detectors/x-bookmark';

const first = '1900000000000000001';
const second = '1900000000000000002';
let href: string;
let detectors: ReturnType<typeof createXBookmarkDetector>[] = [];
const detectorWindow = new Proxy(window, {
  get(target, key) {
    if (key === 'location') return { href };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  },
});
function article(id = first, content = 'A useful post', saved = false) {
  return `<article data-testid="tweet" id="post-${id}"><a role="link" href="https://x.com/example/status/${id}"><time datetime="2026-10-25T00:00:00Z">now</time></a><div data-testid="tweetText">${content}</div><button id="bookmark-${id}" data-testid="${saved ? 'removeBookmark' : 'bookmark'}"><span>Bookmark</span></button></article>`;
}
function setup(overrides: Partial<Parameters<typeof createXBookmarkDetector>[0]> = {}) {
  const sink = vi.fn();
  const detector = createXBookmarkDetector({ document, window: detectorWindow, enabled: true, isTrustedClick: () => true, onBookmark: sink, ...overrides });
  detectors.push(detector); return { sink, detector };
}
function click(id = first) { document.getElementById(`bookmark-${id}`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); }
function state(saved: boolean, id = first) { document.getElementById(`bookmark-${id}`)!.setAttribute('data-testid', saved ? 'removeBookmark' : 'bookmark'); }
function toast(value = 'Added to your Bookmarks') { const node = document.createElement('div'); node.dataset.testid = 'toast'; node.setAttribute('role', 'status'); node.textContent = value; document.body.append(node); return node; }
async function flush(ms = 700) { await Promise.resolve(); await vi.advanceTimersByTimeAsync(ms); }
beforeEach(() => { vi.useFakeTimers(); href = 'https://x.com/home'; document.body.innerHTML = article(); });
afterEach(() => { detectors.forEach(detector => detector.dispose()); detectors = []; vi.restoreAllMocks(); vi.useRealTimers(); });

describe('X实验性原生书签检测（固定DOM，不代替真实X验收）', () => {
  it('默认关闭及空闲时不扫描、不开观察器或计时器', async () => {
    const query = vi.spyOn(document, 'querySelectorAll'); const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { detector, sink } = setup({ enabled: undefined }); click(); state(true); toast(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(detector.getStatus().code).toBe('disabled'); expect(query).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('启用后空闲和只读状态同样无扫描或计时器', async () => {
    const { detector } = setup(); const query = vi.spyOn(document, 'querySelectorAll');
    expect(detector.getStatus().code).toBe('ready'); await flush(1000); expect(query).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('生产模式忽略网页合成点击', async () => {
    const { sink } = setup({ isTrustedClick: undefined }); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('点击、数字或CSS不能创建收藏，终态仍需新精确反馈', async () => {
    const { sink } = setup(); click(); document.querySelector('button')!.classList.add('active'); document.querySelector('button')!.textContent = '123';
    toast('Success'); await flush(); state(true); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('精确成功反馈没有明确终态同样不发送', async () => {
    const { sink } = setup(); click(); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['Added to your Bookmarks', 'Post added to your Bookmarks', 'Added to Bookmarks', '已添加到你的书签', '已添加到书签'])('信息流新%s与稳定终态产生唯一最小记录', async message => {
    const { sink } = setup(); click(); state(true); toast(message); await flush(); toast(message); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: `https://x.com/example/status/${first}`, postId: first, preview: 'A useful post', action: 'add' }); expect(vi.getTimerCount()).toBe(0);
  });
  it('详情页支持点击另一条回复，归属来自该文章时间链接而非地址栏', async () => {
    href = `https://x.com/example/status/${second}`; const { sink } = setup(); click(); state(true); toast(); await flush();
    expect(sink.mock.calls[0][0].postId).toBe(first);
  });
  it.each(['Removed from your Bookmarks', 'Post removed from your Bookmarks', '已从你的书签中移除', '已从书签中移除'])('已收藏→未收藏和新%s只发送remove，不发送add', async message => {
    document.body.innerHTML = article(first, 'Preview', true); const { sink } = setup(); click(); state(false); toast(message); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: `https://x.com/example/status/${first}`, postId: first, preview: 'Preview', action: 'remove' });
  });
  it('终态在稳定窗口内回滚不确认', async () => {
    const { sink } = setup(); click(); state(true); toast(); await flush(300); state(false); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('再次改变书签属性会重新开始完整稳定窗口', async () => {
    const { sink } = setup(); click(); state(true); toast(); await flush(400); state(false); state(true); await flush(400);
    expect(sink).not.toHaveBeenCalled(); await flush(300); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('失败优先于同一批成功和终态', async () => {
    const { sink } = setup(); click(); state(true); toast(); toast('Something went wrong. Try again.'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('短暂出现后移除的失败仍拒绝晚到成功', async () => {
    const { sink } = setup(); click(); const failure = toast('Bookmark failed'); failure.remove(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['textContent', 'characterData'])('复用toast在同一任务内失败→成功（%s）也不能丢掉失败', async mode => {
    const message = toast('Waiting'); const { sink } = setup(); click(); state(true);
    if (mode === 'textContent') { message.textContent = 'Something went wrong'; message.textContent = 'Added to your Bookmarks'; }
    else { const node = message.firstChild as Text; node.data = 'Something went wrong'; node.data = 'Added to your Bookmarks'; }
    await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('旧失败toast被真正的新成功覆盖，不把旧失败误判为本次失败', async () => {
    const message = toast('Something went wrong'); const { sink } = setup(); click(); state(true); message.textContent = 'Added to your Bookmarks';
    await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('相反方向成功消息不能确认当前操作', async () => {
    const { sink } = setup(); click(); state(true); toast('Removed from your Bookmarks'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('旧可见或隐藏成功反馈不能重复消费', async () => {
    toast(); const hidden = toast('Post added to your Bookmarks'); hidden.hidden = true;
    const { sink } = setup(); click(); state(true); hidden.hidden = false; await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('toast含View链接时只消费新消息span，旧消息加子项不能变新消息', async () => {
    const old = toast(); old.innerHTML = '<span>Added to your Bookmarks</span><a>View</a>';
    const { sink } = setup(); click(); state(true); old.insertAdjacentHTML('beforeend', '<span>new counter</span>'); await flush(); expect(sink).not.toHaveBeenCalled();
    const fresh = toast(); fresh.innerHTML = '<span>Added to your Bookmarks</span><a>View</a>'; await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('帖子正文里的伪role=status不能当网站成功', async () => {
    const { sink } = setup(); click(); state(true); document.querySelector('article')!.insertAdjacentHTML('beforeend', '<div role="status">Added to your Bookmarks</div>'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('拒绝只有正文普通链接，没有自己的时间permalink的文章', async () => {
    document.querySelector('time')!.remove(); const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('正文里伪装成time的状态链接也不能当自己的permalink', async () => {
    document.querySelector('article > a')!.remove();
    document.querySelector('[data-testid="tweetText"]')!.innerHTML = `<a href="https://x.com/example/status/${first}"><time>cited timestamp</time></a>`;
    const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('引用卡片中的时间或正文不能归给外层帖子', async () => {
    document.body.innerHTML = `<article data-testid="tweet"><div data-testid="quoteTweet"><a href="https://x.com/example/status/${first}"><time>now</time></a><div data-testid="tweetText">quoted</div></div><button id="bookmark-${first}" data-testid="bookmark">Bookmark</button></article>`;
    const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('自己的多个不同时间链接导致归属歧义时拒绝', async () => {
    document.querySelector('article')!.insertAdjacentHTML('beforeend', `<a href="https://x.com/other/status/${second}"><time>now</time></a>`);
    const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('同一ID重复时间链接不会导致精度损失或重复事件', async () => {
    document.querySelector('article')!.insertAdjacentHTML('beforeend', `<a href="https://x.com/example/status/${first}"><time>now</time></a>`);
    const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink.mock.calls[0][0].postId).toBe(first);
  });
  it('只读取被收藏帖子的可见tweetText，排除引用、隐藏和嵌套帖', async () => {
    document.body.innerHTML = article(first, 'own <a role="link" href="https://example.com">visible</a><span hidden>secret</span><div data-testid="quoteTweet">quote</div>') + article(second, 'other post');
    document.querySelector(`#post-${first}`)!.insertAdjacentHTML('beforeend', `<div data-testid="quoteTweet">${article('1900000000000000003', 'nested quote')}</div>`);
    const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink.mock.calls[0][0].preview).toBe('own visible');
  });
  it('多媒体无文本预览可为空，Unicode预览按280码点截断', async () => {
    document.body.innerHTML = article(first, '😀'.repeat(350)); const { sink } = setup(); click(); state(true); toast(); await flush();
    expect(Array.from(sink.mock.calls[0][0].preview)).toHaveLength(280); expect(sink.mock.calls[0][0].preview.endsWith('😀')).toBe(true);
  });
  it('没有tweetText仍可保存链接事件', async () => {
    document.querySelector('[data-testid="tweetText"]')!.remove(); const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink.mock.calls[0][0].preview).toBe('');
  });
  it('同一文章出现多个可见书签控件拒绝猜测', async () => {
    document.querySelector('article')!.insertAdjacentHTML('beforeend', '<button data-testid="bookmark">another</button>'); const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('同帖控制被React替换仍能归属终态', async () => {
    const { sink } = setup(); click(); document.querySelector('button')!.outerHTML = `<button id="bookmark-${first}" data-testid="removeBookmark">Saved</button>`; toast(); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('文章重建时仅唯一同ID可见替代可继续', async () => {
    const { sink } = setup(); click(); document.querySelector('article')!.outerHTML = article(first, 'new same post', true); toast(); await flush(); expect(sink.mock.calls[0][0].preview).toBe('new same post');
  });
  it('文章消失或多个同ID替代不能借用其他帖子成功态', async () => {
    const { sink } = setup(); click(); document.querySelector('article')!.outerHTML = article(first, 'a', true) + article(first, 'b', true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('虚拟列表复用同一文章节点但变成别的ID时拒绝', async () => {
    const { sink } = setup(); click(); document.querySelector('a')!.setAttribute('href', `https://x.com/example/status/${second}`); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('A后点击B时两者都进入安静隔离，A晚到toast不能误记乐观B', async () => {
    document.body.innerHTML = article() + article(second); const { sink, detector } = setup({ candidateTimeoutMs: 500, settleMs: 100 });
    click(); click(second); state(true, second); toast(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(detector.getStatus().code).toBe('ambiguous'); expect(vi.getTimerCount()).toBe(0);
    state(false, second); click(second); state(true, second); toast(); await flush(); expect(sink.mock.calls[0][0].postId).toBe(second);
  });
  it('同帖快速add/remove/add不能把旧add反馈拼到新操作', async () => {
    const { sink, detector } = setup({ candidateTimeoutMs: 500 }); click(); state(true); click(); state(false); click(); state(true); toast(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(detector.getStatus().code).toBe('ambiguous'); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['https://x.com/example/status/1900000000000000001', 'https://x.com/search?q=new', 'https://x.com/i/flow/login'])('候选期SPA切换到%s清理旧候选', async next => {
    const { sink } = setup(); click(); href = next; state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['https://twitter.com/home', 'https://x.com.evil.example/home', 'http://x.com/home'])('不支持来源%s不启动观察', async page => {
    href = page; const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('禁用、超时和dispose均清理全部候选资源', async () => {
    const { sink, detector } = setup({ candidateTimeoutMs: 300 }); click(); await flush(400); state(true); toast(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); detector.dispose(); detector.dispose(); click(); expect(vi.getTimerCount()).toBe(0);
  });
  it('确认期间设置关闭后晚到反馈无效', async () => {
    const { sink, detector } = setup(); click(); state(true); toast(); await flush(300); detector.setEnabled(false); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('已确认后空闲SPA导航，不沿用旧页成功状态且不启动资源', async () => {
    const { detector } = setup(); click(); state(true); toast(); await flush(); expect(detector.getStatus().code).toBe('confirmed');
    href = `https://x.com/example/status/${second}`; expect(detector.getStatus().code).toBe('navigation'); expect(vi.getTimerCount()).toBe(0);
  });
  it('登录或其他弹窗阻止确认，Escape和toast Undo也取消', async () => {
    const { sink } = setup(); click(); document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Log in</div>'); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('可信toast撤销和Escape阻止尚未稳定的事件', async () => {
    const { sink } = setup(); click(); state(true); const feedback = toast(); feedback.insertAdjacentHTML('beforeend', '<button id="undo">Undo</button>');
    document.getElementById('undo')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('Escape之后的新操作隔离旧请求晚到反馈', async () => {
    document.body.innerHTML = article() + article(second); const { sink, detector } = setup(); click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); click(second); state(true, second); toast(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(detector.getStatus().code).toBe('ambiguous'); expect(vi.getTimerCount()).toBe(0);
  });
  it('页面禁用的书签控件不能创建候选', async () => {
    document.querySelector('button')!.setAttribute('aria-disabled', 'true'); const { sink } = setup(); click(); state(true); toast(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('异步回调错误交给onError而不干扰网站', async () => {
    const error = new Error('save failure'); const onError = vi.fn(); setup({ onBookmark: async () => { throw error; }, onError }); click(); state(true); toast(); await flush(); expect(onError).toHaveBeenCalledWith(error);
  });
});
