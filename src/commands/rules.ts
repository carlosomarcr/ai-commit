import * as git from "../git/git.js";
import { loadRules } from "../rules/index.js";
import { banner, p, pc } from "../ui/theme.js";

/** `gitowl rules`: shows exactly what the AI will be told about this project. */
export async function runRules(): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" rules ")));
  if (!(await git.isRepo())) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }

  const rules = await loadRules({
    cwd: process.cwd(),
    root: await git.root(),
    subjects: await git.recentSubjects(),
  });

  const sourceLines = rules.sources.map((s) => `${pc.cyan(s.kind.padEnd(10))} ${s.label}`);
  p.note(sourceLines.length ? sourceLines.join("\n") : pc.dim("No rule files found, using defaults."), "Sources");

  const constraints = [
    `style        ${rules.style}`,
    rules.types ? `types        ${rules.types.join(", ")}` : "",
    rules.scopes ? `scopes       ${rules.scopes.join(", ")}` : "",
    rules.maxHeaderLength ? `max header   ${rules.maxHeaderLength}` : "",
    rules.language ? `language     ${rules.language}` : "",
    rules.history
      ? `history      ${Math.round(rules.history.conventionalRatio * 100)}% conventional over ${rules.history.count} commits`
      : "",
  ].filter(Boolean);
  p.note(constraints.join("\n"), "Constraints");

  if (rules.text) p.note(rules.text, "Excerpts sent to the AI");
  p.outro(pc.dim("Create a .gitowl.json to override anything above."));
}
