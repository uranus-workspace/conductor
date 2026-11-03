#!/bin/sh
# The OpenRouter API key, kept encrypted in the system's secret store:
#   macOS   the Keychain (security)
#   Linux   the Secret Service: GNOME Keyring, KWallet or KeePassXC (secret-tool, from libsecret)
#
#   openrouter-key.sh set       asks for the key (hidden input) and saves it
#   openrouter-key.sh get       prints the key (for the Conductor to hand to workers by environment)
#   openrouter-key.sh status    prints "set" or "unset"
#   openrouter-key.sh delete    removes it
#   openrouter-key.sh where     names the store, e.g. "the macOS Keychain"
#
# The key never appears on a command line: it reaches the store through stdin. `set` asks in a dialog
# (osascript on macOS, zenity or kdialog on a Linux desktop), else on the terminal with echo off.
# CONDUCTOR_KEY_FROM_STDIN=1 reads the key from stdin instead (scripts, tests).
# CONDUCTOR_KEYCHAIN_SERVICE overrides the item's service name; CONDUCTOR_KEY_STORE picks
# `keychain` or `secret-service` instead of going by the OS (tests).

set -u
SERVICE=${CONDUCTOR_KEYCHAIN_SERVICE:-conductor.openrouter}
ACCOUNT=${USER:-conductor}
LABEL="Conductor: OpenRouter API key"

STORE=${CONDUCTOR_KEY_STORE:-}
if [ -z "$STORE" ]; then
  case "$(uname -s)" in
    Darwin) STORE=keychain ;;
    *) STORE=secret-service ;;
  esac
fi

case "$STORE" in
  keychain)
    WHERE="the macOS Keychain"
    command -v security >/dev/null 2>&1 || { echo "the macOS Keychain (security) is not available here; set OPENROUTER_API_KEY instead" >&2; exit 4; }
    ;;
  secret-service)
    WHERE="the system keyring (Secret Service)"
    command -v secret-tool >/dev/null 2>&1 || {
      echo "no secret store here: install secret-tool (apt install libsecret-tools, or dnf install libsecret) with GNOME Keyring or KWallet running, or set OPENROUTER_API_KEY instead" >&2
      exit 4
    }
    ;;
  *)
    echo "unknown CONDUCTOR_KEY_STORE: $STORE (keychain or secret-service)" >&2
    exit 2
    ;;
esac

# Prints what the person typed, without echoing it anywhere.
ask() {
  if [ -n "${CONDUCTOR_KEY_FROM_STDIN:-}" ]; then
    IFS= read -r typed || true
    printf '%s' "$typed"
    return 0
  fi
  if [ "$STORE" = keychain ] && command -v osascript >/dev/null 2>&1; then
    osascript \
      -e 'set k to text returned of (display dialog "Paste your OpenRouter API key (sk-or-…). Conductor stores it encrypted in your macOS Keychain." default answer "" with hidden answer with title "Conductor" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel")' \
      -e 'return k' 2>/dev/null
    return
  fi
  prompt="Paste your OpenRouter API key (sk-or-…). Conductor stores it encrypted in $WHERE."
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    if command -v zenity >/dev/null 2>&1; then
      zenity --password --title="Conductor: $prompt" 2>/dev/null
      return
    fi
    if command -v kdialog >/dev/null 2>&1; then
      kdialog --title Conductor --password "$prompt" 2>/dev/null
      return
    fi
  fi
  # In a subshell: dash exits the whole shell when a redirection on a builtin fails (no terminal).
  if (: </dev/tty) 2>/dev/null; then
    printf '%s\nKey: ' "$prompt" >/dev/tty
    saved=$(stty -g </dev/tty)
    stty -echo </dev/tty
    IFS= read -r typed </dev/tty || true
    stty "$saved" </dev/tty
    printf '\n' >/dev/tty
    printf '%s' "$typed"
    return 0
  fi
  echo "cannot ask for the key here (no dialog, no terminal): run \"sh $0 set\" in a terminal, or set OPENROUTER_API_KEY" >&2
  return 5
}

case "${1:-}" in
  set)
    key=$(ask)
    asked=$?
    [ "$asked" -eq 0 ] || { [ "$asked" -eq 5 ] || echo "cancelled" >&2; exit "$asked"; }
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    case "$key" in
      sk-or-*) ;;
      *) echo "that is not an OpenRouter key (it starts with sk-or-)" >&2; exit 2 ;;
    esac
    printf '%s' "$key" | grep -Eq '^[A-Za-z0-9_-]+$' || { echo "the key has unexpected characters" >&2; exit 2; }
    if [ "$STORE" = keychain ]; then
      printf 'add-generic-password -U -a "%s" -s "%s" -l "%s" -w "%s"\n' "$ACCOUNT" "$SERVICE" "$LABEL" "$key" \
        | security -i >/dev/null 2>&1 || { echo "the Keychain refused the key" >&2; exit 3; }
    else
      printf '%s' "$key" | secret-tool store --label="$LABEL" service "$SERVICE" account "$ACCOUNT" >/dev/null 2>&1 \
        || { echo "the keyring refused the key: is GNOME Keyring or KWallet running and unlocked?" >&2; exit 3; }
    fi
    echo "saved"
    ;;
  get)
    if [ "$STORE" = keychain ]; then
      security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null
    else
      secret-tool lookup service "$SERVICE" account "$ACCOUNT" 2>/dev/null
    fi
    ;;
  status)
    if [ "$STORE" = keychain ]; then
      security find-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 && echo "set" || echo "unset"
    else
      secret-tool lookup service "$SERVICE" account "$ACCOUNT" >/dev/null 2>&1 && echo "set" || echo "unset"
    fi
    ;;
  delete)
    if [ "$STORE" = keychain ]; then
      security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 && echo "deleted" || echo "unset"
    elif secret-tool lookup service "$SERVICE" account "$ACCOUNT" >/dev/null 2>&1; then
      secret-tool clear service "$SERVICE" account "$ACCOUNT" >/dev/null 2>&1 && echo "deleted" || { echo "the keyring refused to delete the key" >&2; exit 3; }
    else
      echo "unset"
    fi
    ;;
  where)
    echo "$WHERE"
    ;;
  *)
    echo "usage: openrouter-key.sh set|get|status|delete|where" >&2
    exit 2
    ;;
esac
