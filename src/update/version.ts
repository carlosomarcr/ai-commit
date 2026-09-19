import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageInfo {
  name: string;
  version: string;
}

/** Injected by the bundler so a standalone binary (no package.json next to it) still knows its version. */
declare const __AICOMMIT_PKG__: PackageInfo | undefined;

/** Walks up from this file (src/ or dist/) to the package.json, so it works both in dev and built. */
export function readPackageInfo(): PackageInfo {
  if (typeof __AICOMMIT_PKG__ !== "undefined") return __AICOMMIT_PKG__;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Partial<PackageInfo>;
      if (pkg.name && pkg.version) return { name: pkg.name, version: pkg.version };
    } catch {
      // keep walking
    }
    dir = dirname(dir);
  }
  return { name: "aicommit-cli", version: "0.0.0" };
}

function parse(v: string): { nums: number[]; pre: string | null } {
  const [core = "", pre] = v.replace(/^v/, "").split(/-(.+)/);
  return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
}

/** True when `latest` is a strictly newer version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (a.pre === b.pre) return false;
  if (b.pre && !a.pre) return true; // 1.0.0 is newer than 1.0.0-beta
  if (a.pre && !b.pre) return false;
  return (a.pre ?? "") > (b.pre ?? "");
}
