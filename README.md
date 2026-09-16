# pi-multi-project

给 [pi](https://github.com/earendil-works/pi-mono) 的两个扩展，解决同一件事：**让 pi 在多个项目之间工作时保持上下文**。

| 扩展 | 一句话 |
|---|---|
| **pi-tasks** | 跨项目任务栏：看到有哪些项目、一键切换、防止两个终端写坏同一个会话 |
| **pi-memory** | 项目级长期记忆：把结论沉淀进项目，下次开新会话自动带着 |

> **状态：beta。** 逻辑层有 110 项自动化断言覆盖，但真实 TUI 交互尚未充分验证（见[已知限制](#已知限制)）。

---

## 你会得到什么

### 1. 不用再记「我有几个项目开着、都在哪个目录」

**之前**：pi 本身也能跨项目恢复会话——`/resume` 里按 `Tab` 切到 `All` 视图就能列出所有项目的会话。但那是一个**平铺的会话列表**（可按 threaded / recent / fuzzy 排序）：没有项目分组，看不到分支，也**不显示哪些会话正被别的终端占用**，而且每次都得先打开选择器。

**之后**：页脚常驻一行，编辑器下方可选常驻任务栏。

```
agent_work_plante  ·  ▸3  ·  +2 other  ·  ●1 busy
        │              │       │            └ 有 1 个会话正被别的终端占用
        │              │       └ 除当前项目外还有几个
        │              └ 可见项目总数
        └ 你现在的项目
```

```
▸ agent_work_plante      now    2s    main
  proj-beta              3h     1s    main
  proj-alpha             2d     5s    master
```

`▸` 是当前所在项目（两处示例一致）。按 **`ctrl+↓`**（编辑器为空时）进入导航态：`↑↓` 选、`Enter` 切、`Esc` 退出。

### 2. 切换项目后**真的看到那边的对话历史**

不是只改个 cwd 就完事——pi 的 `switchSession` 会拿该会话自己的 cwd 重建整个 runtime，消息、工具调用、上下文全部切过去，就像一直在那个终端里工作。

### 3. 两个终端**不会写坏同一个会话**

pi 的会话文件**没有锁**，pi 核心也不检查这一点。两个终端切到同一个会话文件时，两边都往同一个 JSONL 追加，记录会交错损坏，而且**没有任何提示**（`/resume` 同样不拦）。

pi-tasks 给每个会话落一把 pid 锁，切换前检查。撞上了会拦你：

```
该会话已在别处打开
pid 12345 正在使用这个会话文件。
同时写入可能导致记录损坏。仍要切换？
```

进程已死的僵尸锁会被自动清理，不用手工干预。

### 4. 新会话不用重新交代项目背景

**之前**：pi 会**读取** `AGENTS.md` 并注入，但**从不往里写**。所以每次开新会话，项目背景、踩过的坑、定下的约定都得重新讲一遍。

**之后**：任务收尾时把结论记下来，下次自动生效。

```
<!-- pi-memory:start -->
## 项目记忆

- [decision] 项目身份默认用归一化 cwd，worktree 集合例外
  理由：worktree 共享历史，拆成两条会让人误以为换了项目
- [pitfall] switchSession 只在命令上下文上有，快捷键里没有
> 更早的 8 条已归档：`.pi/memory-archive.md`（需要时自行 read/grep）
<!-- pi-memory:end -->
```

### 5. 记忆**不会丢、不会膨胀、不会污染**

这三个都是真会发生的事，各有一条针对性设计：

| 风险 | 处理 |
|---|---|
| 两个 pi 同时写入，后写的静默吃掉先写的 | 独占文件锁 + **拿到锁后重新读取**再应用增量 |
| 记忆无限增长，把上下文预算吃光 | 超 60 行时最旧条目**剪进归档**，一条不丢，只是不再注入 |
| 在祖先目录（尤其家目录）写入，渗漏到其下所有项目 | 门禁：只在「看起来是项目」的目录写；家目录**显式排除** |

门禁拒绝时不是说句"不行"就完了，会告诉你为什么、以及该怎么做：

```
当前 cwd 是家目录。家目录是几乎所有项目的祖先，且本身可能就是个 git 仓库。
→ 拒绝写入项目层，否则会渗漏到其下所有子项目。

pi-memory 只负责项目层记忆。全局偏好请直接手写 ~/.pi/agent/AGENTS.md：
pi 原生就会加载它，不需要扩展参与。

或者 cd 到一个真实项目目录再记。
```

### 6. 用 Git worktree 时，记忆**不跟着分支跑**

这是最隐蔽的一个问题。worktree 里的 `AGENTS.md` 是**被 Git 跟踪的文件**，所以如果记忆写在那儿：

```
在 feature 分支记一条 → 提交 → 切回 main → 记忆消失了
                                    → 合并回 main → 它才重新出现
```

**记忆本该跟「项目」走，结果跟「分支」走了。**

现在检测到同一仓库有多个 worktree 时，记忆改放共同 `.git` 下的本地共享区：

- 任务栏把它们合并成**一个**项目，分支并列显示：`⎇2  feature/x + main`
- 记忆只存一份，所有 worktree 共享，**不写入任何分支的 checkout**
- 位于 `.git` 内 = 本地于 clone，不进 Git、不随 `checkout` 变化

```
▸ agent_work_plante      now    2s    ⎇2  codex/rag-retrieval-evaluation + main
```

**普通项目（单 worktree）行为完全不变**，仍是 `<项目>/AGENTS.md`，仍由 pi 原生逐级注入。

---

## 快速开始

```bash
pi install git:github.com/zxl3305479573-max/pi-multi-project
```

装完 `/reload` 或重启 pi 生效。卸载：`pi remove <source>`。

**30 秒上手**：

1. 在项目里按 **`ctrl+↓`**，用 `↑↓` + `Enter` 切到另一个项目
2. 干活，觉得"这点值得记住"，`/remember 结论写这里`
3. 任务结束时 pi 会弹一次确认框，确认即写入

要求：pi 已安装、Node.js 18+。

两个扩展都**只用 pi 的原生机制**：不引入数据库、不复制对话内容、不改 pi 本身。索引和记忆都是人可读、可删、可手工编辑的普通文件。

---

## pi-tasks

### 命令

| 操作 | 命令 |
|---|---|
| 打开项目选择器 | `/projects` |
| **任务栏导航** | 编辑器为空时 **`ctrl+↓`** → `↑↓` 选 · `Enter` 切 · `Esc` 退出 |
| 常驻多行任务栏 | `/projects bar` |
| 包含被过滤的项目 | `/projects all` |
| 隐藏 / 强制显示 | `/projects hide\|unhide\|pin\|unpin <路径>` |
| 重建索引 / 查看活跃锁 | `/projects refresh` / `/projects locks` |

选中项目后若有多个会话，会让你挑一条；只有一条就直接切过去。

### 自动过滤

系统 temp、`node_modules`、`.cache`、`.venv`、已不存在的目录都不显示——这些是工具跑测试时留下的探测垃圾。实测一台机器上 12 条会话里 8 条是临时目录。

想临时看全部用 `/projects all`；想让某个被过滤的项目常驻用 `/projects pin <路径>`。

---

## pi-memory

### 命令

| 操作 | 命令 |
|---|---|
| 记一条 | `/remember <内容>`，或 `--tag decision` 指定分类 |
| 浏览 / 删除 / 归档 | `/memory` |
| 从压缩摘要提炼 | `/memory absorb` |
| 裁剪超限的记忆区 | `/memory prune` |
| 查看 / 立即处理待确认队列 | `/memory pending` / `/memory flush` |
| 搜索记忆与归档 | `/memory recall <关键词>` |
| 查看归档文件概况 | `/memory archive` |
| 切换只预览不写入 | `/memory dryrun on\|off` |
| 状态 | `/memory status` |

页脚：

```
mem 项目 5/60  ·  全局 3
     │              └ 全局偏好条数（只读展示——它每轮都注入，成本该可见）
     └ 项目记忆行数 / 软上限
```

### 记忆是怎么进来的

两条路径：

1. **我主动记** —— 我判断某条结论值得长期保留时调 `memory_write`（分类：决策 / 坑 / 接口 / 上下文 / 偏好 / 里程碑）
2. **你直接说** —— `/remember 内容`

无论哪条，**都不会打断正在执行的任务**：只入队、立即返回。确认框在 `agent_settled`（pi 不会再自动继续时）才弹，N 条合并成**一次**确认：

```
待确认 3 条记忆
  · 全部写入
  · 逐条确认
  · 全部丢弃
```

队列持久化到磁盘，直接退出 pi 也不丢，下次启动会提示。

### 只管理项目层

全局偏好请**手写** `~/.pi/agent/AGENTS.md`——pi 原生就会加载它，几条稳定偏好手写比走扩展更划算（零依赖、完全可控）。扩展只读它、展示它的规模，不写它。

---

## 设计取舍

写成"为什么"而不是"是什么"，因为后者读代码就行。

**pi-tasks**

- **索引是缓存，不是第二份存储。** 真相只有 pi 自己的会话文件一份。索引删掉能无损重建，永远不会与对话漂移。
- **导航用 `onTerminalInput` 而不是 `registerShortcut`。** 后者一旦匹配就**完全吞掉按键**（`custom-editor.js` 的 `handleInput` 没有放行机制），绑方向键会把编辑器弄坏。前者支持"不 consume 就正常传给聚焦组件"。
- **不用裸 `↓` 做热键。** pi 内置选择器（`/resume`、`/tree`）不走扩展 UI 通路，扩展**无法检测它们是否开着**。裸 `↓` 会抢走选择器的按键，接着按 `Enter` 就误触发项目切换。
- **陈旧检测很廉价。** 只 `stat` 各会话目录的 mtime，比索引的 `builtAt` 新才重建，不解析 JSONL。
- **worktree 身份解析必须异步 + 缓存。** 渲染路径每次重绘都要问"当前 cwd 属于哪个项目"，Windows 上单次 git 探测约 70ms，12 个可见项目会造成明显 TUI 卡顿。所以索引重建时并发算好放缓存，渲染只查表。
- **git 探测失败就退化成普通 cwd 身份。** 宁可少合并，也不能因为 git 不可用而丢项目。

**pi-memory**

- **不重复造原生机制。** 普通项目 pi 已按 cwd 逐级查找并全量注入 `AGENTS.md`，所以注入部分零代码。只有 worktree 共享记忆需要自己注入——因为 pi 不会扫描 `.git`。
- **记忆单位是「一次任务执行过程的压缩结论」**，不是原子事实。最重的那道压缩 pi 的 compaction 已经做了（它的 `## Key Decisions` / `## Critical Context` 正好是记忆该装的东西）。
- **写入不打断任务**（见上文 `agent_settled`）。
- **跨进程写锁 + 拿锁后重读。** `writeAtomic`（临时文件 + rename）只保证不写坏文件，仍是 last-write-wins——后写的会静默吃掉另一次的记忆。所以先取独占锁（`O_EXCL` 创建，原子），**拿到后重新读取**再应用增量。瞬态失败（锁冲突）放回队列重试；永久失败（目录已删）丢弃并说明，避免永远卡在队列里。
- **不把已删除的目录重建出来。** 目标目录不存在时直接拒绝——否则 `mkdir(recursive)` 会凭空造出一棵空目录树，而你只以为自己确认了一条记忆。

---

## 已知限制

按重要程度：

1. **真实 TUI 交互验证不足。** 自动化测试全在 mock 层。`ctrl+↓` 导航、`agent_settled` 弹框、跨项目切换后的实际渲染，都只有有限的人工验证。
2. **无 CI、无单元测试。** 全是端到端冒烟测试：覆盖好，定位差。
3. **`supersedes` 用模糊匹配兜底**（精确 → 前缀 → 包含），理论上可能误删不相关条目。
4. **`absorb` 只认固定的小节名**（`Key Decisions` / `Critical Context` / `Constraints & Preferences`），pi 改摘要格式会静默失效。
5. **软上限只统计"条目行"**，手写进记忆区的大段说明不计入。
6. **索引全量重建是 O(全部会话)**，几千个会话时会明显变慢。
7. **同一仓库的多个 clone 仍算两个项目**——只有 Git worktree 会合并。
8. **共享 worktree 记忆是本地 `.git/pi-memory/` 文件**，不会被 Git 提交、不能和团队共享。需要团队共享的规则应手写进版本库中的 `AGENTS.md`。
9. **pi-memory 不管理全局层**（设计如此，不是 bug）。

---

## 开发

```bash
npm install       # 装 typescript + @types/node
npm run setup     # 在本仓库 node_modules 建软链接指向本机 pi 安装目录
npm run check     # tsc --noEmit（strict）
npm test          # 两个冒烟测试
```

`precheck` / `pretest` 会自动先跑 setup，所以 `npm install` 之后直接 `npm test` 即可。

**为什么需要 setup 建软链接**：扩展的 `import ... from "@earendil-works/pi-coding-agent"` 在 pi 运行时不走 node_modules 解析，而是由 pi 用 jiti + 一组 alias 注入（见 `pi-coding-agent/dist/core/extensions/loader.js` 的 `getAliases()`）。`scripts/setup-dev.mjs` 在本仓库 `node_modules/` 下建软链接（Windows 用 junction，不需要管理员权限），让 tsc 解析到**同一个包**。

这样 `tsconfig.json` 里**不需要任何机器相关的路径**，仓库可以直接 clone 到任何地方。找不到 pi 时可以设 `PI_PACKAGE_DIR` 指定。

### 测试

两个都是**端到端冒烟测试**：用与 pi 相同的 jiti + alias 真实加载扩展，喂假 `ctx`，验证真实逻辑。

- `test/smoke-tasks.mjs` — 24 项断言
- `test/smoke-memory.mjs` — 86 项断言

两个细节值得一提：

- 会话夹具用 **pi 自己的 `SessionManager`** 生成（而不是手写 JSONL），所以 pi 改了文件格式不会让测试假绿
- 测试**不碰**你真实的 `~/.pi` 与真实家目录——`PI_CODING_AGENT_DIR` 和 `USERPROFILE`/`HOME` 都指向沙箱。沙箱故意放在仓库内 `.tmp/` 而非系统 temp：pi-tasks 会把系统 temp 下的目录当探测垃圾过滤掉，放那儿会让夹具项目全部变成不可见，主流程根本测不到

---

## License

MIT
