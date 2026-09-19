# aicommit

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
# any platform, needs Node 20+
npm install -g aicommit-cli        # or: pnpm add -g aicommit-cli

# one-liners that also run the setup wizard
curl -fsSL https://raw.githubusercontent.com/carlosomarcr/ai-commit/main/install.sh | sh          # macOS / Linux
irm https://raw.githubusercontent.com/carlosomarcr/ai-commit/main/install.ps1 | iex               # Windows (PowerShell)
```

Standalone binaries (no Node needed) for Windows, macOS and Linux are attached to every [release](../../releases). They keep the API key in the config file (owner-only permissions) because the OS keyring is a native module that cannot be embedded; the npm install uses the keyring.

## Quick start

```bash
aicommit init      # 4-step wizard: provider, connection, model, preferences
cd my-repo
aicommit           # plan → review → commit → optional push
```

`aicommit doctor` checks git, your provider, key, model and project rules and tells you how to fix anything that is off (`--deep` also runs a real test generation).

## How it works

1. **Scope.** If you staged files, only those are used. Otherwise everything is (`--all` forces it).
2. **Plan.** The model splits the changes into commits: code with its tests, manifests with lockfiles, docs / CI / dependency bumps apart, ordered so each commit builds on the previous. Every file is placed exactly once; anything the model forgets is placed by folder and you are told.
3. **Review.** Edit a title (or the full message in your editor), regenerate a message, move files between commits, split, merge, skip a commit, or ask for a new plan with guidance ("keep docs separate").
4. **Commit.** Each commit contains exactly its files. Your working tree is never touched; hooks run normally and if one fails you can retry, skip that commit, or stop.
5. **Push.** You are asked once at the end. It shows the target branch, sets the upstream if needed, warns on `main`/`master`, and never force-pushes or pushes a branch that is behind its remote.

Cancelling or hitting Ctrl+C before commits start restores your staging exactly as it was.

### Split a single file into several commits

```bash
aicommit --hunks
```

Unrelated changes inside one file (a feature and an unrelated typo fix) can go into different commits. Files are only split when applying all hunks reproduces the staged content byte for byte; otherwise they stay whole.

## Your project's rules

aicommit reads the commit rules that already exist in your repo, nearest file wins (great for monorepos):

`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`, `.github/copilot-instructions.md`, `CONTRIBUTING.md`, `.gitmessage`, and `commitlint` config (allowed types, scopes, header length).

Only the commit-related sections are extracted (headings about commits/git, plus lines that mention committing). It also learns from your last 30 commits: language, conventional or free-form, scope usage. `aicommit rules` shows exactly what the model will be told.

Highest priority is an optional `.aicommit.json`:

```json
{ "language": "es", "style": "conventional", "types": ["feat", "fix", "chore"],
  "scopes": ["api", "web"], "maxHeaderLength": 72, "instructions": "Mention the ticket id." }
```

Messages are validated against `types`, `scopes` and `maxHeaderLength`; violations are fed back to the model and, if they persist, shown as a warning.

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
- `.aicommitignore` (gitignore syntax) lists files that are committed but whose content is never sent to the model.
- Hosted providers do receive your (redacted) diffs. For private code, use a local Ollama.
- The scanner is heuristic and not a replacement for a dedicated tool such as gitleaks.

## Commands and flags

```
aicommit [options]            plan, review, commit, push
aicommit init                 setup wizard
aicommit config [get|set|path|reset]   menu, or scriptable access
aicommit doctor [--deep]      diagnose your setup
aicommit rules                show the rules found for this project
aicommit update [--check]     update to the latest version

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

A `git ai` shortcut can be added by the wizard.

## Updates

`aicommit update` detects how it was installed (npm, pnpm, yarn, bun, binary) and runs the right command. A once-a-day, non-blocking check prints a notice when a new version exists; disable it with `aicommit config set updateCheck off` or `AICOMMIT_NO_UPDATE_CHECK=1`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not reach ollama … connection refused` | start it: `ollama serve` |
| `402` / "not included in your plan" | pick another model when prompted, or `aicommit config` → Model |
| Messages ignore my format | `aicommit rules` to see what was detected; add `.aicommit.json` |
| A merge/rebase is in progress | finish or abort it, then rerun |
| Anything else | `aicommit doctor --deep` |

## Development

```bash
pnpm install
pnpm dev          # run from source, e.g. pnpm dev --dry-run
pnpm test         # unit and real-git integration tests
pnpm typecheck && pnpm build
```

## License

MIT
