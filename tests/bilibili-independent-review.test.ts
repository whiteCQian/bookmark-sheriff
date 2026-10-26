// @vitest-environment-options {"url":"https://www.bilibili.com/video/BV1xx411c7mD/"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBilibiliFavoriteDetector } from '../src/detectors/bilibili-favorite';

let detector: ReturnType<typeof createBilibiliFavoriteDetector> | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/video/BV1xx411c7mD/');
  document.body.innerHTML = '<div class="video-fav" title="收藏（E）"></div>';
});
afterEach(() => { detector?.dispose(); detector = undefined; vi.useRealTimers(); });

function click(selector: string) { document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true })); }
function begin(closeDialog = true) {
  const sink = vi.fn();
  detector = createBilibiliFavoriteDetector({ document, window, onFavorite: sink, isTrustedClick: () => true });
  click('.video-fav');
  document.body.insertAdjacentHTML('beforeend', '<div class="bili-dialog-bomb"><div class="collection-m-exp">添加到收藏夹<label><input type="checkbox" checked>默认收藏夹</label><button class="btn submit-move">确定</button></div></div>');
  click('.submit-move');
  if (closeDialog) document.querySelector('.bili-dialog-bomb')!.remove();
  return sink;
}
async function flush(ms: number) { await Promise.resolve(); await vi.advanceTimersByTimeAsync(ms); }

it.each(['active', 'is-active'])('原生提交后任意 %s 高亮不能代替实际观察到的 on 成功态', async className => {
  const sink = begin();
  document.querySelector('.video-fav')!.classList.add(className);
  await flush(650);
  expect(sink).not.toHaveBeenCalled();
});

it('原生提交观察到状态回滚后，必须重新确认才能接受后续 on', async () => {
  const sink = begin();
  const button = document.querySelector('.video-fav')!;
  button.classList.add('on'); await flush(150);
  button.classList.remove('on'); await flush(150);
  button.classList.add('on'); await flush(650);
  expect(sink).not.toHaveBeenCalled();
});

it('原生弹窗节点替换而新收藏弹窗仍可见时，不能当作弹窗已经关闭', async () => {
  const sink = begin(false);
  const native = document.querySelector('.collection-m-exp')!;
  native.replaceWith(native.cloneNode(true));
  document.querySelector('.video-fav')!.classList.add('on');
  await flush(650);
  expect(document.querySelector('.collection-m-exp')).not.toBeNull();
  expect(sink).not.toHaveBeenCalled();
});
