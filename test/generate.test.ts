import { describe, expect, it } from "vitest";
import { buildPrompt, cleanTitle, extractJson, formatMessage, generateMessage, validateMessage } from "../src/commit/generate.js";
import type { Provider } from "../src/providers/types.js";
import type { ProjectRules } from "../src/rules/types.js";

const mock = (replies: string[]): Provider => {
  let i = 0;
  return {
    name: "mock",
    listModels: async () => [],
    generate: async () => replies[Math.min(i++, replies.length - 1)]!,
  };
};

const rules = (over: Partial<ProjectRules> = {}): ProjectRules => ({
  sources: [], text: "", style: "conventional", history: null, ...over,
});
const base = { stat: "a.ts | 2 +-", diff: "diff", language: "en" };

describe("extractJson", () => {
  it("parses fenced and chatty replies", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('here: {"a":2} done')).toEqual({ a: 2 });
  });
  it("throws without JSON", () => {
    expect(() => extractJson("nope")).toThrow();
  });
});

describe("generateMessage", () => {
  it("formats a conventional message", async () => {
    const provider = mock(['{"type":"feat","scope":"auth","title":"add login","body":null}']);
    const msg = await generateMessage({ ...base, provider, rules: rules() });
    expect(formatMessage(msg)).toBe("feat(auth): add login");
  });

  it("retries on invalid output then succeeds", async () => {
    const provider = mock(["garbage", '{"type":"fix","title":"handle null"}']);
    const msg = await generateMessage({ ...base, provider, rules: rules() });
    expect(formatMessage(msg)).toBe("fix: handle null");
  });

  it("retries when a type is not allowed by the rules", async () => {
    const provider = mock(['{"type":"feature","title":"x"}', '{"type":"feat","title":"x"}']);
    const msg = await generateMessage({ ...base, provider, rules: rules({ types: ["feat", "fix"] }) });
    expect(msg.type).toBe("feat");
  });

  it("returns the last message when rules stay violated", async () => {
    const provider = mock(['{"type":"nope","title":"x"}']);
    const msg = await generateMessage({ ...base, provider, rules: rules({ types: ["feat"] }) });
    expect(validateMessage(msg, rules({ types: ["feat"] }))).not.toEqual([]);
  });

  it("fails after repeated invalid JSON", async () => {
    await expect(generateMessage({ ...base, provider: mock(["garbage"]), rules: rules() })).rejects.toThrow(/valid commit message/);
  });
});

describe("validateMessage", () => {
  it("enforces max header length and scopes", () => {
    const r = rules({ maxHeaderLength: 20, scopes: ["api"] });
    const errs = validateMessage({ type: "feat", scope: "ui", title: "a very long title here" }, r);
    expect(errs).toHaveLength(2);
  });
  it("free style allows no type", () => {
    expect(validateMessage({ title: "Add login" }, rules({ style: "free" }))).toEqual([]);
    expect(formatMessage({ title: "Add login" })).toBe("Add login");
  });
});

describe("buildPrompt", () => {
  it("includes project rules and free-style instruction", () => {
    const { system } = buildPrompt({ ...base, provider: mock([]), rules: rules({ style: "free", text: "### From CLAUDE.md\nNever use emojis in commits" }) });
    expect(system).toContain("Never use emojis in commits");
    expect(system).toContain("does NOT use conventional commits");
  });
});

describe("duplicated prefix in title", () => {
  it("never repeats type(scope) inside the header", () => {
    const m = { type: "feat", scope: "git", title: "feat(git): add lock retry" };
    expect(formatMessage(m)).toBe("feat(git): add lock retry");
  });

  it("strips repeated or mismatched conventional prefixes, keeps the body", () => {
    expect(formatMessage({ type: "fix", scope: "ui", title: "fix(ui): fix(ui): tidy panel", body: "why" })).toBe("fix(ui): tidy panel\n\nwhy");
    expect(formatMessage({ type: "feat", scope: null, title: "fix: handle empty input" })).toBe("feat: handle empty input");
  });

  it("leaves normal titles and free style alone", () => {
    expect(cleanTitle({ type: "feat", scope: "x", title: "Note: keep this" })).toBe("Note: keep this");
    expect(formatMessage({ type: null, scope: null, title: "feat: whatever the project wants" })).toBe("feat: whatever the project wants");
  });

  it("validates length on the cleaned header", () => {
    const rules = { style: "conventional", maxHeaderLength: 30 } as ProjectRules;
    expect(validateMessage({ type: "feat", scope: "git", title: "feat(git): add retry" }, rules)).toEqual([]);
  });
});
