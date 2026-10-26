import { useEffect, useState } from 'react';
import { ZHIHU_STATUS_LABELS, X_STATUS_LABELS, type ZhihuStatusCode, type XStatusCode, type CurrentCaptureStatus as Status } from '../models/capture-status';
import { request } from '../ui/api';

export function CurrentCaptureStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let active = true;
    void request<Status | null>({ type: 'GET_CURRENT_CAPTURE_STATUS' }).then(value => { if (active) setStatus(value); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (!status?.version) return null;
  const site = status.site === 'x' ? 'X' : '知乎';
  const code = status.page?.code;
  const stage = status.site === 'x'
    ? code && Object.hasOwn(X_STATUS_LABELS, code) ? X_STATUS_LABELS[code as XStatusCode] : '当前页状态不可用'
    : code && Object.hasOwn(ZHIHU_STATUS_LABELS, code) ? ZHIHU_STATUS_LABELS[code as ZhihuStatusCode] : '当前页状态不可用';
  const detail = !status.enabled ? `${site}监听未开启，请到偏好设置启用。`
    : !status.permitted ? `缺少${site}站点权限，请到偏好设置重新授权。`
    : !status.registered ? `${site}脚本尚未注册，请重新开启${site}监听。`
    : status.connection !== 'connected' ? `当前页监听未连接，请刷新${site}页面后重试。`
    : stage;
  return <section className="popup-section" aria-label="当前页监听状态"><div className="section-heading"><h2>{site}监听状态</h2><span>{status.version}</span></div><p>{detail}</p>{status.page && <small>状态码：{status.page.code}</small>}<p><small>实验性；状态检查不会新增收藏。</small></p></section>;
}
