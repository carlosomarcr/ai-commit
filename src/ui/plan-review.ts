import { header, type CommitMessage } from "../commit/generate.js";
import { collapse, dropGroup, mergeGroups, moveFiles, setMessage } from "../grouping/edit.js";
import type { CommitGroup, CommitPlan, FileSummary } from "../grouping/types.js";
import { p, pc, statusColor, unwrap } from "./theme.js";

export interface ReviewContext {
  summaries: FileSummary[];
  /** Writes a fresh message for these files; null when it failed (the old message is kept). */
  regenMessage(files: string[]): Promise<CommitMessage | null>;
  /** Asks the model for a whole new plan with extra guidance; null when it failed. */
  replan(instructions: string): Promise<CommitPlan | null>;
}

export type ReviewOutcome = { kind: "commit"; groups: CommitGroup[]; skipped: CommitGroup[] } | { kind: "cancel" };

const BACK = "__back";
const NEW = "__new";
const MAX_FILES_SHOWN = 12;

export function renderGroup(g: CommitGroup, summaries: FileSummary[]): string {
  const lines: string[] = [];
  if (g.rationale) lines.push(pc.dim(`↳ ${g.rationale}`), "");
  const body = g.message.body?.trim();
  if (body) lines.push(pc.dim(body), "");
  for (const path of g.files.slice(0, MAX_FILES_SHOWN)) {
    const s = summaries.find((x) => x.path === path);
    const letter = s?.status ?? "M";
    const counts = s ? pc.dim(` +${s.additions} -${s.deletions}`) : "";
    lines.push(`${(statusColor[letter] ?? pc.white)(letter)} ${path}${counts}`);
  }
  if (g.files.length > MAX_FILES_SHOWN) lines.push(pc.dim(`… and ${g.files.length - MAX_FILES_SHOWN} more`));
  return lines.join("\n");
}

function showPlan(groups: CommitGroup[], summaries: FileSummary[]): void {
  groups.forEach((g, i) => {
    p.note(renderGroup(g, summaries), `${i + 1}/${groups.length}  ${pc.bold(header(g.message))}`);
  });
}

/** Turns an edited first line back into a message; free-form text is kept as-is with no type. */
export function parseHeader(text: string, previous: CommitMessage): CommitMessage {
  const m = /^(\w+)(?:\(([^)]+)\))?: (.+)$/.exec(text.trim());
  if (m) return { ...previous, type: m[1], scope: m[2] ?? null, title: m[3]! };
  return { ...previous, type: null, scope: null, title: text.trim() };
}

const label = (g: CommitGroup, i: number) => `${i + 1}. ${header(g.message)}`;

async function pickGroup(groups: CommitGroup[], message: string, filter: (g: CommitGroup) => boolean = () => true) {
  const candidates = groups.filter(filter);
  if (candidates.length === 1) return candidates[0]!;
  const id = unwrap(
    await p.select({
      message,
      options: [
        ...candidates.map((g) => ({ value: g.id, label: label(g, groups.indexOf(g)), hint: `${g.files.length} file(s)` })),
        { value: BACK, label: "← Back" },
      ],
    }),
  );
  return id === BACK ? null : groups.find((g) => g.id === id)!;
}

async function regen(groups: CommitGroup[], touched: string[], ctx: ReviewContext): Promise<CommitGroup[]> {
  let next = groups;
  for (const id of touched) {
    const g = next.find((x) => x.id === id);
    if (!g) continue;
    const message = await ctx.regenMessage(g.files);
    if (message) next = setMessage(next, id, message);
    else p.log.warn(`Kept the previous message for commit "${header(g.message)}"; edit it if needed.`);
  }
  return next;
}

/**
 * Lets the user approve, edit, merge, split, move files, skip commits or regenerate the plan.
 * Nothing is committed here; it only returns the final list.
 */
export async function reviewPlan(initial: CommitPlan, ctx: ReviewContext): Promise<ReviewOutcome> {
  let groups = initial.groups;
  let skipped: CommitGroup[] = [];
  for (const w of initial.warnings) p.log.warn(w);
  let dirty = true;

  for (;;) {
    if (dirty) showPlan(groups, ctx.summaries);
    dirty = false;

    const n = groups.length;
    const options = [
      { value: "commit", label: n === 1 ? "Commit" : `Commit all ${n} in order` },
      { value: "edit", label: "Edit a commit…", hint: "title, regenerate, or skip it" },
      ...(n > 1 ? [{ value: "move", label: "Move files between commits…" }] : []),
      ...(groups.some((g) => g.files.length > 1) ? [{ value: "split", label: "Split a commit…" }] : []),
      ...(n > 1 ? [{ value: "merge", label: "Merge commits…" }] : []),
      ...(n > 1 ? [{ value: "single", label: "Make it a single commit" }] : []),
      { value: "replan", label: "Regenerate the plan…", hint: "with extra guidance" },
      { value: "cancel", label: "Cancel" },
    ];
    const action = unwrap(await p.select({ message: "What now?", options }));

    if (action === "commit") return { kind: "commit", groups, skipped };
    if (action === "cancel") return { kind: "cancel" };

    if (action === "edit") {
      const g = await pickGroup(groups, "Which commit?");
      if (!g) continue;
      const what = unwrap(
        await p.select({
          message: header(g.message),
          options: [
            { value: "title", label: "Edit title" },
            { value: "regen", label: "Regenerate message" },
            { value: "skip", label: "Skip this commit", hint: "its files stay uncommitted" },
            { value: BACK, label: "← Back" },
          ],
        }),
      );
      if (what === "title") {
        const text = unwrap(
          await p.text({ message: "Commit title", initialValue: header(g.message), validate: (v) => (v?.trim() ? undefined : "Can't be empty") }),
        );
        groups = setMessage(groups, g.id, parseHeader(text, g.message));
        dirty = true;
      } else if (what === "regen") {
        groups = await regen(groups, [g.id], ctx);
        dirty = true;
      } else if (what === "skip") {
        skipped = [...skipped, g];
        groups = dropGroup(groups, g.id);
        if (groups.length === 0) return { kind: "cancel" };
        dirty = true;
      }
    } else if (action === "move") {
      const from = await pickGroup(groups, "Move files out of which commit?");
      if (!from) continue;
      const files = unwrap(
        await p.multiselect({
          message: "Files to move",
          options: from.files.map((f) => ({ value: f, label: f })),
          required: true,
        }),
      );
      const others = groups.filter((g) => g.id !== from.id);
      const to = unwrap(
        await p.select({
          message: "Move them to",
          options: [
            ...others.map((g) => ({ value: g.id, label: label(g, groups.indexOf(g)) })),
            { value: NEW, label: "A new commit" },
            { value: BACK, label: "← Back" },
          ],
        }),
      );
      if (to === BACK) continue;
      const res = moveFiles(groups, files, to === NEW ? "new" : to, ctx.summaries);
      groups = await regen(res.groups, res.touched, ctx);
      dirty = true;
    } else if (action === "split") {
      const from = await pickGroup(groups, "Split which commit?", (g) => g.files.length > 1);
      if (!from) continue;
      const files = unwrap(
        await p.multiselect({
          message: "Files that go into the new commit",
          options: from.files.map((f) => ({ value: f, label: f })),
          required: true,
        }),
      );
      if (files.length === from.files.length) {
        p.log.warn("That's every file; nothing to split.");
        continue;
      }
      const res = moveFiles(groups, files, "new", ctx.summaries);
      groups = await regen(res.groups, res.touched, ctx);
      dirty = true;
    } else if (action === "merge") {
      const ids = unwrap(
        await p.multiselect({
          message: "Commits to merge (pick at least 2)",
          options: groups.map((g, i) => ({ value: g.id, label: label(g, i), hint: `${g.files.length} file(s)` })),
          required: true,
        }),
      );
      if (ids.length < 2) {
        p.log.warn("Pick at least two commits.");
        continue;
      }
      const res = mergeGroups(groups, ids);
      groups = await regen(res.groups, res.touched, ctx);
      dirty = true;
    } else if (action === "single") {
      const res = collapse(groups);
      groups = await regen(res.groups, res.touched, ctx);
      dirty = true;
    } else if (action === "replan") {
      const text = unwrap(
        await p.text({ message: "Guidance for the model", placeholder: "e.g. keep docs in their own commit, fewer commits" }),
      );
      const plan = await ctx.replan(text.trim());
      if (plan) {
        groups = plan.groups;
        skipped = [];
        for (const w of plan.warnings) p.log.warn(w);
        dirty = true;
      }
    }
  }
}
