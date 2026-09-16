/**
 * pi-memory 冒烟测试。
 *
 * 全程沙箱：PI_CODING_AGENT_DIR 与 USERPROFILE/HOME 都指向临时目录，
 * 所以既不碰你真实的 ~/.pi，也不会误写到你真实的家目录。
 *
 * 重点验证：
 *   • 确认框不打断任务执行（memory_write 只入队，agent_settled 才弹）
 *   • 扩展从不写全局层（只管项目层）
 *   • 跨进程写锁（防静默丢数据）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeSandbox, loadExtension, makeChecker } from "./_harness.mjs";

const { check, summary } = makeChecker();

// 覆盖之前先记下真实家目录，最后用来做安全断言
const REAL_HOME = os.homedir();
const REAL_HOME_AGENTS = path.join(REAL_HOME, "AGENTS.md");
const realHomeBefore = fs.existsSync(REAL_HOME_AGENTS)
	? fs.readFileSync(REAL_HOME_AGENTS, "utf8")
	: null;

// ── 沙箱 ──────────────────────────────────────────────────
const SB = makeSandbox("memory");
const TMP_AGENT = SB.path("agent"); // 充当 ~/.pi/agent
const PROJ = SB.path("proj");
const FAKE_HOME = SB.path("fakehome");

process.env.PI_CODING_AGENT_DIR = TMP_AGENT;
// 把 os.homedir() 也指向沙箱：否则 ctxHome 用的是真实家目录，
// 一旦门禁失效就会真写到 <真实家目录>/AGENTS.md。
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

fs.mkdirSync(TMP_AGENT, { recursive: true });
fs.mkdirSync(path.join(PROJ, ".git"), { recursive: true });
fs.mkdirSync(FAKE_HOME, { recursive: true });
// 家目录故意造成一个 git 仓库（模拟真实情况）——
// 这曾让仅靠标记判定的门禁误放行。
fs.mkdirSync(path.join(FAKE_HOME, ".git"), { recursive: true });

const WT_REPO = SB.path("worktree-repo");
const WT_FEATURE = path.join(WT_REPO, ".worktrees", "feature");
fs.mkdirSync(WT_REPO, { recursive: true });
const git = (args, cwd = WT_REPO) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "测试用户"]);
git(["config", "user.email", "test@example.invalid"]);
fs.writeFileSync(path.join(WT_REPO, "README.md"), "# memory worktree fixture\n", "utf8");
git(["add", "README.md"]);
git(["commit", "-q", "-m", "初始化记忆夹具"]);
git(["worktree", "add", "-q", "-b", "feature/memory", WT_FEATURE]);

const USER_CONTENT = "# 我的项目\n\n这是我自己写的说明，扩展不该动它。\n\n## 构建\n\n用 pnpm。\n";
fs.writeFileSync(path.join(PROJ, "AGENTS.md"), USER_CONTENT, "utf8");
fs.writeFileSync(
	path.join(TMP_AGENT, "pi-memory.json"),
	JSON.stringify({ dryRun: true, softLimit: 14 }, null, 2),
	"utf8",
);

const factory = await loadExtension("extensions/pi-memory.ts");
console.log("✔ 模块加载成功");

// ── mock ─────────────────────────────────────────────────
const handlers = {};
const commands = {};
const tools = {};
const cap = { notes: [], status: new Map(), dialogs: [], switches: [] };

const pi = {
	on: (ev, h) => void (handlers[ev] ??= []).push(h),
	registerCommand: (n, o) => void (commands[n] = o),
	registerTool: (t) => void (tools[t.name] = t),
	registerShortcut: () => {},
	appendEntry: () => {},
	setLabel: () => {},
	getFlag: () => undefined,
};

let idle = true;
let confirmAnswer = true;
let selectAnswer;
let selectImpl = () => undefined;

const ui = {
	theme: { fg: (_c, s) => s },
	setStatus: (k, v) => cap.status.set(k, v),
	setWidget: () => {},
	notify: (m, t) => cap.notes.push(`[${t ?? "info"}] ${m}`),
	confirm: async (title, msg) => {
		cap.dialogs.push({ kind: "confirm", title, msg });
		return confirmAnswer;
	},
	select: async (title, options) => {
		cap.dialogs.push({ kind: "select", title, options });
		return selectAnswer ?? selectImpl(title, options);
	},
	input: async () => undefined,
	onTerminalInput: () => () => {},
	getEditorText: () => "",
};

function mkCtx(cwd, entries = []) {
	return {
		ui,
		hasUI: true,
		mode: "tui",
		cwd,
		isIdle: () => idle,
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => SB.path("fake.jsonl"),
			getSessionId: () => "mem-probe",
			getCwd: () => cwd,
		},
	};
}

const ctxProj = mkCtx(PROJ);
const ctxHome = mkCtx(FAKE_HOME);
const ctxWorktreeMain = mkCtx(WT_REPO);
const ctxWorktreeFeature = mkCtx(WT_FEATURE);

factory(pi);
console.log("✔ 注册:", {
	events: Object.keys(handlers),
	commands: Object.keys(commands),
	tools: Object.keys(tools),
});

const PROJ_AGENTS = path.join(PROJ, "AGENTS.md");
const HOME_AGENTS = path.join(FAKE_HOME, "AGENTS.md");
/** 真正的全局层文件位置 = <agentDir>/AGENTS.md（pi 原生加载的那个） */
const GLOBAL_AGENTS = path.join(TMP_AGENT, "AGENTS.md");
const ARCHIVE = path.join(PROJ, ".pi", "memory-archive.md");
const PENDING = path.join(TMP_AGENT, "pi-memory-pending.json");

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
const countEntries = (f) => ((read(f) ?? "").match(/^- \[/gm) ?? []).length;
const reset = () => {
	cap.dialogs.length = 0;
	cap.notes.length = 0;
};

const write = async (params, ctx = ctxProj) => {
	const res = await tools.memory_write.execute("id", params, undefined, undefined, ctx);
	return (res.content ?? []).map((c) => c.text ?? "").join("\n");
};
const settle = async (ctx = ctxProj) => {
	for (const h of handlers.agent_settled ?? []) await h({ type: "agent_settled" }, ctx);
};
const memory = (args, ctx = ctxProj) => commands.memory.handler(args, ctx);
const remember = (args, ctx = ctxProj) => commands.remember.handler(args, ctx);
const start = async (ctx = ctxProj) => {
	for (const h of handlers.session_start ?? []) await h({ type: "session_start" }, ctx);
};

// ═══ 0. 先关 dry-run，后面测真实写入 ══════════════════════
await commands.memory.handler("dryrun off", ctxProj);
check("dry-run 已关（后续测真实写入）", (read(path.join(TMP_AGENT, "pi-memory.json")) ?? "").includes('"dryRun": false'));

// ═══ 1. 核心约束：入队不落盘、不弹框 ══════════════════════
console.log("\n═══ 1. 任务进行中：只入队，不弹框，不落盘 ═══");
idle = false;
reset();
const r1 = await write({ text: "任务中途记的第一条", tag: "decision" });
console.log("\n--- 工具返回 ---\n" + r1 + "\n---");
check("返回标明「已排队」", r1.includes("已排队"));
check("返回说明不打断执行", r1.includes("不打断"));
check("**没有弹任何框**", cap.dialogs.length === 0, `实际 ${cap.dialogs.length} 次`);
check("文件未被修改", read(PROJ_AGENTS) === USER_CONTENT);
check("队列已持久化到磁盘", fs.existsSync(PENDING) && read(PENDING).includes("任务中途记的第一条"));

await write({ text: "任务中途记的第二条", tag: "pitfall" });
await write({ text: "任务中途记的第三条", tag: "api" });
check("连续入队 3 条，依然 0 次弹框", cap.dialogs.length === 0);
check("pending 文件里有 3 条", JSON.parse(read(PENDING)).length === 3);

// ═══ 2. agent_settled：统一弹 1 次框 ═════════════════════
console.log("\n═══ 2. 任务结束（agent_settled）：N 条只弹 1 次框 ═══");
idle = true;
reset();
selectAnswer = "全部写入";
await settle();
console.log("\n--- 弹框记录 ---");
for (const d of cap.dialogs) {
	console.log(`  [${d.kind}] ${d.title}`);
	if (d.options) d.options.forEach((o) => console.log(`      · ${o}`));
}
check("**只弹了 1 次框**（3 条记忆）", cap.dialogs.length === 1, `实际 ${cap.dialogs.length}`);
check("用的是多选列表而非逐条确认", cap.dialogs[0]?.kind === "select");
check("提供全部写入/逐条确认/全部丢弃", (cap.dialogs[0]?.options ?? []).length === 3);
console.log("\n--- 写入后 AGENTS.md ---\n" + read(PROJ_AGENTS));
check("3 条都已写入", countEntries(PROJ_AGENTS) === 3, `实际 ${countEntries(PROJ_AGENTS)}`);
check("用户原有内容完整保留", read(PROJ_AGENTS).includes("这是我自己写的说明") && read(PROJ_AGENTS).includes("用 pnpm。"));
check("pending 文件已清空", !fs.existsSync(PENDING));

// ═══ 3. 拒绝 → 不写入 ════════════════════════════════════
console.log("\n═══ 3. 用户拒绝 → 不写入、队列清空 ═══");
await write({ text: "这条不该被写入", tag: "note" });
const before3 = read(PROJ_AGENTS);
reset();
confirmAnswer = false;
selectAnswer = "全部丢弃";
await settle();
confirmAnswer = true;
selectAnswer = undefined;
check("文件未变", read(PROJ_AGENTS) === before3);
check("提示已丢弃", cap.notes.some((n) => n.includes("已丢弃")));
check("队列已清空", !fs.existsSync(PENDING));

// ═══ 4. 多行条目 + supersedes ════════════════════════════
console.log("\n═══ 4. 多行条目 + supersedes ═══");
await write({
	text: "索引只存指针，不做第二份真相\n理由：避免双写漂移\n代价：删了 session 要重建",
	tag: "decision",
	
});
await settle();
const c4 = read(PROJ_AGENTS);
check("多行：首行进条目头", c4.includes("- [decision] 索引只存指针，不做第二份真相"));
check("多行：续行缩进 2 格", c4.includes("\n  理由：避免双写漂移"));

await write({
	text: "索引改为缓存文本",
	tag: "decision",
	
	supersedes: "索引只存指针",
});
await settle();
const c4b = read(PROJ_AGENTS);
check("supersedes：旧条已移除", !c4b.includes("索引只存指针，不做第二份真相"));
check("supersedes：新条已写入", c4b.includes("索引改为缓存文本"));

// ═══ 5. 超软上限 → 剪进归档 ══════════════════════════════
console.log("\n═══ 5. 超软上限（14 行）：剪进归档，一条不丢 ═══");
for (let i = 1; i <= 16; i++) await write({ text: `临时验证条目 ${i}`, tag: "note" });
selectAnswer = "全部写入";
await settle();
selectAnswer = undefined;
check("归档文件已创建", fs.existsSync(ARCHIVE));
check("留下归档指针", /更早的 \d+ 条已归档/.test(read(PROJ_AGENTS)));
check("热 + 归档总数 >= 入队数", countEntries(PROJ_AGENTS) + countEntries(ARCHIVE) >= 18, `热 ${countEntries(PROJ_AGENTS)} + 冷 ${countEntries(ARCHIVE)}`);
const hotLines = read(PROJ_AGENTS).split("<!-- pi-memory:start -->")[1].split("<!-- pi-memory:end -->")[0].split(/\r?\n/).filter((l) => l.startsWith("- ")).length;
console.log(`  热记忆条目 ${hotLines} 条（软上限 14 行）`);

// ═══ 6. cwd 是 home → 门禁拒绝 ═══════════════════════════
console.log("\n═══ 6. 家目录（非项目）→ 门禁拒绝写入 ═══");
idle = false;
reset();
const rHome = await write({ text: "家目录里记的项目专属内容", tag: "decision" }, ctxHome);
console.log("\n--- 工具返回（家目录下）---\n" + rHome + "\n---");
check("明确说明未入队", rHome.includes("未入队"));
check("说明拒绝原因：家目录", rHome.includes("家目录") && rHome.includes("祖先"));
check("说明渗漏风险", rHome.includes("渗漏"));
check("给出替代方案：手写全局 AGENTS.md", rHome.includes("手写") && rHome.includes("AGENTS.md"));
check("没有真的入队", !fs.existsSync(PENDING));

// 项目目录下应该能正常入队
reset();
const rProj = await write({ text: "项目目录下记的项目内容", tag: "decision" }, ctxProj);
check("项目目录下正常入队", rProj.includes("已排队"));
check("项目目录下不出现拒绝", !rProj.includes("未入队"));

idle = true;
reset();
selectAnswer = "全部丢弃";
await settle();
selectAnswer = undefined;
check("丢弃后队列已空", !fs.existsSync(PENDING));

// /remember 在家目录也该被拒绝
idle = true;
reset();
await remember("家目录里想记的一条", ctxHome);
check("/remember 在家目录也被拒绝", cap.notes.some((n) => n.includes("未入队")));
check("家目录的 AGENTS.md 未被创建", !fs.existsSync(HOME_AGENTS));
const realHomeAfter = fs.existsSync(REAL_HOME_AGENTS) ? fs.readFileSync(REAL_HOME_AGENTS, "utf8") : null;
check("真实家目录绝未被触碰（内容快照未变）", realHomeAfter === realHomeBefore);

// ═══ 6b. 本扩展绝不碰全局层 ═════════════════════════════
console.log("\n═══ 6b. 关键约束：扩展从不写全局层 ═══");
// 删掉旧的全局文件，后面全部流程都不应该再创建它
if (fs.existsSync(HOME_AGENTS)) fs.unlinkSync(HOME_AGENTS);
check("起点：全局层文件不存在", !fs.existsSync(HOME_AGENTS));
// 造一个「用户手写」的全局偏好文件（无 pi-memory 标记，2 条）
fs.writeFileSync(
	GLOBAL_AGENTS,
	["# 全局偏好", "", "- 手写偏好一", "- 手写偏好二", ""].join("\n"),
	"utf8",
);
const globalSnapshot = read(GLOBAL_AGENTS);
check("全局层夹具已就位（纯手写，无标记）", !globalSnapshot.includes("pi-memory:start"));

/** 扩展职责边界：全局层只读不写。用内容快照做最终校验。 */
const globalUntouched = () => read(GLOBAL_AGENTS) === globalSnapshot;

// ═══ 7. /remember 忙时只入队 ═════════════════════════════
console.log("\n═══ 7. /remember 在任务进行中只入队 ═══");
const before7Proj = read(PROJ_AGENTS);
idle = false;
reset();
await remember("忙时记的一条", ctxProj);
check("忙时 /remember 不弹框", cap.dialogs.length === 0);
check("忙时 /remember 不落盘", read(PROJ_AGENTS) === before7Proj);
check("忙时 /remember 提示已排队", cap.notes.some((n) => n.includes("已排队")));
idle = true;
reset();
await settle();
check("任务结束后补上确认并写入", read(PROJ_AGENTS).includes("忙时记的一条"));

// ═══ 8. 队列跨会话持久化 ═════════════════════════════════
console.log("\n═══ 8. 队列持久化：重载后恢复 ═══");
idle = false;
await write({ text: "退出前没来得及确认的一条", tag: "note" });
idle = true;
reset();
await start(); // session_start 会 loadPending
check("session_start 提示有待确认记忆", cap.notes.some((n) => n.includes("未确认")));
reset();
await memory("pending");
console.log("  " + (cap.notes.at(-1) ?? "").replace(/\n/g, "\n  "));
check("/memory pending 列出了它", (cap.notes.at(-1) ?? "").includes("退出前没来得及确认的一条"));
reset();
selectAnswer = "全部写入";
await settle();
check("重新弹出确认并写入", read(PROJ_AGENTS).includes("退出前没来得及确认的一条"));
selectAnswer = undefined;

// ═══ 9. dry-run 只预览不写 ═══════════════════════════════
console.log("\n═══ 9. dry-run：只预览，不落盘 ═══");
await memory("dryrun on");
const before9 = read(PROJ_AGENTS);
idle = false;
await write({ text: "dry-run 期间的一条", tag: "note" });
idle = true;
reset();
await settle();
check("dry-run 下未落盘", read(PROJ_AGENTS) === before9);
check("dry-run 给出预览", cap.notes.some((n) => n.includes("[DRY RUN]")));
reset();
await memory("dryrun off");
check("dry-run 已关", (read(path.join(TMP_AGENT, "pi-memory.json")) ?? "").includes('"dryRun": false'));

// ═══ 10. absorb 从压缩摘要提炼 ═══════════════════════════
console.log("\n═══ 10. /memory absorb ═══");
const fakeSummary = [
	"## Goal", "给 pi 加长期记忆", "",
	"## Constraints & Preferences", "- 用户要求先讨论规划再写代码", "- 不要重复造 pi 原生机制", "",
	"## Key Decisions", "- **记忆写入 AGENTS.md**: 因为 pi 原生按 cwd 分层注入", "",
	"## Next Steps", "1. 这个不该被吸收", "",
	"## Critical Context", "- switchSession 只在 ExtensionCommandContext 上", "",
].join("\n");
const ctxCompact = mkCtx(PROJ, [{ type: "compaction", summary: fakeSummary }]);
reset();
await memory("absorb", ctxCompact);
const all = (read(PROJ_AGENTS) ?? "") + (read(ARCHIVE) ?? "");
check("吸收了 Key Decisions", all.includes("记忆写入 AGENTS.md"));
check("吸收了 Critical Context", all.includes("switchSession 只在 ExtensionCommandContext"));
check("吸收了 Constraints", all.includes("不要重复造 pi 原生机制"));
check("没有吸收 Next Steps", !all.includes("这个不该被吸收"));
check("absorb 只写项目层（全局层内容未变）", globalUntouched());

// ═══ 11. recall / status / archive ═══════════════════════
console.log("\n═══ 11. recall / status ═══");
reset();
await memory("recall pi 原生");
check("recall 有命中", (cap.notes.at(-1) ?? "").includes("命中"));
reset();
await memory("status");
console.log(cap.notes.at(-1));
check("status 显示主题信息", (cap.notes.at(-1) ?? "").includes("热记忆"));

// ═══ 12. session_start 页脚状态 ══════════════════════════
console.log("\n═══ 12. 页脚状态条 ═══");
reset();
await start();
console.log("  状态条:", cap.status.get("pi-memory"));
const st12 = cap.status.get("pi-memory") ?? "";
console.log("  状态条:", st12);
check("状态条已设置", typeof cap.status.get("pi-memory") === "string");
check("项目目录下显示「项目 N/上限」", /项目 \d+\/\d+/.test(st12), st12);
check("项目目录下也显示「全局 N」", /全局 \d+/.test(st12), st12);

// ═══ 13. 页脚随外部改动刷新（turn_end）═══════════════════
console.log("\n═══ 13. 外部改动后页脚自动刷新 ═══");
const beforeExt = read(PROJ_AGENTS);
fs.writeFileSync(
	PROJ_AGENTS,
	beforeExt.replace("<!-- pi-memory:end -->", "- [note] 手工加的一条\n<!-- pi-memory:end -->"),
	"utf8",
);
const expectCount = countEntries(PROJ_AGENTS);
cap.status.set("pi-memory", "STALE");
for (const h of handlers.turn_end ?? []) await h({ type: "turn_end" }, ctxProj);
const st = cap.status.get("pi-memory") ?? "";
console.log(`  外部编辑后实际 ${expectCount} 条 → 状态条: ${st}`);
check("turn_end 重算了页脚（不再陈旧）", st.includes(`项目 ${expectCount}/`), `期望含 "项目 ${expectCount}/"`);
check("没再显示 STALE", !st.includes("STALE"));
check("页脚标明了项目层", /项目 \d+\/\d+/.test(st), st);
check("页脚含全局偏好规模", /全局 \d+/.test(st), st);

// 非项目目录（家目录）下扩展不显示记忆状态
for (const h of handlers.turn_end ?? []) await h({ type: "turn_end" }, ctxHome);
const stHome = cap.status.get("pi-memory");
console.log(`  家目录下状态条: ${stHome ?? "(已清除)"}`);
check("家目录下仍显示「全局 N」", /全局 \d+/.test(stHome ?? ""), stHome ?? "(undefined)");
check("全局计数读的是真全局文件（2 条夹具）", (stHome ?? "").includes("全局 2"), stHome ?? "(undefined)");
check("家目录下不显示「项目」计数（本层不可写）", !/项目 \d/.test(stHome ?? ""), stHome ?? "(undefined)");

// 收尾：整套流程从未改动全局层文件
check("**全套流程结束时，全局层内容一字未改**", globalUntouched());
check("家目录下的 AGENTS.md 也未被创建", !fs.existsSync(HOME_AGENTS));

// ═══ 14. 项目目录被删后 flush 不该重建它 ══════════════════
console.log("\n═══ 14. 项目目录被删 → 拒绝写入，不重建目录 ═══");
const DOOMED = SB.path("proj-doomed");
fs.mkdirSync(path.join(DOOMED, ".git"), { recursive: true });
const ctxDoomed = mkCtx(DOOMED);
idle = false;
reset();
await write({ text: "入队后目录会被删掉", tag: "note" }, ctxDoomed);
check("已在 doomed 项目入队", fs.existsSync(PENDING));
fs.rmSync(DOOMED, { recursive: true, force: true });
check("目录已删除", !fs.existsSync(DOOMED));
idle = true;
reset();
selectAnswer = "全部写入";
await settle(ctxDoomed);
selectAnswer = undefined;
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ").slice(0, 200));
check("**未把已删除的目录重建出来**", !fs.existsSync(DOOMED));
check("报告了目标目录不存在", cap.notes.some((n) => n.includes("已不存在")));
check("永久失败的条目被丢弃，不卡在队列里", !fs.existsSync(PENDING));
check("说明了丢弃原因", cap.notes.some((n) => n.includes("已丢弃")));

// ═══ 15. 跨进程写锁 ══════════════════════════════════════
console.log("\n═══ 15. 跨进程写锁（防静默丢数据）═══");
const { createHash } = await import("node:crypto");
const lockPathFor = (file) => {
	const key = process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
	const h = createHash("sha1").update(key).digest("hex").slice(0, 16);
	return path.join(TMP_AGENT, "locks", `mem-${h}.lock`);
};
const LOCK = lockPathFor(PROJ_AGENTS);
fs.mkdirSync(path.dirname(LOCK), { recursive: true });

// 15a. 锁被「活着的其他进程」持有 → 拒绝写入，且条目必须回到队列（不能丢）
fs.writeFileSync(LOCK, JSON.stringify({ pid: process.ppid, at: Date.now(), file: PROJ_AGENTS }));
const beforeLock = read(PROJ_AGENTS);
idle = false;
reset();
await write({ text: "锁被占用时记的一条", tag: "note" });
idle = true;
reset();
selectAnswer = "全部写入";
const t0 = Date.now();
await settle();
const waited = Date.now() - t0;
selectAnswer = undefined;
console.log(`  等待持锁者释放：${waited}ms`);
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ").replace(/\n/g, " ").slice(0, 260));
check("锁冲突时未写入文件", read(PROJ_AGENTS) === beforeLock);
check("报告了锁冲突", cap.notes.some((n) => n.includes("另一个 pi 进程")));
check("**条目被放回队列（没丢数据）**", fs.existsSync(PENDING) && read(PENDING).includes("锁被占用时记的一条"));
fs.unlinkSync(LOCK);

// 15b. 僵尸锁（持锁进程已死）→ 自动清理并继续
console.log("\n--- 僵尸锁 ---");
fs.writeFileSync(LOCK, JSON.stringify({ pid: 999999, at: Date.now(), file: PROJ_AGENTS }));
reset();
selectAnswer = "全部写入";
await settle();
selectAnswer = undefined;
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ").slice(0, 200));
check("僵尸锁被清掉后能正常写入（重试成功）", (read(PROJ_AGENTS) ?? "").includes("锁被占用时记的一条"));
check("写入后锁已释放", !fs.existsSync(LOCK));

// 15c. 并发安全的核心：拿锁后重读，而不是用旧快照覆盖
console.log("\n--- 拿锁后重读（CAS 语义）---");
const beforeC = read(PROJ_AGENTS);
cap.notes.length = 0;
// 在「入队」到「flush」之间，模拟另一个进程往文件里追加了一条
idle = false;
await write({ text: "本进程新加的", tag: "note" });
fs.writeFileSync(
	PROJ_AGENTS,
	beforeC.replace("<!-- pi-memory:end -->", "- [note] 别的进程同时加的\n<!-- pi-memory:end -->"),
	"utf8",
);
idle = true;
reset();
selectAnswer = "全部写入";
await settle();
selectAnswer = undefined;
const finalC = read(PROJ_AGENTS);
check("别人的并发写入没被覆盖", finalC.includes("别的进程同时加的"));
check("自己的条目也写进去了", finalC.includes("本进程新加的"));

// ═══ 15d. 多 worktree 共享项目记忆 ═══════════════════════
console.log("\n--- 多 worktree 共享项目记忆 ---");
const sharedMemory = path.join(WT_REPO, ".git", "pi-memory", "memory.md");
const sharedArchive = path.join(WT_REPO, ".git", "pi-memory", "memory-archive.md");
const beforeSharedMain = path.join(WT_REPO, "AGENTS.md");
const beforeSharedFeature = path.join(WT_FEATURE, "AGENTS.md");
idle = false;
await write({ text: "worktree 共享记忆只存一份", tag: "decision" }, ctxWorktreeMain);
idle = true;
reset();
selectAnswer = "全部写入";
await settle(ctxWorktreeMain);
selectAnswer = undefined;
check("共享记忆写入共同 .git 目录", (read(sharedMemory) ?? "").includes("worktree 共享记忆只存一份"));
check("主 worktree 未生成分支 AGENTS.md", !fs.existsSync(beforeSharedMain));
check("feature worktree 未生成分支 AGENTS.md", !fs.existsSync(beforeSharedFeature));
check("共享归档路径与目标一致", path.dirname(sharedArchive) === path.dirname(sharedMemory));
const beforeStart = handlers.before_agent_start?.[0];
const injected = await beforeStart?.({ type: "before_agent_start", prompt: "测试", systemPrompt: "基础系统提示" }, ctxWorktreeFeature);
check("feature worktree 能读到主 worktree 写入的共享记忆", injected?.systemPrompt.includes("worktree 共享记忆只存一份"));
check("共享记忆注入保留基础 system prompt", injected?.systemPrompt.startsWith("基础系统提示"));
for (const h of handlers.session_shutdown ?? []) await h({ type: "session_shutdown" }, ctxProj);
check("status 已清除", cap.status.get("pi-memory") === undefined);

console.log("\n✔ 冒烟测试结束");
summary();
SB.cleanup();
console.log("临时目录已清理（真实 ~/.pi 与真实家目录均未被触碰）");
