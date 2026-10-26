/**
 * Pure helpers shared by the host aggregation layer and the browser panel.
 * This module MUST stay free of Node.js and DOM types and carry zero
 * imports: both halves import it at runtime (the client bundle-purity gate
 * rejects Node builtins, and a value import of `wire.ts` would drag the
 * host-only HTTP helpers — including `Buffer` — into the browser bundle).
 */

/** Local calendar day key, e.g. "2026-08-02" (no UTC shift). */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local calendar hour key, e.g. "2026-08-02T07" (no UTC shift). */
export function hourKey(ts: number): string {
  const d = new Date(ts)
  return `${dayKey(ts)}T${String(d.getHours()).padStart(2, '0')}`
}

/** All local-calendar day keys in [from, to], inclusive. Invalid or reversed
 *  bounds yield an empty list. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${y}-${m}-${day}`)
  }
  return out
}

/** model refs are "provider/model"; a bare model name has no slash and is
 *  attributed to provider "default". */
export function providerOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(0, i)
  return 'default'
}

/** The bare model id/name after a provider prefix. This does NOT resolve the
 *  human-readable display name; the host model metadata does that. */
export function modelNameOf(modelRef: string): string {
  const i = modelRef.indexOf('/')
  if (i > 0) return modelRef.slice(i + 1)
  return modelRef
}

/** The decode accounting one request row must expose: the wall window from the
 *  step's first token to its assembled assistant message, plus the output tokens
 *  that window produced. */
export interface DecodeRowLike {
  decodeMs: number | null
  totals: { outputTokens: number }
}

/** Decode throughput across rows: Σ(output tokens) / Σ(decode window), matching
 *  the `sessionStats` projection's decodeTokens/decodeMs rate that the composer
 *  bottom bar shows. Rows without a decode window (failed attempts, cancelled
 *  steps, running requests) are excluded, so the card, the turn summaries and
 *  the bottom bar all report one speed. */
export function decodeRateOf(rows: readonly DecodeRowLike[]): number | null {
  let ms = 0
  let tokens = 0
  // typeof, not `!== null`: a bundle newer than the payload it is handed (a
  // cached detail, an older server) leaves `decodeMs` absent, and one absent
  // field must not turn the whole sum into NaN.
  for (const row of rows) if (typeof row.decodeMs === 'number' && Number.isFinite(row.decodeMs)) { ms += row.decodeMs; tokens += row.totals.outputTokens }
  return ms > 0 ? tokens / (ms / 1000) : null
}

/** Canonicalize a DISPLAY NAME, never a route id. Case and word separators
 *  do not distinguish models, but versions, punctuation and suffixes do:
 *  gpt-6.1-sol / GPT 6.1 sol -> gpt-6.1-sol, not gpt-6.1 or gpt-61-sol.
 *  Do not strip a slash here: it may be part of the actual display name. */
export function normalizeModelName(displayName: string): string {
  return displayName.normalize('NFKC').trim().toLowerCase()
    .replace(/[\s_\p{Dash_Punctuation}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || '(unknown)'
}
