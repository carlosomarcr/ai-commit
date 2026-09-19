export interface CommitlintRules {
  types?: string[];
  scopes?: string[];
  maxHeaderLength?: number;
}

export const CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert",
];

export const COMMITLINT_FILES = [
  "commitlint.config.js", "commitlint.config.cjs", "commitlint.config.mjs", "commitlint.config.ts",
  "commitlint.config.cts", "commitlint.config.mts",
  ".commitlintrc", ".commitlintrc.json", ".commitlintrc.js", ".commitlintrc.cjs",
  ".commitlintrc.mjs", ".commitlintrc.ts", "package.json",
];

const strings = (s: string) => [...s.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);

function fromObject(obj: Record<string, unknown>): CommitlintRules {
  const out: CommitlintRules = {};
  const ext = ([] as unknown[]).concat(obj.extends ?? []);
  if (ext.some((e) => typeof e === "string" && e.includes("conventional"))) {
    out.types = CONVENTIONAL_TYPES;
  }
  const rules = (obj.rules ?? {}) as Record<string, unknown>;
  const enumRule = (key: string): string[] | undefined => {
    const r = rules[key];
    if (!Array.isArray(r) || r[0] === 0 || r[1] !== "always" || !Array.isArray(r[2])) return undefined;
    return r[2].filter((x): x is string => typeof x === "string");
  };
  out.types = enumRule("type-enum") ?? out.types;
  out.scopes = enumRule("scope-enum");
  const max = rules["header-max-length"];
  if (Array.isArray(max) && max[0] !== 0 && typeof max[2] === "number") out.maxHeaderLength = max[2];
  return out;
}

function fromSource(content: string): CommitlintRules {
  const out: CommitlintRules = {};
  if (/config-conventional/.test(content)) out.types = CONVENTIONAL_TYPES;
  const list = (key: string) =>
    new RegExp(`['"]?${key}['"]?\\s*:\\s*\\[\\s*([12])\\s*,\\s*['"]always['"]\\s*,\\s*\\[([^\\]]*)\\]`).exec(content);
  const types = list("type-enum");
  if (types) out.types = strings(types[2]!);
  const scopes = list("scope-enum");
  if (scopes) out.scopes = strings(scopes[2]!);
  const max = /['"]?header-max-length['"]?\s*:\s*\[\s*[12]\s*,\s*['"]always['"]\s*,\s*(\d+)/.exec(content);
  if (max) out.maxHeaderLength = Number(max[1]);
  return out;
}

/** Best-effort static parse; JS/TS configs are never executed. Returns null if the file isn't commitlint config. */
export function parseCommitlintConfig(fileName: string, content: string): CommitlintRules | null {
  const isJson = fileName.endsWith(".json") || fileName === ".commitlintrc";
  if (fileName === "package.json") {
    try {
      const pkg = JSON.parse(content) as { commitlint?: Record<string, unknown> };
      return pkg.commitlint ? fromObject(pkg.commitlint) : null;
    } catch {
      return null;
    }
  }
  if (isJson) {
    try {
      return fromObject(JSON.parse(content) as Record<string, unknown>);
    } catch {
      // .commitlintrc may also be YAML; fall through to the loose text parse.
    }
  }
  return fromSource(content);
}
