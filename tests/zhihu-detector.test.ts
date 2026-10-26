// @vitest-environment-options {"url":"https://zhuanlan.zhihu.com/p/123"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createZhihuFavoriteDetector } from '../src/detectors/zhihu-favorite';

let detectors: ReturnType<typeof createZhihuFavoriteDetector>[] = [];
let pageHref: string;
// Keep one jsdom DOM while testing both permitted Zhihu origins. This facade only supplies the page URL.
const detectorWindow = new Proxy(window, {
  get(target, key) {
    if (key === 'location') return { href: pageHref };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

beforeEach(() => {
  vi.useFakeTimers();
  pageHref = 'https://zhuanlan.zhihu.com/p/123';
  document.title = '测试标题';
  document.body.innerHTML = '<article class="Post-Main"><div class="ContentItem-actions"><button class="ContentItem-action" aria-label="收藏">收藏</button></div></article>';
});
afterEach(() => {
  detectors.forEach(detector => detector.dispose());
  detectors = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(overrides: Partial<Parameters<typeof createZhihuFavoriteDetector>[0]> = {}) {
  const sink = vi.fn();
  const detector = createZhihuFavoriteDetector({ document, window: detectorWindow, onFavorite: sink, enabled: true, isTrustedClick: () => true, ...overrides });
  detectors.push(detector);
  return { detector, sink };
}
function click(selector = '.ContentItem-action') { document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); }
function state(value: boolean) {
  const button = document.querySelector('.ContentItem-action')!;
  button.setAttribute('aria-label', value ? '取消收藏' : '收藏');
  button.textContent = value ? '已收藏' : '收藏';
}
function feedback(value: string, className = 'Toast') {
  const toast = document.createElement('div'); toast.className = className; toast.textContent = value; document.body.append(toast); return toast;
}
function dialog() {
  document.body.insertAdjacentHTML('beforeend', '<div role="dialog">添加到收藏夹<button id="confirm">确定</button><button id="cancel">取消</button><button id="close" aria-label="关闭"></button></div>');
}
function favoriteList(rows = ['收藏']) {
  document.body.insertAdjacentHTML('beforeend', `<div class="Modal-content"><div class="Favlists-content"><div class="Favlists-items" role="list">${rows.map((label, index) => `<div class="Favlists-item"><button id="row-${index}" class="Favlists-updateButton ${label === '收藏' ? 'Button--blue' : 'Button--primary Button--grey'}">${label}</button></div>`).join('')}</div><button class="Modal-closeButton" aria-label="关闭"></button></div></div>`);
}
function toolbarFavorited() { document.querySelector('.ContentItem-action')!.setAttribute('aria-label', '已收藏'); }
function rowFavorited(index = 0) { document.querySelector(`#row-${index}`)!.textContent = '已收藏'; }
function answer(id = '456', questionId = '123', extraLinks = '') {
  return `<div class="AnswerItem"><a class="ContentItem-time" href="https://www.zhihu.com/question/${questionId}/answer/${id}">发布于昨天</a>${extraLinks}<div class="ContentItem-actions"><button class="ContentItem-action" aria-label="收藏">收藏</button></div></div>`;
}
async function flush(ms = 100) { await Promise.resolve(); await vi.advanceTimersByTimeAsync(ms); }

describe('知乎实验性收藏检测：DOM 模拟不代表真实登录网页验收', () => {
  it('默认关闭，禁用时点击、状态和反馈均不扫描记录', async () => {
    const spy = vi.spyOn(document, 'querySelectorAll');
    const { sink } = setup({ enabled: undefined });
    click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(spy).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('默认忽略网页合成点击', async () => {
    const { sink } = setup({ isTrustedClick: undefined }); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('启用后的空闲状态无扫描、观察器和计时器', async () => {
    const query = vi.spyOn(document, 'querySelectorAll');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const { sink } = setup(); feedback('收藏成功'); await flush(1000);
    expect(sink).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('点击、人数变化或泛 active 样式均不会确认收藏', async () => {
    const { sink } = setup(); click();
    document.querySelector('button')!.classList.add('active');
    document.querySelector('button')!.insertAdjacentHTML('beforeend', '<span>1024</span>');
    feedback('操作成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('仅明确状态变化仍不发送', async () => {
    const { sink } = setup(); click(); state(true); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('真实回答一键流程：无弹窗/无toast，明确aria收藏→已收藏稳定后发送一次', async () => {
    const { sink, detector } = setup(); click(); toolbarFavorited(); await flush(500);
    expect(sink).not.toHaveBeenCalled(); expect(detector.getStatus().code).toBe('direct_pending');
    await flush(400); expect(sink).toHaveBeenCalledExactlyOnceWith({ url: pageHref, title: document.title });
    await flush(1000); expect(sink).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('一键流程稳定前回滚、失败均不发送', async () => {
    const { sink } = setup(); click(); toolbarFavorited(); await flush(300); state(false); await flush(1000);
    expect(sink).not.toHaveBeenCalled(); toolbarFavorited(); feedback('收藏失败'); await flush(1000);
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('一键流程期间弹窗出现不能继续按直接收藏确认', async () => {
    const { sink } = setup(); click(); toolbarFavorited(); await flush(300); favoriteList(['已收藏']); await flush(1000);
    expect(sink).not.toHaveBeenCalled();
  });
  it('一键确认前导航或禁用会清理稳定计时器', async () => {
    const { sink, detector } = setup(); click(); toolbarFavorited(); await flush(300);
    pageHref = 'https://zhuanlan.zhihu.com/p/999'; await flush(1000); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    state(false); click(); toolbarFavorited(); await flush(300); detector.setEnabled(false); await flush(1000);
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('一键初态必须是明确aria收藏，单独文字/title、计数或高亮不适用', async () => {
    const button = document.querySelector('button')!; button.removeAttribute('aria-label');
    const { sink } = setup(); click(); toolbarFavorited(); await flush(1000); expect(sink).not.toHaveBeenCalled();
  });
  it('一键稳定期间再发生按钮属性变化，需要重新完整复核', async () => {
    const { sink } = setup(); click(); toolbarFavorited(); await flush(500);
    document.querySelector('button')!.setAttribute('aria-label', '收藏');
    document.querySelector('button')!.setAttribute('aria-label', '已收藏');
    await flush(500); expect(sink).not.toHaveBeenCalled(); await flush(400); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('仅精确成功反馈没有已收藏状态不发送', async () => {
    const { sink } = setup(); click(); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['收藏成功', '已成功收藏', '已添加到收藏夹'])('明确 false→true 与新 %s 共同产生唯一最小事件', async value => {
    const { sink } = setup(); click(); state(true); feedback(value); await flush(); feedback('收藏成功'); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: pageHref, title: '测试标题' }); expect(vi.getTimerCount()).toBe(0);
  });
  it('精确成功反馈先于终态也需要等明确终态', async () => {
    const { sink } = setup(); click(); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
    state(true); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it.each(['已收藏', '收藏夹更新成功', '操作成功', '添加至收藏夹成功', '这篇文章收藏成功了'])('含糊或非精确反馈 %s 不发送', async value => {
    const { sink } = setup(); click(); state(true); feedback(value); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['', '收藏 1024', '喜欢'])('未知初态 %s 不建立候选，即使 aria-pressed=false', async label => {
    document.querySelector('button')!.outerHTML = `<button class="ContentItem-action" aria-pressed="false">${label}</button>`;
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['aria-label', 'title', 'text'])('明确 %s 收藏可建立未收藏初态', async field => {
    const button = document.querySelector('button')!; button.removeAttribute('aria-label'); button.textContent = '';
    if (field === 'text') button.textContent = '收藏'; else button.setAttribute(field, '收藏');
    const { sink } = setup(); click(); button.setAttribute('aria-pressed', 'true'); feedback('收藏成功'); await flush();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('初态已收藏优先于残留收藏文案，取消收藏不新增记录', async () => {
    document.querySelector('button')!.setAttribute('aria-pressed', 'true');
    const { sink } = setup(); click(); state(false); feedback('取消收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('aria-pressed=true 与新成功反馈可作为终态，泛 active 不行', async () => {
    const { sink } = setup(); click(); document.querySelector('button')!.classList.add('active'); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); document.querySelector('button')!.setAttribute('aria-pressed', 'true'); await flush();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('文章容器以外的收藏按钮不能归属当前文章', async () => {
    document.body.innerHTML = '<article class="Post-Main"></article><div class="ContentItem-actions"><button class="ContentItem-action" aria-label="收藏">收藏</button></div>';
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('多个文章容器的页面拒绝猜测归属', async () => {
    document.body.insertAdjacentHTML('beforeend', '<article class="Post-Main">其他文章</article>');
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('回答详情只接受匹配问题和回答 permalink 的当前 AnswerItem', async () => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456'; document.body.innerHTML = answer();
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: pageHref, title: document.title });
  });
  it('用户报告的长数字回答：只有meta显式地址也可确认归属和无toast双状态', async () => {
    pageHref = 'https://www.zhihu.com/question/2073083082199011507/answer/2096980414967694847';
    document.body.innerHTML = `<div class="AnswerItem"><meta itemprop="url" content="${pageHref}"><div class="ContentItem-time">昨天发布</div><div class="ContentItem-actions"><button class="ContentItem-action" aria-label="收藏">收藏</button></div></div>`;
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: pageHref, title: document.title });
  });
  it.each(['https://www.zhihu.com/question/123/answer/999', 'https://www.zhihu.com/question/999/answer/456', 'https://example.com/question/123/answer/456'])('meta地址%s不属于当前回答时拒绝归属', async permalink => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456';
    document.body.innerHTML = answer().replace(/<a class="ContentItem-time"[^>]*>[^<]*<\/a>/, `<meta itemprop="url" content="${permalink}">`);
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each([['999', '123'], ['456', '999']])('回答 %s / 问题 %s 不匹配时拒绝归属', async (id, questionId) => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456'; document.body.innerHTML = answer(id, questionId);
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('只有正文中的目标回答链接不能当作当前回答 permalink', async () => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456';
    document.body.innerHTML = '<div class="AnswerItem"><div class="RichContent-inner"><a href="https://www.zhihu.com/question/123/answer/456">参考答案</a></div><div class="ContentItem-actions"><button class="ContentItem-action" aria-label="收藏">收藏</button></div></div>';
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('同一 AnswerItem 重复 permalink 可接受', async () => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456';
    document.body.innerHTML = answer('456', '123', '<a itemprop="url" href="https://www.zhihu.com/question/123/answer/456">回答入口</a>');
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('多个匹配 AnswerItem 必须拒绝', async () => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456'; document.body.innerHTML = answer() + answer();
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('当前回答旁的其他答案按钮不能触发当前回答记录', async () => {
    pageHref = 'https://www.zhihu.com/question/123/answer/456'; document.body.innerHTML = answer('999') + answer();
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('已打开收藏夹弹窗后还需可信确认与之后的新反馈', async () => {
    const { sink } = setup(); click(); dialog(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); click('#confirm'); await flush(); expect(sink).not.toHaveBeenCalled();
    feedback('已成功收藏'); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('非可信弹窗确认不能消费成功反馈', async () => {
    const { sink } = setup({ isTrustedClick: event => !(event.target as Element).matches('#confirm') });
    click(); dialog(); click('#confirm'); state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['#cancel', '#close'])('点击 %s 后晚到成功不会记录，且清除全部计时器', async selector => {
    const { sink } = setup(); click(); dialog(); click(selector); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('Escape 后晚到成功不会记录', async () => {
    const { sink } = setup(); click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('弹窗未经确认消失会清除候选', async () => {
    const { sink } = setup(); click(); dialog(); await flush(); document.querySelector('[role="dialog"]')!.remove(); await flush();
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('同一批 DOM 变更内弹窗打开即关闭也不能绕过可信确认', async () => {
    const { sink } = setup(); click(); dialog(); document.querySelector('[role="dialog"]')!.remove();
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('确认后正常关闭弹窗仍可接受新成功反馈', async () => {
    const { sink } = setup(); click(); dialog(); click('#confirm'); document.querySelector('[role="dialog"]')!.remove();
    state(true); feedback('收藏成功'); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('真实观察形态：无 role 与 toast 的收藏夹中，同一可信行与 toolbar 双状态成功', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: pageHref, title: document.title }); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['text', 'title', 'aria-pressed'])('回答工具栏仅%s明确已收藏而无aria-label时，同行成功仍可确认', async field => {
    pageHref = 'https://www.zhihu.com/question/2073083082199011507/answer/2096980414967694847';
    document.body.innerHTML = answer('2096980414967694847', '2073083082199011507');
    const button = document.querySelector('.ContentItem-action')!; button.removeAttribute('aria-label');
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited();
    if (field === 'text') button.textContent = '已收藏';
    if (field === 'title') { button.textContent = '1024'; button.setAttribute('title', '已收藏'); }
    if (field === 'aria-pressed') { button.textContent = '1024'; button.setAttribute('aria-pressed', 'true'); }
    await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('只读状态能区分归属不明、候选、确认行、超时和取消，空闲查询不扫描', async () => {
    const { detector } = setup(); const query = vi.spyOn(document, 'querySelectorAll');
    expect(detector.getStatus().code).toBe('ready'); expect(query).not.toHaveBeenCalled();
    click(); expect(detector.getStatus().code).toBe('candidate'); favoriteList(); await flush();
    expect(detector.getStatus().code).toBe('selecting'); click('#row-0'); expect(detector.getStatus().code).toBe('row_pending');
    await flush(15_100); expect(detector.getStatus().code).toBe('timeout');
    document.querySelector('.Modal-content')!.remove(); click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(detector.getStatus().code).toBe('cancelled');
    document.body.insertAdjacentHTML('beforeend', '<article class="Post-Main"></article>'); click(); expect(detector.getStatus().code).toBe('owner_unmatched');
  });
  it('已确认后空闲SPA切页，状态不能继续指向旧页成功', async () => {
    const { detector } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    expect(detector.getStatus().code).toBe('confirmed');
    pageHref = 'https://zhuanlan.zhihu.com/p/999'; expect(detector.getStatus().code).toBe('navigation');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('无 toast 时只有 toolbar 乐观变化不发送', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('无 toast 时只有行成功不发送，等待 toolbar 明确已收藏', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
    toolbarFavorited(); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('无可信行点击，即使两处变已收藏也不发送', async () => {
    const { sink } = setup(); click(); favoriteList(); rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('非可信行点击不能确认无 toast 的双状态', async () => {
    const { sink } = setup({ isTrustedClick: event => !(event.target as Element).matches('.Favlists-updateButton') });
    click(); favoriteList(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('只可信点击行或改变 CSS 颜色不能确认收藏', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0');
    document.querySelector('#row-0')!.className = 'Favlists-updateButton Button--primary Button--grey'; toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('其他原本已收藏的行不能与 toolbar 拼接为成功', async () => {
    const { sink } = setup(); click(); favoriteList(['收藏', '已收藏']); click('#row-0'); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
    rowFavorited(); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('初始已收藏 toolbar 只打开收藏夹不会新增', async () => {
    toolbarFavorited(); const { sink } = setup(); click(); favoriteList(['收藏', '已收藏']); click('#row-0'); rowFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('点击原本已收藏行表示移除并清候选', async () => {
    const { sink } = setup(); click(); favoriteList(['已收藏']); click('#row-0'); toolbarFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('同一行成功后又点击移除，晚到 toolbar 不创建记录', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); rowFavorited(); await flush(); click('#row-0'); toolbarFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('无 role 收藏夹关闭后晚到双状态与 toast 均无效', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); click('.Modal-closeButton'); rowFavorited(); toolbarFavorited(); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('无 role 收藏夹 Escape 取消后双状态无效', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('多个可见收藏夹容器拒绝行关联', async () => {
    const { sink } = setup(); click(); favoriteList(); favoriteList(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('另一个无关收藏弹窗可见时拒绝猜测行所属容器', async () => {
    const { sink } = setup(); click(); favoriteList(); dialog(); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('行不在明确收藏夹列表结构内不能关联', async () => {
    const { sink } = setup(); click(); favoriteList(); document.querySelector('.Favlists-item')!.parentElement!.removeAttribute('role');
    click('#row-0'); rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('可信点击行被移除后旧 detached Element 变已收藏也不能确认', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); const row = document.querySelector('#row-0')!; row.remove(); row.textContent = '已收藏';
    toolbarFavorited(); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('同一收藏夹行内 React 替换唯一按钮后仍可确认双状态', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); document.querySelector('#row-0')!.outerHTML = '<button id="row-0" class="Favlists-updateButton">已收藏</button>';
    toolbarFavorited(); await flush(); expect(sink).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('替换整个收藏夹行即使ID相同也不能关联；重复按钮也拒绝猜测', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0');
    document.querySelector('.Favlists-item')!.outerHTML = '<div class="Favlists-item"><button id="row-0" class="Favlists-updateButton">已收藏</button></div>';
    toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
    document.querySelector('.Modal-content')!.remove(); state(false); click(); favoriteList(); click('#row-0');
    document.querySelector('#row-0')!.outerHTML = '<button class="Favlists-updateButton">已收藏</button><button class="Favlists-updateButton">已收藏</button>';
    toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('挑选收藏夹超过15秒仍可操作，行确认后有独立完整响应窗口', async () => {
    const { sink } = setup(); click(); favoriteList(); await flush(30_000);
    click('#row-0'); await flush(14_000); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('选择窗口及确认后的响应窗口都有上限，超时后的双状态无效', async () => {
    const { sink } = setup({ selectionTimeoutMs: 500, candidateTimeoutMs: 300 });
    click(); favoriteList(); await flush(600); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    document.querySelector('.Modal-content')!.remove(); state(false); click(); favoriteList(); click('#row-0'); await flush(400);
    rowFavorited(); toolbarFavorited(); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('请求期间工具栏暂时禁用不会抹掉已确认行，单独禁用也不算成功', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0');
    document.querySelector('.ContentItem-action')!.setAttribute('disabled', ''); await flush(); expect(sink).not.toHaveBeenCalled();
    document.querySelector('.ContentItem-action')!.removeAttribute('disabled'); rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).toHaveBeenCalledTimes(1);
  });
  it('导航后晚到双状态无效', async () => {
    const { sink } = setup(); click(); favoriteList(); click('#row-0'); pageHref = 'https://zhuanlan.zhihu.com/p/999'; rowFavorited(); toolbarFavorited(); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('多个收藏夹行连续成功也仅消费当前候选一次', async () => {
    const { sink } = setup(); click(); favoriteList(['收藏', '收藏']); click('#row-0'); rowFavorited(); toolbarFavorited(); await flush();
    click('#row-1'); rowFavorited(1); feedback('收藏成功'); await flush(); expect(sink).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('乐观终态后的延迟失败会清候选，晚到成功也无效', async () => {
    const { sink } = setup(); click(); state(true); await flush(300); feedback('收藏失败，请重试'); await flush();
    feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('同一批次失败优先于成功反馈与状态', async () => {
    const { sink } = setup(); click(); state(true); feedback('收藏成功'); feedback('网络请求失败'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('同一批 DOM 变更内出现后移除的失败提示仍使晚到成功无效', async () => {
    const { sink } = setup(); click(); const failure = feedback('收藏失败'); failure.remove(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['请先登录', '取消收藏成功', '操作失败'])('新 %s 反馈清除候选', async value => {
    const { sink } = setup(); click(); feedback(value); await flush(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('登录弹窗清除候选', async () => {
    const { sink } = setup(); click(); document.body.insertAdjacentHTML('beforeend', '<div class="SignFlow">登录</div>'); await flush();
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('旧的可见或隐藏成功提示都不能消费', async () => {
    feedback('收藏成功'); const hidden = feedback('已添加到收藏夹'); hidden.hidden = true;
    const { sink } = setup(); click(); state(true); hidden.hidden = false; await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('复用旧 toast 但文本发生新的成功变更可确认', async () => {
    const toast = feedback('操作成功'); const { sink } = setup(); click(); state(true); toast.textContent = '收藏成功'; await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('无 DOM 变化的 SPA 导航也会在候选计时器中清除', async () => {
    const { sink } = setup(); click(); pageHref = 'https://zhuanlan.zhihu.com/p/999'; await flush(250);
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('在首个检查前导航也不允许成功', async () => {
    const { sink } = setup(); click(); pageHref = 'https://www.zhihu.com/question/123/answer/456'; state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('未支持页面不建立候选', async () => {
    pageHref = 'https://www.zhihu.com/question/123'; const { sink } = setup(); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('候选期间按钮移除或失去唯一归属即停止', async () => {
    const { sink } = setup(); click(); document.body.insertAdjacentHTML('beforeend', '<article class="Post-Main">另一个</article>');
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('禁用按钮和确认按钮不能建立或确认候选', async () => {
    const { sink } = setup(); document.querySelector('button')!.setAttribute('disabled', ''); click(); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    document.querySelector('button')!.removeAttribute('disabled'); state(false); click(); dialog(); document.querySelector('#confirm')!.setAttribute('aria-disabled', 'true');
    click('#confirm'); state(true); feedback('已成功收藏'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('候选超时释放观察器及计时器，晚到状态和成功无效', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const { sink } = setup({ candidateTimeoutMs: 500 }); click(); await flush(600); state(true); feedback('收藏成功'); await flush();
    expect(sink).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('禁用清候选，重新启用后必须重新可信点击', async () => {
    const { detector, sink } = setup(); click(); detector.setEnabled(false); state(true); feedback('收藏成功'); await flush();
    detector.setEnabled(true); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    state(false); click(); state(true); feedback('已成功收藏'); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('dispose 清理候选、观察器、所有计时器及监听器', async () => {
    const { detector, sink } = setup(); click(); detector.dispose(); detector.dispose(); state(true); feedback('收藏成功'); await flush();
    state(false); click(); state(true); feedback('已成功收藏'); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('异步保存失败交由 onError 处理', async () => {
    const onError = vi.fn(); const error = new Error('保存失败');
    setup({ onFavorite: async () => { throw error; }, onError }); click(); state(true); feedback('收藏成功'); await flush(); expect(onError).toHaveBeenCalledWith(error);
  });
});
