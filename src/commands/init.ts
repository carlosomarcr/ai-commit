import { saveConfig, configPath, CONFIG_VERSION, type Config } from "../config/store.js";
import { detectOllama, OLLAMA_CLOUD_URL, OLLAMA_URL } from "../providers/ollama.js";
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

  const config: Config = { configVersion: CONFIG_VERSION, provider, language: "en", push: "ask", updateCheck: true };

  if (provider === "custom") {
    config.baseUrl = unwrap(
      await p.text({ message: "Base URL (OpenAI-compatible)", placeholder: "http://localhost:1234/v1", validate: (v) => (v?.startsWith("http") ? undefined : "Must start with http(s)://") }),
    );
  }

  let ollamaLocal = false;
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
      ollamaLocal = true;
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
      if (process.env.OLLAMA_API_KEY) {
        p.log.info("Using OLLAMA_API_KEY from your environment.");
      } else {
        const key = unwrap(
          await p.password({
            message: mode === "cloud" ? "Ollama API key (ollama.com/settings/keys)" : "API key (leave empty if none)",
            validate: mode === "cloud" ? (v) => (v?.trim() ? undefined : "Required for Ollama Cloud") : undefined,
          }),
        );
        if (key) config.apiKey = key;
      }
    }
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
  let models: string[] = ollamaLocal ? (ollamaModels ?? []) : [];
  if (!ollamaLocal) {
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
