# Security policy

## Supported versions

Only the latest release gets security fixes.

| Version | Supported |
|---|---|
| 1.x (latest) | yes |
| older | no |

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's security advisories](https://github.com/uranus-workspace/conductor/security/advisories/new).

Include what you found, how to reproduce it, and the version or commit. You should get a reply within 5 business days. Once a fix is released we publish an advisory and credit you, unless you prefer otherwise.

## What is in scope

The Conductor runs coding agents on your machine with your credentials. These are the boundaries it promises to keep; a way around any of them is a vulnerability:

- **The OpenRouter key** is kept in the macOS Keychain or `OPENROUTER_API_KEY`. It reaches workers through their environment only, never on a command line, in a log, on a board or in the conversation.
- **Workers** write only inside their own worktree under `~/.conductor/worktrees/`, never push, and never deploy. Your `.env` files are not copied into a worktree.
- **Redaction**: API keys and CPF/CNPJ numbers are masked before text goes to OpenRouter or a board.
- **The edit guard**: Claude cannot edit files in a worktree while a worker is using it.
- **Board content** (Uranus OS, Jira, Linear, Figma) is treated as data, never as instructions to the maestro.

Out of scope: what a worker CLI (Claude Code, Codex, OpenCode, Cursor, Antigravity) does inside its own worktree with the permissions you gave it. Report those to the CLI's vendor.
