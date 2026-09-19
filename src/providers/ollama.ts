import { assertOk } from "./openai-compatible.js";
import { ProviderError, type GenerateOptions, type Provider } from "./types.js";

export const OLLAMA_URL = "http://localhost:11434";
export const OLLAMA_CLOUD_URL = "https://ollama.com";

/** Works against a local server, a remote/proxied server, or Ollama Cloud (needs an API key). */
export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private baseUrl: string;
  constructor(private model: string, baseUrl = OLLAMA_URL, private apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { headers: this.headers() });
    await assertOk(res, this.name);
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }

  async generate({ system, user, signal }: GenerateOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    await assertOk(res, this.name);
    const json = (await res.json()) as { message?: { content?: string } };
    if (!json.message?.content) throw new ProviderError("ollama returned an empty response");
    return json.message.content;
  }
}

export async function detectOllama(baseUrl = OLLAMA_URL): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  } catch {
    return null;
  }
}
