import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as git from "../src/git/git.js";
import { executePlan } from "../src/grouping/execute.js";
import { applyHunks, buildHunkUnits, parseHunks, splitLines } from "../src/grouping/hunks.js";
import { collectSummaries } from "../src/grouping/summarize.js";

let dir: string;
const cwd = process.cwd();
const sh = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout;
const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const text = (arr: string[], trailingNewline = true) => arr.join("\n") + (trailingNewline ? "\n" : "");

/** Diff of two texts as git would print it for one file (context 1). */
async function diffOf(a: string, b: string): Promise<string> {
  await write("a.txt", a);
  await write("b.txt", b);
  const r = await execa("git", ["diff", "--no-index", "--no-color", "-U1", "a.txt", "b.txt"], { cwd: dir, reject: false, stripFinalNewline: false });
  return r.stdout;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gitowl-hunk-"));
  process.chdir(dir);
  await sh("init", "-q");
  await sh("config", "user.email", "t@t.t");
  await sh("config", "user.name", "t");
  await sh("config", "commit.gpgsign", "false");
  await sh("config", "core.autocrlf", "false");
});
afterEach(async () => {
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

describe("parseHunks + applyHunks", () => {
  it("applying every hunk reproduces the new text, in many shapes", async () => {
    const cases: [string, string][] = [
      [text(lines(20)), text(lines(20).map((l, i) => (i === 2 || i === 15 ? l + " changed" : l)))],
      [text(lines(10)), text([...lines(10), "appended"])],
      [text(lines(10)), text(["prepended", ...lines(10)])],
      [text(lines(10)), text(lines(10).filter((_, i) => i !== 0 && i !== 9))], // delete first and last
      [text(lines(10)), text(lines(10).filter((_, i) => i !== 4))],
      [text(lines(10), false), text([...lines(10), "no longer last"], false)], // no newline at EOF on both
      [text(lines(10), false), text(lines(10).map((l, i) => (i === 0 ? "first changed" : l)), true)], // gains newline at EOF
      [text(lines(10), true), text(lines(10).map((l, i) => (i === 0 ? "first changed" : l)), false)], // loses newline at EOF
      ["a\r\nb\r\nc\r\nd\r\ne\r\nf\r\n", "a\r\nB\r\nc\r\nd\r\ne\r\nF\r\n"], // CRLF
      [text(lines(30)), text(lines(30).map((l, i) => (i % 7 === 0 ? `${l} edited` : l)))], // many hunks
    ];
    for (const [a, b] of cases) {
      const hunks = parseHunks(await diffOf(a, b));
      expect(hunks.length).toBeGreaterThan(0);
      expect(applyHunks(a, hunks)).toBe(b);
    }
  });

  it("applying a subset changes only those hunks", async () => {
    const a = text(lines(30));
    const b = text(lines(30).map((l, i) => (i === 2 ? "AAA" : i === 15 ? "BBB" : i === 27 ? "CCC" : l)));
    const hunks = parseHunks(await diffOf(a, b));
    expect(hunks).toHaveLength(3);
    const only = (...idx: number[]) => applyHunks(a, hunks.filter((h) => idx.includes(h.index)));
    expect(only(1)).toBe(text(lines(30).map((l, i) => (i === 2 ? "AAA" : l))));
    expect(only(2, 3)).toBe(text(lines(30).map((l, i) => (i === 15 ? "BBB" : i === 27 ? "CCC" : l))));
    expect(only()).toBe(a);
  });

  it("is order independent when hunks are applied cumulatively (line numbers refer to the original)", async () => {
    const a = text(lines(30));
    const b = text([...lines(30).slice(0, 3), "inserted-1", "inserted-2", ...lines(30).slice(3, 20), ...lines(30).slice(22)]); // grow near top, shrink lower
    const hunks = parseHunks(await diffOf(a, b));
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    const stepwise = applyHunks(a, hunks.slice(0, 1));
    expect(stepwise).not.toBe(b);
    expect(applyHunks(a, hunks)).toBe(b);
    // committing hunk 2 first, then hunk 1 (cumulative from the original) still ends at b
    expect(applyHunks(a, [hunks[1]!, hunks[0]!])).toBe(b);
  });

  it("counts additions and deletions per hunk", async () => {
    const hunks = parseHunks(await diffOf(text(["a", "b", "c", "d", "e", "f", "g", "h"]), text(["a", "B", "B2", "c", "d", "e", "f", "g"])));
    expect(hunks.reduce((n, h) => n + h.additions, 0)).toBeGreaterThan(0);
    expect(hunks[0]!.text.startsWith("@@")).toBe(true);
  });

  it("splitLines keeps terminators", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\n\nb\n")).toEqual(["a\n", "\n", "b\n"]);
  });
});

describe("buildHunkUnits (real git)", () => {
  it("splits a modified file into units and refuses files it can't reproduce exactly", async () => {
    const base = text(lines(40));
    await write("src/big.ts", base);
    await write("src/small.ts", "one\n");
    await write("bin.dat", "x");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");

    await write("src/big.ts", text(lines(40).map((l, i) => (i === 3 ? "top change" : i === 35 ? "bottom change" : l))));
    await write("src/small.ts", "two\n");
    await write("src/new.ts", "brand new\n");
    await git.stageAll();

    const files = (await git.status()).filter(git.isStaged);
    const summaries = await collectSummaries(files);
    const tree = await git.lsTree(await git.writeTree());
    const built = await buildHunkUnits(summaries, tree);

    const ids = built.summaries.map((s) => s.path);
    expect(ids).toContain("src/big.ts#1");
    expect(ids).toContain("src/big.ts#2");
    expect(ids).not.toContain("src/big.ts");
    expect(ids).toContain("src/small.ts"); // one hunk: stays whole
    expect(ids).toContain("src/new.ts"); // added file: stays whole
    expect(built.files.get("src/big.ts")!.hunks).toHaveLength(2);
    expect(built.summaries.find((s) => s.path === "src/big.ts#1")).toMatchObject({ file: "src/big.ts", hunk: 1 });
  });
});

describe("executePlan with hunks (real git)", () => {
  const mk = (id: string, files: string[]) => ({ id, files, message: { type: "chore", title: id } });

  /** 40-line file with three separated changes; the first one ADDS lines so later line numbers shift. */
  async function setup() {
    await write("src/big.ts", text(lines(40)));
    await write("notes.md", "n\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");
    const changed = lines(40);
    changed.splice(3, 1, "top change A", "top change B", "top change C"); // +2 lines
    const withMiddle = changed.map((l) => (l === "line 21" ? "middle change" : l));
    const final = withMiddle.map((l) => (l === "line 38" ? "bottom change" : l));
    await write("src/big.ts", text(final));
    await write("notes.md", "n2\n");
    const origTree = await git.writeTree();
    await git.stageAll();
    const fullTree = await git.writeTree();
    const summaries0 = await collectSummaries((await git.status()).filter(git.isStaged));
    const built = await buildHunkUnits(summaries0, await git.lsTree(fullTree));
    expect(built.files.get("src/big.ts")!.hunks).toHaveLength(3);
    return { origTree, fullTree, built, final: text(final) };
  }


  it("commits different hunks of one file in different commits, in any order", async () => {
    const { origTree, fullTree, built, final } = await setup();
    // Commit the LAST hunk first, then the first, then the middle one: offsets must not matter.
    const res = await executePlan(
      [mk("g1", ["src/big.ts#3"]), mk("g2", ["src/big.ts#1", "notes.md"]), mk("g3", ["src/big.ts#2"])],
      { origTree, fullTree, summaries: built.summaries, restoreSkipped: false, hunkFiles: built.files },
      { onFailure: async () => "abort" },
    );
    expect(res.committed).toHaveLength(3);

    const changedLines = async (rev: string) =>
      (await sh("show", "--format=", "-U0", rev, "--", "src/big.ts")).split("\n").filter((l) => /^[+-][^+-]/.test(l));
    expect(await changedLines("HEAD~2")).toEqual(["-line 38", "+bottom change"]);
    expect(await changedLines("HEAD~1")).toEqual(["-line 4", "+top change A", "+top change B", "+top change C"]);
    expect(await changedLines("HEAD")).toEqual(["-line 21", "+middle change"]);

    expect(await sh("show", "HEAD:src/big.ts")).toBe(final.replace(/\n$/, ""));
    expect(await sh("status", "--porcelain")).toBe("");
  });

  it("leaves a skipped hunk in the working tree, and keeps it staged when the user had staged it", async () => {
    const { origTree, fullTree, built } = await setup();
    // The user had everything staged (staged scope): a skipped hunk must remain staged afterwards.
    const res = await executePlan(
      [mk("g1", ["src/big.ts#1", "notes.md"])],
      { origTree, fullTree, summaries: built.summaries, restoreSkipped: true, leftover: [mk("x", ["src/big.ts#2", "src/big.ts#3"])], hunkFiles: built.files },
      { onFailure: async () => "abort" },
    );
    expect(res.committed).toHaveLength(1);
    const committed = await sh("show", "--format=", "-U0", "HEAD", "--", "src/big.ts");
    expect(committed).toContain("top change A");
    expect(committed).not.toContain("middle change");
    // remaining hunks are staged (index != HEAD) and the working tree is untouched
    const stagedDiff = await sh("diff", "--cached", "-U0", "--", "src/big.ts");
    expect(stagedDiff).toContain("middle change");
    expect(stagedDiff).toContain("bottom change");
    expect(await sh("diff", "--", "src/big.ts")).toBe(""); // index == working tree
  });

  it("aborting midway keeps done hunks committed and restores staging of the rest (staged scope)", async () => {
    const { origTree, fullTree, built } = await setup();
    let first = true;
    const res = await executePlan(
      [mk("g1", ["src/big.ts#1"]), mk("g2", ["src/big.ts#2", "src/big.ts#3"])],
      { origTree, fullTree, summaries: built.summaries, restoreSkipped: true, hunkFiles: built.files },
      {
        onCommitted: () => void (first = false),
        shouldStop: () => !first,
        onFailure: async () => "abort",
      },
    );
    expect(res.aborted).toBe(true);
    expect(res.committed).toHaveLength(1);
    const stagedDiff = await sh("diff", "--cached", "-U0", "--", "src/big.ts");
    expect(stagedDiff).toContain("middle change");
    expect(stagedDiff).toContain("bottom change");
    expect(stagedDiff).not.toContain("top change A"); // already committed, not a staged revert
  });
});
