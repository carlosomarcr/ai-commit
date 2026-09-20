import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { summarizeCommits } from "../changelog/ai.js";
import { itemsFromCommits, parseCommits, type Item, type ParsedCommit } from "../changelog/commits.js";
import {
  DEFAULT_PREAMBLE,
  UNRELEASED,
  detectStyle,
  parseChangelog,
  renderHeading,
  renderSection,
  serialize,
  upsertSection,
  type Doc,
} from "../changelog/document.js";
import { appendItems, isCovered, readMarker, replaceHeading, setMarker } from "../changelog/merge.js";
import { planTargets, normalizeVersion, type Target } from "../changelog/releases.js";
import { loadConfig, type Config } from "../config/store.js";
import * as git from "../git/git.js";
import { createProvider } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { banner, p, pc, unwrap } from "../ui/theme.js";

export interface ChangelogOptions {
  output?: string;
  release?: string;
  from?: string;
  to?: string;
  /** false with --no-ai */
  ai?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
  allTypes?: boolean;
  limit?: number;
  provider?: string;
  model?: string;
  lang?: string;
}

const DEFAULT_LIMIT = 10;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const v = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Write to a temp file first so a crash never leaves a half-written changelog. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.gitowl-tmp`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** A few bullets from the newest existing sections, so the model copies their tone. */
function exampleBullets(doc: Doc): string[] {
  const bullets: string[] = [];
  for (const s of doc.sections) {
    for (const line of s.text.split("\n")) if (/^\s*[-*]\s+\S/.test(line)) bullets.push(line.trim().slice(0, 200));
    if (bullets.length >= 8) break;
  }
  return bullets.slice(0, 8);
}

interface Ai {
  provider: Provider;
  language: string;
}

async function setupAi(opts: ChangelogOptions): Promise<Ai | null> {
  if (opts.ai === false) return null;
  const stored = await loadConfig();
  if (!stored) {
    p.log.info(`No provider configured, using commit messages as they are. Run ${pc.cyan("gitowl init")} for AI summaries.`);
    return null;
  }
  const config: Config = {
    ...stored,
    provider: opts.provider ?? stored.provider,
    model: opts.model ?? (opts.provider ? undefined : stored.model),
    language: opts.lang ?? stored.language,
  };
  try {
    return { provider: createProvider(config), language: config.language };
  } catch (err) {
    p.log.warn(`AI unavailable (${errText(err)}), using commit messages as they are.`);
    return null;
  }
}

async function buildItems(commits: ParsedCommit[], ai: Ai | null, examples: string[], label: string): Promise<Item[]> {
  if (!ai) return itemsFromCommits(commits);
  const spin = p.spinner();
  spin.start(`Summarizing ${commits.length} commit(s) for ${label}`);
  try {
    const items = await summarizeCommits({ provider: ai.provider, commits, language: ai.language, examples });
    spin.stop(`Summarized ${label}`);
    // Never let a breaking change vanish because the model judged it internal.
    if (commits.some((c) => c.breaking) && !items.some((i) => i.breaking)) {
      items.push(...itemsFromCommits(commits.filter((c) => c.breaking)));
    }
    return items;
  } catch (err) {
    spin.stop(pc.yellow(`AI failed for ${label}, using commit messages`));
    p.log.warn(errText(err));
    return itemsFromCommits(commits);
  }
}

const preview = (text: string, max = 40) => {
  const lines = text.split("\n");
  return lines.length > max ? [...lines.slice(0, max), pc.dim(`… ${lines.length - max} more line(s)`)].join("\n") : text;
};

export async function runChangelog(opts: ChangelogOptions): Promise<void> {
  banner();
  p.intro(pc.bgMagenta(pc.black(" changelog ")));

  if (!(await git.isRepo())) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }
  if (!(await git.hasHead())) {
    p.cancel("This repository has no commits yet.");
    process.exit(1);
  }
  for (const ref of [opts.from, opts.to]) {
    if (ref && !(await git.refExists(ref))) {
      p.cancel(`Unknown git reference: ${ref}`);
      process.exit(1);
    }
  }

  const root = await git.root();
  const path = isAbsolute(opts.output ?? "") ? opts.output! : join(root, opts.output ?? "CHANGELOG.md");
  const shown = relative(process.cwd(), path) || path;

  const raw = await readIfExists(path);
  const doc = parseChangelog(raw ?? "");
  const fresh = raw === null || raw.trim() === "";
  if (fresh) doc.preamble = DEFAULT_PREAMBLE;
  const style = detectStyle(doc);
  p.log.info(fresh ? `Creating ${shown}` : `Updating ${shown}`);

  const existing = new Set(doc.sections.flatMap((s) => (s.version ? [s.version] : [])));
  const release = opts.release ? normalizeVersion(opts.release) : undefined;
  const plan = await planTargets({
    existing,
    from: opts.from,
    to: opts.to,
    release,
    packageVersion: await readPackageVersion(root),
    limit: opts.limit ?? DEFAULT_LIMIT,
  });

  const ai = await setupAi(opts);
  const examples = exampleBullets(doc);
  const written: { target: Target; text: string; action: "added" | "replaced" | "updated" }[] = [];

  for (const target of plan.targets) {
    const label = target.version === UNRELEASED ? "unreleased changes" : target.version;
    const commits = parseCommits(await git.commitsBetween(target.from, target.to), { allTypes: opts.allTypes });
    if (commits.length === 0) {
      if (target.pending) p.log.info(pc.dim(`No user-facing changes${target.from ? ` since ${target.from}` : ""}.`));
      continue;
    }

    // The section this run would extend: same version, or the pending "Unreleased" one being released.
    const existingIdx = doc.sections.findIndex((x) => x.version === target.version);
    const pendingIdx = target.pending && target.version !== UNRELEASED ? doc.sections.findIndex((x) => x.version === UNRELEASED) : -1;
    const idx = existingIdx >= 0 ? existingIdx : pendingIdx;

    if (idx >= 0 && !opts.force) {
      if (!target.pending) {
        p.log.info(pc.dim(`Section ${target.version} already exists, keeping it (use --force to regenerate).`));
        continue;
      }
      // Pending section already in the file: keep it and add only the commits it does not cover yet.
      const section = doc.sections[idx]!;
      const marker = readMarker(section.text);
      const fresh =
        marker && (await git.isAncestor(marker, target.to))
          ? parseCommits(await git.commitsBetween(marker, target.to), { allTypes: opts.allTypes })
          : commits.filter((c) => !isCovered(c, section.text));
      const rename = section.version !== target.version;
      if (fresh.length === 0 && !rename) {
        p.log.info(pc.dim(`Section ${target.version} already covers every commit.`));
        continue;
      }

      const items = fresh.length > 0 ? await buildItems(fresh, ai, examples, label) : [];
      if (items.length === 0 && !rename) {
        p.log.info(pc.dim(`Nothing user-facing in the ${fresh.length} new commit(s).`));
        continue;
      }
      let text = rename ? replaceHeading(section.text, renderHeading(target.version, target.date, style)) : section.text;
      const appended = appendItems(text, items, style.grouped);
      text = setMarker(appended.text, await git.shortHash(target.to));
      doc.sections[idx] = { version: target.version, text };
      const shownText = [renderHeading(target.version, target.date, style), ...appended.added].join("\n");
      written.push({ target, text: shownText, action: "updated" });
      continue;
    }

    const items = await buildItems(commits, ai, examples, label);
    if (items.length === 0) {
      p.log.info(pc.dim(`Nothing user-facing in ${label}.`));
      continue;
    }
    let text = renderSection(target.version, target.date, items, style);
    if (target.pending) text = setMarker(text, await git.shortHash(target.to));
    const action = upsertSection(doc, target.version, text, {
      replace: true,
      absorbUnreleased: target.pending,
    });
    if (action !== "skipped") written.push({ target, text, action });
  }

  if (plan.skippedOlder > 0) {
    p.log.info(pc.dim(`${plan.skippedOlder} older release(s) not in the file were skipped. Use --limit <n> to include more.`));
  }
  if (written.length === 0) {
    p.outro(pc.green(`${shown} is up to date.`));
    return;
  }

  // Oldest last, like the file itself.
  const changes = written.map((w) => w.text).join("\n\n");
  p.note(preview(changes), `${written.length} section(s) ${opts.dryRun ? "(dry run)" : ""}`.trim());
  const replaced = written.filter((w) => w.action === "replaced").map((w) => w.target.version);
  if (replaced.length > 0) p.log.warn(`Replacing existing section(s): ${replaced.join(", ")}`);
  const updated = written.filter((w) => w.action === "updated").map((w) => w.target.version);
  if (updated.length > 0) p.log.info(`Adding new entries to: ${updated.join(", ")} (existing entries are kept)`);

  if (opts.dryRun) {
    p.outro(pc.dim("Dry run: nothing written."));
    return;
  }
  if (!opts.yes && process.stdin.isTTY) {
    const ok = unwrap(await p.confirm({ message: `Write to ${shown}?`, initialValue: true }));
    if (!ok) {
      p.cancel("Cancelled, nothing written.");
      return;
    }
  }

  await writeAtomic(path, serialize(doc));
  p.outro(pc.green(`Updated ${shown}`) + pc.dim(" · review it, then commit it (e.g. with owl)"));
}
