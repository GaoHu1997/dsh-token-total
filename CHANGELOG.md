# Changelog

本文件记录 `dsh-token-total` 每个版本的升级说明。完整差异见各版本间的 GitHub Compare 链接。

## 1.1.6 (2026-11-08)

[Full Changelog](https://github.com/GaoHu1997/dsh-token-total/compare/v1.1.5...v1.1.6)

### 更新内容 / What's New

- **单会话统计缓存重构 / Per-root session-usage cache**：完整会话树统计改用 64 项 LRU 缓存，60 秒到期且命中不续期，替代原先「任意新事件清空全部缓存」的策略，未受影响的会话树可以继续命中缓存。/ Complete session-tree statistics now use a 64-entry LRU cache with a non-renewing 60-second TTL, replacing the previous clear-everything-on-any-event strategy, so untouched trees keep serving cache hits.
- **精确缓存失效 / Precise invalidation**：新事件只失效发生变化的会话及其已知祖先链，并支持尚未出现在持久化目录中的子／孙会话；父链信息不足时保守失效，避免漏算。慢的目录读取不会撤销更新的目录或事件提示。/ New events invalidate only the changed session and its known ancestors, including children not yet in the persistence catalog; missing parent metadata falls back conservatively. Slow catalog reads never undo newer catalogs or event hints.
- **并发读取去重 / Concurrent read deduplication**：同一会话树、同一数据源的无信号请求共用一次计算；显式取消信号保持独立所有权，中止一个调用方不会影响其他调用方。失败、取消或不完整的计算均不缓存，后续请求可重试。/ Signal-less requests for the same tree and source share one computation; explicit abort signals keep independent ownership. Failed, cancelled or incomplete computations are never cached and can be retried.
- **前端轮询重构 / Client polling rework**：轮询改为每次请求完成后等待 4 秒再发起（慢请求不再堆积定时重试）；页面隐藏时暂停轮询、恢复可见时立即刷新；切换或卸载会话时取消进行中的请求并丢弃迟到的旧响应；相同结果不重复写入 React 状态。/ Polling now waits 4 seconds after each response instead of a fixed interval, pauses on hidden pages and refetches on visibility, aborts in-flight requests on session switch/unmount while dropping late answers, and skips identical React state writes.
- **旧宿主兼容 / Legacy host fallback**：没有事件订阅接口的旧版宿主自动回退为每 4 秒重新校验，不会显示过期总量。/ Hosts without a live event hook fall back to four-second revalidation instead of stale live totals.

### 安装 / Installation

```bash
dsh plugin --profile web add dsh-token-total@1.1.6
```

### 兼容性 / Compatibility

| 插件版本 | DSH 版本 |
|---|---|
| 1.1.6 | ≥ 0.28.2 |

## 1.1.5 (2026-11-06)

[Full Changelog](https://github.com/GaoHu1997/dsh-token-total/compare/v1.1.4...v1.1.5)

- **子代理真实名称识别旧记录 / Real subagent names for legacy CLI logs**：旧版 CLI 记录的子会话自身没有标题时，从实际父会话的 `subagent/catalog` 任务标签中找回名称，面板上的子代理明细与请求记录不再显示一串会话 ID。
- **名称取最新标题 / Latest-title resolution**：会话标题变更后使用最新一条非空标题，而不是首次出现的标题。
- **只读解析 / Read-only resolution**：名称解析只读取各日志的自有事件，不改写历史日志，也不影响 Token 统计。
