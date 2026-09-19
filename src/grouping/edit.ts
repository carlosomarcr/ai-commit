import type { CommitMessage } from "../commit/generate.js";
import { placeholderMessage } from "./heuristics.js";
import type { CommitGroup, FileSummary } from "./types.js";

export interface EditResult {
  groups: CommitGroup[];
  /** Ids of groups whose file set changed, so their message should be regenerated. */
  touched: string[];
}

const nextId = (groups: CommitGroup[]) =>
  `g${Math.max(0, ...groups.map((g) => Number(g.id.slice(1)) || 0)) + 1}`;

/** Moves files to another group, or to a brand new one when `to` is "new". Empty groups disappear. */
export function moveFiles(groups: CommitGroup[], files: string[], to: string | "new", summaries: FileSummary[]): EditResult {
  const moving = new Set(files);
  const touched = new Set<string>();
  let next = groups.map((g) => {
    const kept = g.files.filter((f) => !moving.has(f));
    if (kept.length !== g.files.length) touched.add(g.id);
    return { ...g, files: kept };
  });

  if (to === "new") {
    const id = nextId(groups);
    next.push({ id, message: placeholderMessage(files, summaries), files: [...files] });
    touched.add(id);
  } else {
    next = next.map((g) => (g.id === to ? { ...g, files: [...g.files, ...files] } : g));
    touched.add(to);
  }
  next = next.filter((g) => g.files.length > 0);
  return { groups: next, touched: [...touched].filter((id) => next.some((g) => g.id === id)) };
}

/** Merges several groups into the position of the first one; the caller regenerates its message. */
export function mergeGroups(groups: CommitGroup[], ids: string[]): EditResult {
  const picked = groups.filter((g) => ids.includes(g.id));
  if (picked.length < 2) return { groups, touched: [] };
  const target = picked[0]!;
  const merged: CommitGroup = { ...target, files: picked.flatMap((g) => g.files), rationale: undefined };
  const next = groups.filter((g) => g.id === target.id || !ids.includes(g.id)).map((g) => (g.id === target.id ? merged : g));
  return { groups: next, touched: [target.id] };
}

export function dropGroup(groups: CommitGroup[], id: string): CommitGroup[] {
  return groups.filter((g) => g.id !== id);
}

export function setMessage(groups: CommitGroup[], id: string, message: CommitMessage): CommitGroup[] {
  return groups.map((g) => (g.id === id ? { ...g, message } : g));
}

/** Everything in one commit, keeping the first group's message until it is regenerated. */
export function collapse(groups: CommitGroup[]): EditResult {
  return mergeGroups(groups, groups.map((g) => g.id));
}
