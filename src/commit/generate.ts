import { z } from "zod";
import type { Provider } from "../providers/types.js";
import type { ProjectRules } from "../rules/types.js";

export const CommitMessageSchema = z.object({
  /** null in "free" style, where the whole first line lives in `title`. */
  type: z.string().nullish(),
  scope: z.string().nullish(),
  title: z.string().min(1),
  body: z.string().nullish(),
});
export type CommitMessage = z.infer<typeof CommitMessageSchema>;

export interface GenerateInput {
  provider: Provider;
  stat: string;
  diff: string;
  language: string;
  rules: ProjectRules;
  /** Extra user instruction, e.g. from --instructions or a regenerate request. */
  instructions?: string;
}

const MAX_DIFF_CHARS = 24_000;

export function header(m: CommitMessage): string {
  return m.type ? `${m.type}${m.scope ? `(${m.scope})` : ""}: ${m.title}` : m.title;
}

export function formatMessage(m: CommitMessage): string {
  return m.body?.trim() ? `${header(m)}\n\n${m.body.trim()}` : header(m);
}

/** Checks a message against the hard constraints (commitlint / .gitowl.json). */
export function validateMessage(m: CommitMessage, rules: ProjectRules): string[] {
  const errors: string[] = [];
  const head = header(m);
  if (rules.maxHeaderLength && head.length > rules.maxHeaderLength) {
    errors.push(`first line is ${head.length} chars, max is ${rules.maxHeaderLength}`);
  }
  if (rules.style === "conventional") {
    if (!m.type) errors.push("type is required");
    else if (rules.types && !rules.types.includes(m.type)) {
      errors.push(`type "${m.type}" is not allowed, use one of: ${rules.types.join(", ")}`);
    }
    if (m.scope && rules.scopes && !rules.scopes.includes(m.scope)) {
      errors.push(`scope "${m.scope}" is not allowed, use one of: ${rules.scopes.join(", ")} (or null)`);
    }
  }
  return errors;
}

/** Pulls the first JSON object out of a model reply, tolerating code fences and chatter. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Prompt lines describing HOW messages must look; shared by single-message and planning prompts. */
export function styleParts(rules: ProjectRules, language: string, instructions?: string): string[] {
  const conventional = rules.style === "conventional";
  const maxLen = rules.maxHeaderLength ?? 72;
  const parts = [
    conventional
      ? `Use conventional commits. type is one of: ${(rules.types ?? ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf", "build", "ci"]).join(", ")}. The header is "type(scope): title".`
      : "This project does NOT use conventional commits: set type and scope to null and put the entire first line in title.",
    rules.scopes ? `scope must be one of: ${rules.scopes.join(", ")}, or null.` : "",
    `The complete first line must be at most ${maxLen} characters. Use the imperative mood, no trailing period.`,
    "body is optional: explain WHY only when non-obvious, wrapped at 72 columns.",
    `Write title and body in this language: ${language}.`,
  ];

  if (rules.history && rules.history.count >= 3) {
    const h = rules.history;
    parts.push(
      `Recent history: ${Math.round(h.conventionalRatio * 100)}% conventional, ${Math.round(h.scopeRatio * 100)}% use a scope, average subject length ${h.avgLength}${h.topTypes.length ? `, common types: ${h.topTypes.join(", ")}` : ""}. Match that style.`,
    );
  }
  if (rules.text) {
    parts.push(
      "The project documents these commit rules. They are authoritative: where they conflict with the defaults above, follow them (still reply as the JSON object).",
      rules.text,
    );
  }
  if (rules.instructions) parts.push(`Project instructions: ${rules.instructions}`);
  if (instructions) parts.push(`Extra instructions from the user: ${instructions}`);
  return parts.filter(Boolean);
}

export function buildPrompt(input: GenerateInput): { system: string; user: string } {
  const system = [
    "You write git commit messages from a diff.",
    'Reply with ONLY a JSON object: {"type": string|null, "scope": string|null, "title": string, "body": string|null}.',
    ...styleParts(input.rules, input.language, input.instructions),
  ].join("\n");

  const diff =
    input.diff.length > MAX_DIFF_CHARS ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : input.diff;
  return { system, user: `Changed files:\n${input.stat}\n\nDiff:\n${diff}` };
}

export async function generateMessage(input: GenerateInput): Promise<CommitMessage> {
  const { system, user } = buildPrompt(input);
  let feedback = "";
  let last: CommitMessage | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await input.provider.generate({
      system,
      user: feedback ? `${user}\n\nYour previous reply was rejected: ${feedback}. Fix it and reply with valid JSON only.` : user,
    });
    try {
      last = CommitMessageSchema.parse(extractJson(reply));
    } catch (err) {
      feedback = `invalid JSON (${err instanceof Error ? err.message.slice(0, 150) : "parse error"})`;
      continue;
    }
    const errors = validateMessage(last, input.rules);
    if (errors.length === 0) return last;
    feedback = errors.join("; ");
  }
  // Rule violations after retries: hand the message back and let the caller warn.
  if (last) return last;
  throw new Error(`The model did not return a valid commit message (${feedback}).`);
}
