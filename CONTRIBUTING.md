# Contributing

Thanks for helping. Bug reports, fixes, new workers and new boards are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it.
- For a new feature, a new worker or a new board, open an issue first so we can agree on the shape before you write it.
- For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Setup

You need Node.js 22.18 or newer (the tests run TypeScript directly), git, and Claude Code for the plugin checks.

```bash
git clone https://github.com/uranus-workspace/conductor.git
cd conductor
npm ci
```

To try your copy inside Claude Code, start a session with the plugin folder:

```bash
claude --plugin-dir /path/to/conductor
```

## Checks

These run in CI on every pull request. Run them before you push:

```bash
npm test               # unit and end-to-end tests (real git, simulated CLIs and MCP servers)
npm run typecheck      # the core and the tests
npm run validate       # claude plugin validate
npm run test:mod       # claude plugin test: the mod inside the Claude Code engine
```

`npm run smoke` runs a live task with the worker CLIs installed on your machine and spends real tokens. It is not part of CI.

## Code

The rules are in [CLAUDE.md](CLAUDE.md). The main ones:

- Everything in English: code, comments, messages and docs.
- Strong types. Types live in `*.types.ts` files next to the code that uses them, and are exported through `src/index.ts`.
- Input from outside (CLI output, MCP replies, config files) is parsed, never cast.
- Model calls go through OpenRouter unless a worker uses its own login.
- Only `hooks/register.tsx` touches the Claude Code API. Everything in `src/` goes through `Host`, so it runs under Node in the tests.

Add tests for what you change. A new worker gets an adapter in `src/adapters/executors/` and a simulated CLI test; a new board gets a `Board` in `src/adapters/task-source/` and a test against a simulated MCP server.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). CI checks them, and releases are made from them:

| Type | Use for | Release |
|---|---|---|
| `feat` | new behavior | minor |
| `fix` | a bug fix | patch |
| `perf` | a speedup | patch |
| `docs`, `test`, `refactor`, `build`, `ci`, `chore` | everything else | none |

A breaking change adds `!` after the type (`feat!: …`) or a `BREAKING CHANGE:` footer, and makes a major release.

Use a scope when it helps: `core`, `graph`, `executors`, `decision`, `task-source`, `design`, `mod`. For example:

```
fix(executors): pass the worktree's CLAUDE.md to the Claude reviewer
```

Keep a pull request to one change, and say in its description how you tested it. A maintainer reviews it (see [.github/CODEOWNERS](.github/CODEOWNERS)) and squash-merges it, so its title becomes the commit message and must follow the same format.

## Releases

Releases are automatic. Every push to `main` runs [semantic-release](https://github.com/semantic-release/semantic-release), which reads the commits since the last tag, picks the next version, updates `CHANGELOG.md`, the version in `package.json` and `.claude-plugin/plugin.json`, tags it and publishes a GitHub release.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
