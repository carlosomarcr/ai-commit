import * as git from "../git/git.js";
import { formatMessage, generateMessage, type CommitMessage } from "../commit/generate.js";
import { loadConfig, type Config } from "../config/store.js";
import { createProvider } from "../providers/registry.js";
import { banner, p, pc, statusColor, unwrap } from "../ui/theme.js";
import { runInit } from "./init.js";

export interface CommitOptions {
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  push?: boolean;
  noPush?: boolean;
  provider?: string;
  model?: string;
  lang?: string;
  instructions?: string;
}

export async function runCommit(opts: CommitOptions): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" commit ")));

  if (!(await git.isRepo())) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }

  let config = await loadConfig();
  if (!config) {
    p.log.info("First run detected, let's set things up.");
    config = await runInit();
  }
  config = {
    ...config,
    provider: opts.provider ?? config.provider,
    model: opts.model ?? (opts.provider ? undefined : config.model),
    language: opts.lang ?? config.language,
  };
  const provider = createProvider(config);

  // --- Collect changes -----------------------------------------------------
  let files = await git.status();
  if (files.length === 0) {
    p.outro(pc.green("Working tree clean, nothing to commit."));
    return;
  }

  let staged = files.filter(git.isStaged);
  if (staged.length === 0 || opts.all) {
    const toStage = opts.all ? files : files.filter((f) => !git.isStaged(f));
    p.note(renderFiles(toStage), `Unstaged changes (${toStage.length})`);
    const ok =
      opts.all || opts.yes || unwrap(await p.confirm({ message: "Nothing staged. Stage all these files?" }));
    if (!ok) {
      p.cancel("Nothing staged. Use `git add` or rerun with --all.");
      return;
    }
    await git.stageAll();
    files = await git.status();
    staged = files.filter(git.isStaged);
  } else {
    p.note(renderFiles(staged), `Staged changes (${staged.length})`);
  }

  // --- Generate + review ---------------------------------------------------
  const [stat, diff, recentSubjects] = await Promise.all([
    git.stagedStat(),
    git.stagedDiff(),
    git.recentSubjects(),
  ]);

  let instructions = opts.instructions;
  let message: CommitMessage;
  for (;;) {
    const spin = p.spinner();
    spin.start(`Asking ${pc.cyan(provider.name)} for a commit message`);
    try {
      message = await generateMessage({
        provider,
        stat,
        diff,
        language: config.language,
        recentSubjects,
        instructions,
      });
      spin.stop("Message ready");
    } catch (err) {
      spin.stop(pc.red("Generation failed"));
      p.cancel(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    p.note(pc.bold(formatMessage(message)), "Proposed commit");

    if (opts.dryRun) {
      p.outro(pc.dim("Dry run: nothing committed."));
      return;
    }
    if (opts.yes) break;

    const action = unwrap(
      await p.select({
        message: "What now?",
        options: [
          { value: "commit", label: "Commit", hint: "use this message" },
          { value: "edit", label: "Edit title" },
          { value: "regen", label: "Regenerate", hint: "optionally with extra instructions" },
          { value: "cancel", label: "Cancel" },
        ],
      }),
    );
    if (action === "commit") break;
    if (action === "cancel") {
      p.cancel("Cancelled, nothing committed.");
      return;
    }
    if (action === "edit") {
      const title = unwrap(
        await p.text({
          message: "Commit title",
          initialValue: `${message.type}${message.scope ? `(${message.scope})` : ""}: ${message.title}`,
          validate: (v) => (v?.trim() ? undefined : "Title can't be empty"),
        }),
      );
      const body = message.body?.trim();
      await finishCommit(`${title.trim()}${body ? `\n\n${body}` : ""}`, config, opts);
      return;
    }
    const extra = unwrap(await p.text({ message: "Extra instructions (optional)", defaultValue: "" }));
    instructions = [opts.instructions, extra].filter(Boolean).join(". ") || undefined;
  }

  await finishCommit(formatMessage(message), config, opts);
}

async function finishCommit(message: string, config: Config, opts: CommitOptions): Promise<void> {
  const spin = p.spinner();
  spin.start("Committing");
  try {
    const hash = await git.commit(message);
    spin.stop(`Committed ${pc.yellow(hash)} ${pc.dim(message.split("\n")[0]!)}`);
  } catch (err) {
    spin.stop(pc.red("Commit failed"));
    p.log.error(err instanceof Error ? err.message : String(err));
    p.outro(pc.red("Your changes are still staged. Fix the problem and run aicommit again."));
    process.exit(1);
  }
  await maybePush(config, opts);
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
