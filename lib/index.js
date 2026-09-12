/**
 * dsh-trilogy — per-project memory for DeepSeek Harness.
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
 * The three files divide by question, not by topic (see DESIGN.md):
 *   PROJECT.md   what the project is right now  — edited in place, one screen
 *   DECISIONS.md why it is that way             — append only, newest at top
 *   SESSIONS.md  what happened, and when        — append only, newest at top
 *
 * @module dsh-trilogy
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
const name = "trilogy";

/** Services this plugin needs. `tools` carries the model-facing tool registry. */
const inject = ["tools"];

/** The `{kind:'plugin'}` source stamped on everything this plugin injects. */
const PLUGIN_SOURCE = { kind: "plugin", plugin: name };

const FILE_PROJECT = "PROJECT.md";
const FILE_DECISIONS = "DECISIONS.md";
const FILE_SESSIONS = "SESSIONS.md";
/** Overflow from SESSIONS.md. Never injected — it exists so the live log can stay short. */
const FILE_SESSIONS_ARCHIVE = "SESSIONS-archive.md";

/** The fixed section order of PROJECT.md. Empty sections read `暂无`. */
const PROJECT_SECTIONS = ["这是什么", "怎么跑和怎么测", "东西都在哪", "现状", "坑"];

/**
 * The headings this plugin wrote before the memory files were Chinese.
 *
 * A workspace scaffolded by an older version keeps them until it is opened;
 * `sectionBody` and `replaceSection` accept both spellings, and the rename below
 * is applied in place the first time a session touches the workspace. Only the
 * label line moves — every body stays exactly where it was.
 */
const LEGACY_SECTION_NAMES = {
	"这是什么": ["What this is"],
	"怎么跑和怎么测": ["Run and test"],
	"东西都在哪": ["Where things live"],
	"现状": ["State"],
	"坑": ["Traps"],
};

/** The body that means "nothing here yet". */
const EMPTY_SECTION = "暂无";

/** The same thing, as older files spell it; accepted on read. */
const LEGACY_EMPTY_SECTION = "none yet";

/** Idempotency marker for the boot block so re-runs never duplicate it. */
const BOOT_BLOCK_MARKER = "<!-- dsh-trilogy -->";

/**
 * Every boot-block marker this plugin has ever written.
 *
 * Renaming the plugin changes the marker, and an idempotency check that knows
 * only the current name appends a second block instead of recognising the
 * first - which is exactly what the rename to dsh-trilogy did.
 */
const BOOT_BLOCK_MARKER_PATTERN = /<!-- dsh-[a-z0-9-]+ -->/;

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ *
 * Templates
 *
 * Read from ./templates at runtime so a user can edit them in place;
 * the embedded copies keep the plugin working if the directory is
 * missing (single-file installs, bundlers, packaged tarballs).
 * ------------------------------------------------------------------ */

const FALLBACK_TEMPLATES = {
	[FILE_PROJECT]: `# PROJECT\n\n> 这个项目**现在**是什么。就地编辑，控制在一屏内。\n> 这里写的内容和代码冲突时，以代码为准，并在同一次改动里把这个文件改对。\n\n## 这是什么\n\n暂无\n\n## 怎么跑和怎么测\n\n暂无\n\n## 东西都在哪\n\n暂无\n\n## 现状\n\n暂无\n\n## 坑\n\n暂无\n`,

	[FILE_DECISIONS]: `# DECISIONS\n\n> 已经定下来的选择，以及为什么。**只追加，最新在最上。**\n> 定下来的选择要靠**商量**重开，不能悄悄绕过去。\n>\n> 条目形状：\n>\n> \`\`\`\n> ## YYYY-MM-DD — <选择，一行>\n> 选择：决定了什么\n> 放弃：被否决的替代，以及为什么\n> 因为：逼出这个决定的约束\n> \`\`\`\n`,

	[FILE_SESSIONS]: `# SESSIONS\n\n> 发生了什么，什么时候。**只追加，最新在最上。**\n>\n> 条目形状：\n>\n> \`\`\`\n> ## YYYY-MM-DD\n> 完成：现在是真的是什么，以及怎么验证的\n> 未完成：还没做完的\n> 下一步：一个具体的下一步\n> \`\`\`\n>\n> 只写「完成」而没有验证，那是主张，不是记录。没验证的就写没验证。\n`,
};

const FALLBACK_BOOT_BLOCK = `## Memory\n\n这个项目的连续性在 \`memory/\` 里。\`PROJECT.md\`、\`DECISIONS.md\`、\`SESSIONS.md\`\n每个会话开始时自动加载 —— 不要再读一遍，也不用复述，直接用。\n\n- \`PROJECT.md\` 是**现在**的状态。它和代码冲突时以代码为准，并在同一次改动里把它改对。\n- \`DECISIONS.md\` 是已经定下来的选择。定下来的选择要靠**商量**重开，不能悄悄绕过去。\n- \`SESSIONS.md\` 是发生过什么的流水。\n\n用 \`memory_checkpoint\` 工具记录「未来的会话否则得重新发现」的东西。每条候选都过一遍这个\n判据：**没有这条，未来的会话会不会浪费时间，或者重犯同一个错？** 不合格的候选是**丢掉，\n不是删短**。\n`;

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
	// A ceiling the assembler stops degrading at, NOT a size it fills to. The block
// is only ever as big as PROJECT.md + DECISIONS.md + `sessionEntriesInjected`
// session entries -- SESSIONS.md in full is never injected, however large this is.
	injectBudgetBytes: z.number().default(64000),
	// This is the knob that decides how much of the log reaches every session.
	// The budget only decides when the assembler starts degrading.
	sessionEntriesInjected: z.number().default(15),
	nudgeOnTurnEnd: z.boolean().default(true),
	nudgeCooldownMs: z.number().default(600000),
	nudgeMaxPerSession: z.number().default(3),
	sessionsMaxEntries: z.number().default(200),
	projectStaleDays: z.number().default(14),
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
		injectBudgetBytes: input.injectBudgetBytes ?? 64000,
		sessionEntriesInjected: input.sessionEntriesInjected ?? 15,
		nudgeOnTurnEnd: input.nudgeOnTurnEnd ?? true,
		nudgeCooldownMs: input.nudgeCooldownMs ?? 600000,
		nudgeMaxPerSession: input.nudgeMaxPerSession ?? 3,
		sessionsMaxEntries: input.sessionsMaxEntries ?? 200,
		projectStaleDays: input.projectStaleDays ?? 14,
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
 * A conversation can stay open past midnight, so the date has to be read from
 * the clock rather than remembered. A plugin can simply ask the clock, so the
 * date is stamped here instead of being trusted to the model.
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
 * The current heading for a section, given either its Chinese or its legacy name.
 * @param section - a section heading, either language.
 * @returns the canonical heading.
 */
function sectionCanonical(section) {
	const wanted = String(section).trim().toLowerCase();
	for (const canonical of PROJECT_SECTIONS) {
		if (canonical.toLowerCase() === wanted) return canonical;
	}
	for (const [canonical, legacy] of Object.entries(LEGACY_SECTION_NAMES)) {
		if (legacy.some((name) => name.toLowerCase() === wanted)) return canonical;
	}
	return String(section).trim();
}

/**
 * Every heading that names this section, lowercased, canonical first.
 * @param section - a section heading, either language.
 * @returns the spellings to match against.
 */
function sectionAliases(section) {
	const canonical = sectionCanonical(section);
	return [canonical, ...(LEGACY_SECTION_NAMES[canonical] ?? [])].map((name) => name.toLowerCase());
}

/**
 * Rename the legacy English PROJECT.md headings to the current Chinese ones.
 *
 * Only the label line is touched. Runs from `ensureScaffold`, so it costs one read
 * per session and only writes when there is actually something to rename.
 *
 * @param text - PROJECT.md contents, or null.
 * @returns the new text, or null when nothing had to change.
 */
function migrateProjectHeadings(text) {
	if (text === null) return null;
	let next = text;
	for (const [canonical, legacy] of Object.entries(LEGACY_SECTION_NAMES)) {
		for (const name of legacy) {
			const pattern = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "gm");
			next = next.replace(pattern, `## ${canonical}`);
		}
	}
	return next === text ? null : next;
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
	const wanted = sectionAliases(section);
	// The canonical heading, so a section rewritten here also gets renamed.
	const heading = `## ${sectionCanonical(section)}`;
	let start = -1;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record.inFence) continue;
		const match = /^##\s+(.*\S)\s*$/.exec(record.line);
		if (match === null) continue;
		if (start === -1) {
			if (wanted.includes(match[1].trim().toLowerCase())) start = index;
			continue;
		}
		const lines = [...records.slice(0, start).map((entry) => entry.line), heading, "", ...body.trim().split("\n"), "", ...records.slice(index).map((entry) => entry.line)];
		return `${lines.join("\n").trimEnd()}\n`;
	}
	if (start === -1) return null;
	const head = [...records.slice(0, start).map((entry) => entry.line), heading];
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
	// A workspace scaffolded before the files were Chinese is renamed the first
	// time a session opens it. Cheap: one read, and a write only if something moved.
	const projectPath = join(paths.memoryDir, FILE_PROJECT);
	const migrated = migrateProjectHeadings(readTextOrNull(projectPath));
	if (migrated !== null) writeText(projectPath, migrated);

	let bootBlockAdded = false;
	if (cfg.writeBootBlock) {
		const bootPath = join(paths.root, cfg.bootBlockFile);
		const existing = readTextOrNull(bootPath);
		if (existing === null) {
			writeText(bootPath, `${bootBlockText()}`);
			bootBlockAdded = true;
		} else {
			const seen = BOOT_BLOCK_MARKER_PATTERN.exec(existing);
			if (seen === null) {
				writeText(bootPath, `${existing.trimEnd()}\n\n${bootBlockText()}`);
				bootBlockAdded = true;
			} else if (seen[0] !== BOOT_BLOCK_MARKER) {
				// A block written under an older name. The block is always appended
				// last, so everything from its marker onwards is ours to replace.
				writeText(bootPath, `${existing.slice(0, seen.index).trimEnd()}\n\n${bootBlockText()}`);
				bootBlockAdded = true;
			}
		}
	}
	return { created, bootBlockAdded };
}

/**
 * Whether PROJECT.md still holds nothing but the scaffold.
 *
 * True only when the fixed sections exist and every one of them is empty or
 * reads `暂无`. A hand-written PROJECT.md that uses its own headings is
 * treated as NOT empty, so a custom format is never nagged.
 *
 * @param text - PROJECT.md contents, or null when the file is missing.
 * @returns true when the project memory has never been filled in.
 */
function isProjectEmpty(text) {
	if (text === null) return true;
	const known = new Set([
		...PROJECT_SECTIONS.map((section) => section.toLowerCase()),
		...Object.values(LEGACY_SECTION_NAMES).flat().map((name) => name.toLowerCase()),
	]);
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
		const lowered = body.toLowerCase();
		if (body.length > 0 && lowered !== EMPTY_SECTION && lowered !== LEGACY_EMPTY_SECTION) return false;
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
		const parts = ["===== 项目记忆（每个会话自动加载，不要重复读这些文件）====="];
		if (projectText !== null && projectText !== undefined) parts.push(`--- ${FILE_PROJECT} ---\n${projectText.trimEnd()}`);
		if (decisionsText !== null && decisionsText !== undefined) parts.push(`--- ${FILE_DECISIONS} ---\n${decisionsText.trimEnd()}`);
		if (sessionsText !== null && sessionsText !== undefined && sessionsText.length > 0)
			parts.push(`--- ${FILE_SESSIONS}（最近几条）---\n${sessionsText}`);
		return parts.join("\n\n");
	};

	const decisionHeader = decisions === null ? null : decisions.split("\n").slice(0, 40).join("\n");

	// Every degradation step records what it dropped, so the model is told what it
	// cannot see instead of silently reasoning from a partial picture.
	const omitted = [];
	const finish = (produced) => {
		const footer =
			omitted.length === 0
				? ""
				: `\n\n--- 未注入（超出 ${budget} 字节预算）：${[...new Set(omitted)].join("；")}。用 memory_search 检索，或用 memory_read 读原文件。---`;
		const full = produced + footer;
		return { text: full, digest: digestOf(full) };
	};

	// Give up log entries gradually -- halve, then halve again, then keep only the
	// newest. Dropping from N entries to none in a single step is a cliff: a reader
	// is far better served by the newest few than by nothing at all.
	const wanted = Math.max(0, Math.floor(cfg.sessionEntriesInjected));
	const counts = [];
	for (let n = wanted; n > 1; n = Math.floor(n / 2)) counts.push(n);
	counts.push(wanted > 0 ? 1 : 0, 0);

	for (const n of counts) {
		const attempt = render(project, decisions, sessions === null || n === 0 ? null : topEntries(sessions, n));
		if (Buffer.byteLength(attempt, "utf8") > budget) continue;
		if (n < wanted) {
			omitted.push(
				n === 0
					? "SESSIONS.md 的全部条目（预算连一条也装不下）"
					: `SESSIONS.md 的较早条目（本次只注入最近 ${n} 条，配置是 ${wanted} 条）`,
			);
		}
		return finish(attempt);
	}

	// The log is gone by now, so DECISIONS.md goes next and PROJECT.md last.
	if (wanted > 0) omitted.push("SESSIONS.md 的全部条目（预算连一条也装不下）");
	let text = render(project, decisionHeader, null);
	if (Buffer.byteLength(text, "utf8") <= budget) return finish(text);
	omitted.push("DECISIONS.md 的正文（本次只保留开头 40 行）");
	text = render(project, null, null);
	if (Buffer.byteLength(text, "utf8") <= budget) return finish(text);
	omitted.push("PROJECT.md 的尾段");
	const room = Math.max(500, budget - 200);
	const truncated = Buffer.from(project ?? "", "utf8").subarray(0, room).toString("utf8");
	return finish(render(`${truncated}\n\n[已截断以适配注入预算]`, null, null));
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
 * those are the whole of the recording rule.
 */
/**
 * The one-time bootstrap instruction, injected while PROJECT.md is still empty.
 *
 * This is the half of the job a scaffold cannot do by
 * itself: writing three files from a template tells a future session nothing
 * about the project. The survey — read the README, the build and test config,
 * the entry point, the layout, and actually run the test command — has to be
 * done by the model, so the plugin asks for it and then stops asking.
 */
const BOOTSTRAP_TEXT = `===== 项目记忆是空的 —— 先把它填上 =====\n\n\`memory/\` 刚创建，\`PROJECT.md\` 里还没有真内容。在做这一轮的其他事之前，先调研这个项目并填上：\n\n1. 读 README、构建与测试配置、入口点、目录结构。如果有测试命令，**真的跑一遍**并记录有没有通过。\n2. 用 \`memory_checkpoint\` 工具写 \`PROJECT.md\`，它的五个小节按顺序是：这是什么 / 怎么跑和怎么测 / 东西都在哪 / 现状 / 坑。**每一条都必须来自你读过的文件或跑过的命令。** 确实没有内容的就留着 \`暂无\`。\n3. 在 \`SESSIONS.md\` 里记一条这次调研的条目；项目已经定下来的选择写进 \`DECISIONS.md\`。\n\n这件事只做一次。之后 \`PROJECT.md\` 只在这个项目「是什么」或「怎么跑」真的变了的时候就地改。`;

const NUDGE_TEXT = `这一轮结束前：有没有什么是现在变成真的、而未来的会话否则得重新发现的？\n\n有就用 \`memory_checkpoint\` 工具记下来。每条候选都过一遍这个判据：**没有这条，未来的会话会不会浪费时间，或者重犯同一个错？** 不合格的候选是**丢掉，不是删短**。\n\n- 改变「这个项目是什么」或「怎么跑」 → \`PROJECT.md\`（就地编辑）\n- 定下来的选择，以及被否决的替代 → \`DECISIONS.md\`（最新在最上）\n- 这一轮做了什么、怎么验证的 → \`SESSIONS.md\`（最新在最上）\n\n一条都不合格就直说，然后停 —— **什么都不记是合法结果**。`;

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
	return join(home, "trilogy", "registry.json");
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
const API_PREFIX = "/trilogy";

/** `kind` stamped on an exported memory bundle, so an import can refuse anything else. */
const EXPORT_KIND = "dsh-trilogy/memory-bundle";

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
 * How far `PROJECT.md` lags behind the rest of the memory directory.
 *
 * `PROJECT.md` is the only file that is *edited* rather than appended to, so it is
 * the only one that can go stale without anything failing: sessions keep appending
 * while the one-screen summary of "what this project is right now" drifts away from
 * the code. The reading is purely local — two modification times and the dates on the
 * log entries — so it costs nothing and calls no model.
 *
 * @param memoryDir - the workspace's memory directory.
 * @param cfg - normalized config.
 * @returns the staleness reading, always safe to render.
 */
function stalenessFor(memoryDir, cfg) {
	const mtimeOf = (fileName) => {
		try {
			return Math.floor(statSync(join(memoryDir, fileName)).mtimeMs);
		} catch {
			/* a missing file contributes no time */
			return null;
		}
	};
	const projectMtime = mtimeOf(FILE_PROJECT);
	const others = [mtimeOf(FILE_DECISIONS), mtimeOf(FILE_SESSIONS)].filter((value) => value !== null);
	const newestOtherMtime = others.length === 0 ? null : Math.max(...others);
	const thresholdDays = Number.isFinite(cfg.projectStaleDays) ? cfg.projectStaleDays : 14;
	if (projectMtime === null || newestOtherMtime === null) {
		return { stale: false, reason: "no-memory", projectMtime, newestOtherMtime, behindDays: 0, entriesSince: 0, thresholdDays };
	}
	const behindMs = Math.max(0, newestOtherMtime - projectMtime);
	// A calendar gap alone would flag a quiet fortnight. Counting the dated log
	// entries written after PROJECT.md was last touched says instead how many
	// sessions have landed against a summary nobody updated.
	const entriesSince = splitEntries(readTextOrNull(join(memoryDir, FILE_SESSIONS)) ?? "").entries.filter((entry) => {
		const stamp = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(entry);
		if (stamp === null) return false;
		const at = Date.parse(`${stamp[1]}T23:59:59Z`);
		return Number.isFinite(at) && at > projectMtime;
	}).length;
	return {
		stale: thresholdDays > 0 && behindMs >= thresholdDays * 86400000,
		reason: "compared",
		projectMtime,
		newestOtherMtime,
		behindDays: Math.floor(behindMs / 86400000),
		entriesSince,
		thresholdDays,
	};
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

/**
 * The instruction file a workspace's boot block lives in.
 *
 * Resolved through the registry entry first, not through today's config default: a
 * workspace keeps being addressed by the name it was registered under, so changing
 * `bootBlockFile` never makes an existing block invisible.
 *
 * @param root - workspace root.
 * @param meta - the registry entry, when there is one.
 * @param cfg - normalized config.
 * @returns the absolute path of the instruction file.
 */
function instructionPathFor(root, meta, cfg) {
	return join(root, meta?.bootBlockFile ?? cfg.bootBlockFile);
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
	const seen = BOOT_BLOCK_MARKER_PATTERN.exec(text);
	if (seen === null) return { text, removed: false };
	const index = seen.index;
	if (index === -1) return { text, removed: false };
	const next = text.slice(0, index).trimEnd();
	return { text: next.length === 0 ? null : `${next}\n`, removed: true };
}

/**
 * Delete a workspace's memory files — the archive included — and withdraw the boot
 * block. Leaving the archive behind would make the row read "已清除" while older
 * history stayed on disk and stayed searchable.
 * The registry entry survives on purpose: the workspace stays listed, and the
 * next session in it scaffolds the three files again from the templates.
 * @param root - workspace root.
 * @returns what was removed.
 */
function clearWorkspace(root, cfg) {
	const registry = readRegistry();
	const meta = registry.workspaces[root];
	if (meta === undefined) throw new Error(`未记录的工作区：${root}`);
	const memoryDir = meta.memoryDir ?? join(root, cfgMemoryDirFallback());
	const cleared = [];
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE]) {
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
	const bootPath = instructionPathFor(root, meta, cfg);
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
			ctx.logger.warn("trilogy: no webServer service, Settings UI endpoints not registered");
			return;
		}
		const routes = [
			{
				path: "/trilogy/workspaces",
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
				path: "/trilogy/init",
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
				path: "/trilogy/boot",
				methods: ["GET", "POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const url = new URL(request.url, "http://127.0.0.1");
						// The body stream can only be read once: parse it here and reuse it.
						const payload = request.method === "GET" ? null : await request.json().catch(() => ({}));
						const root = request.method === "GET" ? String(url.searchParams.get("root") ?? "") : String(payload?.root ?? "");
						if (root.length === 0) throw new Error("缺少 root 参数");
						const meta = readRegistry().workspaces[root];
						if (meta === undefined) throw new Error("未记录的工作区：" + root);
						const bootPath = instructionPathFor(root, meta, cfg);
						const existing = readTextOrNull(bootPath);
						const seen = existing === null ? null : BOOT_BLOCK_MARKER_PATTERN.exec(existing);
						if (request.method === "GET") {
							return jsonResponse({
								file: bootPath,
								exists: seen !== null,
								fileExists: existing !== null,
								current: seen !== null && seen[0] === BOOT_BLOCK_MARKER,
								block: bootBlockText(),
							});
						}
						const action = String(payload?.action ?? "");
						if (action === "remove") {
							if (existing !== null && seen !== null) {
								const stripped = stripBootBlock(existing);
								if (stripped.text === null) rmSync(bootPath);
								else writeText(bootPath, stripped.text);
							}
							return jsonResponse({ removed: true });
						}
						if (action === "rewrite") {
							if (existing === null) writeText(bootPath, bootBlockText());
							else if (seen === null) writeText(bootPath, `${existing.trimEnd()}\n\n${bootBlockText()}`);
							else writeText(bootPath, `${existing.slice(0, seen.index).trimEnd()}\n\n${bootBlockText()}`);
							return jsonResponse({ rewritten: true });
						}
						throw new Error("action 必须是 rewrite 或 remove");
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/trilogy/overview",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async () => {
					seedRegistryFromSessions(ctx, cfg);
					const registry = readRegistry();
					const workspaces = Object.entries(registry.workspaces).map(([root, meta]) => {
						const memoryDir = meta?.memoryDir ?? join(root, cfg.memoryDirName);
						const project = readTextOrNull(join(memoryDir, FILE_PROJECT));
						const sessions = readTextOrNull(join(memoryDir, FILE_SESSIONS));
						const latest = sessions === null ? "" : (splitEntries(sessions).entries[0] ?? "");
						return {
							root,
							lastSeen: meta?.lastSeen ?? null,
							state: sectionBody(project, "现状"),
							latestSession: latest,
							lastSyncAt: newestMemoryMtime(root),
						};
					});
					workspaces.sort((left, right) => String(right.lastSeen ?? "").localeCompare(String(left.lastSeen ?? "")));
					return jsonResponse({ workspaces });
				},
			},
			{
				path: "/trilogy/restore",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const root = String(body?.root ?? "");
						const text = String(body?.text ?? "").trim();
						if (root.length === 0) throw new Error("缺少 root 参数");
						if (text.length === 0) throw new Error("缺少 text 参数");
						const meta = readRegistry().workspaces[root];
						if (meta === undefined) throw new Error("未记录的工作区：" + root);
						const memoryDir = meta.memoryDir ?? join(root, cfg.memoryDirName);
						const archivePath = join(memoryDir, FILE_SESSIONS_ARCHIVE);
						const archive = readTextOrNull(archivePath);
						if (archive === null || !archive.includes(text)) throw new Error("归档里找不到这条");
						// 从归档移除，再插回活日志顶部
						writeText(archivePath, archive.replace(text, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
						const livePath = join(memoryDir, FILE_SESSIONS);
						writeText(livePath, insertEntryAtTop(readTextOrNull(livePath) ?? templateText(FILE_SESSIONS), text));
						markActivity("done", root, { lastSyncAt: Date.now(), lastSyncFile: FILE_SESSIONS });
						return jsonResponse({ restored: true });
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/trilogy/export",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async (request) => {
					const root = new URL(request.url).searchParams.get("root");
					if (root === null || root.length === 0) return jsonResponse({ error: "缺少 root 参数" }, 400);
					const meta = readRegistry().workspaces[root];
					const memoryDir = meta?.memoryDir ?? join(root, cfg.memoryDirName);
					const files = {};
					for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE]) {
						const value = readTextOrNull(join(memoryDir, fileName));
						if (value !== null) files[fileName] = value;
					}
					return jsonResponse({ kind: EXPORT_KIND, version: 1, exportedAt: new Date().toISOString(), root, files });
				},
			},
			{
				path: "/trilogy/import",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const root = String(body?.root ?? "");
						if (root.length === 0) throw new Error("缺少 root 参数");
						const bundle = body?.bundle;
						if (bundle === null || typeof bundle !== "object") throw new Error("缺少 bundle 参数");
						if (bundle.kind !== EXPORT_KIND) throw new Error(`不是本插件导出的记忆包（kind=${String(bundle.kind)}）`);
						const incoming = bundle.files;
						if (incoming === null || typeof incoming !== "object") throw new Error("记忆包里没有 files");
						const names = [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE].filter(
							(fileName) => typeof incoming[fileName] === "string",
						);
						if (names.length === 0) throw new Error("记忆包里没有任何可写入的文件");
						const memoryDir = join(root, cfg.memoryDirName);
						mkdirSync(memoryDir, { recursive: true });
						const written = [];
						for (const fileName of names) {
							writeText(join(memoryDir, fileName), incoming[fileName]);
							written.push(fileName);
						}
						rememberWorkspace({ cwd: root, root, memoryDir }, cfg.bootBlockFile);
						markActivity("done", root, { lastSyncAt: Date.now(), lastSyncFile: written.join(", ") });
						return jsonResponse({ root, written, memoryDir });
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/trilogy/files",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async (request) => {
					const root = new URL(request.url).searchParams.get("root");
					if (root === null || root.length === 0) return jsonResponse({ error: "缺少 root 参数" }, 400);
					const registry = readRegistry();
					const meta = registry.workspaces[root];
					const memoryDir = meta?.memoryDir ?? join(root, cfg.memoryDirName);
					const files = {};
					for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE]) {
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
					const instructionPath = instructionPathFor(root, meta, cfg);
					const instructionText = readTextOrNull(instructionPath);
					return jsonResponse({
						root,
						memoryDir,
						files,
						staleness: stalenessFor(memoryDir, cfg),
						instruction: {
							name: meta?.bootBlockFile ?? cfg.bootBlockFile,
							path: instructionPath,
							exists: instructionText !== null,
							text: instructionText,
							bytes: instructionText === null ? 0 : Buffer.byteLength(instructionText, "utf8"),
						},
					});
				},
			},
			{
				path: "/trilogy/save",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const root = String(body?.root ?? "");
						const fileName = String(body?.file ?? "");
						if (root.length === 0) throw new Error("缺少 root 参数");
						if (typeof body?.text !== "string") throw new Error("缺少 text 参数");
						const registry = readRegistry();
						const meta = registry.workspaces[root];
						if (meta === undefined) throw new Error(`未记录的工作区：${root}`);
						// The whitelist is resolved per workspace: the three memory files, plus
						// the one instruction file that workspace's boot block lives in. Nothing
						// else is reachable through this endpoint, whatever the caller sends.
						const instructionName = meta.bootBlockFile ?? cfg.bootBlockFile;
						const isInstruction = fileName === instructionName;
						if (!isInstruction && ![FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS].includes(fileName)) {
							throw new Error(`不允许写入 ${fileName}`);
						}
						const target = isInstruction
							? instructionPathFor(root, meta, cfg)
							: join(meta.memoryDir ?? join(root, cfg.memoryDirName), fileName);
						writeText(target, body.text);
						// Editing the instruction file is not a memory write, so it must not
						// make the composer chip claim the memory was just synced.
						if (!isInstruction) markActivity("done", root, { lastSyncAt: Date.now(), lastSyncFile: fileName });
						return jsonResponse({
							saved: fileName,
							kind: isInstruction ? "instruction" : "memory",
							bytes: Buffer.byteLength(body.text, "utf8"),
						});
					} catch (error) {
						return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				},
			},
			{
				path: "/trilogy/status",
				methods: ["GET"],
				requestBody: "buffered",
				fetch: async (request) => jsonResponse(statusFor(new URL(request.url).searchParams.get("cwd"), cfg)),
			},
			{
				path: "/trilogy/clear",
				methods: ["POST"],
				requestBody: "buffered",
				fetch: async (request) => {
					try {
						const body = await request.json();
						const result = clearWorkspace(String(body?.root ?? ""), cfg);
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
			"trilogy: settings ui routes",
		);
		ctx.logger.info("trilogy: Settings UI routes registered at %s", API_PREFIX);
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

/** Prefix of the pointer line left in SESSIONS.md after entries move out. */
const ARCHIVE_POINTER_PREFIX = "> 更早的会话条目已归档到";

/** The pointer, so a reader knows history exists beyond the live log. */
const ARCHIVE_POINTER = `${ARCHIVE_POINTER_PREFIX} \`SESSIONS-archive.md\`（不自动注入；需要时用 \`memory_read\` 读取）。`;

const ARCHIVE_HEADER = `# SESSIONS ARCHIVE

> 从 \`SESSIONS.md\` 里搬出来的会话条目，为的是让活日志保持短、注入保持便宜。
> 最新在最上，形状和 \`SESSIONS.md\` 一样。
> 这个文件**永远不会被自动注入** —— 需要更早的历史时才读它。
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
	// Strip any previous pointer first so repeated archiving never stacks them.
	const keepBody = keep
		.join("\n\n")
		.split("\n")
		.filter((line) => !line.startsWith(ARCHIVE_POINTER_PREFIX))
		.join("\n")
		.trimEnd();
	// Name the count, so lowering sessionsMaxEntries cannot quietly move entries
	// out of view without saying how many went.
	const archivedTotal = splitEntries(archive).entries.length + moved.length;
	const pointer = `${ARCHIVE_POINTER_PREFIX} ${archivedTotal} 条（\`SESSIONS-archive.md\`，不自动注入；需要时用 \`memory_read\` 读取）。`;
	writeText(target, `${header.trimEnd()}\n\n${keepBody}\n\n${pointer}\n`);
	return moved.length;
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/**
 * Register the trilogy behaviour on the harness.
 * @param ctx - the plugin context.
 * @param config - loader-supplied configuration.
 */
/**
 * Whether the injected memory block is still visible in the session.
 *
 * Trusting a boolean would be wrong: DSH compacts long sessions, and a compacted
 * block is gone from context while this plugin would still believe it had been
 * injected — so the memory would silently stop reaching the model. The workspace
 * instruction loader solves this the same way, by looking for its own message
 * rather than remembering that it sent one.
 *
 * @param agent - the running agent.
 * @returns `present`, `absent`, or `unknown` when the surface cannot be read.
 */
function injectedMemoryVisibility(agent) {
	try {
		const nodes = agent?.session?.surface?.nodes;
		if (nodes === undefined || typeof nodes.toReversed !== "function") return "unknown";
		if (typeof agent.session.eventAt !== "function") return "unknown";
		for (const seq of nodes.toReversed()) {
			const event = agent.session.eventAt(seq);
			if (event?.type !== "user/message") continue;
			const source = event.data?.source;
			if (source?.kind === "plugin" && source.plugin === name && source.form === "trilogy") return "present";
		}
		return "absent";
	} catch {
		// A surface we cannot read is not evidence of absence; fall back to the
		// remembered flag rather than re-injecting on every single step.
		return "unknown";
	}
}

/**
 * Tokenizer for BM25: ASCII words and digits stay whole, CJK is one character
 * per token. Enough for a keyword search over a handful of Markdown files, and
 * it costs nothing to run.
 * @param text - anything.
 * @returns the token list.
 */
function tokenize(text) {
	const out = [];
	const re = /[a-z0-9_]+|[\u4e00-\u9fff]/g;
	const lower = String(text).toLowerCase();
	let match;
	while ((match = re.exec(lower)) !== null) out.push(match[0]);
	return out;
}

/**
 * Split the memory files into rankable chunks, remembering which file and
 * heading each came from. The archive is included on purpose: it holds what the
 * live log no longer carries.
 * @param memoryDir - the workspace memory directory.
 * @returns chunks of {file, heading, text}.
 */
function searchableChunks(memoryDir) {
	const chunks = [];
	for (const fileName of [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE]) {
		const text = readTextOrNull(join(memoryDir, fileName));
		if (text === null) continue;
		const { entries } = splitEntries(text);
		const blocks = entries.length > 0 ? entries : text.split(/\n{2,}/).filter((part) => part.trim().length > 0);
		for (const block of blocks) {
			const heading = (/^##\s+(.*\S)\s*$/m.exec(block) ?? [])[1] ?? "";
			chunks.push({ file: fileName, heading, text: block.trim() });
		}
	}
	return chunks;
}

/**
 * Okapi BM25 over the chunks. Deterministic, local, no embeddings.
 * @param query - the search string.
 * @param chunks - from searchableChunks.
 * @param limit - maximum matches.
 * @returns matches sorted by descending score.
 */
function bm25Rank(query, chunks, limit) {
	const terms = [...new Set(tokenize(query))];
	if (terms.length === 0 || chunks.length === 0) return [];
	const docs = chunks.map((chunk) => ({ chunk, tokens: tokenize(chunk.heading + " " + chunk.text) }));
	const total = docs.length;
	const avgdl = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / total || 1;
	const df = new Map();
	for (const doc of docs) for (const token of new Set(doc.tokens)) df.set(token, (df.get(token) ?? 0) + 1);
	const k1 = 1.2;
	const b = 0.75;
	const scored = [];
	for (const doc of docs) {
		const tf = new Map();
		for (const token of doc.tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
		let score = 0;
		for (const term of terms) {
			const freq = tf.get(term);
			if (freq === undefined) continue;
			const seen = df.get(term) ?? 0;
			const idf = Math.log(1 + (total - seen + 0.5) / (seen + 0.5));
			score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.tokens.length) / avgdl)));
		}
		if (score > 0) scored.push({ ...doc.chunk, score });
	}
	scored.sort((left, right) => right.score - left.score);
	return scored.slice(0, limit);
}

/**
 * The body of one fixed PROJECT.md section, without its heading.
 * @param text - PROJECT.md contents, or null.
 * @param section - the heading text, e.g. State.
 * @returns the trimmed body, or an empty string.
 */
function sectionBody(text, section) {
	if (text === null) return "";
	const wanted = sectionAliases(section);
	const records = annotateFences(text);
	let collecting = false;
	const body = [];
	for (const record of records) {
		if (record.inFence) { if (collecting) body.push(record.line); continue; }
		const match = /^##\s+(.*\S)\s*$/.exec(record.line);
		if (match !== null) {
			if (collecting) break;
			collecting = wanted.includes(match[1].trim().toLowerCase());
			continue;
		}
		if (collecting) body.push(record.line);
	}
	const joined = body.join("\n").trim();
	const lowered = joined.toLowerCase();
	return lowered === EMPTY_SECTION || lowered === LEGACY_EMPTY_SECTION ? "" : joined;
}
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
							"trilogy: scaffolded %s%s in %s",
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
					ctx.logger.warn("trilogy: scaffold failed: %o", error);
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
			ctx.logger.warn("trilogy: injection render failed: %o", error);
			return downstream;
		}
		if (built === null) return downstream;
		let text = built.text;
		let digest = built.digest;
		if (cfg.bootstrapWhenEmpty && isProjectEmpty(readTextOrNull(join(state.paths.memoryDir, FILE_PROJECT)))) {
			text = `${text}\n\n${BOOTSTRAP_TEXT}`;
			digest = digestOf(text);
		}
		// Skip only when the identical block is still there to be seen.
		const visibility = injectedMemoryVisibility(agent);
		if (state.digest === digest && (visibility === "present" || (visibility === "unknown" && state.injected))) {
			return downstream;
		}
		state.injected = true;
		state.digest = digest;
		return {
			...downstream,
			messages: [
				...downstream.messages,
				createUserMessage({
					content: [{ type: "text", text }],
					source: { ...PLUGIN_SOURCE, form: "trilogy", baseline: true },
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
				source: { ...PLUGIN_SOURCE, form: "trilogy-nudge" },
			}),
		);
	});

	/* --- model-facing tools ----------------------------------------- */

	ctx.tools.register(
		defineTool({
			name: "memory_checkpoint",
			description:
				"记录「未来的会话否则得重新发现」的东西到这个项目的记忆文件（`memory/PROJECT.md`、`memory/DECISIONS.md`、`memory/SESSIONS.md`）。" +
				"每条候选都过一遍这个判据：没有这条，未来的会话会不会浪费时间，或者重犯同一个错？不合格的候选是**丢掉，不是删短**。" +
				"分流：改变「项目是什么」或「怎么跑」的进 `project`（就地编辑）；定下来的选择以及被否决的替代进 `decisions`（最新在最上）；这一轮做了什么、怎么验证的进 `sessions`（最新在最上）。" +
				"什么都不记是合法结果 —— 不要凑数。",
			parameters: {
				sessions: {
					type: "array",
					description: "写进 SESSIONS.md 的条目，最新的在前。日期由插件盖戳。",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							done: { type: "string", required: true, description: "现在是真的是什么，以及怎么验证的。没有验证就只是主张，不是记录。" },
							open: { type: "string", description: "还没做完的。" },
							next: { type: "string", description: "一个具体的下一步。" },
						},
					},
				},
				decisions: {
					type: "array",
					description: "写进 DECISIONS.md 的条目，最新的在前。只记录真的做过的决定，不要编。",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							choice: { type: "string", required: true, description: "决定了什么，一行。" },
							over: { type: "string", description: "被否决的替代，以及为什么。" },
							because: { type: "string", description: "逼出这个决定的约束。" },
						},
					},
				},
				project: {
					type: "array",
					description: "就地替换 PROJECT.md 的小节。只在这个事实改变了「项目是什么」或「怎么跑」时才用。",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							section: { type: "string", required: true, enum: [...PROJECT_SECTIONS, ...Object.values(LEGACY_SECTION_NAMES).flat()], description: "替换哪个固定小节。旧版用过的英文小节名也接受，写进去时会改成中文。" },
							text: { type: "string", required: true, description: "该小节的新正文。确实没有内容就写 `暂无`。" },
						},
					},
				},
				notes: {
					type: "string",
					description: "你注意到但**不能自作主张删掉**的东西：看起来过时、重复或写错了。这些会转报给用户。",
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
					lines.push(`完成：${String(entry.done).trim()}`);
					if (entry.open !== undefined && String(entry.open).trim().length > 0) lines.push(`未完成：${String(entry.open).trim()}`);
					if (entry.next !== undefined && String(entry.next).trim().length > 0) lines.push(`下一步：${String(entry.next).trim()}`);
					const target = join(memoryDir, FILE_SESSIONS);
					writeText(target, insertEntryAtTop(readTextOrNull(target) ?? templateText(FILE_SESSIONS), lines.join("\n")));
					written.push(`${FILE_SESSIONS}: ${lines[0]}`);
				}

				const decisions = Array.isArray(args.decisions) ? args.decisions : [];
				for (const entry of [...decisions].reverse()) {
					const choice = String(entry.choice).trim();
					const lines = [`## ${date} — ${choice}`, `选择：${choice}`];
					if (entry.over !== undefined && String(entry.over).trim().length > 0) lines.push(`放弃：${String(entry.over).trim()}`);
					if (entry.because !== undefined && String(entry.because).trim().length > 0) lines.push(`因为：${String(entry.because).trim()}`);
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
					// The cap exists to stop nagging a session that ignores the nudge. A
					// session that just recorded has disproved that, so its budget comes
					// back - otherwise a long session goes quiet after three nudges and
					// later work is never recorded at all.
					state.nudges = 0;
					state.lastNudgeAt = 0;
					// Bound the live log before reporting the write, so the injected
					// block never carries more entries than the budget assumes.
					let archived = 0;
					try {
						archived = archiveSessionsIfNeeded(memoryDir, cfg);
					} catch (error) {
						ctx.logger.warn("trilogy: archive failed: %o", error);
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
			name: "memory_search",
			description:
				"按关键词检索这个项目的记忆文件（确定性 BM25，不用 embedding、不调模型）。" +
				"当自动注入的块说「有内容被省略」时用它，或者你需要比最近几条更早的历史时用它 —— 归档也一起搜。" +
				"中文按字匹配，ASCII 单词和数字按整词匹配。",
			parameters: {
				query: { type: "string", required: true, description: "要找的关键词。" },
				limit: { type: "integer", description: "最多返回多少条。默认 5，上限 20。" },
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						matches: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									file: { type: "string", required: true },
									heading: { type: "string" },
									text: { type: "string", required: true },
									score: { type: "number", required: true },
								},
							},
						},
					},
				},
				render: (_args, value) => [
					{
						type: "text",
						text: value.matches.length === 0 ? "没有匹配。" : value.matches.map((match) => match.file + (match.heading ? " · " + match.heading : "") + "\n" + match.text).join("\n\n"),
					},
				],
			},
			execute(args, exec) {
				const agent = exec?.agent;
				if (agent?.session === undefined) throw new Error("memory_search requires an owning agent session");
				const state = stateOf(agent.session);
				if (state.paths === null) state.paths = pathsFor(agent);
				const query = String(args.query ?? "").trim();
				if (query.length === 0) throw new Error("memory_search requires a non-empty query");
				const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 5;
				return Promise.resolve({ matches: bm25Rank(query, searchableChunks(state.paths.memoryDir), limit) });
			},
			presentCall: (args) => ({ card: "generic", title: "Search memory: " + String(args.query), kind: "other", rawInput: args }),
		}),
	);

ctx.tools.register(
		defineTool({
			name: "memory_read",
			description:
				"读这个项目的记忆文件。只在你需要某个**没有被自动加载**的部分时才用 —— 三个文件在每个会话开始时已经在上下文里了。`SESSIONS-archive.md` 装着从活日志里搬出去的更早的会话条目；它永远不会被自动注入，所以需要比最近几条更早的历史时才读它。",
			parameters: {
				file: {
					type: "string",
					required: true,
					enum: [FILE_PROJECT, FILE_DECISIONS, FILE_SESSIONS, FILE_SESSIONS_ARCHIVE],
					description: "要读哪个记忆文件。",
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
