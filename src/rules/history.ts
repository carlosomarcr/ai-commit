import type { HistoryStats } from "./types.js";

const CONVENTIONAL_RE = /^(\w+)(\(([^)]+)\))?!?: .+/;

export function analyzeHistory(subjects: string[]): HistoryStats | null {
  const real = subjects.filter((s) => !/^(Merge|Revert ")/.test(s));
  if (real.length === 0) return null;

  const typeCount = new Map<string, number>();
  let conventional = 0;
  let scoped = 0;
  for (const s of real) {
    const m = CONVENTIONAL_RE.exec(s);
    if (!m) continue;
    conventional++;
    if (m[3]) scoped++;
    typeCount.set(m[1]!, (typeCount.get(m[1]!) ?? 0) + 1);
  }
  const topTypes = [...typeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);
  return {
    count: real.length,
    conventionalRatio: conventional / real.length,
    scopeRatio: conventional ? scoped / conventional : 0,
    avgLength: Math.round(real.reduce((n, s) => n + s.length, 0) / real.length),
    topTypes,
  };
}
