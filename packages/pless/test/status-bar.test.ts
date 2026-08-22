import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StatusInfo } from "../src/status-bar.ts";
import { formatPositionLabel, formatStatus, StatusBar } from "../src/status-bar.ts";

function info(overrides: Partial<StatusInfo> = {}): StatusInfo {
	return { name: "README.md", index: 1, count: 1, position: "42%", ...overrides };
}

describe("formatPositionLabel", () => {
	const content = 100;
	const viewport = 20; // maxScrollTop = 80

	it("shows All when the content fits the viewport", () => {
		assert.equal(formatPositionLabel(0, 20, 20), "All");
		assert.equal(formatPositionLabel(0, 10, 20), "All");
	});

	it("pins the ends to exact percentages without rounding drift", () => {
		assert.equal(formatPositionLabel(0, content, viewport), "0%");
		assert.equal(formatPositionLabel(80, content, viewport), "100%");
	});

	it("rounds midpoints and never exceeds 100%", () => {
		assert.equal(formatPositionLabel(40, content, viewport), "50%");
		assert.equal(formatPositionLabel(41, content, viewport), "51%");
		// scrollTop beyond max is clamped by ScrollView, but guard anyway.
		assert.equal(formatPositionLabel(999, content, viewport), "100%");
	});
});

describe("formatStatus", () => {
	it("shows the file index only in multi-file sessions", () => {
		assert.equal(formatStatus(info({ name: "a.md", index: 2, count: 3 })), "a.md (2/3) 42%");
		assert.equal(formatStatus(info()), "README.md 42%");
	});

	it("reports All when the file fits the viewport", () => {
		assert.equal(formatStatus(info({ position: "All" })), "README.md All");
	});
});

describe("StatusBar", () => {
	it("renders one reverse-video line padded to full width", () => {
		const bar = new StatusBar(() => info());
		const [line] = bar.render(40);
		assert.ok(line!.startsWith("\x1b[7m"));
		assert.ok(line!.endsWith("\x1b[27m"));
		assert.match(line!, /README\.md 42%/);
		// Visible width (ANSI excluded) must fill the whole bar width.
		const visible = line!.replaceAll("\x1b[7m", "").replaceAll("\x1b[27m", "").length;
		assert.equal(visible, 40);
	});

	it("reads live status through the getter on every render", () => {
		let position = "0%";
		const bar = new StatusBar(() => info({ position }));
		const before = bar.render(30)[0]!;
		position = "100%";
		const after = bar.render(30)[0]!;
		assert.notEqual(before, after);
		assert.match(after, /100%/);
	});

	it("shows a hint in place of the status while armed", () => {
		const bar = new StatusBar(() => info());
		bar.setHint(":n next file");
		assert.match(bar.render(40)[0]!, /:n next file/);
		bar.setHint(undefined);
		assert.match(bar.render(40)[0]!, /README\.md/);
	});
});
