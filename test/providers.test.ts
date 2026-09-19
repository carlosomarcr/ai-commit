import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OllamaProvider } from "../src/providers/ollama.js";
import { createProvider } from "../src/providers/registry.js";

const base = { configVersion: 1, updateCheck: true, language: "en", push: "ask" as const };

describe("ollama provider", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OLLAMA_API_KEY", "");
    vi.stubEnv("OLLAMA_HOST", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200 });

  it("sends a bearer token to Ollama Cloud", async () => {
    fetchMock.mockResolvedValue(ok({ message: { content: "{}" } }));
    const provider = createProvider({ ...base, provider: "ollama", model: "gpt-oss:120b", baseUrl: "https://ollama.com", apiKey: "k123" });
    await provider.generate({ system: "s", user: "u" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ollama.com/api/chat");
    expect(init.headers.authorization).toBe("Bearer k123");
  });

  it("uses OLLAMA_API_KEY and defaults to the cloud URL when no base URL is set", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "envkey");
    fetchMock.mockResolvedValue(ok({ models: [{ name: "a" }] }));
    const provider = createProvider({ ...base, provider: "ollama", model: "m" });
    expect(await provider.listModels()).toEqual(["a"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ollama.com/api/tags");
    expect(init.headers.authorization).toBe("Bearer envkey");
  });

  it("stays on localhost without a key and sends no auth header", async () => {
    fetchMock.mockResolvedValue(ok({ models: [] }));
    await createProvider({ ...base, provider: "ollama", model: "m" }).listModels();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:11434/api/tags");
    expect(init.headers.authorization).toBeUndefined();
  });

  it("an explicit local base URL wins over the environment key", async () => {
    vi.stubEnv("OLLAMA_API_KEY", "envkey");
    fetchMock.mockResolvedValue(ok({ models: [] }));
    await createProvider({ ...base, provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }).listModels();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://localhost:11434/api/tags");
  });

  it("reports an invalid key clearly", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(new OllamaProvider("m", "https://ollama.com", "bad").listModels()).rejects.toThrow(/invalid API key/);
  });
});
