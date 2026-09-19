import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateConfig, ConfigSchema } from "../src/config/store.js";
import { fetchLatest } from "../src/update/check.js";
import { detectInstall, updateCommand } from "../src/update/install.js";
import { isNewer, readPackageInfo } from "../src/update/version.js";

describe("isNewer", () => {
  it("compares numerically, not lexically", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });
  it("handles prereleases", () => {
    expect(isNewer("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewer("v1.2.0", "1.1.0")).toBe(true);
  });
});

describe("detectInstall", () => {
  it("recognises package managers and source checkouts", () => {
    expect(detectInstall("C:\\Users\\c\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\aicommit-cli@1\\node_modules\\aicommit-cli\\dist\\cli.js")).toBe("pnpm");
    expect(detectInstall("C:\\Users\\c\\AppData\\Roaming\\npm\\node_modules\\aicommit-cli\\dist\\cli.js")).toBe("npm");
    expect(detectInstall("/home/c/.npm/_npx/abc/node_modules/aicommit-cli/dist/cli.js")).toBe("npx");
    expect(detectInstall("C:\\Users\\c\\Desktop\\Projects\\AICommit\\dist\\cli.js")).toBe("dev");
  });
  it("only offers an update command for real installs", () => {
    expect(updateCommand("pnpm", "x")).toEqual(["pnpm", ["add", "-g", "x@latest"]]);
    expect(updateCommand("dev", "x")).toBeNull();
    expect(updateCommand("npx", "x")).toBeNull();
  });
});

describe("fetchLatest", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns the version, or null on 404 / network errors", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    f.mockResolvedValueOnce(new Response(JSON.stringify({ version: "2.0.0" })));
    expect(await fetchLatest("pkg")).toBe("2.0.0");
    f.mockResolvedValueOnce(new Response("nf", { status: 404 }));
    expect(await fetchLatest("pkg")).toBeNull();
    f.mockRejectedValueOnce(new Error("offline"));
    expect(await fetchLatest("pkg")).toBeNull();
  });
  it("encodes scoped names", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", f);
    await fetchLatest("@me/pkg");
    expect(f.mock.calls[0]![0]).toBe("https://registry.npmjs.org/@me%2Fpkg/latest");
  });
});

describe("migrateConfig", () => {
  it("runs each step in order and stamps the version", () => {
    const m = {
      1: (r: Record<string, unknown>) => ({ ...r, a: 1 }),
      2: (r: Record<string, unknown>) => ({ ...r, b: 2 }),
    };
    const { raw, changed } = migrateConfig({ provider: "x" }, m, 3);
    expect(raw).toMatchObject({ provider: "x", a: 1, b: 2, configVersion: 3 });
    expect(changed).toBe(true);
  });
  it("leaves current and newer configs alone", () => {
    expect(migrateConfig({ configVersion: 1 }).changed).toBe(false);
    expect(migrateConfig({ configVersion: 99 }).changed).toBe(false);
  });
  it("keeps unknown keys from newer versions", () => {
    expect(ConfigSchema.parse({ provider: "x", future: true })).toMatchObject({ future: true });
  });
});

describe("readPackageInfo", () => {
  it("finds this package", () => {
    expect(readPackageInfo().name).toBe("aicommit-cli");
  });
});
