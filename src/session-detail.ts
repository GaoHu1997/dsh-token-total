import type {
  Context,
  UsageSessionEvent,
  UsageSessionHandle,
  UsageSessionHeader,
  UsageSessionPersistence,
  UsageSessionSnapshot,
  UsageSessionStore,
} from './context-types.ts'
import { UsageFold } from './collector.ts'
import { buildSessionContextWindow } from './context-window.ts'
import { resolveModelNames, resolveProviderNames } from './model-names.ts'
import { decodeRateOf } from './shared.ts'
import type { SessionUsageDetail, SessionUsageTotals } from './wire.ts'

const zero = (): SessionUsageTotals => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
function add(a: SessionUsageTotals, b: SessionUsageTotals): void {
  a.uncachedInputTokens += b.uncachedInputTokens; a.outputTokens += b.outputTokens
  a.cacheReadTokens += b.cacheReadTokens; a.cacheWriteTokens += b.cacheWriteTokens
}
function usageOf(x: any): SessionUsageTotals {
  const u = x?.usage ?? x
  return { uncachedInputTokens: Number(u?.inputTokens) || 0, outputTokens: Number(u?.outputTokens) || 0, cacheReadTokens: Number(u?.cacheReadTokens) || 0, cacheWriteTokens: Number(u?.cacheWriteTokens) || 0 }
}
function routeOf(x: any): { provider: string; model: string } {
  const source = x?.message?.source ?? x?.source ?? x?.request ?? x?.context ?? x
  return { provider: typeof source?.provider === 'string' ? source.provider : '', model: typeof source?.model === 'string' ? source.model : '' }
}
/** Whether one stream chunk carries the model's first output token. Mirrors
 *  `isTokenDelta` in @deepseek-ai/dsh-llm so the decode window starts on the
 *  same chunk the official `sessionStats` projection starts it on. */
function isTokenDelta(chunk: any): boolean {
  switch (chunk?.type) {
    case 'text-delta': case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}
/** Reconstructed time of the first token in one packed delta run (mirrors
 *  `runFirstTokenTime`): a name-bearing tool-call run starts at its first
 *  member, every other run at its first non-empty fragment. */
function runFirstTokenTime(run: any): number | undefined {
  if (run?.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const fragments = run?.type === 'tool-call-chunks' ? run.args : run?.texts
  if (!Array.isArray(fragments)) return undefined
  let time = Number(run.time0)
  for (let i = 0; i < fragments.length; i++) {
    if (i > 0) time += Number(run.dt?.[i - 1]) || 0
    if (fragments[i] !== '') return time
  }
  return undefined
}
/** Time of the first token in one compact attempt stream (mirrors
 *  `assistantStreamFirstTokenTime`). */
function streamFirstTokenTime(stream: any): number | undefined {
  for (const r of Array.isArray(stream) ? stream : []) {
    const t = r?.type === 'chunk' ? (isTokenDelta(r.chunk) ? r.time : undefined) : runFirstTokenTime(r)
    if (typeof t === 'number' && Number.isFinite(t)) return t
  }
  return undefined
}
/** Time of the first token carried by one live `assistant/chunk` payload. */
function chunkFirstTokenTime(data: any, fallback: number): number | undefined {
  const c = data?.chunk
  if (!c) return undefined
  const timed = c.chunk && typeof c.time === 'number' ? c : null
  if (!isTokenDelta(timed ? timed.chunk : c)) return undefined
  return timed ? timed.time : typeof c.time === 'number' ? c.time : fallback
}
function streamUsage(data: any): { usage?: SessionUsageTotals; raw?: any } {
  let usage: SessionUsageTotals | undefined
  let raw: any
  for (const r of Array.isArray(data?.stream) ? data.stream : []) {
    if (r?.type === 'chunk' && r?.chunk?.type === 'usage') { usage = usageOf(r.chunk); raw = r.chunk.usage ?? r.chunk }
  }
  return { usage, raw }
}
/** Provider-reported completion tokens, or null when unreported or invalid:
 *  an invalid count must not enter the decode quotient (mirrors
 *  `usageOutputTokens` in the sessionStats projection). */
function usageOutputTokens(x: any): number | null {
  const value = (x?.usage ?? x)?.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function headerOf(item: UsageSessionHeader | UsageSessionSnapshot): UsageSessionHeader | null {
  const x: any = item
  if (x?.header?.id && typeof x.header.id === 'string') return x.header
  return typeof x?.id === 'string' && x.id ? x : null
}
async function read(p: UsageSessionPersistence, id: string, live?: UsageSessionHandle): Promise<{ events: readonly UsageSessionEvent[]; cut: number }> {
  if (live?.snapshotEvents && typeof live.inheritedEventCount === 'number') return { events: live.snapshotEvents(), cut: Math.max(0, live.inheritedEventCount) }
  if (p.open) {
    const h = await p.open(id, 'read'); const out: UsageSessionEvent[] = []
    try { for (let off = 0;;) { const page = await h.read(off, 500); if (!page.events.length) break; out.push(...page.events); off += page.events.length } }
    finally { await h.close().catch(() => {}) }
    return { events: out, cut: Math.max(0, Number(h.inheritedEventCount) || 0) }
  }
  if (p.inspect) { const x = await p.inspect(id); return { events: x.events, cut: Math.max(0, Number(x.inheritedEventCount) || 0) } }
  throw new Error('no readable persistence seam (need open or inspect)')
}

type MutableRecord = SessionUsageDetail['records'][number] & { _attempt: number; _lastUsage: SessionUsageTotals }
function nameOf(h: UsageSessionHeader | undefined, id: string): string {
  const x: any = h
  if (typeof x?.name === 'string' && x.name) return x.name
  if (typeof x?.title === 'string' && x.title) return x.title
  if (typeof x?.cwd === 'string' && x.cwd) return x.cwd.split(/[\\/]/).filter(Boolean).pop() || id
  return id
}

async function one(p: UsageSessionPersistence, id: string, header: UsageSessionHeader | undefined, live: UsageSessionHandle | undefined) {
  const { events, cut } = await read(p, id, live)
  const fold = new UsageFold(); const totals = zero(); const records: MutableRecord[] = []
  const byKey = new Map<string, MutableRecord>(); let route = live?.requestContext?.() ?? {}
  let ordinal = 0
  // Per-turn display names come from the first real user prompt of each turn
  // (other `user/message` kinds are runtime context / skill catalog injections);
  // the prompt usually lands before `turn/start`, so buffer it until the turn opens.
  let currentTurn = 0; let effort = ''; let pendingTopic = ''
  const turnTopics = new Map<number, string>()
  const own = events.filter(e => !(cut > 0 && typeof e.seq === 'number' && e.seq < cut))
  // Real session names: a subagent carries its delegation label on its
  // `subagent/descriptor` event ("完成日志明细后端"), every session can carry a
  // generated `session/title`; only fall back to the header/cwd/id guesses.
  let label = '', title = ''
  for (const ev of own) {
    const d: any = ev.data ?? {}
    if (!label && ev.type === 'subagent/descriptor' && typeof d.label === 'string' && d.label.trim()) label = d.label.trim()
    if (!title && ev.type === 'session/title' && typeof d.title === 'string' && d.title.trim()) title = d.title.trim()
    if (label && title) break
  }
  const name = label || title || nameOf(header, id)
  // Decode accounting mirrors the official `sessionStats` projection: a step
  // records its first token once (the earliest attempt wins, surviving an
  // in-step retry), and only the assembled `assistant/message` closes the
  // decode window, so failed attempts and cancelled steps stay uncounted.
  const stepTokens = new Map<string, number>()
  const closedSteps = new Set<string>()
  for (const ev of own) {
    const d: any = ev.data ?? {}; const turn = Number.isFinite(d.turn) ? d.turn : 0; const step = Number.isFinite(d.step) ? d.step : 0
    if (ev.type === 'request/context') { route = { ...route, ...routeOf(d) }; continue }
    const r = routeOf(d); if (r.provider || r.model) route = { ...route, ...r }
    if (ev.type === 'turn/start') {
      currentTurn = turn
      if (pendingTopic && !turnTopics.has(currentTurn)) { turnTopics.set(currentTurn, pendingTopic); pendingTopic = '' }
    } else if (ev.type === 'user/message' && d.source?.kind === 'user') {
      const block = (Array.isArray(d.content) ? d.content : []).find((b: any) => b?.type === 'text' && typeof b.text === 'string')
      const text = String(block?.text ?? '').replace(/\s+/g, ' ').trim()
      if (text) {
        if (currentTurn > 0 && !turnTopics.has(currentTurn)) turnTopics.set(currentTurn, text)
        else pendingTopic = text
      }
    } else if (ev.type === 'request/header') {
      const e = d.header?.config?.reasoningEffort
      if (typeof e === 'string' && e) {
        effort = e
        for (const x of records) if (x.status === 'running') x.effort = e
      }
    }
    let rec: MutableRecord | undefined
    if (ev.type === 'step/start' || ev.type === 'llm/retry-started') {
      const key = `${turn}:${step}`
      if (ev.type === 'llm/retry-started' || !byKey.has(key)) {
        const previous = byKey.get(key)
        if (previous && ev.type === 'llm/retry-started' && previous.status === 'running') { previous.status = 'failed'; previous.finishedAt = ev.time }
        rec = { id: `${id}:${turn}:${step}:${ordinal++}`, sessionId: id, sessionName: name, turn, step, startedAt: ev.time, finishedAt: null, provider: r.provider || route.provider || '', model: r.model || route.model || '', status: 'running', totals: zero(), firstTokenMs: null, decodeMs: null, tokensPerSecond: null, turnName: '', effort, _attempt: ev.type === 'llm/retry-started' ? 1 : 0, _lastUsage: zero() }
        records.push(rec); byKey.set(key, rec)
      }
    } else if (ev.type === 'assistant/chunk' || ev.type === 'assistant/message' || ev.type === 'assistant/attempt') {
      const key = `${turn}:${step}`
      rec = byKey.get(key)
      if (!rec) { rec = { id: `${id}:${turn}:${step}:${ordinal++}`, sessionId: id, sessionName: name, turn, step, startedAt: ev.time, finishedAt: null, provider: r.provider || route.provider || '', model: r.model || route.model || '', status: 'running', totals: zero(), firstTokenMs: null, decodeMs: null, tokensPerSecond: null, turnName: '', effort, _attempt: 0, _lastUsage: zero() }; records.push(rec); byKey.set(key, rec) }
      if (r.provider) rec.provider = r.provider; if (r.model) rec.model = r.model
      const su = streamUsage(d); const u = ev.type === 'assistant/message' ? (d.usage ? usageOf(d) : su.usage) : ev.type === 'assistant/chunk' ? (d.chunk?.type === 'usage' ? usageOf(d.chunk) : undefined) : (d.usage ? usageOf(d) : su.usage)
      if (u) { rec._lastUsage = u; rec.totals = u }
      // The first token opens both this row's first-token wait and the step's
      // decode window; the earliest attempt keeps it across an in-step retry.
      const tokenAt = streamFirstTokenTime(d.stream) ?? chunkFirstTokenTime(d, ev.time)
      if (tokenAt !== undefined) {
        if (!stepTokens.has(key)) stepTokens.set(key, tokenAt)
        if (rec.firstTokenMs === null) rec.firstTokenMs = Math.max(0, tokenAt - rec.startedAt)
      }
      if (ev.type !== 'assistant/chunk') {
        rec.finishedAt = ev.time; rec.status = ev.type === 'assistant/attempt' ? 'failed' : 'completed'
        // Only an assembled message closes the decode window, and only its own
        // top-level `usage` counts, exactly as the official sessionStats
        // projection counts it: a failed attempt, a cancelled step or a
        // stream-only usage sample contributes no decode time, so the card, the
        // turn summaries and the composer bottom bar all quote one speed.
        const stepFirst = stepTokens.get(key)
        if (rec.status === 'completed' && !closedSteps.has(key) && stepFirst !== undefined && usageOutputTokens(d.usage) !== null) {
          closedSteps.add(key)
          rec.decodeMs = Math.max(0, rec.finishedAt - stepFirst)
          if (rec.decodeMs > 0 && rec.totals.outputTokens > 0) rec.tokensPerSecond = rec.totals.outputTokens / (rec.decodeMs / 1000)
        }
      }
    } else if (ev.type === 'turn/end') {
      const recs = records.filter(x => x.turn === turn && x.status === 'running'); for (const x of recs) { x.status = 'interrupted'; x.finishedAt = ev.time }
    } else if (ev.type === 'compaction/summary') {
      const u = usageOf(d); rec = { id: `${id}:compaction:${ordinal++}`, sessionId: id, sessionName: name, turn: 0, step: 0, startedAt: ev.time, finishedAt: ev.time, provider: typeof d.provider === 'string' ? d.provider : '', model: typeof d.model === 'string' ? d.model : '', status: 'completed', totals: u, firstTokenMs: null, decodeMs: null, tokensPerSecond: null, turnName: '', effort: '', _attempt: 0, _lastUsage: u }; records.push(rec)
    }
    const sample = fold.fold(ev); if (sample && !sample.turn) add(totals, { uncachedInputTokens: sample.inputTokens, outputTokens: sample.outputTokens, cacheReadTokens: sample.cacheReadTokens, cacheWriteTokens: sample.cacheWriteTokens })
  }
  // Records intentionally expose the final fold value; fold corrections can make
  // a stream sample disappear, so reconcile aggregate totals from the records only
  // for presentation while `totals` remains the authoritative UsageFold result.
  const requests = records.length
  // The first-token average quotes answered requests only: a failed attempt or
  // a cancelled step is not a wait the reader experienced as an answer.
  const firsts = records.filter(x => x.status === 'completed').map(x => x.firstTokenMs).filter((x): x is number => x !== null)
  for (const x of records) { x.turnName = turnTopics.get(x.turn) ?? ''; delete (x as any)._attempt; delete (x as any)._lastUsage }
  return { id, name, header, totals, records: records as SessionUsageDetail['records'], requests, averageFirstTokenMs: firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null, tokensPerSecond: decodeRateOf(records), context: buildSessionContextWindow(own) }
}

export async function buildSessionUsageDetail(persistence: UsageSessionPersistence, sessions: UsageSessionStore | undefined, rootId: string, ctx?: Context): Promise<SessionUsageDetail> {
  const raw = await persistence.list(typeof persistence.open === 'function' ? undefined : undefined)
  const headers = raw.map(headerOf).filter((x): x is UsageSessionHeader => x !== null)
  const live = new Map((sessions?.list() ?? []).map(x => [x.id, x])); const children = new Map<string, string[]>()
  for (const h of headers) if (h.parentSession) children.set(h.parentSession, [...(children.get(h.parentSession) ?? []), h.id])
  for (const h of live.values()) { const p = h.header?.parentSession ?? h.parentSession; if (p) children.set(p, [...(children.get(p) ?? []).filter(x => x !== h.id), h.id]) }
  const ids: string[] = []; const seen = new Set([rootId]); const q = [rootId]
  while (q.length) for (const c of children.get(q.shift()!) ?? []) if (!seen.has(c)) { seen.add(c); ids.push(c); q.push(c) }
  const all = [rootId, ...ids]; const parts = await Promise.all(all.map(id => one(persistence, id, headers.find(h => h.id === id), live.get(id))))
  const totals = zero(); const models = new Map<string, { totals: SessionUsageTotals; requests: number; providers: Set<string> }>(); const records = parts.flatMap(x => x.records); for (const p of parts) add(totals, p.totals)
  for (const r of records) { const key = r.model || '(unknown)'; const m = models.get(key) ?? { totals: zero(), requests: 0, providers: new Set<string>() }; add(m.totals, r.totals); m.requests++; if (r.provider) m.providers.add(r.provider); models.set(key, m) }
  const subagents = parts.slice(1).map(p => ({ sessionId: p.id, name: p.name, totals: p.totals, requests: p.requests, averageFirstTokenMs: p.averageFirstTokenMs, tokensPerSecond: p.tokensPerSecond }))
  const routeMap = new Map<string, SessionUsageDetail['routes'][number]>()
  for (const r of records) if (r.provider || r.model) { const id = `${r.provider}/${r.model}`; routeMap.set(id, { id, provider: r.provider, name: r.provider, model: r.model, status: r.status === 'running' ? 'running' : r.status === 'failed' ? 'failed' : 'completed' }) }
  const llm: any = ctx?.get?.('llm'); for (const x of llm?.listProviders?.() ?? []) if (x?.id && !routeMap.has(x.id)) routeMap.set(x.id, { id: x.id, provider: x.id, name: x.name || x.id, model: '', status: 'idle' })
  // Model rows key on the raw historical model id; attach the model selector's
  // display name plus the serving providers so the by-model card never shows a
  // route id as the model name and can disambiguate same-named models.
  const providerNames = resolveProviderNames(llm)
  const refOf = (provider: string, model: string): string => provider ? `${provider}/${model}` : model
  const refs: string[] = []
  for (const [model, m] of models) if (model !== '(unknown)') {
    if (m.providers.size) for (const provider of m.providers) refs.push(refOf(provider, model))
    else refs.push(refOf('', model))
  }
  const names = await resolveModelNames(refs, llm)
  const displayNameOf = (model: string, providers: Set<string>): string | undefined => {
    // One row can span providers; take the first display name they agree on.
    const keys = providers.size ? [...providers].map(provider => refOf(provider, model)) : [refOf('', model)]
    for (const key of keys) { const resolved = names.get(key)?.trim(); if (resolved) return resolved }
    return undefined
  }
  // The card is scoped to this session and every subagent, so its speed and
  // first-token average fold the same records its token totals do.
  const firsts = records.filter(x => x.status === 'completed').map(x => x.firstTokenMs).filter((x): x is number => x !== null)
  return { sessionId: rootId, totals, requests: parts.reduce((n, p) => n + p.requests, 0), averageFirstTokenMs: firsts.length ? firsts.reduce((a, b) => a + b, 0) / firsts.length : null, tokensPerSecond: decodeRateOf(records), subagents, models: [...models.entries()].map(([model, x]) => { const name = displayNameOf(model, x.providers); return { model, ...(name ? { name } : {}), providers: [...x.providers].map(provider => providerNames[provider] || provider), totals: x.totals, requests: x.requests } }), records, routes: [...routeMap.values()], context: parts[0]?.context ?? null }
}
