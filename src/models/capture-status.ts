export const ZHIHU_STATUS_LABELS = {
  ready: '监听已连接，等待收藏操作',
  disabled: '监听已关闭或尚未获得授权',
  unmatched_button: '检测到操作，但收藏按钮形态不匹配',
  unknown_state: '收藏按钮没有明确的收藏状态',
  owner_unmatched: '无法确认按钮属于当前回答或文章',
  blocked: '登录遮罩或其他收藏弹窗阻止确认',
  candidate: '已识别收藏入口，等待网站确认',
  direct_pending: '网站已显示已收藏，正在复核状态是否稳定',
  selecting: '已打开收藏夹，等待网站确认',
  row_pending: '已操作收藏夹，等待行与工具栏成功状态',
  owner_lost: '页面控件被替换或当前内容归属发生变化',
  row_lost: '收藏夹行被移除或归属不明确',
  failure: '网站报告失败或取消收藏',
  cancelled: '收藏操作已取消或弹窗已关闭',
  navigation: '页面已切换，旧收藏候选已停止',
  timeout: '等待成功状态超时，未生成记录',
  confirmed: '已确认网站收藏成功',
  saving: '已确认成功，正在保存记录',
  saved: '记录已保存',
  save_failed: '记录保存失败',
  unconfirmed: '无法确认后台保存结果',
} as const;

export type ZhihuStatusCode = keyof typeof ZHIHU_STATUS_LABELS;
export interface ZhihuPageStatus { code: ZhihuStatusCode; at: number }

export const X_STATUS_LABELS = {
  ready: '监听已连接，等待 X 收藏操作',
  disabled: 'X 监听已关闭或尚未获得授权',
  candidate: '已识别帖子操作，等待网站成功反馈',
  confirming: '网站已反馈成功，正在复核帖子终态',
  confirmed: '已确认 X 收藏操作成功',
  ambiguous: '连续操作的反馈归属不明确，已暂停确认',
  owner_unmatched: '无法唯一确认当前操作所属帖子',
  owner_lost: '帖子或收藏控件已变化，无法继续确认',
  blocked: '登录、弹窗或禁用控件阻止确认',
  failure: 'X 报告操作失败，未生成新记录',
  cancelled: '操作已取消或撤销',
  navigation: '页面已切换，旧候选已停止',
  timeout: '等待 X 明确成功反馈超时，未生成记录',
  saving: '已确认成功，正在保存帖子记录',
  saved: '帖子记录已保存',
  removing: '正在确认取消收藏回执',
  removed: '已确认原站取消收藏，本地复盘任务保留',
  save_failed: '帖子记录处理失败',
  unconfirmed: '无法确认后台处理结果',
} as const;
export type XStatusCode = keyof typeof X_STATUS_LABELS;
export interface XPageStatus { code: XStatusCode; at: number }

export interface CurrentCaptureStatus {
  /** Omitted by legacy Zhihu callers. */
  site?: 'x' | 'zhihu';
  version: string;
  enabled: boolean;
  permitted: boolean;
  registered: boolean;
  page?: ZhihuPageStatus | XPageStatus;
  connection: 'connected' | 'missing' | 'unsupported' | 'unavailable';
}
