import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { summarizeCommits } from "../src/changelog/ai.js";
import { itemsFromCommits, parseCommit, parseCommits } from "../src/changelog/commits.js";
import {
  DEFAULT_STYLE,
  compareVersions,
  detectStyle,
  parseChangelog,
  renderSection,
  serialize,
  upsertSection,
} from "../src/changelog/document.js";
import { planTargets, tagVersion } from "../src/changelog/releases.js";
import * as git from "../src/git/git.js";
import type { Provider } from "../src/providers/types.js";

const c = (subject: string, body = "") => ({ hash: "abc1234", subject, body });

describe("parseCommit", () => {
  it("classifies conventional commits", () => {
    expect(parseCommit(c("feat(ui): add dark mode"))?.group).toBe("Added");
    expect(parseCommit(c("fix: crash on empty input"))?.group).toBe("Fixed");
    expect(parseCommit(c("perf(db): cache lookups"))?.group).toBe("Changed");
    expect(parseCommit(c("refactor: drop legacy flag"))?.group).toBe("Removed");
    expect(parseCommit(c("fix(security): escape html"))?.group).toBe("Security");
  });

  it("drops noise: merges, version bumps, release and changelog commits, internal types", () => {
    const noise = [
      "Merge branch 'x'",
      "0.1.2",
      "v1.0.0",
      "docs(changelog): add 0.1.2",
      "chore(release): 1.0.0",
      "chore: update changelog",
      "test: cover x",
      "ci: pin node",
      "wip",
    ];
    for (const s of noise) expect(parseCommit(c(s)), s).toBeNull();
    expect(parseCommit(c("docs: explain flags"), { allTypes: true })?.group).toBe("Changed");
  });

  it("always keeps breaking changes, even for internal types", () => {
    expect(parseCommit(c("chore!: drop node 18"))?.breaking).toBe(true);
    expect(parseCommit(c("refactor: x", "BREAKING CHANGE: config moved"))?.breaking).toBe(true);
  });

  it("classifies free-form subjects by verb and strips duplicated prefixes", () => {
    expect(parseCommit(c("Add export command"))?.group).toBe("Added");
    expect(parseCommit(c("Fix typo in error"))?.group).toBe("Fixed");
    expect(parseCommit(c("feat(git): feat(git): add retry"))?.description).toBe("add retry");
  });

  it("collapses duplicates and tidies text", () => {
    const items = itemsFromCommits(parseCommits([c("feat: add x."), c("feat: Add x")]));
    expect(items).toEqual([{ group: "Added", text: "Add x", breaking: false }]);
  });
});

const FLAT = `# Changelog

## 0.1.1

- Something

## 0.1.0 (2026-09-19)

### Features
- First
`;

const KAC = `# Changelog

## [Unreleased]

### Added

- Pending

## [1.0.0] - 2026-01-02

### Fixed

- Old

[Unreleased]: https://example.com/compare/v1.0.0...HEAD
[1.0.0]: https://example.com/releases/v1.0.0
`;

describe("changelog document", () => {
  it("round-trips without touching content", () => {
    for (const raw of [FLAT, KAC, FLAT.replace(/\n/g, "\r\n")]) expect(serialize(parseChangelog(raw))).toBe(raw);
  });

  it("keeps link references out of the last section and ignores headings in code fences", () => {
    const doc = parseChangelog(KAC);
    expect(doc.footer).toContain("[1.0.0]: https://example.com");
    expect(doc.sections.map((s) => s.version)).toEqual(["Unreleased", "1.0.0"]);
    const fenced = parseChangelog("# C\n\n## 1.0.0\n\n```\n## 9.9.9\n```\n");
    expect(fenced.sections.map((s) => s.version)).toEqual(["1.0.0"]);
  });

  it("detects the file's own style", () => {
    expect(detectStyle(parseChangelog(FLAT))).toEqual({ grouped: false, bracket: false, date: "none" });
    expect(detectStyle(parseChangelog(KAC))).toEqual({ grouped: true, bracket: true, date: "dash" });
    expect(detectStyle(parseChangelog(""))).toEqual(DEFAULT_STYLE);
  });

  it("renders grouped and flat sections", () => {
    const items = [
      { group: "Added" as const, text: "New thing", breaking: false },
      { group: "Fixed" as const, text: "Old bug", breaking: false },
      { group: "Changed" as const, text: "Renamed flag", breaking: true },
    ];
    expect(renderSection("1.1.0", "2026-02-03", items, DEFAULT_STYLE)).toBe(
      "## [1.1.0] - 2026-02-03\n\n### Added\n\n- New thing\n\n### Changed\n\n- **Breaking:** Renamed flag\n\n### Fixed\n\n- Old bug",
    );
    expect(renderSection("1.1.0", "2026-02-03", items, { grouped: false, bracket: false, date: "none" })).toBe(
      "## 1.1.0\n\n- New thing\n- **Breaking:** Renamed flag\n- Fix: Old bug",
    );
  });

  it("inserts by version, is idempotent and only replaces on request", () => {
    const doc = parseChangelog(FLAT);
    expect(upsertSection(doc, "0.2.0", "## 0.2.0\n\n- new", {})).toBe("added");
    expect(upsertSection(doc, "0.0.9", "## 0.0.9\n\n- older", {})).toBe("added");
    expect(doc.sections.map((s) => s.version)).toEqual(["0.2.0", "0.1.1", "0.1.0", "0.0.9"]);
    expect(upsertSection(doc, "0.2.0", "## 0.2.0\n\n- other", {})).toBe("skipped");
    expect(upsertSection(doc, "0.2.0", "## 0.2.0\n\n- other", { replace: true })).toBe("replaced");
    expect(doc.sections[0]!.text).toContain("other");
  });

  it("turns Unreleased into the release being cut", () => {
    const doc = parseChangelog(KAC);
    expect(upsertSection(doc, "1.1.0", "## [1.1.0]\n\n- x", { absorbUnreleased: true })).toBe("replaced");
    expect(doc.sections.map((s) => s.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(serialize(doc).endsWith("[1.0.0]: https://example.com/releases/v1.0.0\n")).toBe(true);
  });

  it("compares versions", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("Unreleased", "99.0.0")).toBeGreaterThan(0);
  });
});

describe("summarizeCommits", () => {
  const provider = (replies: string[]): Provider => ({
    name: "fake",
    listModels: async () => [],
    generate: async () => replies.shift() ?? "",
  });
  const commits = parseCommits([c("feat: add x"), c("fix: y")]);

  it("normalizes groups and text, retrying invalid JSON", async () => {
    const items = await summarizeCommits({
      provider: provider([
        "nope",
        '{"entries":[{"group":"fixed","text":"- Fixed y."},{"group":"weird","text":"Did z","breaking":true}]}',
      ]),
      commits,
      language: "en",
      examples: [],
    });
    expect(items).toEqual([
      { group: "Fixed", text: "Fixed y", breaking: false },
      { group: "Changed", text: "Did z", breaking: true },
    ]);
  });

  it("throws when the model never returns valid JSON", async () => {
    await expect(
      summarizeCommits({ provider: provider(["a", "b", "c"]), commits, language: "en", examples: [] }),
    ).rejects.toThrow(/valid release notes/);
  });
});

describe("tagVersion", () => {
  it("extracts versions from common tag styles", () => {
    expect(tagVersion("v1.2.3")).toBe("1.2.3");
    expect(tagVersion("1.2.3")).toBe("1.2.3");
    expect(tagVersion("pkg@1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(tagVersion("latest")).toBeNull();
  });
});

describe("planTargets (real git)", () => {
  let dir: string;
  const cwd = process.cwd();
  const sh = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout;
  const commit = async (msg: string) => {
    await writeFile(join(dir, "f.txt"), `${Math.random()}`);
    await sh("add", "-A");
    await sh("commit", "-q", "-m", msg);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitowl-cl-"));
    process.chdir(dir);
    await sh("init", "-q");
    await sh("config", "user.email", "t@t.t");
    await sh("config", "user.name", "t");
    await sh("config", "commit.gpgsign", "false");
    await sh("config", "tag.gpgsign", "false");
    await commit("feat: first");
    await sh("tag", "v0.1.0");
    await commit("fix: second");
    await commit("feat: third");
    await sh("tag", "v0.2.0");
    await commit("fix: fourth");
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("plans pending commits plus tagged releases missing from the file", async () => {
    const { targets, skippedOlder } = await planTargets({
      existing: new Set(["0.1.0"]),
      limit: 10,
      packageVersion: "0.3.0",
    });
    expect(skippedOlder).toBe(0);
    expect(targets.map((t) => [t.version, t.from, t.to])).toEqual([
      ["0.3.0", "v0.2.0", "HEAD"],
      ["0.2.0", "v0.1.0", "v0.2.0"],
    ]);
    const subjects = async (t: { from: string | null; to: string }) =>
      (await git.commitsBetween(t.from, t.to)).map((x) => x.subject);
    expect(await subjects(targets[0]!)).toEqual(["fix: fourth"]);
    expect(await subjects(targets[1]!)).toEqual(["fix: second", "feat: third"]);
  });

  it("uses Unreleased when package.json's version is already tagged, and honours --limit", async () => {
    const { targets, skippedOlder } = await planTargets({ existing: new Set(), limit: 1, packageVersion: "0.2.0" });
    expect(targets.map((t) => t.version)).toEqual(["Unreleased", "0.2.0"]);
    expect(skippedOlder).toBe(1);
  });

  it("handles an explicit range", async () => {
    const { targets } = await planTargets({ existing: new Set(), from: "v0.1.0", release: "v9.9.9", limit: 10 });
    expect(targets).toMatchObject([{ version: "9.9.9", from: "v0.1.0", to: "HEAD" }]);
  });
});
