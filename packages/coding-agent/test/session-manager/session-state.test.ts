import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToJsonl } from "../../src/core/session-export.ts";
import {
	type FileEntry,
	type JsonValue,
	loadEntriesFromFile,
	SessionManager,
	type SessionStateEntry,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

/** Identify current session-state metadata without confusing it with the header. */
function isSessionStateEntry(entry: FileEntry): entry is SessionStateEntry {
	return entry.type === "session" && "sessionState" in entry;
}

describe("SessionManager session-global state", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-session-state-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("makes JSON writes immediately visible and durable before any conversation", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const input = { enabled: true, nested: [1, "two", null] };

		session.setSessionState("context", input);
		input.enabled = false;

		expect(session.getSessionState("context")).toEqual({ enabled: true, nested: [1, "two", null] });
		const read = session.getSessionState<{ enabled: boolean; nested: Array<number | string | null> }>("context");
		if (!read) throw new Error("Expected stored state");
		read.enabled = false;
		expect(session.getSessionState("context")).toEqual({ enabled: true, nested: [1, "two", null] });

		const sessionFile = session.getSessionFile();
		expect(sessionFile && existsSync(sessionFile)).toBe(true);
		const records = loadEntriesFromFile(sessionFile!);
		const stateRecord = records.find(isSessionStateEntry);
		expect(stateRecord).toEqual(
			expect.objectContaining({
				type: "session",
				sessionState: { key: "context", value: { enabled: true, nested: [1, "two", null] } },
			}),
		);
		expect(stateRecord).toEqual(expect.not.objectContaining({ id: expect.anything(), parentId: expect.anything() }));

		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(reopened.getSessionState("context")).toEqual({ enabled: true, nested: [1, "two", null] });
	});

	it("leaves no effective value or file history when the initial durable rewrite fails", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile()!;
		mkdirSync(sessionFile);

		expect(() => session.setSessionState("mode", "rejected")).toThrow();
		expect(session.getSessionState("mode")).toBeUndefined();
		expect(session.getSessionStateSnapshot()).toEqual({});

		// A later successful first write proves the failed fact was not retained for the rewrite.
		rmSync(sessionFile, { recursive: true });
		session.setSessionState("mode", "durable");
		expect(loadEntriesFromFile(sessionFile).filter(isSessionStateEntry)).toEqual([
			expect.objectContaining({ sessionState: { key: "mode", value: "durable" } }),
		]);
	});

	it("keeps the last durable value when append-based set and clear writes fail", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.setSessionState("mode", "durable");
		const sessionFile = session.getSessionFile()!;
		const durableContent = readFileSync(sessionFile, "utf8");
		rmSync(sessionFile);
		mkdirSync(sessionFile);

		expect(() => session.setSessionState("mode", "rejected")).toThrow();
		expect(() => session.setSessionState("mode", undefined)).toThrow();
		expect(session.getSessionState("mode")).toBe("durable");

		const exportPath = join(tempDir, "after-failure.jsonl");
		exportSessionToJsonl(session, exportPath);
		expect(loadEntriesFromFile(exportPath).filter(isSessionStateEntry)).toEqual([
			expect.objectContaining({ sessionState: { key: "mode", value: "durable" } }),
		]);

		// Restore the durable file and prove subsequent history omits both rejected facts.
		rmSync(sessionFile, { recursive: true });
		writeFileSync(sessionFile, durableContent);
		session.setSessionState("mode", "final");
		expect(loadEntriesFromFile(sessionFile).filter(isSessionStateEntry)).toEqual([
			expect.objectContaining({ sessionState: { key: "mode", value: "durable" } }),
			expect.objectContaining({ sessionState: { key: "mode", value: "final" } }),
		]);
	});

	it("keeps independent keys and uses physical last-write-wins order", () => {
		const session = SessionManager.inMemory();

		session.setSessionState("shared", { writer: "extension-a" });
		session.setSessionState("other", [1, 2, 3]);
		session.setSessionState("shared", { writer: "extension-b" });

		expect(session.getSessionState("shared")).toEqual({ writer: "extension-b" });
		expect(session.getSessionState("other")).toEqual([1, 2, 3]);
	});

	it("rejects non-finite numbers recursively without changing memory or disk", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.setSessionState("mode", { count: 1 });
		const sessionFile = session.getSessionFile()!;
		const durableContent = readFileSync(sessionFile, "utf8");
		const invalidValues: JsonValue[] = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			[1, Number.POSITIVE_INFINITY],
			{ nested: { count: Number.NEGATIVE_INFINITY } },
		];

		for (const value of invalidValues) {
			expect(() => session.setSessionState("mode", value)).toThrow(
				new TypeError("Session state values must contain only finite JSON numbers"),
			);
		}

		expect(session.getSessionState("mode")).toEqual({ count: 1 });
		expect(readFileSync(sessionFile, "utf8")).toBe(durableContent);
	});

	it("distinguishes JSON null from absence and persists clear tombstones", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.setSessionState("nullable", null);
		session.setSessionState("removed", "present");
		session.setSessionState("removed", undefined);

		expect(session.getSessionState("nullable")).toBeNull();
		expect(session.getSessionState("removed")).toBeUndefined();

		const reopened = SessionManager.open(session.getSessionFile()!, tempDir);
		expect(reopened.getSessionState("nullable")).toBeNull();
		expect(reopened.getSessionState("removed")).toBeUndefined();
	});

	it("never exposes state records through conversation tree, branch, context, or messages", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg("hello"));
		const leafBeforeState = session.getLeafId();

		session.setSessionState("hidden", { secret: "state" });
		const assistantId = session.appendMessage(assistantMsg("reply"));

		expect(leafBeforeState).toBe(userId);
		expect(session.getLeafId()).toBe(assistantId);
		expect(session.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(session.getBranch().map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(session.buildContextEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(session.buildSessionContext().messages).toEqual([
			expect.objectContaining({ role: "user", content: "hello" }),
			expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "reply" }] }),
		]);
		expect(session.getTree()).toHaveLength(1);
		expect(session.getTree()[0].children).toHaveLength(1);
	});

	it("does not roll global state back during branch navigation", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage(userMsg("first"));
		session.setSessionState("mode", "old");
		session.appendMessage(assistantMsg("second"));
		session.setSessionState("mode", "latest");

		session.branch(firstId);

		expect(session.getSessionState("mode")).toBe("latest");
	});

	it("clears all values when starting a genuinely new session", () => {
		const session = SessionManager.inMemory();
		session.setSessionState("mode", { enabled: true });

		session.newSession();

		expect(session.getSessionState("mode")).toBeUndefined();
		expect(session.getSessionStateSnapshot()).toEqual({});
	});

	it("copies only effective values when extracting a branch", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.setSessionState("mode", "old");
		session.setSessionState("mode", "latest");
		session.setSessionState("removed", true);
		session.setSessionState("removed", undefined);
		session.appendMessage(userMsg("question"));
		const assistantId = session.appendMessage(assistantMsg("answer"));

		const derivedFile = session.createBranchedSession(assistantId);

		expect(derivedFile).toBeDefined();
		expect(session.getSessionState("mode")).toBe("latest");
		expect(session.getSessionState("removed")).toBeUndefined();
		const stateRecords = loadEntriesFromFile(derivedFile!).filter(isSessionStateEntry);
		expect(stateRecords).toEqual([
			expect.objectContaining({ type: "session", sessionState: { key: "mode", value: "latest" } }),
		]);
	});

	it("inherits effective values when deriving an empty in-memory session", () => {
		const session = SessionManager.inMemory();
		session.setSessionState("mode", { enabled: true });
		session.appendMessage(userMsg("discarded conversation"));

		session.createBranchedSession(null);

		expect(session.getEntries()).toEqual([]);
		expect(session.getSessionState("mode")).toEqual({ enabled: true });
	});

	it("collapses state history for cross-project forks", () => {
		const source = SessionManager.create(tempDir, tempDir);
		source.setSessionState("mode", 1);
		source.setSessionState("mode", 2);
		source.appendMessage(userMsg("question"));
		source.appendMessage(assistantMsg("answer"));

		const targetDir = join(tempDir, "target");
		const forked = SessionManager.forkFrom(source.getSessionFile()!, targetDir, tempDir);
		const stateRecords = loadEntriesFromFile(forked.getSessionFile()!).filter(isSessionStateEntry);

		expect(forked.getSessionState("mode")).toBe(2);
		expect(stateRecords).toEqual([
			expect.objectContaining({ type: "session", sessionState: { key: "mode", value: 2 } }),
		]);
	});

	it("exports the active branch with one effective state record per key", () => {
		const session = SessionManager.inMemory(tempDir);
		session.setSessionState("mode", "old");
		session.setSessionState("mode", "latest");
		session.appendMessage(userMsg("question"));
		const outputPath = join(tempDir, "export.jsonl");

		exportSessionToJsonl(session, outputPath);

		const exported = loadEntriesFromFile(outputPath);
		const stateRecords = exported.filter(isSessionStateEntry);
		expect(stateRecords).toEqual([
			expect.objectContaining({ type: "session", sessionState: { key: "mode", value: "latest" } }),
		]);
		expect(exported.filter((entry) => entry.type === "message")).toHaveLength(1);
	});

	it("encodes trailing state so a pre-state version 3 reader preserves the conversation leaf", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg("question"));
		const assistantId = session.appendMessage(assistantMsg("answer"));
		session.setSessionState("mode", "latest");
		const records = loadEntriesFromFile(session.getSessionFile()!);

		// Pre-feature v3 readers skipped every `type: session` record and treated all others as tree entries.
		let oldReaderLeafId: string | null | undefined = null;
		for (const entry of records) {
			if (entry.type === "session") continue;
			oldReaderLeafId = "id" in entry ? entry.id : undefined;
		}

		expect(records.at(-1)).toEqual(
			expect.objectContaining({ type: "session", sessionState: { key: "mode", value: "latest" } }),
		);
		expect(oldReaderLeafId).toBe(assistantId);
		expect(session.getLeafId()).toBe(assistantId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
	});

	it("normalizes temporary flat state records without re-rooting their conversation", () => {
		const file = join(tempDir, "flat-state.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "flat-state",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const message = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: userMsg("legacy state"),
		};
		writeFileSync(
			file,
			`${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify({ type: "session_state", timestamp: "2025-01-01T00:00:02.000Z", key: "mode", value: "old" })}\n${JSON.stringify({ type: "session_state", timestamp: "2025-01-01T00:00:03.000Z", key: "mode", value: "latest" })}\n`,
		);

		const session = SessionManager.open(file, tempDir);

		expect(session.getLeafId()).toBe("entry-1");
		expect(session.getSessionState("mode")).toBe("latest");
		const rewritten = loadEntriesFromFile(file);
		expect(rewritten.some((entry) => entry.type === "session_state")).toBe(false);
		expect(rewritten.filter(isSessionStateEntry)).toEqual([
			expect.objectContaining({ sessionState: { key: "mode", value: "old" } }),
			expect.objectContaining({ sessionState: { key: "mode", value: "latest" } }),
		]);
	});

	it("continues to open state-free version 3 session files", () => {
		const file = join(tempDir, "legacy.jsonl");
		const header = {
			type: "session",
			version: 3,
			id: "legacy",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const message = {
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: userMsg("legacy"),
		};
		const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
		writeFileSync(file, content);

		const session = SessionManager.open(file, tempDir);
		expect(session.getSessionState("missing")).toBeUndefined();
		expect(readFileSync(file, "utf8")).toBe(content);
	});
});
