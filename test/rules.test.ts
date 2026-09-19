import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommitlintConfig } from "../src/rules/commitlint.js";
import { extractCommitRules } from "../src/rules/extract.js";
import { analyzeHistory } from "../src/rules/history.js";
import { loadRules } from "../src/rules/index.js";
import { parseProjectConfig } from "../src/rules/project.js";

describe("extractCommitRules", () => {
  const md = [
    "# Project", "", "Some intro.", "",
    "## Build", "Run pnpm build.", "",
    "## Git Commits", "- Use conventional commits", "- Never mention AI", "",
    "### Scope", "Use the package name as scope.", "",
    "## Style", "Use tabs.", "Always commit lockfile changes separately.", "",
    "```", "# not a heading, commit inside fence", "```",
  ].join("\n");

  it("keeps commit sections (with subsections) and loose commit lines only", () => {
    const { text, headings } = extractCommitRules(md);
    expect(headings).toEqual(["Git Commits"]);
    expect(text).toContain("Never mention AI");
    expect(text).toContain("Use the package name as scope.");
    expect(text).toContain("Always commit lockfile changes separately.");
    expect(text).not.toContain("pnpm build");
    expect(text).not.toContain("Use tabs");
    expect(text).not.toContain("inside fence");
  });

  it("handles headingless files by line filtering", () => {
    const { text } = extractCommitRules("Use tabs\nWrite commit messages in Spanish\nPrefer const");
    expect(text).toBe("Write commit messages in Spanish");
  });

  it("returns nothing when there are no commit rules", () => {
    expect(extractCommitRules("# Hi\nJust code style.").text).toBe("");
  });
});

describe("parseCommitlintConfig", () => {
  it("reads JSON rules and conventional extends", () => {
    const r = parseCommitlintConfig(".commitlintrc.json", JSON.stringify({
      extends: ["@commitlint/config-conventional"],
      rules: { "scope-enum": [2, "always", ["api", "ui"]], "header-max-length": [2, "always", 80] },
    }));
    expect(r?.types).toContain("feat");
    expect(r?.scopes).toEqual(["api", "ui"]);
    expect(r?.maxHeaderLength).toBe(80);
  });

  it("statically parses JS configs", () => {
    const r = parseCommitlintConfig("commitlint.config.js",
      "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix']], 'header-max-length': [2, 'always', 60] } }");
    expect(r).toEqual({ types: ["feat", "fix"], maxHeaderLength: 60 });
  });

  it("ignores package.json without commitlint key", () => {
    expect(parseCommitlintConfig("package.json", '{"name":"x"}')).toBeNull();
  });
});

describe("analyzeHistory", () => {
  it("computes conventional ratio and skips merges", () => {
    const h = analyzeHistory(["feat(a): x", "fix: y", "Merge branch 'z'", "random message"])!;
    expect(h.count).toBe(3);
    expect(h.conventionalRatio).toBeCloseTo(2 / 3);
    expect(h.topTypes).toEqual(["feat", "fix"]);
  });
});

describe("parseProjectConfig", () => {
  it("validates", () => {
    expect(parseProjectConfig('{"style":"free"}').style).toBe("free");
    expect(() => parseProjectConfig('{"style":"nope"}')).toThrow(/style/);
    expect(() => parseProjectConfig("{")).toThrow(/Invalid/);
  });
});

describe("loadRules", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gitowl-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("merges files, dedupes identical ones and prefers the nearest package", async () => {
    await mkdir(join(root, "packages", "web"), { recursive: true });
    await writeFile(join(root, "CLAUDE.md"), "## Commits\nUse conventional commits.\n");
    await writeFile(join(root, "AGENTS.md"), "## Commits\nUse conventional commits.\n"); // duplicate content
    await writeFile(join(root, "commitlint.config.js"), "module.exports={rules:{'header-max-length':[2,'always',50]}}");
    await writeFile(join(root, "packages", "web", "AGENTS.md"), "## Commit rules\nScope is always web.\n");
    await writeFile(join(root, "packages", "web", ".gitowl.json"), '{"language":"es"}');

    const rules = await loadRules({ cwd: join(root, "packages", "web"), root, subjects: [] });
    const labels = rules.sources.map((s) => s.label);
    expect(labels).toContain(".gitowl.json");
    expect(labels).toContain("commitlint.config.js");
    expect(labels.filter((l) => l.includes("§")).length).toBe(2); // web/AGENTS + one of the root duplicates
    expect(rules.text).toContain("Scope is always web.");
    expect(rules.maxHeaderLength).toBe(50);
    expect(rules.language).toBe("es");
  });

  it("falls back to free style when history is clearly not conventional", async () => {
    const subjects = ["Add thing", "Fix bug", "Update docs", "Refactor x", "Bump deps", "Tweak"];
    const rules = await loadRules({ cwd: root, root, subjects });
    expect(rules.style).toBe("free");
  });

  it("defaults to conventional with no signals", async () => {
    expect((await loadRules({ cwd: root, root, subjects: [] })).style).toBe("conventional");
  });
});
