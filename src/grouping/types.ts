import type { CommitMessage } from "../commit/generate.js";

export type FileKind = "source" | "test" | "docs" | "config" | "ci" | "deps" | "lock" | "asset" | "generated";

export interface FileSummary {
  /** Current path (the NEW path for renames). */
  path: string;
  orig?: string;
  /** Index status letter: A, M, D, R... */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  kind: FileKind;
  /** Set on hunk units: the real file this hunk belongs to, and its position in that file. */
  file?: string;
  hunk?: number;
  /** Why the diff content is never sent to the AI (it is still committed). */
  withheld?: "sensitive" | "ignored";
  /** Diff excerpt; absent for lockfiles, generated files, binaries and files past the budget. */
  diff?: string;
}

export interface CommitGroup {
  id: string;
  message: CommitMessage;
  /** Paths (new paths for renames). File-level: a file belongs to exactly one group. */
  files: string[];
  rationale?: string;
}

export interface CommitPlan {
  groups: CommitGroup[];
  /** Things the user should know, e.g. files the model forgot and we placed by folder. */
  warnings: string[];
}
