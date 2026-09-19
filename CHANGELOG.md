# Changelog

## 0.1.0 (2026-09-19)

First public release.

### Commits
- **Smart grouping**: changes are split into logical commits (tests with their code, lockfiles with manifests, docs / CI / dependency bumps apart), ordered so each builds on the previous. Every file is placed exactly once; anything the model forgets is placed by folder and reported.
- **Interactive review**: edit a title or the full message in your own editor, regenerate a message, move files between commits, split, merge, skip a commit, or ask for a new plan with guidance.
- `--hunks`: unrelated changes inside a single file can go into separate commits (only when applying all hunks reproduces the staged file exactly).
- `--single`, `--dry-run`, `--all`, `--yes`, `--push` / `--no-push`, `--provider`, `--model`, `--lang`, `-i/--instructions`.
- Commits are built with git index plumbing: partially staged files, renames and unusual paths are handled, the working tree is never touched, and your staging is restored on cancel, error or Ctrl+C.
- Asks before every commit and, afterwards, before pushing to the branch's upstream (sets it if missing, warns on `main`/`master`, never force-pushes).

### Project rules
- Reads commit rules from `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*`, Copilot instructions, `CONTRIBUTING.md`, `.gitmessage`, commitlint config and `.aicommit.json`, plus the style of your recent commits. Nearest file wins (monorepos). `aicommit rules` shows what is used.
- Messages are validated against allowed types, scopes and header length, with automatic retries.

### Providers
- Ollama (local, remote and Cloud with API key), DeepSeek, Anthropic (Claude), Google Gemini, OpenAI, Groq, OpenRouter and any OpenAI-compatible endpoint.
- If generation fails (plan limits, rate limit, invalid model, invalid JSON) you can switch model or provider and continue.
- Timeouts and readable network errors instead of "fetch failed".

### Setup and maintenance
- Guided 4-step `aicommit init`: tests the connection, retries a rejected key, reuses saved keys, offers a `git ai` shortcut.
- API keys are stored in the system keyring (Windows Credential Manager, macOS Keychain, libsecret) with a config-file fallback.
- `aicommit doctor` (`--deep` runs a real test generation) and `aicommit config` (menu, plus `get` / `set` / `path` / `reset`).
- `aicommit update` and a daily, non-blocking update notice (opt out with `aicommit config set updateCheck off` or `AICOMMIT_NO_UPDATE_CHECK=1`). Config files are versioned and migrated automatically.

### Security
- Diffs are scanned for API keys, tokens, private keys and hard-coded passwords. Secrets are redacted and files such as `.env` or `*.pem` are never sent to the model; flagged files can be left out of the commit (`--allow-secrets` overrides).
- `.aicommitignore`: files that are committed but whose content is never sent to the model.
- Refuses to run during a merge, rebase, cherry-pick or revert.
- Very large change sets (250+ files) are grouped by folder, tests and lockfiles; monorepo commits are scoped by package.

### Distribution
- npm package, one-line installers (`install.sh`, `install.ps1`) and standalone binaries (Node SEA) for Windows, macOS and Linux. Binaries keep the API key in the config file because the OS keyring is a native module.
- CI on Linux, macOS and Windows; tag-triggered release workflow.
