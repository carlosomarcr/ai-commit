import { cac } from "cac";
import { runCommit } from "./commands/commit.js";
import { runChangelog } from "./commands/changelog.js";
import { runConfig } from "./commands/config.js";
import { runDoctor } from "./commands/doctor.js";
import { runInitCommand } from "./commands/init.js";
import { runRules } from "./commands/rules.js";
import { runUpdate } from "./commands/update.js";
import { scheduleUpdateNotice } from "./update/check.js";
import { readPackageInfo } from "./update/version.js";

const cli = cac("gitowl");

cli
  .command("", "Generate a commit with AI, confirm it, then optionally push")
  .option("-a, --all", "Stage all changes before committing")
  .option("-y, --yes", "Skip confirmation prompts")
  .option("--single", "Force a single commit instead of grouping")
  .option("--allow-secrets", "Commit files flagged as possible secrets instead of leaving them out")
  .option("--hunks", "Split unrelated changes inside the same file into separate commits")
  .option("--dry-run", "Show the proposed message without committing")
  .option("--push", "Push after committing without asking")
  .option("--no-push", "Never push after committing")
  .option("--provider <id>", "Override the configured provider")
  .option("--model <name>", "Override the configured model")
  .option("--lang <code>", "Language of the commit message")
  .option("-i, --instructions <text>", "Extra instructions for the AI")
  .action((options) =>
    runCommit({
      all: options.all,
      yes: options.yes,
      dryRun: options.dryRun,
      single: options.single,
      allowSecrets: options.allowSecrets,
      hunks: options.hunks,
      push: options.push === true,
      noPush: options.push === false,
      provider: options.provider,
      model: options.model,
      lang: options.lang,
      instructions: options.instructions,
    }),
  );

cli.command("init", "Interactive setup: provider, model, preferences").action(runInitCommand);

cli
  .command("update", "Check for a new version and install it")
  .option("--check", "Only check, do not install")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action((o) => runUpdate({ check: o.check, yes: o.yes }));

cli
  .command("config [action] [key] [value]", "View or change settings (menu, or: get | set | path | reset)")
  .action((action, key, value) => runConfig(action, key, value));

cli
  .command("doctor", "Diagnose your setup: git, provider, key, connection, project rules")
  .option("--deep", "Also run a real test generation against the model")
  .action((o) => runDoctor({ deep: o.deep }));

cli
  .command("changelog", "Generate or update CHANGELOG.md from your git history")
  .option("-o, --output <file>", "Changelog file (default: CHANGELOG.md at the repo root)")
  .option("-r, --release <version>", "Heading for the changes not tagged yet (default: package.json version, or Unreleased)")
  .option("--from <ref>", "Start of the range (exclusive): a tag, branch or commit")
  .option("--to <ref>", "End of the range (default: HEAD)")
  .option("--no-ai", "Use commit messages as they are, without calling a model")
  .option("--all-types", "Also include docs, test, chore, ci, build and style commits")
  .option("--limit <n>", "Max number of missing tagged releases to write (default: 10)")
  .option("--force", "Regenerate a section that already exists")
  .option("--dry-run", "Show the result without writing the file")
  .option("-y, --yes", "Skip the confirmation prompt")
  .option("--provider <id>", "Override the configured provider")
  .option("--model <name>", "Override the configured model")
  .option("--lang <code>", "Language of the entries")
  .action((o) =>
    runChangelog({
      output: o.output,
      release: o.release,
      from: o.from,
      to: o.to,
      ai: o.ai,
      allTypes: o.allTypes,
      limit: o.limit === undefined ? undefined : Number(o.limit),
      force: o.force,
      dryRun: o.dryRun,
      yes: o.yes,
      provider: o.provider,
      model: o.model,
      lang: o.lang,
    }),
  );

cli.command("rules", "Show the commit rules detected for this project").action(runRules);

cli.help();
cli.version(readPackageInfo().version);

const first = process.argv[2];
if (first !== "update" && !process.argv.some((a) => ["-h", "--help", "-v", "--version"].includes(a))) {
  scheduleUpdateNotice();
}

// No top-level await: the standalone binary is bundled as CommonJS.
async function main(): Promise<void> {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
