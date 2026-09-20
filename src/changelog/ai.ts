import { z } from "zod";
import { extractJson } from "../commit/generate.js";
import type { Provider } from "../providers/types.js";
import { GROUP_ORDER, cleanText, type Group, type Item, type ParsedCommit } from "./commits.js";

const ReplySchema = z.object({
  entries: z.array(
    z.object({
      group: z.string(),
      text: z.string().min(1),
      breaking: z.boolean().nullish(),
    }),
  ),
});

/** Commits per request; keeps prompts small for local models and cheap for hosted ones. */
const BATCH = 80;
const MAX_BODY_CHARS = 300;

export interface SummarizeInput {
  provider: Provider;
  commits: ParsedCommit[];
  language: string;
  /** A few bullets from the existing changelog, to copy its tone and level of detail. */
  examples: string[];
}

function describe(c: ParsedCommit, n: number): string {
  const head = c.type ? `${c.type}${c.scope ? `(${c.scope})` : ""}${c.breaking ? "!" : ""}: ` : "";
  const body = c.body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);
  return `${n}. ${head}${c.description}${body ? `\n   ${body}` : ""}`;
}

function buildPrompt(input: SummarizeInput, commits: ParsedCommit[]): { system: string; user: string } {
  const system = [
    "You write release notes for a CHANGELOG from a list of git commits.",
    'Reply with ONLY a JSON object: {"entries": [{"group": string, "text": string, "breaking": boolean}]}.',
    `group is one of: ${GROUP_ORDER.join(", ")}.`,
    "Write for people who USE the software, not for its developers: say what changed for them.",
    "One short line per entry, no commit hashes, no trailing period.",
    "Merge commits that are part of the same change (a feature and its follow-up fixes) into a single entry.",
    "Leave out purely internal work (refactors with no visible effect, tests, CI, formatting, version bumps, changelog edits).",
    "Never invent details that are not in the commits. Mark breaking: true only for incompatible changes.",
    `Write the entries in this language: ${input.language}.`,
    input.examples.length ? `Match the tone and format of these existing entries:\n${input.examples.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user: `Commits (oldest first):\n${commits.map((c, i) => describe(c, i + 1)).join("\n")}` };
}

function toGroup(name: string): Group {
  return GROUP_ORDER.find((g) => g.toLowerCase() === name.trim().toLowerCase()) ?? "Changed";
}

function toItems(reply: z.infer<typeof ReplySchema>): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const e of reply.entries) {
    const text = cleanText(e.text.replace(/^\s*[-*]\s+/, ""));
    if (!text) continue;
    const group = toGroup(e.group);
    const key = `${group}\0${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ group, text, breaking: Boolean(e.breaking) });
  }
  return items;
}

/** Turns commits into user-facing entries. Throws when the model never produces valid JSON. */
export async function summarizeCommits(input: SummarizeInput): Promise<Item[]> {
  const items: Item[] = [];
  for (let i = 0; i < input.commits.length; i += BATCH) {
    const { system, user } = buildPrompt(input, input.commits.slice(i, i + BATCH));
    let feedback = "";
    let reply: z.infer<typeof ReplySchema> | undefined;
    for (let attempt = 0; attempt < 3 && !reply; attempt++) {
      const text = await input.provider.generate({
        system,
        user: feedback ? `${user}\n\nYour previous reply was rejected: ${feedback}. Reply with valid JSON only.` : user,
      });
      try {
        reply = ReplySchema.parse(extractJson(text));
      } catch (err) {
        feedback = `invalid JSON (${err instanceof Error ? err.message.slice(0, 150) : "parse error"})`;
      }
    }
    if (!reply) throw new Error(`The model did not return valid release notes (${feedback}).`);
    items.push(...toItems(reply));
  }

  // Batches can repeat an entry.
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = `${it.group}\0${it.text.toLowerCase()}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
