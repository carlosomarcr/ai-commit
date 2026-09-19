import * as git from "../git/git.js";
import type { FileSummary } from "../grouping/types.js";
import { assessRisk, scanDiff, type FileRisk } from "../security/scan.js";
import { p, pc, unwrap } from "../ui/theme.js";

/** Refuses to run in the middle of a merge/rebase/cherry-pick: splitting into several commits would corrupt it. */
export async function guardOperation(): Promise<void> {
  const op = await git.operationInProgress();
  if (!op) return;
  p.cancel(
    `A ${op} is in progress. Finish it first (${op === "rebase" ? "git rebase --continue" : `git ${op} --continue`}, or --abort), then run aicommit again.`,
  );
  process.exit(1);
}

/** Scans what is about to be committed for secrets. Returns null (with a warning) if the diff is too big to scan. */
export async function findRisks(summaries: FileSummary[]): Promise<FileRisk[] | null> {
  try {
    const findings = scanDiff(await git.stagedAddedLinesDiff());
    return assessRisk(findings, summaries.map((s) => s.path));
  } catch {
    p.log.warn("The change is too large to scan for secrets; skipping the secret check.");
    return null;
  }
}

export type RiskDecision = { kind: "continue" } | { kind: "exclude"; paths: string[] } | { kind: "cancel" };

/**
 * Shows possible secrets and lets the user decide. Their content was already withheld/redacted
 * from the AI; this is about whether they should be committed at all.
 */
export async function decideRisks(
  risks: FileRisk[],
  opts: { allow?: boolean; interactive: boolean },
): Promise<RiskDecision> {
  if (risks.length === 0) return { kind: "continue" };

  const lines = risks.flatMap((r) => [pc.bold(r.path), ...r.reasons.map((x) => `  ${pc.yellow("▲")} ${x}`)]);
  p.note(lines.join("\n"), pc.yellow("Possible secrets in this commit"));
  p.log.info(pc.dim("Their content was hidden from the AI (redacted or withheld)."));

  if (opts.allow) {
    p.log.warn("Committing them anyway (--allow-secrets).");
    return { kind: "continue" };
  }
  if (!opts.interactive) {
    p.log.warn("Leaving these files out of the commit. Use --allow-secrets to include them.");
    return { kind: "exclude", paths: risks.map((r) => r.path) };
  }

  const choice = unwrap(
    await p.select({
      message: "What do you want to do?",
      options: [
        { value: "exclude", label: "Leave these files out of this commit", hint: "recommended; they stay uncommitted" },
        { value: "continue", label: "Commit them anyway", hint: "make sure they're not real secrets" },
        { value: "cancel", label: "Cancel" },
      ],
    }),
  );
  if (choice === "exclude") return { kind: "exclude", paths: risks.map((r) => r.path) };
  return { kind: choice as "continue" | "cancel" };
}

export interface InterruptGuard {
  /** Call once planning is done and commits are about to be made. */
  startExecution(): void;
  shouldStop(): boolean;
  dispose(): void;
}

interface Emitter {
  on(event: string, fn: () => void): unknown;
  off(event: string, fn: () => void): unknown;
}

/**
 * Keeps the user's staging safe when the run ends early. Before any commit is made, every exit
 * path restores the original index; during commits, Ctrl+C finishes the current commit and stops.
 */
export function installInterruptGuard(
  restore: () => void,
  proc: Emitter & { exit(code: number): never } = process as unknown as Emitter & { exit(code: number): never },
  log: (msg: string) => void = (m) => console.error(m),
): InterruptGuard {
  let executing = false;
  let stop = false;

  const onExit = () => {
    if (executing) return;
    try {
      restore();
    } catch {
      // best effort: nothing more we can do while exiting
    }
  };
  const onSigint = () => {
    if (!executing) {
      onExit();
      log("\nInterrupted. Your staging was restored.");
      proc.exit(130);
    }
    if (stop) {
      log("\nForcing exit.");
      proc.exit(130);
    }
    stop = true;
    log("\nInterrupt received: finishing the current commit, then stopping…");
  };

  proc.on("exit", onExit);
  proc.on("SIGINT", onSigint);
  return {
    startExecution: () => {
      executing = true;
    },
    shouldStop: () => stop,
    dispose: () => {
      proc.off("exit", onExit);
      proc.off("SIGINT", onSigint);
    },
  };
}
