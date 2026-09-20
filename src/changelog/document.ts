import { GROUP_ORDER, type Group, type Item } from "./commits.js";

export const UNRELEASED = "Unreleased";

export interface Style {
  /** `### Added` / `### Fixed` subsections, or a flat bullet list per version. */
  grouped: boolean;
  /** `## [1.2.3]` instead of `## 1.2.3`. */
  bracket: boolean;
  date: "none" | "paren" | "dash";
}

/** Keep a Changelog layout, used when there is no file (or nothing to copy the style from). */
export const DEFAULT_STYLE: Style = { grouped: true, bracket: true, date: "dash" };

export const DEFAULT_PREAMBLE = "# Changelog\n\nAll notable changes to this project are documented in this file.";

export interface Section {
  /** Normalized version ("1.2.3", "Unreleased") or null for headings that are not releases. */
  version: string | null;
  text: string;
}

export interface Doc {
  eol: "\n" | "\r\n";
  preamble: string;
  sections: Section[];
  /** Trailing link reference definitions (`[1.0.0]: https://...`), kept untouched at the end. */
  footer: string;
}

export function sectionVersion(heading: string): string | null {
  if (/^##\s+\[?unreleased\]?/i.test(heading)) return UNRELEASED;
  const m = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s)]*)\]?/.exec(heading);
  return m ? m[1]! : null;
}

export function parseChangelog(raw: string): Doc {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  // Level-2 headings outside code fences delimit the sections.
  const starts: number[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^##\s+\S/.test(line)) starts.push(i);
  });

  // A trailing block of `[x]: url` definitions belongs to the document, not to the last section.
  let end = lines.length;
  let footerStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/^\[[^\]]+\]:\s*\S+/.test(line)) footerStart = i;
    else if (line.trim() === "") continue;
    else break;
  }
  if (footerStart > (starts[starts.length - 1] ?? -1)) end = footerStart;
  else footerStart = -1;

  const firstStart = starts[0] ?? end;
  const sections: Section[] = starts.map((start, i) => {
    const text = lines.slice(start, starts[i + 1] ?? end).join("\n").trimEnd();
    return { version: sectionVersion(lines[start]!), text };
  });

  return {
    eol,
    preamble: lines.slice(0, firstStart).join("\n").trimEnd(),
    sections,
    footer: footerStart >= 0 ? lines.slice(footerStart).join("\n").trim() : "",
  };
}

export function serialize(doc: Doc): string {
  const parts = [doc.preamble, ...doc.sections.map((s) => s.text)].filter((s) => s.trim());
  let out = parts.join("\n\n");
  if (doc.footer) out += `\n\n${doc.footer}`;
  out += "\n";
  return doc.eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out;
}

/** Copies the conventions of the existing file so new sections look like the old ones. */
export function detectStyle(doc: Doc): Style {
  const released = doc.sections.filter((s) => s.version && s.version !== UNRELEASED).slice(0, 5);
  if (released.length === 0) return DEFAULT_STYLE;

  const majority = (n: number) => n > released.length / 2;
  const heading = (s: Section) => s.text.split("\n", 1)[0]!;
  const bracket = majority(released.filter((s) => /^##\s+\[/.test(heading(s))).length);
  const paren = released.filter((s) => /\(\d{4}-\d{2}-\d{2}\)\s*$/.test(heading(s))).length;
  const dash = released.filter((s) => /\s[-–]\s+\d{4}-\d{2}-\d{2}\s*$/.test(heading(s))).length;
  // "Security" alone is too common as an ordinary heading, so it does not count as evidence.
  const grouped = doc.sections
    .slice(0, 4)
    .some((s) => /^###\s+(Added|Changed|Deprecated|Removed|Fixed)\s*$/m.test(s.text));

  return { grouped, bracket, date: majority(paren) ? "paren" : majority(dash) ? "dash" : "none" };
}

const FLAT_PREFIX: Partial<Record<Group, string>> = {
  Fixed: "Fix: ",
  Removed: "Removed: ",
  Deprecated: "Deprecated: ",
  Security: "Security: ",
};

const bullet = (item: Item, prefix: string) => `- ${item.breaking ? "**Breaking:** " : ""}${prefix}${item.text}`;

/** One changelog line in either layout (flat lists prefix the group, e.g. "Fix: "). */
export const bulletLine = (item: Item, grouped: boolean) => bullet(item, grouped ? "" : (FLAT_PREFIX[item.group] ?? ""));

export function renderHeading(version: string, date: string | undefined, style: Style): string {
  let head = `## ${style.bracket ? `[${version}]` : version}`;
  if (date && version !== UNRELEASED) {
    if (style.date === "paren") head += ` (${date})`;
    else if (style.date === "dash") head += ` - ${date}`;
  }
  return head;
}

export function renderSection(version: string, date: string | undefined, items: Item[], style: Style): string {
  const head = renderHeading(version, date, style);

  const byGroup = new Map<Group, Item[]>();
  for (const item of items) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g));

  const body = style.grouped
    ? groups.map((g) => `### ${g}\n\n${byGroup.get(g)!.map((i) => bullet(i, "")).join("\n")}`).join("\n\n")
    : groups.map((g) => byGroup.get(g)!.map((i) => bullet(i, FLAT_PREFIX[g] ?? "")).join("\n")).join("\n");

  return `${head}\n\n${body}`;
}

/** Numeric semver-ish comparison; "Unreleased" is newer than everything. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNRELEASED) return 1;
  if (b === UNRELEASED) return -1;
  const split = (v: string) => {
    const [main = "", ...pre] = v.split(/[-+]/);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre.join("-") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 1.0.0 is newer than 1.0.0-beta
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type UpsertAction = "added" | "replaced" | "skipped";

/**
 * Puts a rendered section in the right place. An existing section with the same version is only
 * touched when `replace` is set. With `absorbUnreleased`, a pending "Unreleased" section is
 * turned into this release instead of leaving both in the file.
 */
export function upsertSection(
  doc: Doc,
  version: string,
  text: string,
  opts: { replace?: boolean; absorbUnreleased?: boolean } = {},
): UpsertAction {
  const same = doc.sections.findIndex((s) => s.version === version);
  if (same >= 0) {
    if (!opts.replace) return "skipped";
    doc.sections[same] = { version, text };
    return "replaced";
  }

  if (opts.absorbUnreleased && version !== UNRELEASED) {
    const pending = doc.sections.findIndex((s) => s.version === UNRELEASED);
    if (pending >= 0) {
      doc.sections[pending] = { version, text };
      return "replaced";
    }
  }

  const at = doc.sections.findIndex((s) => s.version !== null && compareVersions(s.version, version) < 0);
  const lastRelease = doc.sections.reduce((n, s, i) => (s.version !== null ? i : n), -1);
  doc.sections.splice(at >= 0 ? at : lastRelease + 1, 0, { version, text });
  return "added";
}
