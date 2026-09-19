import * as git from "../git/git.js";
import { redact } from "../security/rules.js";
import type { FileSummary } from "./types.js";

/** One contiguous change inside a file. Line numbers refer to the ORIGINAL (HEAD) file. */
export interface Hunk {
  /** 1-based position within the file. */
  index: number;
  oldStart: number;
  oldCount: number;
  /** Replacement for the old range: unchanged context lines plus added lines, with terminators. */
  newLines: string[];
  additions: number;
  deletions: number;
  /** The hunk as shown in a diff, for the prompt and the review screen. */
  text: string;
}

/** A file that can be split: its HEAD content and its hunks. */
export interface HunkFile {
  file: string;
  base: string;
  hunks: Hunk[];
}

const HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;
const NO_NEWLINE = "\\ No newline at end of file";

export const unitId = (file: string, index: number) => `${file}#${index}`;

/** Splits text into lines that keep their terminator; the last one may have none. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Parses a unified diff of ONE file into hunks. Handles "\ No newline at end of file". */
export function parseHunks(diff: string): Hunk[] {
  const lines = diff.split("\n");
  const hunks: Hunk[] = [];
  let i = lines.findIndex((l) => HEADER_RE.test(l));
  if (i === -1) return hunks;

  while (i < lines.length) {
    const m = HEADER_RE.exec(lines[i]!);
    if (!m) {
      i++;
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const headerLine = lines[i]!;
    const body: string[] = [];
    i++;
    while (i < lines.length && !HEADER_RE.test(lines[i]!)) {
      // A trailing empty string comes from the final "\n" of the diff text, not from a real line.
      if (!(i === lines.length - 1 && lines[i] === "")) body.push(lines[i]!);
      i++;
    }

    const newLines: string[] = [];
    let additions = 0;
    let deletions = 0;
    let lastKind = "";
    for (const raw of body) {
      if (raw === NO_NEWLINE) {
        // The marker qualifies the line right before it; only new-side lines end up in the file.
        if (lastKind !== "-" && newLines.length) newLines[newLines.length - 1] = newLines[newLines.length - 1]!.replace(/\n$/, "");
        continue;
      }
      const kind = raw[0] ?? " ";
      lastKind = kind;
      if (kind === "+") {
        additions++;
        newLines.push(raw.slice(1) + "\n");
      } else if (kind === "-") deletions++;
      else newLines.push(raw.slice(1) + "\n"); // context
    }
    hunks.push({
      index: hunks.length + 1,
      oldStart,
      oldCount,
      newLines,
      additions,
      deletions,
      text: [headerLine, ...body].join("\n"),
    });
  }
  return hunks;
}

/** Applies the chosen hunks to the original text. Unchosen changes stay as they were in `base`. */
export function applyHunks(base: string, hunks: Hunk[]): string {
  const lines = splitLines(base);
  // Bottom-up so earlier line numbers stay valid while splicing.
  for (const h of [...hunks].sort((a, b) => b.oldStart - a.oldStart)) {
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    lines.splice(start, h.oldCount, ...h.newLines);
  }
  return lines.join("");
}

const isUtf8 = (buf: Buffer) => Buffer.from(buf.toString("utf8")).equals(buf);

export interface HunkOptions {
  maxHunksPerFile?: number;
  maxUnits?: number;
}

/**
 * Replaces eligible modified files with one summary per hunk ("path#N"). A file is only split
 * when applying ALL its hunks to the HEAD text reproduces the staged text exactly; otherwise it
 * stays a whole-file unit, so a parsing surprise can never corrupt a commit.
 */
export async function buildHunkUnits(
  summaries: FileSummary[],
  staged: Map<string, git.TreeEntry>,
  opts: HunkOptions = {},
): Promise<{ summaries: FileSummary[]; files: Map<string, HunkFile> }> {
  const { maxHunksPerFile = 30, maxUnits = 120 } = opts;
  const files = new Map<string, HunkFile>();
  const out: FileSummary[] = [];
  let units = summaries.length;

  for (const s of summaries) {
    const eligible =
      s.status === "M" && !s.orig && !s.binary && !s.withheld && !["lock", "generated", "asset"].includes(s.kind) && s.additions + s.deletions > 0;
    const entry = staged.get(s.path);
    if (!eligible || !entry || units >= maxUnits) {
      out.push(s);
      continue;
    }

    const split = await tryHunks(s.path, entry, maxHunksPerFile);
    if (!split || units - 1 + split.hunks.length > maxUnits) {
      out.push(s);
      continue;
    }
    files.set(s.path, split);
    units += split.hunks.length - 1;
    for (const h of split.hunks) {
      out.push({
        path: unitId(s.path, h.index),
        file: s.path,
        hunk: h.index,
        status: "M",
        additions: h.additions,
        deletions: h.deletions,
        binary: false,
        kind: s.kind,
        diff: redact(h.text).slice(0, 4000),
      });
    }
  }
  return { summaries: out, files };
}

async function tryHunks(path: string, entry: git.TreeEntry, maxHunks: number): Promise<HunkFile | null> {
  try {
    const [baseBuf, stagedBuf] = await Promise.all([git.headBlob(path), git.catBlob(entry.sha)]);
    if (!baseBuf || !isUtf8(baseBuf) || !isUtf8(stagedBuf)) return null;
    const hunks = parseHunks(await git.stagedHunkDiff(path));
    if (hunks.length < 2 || hunks.length > maxHunks) return null;
    const base = baseBuf.toString("utf8");
    if (applyHunks(base, hunks) !== stagedBuf.toString("utf8")) return null;
    return { file: path, base, hunks };
  } catch {
    return null;
  }
}
