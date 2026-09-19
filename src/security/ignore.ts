import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Translates one gitignore-style glob into a RegExp over forward-slash paths. */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  const dirOnly = p.endsWith("/");
  p = p.replace(/^\//, "").replace(/\/$/, "");

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        // "**/" = any folders (including none); trailing "**" = everything below
        if (p[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // Unanchored patterns match at any depth; a match on a folder covers everything inside it.
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${re}${suffix}`);
}

export type IgnoreMatcher = (path: string) => boolean;

/** Compiles the lines of an ignore file. Supports comments, blank lines, `!` negation and `**`. */
export function compileIgnore(content: string): IgnoreMatcher {
  const rules = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => ({ negate: l.startsWith("!"), re: globToRegExp(l.replace(/^!/, "")) }));
  return (path) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path.replace(/\\/g, "/"))) ignored = !r.negate;
    return ignored;
  };
}

/** Loads `.gitowlignore` from the repo root (files listed there are committed but never shown to the AI). */
export async function loadIgnore(root: string): Promise<IgnoreMatcher> {
  try {
    return compileIgnore(await readFile(join(root, ".gitowlignore"), "utf8"));
  } catch {
    return () => false;
  }
}
