/**
 * Interaction test for the browser half.
 *
 * `client-render.mjs` proves the components can be *called*. This file proves
 * they *work*: it runs the bundle against a miniature React runtime that really
 * re-renders on state change, and a `fetch` that stands in for the host half and
 * parses every request body as JSON. So each check is a real click → request →
 * state → re-render round trip, and the assertions are about what the user sees.
 *
 * The JSON parse in the fetch stub is load-bearing: `fetch` silently turns a
 * plain-object body into the string "[object Object]", so a POST built that way
 * still "looks" fine in a render test and fails only against a real server.
 *
 * Run: node test/client-interact.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const results = [];
async function check(label, fn) {
	try {
		await fn();
		results.push(`  PASS  ${label}`);
	} catch (error) {
		results.push(`  FAIL  ${label}\n        ${error.message}`);
		process.exitCode = 1;
	}
}

/* ------------------------------------------------------------------ *
 * A miniature React: hooks with identity, and a render loop that settles
 * ------------------------------------------------------------------ */

const sameDeps = (left, right) => {
	if (left === null || right === undefined) return false;
	if (left.length !== right.length) return false;
	return left.every((value, index) => Object.is(value, right[index]));
};

function makeRuntime() {
	const hooks = [];
	let cursor = 0;
	let dirty = false;
	const queued = [];

	const cell = (index, create) => {
		if (!(index in hooks)) hooks[index] = create();
		return hooks[index];
	};

	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState(initial) {
			const index = cursor++;
			const slot = cell(index, () => ({ value: typeof initial === "function" ? initial() : initial }));
			const set = (next) => {
				const value = typeof next === "function" ? next(slot.value) : next;
				if (Object.is(value, slot.value)) return;
				slot.value = value;
				dirty = true;
			};
			return [slot.value, set];
		},
		useRef(value) {
			const index = cursor++;
			return cell(index, () => ({ current: value }));
		},
		useMemo(fn, deps) {
			const index = cursor++;
			const slot = cell(index, () => ({ deps: null, value: undefined }));
			if (!sameDeps(slot.deps, deps)) {
				slot.value = fn();
				slot.deps = deps;
			}
			return slot.value;
		},
		useCallback(fn, deps) {
			const index = cursor++;
			const slot = cell(index, () => ({ deps: null, fn }));
			if (!sameDeps(slot.deps, deps)) {
				slot.fn = fn;
				slot.deps = deps;
			}
			return slot.fn;
		},
		useEffect(fn, deps) {
			const index = cursor++;
			const slot = cell(index, () => ({ deps: null, cleanup: undefined, fn }));
			slot.fn = fn;
			if (!sameDeps(slot.deps, deps)) {
				slot.deps = deps;
				queued.push(slot);
			}
		},
		createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
	};
	react.useLayoutEffect = react.useEffect;

	/** Render until state stops changing, running effects in between. */
	const render = (Component, props) => {
		let tree = null;
		for (let pass = 0; pass < 50; pass++) {
			cursor = 0;
			dirty = false;
			queued.length = 0;
			tree = Component(props);
			for (const slot of queued.splice(0)) {
				if (typeof slot.cleanup === "function") slot.cleanup();
				const cleanup = slot.fn();
				slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
			}
			if (!dirty) break;
		}
		return tree;
	};

	/** Let every promise chain the components started run to completion. */
	const flush = async () => {
		for (let round = 0; round < 12; round++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	};

	return { react, render, flush };
}

/* ------------------------------------------------------------------ *
 * Tree helpers
 * ------------------------------------------------------------------ */

function walk(node, visit) {
	if (node === null || node === undefined || typeof node === "boolean") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node === "string" || typeof node === "number") {
		visit(node);
		return;
	}
	visit(node);
	for (const child of node.children ?? []) walk(child, visit);
}

const textOf = (node) => {
	const parts = [];
	walk(node, (item) => {
		if (typeof item === "string" || typeof item === "number") parts.push(String(item));
	});
	return parts.join(" ").replace(/\s+/g, " ").trim();
};

const findAll = (node, predicate) => {
	const found = [];
	walk(node, (item) => {
		if (typeof item === "object" && predicate(item)) found.push(item);
	});
	return found;
};

/** The first enabled button whose visible text contains `label`. */
function button(tree, label) {
	const candidates = findAll(tree, (el) => el.type === "button");
	const match = candidates.find((el) => el.props.disabled !== true && textOf(el).includes(label));
	assert.ok(
		match !== undefined,
		`no enabled button matching "${label}" — buttons on screen: ${candidates.map((el) => `"${textOf(el)}"${el.props.disabled ? "(disabled)" : ""}`).join(", ")}`,
	);
	return match;
}

const click = (el) => el.props.onClick({});

/* ------------------------------------------------------------------ *
 * A stand-in host half
 * ------------------------------------------------------------------ */

const ALPHA = "D:\\work\\alpha";
const BETA = "D:\\work\\beta";
const file = (name, text) => ({ text, bytes: Buffer.byteLength(text, "utf8"), mtime: 1_700_000_000_000 });
const WORKSPACE = (root) => ({ root, memoryDir: join(root, "memory"), firstSeen: "2026-01-01", lastSeen: "2026-09-12", exists: true, empty: false });

function makeHost() {
	const state = {
		workspaces: [WORKSPACE(ALPHA), WORKSPACE(BETA)],
		files: {
			[ALPHA]: {
				"PROJECT.md": file("PROJECT.md", "# PROJECT\n\n## State\n\nliving\n"),
				"DECISIONS.md": file("DECISIONS.md", "# DECISIONS\n"),
				"SESSIONS.md": file("SESSIONS.md", "# SESSIONS\n"),
				"SESSIONS-archive.md": file(
					"SESSIONS-archive.md",
					[
						"# SESSIONS ARCHIVE",
						"",
						"> Session entries moved out of `SESSIONS.md` so the live log stays short.",
						"> This file is **never injected** — read it only when you need older history.",
						"",
						"## 2026-01-02 — 旧会话二",
						"did b",
						"",
						"## 2026-01-01 — 旧会话一",
						"did a",
						"",
					].join("\n"),
				),
			},
			[BETA]: {
				"PROJECT.md": file("PROJECT.md", "# PROJECT (beta)\n"),
				"DECISIONS.md": null,
				"SESSIONS.md": null,
				"SESSIONS-archive.md": null,
			},
		},
		staleness: {
			[ALPHA]: { stale: false, projectMtime: 1, newestOtherMtime: 1, behindDays: 0, entriesSince: 0, thresholdDays: 14 },
			[BETA]: { stale: false, projectMtime: 1, newestOtherMtime: 1, behindDays: 0, entriesSince: 0, thresholdDays: 14 },
		},
		boot: {
			[ALPHA]: { file: join(ALPHA, "AGENTS.md"), exists: true, fileExists: true, current: true, block: "<!-- dsh-trilogy -->\n\n## Memory\n" },
			[BETA]: { file: join(BETA, "AGENTS.md"), exists: false, fileExists: false, current: false, block: "<!-- dsh-trilogy -->\n\n## Memory\n" },
		},
		instruction: {
			[ALPHA]: {
				name: "AGENTS.md",
				path: join(ALPHA, "AGENTS.md"),
				exists: true,
				text: "<!-- dsh-trilogy -->\n\n## Memory\n\nContinuity lives in memory/.\n",
				bytes: 59,
			},
			[BETA]: { name: "AGENTS.md", path: join(BETA, "AGENTS.md"), exists: false, text: null, bytes: 0 },
		},
		status: { [ALPHA]: { phase: "idle", at: 0, workspace: ALPHA, lastSyncAt: 1_700_000_000_000, lastSyncFile: "SESSIONS.md", now: 1_700_000_060_000 } },
		calls: [],
		downloads: [],
	};
	return state;
}

/**
 * Build a `fetch` for the sandbox.
 *
 * Every request body is parsed as JSON, and a body that is not JSON makes the
 * call fail loudly — which is exactly how a plain object reaching `fetch` gets
 * caught instead of travelling all the way to a real server as "[object Object]".
 */
function makeFetch(state) {
	return async (url, init = {}) => {
		const method = String(init.method ?? "GET").toUpperCase();
		const parsed = new URL(url, "http://127.0.0.1");
		let body;
		if (init.body !== undefined) {
			try {
				body = JSON.parse(init.body);
			} catch {
				return reply(400, { error: `请求体不是 JSON：${String(init.body).slice(0, 60)}` });
			}
		}
		state.calls.push({ method, path: parsed.pathname, query: parsed.searchParams, body, headers: init.headers });
		return route(state, method, parsed);
	};
}

const reply = (status, payload) => ({
	ok: status >= 200 && status < 300,
	status,
	statusText: String(status),
	text: async () => JSON.stringify(payload),
});

function route(state, method, parsed) {
	const path = parsed.pathname;
	const root = parsed.searchParams.get("root");
	const entry = (map, fallback) => (root !== null && root in map ? map[root] : (fallback ?? null));

	if (method === "GET" && path === "/trilogy/workspaces") return reply(200, { workspaces: state.workspaces });
	if (method === "GET" && path === "/trilogy/files") {
		return reply(200, {
			root,
			files: entry(state.files, {}) ?? {},
			staleness: entry(state.staleness, null),
			instruction: entry(state.instruction, null),
		});
	}
	if (method === "GET" && path === "/trilogy/boot") {
		const boot = entry(state.boot, null);
		return boot === null ? reply(400, { error: "未记录的工作区：" + root }) : reply(200, boot);
	}
	if (method === "GET" && path === "/trilogy/export") {
		const files = entry(state.files, {}) ?? {};
		// The real host exports file *text*, and only the files that exist.
		const texts = Object.fromEntries(Object.entries(files).filter(([, value]) => value !== null).map(([name, value]) => [name, value.text]));
		return reply(200, { kind: "dsh-trilogy/memory-bundle", version: 1, exportedAt: "2026-09-12T00:00:00.000Z", root, files: texts });
	}
	if (method === "GET" && path === "/trilogy/status") {
		const cwd = parsed.searchParams.get("cwd");
		return reply(200, state.status[cwd] ?? { phase: "none", at: 0, workspace: null, lastSyncAt: null, lastSyncFile: null, now: 1 });
	}

	return mutate(state, method, path, root);
}

/** POST endpoints. The body is read back off the recorded call, which by then is parsed JSON. */
function mutate(state, method, path, queryRoot) {
	const call = state.calls[state.calls.length - 1];
	const payload = call?.body ?? {};
	// A GET carries the workspace in the query; a POST carries it in the body.
	const root = typeof payload.root === "string" && payload.root.length > 0 ? payload.root : queryRoot;

	if (method === "POST" && path === "/trilogy/boot") {
		const boot = state.boot[root];
		if (boot === undefined) return reply(400, { error: "未记录的工作区：" + root });
		if (payload.action === "remove") {
			boot.exists = false;
			boot.current = false;
			return reply(200, { removed: true });
		}
		if (payload.action === "rewrite") {
			boot.exists = true;
			boot.current = true;
			return reply(200, { rewritten: true });
		}
		return reply(400, { error: "action 必须是 rewrite 或 remove" });
	}
	if (method === "POST" && path === "/trilogy/save") {
		// The instruction file is writable too, but only under the name this
		// workspace registered — exactly like the host's whitelist.
		const instr = state.instruction[root];
		if (instr !== undefined && payload.file === instr.name) {
			instr.text = payload.text;
			instr.exists = true;
			instr.bytes = Buffer.byteLength(String(payload.text), "utf8");
			return reply(200, { saved: instr.name, kind: "instruction", bytes: instr.bytes });
		}
		const target = state.files[root]?.[payload.file];
		if (target === undefined) return reply(400, { error: "不允许写入 " + String(payload.file) });
		target.text = payload.text;
		target.bytes = Buffer.byteLength(String(payload.text), "utf8");
		return reply(200, { saved: payload.file, kind: "memory", bytes: target.bytes });
	}
	if (method === "POST" && path === "/trilogy/clear") {
		for (const name of ["PROJECT.md", "DECISIONS.md", "SESSIONS.md", "SESSIONS-archive.md"]) {
			if (state.files[root] !== undefined) state.files[root][name] = null;
		}
		const row = state.workspaces.find((w) => w.root === root);
		if (row !== undefined) {
			row.exists = false;
			row.empty = true;
		}
		return reply(200, { cleared: ["PROJECT.md", "DECISIONS.md", "SESSIONS.md", "SESSIONS-archive.md"], bootBlockRemoved: true });
	}
	if (method === "POST" && path === "/trilogy/init") {
		const cwd = String(payload.cwd ?? "");
		state.files[cwd] = { "PROJECT.md": file("PROJECT.md", "# PROJECT\n"), "DECISIONS.md": file("DECISIONS.md", "# DECISIONS\n"), "SESSIONS.md": file("SESSIONS.md", "# SESSIONS\n"), "SESSIONS-archive.md": null };
		state.boot[cwd] = { file: join(cwd, "AGENTS.md"), exists: true, fileExists: true, current: true, block: "<!-- dsh-trilogy -->" };
		// Creating the files is itself a sync, and the chip reads that back.
		state.status[cwd] = { phase: "done", at: 1_700_000_060_000, workspace: cwd, lastSyncAt: 1_700_000_060_000, lastSyncFile: "PROJECT.md", now: 1_700_000_060_000 };
		return reply(200, { root: cwd, created: ["PROJECT.md", "DECISIONS.md", "SESSIONS.md"], bootBlockAdded: true });
	}
	if (method === "POST" && path === "/trilogy/import") {
		const written = Object.keys(payload.bundle?.files ?? {});
		state.files[root] = { ...(state.files[root] ?? {}), ...Object.fromEntries(written.map((name) => [name, file(name, payload.bundle.files[name])])) };
		return reply(200, { root, written });
	}
	if (method === "POST" && path === "/trilogy/restore") return reply(200, { restored: true });
	return reply(404, { error: "未知端点：" + path });
}

/* ------------------------------------------------------------------ *
 * Sandbox
 * ------------------------------------------------------------------ */

/** Load the bundle against a runtime + host, and hand back everything the checks need. */
function harness({ host = makeHost(), primitives = {} } = {}) {
	const runtime = makeRuntime();
	const loaded = new Map();
	const downloads = [];
	const intervals = [];
	const appended = [];
	const timeouts = [];

	const element = (tag) => ({
		tag,
		style: {},
		children: [],
		appendChild(child) {
			this.children.push(child);
			appended.push(child);
		},
		remove() {
			this.removed = true;
		},
		setAttribute() {},
		click() {
			downloads.push({ tag: this.tag, href: this.href, download: this.download });
		},
	});
	const documentStub = {
		head: element("head"),
		body: element("body"),
		documentElement: element("html"),
		createElement: element,
	};

	const blobs = [];
	class Blob {
		constructor(parts, options) {
			this.parts = parts;
			this.type = options?.type;
			blobs.push(this);
		}
	}
	const objectUrls = new Map();
	const URLStub = {
		createObjectURL(blob) {
			const url = `blob:test/${objectUrls.size}`;
			objectUrls.set(url, blob);
			return url;
		},
		revokeObjectURL(url) {
			objectUrls.delete(url);
		},
	};

	const sandbox = {
		window: { __ModuleLoader__: { load: (entry) => loaded.set(entry.id, entry.factory) } },
		document: documentStub,
		fetch: makeFetch(host),
		Blob,
		URL: URLStub,
		setInterval: (fn, ms) => {
			intervals.push({ fn, ms });
			return intervals.length;
		},
		clearInterval: () => {},
		setTimeout: (fn) => {
			// Recorded, not run: the only timer in the bundle is the deferred
			// `revokeObjectURL`, and revoking it here would hide the download.
			timeouts.push(fn);
			return 0;
		},
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: "lib/client.js" });

	const factory = loaded.get("dsh-trilogy");
	const registrations = [];
	const ctx = {
		slots: {
			inject: (_key, callback) => callback(),
			register: (options, Component) => registrations.push({ options, Component }),
		},
		effect: (fn) => fn(),
		get: () => undefined,
		locale: { register: () => {}, bind: () => (key) => key },
	};
	const exports = factory((specifier) => {
		if (specifier === "react") return runtime.react;
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		return {};
	});
	exports.apply(ctx);

	const seat = (name) => {
		const found = registrations.find((entry) => entry.options.name === name);
		assert.ok(found !== undefined, `seat ${name} was not registered`);
		return found.Component;
	};

	return {
		host,
		runtime,
		downloads,
		intervals,
		timeouts,
		blobs,
		objectUrls,
		appended,
		settings: seat("settings.section"),
		chip: seat("conversation.input.left"),
		/** Render, then let the requests the render started land, then render again. */
		async paint(Component, props) {
			const first = runtime.render(Component, props);
			await runtime.flush();
			const settled = runtime.render(Component, props);
			return { first, tree: settled };
		},
		/** Re-render after a synchronous state change, then let async work land. */
		async settle(Component, props) {
			await runtime.flush();
			const tree = runtime.render(Component, props);
			await runtime.flush();
			return runtime.render(Component, props);
		},
		repaint: (Component, props) => runtime.render(Component, props),
	};
}

const callsTo = (host, method, path) => host.calls.filter((call) => call.method === method && call.path === path);
const lastCall = (host, method, path) => callsTo(host, method, path).at(-1);

/* ------------------------------------------------------------------ *
 * The checks
 * ------------------------------------------------------------------ */

console.log("dsh-trilogy client-half interaction test");

await check("the settings page loads the workspace list and the first workspace's files", async () => {
	const h = harness();
	const { tree } = await h.paint(h.settings, {});
	const text = textOf(tree);
	assert.ok(text.includes("alpha"), `workspace list not rendered: ${text.slice(0, 160)}`);
	assert.ok(text.includes("beta"), "second workspace missing");
	assert.ok(text.includes("living"), "the selected workspace's PROJECT.md was not shown");
	assert.equal(callsTo(h.host, "GET", "/trilogy/files").length, 1, "exactly one file read on open");
	assert.equal(callsTo(h.host, "GET", "/trilogy/boot").length, 1, "the boot block is read on open");
});

await check("picking another workspace refetches that workspace's files", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	const row = findAll(tree, (el) => el.type === "button" && textOf(el).includes(BETA))[0];
	assert.ok(row !== undefined, "the beta row was not found");
	await click(row);
	tree = await h.settle(h.settings, {});
	const reads = callsTo(h.host, "GET", "/trilogy/files").map((call) => call.query.get("root"));
	assert.deepEqual(reads, [ALPHA, BETA], `unexpected file reads: ${JSON.stringify(reads)}`);
	assert.ok(textOf(tree).includes("PROJECT (beta)"), "the newly selected workspace's file was not shown");
});

await check("the three memory files are view-only: only the instruction file can be edited", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});

	for (const label of ["现状", "决策", "日志"]) {
		await click(button(tree, label));
		tree = h.repaint(h.settings, {});
		assert.equal(
			findAll(tree, (el) => el.type === "button" && textOf(el) === "编辑").length,
			0,
			`${label} still offered an editor`,
		);
		assert.equal(findAll(tree, (el) => el.type === "textarea").length, 0, `${label} opened an editor`);
	}

	assert.equal(callsTo(h.host, "POST", "/trilogy/save").length, 0, "viewing a file must not write");
	assert.ok(button(tree, "编辑整份文件") !== undefined, "the instruction file is the one file that stays editable");
});

await check("clearing posts the root and reports how much went", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "清除记忆文件"));
	tree = h.repaint(h.settings, {});
	assert.equal(callsTo(h.host, "POST", "/trilogy/clear").length, 0, "the first click must only arm the button");
	assert.ok(textOf(tree).includes("确认清除"), `no confirmation was offered: ${textOf(tree).slice(-200)}`);
	assert.ok(textOf(tree).includes("含归档"), "the warning must say the archive goes too");
	await click(button(tree, "确认清除"));
	tree = await h.settle(h.settings, {});

	const posted = lastCall(h.host, "POST", "/trilogy/clear");
	assert.ok(posted !== undefined, "no clear request was sent");
	assert.deepEqual(posted.body, { root: ALPHA });
	const text = textOf(tree);
	assert.ok(text.includes("已清除 4 个文件"), `the page did not report the clear: ${text.slice(-200)}`);
	assert.ok(text.includes("移除了 AGENTS.md"), "the withdrawn boot block was not mentioned");
	assert.ok(text.includes("已清除"), "the workspace badge did not go back to 已清除");
});

/* --- the instruction file (boot block) ------------------------------ */

await check("the boot panel reports whether the instruction file carries the block", async () => {
	const h = harness();
	const { tree } = await h.paint(h.settings, {});
	const text = textOf(tree);
	assert.ok(text.includes("指令文件"), "the boot panel is missing");
	assert.ok(text.includes(join(ALPHA, "AGENTS.md")), "the instruction file path is missing");
	assert.ok(text.includes("已写入"), `the block's presence was not reported: ${text.slice(0, 200)}`);
});

await check("removing the Memory block posts the action and the panel follows", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "移除 Memory 段"));
	tree = await h.settle(h.settings, {});

	const posted = lastCall(h.host, "POST", "/trilogy/boot");
	assert.ok(posted !== undefined, "no boot request was sent");
	assert.deepEqual(posted.body, { root: ALPHA, action: "remove" });
	assert.equal(h.host.boot[ALPHA].exists, false);
	const text = textOf(tree);
	assert.ok(text.includes("未写入"), `the panel did not follow the removal: ${text.slice(0, 240)}`);
	assert.ok(text.includes("没有它，新会话不会知道"), "the consequence of removing it was not spelled out");
	const removeAgain = findAll(tree, (el) => el.type === "button" && textOf(el).includes("移除 Memory 段"))[0];
	assert.equal(removeAgain.props.disabled, true, "removing twice must not be offered");
});

await check("rewriting the Memory block posts the action and restores the badge", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "移除 Memory 段"));
	tree = await h.settle(h.settings, {});
	await click(button(tree, "重写 Memory 段"));
	tree = await h.settle(h.settings, {});

	const posted = lastCall(h.host, "POST", "/trilogy/boot");
	assert.deepEqual(posted.body, { root: ALPHA, action: "rewrite" });
	assert.equal(h.host.boot[ALPHA].exists, true);
	assert.ok(textOf(tree).includes("已写入"), "the badge did not come back");
});

/* --- editing the instruction file itself ----------------------------- */

await check("the panel opens the whole instruction file, Memory block included", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "编辑整份文件"));
	tree = h.repaint(h.settings, {});

	const areas = findAll(tree, (el) => el.type === "textarea");
	assert.equal(areas.length, 1, `expected one editor, saw ${areas.length}`);
	assert.ok(areas[0].props.value.includes("Continuity lives in memory/"), `not the file's text: ${areas[0].props.value}`);
	assert.ok(areas[0].props.value.includes("<!-- dsh-trilogy -->"), "the Memory block must be visible in the editor");
	// The block-level buttons step aside while the whole file is open.
	assert.equal(findAll(tree, (el) => el.type === "button" && textOf(el) === "移除 Memory 段").length, 0, "the block buttons should step aside");
});

await check("saving the instruction file posts the whole text and refreshes the panel", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "编辑整份文件"));
	tree = h.repaint(h.settings, {});
	const edited = "## House rules\n\n- be brief\n";
	findAll(tree, (el) => el.type === "textarea")[0].props.onChange({ target: { value: edited } });
	tree = h.repaint(h.settings, {});
	await click(button(tree, "保存"));
	tree = await h.settle(h.settings, {});

	const posted = lastCall(h.host, "POST", "/trilogy/save");
	assert.ok(posted !== undefined, "no save was sent");
	assert.deepEqual(posted.body, { root: ALPHA, file: "AGENTS.md", text: edited });
	assert.equal(h.host.instruction[ALPHA].text, edited, "the host did not receive the new text");
	assert.ok(textOf(tree).includes("已保存 AGENTS.md"), `no confirmation shown: ${textOf(tree).slice(-160)}`);
	assert.equal(findAll(tree, (el) => el.type === "textarea").length, 0, "the editor stayed open after saving");
	assert.ok(button(tree, "移除 Memory 段") !== undefined, "the block buttons did not come back");
});

await check("cancelling the instruction editor writes nothing", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "编辑整份文件"));
	tree = h.repaint(h.settings, {});
	findAll(tree, (el) => el.type === "textarea")[0].props.onChange({ target: { value: "discard me" } });
	tree = h.repaint(h.settings, {});
	await click(button(tree, "取消"));
	tree = h.repaint(h.settings, {});

	assert.equal(findAll(tree, (el) => el.type === "textarea").length, 0, "the editor stayed open");
	assert.equal(callsTo(h.host, "POST", "/trilogy/save").length, 0, "cancel must not write");
	assert.equal(h.host.instruction[ALPHA].text.includes("discard me"), false, "the discarded text reached the host");
});

await check("an open instruction editor survives a switch of the file tab", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "编辑整份文件"));
	tree = h.repaint(h.settings, {});
	const draft = "# PROJECT\n\n## 现状\n\nunsaved draft\n";
	findAll(tree, (el) => el.type === "textarea")[0].props.onChange({ target: { value: draft } });
	tree = h.repaint(h.settings, {});

	// The instruction file is not one of the tabs, so switching tabs is not a
	// reason to throw away what was typed into it.
	await click(button(tree, "决策"));
	tree = h.repaint(h.settings, {});
	const areas = findAll(tree, (el) => el.type === "textarea");
	assert.equal(areas.length, 1, `the tab switch closed the editor: ${areas.length}`);
	assert.equal(areas[0].props.value, draft, "the tab switch dropped the unsaved draft");
	assert.equal(callsTo(h.host, "POST", "/trilogy/save").length, 0, "switching tabs must not write");
});

/* --- export / import ------------------------------------------------- */

await check("export downloads a JSON bundle named after the workspace", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "导出"));
	tree = await h.settle(h.settings, {});

	const bundle = lastCall(h.host, "GET", "/trilogy/export");
	assert.ok(bundle !== undefined, "no export request was sent");
	assert.equal(bundle.query.get("root"), ALPHA);
	assert.equal(h.downloads.length, 1, "no download was started");
	assert.equal(h.downloads[0].download, `alpha-memory-${new Date().toISOString().slice(0, 10)}.json`, h.downloads[0].download);
	const blob = h.objectUrls.get(h.downloads[0].href);
	assert.ok(blob !== undefined, "the download did not point at an object URL");
	const saved = JSON.parse(blob.parts[0]);
	assert.equal(saved.kind, "dsh-trilogy/memory-bundle");
	assert.equal(saved.files["PROJECT.md"], "# PROJECT\n\n## State\n\nliving\n");
	assert.ok(textOf(tree).includes("已导出 4 个文件"), `the page did not confirm the export: ${textOf(tree).slice(-200)}`);
});

await check("importing a bundle POSTs it and re-reads everything", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	const bundle = { kind: "dsh-trilogy/memory-bundle", version: 1, files: { "PROJECT.md": "# PROJECT\n\n## State\n\nimported\n", "DECISIONS.md": "# DECISIONS\n" } };
	const picked = { text: async () => JSON.stringify(bundle) };

	const input = findAll(tree, (el) => el.type === "input" && el.props.type === "file")[0];
	assert.ok(input !== undefined, "the file picker is missing");
	await input.props.onChange({ target: { files: [picked], value: "C:\\fakepath\\bundle.json" } });
	tree = await h.settle(h.settings, {});

	const posted = lastCall(h.host, "POST", "/trilogy/import");
	assert.ok(posted !== undefined, "no import request was sent");
	assert.equal(posted.body.root, ALPHA);
	assert.deepEqual(posted.body.bundle, bundle);
	assert.equal(h.host.files[ALPHA]["PROJECT.md"].text, "# PROJECT\n\n## State\n\nimported\n", "the imported text did not land");
	assert.ok(textOf(tree).includes("已导入 2 个文件"), `the page did not confirm the import: ${textOf(tree).slice(-200)}`);
});

await check("a bundle from somewhere else is refused and nothing is written", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	const input = findAll(tree, (el) => el.type === "input" && el.props.type === "file")[0];
	// The stub host answers 404 for a POST it does not recognise; what matters here
	// is that a parse failure surfaces instead of being swallowed.
	await input.props.onChange({ target: { files: [{ text: async () => "not json at all" }], value: "" } });
	tree = await h.settle(h.settings, {});
	const status = findAll(tree, (el) => el.props.role === "status").map(textOf).join(" | ");
	assert.ok(/JSON/i.test(status), `a failed import reported nothing useful: "${status}"`);
	assert.equal(callsTo(h.host, "POST", "/trilogy/import").length, 0, "an unparseable file must not reach the host");
});

/* --- PROJECT.md staleness -------------------------------------------- */

await check("a stale PROJECT.md raises a banner naming the gap", async () => {
	const host = makeHost();
	host.staleness[ALPHA] = { stale: true, projectMtime: 1, newestOtherMtime: 2, behindDays: 41, entriesSince: 7, thresholdDays: 14 };
	const h = harness({ host });
	const { tree } = await h.paint(h.settings, {});
	const text = textOf(tree);
	assert.ok(text.includes("PROJECT.md 可能过时"), `no staleness banner: ${text.slice(0, 300)}`);
	assert.ok(text.includes("41 天"), "the banner did not name the gap");
	assert.ok(text.includes("7 条"), "the banner did not name how many entries landed");
});

await check("a PROJECT.md that keeps up raises no banner", async () => {
	const h = harness();
	const { tree } = await h.paint(h.settings, {});
	assert.ok(!textOf(tree).includes("PROJECT.md 可能过时"), "a fresh PROJECT.md was reported stale");
});

await check("the banner goes away once the host stops reporting it", async () => {
	const host = makeHost();
	host.staleness[ALPHA] = { stale: true, projectMtime: 1, newestOtherMtime: 2, behindDays: 41, entriesSince: 7, thresholdDays: 14 };
	const h = harness({ host });
	let { tree } = await h.paint(h.settings, {});
	assert.ok(textOf(tree).includes("PROJECT.md 可能过时"), "the banner never appeared");
	host.staleness[ALPHA] = { stale: false, projectMtime: 2, newestOtherMtime: 2, behindDays: 0, entriesSince: 0, thresholdDays: 14 };
	await click(button(tree, "重新读取"));
	tree = await h.settle(h.settings, {});
	assert.ok(!textOf(tree).includes("PROJECT.md 可能过时"), "the banner outlived the condition");
});

/* --- every memory file is read-only ----------------------------------- */

await check("the archive tab offers one restore button per dated entry, and never for the header", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "归档"));
	tree = h.repaint(h.settings, {});

	const restores = findAll(tree, (el) => el.type === "button" && textOf(el) === "恢复这条");
	assert.equal(restores.length, 2, `expected two restorable entries, saw ${restores.length}`);
	const blocks = findAll(tree, (el) => el.type === "pre").map(textOf);
	assert.ok(blocks.some((block) => block.startsWith("## 2026-01-02")), "the newest entry was not shown");
	assert.ok(
		!blocks.some((block) => block.startsWith("## # SESSIONS ARCHIVE")),
		"the file header was rendered as if it were a restorable entry",
	);
});

await check("no memory file offers an editor, and the archive says how to change one", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	await click(button(tree, "归档"));
	tree = h.repaint(h.settings, {});

	assert.equal(findAll(tree, (el) => el.type === "button" && textOf(el) === "编辑").length, 0, "an editor was offered for a read-only file");
	assert.ok(textOf(tree).includes("归档只读"), "the tab did not say how to change an archived entry");
	assert.ok(button(tree, "重新读取") !== undefined, "re-reading should still be possible");
	assert.equal(callsTo(h.host, "POST", "/trilogy/save").length, 0, "no save should have been attempted");
});


await check("re-reading sits in the tab strip, immediately left of 归档", async () => {
	const h = harness();
	const { tree } = await h.paint(h.settings, {});
	const strip = findAll(tree, (el) => el.props?.className === "dsh-pm-tabs")[0];
	assert.ok(strip !== undefined, "the tab strip is missing");
	const labels = findAll(strip, (el) => el.type === "button").map(textOf);
	assert.deepEqual(labels, ["现状", "决策", "日志", "重新读取", "归档"], `unexpected tab strip: ${JSON.stringify(labels)}`);
});

await check("the detail says which workspace it belongs to", async () => {
	const h = harness();
	const { tree } = await h.paint(h.settings, {});
	// The picker is on the left and the detail on the right, so the selected row can
	// be far away; the detail repeats the path to stay unambiguous.
	const paths = findAll(tree, (el) => el.props?.className === "dsh-pm-path").map(textOf);
	assert.equal(paths.filter((path) => path === ALPHA).length, 2, `expected the selected path twice, got ${JSON.stringify(paths)}`);
	// And the destructive control is not in the same row as the ordinary ones.
	const danger = findAll(tree, (el) => el.props?.className === "dsh-pm-danger");
	assert.equal(danger.length, 1, "expected exactly one danger row");
	assert.ok(textOf(danger[0]).includes("清除记忆文件"), "the danger row has no clear button");
	assert.ok(!textOf(danger[0]).includes("导出"), "the danger row must not mix in ordinary actions");
});

await check("the workspace list and the detail are separate columns", async () => {
	const h = harness();
	let { tree } = await h.paint(h.settings, {});
	const body = findAll(tree, (el) => el.props?.className === "dsh-pm-body")[0];
	assert.ok(body !== undefined, "no two-column body");
	const side = findAll(body, (el) => el.props?.className === "dsh-pm-side")[0];
	const main = findAll(body, (el) => el.props?.className === "dsh-pm-main")[0];
	assert.ok(side !== undefined && main !== undefined, "the body is missing a column");
	// Picking a workspace must not rebuild the picker: it is the same subtree, so the
	// list never jumps and the detail never loses its subject.
	await click(button(tree, "beta"));
	tree = await h.settle(h.settings, {});
	const sideAfter = findAll(tree, (el) => el.props?.className === "dsh-pm-side")[0];
	assert.ok(sideAfter !== undefined, "the picker disappeared after selecting");
	assert.ok(textOf(sideAfter).includes("alpha") && textOf(sideAfter).includes("beta"), "the picker stopped listing both workspaces");
});

/* --- the composer chip ------------------------------------------------ */

const chipProps = (cwd) => ({ sessionId: "s1", useSessions: (select) => select({ byId: { s1: { cwd } } }) });

await check("the chip polls its own workspace's status", async () => {
	const h = harness();
	await h.paint(h.chip, chipProps(ALPHA));
	const reads = callsTo(h.host, "GET", "/trilogy/status");
	assert.equal(reads.length, 1, "the chip did not read the status exactly once");
	assert.equal(reads[0].query.get("cwd"), ALPHA, "the chip asked about the wrong workspace");
	assert.equal(h.intervals.length, 1, "the chip did not schedule a poll");
	assert.equal(h.intervals[0].ms, 4000, "the poll interval changed");
});

await check("a synced workspace shows a plain chip with how long ago", async () => {
	const h = harness();
	const { tree } = await h.paint(h.chip, chipProps(ALPHA));
	const text = textOf(tree);
	assert.ok(text.includes("已同步"), `unexpected chip text: ${text}`);
	assert.ok(text.includes("1 分钟前"), `the chip did not say how long ago: ${text}`);
	assert.equal(tree.type, "span", "a synced chip must not be a button");
});

await check("a workspace with no memory offers to create it and does so on click", async () => {
	const h = harness();
	const cwd = "D:\\work\\fresh";
	let { tree } = await h.paint(h.chip, chipProps(cwd));
	assert.ok(textOf(tree).includes("无记忆 · 点击创建"), `unexpected chip text: ${textOf(tree)}`);
	assert.equal(tree.type, "button", "an uninitialised chip must be clickable");

	await click(tree);
	tree = await h.settle(h.chip, chipProps(cwd));
	const posted = lastCall(h.host, "POST", "/trilogy/init");
	assert.ok(posted !== undefined, "clicking the chip sent no init request");
	assert.deepEqual(posted.body, { cwd });
	assert.ok(textOf(tree).includes("刚刚"), `the chip did not pick up the new sync time: ${textOf(tree)}`);
});

await check("a workspace the chip cannot read renders nothing rather than guessing", async () => {
	const h = harness();
	const tree = h.repaint(h.chip, { sessionId: "s1", useSessions: (select) => select({ byId: {} }) });
	assert.equal(tree, null, "the chip must not render before it knows its workspace");
});

/* ------------------------------------------------------------------ */

console.log(results.join("\n"));
console.log(process.exitCode === 1 ? "\nRESULT: FAILURES" : "\nRESULT: all checks passed");
