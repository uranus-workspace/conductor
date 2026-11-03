#!/bin/sh
# Stands in for `claude -p` in the end-to-end test. Reads the prompt (argv[2]),
# creates the file named by "create file <name>", and answers like
# `--output-format json`. A prompt holding "fail-once" fails its first run.
prompt=$2
name=$(printf '%s\n' "$prompt" | sed -n 's/.*create file \([A-Za-z0-9._-]*\).*/\1/p' | head -n 1)
if printf '%s' "$prompt" | grep -q 'fail-once'; then
  marker="$FAKE_STATE_DIR/failed-$name"
  if [ ! -f "$marker" ]; then
    touch "$marker"
    echo '{"type":"result","is_error":true,"result":"simulated failure","total_cost_usd":0.01}'
    exit 1
  fi
fi
if printf '%s' "$prompt" | grep -q 'do-nothing'; then
  echo '{"type":"result","is_error":false,"result":"nothing to do","total_cost_usd":0.001}'
  exit 0
fi
if printf '%s' "$prompt" | grep -q 'create the files in scope'; then
  # Every "- path" line under "## Files in scope", up to the next heading.
  printf '%s\n' "$prompt" | awk '/^## Files in scope/{on=1; next} /^## /{on=0} on && /^- /{print substr($0, 3)}' | while IFS= read -r f; do
    mkdir -p "$(dirname "$f")"
    echo "made in scope" > "$f"
  done
  printf '{"type":"result","is_error":false,"result":"created the files in scope","total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":20}}\n'
  exit 0
fi
echo "made by $name" > "$name"
printf '{"type":"result","is_error":false,"result":"created %s","total_cost_usd":0.02,"usage":{"input_tokens":100,"output_tokens":20}}\n' "$name"
