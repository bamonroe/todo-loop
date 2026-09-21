/**
 * Wall-clock stamps on the run log, and durations on what the run did.
 *
 * Run 13's post-mortem had to reconstruct every timing from git commit
 * timestamps, which only exist where a task was verified and committed — so a
 * rejected iteration, a timed-out one, or anything happening *inside* an
 * iteration left no trace at all. The one question worth asking of a slow run
 * is which part was slow, and the log could not answer it.
 *
 * Absolute time rather than elapsed: it is what correlates the log against git,
 * the emulator, and docker. Elapsed is one subtraction away, and the durations
 * that matter are reported outright.
 */

/** `14:07:31` in local time, the form every other log on the box uses. */
export function clockTime(at: number): string {
	const d = new Date(at);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A duration a human reads without counting digits: `4.2s`, `72s`, `31m12s`,
 * `1h04m`. Sub-minute keeps a decimal because the difference between a 0.3s
 * and a 4s tool call is the whole point of measuring them.
 */
export function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const seconds = ms / 1000;
	if (seconds < 10) return `${seconds.toFixed(1)}s`;
	if (seconds < 90) return `${Math.round(seconds)}s`;
	const total = Math.round(seconds);
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Joins the phases that actually ran: "worker 30m00s, verify 69s". */
export function describePhases(phases: Array<[string, number | undefined]>): string {
	return phases
		.filter((entry): entry is [string, number] => entry[1] !== undefined)
		.map(([name, ms]) => `${name} ${formatDuration(ms)}`)
		.join(", ");
}

/**
 * Prefix everything the run prints with the time it was printed.
 *
 * Patching the console rather than threading a logger through forty call sites
 * is deliberate: the lines worth stamping most are the worker's own tool calls,
 * which the session monitor emits from inside pi's event stream, and those are
 * the ones a threaded logger would be most likely to miss. Returns the undo, so
 * a run restores the console it found — the in-session extension shares this
 * process with a pi session that does its own printing.
 */
export function stampConsole(now: () => number = Date.now): () => void {
	const realLog = console.log;
	const realError = console.error;
	// A blank line is spacing, not a message; stamping it prints a column of
	// bare timestamps down the gaps between iterations.
	const wrap =
		(write: (...args: unknown[]) => void) =>
		(...args: unknown[]): void => {
			const [first] = args;
			if (args.length === 1 && typeof first === "string" && !first.trim()) {
				write(...args);
				return;
			}
			// A leading newline is the iteration separator: keep the break, and
			// stamp the text that follows rather than the emptiness before it.
			if (typeof first === "string" && first.startsWith("\n")) {
				write(`\n[${clockTime(now())}] ${first.slice(1)}`, ...args.slice(1));
				return;
			}
			write(`[${clockTime(now())}]`, ...args);
		};
	console.log = wrap(realLog.bind(console));
	console.error = wrap(realError.bind(console));
	return (): void => {
		console.log = realLog;
		console.error = realError;
	};
}
