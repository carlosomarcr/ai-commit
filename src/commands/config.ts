import { configPath, loadConfig, resetConfig, saveConfig, type Config } from "../config/store.js";
import { findPreset } from "../providers/registry.js";
import { isAuthError, verifyConnection } from "../providers/verify.js";
import { banner, p, pc, unwrap } from "../ui/theme.js";
import { LANGUAGES, promptApiKey, runInit } from "./init.js";
import { pickModelFor } from "./recover.js";

/** Keys that `config set` accepts. The API key is deliberately absent: it must not land in shell history. */
export const SETTABLE = ["model", "language", "push", "updateCheck", "baseUrl"] as const;
export type SettableKey = (typeof SETTABLE)[number];

const TRUE = new Set(["true", "on", "yes", "1"]);
const FALSE = new Set(["false", "off", "no", "0"]);

/** Validates and applies one setting; throws a user-readable error when the value is invalid. */
export function applySetting(config: Config, key: string, value: string | undefined): Config {
  if (key === "apiKey") throw new Error("Set the API key with `aicommit config` (interactive), so it never lands in your shell history.");
  if (!(SETTABLE as readonly string[]).includes(key)) {
    throw new Error(`Unknown setting "${key}". You can set: ${SETTABLE.join(", ")}.`);
  }
  const v = (value ?? "").trim();
  switch (key as SettableKey) {
    case "model":
      if (!v) throw new Error("model can't be empty.");
      return { ...config, model: v };
    case "language":
      if (!v || v.length > 30) throw new Error("language must be a short name or code, e.g. en, es, Portuguese.");
      return { ...config, language: v };
    case "push":
      if (v !== "ask" && v !== "always" && v !== "never") throw new Error("push must be ask, always or never.");
      return { ...config, push: v };
    case "updateCheck":
      if (TRUE.has(v.toLowerCase())) return { ...config, updateCheck: true };
      if (FALSE.has(v.toLowerCase())) return { ...config, updateCheck: false };
      throw new Error("updateCheck must be true or false.");
    case "baseUrl": {
      const { baseUrl: _drop, ...rest } = config;
      if (!v || v === "none") return rest as Config;
      if (!/^https?:\/\//.test(v)) throw new Error("baseUrl must start with http:// or https:// (or use \"none\" to clear it).");
      return { ...config, baseUrl: v };
    }
  }
}

/** Human/script friendly view of the config; the key itself is never printed. */
export function displayConfig(config: Config): Record<string, string> {
  const out: Record<string, string> = {
    provider: config.provider,
    model: config.model ?? "(provider default)",
    baseUrl: config.baseUrl ?? "(default)",
    language: config.language,
    push: config.push,
    updateCheck: String(config.updateCheck),
    apiKey: config.apiKey ? "(stored)" : "(none)",
  };
  return out;
}

export async function runConfig(action?: string, key?: string, value?: string): Promise<void> {
  // Scriptable subcommands: plain output, no decoration.
  if (action === "path") {
    console.log(configPath());
    return;
  }
  if (action === "get" || action === "set") {
    const config = await loadConfig();
    if (!config) throw new Error("Not configured yet. Run `aicommit init`.");
    if (action === "get") {
      const view = displayConfig(config);
      if (key) {
        if (!(key in view)) throw new Error(`Unknown setting "${key}".`);
        console.log(view[key]);
      } else for (const [k, v] of Object.entries(view)) console.log(`${k} = ${v}`);
      return;
    }
    if (!key) throw new Error("Usage: aicommit config set <key> <value>");
    await saveConfig(applySetting(config, key, value));
    console.log(`${key} updated`);
    return;
  }
  if (action === "reset") {
    banner();
    const ok = unwrap(await p.confirm({ message: "Delete your aicommit settings and stored API key?", initialValue: false }));
    if (ok) {
      await resetConfig();
      p.outro("Settings removed. Run `aicommit init` to set up again.");
    } else p.cancel("Nothing changed.");
    return;
  }
  if (action) throw new Error(`Unknown config action "${action}". Try: path, get, set, reset, or no action for the menu.`);

  await configMenu();
}

async function configMenu(): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" config ")));
  let config = await loadConfig();
  if (!config) {
    p.log.info("Nothing configured yet, starting setup.");
    await runInit();
    return;
  }

  for (;;) {
    const preset = findPreset(config.provider);
    const view = displayConfig(config);
    const choice = unwrap(
      await p.select({
        message: "What do you want to change?",
        options: [
          { value: "provider", label: "Provider & connection", hint: `${preset?.label ?? config.provider}` },
          { value: "model", label: "Model", hint: view.model },
          { value: "key", label: "API key", hint: view.apiKey },
          { value: "language", label: "Commit language", hint: config.language },
          { value: "push", label: "Push behavior", hint: config.push },
          { value: "updates", label: "Update notifications", hint: config.updateCheck ? "on" : "off" },
          { value: "show", label: "Show current settings" },
          { value: "reset", label: "Reset everything" },
          { value: "done", label: "Done" },
        ],
      }),
    );

    if (choice === "done") break;
    if (choice === "provider") {
      config = await runInit();
      return;
    }
    if (choice === "show") {
      p.note(Object.entries(displayConfig(config)).map(([k, v]) => `${pc.dim(k.padEnd(12))}${v}`).join("\n"), configPath());
    } else if (choice === "model") {
      const model = await pickModelFor(config, config.model, preset?.defaultModel);
      if (model) config = await persist({ ...config, model });
    } else if (choice === "key") {
      if (!preset) continue;
      const key = await promptApiKey(preset, { optional: !preset.needsKey });
      if (key) {
        const next = { ...config, apiKey: key };
        const spin = p.spinner();
        spin.start("Testing the new key");
        const v = await verifyConnection(next);
        if (v.ok) spin.stop(pc.green("Key works"));
        else {
          spin.stop(pc.yellow(isAuthError(v) ? "The provider rejected this key" : "Couldn't verify the key"));
          p.log.warn(v.error ?? "unknown error");
        }
        const keep = v.ok || unwrap(await p.confirm({ message: "Save it anyway?", initialValue: false }));
        if (keep) config = await persist(next);
      }
    } else if (choice === "language") {
      const language = unwrap(await p.select({ message: "Language for commit messages", options: LANGUAGES, initialValue: config.language }));
      config = await persist({ ...config, language });
    } else if (choice === "push") {
      const push = unwrap(
        await p.select({
          message: "After committing, push to the remote?",
          options: [
            { value: "ask", label: "Ask me each time" },
            { value: "always", label: "Always push" },
            { value: "never", label: "Never push" },
          ],
          initialValue: config.push,
        }),
      ) as Config["push"];
      config = await persist({ ...config, push });
    } else if (choice === "updates") {
      const on = unwrap(await p.confirm({ message: "Check for new versions once a day?", initialValue: config.updateCheck }));
      config = await persist({ ...config, updateCheck: on });
    } else if (choice === "reset") {
      const ok = unwrap(await p.confirm({ message: "Delete your settings and stored API key?", initialValue: false }));
      if (ok) {
        await resetConfig();
        p.outro("Settings removed. Run `aicommit init` to set up again.");
        return;
      }
    }
  }
  p.outro("Done.");
}

async function persist(config: Config): Promise<Config> {
  await saveConfig(config);
  p.log.success("Saved.");
  return config;
}
