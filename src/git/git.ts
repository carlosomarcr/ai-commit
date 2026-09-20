import { execa, execaSync } from "execa";

export interface ChangedFile {
  path: string;
  /** Previous path when the change is a rename/copy. */
  orig?: string;
  /** Index (staged) status letter, " " if none. */
  index: string;
  /** Worktree (unstaged) status letter, " " if none. */
  worktree: string;
}

export class GitError extends Error {}

const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1200];

const isLockError = (text: string) => /index\.lock|Unable to create '.*\.lock'/i.test(text);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Another git process (an IDE refreshing its status, a hook, an antivirus scan) can hold
 * `.git/index.lock` for a few milliseconds. git fails before doing any work in that case, so
 * retrying with a short backoff is always safe.
 */
async function withLockRetry<T extends { exitCode?: number; stderr?: unknown }>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const delay = LOCK_RETRY_DELAYS_MS[attempt];
    try {
      const r = await run();
      if (r.exitCode === 0 || delay === undefined || !isLockError(String(r.stderr ?? ""))) return r;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      if (delay === undefined || !isLockError(`${e.stderr ?? ""}\n${e.message ?? ""}`)) throw err;
    }
    await sleep(delay);
  }
}

const LOCK_HINT =
  "\nAnother git process is holding .git/index.lock (an editor, a git hook or another terminal). " +
  "Wait a moment and try again; if nothing else is running git, delete .git/index.lock.";

function toGitError(err: unknown): GitError {
  const e = err as { stderr?: string; message: string };
  const text = (e.stderr || e.message).trim();
  return new GitError(isLockError(text) ? text + LOCK_HINT : text);
}

/** `readOnly` commands skip optional locks so they never fight other tools over the index. */
async function git(args: string[], opts: { cwd?: string; reject?: boolean; readOnly?: boolean } = {}) {
  try {
    return await withLockRetry(() =>
      execa("git", args, {
        cwd: opts.cwd,
        reject: opts.reject ?? true,
        env: opts.readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : undefined,
      }),
    );
  } catch (err) {
    throw toGitError(err);
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
  const r = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { readOnly: true });
  const parts = r.stdout.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const index = entry[0]!;
    const worktree = entry[1]!;
    let orig: string | undefined;
    // Renames/copies are followed by the original path as a separate entry.
    if (index === "R" || index === "C") orig = parts[++i];
    files.push({ path: entry.slice(3), orig, index: index === "?" ? " " : index, worktree });
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
  return (await git(["diff", "--cached", "--no-color", "--unified=2"], { readOnly: true })).stdout;
}

export async function stagedStat(): Promise<string> {
  return (await git(["diff", "--cached", "--no-color", "--stat"], { readOnly: true })).stdout;
}

export async function recentSubjects(n = 30): Promise<string[]> {
  const r = await git(["log", `-${n}`, "--pretty=%s"], { reject: false });
  return r.stdout.split("\n").filter(Boolean);
}

export async function commit(message: string): Promise<string> {
  // Message goes through stdin so multi-line bodies and quotes are safe on every shell.
  try {
    await withLockRetry(() => execa("git", ["commit", "-F", "-"], { input: message }));
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // Hook failures print to stdout/stderr; surface everything.
    const text = [e.stdout, e.stderr].filter(Boolean).join("\n").trim() || e.message;
    throw new GitError(isLockError(text) ? text + LOCK_HINT : text);
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

export const hasConflict = (f: ChangedFile) =>
  f.index === "U" || f.worktree === "U" || (f.index === "A" && f.worktree === "A") || (f.index === "D" && f.worktree === "D");

// --- Index plumbing: lets us commit exact file sets without touching the working tree ------------

export async function hasHead(): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "-q", "HEAD"], { reject: false })).exitCode === 0;
}

/** Snapshot of the current index as a tree object. */
export async function writeTree(): Promise<string> {
  return (await git(["write-tree"])).stdout.trim();
}

/** Restores the index to a snapshot taken with writeTree (working tree untouched). */
export async function readTree(tree: string): Promise<void> {
  await git(["read-tree", tree]);
}

export async function resetIndexToHead(): Promise<void> {
  await git(["read-tree", (await hasHead()) ? "HEAD" : "--empty"]);
}

export interface TreeEntry {
  mode: string;
  sha: string;
}

export async function lsTree(tree: string): Promise<Map<string, TreeEntry>> {
  const r = await git(["ls-tree", "-r", "-z", tree]);
  const map = new Map<string, TreeEntry>();
  for (const rec of r.stdout.split("\0").filter(Boolean)) {
    const tab = rec.indexOf("\t");
    const [mode = "", , sha = ""] = rec.slice(0, tab).split(" ");
    map.set(rec.slice(tab + 1), { mode, sha });
  }
  return map;
}

/** Sets (or, with null, removes) index entries. Paths are literal and passed via stdin, so no quoting/length limits. */
export async function setIndexEntries(entries: { path: string; entry: TreeEntry | null }[]): Promise<void> {
  if (entries.length === 0) return;
  const zeros = "0".repeat(entries.find((e) => e.entry)?.entry?.sha.length ?? 40);
  // Removals first so directory/file replacements don't collide.
  const ordered = [...entries].sort((a, b) => Number(Boolean(a.entry)) - Number(Boolean(b.entry)));
  const input =
    ordered
      .map((e) => (e.entry ? `${e.entry.mode} ${e.entry.sha}\t${e.path}` : `0 ${zeros}\t${e.path}`))
      .join("\0") + "\0";
  try {
    await execa("git", ["update-index", "-z", "--index-info"], { input });
  } catch (err) {
    throw new GitError(((err as { stderr?: string }).stderr || (err as Error).message).trim());
  }
}

export async function hasStagedChanges(): Promise<boolean> {
  return (await git(["diff", "--cached", "--quiet"], { reject: false })).exitCode === 1;
}

export interface NumstatEntry {
  path: string;
  orig?: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** Added/deleted line counts for everything staged, in one cheap call. */
export async function stagedNumstat(): Promise<NumstatEntry[]> {
  const r = await git(["diff", "--cached", "-M", "-z", "--numstat"]);
  const parts = r.stdout.split("\0");
  const out: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\S+)\t(\S+)\t([\s\S]*)$/.exec(parts[i] ?? "");
    if (!m) continue;
    const binary = m[1] === "-";
    let path = m[3]!;
    let orig: string | undefined;
    if (path === "") {
      orig = parts[++i];
      path = parts[++i] ?? "";
    }
    out.push({ path, orig, additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return out;
}

/** Staged diff for specific files (literal paths, so brackets/globs in names are safe). */
export async function stagedFileDiff(paths: string[]): Promise<string> {
  const r = await git(["--literal-pathspecs", "diff", "--cached", "-M", "--no-color", "--unified=2", "--", ...paths]);
  return r.stdout;
}

export async function getGlobalAlias(name: string): Promise<string | null> {
  const r = await git(["config", "--global", "--get", `alias.${name}`], { reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function setGlobalAlias(name: string, command: string): Promise<void> {
  await git(["config", "--global", `alias.${name}`, command]);
}

export async function globalIdentity(): Promise<{ name: string | null; email: string | null }> {
  const get = async (key: string) => {
    const r = await git(["config", "--get", key], { reject: false });
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
  return { name: await get("user.name"), email: await get("user.email") };
}

export async function gitVersion(): Promise<string | null> {
  const r = await git(["--version"], { reject: false }).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout.trim().replace(/^git version /, "") : null;
}

/** Zero-context staged diff of added/modified files: cheap to scan, contains only the new lines. */
export async function stagedAddedLinesDiff(): Promise<string> {
  const r = await git(["-c", "core.quotepath=false", "diff", "--cached", "-M", "-U0", "--no-color", "--diff-filter=ACMR"]);
  return r.stdout;
}

/** Name of a merge/rebase/cherry-pick/revert in progress, or null. Committing groups mid-operation would corrupt it. */
export async function operationInProgress(): Promise<string | null> {
  const dir = (await git(["rev-parse", "--absolute-git-dir"])).stdout.trim();
  const { access } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const markers: [string, string][] = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [file, name] of markers) {
    try {
      await access(join(dir, file));
      return name;
    } catch {
      // not present
    }
  }
  return null;
}

/** Synchronous index restore, usable from a SIGINT handler. */
export function readTreeSync(tree: string): void {
  execaSync("git", ["read-tree", tree]);
}

/** The editor git itself would open for a commit message. */
export async function editorCommand(): Promise<string> {
  const r = await git(["var", "GIT_EDITOR"], { reject: false });
  return (r.exitCode === 0 && r.stdout.trim()) || process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
}

/** Staged diff of one file with 1 line of context and the diff text left exactly as git printed it. */
export async function stagedHunkDiff(path: string): Promise<string> {
  const r = await execa("git", ["-c", "core.quotepath=false", "--literal-pathspecs", "diff", "--cached", "--no-color", "-U1", "--", path], {
    stripFinalNewline: false,
  });
  return r.stdout;
}

/** Raw bytes of a blob. */
export async function catBlob(sha: string): Promise<Buffer> {
  const r = await execa("git", ["cat-file", "blob", sha], { encoding: "buffer", stripFinalNewline: false });
  return Buffer.from(r.stdout);
}

/** The file as it is in HEAD, or null when HEAD doesn't have it. */
export async function headBlob(path: string): Promise<Buffer | null> {
  try {
    const r = await execa("git", ["--literal-pathspecs", "show", `HEAD:${path}`], { encoding: "buffer", stripFinalNewline: false });
    return Buffer.from(r.stdout);
  } catch {
    return null;
  }
}

/** Stores text as a blob object and returns its id. */
export async function hashObject(content: string): Promise<string> {
  return (await execa("git", ["hash-object", "-w", "--stdin"], { input: content })).stdout.trim();
}

// --- History (used by `gitowl changelog`) ---------------------------------------------------------

export interface LogCommit {
  hash: string;
  subject: string;
  body: string;
}

export interface TagInfo {
  name: string;
  /** Creation date, YYYY-MM-DD. */
  date: string;
}

/** Matches tags that look like releases (v1.2.3, 1.2.3, pkg@1.2.3) without fetching every tag. */
const VERSION_TAG_GLOB = "*[0-9]*.*[0-9]*";

/** All tags, oldest first. */
export async function tags(): Promise<TagInfo[]> {
  const r = await git(
    ["for-each-ref", "--sort=creatordate", "--format=%(refname:short)%09%(creatordate:short)", "refs/tags"],
    { reject: false, readOnly: true },
  );
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", date = ""] = line.split("\t");
      return { name, date };
    });
}

/** Nearest release-like tag reachable from `ref`, or null. */
export async function nearestTag(ref = "HEAD"): Promise<string | null> {
  const r = await git(["describe", "--tags", "--abbrev=0", "--match", VERSION_TAG_GLOB, ref], {
    reject: false,
    readOnly: true,
  });
  return r.exitCode === 0 ? r.stdout.trim() || null : null;
}

/** The release-like tag before `tag` (null for the first release). */
export async function previousTag(tag: string): Promise<string | null> {
  return nearestTag(`${tag}^`);
}

/** Commits in `from..to` (or everything up to `to` when `from` is null), oldest first, merges excluded. */
export async function commitsBetween(from: string | null, to: string): Promise<LogCommit[]> {
  const range = from ? `${from}..${to}` : to;
  const r = await git(["log", "--no-merges", "--reverse", "--format=%h%x1f%s%x1f%b%x1e", range], {
    reject: false,
    readOnly: true,
  });
  if (r.exitCode !== 0) throw new GitError(String(r.stderr || `Could not read history for ${range}`).trim());
  return r.stdout
    .split("\x1e")
    .map((rec) => rec.replace(/^\n+/, ""))
    .filter((rec) => rec.trim())
    .map((rec) => {
      const [hash = "", subject = "", body = ""] = rec.split("\x1f");
      return { hash, subject: subject.trim(), body: body.trim() };
    });
}

export async function refExists(ref: string): Promise<boolean> {
  return (await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { reject: false, readOnly: true })).exitCode === 0;
}
