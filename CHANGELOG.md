# Changelog

## Unreleased

- Smart grouping: changes are split into several logical commits (tests with code, lockfiles with manifests, docs/CI apart), with an interactive review to edit, move files, split, merge, skip or regenerate.
- New `--single` flag; `--dry-run` previews the whole plan.
- Commits are built with git index plumbing, so partially staged files, renames and unusual paths are handled and your staging is restored on cancel or failure.
- On generation errors you can now switch model or provider and retry.

## 0.1.0

- Initial release: AI commit messages, confirmation flow, optional push.
- Providers: Ollama (local, remote and Cloud with API key), DeepSeek, OpenAI, Groq, OpenRouter, custom.
- Project rules from AGENTS.md / CLAUDE.md / commitlint / .aicommit.json and commit history.
- `aicommit update` and a daily, non-blocking update notice.
