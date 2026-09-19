import type { Config } from "../config/store.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ProviderError, type Provider } from "./types.js";

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl?: string;
  envKey?: string;
  defaultModel?: string;
  needsKey: boolean;
}

export const PRESETS: ProviderPreset[] = [
  { id: "ollama", label: "Ollama (local)", needsKey: false },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat", needsKey: true },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini", needsKey: true },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile", needsKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", needsKey: true },
  { id: "custom", label: "Custom (OpenAI-compatible)", needsKey: false },
];

export function createProvider(cfg: Config): Provider {
  const preset = PRESETS.find((p) => p.id === cfg.provider);
  if (!preset) throw new ProviderError(`Unknown provider "${cfg.provider}"`);
  const model = cfg.model ?? preset.defaultModel;
  if (!model) throw new ProviderError(`No model configured for ${preset.label}. Run \`aicommit init\`.`);

  if (preset.id === "ollama") return new OllamaProvider(model, cfg.baseUrl);

  const baseUrl = cfg.baseUrl ?? preset.baseUrl;
  if (!baseUrl) throw new ProviderError("No base URL configured. Run `aicommit init`.");
  const apiKey = (preset.envKey && process.env[preset.envKey]) || cfg.apiKey;
  if (preset.needsKey && !apiKey) {
    throw new ProviderError(`Missing API key for ${preset.label}. Set ${preset.envKey} or run \`aicommit init\`.`);
  }
  return new OpenAICompatibleProvider({ name: preset.id, baseUrl, apiKey, model });
}
