export interface ContextPressureLike {
  projectedTokens?: number
  pressureTokens?: number
  contextWindow?: number
}

export interface ContextBreakdownLike {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/** Mirrors the host meter's occupancy calculation exactly. */
export function contextOccupancy(pressure: ContextPressureLike | undefined): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

export function contextBreakdownTotal(breakdown: ContextBreakdownLike | undefined): number {
  return breakdown === undefined ? 0 : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
}

export function contextBreakdownSegments(
  percent: number,
  breakdown: ContextBreakdownLike | undefined,
): Array<{ key: string; width: number }> {
  const total = contextBreakdownTotal(breakdown)
  if (breakdown === undefined || total === 0) return [{ key: 'total', width: percent }]
  return [
    { key: 'systemTokens', width: percent * breakdown.systemTokens / total },
    { key: 'toolsTokens', width: percent * breakdown.toolsTokens / total },
    { key: 'messageTokens', width: percent * breakdown.messageTokens / total },
  ].filter(segment => segment.width > 0)
}

export function formatContextTokens(value: number, units: { thousand: string; million: string }): string {
  const scaled = (candidate: number): string => candidate >= 100
    ? String(Math.round(candidate))
    : String(Math.round(candidate * 10) / 10)
  if (value < 1e3) return String(value)
  if (value < 1e6) return units.thousand.replace('{value}', scaled(value / 1e3))
  return units.million.replace('{value}', scaled(value / 1e6))
}
