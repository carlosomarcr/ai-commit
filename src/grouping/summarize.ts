import * as git from "../git/git.js";
import { classify } from "./heuristics.js";
import type { FileSummary } from "./types.js";

export interface SummarizeOptions {
  /** Max files whose diff content is fetched; the rest are described by counts only. */
  maxDiffFiles?: number;
  /** Max chars kept per file diff. */
  perFileCap?: number;
}

const NO_CONTENT = new Set(["lock", "generated", "asset"]);

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** Builds per-file summaries from the index: one numstat call plus a bounded number of diffs. */
export async function collectSummaries(files: git.ChangedFile[], opts: SummarizeOptions = {}): Promise<FileSummary[]> {
  const { maxDiffFiles = 80, perFileCap = 6000 } = opts;
  const stats = new Map((await git.stagedNumstat()).map((e) => [e.path, e]));

  const summaries: FileSummary[] = files.map((f) => {
    const st = stats.get(f.path);
    return {
      path: f.path,
      orig: f.orig,
      status: f.index,
      additions: st?.additions ?? 0,
      deletions: st?.deletions ?? 0,
      binary: st?.binary ?? false,
      kind: classify(f.path),
    };
  });

  // Small diffs first: they carry the most signal per character.
  const wanted = summaries
    .filter((s) => !s.binary && !NO_CONTENT.has(s.kind))
    .sort((a, b) => a.additions + a.deletions - (b.additions + b.deletions))
    .slice(0, maxDiffFiles);
  await mapLimit(wanted, 8, async (s) => {
    s.diff = (await git.stagedFileDiff([s.path, ...(s.orig ? [s.orig] : [])])).slice(0, perFileCap);
  });
  return summaries;
}

export function renderStat(summaries: FileSummary[]): string {
  return summaries
    .map((s) => {
      const name = s.orig ? `${s.orig} -> ${s.path}` : s.path;
      return `${s.status} ${name} (+${s.additions} -${s.deletions})${s.binary ? " [binary]" : ""}`;
    })
    .join("\n");
}

/** Concatenates diffs within a char budget, sharing it fairly so one huge file can't starve the rest. */
export function renderDiffs(summaries: FileSummary[], budget: number): string {
  const withDiff = summaries.filter((s) => s.diff);
  const lengths = withDiff.map((s) => s.diff!.length).sort((a, b) => a - b);
  // Fair share: small files keep everything, their unused budget flows to bigger ones.
  let remaining = budget;
  let cap = 0;
  lengths.forEach((len, i) => {
    const share = Math.floor(remaining / (lengths.length - i));
    cap = share;
    remaining -= Math.min(len, share);
  });

  const parts = summaries.map((s) => {
    if (!s.diff) {
      const why = s.binary ? "binary" : s.kind === "lock" ? "lockfile" : s.kind === "generated" ? "generated" : "omitted for size";
      return `### ${s.path}\n(${why}, +${s.additions} -${s.deletions}; content not shown)`;
    }
    const text = s.diff.length > cap ? `${s.diff.slice(0, cap)}\n[truncated]` : s.diff;
    return `### ${s.path}\n${text}`;
  });
  return parts.join("\n\n");
}
