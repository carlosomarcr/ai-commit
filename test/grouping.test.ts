import { describe, expect, it } from "vitest";
import { collapse, dropGroup, mergeGroups, moveFiles } from "../src/grouping/edit.js";
import { classify, heuristicClusters, unitOf } from "../src/grouping/heuristics.js";
import { normalizePlan, planCommits } from "../src/grouping/planner.js";
import { renderDiffs } from "../src/grouping/summarize.js";
import type { CommitGroup, FileSummary } from "../src/grouping/types.js";
import type { Provider } from "../src/providers/types.js";
import type { ProjectRules } from "../src/rules/types.js";

const sum = (path: string, extra: Partial<FileSummary> = {}): FileSummary => ({
  path, status: "M", additions: 1, deletions: 0, binary: false, kind: classify(path), ...extra,
});
const rules: ProjectRules = { sources: [], text: "", style: "conventional", history: null };
const mock = (replies: string[]): Provider => {
  let i = 0;
  return { name: "mock", listModels: async () => [], generate: async () => replies[Math.min(i++, replies.length - 1)]! };
};

describe("classify / heuristics", () => {
  it("classifies common files", () => {
    expect(classify("pnpm-lock.yaml")).toBe("lock");
    expect(classify("package.json")).toBe("deps");
    expect(classify("src/a.test.ts")).toBe("test");
    expect(classify("tests/x.py")).toBe("test");
    expect(classify(".github/workflows/ci.yml")).toBe("ci");
    expect(classify("README.md")).toBe("docs");
    expect(classify("tsconfig.json")).toBe("config");
    expect(classify("dist/cli.js")).toBe("generated");
    expect(classify("src/auth/login.ts")).toBe("source");
  });

  it("knows monorepo units", () => {
    expect(unitOf("packages/web/src/a.ts")).toBe("packages/web");
    expect(unitOf("src/auth/login.ts")).toBe("src/auth");
    expect(unitOf("index.ts")).toBe("root");
  });

  it("keeps lockfile with manifest, tests with source, and separates docs/CI", () => {
    const clusters = heuristicClusters(
      ["package.json", "pnpm-lock.yaml", "src/auth/login.ts", "src/auth/login.test.ts", "src/ui/button.ts", "README.md", ".github/workflows/ci.yml"].map((path) => ({ path })),
    );
    const has = (a: string, b: string) => clusters.some((c) => c.includes(a) && c.includes(b));
    expect(has("package.json", "pnpm-lock.yaml")).toBe(true);
    expect(has("src/auth/login.ts", "src/auth/login.test.ts")).toBe(true);
    expect(has("src/auth/login.ts", "src/ui/button.ts")).toBe(false);
    expect(has("README.md", ".github/workflows/ci.yml")).toBe(false);
  });
});

describe("normalizePlan", () => {
  const files = ["a.ts", "b.ts", "docs/x.md"].map((p) => sum(p));
  const commit = (over: object) => ({ type: "feat", title: "t", files: ["a.ts"], ...over });

  it("drops invented and duplicate files and places forgotten ones by folder", () => {
    const { groups, problems } = normalizePlan(
      { commits: [commit({ files: ["a.ts", "ghost.ts"] }), commit({ files: ["a.ts", "docs/x.md"] })] },
      files,
    );
    expect(groups.flatMap((g) => g.files).sort()).toEqual(["a.ts", "b.ts", "docs/x.md"]);
    expect(problems.join(" ")).toMatch(/ghost\.ts.*not a changed file/);
    expect(problems.join(" ")).toMatch(/more than one commit/);
    expect(problems.join(" ")).toMatch(/not in any commit: b\.ts/);
  });

  it("accepts the old path of a renamed file and ./ prefixes", () => {
    const { groups, problems } = normalizePlan(
      { commits: [commit({ files: ["./old.ts"] })] },
      [sum("new.ts", { orig: "old.ts", status: "R" })],
    );
    expect(groups[0]!.files).toEqual(["new.ts"]);
    expect(problems).toEqual([]);
  });
});

describe("planCommits", () => {
  const files = ["src/a.ts", "src/a.test.ts", "README.md"].map((p) => sum(p));
  const good = JSON.stringify({
    commits: [
      { type: "feat", title: "add a", files: ["src/a.ts", "src/a.test.ts"], rationale: "code with tests" },
      { type: "docs", title: "update readme", files: ["README.md"] },
    ],
  });

  it("returns the model's plan when valid", async () => {
    const plan = await planCommits({ provider: mock([good]), summaries: files, language: "en", rules });
    expect(plan.groups.map((g) => g.files.length)).toEqual([2, 1]);
    expect(plan.warnings).toEqual([]);
  });

  it("retries with feedback when files are missing, then accepts the fixed plan", async () => {
    const bad = JSON.stringify({ commits: [{ type: "feat", title: "x", files: ["src/a.ts"] }] });
    let prompts: string[] = [];
    const provider: Provider = {
      name: "m", listModels: async () => [],
      generate: async ({ user }) => (prompts.push(user), prompts.length === 1 ? bad : good),
    };
    const plan = await planCommits({ provider, summaries: files, language: "en", rules });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("not in any commit");
    expect(plan.groups).toHaveLength(2);
  });

  it("repairs (with warnings) when the model keeps omitting files", async () => {
    const bad = JSON.stringify({ commits: [{ type: "feat", title: "x", files: ["src/a.ts"] }] });
    const plan = await planCommits({ provider: mock([bad]), summaries: files, language: "en", rules });
    expect(plan.groups.flatMap((g) => g.files).sort()).toEqual(["README.md", "src/a.test.ts", "src/a.ts"]);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });

  it("falls back to heuristic groups when the model never returns JSON", async () => {
    const provider: Provider = {
      name: "m", listModels: async () => [],
      // plan attempts get garbage; per-group message calls (they mention "commit messages") get a valid message
      generate: async ({ system }) => (system.includes("split a set") ? "garbage" : '{"type":"chore","title":"stuff"}'),
    };
    const plan = await planCommits({ provider, summaries: files, language: "en", rules });
    expect(plan.warnings[0]).toMatch(/heuristics/);
    expect(plan.groups.flatMap((g) => g.files).sort()).toEqual(["README.md", "src/a.test.ts", "src/a.ts"]);
    expect(plan.groups.length).toBeGreaterThan(1);
  });

  it("skips planning for a single file", async () => {
    const plan = await planCommits({ provider: mock(['{"type":"fix","title":"one"}']), summaries: [sum("a.ts")], language: "en", rules });
    expect(plan.groups).toHaveLength(1);
  });
});

describe("plan editing", () => {
  const mk = (id: string, files: string[]): CommitGroup => ({ id, files, message: { type: "feat", title: id } });
  const summaries = ["a", "b", "c", "d"].map((f) => sum(`${f}.ts`));
  const groups = [mk("g1", ["a.ts", "b.ts"]), mk("g2", ["c.ts"]), mk("g3", ["d.ts"])];

  it("moves files to an existing group and flags both as touched", () => {
    const r = moveFiles(groups, ["b.ts"], "g2", summaries);
    expect(r.groups.map((g) => g.files)).toEqual([["a.ts"], ["c.ts", "b.ts"], ["d.ts"]]);
    expect(r.touched.sort()).toEqual(["g1", "g2"]);
  });

  it("moving to a new group creates it, and emptied groups vanish", () => {
    const r = moveFiles(groups, ["c.ts"], "new", summaries);
    expect(r.groups.map((g) => g.id)).toEqual(["g1", "g3", "g4"]);
    expect(r.groups.at(-1)!.files).toEqual(["c.ts"]);
    expect(r.touched).toEqual(["g4"]);
  });

  it("merges into the first group's position and collapses everything", () => {
    const m = mergeGroups(groups, ["g3", "g1"]);
    expect(m.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(m.groups[0]!.files).toEqual(["a.ts", "b.ts", "d.ts"]);
    const all = collapse(groups);
    expect(all.groups).toHaveLength(1);
    expect(all.groups[0]!.files).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("drops a group", () => {
    expect(dropGroup(groups, "g2").map((g) => g.id)).toEqual(["g1", "g3"]);
  });
});

describe("renderDiffs", () => {
  it("shares the budget fairly and describes files without content", () => {
    const s = [
      sum("small.ts", { diff: "x".repeat(100) }),
      sum("huge.ts", { diff: "y".repeat(10_000) }),
      sum("pnpm-lock.yaml", { additions: 900 }),
    ];
    const out = renderDiffs(s, 1000);
    expect(out).toContain("x".repeat(100)); // small file kept whole
    expect(out).toContain("[truncated]");
    expect(out).toContain("lockfile, +900");
    expect(out.length).toBeLessThan(1500);
  });
});
