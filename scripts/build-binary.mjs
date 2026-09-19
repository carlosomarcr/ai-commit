// Builds a standalone executable (no Node needed) with Node's Single Executable Applications.
//   pnpm build:binary        -> dist-bin/gitowl[.exe] for the CURRENT platform
// Cross-compiling isn't possible with SEA; the release workflow runs this on each OS.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsup";

const out = "dist-bin";
const exe = join(out, process.platform === "win32" ? "gitowl.exe" : "gitowl");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. One CommonJS file with every dependency inlined. The OS keyring is a native addon that can't
//    be embedded, so it stays external: the app already falls back to the config file without it.
await build({
  entry: { gitowl: "src/cli.ts" },
  outDir: out,
  format: ["cjs"],
  target: "node20",
  platform: "node",
  clean: false,
  splitting: false,
  shims: true,
  noExternal: [/^(?!@napi-rs)/],
  external: ["@napi-rs/keyring"],
  define: { __GITOWL_PKG__: JSON.stringify({ name: pkg.name, version: pkg.version }) },
  silent: true,
});

// 2. SEA blob + a copy of the running node binary with the blob injected.
const config = join(out, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: join(out, "gitowl.cjs"), output: join(out, "sea.blob"), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
copyFileSync(process.execPath, exe);

const args = [exe, "NODE_SEA_BLOB", join(out, "sea.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", "postject", ...args], { stdio: "inherit", shell: process.platform === "win32" });
if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });

console.log(`Built ${exe}`);
