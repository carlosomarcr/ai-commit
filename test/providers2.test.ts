import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProvider } from "../src/providers/registry.js";
import { ProviderError } from "../src/providers/types.js";
import { verifyConnection } from "../src/providers/verify.js";

const base = { configVersion: 1, updateCheck: true, language: "en", push: "ask" as const };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("anthropic + gemini providers", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("anthropic: sends x-api-key, system prompt and reads text blocks", async () => {
    fetchMock.mockResolvedValue(json({ content: [{ type: "text", text: '{"a":' }, { type: "text", text: "1}" }] }));
    const p = createProvider({ ...base, provider: "anthropic", apiKey: "sk-ant" });
    expect(await p.generate({ system: "SYS", user: "USR" })).toBe('{"a":1}');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-ant");
    expect(init.headers["anthropic-version"]).toBeDefined();
    const body = JSON.parse(init.body);
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual([{ role: "user", content: "USR" }]);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  it("anthropic: lists models", async () => {
    fetchMock.mockResolvedValue(json({ data: [{ id: "a" }, { id: "b" }] }));
    expect(await createProvider({ ...base, provider: "anthropic", apiKey: "k" }).listModels()).toEqual(["a", "b"]);
  });

  it("gemini: uses header auth, JSON mime type and strips the models/ prefix when listing", async () => {
    fetchMock.mockResolvedValueOnce(json({ candidates: [{ content: { parts: [{ text: "{}" }] } }] }));
    const p = createProvider({ ...base, provider: "gemini", apiKey: "g-key", model: "gemini-2.5-flash" });
    expect(await p.generate({ system: "S", user: "U" })).toBe("{}");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("g-key");
    expect(url).not.toContain("g-key"); // key never in the URL
    expect(JSON.parse(init.body).generationConfig.responseMimeType).toBe("application/json");

    fetchMock.mockResolvedValueOnce(
      json({ models: [{ name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }),
    );
    expect(await p.listModels()).toEqual(["gemini-a"]);
  });

  it("gemini: an empty (blocked) reply is a clear error", async () => {
    fetchMock.mockResolvedValue(json({ candidates: [] }));
    await expect(createProvider({ ...base, provider: "gemini", apiKey: "k" }).generate({ system: "s", user: "u" })).rejects.toThrow(/empty response/);
  });

  it("requires a key for hosted providers, with a helpful message", () => {
    expect(() => createProvider({ ...base, provider: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    vi.stubEnv("GEMINI_API_KEY", "from-env");
    expect(() => createProvider({ ...base, provider: "gemini" })).not.toThrow();
  });
});

describe("verifyConnection", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reports success with model count and failure with status", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    f.mockResolvedValueOnce(json({ data: [{ id: "m1" }] }));
    const ok = await verifyConnection({ ...base, provider: "openai", apiKey: "k" });
    expect(ok).toMatchObject({ ok: true, models: ["m1"] });

    f.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const bad = await verifyConnection({ ...base, provider: "openai", apiKey: "bad" });
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(401);
    expect(new ProviderError("x", 401).status).toBe(401);
  });
  it("turns a missing key into a failed verification instead of throwing", async () => {
    const v = await verifyConnection({ ...base, provider: "openai" });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Missing API key/);
  });
});
