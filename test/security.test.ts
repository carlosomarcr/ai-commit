import { execa } from "execa";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installInterruptGuard } from "../src/commands/safety.js";
import * as git from "../src/git/git.js";
import { executePlan } from "../src/grouping/execute.js";
import { capClusters, monorepoHint } from "../src/grouping/planner.js";
import { collectSummaries, renderDiffs } from "../src/grouping/summarize.js";
import { request } from "../src/providers/http.js";
import { ProviderError } from "../src/providers/types.js";
import { compileIgnore, globToRegExp } from "../src/security/ignore.js";
import { entropy, isSensitivePath, redact, scanLine } from "../src/security/rules.js";
import { assessRisk, scanDiff } from "../src/security/scan.js";

// Fake credentials, assembled at runtime so this file itself never trips a secret scanner.
const AWS = "AKIA" + "IOSFODNN7QWERTYU";
const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const OPENAI = "sk-" + "proj-Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6";
const PEM_HEAD = "-----BEGIN " + "RSA PRIVATE KEY-----";

describe("secret rules", () => {
  it("detects well-known token formats", () => {
    expect(scanLine(`key = "${AWS}"`).map((h) => h.ruleId)).toContain("aws-access-key");
    expect(scanLine(`token: ${GH}`).map((h) => h.ruleId)).toContain("github-token");
    expect(scanLine(`OPENAI=${OPENAI}`).map((h) => h.ruleId)).toContain("openai-key");
    expect(scanLine(PEM_HEAD).map((h) => h.ruleId)).toContain("private-key");
    expect(scanLine("postgres://admin:hunter2secret@db.internal:5432/app").map((h) => h.ruleId)).toContain("url-credentials");
  });

  it("flags high-entropy hard-coded secrets but not placeholders or words", () => {
    expect(scanLine('const password = "k8Zq2mV9xR4tBw7YpL3n"').map((h) => h.ruleId)).toContain("generic-secret");
    expect(scanLine('const password = "your-password-here-please"')).toEqual([]);
    expect(scanLine('const apiKey = process.env.API_KEY_FROM_ENVIRONMENT')).toEqual([]);
    expect(scanLine('secret: "aaaaaaaaaaaaaaaaaaaa"')).toEqual([]); // low entropy
    expect(scanLine("const label = 'passwordFieldLabelText'")).toEqual([]);
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });

  it("redacts secrets, including multi-line private keys, before anything leaves the machine", () => {
    const text = `a\n+key=${AWS}\n+${PEM_HEAD}\n+MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n+abcdefghijklmnop\n+-----END ${"RSA PRIVATE KEY"}-----\n+ok`;
    const out = redact(text);
    expect(out).not.toContain(AWS);
    expect(out).not.toContain("MIIEvQIBADANBg");
    expect(out).toContain("[REDACTED:aws-access-key]");
    expect(out).toContain("[REDACTED:private-key]");
    expect(out).toContain("+ok");
  });

  it("redacts only the value in generic assignments, keeping the code readable", () => {
    const out = redact('const password = "k8Zq2mV9xR4tBw7YpL3n";');
    expect(out).toBe('const password = "[REDACTED:generic-secret]";');
  });

  it("knows secret-bearing file names, but not examples or public keys", () => {
    for (const p of [".env", "app/.env.production", "certs/server.pem", "id_rsa", "config/credentials.json", ".npmrc", "infra/terraform.tfvars"]) {
      expect(isSensitivePath(p), p).toBe(true);
    }
    for (const p of [".env.example", "src/environment.ts", "id_rsa.pub", "docs/keys.md", "src/key.ts"]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});

describe("scanDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +10,3 @@",
    "+const ok = 1;",
    `+const k = "${AWS}";`,
    "+const also = 2;",
    "diff --git a/old.ts b/old.ts",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -5 +5 @@",
    `-const removed = "${AWS}";`,
    "+const safe = 1;",
  ].join("\n");

  it("reports file and line for added lines only", () => {
    const f = scanDiff(diff);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ path: "src/a.ts", line: 11, ruleId: "aws-access-key" });
  });

  it("groups findings and file-name risks per file", () => {
    const risks = assessRisk(scanDiff(diff), ["src/a.ts", ".env", "README.md"]);
    expect(risks.map((r) => r.path).sort()).toEqual([".env", "src/a.ts"]);
    expect(risks.find((r) => r.path === "src/a.ts")!.reasons[0]).toMatch(/AWS access key \(line 11\)/);
    expect(risks.find((r) => r.path === ".env")!.reasons[0]).toMatch(/file name/);
  });

  it("does not treat a removed line starting with dashes as a file header", () => {
    const d = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "--- comment removed", `+k="${AWS}"`].join("\n");
    expect(scanDiff(d)).toHaveLength(1);
  });
});

describe(".gitowlignore matching", () => {
  const ig = compileIgnore("# comment\n\n*.snap\n/build/\ndocs/**/*.pdf\nsecrets/\n!keep.snap\nvendor");
  it("matches gitignore-style patterns", () => {
    expect(ig("a/b/c.snap")).toBe(true);
    expect(ig("build/out.js")).toBe(true);
    expect(ig("src/build/out.js")).toBe(false); // anchored
    expect(ig("docs/a/b/x.pdf")).toBe(true);
    expect(ig("docs/x.pdf")).toBe(true);
    expect(ig("secrets/token.txt")).toBe(true);
    expect(ig("vendor/lib/x.js")).toBe(true);
    expect(ig("src/index.ts")).toBe(false);
  });
  it("supports negation", () => {
    expect(ig("keep.snap")).toBe(false);
  });
  it("escapes regex characters in names", () => {
    expect(globToRegExp("a+b(1).txt").test("a+b(1).txt")).toBe(true);
    expect(globToRegExp("a+b(1).txt").test("aab1.txt")).toBe(false);
  });
});

describe("large change sets", () => {
  it("keeps the biggest clusters and folds the rest into one", () => {
    const clusters = Array.from({ length: 20 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `f${i}-${j}`));
    const capped = capClusters(clusters, 5);
    expect(capped).toHaveLength(5);
    expect(capped.flat()).toHaveLength(clusters.flat().length); // nothing lost
    expect(capped[0]).toHaveLength(20);
  });

  it("hints package scopes only for multi-package monorepos with conventional style", () => {
    const s = (path: string) => ({ path, status: "M", additions: 1, deletions: 0, binary: false, kind: "source" as const });
    const rules = { sources: [], text: "", style: "conventional" as const, history: null };
    expect(monorepoHint([s("packages/web/a.ts"), s("packages/api/b.ts")], rules)).toMatch(/web, api/);
    expect(monorepoHint([s("packages/web/a.ts")], rules)).toBe("");
    expect(monorepoHint([s("packages/web/a.ts"), s("packages/api/b.ts")], { ...rules, scopes: ["x"] })).toBe("");
  });
});

describe("request helper", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("explains connection failures instead of 'fetch failed'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));
    await expect(request("ollama", "http://localhost:11434/api/tags")).rejects.toThrow(/Could not reach ollama at localhost:11434 \(connection refused\)/);
  });

  it("reports timeouts with the provider name", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))));
    const err = await request("deepseek", "https://x.test", { timeoutMs: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/deepseek did not answer within/);
  });

  it("passes through a deliberate cancel", async () => {
    const ctl = new AbortController();
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("cancelled")))));
    const p = request("x", "https://x.test", { signal: ctl.signal, timeoutMs: 5000 });
    ctl.abort();
    await expect(p).rejects.toThrow("cancelled");
  });
});

describe("interrupt guard", () => {
  function fakeProc() {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      on: (e: string, fn: () => void) => void handlers.set(e, fn),
      off: (e: string) => void handlers.delete(e),
      exit: vi.fn((code: number) => {
        throw new Error(`exit ${code}`);
      }) as unknown as (code: number) => never,
    };
  }

  it("restores the index on any exit before commits start, and on SIGINT", () => {
    const proc = fakeProc();
    const restore = vi.fn();
    const g = installInterruptGuard(restore, proc, () => {});
    proc.handlers.get("exit")!();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(() => proc.handlers.get("SIGINT")!()).toThrow("exit 130");
    expect(restore).toHaveBeenCalledTimes(2);
    g.dispose();
    expect(proc.handlers.size).toBe(0);
  });

  it("during commits, Ctrl+C asks to stop after the current commit and does not touch the index", () => {
    const proc = fakeProc();
    const restore = vi.fn();
    const g = installInterruptGuard(restore, proc, () => {});
    g.startExecution();
    proc.handlers.get("SIGINT")!();
    expect(g.shouldStop()).toBe(true);
    proc.handlers.get("exit")!();
    expect(restore).not.toHaveBeenCalled();
    expect(() => proc.handlers.get("SIGINT")!()).toThrow("exit 130"); // second press forces exit
  });
});

// --- real git ------------------------------------------------------------------------------
describe("with a real repository", () => {
  let dir: string;
  const cwd = process.cwd();
  const sh = async (...args: string[]) => (await execa("git", args, { cwd: dir })).stdout;
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gitowl-sec-"));
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

  it("finds a secret in staged content and never puts it in the summaries sent to the AI", async () => {
    await write("src/app.ts", `export const cfg = { key: "${AWS}" };\n`);
    await write(".env", "TOKEN=abc\n");
    await write("docs/x.md", "hello\n");
    await git.stageAll();

    const risks = assessRisk(scanDiff(await git.stagedAddedLinesDiff()), ["src/app.ts", ".env", "docs/x.md"]);
    expect(risks.map((r) => r.path).sort()).toEqual([".env", "src/app.ts"]);

    const files = (await git.status()).filter(git.isStaged);
    const summaries = await collectSummaries(files, { ignore: compileIgnore("docs/") });
    const payload = renderDiffs(summaries, 10_000);
    expect(payload).not.toContain(AWS);
    expect(payload).toContain("[REDACTED:aws-access-key]");
    expect(payload).not.toContain("TOKEN=abc");
    expect(payload).toContain("sensitive file, content withheld");
    expect(payload).toContain("listed in .gitowlignore");
    expect(payload).not.toContain("hello");
  });

  it("detects a merge in progress", async () => {
    await write("a.txt", "1\n");
    await sh("add", "-A");
    await sh("commit", "-qm", "init");
    expect(await git.operationInProgress()).toBeNull();
    await writeFile(join(dir, ".git", "MERGE_HEAD"), (await sh("rev-parse", "HEAD")) + "\n");
    expect(await git.operationInProgress()).toBe("merge");
  });

  it("stops between commits when asked, keeping done commits and restoring the user's staging", async () => {
    await write("a.ts", "a\n");
    await write("b.ts", "b\n");
    await write("c.ts", "c\n");
    const origTree = await git.writeTree();
    await git.stageAll();
    const fullTree = await git.writeTree();
    const summaries = await collectSummaries((await git.status()).filter(git.isStaged));
    const mk = (id: string, files: string[]) => ({ id, files, message: { type: "chore", title: id } });

    let stop = false;
    const res = await executePlan([mk("g1", ["a.ts"]), mk("g2", ["b.ts"]), mk("g3", ["c.ts"])], { origTree, fullTree, summaries, restoreSkipped: false }, {
      onCommitted: () => {
        stop = true; // simulate Ctrl+C right after the first commit
      },
      shouldStop: () => stop,
      onFailure: async () => "abort",
    });

    expect(res.aborted).toBe(true);
    expect(res.committed).toHaveLength(1);
    expect(await sh("log", "--format=%s")).toBe("chore: g1");
    expect(await sh("status", "--porcelain")).toBe("?? b.ts\n?? c.ts");
  });
});
