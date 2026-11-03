#!/bin/sh
# The OpenRouter API key, kept encrypted in the macOS Keychain.
#
#   openrouter-key.sh set       asks for the key in a native dialog (hidden input) and saves it
#   openrouter-key.sh get       prints the key (for the Conductor to hand to workers by environment)
#   openrouter-key.sh status    prints "set" or "unset"
#   openrouter-key.sh delete    removes it
#
# The key never appears on a command line: it reaches `security` through stdin.
# CONDUCTOR_KEYCHAIN_SERVICE overrides the item's service name (tests).

set -u
SERVICE=${CONDUCTOR_KEYCHAIN_SERVICE:-conductor.openrouter}
ACCOUNT=${USER:-conductor}

command -v security >/dev/null 2>&1 || { echo "the macOS Keychain (security) is not available here" >&2; exit 4; }

case "${1:-}" in
  set)
    if [ -n "${CONDUCTOR_KEY_FROM_STDIN:-}" ]; then
      IFS= read -r key || true
    else
      key=$(osascript \
        -e 'set k to text returned of (display dialog "Paste your OpenRouter API key (sk-or-…). Conductor stores it encrypted in your macOS Keychain." default answer "" with hidden answer with title "Conductor" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel")' \
        -e 'return k' 2>/dev/null) || { echo "cancelled" >&2; exit 1; }
    fi
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    case "$key" in
      sk-or-*) ;;
      *) echo "that is not an OpenRouter key (it starts with sk-or-)" >&2; exit 2 ;;
    esac
    printf '%s' "$key" | grep -Eq '^[A-Za-z0-9_-]+$' || { echo "the key has unexpected characters" >&2; exit 2; }
    printf 'add-generic-password -U -a "%s" -s "%s" -l "Conductor: OpenRouter API key" -w "%s"\n' "$ACCOUNT" "$SERVICE" "$key" \
      | security -i >/dev/null 2>&1 || { echo "the Keychain refused the key" >&2; exit 3; }
    echo "saved"
    ;;
  get)
    security find-generic-password -a "$ACCOUNT" -s "$SERVICE" -w 2>/dev/null
    ;;
  status)
    if security find-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1; then echo "set"; else echo "unset"; fi
    ;;
  delete)
    security delete-generic-password -a "$ACCOUNT" -s "$SERVICE" >/dev/null 2>&1 && echo "deleted" || echo "unset"
    ;;
  *)
    echo "usage: openrouter-key.sh set|get|status|delete" >&2
    exit 2
    ;;
esac
