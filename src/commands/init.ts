import * as git from "../git/git.js";
import { CONFIG_VERSION, configPath, loadConfig, saveConfig, type Config } from "../config/store.js";
import { getSecret } from "../config/secrets.js";
import { detectOllama, OLLAMA_CLOUD_URL, OLLAMA_URL } from "../providers/ollama.js";
import { findPreset, PRESETS, type ProviderPreset } from "../providers/registry.js";
import { isAuthError, verifyConnection } from "../providers/verify.js";
import { banner, p, pc, unwrap } from "../ui/theme.js";
import { chooseModel } from "./recover.js";

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
];

/**
 * Asks for an API key, reusing one from the environment or the keyring when present.
 * Returns undefined when the key should come from the environment (nothing to store).
 */
export async function promptApiKey(preset: ProviderPreset, opts: { optional?: boolean } = {}): Promise<string | undefined> {
  if (preset.envKey && process.env[preset.envKey]) {
    p.log.info(`Using ${pc.cyan(preset.envKey)} from your environment.`);
    return undefined;
  }
  const saved = await getSecret(preset.id);
  if (saved) {
    const reuse = unwrap(await p.confirm({ message: `Use the ${preset.label} key saved in your keyring?`, initialValue: true }));
    if (reuse) return saved;
  }
  const key = unwrap(
    await p.password({
      message: opts.optional ? `${preset.label} API key (leave empty if none)` : `${preset.label} API key`,
      validate: opts.optional ? undefined : (v) => (v?.trim() ? undefined : "Required"),
    }),
  );
  return key.trim() || undefined;
}

export async function runInit(): Promise<Config> {
  p.intro(pc.bgMagenta(pc.black(" setup ")));
  const existing = await loadConfig();
  const ollamaModels = await detectOllama();

  // 1. Provider ---------------------------------------------------------------
  p.log.step(pc.bold("1/4  Provider"));
  const provider = unwrap(
    await p.select({
      message: "Which AI provider do you want to use?",
      options: PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint:
          preset.id === "ollama" && ollamaModels
            ? `detected locally, ${ollamaModels.length} model(s)`
            : preset.envKey && process.env[preset.envKey]
              ? `${preset.envKey} found`
              : preset.id === existing?.provider
                ? "current"
                : undefined,
      })),
      initialValue: existing?.provider ?? (ollamaModels ? "ollama" : "deepseek"),
    }),
  );
  const preset = findPreset(provider)!;
  const config: Config = {
    configVersion: CONFIG_VERSION,
    provider,
    language: existing?.language ?? "en",
    push: existing?.push ?? "ask",
    updateCheck: existing?.updateCheck ?? true,
  };

  // 2. Connection -------------------------------------------------------------
  p.log.step(pc.bold("2/4  Connection"));
  let localOllama = false;
  if (provider === "ollama") {
    const mode = unwrap(
      await p.select({
        message: "Where does Ollama run?",
        options: [
          { value: "local", label: "Local server", hint: ollamaModels ? "localhost:11434, detected" : "localhost:11434" },
          { value: "cloud", label: "Ollama Cloud", hint: "ollama.com, needs an API key" },
          { value: "remote", label: "Remote server", hint: "your own host, optional API key" },
        ],
        initialValue: ollamaModels ? "local" : "cloud",
      }),
    );
    if (mode === "local") {
      localOllama = true;
      config.baseUrl = OLLAMA_URL;
    } else {
      config.baseUrl =
        mode === "cloud"
          ? OLLAMA_CLOUD_URL
          : unwrap(
              await p.text({
                message: "Ollama server URL",
                placeholder: "https://ollama.example.com",
                validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http(s)://"),
              }),
            );
      config.apiKey = await promptApiKey(preset, { optional: mode === "remote" });
    }
  } else {
    if (provider === "custom") {
      config.baseUrl = unwrap(
        await p.text({
          message: "Base URL (OpenAI-compatible)",
          placeholder: "http://localhost:1234/v1",
          validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http(s)://"),
        }),
      );
    }
    config.apiKey = await promptApiKey(preset, { optional: !preset.needsKey });
  }

  // Verify the connection; a rejected key gets up to two more tries.
  let models: string[] = localOllama ? (ollamaModels ?? []) : [];
  if (!localOllama) {
    for (let attempt = 0; ; attempt++) {
      const spin = p.spinner();
      spin.start("Testing the connection");
      const v = await verifyConnection(config);
      if (v.ok) {
        spin.stop(pc.green(`Connected in ${v.ms} ms, ${v.models.length} model(s) available`));
        models = v.models;
        break;
      }
      spin.stop(pc.yellow("Couldn't connect"));
      p.log.warn(v.error ?? "unknown error");
      if (isAuthError(v) && attempt < 2 && preset.needsKey) {
        config.apiKey = unwrap(
          await p.password({ message: "That key was rejected. Enter it again", validate: (x) => (x?.trim() ? undefined : "Required") }),
        ).trim();
        continue;
      }
      p.log.info("Saving anyway; run `gitowl doctor` later to diagnose.");
      break;
    }
  } else if (!ollamaModels) {
    p.log.warn("Ollama isn't running on localhost:11434. Start it and pull a model (e.g. `ollama pull qwen2.5-coder`).");
  } else if (ollamaModels.length === 0) {
    p.log.warn("Ollama is running but has no models. Pull one first, e.g. `ollama pull qwen2.5-coder`.");
  }

  // 3. Model ------------------------------------------------------------------
  p.log.step(pc.bold("3/4  Model"));
  config.model = await chooseModel(models, existing?.provider === provider ? existing.model : undefined, preset.defaultModel);

  // 4. Preferences ------------------------------------------------------------
  p.log.step(pc.bold("4/4  Preferences"));
  config.language = unwrap(
    await p.select({ message: "Language for commit messages", options: LANGUAGES, initialValue: config.language }),
  );
  config.push = unwrap(
    await p.select({
      message: "After committing, push to the remote?",
      options: [
        { value: "ask", label: "Ask me each time", hint: "recommended" },
        { value: "always", label: "Always push" },
        { value: "never", label: "Never push" },
      ],
      initialValue: config.push,
    }),
  ) as Config["push"];

  await saveConfig(config);
  p.log.success(`Saved to ${pc.dim(configPath())}${config.apiKey ? pc.dim("  (API key kept in your system keyring)") : ""}`);

  await offerGitAlias();

  p.note(
    [
      `${pc.dim("provider")}  ${preset.label}`,
      `${pc.dim("model")}     ${config.model}`,
      `${pc.dim("language")}  ${config.language}`,
      `${pc.dim("push")}      ${config.push}`,
    ].join("\n"),
    "You're all set",
  );
  p.outro(`Run ${pc.cyan("gitowl")} in any git repo. Use ${pc.cyan("gitowl doctor")} if anything looks off.`);
  return config;
}

/** Offers `git owl` as a shortcut for gitowl. Never overwrites an alias that does something else. */
async function offerGitAlias(): Promise<void> {
  const current = await git.getGlobalAlias("owl");
  if (current === "!gitowl") return;
  if (current) {
    p.log.info(`Your git alias "owl" already exists (${current}), leaving it alone.`);
    return;
  }
  const add = unwrap(await p.confirm({ message: `Add a ${pc.cyan("git owl")} shortcut? (sets a global git alias)`, initialValue: true }));
  if (add) {
    await git.setGlobalAlias("owl", "!gitowl");
    p.log.success(`Added. Now ${pc.cyan("git owl")} works in any repo.`);
  }
}

export async function runInitCommand(): Promise<void> {
  banner();
  await runInit();
}
