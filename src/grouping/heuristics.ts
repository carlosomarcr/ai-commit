import type { CommitMessage } from "../commit/generate.js";
import type { FileKind, FileSummary } from "./types.js";

const LOCK_TO_MANIFEST: Record<string, string> = {
  "package-lock.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "bun.lock": "package.json",
  "bun.lockb": "package.json",
  "cargo.lock": "cargo.toml",
  "go.sum": "go.mod",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "pipfile.lock": "pipfile",
  "composer.lock": "composer.json",
  "gemfile.lock": "gemfile",
};
const MANIFESTS = new Set([
  "package.json", "cargo.toml", "go.mod", "pyproject.toml", "pipfile", "composer.json", "gemfile", "requirements.txt",
]);

const GENERATED_RE = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt)\/|\.min\.(js|css)$|\.map$/i;
const ASSET_RE = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|otf|eot|mp[34]|mov|wav)$/i;
const TEST_RE = /(^|\/)(__tests__|tests?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
const CI_RE = /^\.github\/|^\.gitlab-ci|(^|\/)\.circleci\/|(^|\/)jenkinsfile$|^\.buildkite\//i;
const DOCS_RE = /\.(md|mdx|rst|txt)$|^docs?\//i;
const CONFIG_RE =
  /(^|\/)(\.[\w.-]*rc(\.\w+)?|[\w.-]*\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json|\.gitignore|\.gitattributes|\.editorconfig|\.env\.example|dockerfile|docker-compose[\w.-]*\.ya?ml)$/i;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function classify(path: string): FileKind {
  const b = base(path);
  if (LOCK_TO_MANIFEST[b]) return "lock";
  if (GENERATED_RE.test(path)) return "generated";
  if (MANIFESTS.has(b)) return "deps";
  if (TEST_RE.test(path)) return "test";
  if (CI_RE.test(path)) return "ci";
  if (ASSET_RE.test(path)) return "asset";
  if (DOCS_RE.test(path)) return "docs";
  if (CONFIG_RE.test(path)) return "config";
  return "source";
}

/** Package (monorepo) or first folders; used to keep related source files together. */
export function unitOf(path: string): string {
  const mono = /^(packages|apps|libs|services|modules|crates)\/([^/]+)\//.exec(path);
  if (mono) return `${mono[1]}/${mono[2]}`;
  const parts = path.split("/");
  if (parts.length === 1) return "root";
  return parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

/** "auth.test.ts" / "auth_test.go" / "test_auth.py" -> "auth" */
function stem(path: string): string {
  return base(path)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(test|spec)$/, "")
    .replace(/_test$/, "")
    .replace(/^test_/, "");
}

function keyOf(f: { path: string }, all: { path: string }[]): string {
  const kind = classify(f.path);
  switch (kind) {
    case "lock":
    case "deps":
      return `deps:${dir(f.path)}`;
    case "test": {
      const s = stem(f.path);
      const counterpart = all.find((o) => o.path !== f.path && classify(o.path) === "source" && stem(o.path) === s);
      return counterpart ? keyOf(counterpart, all) : "tests";
    }
    case "docs": return "docs";
    case "ci": return "ci";
    case "config": return "config";
    case "asset": return "assets";
    case "generated": return "generated";
    default: return `src:${unitOf(f.path)}`;
  }
}

/**
 * Deterministic clusters: lockfile with manifest, test with its source, docs/CI/config apart,
 * source by package or folder. Used as hints for the model and as the fallback when it fails.
 */
export function heuristicClusters(files: { path: string }[]): string[][] {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const k = keyOf(f, files);
    (map.get(k) ?? map.set(k, []).get(k)!).push(f.path);
  }
  return [...map.values()];
}

const KIND_TYPE: Partial<Record<FileKind, string>> = {
  docs: "docs", test: "test", ci: "ci", deps: "build", lock: "build", config: "chore", generated: "chore", asset: "chore",
};

/** Placeholder message for groups we build without the model (leftovers, splits) until it's regenerated. */
export function placeholderMessage(paths: string[], summaries: FileSummary[]): CommitMessage {
  const kinds = new Set(paths.map((p) => summaries.find((s) => s.path === p)?.kind ?? classify(p)));
  const only = kinds.size === 1 ? [...kinds][0]! : "source";
  return { type: KIND_TYPE[only] ?? "chore", title: `update ${paths.length} file${paths.length === 1 ? "" : "s"}` };
}
