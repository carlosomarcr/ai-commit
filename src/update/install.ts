import { realpathSync } from "node:fs";

export type InstallMethod = "pnpm" | "npm" | "yarn" | "bun" | "npx" | "dev";

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
  try {
    return detectInstall(realpathSync(process.argv[1] ?? ""));
  } catch {
    return "dev";
  }
}

export function updateCommand(method: InstallMethod, pkg: string): [string, string[]] | null {
  switch (method) {
    case "pnpm": return ["pnpm", ["add", "-g", `${pkg}@latest`]];
    case "npm": return ["npm", ["install", "-g", `${pkg}@latest`]];
    case "yarn": return ["yarn", ["global", "add", `${pkg}@latest`]];
    case "bun": return ["bun", ["add", "-g", `${pkg}@latest`]];
    default: return null;
  }
}
