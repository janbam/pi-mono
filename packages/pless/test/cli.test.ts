import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { loadDocuments, parseCliArgs } from "../src/cli.ts";

describe("parseCliArgs", () => {
	it("accepts a single file", () => {
		const result = parseCliArgs(["README.md"]);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.deepEqual(result.args.files, ["README.md"]);
			assert.equal(result.args.help, false);
			assert.equal(result.args.version, false);
		}
	});

	it("collects multiple files in order", () => {
		const result = parseCliArgs(["a.md", "b.md", "docs/c.md"]);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.deepEqual(result.args.files, ["a.md", "b.md", "docs/c.md"]);
	});

	it("recognizes help and version flags alongside files", () => {
		const result = parseCliArgs(["--help", "-v", "x.md"]);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(result.args.help, true);
			assert.equal(result.args.version, true);
			assert.deepEqual(result.args.files, ["x.md"]);
		}
	});

	it("rejects unknown options with the offending flag named", () => {
		const result = parseCliArgs(["--wat", "a.md"]);
		assert.equal(result.kind, "error");
		if (result.kind === "error") assert.match(result.message, /--wat/);
	});
});

describe("loadDocuments", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pless-test-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("reads file contents and records absolute paths", () => {
		const file = path.join(dir, "sample.md");
		writeFileSync(file, "# hello\n");
		const result = loadDocuments([file]);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") {
			assert.equal(result.documents.length, 1);
			assert.equal(result.documents[0]!.path, path.resolve(file));
			assert.equal(result.documents[0]!.content, "# hello\n");
		}
	});

	it("fails loudly for a missing file", () => {
		const result = loadDocuments([path.join(dir, "missing.md")]);
		assert.equal(result.kind, "error");
		if (result.kind === "error") assert.match(result.message, /no such file/);
	});

	it("rejects directories instead of reading them as markdown", () => {
		const sub = path.join(dir, "subdir");
		mkdirSync(sub);
		const result = loadDocuments([sub]);
		assert.equal(result.kind, "error");
		if (result.kind === "error") assert.match(result.message, /is a directory/);
	});
});
