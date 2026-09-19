import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

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

export async function loadConfig(): Promise<Config | null> {
  let raw: Raw;
  try {
    raw = JSON.parse(await readFile(configPath(), "utf8")) as Raw;
  } catch {
    return null;
  }
  const migrated = migrateConfig(raw);
  const parsed = ConfigSchema.safeParse(migrated.raw);
  if (!parsed.success) return null;
  if (migrated.changed) await saveConfig(parsed.data).catch(() => undefined);
  return parsed.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}
