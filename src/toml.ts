/**
 * Minimal TOML subset: enough for todo.toml and todoloop.toml.
 *
 * Supported: comments, [table], [[array of tables]], basic strings,
 * literal strings, multi-line basic strings, integers, floats, booleans,
 * dates (carried verbatim, see TomlRaw) and single-line arrays of those
 * scalars.
 *
 * Not supported (and not needed here): inline tables, multi-line arrays.
 * Dotted table headers survive as a single flat key — `[meta.rules]` parses to
 * the key "meta.rules" and is written back out the same way, which is all the
 * round-trip needs.
 */

/**
 * A bare token this parser has no opinion about — a date, in practice.
 *
 * A queue in the project schema writes `created = 2026-09-12`, which is a TOML
 * date and emphatically not a string. Reading it as one and writing it back
 * would wrap it in quotes and silently change its type, so the token is carried
 * through verbatim instead. The parser does not have to *understand* dates in
 * order not to corrupt them.
 */
export class TomlRaw {
	readonly token: string;

	constructor(token: string) {
		this.token = token;
	}

	toString(): string {
		return this.token;
	}
}

export function isRaw(value: unknown): value is TomlRaw {
	return value instanceof TomlRaw;
}

/** Today as a bare TOML date, the form `created` and `completed` are written in. */
export function todayRaw(now = new Date()): TomlRaw {
	const pad = (n: number): string => String(n).padStart(2, "0");
	return new TomlRaw(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
}

export type TomlScalar = string | number | boolean | TomlRaw;
export type TomlValue = TomlScalar | TomlScalar[];
export type TomlTable = { [key: string]: TomlValue | TomlTable | TomlTable[] };

class Cursor {
	text: string;
	pos: number;

	constructor(text: string, pos = 0) {
		this.text = text;
		this.pos = pos;
	}

	get line(): number {
		let n = 1;
		for (let i = 0; i < this.pos && i < this.text.length; i++) if (this.text[i] === "\n") n++;
		return n;
	}
}

function fail(cur: Cursor, msg: string): never {
	throw new Error(`TOML parse error on line ${cur.line}: ${msg}`);
}

function parseBasicString(cur: Cursor): string {
	if (cur.text.startsWith('"""', cur.pos)) {
		cur.pos += 3;
		if (cur.text[cur.pos] === "\n") cur.pos += 1;
		const end = cur.text.indexOf('"""', cur.pos);
		if (end < 0) fail(cur, "unterminated multi-line string");
		const raw = cur.text.slice(cur.pos, end);
		cur.pos = end + 3;
		return unescape(raw);
	}
	cur.pos += 1; // opening quote
	let out = "";
	while (cur.pos < cur.text.length) {
		const ch = cur.text[cur.pos];
		if (ch === "\\") {
			out += cur.text.slice(cur.pos, cur.pos + 2);
			cur.pos += 2;
			continue;
		}
		if (ch === '"') {
			cur.pos += 1;
			return unescape(out);
		}
		if (ch === "\n") fail(cur, "unterminated string");
		out += ch;
		cur.pos += 1;
	}
	return fail(cur, "unterminated string");
}

function unescape(raw: string): string {
	return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
		switch (esc[0]) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case '"':
				return '"';
			case "\\":
				return "\\";
			case "u":
				return String.fromCharCode(parseInt(esc.slice(1), 16));
			default:
				return esc;
		}
	});
}

function parseLiteralString(cur: Cursor): string {
	cur.pos += 1;
	const end = cur.text.indexOf("'", cur.pos);
	if (end < 0) fail(cur, "unterminated literal string");
	const out = cur.text.slice(cur.pos, end);
	cur.pos = end + 1;
	return out;
}

function skipWhitespace(cur: Cursor, includeNewlines: boolean): void {
	while (cur.pos < cur.text.length) {
		const ch = cur.text[cur.pos];
		if (ch === " " || ch === "\t" || ch === "\r" || (includeNewlines && ch === "\n")) {
			cur.pos += 1;
		} else if (ch === "#") {
			while (cur.pos < cur.text.length && cur.text[cur.pos] !== "\n") cur.pos += 1;
		} else {
			return;
		}
	}
}

function parseScalar(cur: Cursor): TomlScalar {
	const ch = cur.text[cur.pos];
	if (ch === '"') return parseBasicString(cur);
	if (ch === "'") return parseLiteralString(cur);

	let end = cur.pos;
	while (end < cur.text.length && !"\n,]#".includes(cur.text[end])) end += 1;
	const raw = cur.text.slice(cur.pos, end).trim();
	cur.pos = end;

	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^[+-]?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(raw)) return Number.parseFloat(raw);
	if (raw === "") fail(cur, "empty value");
	return new TomlRaw(raw); // a date, or anything else this subset does not model
}

function parseValue(cur: Cursor): TomlValue {
	if (cur.text[cur.pos] === "[") {
		cur.pos += 1;
		const items: TomlScalar[] = [];
		for (;;) {
			skipWhitespace(cur, true);
			if (cur.text[cur.pos] === "]") {
				cur.pos += 1;
				return items;
			}
			items.push(parseScalar(cur));
			skipWhitespace(cur, true);
			if (cur.text[cur.pos] === ",") cur.pos += 1;
			else if (cur.text[cur.pos] === "]") {
				cur.pos += 1;
				return items;
			} else if (cur.pos >= cur.text.length) fail(cur, "unterminated array");
		}
	}
	return parseScalar(cur);
}

function parseKey(cur: Cursor): string {
	const ch = cur.text[cur.pos];
	if (ch === '"') return parseBasicString(cur);
	if (ch === "'") return parseLiteralString(cur);
	let end = cur.pos;
	while (end < cur.text.length && /[A-Za-z0-9_\-.]/.test(cur.text[end])) end += 1;
	if (end === cur.pos) fail(cur, `unexpected character ${JSON.stringify(ch)}`);
	const key = cur.text.slice(cur.pos, end);
	cur.pos = end;
	return key;
}

export function parseToml(text: string): TomlTable {
	const root: TomlTable = {};
	const cur = new Cursor(text);
	let target: TomlTable = root;

	for (;;) {
		skipWhitespace(cur, true);
		if (cur.pos >= cur.text.length) return root;

		if (cur.text[cur.pos] === "[") {
			const isArray = cur.text[cur.pos + 1] === "[";
			cur.pos += isArray ? 2 : 1;
			skipWhitespace(cur, false);
			const name = parseKey(cur);
			skipWhitespace(cur, false);
			if (isArray) {
				if (!cur.text.startsWith("]]", cur.pos)) fail(cur, "expected ]]");
				cur.pos += 2;
				const existing = root[name];
				const arr = Array.isArray(existing) ? (existing as TomlTable[]) : [];
				if (!Array.isArray(existing)) root[name] = arr;
				target = {};
				arr.push(target);
			} else {
				if (cur.text[cur.pos] !== "]") fail(cur, "expected ]");
				cur.pos += 1;
				const existing = root[name];
				target =
					existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as TomlTable) : {};
				root[name] = target;
			}
			continue;
		}

		const key = parseKey(cur);
		skipWhitespace(cur, false);
		if (cur.text[cur.pos] !== "=") fail(cur, `expected '=' after key ${key}`);
		cur.pos += 1;
		skipWhitespace(cur, false);
		target[key] = parseValue(cur);
	}
}

function escapeString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r");
}

/**
 * Body of a multi-line basic string.
 *
 * Newlines stay literal — that is the point of the form — so only backslashes
 * and a run of three quotes need escaping. Reusing the single-line escaper here
 * would be wrong twice over: it escapes quotes that do not need it, and it does
 * not break up a `"""` that would otherwise end the string early.
 */
function escapeMultiline(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
}

function formatScalar(value: TomlScalar): string {
	if (isRaw(value)) return value.token;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
	if (value.includes("\n")) return `"""\n${escapeMultiline(value)}"""`;
	return `"${escapeString(value)}"`;
}

function formatValue(value: TomlValue): string {
	if (Array.isArray(value)) return `[${value.map(formatScalar).join(", ")}]`;
	return formatScalar(value);
}

/** A TomlRaw is an object too, so it has to be ruled out before anything is treated as a table. */
export function isTable(value: unknown): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !isRaw(value);
}

function formatKeyValues(table: TomlTable): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(table)) {
		if (value === undefined || isTable(value)) continue;
		if (Array.isArray(value) && value.some(isTable)) continue;
		lines.push(`${key} = ${formatValue(value as TomlValue)}`);
	}
	return lines;
}

/**
 * The comment block at the top of a file, verbatim and without its trailing
 * blank line.
 *
 * Comments are not part of the parsed document, so a file that explains itself
 * at the top — as both task-file schemas do — would lose that explanation on
 * the first write. Lifting the block out lets the writer put it back unchanged.
 */
export function leadingComments(text: string): string {
	const kept: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) kept.push(line);
		else if (trimmed === "" && kept.length === 0) continue;
		else break;
	}
	return kept.join("\n");
}

export function stringifyToml(table: TomlTable): string {
	const out: string[] = [...formatKeyValues(table)];

	for (const [key, value] of Object.entries(table)) {
		if (isTable(value)) {
			if (out.length) out.push("");
			out.push(`[${key}]`, ...formatKeyValues(value));
		} else if (Array.isArray(value) && value.every(isTable) && value.length) {
			for (const item of value as TomlTable[]) {
				if (out.length) out.push("");
				out.push(`[[${key}]]`, ...formatKeyValues(item));
			}
		}
	}

	return `${out.join("\n")}\n`;
}
