import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveColonCommand } from "../src/pager.ts";

describe("resolveColonCommand", () => {
	it("maps n to the next file and p to the previous file", () => {
		assert.equal(resolveColonCommand("n"), "nextFile");
		assert.equal(resolveColonCommand("p"), "previousFile");
	});

	it("cancels on any other key", () => {
		assert.equal(resolveColonCommand("q"), undefined);
		assert.equal(resolveColonCommand("\x1b"), undefined);
	});
});
