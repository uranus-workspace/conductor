#!/bin/sh
# Detached job runner for the Conductor. The mod's own process calls are
# one-shot and its streamed children die with every hot reload, so workers
# run detached and leave their state in files the heartbeat reads.
#
#   job.sh start <dir> <cwd> [--unset VAR]... [--pre SHELL] -- argv...
#       Starts argv in <cwd>, stdin closed, stdout/stderr to <dir>/out.log and
#       <dir>/err.log; writes <dir>/pid now and <dir>/exit when it ends.
#       --pre runs a shell snippet first (setup such as `npm ci`); its failure
#       ends the job with its exit code. Prints the pid.
#   job.sh alive <pid>     exit 0 while the process runs
#   job.sh kill <pid>      TERM to the process and all its descendants

set -u

killtree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do killtree "$child"; done
  kill -TERM "$1" 2>/dev/null
}

case "${1:-}" in
  alive)
    kill -0 "$2" 2>/dev/null
    exit $?
    ;;
  kill)
    killtree "$2"
    exit 0
    ;;
  start)
    shift
    dir=$1
    cwd=$2
    shift 2
    pre=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --unset) unset "$2"; shift 2 ;;
        --pre) pre=$2; shift 2 ;;
        --) shift; break ;;
        *) echo "job.sh: unexpected $1" >&2; exit 2 ;;
      esac
    done
    mkdir -p "$dir" || exit 2
    rm -f "$dir/exit" "$dir/exit.tmp"
    (
      trap '' HUP
      code=0
      if ! cd "$cwd"; then
        code=127
      else
        if [ -n "$pre" ]; then
          sh -c "$pre" < /dev/null > "$dir/pre.log" 2>&1
          code=$?
        fi
        if [ "$code" -eq 0 ]; then
          "$@" < /dev/null > "$dir/out.log" 2> "$dir/err.log"
          code=$?
        fi
      fi
      echo "$code" > "$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit"
    ) < /dev/null > /dev/null 2>&1 &
    echo $! > "$dir/pid"
    echo $!
    ;;
  *)
    echo "usage: job.sh start|alive|kill ..." >&2
    exit 2
    ;;
esac
