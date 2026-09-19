import { isSensitivePath, scanLine, type Finding } from "./rules.js";

/**
 * Scans a zero-context staged diff for secrets, looking only at added lines (removing a secret
 * isn't a leak). Tracks file and line numbers so the report can point at the exact spot.
 */
export function scanDiff(diff: string, maxFindings = 200): Finding[] {
  const findings: Finding[] = [];
  let path = "";
  let line = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      path = "";
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) {
        const p = raw.slice(4).replace(/\t.*$/, "");
        path = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      } else {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
        if (hunk) {
          line = Number(hunk[1]);
          inHunk = true;
        }
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith("+")) continue; // with -U0 the only other lines are removals
    for (const hit of scanLine(raw.slice(1))) {
      findings.push({ path, line, ruleId: hit.ruleId, label: hit.label });
      if (findings.length >= maxFindings) return findings;
    }
    line++;
  }
  return findings;
}

export interface FileRisk {
  path: string;
  reasons: string[];
}

/** Combines content findings and suspicious file names into one entry per file. */
export function assessRisk(findings: Finding[], paths: string[]): FileRisk[] {
  const byFile = new Map<string, Map<string, number[]>>();
  const add = (path: string, reason: string, line?: number) => {
    const reasons = byFile.get(path) ?? new Map<string, number[]>();
    const lines = reasons.get(reason) ?? [];
    if (line) lines.push(line);
    reasons.set(reason, lines);
    byFile.set(path, reasons);
  };

  for (const p of paths) if (isSensitivePath(p)) add(p, "file name usually holds secrets");
  for (const f of findings) add(f.path, f.label, f.line);

  return [...byFile.entries()].map(([path, reasons]) => ({
    path,
    reasons: [...reasons.entries()].map(([reason, lines]) => {
      const shown = lines.slice(0, 3).join(", ");
      return lines.length ? `${reason} (line${lines.length > 1 ? "s" : ""} ${shown}${lines.length > 3 ? "…" : ""})` : reason;
    }),
  }));
}
