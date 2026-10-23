/**
 * Typed fetch wrapper over the token-total JSON API. Every call posts to
 * `token-total/api/<method>` — DOCUMENT-RELATIVE, never root-absolute — with a
 * JSON body; the host resolves the range and returns the aggregate (or the
 * backfill status). Failures surface as {@link UsageApiError} with the wire code.
 *
 * Relative is the dsh 0.1.7 contract: the served index carries `<base
 * href="./">` (packages/host/frontend-static), so browser references resolve
 * under whatever mount served the page. A root-absolute `/token-total/api/...` only
 * works when the shell sits at the origin root and 404s behind a
 * prefix-stripping proxy; the host's own route key stays absolute
 * (`/token-total/api` in src/routes.ts), because only the browser half is relative.
 */
import type { BackfillStatus, SessionUsageDetail, SessionUsageTree, TokenTotalRange, TokenTotalRequest } from '../wire.ts'

/** One wire failure. */
export class UsageApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface WireResponse<T> {
  ok: true
  value: T
}

async function post<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`token-total/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw new UsageApiError('network', err instanceof Error ? err.message : String(err))
  }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new UsageApiError('bad-response', `unexpected response from /token-total/api/${method}`)
  }
  const wire = json as WireResponse<T> | { ok: false; error: { code: string; message: string } }
  if (!wire || wire.ok !== true) {
    const failure = wire as { ok: false; error: { code: string; message: string } }
    throw new UsageApiError(failure?.error?.code ?? 'error', failure?.error?.message ?? 'usage api error')
  }
  return wire.value
}

/** Aggregate the usage panel renders for one range. */
export async function fetchRange(req: TokenTotalRequest): Promise<TokenTotalRange> {
  return post<TokenTotalRange>('range', req)
}

/** Rebuild the statistics from the session logs. The host wipes every row plus
 *  the backfill cursor and replays all persisted sessions under the current
 *  attribution rules, so a drifted store converges back onto the logs; it
 *  refuses (409) only while a boot scan is still running. */
export async function rebuildStats(): Promise<BackfillStatus> {
  return post<BackfillStatus>('reset', {})
}

/** The whole session tree's usage: the root session's own main-agent spend plus
 *  every subagent session delegated from it. The native `tokenUsage` projection
 *  covers only the main agent, so this is what makes a delegating session's
 *  cost visible. */
export async function fetchSessionUsage(sessionId: string): Promise<SessionUsageTree> {
  return post<SessionUsageTree>('session', { sessionId })
}

/** Log-owned requests and live route states for the per-session Usage view. */
export async function fetchSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionUsageDetail> {
  return post<SessionUsageDetail>('session-detail', { sessionId }, signal)
}
