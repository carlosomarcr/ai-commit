import { execa } from "execa";

export interface ChangedFile {
  path: string;
  /** Index (staged) status letter, " " if none. */
  index: string;
  /** Worktree (unstaged) status letter, " " if none. */
  worktree: string;
}

export class GitError extends Error {}

async function git(args: string[], opts: { cwd?: string; reject?: boolean } = {}) {
  try {
    return await execa("git", args, { cwd: opts.cwd, reject: opts.reject ?? true });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError((e.stderr || e.message).trim());
  }
}

export async function isRepo(cwd?: string): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], { cwd, reject: false }).catch(() => null);
  return r?.stdout.trim() === "true";
}

export async function root(): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"])).stdout.trim();
}

export async function currentBranch(): Promise<string> {
  const r = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

export async function status(): Promise<ChangedFile[]> {
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = r.stdout.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const index = entry[0]!;
    const worktree = entry[1]!;
    files.push({ path: entry.slice(3), index: index === "?" ? " " : index, worktree });
    // Renames/copies are followed by the original path as a separate entry.
    if (index === "R" || index === "C") i++;
  }
  return files;
}

export const isStaged = (f: ChangedFile) => f.index !== " " && f.worktree !== "?";

export async function stageAll(): Promise<void> {
  await git(["add", "-A"]);
}

export async function stageFiles(paths: string[]): Promise<void> {
  await git(["add", "-A", "--", ...paths]);
}

export async function stagedDiff(): Promise<string> {
  return (await git(["diff", "--cached", "--no-color", "--unified=2"])).stdout;
}

export async function stagedStat(): Promise<string> {
  return (await git(["diff", "--cached", "--no-color", "--stat"])).stdout;
}

export async function recentSubjects(n = 30): Promise<string[]> {
  const r = await git(["log", `-${n}`, "--pretty=%s"], { reject: false });
  return r.stdout.split("\n").filter(Boolean);
}

export async function commit(message: string): Promise<string> {
  // Message goes through stdin so multi-line bodies and quotes are safe on every shell.
  try {
    await execa("git", ["commit", "-F", "-"], { input: message });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // Hook failures print to stdout/stderr; surface everything.
    throw new GitError([e.stdout, e.stderr].filter(Boolean).join("\n").trim() || e.message);
  }
  return (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
}

export async function upstream(): Promise<string | null> {
  const r = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function aheadBehind(): Promise<{ ahead: number; behind: number } | null> {
  const r = await git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], { reject: false });
  if (r.exitCode !== 0) return null;
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

export async function defaultRemote(): Promise<string | null> {
  const r = await git(["remote"], { reject: false });
  const remotes = r.stdout.split("\n").filter(Boolean);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

export async function push(opts: { setUpstream?: { remote: string; branch: string } }): Promise<string> {
  const args = opts.setUpstream
    ? ["push", "-u", opts.setUpstream.remote, opts.setUpstream.branch]
    : ["push"];
  const r = await git(args);
  return [r.stdout, r.stderr].filter(Boolean).join("\n").trim();
}
