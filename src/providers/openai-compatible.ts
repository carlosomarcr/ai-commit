import { ProviderError, type GenerateOptions, type Provider } from "./types.js";

export interface OpenAICompatibleConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Covers OpenAI, DeepSeek, Groq, OpenRouter, LM Studio and any compatible endpoint. */
export class OpenAICompatibleProvider implements Provider {
  readonly name: string;
  constructor(private cfg: OpenAICompatibleConfig) {
    this.name = cfg.name;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(this.url("/models"), { headers: this.headers() });
    await assertOk(res, this.name);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id).sort();
  }

  async generate({ system, user, signal }: GenerateOptions): Promise<string> {
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    await assertOk(res, this.name);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new ProviderError(`${this.name} returned an empty response`);
    return text;
  }
}

export async function assertOk(res: Response, name: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const hint =
    res.status === 401 ? " (invalid API key?)" : res.status === 429 ? " (rate limited)" : "";
  throw new ProviderError(`${name} responded ${res.status}${hint}: ${body.slice(0, 200)}`);
}
