import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  provider: z.string().default("ollama"),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  language: z.string().default("en"),
  push: z.enum(["ask", "always", "never"]).default("ask"),
});
export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  const base =
    process.env.APPDATA ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "aicommit", "config.json");
}

export async function loadConfig(): Promise<Config | null> {
  try {
    return ConfigSchema.parse(JSON.parse(await readFile(configPath(), "utf8")));
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}
