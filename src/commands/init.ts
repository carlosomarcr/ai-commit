import { saveConfig, configPath, type Config } from "../config/store.js";
import { detectOllama } from "../providers/ollama.js";
import { createProvider, PRESETS } from "../providers/registry.js";
import { banner, p, pc, unwrap } from "../ui/theme.js";

export async function runInit(): Promise<Config> {
  p.intro(pc.bgMagenta(pc.black(" setup ")));

  const ollamaModels = await detectOllama();
  const provider = unwrap(
    await p.select({
      message: "Which AI provider do you want to use?",
      options: PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint:
          preset.id === "ollama" && ollamaModels
            ? `detected, ${ollamaModels.length} model(s)`
            : preset.envKey && process.env[preset.envKey]
              ? `${preset.envKey} found`
              : undefined,
      })),
      initialValue: ollamaModels ? "ollama" : "deepseek",
    }),
  );
  const preset = PRESETS.find((x) => x.id === provider)!;

  const config: Config = { provider, language: "en", push: "ask" };

  if (provider === "custom") {
    config.baseUrl = unwrap(
      await p.text({ message: "Base URL (OpenAI-compatible)", placeholder: "http://localhost:1234/v1", validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http(s)://") }),
    );
  }

  const envKey = preset.envKey ? process.env[preset.envKey] : undefined;
  if (preset.needsKey && !envKey) {
    config.apiKey = unwrap(
      await p.password({ message: `${preset.label} API key`, validate: (v) => (v?.trim() ? undefined : "Required") }),
    );
  } else if (provider === "custom") {
    const key = unwrap(await p.password({ message: "API key (leave empty if none)" }));
    if (key) config.apiKey = key;
  }

  // Model selection from the provider's real list, with a manual fallback.
  let models: string[] = provider === "ollama" ? (ollamaModels ?? []) : [];
  if (provider !== "ollama") {
    const spin = p.spinner();
    spin.start("Checking connection");
    try {
      models = await createProvider({ ...config, model: preset.defaultModel ?? "probe" }).listModels();
      spin.stop(pc.green("Connected"));
    } catch (err) {
      spin.stop(pc.yellow("Could not list models"));
      p.log.warn(err instanceof Error ? err.message : String(err));
    }
  } else if (!ollamaModels) {
    p.log.warn("Ollama isn't running on localhost:11434. Start it and pull a model (e.g. `ollama pull qwen2.5-coder`).");
  }

  if (models.length > 0) {
    config.model = unwrap(
      await p.select({
        message: "Model",
        options: models.slice(0, 50).map((m) => ({ value: m, label: m })),
        initialValue: preset.defaultModel && models.includes(preset.defaultModel) ? preset.defaultModel : models[0],
      }),
    );
  } else {
    config.model = unwrap(
      await p.text({ message: "Model name", defaultValue: preset.defaultModel, placeholder: preset.defaultModel }),
    );
  }

  config.language = unwrap(
    await p.select({
      message: "Language for commit messages",
      options: [
        { value: "en", label: "English" },
        { value: "es", label: "Español" },
        { value: "pt", label: "Português" },
        { value: "fr", label: "Français" },
      ],
    }),
  );

  config.push = unwrap(
    await p.select({
      message: "After committing, push to the remote?",
      options: [
        { value: "ask", label: "Ask me each time", hint: "recommended" },
        { value: "always", label: "Always push" },
        { value: "never", label: "Never push" },
      ],
    }),
  ) as Config["push"];

  await saveConfig(config);
  p.log.success(`Saved to ${pc.dim(configPath())}`);
  p.outro("Setup complete. Run " + pc.cyan("aicommit") + " in any git repo.");
  return config;
}

export async function runInitCommand(): Promise<void> {
  banner();
  await runInit();
}
