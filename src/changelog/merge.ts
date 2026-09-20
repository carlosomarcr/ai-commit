import { GROUP_ORDER, type Group, type Item, type ParsedCommit } from "./commits.js";
import { bulletLine } from "./document.js";

const MARKER = /^[ \t]*<!--\s*gitowl:([0-9a-f]{7,40})\s*-->[ \t]*\n?/m;

/** Hash of the last commit a pending section was generated from (an invisible HTML comment). */
export function readMarker(text: string): string | null {
  return MARKER.exec(text)?.[1] ?? null;
}

/** Puts (or moves) the marker on its own line right below the heading. */
export function setMarker(text: string, hash: string): string {
  const clean = text.replace(MARKER, "").replace(/\n{3,}/g, "\n\n");
  const nl = clean.indexOf("\n");
  const head = nl === -1 ? clean : clean.slice(0, nl);
  const rest = nl === -1 ? "" : clean.slice(nl + 1).replace(/^\s+/, "");
  const marker = `<!-- gitowl:${hash} -->`;
  return rest ? `${head}\n\n${marker}\n\n${rest}` : `${head}\n\n${marker}`;
}

export function replaceHeading(text: string, heading: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? heading : `${heading}${text.slice(nl)}`;
}

const STOP = new Set(["with", "from", "that", "this", "when", "into", "than", "then", "also", "only", "have", "each", "after", "before", "while", "instead"]);

const tokens = (s: string) =>
  [...new Set(s.toLowerCase().match(/[a-z0-9áéíóúñü]{4,}/g) ?? [])].filter((t) => !STOP.has(t));

/**
 * For sections written by hand (no marker): a commit counts as already covered when most of its
 * meaningful words appear in the section. Errs towards "covered" only when the evidence is strong,
 * since the user reviews everything before it is written.
 */
export function isCovered(commit: ParsedCommit, sectionText: string): boolean {
  const words = tokens(commit.description);
  if (words.length === 0) return false;
  const haystack = sectionText.toLowerCase();
  // Prefix match so "retry" finds "retries" and "report" finds "reporting".
  const hits = words.filter((w) => haystack.includes(w.slice(0, w.length <= 5 ? w.length - 1 : 6))).length;
  return hits / words.length >= 0.6;
}

const GROUP_HEADING = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/;
const isBullet = (line: string) => /^\s*[-*]\s/.test(line);

/**
 * Adds items to an existing section, keeping its layout: under the matching `### Group` when the
 * section is grouped, at the end of the list when it is flat. Returns the new text and the lines added.
 */
export function appendItems(text: string, items: Item[], fallbackGrouped: boolean): { text: string; added: string[] } {
  if (items.length === 0) return { text, added: [] };
  const lines = text.replace(/\s+$/, "").split("\n");
  const hasGroups = lines.some((l) => GROUP_HEADING.test(l) && !/^###\s+Security\s*$/.test(l));
  const hasBullets = lines.some(isBullet);
  const grouped = hasGroups || (!hasBullets && fallbackGrouped);
  const added: string[] = [];

  if (!grouped) {
    // Same order as a freshly generated section: by group, then as given.
    const ordered = GROUP_ORDER.flatMap((g) => items.filter((i) => i.group === g));
    const bullets = ordered.map((i) => bulletLine(i, false));
    const last = [...lines].reverse().find((l) => l.trim() !== "") ?? "";
    if (!isBullet(last)) lines.push("");
    lines.push(...bullets);
    added.push(...bullets);
  } else {
    for (const group of GROUP_ORDER) {
      const groupItems = items.filter((i) => i.group === group);
      if (groupItems.length === 0) continue;
      const bullets = groupItems.map((i) => bulletLine(i, true));
      added.push(...bullets);

      const at = lines.findIndex((l) => l.trim() === `### ${group}`);
      if (at >= 0) {
        let end = lines.findIndex((l, i) => i > at && /^###\s/.test(l));
        if (end === -1) end = lines.length;
        let insert = end;
        while (insert > at + 1 && lines[insert - 1]!.trim() === "") insert--;
        lines.splice(insert, 0, ...bullets);
        continue;
      }

      // New group: keep the conventional order among the groups already present.
      const rank = (g: Group) => GROUP_ORDER.indexOf(g);
      const before = lines.findIndex((l) => {
        const m = GROUP_HEADING.exec(l);
        return m !== null && rank(m[1] as Group) > rank(group);
      });
      const block = [`### ${group}`, "", ...bullets];
      if (before >= 0) lines.splice(before, 0, ...block, "");
      else lines.push("", ...block);
    }
  }
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n"), added };
}
