import * as git from "../git/git.js";
import { formatMessage } from "../commit/generate.js";
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

/** All paths a group touches, including the old side of renames. */
function pathsFor(group: CommitGroup, summaries: FileSummary[]): string[] {
  const out = new Set<string>();
  for (const f of group.files) {
    out.add(f);
    const orig = summaries.find((s) => s.path === f)?.orig;
    if (orig) out.add(orig);
  }
  return [...out];
}

async function stageFromTree(paths: string[], tree: Map<string, git.TreeEntry>): Promise<void> {
  await git.setIndexEntries(paths.map((path) => ({ path, entry: tree.get(path) ?? null })));
}

/**
 * Commits each group in order, using only index plumbing: for every group the index is rebuilt as
 * HEAD plus that group's files taken from `fullTree`. The working tree is never touched, and
 * paths never go through a shell.
 */
export async function executePlan(groups: CommitGroup[], ctx: ExecuteContext, hooks: ExecuteHooks): Promise<ExecuteResult> {
  const tree = await git.lsTree(ctx.fullTree);
  const result: ExecuteResult = { committed: [], skipped: [], aborted: false };

  // Keep what was already committed; put the user's original staging back for what is left.
  const abort = async (from: number): Promise<ExecuteResult> => {
    const rest = groups.slice(from).flatMap((g) => pathsFor(g, ctx.summaries));
    await git.resetIndexToHead();
    await stageFromTree(rest, await git.lsTree(ctx.origTree));
    result.aborted = true;
    return result;
  };

  for (const [i, group] of groups.entries()) {
    if (hooks.shouldStop?.()) return abort(i);
    hooks.onStart?.(group, i, groups.length);
    const paths = pathsFor(group, ctx.summaries);

    for (;;) {
      await git.resetIndexToHead();
      await stageFromTree(paths, tree);
      if (!(await git.hasStagedChanges())) {
        hooks.onEmpty?.(group);
        result.skipped.push(group);
        break;
      }
      try {
        const hash = await git.commit(formatMessage(group.message));
        result.committed.push({ group, hash });
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
  if (ctx.restoreSkipped) {
    await stageFromTree(
      [...result.skipped, ...(ctx.leftover ?? [])].flatMap((g) => pathsFor(g, ctx.summaries)),
      tree,
    );
  }
  return result;
}
