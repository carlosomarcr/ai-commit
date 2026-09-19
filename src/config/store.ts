import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { deleteSecret, getSecret, setSecret } from "./secrets.js";

/** Bump when the shape changes and add a migration below. */
export const CONFIG_VERSION = 1;

// Loose: unknown keys survive a load/save round trip, so downgrading never erases newer settings.
export const ConfigSchema = z.looseObject({
  configVersion: z.number().default(CONFIG_VERSION),
  provider: z.string().default("ollama"),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  language: z.string().default("en"),
  push: z.enum(["ask", "always", "never"]).default("ask"),
  /** Set to false to disable the daily "new version available" check. */
  updateCheck: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

type Raw = Record<string, unknown>;

/** Migrations keyed by the version they upgrade FROM: `1: (raw) => ({ ...raw, newField: x })`. */
export const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {};

export function migrateConfig(
  raw: Raw,
  migrations: Record<number, (raw: Raw) => Raw> = MIGRATIONS,
  target = CONFIG_VERSION,
): { raw: Raw; changed: boolean } {
  let version = typeof raw.configVersion === "number" ? raw.configVersion : 1;
  let out = raw;
  let changed = false;
  while (version < target) {
    const step = migrations[version];
    if (step) out = step(out);
    version++;
    out = { ...out, configVersion: version };
    changed = true;
  }
  return { raw: out, changed };
}

export function configDir(): string {
  const base =
    process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "aicommit");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function readRawConfig(): Promise<Raw | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Raw;
  } catch {
    return null;
  }
}

/**
 * Loads the config with the API key filled in from the OS keyring. A key still sitting in the
 * file (older versions, or no keyring available) is moved into the keyring when possible.
 */
export async function loadConfig(): Promise<Config | null> {
  const raw = await readRawConfig();
  if (!raw) return null;
  const migrated = migrateConfig(raw);
  const parsed = ConfigSchema.safeParse(migrated.raw);
  if (!parsed.success) return null;
  const config = parsed.data;

  const fileKey = config.apiKey;
  const apiKey = fileKey ?? (await getSecret(config.provider)) ?? undefined;
  const full: Config = { ...config, apiKey };
  if (migrated.changed || fileKey) await saveConfig(full).catch(() => undefined);
  return full;
}

/** Writes the config; the API key goes to the keyring and only falls back to the file if that fails. */
export async function saveConfig(config: Config): Promise<void> {
  const { apiKey, ...rest } = config;
  const onDisk: Record<string, unknown> = { ...rest };
  if (apiKey && !(await setSecret(config.provider, apiKey))) onDisk.apiKey = apiKey;
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
}

/** Removes the config file and the stored key for its provider. */
export async function resetConfig(): Promise<void> {
  const config = await loadConfig();
  if (config) await deleteSecret(config.provider);
  await rm(configPath(), { force: true });
}
