/**
 * Pure helpers behind the context-window panel: the treemap squarifier, the
 * per-category roll-up the legend prints, and the occupancy reading. Kept
 * separate from the component so both are testable without a DOM.
 */
import type { SessionContextCategory, SessionContextItem, SessionContextWindow } from '../wire.ts'

/** Legend order, also the color assignment order (see the CSS module). */
export const CONTEXT_CATEGORY_ORDER: readonly SessionContextCategory[] = [
  'system', 'tools', 'memory', 'files', 'results', 'conversation',
]

/** One positioned treemap block in container pixels. */
export interface TreemapBox {
  key: string
  x: number
  y: number
  width: number
  height: number
}

/** Per-category token totals in legend order, empty categories dropped. */
export function contextCategoryTotals(
  items: readonly SessionContextItem[],
): Array<{ key: SessionContextCategory; tokens: number }> {
  const totals = new Map<SessionContextCategory, number>()
  for (const item of items) totals.set(item.category, (totals.get(item.category) ?? 0) + item.tokens)
  return CONTEXT_CATEGORY_ORDER
    .map(key => ({ key, tokens: totals.get(key) ?? 0 }))
    .filter(row => row.tokens > 0)
}

/** Window occupancy in whole percent, or null when the host never reported the
 *  model's window (the panel then says "unknown" instead of guessing one). */
export function contextWindowPercent(usedTokens: number, contextWindow: number | null): number | null {
  if (contextWindow === null || !(contextWindow > 0) || !(usedTokens >= 0)) return null
  return Math.min(100, Math.round(usedTokens / contextWindow * 100))
}

/** How much the replay estimate may drift from the billed prompt before the
 *  panel stops treating them as the same number (rounding, framing tokens). */
export const CONTEXT_ESTIMATE_TOLERANCE = 0.15

/** One reading of the snapshot for the headline: the billed prompt when the log
 *  has one (exact), else the replay estimate. `estimateDiffers` marks the case
 *  where the log carries text the model was never billed for — an upstream
 *  compression plugin, say — so the panel can explain a treemap that sums
 *  higher than the total. */
export interface ContextReading {
  usedTokens: number
  percent: number | null
  estimateTokens: number
  estimateDiffers: boolean
}

export function contextReading(context: SessionContextWindow): ContextReading {
  const estimateTokens = context.totalTokens
  const usedTokens = context.promptTokens ?? estimateTokens
  const gap = estimateTokens > 0 ? Math.abs(estimateTokens - usedTokens) / Math.max(estimateTokens, usedTokens) : 0
  return {
    usedTokens,
    percent: contextWindowPercent(usedTokens, context.contextWindow),
    estimateTokens,
    estimateDiffers: context.promptTokens !== null && gap > CONTEXT_ESTIMATE_TOLERANCE,
  }
}

/** Aspect ratio of the worst tile in a row of `sum` area, given the strip's
 *  short side — the squarified-treemap cost function. */
function worstRatio(sum: number, max: number, min: number, side: number): number {
  const squared = sum * sum
  const sideSquared = side * side
  return Math.max((sideSquared * max) / squared, squared / (sideSquared * min))
}

const round = (value: number): number => Math.round(value * 100) / 100

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): tile `width`×`height` with
 * one block per positive weight, proportional to its tokens and as close to
 * square as the greedy row packing allows. Blocks come back in the input's
 * descending-weight order, covering the whole area.
 */
export function treemapLayout(
  rows: ReadonlyArray<{ key: string; tokens: number }>,
  width: number,
  height: number,
): TreemapBox[] {
  const ordered = rows.filter(row => row.tokens > 0 && Number.isFinite(row.tokens)).sort((a, b) => b.tokens - a.tokens)
  if (ordered.length === 0 || !(width > 0) || !(height > 0)) return []
  const total = ordered.reduce((sum, row) => sum + row.tokens, 0)
  const scale = (width * height) / total
  const areas = ordered.map(row => ({ key: row.key, area: row.tokens * scale }))
  const boxes: TreemapBox[] = []
  let x = 0
  let y = 0
  let w = width
  let h = height
  let index = 0
  while (index < areas.length) {
    const side = Math.min(w, h)
    if (!(side > 0)) break
    // Grow one row while the worst aspect ratio keeps improving.
    let end = index + 1
    let sum = areas[index]!.area
    let max = sum
    let min = sum
    let worst = worstRatio(sum, max, min, side)
    while (end < areas.length) {
      const area = areas[end]!.area
      const nextSum = sum + area
      const nextMax = Math.max(max, area)
      const nextMin = Math.min(min, area)
      const nextWorst = worstRatio(nextSum, nextMax, nextMin, side)
      if (nextWorst > worst) break
      sum = nextSum
      max = nextMax
      min = nextMin
      worst = nextWorst
      end++
    }
    const thickness = sum / side
    if (!(thickness > 0)) break
    let offset = 0
    for (let k = index; k < end; k++) {
      const length = areas[k]!.area / thickness
      const box = w >= h
        ? { key: areas[k]!.key, x, y: y + offset, width: thickness, height: length }
        : { key: areas[k]!.key, x: x + offset, y, width: length, height: thickness }
      boxes.push({ key: box.key, x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) })
      offset += length
    }
    if (w >= h) { x += thickness; w -= thickness } else { y += thickness; h -= thickness }
    index = end
  }
  return boxes
}
