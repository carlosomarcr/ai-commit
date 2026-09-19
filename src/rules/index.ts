import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { COMMITLINT_FILES, parseCommitlintConfig } from "./commitlint.js";
import { extractCommitRules } from "./extract.js";
import { analyzeHistory } from "./history.js";
import { parseProjectConfig, type ProjectConfig } from "./project.js";
import type { CommitStyle, ProjectRules, RuleSource } from "./types.js";

/** Files that may hold commit rules, in priority order within the same directory. */
const AGENT_FILES = [
  "AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md", "GEMINI.md",
  ".github/copilot-instructions.md", ".cursorrules", ".windsurfrules",
  "CONTRIBUTING.md", ".github/CONTRIBUTING.md", "docs/CONTRIBUTING.md",
];
const CURSOR_RULES_DIR = ".cursor/rules";
const TEMPLATE_FILE = ".gitmessage";
const PROJECT_FILE = ".gitowl.json";

const MAX_TOTAL_CHARS = 6000;

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Directories from `cwd` up to `root` (inclusive); nearest first, so monorepo packages win. */
export function dirsUp(cwd: string, root: string): string[] {
  const top = resolve(root);
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (dir === top || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return dirs;
}

async function findNearest(dirs: string[], rel: string): Promise<{ path: string; content: string } | null> {
  for (const dir of dirs) {
    const path = join(dir, rel);
    const content = await readIfExists(path);
    if (content !== null) return { path, content };
  }
  return null;
}

export interface LoadRulesOptions {
  cwd: string;
  root: string;
  subjects: string[];
}

export async function loadRules({ cwd, root, subjects }: LoadRulesOptions): Promise<ProjectRules> {
  const dirs = dirsUp(cwd, root);
  const show = (p: string) => relative(root, p).split(sep).join("/") || p;
  const sources: RuleSource[] = [];

  // 1. .gitowl.json (highest priority)
  let project: ProjectConfig = {};
  const proj = await findNearest(dirs, PROJECT_FILE);
  if (proj) {
    project = parseProjectConfig(proj.content);
    sources.push({ label: PROJECT_FILE, path: proj.path, kind: "project" });
  }

  // 2. commitlint (hard constraints)
  let commitlint: ReturnType<typeof parseCommitlintConfig> = null;
  outer: for (const dir of dirs) {
    for (const name of COMMITLINT_FILES) {
      const content = await readIfExists(join(dir, name));
      if (content === null) continue;
      const parsed = parseCommitlintConfig(name, content);
      if (parsed) {
        commitlint = parsed;
        sources.push({ label: name === "package.json" ? "package.json (commitlint)" : name, path: join(dir, name), kind: "commitlint" });
        break outer;
      }
    }
  }

  // 3. Agent / contributing files: keep only commit-related excerpts
  const candidates: { rel: string; path: string; content: string }[] = [];
  for (const rel of AGENT_FILES) {
    const hit = await findNearest(dirs, rel);
    if (hit) candidates.push({ rel, ...hit });
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = (await readdir(join(dir, CURSOR_RULES_DIR))).filter((n) => /\.(md|mdc)$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const path = join(dir, CURSOR_RULES_DIR, n);
      const content = await readIfExists(path);
      if (content !== null) candidates.push({ rel: `${CURSOR_RULES_DIR}/${n}`, path, content });
    }
    break;
  }

  const seen = new Set<string>(); // CLAUDE.md is often a symlink/copy of AGENTS.md
  const texts: string[] = [];
  let budget = MAX_TOTAL_CHARS;
  for (const c of candidates) {
    const hash = createHash("sha1").update(c.content).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    const { headings, text } = extractCommitRules(c.content);
    if (!text || budget <= 0) continue;
    const clipped = text.slice(0, budget);
    budget -= clipped.length;
    const name = show(c.path);
    texts.push(`### From ${name}\n${clipped}`);
    sources.push({
      label: headings.length ? `${name} §${headings.slice(0, 2).join(", ")}` : `${name} (commit mentions)`,
      path: c.path,
      kind: "agent",
    });
  }

  const template = await findNearest(dirs, TEMPLATE_FILE);
  if (template?.content.trim()) {
    const body = template.content.split("\n").filter((l) => !l.startsWith("#")).join("\n").trim();
    if (body) {
      texts.push(`### Commit template (${TEMPLATE_FILE})\n${body.slice(0, 800)}`);
      sources.push({ label: TEMPLATE_FILE, path: template.path, kind: "template" });
    }
  }

  // 4. History: style hints, and the fallback for style
  const history = analyzeHistory(subjects);
  if (history) sources.push({ label: `last ${history.count} commits`, path: "", kind: "history" });

  let style: CommitStyle = "conventional";
  if (project.style) style = project.style;
  else if (commitlint) style = "conventional";
  else if (history && history.count >= 5 && history.conventionalRatio < 0.3) style = "free";

  return {
    sources,
    text: texts.join("\n\n"),
    style,
    types: project.types ?? commitlint?.types,
    scopes: project.scopes ?? commitlint?.scopes,
    maxHeaderLength: project.maxHeaderLength ?? commitlint?.maxHeaderLength,
    language: project.language,
    instructions: project.instructions,
    history,
  };
}
