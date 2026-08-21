import type { GroupStat, ScoringOptions } from "../src/index.ts";
import { DEFAULT_ERROR_RATE_CAP, DEFAULT_PRICE_BAND } from "../src/index.ts";

export const NOW = Date.parse("2026-07-26T14:11:00Z");

export function stat(partial: Partial<GroupStat> & { groupId: number }): GroupStat {
  return {
    code: `G${partial.groupId}`,
    platform: "openai",
    rateMultiplier: 0.1,
    avgTtftMs: 3000,
    sampleCount: 20,
    lastSampleAt: new Date(NOW - 60_000).toISOString(),
    ...partial,
  };
}

export function opts(partial?: Partial<ScoringOptions>): ScoringOptions {
  return {
    mode: "balanced",
    model: undefined,
    modelBlockedGroupIds: [],
    accountPoolFilterActive: false,
    priceBand: { ...DEFAULT_PRICE_BAND },
    blacklist: [],
    errorRateCap: DEFAULT_ERROR_RATE_CAP,
    platform: "openai",
    now: NOW,
    ...partial,
  };
}
