import { loadConfig, saveConfig, type Config } from "../config/store.js";
import { findPreset } from "../providers/registry.js";
import { verifyConnection } from "../providers/verify.js";
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

  const current = config.model ?? findPreset(config.provider)?.defaultModel ?? "default";
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

  const model = await pickModelFor(config, current);
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

/** Lists the provider's models (with a spinner) and lets the user pick one. */
export async function pickModelFor(config: Config, current?: string, preferred?: string): Promise<string | null> {
  const spin = p.spinner();
  spin.start("Loading available models");
  const v = await verifyConnection(config);
  if (v.ok) spin.stop(`${v.models.length} model(s) available`);
  else {
    spin.stop(pc.yellow("Couldn't list models"));
    p.log.warn(v.error ?? "unknown error");
  }
  return chooseModel(v.models, current, preferred);
}

/** Pure prompt: pick from a list, or type a name when the list is empty or the model isn't in it. */
export async function chooseModel(models: string[], current?: string, preferred?: string): Promise<string> {
  const ask = async () =>
    unwrap(await p.text({ message: "Model name", defaultValue: preferred, placeholder: preferred, validate: (v) => (v?.trim() || preferred ? undefined : "Required") })).trim() ||
    preferred!;

  if (models.length === 0) return ask();

  const initial =
    preferred && models.includes(preferred) ? preferred : (models.find((m) => m !== current) ?? current ?? models[0]);
  const choice = unwrap(
    await p.select({
      message: "Model",
      options: [
        ...models.slice(0, 50).map((m) => ({ value: m, label: m, hint: m === current ? "current" : undefined })),
        { value: MANUAL, label: "Type a model name…" },
      ],
      initialValue: initial,
    }),
  );
  return choice === MANUAL ? ask() : choice;
}
