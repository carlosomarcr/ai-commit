import { execa } from "execa";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommit, parseCommits } from "../src/changelog/commits.js";
import { appendItems, isCovered, readMarker, setMarker } from "../src/changelog/merge.js";
import { runChangelog } from "../src/commands/changelog.js";

const c = (subject: string, body = "") => ({ hash: "abc1234", subject, body });

describe("scope filter", () => {
  it("keeps real features and fixes scoped to the changelog, drops maintenance commits", () => {
    expect(parseCommit(c("feat(changelog): implement changelog generation command"))?.group).toBe("Added");
    expect(parseCommit(c("fix(release): wrong tag"))?.group).toBe("Fixed");
    expect(parseCommit(c("docs(changelog): add 0.1.3"))).toBeNull();
    expect(parseCommit(c("chore(release): 1.0.0"))).toBeNull();
  });
});

describe("merging into an existing section", () => {
  const item = (group: "Added" | "Fixed" | "Changed", text: string) => ({ group, text, breaking: false });

  it("sets, reads and moves the marker without touching the rest", () => {
    const once = setMarker("## 1.0.0\n\n- a", "abc1234");
    expect(once).toBe("## 1.0.0\n\n<!-- gitowl:abc1234 -->\n\n- a");
    expect(readMarker(once)).toBe("abc1234");
    expect(setMarker(once, "def5678")).toBe("## 1.0.0\n\n<!-- gitowl:def5678 -->\n\n- a");
  });

  it("appends to a flat list", () => {
    const flat = appendItems("## 1.0.0\n\n- a\n- Fix: b", [item("Fixed", "c"), item("Added", "d")], false);
    expect(flat.added).toEqual(["- d", "- Fix: c"]);
    expect(flat.text).toBe("## 1.0.0\n\n- a\n- Fix: b\n- d\n- Fix: c");
  });

  it("appends to the right group, creating missing ones in order", () => {
    const text = "## 1.0.0\n\n### Added\n\n- a\n\n### Fixed\n\n- b";
    const out = appendItems(text, [item("Fixed", "c"), item("Changed", "d"), item("Added", "e")], true);
    expect(out.text).toBe("## 1.0.0\n\n### Added\n\n- a\n- e\n\n### Changed\n\n- d\n\n### Fixed\n\n- b\n- c");
  });

  it("recognises commits already described by hand-written entries", () => {
    const [retry, cmd] = parseCommits([
      c("feat(git): add lock retry and cleanup error reporting"),
      c("feat: add export command for reports"),
    ]);
    const text = "## 0.1.3\n\n- gitowl retries when index.lock is held and reports cleanup errors";
    expect(isCovered(retry!, text)).toBe(true);
    expect(isCovered(cmd!, text)).toBe(false);
  });
});

describe("runChangelog updates a section that already exists (real git)", () => {
  let dir: string;
  const cwd = process.cwd();
  const sh = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout;
  const commit = async (msg: string) => {
    await writeFile(join(dir, "f.txt"), `${Math.random()}`);
    await sh("add", "-A");
    await sh("commit", "-q", "-m", msg);
  };
  const run = () => runChangelog({ ai: false, yes: true });
  const read = () => readFile(join(dir, "CHANGELOG.md"), "utf8");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitowl-cl2-"));
    process.chdir(dir);
    await sh("init", "-q");
    await sh("config", "user.email", "t@t.t");
    await sh("config", "user.name", "t");
    await sh("config", "commit.gpgsign", "false");
    await sh("config", "tag.gpgsign", "false");
    await commit("feat: first");
    await sh("tag", "v0.1.0");
    await writeFile(join(dir, "package.json"), '{"version":"0.2.0"}');
    await commit("feat: second thing");
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  it("adds only the new commits, keeps existing entries and is idempotent", async () => {
    await run();
    const first = await read();
    expect(first).toContain("## [0.2.0]");
    expect(first).toContain("- Second thing");
    expect(readMarker(first)).toBeTruthy();

    await run();
    expect(await read()).toBe(first);

    await commit("fix: third bug");
    await commit("docs(changelog): update changelog");
    await commit("feat(changelog): fourth feature");
    await run();
    const updated = await read();
    expect(updated.match(/Second thing/g)).toHaveLength(1);
    expect(updated).toMatch(/### Added\n\n- Second thing\n- Fourth feature/);
    expect(updated).toMatch(/### Fixed\n\n- Third bug/);
    expect(updated.match(/^## /gm)).toHaveLength(2);

    await run();
    expect(await read()).toBe(updated);
  }, 30000);

  it("completes a hand-written section without duplicating what it already says", async () => {
    await writeFile(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.2.0\n\n- A second thing was added\n");
    await commit("fix: crash when parsing empty config");
    await run();
    const out = await read();
    expect(out.match(/second thing/gi)).toHaveLength(1);
    expect(out).toContain("- Fix: Crash when parsing empty config");
    expect(out).toContain("<!-- gitowl:");
  }, 30000);
});
