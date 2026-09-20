# 🦉 gitowl

AI-written git commits that **group your changes into logical commits**, follow **your project's own rules**, and **always ask before committing or pushing**. Works with local models (Ollama) and hosted ones (DeepSeek, Claude, Gemini, OpenAI, Groq, OpenRouter, any OpenAI-compatible endpoint).

```
◇  Changes (7)
◇  Rules applied  CLAUDE.md §Commits · commitlint.config.js
◇  Planning commits

◇  1/3  refactor(auth): extract token parsing ─────╮
│  ↳ groundwork for the new login flow             │
│  M src/auth/token.ts  +18 -9                     │
│  A src/auth/parse.ts  +31 -0                     │
├───────────────────────────────────────────────────╯
◇  2/3  feat(auth): add passwordless login ─────────╮
│  M src/auth/login.ts  hunks 1,2  +44 -6          │
│  A src/auth/login.test.ts  +52 -0                │
├───────────────────────────────────────────────────╯
◇  3/3  build: bump zod ────────────────────────────╮
│  M package.json  +1 -1                           │
│  M pnpm-lock.yaml  +12 -12                       │
├───────────────────────────────────────────────────╯
?  What now?
   ● Commit all 3 in order
   ○ Edit a commit…   ○ Move files…   ○ Split…   ○ Merge…   ○ Cancel
```

## Install

```bash
# any platform, needs Node 20.19+
npm install -g @carlosomarcr/gitowl        # or: pnpm add -g @carlosomarcr/gitowl   (the command is `gitowl`, or the shorter `owl`)

# one-liners that also run the setup wizard
curl -fsSL https://raw.githubusercontent.com/carlosomarcr/gitowl/main/install.sh | sh          # macOS / Linux
irm https://raw.githubusercontent.com/carlosomarcr/gitowl/main/install.ps1 | iex               # Windows (PowerShell)
```

Standalone binaries (no Node needed) for Windows, macOS and Linux are attached to every [release](https://github.com/carlosomarcr/gitowl/releases). They keep the API key in the config file (owner-only permissions) because the OS keyring is a native module that cannot be embedded; the npm install uses the keyring.

## Quick start

```bash
gitowl init      # 4-step wizard: provider, connection, model, preferences
cd my-repo
gitowl           # plan → review → commit → optional push
```

`gitowl doctor` checks git, your provider, key, model and project rules and tells you how to fix anything that is off (`--deep` also runs a real test generation).

## How it works

1. **Scope.** If you staged files, only those are used. Otherwise everything is (`--all` forces it).
2. **Plan.** The model splits the changes into commits: code with its tests, manifests with lockfiles, docs / CI / dependency bumps apart, ordered so each commit builds on the previous. Every file is placed exactly once; anything the model forgets is placed by folder and you are told.
3. **Review.** Edit a title (or the full message in your editor), regenerate a message, move files between commits, split, merge, skip a commit, or ask for a new plan with guidance ("keep docs separate").
4. **Commit.** Each commit contains exactly its files. Your working tree is never touched; hooks run normally and if one fails you can retry, skip that commit, or stop.
5. **Push.** You are asked once at the end. It shows the target branch, sets the upstream if needed, warns on `main`/`master`, and never force-pushes or pushes a branch that is behind its remote.

Cancelling or hitting Ctrl+C before commits start restores your staging exactly as it was.

### Split a single file into several commits

```bash
gitowl --hunks
```

Unrelated changes inside one file (a feature and an unrelated typo fix) can go into different commits. Files are only split when applying all hunks reproduces the staged content byte for byte; otherwise they stay whole.

## Your project's rules

gitowl reads the commit rules that already exist in your repo, nearest file wins (great for monorepos):

`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `.gitmessage`, and `commitlint` config (allowed types, scopes, header length).

Only the commit-related sections are extracted (headings about commits/git, plus lines that mention committing). It also learns from your last 30 commits: language, conventional or free-form, scope usage. `gitowl rules` shows exactly what the model will be told.

Highest priority is an optional `.gitowl.json`:

```json
{ "language": "es", "style": "conventional", "types": ["feat", "fix", "chore"],
  "scopes": ["api", "web"], "maxHeaderLength": 72, "instructions": "Mention the ticket id." }
```

Messages are validated against `types`, `scopes` and `maxHeaderLength`; violations are fed back to the model and, if they persist, shown as a warning.

## Changelog

`gitowl changelog` (or `owl changelog`) writes release notes from your git history, in a few seconds and without reading any diffs, only commit messages.

- **Creates or updates** `CHANGELOG.md`. Existing content is never rewritten: new sections are inserted in version order, and sections that already exist are left alone, so running it twice changes nothing.
- **Finds what is missing on its own.** Each tag (`v1.2.3`, `1.2.3`, `pkg@1.2.3`) is a release; tags without a section are added, plus the commits after the last tag. Those get the version in `package.json` if it is not tagged yet, otherwise `Unreleased` (regenerated every time and turned into the release once tagged).
- **Copies your file's style**: flat list or `### Added / Fixed` groups, `## 1.2.3` or `## [1.2.3]`, with or without dates. A new file uses Keep a Changelog.
- **Filters noise**: merges, version bumps, release/changelog commits and `docs`, `test`, `chore`, `ci`, `build`, `style` commits are left out (`--all-types` keeps them). Breaking changes are always kept and marked.
- **AI is optional.** With a provider configured, entries are rewritten for users of the software, related commits merged and internal work dropped; if the model fails, it falls back to your commit messages. `--no-ai` never calls a model.

```
gitowl changelog                      preview, confirm, write
gitowl changelog --dry-run            show the result only
gitowl changelog --release 1.4.0      heading for the untagged commits
gitowl changelog --from v1.0.0 --to v1.2.0   one explicit range
gitowl changelog --force              regenerate an existing section
gitowl changelog --no-ai -y           no model, no prompts (CI friendly)
```

Other flags: `-o, --output <file>`, `--limit <n>` (missing tagged releases to write, default 10), `--all-types`, `--provider`, `--model`, `--lang`. Link references at the bottom of the file (`[1.0.0]: https://…`) are kept but not updated.

## Providers

| Provider | Setup | Key |
|---|---|---|
| Ollama (local) | `ollama serve` | none |
| Ollama Cloud / remote | wizard asks for URL | `OLLAMA_API_KEY` |
| DeepSeek | | `DEEPSEEK_API_KEY` |
| Anthropic (Claude) | | `ANTHROPIC_API_KEY` |
| Google Gemini | | `GEMINI_API_KEY` |
| OpenAI / Groq / OpenRouter | | `OPENAI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` |
| Custom | any OpenAI-compatible base URL (LM Studio, vLLM…) | optional |

API keys are stored in your **system keyring** (Windows Credential Manager, macOS Keychain, libsecret), never in the config file, unless no keyring exists. Environment variables always win.

If the model fails (not in your plan, rate limit, invalid JSON) you can switch model or provider right there and continue.

## Security & privacy

- Diffs are scanned for API keys, tokens, private keys and hard-coded passwords. Secrets are **redacted before anything is sent to a model**, and files like `.env`, `*.pem`, `id_rsa` are never sent at all.
- Flagged files can be left out of the commit (default with `--yes`); `--allow-secrets` overrides.
- `.gitowlignore` (gitignore syntax) lists files that are committed but whose content is never sent to the model.
- Hosted providers do receive your (redacted) diffs. For private code, use a local Ollama.
- The scanner is heuristic and not a replacement for a dedicated tool such as gitleaks.

## Commands and flags

```
gitowl [options]            plan, review, commit, push
gitowl init                 setup wizard
gitowl config [get|set|path|reset]   menu, or scriptable access
gitowl doctor [--deep]      diagnose your setup
gitowl rules                show the rules found for this project
gitowl changelog            generate or update CHANGELOG.md from git history
gitowl update [--check]     update to the latest version

-a, --all              include unstaged and untracked files
    --single           one commit for everything
    --hunks            split unrelated changes inside a file
    --dry-run          show the plan, change nothing
-y, --yes              no prompts (flagged secrets are left out)
    --allow-secrets    commit files flagged as possible secrets
    --push / --no-push
    --provider <id> --model <name> --lang <code>
-i, --instructions "…" extra guidance for the model
```

`owl` is a shorter alias for `gitowl`: both do exactly the same. If another program named `owl` is on your PATH first (for example the `owl-cli` npm package), keep using `gitowl`; `gitowl doctor` tells you when that happens. A `git owl` shortcut can also be added by the wizard.

Standalone binaries are named `gitowl`; rename the file to `owl` if you prefer the short name.

## Updates

`gitowl update` detects how it was installed (npm, pnpm, yarn, bun, binary) and runs the right command. A once-a-day, non-blocking check prints a notice when a new version exists; disable it with `gitowl config set updateCheck off` or `GITOWL_NO_UPDATE_CHECK=1`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not reach ollama … connection refused` | start it: `ollama serve` |
| `402` / "not included in your plan" | pick another model when prompted, or `gitowl config` → Model |
| Messages ignore my format | `gitowl rules` to see what was detected; add `.gitowl.json` |
| A merge/rebase is in progress | finish or abort it, then rerun |
| Anything else | `gitowl doctor --deep` |

## Development

```bash
pnpm install
pnpm dev          # run from source, e.g. pnpm dev --dry-run
pnpm test         # unit and real-git integration tests
pnpm typecheck && pnpm build
```

## License

MIT
