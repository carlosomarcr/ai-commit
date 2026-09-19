import { realpathSync } from "node:fs";
import { basename } from "node:path";

export type InstallMethod = "pnpm" | "npm" | "yarn" | "bun" | "npx" | "binary" | "dev";

/**
 * Figures out how this copy was installed from where the script lives.
 * `pnpm link --global` resolves to the source checkout, so it's reported as "dev".
 */
export function detectInstall(scriptPath: string): InstallMethod {
  const p = scriptPath.replace(/\\/g, "/").toLowerCase();
  if (!p.includes("/node_modules/")) return "dev";
  if (p.includes("/_npx/")) return "npx";
  if (p.includes("/.bun/")) return "bun";
  if (p.includes("/pnpm/") || p.includes("/.pnpm/")) return "pnpm";
  if (p.includes("/yarn/")) return "yarn";
  return "npm";
}

export function currentInstall(): InstallMethod {
  // A standalone binary is its own executable; only real Node runs load a script.
  if (!/^node(\.exe)?$/i.test(basename(process.execPath))) return "binary";
  try {
    return detectInstall(realpathSync(process.argv[1] ?? ""));
  } catch {
    return "dev";
  }
}

/**
 * `version` should be the exact version just read from the registry: package managers resolve
 * `@latest` from cached metadata, so right after a publish they can reinstall the old version.
 */
export function updateCommand(method: InstallMethod, pkg: string, version = "latest"): [string, string[]] | null {
  const spec = `${pkg}@${version}`;
  switch (method) {
    case "pnpm": return ["pnpm", ["add", "-g", spec]];
    case "npm": return ["npm", ["install", "-g", spec]];
    case "yarn": return ["yarn", ["global", "add", spec]];
    case "bun": return ["bun", ["add", "-g", spec]];
    default: return null;
  }
}
