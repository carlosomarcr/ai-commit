import { cac } from "cac";
import { runCommit } from "./commands/commit.js";
import { runInitCommand } from "./commands/init.js";

const cli = cac("aicommit");

cli
  .command("", "Generate a commit with AI, confirm it, then optionally push")
  .option("-a, --all", "Stage all changes before committing")
  .option("-y, --yes", "Skip confirmation prompts")
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
      push: options.push === true,
      noPush: options.push === false,
      provider: options.provider,
      model: options.model,
      lang: options.lang,
      instructions: options.instructions,
    }),
  );

cli.command("init", "Interactive setup: provider, model, preferences").action(runInitCommand);

cli.help();
cli.version("0.1.0");

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
