import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type ApiRequestLogEntry,
	createRequestLoggingFetch,
	enableApiRequestLogging,
} from "../src/core/api-request-logging.ts";

function fakeBase(status = 200): typeof globalThis.fetch {
	return (async () => new Response("ok", { status })) as typeof globalThis.fetch;
}

function capturingLog(entries: ApiRequestLogEntry[]): (entry: ApiRequestLogEntry) => void {
	return (entry) => entries.push(entry);
}

describe("createRequestLoggingFetch", () => {
	test("logs method, url, headers, JSON body, and response status", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const fetch = createRequestLoggingFetch(fakeBase(201), capturingLog(entries));

		const response = await fetch("https://api.provider.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": "sk-secret" },
			body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "hi" }] }),
		});

		expect(response.status).toBe(201);
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		expect(entry.method).toBe("POST");
		expect(entry.url).toBe("https://api.provider.com/v1/messages");
		expect(entry.responseStatus).toBe(201);
		expect(entry.bodyEncoding).toBe("json");
		expect(entry.body).toEqual({ model: "test", messages: [{ role: "user", content: "hi" }] });
		expect(entry.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("redacts credential-bearing headers but keeps benign ones", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const fetch = createRequestLoggingFetch(fakeBase(), capturingLog(entries));

		await fetch("https://api.provider.com/v1", {
			method: "POST",
			headers: {
				Authorization: "Bearer tok",
				"X-Api-Key": "k",
				"X-Auth-Token": "t",
				Cookie: "c",
				"content-type": "application/json",
				"x-session-id": "sid",
			},
			body: "{}",
		});

		const headers = entries[0].headers;
		expect(headers.authorization).toBe("<redacted>");
		expect(headers["x-api-key"]).toBe("<redacted>");
		expect(headers["x-auth-token"]).toBe("<redacted>");
		expect(headers.cookie).toBe("<redacted>");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["x-session-id"]).toBe("sid");
	});

	test("keeps non-JSON text bodies as text", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const fetch = createRequestLoggingFetch(fakeBase(), capturingLog(entries));

		await fetch("https://provider.com/upload", { method: "POST", body: "plain payload" });

		expect(entries[0].bodyEncoding).toBe("text");
		expect(entries[0].body).toBe("plain payload");
	});

	test("reads the body of Request inputs without consuming them", async () => {
		const entries: ApiRequestLogEntry[] = [];
		// Base inspects the passed Request body to prove the original is still readable.
		let baseSawBody = "";
		const base = (async (input: string | URL | Request) => {
			baseSawBody = await (input as Request).text();
			return new Response("ok");
		}) as typeof globalThis.fetch;
		const fetch = createRequestLoggingFetch(base, capturingLog(entries));

		const request = new Request("https://provider.com/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "sk-secret" },
			body: JSON.stringify({ hello: "world" }),
		});
		await fetch(request);

		expect(baseSawBody).toBe(JSON.stringify({ hello: "world" }));
		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0].bodyEncoding).toBe("json");
		expect(entries[0].body).toEqual({ hello: "world" });
		expect(entries[0].headers["x-api-key"]).toBe("<redacted>");
	});

	test("prefers init.headers over Request headers when both are present", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const fetch = createRequestLoggingFetch(fakeBase(), capturingLog(entries));

		const request = new Request("https://provider.com/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "original" },
			body: "{}",
		});
		// Per the fetch spec, init.headers replaces the Request's own headers entirely.
		await fetch(request, { headers: { Authorization: "Bearer tok" } });

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0].headers).toEqual({ authorization: "<redacted>" });
	});

	test("dispatches the request before reading a Request body clone", async () => {
		const entries: ApiRequestLogEntry[] = [];
		// Base records dispatch order; an open-ended body must not block base from being called.
		const order: string[] = [];
		const base = (async (input: string | URL | Request) => {
			order.push("dispatch");
			void (input as Request).body;
			return new Response("ok");
		}) as typeof globalThis.fetch;
		const fetch = createRequestLoggingFetch(base, (entry) => {
			order.push("log");
			entries.push(entry);
		});

		await fetch(
			new Request("https://provider.com/v1/messages", {
				method: "POST",
				body: JSON.stringify({ hello: "world" }),
			}),
		);

		// Logging is fire-and-forget after the response resolves; wait for the entry to land.
		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(order[0]).toBe("dispatch");
		expect(entries[0].body).toEqual({ hello: "world" });
	});

	test("marks stream bodies as opaque instead of consuming them", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const fetch = createRequestLoggingFetch(fakeBase(), capturingLog(entries));

		await fetch("https://provider.com/stream", {
			method: "POST",
			body: new ReadableStream(),
		});

		expect(entries[0].bodyEncoding).toBe("opaque");
		expect(entries[0].body).toBe("opaque: ReadableStream");
	});

	test("logs fetch failures with the error message and rethrows", async () => {
		const entries: ApiRequestLogEntry[] = [];
		const base = (async () => {
			throw new Error("connection refused");
		}) as typeof globalThis.fetch;
		const fetch = createRequestLoggingFetch(base, capturingLog(entries));

		await expect(fetch("https://down.provider.com", { method: "GET" })).rejects.toThrow("connection refused");

		await vi.waitFor(() => expect(entries).toHaveLength(1));
		expect(entries[0].error).toBe("connection refused");
		expect(entries[0].responseStatus).toBeUndefined();
	});
});

describe("enableApiRequestLogging", () => {
	let originalFetch: typeof globalThis.fetch;
	let tempDir: string;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		tempDir = mkdtempSync(join(tmpdir(), "pi-api-log-"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("appends JSONL entries to the log file through global fetch", async () => {
		const logFile = join(tempDir, "requests.jsonl");
		// Stub fetch first so enable() wraps the stub and no real request leaves the machine.
		globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof globalThis.fetch;
		enableApiRequestLogging(logFile);

		await globalThis.fetch("https://provider.example.com/v1/chat", {
			method: "POST",
			headers: { Authorization: "Bearer tok" },
			body: JSON.stringify({ model: "m" }),
		});

		// Logging is fire-and-forget; wait until the JSONL line has been appended.
		await vi.waitFor(() => expect(existsSync(logFile)).toBe(true));
		const lines = readFileSync(logFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as ApiRequestLogEntry;
		expect(entry.url).toBe("https://provider.example.com/v1/chat");
		expect(entry.headers.authorization).toBe("<redacted>");
		expect(entry.body).toEqual({ model: "m" });
	});

	test("a second enable call does not wrap fetch again", async () => {
		// Order-independent against the module-level install flag: whichever enable call
		// (if any) actually installs, a further call must leave globalThis.fetch identical.
		globalThis.fetch = (async () => new Response("ok")) as typeof globalThis.fetch;
		enableApiRequestLogging(join(tempDir, "first.jsonl"));
		const wrappedOnce = globalThis.fetch;

		enableApiRequestLogging(join(tempDir, "second.jsonl"));

		expect(globalThis.fetch).toBe(wrappedOnce);
		const response = await globalThis.fetch("https://provider.example.com/second");
		expect(response.status).toBe(200);
	});
});
