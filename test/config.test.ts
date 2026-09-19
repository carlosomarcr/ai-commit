import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySetting, displayConfig } from "../src/commands/config.js";
import { connectionFix, detectKeySource } from "../src/commands/doctor.js";
import { setSecretBackend, type SecretBackend } from "../src/config/secrets.js";
import { configPath, loadConfig, resetConfig, saveConfig, type Config } from "../src/config/store.js";

const cfg = (over: Partial<Config> = {}): Config => ({
  configVersion: 1, provider: "deepseek", language: "en", push: "ask", updateCheck: true, ...over,
});

function memoryBackend(): SecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    name: "memory", store,
    get: (a) => store.get(a) ?? null,
    set: (a, v) => void store.set(a, v),
    delete: (a) => void store.delete(a),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aicommit-cfg-"));
  vi.stubEnv("APPDATA", dir);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
});
afterEach(async () => {
  setSecretBackend(undefined);
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("config storage with keyring", () => {
  it("keeps the API key out of the file and restores it on load", async () => {
    const kr = memoryBackend();
    setSecretBackend(kr);
    await saveConfig(cfg({ apiKey: "sk-secret-123", model: "deepseek-chat" }));

    const onDisk = await readFile(configPath(), "utf8");
    expect(onDisk).not.toContain("sk-secret-123");
    expect(kr.store.get("deepseek")).toBe("sk-secret-123");

    const loaded = await loadConfig();
    expect(loaded?.apiKey).toBe("sk-secret-123");
    expect(loaded?.model).toBe("deepseek-chat");
  });

  it("falls back to the file when no keyring is available", async () => {
    setSecretBackend(null);
    await saveConfig(cfg({ apiKey: "sk-file" }));
    expect(await readFile(configPath(), "utf8")).toContain("sk-file");
    expect((await loadConfig())?.apiKey).toBe("sk-file");
  });

  it("migrates a plain-text key from an older config into the keyring", async () => {
    const kr = memoryBackend();
    setSecretBackend(kr);
    await mkdir(join(dir, "aicommit"), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: "deepseek", apiKey: "sk-old", language: "en", push: "ask" }));

    const loaded = await loadConfig();
    expect(loaded?.apiKey).toBe("sk-old");
    expect(kr.store.get("deepseek")).toBe("sk-old");
    expect(await readFile(configPath(), "utf8")).not.toContain("sk-old");
  });

  it("keeps one key per provider so switching back doesn't lose it", async () => {
    const kr = memoryBackend();
    setSecretBackend(kr);
    await saveConfig(cfg({ provider: "deepseek", apiKey: "k1" }));
    await saveConfig(cfg({ provider: "openai", apiKey: "k2" }));
    expect(kr.store.get("deepseek")).toBe("k1");
    expect(kr.store.get("openai")).toBe("k2");
  });

  it("reset removes the file and the stored key", async () => {
    const kr = memoryBackend();
    setSecretBackend(kr);
    await saveConfig(cfg({ apiKey: "k" }));
    await resetConfig();
    expect(kr.store.size).toBe(0);
    expect(await loadConfig()).toBeNull();
  });
});

describe("detectKeySource", () => {
  it("prefers the environment, then the file, then the keyring", async () => {
    const kr = memoryBackend();
    setSecretBackend(kr);
    kr.store.set("deepseek", "x");
    expect((await detectKeySource(cfg(), false)).source).toBe("keyring");
    expect((await detectKeySource(cfg(), true)).source).toBe("file");
    vi.stubEnv("DEEPSEEK_API_KEY", "env");
    expect(await detectKeySource(cfg(), true)).toEqual({ source: "env", envName: "DEEPSEEK_API_KEY" });
    kr.store.clear();
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    expect((await detectKeySource(cfg(), false)).source).toBe("none");
  });
});

describe("connectionFix", () => {
  const v = (status?: number) => ({ ok: false, models: [], ms: 1, status, error: "x" });
  it("gives an actionable hint per failure", () => {
    expect(connectionFix(v(401), cfg())).toMatch(/key was rejected/);
    expect(connectionFix(v(402), cfg())).toMatch(/plan/);
    expect(connectionFix(v(undefined), cfg({ provider: "ollama", baseUrl: "http://localhost:11434" }))).toMatch(/ollama serve/);
    expect(connectionFix(v(undefined), cfg())).toMatch(/internet/);
  });
});

describe("applySetting", () => {
  it("validates each setting", () => {
    expect(applySetting(cfg(), "push", "never").push).toBe("never");
    expect(() => applySetting(cfg(), "push", "sometimes")).toThrow(/ask, always or never/);
    expect(applySetting(cfg(), "updateCheck", "off").updateCheck).toBe(false);
    expect(() => applySetting(cfg(), "updateCheck", "maybe")).toThrow();
    expect(applySetting(cfg(), "model", "  gpt-4o ").model).toBe("gpt-4o");
    expect(() => applySetting(cfg(), "model", " ")).toThrow();
    expect(() => applySetting(cfg(), "baseUrl", "ftp://x")).toThrow(/http/);
    expect(applySetting(cfg({ baseUrl: "http://x" }), "baseUrl", "none").baseUrl).toBeUndefined();
  });
  it("refuses unknown keys and never sets the API key from the command line", () => {
    expect(() => applySetting(cfg(), "colour", "red")).toThrow(/Unknown setting/);
    expect(() => applySetting(cfg(), "apiKey", "sk-x")).toThrow(/shell history/);
  });
  it("never displays the key", () => {
    expect(JSON.stringify(displayConfig(cfg({ apiKey: "sk-secret" })))).not.toContain("sk-secret");
  });
});

describe("nodeSupported", () => {
  it("accepts 20.19+ and anything newer, rejects older 20.x and 18", async () => {
    const { nodeSupported } = await import("../src/commands/doctor.js");
    expect(nodeSupported("20.19.0")).toBe(true);
    expect(nodeSupported("20.20.1")).toBe(true);
    expect(nodeSupported("22.0.0")).toBe(true);
    expect(nodeSupported("24.21.0")).toBe(true);
    expect(nodeSupported("20.18.9")).toBe(false);
    expect(nodeSupported("18.19.0")).toBe(false);
  });
});
