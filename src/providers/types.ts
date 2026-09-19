export interface GenerateOptions {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  listModels(): Promise<string[]>;
  /** Returns the raw text of the reply (expected to contain JSON). */
  generate(opts: GenerateOptions): Promise<string>;
}

export class ProviderError extends Error {}
