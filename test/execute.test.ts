import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as git from "../src/git/git.js";
import { executePlan, type ExecuteHooks } from "../src/grouping/execute.js";
import { collectSummaries } from "../src/grouping/summarize.js";
import type { CommitGroup } from "../src/grouping/types.js";

let dir: string;
const cwd = process.cwd();

const sh = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout;
const write = async (path: string, content: string) => {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), content);
};
const group = (id: string, files: string[], title = id): CommitGroup => ({ id, files, message: { type: "chore", title } });
const noFail: ExecuteHooks = { onFailure: async () => "abort" };

/** Stages everything and prepares the execution context like the CLI does. */
async function prepare() {
  const origTree = await git.writeTree();
  await git.stageAll();
  const fullTree = await git.writeTree();
  const files = (await git.status()).filter(git.isStaged);
  const summaries = await collectSummaries(files);
  return { origTree, fullTree, summaries, restoreSkipped: false };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aicommit-git-"));
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

const filesOf = async (rev: string) => (await sh("show", "--name-status", "--format=", rev)).split("\n").filter(Boolean).sort();

describe("executePlan", () => {
  it("splits changes (modified, new, deleted, untracked) into separate commits", async () => {
    await write("a.ts", "a1\n");
    await write("gone.ts", "x\n");
    await write("README.md", "r\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");

    await write("a.ts", "a2\n");
    await write("src/new.ts", "n\n");
    await write("README.md", "r2\n");
    await rm(join(dir, "gone.ts"));

    const ctx = await prepare();
    const res = await executePlan(
      [group("g1", ["a.ts", "src/new.ts", "gone.ts"], "code"), group("g2", ["README.md"], "docs")],
      ctx,
      noFail,
    );

    expect(res.committed).toHaveLength(2);
    expect(await sh("log", "--format=%s", "-2")).toBe("chore: docs\nchore: code");
    expect(await filesOf("HEAD~1")).toEqual(["A\tsrc/new.ts", "D\tgone.ts", "M\ta.ts"]);
    expect(await filesOf("HEAD")).toEqual(["M\tREADME.md"]);
    expect(await sh("status", "--porcelain")).toBe("");
  });

  it("commits renames as a unit (old path removed, new added)", async () => {
    await write("old-name.ts", "export const value = 12345;\nexport const other = 6789;\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");
    await sh("mv", "old-name.ts", "new-name.ts");
    await write("other.md", "doc\n");

    const ctx = await prepare();
    expect(ctx.summaries.find((s) => s.path === "new-name.ts")?.orig).toBe("old-name.ts");
    await executePlan([group("g1", ["new-name.ts"], "rename"), group("g2", ["other.md"], "docs")], ctx, noFail);

    expect(await sh("ls-files")).toBe("new-name.ts\nother.md");
    expect(await filesOf("HEAD~1")).toEqual([expect.stringMatching(/^R\d+\told-name\.ts\tnew-name\.ts$/)]);
    expect(await sh("status", "--porcelain")).toBe("");
  });

  it("works on a repository with no commits yet", async () => {
    await write("a.ts", "a\n");
    await write("b.ts", "b\n");
    const ctx = await prepare();
    await executePlan([group("g1", ["a.ts"]), group("g2", ["b.ts"])], ctx, noFail);
    expect(await sh("log", "--format=%s")).toBe("chore: g2\nchore: g1");
    expect(await filesOf("HEAD~1")).toEqual(["A\ta.ts"]);
  });

  it("handles paths with spaces, brackets and unicode", async () => {
    await write("app/[id]/page name.tsx", "p\n");
    await write("docs/ñandú.md", "d\n");
    const ctx = await prepare();
    await executePlan([group("g1", ["app/[id]/page name.tsx"]), group("g2", ["docs/ñandú.md"])], ctx, noFail);
    expect(await sh("ls-files", "-z")).toContain("app/[id]/page name.tsx");
    expect((await sh("rev-list", "--count", "HEAD"))).toBe("2");
  });

  it("commits only the staged part of a partially staged file", async () => {
    await write("a.ts", "one\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");
    await write("a.ts", "two\n");
    await sh("add", "a.ts");
    await write("a.ts", "three (unstaged)\n");

    const origTree = await git.writeTree();
    const fullTree = origTree; // staged-only scope: nothing extra gets staged
    const files = (await git.status()).filter(git.isStaged);
    const summaries = await collectSummaries(files);
    await executePlan([group("g1", ["a.ts"])], { origTree, fullTree, summaries, restoreSkipped: true }, noFail);

    expect(await sh("show", "HEAD:a.ts")).toBe("two");
    expect(await sh("status", "--porcelain")).toBe(" M a.ts"); // the unstaged edit survives
  });

  it("restores the original index when the user aborts after a hook failure", async () => {
    await write("a.ts", "a\n");
    await write("b.ts", "b\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");
    await write("a.ts", "a2\n");
    await write("b.ts", "b2\n");
    await sh("add", "b.ts"); // user staged only b.ts

    // Reject the 2nd commit with a hook
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await write(".git/hooks/pre-commit", '#!/bin/sh\n[ -f .fail ] && { echo "lint failed"; exit 1; }\nexit 0\n');
    const { chmod } = await import("node:fs/promises");
    await chmod(hook, 0o755);

    const origTree = await git.writeTree();
    await git.stageAll();
    const fullTree = await git.writeTree();
    const summaries = await collectSummaries((await git.status()).filter(git.isStaged));

    let seen = "";
    let n = 0;
    const res = await executePlan(
      [group("g1", ["a.ts"]), group("g2", ["b.ts"])],
      { origTree, fullTree, summaries, restoreSkipped: false },
      {
        onCommitted: async () => {
          await writeFile(join(dir, ".fail"), "1"); // make the next commit fail
          n++;
        },
        onFailure: async (_g, err) => {
          seen = err.message;
          return "abort";
        },
      },
    );

    expect(n).toBe(1);
    expect(seen).toContain("lint failed");
    expect(res.aborted).toBe(true);
    expect(await sh("diff", "--cached", "--name-only")).toBe("b.ts"); // only the user's own staging is back; a.ts stays committed
  });

  it("skips empty groups and reports them", async () => {
    await write("a.ts", "a\n");
    const ctx = await prepare();
    const empties: string[] = [];
    // A group naming a file that is not in the tree stages nothing.
    const res = await executePlan([group("g1", ["a.ts"]), group("g2", ["ghost.ts"])], ctx, {
      ...noFail,
      onEmpty: (g) => empties.push(g.id),
    });
    expect(res.committed).toHaveLength(1);
    expect(empties).toEqual(["g2"]);
  });
});
