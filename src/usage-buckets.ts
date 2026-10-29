/**
 * The legend order of the Token stats card, shared by the host accumulator and
 * the client card so the two halves can never disagree about which bucket sits
 * where. Left column first (what filled the prompt), right column second: the
 * layout mirrors the reference design — system/user/skill/results on the left,
 * tool definitions/injected/assistant/output on the right.
 *
 * Kept in its own dependency-free module: the host builds the numbers and the
 * client paints them, and neither should pull the other's graph in for this.
 */
import type { SessionUsageBucket } from './wire.ts'

export const USAGE_BUCKET_ORDER: readonly SessionUsageBucket[] = [
  'systemPrompt',
  'user',
  'skill',
  'toolResult',
  'toolDef',
  'injected',
  'assistant',
  'output',
]

/** The buckets that describe the live window (output never occupies it). */
export const CONTEXT_BUCKET_ORDER: readonly SessionUsageBucket[] = USAGE_BUCKET_ORDER.filter(
  (key) => key !== 'output',
)
