import { cleanTitle } from "../commit/generate.js";
import type { LogCommit } from "../git/git.js";

export type Group = "Added" | "Changed" | "Deprecated" | "Removed" | "Fixed" | "Security";

/** Order used when rendering. */
export const GROUP_ORDER: Group[] = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

export interface ParsedCommit {
  hash: string;
  type: string | null;
  scope: string | null;
  description: string;
  breaking: boolean;
  body: string;
  group: Group;
}

/** One changelog line. */
export interface Item {
  group: Group;
  text: string;
  breaking: boolean;
}

const CONVENTIONAL = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/i;
const VERSION_ONLY = /^(?:release\s+)?v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i;
const NOISE_SUBJECT = [/^merge\b/i, /^(fixup|squash)!/i, /^(wip|typo|initial commit)\.?$/i, /^release\b/i];
const CHANGELOG_ONLY = /^(?:(?:update|add|generate|bump|prepare|regenerate)\s+)?(?:the\s+)?(?:changelog|release notes)\b/i;

/** Types that rarely matter to someone reading release notes. */
const INTERNAL_TYPES = new Set(["docs", "test", "tests", "chore", "ci", "build", "style"]);

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
export const cleanText = (s: string) => capitalize(s.replace(/\s+/g, " ").trim().replace(/\.+$/, ""));

function groupFor(type: string | null, scope: string | null, description: string): Group {
  if (scope && /security/i.test(scope)) return "Security";
  if (/\bCVE-\d{4}-\d+|vulnerab/i.test(description)) return "Security";
  if (/^(remove|drop|delete)\b/i.test(description)) return "Removed";
  if (/^deprecate\b/i.test(description)) return "Deprecated";
  switch (type?.toLowerCase()) {
    case "feat":
    case "feature":
      return "Added";
    case "fix":
    case "hotfix":
    case "bugfix":
      return "Fixed";
    case undefined:
      if (/^(add|implement|introduce|support|create)\b/i.test(description)) return "Added";
      if (/^(fix|resolve|correct|patch)\b/i.test(description)) return "Fixed";
      return "Changed";
    default:
      return "Changed";
  }
}

/**
 * Parses a commit and decides whether it belongs in release notes. Returns null for noise
 * (merges, version bumps, changelog/release commits) and, unless `allTypes`, for internal types
 * such as docs/test/chore/ci. Breaking changes are always kept.
 */
export function parseCommit(c: LogCommit, opts: { allTypes?: boolean } = {}): ParsedCommit | null {
  const subject = c.subject.trim();
  if (!subject || VERSION_ONLY.test(subject) || NOISE_SUBJECT.some((re) => re.test(subject))) return null;

  const m = CONVENTIONAL.exec(subject);
  const type = m ? m[1]!.toLowerCase() : null;
  const scope = m?.[2]?.trim() || null;
  // Older commits may repeat the prefix inside the description ("feat(x): feat(x): ...").
  const description = m ? cleanTitle({ type, scope, title: m[4]!.trim() }) : subject;
  const breaking = Boolean(m?.[3]) || /^BREAKING[ -]CHANGE:/m.test(c.body);

  // Commits that only maintain the changelog/release are noise, but `feat(changelog): ...` is a real feature.
  const internal = !type || INTERNAL_TYPES.has(type);
  if (scope && /^(changelog|release)$/i.test(scope) && internal && !breaking) return null;
  if (CHANGELOG_ONLY.test(description) && internal) return null;
  if (!breaking && !opts.allTypes && type && INTERNAL_TYPES.has(type)) return null;

  return { hash: c.hash, type, scope, description, breaking, body: c.body, group: groupFor(type, scope, description) };
}

export function parseCommits(commits: LogCommit[], opts: { allTypes?: boolean } = {}): ParsedCommit[] {
  return commits.map((c) => parseCommit(c, opts)).filter((c): c is ParsedCommit => c !== null);
}

/** No-AI fallback: one item per commit (duplicates collapsed). */
export function itemsFromCommits(commits: ParsedCommit[]): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const c of commits) {
    const text = cleanText(c.description);
    const key = `${c.group}\0${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ group: c.group, text, breaking: c.breaking });
  }
  return items;
}
