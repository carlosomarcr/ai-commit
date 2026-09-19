# Changelog

## Unreleased

- `--hunks`: unrelated changes inside a single file can go into separate commits (only when applying all hunks reproduces the staged file exactly).
- Edit the full commit message (title and body) in your own editor from the review screen.
- Standalone binaries (Node SEA) via `pnpm build:binary`, one-line installers (`install.sh`, `install.ps1`), CI on Linux/macOS/Windows and a tag-triggered release workflow.
- README, MIT license.

- Secret protection: diffs are scanned for API keys, tokens, private keys and hard-coded passwords. Secrets are redacted and files like .env or *.pem are withheld from the AI; flagged files can be left out of the commit (`--allow-secrets` to override).
- `.aicommitignore`: files listed there are committed but their content is never sent to the AI.
- Provider calls have timeouts and clear network errors (refused, DNS, timeout) instead of "fetch failed".
- Refuses to run during a merge/rebase/cherry-pick; Ctrl+C restores your staging (or finishes the current commit and stops).
- Very large change sets (250+ files) are grouped by folder/tests/lockfiles; monorepo commits are scoped by package.

- New providers: Anthropic (Claude) and Google Gemini.
- API keys now live in the system keyring (Windows Credential Manager, macOS Keychain, libsecret); older plain-text keys are migrated automatically. Falls back to the config file only when no keyring exists.
- New `aicommit doctor` (with `--deep` for a real test generation) and `aicommit config` (menu, plus `get`/`set`/`path`/`reset`).
- Guided 4-step `aicommit init` that tests the connection, retries a rejected key, reuses saved keys, and can add a `git ai` shortcut.

- Smart grouping: changes are split into several logical commits (tests with code, lockfiles with manifests, docs/CI apart), with an interactive review to edit, move files, split, merge, skip or regenerate.
- New `--single` flag; `--dry-run` previews the whole plan.
- Commits are built with git index plumbing, so partially staged files, renames and unusual paths are handled and your staging is restored on cancel or failure.
- On generation errors you can now switch model or provider and retry.

## 0.1.0

- Initial release: AI commit messages, confirmation flow, optional push.
- Providers: Ollama (local, remote and Cloud with API key), DeepSeek, OpenAI, Groq, OpenRouter, custom.
- Project rules from AGENTS.md / CLAUDE.md / commitlint / .aicommit.json and commit history.
- `aicommit update` and a daily, non-blocking update notice.
