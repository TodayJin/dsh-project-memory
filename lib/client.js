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

		const CSS = `
.dsh-pm{display:flex;flex-direction:column;gap:12px;width:100%;max-width:860px;color:var(--dsw-alias-label-primary)}
.dsh-pm h2{margin:0;font-size:16px}
.dsh-pm-intro{margin:0;font-size:12px;opacity:.75;line-height:1.6}
.dsh-pm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-pm-btn{border:1px solid var(--dsw-alias-border-secondary,#0003);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer}
.dsh-pm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-btn:disabled{opacity:.45;cursor:default}
.dsh-pm-btn-primary{border-color:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe)}
.dsh-pm-btn-danger{color:#d33}
.dsh-pm-list{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:8px;padding:6px;max-height:220px;overflow:auto}
.dsh-pm-item{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:6px;cursor:pointer;text-align:left;background:transparent;border:0;color:inherit;font:inherit;width:100%}
.dsh-pm-item:hover{background:var(--dsw-alias-bg-secondary,#0000000d)}
.dsh-pm-item[data-active="true"]{background:var(--dsw-alias-bg-secondary,#0000000d);outline:1px solid var(--dsw-alias-brand-primary,#3964fe55)}
.dsh-pm-name{font-size:13px;font-weight:500}
.dsh-pm-path{font-size:11px;opacity:.6;word-break:break-all}
.dsh-pm-badge{font-size:10px;border-radius:999px;padding:1px 7px;border:1px solid currentColor;opacity:.8;white-space:nowrap}
.dsh-pm-tabs{display:flex;gap:6px;flex-wrap:wrap}
.dsh-pm-pre{margin:0;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-secondary,#0000000a);max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6}
.dsh-pm-status{font-size:12px;min-height:18px}
.dsh-pm-ok{color:#1a8f4a}
.dsh-pm-err{color:#d33}
.dsh-pm-empty{font-size:12px;opacity:.7;padding:10px}
.dsh-pm-search{border:1px solid var(--dsw-alias-border-secondary,#0002);background:transparent;color:inherit;border-radius:6px;padding:5px 8px;font:inherit;font-size:12px;width:100%}
.dsh-pm-meta{font-size:11px;opacity:.6;margin-left:auto;align-self:center}
.dsh-pm-edit{width:100%;min-height:340px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-secondary,#0000000a);color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6;resize:vertical}
.dsh-pm-overview-row{border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:10px;display:flex;flex-direction:column;gap:6px}
.dsh-pm-overview-row:first-child{border-top:0;padding-top:0}
.dsh-pm-overview-pre{max-height:150px;font-size:11px}
.dsh-pm-archive-entry{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:8px}
.dsh-pm-archive-entry:first-child{border-top:0;padding-top:0}
.dsh-pm-btn[data-active="true"]{border-color:var(--dsw-alias-brand-primary,#3964fe);color:var(--dsw-alias-brand-primary,#3964fe)}
.dsh-pm-panel{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-secondary,#0002);border-radius:10px;padding:10px 12px}
.dsh-pm-panel-quiet{border-style:dashed;background:var(--dsw-alias-bg-secondary,#00000008)}
.dsh-pm-panel-label{font-size:10.5px;letter-spacing:.08em;opacity:.5;text-transform:uppercase}
.dsh-pm-danger-row{border-top:1px solid var(--dsw-alias-border-secondary,#0002);padding-top:9px;margin-top:1px}
.dsh-pm-hint{font-size:11px;opacity:.5;align-self:center;margin-right:2px}
.dsh-pm-tab{border-radius:999px;padding:4px 12px}
.dsh-pm-tabs{gap:5px}
.dsh-pm-sep{border:0;border-top:1px solid var(--dsw-alias-border-secondary,#0002);margin:2px 0}
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
			const response = await fetch(`${API}${path}`, {
				cache: "no-store",
				headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
				...init,
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
			const label = canInit ? "无记忆 · 点击创建" : hasSync ? (PHASE_LABEL[shown] ?? shown) : "尚未同步 · 点击更新";

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
				} catch (failure) {
					setFiles(null);
					setError(messageOf(failure));
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
					}
				});
			}, [loadWorkspaces, loadFiles]);

			const pick = (root) => {
				setSelected(root);
				setStatus({ kind: "idle", text: "" });
				loadFiles(root);
			};

			const refresh = async () => {
				setBusy("refresh");
				const list = await loadWorkspaces();
				const stillThere = list.some((w) => w.root === selected);
				if (stillThere) await loadFiles(selected);
				setBusy("");
				setStatus({ kind: "ok", text: "已刷新" });
			};

			const clearWorkspace = async () => {
				if (!selected) return;
				setBusy("clear");
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


			const meta = entry === null || entry === undefined ? "" : `${entry.bytes} 字节${entry.mtime ? ` · 修改于 ${agoText(entry.mtime, Date.now())}` : ""}`;

			const children = [
				h("h2", { key: "title" }, "项目记忆"),
				h(
					"p",
					{ key: "intro", className: "dsh-pm-intro" },
					"每个工作区一份 memory/，含 PROJECT.md（项目现状，就地编辑）、DECISIONS.md（已定决策，只追加）、SESSIONS.md（会话日志，只追加）。新会话会自动创建并在开始时加载这三个文件。",
				),
				error ? h("p", { key: "err", className: "dsh-pm-status dsh-pm-err", role: "alert" }, error) : null,
				h(
					"div",
					{ key: "row1", className: "dsh-pm-row" },
					h("button", { className: "dsh-pm-btn", onClick: refresh, disabled: busy !== "" }, busy === "refresh" ? "刷新中…" : "刷新"),
					h("span", { className: "dsh-pm-intro" }, `${(workspaces ?? []).length} 个工作区`),
				),
				h("hr", { key: "sep", className: "dsh-pm-sep" }),
			];

			if (workspaces !== null && workspaces.length === 0) {
				children.push(
					h("p", { key: "none", className: "dsh-pm-empty" }, "还没有记录过任何工作区。在任意项目里开一个会话，这里就会出现它。"),
				);
				return h("div", { className: "dsh-pm" }, children);
			}

			children.push(
				h("input", {
					key: "search",
					className: "dsh-pm-search",
					type: "search",
					placeholder: "按路径筛选工作区…",
					value: search,
					onChange: (event) => setSearch(event.target.value),
				}),
				h(
					"div",
					{ key: "list", className: "dsh-pm-list" },
					shown.length === 0
						? h("p", { className: "dsh-pm-empty" }, "没有匹配的工作区。")
						: shown.map((w) =>
								h(
									"button",
									{ key: w.root, className: "dsh-pm-item", "data-active": String(w.root === selected), onClick: () => pick(w.root) },
									h("span", { className: "dsh-pm-name" }, workspaceName(w)),
									h("span", { className: "dsh-pm-badge" }, w.exists ? (w.empty ? "空" : "已记录") : "已清除"),
									h("span", { className: "dsh-pm-path" }, w.root),
								),
							),
				),
			);

			if (current !== null) {
				children.push(
					h(
						"div",
						{ key: "toolbar", className: "dsh-pm-panel" },
						h("span", { className: "dsh-pm-panel-label" }, "操作"),
						h(
							"div",
							{ className: "dsh-pm-row" },
							editing
								? h("button", { className: "dsh-pm-btn dsh-pm-btn-primary", onClick: saveFile, disabled: busy !== "" }, busy === "save" ? "保存中…" : "保存")
								: h("button", { className: "dsh-pm-btn dsh-pm-btn-primary", onClick: () => { setDraft(body); setEditing(true); setStatus({ kind: "idle", text: "" }); }, disabled: busy !== "" }, "编辑"),
							editing
								? h("button", { className: "dsh-pm-btn", onClick: () => { setEditing(false); setDraft(""); }, disabled: busy !== "" }, "取消")
								: h("button", { className: "dsh-pm-btn", onClick: () => loadFiles(selected), disabled: busy !== "" }, "重新读取"),
						),
						h(
							"div",
							{ className: "dsh-pm-row dsh-pm-danger-row" },
							h("span", { className: "dsh-pm-hint" }, "会改动磁盘："),
							h("button", { className: "dsh-pm-btn dsh-pm-btn-danger", onClick: clearWorkspace, disabled: busy !== "" }, busy === "clear" ? "清除中…" : "清除记忆文件"),
						),
					),
					h(
						"div",
						{ key: "filebar", className: "dsh-pm-panel dsh-pm-panel-quiet" },
						h(
							"div",
							{ className: "dsh-pm-row" },
							h("button", { className: "dsh-pm-btn dsh-pm-tab", "data-active": String(tab === "__overview__"), onClick: () => { setTab("__overview__"); setEditing(false); loadOverview(); } }, "全部工作区"),
							h("span", { className: "dsh-pm-panel-label" }, "文件"),
							h(
								"div",
								{ className: "dsh-pm-tabs" },
								["PROJECT.md", "DECISIONS.md", "SESSIONS.md", "SESSIONS-archive.md"].map((fileName) =>
									h(
										"button",
										{ key: fileName, className: "dsh-pm-btn dsh-pm-tab", "data-active": String(fileName === tab), onClick: () => { setTab(fileName); setEditing(false); } },
										fileName,
									),
								),
							),
							h("span", { className: "dsh-pm-meta" }, editing ? "编辑中，未保存" : meta),
						),
					),
					editing
						? h("textarea", {
								key: "edit",
								className: "dsh-pm-edit",
								value: draft,
								spellCheck: false,
								onChange: (event) => setDraft(event.target.value),
							})
						: 				tab === "__overview__"
					? h(
						"div",
						{ key: "overview", className: "dsh-pm-panel dsh-pm-panel-quiet" },
						(overview ?? []).length === 0
							? h("p", { className: "dsh-pm-empty" }, "还没有工作区。")
							: (overview ?? []).map((row) =>
								h(
									"div",
									{ key: row.root, className: "dsh-pm-overview-row" },
									h("div", { className: "dsh-pm-row" },
										h("span", { className: "dsh-pm-name" }, workspaceName(row)),
										h("span", { className: "dsh-pm-path" }, row.root),
										row.lastSyncAt ? h("span", { className: "dsh-pm-meta" }, `· 同步于 ${agoText(row.lastSyncAt, Date.now())}`) : null,
									),
									h("pre", { className: "dsh-pm-pre dsh-pm-overview-pre" }, row.state.length === 0 ? "（State 一节还是空的）" : row.state),
									row.latestSession.length === 0 ? null : h("pre", { className: "dsh-pm-pre dsh-pm-overview-pre" }, row.latestSession),
								),
							),
						)
				: tab === "SESSIONS-archive.md"
					? h(
						"div",
						{ key: "archive", className: "dsh-pm-panel dsh-pm-panel-quiet" },
						h("p", { className: "dsh-pm-hint" }, "归档条目不会被自动注入。点「恢复」把它搬回活日志顶部。"),
												body.length === 0
							? h("p", { className: "dsh-pm-empty" }, "（归档是空的）")
							: body.split(/^## /m).filter((part) => part.trim().length > 0).map((part, index) => {
									const entry = "## " + part.trim();
									return h(
										"div",
										{ key: index, className: "dsh-pm-archive-entry" },
										h("div", { className: "dsh-pm-row" },
											h("button", { className: "dsh-pm-btn", disabled: busy !== "", onClick: () => restoreEntry(entry) }, "恢复这条"),
										),
										h("pre", { className: "dsh-pm-pre" }, entry),
									);
								}),
					)
				: h("pre", { key: "pre", className: "dsh-pm-pre" }, body.length === 0 ? "（这个文件目前是空的）" : body),
				);
			}

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