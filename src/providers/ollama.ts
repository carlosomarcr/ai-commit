import { assertOk } from "./openai-compatible.js";
import { ProviderError, type GenerateOptions, type Provider } from "./types.js";

export const OLLAMA_URL = "http://localhost:11434";

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  constructor(private model: string, private baseUrl = OLLAMA_URL) {}

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    await assertOk(res, this.name);
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }

  async generate({ system, user, signal }: GenerateOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
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
