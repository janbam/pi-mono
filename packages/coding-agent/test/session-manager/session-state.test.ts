import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToJsonl } from "../../src/core/session-export.ts";
import { loadEntriesFromFile, SessionManager, type SessionStateEntry } from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

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
		const stateRecord = records.find((entry) => entry.type === "session_state");
		expect(stateRecord).toEqual(expect.not.objectContaining({ id: expect.anything(), parentId: expect.anything() }));

		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(reopened.getSessionState("context")).toEqual({ enabled: true, nested: [1, "two", null] });
	});

	it("keeps independent keys and uses physical last-write-wins order", () => {
		const session = SessionManager.inMemory();

		session.setSessionState("shared", { writer: "extension-a" });
		session.setSessionState("other", [1, 2, 3]);
		session.setSessionState("shared", { writer: "extension-b" });

		expect(session.getSessionState("shared")).toEqual({ writer: "extension-b" });
		expect(session.getSessionState("other")).toEqual([1, 2, 3]);
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
		const stateRecords = loadEntriesFromFile(derivedFile!).filter(
			(entry): entry is SessionStateEntry => entry.type === "session_state",
		);
		expect(stateRecords).toEqual([expect.objectContaining({ type: "session_state", key: "mode", value: "latest" })]);
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
		const stateRecords = loadEntriesFromFile(forked.getSessionFile()!).filter(
			(entry): entry is SessionStateEntry => entry.type === "session_state",
		);

		expect(forked.getSessionState("mode")).toBe(2);
		expect(stateRecords).toEqual([expect.objectContaining({ type: "session_state", key: "mode", value: 2 })]);
	});

	it("exports the active branch with one effective state record per key", () => {
		const session = SessionManager.inMemory(tempDir);
		session.setSessionState("mode", "old");
		session.setSessionState("mode", "latest");
		session.appendMessage(userMsg("question"));
		const outputPath = join(tempDir, "export.jsonl");

		exportSessionToJsonl(session, outputPath);

		const exported = loadEntriesFromFile(outputPath);
		const stateRecords = exported.filter((entry): entry is SessionStateEntry => entry.type === "session_state");
		expect(stateRecords).toEqual([expect.objectContaining({ type: "session_state", key: "mode", value: "latest" })]);
		expect(exported.filter((entry) => entry.type === "message")).toHaveLength(1);
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
