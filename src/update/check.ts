import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configDir, loadConfig } from "../config/store.js";
import { currentInstall } from "./install.js";
import { isNewer, readPackageInfo } from "./version.js";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface UpdateState {
  checkedAt?: number;
  latest?: string;
  lastRunVersion?: string;
}

const statePath = () => join(configDir(), "state.json");

async function readState(): Promise<UpdateState> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

async function writeState(state: UpdateState): Promise<void> {
  try {
    await mkdir(configDir(), { recursive: true });
    await writeFile(statePath(), JSON.stringify(state));
  } catch {
    // state is only a cache; never fail the command over it
  }
}

/** Asks the npm registry for the `latest` dist-tag. Returns null on any failure (offline, 404, timeout). */
export async function fetchLatest(name: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

/** Force-checks now and refreshes the cache. Used by `gitowl update`. */
export async function checkNow(timeoutMs = 5000): Promise<{ current: string; latest: string | null; newer: boolean }> {
  const { name, version } = readPackageInfo();
  const latest = await fetchLatest(name, timeoutMs);
  if (latest) await writeState({ ...(await readState()), checkedAt: Date.now(), latest });
  return { current: version, latest, newer: latest ? isNewer(latest, version) : false };
}

function envDisabled(): boolean {
  return Boolean(
    process.env.GITOWL_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER || process.env.CI || !process.stdout.isTTY,
  );
}

/**
 * Passive, non-blocking update notice. Reads the cached result immediately, refreshes it at most
 * once a day in the background, and prints on process exit so it never interrupts a prompt.
 * Skipped for dev checkouts, CI, non-TTY output and when disabled in config or env.
 */
export function scheduleUpdateNotice(): void {
  if (envDisabled() || currentInstall() === "dev") return;
  const { name, version } = readPackageInfo();
  const notes: string[] = [];

  process.on("exit", () => {
    for (const n of notes) console.error(n);
  });

  void (async () => {
    if ((await loadConfig())?.updateCheck === false) return;
    const state = await readState();
    const next: UpdateState = { ...state, lastRunVersion: version };

    if (state.lastRunVersion && isNewer(version, state.lastRunVersion)) {
      notes.push(`\n  ✔ gitowl updated ${state.lastRunVersion} → ${version}  (see CHANGELOG.md)\n`);
    }

    let latest = state.latest;
    if (!state.checkedAt || Date.now() - state.checkedAt > CHECK_INTERVAL_MS) {
      latest = (await fetchLatest(name)) ?? latest;
      next.checkedAt = Date.now();
      next.latest = latest;
    }
    if (latest && isNewer(latest, version)) {
      notes.push(`\n  ⬆ Update available ${version} → ${latest}. Run \`gitowl update\`\n`);
    }
    if (next.lastRunVersion !== state.lastRunVersion || next.checkedAt !== state.checkedAt) {
      await writeState(next);
    }
  })();
}
