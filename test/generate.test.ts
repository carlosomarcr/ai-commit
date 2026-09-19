import { describe, expect, it } from "vitest";
import { extractJson, formatMessage, generateMessage } from "../src/commit/generate.js";
import type { Provider } from "../src/providers/types.js";

const mock = (replies: string[]): Provider => {
  let i = 0;
  return {
    name: "mock",
    listModels: async () => [],
    generate: async () => replies[Math.min(i++, replies.length - 1)]!,
  };
};

const base = { stat: "a.ts | 2 +-", diff: "diff", language: "en", recentSubjects: [] };

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
    const msg = await generateMessage({ ...base, provider });
    expect(formatMessage(msg)).toBe("feat(auth): add login");
  });

  it("retries on invalid output then succeeds", async () => {
    const provider = mock(["garbage", '{"type":"fix","title":"handle null"}']);
    const msg = await generateMessage({ ...base, provider });
    expect(formatMessage(msg)).toBe("fix: handle null");
  });

  it("fails after repeated invalid output", async () => {
    await expect(generateMessage({ ...base, provider: mock(["garbage"]) })).rejects.toThrow(/valid commit message/);
  });
});
