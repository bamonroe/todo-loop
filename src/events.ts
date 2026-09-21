/**
 * Reading a worker session while it runs.
 *
 * The driver used to launch `pi -p` and keep whatever text it printed. That is
 * almost nothing: run 13's entire log was 152 lines for 31 iterations, nearly
 * all of it the driver's own. So when ten of those sessions were killed for
 * overrunning their budget — the single largest cost of the run — the only
 * thing on record was that they had. Not what the worker was doing when the
 * clock ran out, not whether it had edited a file, not how far its context had
 * grown.
 *
 * `pi --mode json` emits every session event as one JSON line. This assembles
 * them into the two things the driver needs: what the worker *said*, for the
 * BLOCKED marker, and what the session *cost*, for the log, the rejection
 * reason and the overflow note. Everything else is dropped as it arrives, so a
 * thirty-minute session holds no more memory than a thirty-second one.
 */

/** What one worker session did, as far as its event stream admitted. */
export interface RunTelemetry {
	/** False when nothing parsed as an event: plain-text output, or a worker that died first. */
	sawEvents: boolean;
	turns: number;
	tools: number;
	toolErrors: number;
	/** Calls per tool name, in the order each was first used. */
	byTool: Record<string, number>;
	compactions: number;
	/** What the last assistant message had to re-read: how large the context got. */
	contextTokens: number;
	/** Tokens generated across every assistant message. */
	outputTokens: number;
	/** A tool that started and never ended — what the worker was inside when it was stopped. */
	inFlight?: { name: string; elapsedMs: number };
}

/**
 * Keep the tail, not the head. `findBlockMarker` takes the *last* declaration,
 * and a worker's closing summary is what the driver reads; a long session's
 * early chatter is worth nothing to either.
 */
const DEFAULT_MAX_TEXT_BYTES = 64 * 1024;

/** Args worth naming in a one-line echo, most specific first. */
const SUBJECT_KEYS = ["command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url", "id", "title"];

/** One line of log for a tool call: the name, and just enough of its argument to recognise it. */
function precis(args: unknown, limit = 120): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const key = SUBJECT_KEYS.find((candidate) => typeof record[candidate] === "string" && record[candidate]);
	const text = key ? String(record[key]) : JSON.stringify(args);
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function tokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function emptyTelemetry(): RunTelemetry {
	return { sawEvents: false, turns: 0, tools: 0, toolErrors: 0, byTool: {}, compactions: 0, contextTokens: 0, outputTokens: 0 };
}

/**
 * One line summarising a session, for the log and for the reason a rejected
 * task carries into its retry prompt.
 *
 * Empty when there is nothing to report, so callers can append it
 * conditionally rather than printing "0 tool calls, 0 turns" after a worker
 * that never started.
 */
export function describeTelemetry(t: RunTelemetry): string {
	if (!t.sawEvents) return "";
	const parts: string[] = [];
	const names = Object.entries(t.byTool);
	if (t.tools) {
		const breakdown = names.length ? ` (${names.map(([name, n]) => `${name}×${n}`).join(", ")})` : "";
		parts.push(`${t.tools} tool call${t.tools === 1 ? "" : "s"}${breakdown}`);
	} else {
		// A session that called no tools cannot have changed anything, and that is
		// the most useful single fact about a worker that ran out of clock.
		parts.push("no tool calls");
	}
	if (t.toolErrors) parts.push(`${t.toolErrors} failed`);
	if (t.turns) parts.push(`${t.turns} turn${t.turns === 1 ? "" : "s"}`);
	if (t.contextTokens || t.outputTokens) parts.push(`${tokens(t.contextTokens)} context / ${tokens(t.outputTokens)} out`);
	if (t.compactions) parts.push(`${t.compactions} compaction${t.compactions === 1 ? "" : "s"}`);
	if (t.inFlight) parts.push(`still inside ${t.inFlight.name} after ${Math.round(t.inFlight.elapsedMs / 1000)}s`);
	return parts.join(", ");
}

interface MonitorOptions {
	/** A rendered, human-readable line. The driver writes these to its own stdout. */
	onLine?: (line: string) => void;
	now?: () => number;
	maxTextBytes?: number;
}

/**
 * Feed it pi's stdout; ask it afterwards what happened.
 *
 * Lines that are not pi events are echoed verbatim and kept as text. That is
 * not a fallback for tidiness: it is what makes the driver work against a
 * `pi` that is not in JSON mode at all — an older build, a stub on PATH in the
 * tests — instead of silently reading every session as empty.
 */
export class SessionMonitor {
	private readonly onLine: (line: string) => void;
	private readonly now: () => number;
	private readonly maxTextBytes: number;
	private buffer = "";
	private said = "";
	private readonly running = new Map<string, { name: string; at: number }>();
	private state = emptyTelemetry();

	constructor(options: MonitorOptions = {}) {
		this.onLine = options.onLine ?? ((): void => {});
		this.now = options.now ?? Date.now;
		this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
	}

	feed(chunk: string): void {
		this.buffer += chunk;
		let cut = this.buffer.indexOf("\n");
		while (cut >= 0) {
			this.line(this.buffer.slice(0, cut));
			this.buffer = this.buffer.slice(cut + 1);
			cut = this.buffer.indexOf("\n");
		}
	}

	/** Flush a last line that arrived without its newline, as a killed worker's will. */
	end(): void {
		if (!this.buffer) return;
		const rest = this.buffer;
		this.buffer = "";
		this.line(rest);
	}

	/** What the worker said, tail-trimmed. */
	get text(): string {
		return this.said;
	}

	/**
	 * Read whenever, including mid-session from the timeout handler — which is
	 * the point. `inFlight` is resolved against the clock at this moment, so the
	 * elapsed time is how long the stuck tool has actually been stuck.
	 */
	get telemetry(): RunTelemetry {
		const oldest = [...this.running.values()].sort((a, b) => a.at - b.at)[0];
		return {
			...this.state,
			byTool: { ...this.state.byTool },
			inFlight: oldest ? { name: oldest.name, elapsedMs: this.now() - oldest.at } : undefined,
		};
	}

	private line(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		// message_update is one event per token: the overwhelming bulk of the
		// stream, and nothing here reads it — usage is taken from the message that
		// closes, which is authoritative. Skipping the parse keeps the cost of a
		// long session flat. The switch below drops it too, in case pi ever
		// reorders the keys and this test stops matching.
		if (trimmed.startsWith('{"type":"message_update"')) {
			this.state.sawEvents = true;
			return;
		}
		if (!trimmed.startsWith("{")) {
			this.echo(line);
			this.remember(line);
			return;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			this.echo(line);
			this.remember(line);
			return;
		}
		this.state.sawEvents = true;
		this.handle(event);
	}

	private handle(event: Record<string, unknown>): void {
		switch (event.type) {
			case "message_update":
				return;
			case "turn_start":
				this.state.turns += 1;
				return;
			case "tool_execution_start": {
				const name = String(event.toolName ?? "tool");
				this.state.tools += 1;
				this.state.byTool[name] = (this.state.byTool[name] ?? 0) + 1;
				this.running.set(String(event.toolCallId ?? `${name}:${this.state.tools}`), { name, at: this.now() });
				const what = precis(event.args);
				this.echo(`  → ${name}${what ? ` ${what}` : ""}`);
				return;
			}
			case "tool_execution_end": {
				const name = String(event.toolName ?? "tool");
				this.running.delete(String(event.toolCallId ?? ""));
				if (event.isError) {
					this.state.toolErrors += 1;
					this.echo(`  ✗ ${name} failed`);
				}
				return;
			}
			case "compaction_start":
				this.state.compactions += 1;
				this.echo("  … compacting the session");
				return;
			case "message_end":
				this.assistant(event.message);
				return;
			default:
				return;
		}
	}

	/**
	 * The authoritative end of one assistant message: its text is what text mode
	 * would have printed, and its usage is the only usage worth recording.
	 *
	 * `input` is *not* summed. Each turn re-sends the whole conversation, so a
	 * sum would say the worker read a million tokens when what happened is that
	 * it read fifty thousand twenty times. The last message's input is the real
	 * quantity of interest: how large the context got before the session ended.
	 */
	private assistant(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const msg = message as { role?: string; content?: unknown; usage?: { input?: number; output?: number } };
		if (msg.role !== "assistant") return;
		if (msg.usage) {
			if (typeof msg.usage.input === "number") this.state.contextTokens = msg.usage.input;
			if (typeof msg.usage.output === "number") this.state.outputTokens += msg.usage.output;
		}
		if (!Array.isArray(msg.content)) return;
		// Thinking is deliberately not echoed or kept: pi discards it between
		// turns anyway, and it is far longer than the answer.
		const text = msg.content
			.filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && (block as { type?: string }).type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (!text) return;
		this.echo(text);
		this.remember(text);
	}

	private echo(line: string): void {
		this.onLine(line);
	}

	private remember(text: string): void {
		this.said += `${text}\n`;
		if (this.said.length > this.maxTextBytes) this.said = this.said.slice(this.said.length - this.maxTextBytes);
	}
}
