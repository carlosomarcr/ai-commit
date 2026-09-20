import * as git from "../git/git.js";
import { UNRELEASED } from "./document.js";

export interface Target {
  version: string;
  date?: string;
  /** Exclusive lower bound (null: from the first commit). */
  from: string | null;
  to: string;
  /** Commits not covered by any tag yet. */
  pending: boolean;
}

export interface TargetPlan {
  targets: Target[];
  /** Tagged releases missing from the file that were left out because of `limit`. */
  skippedOlder: number;
}

export interface PlanOptions {
  /** Versions that already have a section in the file. */
  existing: Set<string>;
  from?: string;
  to?: string;
  /** Heading for the not-yet-tagged commits (e.g. "1.4.0"); "Unreleased" when omitted. */
  release?: string;
  /** Version in package.json; used as the heading of untagged commits when it has no tag yet. */
  packageVersion?: string | null;
  /** Max number of missing tagged releases to write (newest first). */
  limit: number;
}

/** "v1.2.3", "1.2.3" and "pkg@1.2.3" all give "1.2.3"; other tags give null. */
export function tagVersion(name: string): string | null {
  const m = /(?:^|[^0-9A-Za-z])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(name);
  return m ? m[1]! : null;
}

export const normalizeVersion = (v: string) => (v === UNRELEASED ? v : v.replace(/^v(?=\d)/i, ""));

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function planTargets(opts: PlanOptions): Promise<TargetPlan> {
  const release = opts.release ? normalizeVersion(opts.release) : undefined;

  // Explicit range: exactly one section.
  if (opts.from || opts.to) {
    const to = opts.to ?? "HEAD";
    const from = opts.from ?? (to === "HEAD" ? await git.nearestTag("HEAD") : await git.previousTag(to));
    return { targets: [{ version: release ?? UNRELEASED, date: localDate(), from, to, pending: true }], skippedOlder: 0 };
  }

  const tagged = new Map<string, git.TagInfo>();
  for (const t of await git.tags()) {
    const v = tagVersion(t.name);
    if (v) tagged.set(v, t);
  }

  const missing = [...tagged.entries()].filter(([v]) => !opts.existing.has(v));
  const taken = opts.limit > 0 ? missing.slice(-opts.limit) : missing;
  const targets: Target[] = [];

  const last = await git.nearestTag("HEAD");
  const packageVersion = opts.packageVersion && !tagged.has(opts.packageVersion) ? opts.packageVersion : undefined;
  targets.push({ version: release ?? packageVersion ?? UNRELEASED, date: localDate(), from: last, to: "HEAD", pending: true });

  for (const [version, tag] of [...taken].reverse()) {
    targets.push({ version, date: tag.date, from: await git.previousTag(tag.name), to: tag.name, pending: false });
  }
  return { targets, skippedOlder: missing.length - taken.length };
}
