/**
 * Context-window composition: what the session's NEXT provider call carries.
 *
 * The panel above the Usage cards answers "what is inside the window right
 * now", which is not what the log accumulated. So this walks one session's own
 * events (fork-inherited ones never reach here) and rebuilds the message list a
 * live request would replay:
 * - `compaction/prune` / `compaction/summary` shadowed sequences drop out — the
 *   compacted turn is gone from the request, not merely folded in the store;
 * - a compaction summary stands in for the range it replaced, as injected
 *   memory rather than conversation (the model never wrote it);
 * - the tool catalogue is the NEWEST `request/header`'s list, since that is the
 *   set the next call will send;
 * - file reads group by path and the remaining tool results by tool name, so a
 *   session that ran `pwsh` sixty times shows one block with its call count.
 *
 * Token counts are ESTIMATES from character counts: the host's own estimator
 * bills ASCII at four characters per token, while CJK text bills closer to one
 * token per character, so both rates are applied per character class and every
 * figure is presented as approximate. Exact counts are unavailable here — the
 * provider only reports a whole-prompt number after the call — but that billed
 * number IS exact for the request it answered, so it ships alongside the
 * estimate (`promptTokens`) and the panel prints it as the used total whenever
 * the log has one. The two disagree when something upstream rewrites the prompt
 * (a compression plugin, a gateway that trims history), because the stored log
 * then holds more text than the model was ever billed for.
 */
import type { UsageSessionEvent } from './context-types.ts'
import type {
  SessionContextCategory,
  SessionContextItem,
  SessionContextWindow,
} from './wire.ts'

/** ASCII-ish characters per token (the host estimator's ratio). */
const ASCII_CHARS_PER_TOKEN = 4
/** Wide (CJK, kana, hangul) characters per token: these bill ~1 token/char. */
const WIDE_CHARS_PER_TOKEN = 1.5
/** A supplementary-plane emoji is worth a few wide characters. */
const EMOJI_TOKEN_EQUIVALENT = 3
/** Serialized JSON punctuation/keys cost a token or two per schema node. */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 8
/** Per-message framing the provider bills on top of the content. */
const MESSAGE_OVERHEAD_TOKENS = 4
/** A rendered image is billed in tiles, not characters. */
const IMAGE_TOKENS = 1_100
/** A category keeps its biggest rows until this share of its tokens is covered. */
const KEEP_SHARE = 0.85
/** Hard cap on rows kept per category before the rest folds into one block. */
const MAX_ROWS_PER_CATEGORY = 10
/** Tool names whose results are file payloads (they group by path). */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebook_read', 'notebook_edit'])
/** Legend/treemap order; also the tie-break for equal-sized rows. */
const CATEGORY_ORDER: readonly SessionContextCategory[] = ['system', 'tools', 'memory', 'files', 'results', 'conversation']

/** Approximate token count of one string (see the header comment). */
export function estimateTokens(text: string): number {
  if (text === '') return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    // Astral pictographs (emoji) bill like a short word, not like one glyph;
    // the rest of the supplementary plane is CJK ideographs, which bill wide.
    if (code >= 0x1f000 && code <= 0x1faff) wide += EMOJI_TOKEN_EQUIVALENT
    else if (code < 0x2e80) ascii++
    else wide++
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN)
}

/** Approximate tokens of any JSON-ish value, counting its strings only. */
function valueTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTokens(value)
  if (typeof value === 'number' || typeof value === 'boolean') return 1
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + valueTokens(item), 0)
  if (value !== null && typeof value === 'object') {
    let sum = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // Replay/thinking signatures are opaque provider bookkeeping: the model
      // is not re-sent that text, so counting it would inflate every answer.
      if (key === 'replayState' || key === 'thinkingSignature' || key === 'textSignature') continue
      sum += valueTokens(item)
    }
    return sum
  }
  return 0
}

/** Approximate tokens of one replayed message (content + framing). */
export function messageTokens(message: unknown): number {
  const content = (message as { content?: unknown } | null | undefined)?.content
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
  let sum = MESSAGE_OVERHEAD_TOKENS
  for (const block of blocks) {
    const kind = (block as { type?: unknown } | null)?.type
    if (kind === 'image' || kind === 'image-url') { sum += IMAGE_TOKENS; continue }
    // A text block's `type` discriminator is chat framing, not content: counting
    // the literal string "text" would add a phantom token to every block.
    if (kind === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      sum += valueTokens((block as { text: unknown }).text)
      continue
    }
    sum += valueTokens(block)
  }
  return sum
}

interface Draft {
  category: SessionContextCategory
  kind?: string
  label: string
  count: number
  tokens: number
}

interface CompactionSummary {
  seq: number
  tokens: number
}

/** Prompt tokens one answer actually sent, as the provider billed it: its total
 *  minus the output it generated, or the uncached plus cached input when the
 *  provider reported no total. Null when there is no usage at all. */
function promptTokensOf(usage: unknown): number | null {
  const record = usage as { totalTokens?: unknown; outputTokens?: unknown; inputTokens?: unknown; cacheReadTokens?: unknown } | null | undefined
  const total = Number(record?.totalTokens) || 0
  const output = Number(record?.outputTokens) || 0
  if (total > output) return total - output
  const input = Number(record?.inputTokens) || 0
  const cached = Number(record?.cacheReadTokens) || 0
  return input + cached > 0 ? input + cached : null
}

/** Prompt tokens one tool definition costs: its name, description and JSON
 *  schema, plus the framing every schema node pays. 0 for a nameless entry.
 *  Shared with the spend composition, which replays the same catalogue on
 *  every request. */
export function toolTokens(tool: unknown): number {
  const record = tool as { name?: unknown; description?: unknown; parameters?: unknown }
  const name = String(record?.name ?? '')
  if (name === '') return 0
  return estimateTokens(name) + valueTokens(record?.description)
    + estimateTokens(JSON.stringify(record?.parameters ?? {})) + TOOL_SCHEMA_OVERHEAD_TOKENS
}

/** Fold one category's rows: keep the biggest until KEEP_SHARE is covered (and
 *  never more than MAX_ROWS_PER_CATEGORY), then merge the tail into one row so
 *  a session with 200 tool calls still yields a readable treemap. */
function foldDrafts(drafts: Draft[]): SessionContextItem[] {
  const items: SessionContextItem[] = []
  for (const category of CATEGORY_ORDER) {
    const rows = drafts.filter(row => row.category === category).sort((a, b) => b.tokens - a.tokens)
    if (rows.length === 0) continue
    const total = rows.reduce((sum, row) => sum + row.tokens, 0)
    const kept: Draft[] = []
    let covered = 0
    for (const row of rows) {
      if (kept.length >= MAX_ROWS_PER_CATEGORY) break
      if (kept.length > 0 && covered >= total * KEEP_SHARE) break
      kept.push(row)
      covered += row.tokens
    }
    const folded = rows.slice(kept.length)
    for (const row of kept) {
      items.push({ key: `${category}:${row.kind ?? row.label}`, category, ...(row.kind === undefined ? {} : { kind: row.kind }), label: row.label, count: row.count, tokens: row.tokens })
    }
    if (folded.length > 0) {
      items.push({
        key: `${category}:rest`,
        category,
        kind: 'rest',
        label: '',
        count: folded.length,
        tokens: folded.reduce((sum, row) => sum + row.tokens, 0),
      })
    }
  }
  return items.sort((a, b) => b.tokens - a.tokens || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
}

/** Build the context-window snapshot from one session's own events. Returns
 *  null for an empty log so the panel can hide itself. */
export function buildSessionContextWindow(events: readonly UsageSessionEvent[]): SessionContextWindow | null {
  if (events.length === 0) return null
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  // ── Pass 1: the state the current request is derived from ────────────────
  const shadowed = new Set<number>()
  const summaries: CompactionSummary[] = []
  const callNames = new Map<string, string>()
  let tools: unknown[] = []
  let headerRoute: { provider: string; model: string } | null = null
  let route: { provider: string; model: string; contextWindow: number | null } | null = null
  let cache: { hit: number; miss: number } | null = null
  /** What the newest answer actually sent, which is what the window holds now. */
  let billed: number | null = null
  for (const event of ordered) {
    const data: any = event.data ?? {}
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      for (const seq of Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []) shadowed.add(Number(seq))
      const range = data.shadowedRange
      if (typeof range?.start === 'number' && typeof range?.end === 'number') {
        for (let seq = range.start; seq <= range.end; seq++) shadowed.add(seq)
      }
      if (event.type === 'compaction/summary') {
        summaries.push({ seq: event.seq, tokens: messageTokens({ content: data.summary }) })
        const usage = data.usage
        if (usage) {
          cache = { hit: Number(usage.cacheReadTokens) || 0, miss: (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0) }
          const summaryBilled = promptTokensOf(usage)
          if (summaryBilled !== null) billed = summaryBilled
        }
      }
      continue
    }
    if (event.type === 'tool/call' && typeof data.callId === 'string') {
      callNames.set(data.callId, String(data.name ?? ''))
      continue
    }
    if (event.type === 'request/header') {
      const header = data.header ?? {}
      if (Array.isArray(header.tools)) tools = header.tools
      const config = header.config ?? {}
      if (typeof config.provider === 'string' || typeof config.model === 'string') {
        headerRoute = { provider: String(config.provider ?? ''), model: String(config.model ?? '') }
      }
      continue
    }
    if (event.type === 'request/context') {
      route = {
        provider: String(data.provider ?? ''),
        model: String(data.model ?? ''),
        contextWindow: typeof data.contextWindow === 'number' && data.contextWindow > 0 ? data.contextWindow : null,
      }
      continue
    }
    if (event.type === 'assistant/message' && data.usage) {
      const usage = data.usage
      cache = { hit: Number(usage.cacheReadTokens) || 0, miss: (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0) }
      billed = promptTokensOf(usage)
    }
  }
  // ── Pass 2: every event still replayed into the window ───────────────────
  const drafts = new Map<string, Draft>()
  const add = (category: SessionContextCategory, label: string, tokens: number, kind?: string): void => {
    const key = `${category}\u0000${kind ?? ''}\u0000${label}`
    const draft = drafts.get(key)
    if (draft === undefined) drafts.set(key, { category, ...(kind === undefined ? {} : { kind }), label, count: 1, tokens })
    else { draft.count++; draft.tokens += tokens }
  }
  for (const event of ordered) {
    if (shadowed.has(event.seq)) continue
    const data: any = event.data ?? {}
    switch (event.type) {
      case 'system/message': {
        const kind = String(data.message?.source?.kind ?? data.source?.kind ?? 'system-prompt')
        const category: SessionContextCategory = kind === 'system-prompt' ? 'system' : 'memory'
        add(category, '', messageTokens(data.message ?? { content: data.content }), kind)
        break
      }
      case 'user/message': {
        const kind = String(data.source?.kind ?? data.message?.source?.kind ?? 'user')
        const message = data.message ?? { content: data.content }
        if (kind === 'user') add('conversation', '', messageTokens(message), 'user')
        else add('memory', '', messageTokens(message), kind)
        break
      }
      case 'assistant/message': {
        add('conversation', '', messageTokens(data.message ?? { content: data.content }), 'assistant')
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = String(message.toolCallId ?? message.source?.callId ?? '')
        const name = callNames.get(callId) ?? ''
        const path = typeof data.meta?.path === 'string' ? data.meta.path : ''
        const tokens = messageTokens(message)
        // A file read is a file payload: several reads of one path are one
        // block. Everything else groups by the tool that produced it.
        if (path !== '' && (FILE_TOOLS.has(name) || name === '')) add('files', path, tokens)
        else add('results', name === '' ? 'tool' : name, tokens)
        break
      }
      default:
        break
    }
  }
  // A compaction summary replaced a pruned range: it is replayed in its place.
  for (const summary of summaries) {
    if (summary.tokens > 0) add('memory', '', summary.tokens, 'compaction-summary')
  }
  // The tool catalogue the next call sends: name + description + JSON schema.
  for (const tool of tools) {
    const tokens = toolTokens(tool)
    const name = String((tool as { name?: unknown })?.name ?? '')
    if (name === '' || tokens === 0) continue
    add('tools', name, tokens)
  }
  const items = foldDrafts([...drafts.values()])
  const totalTokens = items.reduce((sum, item) => sum + item.tokens, 0)
  return {
    totalTokens,
    contextWindow: route?.contextWindow ?? null,
    provider: route?.provider || headerRoute?.provider || '',
    model: route?.model || headerRoute?.model || '',
    cacheHitTokens: cache?.hit ?? 0,
    cacheMissTokens: cache?.miss ?? 0,
    cacheKnown: cache !== null,
    promptTokens: billed,
    items,
  }
}
