import { ProviderError } from "./types.js";

export const GENERATE_TIMEOUT_MS = 180_000;
export const LIST_TIMEOUT_MS = 20_000;

const FRIENDLY: Record<string, string> = {
  ECONNREFUSED: "connection refused",
  ENOTFOUND: "host not found",
  ETIMEDOUT: "connection timed out",
  ECONNRESET: "connection reset",
  EAI_AGAIN: "DNS lookup failed",
  CERT_HAS_EXPIRED: "TLS certificate expired",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate not trusted",
};

export interface RequestInitWithTimeout extends RequestInit {
  timeoutMs?: number;
}

/**
 * fetch with a deadline and readable failures. Node's raw "fetch failed" tells the user nothing;
 * this says which provider, which host, and why (refused, DNS, timeout...).
 */
export async function request(name: string, url: string, init: RequestInitWithTimeout = {}): Promise<Response> {
  const { timeoutMs = GENERATE_TIMEOUT_MS, signal: outer, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  try {
    return await fetch(url, { ...rest, signal });
  } catch (err) {
    if (outer?.aborted) throw err; // the caller cancelled on purpose
    if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      throw new ProviderError(`${name} did not answer within ${Math.round(timeoutMs / 1000)} s. The model may be too slow or overloaded.`);
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    const why = cause?.code ? (FRIENDLY[cause.code] ?? cause.code) : "network error";
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url
    }
    throw new ProviderError(`Could not reach ${name} at ${host} (${why}).`);
  }
}
