import { assertOk } from "./openai-compatible.js";
import { ProviderError, type GenerateOptions, type Provider } from "./types.js";

export const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements Provider {
  readonly name = "gemini";
  private baseUrl: string;
  constructor(private model: string, private apiKey: string, baseUrl = GEMINI_URL) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private headers(): Record<string, string> {
    return { "content-type": "application/json", "x-goog-api-key": this.apiKey };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/models?pageSize=200`, { headers: this.headers() });
    await assertOk(res, this.name);
    const json = (await res.json()) as {
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    return (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  }

  async generate({ system, user, signal }: GenerateOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    });
    await assertOk(res, this.name);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    if (!text) throw new ProviderError("gemini returned an empty response (blocked or no candidates)");
    return text;
  }
}
