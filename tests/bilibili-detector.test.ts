// @vitest-environment-options {"url":"https://www.bilibili.com/video/BV1xx411c7mD/"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBilibiliFavoriteDetector } from '../src/detectors/bilibili-favorite';

let detectors: ReturnType<typeof createBilibiliFavoriteDetector>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/video/BV1xx411c7mD/');
  document.title = '测试视频';
  document.body.innerHTML = '<div class="video-fav" title="收藏（E）"><span class="video-fav-info">100</span></div>';
});
afterEach(() => { detectors.forEach(detector => detector.dispose()); detectors = []; vi.useRealTimers(); });

function setup(overrides: Partial<Parameters<typeof createBilibiliFavoriteDetector>[0]> = {}) {
  const sink = vi.fn();
  const detector = createBilibiliFavoriteDetector({ document, window, onFavorite: sink, isTrustedClick: () => true, ...overrides });
  detectors.push(detector);
  return { detector, sink };
}
function click(selector = '.video-fav') { document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); }
function state(value: boolean) { document.querySelector('.video-fav')!.classList.toggle('on', value); }
function feedback(value: string) { const toast = document.createElement('div'); toast.className = 'bili-toast'; toast.textContent = value; document.body.append(toast); }
function dialog() { document.body.insertAdjacentHTML('beforeend', '<div role="dialog">添加到收藏夹<button id="confirm">确定</button><button id="cancel">取消</button><button id="close" aria-label="关闭"></button></div>'); }
function confirmSuccess(value = '收藏成功') { dialog(); click('#confirm'); feedback(value); }
function nativeDialog(checked = true) {
  document.body.insertAdjacentHTML('beforeend', `<div class="bili-dialog-bomb"><div class="collection-m-exp"><div class="title">添加到收藏夹<i class="close" id="native-close"></i></div><div class="content"><div class="group-list"><label><input type="checkbox" ${checked ? 'checked' : ''}>默认收藏夹</label></div></div><div class="bottom"><button class="btn submit-move" id="native-confirm">确定</button></div></div></div>`);
}
function finishNative() { state(true); document.querySelector('.bili-dialog-bomb')!.remove(); }
async function flush(ms = 100) { await Promise.resolve(); await vi.advanceTimersByTimeAsync(ms); }

describe('B站收藏检测：DOM 模拟规则测试，不能代替登录后的真实收藏验收', () => {
  it('真实collection-m-exp选中确认、弹窗关闭且收藏状态成立，不需要额外toast', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-confirm'); finishNative();
    await flush(100); expect(sink).not.toHaveBeenCalled();
    await flush(450); expect(sink).toHaveBeenCalledExactlyOnceWith({ url: location.href, title: '测试视频' });
    feedback('收藏成功'); await flush(); expect(sink).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('只确认、只关闭或只高亮，缺少任一成功证据均不新增', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-confirm'); state(true);
    await flush(700); expect(sink).not.toHaveBeenCalled();
    state(false); document.querySelector('.bili-dialog-bomb')!.remove();
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生弹窗没有正向选中不能根据关闭+高亮新增', async () => {
    const { sink } = setup(); click(); nativeDialog(false); click('#native-confirm'); finishNative();
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生无toast路径只接受实测submit-move确定按钮，不接受通用保存按钮', async () => {
    const { sink } = setup(); click(); nativeDialog();
    const button = document.querySelector('#native-confirm')!; button.className = ''; button.textContent = '保存';
    click('#native-confirm'); finishNative(); await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生弹窗关闭按钮和Escape不会被当作提交成功', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-close'); finishNative();
    await flush(700); expect(sink).not.toHaveBeenCalled();
    state(false); click(); nativeDialog(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); finishNative();
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生提交后的延迟失败或状态回滚撤销候选', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-confirm'); finishNative();
    await flush(150); feedback('收藏失败，请稍后重试');
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生提交观察期间状态回滚不会保存', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-confirm'); finishNative();
    await flush(150); state(false); await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('选收藏夹超过初始窗口后，可信原生确认仍可重新核验并保存', async () => {
    const { sink } = setup({ candidateTimeoutMs: 300 }); click(); nativeDialog(); await flush(500);
    expect(vi.getTimerCount()).toBe(0);
    click('#native-confirm'); finishNative(); await flush(650);
    // A custom timeout shorter than the settling window still expires conservatively.
    expect(sink).not.toHaveBeenCalled();
  });
  it('用户长时间选择后原生确认使用新的完整候选时间', async () => {
    const { sink } = setup(); click(); nativeDialog(); await flush(16_000);
    click('#native-confirm'); finishNative(); await flush(650); expect(sink).toHaveBeenCalledOnce();
  });
  it('在初始窗口将结束时确定，仍获得完整的响应核验时间', async () => {
    const { sink } = setup(); click(); nativeDialog(); await flush(14_900);
    click('#native-confirm'); finishNative(); await flush(650); expect(sink).toHaveBeenCalledOnce();
  });
  it('隐藏的旧成功提示被显示，不作为本次成功证据', async () => {
    feedback('收藏成功'); const toast = document.querySelector('.bili-toast') as HTMLElement; toast.hidden = true;
    const { sink } = setup(); click(); dialog(); click('#confirm'); toast.hidden = false;
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('短暂出现又移除的失败反馈优先于原生成功状态', async () => {
    const { sink } = setup(); click(); nativeDialog(); click('#native-confirm'); finishNative();
    feedback('收藏失败'); document.querySelector('.bili-toast')!.remove();
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('原生确认期间导航/禁用会取消迟到的成功', async () => {
    const { sink, detector } = setup(); click(); nativeDialog(); click('#native-confirm'); finishNative();
    await flush(150); history.pushState({}, '', '/video/BV1ex411x7Em/'); detector.checkLocation();
    await flush(700); expect(sink).not.toHaveBeenCalled();
  });
  it('真实点击不足以确认，收藏人数变化也不会发送', async () => {
    const { sink } = setup(); click();
    document.querySelector('.video-fav-info')!.textContent = '101';
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('生产默认忽略非可信合成点击', async () => {
    const { sink } = setup({ isTrustedClick: undefined });
    click(); state(true); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('确认后的新明确成功提示只发送一次，并保留当前分集入口', async () => {
    history.replaceState({}, '', '?p=2');
    const { sink } = setup(); click(); state(true); await flush();
    expect(sink).not.toHaveBeenCalled();
    confirmSuccess(); await flush(); feedback('已成功收藏'); await flush();
    expect(sink).toHaveBeenCalledExactlyOnceWith({ url: location.href, title: '测试视频' });
  });
  it.each(['on', 'active', 'is-active'])('仅 %s 状态变化不能证明收藏成功', async name => {
    const { sink } = setup(); click();
    document.querySelector('.video-fav')!.classList.add(name);
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('仅 aria-pressed 状态变化不能证明收藏成功', async () => {
    const { sink } = setup(); document.querySelector('.video-fav')!.setAttribute('aria-pressed', 'false');
    click(); document.querySelector('.video-fav')!.setAttribute('aria-pressed', 'true');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('确认后的乐观状态先变更、延迟请求失败不产生记录', async () => {
    const { sink } = setup(); click(); dialog(); click('#confirm'); state(true);
    await flush(500); expect(sink).not.toHaveBeenCalled();
    feedback('收藏失败，请稍后重试'); await flush();
    feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('已收藏页面与移除收藏不会创建记录', async () => {
    state(true); const { sink } = setup(); click(); state(false); await flush();
    feedback('取消收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('取消弹窗后晚到的状态变化不会发送', async () => {
    const { sink } = setup(); click(); dialog(); click('#cancel'); state(true); feedback('收藏成功');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('Escape 取消后晚到的成功不会发送', async () => {
    const { sink } = setup(); click(); dialog();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('关闭按钮会清除候选，晚到成功也不保存', async () => {
    const { sink } = setup(); click(); dialog(); click('#close'); feedback('已添加到收藏夹');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('收藏夹弹窗未经确认关闭会清除候选', async () => {
    const { sink } = setup(); click(); dialog(); await flush();
    document.querySelector('[role="dialog"]')!.remove(); await flush();
    state(true); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('失败反馈优先于同一批次的正向状态变化', async () => {
    const { sink } = setup(); click(); dialog(); click('#confirm'); state(true); feedback('收藏成功'); feedback('收藏失败，请稍后重试');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('登录失败或要求登录会清除候选', async () => {
    const { sink } = setup(); click(); feedback('请先登录'); await flush(); state(true);
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('登录弹窗会清除候选', async () => {
    const { sink } = setup(); click(); document.body.insertAdjacentHTML('beforeend', '<div class="bili-mini-login">登录</div>');
    await flush(); state(true); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('候选超时后不会消费晚到的成功', async () => {
    const { sink } = setup({ candidateTimeoutMs: 500 }); click(); dialog(); click('#confirm'); await flush(600); state(true); feedback('收藏成功');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['/video/BV1ex411x7Em/', '/video/BV1xx411c7mD/?p=2'])('SPA 导航到 %s 清除候选', async next => {
    const { sink } = setup(); click(); dialog(); click('#confirm'); history.pushState({}, '', next); await flush(250); state(true); feedback('收藏成功');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('跟踪参数改变不误认为视频或分集切换', async () => {
    const { sink } = setup(); click(); history.pushState({}, '', '?spm_id_from=test'); state(true); confirmSuccess();
    await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('仅明确成功提示但没有确认操作仍不发送', async () => {
    const { sink } = setup(); click(); feedback('收藏成功'); await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it.each(['收藏成功', '已成功收藏', '已添加到收藏夹'])('收藏夹确认后的新明确提示 %s 可以确认收藏', async value => {
    const { sink } = setup(); click(); confirmSuccess(value);
    await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it.each(['已收藏', '收藏夹更新成功', '操作成功', '添加至收藏夹成功'])('确认后含糊提示 %s 不被当作新增收藏成功', async value => {
    const { sink } = setup(); click(); confirmSuccess(value);
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('确认动作不消费旧成功提示或无关的操作成功', async () => {
    feedback('收藏成功'); const { sink } = setup(); click(); dialog(); click('#confirm'); feedback('操作成功');
    await flush(); expect(sink).not.toHaveBeenCalled();
  });
  it('禁用会清候选，重新启用后必须重新点击', async () => {
    const { sink, detector } = setup(); click(); detector.setEnabled(false); state(true); await flush();
    detector.setEnabled(true); state(false); await flush(); state(true); await flush(); expect(sink).not.toHaveBeenCalled();
    state(false); click(); state(true); confirmSuccess(); await flush(); expect(sink).toHaveBeenCalledTimes(1);
  });
  it('移除后稍后重新添加可以产生新事件，由存储层去重', async () => {
    const { sink } = setup(); click(); state(true); confirmSuccess(); await flush();
    document.querySelector('[role="dialog"]')!.remove();
    state(false); await flush(); click(); state(true); confirmSuccess(); await flush(); expect(sink).toHaveBeenCalledTimes(2);
  });
  it('dispose 清理监听器、观察器和所有活动计时器', async () => {
    const { sink, detector } = setup(); click(); detector.dispose(); state(true); await flush();
    state(false); click(); state(true); await flush(); expect(sink).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('异步保存失败由 onError 接收，不产生未处理拒绝', async () => {
    const onError = vi.fn(); const error = new Error('扩展已更新');
    setup({ onFavorite: async () => { throw error; }, onError }); click(); state(true); confirmSuccess(); await flush();
    expect(onError).toHaveBeenCalledWith(error);
  });
  it('空闲时不启动观察器计时器', () => { setup(); expect(vi.getTimerCount()).toBe(0); });
});
