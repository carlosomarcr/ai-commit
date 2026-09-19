export type CommitStyle = "conventional" | "free";

export interface RuleSource {
  /** Human label shown in the UI, e.g. "CLAUDE.md §Commits". */
  label: string;
  path: string;
  kind: "agent" | "commitlint" | "project" | "template" | "history";
}

export interface HistoryStats {
  count: number;
  conventionalRatio: number;
  scopeRatio: number;
  avgLength: number;
  topTypes: string[];
}

export interface ProjectRules {
  sources: RuleSource[];
  /** Commit-related excerpts from agent/contributing files, ready to paste in a prompt. */
  text: string;
  style: CommitStyle;
  types?: string[];
  scopes?: string[];
  maxHeaderLength?: number;
  language?: string;
  instructions?: string;
  history: HistoryStats | null;
}
