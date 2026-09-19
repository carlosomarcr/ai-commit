import type { Config } from "../config/store.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OLLAMA_CLOUD_URL, OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError, type Provider } from "./types.js";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: "ollama" | "openai" | "anthropic" | "gemini";
  baseUrl?: string;
  envKey?: string;
  defaultModel?: string;
  needsKey: boolean;
}

export const PRESETS: ProviderPreset[] = [
  { id: "ollama", label: "Ollama (local or cloud)", kind: "ollama", envKey: "OLLAMA_API_KEY", needsKey: false },
  { id: "deepseek", label: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", needsKey: true },
  { id: "anthropic", label: "Anthropic (Claude)", kind: "anthropic", envKey: "ANTHROPIC_API_KEY", defaultModel: "claude-haiku-4-5-20251001", needsKey: true },
  { id: "gemini", label: "Google Gemini", kind: "gemini", envKey: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash", needsKey: true },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini", needsKey: true },
  { id: "groq", label: "Groq", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", needsKey: true },
  { id: "openrouter", label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", needsKey: true },
  { id: "custom", label: "Custom (OpenAI-compatible)", kind: "openai", needsKey: false },
];

export const findPreset = (id: string) => PRESETS.find((p) => p.id === id);

/** Where the key for this config comes from, without revealing it. */
export function keyFromEnv(cfg: Config): string | undefined {
  const preset = findPreset(cfg.provider);
  return (preset?.envKey && process.env[preset.envKey]) || undefined;
}

export function createProvider(cfg: Config): Provider {
  const preset = findPreset(cfg.provider);
  if (!preset) throw new ProviderError(`Unknown provider "${cfg.provider}"`);
  const model = cfg.model ?? preset.defaultModel;
  if (!model) throw new ProviderError(`No model configured for ${preset.label}. Run \`gitowl config\`.`);

  const apiKey = keyFromEnv(cfg) || cfg.apiKey || undefined;
  if (preset.needsKey && !apiKey) {
    throw new ProviderError(`Missing API key for ${preset.label}. Set ${preset.envKey} or run \`gitowl config\`.`);
  }

  switch (preset.kind) {
    case "ollama": {
      // Key is optional: local servers don't need one, Ollama Cloud does.
      const baseUrl = cfg.baseUrl ?? (apiKey && !process.env.OLLAMA_HOST ? OLLAMA_CLOUD_URL : undefined);
      return new OllamaProvider(model, baseUrl || process.env.OLLAMA_HOST || undefined, apiKey);
    }
    case "anthropic":
      return new AnthropicProvider(model, apiKey!, cfg.baseUrl);
    case "gemini":
      return new GeminiProvider(model, apiKey!, cfg.baseUrl);
    case "openai": {
      const baseUrl = cfg.baseUrl ?? preset.baseUrl;
      if (!baseUrl) throw new ProviderError("No base URL configured. Run `gitowl config`.");
      return new OpenAICompatibleProvider({ name: preset.id, baseUrl, apiKey, model });
    }
  }
}
