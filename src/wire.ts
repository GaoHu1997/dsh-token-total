/**
 * Wire contract shared by the host aggregation layer and the browser panel,
 * plus the JSON request/response helpers for the /token-total/api route handlers.
 * These types mirror the reasonix stats wire (internal/stats/query.go +
 * desktop/stats_app.go): the aggregate response the panel renders maps 1:1
 * to the panel sections (totals, derived stats, daily trend, per-model
 * split). No Node or DOM types leak into the shared declarations — the HTTP
 * helpers are host-only and import the node faces explicitly.
 */

import type { UsageHttpRequest, UsageHttpResponse } from './context-types.ts'

/** One bucket's token usage and turn count in a trend series. The `day`
 *  field is the bucket key: "YYYY-MM-DD" in day mode, "YYYY-MM-DDTHH" in
 *  hour mode (see {@link TokenTotalRange.granularity}). */
export interface DailyTokenUsage {
  day: string // bucket key; "YYYY-MM-DD" or "YYYY-MM-DDTHH", local calendar
  total: number // provider-inclusive tokens (input+output+cache reads/writes)
  byModel: Record<string, number> // normalized display name -> tokens
  byProvider: Record<string, number> // provider name -> tokens
  requests: number // usage events (API calls)
  failures: number // failed calls in the bucket (subset of requests)
  turns: number // completed turns
  cacheHit: number // cached input tokens in the bucket
  cacheMiss: number // uncached input tokens in the bucket
}

/** One model's aggregate within the range. */
export interface ModelTokenUsage {
  /** Normalized human-readable model name, not a provider/model route id. */
  model: string
  /** Single source provider, or empty when this model spans providers. */
  provider: string
  /** All source providers; optional for compatibility with older responses. */
  providers?: string[]
  /** Per-provider token split of this one model, largest first — the ranked
   *  row's hover detail ("which providers served this model"). Optional so a
   *  pre-cross-breakdown host still renders. */
  providerTokens?: Array<{ provider: string; tokens: number }>
  tokens: number
  percent: number // 0..100
  /** Cached input tokens this model served (rate numerator). */
  cacheHit: number
  /** Uncached prompt tokens: uncached input + cache writes (rate denominator side). */
  cacheMiss: number
}

/** One provider's aggregate within the range (each provider may serve several models). */
export interface ProviderTokenUsage {
  provider: string
  tokens: number
  percent: number
  cacheHit: number
  cacheMiss: number
  /** Per-model token split this provider served, largest first — the ranked
   *  row's hover detail ("which models this provider served"). Optional so a
   *  pre-cross-breakdown host still renders. */
  modelTokens?: Array<{ model: string; tokens: number }>
}

/** The full aggregate the panel renders for one time range. */
export interface TokenTotalRange {
  from: string // inclusive
  to: string // inclusive
  // Totals
  tokens: number // provider-inclusive (input + output + cache reads/writes)
  /** Uncached prompt tokens (the input the provider billed as new). */
  inputTokens: number
  /** Completion tokens. */
  outputTokens: number
  /** Cached prompt tokens: cache reads + cache writes (the cache bucket of `tokens`). */
  cacheTokens: number
  requests: number // usage events (API calls)
  /** Provider calls in the range that FAILED: the stream ended with an error
   *  or the call was cancelled before any content was committed. A subset of
   *  `requests` (a failed call was still one call), and — like `requests` —
   *  independent of the token buckets: a stream that died mid-flight may
   *  still have reported usage. */
  failures: number
  turns: number // completed turns
  cacheHit: number
  cacheMiss: number
  // Derived
  activeDays: number
  topModel: string
  topProvider: string
  // Series
  /** Bucket size of `daily`: day presets and custom ranges group per day;
   *  the "today" / "last 3 days" presets group per local hour. */
  granularity: 'day' | 'hour'
  daily: DailyTokenUsage[]
  models: ModelTokenUsage[]
  providers: ProviderTokenUsage[]
  /** Provider route id -> the display name the model selector shows. Filled by
   *  the host route from the llm service metadata; a provider missing here (a
   *  deleted route, an older host) renders as its raw id. Optional so a host
   *  that cannot resolve names still serves a valid payload. */
  providerNames?: Record<string, string>
}

/** The usage statistics panel aggregate request. */
export interface TokenTotalRequest {
  range: string // "today" | "3" | "7" | "14" | "30" | "90" | "custom"
  from?: string // "YYYY-MM-DD", custom only
  to?: string // "YYYY-MM-DD", custom only
}

/** The four billing buckets the composer pill and the dashboard both speak. */
export interface SessionUsageTotals {
  /** Uncached prompt tokens. */
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** What one session tree cost, split into the main agent and its subagents.
 *  The composer stats row renders this so a delegating session shows its whole
 *  spend (the native `tokenUsage` projection only covers the main agent). */
export interface SessionUsageTree {
  /** The root session's own usage, including logged compaction calls. */
  self: SessionUsageTotals
  /** Root-only compaction spend already included in `self`, but absent from
   *  the native `tokenUsage` projection. Optional for older host responses. */
  selfCompaction?: SessionUsageTotals
  /** Sum over every descendant (subagent) session. */
  subagents: SessionUsageTotals
  /** self + subagents. */
  total: SessionUsageTotals
  /** How many descendant sessions were counted. */
  subagentSessions: number
}

/** Request body of POST /token-total/api/session. */
export interface SessionUsageRequest {
  sessionId: string
}

/** Detailed per-session usage view used by the Usage tab. */
export interface SessionUsageDetail {
  sessionId: string
  totals: SessionUsageTotals
  requests: number
  averageFirstTokenMs: number | null
  tokensPerSecond: number | null
  subagents: Array<{
    sessionId: string
    name: string
    totals: SessionUsageTotals
    requests: number
    averageFirstTokenMs: number | null
    tokensPerSecond: number | null
  }>
  models: Array<{
    /** Raw model id from the historical route. Stays the row key and the
     *  fallback label (also the tooltip) when no display name is resolved. */
    model: string
    /** The model selector's display name for this model, resolved host-side
     *  from the llm service metadata. Optional so an older host (or an
     *  unresolvable route) still serves a valid payload. */
    name?: string
    /** Display names (raw ids when unknown) of every provider that served this
     *  model in the session, first-seen order. The by-model card shows these in
     *  gray when two rows end up sharing one display name. */
    providers?: string[]
    totals: SessionUsageTotals
    requests: number
  }>
  records: Array<{
    id: string
    sessionId: string
    sessionName: string
    turn: number
    step: number
    startedAt: number
    finishedAt: number | null
    provider: string
    model: string
    status: 'running' | 'completed' | 'failed' | 'interrupted'
    totals: SessionUsageTotals
    firstTokenMs: number | null
    /** Wall window from this step's first token to the assembled assistant
     *  message — the same decode window the `sessionStats` projection counts
     *  (decodeMs). Null when the request never assembled a message or reported
     *  no usage, so it stays out of every throughput quotient. */
    decodeMs: number | null
    tokensPerSecond: number | null
    turnName: string
    effort: string
  }>
  routes: Array<{
    id: string
    provider: string
    name: string
    model: string
    status: 'idle' | 'running' | 'completed' | 'failed'
  }>
  /** The root session's live context composition, rendered above the cards.
   *  Null when the log has no readable events (or on an older host). */
  context?: SessionContextWindow | null
  /** What the session's requests spent, split by what filled the prompt.
   *  Null when the log has no readable usage (or on an older host). */
  composition?: SessionUsageComposition | null
}

/** The eight buckets the Token stats card names, in legend order: the left
 *  column first (prompt composition), then the right column. */
export type SessionUsageBucket =
  | 'systemPrompt'
  | 'user'
  | 'skill'
  | 'toolResult'
  | 'toolDef'
  | 'injected'
  | 'assistant'
  | 'output'

/** One session tree's spend split by prompt content.
 *
 *  Every provider request replays the whole message list, so a bucket's number
 *  is what that bucket contributed ACROSS ALL REQUESTS, not its size in the
 *  window today. The replay figures are ESTIMATES (character counts, the same
 *  estimator the context-window snapshot uses) because the provider only bills
 *  a whole prompt; the billed total and its cache split are exact and drive
 *  the headline and the cache-hit badge. */
export interface SessionUsageComposition {
  /** Estimated replay tokens per bucket, in legend order (kept at 0 when a
   *  bucket never appeared so the card can keep a stable order). */
  buckets: Array<{ key: SessionUsageBucket; tokens: number }>
  /** Exact provider-billed total across the same requests (prompt including
   *  cached tokens, plus output). */
  billedTokens: number
  /** The same spend split into the four billing buckets, for the cache badge
   *  and any future detail row. */
  totals: SessionUsageTotals
  /** How many provider answers the accumulation covers (compaction included). */
  requests: number
}

/** The six buckets the context-window panel paints, in legend order. They are
 *  the buckets a reader thinks in: the harness prompt, the tool catalogue, the
 *  injected memory (runtime context, skill catalog, compaction summaries), the
 *  files the agent read, the remaining tool results, and the conversation. */
export type SessionContextCategory = 'system' | 'tools' | 'memory' | 'files' | 'results' | 'conversation'

/** One block of the context-window treemap: a tool, one file path, one folded
 *  group of the same tool, or one message bucket. `tokens` is an ESTIMATE from
 *  character counts (see context-window.ts), so the panel renders it as ~N. */
export interface SessionContextItem {
  /** Row key, unique inside one snapshot. */
  key: string
  category: SessionContextCategory
  /** What to print: a tool name, a file path, or (for `kind`-bearing rows) the
   *  localized kind label the panel substitutes. */
  label: string
  /** Machine kind the panel localizes ("system-prompt", "user", "rest", …).
   *  Absent for rows whose label is itself the data (tool names, paths). */
  kind?: string
  /** How many log entries folded into this row (messages, tool calls). */
  count: number
  tokens: number
}

/** The context-window snapshot: what the session's next provider call would
 *  carry, reconstructed from its own log (pruned events dropped, a compaction
 *  summary standing in for the range it replaced, the newest request's tool
 *  catalogue). Null when the session has no readable events yet. */
export interface SessionContextWindow {
  /** Sum of every item's estimated tokens. */
  totalTokens: number
  /** The model's window from the newest `request/context`, or null when the
   *  host route never reported one (the panel then says "unknown"). */
  contextWindow: number | null
  provider: string
  model: string
  /** Prompt-cache split of the newest answer: cache reads vs new prompt tokens. */
  cacheHitTokens: number
  cacheMissTokens: number
  /** Whether any answer reported usage (the cache bar needs one to draw). */
  cacheKnown: boolean
  /** Prompt tokens the provider billed on the newest answer
   *  (`totalTokens − outputTokens`, or uncached + cached input): the real
   *  occupancy. Upstream prompt compression can make it smaller than
   *  `totalTokens`, which merely replays the stored log. */
  promptTokens: number | null
  /** Treemap blocks, largest first. */
  items: SessionContextItem[]
}

/** The backfill (historical session scan) progress state. */
export interface BackfillStatus {
  running: boolean
  total: number
  done: number
  scannedSessions: number
  lastSessionId?: string
  error?: string
}

// ── HTTP helpers (host half only) ─────────────────────────────────────────

/** Default cap for a JSON request body. The panel posts tiny objects
 *  ({ range, from?, to? }); the cap only bounds a misbehaving trusted
 *  client, so 64 KiB is generous. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One line of an async-iterable request body read as UTF-8 text. */
export async function readJsonBody(req: UsageHttpRequest, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<unknown> {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > maxBytes) {
      throw new UsageError(413, `request body exceeds ${maxBytes} bytes`)
    }
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new UsageError(400, 'invalid json body')
  }
}

/** A user-visible error carrying its HTTP status. */
export class UsageError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function writeJson(res: UsageHttpResponse, value: unknown, status = 200): void {
  res.statusCode = status
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function writeError(res: UsageHttpResponse, err: unknown): void {
  const status = err instanceof UsageError ? err.status : 500
  // Deliberate 4xx carries its user-facing message; an unexpected 500 must
  // not echo internal error text (paths, driver messages) to the client —
  // the route handler logs the real error server-side.
  const message = err instanceof UsageError ? err.message : 'internal error'
  writeJson(res, { ok: false, error: { code: 'usage_api_error', message } }, status)
}
