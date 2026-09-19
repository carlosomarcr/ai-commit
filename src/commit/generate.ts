import { z } from "zod";
import type { Provider } from "../providers/types.js";

export const CommitMessageSchema = z.object({
  type: z.string().min(1),
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
  recentSubjects: string[];
  /** Extra user instruction, e.g. from --instructions or a regenerate request. */
  instructions?: string;
}

const MAX_DIFF_CHARS = 24_000;

export function formatMessage(m: CommitMessage): string {
  const head = `${m.type}${m.scope ? `(${m.scope})` : ""}: ${m.title}`;
  return m.body?.trim() ? `${head}\n\n${m.body.trim()}` : head;
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

export function buildPrompt(input: GenerateInput): { system: string; user: string } {
  const system = [
    "You write git commit messages from a diff.",
    "Reply with ONLY a JSON object: {\"type\": string, \"scope\": string|null, \"title\": string, \"body\": string|null}.",
    "type is a conventional-commit type (feat, fix, refactor, docs, test, chore, style, perf, build, ci).",
    "title is imperative, lowercase start, no trailing period, max 72 characters including type and scope.",
    "body is optional: explain WHY only when non-obvious, wrapped at 72 columns.",
    `Write title and body in this language: ${input.language}.`,
    input.recentSubjects.length
      ? `Match the style of these recent commits:\n${input.recentSubjects.map((s) => `- ${s}`).join("\n")}`
      : "",
    input.instructions ? `Extra instructions from the user: ${input.instructions}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const diff =
    input.diff.length > MAX_DIFF_CHARS
      ? `${input.diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]`
      : input.diff;
  const user = `Changed files:\n${input.stat}\n\nDiff:\n${diff}`;
  return { system, user };
}

export async function generateMessage(input: GenerateInput): Promise<CommitMessage> {
  const { system, user } = buildPrompt(input);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await input.provider.generate({
      system,
      user: lastError ? `${user}\n\nYour previous reply was invalid (${lastError}). Reply with valid JSON only.` : user,
    });
    try {
      return CommitMessageSchema.parse(extractJson(reply));
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 200) : "parse error";
    }
  }
  throw new Error(`The model did not return a valid commit message (${lastError}).`);
}
