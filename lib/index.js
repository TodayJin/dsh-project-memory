/**
 * dsh-project-memory — per-project memory for DeepSeek Harness.
 *
 * A prompt-only approach leaves everything to the model's diligence: it has to
 * remember to create the files, read them, and record anything. This plugin
 * supplies the three-file model as a host plugin instead, so the behaviour is
 * guaranteed by the harness rather than by the model's diligence:
 *
 *   1. a session in a project without `memory/` gets the three files scaffolded;
 *   2. every session starts with the three files already in context;
 *   3. durable outcomes are classified into the right file, with a bounded
 *      end-of-turn nudge so a session cannot silently forget to record.
 *
 * File semantics are taken verbatim from the upstream spec (see DESIGN.md):
 *   PROJECT.md   what the project is right now  — edited in place, one screen
 *   DECISIONS.md why it is that way             — append only, newest at top
 *   SESSIONS.md  what happened, and when        — append only, newest at top
 *
 * @module dsh-project-memory
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Plugin id, also the `plugin` field stamped on every injected message source. */
const name = "project-memory";

/** Services this plugin needs. `tools` carries the model-facing tool registry. */
const inject = ["tools"];

/** The `{kind:'plugin'}` source stamped on everything this plugin injects. */
const PLUGIN_SOURCE = { kind: "plugin", plugin: name };

const FILE_PROJECT = "PROJECT.md";
const FILE_DECISIONS = "DECISIONS.md";
const FILE_SESSIONS = "SESSIONS.md";
/** Overflow from SESSIONS.md. Never injected — it exists so the live log can stay short. */
const FILE_SESSIONS_ARCHIVE = "SESSIONS-archive.md";

/** The fixed section order of PROJECT.md. Empty sections read `none yet`. */
const PROJECT_SECTIONS = ["What this is", "Run and test", "Where things live", "State", "Traps"];

const EMPTY_SECTION = "none yet";

/** Idempotency marker for the boot block so re-runs never duplicate it. */
const BOOT_BLOCK_MARKER = "<!-- dsh-project-memory -->";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ *
 * Templates
 *
 * Read from ./templates at runtime so a user can edit them in place;
 * the embedded copies keep the plugin working if the directory is
 * missing (single-file installs, bundlers, packaged tarballs).
 * ------------------------------------------------------------------ */

const FALLBACK_TEMPLATES = {
	[FILE_PROJECT]: `# PROJECT

> What this project is, right now. Edited in place — keep it under one screen.
> Where this file disagrees with the code, the code wins, and this file gets fixed in the same pass.

## What this is

${EMPTY_SECTION}

## Run and test

${EMPTY_SECTION}

## Where things live

${EMPTY_SECTION}

## State

${EMPTY_SECTION}

## Traps

${EMPTY_SECTION}
`,
	[FILE_DECISIONS]: `# DECISIONS

> Settled choices and why. **Append only, newest at top.**
> A settled choice is reopened by asking, not by quietly working around it.
>
> Entry shape:
>
> \`\`\`
> ## YYYY-MM-DD — <the choice, one line>
> Chose: what was decided
> Over: the alternative that was rejected, and why
> Because: the constraint that forced it
> \`\`\`
`,
	[FILE_SESSIONS]: `# SESSIONS

> What happened, and when. **Append only, newest at top.**
>
> Entry shape:
>
> \`\`\`
> ## YYYY-MM-DD
> Done: what is now true, and how it was verified
> Open: what is unfinished
> Next: the one concrete next action
> \`\`\`
>
> \`Done\` without the verification is a claim, not a record. Where something was
> not verified, say that instead.
`,
};

const FALLBACK_BOOT_BLOCK = `## Memory

Continuity for this project lives in \`memory/\`. \`PROJECT.md\`, \`DECISIONS.md\` and
\`SESSIONS.md\` are loaded automatically at the start of every session — do not
re-read or re-summarise them, just use them.

- \`PROJECT.md\` is the current state. Where it disagrees with the code, the code
  wins, and the file gets fixed in the same pass.
- \`DECISIONS.md\` holds settled choices. A settled choice is reopened by asking,
  not by quietly working around it.
- \`SESSIONS.md\` is the log of what happened.

Record what a future session would otherwise have to rediscover, using the
\`memory_checkpoint\` tool. Apply one test to every candidate line: **would a
future session waste time, or repeat a mistake, without this?** A candidate that
fails is dropped, not shortened.
`;

/**
 * Read one template from ./templates, falling back to the embedded copy.
 * @param fileName - template file name.
 * @returns the template text.
 */
function templateText(fileName) {
	const onDisk = readTextOrNull(join(PACKAGE_ROOT, "templates", fileName));
	return onDisk !== null && onDisk.trim().length > 0 ? onDisk : FALLBACK_TEMPLATES[fileName];
}

/** The boot block appended to the project's AGENTS.md, marker included. */
function bootBlockText() {
	const onDisk = readTextOrNull(join(PACKAGE_ROOT, "templates", "boot-block.md"));
	const body = onDisk !== null && onDisk.trim().length > 0 ? onDisk : FALLBACK_BOOT_BLOCK;
	return `${BOOT_BLOCK_MARKER}\n\n${body.trimEnd()}\n`;
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const Config = z.object({
	enabled: z.boolean().default(true),
	memoryDirName: z.string().default("memory"),
	projectRootStrategy: z.string().default("workspace"),
	projectRootMarkers: z.array(z.string()).default([".git"]),
	autoScaffold: z.boolean().default(true),
	writeBootBlock: z.boolean().default(true),
	bootBlockFile: z.string().default("AGENTS.md"),
	injectOnSessionStart: z.boolean().default(true),
	bootstrapWhenEmpty: z.boolean().default(true),
	injectBudgetBytes: z.number().default(16000),
	sessionEntriesInjected: z.number().default(5),
	nudgeOnTurnEnd: z.boolean().default(true),
	nudgeCooldownMs: z.number().default(600000),
	nudgeMaxPerSession: z.number().default(3),
	sessionsMaxEntries: z.number().default(40),
});

/**
 * Merge partial loader config with field defaults so the plugin also works when
 * mounted with no config object at all.
 * @param config - loader-supplied config, possibly undefined.
 * @returns a fully-populated config.
 */
function normalizeConfig(config) {
	const input = config ?? {};
	return {
		enabled: input.enabled ?? true,
		memoryDirName: input.memoryDirName ?? "memory",
		projectRootStrategy: input.projectRootStrategy ?? "workspace",
		projectRootMarkers:
			Array.isArray(input.projectRootMarkers) && input.projectRootMarkers.length > 0
				? input.projectRootMarkers
				: [".git"],
		autoScaffold: input.autoScaffold ?? true,
		writeBootBlock: input.writeBootBlock ?? true,
		bootBlockFile: input.bootBlockFile ?? "AGENTS.md",
		injectOnSessionStart: input.injectOnSessionStart ?? true,
		bootstrapWhenEmpty: input.bootstrapWhenEmpty ?? true,
		injectBudgetBytes: input.injectBudgetBytes ?? 16000,
		sessionEntriesInjected: input.sessionEntriesInjected ?? 5,
		nudgeOnTurnEnd: input.nudgeOnTurnEnd ?? true,
		nudgeCooldownMs: input.nudgeCooldownMs ?? 600000,
		nudgeMaxPerSession: input.nudgeMaxPerSession ?? 3,
		sessionsMaxEntries: input.sessionsMaxEntries ?? 40,
	};
}

/* ------------------------------------------------------------------ *
 * Small filesystem helpers
 *
 * These are the plugin's own bookkeeping over files it owns, so they use
 * node:fs directly instead of the harness fs seam: the seam's resolve/write
 * contract is built for sandboxed *tool* execution, while scaffolding must
 * work identically under every provider (and under none).
 * ------------------------------------------------------------------ */

/**
 * Read a UTF-8 text file, or null when it is absent or unreadable.
 * @param filePath - absolute path.
 * @returns file text, or null.
 */
function readTextOrNull(filePath) {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

/**
 * Whether a path exists as a file.
 * @param filePath - absolute path.
 * @returns true when it is a regular file.
 */
function isFile(filePath) {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether a path exists as a directory.
 * @param dirPath - absolute path.
 * @returns true when it is a directory.
 */
function isDirectory(dirPath) {
	try {
		return statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Write text, creating parent directories as needed.
 * @param filePath - absolute path.
 * @param content - text to write.
 */
function writeText(filePath, content) {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content, "utf8");
}

/**
 * Find the project root by walking up from `cwd` until a marker is found.
 * @param cwd - absolute session working directory.
 * @param markers - marker names, e.g. ['.git'].
 * @returns the project root, or `cwd` when no marker is found.
 */
function findProjectRoot(cwd, markers) {
	let current = resolvePath(cwd);
	for (;;) {
		for (const marker of markers) if (existsSync(join(current, marker))) return current;
		const parent = dirname(current);
		if (parent === current) return resolvePath(cwd);
		current = parent;
	}
}

/**
 * Today's date from the system clock, in the local timezone.
 *
 * The upstream skill tells the model to go read the system date because a
 * conversation can stay open past midnight. A plugin can simply ask the clock,
 * so the date is stamped here instead of being trusted to the model.
 *
 * @returns `YYYY-MM-DD`.
 */
function todayISO(now = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* ------------------------------------------------------------------ *
 * Markdown surgery
 *
 * Entries are `## ` headings, and every template also contains fenced code
 * blocks that *show* an entry shape. Every scan therefore tracks fence state so
 * a sample inside ``` is never mistaken for a real entry.
 * ------------------------------------------------------------------ */

/**
 * Split text into lines annotated with fenced-code-block membership.
 * @param text - markdown text.
 * @returns one `{line, inFence}` record per line.
 */
function annotateFences(text) {
	const records = [];
	let fence = false;
	for (const line of text.split("\n")) {
		const trimmed = line.trimStart();
		const isFence = trimmed.startsWith("```") || trimmed.startsWith("~~~");
		records.push({ line, inFence: fence });
		if (isFence) fence = !fence;
	}
	return records;
}

/**
 * Index of the first real `## ` heading line, or -1.
 * @param text - markdown text.
 * @returns the line index, or -1.
 */
function firstEntryIndex(text) {
	const records = annotateFences(text);
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record.inFence && /^##\s+\S/.test(record.line)) return index;
	}
	return -1;
}

/**
 * Insert an entry block at the top of a newest-first file.
 * @param text - current file text.
 * @param entry - the block to insert, without surrounding blank lines.
 * @returns the new file text.
 */
function insertEntryAtTop(text, entry) {
	const block = entry.trimEnd();
	const index = firstEntryIndex(text);
	if (index === -1) return `${text.trimEnd()}\n\n${block}\n`;
	const lines = text.split("\n");
	const before = lines.slice(0, index).join("\n").trimEnd();
	const after = lines.slice(index).join("\n").trimEnd();
	return `${before}\n\n${block}\n\n${after}\n`;
}

/**
 * The first `count` entry blocks of a newest-first file.
 * @param text - markdown text.
 * @param count - how many blocks to keep.
 * @returns the concatenated blocks, trimmed; empty when there are none.
 */
function topEntries(text, count) {
	const records = annotateFences(text);
	const starts = [];
	for (let index = 0; index < records.length; index++) {
		if (!records[index].inFence && /^##\s+\S/.test(records[index].line)) starts.push(index);
	}
	if (starts.length === 0) return "";
	const chunks = [];
	for (let i = 0; i < Math.min(count, starts.length); i++) {
		const from = starts[i];
		const to = i + 1 < starts.length ? starts[i + 1] : records.length;
		chunks.push(records.slice(from, to).map((record) => record.line).join("\n").trimEnd());
	}
	return chunks.join("\n\n");
}

/**
 * Replace one `## <section>` body inside PROJECT.md, leaving the heading in place.
 * @param text - current file text.
 * @param section - section heading text without the leading `## `.
 * @param body - replacement body.
 * @returns the new file text.
 */
function replaceSection(text, section, body) {
	const records = annotateFences(text);
	const wanted = section.trim().toLowerCase();
	let start = -1;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.inFence) continue;
		const match = /^##\s+(.*\S)\s*$/.exec(record.line);
		if (match === null) continue;
		if (start === -1) {
			if (match[1].trim().toLowerCase() === wanted) start = index;
			continue;
		}
		const lines = [...records.slice(0, start + 1).map((entry) => entry.line), "", ...body.trim().split("\n"), "", ...records.slice(index).map((entry) => entry.line)];
		return `${lines.join("\n").trimEnd()}\n`;
	}
	if (start === -1) return null;
	const head = records.slice(0, start + 1).map((entry) => entry.line);
	const tail = ["", ...body.trim().split("\n")];
	return `${[...head, ...tail].join("\n").trimEnd()}\n`;
}

/**
 * Resolve the project root for one session.
 *
 * The default treats the **session workspace itself** as the project — no version
 * control, no marker, no walking up. `projectRootStrategy: "marker"` opts back
 * into climbing to the nearest `.git`, which only matters when the workspace is a
 * subdirectory of a repository and you would rather keep one memory for the whole
 * repository than one per package.
 *
 * @param cwd - absolute session working directory.
 * @param cfg - normalized config.
 * @returns the project root.
 */
function resolveProjectRoot(cwd, cfg) {
	if (cfg.projectRootStrategy !== "marker") return resolvePath(cwd);
	return findProjectRoot(cwd, cfg.projectRootMarkers);
}

/* ------------------------------------------------------------------ *
 * Scaffolding
 * ------------------------------------------------------------------ */

/**
 * Create any missing memory file, and append the boot block when absent.
 * Existing files are never overwritten — this runs on every session, and a
 * project's memory is the one thing here that must survive.
 *
 * @param paths - resolved project/memory paths.
 * @param cfg - normalized plugin config.
 * @returns a summary of what was created, for the injection note.
 */
function ensureScaffold(paths, cfg) {
	const created = [];
	if (!isDirectory(paths.memoryDir)) mkdirSync(paths.memoryDir, { recursive: true });
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS]) {
		const target = join(paths.memoryDir, fileName);
		if (isFile(target)) continue;
		writeText(target, templateText(fileName));
		created.push(fileName);
	}
	let bootBlockAdded = false;
	if (cfg.writeBootBlock) {
		const bootPath = join(paths.root, cfg.bootBlockFile);
		const existing = readTextOrNull(bootPath);
		if (existing === null) {
			writeText(bootPath, `${bootBlockText()}`);
			bootBlockAdded = true;
		} else if (!existing.includes(BOOT_BLOCK_MARKER)) {
			writeText(bootPath, `${existing.trimEnd()}\n\n${bootBlockText()}`);
			bootBlockAdded = true;
		}
	}
	return { created, bootBlockAdded };
}

/**
 * Whether PROJECT.md still holds nothing but the scaffold.
 *
 * True only when the fixed sections exist and every one of them is empty or
 * reads `none yet`. A hand-written PROJECT.md that uses its own headings is
 * treated as NOT empty, so a custom format is never nagged.
 *
 * @param text - PROJECT.md contents, or null when the file is missing.
 * @returns true when the project memory has never been filled in.
 */
function isProjectEmpty(text) {
	if (text === null) return true;
	const known = new Set(PROJECT_SECTIONS.map((section) => section.toLowerCase()));
	let current = null;
	let sawKnownSection = false;
	for (const record of annotateFences(text)) {
		if (record.inFence) continue;
		const match = /^##\s+(.*\S)\s*$/.exec(record.line);
		if (match !== null) {
			current = match[1].trim().toLowerCase();
			if (known.has(current)) sawKnownSection = true;
			continue;
		}
		if (current === null || !known.has(current)) continue;
		const body = record.line.trim();
		if (body.length > 0 && body.toLowerCase() !== EMPTY_SECTION) return false;
	}
	return sawKnownSection;
}

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

/**
 * Assemble the auto-loaded block from the three files, under a byte budget.
 *
 * Priority when over budget: PROJECT.md is the current state and is kept;
 * SESSIONS.md is dropped to fewer entries first, then DECISIONS.md is
 * truncated, and PROJECT.md is only ever hard-truncated as a last resort.
 *
 * @param paths - resolved project/memory paths.
 * @param cfg - normalized plugin config.
 * @returns `{text, digest}` or null when nothing could be read.
 */
function buildInjection(paths, cfg) {
	const project = readTextOrNull(join(paths.memoryDir, FILE_PROJECT));
	const decisions = readTextOrNull(join(paths.memoryDir, FILE_DECISIONS));
	const sessions = readTextOrNull(join(paths.memoryDir, FILE_SESSIONS));
	if (project === null && decisions === null && sessions === null) return null;

	const budget = Math.max(2000, cfg.injectBudgetBytes);
	const render = (projectText, decisionsText, sessionsText) => {
		const parts = ["===== PROJECT MEMORY (auto-loaded, do not re-read these files) ====="];
		if (projectText !== null && projectText !== undefined) parts.push(`--- ${FILE_PROJECT} ---\n${projectText.trimEnd()}`);
		if (decisionsText !== null && decisionsText !== undefined) parts.push(`--- ${FILE_DECISIONS} ---\n${decisionsText.trimEnd()}`);
		if (sessionsText !== null && sessionsText !== undefined && sessionsText.length > 0)
			parts.push(`--- ${FILE_SESSIONS} (most recent) ---\n${sessionsText}`);
		return parts.join("\n\n");
	};

	const recent = sessions === null ? null : topEntries(sessions, cfg.sessionEntriesInjected);
	const decisionHeader = decisions === null ? null : decisions.split("\n").slice(0, 40).join("\n");

	let text = render(project, decisions, recent);
	if (Buffer.byteLength(text, "utf8") <= budget) {
		return { text, digest: digestOf(text) };
	}
	text = render(project, decisions, null);
	if (Buffer.byteLength(text, "utf8") <= budget) {
		return { text, digest: digestOf(text) };
	}
	text = render(project, decisionHeader, null);
	if (Buffer.byteLength(text, "utf8") <= budget) {
		return { text, digest: digestOf(text) };
	}
	const room = Math.max(500, budget - 200);
	const truncated = Buffer.from(project ?? "", "utf8").subarray(0, room).toString("utf8");
	text = render(`${truncated}\n\n[truncated to fit the injection budget]`, null, null);
	return { text, digest: digestOf(text) };
}

/**
 * Stable content digest used to skip re-injecting an unchanged block.
 * @param text - the rendered block.
 * @returns a hex digest.
 */
function digestOf(text) {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ *
 * The end-of-turn nudge
 * ------------------------------------------------------------------ */

/**
 * The short reminder that goes back to the model when a working turn recorded
 * nothing. It carries the single admission test and the routing table, because
 * those are the whole of the upstream `checkpoint` skill.
 */
/**
 * The one-time bootstrap instruction, injected while PROJECT.md is still empty.
 *
 * This is the half of the upstream `memory-init` skill a scaffold cannot do by
 * itself: writing three files from a template tells a future session nothing
 * about the project. The survey — read the README, the build and test config,
 * the entry point, the layout, and actually run the test command — has to be
 * done by the model, so the plugin asks for it and then stops asking.
 */
const BOOTSTRAP_TEXT = `===== PROJECT MEMORY IS EMPTY — BOOTSTRAP IT =====

\`memory/\` was just created and \`PROJECT.md\` still has no real content. Before doing other work in this session, survey the project and fill it in:

1. Read the README, the build and test config, the entry point, and the directory layout. If there is a test command, run it and record whether it passed.
2. Write \`PROJECT.md\` with the \`memory_checkpoint\` tool — its five sections in order: What this is / Run and test / Where things live / State / Traps. **Every claim must come from a file you read or a command you ran.** A section with nothing real in it stays \`none yet\`.
3. Seed one real entry in \`SESSIONS.md\` for this setup run, and any choice the project has already settled into \`DECISIONS.md\`.

Do this once. After that, \`PROJECT.md\` is edited in place only when something changes what the project is or how to run it.`;

const NUDGE_TEXT = `Before this turn ends: did anything become true that a future session would have to rediscover?

Record it with the \`memory_checkpoint\` tool. Apply one test to every candidate: **would a future session waste time, or repeat a mistake, without this?** A candidate that fails is dropped, not shortened.

- changes what the project is, or how to run it → \`PROJECT.md\` (edited in place)
- a settled choice and the alternative it beat → \`DECISIONS.md\` (newest at top)
- what this session did, and how it was verified → \`SESSIONS.md\` (newest at top)

If nothing passes the test, say so and stop — recording nothing is a valid outcome.`;

/* ------------------------------------------------------------------ *
 * Workspace registry
 *
 * The host half remembers every workspace it has ever scaffolded, in one
 * JSON file under DSH_HOME, so the Settings UI can list them. The registry
 * is an index only: the three memory files stay the single source of truth,
 * and a workspace whose files were deleted still appears here as cleared.
 * ------------------------------------------------------------------ */

const REGISTRY_VERSION = 1;

/** Absolute path of the workspace registry file. */
function registryFile() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "project-memory", "registry.json");
}

/**
 * Read the registry, tolerating a missing or corrupt file.
 * @returns the registry object.
 */
function readRegistry() {
	const empty = { version: REGISTRY_VERSION, workspaces: {} };
	const text = readTextOrNull(registryFile());
	if (text === null) return empty;
	try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && typeof parsed.workspaces === "object" && parsed.workspaces !== null) return parsed;
	} catch {
		/* a corrupt registry must never break a session */
	}
	return empty;
}

/**
 * Persist the registry.
 * @param registry - the registry object to write.
 */
function writeRegistry(registry) {
	writeText(registryFile(), `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * Record (or refresh) one workspace in the registry.
 * @param paths - resolved project/memory paths.
 * @param bootBlockFile - the instruction file the boot block was written to.
 */
function rememberWorkspace(paths, bootBlockFile) {
	try {
		const registry = readRegistry();
		const now = new Date().toISOString();
		const existing = registry.workspaces[paths.root];
		registry.workspaces[paths.root] = {
			memoryDir: paths.memoryDir,
			bootBlockFile,
			firstSeen: existing?.firstSeen ?? now,
			lastSeen: now,
		};
		writeRegistry(registry);
	} catch (error) {
		/* registry bookkeeping is never worth failing a session over */
		void error;
	}
}

/**
 * Seed the registry from sessions this harness already knows about.
 *
 * The registry only learns about a workspace on that workspace's first pre-step
 * after this feature exists, so a project scaffolded by an earlier version would
 * be invisible until someone opened a session there again. Any live session whose
 * working directory already holds a `memory/PROJECT.md` is therefore folded in.
 *
 * @param ctx - plugin context.
 * @param cfg - normalized config.
 */
function seedRegistryFromSessions(ctx, cfg) {
	try {
		const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
		if (sessions === undefined || typeof sessions.list !== "function") return;
		const registry = readRegistry();
		let changed = false;
		for (const session of sessions.list()) {
			const cwd = session?.header?.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) continue;
			const root = resolveProjectRoot(cwd, cfg);
			if (registry.workspaces[root] !== undefined) continue;
			const memoryDir = join(root, cfg.memoryDirName);
			if (!isFile(join(memoryDir, FILE_PROJECT))) continue;
			const now = new Date().toISOString();
			registry.workspaces[root] = { memoryDir, bootBlockFile: cfg.bootBlockFile, firstSeen: now, lastSeen: now };
			changed = true;
		}
		if (changed) writeRegistry(registry);
	} catch (error) {
		/* seeding is best-effort bookkeeping */
		void error;
	}
}

/* ------------------------------------------------------------------ *
 * Web API (Settings UI)
 * ------------------------------------------------------------------ */

/**
 * Build a JSON response.
 * @param value - the body.
 * @param status - HTTP status.
 * @returns a Fetch Response.
 */
function jsonResponse(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

/** Path prefix the Settings UI talks to on the web server. */
const API_PREFIX = "/project-memory";

/**
 * Last observed memory activity, held for the composer indicator.
 *
 * In-process and single-valued on purpose: the indicator answers "what is this
 * plugin doing right now, and when did it last sync", which is one fact about
 * the process, not one fact per workspace.
 */
const activity = {
	phase: "idle",
	at: 0,
	workspace: null,
	lastSyncAt: null,
	lastSyncFile: null,
};

/**
 * Record a phase transition.
 * @param phase - `recording` while a checkpoint writes, `updating` while a long write runs, `done` after either.
 * @param workspace - the workspace the activity belongs to.
 * @param extra - fields to merge, e.g. `lastSyncAt`.
 */
function markActivity(phase, workspace, extra = {}) {
	activity.phase = phase;
	activity.at = Date.now();
	if (typeof workspace === "string" && workspace.length > 0) activity.workspace = workspace;
	Object.assign(activity, extra);
}

/**
 * Newest mtime across one workspace's three memory files.
 * @param root - workspace root, or null.
 * @returns epoch milliseconds, or null when nothing is readable.
 */
function newestMemoryMtime(root) {
	if (typeof root !== "string" || root.length === 0) return null;
	const memoryDir = join(root, cfgMemoryDirFallback());
	let newest = null;
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS]) {
		try {
			const info = statSync(join(memoryDir, fileName));
			// NTFS reports sub-millisecond mtime; floor it so a freshly written file
			// can never look like it synced a fraction of a millisecond in the future.
			const stamp = Math.floor(info.mtimeMs);
			if (newest === null || stamp > newest) newest = stamp;
		} catch {
			/* a missing file simply does not contribute a time */
		}
	}
	return newest;
}

/**
 * Status for **one** workspace, addressed by the calling session's directory.
 *
 * The chip lives inside a session, so it must answer for that session's
 * workspace alone: "none" when that workspace holds no memory at all, otherwise
 * its own newest file time. The in-process `activity` phase is consulted only
 * when it belongs to this same workspace — a neighbouring workspace's write must
 * never be reported as this one's.
 *
 * @param cwd - the calling session's working directory.
 * @param cfg - normalized config.
 * @returns the per-workspace status, plus the host clock as `now`.
 */
function statusFor(cwd, cfg) {
	const now = Date.now();
	const blank = { phase: "none", at: 0, workspace: null, lastSyncAt: null, lastSyncFile: null, now };
	if (typeof cwd !== "string" || cwd.length === 0) return blank;
	const root = resolveProjectRoot(cwd, cfg);
	const memoryDir = join(root, cfg.memoryDirName);
	const hasMemory = [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS].some((fileName) => isFile(join(memoryDir, fileName)));
	if (!hasMemory) return { ...blank, workspace: root };
	const mine = activity.workspace === root;
	return {
		phase: mine ? activity.phase : "idle",
		at: mine ? activity.at : 0,
		workspace: root,
		lastSyncAt: newestMemoryMtime(root),
		lastSyncFile: mine ? activity.lastSyncFile : null,
		now,
	};
}

/**
 * Whether a request came from this machine.
 *
 * A raw `webServer` route carries no authentication of its own, and two of these
 * endpoints mutate files, so they are fenced to loopback. Deployments that bind
 * a non-loopback host should keep that fence.
 *
 * @param req - the incoming message.
 * @returns true when the peer address is loopback.
 */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Write a JSON body onto a node response.
 * @param res - the server response.
 * @param status - HTTP status.
 * @param value - the body.
 */
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(body);
}

/**
 * Adapt a node request into a Fetch Request so the route handlers can be written
 * once against the Fetch shape.
 * @param req - the incoming message.
 * @param url - the parsed URL.
 * @returns a Fetch Request.
 */
async function toRequest(req, url) {
	const method = (req.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") return new Request(url, { method });
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return new Request(url, { method, body: Buffer.concat(chunks), headers: { "content-type": "application/json" } });
}

/**
 * Write a Fetch Response onto a node response.
 * @param res - the server response.
 * @param response - the Fetch response.
 */
async function sendResponse(res, response) {
	const headers = {};
	for (const [key, value] of response.headers) headers[key] = value;
	res.writeHead(response.status, headers);
	res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * One workspace's live state, merging the registry entry with the disk.
 * @param root - workspace root.
 * @param meta - registry metadata for that root.
 * @returns the summary sent to the UI.
 */
function workspaceSummary(root, meta) {
	const memoryDir = meta?.memoryDir ?? join(root, cfgMemoryDirFallback(), "memory");
	const contents = {};
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS]) {
		const text = readTextOrNull(join(memoryDir, fileName));
		contents[fileName] = text;
	}
	const present = Object.values(contents).filter((text) => text !== null).length;
	return {
		root,
		memoryDir,
		firstSeen: meta?.firstSeen ?? null,
		lastSeen: meta?.lastSeen ?? null,
		exists: present > 0,
		empty: isProjectEmpty(contents[FILE_PROJECT]),
		files: Object.fromEntries(
			Object.entries(contents).map(([fileName, text]) => [fileName, text === null ? null : { bytes: Buffer.byteLength(text, "utf8") }]),
		),
	};
}

/** The default memory directory name, used when a registry entry has none. */
function cfgMemoryDirFallback() {
	return "memory";
}

/**
 * Remove our boot block from an instruction file, restoring it byte-for-byte.
 * @param text - current file text.
 * @returns `{text, removed}` where text is null when the file should be deleted.
 */
function stripBootBlock(text) {
	const block = bootBlockText();
	const withLeadingBreak = `\n\n${block}`;
	if (text.includes(withLeadingBreak)) {
		const next = text.replace(withLeadingBreak, "").trimEnd();
		return { text: next.length === 0 ? null : `${next}\n`, removed: true };
	}
	const index = text.indexOf(BOOT_BLOCK_MARKER);
	if (index === -1) return { text, removed: false };
	const next = text.slice(0, index).trimEnd();
	return { text: next.length === 0 ? null : `${next}\n`, removed: true };
}

/**
 * Delete a workspace's three memory files and withdraw the boot block.
 * The registry entry survives on purpose: the workspace stays listed, and the
 * next session in it scaffolds the three files again from the templates.
 * @param root - workspace root.
 * @returns what was removed.
 */
function clearWorkspace(root) {
	const registry = readRegistry();
	const meta = registry.workspaces[root];
	if (meta === undefined) throw new Error(`未记录的工作区：${root}`);
	const memoryDir = meta.memoryDir ?? join(root, cfgMemoryDirFallback());
	const cleared = [];
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS]) {
		const target = join(memoryDir, fileName);
		if (isFile(target)) {
			rmSync(target);
			cleared.push(fileName);
		}
	}
	try {
		if (isDirectory(memoryDir) && readdirSync(memoryDir).length === 0) rmSync(memoryDir, { recursive: true });
	} catch {
		/* leaving an empty directory behind is harmless */
	}
	let bootBlockRemoved = false;
	const bootPath = join(root, meta.bootBlockFile ?? "AGENTS.md");
	const existing = readTextOrNull(bootPath);
	if (existing !== null && existing.includes(BOOT_BLOCK_MARKER)) {
		const stripped = stripBootBlock(existing);
		if (stripped.removed) {
			if (stripped.text === null) rmSync(bootPath);
			else writeText(bootPath, stripped.text);
			bootBlockRemoved = true;
		}
	}
	return { cleared, bootBlockRemoved };
}


/**
 * Register the Settings-UI endpoints when a web carrier is present.
 *
 * `connection` is injected conditionally rather than declared in `inject`, so
 * headless and TUI profiles without a web carrier still load the plugin.
 *
 * @param ctx - plugin context.
 * @param cfg - normalized config.
 */
function registerWebApi(ctx, cfg) {
	const install = (hostCtx) => {
		const webServer = typeof hostCtx.get === "function" ? hostCtx.get("webServer") : Reflect.get(hostCtx, "webServer");
		if (webServer === undefined || typeof webServer.register !== "function") {
			ctx.logger.warn("project-memory: no webServer service, Settings UI endpoints not registered");
			return;
		}
		const routes = [
			{
				path: "/project-memory/workspaces",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async () => {
					// Sessions exist by the time the UI asks, unlike at plugin activation.
					seedRegistryFromSessions(ctx, cfg);
					const registry = readRegistry();
					const workspaces = Object.entries(registry.workspaces)
						.map(([root, meta]) => workspaceSummary(root, meta))
						.sort((left, right) => String(right.lastSeen ?? "").localeCompare(String(left.lastSeen ?? "")));
					return jsonResponse({ workspaces, registry: registryFile() });
				},
			},
			{
				path: "/project-memory/init",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const cwd = String(body?.cwd ?? "");
						if (cwd.length === 0) throw new Error("缺少 cwd 参数");
						const root = resolveProjectRoot(cwd, cfg);
						const paths = { cwd, root, memoryDir: join(root, cfg.memoryDirName) };
						const result = ensureScaffold(paths, cfg);
						rememberWorkspace(paths, cfg.bootBlockFile);
						markActivity("done", root, { lastSyncAt: Date.now(), lastSyncFile: result.created.join(", ") || "boot block" });
						return jsonResponse({ root, created: result.created, bootBlockAdded: result.bootBlockAdded });
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/project-memory/files",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async (request) => {
					const root = new URL(request.url).searchParams.get("root");
					if (root === null || root.length === 0) return jsonResponse({ error: "缺少 root 参数" }, 400);
					const registry = readRegistry();
					const meta = registry.workspaces[root];
					const memoryDir = meta?.memoryDir ?? join(root, cfg.memoryDirName);
					const files = {};
					for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS]) {
						const text = readTextOrNull(join(memoryDir, fileName));
						if (text === null) {
							files[fileName] = null;
							continue;
						}
						let mtime = null;
						try {
							mtime = Math.floor(statSync(join(memoryDir, fileName)).mtimeMs);
						} catch {
							/* the file vanished between read and stat */
						}
						files[fileName] = { text, bytes: Buffer.byteLength(text, "utf8"), mtime };
					}
					return jsonResponse({ root, memoryDir, files });
				},
			},
			{
				path: "/project-memory/save",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const root = String(body?.root ?? "");
						const fileName = String(body?.file ?? "");
						if (root.length === 0) throw new Error("缺少 root 参数");
						if (![FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS].includes(fileName)) throw new Error(`不允许写入 ${fileName}`);
						if (typeof body?.text !== "string") throw new Error("缺少 text 参数");
						const registry = readRegistry();
						const meta = registry.workspaces[root];
						if (meta === undefined) throw new Error(`未记录的工作区：${root}`);
						const target = join(meta.memoryDir ?? join(root, cfg.memoryDirName), fileName);
						writeText(target, body.text);
						markActivity("done", root, { lastSyncAt: Date.now(), lastSyncFile: fileName });
						return jsonResponse({ saved: fileName, bytes: Buffer.byteLength(body.text, "utf8") });
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/project-memory/forget",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const root = String(body?.root ?? "");
						const registry = readRegistry();
						if (registry.workspaces[root] === undefined) throw new Error(`未记录的工作区：${root}`);
						delete registry.workspaces[root];
						writeRegistry(registry);
						return jsonResponse({ forgotten: root });
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/project-memory/status",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async (request) => jsonResponse(statusFor(new URL(request.url).searchParams.get("cwd"), cfg)),
			},
			{
				path: "/project-memory/clear",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const result = clearWorkspace(String(body?.root ?? ""));
						return jsonResponse(result);
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
		];
		hostCtx.effect(
			() => {
				const dispose = webServer.register({
					kind: "prefix",
					path: API_PREFIX,
					handler: async (req, res) => {
						if (!isLoopback(req)) {
							sendJson(res, 403, { error: "仅允许本机访问" });
							return;
						}
						const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
						const route = routes.find((candidate) => candidate.path === url.pathname);
						if (route === undefined) {
							sendJson(res, 404, { error: `未知端点：${url.pathname}` });
							return;
						}
						try {
							await sendResponse(res, await route.fetch(await toRequest(req, url)));
						} catch (error) {
							sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
						}
					},
				});
				return () => dispose();
			},
			"project-memory: settings ui routes",
		);
		ctx.logger.info("project-memory: Settings UI routes registered at %s", API_PREFIX);
	};
	// Prefer a direct registration; fall back to waiting for the service to appear.
	if (typeof ctx.get === "function" && ctx.get("webServer") !== undefined) install(ctx);
	else ctx.inject(["webServer"], install);
}

/**
 * Split a newest-first memory file into its header and its entry blocks.
 * @param text - the file text.
 * @returns `{header, entries}` in file order.
 */
function splitEntries(text) {
	const records = annotateFences(text);
	const starts = [];
	for (let index = 0; index < records.length; index++) {
		if (!records[index].inFence && /^##\s+\S/.test(records[index].line)) starts.push(index);
	}
	if (starts.length === 0) return { header: text, entries: [] };
	const header = records
		.slice(0, starts[0])
		.map((record) => record.line)
		.join("\n");
	const entries = [];
	for (let index = 0; index < starts.length; index++) {
		const from = starts[index];
		const to = index + 1 < starts.length ? starts[index + 1] : records.length;
		entries.push(
			records
				.slice(from, to)
				.map((record) => record.line)
				.join("\n")
				.trimEnd(),
		);
	}
	return { header, entries };
}

const ARCHIVE_HEADER = `# SESSIONS ARCHIVE

> Session entries moved out of \`SESSIONS.md\` so the live log stays short and its
> injection stays cheap. Newest at top, same shape as \`SESSIONS.md\`.
> This file is **never injected** — read it only when you need older history.
`;

/**
 * Keep SESSIONS.md bounded by moving its oldest entries into an archive file.
 *
 * This is the plugin's own answer to "do not let the context grow without bound":
 * the live log stays short enough to inject cheaply, while nothing is destroyed.
 * Deterministic on purpose — no model call, so housekeeping never costs tokens.
 *
 * @param memoryDir - the workspace's memory directory.
 * @param cfg - normalized config.
 * @returns how many entries were moved.
 */
function archiveSessionsIfNeeded(memoryDir, cfg) {
	const max = cfg.sessionsMaxEntries;
	if (!Number.isFinite(max) || max <= 0) return 0;
	const target = join(memoryDir, FILE_SESSIONS);
	const text = readTextOrNull(target);
	if (text === null) return 0;
	const { header, entries } = splitEntries(text);
	if (entries.length <= max) return 0;
	const keep = entries.slice(0, max);
	const moved = entries.slice(max);
	const archivePath = join(memoryDir, FILE_SESSIONS_ARCHIVE);
	const archive = readTextOrNull(archivePath) ?? ARCHIVE_HEADER;
	writeText(archivePath, `${archive.trimEnd()}\n\n${moved.join("\n\n")}\n`);
	writeText(target, `${header.trimEnd()}\n\n${keep.join("\n\n")}\n`);
	return moved.length;
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Register the project-memory behaviour on the harness.
 * @param ctx - the plugin context.
 * @param config - loader-supplied configuration.
 */
function apply(ctx, config) {
	const cfg = normalizeConfig(config);
	if (!cfg.enabled) return;

	/** Per-session bookkeeping, keyed by the session object. */
	const sessions = new WeakMap();

	/**
	 * Get (or create) the per-session state.
	 * @param session - the agent's session.
	 * @returns the mutable state record.
	 */
	const stateOf = (session) => {
		let state = sessions.get(session);
		if (state === undefined) {
			state = {
				paths: null,
				scaffolded: false,
				injected: false,
				digest: null,
				workThisTurn: false,
				wroteThisTurn: false,
				nudges: 0,
				lastNudgeAt: 0,
			};
			sessions.set(session, state);
		}
		return state;
	};

	/**
	 * Resolve the project root and memory directory for one agent.
	 * @param agent - the running agent.
	 * @returns `{root, memoryDir}`.
	 */
	const pathsFor = (agent) => {
		const cwd = agent?.session?.header?.cwd ?? process.cwd();
		const root = resolveProjectRoot(cwd, cfg);
		return { cwd, root, memoryDir: join(root, cfg.memoryDirName) };
	};

	/* --- Settings UI endpoints (web profiles only) ------------------- */

	seedRegistryFromSessions(ctx, cfg);
	registerWebApi(ctx, cfg);

	/* --- turn bookkeeping ------------------------------------------- */

	ctx.on("session/event", (session, event) => {
		if (event?.type !== "turn/start") return;
		const state = stateOf(session);
		state.workThisTurn = false;
		state.wroteThisTurn = false;
	});

	ctx.on("tools/result", (exec) => {
		const session = exec?.agent?.session;
		if (session === undefined) return;
		stateOf(session).workThisTurn = true;
	});

	/* --- scaffold + inject at the head of every step ---------------- */

	ctx.on("agent/pre-step", async ({ agent }, next) => {
		const downstream = await next();
		if (downstream?.kind !== "enter") return downstream;
		if (agent?.session === undefined) return downstream;
		const state = stateOf(agent.session);
		if (state.paths === null) state.paths = pathsFor(agent);

		if (!state.scaffolded) {
			state.scaffolded = true;
			if (cfg.autoScaffold) {
				try {
					const result = ensureScaffold(state.paths, cfg);
					if (result.created.length > 0 || result.bootBlockAdded) {
						ctx.logger.info(
							"project-memory: scaffolded %s%s in %s",
							result.created.join(", ") || "(nothing)",
							result.bootBlockAdded ? " + boot block" : "",
							state.paths.root,
						);
						markActivity("done", state.paths.root, {
							lastSyncAt: Date.now(),
							lastSyncFile: result.created.join(", ") || "boot block",
						});
					}
				} catch (error) {
					ctx.logger.warn("project-memory: scaffold failed: %o", error);
				}
			}
			// Registered even when scaffolding is off: the Settings UI should list
			// every workspace this plugin has been in, not only what it created.
			rememberWorkspace(state.paths, cfg.bootBlockFile);
		}

		if (!cfg.injectOnSessionStart) return downstream;
		let built;
		try {
			built = buildInjection(state.paths, cfg);
		} catch (error) {
			ctx.logger.warn("project-memory: injection render failed: %o", error);
			return downstream;
		}
		if (built === null) return downstream;
		let text = built.text;
		let digest = built.digest;
		if (cfg.bootstrapWhenEmpty && isProjectEmpty(readTextOrNull(join(state.paths.memoryDir, FILE_PROJECT)))) {
			text = `${text}\n\n${BOOTSTRAP_TEXT}`;
			digest = digestOf(text);
		}
		if (state.injected && state.digest === digest) return downstream;
		state.injected = true;
		state.digest = digest;
		return {
			...downstream,
			messages: [
				...downstream.messages,
				createUserMessage({
					content: [{ type: "text", text }],
					source: { ...PLUGIN_SOURCE, form: "project-memory", baseline: true },
				}),
			],
		};
	});

	/* --- bounded end-of-turn nudge ---------------------------------- */

	ctx.on("agent/turn-stopping", async ({ agent }) => {
		if (!cfg.nudgeOnTurnEnd) return;
		if (agent?.session === undefined) return;
		const state = stateOf(agent.session);
		if (!state.workThisTurn || state.wroteThisTurn) return;
		if (state.nudges >= cfg.nudgeMaxPerSession) return;
		const now = Date.now();
		if (now - state.lastNudgeAt < cfg.nudgeCooldownMs) return;
		state.nudges += 1;
		state.lastNudgeAt = now;
		agent.steer(
			createUserMessage({
				content: [{ type: "text", text: NUDGE_TEXT }],
				source: { ...PLUGIN_SOURCE, form: "project-memory-nudge" },
			}),
		);
	});

	/* --- model-facing tools ----------------------------------------- */

	ctx.tools.register(
		defineTool({
			name: "memory_checkpoint",
			description:
				"Record what a future session must know into this project's memory files (`memory/PROJECT.md`, `memory/DECISIONS.md`, `memory/SESSIONS.md`). " +
				"Apply one test to every candidate line: would a future session waste time, or repeat a mistake, without this? A candidate that fails is dropped, not shortened. " +
				"Routing: something that changes what the project is or how to run it goes to `project` (edited in place); a settled choice and the alternative it beat goes to `decisions` (newest at top); what this session did and how it was verified goes to `sessions` (newest at top). " +
				"Recording nothing is a valid outcome — do not pad.",
			parameters: {
				sessions: {
					type: "array",
					description: "Entries for SESSIONS.md, newest first. The date is stamped by the plugin.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							done: { type: "string", required: true, description: "What is now true, and how it was verified. Without the verification this is a claim, not a record." },
							open: { type: "string", description: "What is unfinished." },
							next: { type: "string", description: "The one concrete next action." },
						},
					},
				},
				decisions: {
					type: "array",
					description: "Entries for DECISIONS.md, newest first. Record that a decision was made; do not invent one.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							choice: { type: "string", required: true, description: "The choice, one line." },
							over: { type: "string", description: "The alternative that was rejected, and why." },
							because: { type: "string", description: "The constraint that forced it." },
						},
					},
				},
				project: {
					type: "array",
					description: "In-place replacements of PROJECT.md sections. Only use this when the fact changes what the project is or how it runs.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							section: { type: "string", required: true, enum: [...PROJECT_SECTIONS], description: "Which fixed section to replace." },
							text: { type: "string", required: true, description: "The new body for that section. Write `none yet` when there is genuinely nothing." },
						},
					},
				},
				notes: {
					type: "string",
					description: "Anything you noticed that looks stale, duplicated or wrong but must NOT be deleted unilaterally. Reported to the user instead.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						summary: { type: "string", required: true },
						written: {
							type: "array",
							required: true,
							items: { type: "string" },
						},
					},
				},
				render: (_args, value) => [{ type: "text", text: value.summary }],
			},
			execute(args, exec) {
				const agent = exec?.agent;
				if (agent?.session === undefined) throw new Error("memory_checkpoint requires an owning agent session");
				const state = stateOf(agent.session);
				if (state.paths === null) state.paths = pathsFor(agent);
				const { memoryDir } = state.paths;
				const written = [];
				const date = todayISO();
				markActivity("recording", state.paths.root);

				const sessionEntries = Array.isArray(args.sessions) ? args.sessions : [];
				for (const entry of [...sessionEntries].reverse()) {
					const lines = [`## ${date}`];
					lines.push(`Done: ${String(entry.done).trim()}`);
					if (entry.open !== undefined && String(entry.open).trim().length > 0) lines.push(`Open: ${String(entry.open).trim()}`);
					if (entry.next !== undefined && String(entry.next).trim().length > 0) lines.push(`Next: ${String(entry.next).trim()}`);
					const target = join(memoryDir, FILE_SESSIONS);
					writeText(target, insertEntryAtTop(readTextOrNull(target) ?? templateText(FILE_SESSIONS), lines.join("\n")));
					written.push(`${FILE_SESSIONS}: ${lines[0]}`);
				}

				const decisions = Array.isArray(args.decisions) ? args.decisions : [];
				for (const entry of [...decisions].reverse()) {
					const choice = String(entry.choice).trim();
					const lines = [`## ${date} — ${choice}`, `Chose: ${choice}`];
					if (entry.over !== undefined && String(entry.over).trim().length > 0) lines.push(`Over: ${String(entry.over).trim()}`);
					if (entry.because !== undefined && String(entry.because).trim().length > 0) lines.push(`Because: ${String(entry.because).trim()}`);
					const target = join(memoryDir, FILE_DECISIONS);
					writeText(target, insertEntryAtTop(readTextOrNull(target) ?? templateText(FILE_DECISIONS), lines.join("\n")));
					written.push(`${FILE_DECISIONS}: ${choice}`);
				}

				const projectEdits = Array.isArray(args.project) ? args.project : [];
				for (const edit of projectEdits) {
					const target = join(memoryDir, FILE_PROJECT);
					const current = readTextOrNull(target) ?? templateText(FILE_PROJECT);
					const next = replaceSection(current, String(edit.section), String(edit.text));
					if (next === null) {
						writeText(target, `${current.trimEnd()}\n\n## ${String(edit.section)}\n\n${String(edit.text).trim()}\n`);
					} else {
						writeText(target, next);
					}
					written.push(`${FILE_PROJECT}: ${String(edit.section)}`);
				}

				if (written.length > 0) {
					state.wroteThisTurn = true;
					// Bound the live log before reporting the write, so the injected
					// block never carries more entries than the budget assumes.
					let archived = 0;
					try {
						archived = archiveSessionsIfNeeded(memoryDir, cfg);
					} catch (error) {
						ctx.logger.warn("project-memory: archive failed: %o", error);
					}
					if (archived > 0) written.push(`${FILE_SESSIONS} → ${FILE_SESSIONS_ARCHIVE} ×${archived}`);
					markActivity("done", state.paths.root, { lastSyncAt: Date.now(), lastSyncFile: written.join(", ") });
				} else {
					markActivity("idle", state.paths.root);
				}

				const notes = args.notes === undefined ? "" : String(args.notes).trim();
				const summaryParts = [];
				summaryParts.push(written.length === 0 ? "Nothing recorded — no candidate passed the test." : `Recorded ${written.length} item(s): ${written.join("; ")}.`);
				if (notes.length > 0) summaryParts.push(`Left untouched for your review: ${notes}`);
				return Promise.resolve({ summary: summaryParts.join(" "), written });
			},
			presentCall: (args) => ({
				card: "generic",
				title: "Record project memory",
				kind: "other",
				rawInput: args,
			}),
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "memory_read",
			description:
				"Read this project's memory files. Use only when you need a section that was not auto-loaded — the three files are already in context at the start of every session.",
			parameters: {
				file: {
					type: "string",
					required: true,
					enum: [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS],
					description: "Which memory file to read.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						content: { type: "string", required: true },
						path: { type: "string", required: true },
					},
				},
				render: (_args, value) => [{ type: "text", text: value.content }],
			},
			execute(args, exec) {
				const agent = exec?.agent;
				if (agent?.session === undefined) throw new Error("memory_read requires an owning agent session");
				const state = stateOf(agent.session);
				if (state.paths === null) state.paths = pathsFor(agent);
				const target = join(state.paths.memoryDir, String(args.file));
				const content = readTextOrNull(target);
				if (content === null) throw new Error(`no memory file at ${target} — is this a project with a memory directory?`);
				return Promise.resolve({ content, path: target });
			},
			presentCall: (args) => ({
				card: "generic",
				title: `Read ${String(args.file)}`,
				kind: "other",
				rawInput: args,
			}),
		}),
	);
}

export { Config, apply, inject, name };
