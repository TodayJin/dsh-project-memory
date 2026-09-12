/**
 * Smoke test for dsh-project-memory.
 *
 * Drives the plugin through a fake harness context: no dsh process, no profile.
 * It exercises the real public surface (`apply`) and asserts the three
 * behaviours the plugin promises, plus the markdown surgery underneath them.
 *
 * Run: node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
			if (route.kind !== "prefix" || route.path !== "/project-memory") {
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

console.log(`dsh-project-memory smoke test — plugin id "${name}", inject ${JSON.stringify(inject)}`);
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
	assert.ok(agents.includes("<!-- dsh-project-memory -->"), "marker missing");
	assert.ok(agents.includes("## Memory"), "boot block heading missing");
});

await check("PROJECT.md has the five fixed sections, empty ones say `none yet`", () => {
	const text = read(join(memoryDir, "PROJECT.md"));
	for (const section of ["What this is", "Run and test", "Where things live", "State", "Traps"]) {
		assert.ok(text.includes(`## ${section}`), `section ${section} missing`);
	}
	assert.equal((text.match(/none yet/g) ?? []).length, 5, "expected five empty sections");
});

await check("first step injects the three files into the step", () => {
	assert.equal(firstPass.messages.length, 1, "expected one injected message");
	const text = JSON.stringify(firstPass.messages[0]);
	assert.ok(text.includes("PROJECT MEMORY"), "block marker missing");
	assert.ok(text.includes("PROJECT.md") && text.includes("DECISIONS.md"), "files not listed");
	assert.ok(text.includes("PROJECT MEMORY IS EMPTY"), "a brand-new project must be asked to bootstrap");
});

await check("second step with unchanged files injects nothing new (digest dedup)", async () => {
	const second = await preStep(handlers, agent);
	assert.equal(second.messages.length, 0, "expected no re-injection");
});

await check("a changed memory file is re-injected", async () => {
	writeFileSync(
		join(memoryDir, "PROJECT.md"),
		read(join(memoryDir, "PROJECT.md")).replace("none yet", "a real project"),
		"utf8",
	);
	const afterEdit = await preStep(handlers, agent);
	assert.equal(afterEdit.messages.length, 1, "expected exactly one injected message");
	const text = JSON.stringify(afterEdit.messages[0]);
	assert.ok(text.includes("a real project"), "changed content missing");
	assert.ok(!text.includes("PROJECT MEMORY IS EMPTY"), "bootstrap must stop once real content exists");
});

await check("re-running scaffold never overwrites existing memory", async () => {
	await preStep(handlers, agent);
	assert.ok(read(join(memoryDir, "PROJECT.md")).includes("a real project"), "existing content was clobbered");
	const agents = read(join(projectRoot, "AGENTS.md"));
	assert.equal((agents.match(/<!-- dsh-project-memory -->/g) ?? []).length, 1, "boot block duplicated");
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
		JSON.stringify(first.messages[0]).includes("PROJECT MEMORY IS EMPTY"),
		"a fresh project must be asked to bootstrap",
	);

	await fresh.tools.get("memory_checkpoint").execute(
		{
			project: [
				{ section: "What this is", text: "a surveyed project" },
				{ section: "Run and test", text: "node test/smoke.mjs" },
				{ section: "Where things live", text: "src/" },
				{ section: "State", text: "works" },
				{ section: "Traps", text: "none yet" },
			],
		},
		{ agent: freshAgent },
	);

	const second = await preStep(fresh.handlers, freshAgent);
	assert.equal(second.messages.length, 1, "filling PROJECT.md must refresh the injected block");
	assert.ok(
		!JSON.stringify(second.messages[0]).includes("PROJECT MEMORY IS EMPTY"),
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
	assert.ok(/## \d{4}-\d{2}-\d{2}\nDone: wired the plugin/.test(text), `entry malformed:\n${text}`);
	assert.ok(text.includes("Open: no tests in CI"));
	assert.ok(text.includes("Next: run the profile"));
	const entryIndex = text.indexOf("Done: wired the plugin");
	const fenceEnd = text.indexOf("```", text.indexOf("```") + 3);
	assert.ok(entryIndex > fenceEnd, "entry was inserted inside the fenced example");
});

await check("DECISIONS.md gets the full choice/over/because shape", () => {
	const text = read(join(memoryDir, "DECISIONS.md"));
	assert.ok(text.includes("— markdown, not sqlite"), "heading missing");
	assert.ok(text.includes("Chose: markdown, not sqlite"));
	assert.ok(text.includes("Over: sqlite"));
	assert.ok(text.includes("Because: git-diffable"));
});

await check("PROJECT.md section is replaced in place, later sections intact", () => {
	const text = read(join(memoryDir, "PROJECT.md"));
	assert.ok(text.includes("## State\n\nplugin scaffolded and injecting"), `section not replaced:\n${text}`);
	assert.ok(text.includes("## Traps"), "later section was damaged");
	assert.equal((text.match(/## State/g) ?? []).length, 1, "section duplicated");
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
	assert.ok(payload.includes("would a future session waste time"), "nudge must carry the admission test");
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
	assert.ok(web.apiHandler !== null, "no prefix route registered at /project-memory");
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
	const { body } = await callRoute("/project-memory/workspaces");
	const row = wsOf(body, WEB_PROJECT);
	assert.ok(row !== undefined, JSON.stringify(body.workspaces.map((w) => w.root)));
	assert.equal(row.exists, true);
	assert.equal(row.empty, true, "a freshly scaffolded project is empty");
	assert.ok(row.lastSeen !== null, "lastSeen missing");
});

await check("GET /files returns the three files with metadata", async () => {
	const { body } = await callRoute(`/project-memory/files?root=${encodeURIComponent(WEB_PROJECT)}`);
	assert.ok(body.files["PROJECT.md"].text.includes("## What this is"));
	assert.ok(body.files["DECISIONS.md"].text.includes("# DECISIONS"));
	assert.ok(body.files["SESSIONS.md"].text.includes("# SESSIONS"));
	assert.ok(body.files["PROJECT.md"].bytes > 0, "byte count missing");
	assert.ok(body.files["PROJECT.md"].mtime > 0, "mtime missing");
});



await check("POST /clear deletes the three files and withdraws the boot block", async () => {
	const { body } = await callRoute("/project-memory/clear", { method: "POST", body: { root: WEB_PROJECT } });
	assert.equal(body.cleared.length, 3, JSON.stringify(body));
	assert.equal(body.bootBlockRemoved, true);
	// `exists` drives the row badge: false after a clear is what makes it read "已清除".
	const { body: listed } = await callRoute("/project-memory/workspaces");
	assert.equal(wsOf(listed, WEB_PROJECT).exists, false, "a cleared workspace must report exists=false");
	for (const fileName of ["PROJECT.md", "DECISIONS.md", "SESSIONS.md"]) {
		assert.ok(!existsSync(join(WEB_PROJECT, "memory", fileName)), `${fileName} survived the clear`);
	}
	assert.ok(!existsSync(join(WEB_PROJECT, "AGENTS.md")), "AGENTS.md held only our block, so it should be gone");
});

await check("clearing is not permanent: the next session scaffolds empty files again", async () => {
	const fresh = fakeAgent(WEB_PROJECT);
	const before = await preStep(web.handlers, fresh);
	assert.ok(existsSync(join(WEB_PROJECT, "memory", "PROJECT.md")), "files were not recreated");
	const text = read(join(WEB_PROJECT, "memory", "PROJECT.md"));
	assert.ok(text.includes("none yet"), "recreated files must be empty templates");
	assert.ok(!text.includes("surfaced by the fake model"), "content survived the clear");
	assert.ok(
		JSON.stringify(before.messages[0]).includes("PROJECT MEMORY IS EMPTY"),
		"a recreated project must be offered the bootstrap again",
	);
});

await check("POST /clear rejects a workspace that was never recorded", async () => {
	const { status, body } = await callRoute("/project-memory/clear", { method: "POST", body: { root: "D:/definitely-not-registered" } });
	assert.equal(status, 400);
	assert.ok(String(body.error).includes("未记录"), JSON.stringify(body));
});

await check("the API answers 404 for an unknown endpoint", async () => {
	const { status, body } = await callRoute("/project-memory/nope");
	assert.equal(status, 404);
	assert.ok(String(body.error).includes("未知端点"), JSON.stringify(body));
});

await check("the mutating API is fenced to this machine", async () => {
	const { status, body } = await callRoute("/project-memory/clear", {
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
	const { body } = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(body.phase, "idle", JSON.stringify(body));
});

await check("a recording checkpoint reports done with a sync time", async () => {
	await web.tools.get("memory_checkpoint").execute({ sessions: [{ done: "status probe" }] }, { agent: webAgent });
	const { body } = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.equal(body.phase, "done", JSON.stringify(body));
	assert.ok(body.lastSyncAt > 0, "lastSyncAt missing");
	assert.ok(String(body.lastSyncFile).includes("SESSIONS.md"), JSON.stringify(body));
	assert.equal(typeof body.now, "number", "the host clock stamp is missing");
});

await check("the indicator never reports a sync time in the future", async () => {
	const { body } = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(WEB_PROJECT)}`);
	assert.ok(body.lastSyncAt <= body.now, `${body.lastSyncAt} > ${body.now}`);
});

/* --- 6. manual editing and forgetting -------------------------------- */

await check("POST /save writes one memory file", async () => {
	const { status } = await callRoute("/project-memory/save", {
		method: "POST",
		body: { root: WEB_PROJECT, file: "PROJECT.md", text: "# PROJECT\n\n## What this is\n\nhand edited in the settings page\n" },
	});
	assert.equal(status, 200);
	assert.ok(read(join(WEB_PROJECT, "memory", "PROJECT.md")).includes("hand edited"));
});

await check("POST /save refuses to write anything but the three files", async () => {
	const { status } = await callRoute("/project-memory/save", {
		method: "POST",
		body: { root: WEB_PROJECT, file: "AGENTS.md", text: "nope" },
	});
	assert.equal(status, 400, "only the three memory files may be written through this route");
});

await check("POST /forget drops the row but never the files", async () => {
	const { status } = await callRoute("/project-memory/forget", { method: "POST", body: { root: WEB_PROJECT } });
	assert.equal(status, 200);
	const { body } = await callRoute("/project-memory/workspaces");
	assert.equal(wsOf(body, WEB_PROJECT), undefined, "the row should be gone");
	assert.ok(existsSync(join(WEB_PROJECT, "memory", "PROJECT.md")), "forget must not delete anything on disk");
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
	const { body } = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(bare)}`);
	assert.equal(body.phase, "none", JSON.stringify(body));
	assert.equal(body.lastSyncAt, null);
	assert.equal(body.workspace, bare, "the workspace must still be resolved");
});

await check("POST /init creates the three files for a memoryless workspace", async () => {
	const bare = mkdtempSync(join(tmpdir(), "pm-init-"));
	const { status, body } = await callRoute("/project-memory/init", { method: "POST", body: { cwd: bare } });
	assert.equal(status, 200, JSON.stringify(body));
	assert.equal(body.created.length, 3, JSON.stringify(body));
	assert.ok(existsSync(join(bare, "memory", "PROJECT.md")));
	const after = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(bare)}`);
	assert.notEqual(after.body.phase, "none", "after init the workspace has memory");
	assert.ok(after.body.lastSyncAt > 0, "and a sync time from disk");
});

await check("status is per-workspace: two workspaces do not share it", async () => {
	const a = mkdtempSync(join(tmpdir(), "pm-a-"));
	const b = mkdtempSync(join(tmpdir(), "pm-b-"));
	await callRoute("/project-memory/init", { method: "POST", body: { cwd: a } });
	const statusA = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(a)}`);
	const statusB = await callRoute(`/project-memory/status?cwd=${encodeURIComponent(b)}`);
	assert.notEqual(statusA.body.phase, "none", "a has memory");
	assert.equal(statusB.body.phase, "none", "b has none");
	assert.notEqual(statusA.body.workspace, statusB.body.workspace);
});

/* --- 7. health ----------------------------------------------------- */

await check("no warnings were logged during the whole run", () => {
	const warns = logs.filter(([level]) => level === "warn");
	assert.equal(warns.length, 0, JSON.stringify(warns));
});

console.log(results.join("\n"));
console.log(process.exitCode === 1 ? "\nRESULT: FAILURES" : "\nRESULT: all checks passed");
