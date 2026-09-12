# dsh-trilogy

**给 DeepSeek Harness 的项目记忆插件** —— 为每个工作区维护三份 Markdown 记忆文件：**自动创建、自动加载、自动记录**。

记忆不该靠模型自觉。这些行为由 **host 插件**保证，而不是靠提示词提醒模型：

| 能力 | 只靠提示词/技能 | 本插件 |
|---|---|---|
| 新建项目自动创建三个文件 | ❌ 要人工触发 | ✅ 会话启动时自动 scaffold |
| 每个会话开始加载三个文件 | ❌ 靠模型记得读 | ✅ 自动注入 + 内容摘要去重 |
| 进展分类记录进三个文件 | ⚠️ 靠模型自觉 | ✅ 收尾兜底提醒 + `memory_checkpoint` 工具 |

> 「会话冷启动」与「锁定决策」是原生实现，不依赖模型自觉。

---

## 三个文件

全部在 `<项目根>/memory/` 下。**项目根的判定规则**：

**项目根 = 会话工作目录本身。** 插件完全不看版本控制 —— 你打开哪个目录，记忆就写在那个目录的
`memory/` 里。工作区有没有 `.git` 都不影响判定。

若你想要「一个仓库一份记忆、不要每个子包各一份」，把 `projectRootStrategy` 设成 `"marker"`，
插件才会向上找 `projectRootMarkers`（默认 `.git`）。

| 文件 | 职责 | 写入方式 |
|---|---|---|
| `PROJECT.md` | 项目**现在**是什么 | **就地编辑**，控制在一屏内 |
| `DECISIONS.md` | 为什么是这样 | **只追加，最新在最上** |
| `SESSIONS.md` | 发生了什么、什么时候 | **只追加，最新在最上** |

`PROJECT.md` 的固定五节：`What this is` / `Run and test` / `Where things live` / `State` / `Traps`。
空节写 `none yet`。

### 什么才配占一行

对每条候选只问一句：

> **没有这条，未来的会话会不会浪费时间、或者重犯同一个错误？**

不合格的候选是**丢弃，不是删短**。删除是受限操作：只允许「刚写入的这行直接取代了某一行」的**配对替换**，
其他看着陈旧的内容会被要求写进报告交给你决定，而不是被静默删掉。

### 路由表

| 内容性质 | 去向 |
|---|---|
| 改变「项目是什么」或「怎么跑」 | `PROJECT.md`（就地编辑） |
| 定下来的选择 + 被否决的替代 | `DECISIONS.md`（顶部追加） |
| 本次会话做了什么、怎么验证的 | `SESSIONS.md`（顶部追加） |

---

## 安装

**前置**：`pnpm` 在 PATH 上，DSH `0.1.5-rc.2`。

```sh
# 从本地目录安装（link，改代码即时生效，适合开发）
dsh plugin --profile web add link:D:/path/to/dsh-trilogy

# 重启 dsh web 生效
```

卸载：

```sh
dsh plugin --profile web remove dsh-trilogy
```

`dsh plugin add` 会自动写入 profile 依赖并追加到 `dsh.profile.bundles`，**无需手工编辑**。
`memory/` 目录属于你的项目，卸载插件不会删除它。

---

## 使用

装好后**不需要任何操作**：

1. 在任意项目里开一个会话 → `memory/` 三个文件和 `AGENTS.md` 的 boot block 被自动创建；
2. **项目还没被描述过时**（`PROJECT.md` 五节全是 `none yet`）→ 注入一条"去调研这个项目并填上"的指令，
   模型会读 README / 构建与测试配置 / 入口点 / 目录结构，**并真的跑一遍测试命令**，然后填 `PROJECT.md`。
   填完就不再提；
3. 之后每个会话开始 → 三个文件自动注入上下文（内容没变则不重复注入，**KV cache 友好**）；
4. 会话干了实事却没记录 → 收尾时收到一条很短的提醒，由**主模型**自己判断该不该记。

### 初次填充（bootstrap）

模板不等于项目说明。插件把"先调研再写"这一步也自动化了 ——
scaffold 出空模板后，只要 `PROJECT.md` 还是空的，就注入一条 bootstrap 指令，要求：

1. 读 README、构建与测试配置、入口点、目录结构；**有测试命令就真的跑一遍并记录是否通过**；
2. 用 `memory_checkpoint` 填 `PROJECT.md` 五节 —— **每条论断都必须来自读过的文件或跑过的命令**；
3. 补一条真实的 `SESSIONS.md` 记录和已定的 `DECISIONS.md` 条目。

填完后 bootstrap 自动消失（靠内容判断，不需要额外状态）。用 `bootstrapWhenEmpty: false` 关掉。

> 手写了自己标题格式的 `PROJECT.md` 不会被判定为"空"，因此不会被反复催。

### 输入框状态图标

对话框**左下角**（`conversation.input.left` 座位）常驻一个小指示器：

```
[图标] 正在记录 · 刚刚
```

| 阶段 | 显示 | 触发时机 |
|---|---|---|
| `recording` | **正在记录** | `memory_checkpoint` 正在写文件 |
| `updating` | **正在更新** | 长时间写入进行中 |
| `done` | **更新完毕** | 刚写完（约 8 秒后自动回落为「已同步」） |
| `idle` | **已同步** | 无进行中的写入 |

后面跟的是**最近的同步时间**（`刚刚` / `N 秒前` / `N 分钟前` / `N 小时前` / `N 天前`）。
悬停显示完整信息：状态、最近同步、工作区路径、写入的文件。

数据来自宿主时钟 —— 响应里带一个 `now` 字段，所以浏览器不需要相信自己的时钟。
客户端每 4 秒轮询一次 `GET /trilogy/status`；宿主不可达时保留最后一次读数。

> 图标用 UI primitives 的 `IconLoadingOutline16` / `IconRefreshOutline14` /
> `IconCheckOutline14` / `IconDatabaseOutline16`；若该模块缺少对应图标，
> 自动回退成一个会随状态变色的圆点。

### 图形设置界面

插件带一个浏览器半边，在 **设置 → 项目记忆** 里：

| 功能 | 说明 |
|---|---|
| **查看记录** | 列出所有记录过的工作区（名称、路径、`已记录`/`空`/`已清除` 徽标、最近活跃时间） |
| **实时查看** | 选中工作区后，分页签直接读 `PROJECT.md` / `DECISIONS.md` / `SESSIONS.md` / `SESSIONS-archive.md` 的最新内容 |
| **清除** | 删掉该工作区的**全部**记忆文件（含 `SESSIONS-archive.md`），并撤回 `AGENTS.md` 里的 boot block。**注册表条目保留** —— 下次在该工作区开新会话会重新创建空文件 |
| **编辑并保存** | 三个文件都能直接在界面里改，白名单只允许写这三个文件 |
| **搜索筛选** | 工作区多时按路径过滤 |
| **指令文件** | 显示 `AGENTS.md` 里 Memory 段的状态（`已写入` / `旧版本` / `未写入` / `文件不存在`），可**重写**或**移除**这一整段。移除只摘掉这一段，文件其余内容原样保留 |
| **陈旧提醒** | `PROJECT.md` 落后于其余记忆文件超过 `projectStaleDays`（默认 14 天）时，在面板顶部给出横幅，并说明这期间追加了多少条日志 |
| **归档与恢复** | 归档页签逐条列出被搬走的会话记录，点「恢复这条」把它搬回活日志顶部。归档与「全部工作区」概览都是**只读**的 —— 宿主只允许写那三个活文件，所以那里不提供编辑器 |
| **全部工作区** | 一屏概览每个工作区的 `State` 一节与最新会话条目 |
| **导出 / 导入** | 把一个工作区的 `memory/` 导出成单个 JSON 记忆包，在另一台机器或另一个工作区导入。导入会覆盖同名文件，且**只接受本插件导出的包**（按 `kind` 校验） |

工作区列表在**打开设置页时**从活会话回填，所以历史项目（在新功能之前建的 `memory/`）也会出现。

**写入受限**：清除、初始化、保存都是写操作，而裸 `webServer` 路由本身没有鉴权，因此
整个 `/trilogy` 前缀被**限制为本机访问**（非 loopback 返回 403）。

> 插件**完全不调用模型** —— 没有向量检索、没有 embedding、没有后台蒸馏。
> `PROJECT.md` 的初次内容由**会话里的模型**自己去读文件、跑测试命令后写入。

### 模型侧工具

| 工具 | 作用 |
|---|---|
| `memory_checkpoint` | 按路由表分类写入。参数：`sessions[]` / `decisions[]` / `project[]` / `notes` |
| `memory_read` | 按需读取某个记忆文件（三个文件默认已自动加载；也含 `SESSIONS-archive.md`） |
| `memory_search` | 零依赖 BM25 检索，连归档一起搜 —— 注入预算之外的内容也找得回来 |

日期由**插件**从系统时钟盖戳，不靠模型记 —— 让模型自己读系统日期是不可靠的。

### 收尾兜底（nudge）

- **不额外调用模型** —— 复用当前会话里已在跑的主模型，token 开销只是一条短提醒
- 只在「这轮干了实事」且「这轮没记录任何东西」时触发
- 有冷却时间与每会话次数上限，无事发生的轮次不打扰
- 「值不值得记」由主模型判断（它上下文最全），插件只负责**保证它一定会被问一次**

---

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，例如：

```yaml
- id: trilogy
  config:
    injectBudgetBytes: 24000
    nudgeMaxPerSession: 5
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `memoryDirName` | `"memory"` | 记忆目录名（相对项目根） |
| `projectRootMarkers` | `[".git"]` | 项目根标识 |
| `autoScaffold` | `true` | 缺文件时自动创建 |
| `writeBootBlock` | `true` | 往 `AGENTS.md` 追加 Memory 段 |
| `bootBlockFile` | `"AGENTS.md"` | boot block 写进哪个文件 |
| `injectOnSessionStart` | `true` | 会话开始自动注入 |
| `bootstrapWhenEmpty` | `true` | `PROJECT.md` 还空着时，注入"去调研并填上"的指令 |
| `sessionsMaxEntries` | `200` | SESSIONS.md 超过这个条数才把最旧的搬到归档（阈值定得高，避免过早压缩） |
| `projectRootStrategy` | `"workspace"` | `workspace` = 工作区即项目；`marker` = 向上找 `.git` |
| `injectBudgetBytes` | `16000` | 注入总字节预算 |
| `sessionEntriesInjected` | `5` | 注入最近几条 SESSIONS 条目 |
| `nudgeOnTurnEnd` | `true` | 收尾智能判断兜底 |
| `nudgeCooldownMs` | `600000` | 兜底提醒冷却（10 分钟） |
| `nudgeMaxPerSession` | `3` | 每会话兜底提醒上限（**成功写入一次就清零**，长会话不会因为额度用完而沉默） |
| `projectStaleDays` | `14` | `PROJECT.md` 落后其余记忆文件多少天才提示陈旧；`0` 关闭提示 |

**模板可改**：三个文件和 boot block 的模板在 `templates/`，运行时直接读取；目录缺失时回退到内置副本。

---

## 注入预算的取舍顺序

超预算时按此顺序降级（`PROJECT.md` 是「当前状态」，优先级最高）：

1. 完整注入三个文件；
2. 丢掉 `SESSIONS.md` 的条目；
3. 只保留 `DECISIONS.md` 头部；
4. 最后才硬截断 `PROJECT.md`（并标注 `[truncated to fit the injection budget]`）。

---

## 开发与测试

```sh
node test/smoke.mjs            # 56 项，宿主半边
node test/client-render.mjs    # 6 项，浏览器半边：每个组件都真的渲染一次
node test/client-interact.mjs  # 21 项，浏览器半边：点击 → 请求 → 状态 → 重渲染
```

`smoke.mjs` 用假 ctx 驱动真实的 `apply()`。两个浏览器套件用 vm 沙箱跑 bundle：
渲染套件用一个 React 桩同步调用每个注册的组件（组件引用未声明的变量会被
`SlotErrorBoundary` 静默吞成空白页，渲染套件把那片沉默变成一条失败测试）；
交互套件换成一个会真正重渲染的迷你 React 运行时，配一个**会把每个请求体当 JSON 解析**
的假宿主 —— `fetch` 会把普通对象悄悄变成 `"[object Object]"`，只有真解析才拦得住。

> **改了 `lib/client.js` 就必须跑两个客户端套件，并重启 `dsh web`。** 客户端 bundle 在
> 启动时快照，base bundle 里 `hmr` 是 `disabled: true`。
>
> `test/` 与 `node_modules/` 不在发布文件清单里。本地跑测试需要 `node_modules/@deepseek-ai`
> 能解析到 DSH 的包（开发时用 junction 指向 DSH 安装目录即可）。

---

## 已知边界

- **不做**：向量检索、embedding、网络请求、后台服务、修改 DSH 核心
- 写入用 `node:fs` 直连，不走 harness 的 `ctx.fs` seam —— scaffold 必须在任何 provider 下都一致工作；
  seam 的 resolve/write 契约是为**沙箱化的工具执行**设计的
- 与 `AGENTS.md` **共存**：`AGENTS.md` 管「该守什么规矩」，三个文件管「项目是什么、发生了什么」
- `DECISIONS.md` 允许模型写入，但要求在条目里写明被否决的替代与约束（没有这些就不该写）

---

## 参考

- 设计说明：[`DESIGN.md`](./DESIGN.md)
