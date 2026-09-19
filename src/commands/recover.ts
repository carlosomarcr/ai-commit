import { loadConfig, saveConfig, type Config } from "../config/store.js";
import { createProvider, PRESETS } from "../providers/registry.js";
import { p, pc, unwrap } from "../ui/theme.js";
import { runInit } from "./init.js";

const MANUAL = "__manual__";

/**
 * Shown when generation fails (plan/billing limits, unknown model, rate limits, a model that
 * can't produce valid JSON...). Lets the user switch model or provider instead of just dying.
 * Returns the config to retry with, or null if the user cancelled.
 */
export async function offerRecovery(
  err: unknown,
  config: Config,
  opts: { persist: boolean },
): Promise<{ config: Config } | null> {
  p.log.error(err instanceof Error ? err.message : String(err));

  const current = config.model ?? PRESETS.find((x) => x.id === config.provider)?.defaultModel ?? "default";
  const action = unwrap(
    await p.select({
      message: "What do you want to do?",
      options: [
        { value: "model", label: "Choose another model", hint: `current: ${current}` },
        { value: "retry", label: "Try again", hint: "same model" },
        { value: "provider", label: "Switch provider / re-run setup" },
        { value: "cancel", label: "Cancel" },
      ],
    }),
  );

  if (action === "cancel") return null;
  if (action === "retry") return { config };
  if (action === "provider") return { config: await runInit() };

  const model = await pickModel(config, current);
  if (!model) return null;
  const next = { ...config, model };

  if (opts.persist && model !== config.model) {
    const save = unwrap(await p.confirm({ message: `Save ${pc.cyan(model)} as your default model?`, initialValue: true }));
    if (save) {
      const stored = await loadConfig();
      if (stored && stored.provider === config.provider) {
        await saveConfig({ ...stored, model });
        p.log.success("Default model updated.");
      }
    }
  }
  return { config: next };
}

async function pickModel(config: Config, current: string): Promise<string | null> {
  let models: string[] = [];
  const spin = p.spinner();
  spin.start("Loading available models");
  try {
    models = await createProvider({ ...config, model: config.model ?? "probe" }).listModels();
    spin.stop(`${models.length} model(s) available`);
  } catch (e) {
    spin.stop(pc.yellow("Couldn't list models"));
    p.log.warn(e instanceof Error ? e.message : String(e));
  }

  if (models.length === 0) {
    const typed = unwrap(
      await p.text({ message: "Model name", validate: (v) => (v?.trim() ? undefined : "Required") }),
    );
    return typed.trim();
  }

  const choice = unwrap(
    await p.select({
      message: "Model",
      options: [
        ...models.slice(0, 50).map((m) => ({ value: m, label: m, hint: m === current ? "current" : undefined })),
        { value: MANUAL, label: "Type a model name…" },
      ],
      initialValue: models.find((m) => m !== current) ?? current,
    }),
  );
  if (choice !== MANUAL) return choice;
  return unwrap(await p.text({ message: "Model name", validate: (v) => (v?.trim() ? undefined : "Required") })).trim();
}
