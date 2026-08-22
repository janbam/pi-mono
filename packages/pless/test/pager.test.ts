import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveColonCommand, resolveViewportAction } from "../src/pager.ts";

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

describe("resolveViewportAction", () => {
	const page = 20;

	it("maps j/k to single-line scrolling", () => {
		assert.deepEqual(resolveViewportAction("j", page), { kind: "scroll", lines: 1 });
		assert.deepEqual(resolveViewportAction("k", page), { kind: "scroll", lines: -1 });
	});

	it("maps space/f/b to page scrolling", () => {
		assert.deepEqual(resolveViewportAction(" ", page), { kind: "scroll", lines: 20 });
		assert.deepEqual(resolveViewportAction("f", page), { kind: "scroll", lines: 20 });
		assert.deepEqual(resolveViewportAction("b", page), { kind: "scroll", lines: -20 });
	});

	it("maps g/shift+g to top and bottom jumps", () => {
		assert.deepEqual(resolveViewportAction("g", page), { kind: "top" });
		assert.deepEqual(resolveViewportAction("G", page), { kind: "bottom" });
	});

	it("returns undefined for unrelated keys including search-relevant letters", () => {
		assert.equal(resolveViewportAction("n", page), undefined);
		assert.equal(resolveViewportAction("q", page), undefined);
		assert.equal(resolveViewportAction("\x1b", page), undefined);
	});
});
