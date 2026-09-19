import * as git from "../git/git.js";
import { formatMessage } from "../commit/generate.js";
import { applyHunks, type HunkFile } from "./hunks.js";
import type { CommitGroup, FileSummary } from "./types.js";

export interface ExecuteContext {
  /** Tree of the fully staged index (everything in scope). Each commit takes its files from here. */
  fullTree: string;
  /** Tree of the index as the user left it; used to restore their staging on abort. */
  origTree: string;
  summaries: FileSummary[];
  /** Put skipped groups back into the index at the end (when the user had staged them on purpose). */
  restoreSkipped: boolean;
  /** Groups the user chose to skip before committing; treated like skipped ones at the end. */
  leftover?: CommitGroup[];
  /** Files that were split into hunks (`--hunks`); their units look like "path#2". */
  hunkFiles?: Map<string, HunkFile>;
}

export type FailureDecision = "retry" | "skip" | "abort";

export interface ExecuteHooks {
  onStart?(group: CommitGroup, index: number, total: number): void;
  onCommitted?(group: CommitGroup, hash: string): void;
  onEmpty?(group: CommitGroup): void;
  /** Checked before each commit; returning true stops the run cleanly (e.g. after Ctrl+C). */
  shouldStop?(): boolean;
  /** Called when git refuses a commit (usually a hook). Decides what to do next. */
  onFailure(group: CommitGroup, error: git.GitError): Promise<FailureDecision>;
}

export interface ExecuteResult {
  committed: { group: CommitGroup; hash: string }[];
  skipped: CommitGroup[];
  aborted: boolean;
}

/** A group's units split into whole files (with the old side of renames) and hunks per file. */
function splitUnits(groups: CommitGroup[], summaries: FileSummary[]): { whole: string[]; hunks: Map<string, string[]> } {
  const whole = new Set<string>();
  const hunks = new Map<string, string[]>();
  for (const g of groups) {
    for (const unit of g.files) {
      const s = summaries.find((x) => x.path === unit);
      if (s?.file) hunks.set(s.file, [...(hunks.get(s.file) ?? []), unit]);
      else {
        whole.add(unit);
        if (s?.orig) whole.add(s.orig);
      }
    }
  }
  return { whole: [...whole], hunks };
}

/**
 * Commits each group in order, using only index plumbing: for every group the index is rebuilt as
 * HEAD plus that group's files taken from `fullTree`. The working tree is never touched, and
 * paths never go through a shell. Files split into hunks get a blob built from the original text
 * plus every hunk committed so far (line numbers always refer to that original).
 */
export async function executePlan(groups: CommitGroup[], ctx: ExecuteContext, hooks: ExecuteHooks): Promise<ExecuteResult> {
  const tree = await git.lsTree(ctx.fullTree);
  const result: ExecuteResult = { committed: [], skipped: [], aborted: false };
  const applied = new Set<string>(); // hunk units already committed

  const stageWhole = (paths: string[], from: Map<string, git.TreeEntry>) =>
    git.setIndexEntries(paths.map((path) => ({ path, entry: from.get(path) ?? null })));

  /** Puts `file` in the index with exactly the chosen hunks applied to its original text. */
  const stageHunkFile = async (file: string, units: Set<string>) => {
    const hf = ctx.hunkFiles?.get(file);
    const entry = tree.get(file);
    if (!hf || !entry) return;
    const selected = hf.hunks.filter((h) => units.has(`${file}#${h.index}`));
    if (selected.length === hf.hunks.length) return git.setIndexEntries([{ path: file, entry }]);
    const sha = await git.hashObject(applyHunks(hf.base, selected));
    return git.setIndexEntries([{ path: file, entry: { mode: entry.mode, sha } }]);
  };

  const stageGroup = async (group: CommitGroup) => {
    const { whole, hunks } = splitUnits([group], ctx.summaries);
    await stageWhole(whole, tree);
    for (const [file, units] of hunks) await stageHunkFile(file, new Set([...applied, ...units]));
  };

  /** Re-stages `pending` groups exactly as the user had them staged (only meaningful for staged scope). */
  const restore = async (pending: CommitGroup[], source: Map<string, git.TreeEntry>) => {
    const { whole, hunks } = splitUnits(pending, ctx.summaries);
    await stageWhole(whole, source);
    if (ctx.restoreSkipped) for (const [file, units] of hunks) await stageHunkFile(file, new Set([...applied, ...units]));
  };

  // Keep what was already committed; put the user's original staging back for what is left.
  const abort = async (from: number): Promise<ExecuteResult> => {
    await git.resetIndexToHead();
    await restore(groups.slice(from), await git.lsTree(ctx.origTree));
    result.aborted = true;
    return result;
  };

  for (const [i, group] of groups.entries()) {
    if (hooks.shouldStop?.()) return abort(i);
    hooks.onStart?.(group, i, groups.length);

    for (;;) {
      await git.resetIndexToHead();
      await stageGroup(group);
      if (!(await git.hasStagedChanges())) {
        hooks.onEmpty?.(group);
        result.skipped.push(group);
        break;
      }
      try {
        const hash = await git.commit(formatMessage(group.message));
        result.committed.push({ group, hash });
        for (const unit of group.files) applied.add(unit);
        hooks.onCommitted?.(group, hash);
        break;
      } catch (err) {
        const decision = await hooks.onFailure(group, err instanceof git.GitError ? err : new git.GitError(String(err)));
        if (decision === "retry") continue;
        if (decision === "skip") {
          result.skipped.push(group);
          break;
        }
        return abort(i);
      }
    }
  }

  await git.resetIndexToHead();
  if (ctx.restoreSkipped) await restore([...result.skipped, ...(ctx.leftover ?? [])], tree);
  return result;
}
