# pi-multi-project

给 [pi](https://github.com/earendil-works/pi-mono) 的两个扩展，解决同一件事：**让 pi 在多个项目之间工作时保持上下文**。

| 扩展 | 作用 |
|---|---|
| **pi-tasks** | 跨项目任务栏：一眼看到有哪些项目、一键切换、防止两个终端写坏同一个会话 |
| **pi-memory** | 项目级长期记忆：把架构决策和踩过的坑沉淀进项目的 `AGENTS.md`，下次自动注入 |

> **状态：beta。** 逻辑层有 99 项自动化断言覆盖，但**真实 TUI 交互尚未充分验证**（详见[已知限制](#已知限制)）。

---

## 要求

- pi 已安装（`pi --version`）
- Node.js 18+

两个扩展都**只用 pi 的原生机制**：不引入数据库、不复制对话内容、不改 pi 本身。

---

## 安装

```bash
# 从 git 安装
pi install git:github.com/<你>/pi-multi-project

# 或从本地目录
pi install ./pi-multi-project
```

装完 `/reload` 或重启 pi 生效。卸载：`pi remove <source>`。

---

## pi-tasks

### 它能解决什么

pi 的会话本来就按工作目录分开存放（`~/.pi/agent/sessions/<路径>/`），但**没有"总览"**——你得自己记着有几个项目在跑、哪个在哪个目录。`/resume` 也只列当前项目的会话。

另一个真实问题：pi 的会话文件**没有加锁**。两个终端切到同一个会话文件，两边都往同一个 JSONL 追加，记录会交错损坏。

### 用法

| 操作 | 命令 |
|---|---|
| 打开项目选择器 | `/projects` |
| **任务栏导航** | 编辑器为空时按 **`ctrl+↓`**，然后 `↑↓` 选、`Enter` 切、`Esc` 退出 |
| 常驻多行任务栏 | `/projects bar` |
| 包含被过滤的项目 | `/projects all` |
| 隐藏 / 强制显示 | `/projects hide|unhide|pin|unpin <路径>` |
| 重建索引 / 查看活跃锁 | `/projects refresh` / `/projects locks` |

页脚常驻状态：

```
proj-alpha  ·  ▸3  ·  +2 other  ·  ●1 busy
   │           │       │            └ 有 1 个会话正被别的终端占用
   │           │       └ 除当前项目外还有几个
   │           └ 可见项目总数
   └ 当前项目名
```

### 设计要点

- **索引是缓存，不是第二份存储。** 真相只有一份——pi 自己的会话文件。索引（`~/.pi/agent/index/tasks-index.json`）删掉能无损重建，永远不会与对话漂移。这正好也让它天然成为将来做"跨会话召回"的数据源。
- **项目身份用归一化 cwd**，不用 git remote。代价是换 clone 位置记忆会断，好处是可预测。
- **自动过滤探测垃圾**：系统 temp、`node_modules`、`.cache`、已不存在的目录都不显示。实测一台机器上 12 条会话里 8 条是临时探测目录。
- **并发靠 pid 锁**：`~/.pi/agent/locks/<sessionId>.lock` 存 pid，启动时写、退出时删，读锁时顺手清理进程已死的僵尸锁。
- **陈旧检测很廉价**：只 `stat` 各会话目录的 mtime，比索引的 `builtAt` 新才重建，不解析 JSONL。
- **导航用 `onTerminalInput` 而不是 `registerShortcut`**：后者一旦匹配就完全吞掉按键（`custom-editor.js` 的 `handleInput` 没有放行机制），绑方向键会把编辑器弄坏。前者支持"不 consume 就正常传给聚焦组件"。
- **不用裸 `↓` 做热键**：pi 内置选择器（`/resume`、`/tree`）不走扩展 UI 通路，扩展**无法检测它们是否开着**。裸 `↓` 会抢走选择器的按键，接着按 `Enter` 会误触发项目切换。

---

## pi-memory

### 它能解决什么

pi 原生会**读取** `AGENTS.md` 并注入 system prompt（并按 cwd 逐级向上查找），但**从不往里写**——没有任何记忆功能。所以每次开新会话，项目背景都得重新交代一遍。

这个扩展负责"写"：在任务收尾时把结论沉淀进项目记忆，下次自动生效。

### 职责边界

**只管项目层。** 全局偏好请手写 `~/.pi/agent/AGENTS.md`——pi 原生就会加载它，而几条稳定偏好手写比走扩展更划算（零依赖、完全可控）。

### 用法

| 操作 | 命令 |
|---|---|
| 记一条 | `/remember <内容>`，或 `--tag decision` 指定分类 |
| 浏览 / 删除 / 归档 | `/memory` |
| 从压缩摘要提炼 | `/memory absorb` |
| 裁剪超限的记忆区 | `/memory prune` |
| 查看 / 立即处理待确认队列 | `/memory pending` / `/memory flush` |
| 搜索记忆与归档 | `/memory recall <关键词>` |
| 状态 | `/memory status` |

页脚：

```
mem 项目 5/60  ·  全局 3
     │              └ 全局偏好条数（只读展示 —— 它每轮都注入，成本该可见）
     └ 项目记忆行数 / 软上限
```

### 写入的东西长什么样

写进 `<项目>/AGENTS.md`，**只在自己标记之间操作，你手写的内容一字不动**：

```markdown
# 我的项目

这是我自己写的说明。

<!-- pi-memory:start -->
## 项目记忆

- [decision] 项目身份用归一化 cwd，不用 git remote
  理由：git remote 会让多 worktree 合并
- [pitfall] switchSession 只在命令上下文上有
> 更早的 8 条已归档：`.pi/memory-archive.md`（需要时自行 read/grep）
<!-- pi-memory:end -->
```

超过软上限（默认 60 行）时，最旧的条目被**剪进** `.pi/memory-archive.md`——一条不丢，只是不再注入。

### 设计要点

- **不重复造原生机制。** pi 已按 cwd 逐级向上查找并全量注入 `AGENTS.md`，所以**注入部分零代码**。代价是全局层被注入到每个项目，所以本项目不碰全局层。
- **记忆单位是「一次任务执行过程的压缩结论」**，不是原子事实——最重的那道压缩 pi 的 compaction 已经做了（它的 `## Key Decisions` / `## Critical Context` 正好是记忆该装的东西）。
- **写入不打断任务。** `memory_write` 只入队、立即返回；确认框在 `agent_settled`（pi 不会再自动继续时）才弹一次，N 条合并成一次确认。队列持久化到磁盘，直接退出 pi 也不丢。
- **门禁：只在"看起来是项目"的目录写。** 因为 `AGENTS.md` 是逐级向上查找的，在祖先目录（尤其家目录）写会渗漏到其下所有项目。家目录**显式排除**——它本身可能就是 git 仓库，只靠 `.md` 标记判定会误放行。
- **跨进程写锁 + 拿锁后重读。** 两个 pi 同时 flush 时，`writeAtomic`（临时文件 + rename）只保证不写坏文件，仍是 last-write-wins——后写的会静默吃掉另一次的记忆。所以先取独占锁（`O_EXCL` 创建，原子），**拿到后重新读取**再应用增量。瞬态失败（锁冲突）放回队列重试；永久失败（目录已删）丢弃并说明，避免永远卡在队列里。
- **不把已删除的目录重建出来。** 目标目录不存在时直接拒绝写入——否则 `mkdir(recursive)` 会凭空造出一棵空目录树，而你只以为自己确认了一条记忆。

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

这样 `tsconfig.json` 里**不需要任何机器相关的路径**，仓库可以直接 clone 到任何地方。

找不到 pi 时可以设 `PI_PACKAGE_DIR` 环境变量指定。

### 测试

两个测试都是**端到端冒烟测试**：用与 pi 相同的 jiti + alias 真实加载扩展，喂假 `ctx`，验证真实逻辑。全程在临时沙箱里跑。

- `test/smoke-tasks.mjs` — 19 项断言
- `test/smoke-memory.mjs` — 80 项断言。会话夹具用 pi 自己的 `SessionManager` 生成（而不是手写 JSONL），所以 pi 改了文件格式不会让测试假绿

测试**不碰**你真实的 `~/.pi`，也不碰真实家目录——`PI_CODING_AGENT_DIR` 和 `USERPROFILE`/`HOME` 都被指向沙箱。

---

## 已知限制

按重要程度：

1. **真实 TUI 交互验证不足。** 自动化测试全在 mock 层。`ctrl+↓` 导航、`agent_settled` 弹框、跨项目切换后的实际渲染，都只有有限的人工验证。
2. **无 CI、无单元测试。** 全是端到端冒烟测试：覆盖好，定位差。
3. **`supersedes` 用模糊匹配兜底**（精确 → 前缀 → 包含），理论上可能误删不相关条目。
4. **`absorb` 只认固定的小节名**（`Key Decisions` / `Critical Context` / `Constraints & Preferences`），pi 改摘要格式会静默失效。
5. **软上限只统计"条目行"**，手写进记忆区的大段说明不计入。
6. **索引全量重建是 O(全部会话)**，几千个会话时会明显变慢。
7. **项目身份用 cwd**，换 clone 位置记忆会断；同一 repo 的多个 clone 会被算作两个项目。
8. **pi-memory 不管理全局层**（设计如此，不是 bug）。

---

## License

MIT
