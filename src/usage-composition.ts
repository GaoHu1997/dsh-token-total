/**
 * Spend composition: what the session's requests actually paid for, split by
 * what filled each prompt.
 *
 * The context-window snapshot answers "what is in the window NOW". This module
 * answers the other half of the picture: every provider request replays the
 * whole message list, so a session that made 300 calls paid for the system
 * prompt 300 times. The number the Token stats card shows per bucket is
 * therefore the sum of that bucket's size AT EVERY REQUEST — not its current
 * size, which would always favour whatever arrived last.
 *
 * The naive way to get that is to rebuild the replayed list per request, which
 * is O(requests × events) and far too slow for a view that polls every 1.5 s
 * over a long session. Instead this walks the log ONCE and keeps a live block
 * map with per-bucket subtotals: a request snapshots those subtotals (8 adds)
 * plus the tool catalogue total, and shadowed sequences subtract their block
 * the moment compaction prunes them. That is O(events + requests × 8).
 *
 * Token sizes are ESTIMATES from the same character-count estimator as
 * `context-window.ts` (the provider never reports a per-block number), so the
 * card labels them approximate. The billed total, cache split and request
 * count come straight from `usage` records and are exact.
 */
import { messageTokens, toolTokens } from './context-window.ts'
import { USAGE_BUCKET_ORDER } from './usage-buckets.ts'
import type { UsageSessionEvent } from './context-types.ts'
import type { SessionUsageBucket, SessionUsageComposition, SessionUsageTotals } from './wire.ts'

/** One replayed message block (or a folded compaction summary). */
interface LiveBlock {
  bucket: SessionUsageBucket
  tokens: number
}

/** Shadowed sequences a compaction event removed from the replay list. */
function shadowedSeqs(data: any): number[] {
  const seqs: number[] = []
  for (const seq of Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs : []) seqs.push(Number(seq))
  const range = data?.shadowedRange
  if (typeof range?.start === 'number' && typeof range?.end === 'number') {
    for (let seq = range.start; seq <= range.end; seq++) seqs.push(seq)
  }
  return seqs
}

/**
 * Accumulate one session's own events into the eight legend buckets.
 *
 * Returns null for an empty log or a log whose requests never reported usage
 * (an older host writing no usage records) so the card can hide itself rather
 * than draw an empty ring.
 */
export function buildSessionUsageComposition(
  events: readonly UsageSessionEvent[],
): SessionUsageComposition | null {
  if (events.length === 0) return null
  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  /** Blocks still replayed by the next request, keyed by their event sequence. */
  const live = new Map<number, LiveBlock>()
  /** Current size of the replay list per bucket — what one request would send. */
  const liveByBucket = new Map<SessionUsageBucket, number>()
  /** What every request so far sent, summed per bucket. */
  const acc = new Map<SessionUsageBucket, number>()
  const totals: SessionUsageTotals = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let billed = 0
  let requests = 0
  /** Prompt tokens the newest request/header's tool catalogue costs. */
  let catalogue = 0

  const addBlock = (seq: number, bucket: SessionUsageBucket, tokens: number): void => {
    if (tokens <= 0) return
    live.set(seq, { bucket, tokens })
    liveByBucket.set(bucket, (liveByBucket.get(bucket) ?? 0) + tokens)
  }
  const dropBlock = (seq: number): void => {
    const block = live.get(seq)
    if (block === undefined) return
    live.delete(seq)
    liveByBucket.set(block.bucket, (liveByBucket.get(block.bucket) ?? 0) - block.tokens)
  }
  /** Charge one request for everything it replayed. */
  const snapshot = (): void => {
    for (const [bucket, tokens] of liveByBucket) {
      if (tokens > 0) acc.set(bucket, (acc.get(bucket) ?? 0) + tokens)
    }
    if (catalogue > 0) acc.set('toolDef', (acc.get('toolDef') ?? 0) + catalogue)
  }
  /** Fold the provider's exact report into the billed split. */
  const account = (usage: any): void => {
    const input = Number(usage?.inputTokens) || 0
    const cacheRead = Number(usage?.cacheReadTokens) || 0
    const cacheWrite = Number(usage?.cacheWriteTokens) || 0
    const output = Number(usage?.outputTokens) || 0
    totals.uncachedInputTokens += input
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += cacheWrite
    totals.outputTokens += output
    billed += input + cacheRead + cacheWrite + output
    requests++
    // Output never belongs to the replayed prompt, so it is not a live block;
    // it is charged straight to its own bucket.
    if (output > 0) acc.set('output', (acc.get('output') ?? 0) + output)
  }

  for (const event of ordered) {
    const data: any = event.data ?? {}
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      // The summary call itself carried the PRE-prune prompt, so it is charged
      // before the shadow set is applied — and before its own block lands.
      if (event.type === 'compaction/summary' && data.usage !== undefined && data.usage !== null) {
        snapshot()
        account(data.usage)
      }
      for (const seq of shadowedSeqs(data)) dropBlock(seq)
      if (event.type === 'compaction/summary') {
        addBlock(event.seq, 'injected', messageTokens({ content: data.summary }))
      }
      continue
    }
    if (event.type === 'request/header') {
      const header = data.header ?? {}
      if (Array.isArray(header.tools)) {
        catalogue = 0
        for (const tool of header.tools) catalogue += toolTokens(tool)
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (data.usage !== undefined && data.usage !== null) {
        snapshot()
        account(data.usage)
      }
      addBlock(event.seq, 'assistant', messageTokens(data.message ?? { content: data.content }))
      continue
    }
    if (event.type === 'system/message') {
      const kind = String(data.message?.source?.kind ?? data.source?.kind ?? 'system-prompt')
      const bucket: SessionUsageBucket = kind === 'system-prompt' ? 'systemPrompt' : 'injected'
      addBlock(event.seq, bucket, messageTokens(data.message ?? { content: data.content }))
      continue
    }
    if (event.type === 'user/message') {
      const kind = String(data.source?.kind ?? data.message?.source?.kind ?? 'user')
      const bucket: SessionUsageBucket = kind === 'user'
        ? 'user'
        : kind === 'skill-catalog' ? 'skill' : 'injected'
      addBlock(event.seq, bucket, messageTokens(data.message ?? { content: data.content }))
      continue
    }
    if (event.type === 'tool/result') {
      // A file read is still prompt payload; the reference card has no separate
      // "files" row, so it belongs with the rest of the tool results.
      addBlock(event.seq, 'toolResult', messageTokens(data.message ?? {}))
      continue
    }
  }

  if (requests === 0) return null
  return {
    buckets: USAGE_BUCKET_ORDER.map((key) => ({ key, tokens: Math.max(0, Math.round(acc.get(key) ?? 0)) })),
    billedTokens: billed,
    totals,
    requests,
  }
}

/** Add one tree's compositions into the root's, matching its other aggregates. */
export function mergeUsageCompositions(
  parts: ReadonlyArray<SessionUsageComposition | null | undefined>,
): SessionUsageComposition | null {
  const present = parts.filter((part): part is SessionUsageComposition => part !== null && part !== undefined)
  if (present.length === 0) return null
  const acc = new Map<SessionUsageBucket, number>()
  const totals: SessionUsageTotals = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  let billed = 0
  let requests = 0
  for (const part of present) {
    for (const bucket of part.buckets) acc.set(bucket.key, (acc.get(bucket.key) ?? 0) + bucket.tokens)
    totals.uncachedInputTokens += part.totals.uncachedInputTokens
    totals.cacheReadTokens += part.totals.cacheReadTokens
    totals.cacheWriteTokens += part.totals.cacheWriteTokens
    totals.outputTokens += part.totals.outputTokens
    billed += part.billedTokens
    requests += part.requests
  }
  return {
    buckets: USAGE_BUCKET_ORDER.map((key) => ({ key, tokens: acc.get(key) ?? 0 })),
    billedTokens: billed,
    totals,
    requests,
  }
}
