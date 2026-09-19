import { LIST_TIMEOUT_MS, request } from "./http.js";
import { assertOk } from "./openai-compatible.js";
import { ProviderError, type GenerateOptions, type Provider } from "./types.js";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private baseUrl: string;
  constructor(private model: string, private apiKey: string, baseUrl = ANTHROPIC_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  async listModels(): Promise<string[]> {
    const res = await request(this.name, `${this.baseUrl}/models?limit=100`, { headers: this.headers(), timeoutMs: LIST_TIMEOUT_MS });
    await assertOk(res, this.name);
    const json = (await res.json()) as { data?: { id: string }[] };
    return (json.data ?? []).map((m) => m.id);
  }

  async generate({ system, user, signal }: GenerateOptions): Promise<string> {
    const res = await request(this.name, `${this.baseUrl}/messages`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    await assertOk(res, this.name);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    if (!text) throw new ProviderError("anthropic returned an empty response");
    return text;
  }
}
