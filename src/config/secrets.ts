const SERVICE = "gitowl";
/** The tool's previous name: keys saved under it are moved over the first time they're read. */
const LEGACY_SERVICE = "aicommit";

export interface SecretBackend {
  name: string;
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

/** OS keychain (Windows Credential Manager, macOS Keychain, libsecret). Null when unavailable. */
async function loadKeyring(): Promise<SecretBackend | null> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const backend: SecretBackend = {
      name: "system keyring",
      get: (a) => {
        const current = new Entry(SERVICE, a).getPassword();
        if (current) return current;
        const legacy = new Entry(LEGACY_SERVICE, a).getPassword();
        if (legacy) {
          new Entry(SERVICE, a).setPassword(legacy);
          new Entry(LEGACY_SERVICE, a).deletePassword();
        }
        return legacy ?? null;
      },
      set: (a, v) => new Entry(SERVICE, a).setPassword(v),
      delete: (a) => void new Entry(SERVICE, a).deletePassword(),
    };
    // Some Linux setups load the module but have no secret service; probe before trusting it.
    backend.get("__probe__");
    return backend;
  } catch {
    return null;
  }
}

let override: SecretBackend | null | undefined;
let cached: Promise<SecretBackend | null> | undefined;

/** Tests inject an in-memory backend (or null to simulate "no keyring"). */
export function setSecretBackend(backend: SecretBackend | null | undefined): void {
  override = backend;
  cached = undefined;
}

export function secretBackend(): Promise<SecretBackend | null> {
  if (override !== undefined) return Promise.resolve(override);
  return (cached ??= loadKeyring());
}

export async function getSecret(account: string): Promise<string | null> {
  try {
    return (await secretBackend())?.get(account) ?? null;
  } catch {
    return null;
  }
}

/** Returns true when the secret went to the keyring; false means the caller must fall back. */
export async function setSecret(account: string, value: string): Promise<boolean> {
  try {
    const backend = await secretBackend();
    if (!backend) return false;
    backend.set(account, value);
    return backend.get(account) === value;
  } catch {
    return false;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  try {
    (await secretBackend())?.delete(account);
  } catch {
    // nothing to delete
  }
}
