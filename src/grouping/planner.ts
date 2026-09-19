import { z } from "zod";
import {
  extractJson,
  generateMessage,
  styleParts,
  validateMessage,
  type CommitMessage,
} from "../commit/generate.js";
import type { Provider } from "../providers/types.js";
import type { ProjectRules } from "../rules/types.js";
import { heuristicClusters, placeholderMessage } from "./heuristics.js";
import { renderDiffs, renderStat } from "./summarize.js";
import type { CommitGroup, CommitPlan, FileSummary } from "./types.js";

export interface PlanInput {
  provider: Provider;
  summaries: FileSummary[];
  language: string;
  rules: ProjectRules;
  /** Extra user guidance, e.g. "keep docs separate". */
  instructions?: string;
}

const DIFF_BUDGET = 20_000;
const MAX_HINT_FILES = 60;

const PlanSchema = z.object({
  commits: z
    .array(
      z.object({
        type: z.string().nullish(),
        scope: z.string().nullish(),
        title: z.string().min(1),
        body: z.string().nullish(),
        files: z.array(z.string()).min(1),
        rationale: z.string().nullish(),
      }),
    )
    .min(1),
});
type RawPlan = z.infer<typeof PlanSchema>;

/** Length of the shared leading folder path, used to place files the model forgot. */
function affinity(a: string, b: string): number {
  const x = a.split("/").slice(0, -1);
  const y = b.split("/").slice(0, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

/** Puts unassigned files into the group with the closest folder, or a new group when nothing is close. */
export function assignLeftovers(groups: CommitGroup[], missing: string[], summaries: FileSummary[]): void {
  const orphans: string[] = [];
  for (const file of missing) {
    let best: CommitGroup | undefined;
    let score = 0;
    for (const g of groups) {
      const s = Math.max(...g.files.map((f) => affinity(f, file)));
      if (s > score) [best, score] = [g, s];
    }
    if (best) best.files.push(file);
    else orphans.push(file);
  }
  if (orphans.length) {
    groups.push({
      id: `g${groups.length + 1}`,
      message: placeholderMessage(orphans, summaries),
      files: orphans,
      rationale: "files the model did not place",
    });
  }
}

/**
 * Turns the model's raw plan into a valid one: every file exactly once, no invented paths.
 * `problems` describes what had to be repaired (fed back to the model on retries).
 */
export function normalizePlan(raw: RawPlan, summaries: FileSummary[]): { groups: CommitGroup[]; problems: string[] } {
  const known = new Set(summaries.map((s) => s.path));
  const byOrig = new Map(summaries.filter((s) => s.orig).map((s) => [s.orig!, s.path]));
  const seen = new Set<string>();
  const problems: string[] = [];
  const groups: CommitGroup[] = [];

  for (const c of raw.commits) {
    const files: string[] = [];
    for (const original of c.files) {
      const cleaned = original.trim().replace(/^\.\//, "").replace(/\\/g, "/");
      const path = known.has(cleaned) ? cleaned : (byOrig.get(cleaned) ?? cleaned);
      if (!known.has(path)) problems.push(`"${original}" is not a changed file`);
      else if (seen.has(path)) problems.push(`"${path}" appears in more than one commit`);
      else {
        seen.add(path);
        files.push(path);
      }
    }
    if (files.length === 0) continue;
    groups.push({
      id: `g${groups.length + 1}`,
      message: {
        type: c.type?.trim() || null,
        scope: c.scope?.trim() || null,
        title: c.title.trim(),
        body: c.body?.trim() || null,
      },
      files,
      rationale: c.rationale?.trim() || undefined,
    });
  }

  const missing = summaries.map((s) => s.path).filter((p) => !seen.has(p));
  if (missing.length) {
    problems.push(`these changed files are not in any commit: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);
    assignLeftovers(groups, missing, summaries);
  }
  return { groups, problems };
}

function planPrompt(input: PlanInput): { system: string; user: string } {
  const { summaries, rules } = input;
  const clusters = heuristicClusters(summaries);
  const hints =
    clusters.length > 1 && summaries.length <= MAX_HINT_FILES
      ? `Hints (deterministic clusters; follow or override them):\n${clusters.map((c) => `- ${c.join(", ")}`).join("\n")}`
      : "";

  const system = [
    "You split a set of code changes into logical git commits and write each commit message.",
    'Reply with ONLY JSON: {"commits":[{"type": string|null, "scope": string|null, "title": string, "body": string|null, "files": string[], "rationale": string}]}.',
    "Grouping rules:",
    "- Every changed file must appear in exactly one commit. Use the exact paths listed (for renames use the NEW path).",
    "- Group by logical unit of change (one feature, one fix, one refactor, one docs update), not merely by folder.",
    "- Keep code together with its tests, and dependency manifests together with their lockfiles.",
    "- Put unrelated concerns (docs, CI, dependency bumps, formatting, config) in separate commits.",
    "- Prefer few, meaningful commits (usually 1 to 6). If everything is one concern, return a single commit.",
    "- Order commits so each builds on the previous: refactors and foundations first, features after.",
    "- rationale: max 15 words on why these files belong together.",
    ...styleParts(rules, input.language, input.instructions),
    hints,
  ]
    .filter(Boolean)
    .join("\n");

  const user = `Changed files:\n${renderStat(summaries)}\n\nDiffs:\n${renderDiffs(summaries, DIFF_BUDGET)}`;
  return { system, user };
}

/** Generates a message for a subset of files (used for merges, splits, fallbacks and regeneration). */
export async function messageForFiles(input: PlanInput, files: string[]): Promise<CommitMessage> {
  const subset = input.summaries.filter((s) => files.includes(s.path));
  return generateMessage({
    provider: input.provider,
    stat: renderStat(subset),
    diff: renderDiffs(subset, 24_000),
    language: input.language,
    rules: input.rules,
    instructions: input.instructions,
  });
}

/** One commit with everything (`--single`, or when there is a single file). */
export async function singlePlan(input: PlanInput): Promise<CommitPlan> {
  const files = input.summaries.map((s) => s.path);
  return { groups: [{ id: "g1", message: await messageForFiles(input, files), files }], warnings: [] };
}

/** Heuristic clusters + one message each; used when the model can't produce a usable plan. */
async function fallbackPlan(input: PlanInput): Promise<CommitPlan> {
  const groups: CommitGroup[] = [];
  for (const files of heuristicClusters(input.summaries)) {
    groups.push({ id: `g${groups.length + 1}`, message: await messageForFiles(input, files), files });
  }
  return {
    groups,
    warnings: ["The model didn't return a usable plan, so files were grouped by heuristics (folder, tests, lockfiles)."],
  };
}

/** Asks the model to split the changes into commits, validating and repairing its answer. */
export async function planCommits(input: PlanInput): Promise<CommitPlan> {
  if (input.summaries.length <= 1) return singlePlan(input);

  const { system, user } = planPrompt(input);
  let feedback = "";
  let best: { groups: CommitGroup[]; problems: string[] } | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await input.provider.generate({
      system,
      user: feedback ? `${user}\n\nYour previous reply was rejected: ${feedback}. Fix it and reply with valid JSON only.` : user,
    });

    let raw: RawPlan;
    try {
      raw = PlanSchema.parse(extractJson(reply));
    } catch (err) {
      feedback = `invalid JSON (${err instanceof Error ? err.message.slice(0, 150) : "parse error"})`;
      continue;
    }

    const normalized = normalizePlan(raw, input.summaries);
    const violations = normalized.groups.flatMap((g, i) =>
      validateMessage(g.message, input.rules).map((e) => `commit ${i + 1}: ${e}`),
    );
    best = { groups: normalized.groups, problems: [...normalized.problems, ...violations] };
    if (best.problems.length === 0) return { groups: best.groups, warnings: [] };
    feedback = best.problems.join("; ");
  }

  if (!best) return fallbackPlan(input);
  return { groups: best.groups, warnings: best.problems.map((p) => `Repaired: ${p}`) };
}
