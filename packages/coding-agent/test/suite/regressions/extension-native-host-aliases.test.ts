import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

it("resolves Pi packages to the host in native ESM extensions with private copies", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-native-extension-aliases-"));
	/** Write a fixture file, creating any enclosing directories. */
	const write = (path: string, source: string) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, source);
	};

	try {
		// A "type": "module" extension makes jiti hand its .js files to Node's native importer, bypassing jiti's alias.
		// The extension ships its own Pi packages, a dependency importing one, and a pinned TypeBox. Every import must
		// resolve without the hook too; otherwise native loading fails and jiti's aliased fallback hides the bug.
		const reexportEditor = 'export { CustomEditor } from "@earendil-works/pi-coding-agent";\n';
		/** Write a private ESM package whose entry is `index.js`. */
		const writePackage = (name: string, source: string) => {
			write(`ext/node_modules/${name}/package.json`, '{"type":"module","exports":"./index.js"}');
			write(`ext/node_modules/${name}/index.js`, source);
		};
		write("ext/package.json", '{"name":"ext","type":"module"}');
		writePackage("@earendil-works/pi-coding-agent", "export class CustomEditor {}\n");
		writePackage("@earendil-works/pi-ai", "export const Type = {};\n");
		writePackage("private-dep", reexportEditor);
		writePackage("typebox", 'export const pinned = "extension";\n');
		// A CommonJS dependency requires a Pi package only when called, i.e. after the extension has loaded.
		write("ext/node_modules/cjs-dep/package.json", '{"main":"./index.js"}');
		write(
			"ext/node_modules/cjs-dep/index.js",
			'exports.editor = () => require("@earendil-works/pi-coding-agent").CustomEditor;\n',
		);
		// Compiled output below a nested format-only manifest, as emitted by some extension builds.
		write("ext/dist/package.json", '{"type":"module"}');
		write("ext/dist/helper.js", reexportEditor);
		write(
			"ext/index.js",
			`import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { pinned } from "typebox";
import { CustomEditor as nested } from "./dist/helper.js";
import { CustomEditor as viaDependency } from "private-dep";
import cjs from "cjs-dep";
export default (pi) => pi.registerCommand("probe", {
	handler: async () => ({
		CustomEditor, Type, pinned, nested, viaDependency,
		late: (await import("@earendil-works/pi-coding-agent")).CustomEditor,
		required: cjs.editor(),
	}),
});`,
		);

		// Exercise the built loader in a child process: the hook is process-global and only active for unbundled dist.
		// Like CI, this relies on a current build (`npm run build`) of the coding agent.
		const dist = (path: string) => JSON.stringify(new URL(`../../../dist/${path}`, import.meta.url).href);
		write(
			"probe.mjs",
			`import assert from "node:assert/strict";
import { loadExtensions } from ${dist("core/extensions/loader.js")};
import { Type as hostType } from ${dist("core/extensions/pi-ai-extension-view.js")};
import { CustomEditor } from ${dist("index.js")};

const { extensions, errors } = await loadExtensions([${JSON.stringify(join(root, "ext/index.js"))}], process.cwd());
assert.deepEqual(errors, []);
const result = await extensions[0].commands.get("probe").handler();
assert.equal(result.CustomEditor, CustomEditor, "extension entry must get the host editor");
assert.equal(result.nested, CustomEditor, "compiled output below a nested manifest must get the host editor");
assert.equal(result.late, CustomEditor, "dynamic imports after initialization must get the host editor");
assert.equal(result.viaDependency, CustomEditor, "private dependencies get the host editor (global hook)");
assert.equal(result.required, CustomEditor, "CommonJS require must get the host editor");
assert.equal(result.Type, hostType, "the host pi-ai extension view must resolve its own imports");
assert.equal(result.pinned, "extension", "TypeBox stays per extension");`,
		);
		const child = spawnSync(process.execPath, [join(root, "probe.mjs")], {
			cwd: root,
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
