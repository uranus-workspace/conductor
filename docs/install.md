# Install, update and uninstall

## Install

In Claude Code:

```
/plugin marketplace add uranus-workspace/conductor
/plugin install conductor@uranus
```

Or from a shell:

```bash
claude plugin marketplace add uranus-workspace/conductor
claude plugin install conductor@uranus
```

You also need `git` and at least one worker CLI signed in: `claude`, `codex` (`codex login`), `opencode`, `cursor-agent` (`cursor-agent login`) or `agy`. Then store your OpenRouter key with `/conduct key`.

### The OpenRouter key

`/conduct key` asks for the key with the input hidden and stores it encrypted in your system's secret store. It never enters the conversation or a command line.

| System | Where the key goes | How it asks |
|---|---|---|
| macOS | the Keychain (`security`) | a native dialog |
| Linux desktop | the Secret Service: GNOME Keyring, KWallet or KeePassXC (`secret-tool`) | a `zenity` or `kdialog` dialog |
| Linux without a desktop | the same, if a keyring is running | the terminal (run the script yourself, below) |

On Linux, install `secret-tool` if it is missing:

```bash
sudo apt install libsecret-tools      # Debian, Ubuntu
sudo dnf install libsecret            # Fedora
```

Where there is no dialog, for example over SSH, `/conduct key` replies with the command to run in a terminal instead (`sh <plugin folder>/scripts/openrouter-key.sh set`). The script reads the key there with echo off.

On a server with no keyring at all, set `OPENROUTER_API_KEY` in the environment Claude Code starts from instead. The Conductor reads it first, on every system.

`/conduct key status` says where the key is, and `/conduct key remove` deletes it.

### For a team

Add the marketplace to the project's `.claude/settings.json` (or your own `~/.claude/settings.json`). Claude Code offers to install it, and keeps it up to date:

```json
{
  "extraKnownMarketplaces": {
    "uranus": {
      "source": { "source": "github", "repo": "uranus-workspace/conductor" },
      "autoUpdate": true
    }
  }
}
```

A marketplace declared in a project's settings applies once each person trusts the folder.

## Update

Releases are listed in [GitHub Releases](https://github.com/uranus-workspace/conductor/releases) and [CHANGELOG.md](../CHANGELOG.md).

### Automatically

Claude Code does not auto-update plugins from third-party marketplaces unless you turn it on. Either:

- in Claude Code, run `/plugin`, open **Marketplaces**, select `uranus` and choose **Enable auto-update**; or
- set `"autoUpdate": true` on the marketplace in your settings, as above.

Claude Code checks in the background, within ten minutes of your first message in a session. When it has updated the plugin it says `Plugin updated: conductor · Run /reload-plugins to apply`.

If you set `DISABLE_AUTOUPDATER=1` or `DISABLE_UPDATES=1`, plugin updates are off as well, unless you also set `FORCE_AUTOUPDATE_PLUGINS=1`.

### By hand

```bash
claude plugin update conductor@uranus
```

Or in Claude Code: `/plugin` → **Installed** → conductor → **Update now**. Then run `/reload-plugins`, or start a new session.

Runs in progress survive an update: their state is on the board and in `.conductor/`, and workers are separate processes.

## Uninstall

1. **Stop active runs.** In each project with a run, `/conduct stop`. Workers are detached processes and keep running otherwise.
2. **Remove the OpenRouter key** while the plugin is still installed: `/conduct key remove`. It deletes the `conductor.openrouter` item from your Keychain (macOS) or keyring (Linux). If the plugin is already gone:

   ```bash
   security delete-generic-password -s conductor.openrouter                    # macOS
   secret-tool clear service conductor.openrouter account "$USER"              # Linux
   ```

3. **Remove the plugin.**

   ```bash
   claude plugin uninstall conductor@uranus
   ```

   Or in Claude Code, `/plugin uninstall conductor`. This also deletes the plugin's settings (the on/off switches) and its data folder under `~/.claude/plugins/data/`.

4. **Remove the marketplace** (optional). This alone also uninstalls the plugin.

   ```bash
   claude plugin marketplace remove uranus
   ```

### What stays on disk

Claude Code does not know about these; delete them if you no longer need them.

| What | Where | How to remove |
|---|---|---|
| Worker worktrees | `~/.conductor/worktrees/` | `rm -rf ~/.conductor`, then `git worktree prune` in each project |
| Run state, logs, graphs, Jev decisions, config | `.conductor/` in each project | `rm -rf .conductor` |
| The metrics ledger (`/conduct stats`) | `~/.conductor/metrics/` | `rm -rf ~/.conductor` (with the worktrees) |
| The ignore line for `.conductor/` | `.git/info/exclude` in each project | delete the `.conductor/` line |
| Task and integration branches | `conductor/<runId>/…` in each project | see below |

The integration branch (`conductor/<runId>/integration`) may hold work you have not merged yet. Check it before deleting the branches:

```bash
git log --oneline main..conductor/<runId>/integration
git branch --list 'conductor/*' | xargs git branch -D
```
