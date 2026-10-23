/**
 * The /token-total/api route table: a small JSON RPC over the fenced web route.
 * Methods:
 *   - range  { range, from?, to?, source? } -> TokenTotalRange
 *   - session { sessionId } -> SessionUsageTree (main + subagent usage)
 *   - status {} -> BackfillStatus
 *   - reset  {} -> drop every row + cursor, then rescan all persisted
 *              sessions (the store-rebuild escape hatch)
 * The prefix route /token-total/api is registered on the webserver; each request
 * passes the browser-trust fence (Host-header loopback, a trusted authority, or
 * this listener's own bind address).
 */

import type { Context, UsageLlmService } from './context-types.ts'
import { resolveModelNames, resolveProviderNames } from './model-names.ts'
import type { UsageHttpRequest, UsageHttpResponse, UsageWebRoute } from './context-types.ts'
import type { UsageStore, UsageDayRow, UsageHourRow } from './store.ts'
import type { UsageCollector } from './collector.ts'
import { aggregateSamples } from './query.ts'
import type { Granularity, UsageSample } from './query.ts'
import type { BackfillStatus, SessionUsageDetail, SessionUsageRequest, TokenTotalRange, TokenTotalRequest } from './wire.ts'
import { buildSessionUsageDetail } from './session-detail.ts'
import { UsageError, readJsonBody, writeError, writeJson } from './wire.ts'
import type { SessionUsageService } from './session-usage.ts'
import { createTrustFence, type TrustFence, type TrustInputs } from './trust-fence.ts'

export interface RoutesDeps {
  store: UsageStore
  collector: UsageCollector
  /** Per-session (main + subagent) usage, computed on demand from session logs. */
  sessionUsage: SessionUsageService
  /** Live persistence + session store, used by the per-session endpoint. */
  persistence: () => Context['sessionPersistence']
  sessions: () => Context['sessions']
  /** Resolve the /token-total/api trust inputs live: the trusted authorities, this
   *  listener's bind address, and its protocol (see trust-fence TrustInputs). */
  trust: () => TrustInputs
  /** Whether a /reset rebuild pipeline is currently in flight (its scan
   *  makes the collector report running too 鈥?callers use this to tell that
   *  benign state apart from a boot scan and COALESCE onto the pipeline
   *  instead of refusing). */
  isRebuilding: () => boolean
  /** Wipe the store at wipe-time live watermarks and re-run the full
   *  backfill (wired by the host half; concurrent calls coalesce into one
   *  rebuild). */
  resetAndRescan: () => Promise<void>
}

/** Parse a strict `YYYY-MM-DD` calendar date (rejects rolled-over shapes
 *  like "2026-13-45" that a regex alone would pass). */
function parseDayKey(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : null
}

/** Longest custom span accepted (one leap year) 鈥?bounds the daily series
 *  size and the response body against a misbehaving trusted client. */
const MAX_CUSTOM_SPAN_DAYS = 366

/** Resolve a request's [from, to] into inclusive local day keys. */
export function resolveRange(req: TokenTotalRequest, now = new Date()): { from: string; to: string } {
  const day = (d: Date): string => {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
  const toDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 0)
  switch (req.range) {
    case 'today': {
      return { from: day(toDate), to: day(toDate) }
    }
    case '3': {
      const from = new Date(toDate)
      from.setDate(from.getDate() - 2)
      return { from: day(from), to: day(toDate) }
    }
    case '7':
    case '14':
    case '30':
    case '90': {
      const n = Number(req.range)
      const from = new Date(toDate)
      from.setDate(from.getDate() - (n - 1))
      return { from: day(from), to: day(toDate) }
    }
    case 'custom': {
      if (!req.from || !req.to) {
        throw new UsageError(400, 'token total: custom range needs valid from/to dates (YYYY-MM-DD)')
      }
      const from = parseDayKey(req.from)
      const to = parseDayKey(req.to)
      if (from === null || to === null) {
        throw new UsageError(400, 'token total: custom range needs valid from/to dates (YYYY-MM-DD)')
      }
      if (req.to < req.from) {
        throw new UsageError(400, 'token total: custom to must be >= from')
      }
      // Calendar-day span via UTC noon-free date math: both keys are plain
      // calendar dates, so the millisecond difference is exact whole days.
      const spanDays = (Date.UTC(to.y, to.m - 1, to.d) - Date.UTC(from.y, from.m - 1, from.d)) / 86_400_000 + 1
      if (spanDays > MAX_CUSTOM_SPAN_DAYS) {
        throw new UsageError(400, `token total: custom range spans more than ${MAX_CUSTOM_SPAN_DAYS} days`)
      }
      return { from: req.from, to: req.to }
    }
    default: {
      // Unknown/empty range defaults to the last 7 days.
      const from = new Date(toDate)
      from.setDate(from.getDate() - 6)
      return { from: day(from), to: day(toDate) }
    }
  }
}

/** The trend granularity a range preset asks for: the two short presets read
 *  per hour, everything else (including custom) per day. */
export function granularityOf(range: string | undefined): Granularity {
  return range === 'today' || range === '3' ? 'hour' : 'day'
}

/** Build the aggregate for a range from the store rows. The per-row request
 *  and turn counts are yielded lazily as markers, so no intermediate array
 *  is materialized regardless of range size. */
export async function aggregateRange(
  store: UsageStore,
  from: string,
  to: string,
  granularity: Granularity = 'day',
  llm?: UsageLlmService,
): Promise<TokenTotalRange> {
  const rows: Array<UsageDayRow | UsageHourRow> = granularity === 'hour'
    ? await store.rangeHourRows(from, to)
    : await store.rangeRows(from, to)
  const names = await resolveModelNames(rows.filter((row) =>
    row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0,
  ).map((row) => row.model), llm)
  const samples = (function* (): Generator<UsageSample> {
    for (const row of rows) {
      const hour = 'hour' in row ? row.hour : undefined
      const day = hour === undefined ? (row as UsageDayRow).day : hour.slice(0, 10)
      // Any real token traffic makes the row a token sample 鈥?including a
      // pure-cache call whose uncached input and output are both zero.
      if (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0) {
        yield {
          day,
          hour,
          model: row.model,
          modelName: names.get(row.model),
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
        }
      }
      // Requests live on the row as a count (one per provider call, tokens or
      // not); expand them into request markers for the shared aggregator.
      for (let i = 0; i < row.requests; i++) {
        yield { day, hour, model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, request: true }
      }
      // Failed calls ride the row as a count too. They are folded as their own
      // marker (never as an extra request): the call's request is already
      // counted above, and a zero-token failure must not open a model row.
      for (let i = 0; i < (row.failures ?? 0); i++) {
        yield { day, hour, model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, failed: true }
      }
      for (let i = 0; i < row.turns; i++) {
        yield { day, hour, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turn: true }
      }
    }
  })()
  const stats = aggregateSamples(samples, { from, to }, granularity)
  // Provider labels ride along with the aggregate: the ranked provider card
  // shows the selector's display name, and the hover detail names the models
  // underneath it. Only providers actually present in the range are included,
  // so the payload stays proportional to the ranking it decorates.
  const resolved = resolveProviderNames(llm)
  const providerNames: Record<string, string> = Object.create(null)
  for (const provider of stats.providers) {
    const label = resolved[provider.provider]
    if (label !== undefined) providerNames[provider.provider] = label
  }
  if (Object.keys(providerNames).length > 0) stats.providerNames = providerNames
  return stats
}

/** Build the single fenced prefix route serving the /token-total/api JSON RPC.
 *  The host mounts it via `ctx.webServer.register` (which takes ONE WebRoute,
 *  not an array 鈥?matching the real dsh-host-webserver contract). */
export function buildUsageRoute(ctx: Context, deps: RoutesDeps): UsageWebRoute {
  const fence: TrustFence = createTrustFence(deps.trust)
  const handler = async (req: UsageHttpRequest, res: UsageHttpResponse): Promise<void> => {
    if (!fence.isTrusted(req)) {
      writeJson(res, { ok: false, error: { code: 'forbidden', message: 'untrusted host' } }, 403)
      return
    }
    // Match on the request PATH only: the route is registered as a /token-total/api
    // prefix, so a raw `endsWith` would also swallow deeper paths like
    // /token-total/api/x/range, and a query string would break the comparison and
    // 404 a legitimate endpoint. Strip ?/# and compare exactly.
    const url = req.url ?? ''
    const path = url.split(/[?#]/, 1)[0]!
    const method = req.method ?? 'GET'
    try {
      if (method === 'POST' && path === '/token-total/api/range') {
        const body = (await readJsonBody(req)) as Partial<TokenTotalRequest>
        const { from, to } = resolveRange(body as TokenTotalRequest)
        const llm = ctx.get('llm') as UsageLlmService | undefined
        const stats = await aggregateRange(deps.store, from, to, granularityOf(body.range), llm)
        writeJson(res, { ok: true, value: stats })
        return
      }
      if (method === 'POST' && path === '/token-total/api/session') {
        const body = (await readJsonBody(req)) as Partial<SessionUsageRequest>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '' || sessionId.length > 200) {
          throw new UsageError(400, 'token total: session needs a valid sessionId')
        }
        const value = await deps.sessionUsage.tree(
          deps.persistence(),
          deps.sessions(),
          sessionId,
        )
        writeJson(res, { ok: true, value })
        return
      }
      if (method === 'POST' && path === '/token-total/api/session-detail') {
        const body = (await readJsonBody(req)) as Partial<SessionUsageRequest>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '' || sessionId.length > 200) throw new UsageError(400, 'token total: session needs a valid sessionId')
        const value = await buildSessionUsageDetail(deps.persistence(), deps.sessions(), sessionId, ctx)
        writeJson(res, { ok: true, value })
        return
      }
      if (method === 'POST' && path === '/token-total/api/status') {
        writeJson(res, { ok: true, value: deps.collector.status })
        return
      }
      if (method === 'POST' && path === '/token-total/api/reset') {
        // Rebuild escape hatch: wipe rows + cursor, then replay every
        // persisted session under the CURRENT attribution rules. Refuse only
        // while a BOOT scan (not started by a reset) is in flight; an
        // overlapping reset rides the coalescing pipeline instead 鈥?one
        // wipe+rebuild, every caller gets its outcome. Live sessions are
        // re-bounded at their wipe-time log length so the rebuild also
        // reconstructs what the live path had recorded before the wipe.
        if (deps.collector.running && !deps.isRebuilding()) {
          throw new UsageError(409, 'token total: backfill already running')
        }
        await deps.resetAndRescan()
        writeJson(res, { ok: true, value: deps.collector.status })
        return
      }
      writeJson(res, { ok: false, error: { code: 'not_found', message: `unknown endpoint ${path}` } }, 404)
    } catch (err) {
      // Log the real failure server-side (the fence keeps untrusted callers
      // out, so this is a trusted client or an internal fault); writeError
      // only returns a generic 500 body for non-UsageError failures.
      const logger = (ctx as unknown as { logger?: { warn(message: unknown): void } }).logger
      if (!(err instanceof UsageError)) logger?.warn(err instanceof Error ? err : new Error(String(err)))
      writeError(res, err)
    }
  }
  return { kind: 'prefix', path: '/token-total/api', handler }
}

export type { BackfillStatus, TokenTotalRange, TokenTotalRequest, SessionUsageRequest, SessionUsageDetail }
