import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { name: string; version: string };
const define = { __GITOWL_PKG__: JSON.stringify({ name: pkg.name, version: pkg.version }) };

// The npm package: ESM, dependencies stay external (installed alongside it).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  define,
  banner: { js: "#!/usr/bin/env node" },
});
