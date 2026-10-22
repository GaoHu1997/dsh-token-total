/**
 * Usage panel dictionaries, registered into the DSH locale service. The keys
 * mirror the reasonix stats locale block (settings.stats.*) plus the PR#7503
 * additions ("Other", 180-day trend note); values are the same Chinese and
 * English copy with the zh-TW variant transliterated.
 */

/** The locale namespace this plugin owns. */
export const LOCALE_NS = 'tokenTotal'

/** The typed translator key union for the panel's locale seat. */
export type TokenTotalKey =
  | 'nav'
  | 'back'
  | 'range'
  | 'rangePreset.today'
  | 'rangePreset.3'
  | 'rangePreset.7'
  | 'rangePreset.30'
  | 'rangePreset.90'
  | 'rangeCustom'
  | 'from'
  | 'to'
  | 'refresh'
  | 'loading'
  | 'tokens'
  | 'tokensHint'
  | 'tokensUnit'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheTokens'
  | 'cachedTokens'
  | 'sessions'
  | 'requests'
  | 'activeDays'
  | 'cacheRate'
  | 'cacheRateHint'
  | 'cacheHitRate'
  | 'hitRateLegend'
  | 'topModel'
  | 'topModelHint'
  | 'heatmap'
  | 'heatLess'
  | 'heatMore'
  | 'dailyTrend'
  | 'hourlyTrend'
  | 'trendLimited'
  | 'usageRanking'
  | 'byModel'
  | 'byProvider'
  | 'tokensColumn'
  | 'cacheRateColumn'
  | 'providerModels'
  | 'other'
  | 'total'
  | 'percent'
  | 'asOf'
  | 'empty'
  | 'stats.counts'
  | 'stats.tokensPerSecond'
  | 'stats.cacheHit'
  | 'stats.cacheMiss'
  | 'stats.dialog.title'
  | 'stats.dialog.usageTitle'
  | 'stats.dialog.llmTime'
  | 'stats.dialog.toolTime'
  | 'stats.dialog.ttft'
  | 'stats.dialog.speed'
  | 'stats.dialog.main'
  | 'stats.dialog.subagents'
  | 'stats.dialog.subagentCount'
  | 'stats.dialog.treeTotal'
  | 'message.turnUsage.count'
  | 'message.turnUsage.cacheHit'
  | 'message.turnUsage.input'
  | 'message.turnUsage.cacheRead'
  | 'message.turnUsage.cacheWrite'
  | 'message.turnUsage.output'

export const en: Record<TokenTotalKey, string> = {
  nav: 'Usage statistics',
  back: 'Back',
  range: 'Time range',
  'rangePreset.today': 'Today',
  'rangePreset.3': 'Last 3 days',
  'rangePreset.7': 'Last 7 days',
  'rangePreset.30': 'Last 30 days',
  'rangePreset.90': 'Last 90 days',
  rangeCustom: 'Custom',
  from: 'From',
  to: 'To',
  refresh: 'Refresh',
  loading: 'Loading',
  tokens: 'Token usage',
  tokensUnit: 'tokens',
  tokensHint: 'Provider-visible total: uncached input + output + cached tokens',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheTokens: 'Cached tokens',
  cachedTokens: 'cached',
  sessions: 'Sessions',
  requests: 'Requests',
  activeDays: 'Active days',
  cacheRate: 'Avg cache hit rate',
  cacheRateHint: 'Cached input tokens as a share of all input tokens in the range',
  cacheHitRate: 'Cache hit rate',
  hitRateLegend: 'Cache hit rate',
  topModel: 'Top model',
  topModelHint: 'Ranked by token volume, not call count',
  heatmap: 'Activity heatmap',
  heatLess: 'Less',
  heatMore: 'More',
  dailyTrend: 'Daily token trend',
  hourlyTrend: 'Hourly token trend',
  trendLimited: 'Showing the latest {n} days',
  usageRanking: 'Usage ranking',
  byModel: 'By model',
  byProvider: 'By provider',
  tokensColumn: 'Tokens',
  cacheRateColumn: 'Cache hit rate',
  providerModels: '{n} models',
  other: 'Other',
  total: 'Total',
  percent: 'Share',
  asOf: 'As of',
  empty: 'No usage data in this time range yet. Token usage is recorded from the day the panel is installed, including a one-time scan of your existing sessions.',
  'stats.counts': '{turns} turns · {steps} steps',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': 'Cache hit {percent}%',
  'stats.cacheMiss': 'Cache miss',
  'stats.dialog.title': 'Time & speed',
  'stats.dialog.usageTitle': 'Token usage',
  'stats.dialog.llmTime': 'LLM time',
  'stats.dialog.toolTime': 'Tool time',
  'stats.dialog.ttft': 'Mean TTFT',
  'stats.dialog.speed': 'Decode speed',
  'stats.dialog.main': 'Main agent',
  'stats.dialog.subagents': 'Subagents',
  'stats.dialog.subagentCount': '{count} subagent session(s)',
  'stats.dialog.treeTotal': 'Session total (main + subagents)',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': 'Cache hit',
  'message.turnUsage.input': 'Input',
  'message.turnUsage.cacheRead': 'Cache read',
  'message.turnUsage.cacheWrite': 'Cache write',
  'message.turnUsage.output': 'Output',
}

export const zh: Record<TokenTotalKey, string> = {
  nav: '使用统计',
  back: '返回',
  range: '时间范围',
  'rangePreset.today': '今日',
  'rangePreset.3': '近 3 天',
  'rangePreset.7': '近 7 天',
  'rangePreset.30': '近 1 月',
  'rangePreset.90': '近 3 月',
  rangeCustom: '自定义',
  from: '开始日期',
  to: '结束日期',
  refresh: '刷新',
  loading: '加载中',
  tokens: '总 Tokens',
  tokensUnit: 'tokens',
  tokensHint: '服务商总口径：未缓存输入 + 输出 + 缓存命中 token',
  inputTokens: '输入 Tokens',
  outputTokens: '输出 Tokens',
  cacheTokens: '缓存 Tokens',
  cachedTokens: '缓存命中',
  sessions: '会话数量',
  requests: '请求数量',
  activeDays: '活跃天数',
  cacheRate: '缓存命中率',
  cacheRateHint: '时间段内缓存命中 token 占输入 token 的比例',
  cacheHitRate: '缓存命中率',
  hitRateLegend: '缓存命中率',
  topModel: '最常用模型',
  topModelHint: '按 token 用量排序，非调用次数',
  heatmap: '活跃热力图',
  heatLess: '较少',
  heatMore: '较多',
  dailyTrend: '按天 Token 趋势',
  hourlyTrend: '按小时 Token 趋势',
  trendLimited: '仅显示最近 {n} 天',
  usageRanking: '用量排行',
  byModel: '按模型',
  byProvider: '按供应商',
  tokensColumn: '总 Tokens',
  cacheRateColumn: '缓存命中率',
  providerModels: '{n} 个模型',
  other: '其他',
  total: '总用量',
  percent: '占比',
  asOf: '统计截至',
  empty: '当前时间范围内暂无用量数据。Token 用量从本面板启用后开始累计，并会一次性回扫已有的历史会话。',
  'stats.counts': '{turns} 轮 · {steps} 步',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': '缓存命中 {percent}%',
  'stats.cacheMiss': '未命中缓存',
  'stats.dialog.title': '用时与速度',
  'stats.dialog.usageTitle': 'Token 用量',
  'stats.dialog.llmTime': 'LLM 用时',
  'stats.dialog.toolTime': '工具用时',
  'stats.dialog.ttft': '首 token 平均',
  'stats.dialog.speed': '解码速度',
  'stats.dialog.main': '主智能体',
  'stats.dialog.subagents': '子智能体',
  'stats.dialog.subagentCount': '{count} 个子智能体会话',
  'stats.dialog.treeTotal': '会话合计（主智能体 + 子智能体）',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': '缓存命中',
  'message.turnUsage.input': '输入',
  'message.turnUsage.cacheRead': '缓存读取',
  'message.turnUsage.cacheWrite': '缓存写入',
  'message.turnUsage.output': '输出',
}

export const zhTW: Record<TokenTotalKey, string> = {
  nav: '使用統計',
  back: '返回',
  range: '時間範圍',
  'rangePreset.today': '今日',
  'rangePreset.3': '近 3 天',
  'rangePreset.7': '近 7 天',
  'rangePreset.30': '近 1 月',
  'rangePreset.90': '近 3 月',
  rangeCustom: '自訂',
  from: '開始日期',
  to: '結束日期',
  refresh: '重新整理',
  loading: '載入中',
  tokens: '總 Tokens',
  tokensUnit: 'tokens',
  tokensHint: '服務商總口徑：未快取輸入 + 輸出 + 快取命中 token',
  inputTokens: '輸入 Tokens',
  outputTokens: '輸出 Tokens',
  cacheTokens: '快取 Tokens',
  cachedTokens: '快取命中',
  sessions: '會話數量',
  requests: '請求數量',
  activeDays: '活躍天數',
  cacheRate: '快取命中率',
  cacheRateHint: '時間範圍內快取命中 token 佔輸入 token 的比例',
  cacheHitRate: '快取命中率',
  hitRateLegend: '快取命中率',
  topModel: '最常用模型',
  topModelHint: '依 token 用量排序，非呼叫次數',
  heatmap: '活躍熱力圖',
  heatLess: '較少',
  heatMore: '較多',
  dailyTrend: '每日 Token 趨勢',
  hourlyTrend: '每小時 Token 趨勢',
  trendLimited: '僅顯示最近 {n} 天',
  usageRanking: '用量排行',
  byModel: '按模型',
  byProvider: '按供應商',
  tokensColumn: '總 Tokens',
  cacheRateColumn: '快取命中率',
  providerModels: '{n} 個模型',
  other: '其他',
  total: '總用量',
  percent: '佔比',
  asOf: '統計截至',
  empty: '目前時間範圍內尚無用量資料。Token 用量自本面板啟用後開始累計，並會一次掃描既有的歷史會話。',
  'stats.counts': '{turns} 輪 · {steps} 步',
  'stats.tokensPerSecond': '{throughput} tok/s',
  'stats.cacheHit': '快取命中 {percent}%',
  'stats.cacheMiss': '未命中快取',
  'stats.dialog.title': '用時與速度',
  'stats.dialog.usageTitle': 'Token 用量',
  'stats.dialog.llmTime': 'LLM 用時',
  'stats.dialog.toolTime': '工具用時',
  'stats.dialog.ttft': '首 token 平均',
  'stats.dialog.speed': '解碼速度',
  'stats.dialog.main': '主智能體',
  'stats.dialog.subagents': '子智能體',
  'stats.dialog.subagentCount': '{count} 個子智能體會話',
  'stats.dialog.treeTotal': '會話合計（主智能體 + 子智能體）',
  'message.turnUsage.count': '{count} tok',
  'message.turnUsage.cacheHit': '快取命中',
  'message.turnUsage.input': '輸入',
  'message.turnUsage.cacheRead': '快取讀取',
  'message.turnUsage.cacheWrite': '快取寫入',
  'message.turnUsage.output': '輸出',
}
