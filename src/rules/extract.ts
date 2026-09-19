export interface ExtractedRules {
  /** Headings that were taken whole, used for the UI label. */
  headings: string[];
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RELEVANT_HEADING =
  /\b(commits?|committing|git|conventional|changelog|version control|pull requests?|branch(?:es|ing)?)\b/i;
const COMMIT_LINE = /\bcommit(?:s|ted|ting)?\b/i;

export const MAX_SOURCE_CHARS = 2500;

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

/**
 * Agent files talk about many things besides commits. Keep (1) whole sections whose heading is
 * about git/commits and (2) any other line that mentions committing, with no LLM involved.
 */
export function extractCommitRules(markdown: string): ExtractedRules {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);

  interface Heading { idx: number; level: number; title: string }
  const headings: Heading[] = [];
  const inFence: boolean[] = [];
  let fenced = false;
  lines.forEach((line, idx) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence.push(true);
      fenced = !fenced;
      return;
    }
    inFence.push(fenced);
    if (fenced) return;
    const m = HEADING_RE.exec(line);
    if (m) headings.push({ idx, level: m[1]!.length, title: m[2]! });
  });

  const covered = new Array<boolean>(lines.length).fill(false);
  const chunks: string[] = [];
  const taken: string[] = [];

  for (const h of headings) {
    if (covered[h.idx] || !RELEVANT_HEADING.test(h.title)) continue;
    const next = headings.find((n) => n.idx > h.idx && n.level <= h.level);
    const end = next ? next.idx : lines.length;
    for (let i = h.idx; i < end; i++) covered[i] = true;
    const body = lines.slice(h.idx, end).join("\n").trim();
    if (body.split("\n").length > 1) {
      chunks.push(body);
      taken.push(h.title);
    }
  }

  const loose: string[] = [];
  lines.forEach((line, i) => {
    if (covered[i] || inFence[i] || HEADING_RE.test(line)) return;
    if (COMMIT_LINE.test(line) && line.trim()) loose.push(line.trim());
  });
  if (loose.length) chunks.push(loose.join("\n"));

  let text = chunks.join("\n\n").trim();
  if (text.length > MAX_SOURCE_CHARS) text = `${text.slice(0, MAX_SOURCE_CHARS)}\n[truncated]`;
  return { headings: taken, text };
}
