/**
 * Opt-in API request logging via `--log-api-requests <file>`.
 *
 * Wraps global fetch and appends one JSON line per outgoing HTTP request,
 * capturing the exact request body sent to the provider (URL, method,
 * redacted headers, body) plus response status and duration. All fetch-based
 * provider SDKs ultimately call global fetch, so this sees the wire-level
 * payload after provider-specific transformation.
 *
 * Also wraps global WebSocket and appends one line per outgoing message, because
 * WebSocket transports (e.g. OpenAI Codex's default `auto` transport) send the
 * request body as a socket message and never touch fetch.
 *
 * Limitation: Amazon Bedrock uses the AWS SDK's node:http transport and is
 * not captured. Sensitive headers are redacted before writing.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

/** One JSONL record describing an outgoing HTTP request and its outcome. */
export interface ApiRequestLogEntry {
	timestamp: string;
	/** HTTP method, or "WS" for an outgoing WebSocket message. */
	method: string;
	url: string;
	/** Header names lowercased; credential-bearing values replaced with "<redacted>". */
	headers: Record<string, string>;
	/** Request body: parsed JSON value when parseable, otherwise raw text/base64. */
	body?: unknown;
	/** How `body` was captured. "opaque" means the body type could not be read without consuming it. */
	bodyEncoding?: "json" | "text" | "base64" | "opaque";
	responseStatus?: number;
	error?: string;
	/** Time until the HTTP response settled. Absent for WebSocket messages, which have no per-message response. */
	durationMs?: number;
}

/** A captured request body plus how it was encoded for the log. */
type CapturedBody = { body?: unknown; bodyEncoding?: ApiRequestLogEntry["bodyEncoding"] };

const REDACTED = "<redacted>";
const SENSITIVE_HEADER_PATTERN = /authorization|cookie|api-key|token|secret/i;

type HeadersLike =
	| Headers
	| Array<[string, string] | string[]>
	| Record<string, string | readonly string[] | undefined>;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		redacted[name] = SENSITIVE_HEADER_PATTERN.test(name) ? REDACTED : value;
	}
	return redacted;
}

function headersToObject(headers: HeadersLike | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers) return result;
	// Normalize all three HeadersInit shapes into plain entries before lowering.
	const source: Array<[string, string | readonly string[] | undefined]> =
		headers instanceof Headers
			? Array.from(headers.entries())
			: Array.isArray(headers)
				? (headers as Array<[string, string | readonly string[] | undefined]>)
				: Object.entries(headers);
	for (const [name, value] of source) {
		if (value === undefined) continue;
		// Array.isArray cannot narrow readonly arrays; cast the remaining non-string shape.
		result[name.toLowerCase()] = typeof value === "string" ? value : (value as readonly string[]).join(", ");
	}
	return result;
}

/**
 * Read an `init.body` value without consuming or mutating it.
 * Returns a description suitable for logging; opaque bodies are named by type.
 */
async function captureInitBody(raw: unknown): Promise<CapturedBody> {
	if (raw === undefined || raw === null) return {};

	if (typeof raw === "string" || raw instanceof URLSearchParams) {
		return { body: String(raw), bodyEncoding: "text" };
	}

	if (raw instanceof Blob) {
		// FormData parts may contain file streams; do not force materialization.
		if (raw.type === "application/json") {
			return { body: await raw.text(), bodyEncoding: "text" };
		}
		return { body: `opaque: Blob (${raw.type || "unknown type"})`, bodyEncoding: "opaque" };
	}

	if (raw instanceof FormData) {
		return { body: "opaque: FormData", bodyEncoding: "opaque" };
	}

	if (raw instanceof ReadableStream) {
		return { body: "opaque: ReadableStream", bodyEncoding: "opaque" };
	}

	// ArrayBuffer, TypedArray, DataView: decode as UTF-8; JSON bodies stay readable.
	if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
		const bytes =
			raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
		try {
			return { body: new TextDecoder().decode(bytes), bodyEncoding: "text" };
		} catch {
			return { body: Buffer.from(bytes).toString("base64"), bodyEncoding: "base64" };
		}
	}

	return { body: `opaque: ${typeof raw}`, bodyEncoding: "opaque" };
}

/** Promote text bodies that are valid JSON so the log line stays inspectable; other bodies pass through. */
function promoteJsonBody(captured: CapturedBody): CapturedBody {
	if (captured.bodyEncoding !== "text" || typeof captured.body !== "string") return captured;
	try {
		return { body: JSON.parse(captured.body), bodyEncoding: "json" };
	} catch {
		return captured;
	}
}

/**
 * Build a fetch function that logs every request through `log` before delegating to `base`.
 * The captured fetch resolves/rejects exactly like `base`; logging never changes behavior.
 */
export function createRequestLoggingFetch(
	base: typeof globalThis.fetch,
	log: (entry: ApiRequestLogEntry) => void,
): typeof globalThis.fetch {
	const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
		const startedAt = Date.now();
		const isRequest = input instanceof Request;
		const method = init?.method ?? (isRequest ? input.method : "GET");
		const url = isRequest ? input.url : String(input);
		// init.headers replaces a Request's own headers per the fetch spec, so prefer it when present.
		const headers = redactHeaders(headersToObject(init?.headers ?? (isRequest ? input.headers : undefined)));

		// Request bodies must be read from a clone; take it synchronously so base can consume the
		// original. The clone is only read after dispatch so an open-ended request stream can never
		// block the request itself.
		const requestClone = isRequest && init?.body === undefined ? input.clone() : undefined;
		const fromInit = init?.body !== undefined ? await captureInitBody(init.body) : {};

		const readLoggedBody = async (): Promise<CapturedBody> => {
			if (!requestClone) return fromInit;
			try {
				return { body: await requestClone.text(), bodyEncoding: "text" };
			} catch {
				return { body: "opaque: unreadable request body", bodyEncoding: "opaque" };
			}
		};

		const logAttempt = async (responseStatus: number | undefined, error: string | undefined): Promise<void> => {
			const { body, bodyEncoding } = promoteJsonBody(await readLoggedBody());
			log({
				timestamp: new Date().toISOString(),
				method,
				url,
				headers,
				body,
				bodyEncoding,
				responseStatus,
				error,
				durationMs: Date.now() - startedAt,
			});
		};

		try {
			const response = await base(input, init);
			// Log without blocking the caller: the clone read (or a still-streaming request body)
			// must never delay the response, and a debug log must not delay the agent run.
			void logAttempt(response.status, undefined).catch(() => {});
			return response;
		} catch (error: unknown) {
			void logAttempt(undefined, error instanceof Error ? error.message : String(error)).catch(() => {});
			throw error;
		}
	};
	return wrapped as typeof globalThis.fetch;
}

/**
 * Build a WebSocket constructor that logs every outgoing message through `log` before delegating to `base`.
 * Each `send()` becomes one entry with method "WS", the socket URL, the redacted handshake headers, and the
 * message payload. Handshake, incoming frames, and close are not logged. Behaves exactly like `base` otherwise.
 */
export function createRequestLoggingWebSocket(
	base: typeof globalThis.WebSocket,
	log: (entry: ApiRequestLogEntry) => void,
): typeof globalThis.WebSocket {
	return class RequestLoggingWebSocket extends base {
		readonly #logHeaders: Record<string, string>;

		constructor(url: string | URL, protocols?: string | string[] | WebSocketInit) {
			super(url, protocols);
			// Only the init-object form carries handshake headers; a protocol list has none.
			const init = typeof protocols === "object" && !Array.isArray(protocols) ? protocols : undefined;
			this.#logHeaders = redactHeaders(headersToObject(init?.headers as HeadersLike | undefined));
		}

		override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
			// Snapshot the payload before sending: non-Blob bodies are decoded synchronously, so a
			// caller reusing its buffer after send() cannot alter what gets logged.
			const captured = captureInitBody(data);
			let error: string | undefined;
			try {
				super.send(data);
			} catch (sendError: unknown) {
				error = sendError instanceof Error ? sendError.message : String(sendError);
				throw sendError;
			} finally {
				// Log without blocking or altering the send; a failed send is logged with its error and rethrown.
				void captured
					.then((body) => {
						const { body: logBody, bodyEncoding } = promoteJsonBody(body);
						log({
							timestamp: new Date().toISOString(),
							method: "WS",
							url: this.url,
							headers: this.#logHeaders,
							body: logBody,
							bodyEncoding,
							error,
						});
					})
					.catch(() => {});
			}
		}
	};
}

let loggingInstalled = false;

/**
 * Install the global fetch and WebSocket logging wrappers and append entries to `logFile` (JSONL).
 * Must be called after `configureHttpDispatcher()` has run at least once so the
 * wrapper sits on top of undici's installed fetch; later dispatcher
 * reconfigurations keep working because undici fetch resolves the global
 * dispatcher dynamically. WebSocket users must resolve `globalThis.WebSocket`
 * at connect time (as the Codex provider does) to be captured. Idempotent: only
 * the first call installs the wrappers.
 */
export function enableApiRequestLogging(logFile: string): void {
	if (loggingInstalled) return;
	loggingInstalled = true;

	const filePath = resolve(logFile);
	let writeFailed = false;
	const writeEntry = (entry: ApiRequestLogEntry): void => {
		try {
			appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
		} catch (error: unknown) {
			// A debug log must not kill the agent run; report the first failure and keep going.
			if (!writeFailed) {
				writeFailed = true;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Warning: failed to write API request log ${filePath}: ${message}`);
			}
		}
	};

	globalThis.fetch = createRequestLoggingFetch(globalThis.fetch, writeEntry);
	// Runtimes without a global WebSocket have no socket transport to capture.
	if (typeof globalThis.WebSocket === "function") {
		globalThis.WebSocket = createRequestLoggingWebSocket(globalThis.WebSocket, writeEntry);
	}
}
