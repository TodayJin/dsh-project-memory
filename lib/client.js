/**
 * dsh-trilogy — browser half.
 *
 * Loaded by the DSH client module loader (`window.__ModuleLoader__.load`), which
 * hands the factory a `require` for shared modules. React comes from that loader
 * — the same copy the built-in settings pages use — so this file needs no bundler
 * and no JSX: everything is `react.createElement`.
 *
 * Adds one section to the Settings UI:
 *   - every workspace the host half has ever scaffolded
 *   - the live contents of that workspace's three memory files
 *   - Clear (delete the three files; the next session scaffolds them again, empty)
 */

window.__ModuleLoader__.load({
	id: "dsh-trilogy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;

		const API = "/trilogy";

		const CSS = `.dsh-pm{display:flex;flex-direction:column;gap:12px;width:100%;max-width:1040px;color:var(--dsw-alias-label-primary)}
.dsh-pm-head{display:flex;align-items:flex-start;gap:12px}
.dsh-pm-head h2{margin:0 0 3px;font-size:15px}
.dsh-pm-head>.dsh-pm-btn{margin-left:auto;flex:0 0 auto}
.dsh-pm-intro{margin:0;font-size:12px;opacity:.7;line-height:1.65}

/* left picks, right shows */
.dsh-pm-body{display:grid;grid-template-columns:minmax(190px,230px) minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:760px){.dsh-pm-body{grid-template-columns:minmax(0,1fr)}}
.dsh-pm-side{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:10px;padding:10px;min-width:0}
.dsh-pm-side-head{display:flex;align-items:center;gap:6px}
.dsh-pm-count{margin-left:auto;font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}
.dsh-pm-list{display:flex;flex-direction:column;gap:2px;max-height:430px;overflow:auto;margin:0 -4px;padding:0 4px}
.dsh-pm-main{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-pm-title{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-pm-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-pm-title .dsh-pm-name{font-size:14px;font-weight:600}

/* buttons */
.dsh-pm-btn{border:1px solid var(--dsw-alias-border-secondary,#0003);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-pm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-btn:disabled{opacity:.45;cursor:default}
.dsh-pm-btn-primary{border-color:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe)}
.dsh-pm-btn-danger{color:#d33}
.dsh-pm-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe);background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-tab{border-radius:999px;padding:3px 12px}

/* the workspace list */
.dsh-pm-item{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:6px;cursor:pointer;text-align:left;background:transparent;border:0;color:inherit;font:inherit;width:100%;min-width:0}
.dsh-pm-item:hover{background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-item[data-active="true"]{background:var(--dsw-alias-bg-secondary,#0000000d);outline:1px solid var(--dsw-alias-brand-primary,#3964fe55)}
.dsh-pm-item-top{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-pm-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pm-path{font-size:11px;opacity:.55;word-break:break-all;line-height:1.5}
.dsh-pm-meta{font-size:11px;opacity:.55;font-variant-numeric:tabular-nums}
.dsh-pm-badge{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid currentColor;opacity:.75;white-space:nowrap;margin-left:auto}
.dsh-pm-search{border:1px solid var(--dsw-alias-border-secondary,#0002);background:transparent;color:inherit;border-radius:6px;padding:4px 8px;font:inherit;font-size:12px;width:100%}
.dsh-pm-empty{font-size:12px;opacity:.65;padding:10px;margin:0;line-height:1.6}

/* controls, content, and the instruction file */
.dsh-pm-tabs{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.dsh-pm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-pm-spacer{margin-left:auto}
.dsh-pm-hint{font-size:11px;opacity:.55}
.dsh-pm-pre{margin:0;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-secondary,#0000000a);max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.65}
.dsh-pm-edit{width:100%;min-height:340px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-secondary,#0000000a);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;resize:vertical}
.dsh-pm-section{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:10px;padding:10px 12px;min-width:0}
.dsh-pm-section-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-pm-panel-label{font-size:10.5px;letter-spacing:.08em;opacity:.5;text-transform:uppercase;white-space:nowrap}
.dsh-pm-overview-row{border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.dsh-pm-overview-row:first-child{border-top:0;padding-top:0}
.dsh-pm-overview-pre{max-height:150px;font-size:11px}
.dsh-pm-archive-entry{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:8px}
.dsh-pm-archive-entry:first-child{border-top:0;padding-top:0}

/* the one destructive row, kept apart from everything above it */
.dsh-pm-danger{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:10px;margin-top:2px}
.dsh-pm-warn{font-size:11.5px;color:#c47f17;line-height:1.6;flex:1 1 260px;min-width:0}

/* the staleness banner, which is about PROJECT.md */
.dsh-pm-stale{display:flex;gap:8px;align-items:baseline;border:1px solid #c47f1755;background:#c47f1712;border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55}
.dsh-pm-stale .dsh-pm-badge{color:#c47f17;border-color:currentColor;font-size:11px;margin-left:0}

.dsh-pm-status{font-size:12px;min-height:16px;margin:0}
.dsh-pm-ok{color:#1a8f4a}
.dsh-pm-err{color:#d33}

/* the composer chip */
.dsh-pm-chip{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;line-height:1;padding:3px 6px;border-radius:6px;cursor:default;opacity:.75;white-space:nowrap;max-width:190px}
.dsh-pm-chip:hover{opacity:1;background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-chip[data-tone="busy"]{opacity:1;color:var(--dsw-alias-brand-primary,#3964fe)}
.dsh-pm-chip[data-tone="ok"]{opacity:1;color:#1a8f4a}
.dsh-pm-chip[data-tone="warn"]{opacity:1;color:#c47f17}
.dsh-pm-chip[data-clickable="true"]{cursor:pointer}
.dsh-pm-chip-label{overflow:hidden;text-overflow:ellipsis}
.dsh-pm-chip-ago{opacity:.6}
.dsh-pm-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto}
@media (prefers-reduced-motion: no-preference){.dsh-pm-chip[data-tone="busy"] .dsh-pm-dot{animation:dsh-pm-pulse 1.1s ease-in-out infinite}}
@keyframes dsh-pm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
`;
		/**
		 * Normalise any failure into a readable message.
		 * @param error - whatever was thrown.
		 * @returns a human-readable string.
		 */
		const messageOf = (error) => (error instanceof Error ? error.message : String(error));

		/**
		 * Call one JSON endpoint of the host half.
		 * @param path - path below /api/trilogy.
		 * @param init - optional fetch init.
		 * @returns the parsed JSON body.
		 */
		async function call(path, init) {
			// `fetch` stringifies a plain-object body to "[object Object]", which the
			// host would then fail to parse as JSON. Every call site here hands over an
			// object, so it is encoded once, here, rather than trusted to each caller.
			const requestBody = init?.body === undefined || typeof init.body === "string" ? init?.body : JSON.stringify(init.body);
			const response = await fetch(`${API}${path}`, {
				cache: "no-store",
				...init,
				body: requestBody,
				headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
			});
			const text = await response.text();
			let body;
			try {
				body = text.length === 0 ? {} : JSON.parse(text);
			} catch {
				throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
			}
			if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
			return body;
		}

		/** Short label for a workspace row. */
		function workspaceName(workspace) {
			const parts = String(workspace.root ?? "").split(/[\\/]/).filter(Boolean);
			return parts.length === 0 ? String(workspace.root) : parts[parts.length - 1];
		}

		/**
		 * Hand a text file to the browser's download machinery.
		 *
		 * Returns false instead of throwing when the page cannot mint an object URL
		 * (an embedded shell, a test sandbox): the caller then says so rather than
		 * leaving the user staring at a button that did nothing.
		 *
		 * @param fileName - the name the browser should save under.
		 * @param text - the file body.
		 * @returns whether a download was started.
		 */
		function saveAs(fileName, text) {
			const canBlob =
				typeof Blob === "function" && typeof URL?.createObjectURL === "function" && typeof document?.createElement === "function";
			if (!canBlob) return false;
			const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = fileName;
			anchor.rel = "noopener";
			(document.body ?? document.documentElement).appendChild(anchor);
			anchor.click();
			anchor.remove();
			// Revoking in the same tick can cancel the download the browser has not
			// started reading yet, so let it settle first.
			setTimeout(() => URL.revokeObjectURL(url), 0);
			return true;
		}

		/** How long "更新完毕" stays on screen before the chip relaxes to "已同步". */
		const DONE_LINGER_MS = 8000;

		/** Phase → what the chip says. */
		const PHASE_LABEL = {
			recording: "正在记录",
			none: "无记忆",
			updating: "正在更新",
			done: "更新完毕",
			idle: "已同步",
		};
		/** Phase → which primitives icon to draw. */
		const PHASE_ICON = {
			recording: "IconLoadingOutline16",
			none: "IconProjectAddOutline16",
			updating: "IconRefreshOutline14",
			done: "IconCheckOutline14",
			idle: "IconDatabaseOutline16",
		};

		/**
		 * Human-readable "how long ago", computed locally so no clock or locale
		 * helper has to be trusted.
		 * @param at - epoch milliseconds, or null.
		 * @param now - current epoch milliseconds from the host.
		 * @returns the relative phrase.
		 */
		function agoText(at, now) {
			if (typeof at !== "number" || at <= 0) return "尚未同步";
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 10) return "刚刚";
			if (seconds < 60) return `${seconds} 秒前`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes} 分钟前`;
			const hours = Math.round(minutes / 60);
			if (hours < 24) return `${hours} 小时前`;
			return `${Math.round(hours / 24)} 天前`;
		}

		/**
		 * The composer's bottom-left memory indicator: what the plugin is doing
		 * right now, and when it last wrote.
		 * @returns the chip element.
		 */
		function StatusChip(props) {
			// Standard props on every session-scoped seat: this is what makes the chip
			// answer for ITS workspace instead of for the host process.
			const { sessionId, useSessions } = props;
			const cwd = useSessions((state) => state.byId[sessionId]?.cwd ?? "");
			const [snapshot, setSnapshot] = react.useState(null);
			const [busy, setBusy] = react.useState(false);

			const reload = react.useCallback(() => {
				if (cwd === "") return Promise.resolve();
				return call(`/status?cwd=${encodeURIComponent(cwd)}`)
					.then(setSnapshot)
					.catch(() => {
						/* an unreachable host leaves the last reading on screen */
					});
			}, [cwd]);

			react.useEffect(() => {
				if (cwd === "") return undefined;
				reload();
				const timer = setInterval(reload, 4000);
				return () => clearInterval(timer);
			}, [cwd, reload]);

			if (cwd === "") return null;
			if (snapshot === null) return null;

			const now = typeof snapshot.now === "number" ? snapshot.now : Date.now();
			const phase = typeof snapshot.phase === "string" ? snapshot.phase : "idle";
			// A finished write announces itself briefly, then settles.
			const settled = phase === "done" && now - (snapshot.at ?? 0) > DONE_LINGER_MS;
			const shown = settled ? "idle" : phase;
			const hasSync = typeof snapshot.lastSyncAt === "number" && snapshot.lastSyncAt > 0;
			const tone = shown === "recording" || shown === "updating" ? "busy" : shown === "done" ? "ok" : shown === "none" ? "warn" : "idle";
			// Never claim "已同步" for a workspace that has no memory at all, or one
			// that has never been written to. Both are states the user can act on.
			const canInit = shown === "none";
			// No third branch promising "点击更新": this chip only renders as a button
			// when it can actually create the files, so any other label would describe
			// a click the user cannot make.
			const label = canInit ? "无记忆 · 点击创建" : (PHASE_LABEL[shown] ?? shown);

			const Icon = primitives?.[PHASE_ICON[shown]];
			const glyph =
				typeof Icon === "function"
					? h(Icon, { "aria-hidden": "true" })
					: h("span", { className: "dsh-pm-dot", "aria-hidden": "true" });

			const title = [
				`状态：${label}`,
				canInit ? "点击为这个工作区创建 memory/ 三个文件" : null,
				`最近同步：${agoText(snapshot.lastSyncAt, now)}`,
				snapshot.workspace ? `工作区：${snapshot.workspace}` : null,
				snapshot.lastSyncFile ? `写入：${snapshot.lastSyncFile}` : null,
			]
				.filter(Boolean)
				.join("\n");

			const doInit = () => {
				if (busy || cwd === "") return;
				setBusy(true);
				call("/init", { method: "POST", body: { cwd } })
					.then(() => reload())
					.catch(() => {})
					.finally(() => setBusy(false));
			};

			return h(
				canInit ? "button" : "span",
				{
					className: "dsh-pm-chip",
					"data-tone": tone,
					title,
					role: "status",
					"aria-live": "polite",
					...canInit ? { type: "button", onClick: doInit, disabled: busy, "data-clickable": "true" } : {},
				},
				glyph,
				h("span", { className: "dsh-pm-chip-label" }, label),
				hasSync ? h("span", { className: "dsh-pm-chip-ago" }, `· ${agoText(snapshot.lastSyncAt, now)}`) : null,
			);
		}

/**
 * The four memory files, under the name that says what each one is FOR.
 *
 * The file name is still the tab's identity — it is what the endpoint takes —
 * but the label is the question the file answers, which is what a reader is
 * actually looking for. The file name shows up in the toolbar's meta line.
 */
const MEMORY_TABS = [
	{ file: "PROJECT.md", label: "现状" },
	{ file: "DECISIONS.md", label: "决策" },
	{ file: "SESSIONS.md", label: "日志" },
	{ file: "SESSIONS-archive.md", label: "归档" },
];

		/** The settings panel. */
		function SettingsPanel() {
			const [workspaces, setWorkspaces] = react.useState(null);
			const [selected, setSelected] = react.useState("");
			const [files, setFiles] = react.useState(null);
			const [tab, setTab] = react.useState("PROJECT.md");
			const [busy, setBusy] = react.useState("");
			const [status, setStatus] = react.useState({ kind: "idle", text: "" });
			const [error, setError] = react.useState("");
			const [search, setSearch] = react.useState("");
			const [editing, setEditing] = react.useState(false);
			const [draft, setDraft] = react.useState("");
			const [staleness, setStaleness] = react.useState(null);
			const [boot, setBoot] = react.useState(null);
			const [instruction, setInstruction] = react.useState(null);
			const [editingInstruction, setEditingInstruction] = react.useState(false);
			const [instructionDraft, setInstructionDraft] = react.useState("");
			const fileInput = react.useRef(null);
			const [confirmClear, setConfirmClear] = react.useState(false);

			const loadWorkspaces = react.useCallback(async () => {
				setError("");
				try {
					const body = await call("/workspaces");
					setWorkspaces(body.workspaces ?? []);
					return body.workspaces ?? [];
				} catch (failure) {
					setError(messageOf(failure));
					setWorkspaces([]);
					return [];
				}
			}, []);

			const loadFiles = react.useCallback(async (root) => {
				if (!root) return;
				try {
					const body = await call(`/files?root=${encodeURIComponent(root)}`);
					setFiles(body.files ?? {});
					setStaleness(body.staleness ?? null);
					setInstruction(body.instruction ?? null);
				} catch (failure) {
					setFiles(null);
					setStaleness(null);
					setInstruction(null);
					setError(messageOf(failure));
				}
			}, []);

			/**
			 * Read the workspace's instruction file (AGENTS.md by default): whether the
			 * Memory block is in it, and which version.
			 */
			const loadBoot = react.useCallback(async (root) => {
				if (!root) return;
				try {
					setBoot(await call(`/boot?root=${encodeURIComponent(root)}`));
				} catch {
					// A workspace that has never been recorded has no boot block to report,
					// which is not an error worth showing.
					setBoot(null);
				}
			}, []);
			const [overview, setOverview] = react.useState(null);
			const loadOverview = react.useCallback(async () => {
				try {
					const body = await call("/overview");
					setOverview(body.workspaces ?? []);
				} catch (failure) {
					setError(messageOf(failure));
				}
			}, []);

			react.useEffect(() => {
				loadWorkspaces().then((list) => {
					if (list.length > 0) {
						setSelected(list[0].root);
						loadFiles(list[0].root);
						loadBoot(list[0].root);
					}
				});
			}, [loadWorkspaces, loadFiles, loadBoot]);

			const pick = (root) => {
				setSelected(root);
				setStatus({ kind: "idle", text: "" });
				setBoot(null);
				setInstruction(null);
				setEditing(false);
				setEditingInstruction(false);
				setConfirmClear(false);
				loadFiles(root);
				loadBoot(root);
			};

			const refresh = async () => {
				setBusy("refresh");
				const list = await loadWorkspaces();
				const stillThere = list.some((w) => w.root === selected);
				if (stillThere) {
					await loadFiles(selected);
					await loadBoot(selected);
				}
				setBusy("");
				setStatus({ kind: "ok", text: "已刷新" });
			};

			const clearWorkspace = async () => {
				if (!selected) return;
				setBusy("clear");
				setConfirmClear(false);
				try {
					const body = await call("/clear", { method: "POST", body: JSON.stringify({ root: selected }) });
					await loadWorkspaces();
					await loadFiles(selected);
					setStatus({
						kind: "ok",
						text: `已清除 ${body.cleared?.length ?? 0} 个文件${body.bootBlockRemoved ? "（并移除了 AGENTS.md 的 Memory 段）" : ""}。下次在该工作区开新会话会重新创建空文件。`,
					});
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};

			const current = (workspaces ?? []).find((w) => w.root === selected) ?? null;
			const entry = files === null ? null : (files[tab] ?? null);
			const body = entry === null || entry === undefined ? "" : (entry.text ?? "");
			const shown = (workspaces ?? []).filter((w) => {
				const needle = search.trim().toLowerCase();
				if (needle.length === 0) return true;
				return String(w.root).toLowerCase().includes(needle);
			});

			const restoreEntry = async (entry) => {
				setBusy("restore");
				try {
					await call("/restore", { method: "POST", body: { root: selected, text: entry } });
					await loadFiles(selected);
					setTab("SESSIONS.md");
					setStatus({ kind: "ok", text: "已恢复到活日志顶部" });
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};
			const saveFile = async () => {
				setBusy("save");
				try {
					await call("/save", { method: "POST", body: { root: selected, file: tab, text: draft } });
					await loadFiles(selected);
					setEditing(false);
					setStatus({ kind: "ok", text: `已保存 ${tab}` });
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};

			/** Write the Memory block into the workspace's instruction file. */
			const bootAction = async (action) => {
				if (!selected) return;
				setBusy("boot");
				try {
					await call("/boot", { method: "POST", body: { root: selected, action } });
					await loadBoot(selected);
					setStatus({
						kind: "ok",
						text: action === "remove" ? "已从指令文件移除 Memory 段（其余内容原样保留）" : "已把 Memory 段写回指令文件",
					});
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};

			/** Open the whole instruction file in the editor. */
			const startInstructionEdit = () => {
				if (instruction === null) return;
				setEditing(false);
				setEditingInstruction(true);
				setInstructionDraft(instruction.text ?? "");
				setStatus({ kind: "idle", text: "" });
			};

			/**
			 * Write the whole instruction file back.
			 *
			 * This is the blunt instrument the block-level buttons exist to avoid: it
			 * replaces everything, Memory block included, so the block is re-added on a
			 * later session if it gets dropped here (see the panel's own hint).
			 */
			const saveInstruction = async () => {
				if (instruction === null || !selected) return;
				setBusy("instruction");
				try {
					await call("/save", { method: "POST", body: { root: selected, file: instruction.name, text: instructionDraft } });
					await loadFiles(selected);
					await loadBoot(selected);
					setEditingInstruction(false);
					setInstructionDraft("");
					setStatus({ kind: "ok", text: `已保存 ${instruction.name}` });
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};

			/** Download one workspace's memory/ as a portable bundle. */
			const exportMemory = async () => {
				if (!selected) return;
				setBusy("export");
				try {
					const bundle = await call(`/export?root=${encodeURIComponent(selected)}`);
					const count = Object.keys(bundle.files ?? {}).length;
					const stamp = new Date().toISOString().slice(0, 10);
					const started = saveAs(`${workspaceName(current ?? { root: selected })}-memory-${stamp}.json`, JSON.stringify(bundle, null, 2));
					setStatus(
						started
							? { kind: "ok", text: `已导出 ${count} 个文件` }
							: { kind: "err", text: "这个界面不允许下载文件，无法导出" },
					);
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
			};

			/** Read a bundle the user picked and write it over this workspace's memory. */
			const importMemory = async (event) => {
				const chosen = event?.target?.files?.[0];
				if (chosen === undefined || chosen === null) return;
				setBusy("import");
				try {
					const parsed = JSON.parse(await chosen.text());
					const result = await call("/import", { method: "POST", body: { root: selected, bundle: parsed } });
					await loadWorkspaces();
					await loadFiles(selected);
					await loadBoot(selected);
					setStatus({ kind: "ok", text: `已导入 ${result.written?.length ?? 0} 个文件（同名文件被覆盖）` });
				} catch (failure) {
					setStatus({ kind: "err", text: messageOf(failure) });
				}
				setBusy("");
				if (event?.target) event.target.value = "";
			};


			const meta = entry === null || entry === undefined ? "" : `${tab} · ${entry.bytes} 字节${entry.mtime ? ` · 修改于 ${agoText(entry.mtime, Date.now())}` : ""}`;
			// Only a dated block is an entry. The archive's own header is not one, and
			// offering to "restore" it could only ever end in 「归档里找不到这条」.
			const archiveEntries = body
				.split(/^## /m)
				.map((part) => part.trim())
				.filter((part) => /^\d{4}-\d{2}-\d{2}/.test(part));
			// The host refuses to write anything but the three live files, so the editor
			// is only offered where a save can actually succeed.
			const writable = ["PROJECT.md", "DECISIONS.md", "SESSIONS.md"].includes(tab);

			/** The right-hand column: everything about the selected workspace. */
			const detail = () => {
				const lastSeenAt = current.lastSeen ? Date.parse(current.lastSeen) : Number.NaN;
				return [
					// Which workspace this is — the list on the left is far away once the
					// page is scrolled, so the detail has to name itself.
					h(
						"header",
						{ key: "title", className: "dsh-pm-title" },
						h(
							"div",
							{ className: "dsh-pm-title-row" },
							h("span", { className: "dsh-pm-name" }, workspaceName(current)),
							h("span", { className: "dsh-pm-badge" }, current.exists ? (current.empty ? "空" : "已记录") : "已清除"),
							Number.isFinite(lastSeenAt) ? h("span", { className: "dsh-pm-meta" }, `最近活跃 ${agoText(lastSeenAt, Date.now())}`) : null,
						),
						h("span", { className: "dsh-pm-path" }, current.root),
					),
					staleness !== null && staleness.stale
						? h(
								"div",
								{ key: "stale", className: "dsh-pm-stale", role: "status" },
								h("span", { className: "dsh-pm-badge" }, "PROJECT.md 可能过时"),
								h(
									"span",
									null,
									`它已经 ${staleness.behindDays} 天没改过，而这期间日志里追加了 ${staleness.entriesSince} 条 —— 先把它改写成现在的样子，再往下做。`,
								),
							)
						: null,
					// What the files are FOR, not what they are called. The file name shows
					// up in the meta line on the right of the toolbar.
					h(
						"div",
						{ key: "tabs", className: "dsh-pm-tabs" },
						...MEMORY_TABS.map((memory) =>
							h(
								"button",
								{
									key: memory.file,
									className: "dsh-pm-btn dsh-pm-tab",
									"data-active": String(memory.file === tab),
									onClick: () => { setTab(memory.file); setEditing(false); setEditingInstruction(false); },
								},
								memory.label,
							),
						),
						h(
							"button",
							{
								key: "__overview__",
								className: "dsh-pm-btn dsh-pm-tab",
								"data-active": String(tab === "__overview__"),
								onClick: () => { setTab("__overview__"); setEditing(false); setEditingInstruction(false); loadOverview(); },
							},
							"全部工作区",
						),
					),
					h(
						"div",
						{ key: "toolbar", className: "dsh-pm-toolbar" },
						writable
							? editing
								? h("button", { className: "dsh-pm-btn dsh-pm-btn-primary", onClick: saveFile, disabled: busy !== "" }, busy === "save" ? "保存中…" : "保存")
								: h(
										"button",
										{
											className: "dsh-pm-btn dsh-pm-btn-primary",
											onClick: () => { setEditingInstruction(false); setDraft(body); setEditing(true); setStatus({ kind: "idle", text: "" }); },
											disabled: busy !== "",
										},
										"编辑",
									)
							: null,
						writable && editing
							? h("button", { className: "dsh-pm-btn", onClick: () => { setEditing(false); setDraft(""); }, disabled: busy !== "" }, "取消")
							: null,
						h("button", { className: "dsh-pm-btn", onClick: () => loadFiles(selected), disabled: busy !== "" }, "重新读取"),
						writable ? null : h("span", { className: "dsh-pm-hint" }, tab === "__overview__" ? "概览只读" : "归档只读，要改就先用「恢复这条」搬回日志"),
						h("span", { key: "gap", className: "dsh-pm-spacer" }),
						h("button", { className: "dsh-pm-btn", onClick: exportMemory, disabled: busy !== "" }, busy === "export" ? "导出中…" : "导出"),
						h("button", { className: "dsh-pm-btn", onClick: () => fileInput.current?.click(), disabled: busy !== "" }, busy === "import" ? "导入中…" : "导入"),
						h("input", {
							key: "picker",
							ref: fileInput,
							type: "file",
							accept: "application/json,.json",
							style: { display: "none" },
							onChange: importMemory,
						}),
						h("span", { key: "meta", className: "dsh-pm-meta" }, editing ? "编辑中，未保存" : meta),
					),
					editing
						? h("textarea", {
								key: "edit",
								className: "dsh-pm-edit",
								value: draft,
								spellCheck: false,
								onChange: (event) => setDraft(event.target.value),
							})
						: tab === "__overview__"
							? h(
									"div",
									{ key: "overview", className: "dsh-pm-section" },
									(overview ?? []).length === 0
										? h("p", { className: "dsh-pm-empty" }, "还没有工作区。")
										: (overview ?? []).map((row) =>
												h(
													"div",
													{ key: row.root, className: "dsh-pm-overview-row" },
													h(
														"div",
														{ className: "dsh-pm-title-row" },
														h("span", { className: "dsh-pm-name" }, workspaceName(row)),
														h("span", { className: "dsh-pm-path" }, row.root),
														row.lastSyncAt ? h("span", { className: "dsh-pm-meta" }, `同步于 ${agoText(row.lastSyncAt, Date.now())}`) : null,
													),
													h("pre", { className: "dsh-pm-pre dsh-pm-overview-pre" }, row.state.length === 0 ? "（现状一节还是空的）" : row.state),
													row.latestSession.length === 0 ? null : h("pre", { className: "dsh-pm-pre dsh-pm-overview-pre" }, row.latestSession),
												),
											),
								)
							: tab === "SESSIONS-archive.md"
								? h(
										"div",
										{ key: "archive", className: "dsh-pm-section" },
										h("p", { className: "dsh-pm-hint" }, "归档条目不会被自动注入。点「恢复这条」把它搬回日志顶部。"),
										archiveEntries.length === 0
											? h("p", { className: "dsh-pm-empty" }, "（归档是空的）")
											: archiveEntries.map((part, index) => {
													const entry = "## " + part;
													return h(
														"div",
														{ key: index, className: "dsh-pm-archive-entry" },
														h(
															"div",
															{ className: "dsh-pm-toolbar" },
															h("button", { className: "dsh-pm-btn", disabled: busy !== "", onClick: () => restoreEntry(entry) }, "恢复这条"),
														),
														h("pre", { className: "dsh-pm-pre" }, entry),
													);
												}),
									)
								: h("pre", { key: "pre", className: "dsh-pm-pre" }, body.length === 0 ? "（这个文件目前是空的）" : body),
					// The instruction file is not one of the four; it gets its own section
					// rather than sitting between the tabs and the text they select.
					h(
						"section",
						{ key: "instruction", className: "dsh-pm-section" },
						h(
							"div",
							{ className: "dsh-pm-section-head" },
							h("span", { className: "dsh-pm-panel-label" }, "指令文件"),
							h("span", { className: "dsh-pm-path" }, boot === null ? "读取中…" : String(boot.file ?? "")),
							boot === null
								? null
								: h(
										"span",
										{ className: "dsh-pm-badge" },
										boot.exists ? (boot.current ? "已写入" : "旧版本") : boot.fileExists ? "未写入" : "文件不存在",
									),
						),
						h(
							"div",
							{ className: "dsh-pm-toolbar" },
							editingInstruction
								? h("button", { className: "dsh-pm-btn dsh-pm-btn-primary", onClick: saveInstruction, disabled: busy !== "" }, busy === "instruction" ? "保存中…" : "保存")
								: h("button", { className: "dsh-pm-btn dsh-pm-btn-primary", onClick: startInstructionEdit, disabled: busy !== "" || instruction === null }, "编辑整份文件"),
							editingInstruction
								? h("button", { className: "dsh-pm-btn", onClick: () => { setEditingInstruction(false); setInstructionDraft(""); }, disabled: busy !== "" }, "取消")
								: null,
							editingInstruction
								? null
								: h("button", { className: "dsh-pm-btn", onClick: () => bootAction("rewrite"), disabled: busy !== "" || boot === null }, busy === "boot" ? "写入中…" : "重写 Memory 段"),
							editingInstruction
								? null
								: h("button", { className: "dsh-pm-btn dsh-pm-btn-danger", onClick: () => bootAction("remove"), disabled: busy !== "" || boot === null || !boot.exists }, "移除 Memory 段"),
							h(
								"span",
								{ className: "dsh-pm-hint" },
								editingInstruction
									? `${instruction === null ? "指令文件" : instruction.name} 整份可改，Memory 段也在里面`
									: boot === null
										? ""
										: boot.exists
											? "新会话开头会自动加载这一段；移除后，下个新会话会把它写回"
											: "没有它，新会话不会知道 memory/ 的存在",
							),
						),
						editingInstruction
							? h("textarea", {
									key: "instruction-edit",
									className: "dsh-pm-edit",
									value: instructionDraft,
									spellCheck: false,
									onChange: (event) => setInstructionDraft(event.target.value),
								})
							: null,
					),
					// Last, alone, and behind a second click: this is the only control here
					// that destroys something.
					h(
						"div",
						{ key: "danger", className: "dsh-pm-danger" },
						confirmClear
							? [
									h(
										"span",
										{ key: "warn", className: "dsh-pm-warn" },
										`会删掉 ${workspaceName(current)} 的全部记忆文件（含归档），并移除指令文件里的 Memory 段。`,
									),
									h("button", { key: "yes", className: "dsh-pm-btn dsh-pm-btn-danger", onClick: clearWorkspace, disabled: busy !== "" }, busy === "clear" ? "清除中…" : "确认清除"),
									h("button", { key: "no", className: "dsh-pm-btn", onClick: () => setConfirmClear(false), disabled: busy !== "" }, "取消"),
								]
							: [
									h("span", { key: "label", className: "dsh-pm-hint" }, "危险操作"),
									h("button", { key: "clear", className: "dsh-pm-btn dsh-pm-btn-danger", onClick: () => setConfirmClear(true), disabled: busy !== "" }, "清除记忆文件"),
								],
					),
				];
			};

			const children = [
				h(
					"div",
					{ key: "head", className: "dsh-pm-head" },
					h(
						"div",
						null,
						h("h2", null, "项目记忆"),
						h(
							"p",
							{ className: "dsh-pm-intro" },
							"每个工作区一份 memory/：PROJECT.md 是项目现状，DECISIONS.md 是已定决策，SESSIONS.md 是会话日志，SESSIONS-archive.md 是搬出去的老日志。新会话会自动创建并加载这三个文件。",
						),
					),
					h("button", { className: "dsh-pm-btn", onClick: refresh, disabled: busy !== "" }, busy === "refresh" ? "刷新中…" : "刷新"),
				),
				error ? h("p", { key: "err", className: "dsh-pm-status dsh-pm-err", role: "alert" }, error) : null,
				// Left picks, right shows. The picker keeps its position, so the detail
				// never loses its subject.
				h(
					"div",
					{ key: "body", className: "dsh-pm-body" },
					h(
						"aside",
						{ className: "dsh-pm-side" },
						h(
							"div",
							{ className: "dsh-pm-side-head" },
							h("span", { className: "dsh-pm-panel-label" }, "工作区"),
							h("span", { className: "dsh-pm-count" }, String((workspaces ?? []).length)),
						),
						h("input", {
							className: "dsh-pm-search",
							type: "search",
							placeholder: "按路径筛选…",
							value: search,
							onChange: (event) => setSearch(event.target.value),
						}),
						h(
							"div",
							{ className: "dsh-pm-list" },
							workspaces === null
								? h("p", { className: "dsh-pm-empty" }, "读取中…")
								: workspaces.length === 0
									? h("p", { className: "dsh-pm-empty" }, "还没有记录过任何工作区。在任意项目里开一个会话，这里就会出现它。")
									: shown.length === 0
										? h("p", { className: "dsh-pm-empty" }, "没有匹配的工作区。")
										: shown.map((workspace) =>
												h(
													"button",
													{
														key: workspace.root,
														className: "dsh-pm-item",
														"data-active": String(workspace.root === selected),
														onClick: () => pick(workspace.root),
													},
													h(
														"span",
														{ className: "dsh-pm-item-top" },
														h("span", { className: "dsh-pm-name" }, workspaceName(workspace)),
														h("span", { className: "dsh-pm-badge" }, workspace.exists ? (workspace.empty ? "空" : "已记录") : "已清除"),
													),
													h("span", { className: "dsh-pm-path" }, workspace.root),
												),
											),
						),
					),
					h("section", { className: "dsh-pm-main" }, current === null ? h("p", { className: "dsh-pm-empty" }, "左边选一个工作区。") : detail()),
				),
			];

			if (status.text) {
				children.push(
					h("p", { key: "status", className: `dsh-pm-status ${status.kind === "err" ? "dsh-pm-err" : "dsh-pm-ok"}`, role: "status" }, status.text),
				);
			}

			return h("div", { className: "dsh-pm" }, children);
		}

/**
		 * Mount the settings section.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			const style = document.createElement("style");
			style.id = "dsh-trilogy-settings-style";
			style.textContent = CSS;
			(document.head || document.documentElement).appendChild(style);

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "trilogy",
						order: 60,
						label: () => "项目记忆",
					},
					SettingsPanel,
				),
			);

			// Bottom-left of the composer tool row: live status + last sync time.
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "trilogy-status",
						order: 50,
					},
					StatusChip,
				),
			);
		}

		exports.name = "dsh-trilogy";
		// The module's own Cordis service gate. `settings.section` comes from the
		// slots service, and the shell may declare the seat after this bundle loads.
		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	},
});