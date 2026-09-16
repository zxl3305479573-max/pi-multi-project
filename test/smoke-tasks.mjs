/**
 * pi-tasks 冒烟测试。
 *
 * 用 pi 自己的 jiti + alias 加载扩展，喂假 ctx，验证真实逻辑。
 * 全程在临时沙箱里跑：PI_CODING_AGENT_DIR 指向临时目录，
 * 会话记录用夹具现造 —— 不碰你真实的 ~/.pi，也不依赖本机已有会话。
 */
import path from "node:path";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { makeSandbox, loadExtension, makeChecker } from "./_harness.mjs";
import { addSession, makeProjectDir } from "./fixtures.mjs";

const { check, summary } = makeChecker();

// ── 沙箱 ──────────────────────────────────────────────────
const SB = makeSandbox("tasks");
const AGENT = SB.path("agent"); // 充当 ~/.pi/agent
fs.mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

// 造两个「真项目」和它们的会话
const PROJ_A = makeProjectDir(SB.path("proj-alpha"));
const PROJ_B = makeProjectDir(SB.path("proj-beta"));
const WORKTREE_MAIN = SB.path("worktree-repo");
const WORKTREE_FEATURE = path.join(WORKTREE_MAIN, ".worktrees", "feature");
fs.mkdirSync(WORKTREE_MAIN, { recursive: true });
const git = (args, cwd = WORKTREE_MAIN) =>
	execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
git(["init", "-q", "-b", "main"]);
git(["config", "user.name", "测试用户"]);
git(["config", "user.email", "test@example.invalid"]);
fs.writeFileSync(path.join(WORKTREE_MAIN, "README.md"), "# worktree fixture\n", "utf8");
git(["add", "README.md"]);
git(["commit", "-q", "-m", "初始化夹具"]);
git(["worktree", "add", "-q", "-b", "feature/worktree", WORKTREE_FEATURE]);
await addSession(PROJ_A, "alpha 第一条会话");
await addSession(PROJ_A, "alpha 第二条会话");
await addSession(PROJ_B, "beta 的会话");
await addSession(WORKTREE_MAIN, "主 worktree 的会话");
await addSession(WORKTREE_FEATURE, "feature worktree 的会话");

const CONFIG_PATH = path.join(AGENT, "pi-tasks.json");
const factory = await loadExtension("extensions/pi-tasks.ts");
console.log("✔ 模块加载成功");

// ── 收集注册 ──────────────────────────────────────────────
const handlers = {};
const commands = {};
const shortcuts = {};
const cap = { status: new Map(), widget: new Map(), notes: [], switches: [] };

const pi = {
	on: (ev, h) => void (handlers[ev] ??= []).push(h),
	registerCommand: (n, o) => void (commands[n] = o),
	registerShortcut: (k, o) => void (shortcuts[k] = o),
	registerTool: () => {},
	appendEntry: () => {},
	setLabel: () => {},
	getFlag: () => undefined,
	getSessionName: () => undefined,
	sendUserMessage: (t) => cap.notes.push(`sendUserMessage(${t})`),
	exec: (cmd, args, opts) =>
		new Promise((res) => {
			execFile(
				cmd,
				args,
				{ cwd: opts?.cwd, timeout: opts?.timeout, windowsHide: true },
				(err, stdout, stderr) =>
					res({ stdout: stdout ?? "", stderr: stderr ?? "", code: err ? (err.code ?? 1) : 0 }),
			);
		}),
};

// ── 假 ctx ───────────────────────────────────────────────
let selectImpl = () => undefined;
let editorText = "";
let inputHandler;
const ui = {
	theme: { fg: (_c, s) => s },
	setStatus: (k, v) => cap.status.set(k, v),
	setWidget: (k, v) => cap.widget.set(k, v),
	notify: (m, t) => cap.notes.push(`[${t ?? "info"}] ${m}`),
	select: async (title, opts) => {
		cap.notes.push(`SELECT "${title}" (${opts.length} 项)`);
		return selectImpl(title, opts);
	},
	confirm: async () => true,
	input: async () => undefined,
	onTerminalInput: (handler) => {
		inputHandler = handler;
		return () => {
			if (inputHandler === handler) inputHandler = undefined;
		};
	},
	getEditorText: () => editorText,
};

/** 模拟按键；返回是否被吞掉 */
const press = (key) => inputHandler?.(key);

let currentSessionFile = SB.path("fake-current-session.jsonl");

const baseCtx = {
	ui,
	hasUI: true,
	mode: "tui",
	cwd: PROJ_A,
	isIdle: () => true,
	sessionManager: {
		getSessionFile: () => currentSessionFile,
		getSessionId: () => "smoke-test-session",
		getCwd: () => PROJ_A,
		getEntries: () => [],
	},
};

const cmdCtx = {
	...baseCtx,
	switchSession: async (p, o) => {
		cap.switches.push(p);
		await o?.withSession?.({ ui });
		return { cancelled: false };
	},
};

// ── 运行 ─────────────────────────────────────────────────
factory(pi);
console.log("✔ 注册项:", {
	events: Object.keys(handlers),
	commands: Object.keys(commands),
	shortcuts: Object.keys(shortcuts),
});

for (const h of handlers.session_start ?? []) {
	await h({ type: "session_start", reason: "startup" }, baseCtx);
}

// 等后台 rebuild + git 查询
await new Promise((r) => setTimeout(r, 6000));

console.log("\n── 页脚状态条 ─────────────────────────");
console.log(" ", cap.status.get("pi-tasks") ?? "(空)");

console.log("\n── /projects bar 后的 widget ──────────");
await commands.projects.handler("bar", cmdCtx);
const widget = cap.widget.get("pi-tasks-bar");
console.log(widget ? widget.map((l) => `  ${l}`).join("\n") : "  (空)");

console.log("\n── 索引文件 ───────────────────────────");
const idxPath = path.join(
	process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.USERPROFILE ?? "", ".pi", "agent"),
	"index",
	"tasks-index.json",
);
try {
	const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
	console.log(`  版本 ${idx.version}  项目 ${idx.projects.length}  建于 ${new Date(idx.builtAt).toISOString()}`);
	for (const p of idx.projects) {
		console.log(
			`   ${p.noise ? "·" : "▸"} ${p.name.padEnd(24)} tier=${p.tier} git=${p.isGit ? "y" : "n"} sessions=${p.sessionCount} worktrees=${p.worktreeCount ?? 1} missing=${p.missing} branch=${p.branch ?? "-"}`,
		);
	}
} catch (e) {
	console.log("  读取失败:", e.message);
}

const worktreeGroup = JSON.parse(fs.readFileSync(idxPath, "utf8")).projects.find((p) => p.key.startsWith("worktree:"));
check("同仓库 worktree 合并为一个项目", !!worktreeGroup, `实际 ${worktreeGroup ? "已合并" : "缺失"}`);
check("worktree 项目保留两个会话", worktreeGroup?.sessionCount === 2, `实际 ${worktreeGroup?.sessionCount ?? 0}`);
check("worktree 数量正确", worktreeGroup?.worktreeCount === 2, `实际 ${worktreeGroup?.worktreeCount ?? 0}`);
check("worktree 分支集合已显示", (worktreeGroup?.branch ?? "").includes("main") && (worktreeGroup?.branch ?? "").includes("feature/worktree"));
check("常驻任务栏标记 worktree 数", (cap.widget.get("pi-tasks-bar") ?? []).some((l) => l.includes("⎇2")));

console.log("\n── /projects 选择器（选第 2 行）───────");
cap.notes.length = 0;
let calls = 0;
selectImpl = (_t, opts) => {
	calls++;
	return calls === 1 ? opts[1] : undefined; // 第二次（会话选择）取消
};
await commands.projects.handler("", cmdCtx);
console.log(cap.notes.map((n) => `  ${n}`).join("\n") || "  (无输出)");
console.log("  切换目标:", cap.switches.length ? cap.switches : "(未切换)");

console.log("\n── /projects all ──────────────────────");
cap.notes.length = 0;
selectImpl = () => undefined;
await commands.projects.handler("all", cmdCtx);
console.log(cap.notes.map((n) => `  ${n}`).join("\n") || "  (无输出)");

console.log("\n── /projects locks ────────────────────");
cap.notes.length = 0;
await commands.projects.handler("locks", cmdCtx);
console.log(cap.notes.map((n) => `  ${n}`).join("\n") || "  (无输出)");

console.log("\n── 快捷键 alt+t ───────────────────────");
cap.notes.length = 0;
await shortcuts["alt+t"]?.handler(baseCtx);
console.log(cap.notes.map((n) => `  ${n}`).join("\n") || "  (无输出)");

// ── 边界测试 ──────────────────────────────
const realProject = JSON.parse(fs.readFileSync(path.join(AGENT, "index", "tasks-index.json"), "utf8")).projects.find((p) => !p.noise);
const noiseProject = JSON.parse(fs.readFileSync(path.join(AGENT, "index", "tasks-index.json"), "utf8")).projects.find((p) => p.noise && p.tier === 1);

async function visibleCount() {
	cap.notes.length = 0;
	let n = 0;
	selectImpl = (_t, opts) => {
		n = opts.length;
		return undefined;
	};
	await commands.projects.handler("", cmdCtx);
	return n;
}

console.log("\n── hide 真项目（应从可见列表消失）─────");
const baseVis = await visibleCount();
console.log(`  隐藏前可见: ${baseVis}`);
cap.notes.length = 0;
await commands.projects.handler(`hide ${realProject.cwd}`, cmdCtx);
console.log("  " + cap.notes.join(" | "));
const afterHide = await visibleCount();
console.log(`  隐藏后可见: ${afterHide}`);
check("hide 后可见数 -1", afterHide === baseVis - 1, `${baseVis} → ${afterHide}`);

console.log("\n── unhide 恢复 ────────────────────────");
cap.notes.length = 0;
await commands.projects.handler(`unhide ${realProject.cwd}`, cmdCtx);
console.log("  " + cap.notes.join(" | "));
const afterUnhide = await visibleCount();
console.log(`  恢复后可见: ${afterUnhide}`);
check("unhide 后可见数回到基线", afterUnhide === baseVis, `期望 ${baseVis}`);

console.log("\n── pin 让 temp 噪声项目强制可见 ───────");
if (noiseProject) {
	cap.notes.length = 0;
	await commands.projects.handler(`pin ${noiseProject.cwd}`, cmdCtx);
	console.log("  " + cap.notes.join(" | "));
	const afterPin = await visibleCount();
	console.log(`  pin 后可见: ${afterPin}`);
	check("pin 后可见数 +1", afterPin === baseVis + 1, `${baseVis} → ${afterPin}`);
	cap.notes.length = 0;
	await commands.projects.handler(`unpin ${noiseProject.cwd}`, cmdCtx);
	const afterUnpin = await visibleCount();
	console.log(`  unpin 后可见: ${afterUnpin}`);
	check("unpin 后可见数回到基线", afterUnpin === baseVis, `期望 ${baseVis}`);
}

console.log("\n── pin 不能覆盖显式 hide ──────────────");
cap.notes.length = 0;
await commands.projects.handler(`hide ${realProject.cwd}`, cmdCtx);
await commands.projects.handler(`pin ${realProject.cwd}`, cmdCtx);
const hidePin = await visibleCount();
console.log(`  hide+pin 后可见: ${hidePin}`);
check("pin 不能覆盖显式 hide", hidePin === baseVis - 1, `期望 ${baseVis - 1}`);
await commands.projects.handler(`unhide ${realProject.cwd}`, cmdCtx);
await commands.projects.handler(`unpin ${realProject.cwd}`, cmdCtx);
const cleaned = await visibleCount();
console.log(`  清理后可见: ${cleaned}`);
check("清理后回到基线", cleaned === baseVis, `期望 ${baseVis}`);

console.log("\n── 切换到已消失的目录 ─────────────────");
cap.notes.length = 0;
cap.switches.length = 0;
selectImpl = (_t, opts) => opts.find((o) => o.includes("(missing)")) ?? opts[0];
await commands.projects.handler("all", cmdCtx);
const missingRow = cap.notes.find((n) => n.includes("ERR") || n.includes("不存在"));
console.log("  " + cap.notes.filter((n) => n.startsWith("[") || n.includes("不存在")).join("\n  "));
console.log("  是否切换:", cap.switches.length ? cap.switches : "否（正确：拦住了）");

console.log("\n── 会话被其他进程锁住时 ───────────────");
const locksDir = path.join(AGENT, "locks");
fs.mkdirSync(locksDir, { recursive: true });
const victim = realProject.sessions[0];
const lockPath = path.join(locksDir, `${victim.id}.lock`);
fs.writeFileSync(
	lockPath,
	JSON.stringify({ pid: process.ppid, sessionId: victim.id, sessionFile: victim.path, cwd: victim.cwd, startedAt: Date.now() }),
);

async function trySwitch(confirmAnswer) {
	cap.notes.length = 0;
	cap.switches.length = 0;
	let asked = false;
	ui.confirm = async () => {
		asked = true;
		return confirmAnswer;
	};
	selectImpl = (_t, opts) => opts[0];
	await commands.projects.handler("", cmdCtx);
	return { asked, switched: cap.switches.length > 0 };
}

console.log("  确认=否 →", JSON.stringify(await trySwitch(false)), "(期望 asked=true, switched=false)");
console.log("  确认=是 →", JSON.stringify(await trySwitch(true)), "(期望 asked=true, switched=true)");
fs.unlinkSync(lockPath);
ui.confirm = async () => true;

console.log("\n── 未知子命令 → 帮助 ──────────────────");
cap.notes.length = 0;
await commands.projects.handler("bogus", cmdCtx);
console.log("  首行:", cap.notes[0]?.split("\n")[0]);

console.log("\n── 选当前正在用的会话（应拦住）────────");
cap.notes.length = 0;
cap.switches.length = 0;
currentSessionFile = realProject.sessions[0].path;
let sawCurrentTag = false;
selectImpl = (_t, opts) => {
	sawCurrentTag = opts.some((o) => o.includes("← 当前"));
	return opts[0];
};
await commands.projects.handler("", cmdCtx);
console.log("  会话列表标出了当前:", sawCurrentTag, "(期望 true)");
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ") || "(无)");
console.log("  是否切换:", cap.switches.length ? cap.switches : "否（正确：拦住了）");
currentSessionFile = SB.path("fake-current-session.jsonl");

console.log("\n── 选另一个会话（应真切换）──────────");
cap.notes.length = 0;
cap.switches.length = 0;
currentSessionFile = realProject.sessions[0].path;
selectImpl = (_t, opts) => opts[1] ?? opts[0];
await commands.projects.handler("", cmdCtx);
console.log("  切换目标:", cap.switches.length ? cap.switches : "(未切换)");
let sawSwitchNote = false;
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ") || "(无)");
currentSessionFile = SB.path("fake-current-session.jsonl");

console.log("\n── 陈旧检测 / 自动重建 ────────────────");
const idxFile = path.join(AGENT, "index", "tasks-index.json");
const readBuiltAt = () => JSON.parse(fs.readFileSync(idxFile, "utf8")).builtAt;

selectImpl = () => undefined;
await commands.projects.handler("", cmdCtx);
const t0 = readBuiltAt();
await commands.projects.handler("", cmdCtx);
const t1 = readBuiltAt();
console.log(`  无变化时 → 不重建: ${t1 === t0}  (期望 true，避免每次打开都重扫)`);

// 模拟“你在另一个终端 cd 到新项目启动了 pi”：更新 sessions 子目录 mtime
const sessRoot = path.join(AGENT, "sessions");
const someDir = path.join(sessRoot, fs.readdirSync(sessRoot)[0]);
const bumped = new Date(Date.now() + 2000);
fs.utimesSync(someDir, bumped, bumped);
await commands.projects.handler("", cmdCtx);
const t2 = readBuiltAt();
console.log(`  目录 mtime 更新后 → 自动重建: ${t2 > t1}  (期望 true)`);

console.log("\n── 任务栏激活态（ctrl+↓）─────────────");
const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", ctrlDown: "\x1b[1;5B", other: "a" };
const BAR = "pi-tasks-bar";
/** 激活态独有的提示行 —— 用它判断状态，而不是看 widget 是否为 undefined
 *  （config.bar 为 true 时退出激活态仍会渲染普通任务栏） */
const barActive = () => (cap.widget.get(BAR) ?? []).some((l) => l.includes("Enter 切换"));
const idxNow = JSON.parse(fs.readFileSync(path.join(AGENT, "index", "tasks-index.json"), "utf8"));
const visList = idxNow.projects.filter((p) => !p.noise);
console.log(`  （当前可见项目 ${visList.length} 个）`);

editorText = "正在打字的草稿";
cap.widget.clear();
let r = press(K.ctrlDown);
check("编辑器非空时 ctrl+↓ 放行、不激活", r === undefined && cap.widget.get(BAR) === undefined);

editorText = "";
cap.widget.clear();
r = press(K.ctrlDown);
let bar = cap.widget.get(BAR);
check("编辑器为空时 ctrl+↓ 激活并吞掉按键", r?.consume === true);
check("显示了操作提示行", Array.isArray(bar) && bar.some((l) => l.includes("Enter 切换")));
check("当前项目被高亮", Array.isArray(bar) && bar.some((l) => l.startsWith("▶")));

if (visList.length > 1) {
	const before = cap.widget.get(BAR).find((l) => l.startsWith("▶"));
	press(K.down);
	const after = cap.widget.get(BAR).find((l) => l.startsWith("▶"));
	check("↓ 移动了高亮", before !== after);
} else {
	console.log("  ⏭ 只有 1 个项目，跳过高亮移动断言");
}

r = press(K.other);
check("普通字符退出激活态且原样放行", r === undefined && !barActive());

press(K.ctrlDown);
check("重新激活", barActive());
r = press(K.esc);
check("Esc 退出且吞掉", r?.consume === true && !barActive());

cap.notes.length = 0;
press(K.ctrlDown);
press(K.down);
r = press(K.enter);
const dispatched = cap.notes.find((n) => n.startsWith("sendUserMessage"));
check("Enter 吞掉并派发命令", r?.consume === true && !!dispatched);
console.log("  派发:", dispatched);
check("派发 __switch 且带项目 key（而非下标）", /sendUserMessage\(\/projects __switch .+\)/.test(dispatched ?? ""));

console.log("\n── __switch 子命令真实切换 ────────────");
cap.notes.length = 0;
cap.switches.length = 0;
// 该项目可能有多个会话 → 第二层选择器需返回一个具体会话
selectImpl = (_t, opts) => opts[0];
await commands.projects.handler(`__switch ${visList[0].key}`, cmdCtx);
console.log(`  项目: ${visList[0].name}  会话数: ${visList[0].sessions.length}`);
console.log("  切换目标:", cap.switches.length ? cap.switches : "(未切换)");
console.log("  提示:", cap.notes.filter((n) => n.startsWith("[")).join(" | ") || "(无)");
check("__switch 按 key 定位到项目并发起切换", cap.switches.length > 0);
selectImpl = () => undefined;

cap.notes.length = 0;
cap.switches.length = 0;
await commands.projects.handler("__switch c:/nonexistent/path/xyz", cmdCtx);
check("__switch 未知 key 报错且不切换", cap.switches.length === 0 && cap.notes.some((n) => n.includes("未找到项目")));

console.log("\n── session_shutdown ───────────────────");
for (const h of handlers.session_shutdown ?? []) {
	await h({ type: "session_shutdown" }, baseCtx);
}
check("无残留锁文件", !fs.existsSync(path.join(AGENT, "locks", "smoke-test-session.lock")));
check("status 已清除", cap.status.get("pi-tasks") === undefined);
check("widget 已清除", cap.widget.get("pi-tasks-bar") === undefined);

console.log("\n✔ 冒烟测试结束");
summary();
SB.cleanup();
console.log("临时目录已清理（未触碰你真实的 ~/.pi）");
