/**
 * Smoke test for dsh-trilogy.
 *
 * Drives the plugin through a fake harness context: no dsh process, no profile.
 * It exercises the real public surface (`apply`) and asserts the three
 * behaviours the plugin promises, plus the markdown surgery underneath them.
 *
 * Run: node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { apply, name, inject, Config } from "../lib/index.js";

const read = (p) => readFileSync(p, "utf8");
const results = [];

/** Run one check, awaiting async bodies so a failure cannot escape as an unhandled rejection. */
async function check(label, fn) {
	try {
		await fn();
		results.push(`  PASS  ${label}`);
	} catch (error) {
		results.push(`  FAIL  ${label}\n        ${error.message}`);
		process.exitCode = 1;
	}
}

/**
 * Build a fake ctx that captures the handlers, tools and API route the plugin registers.
 * @param options - `web: true` simulates a profile with a web server; `llm` stubs the model.
 */
function fakeContext({ web = false, llm = null } = {}) {
	const handlers = new Map();
	const tools = new Map();
	const logs = [];
	const disposers = [];
	let apiHandler = null;
	const ctx = {
		on(event, fn) {
			handlers.set(event, fn);
		},
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
			},
		},
		logger: {
			info: (...args) => logs.push(["info", args]),
			warn: (...args) => logs.push(["warn", args]),
		},
		effect(fn) {
			disposers.push(fn());
		},
		get(name) {
			if (name === "llm") return llm ?? undefined;
			if (name === "webServer" && web) return webServer;
			return undefined;
		},
		inject(services, callback) {
			// A headless profile has no web server; the plugin must stay loadable anyway.
			if (!web || !services.includes("webServer")) return;
			callback({ get: ctx.get, effect: ctx.effect });
		},
	};
	const webServer = {
		register(route) {
			if (route.kind !== "prefix" || route.path !== "/trilogy") {
				throw new Error(`unexpected route registration: ${JSON.stringify({ kind: route.kind, path: route.path })}`);
			}
			apiHandler = route.handler;
			return () => {
				apiHandler = null;
			};
		},
	};
	return {
		ctx,
		handlers,
		tools,
		logs,
		get apiHandler() {
			return apiHandler;
		},
	};
}

/** A fake `ctx.llm` that answers every call with one fixed JSON object. */
function fakeLlm(payload) {
	return {
		async *stream() {
			yield { type: "text-delta", index: 0, text: JSON.stringify(payload) };
			yield { type: "finish", reason: { kind: "stop" } };
		},
	};
}

/** A fake agent rooted at `cwd`, recording every steer. */
function fakeAgent(cwd) {
	const steered = [];
	return {
		session: { header: { cwd } },
		steer: (message) => steered.push(message),
		steered,
	};
}

const preStep = (handlers, agent) =>
	handlers.get("agent/pre-step")({ agent }, async () => ({ kind: "enter", messages: [] }));

console.log(`dsh-trilogy smoke test — plugin id "${name}", inject ${JSON.stringify(inject)}`);
console.log(`config declared: ${Config !== undefined}`);

// Keep registry writes out of the real DSH home.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "pm-home-"));

/* ------------------------------------------------------------------ */

const projectRoot = mkdtempSync(join(tmpdir(), "pm-project-"));
mkdirSync(join(projectRoot, ".git"), { recursive: true });
const memoryDir = join(projectRoot, "memory");

const { ctx, handlers, tools, logs } = fakeContext();
apply(ctx, {});
const agent = fakeAgent(projectRoot);

/* --- 1. scaffold + injection -------------------------------------- */

const firstPass = await preStep(handlers, agent);

await check("scaffold creates all three memory files", () => {
	for (const f of ["PROJECT.md", "DECISIONS.md", "SESSIONS.md"]) {
		assert.ok(existsSync(join(memoryDir, f)), `${f} missing`);
	}
});

await check("scaffold appends the boot block to AGENTS.md", () => {
	const agents = read(join(projectRoot, "AGENTS.md"));
	assert.ok(agents.includes("<!-- dsh-trilogy -->"), "marker missing");
	assert.ok(agents.includes("## Memory"), "boot block heading missing");
});

await check("PROJECT.md has the five fixed sections, empty ones say `暂无`", () => {
	const text = read(join(memoryDir, "PROJECT.md"));
	for (const section of ["这是什么", "怎么跑和怎么测", "东西都在哪", "现状", "坑"]) {
		assert.ok(text.includes(`## ${section}`), `section ${section} missing`);
	}
	assert.equal((text.match(/暂无/g) ?? []).length, 5, "expected five empty sections");
});

await check("first step injects the three files into the step", () => {
	assert.equal(firstPass.messages.length, 1, "expected one injected message");
	const text = JSON.stringify(firstPass.messages[0]);
	assert.ok(text.includes("项目记忆"), "block marker missing");
	assert.ok(text.includes("PROJECT.md") && text.includes("DECISIONS.md"), "files not listed");
	assert.ok(text.includes("项目记忆是空的"), "a brand-new project must be asked to bootstrap");
});

await check("second step with unchanged files injects nothing new (digest dedup)", async () => {
	const second = await preStep(handlers, agent);
	assert.equal(second.messages.length, 0, "expected no re-injection");
});

await check("a changed memory file is re-injected", async () => {
	writeFileSync(
		join(memoryDir, "PROJECT.md"),
		read(join(memoryDir, "PROJECT.md")).replace("暂无", "a real project"),
		"utf8",
	);
	const afterEdit = await preStep(handlers, agent);
	assert.equal(afterEdit.messages.length, 1, "expected exactly one injected message");
	const text = JSON.stringify(afterEdit.messages[0]);
	assert.ok(text.includes("a real project"), "changed content missing");
	assert.ok(!text.includes("项目记忆是空的"), "bootstrap must stop once real content exists");
});

await check("re-running scaffold never overwrites existing memory", async () => {
	await preStep(handlers, agent);
	assert.ok(read(join(memoryDir, "PROJECT.md")).includes("a real project"), "existing content was clobbered");
	const agents = read(join(projectRoot, "AGENTS.md"));
	assert.equal((agents.match(/<!-- dsh-trilogy -->/g) ?? []).length, 1, "boot block duplicated");
});

await check("bootstrap stops once PROJECT.md is filled through the tool", async () => {
	// A second, untouched project: scaffolded but never filled in.
	const freshRoot = mkdtempSync(join(tmpdir(), "pm-bootstrap-"));
	mkdirSync(join(freshRoot, ".git"), { recursive: true });
	const fresh = fakeContext();
	apply(fresh.ctx, {});
	const freshAgent = fakeAgent(freshRoot);

	const first = await preStep(fresh.handlers, freshAgent);
	assert.ok(
		JSON.stringify(first.messages[0]).includes("项目记忆是空的"),
		"a fresh project must be asked to bootstrap",
	);

	await fresh.tools.get("memory_checkpoint").execute(
		{
			project: [
				{ section: "这是什么", text: "a surveyed project" },
				{ section: "怎么跑和怎么测", text: "node test/smoke.mjs" },
				{ section: "东西都在哪", text: "src/" },
				{ section: "State", text: "works" },
				{ section: "坑", text: "暂无" },
			],
		},
		{ agent: freshAgent },
	);

	const second = await preStep(fresh.handlers, freshAgent);
	assert.equal(second.messages.length, 1, "filling PROJECT.md must refresh the injected block");
	assert.ok(
		!JSON.stringify(second.messages[0]).includes("项目记忆是空的"),
		"bootstrap must not repeat once the project has been described",
	);
});

/* --- 2. the checkpoint tool --------------------------------------- */

await check("both tools are registered", () => {
	assert.ok(tools.has("memory_checkpoint"), "memory_checkpoint missing");
	assert.ok(tools.has("memory_read"), "memory_read missing");
});

const checkpoint = tools.get("memory_checkpoint");
const written = await checkpoint.execute(
	{
		sessions: [{ done: "wired the plugin", open: "no tests in CI", next: "run the profile" }],
		decisions: [{ choice: "markdown, not sqlite", over: "sqlite", because: "git-diffable" }],
		project: [{ section: "State", text: "plugin scaffolded and injecting" }],
	},
	{ agent },
);

await check("checkpoint reports exactly what it wrote", () => {
	assert.equal(written.written.length, 3, JSON.stringify(written));
});

await check("SESSIONS.md gets a dated entry above the fence, newest at top", () => {
	const text = read(join(memoryDir, "SESSIONS.md"));
	assert.ok(/## \d{4}-\d{2}-\d{2}\n完成：wired the plugin/.test(text), `entry malformed:\n${text}`);
	assert.ok(text.includes("未完成：no tests in CI"));
	assert.ok(text.includes("下一步：run the profile"));
	const entryIndex = text.indexOf("完成：wired the plugin");
	const fenceEnd = text.indexOf("```", text.indexOf("```") + 3);
	assert.ok(entryIndex > fenceEnd, "entry was inserted inside the fenced example");
});

await check("DECISIONS.md gets the full choice/over/because shape", () => {
	const text = read(join(memoryDir, "DECISIONS.md"));
	assert.ok(text.includes("— markdown, not sqlite"), "heading missing");
	assert.ok(text.includes("选择：markdown, not sqlite"));
	assert.ok(text.includes("放弃：sqlite"));
	assert.ok(text.includes("因为：git-diffable"));
});

await check("PROJECT.md section is replaced in place, later sections intact", () => {
	const text = read(join(memoryDir, "PROJECT.md"));
	assert.ok(text.includes("## 现状\n\nplugin scaffolded and injecting"), `section not replaced:\n${text}`);
	assert.ok(text.includes("## 坑"), "later section was damaged");
	assert.equal((text.match(/## 现状/g) ?? []).length, 1, "section duplicated");
});

await check("memory_read returns the file that was written", async () => {
	const readBack = await tools.get("memory_read").execute({ file: "DECISIONS.md" }, { agent });
	assert.ok(readBack.content.includes("markdown, not sqlite"));
	assert.ok(readBack.path.endsWith("DECISIONS.md"));
});

/* --- 3. the end-of-turn nudge ------------------------------------- */

const runTurn = async (target, { work, record }) => {
	handlers.get("session/event")(target.session, { type: "turn/start" });
	if (work) handlers.get("tools/result")({ agent: target });
	if (record) {
		await checkpoint.execute({ sessions: [{ done: "recorded during the turn" }] }, { agent: target });
	}
	await handlers.get("agent/turn-stopping")({ agent: target });
	return target.steered;
};

await check("a working turn that recorded nothing is nudged once", async () => {
	const target = fakeAgent(projectRoot);
	const steered = await runTurn(target, { work: true, record: false });
	assert.equal(steered.length, 1, "expected exactly one steer");
	const payload = JSON.stringify(steered[0]);
	assert.ok(payload.includes("memory_checkpoint"), "nudge must name the tool");
	assert.ok(payload.includes("未来的会话会不会浪费时间"), "nudge must carry the admission test");
});

await check("cooldown suppresses a second nudge in the same session", async () => {
	const target = fakeAgent(projectRoot);
	await runTurn(target, { work: true, record: false });
	await runTurn(target, { work: true, record: false });
	assert.equal(target.steered.length, 1, "cooldown did not suppress the second nudge");
});

await check("a turn that recorded something is not nudged", async () => {
	const target = fakeAgent(projectRoot);
	const steered = await runTurn(target, { work: true, record: true });
	assert.equal(steered.length, 0, "a recording turn should not be nudged");
});

await check("a turn that did no work is not nudged", async () => {
	const target = fakeAgent(projectRoot);
	const steered = await runTurn(target, { work: false, record: false });
	assert.equal(steered.length, 0, "an idle turn should not be nudged");
});

/* --- 4. Settings UI API -------------------------------------------- */

const WEB_PROJECT = mkdtempSync(join(tmpdir(), "pm-web-"));
mkdirSync(join(WEB_PROJECT, ".git"), { recursive: true });

const web = fakeContext({
	web: true,
	llm: fakeLlm({
		whatThisIs: "surfaced by the fake model",
		runAndTest: "npm test",
		whereThingsLive: "src/",
		state: "green",
		traps: "none yet",
	}),
});
apply(web.ctx, {});
const webAgent = fakeAgent(WEB_PROJECT);

await check("a web profile registers the Settings UI prefix route", () => {
	assert.ok(web.apiHandler !== null, "no prefix route registered at /trilogy");
});

/**
 * Drive the registered node-style handler with a synthetic request/response pair.
 * @param pathname - request pathname, query included.
 * @param options - method and optional JSON body object.
 */
async function callRoute(pathname, { method = "GET", body, remoteAddress = "127.0.0.1" } = {}) {
	assert.ok(web.apiHandler !== null, "API route is not registered");
	const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
	req.method = method;
	req.url = pathname;
	req.headers = { host: "127.0.0.1" };
	req.socket = { remoteAddress };
	let status = 0;
	let payload = "";
	const res = {
		writeHead(code) {
			status = code;
		},
		end(chunk) {
			if (chunk !== undefined) payload += String(chunk);
		},
	};
	await web.apiHandler(req, res);
	return { status, body: payload.length === 0 ? {} : JSON.parse(payload) };
}

/** Find one workspace row by root. */
const wsOf = (body, root) => body.workspaces.find((w) => w.root === root);

await preStep(web.handlers, webAgent);

await check("GET /workspaces lists a scaffolded workspace", async () => {
	const { body } = await callRoute("/trilogy/workspaces");
	const row = wsOf(body, WEB_PROJECT);
	assert.ok(row !== undefined, JSON.stringify(body.workspaces.map((w) => w.root)));
	assert.equal(row.exists, true);
	assert.equal(row.empty, true, "a freshly scaffolded project is empty");
	assert.ok(row.lastSeen !== null, "lastSeen missing");
});

await check("GET /files returns the three files with metadata", async () => {
	const { body } = await callRoute(`/trilogy/files?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.ok(body.files["PROJECT.md"].text.includes("## 这是什么"));
	assert.ok(body.files["DECISIONS.md"].text.includes("# DECISIONS"));
	assert.ok(body.files["SESSIONS.md"].text.includes("# SESSIONS"));
	assert.ok(body.files["PROJECT.md"].bytes > 0, "byte count missing");
	assert.ok(body.files["PROJECT.md"].mtime > 0, "mtime missing");
});



await check("POST /clear deletes every memory file — the archive included", async () => {
	// An archive left behind would let the row read "已清除" while older history
	// stayed on disk and stayed reachable through memory_search.
	writeFileSync(join(WEB_PROJECT, "memory", "SESSIONS-archive.md"), "# SESSIONS ARCHIVE\n\n## 2020-01-01 — old\ngone\n");
	const { body } = await callRoute("/trilogy/clear", { method: "POST", body: { root: WEB_PROJECT } });
	assert.equal(body.cleared.length, 4, JSON.stringify(body));
	assert.equal(body.bootBlockRemoved, true);
	// `exists` drives the row badge: false after a clear is what makes it read "已清除".
	const { body: listed } = await callRoute("/trilogy/workspaces");
	assert.equal(wsOf(listed, WEB_PROJECT).exists, false, "a cleared workspace must report exists=false");
	for (const fileName of ["PROJECT.md", "DECISIONS.md", "SESSIONS.md", "SESSIONS-archive.md"]) {
		assert.ok(!existsSync(join(WEB_PROJECT, "memory", fileName)), `${fileName} survived the clear`);
	}
	assert.ok(!existsSync(join(WEB_PROJECT, "AGENTS.md")), "AGENTS.md held only our block, so it should be gone");
});

await check("clearing is not permanent: the next session scaffolds empty files again", async () => {
	const fresh = fakeAgent(WEB_PROJECT);
	const before = await preStep(web.handlers, fresh);
	assert.ok(existsSync(join(WEB_PROJECT, "memory", "PROJECT.md")), "files were not recreated");
	const text = read(join(WEB_PROJECT, "memory", "PROJECT.md"));
	assert.ok(text.includes("暂无"), "recreated files must be empty templates");
	assert.ok(!text.includes("surfaced by the fake model"), "content survived the clear");
	assert.ok(
		JSON.stringify(before.messages[0]).includes("项目记忆是空的"),
		"a recreated project must be offered the bootstrap again",
	);
});

await check("POST /clear rejects a workspace that was never recorded", async () => {
	const { status, body } = await callRoute("/trilogy/clear", { method: "POST", body: { root: "D:/definitely-not-registered" } });
	assert.equal(status, 400);
	assert.ok(String(body.error).includes("未记录"), JSON.stringify(body));
});

await check("the API answers 404 for an unknown endpoint", async () => {
	const { status, body } = await callRoute("/trilogy/nope");
	assert.equal(status, 404);
	assert.ok(String(body.error).includes("未知端点"), JSON.stringify(body));
});

await check("the mutating API is fenced to this machine", async () => {
	const { status, body } = await callRoute("/trilogy/clear", {
		method: "POST",
		body: { root: WEB_PROJECT },
		remoteAddress: "192.168.1.50",
	});
	assert.equal(status, 403, JSON.stringify(body));
	assert.ok(String(body.error).includes("本机"), JSON.stringify(body));
});

/* --- 5. the composer status indicator ------------------------------- */

await check("a checkpoint that records nothing leaves the indicator idle", async () => {
	await web.tools.get("memory_checkpoint").execute({}, { agent: webAgent });
	const { body } = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(body.phase, "idle", JSON.stringify(body));
});

await check("a recording checkpoint reports done with a sync time", async () => {
	await web.tools.get("memory_checkpoint").execute({ sessions: [{ done: "status probe" }] }, { agent: webAgent });
	const { body } = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(body.phase, "done", JSON.stringify(body));
	assert.ok(body.lastSyncAt > 0, "lastSyncAt missing");
	assert.ok(String(body.lastSyncFile).includes("SESSIONS.md"), JSON.stringify(body));
	assert.equal(typeof body.now, "number", "the host clock stamp is missing");
});

await check("the indicator never reports a sync time in the future", async () => {
	const { body } = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.ok(body.lastSyncAt <= body.now, `${body.lastSyncAt} > ${body.now}`);
});

/* --- 6. manual editing and forgetting -------------------------------- */

await check("POST /save writes one memory file", async () => {
	const { status } = await callRoute("/trilogy/save", {
		method: "POST",
		body: { root: WEB_PROJECT, file: "PROJECT.md", text: "# PROJECT\n\n## 这是什么\n\nhand edited in the settings page\n" },
	});
	assert.equal(status, 200);
	assert.ok(read(join(WEB_PROJECT, "memory", "PROJECT.md")).includes("hand edited"));
});

await check("POST /save refuses everything except the three memory files and the instruction file", async () => {
	// The instruction file is writable now, so the interesting question is what is
	// NOT: an archive, a sibling file, a traversal attempt, and a name this
	// workspace does not use for its instruction file.
	for (const name of ["SESSIONS-archive.md", "package.json", "README.md", "../escape.txt", "AGENTS.md.bak"]) {
		const { status, body } = await callRoute("/trilogy/save", { method: "POST", body: { root: WEB_PROJECT, file: name, text: "nope" } });
		assert.equal(status, 400, `${name} must be refused, got ${JSON.stringify(body)}`);
	}
	assert.ok(!existsSync(join(WEB_PROJECT, "..", "escape.txt")), "a refused write must not escape the workspace");
});

await check("POST /save writes the instruction file itself, and /files reports it", async () => {
	// Its own workspace on purpose: writing the instruction file is destructive to
	// the boot block, and WEB_PROJECT has a round-trip test further down.
	const instr = mkdtempSync(join(tmpdir(), "pm-instr-"));
	await callRoute("/trilogy/init", { method: "POST", body: { cwd: instr } });
	const before = (await callRoute(`/trilogy/files?root=${encodeURIComponent(instr)}`)).body.instruction;
	assert.equal(before.name, "AGENTS.md");
	assert.equal(before.exists, true);
	assert.ok(before.text.includes("<!-- dsh-trilogy -->"), "init should have written the block");

	const written = "## House rules\n\n- keep it short\n";
	const { status, body } = await callRoute("/trilogy/save", { method: "POST", body: { root: instr, file: "AGENTS.md", text: written } });
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.kind, "instruction", "the endpoint must say which kind it wrote");
	assert.equal(read(join(instr, "AGENTS.md")), written, "the file must be replaced, not appended to");

	const after = (await callRoute(`/trilogy/files?root=${encodeURIComponent(instr)}`)).body.instruction;
	assert.equal(after.text, written, "the listing must carry the new text");
	assert.equal(after.bytes, Buffer.byteLength(written, "utf8"));

	// A moved instruction file is still addressable by the name it was registered
	// under, and that name is the only one the whitelist opens.
	const renamed = await callRoute("/trilogy/save", { method: "POST", body: { root: instr, file: "CLAUDE.md", text: "x" } });
	assert.equal(renamed.status, 400, "a name this workspace did not register must stay refused");
});


await check("a workspace nested inside a repository is still its own project", async () => {
	// The whole point of the default: no `.git` hunting, the workspace wins.
	const repo = mkdtempSync(join(tmpdir(), "pm-repo-"));
	mkdirSync(join(repo, ".git"), { recursive: true });
	const nested = join(repo, "packages", "app");
	mkdirSync(nested, { recursive: true });

	const nestedCtx = fakeContext();
	apply(nestedCtx.ctx, {});
	const nestedAgent = fakeAgent(nested);
	await preStep(nestedCtx.handlers, nestedAgent);

	assert.ok(existsSync(join(nested, "memory", "PROJECT.md")), "memory must land in the workspace");
	assert.ok(!existsSync(join(repo, "memory")), "the repository root must be left alone");
});

await check("projectRootStrategy=marker restores the climb to .git", async () => {
	const repo = mkdtempSync(join(tmpdir(), "pm-repo2-"));
	mkdirSync(join(repo, ".git"), { recursive: true });
	const nested = join(repo, "packages", "app");
	mkdirSync(nested, { recursive: true });

	const markerCtx = fakeContext();
	apply(markerCtx.ctx, { projectRootStrategy: "marker" });
	await preStep(markerCtx.handlers, fakeAgent(nested));

	assert.ok(existsSync(join(repo, "memory", "PROJECT.md")), "marker mode must climb to the repository root");
});

const compactRoot = mkdtempSync(join(tmpdir(), "pm-compact-"));
mkdirSync(join(compactRoot, ".git"), { recursive: true });
const compactCtx = fakeContext();
apply(compactCtx.ctx, {});

const capRoot = mkdtempSync(join(tmpdir(), "pm-cap-"));
mkdirSync(join(capRoot, ".git"), { recursive: true });
const capCtx = fakeContext();
apply(capCtx.ctx, { sessionsMaxEntries: 5 });
const capAgent = fakeAgent(capRoot);

await check("SESSIONS.md is capped: the oldest entries move to an archive", async () => {
	await preStep(capCtx.handlers, capAgent);

	const many = Array.from({ length: 12 }, (_, index) => ({ done: `entry ${index}` }));
	await capCtx.tools.get("memory_checkpoint").execute({ sessions: many }, { agent: capAgent });

	const live = read(join(capRoot, "memory", "SESSIONS.md"));
	const archived = read(join(capRoot, "memory", "SESSIONS-archive.md"));
	const liveCount = (live.match(/^## /gm) ?? []).length;
	const archivedCount = (archived.match(/^## /gm) ?? []).length;
	assert.equal(liveCount, 5, `live log should be capped at 5, got ${liveCount}`);
	assert.equal(archivedCount, 7, `7 oldest entries should be archived, got ${archivedCount}`);
	assert.ok(live.includes("entry 0"), "the newest entry must stay live");
	assert.ok(archived.includes("entry 11"), "the oldest entry must be archived");
	assert.ok(!live.includes("entry 11"), "the archive must not leak back into the live log");
	assert.ok(live.includes("更早的会话条目已归档到"), "the live log must leave a visible pointer to the archive");
	assert.equal((live.match(/更早的会话条目已归档到/g) ?? []).length, 1, "the pointer must not stack");
});

await check("the archive stays reachable through memory_read", async () => {
	const archived = await capCtx.tools.get("memory_read").execute({ file: "SESSIONS-archive.md" }, { agent: capAgent });
	assert.ok(archived.content.includes("entry 11"), "archived detail must remain readable");
});

await check("the archive never leaks into the injected block", async () => {
	const fresh = fakeAgent(capRoot);
	const pass = await preStep(capCtx.handlers, fresh);
	const injected = JSON.stringify(pass.messages);
	assert.ok(injected.includes("SESSIONS.md"), "the live log should still be injected");
	assert.ok(!injected.includes("SESSIONS ARCHIVE"), "the archive must never be injected");
});


await check("a workspace with no memory reports 无记忆, not 已同步", async () => {
	const bare = mkdtempSync(join(tmpdir(), "pm-bare-"));
	const { body } = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(bare)}`);
	assert.equal(body.phase, "none", JSON.stringify(body));
	assert.equal(body.lastSyncAt, null);
	assert.equal(body.workspace, bare, "the workspace must still be resolved");
});

await check("POST /init creates the three files for a memoryless workspace", async () => {
	const bare = mkdtempSync(join(tmpdir(), "pm-init-"));
	const { status, body } = await callRoute("/trilogy/init", { method: "POST", body: { cwd: bare } });
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.created.length, 3, JSON.stringify(body));
	assert.ok(existsSync(join(bare, "memory", "PROJECT.md")));
	const after = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(bare)}`);
	assert.notEqual(after.body.phase, "none", "after init the workspace has memory");
	assert.ok(after.body.lastSyncAt > 0, "and a sync time from disk");
});

await check("status is per-workspace: two workspaces do not share it", async () => {
	const a = mkdtempSync(join(tmpdir(), "pm-a-"));
	const b = mkdtempSync(join(tmpdir(), "pm-b-"));
	await callRoute("/trilogy/init", { method: "POST", body: { cwd: a } });
	const statusA = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(a)}`);
	const statusB = await callRoute(`/trilogy/status?cwd=${encodeURIComponent(b)}`);
	assert.notEqual(statusA.body.phase, "none", "a has memory");
	assert.equal(statusB.body.phase, "none", "b has none");
	assert.notEqual(statusA.body.workspace, statusB.body.workspace);
});

await check("a block that vanished from the session is re-injected", async () => {
	// One session object across all three passes, so the digest settles and only
	// the visibility of the injected block differs between them.
	const session = { header: { cwd: compactRoot }, surface: { nodes: [1] }, eventAt: () => undefined };
	const subject = { session, steer() {} };

	const first = await preStep(compactCtx.handlers, subject);
	assert.equal(first.messages.length, 1, "the first pass must inject");

	// Same content, but nothing in the session carries it: this is what a
	// compaction leaves behind, and it must not silence the memory.
	const second = await preStep(compactCtx.handlers, subject);
	assert.equal(second.messages.length, 1, "a block absent from the session must be re-injected");

	// Same content and the block is still there: stay quiet.
	session.eventAt = () => ({
		type: "user/message",
		data: { source: { kind: "plugin", plugin: "trilogy", form: "trilogy" } },
	});
	const third = await preStep(compactCtx.handlers, subject);
	assert.equal(third.messages.length, 0, "a block still present must not be re-injected");
});

await check("a boot block written under an older name is upgraded, not duplicated", async () => {
	const root = mkdtempSync(join(tmpdir(), "pm-upgrade-"));
	writeFileSync(join(root, "AGENTS.md"), "# House rules\n\n<!-- dsh-project-memory -->\n\n## Memory\n\nstale block\n", "utf8");
	const c = fakeContext();
	apply(c.ctx, {});
	await preStep(c.handlers, fakeAgent(root));

	const text = read(join(root, "AGENTS.md"));
	assert.ok(text.includes("# House rules"), "existing content must survive");
	assert.ok(text.includes("<!-- dsh-trilogy -->"), "the current marker must be present");
	assert.ok(!text.includes("dsh-project-memory"), "the old marker must be gone");
	assert.ok(!text.includes("stale block"), "the old block body must be gone");
	assert.equal((text.match(/## Memory/g) ?? []).length, 1, "exactly one Memory section");
});

await check("recording resets the nudge budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "pm-nudge-"));
	const c = fakeContext();
	apply(c.ctx, { nudgeCooldownMs: 0, nudgeMaxPerSession: 1 });
	const subject = fakeAgent(root);
	const turn = async (record) => {
		c.handlers.get("session/event")(subject.session, { type: "turn/start" });
		c.handlers.get("tools/result")({ agent: subject });
		if (record) await c.tools.get("memory_checkpoint").execute({ sessions: [{ done: "x" }] }, { agent: subject });
		await c.handlers.get("agent/turn-stopping")({ agent: subject });
	};

	await turn(false);
	assert.equal(subject.steered.length, 1, "the first working turn should be nudged");
	await turn(false);
	assert.equal(subject.steered.length, 1, "the budget is 1, so the second must be silent");
	await turn(true);
	await turn(false);
	assert.equal(subject.steered.length, 2, "recording must give the budget back");
});

await check("an over-budget injection says what it left out", async () => {
	const root = mkdtempSync(join(tmpdir(), "pm-budget-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	const c = fakeContext();
	// Ask for many recent entries so the block cannot fit under the floor budget.
	apply(c.ctx, { injectBudgetBytes: 2000, sessionEntriesInjected: 30 });
	const subject = fakeAgent(root);
	await preStep(c.handlers, subject);
	await c.tools.get("memory_checkpoint").execute({
		sessions: Array.from({ length: 30 }, (_, i) => ({ done: "padding ".repeat(40) + i })),
	}, { agent: subject });
	const pass = await preStep(c.handlers, subject);
	const text = JSON.stringify(pass.messages);
	assert.ok(text.includes("未注入"), "the omission must be stated, not silent");
	assert.ok(text.includes("memory_search"), "the note must say how to get it back");
});

await check("an over-budget log degrades entry by entry, not by dropping the log", async () => {
	// One byte over budget used to mean the whole log disappeared. Halving first
	// keeps the newest few, which is what a reader actually needs.
	const root = mkdtempSync(join(tmpdir(), "pm-cliff-"));
	const c = fakeContext();
	// Room for the two files plus a few entries, nowhere near all twelve.
	apply(c.ctx, { injectBudgetBytes: 4000, sessionEntriesInjected: 12 });
	const subject = fakeAgent(root);
	await preStep(c.handlers, subject);
	await c.tools.get("memory_checkpoint").execute({
		sessions: Array.from({ length: 12 }, (_, i) => ({ done: `条目${i} ` + "填充".repeat(120) })),
	}, { agent: subject });
	const pass = await preStep(c.handlers, subject);
	const text = JSON.stringify(pass.messages);
	assert.ok(text.includes("条目0"), "the newest entry must survive an over-budget log");
	assert.ok(!text.includes("条目11"), "the oldest entry should have been dropped");
	assert.ok(/本次只注入最近 \d+ 条/.test(text), `expected a partial count, got: ${text.slice(-240)}`);
});

await check("the shipped default carries well beyond a handful of session entries", async () => {
	// The count is the knob that decides how much log reaches every session. It used
	// to be 5, which is a couple of days in a busy workspace.
	const root = mkdtempSync(join(tmpdir(), "pm-default-entries-"));
	const c = fakeContext();
	apply(c.ctx, {}); // no config at all: whatever ships is what runs
	const subject = fakeAgent(root);
	await preStep(c.handlers, subject);
	// The tool inserts in reverse, so the last item here ends up furthest down the
	// log -- it is only injected if every one of the fifteen makes it in.
	await c.tools.get("memory_checkpoint").execute({
		sessions: Array.from({ length: 15 }, (_, i) => ({ done: `标记${i}` })),
	}, { agent: subject });
	const pass = await preStep(c.handlers, subject);
	const text = JSON.stringify(pass.messages);
	assert.ok(text.includes("标记0"), "the newest entry is missing");
	assert.ok(text.includes("标记14"), "the default dropped the oldest of fifteen entries");
});

await check("the shipped budget fits a real-sized memory without an omission note", async () => {
	// The default used to be 16000, which could not even hold the three files plus
	// the default number of entries -- every session in a mature workspace got the
	// omission footer. This pins the guarantee, not the number.
	const root = mkdtempSync(join(tmpdir(), "pm-default-budget-"));
	const c = fakeContext();
	apply(c.ctx, {}); // no config at all: whatever ships is what runs
	const subject = fakeAgent(root);
	await preStep(c.handlers, subject);
	await c.tools.get("memory_checkpoint").execute({
		project: [{ section: "现状", text: "填充内容".repeat(2000) }],
		sessions: Array.from({ length: 5 }, (_, i) => ({ done: "记录一条".repeat(200) + i })),
	}, { agent: subject });
	const pass = await preStep(c.handlers, subject);
	const text = JSON.stringify(pass.messages);
	assert.ok(text.includes("填充内容"), "the project memory was not injected at all");
	assert.ok(!text.includes("未注入"), "the shipped budget is too small for a normal memory");
});

await check("memory_search finds entries the live log no longer carries", async () => {
	// capCtx capped SESSIONS.md at 5 entries, so "entry 11" lives in the archive.
	const found = await capCtx.tools.get("memory_search").execute({ query: "entry 11" }, { agent: capAgent });
	assert.ok(found.matches.length > 0, "the archive must be searchable");
	assert.ok(
		found.matches.some((match) => match.file === "SESSIONS-archive.md"),
		JSON.stringify(found.matches.map((match) => match.file)),
	);
});

await check("memory_search refuses an empty query", async () => {
	await assert.rejects(
		() => capCtx.tools.get("memory_search").execute({ query: "   " }, { agent: capAgent }),
		/requires a non-empty query/,
	);
});



await check("POST /restore moves an archived entry back to the live log", async () => {
	const archived = await capCtx.tools.get("memory_read").execute({ file: "SESSIONS-archive.md" }, { agent: capAgent });
	const entry = archived.content
		.split(/^## /m)
		.filter((part) => part.includes("entry 11"))
		.map((part) => "## " + part.trim())[0];
	assert.ok(entry !== undefined, "entry 11 must be in the archive first");
	const { status } = await callRoute("/trilogy/restore", { method: "POST", body: { root: capRoot, text: entry } });
	assert.equal(status, 200);
	assert.ok(read(join(capRoot, "memory", "SESSIONS.md")).includes("entry 11"), "the entry must be back in the live log");
	assert.ok(!read(join(capRoot, "memory", "SESSIONS-archive.md")).includes("entry 11"), "and gone from the archive");
});

await check("the archive pointer names how many entries moved", async () => {
	const live = read(join(capRoot, "memory", "SESSIONS.md"));
	assert.ok(/更早的会话条目已归档到 \d+ 条/.test(live), live.split("\n").slice(-3).join(" | "));
});

await check("GET /boot reports the boot block, and remove/rewrite round-trips", async () => {
	const before = await callRoute(`/trilogy/boot?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(before.body.exists, true, "the block should be present");
	assert.ok(before.body.block.includes("<!-- dsh-trilogy -->"), "the block text must be current");

	const removed = await callRoute("/trilogy/boot", { method: "POST", body: { root: WEB_PROJECT, action: "remove" } });
	assert.equal(removed.status, 200);
	const gone = await callRoute(`/trilogy/boot?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(gone.body.exists, false, "remove must take it out");

	const back = await callRoute("/trilogy/boot", { method: "POST", body: { root: WEB_PROJECT, action: "rewrite" } });
	assert.equal(back.status, 200);
	const again = await callRoute(`/trilogy/boot?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(again.body.exists, true, "rewrite must put it back");
	assert.equal((await callRoute(`/trilogy/boot?root=${encodeURIComponent(WEB_PROJECT)}`)).body.current, true);
});

await check("/boot refuses an unknown action", async () => {
	const { status } = await callRoute("/trilogy/boot", { method: "POST", body: { root: WEB_PROJECT, action: "nope" } });
	assert.equal(status, 400);
});

/* --- 6d. export / import -------------------------------------------- */

await check("GET /export bundles every memory file under the plugin's own kind", async () => {
	const { status, body } = await callRoute(`/trilogy/export?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(status, 200);
	assert.equal(body.kind, "dsh-trilogy/memory-bundle");
	assert.equal(body.root, WEB_PROJECT);
	assert.ok(Object.keys(body.files).includes("PROJECT.md"), JSON.stringify(Object.keys(body.files)));
	assert.ok(body.files["PROJECT.md"].includes("# PROJECT"), "the bundle must carry the file text itself");
});

await check("POST /import restores a bundle into a workspace that has none", async () => {
	const exported = (await callRoute(`/trilogy/export?root=${encodeURIComponent(WEB_PROJECT)}`)).body;
	const target = mkdtempSync(join(tmpdir(), "pm-import-"));
	const { status, body } = await callRoute("/trilogy/import", { method: "POST", body: { root: target, bundle: exported } });
	assert.equal(status, 200, JSON.stringify(body));
	assert.ok(body.written.includes("PROJECT.md"), JSON.stringify(body));
	assert.equal(read(join(target, "memory", "PROJECT.md")), exported.files["PROJECT.md"], "the text must land byte-for-byte");
	// A restored workspace has to be remembered, or the Settings UI could never list it.
	const row = wsOf((await callRoute("/trilogy/workspaces")).body, target);
	assert.ok(row !== undefined, "the imported workspace must be registered");
	assert.equal(row.exists, true);
});

await check("/import refuses a bundle this plugin did not write", async () => {
	const target = mkdtempSync(join(tmpdir(), "pm-import-bad-"));
	const { status, body } = await callRoute("/trilogy/import", {
		method: "POST",
		body: { root: target, bundle: { kind: "someone-else", files: { "PROJECT.md": "x" } } },
	});
	assert.equal(status, 400);
	assert.match(body.error, /记忆包/);
	assert.equal(existsSync(join(target, "memory")), false, "a refused import must not touch the disk");
});

/* --- 6e. PROJECT.md staleness ---------------------------------------- */

await check("a workspace whose files move together is not reported stale", async () => {
	const { body } = await callRoute(`/trilogy/files?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.ok(body.staleness !== undefined, "the file listing must carry a staleness reading");
	assert.equal(body.staleness.stale, false, JSON.stringify(body.staleness));
});

await check("PROJECT.md lagging behind the log past the threshold is reported stale", async () => {
	const stale = mkdtempSync(join(tmpdir(), "pm-stale-"));
	mkdirSync(join(stale, "memory"), { recursive: true });
	const longAgo = new Date(Date.now() - 60 * 86400000);
	const day = (ago) => new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
	writeFileSync(join(stale, "memory", "PROJECT.md"), "# PROJECT\n\n## 现状\n\n暂无\n");
	writeFileSync(join(stale, "memory", "SESSIONS.md"), `# SESSIONS\n\n## ${day(5)} — 做了一件事\ndone\n`);
	utimesSync(join(stale, "memory", "PROJECT.md"), longAgo, longAgo);

	const { body } = await callRoute(`/trilogy/files?root=${encodeURIComponent(stale)}`);
	assert.equal(body.staleness.stale, true, JSON.stringify(body.staleness));
	assert.equal(body.staleness.entriesSince, 1, JSON.stringify(body.staleness));
	assert.ok(body.staleness.behindDays >= 55, JSON.stringify(body.staleness));
});

await check("PROJECT.md headings written by an older version are renamed in place", async () => {
	const legacy = mkdtempSync(join(tmpdir(), "pm-legacy-"));
	mkdirSync(join(legacy, "memory"), { recursive: true });
	const english = "# PROJECT\n\n## What this is\n\nthe real thing\n\n## Run and test\n\nnode test\n\n## State\n\nstill going\n\n## Traps\n\nnone yet\n";
	writeFileSync(join(legacy, "memory", "PROJECT.md"), english);

	await preStep(handlers, fakeAgent(legacy));
	const after = read(join(legacy, "memory", "PROJECT.md"));
	for (const heading of ["## 这是什么", "## 怎么跑和怎么测", "## 现状", "## 坑"]) {
		assert.ok(after.includes(heading), `${heading} missing after migration:\n${after}`);
	}
	assert.ok(!/^## (What this is|Run and test|State|Traps)$/m.test(after), "an English heading survived");
	assert.ok(after.includes("the real thing") && after.includes("still going"), "a body was damaged by the rename");
	assert.ok(after.includes("## 坑") && after.includes("暂无") === false, "a filled section must keep its body");
});

await check("the legacy English section names are still accepted when writing", async () => {
	const legacy = mkdtempSync(join(tmpdir(), "pm-legacy-write-"));
	const agent = fakeAgent(legacy);
	await preStep(handlers, agent);
	// The enum takes both spellings; what lands on disk is always the Chinese one.
	await tools.get("memory_checkpoint").execute({ project: [{ section: "State", text: "written through the old name" }] }, { agent });
	const after = read(join(legacy, "memory", "PROJECT.md"));
	assert.ok(after.includes("## 现状"), `the section was not normalised:\n${after}`);
	assert.ok(after.includes("written through the old name"), "the body was lost");
	assert.ok(!after.includes("## State"), "the legacy heading was written out");
});

/* --- 7. health ----------------------------------------------------- */

await check("no warnings were logged during the whole run", () => {
	const warns = logs.filter(([level]) => level === "warn");
	assert.equal(warns.length, 0, JSON.stringify(warns));
});

console.log(results.join("\n"));
console.log(process.exitCode === 1 ? "\nRESULT: FAILURES" : "\nRESULT: all checks passed");
