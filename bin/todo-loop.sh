#!/usr/bin/env bash
# The shell driver, in its smallest honest form.
#
# One pi process per task, so clearing the context is process exit rather than
# session bookkeeping. `todo run` does the same thing with verification and
# checkpointing wired in; this is here because it is easy to read and easy to
# modify when something goes wrong.
set -euo pipefail

here="$(dirname "$(readlink -f "$0")")"
todo="$here/todo"
max="${TODOLOOP_MAX:-50}"

for ((i = 1; i <= max; i++)); do
	prompt="$("$todo" next)" || {
		status=$?
		[ "$status" -eq 3 ] && { echo "queue empty"; exit 0; }
		exit "$status"
	}

	id="$("$todo" next --id)"
	echo "=== [$i/$max] $id ==="
	"$todo" start >/dev/null

	# stdin from /dev/null: print mode waits for EOF before it runs the prompt.
	# --approve: print mode never asks about project trust, and without the flag
	# it silently skips the project's own .pi/settings.json. See workerArgs in
	# src/cli.ts for why that file matters on a small context window.
	# TODOLOOP_DRIVER: this script owns the loop, so the in-session extension
	# must not verify, commit or advance on top of it.
	TODOLOOP_DRIVER=shell pi -p --approve -- "$prompt" </dev/null || echo "pi exited non-zero; verifying anyway" >&2

	if "$todo" complete "$id"; then
		continue
	elif [ $? -eq 4 ]; then
		echo "rejected; the task stays at the head of the queue" >&2
	else
		echo "halted" >&2
		exit 1
	fi
done

echo "stopped after the $max-iteration cap" >&2
exit 1
