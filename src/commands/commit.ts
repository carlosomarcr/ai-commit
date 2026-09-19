import { header, type CommitMessage } from "../commit/generate.js";
import { loadConfig, type Config } from "../config/store.js";
import { executePlan } from "../grouping/execute.js";
import { messageForFiles, planCommits, singlePlan, type PlanInput } from "../grouping/planner.js";
import { collectSummaries } from "../grouping/summarize.js";
import type { CommitGroup, CommitPlan, FileSummary } from "../grouping/types.js";
import * as git from "../git/git.js";
import { createProvider } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { loadRules } from "../rules/index.js";
import { renderGroup, reviewPlan } from "../ui/plan-review.js";
import { banner, p, pc, statusColor, unwrap } from "../ui/theme.js";
import { loadIgnore } from "../security/ignore.js";
import { runInit } from "./init.js";
import { offerRecovery } from "./recover.js";
import { decideRisks, findRisks, guardOperation, installInterruptGuard } from "./safety.js";

export interface CommitOptions {
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  single?: boolean;
  allowSecrets?: boolean;
  push?: boolean;
  noPush?: boolean;
  provider?: string;
  model?: string;
  lang?: string;
  instructions?: string;
}

interface AiState {
  config: Config;
  provider: Provider;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Runs an AI call with a spinner. On failure (plan limits, bad model, ...) the user can switch
 * model/provider and retry; returns null if they cancel. Non-interactive runs rethrow.
 */
async function withRecovery<T>(
  state: AiState,
  opts: CommitOptions,
  label: string,
  run: (provider: Provider) => Promise<T>,
): Promise<T | null> {
  for (;;) {
    const spin = p.spinner();
    spin.start(label);
    try {
      const value = await run(state.provider);
      spin.stop(label.replace(/\.{3}$/, ""));
      return value;
    } catch (err) {
      spin.stop(pc.red("Generation failed"));
      if (opts.yes || !process.stdin.isTTY) throw err;
      const recovered = await offerRecovery(err, state.config, { persist: !opts.provider });
      if (!recovered) return null;
      state.config = recovered.config;
      state.provider = createProvider(state.config);
    }
  }
}

export async function runCommit(opts: CommitOptions): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" commit ")));

  if (!(await git.isRepo())) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }

  const stored = await loadConfig();
  if (!stored) p.log.info("First run detected, let's set things up.");
  const base = stored ?? (await runInit());
  const config: Config = {
    ...base,
    provider: opts.provider ?? base.provider,
    model: opts.model ?? (opts.provider ? undefined : base.model),
    language: opts.lang ?? base.language,
  };
  const state: AiState = { config, provider: createProvider(config) };

  // --- Decide what is in scope ---------------------------------------------
  const files = await git.status();
  if (files.length === 0) {
    p.outro(pc.green("Working tree clean, nothing to commit."));
    return;
  }
  if (files.some(git.hasConflict)) {
    p.cancel("There are unresolved merge conflicts. Resolve them first.");
    process.exit(1);
  }

  await guardOperation();

  // Respect deliberate staging; otherwise take everything. The original index is snapshotted so
  // any cancel/failure before committing puts it back exactly as it was.
  const origTree = await git.writeTree();
  const alreadyStaged = files.filter(git.isStaged);
  const useAll = Boolean(opts.all) || alreadyStaged.length === 0;
  if (useAll) await git.stageAll();
  else {
    const left = files.length - alreadyStaged.length;
    if (left > 0) p.log.info(`${left} unstaged file(s) left out. Use ${pc.cyan("--all")} to include them.`);
  }
  const fullTree = await git.writeTree();
  const restoreIndex = () => git.readTree(origTree).catch(() => undefined);
  // From here until commits start, any exit path (cancel, error, Ctrl+C) puts the index back.
  const guard = installInterruptGuard(() => git.readTreeSync(origTree));

  const inScope = (await git.status()).filter(git.isStaged);
  if (inScope.length === 0) {
    await restoreIndex();
    p.outro(pc.green("Nothing to commit."));
    return;
  }
  p.note(renderFiles(inScope), `${useAll ? "Changes" : "Staged changes"} (${inScope.length})`);

  let plan: CommitPlan | null;
  let planInput: (provider: Provider, extra?: string) => PlanInput;
  let summaries: FileSummary[];
  let allSummaries: FileSummary[];
  let leftover: CommitGroup[] = [];
  try {
    const spin = p.spinner();
    spin.start(`Analyzing ${inScope.length} file(s)`);
    const root = await git.root();
    allSummaries = await collectSummaries(inScope, { ignore: await loadIgnore(root) });
    spin.stop(`Analyzed ${inScope.length} file(s)`);

    // Secrets: never sent to the AI (redacted/withheld), and the user decides whether they get committed.
    const risks = await findRisks(allSummaries);
    summaries = allSummaries;
    if (risks) {
      const decision = await decideRisks(risks, { allow: opts.allowSecrets, interactive: !opts.yes && Boolean(process.stdin.isTTY) });
      if (decision.kind === "cancel") {
        await restoreIndex();
        p.cancel("Cancelled, nothing committed.");
        return;
      }
      if (decision.kind === "exclude") {
        const out = new Set(decision.paths);
        summaries = allSummaries.filter((x) => !out.has(x.path));
        leftover = [{ id: "excluded", files: decision.paths, message: { type: "chore", title: "excluded" } }];
        if (summaries.length === 0) {
          await restoreIndex();
          p.outro(pc.yellow("Nothing left to commit after leaving out the flagged files."));
          return;
        }
      }
    }

    const subjects = await git.recentSubjects();
    const rules = await loadRules({ cwd: process.cwd(), root, subjects });
    const applied = rules.sources.filter((s) => s.kind !== "history");
    if (applied.length) {
      p.log.info(`${pc.bold("Rules applied")}  ${pc.dim(applied.map((s) => s.label).join(" · "))}`);
    }
    const language = opts.lang ?? rules.language ?? config.language;
    planInput = (provider, extra) => ({
      provider,
      summaries,
      language,
      rules,
      instructions: [opts.instructions, extra].filter(Boolean).join(". ") || undefined,
    });

    const single = opts.single || summaries.length === 1;
    plan = await withRecovery(state, opts, single ? "Writing commit message..." : "Planning commits...", (provider) =>
      single ? singlePlan(planInput(provider)) : planCommits(planInput(provider)),
    );
  } catch (err) {
    await restoreIndex();
    p.cancel(errText(err));
    process.exit(1);
  }
  if (!plan) {
    await restoreIndex();
    p.cancel("Cancelled, nothing committed.");
    return;
  }

  // --- Review ---------------------------------------------------------------
  const sums = summaries;
  let groups: CommitGroup[] = plan.groups;

  if (opts.dryRun) {
    plan.groups.forEach((g, i) =>
      p.note(renderGroup(g, sums), `${i + 1}/${plan!.groups.length}  ${pc.bold(header(g.message))}`),
    );
    for (const w of plan.warnings) p.log.warn(w);
    await restoreIndex();
    p.outro(pc.dim("Dry run: nothing committed."));
    return;
  }

  if (opts.yes) {
    for (const w of plan.warnings) p.log.warn(w);
  } else {
    const outcome = await reviewPlan(plan, {
      summaries: sums,
      regenMessage: (paths) =>
        withRecovery<CommitMessage>(state, opts, "Writing commit message...", (provider) =>
          messageForFiles(planInput(provider), paths),
        ).catch((err) => {
          p.log.error(errText(err));
          return null;
        }),
      replan: (extra) =>
        withRecovery(state, opts, "Planning commits...", (provider) => planCommits(planInput(provider, extra))).catch((err) => {
          p.log.error(errText(err));
          return null;
        }),
    });
    if (outcome.kind === "cancel") {
      await restoreIndex();
      p.cancel("Cancelled, nothing committed.");
      return;
    }
    groups = outcome.groups;
    leftover = [...leftover, ...outcome.skipped];
  }

  // --- Commit ---------------------------------------------------------------
  guard.startExecution();
  let spin = p.spinner();
  const result = await executePlan(
    groups,
    { fullTree, origTree, summaries: allSummaries, restoreSkipped: !useAll, leftover },
    {
      shouldStop: guard.shouldStop,
      onStart: (g, i, n) => {
        spin = p.spinner();
        spin.start(`Committing ${i + 1}/${n}: ${header(g.message)}`);
      },
      onCommitted: (g, hash) => spin.stop(`${pc.yellow(hash)} ${header(g.message)}`),
      onEmpty: (g) => spin.stop(pc.dim(`Skipped "${header(g.message)}": already identical to HEAD`)),
      onFailure: async (g, err) => {
        spin.stop(pc.red(`Commit failed: ${header(g.message)}`));
        p.log.error(err.message);
        if (opts.yes || !process.stdin.isTTY) return "abort";
        return unwrap(
          await p.select({
            message: "What now?",
            options: [
              { value: "retry", label: "Try this commit again" },
              { value: "skip", label: "Skip this commit", hint: "its files stay uncommitted" },
              { value: "abort", label: "Stop here", hint: "keeps commits already made, restores your staging" },
            ],
          }),
        ) as "retry" | "skip" | "abort";
      },
    },
  );

  guard.dispose();
  const leftFiles = [...result.skipped, ...leftover].reduce((n, g) => n + g.files.length, 0);
  if (leftFiles > 0) p.log.info(`${leftFiles} file(s) were left uncommitted.`);
  if (result.aborted) {
    p.outro(pc.yellow(`Stopped after ${result.committed.length} commit(s).`));
    process.exit(1);
  }
  if (result.committed.length === 0) {
    p.outro(pc.yellow("No commits were made."));
    return;
  }
  p.log.success(`Created ${result.committed.length} commit${result.committed.length === 1 ? "" : "s"}`);
  await maybePush(state.config, opts);
}

async function maybePush(config: Config, opts: CommitOptions): Promise<void> {
  if (opts.noPush || config.push === "never") {
    p.outro(pc.green("Done."));
    return;
  }

  const branch = await git.currentBranch();
  if (branch === "HEAD") {
    p.outro(pc.green("Done.") + pc.dim(" (detached HEAD, skipping push)"));
    return;
  }
  const remote = await git.defaultRemote();
  if (!remote) {
    p.outro(pc.green("Done.") + pc.dim(" (no remote configured, skipping push)"));
    return;
  }

  const upstream = await git.upstream();
  const target = upstream ?? `${remote}/${branch}`;

  const counts = upstream ? await git.aheadBehind() : null;
  if (counts && counts.behind > 0) {
    p.log.warn(
      `${pc.bold(target)} is ${counts.behind} commit(s) ahead of your branch${
        counts.ahead ? " (diverged)" : ""
      }. Pull/rebase first, then push. Skipping push.`,
    );
    p.outro(pc.green("Done."));
    return;
  }

  const protectedBranch = /^(main|master|production|prod)$/.test(branch);
  const auto = opts.push || config.push === "always";
  if (!auto) {
    const ok = unwrap(
      await p.confirm({
        message: `Push to ${pc.cyan(target)}${upstream ? "" : pc.dim(" (new upstream)")}?${
          protectedBranch ? pc.yellow(`  ⚠ ${branch} is a protected-looking branch`) : ""
        }`,
        initialValue: !protectedBranch,
      }),
    );
    if (!ok) {
      p.outro(pc.green("Done.") + pc.dim(" Not pushed."));
      return;
    }
  }

  const spin = p.spinner();
  spin.start(`Pushing to ${target}`);
  try {
    await git.push({ setUpstream: upstream ? undefined : { remote, branch } });
    spin.stop(`Pushed to ${pc.cyan(target)}`);
    p.outro(pc.green("All done ✔"));
  } catch (err) {
    spin.stop(pc.red("Push failed"));
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.yellow("Commit is saved locally; push manually when ready."));
    process.exit(1);
  }
}

function renderFiles(files: git.ChangedFile[]): string {
  const shown = files.slice(0, 20).map((f) => {
    const letter = f.worktree === "?" ? "?" : f.index !== " " ? f.index : f.worktree;
    return `${(statusColor[letter] ?? pc.white)(letter)} ${f.path}`;
  });
  if (files.length > 20) shown.push(pc.dim(`… and ${files.length - 20} more`));
  return shown.join("\n");
}
