import { generateMessage, formatMessage } from "../commit/generate.js";
import { getSecret, secretBackend } from "../config/secrets.js";
import { configPath, loadConfig, readRawConfig, type Config } from "../config/store.js";
import * as git from "../git/git.js";
import { createProvider, findPreset, keyFromEnv } from "../providers/registry.js";
import { verifyConnection, type Verification } from "../providers/verify.js";
import { loadRules } from "../rules/index.js";
import { checkNow } from "../update/check.js";
import { currentInstall } from "../update/install.js";
import { banner, p, pc } from "../ui/theme.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface Check {
  status: CheckStatus;
  label: string;
  detail?: string;
  /** What to do about it; shown under warnings and failures. */
  fix?: string;
}

/** Suggests the next step for a failed connection, based on what the provider answered. */
export function connectionFix(v: Verification, config: Config): string {
  if (v.status === 401) return "The key was rejected. Update it with `aicommit config` → API key.";
  if (v.status === 402 || v.status === 403) return "Your plan may not include this. Pick another model with `aicommit config` → Model.";
  if (v.status === 404) return "The URL or model wasn't found. Check the base URL in `aicommit config`.";
  if (v.status === 429) return "Rate limited. Wait a moment and try again.";
  if (config.provider === "ollama" && (config.baseUrl ?? "").includes("localhost")) {
    return "Is Ollama running? Start it with `ollama serve`, then retry.";
  }
  return "Check your internet connection and the provider URL in `aicommit config`.";
}

/** Minimum supported Node is 20.19 (what our dependencies require). */
export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 20 || (major === 20 && minor >= 19);
}

export type KeySource = "env" | "keyring" | "file" | "none";

/** Where the API key comes from, in the same order the app resolves it. */
export async function detectKeySource(config: Config, fileHasKey: boolean): Promise<{ source: KeySource; envName?: string }> {
  const preset = findPreset(config.provider);
  if (keyFromEnv(config)) return { source: "env", envName: preset?.envKey };
  if (fileHasKey) return { source: "file" };
  if (await getSecret(config.provider)) return { source: "keyring" };
  return { source: "none" };
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function environmentChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(
    nodeSupported(process.versions.node)
      ? { status: "ok", label: "Node.js", detail: process.versions.node }
      : { status: "fail", label: "Node.js", detail: process.versions.node, fix: "aicommit needs Node 20.19 or newer." },
  );

  const version = await git.gitVersion();
  if (!version) {
    checks.push({ status: "fail", label: "git", detail: "not found", fix: "Install git and make sure it is on your PATH." });
    return checks;
  }
  checks.push({ status: "ok", label: "git", detail: version });

  const id = await git.globalIdentity();
  if (id.name && id.email) checks.push({ status: "ok", label: "git identity", detail: `${id.name} <${id.email}>` });
  else {
    checks.push({
      status: "fail",
      label: "git identity",
      detail: "user.name / user.email not set",
      fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com',
    });
  }

  const alias = await git.getGlobalAlias("ai");
  checks.push(
    alias === "!aicommit"
      ? { status: "ok", label: "git ai shortcut", detail: "installed" }
      : { status: "info", label: "git ai shortcut", detail: "not set", fix: "Optional: run `aicommit init` to add it." },
  );
  return checks;
}

async function providerChecks(config: Config, deep: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  const preset = findPreset(config.provider);
  const raw = await readRawConfig();
  checks.push({ status: "ok", label: "Configuration", detail: configPath() });
  checks.push({ status: "ok", label: "Provider", detail: `${preset?.label ?? config.provider}, model ${config.model ?? preset?.defaultModel ?? "(none)"}` });

  const backend = await secretBackend();
  const key = await detectKeySource(config, Boolean(raw?.apiKey));
  if (key.source === "env") checks.push({ status: "ok", label: "API key", detail: `from ${key.envName}` });
  else if (key.source === "keyring") checks.push({ status: "ok", label: "API key", detail: "stored in your system keyring" });
  else if (key.source === "file") {
    checks.push({
      status: "warn",
      label: "API key",
      detail: "stored in the config file",
      fix: backend ? "Re-run `aicommit config` → API key to move it into the keyring." : "No system keyring is available here; the file is only readable by you.",
    });
  } else if (preset?.needsKey) {
    checks.push({ status: "fail", label: "API key", detail: "missing", fix: `Run \`aicommit config\` → API key${preset.envKey ? `, or set ${preset.envKey}` : ""}.` });
  } else checks.push({ status: "info", label: "API key", detail: "none (not required)" });
  checks.push({ status: backend ? "ok" : "info", label: "System keyring", detail: backend ? "available" : "not available, using the config file" });

  if (preset?.needsKey && key.source === "none") return checks; // no point testing the connection

  const v = await verifyConnection(config);
  if (!v.ok) {
    checks.push({ status: "fail", label: "Connection", detail: v.error, fix: connectionFix(v, config) });
    return checks;
  }
  checks.push({ status: "ok", label: "Connection", detail: `${v.ms} ms, ${v.models.length} model(s)` });

  const model = config.model ?? preset?.defaultModel;
  if (model && v.models.length > 0 && !v.models.includes(model)) {
    checks.push({ status: "warn", label: "Model", detail: `"${model}" isn't in the provider's list`, fix: "Choose one with `aicommit config` → Model (it may still work if it's an alias)." });
  } else checks.push({ status: "ok", label: "Model", detail: model ?? "default" });

  if (deep) checks.push(await generationCheck(config));
  return checks;
}

/** Sends a tiny canned diff through the real prompt to prove the model can answer in the expected JSON format. */
async function generationCheck(config: Config): Promise<Check> {
  const started = Date.now();
  try {
    const message = await generateMessage({
      provider: createProvider(config),
      stat: "M src/greeting.ts (+2 -1)",
      diff: "diff --git a/src/greeting.ts b/src/greeting.ts\n@@ -1,3 +1,4 @@\n-export const greet = () => 'hi';\n+export const greet = (name: string) => `hi ${name}`;\n+export const bye = () => 'bye';",
      language: config.language,
      rules: { sources: [], text: "", style: "conventional", history: null },
    });
    return { status: "ok", label: "Test generation", detail: `“${formatMessage(message).split("\n")[0]}” in ${((Date.now() - started) / 1000).toFixed(1)} s` };
  } catch (err) {
    return {
      status: "fail",
      label: "Test generation",
      detail: err instanceof Error ? err.message : String(err),
      fix: "The model couldn't produce a valid commit message. Try a larger or instruction-tuned model.",
    };
  }
}

async function repoChecks(): Promise<Check[]> {
  if (!(await git.isRepo())) {
    return [{ status: "info", label: "Repository", detail: "not inside a git repository (skipping repo checks)" }];
  }
  const checks: Check[] = [];
  const branch = await safe(() => git.currentBranch());
  const remote = await safe(() => git.defaultRemote());
  const upstream = await safe(() => git.upstream());
  checks.push({ status: "ok", label: "Repository", detail: `branch ${branch ?? "?"}` });
  checks.push(
    remote
      ? { status: "ok", label: "Push target", detail: upstream ?? `${remote}/${branch} (new upstream on first push)` }
      : { status: "info", label: "Push target", detail: "no remote configured, push will be skipped" },
  );

  try {
    const root = await git.root();
    const rules = await loadRules({ cwd: process.cwd(), root, subjects: await git.recentSubjects() });
    const files = rules.sources.filter((s) => s.kind !== "history");
    checks.push({
      status: "ok",
      label: "Project rules",
      detail: files.length ? `${files.map((s) => s.label).join(", ")} · style ${rules.style}` : `none found · style ${rules.style} (from history)`,
    });
  } catch (err) {
    checks.push({ status: "fail", label: "Project rules", detail: err instanceof Error ? err.message : String(err), fix: "Fix the .aicommit.json in this project." });
  }
  return checks;
}

async function updateCheck(): Promise<Check> {
  const method = currentInstall();
  const { current, latest, newer } = await checkNow(3000);
  if (!latest) return { status: "info", label: "Updates", detail: `v${current} (couldn't reach the registry; offline or not published yet)` };
  if (newer) return { status: "warn", label: "Updates", detail: `v${current} → v${latest} available`, fix: method === "dev" ? "Source checkout: git pull && pnpm install && pnpm build" : "Run `aicommit update`." };
  return { status: "ok", label: "Updates", detail: `v${current} is the latest` };
}

const ICON: Record<CheckStatus, (s: string) => string> = {
  ok: (s) => pc.green(s),
  warn: (s) => pc.yellow(s),
  fail: (s) => pc.red(s),
  info: (s) => pc.blue(s),
};
const SYMBOL: Record<CheckStatus, string> = { ok: "✔", warn: "▲", fail: "✖", info: "●" };

export function renderCheck(c: Check): string {
  const head = `${ICON[c.status](SYMBOL[c.status])} ${pc.bold(c.label)}${c.detail ? pc.dim(`  ${c.detail}`) : ""}`;
  return c.fix && c.status !== "ok" ? `${head}\n  ${pc.dim("↳")} ${c.fix}` : head;
}

export async function runDoctor(opts: { deep?: boolean }): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" doctor ")));
  const all: Check[] = [];
  const show = (title: string, checks: Check[], headerShown = false) => {
    if (!headerShown) p.log.step(pc.bold(title));
    for (const c of checks) p.log.message(renderCheck(c), { symbol: " " });
    all.push(...checks);
  };

  const spin = p.spinner();
  spin.start("Checking your environment");
  const env = await environmentChecks();
  spin.stop(pc.bold("Environment"));
  show("Environment", env, true);

  const config = await loadConfig();
  if (!config) {
    show("Provider", [{ status: "fail", label: "Configuration", detail: "not found or invalid", fix: "Run `aicommit init` to set things up." }]);
  } else {
    spin.start(opts.deep ? "Testing the provider (including a real generation)" : "Testing the provider");
    const checks = await providerChecks(config, Boolean(opts.deep));
    spin.stop(pc.bold("Provider"));
    show("Provider", checks, true);
  }

  show("Project", await repoChecks());

  spin.start("Looking for updates");
  const update = await updateCheck();
  spin.stop(pc.bold("Updates"));
  show("Updates", [update], true);

  const fails = all.filter((c) => c.status === "fail").length;
  const warns = all.filter((c) => c.status === "warn").length;
  if (fails > 0) {
    p.outro(pc.red(`${fails} problem(s) found`) + (warns ? pc.yellow(`, ${warns} warning(s)`) : "") + pc.dim(". Follow the ↳ hints above."));
    process.exit(1);
  }
  p.outro(warns ? pc.yellow(`Working, with ${warns} warning(s).`) : pc.green("Everything looks good ✔") + (opts.deep ? "" : pc.dim("  (add --deep to test a real generation)")));
}
