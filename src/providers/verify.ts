import type { Config } from "../config/store.js";
import { createProvider, findPreset } from "./registry.js";
import { ProviderError } from "./types.js";

export interface Verification {
  ok: boolean;
  models: string[];
  ms: number;
  error?: string;
  /** HTTP status when the provider answered with an error. */
  status?: number;
}

/** Connects with the configured credentials and lists models; the cheapest real end-to-end check. */
export async function verifyConnection(cfg: Config): Promise<Verification> {
  const started = Date.now();
  try {
    const model = cfg.model ?? findPreset(cfg.provider)?.defaultModel ?? "probe";
    const models = await createProvider({ ...cfg, model }).listModels();
    return { ok: true, models, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      models: [],
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof ProviderError ? err.status : undefined,
    };
  }
}

export const isAuthError = (v: Verification) => v.status === 401 || v.status === 403;
