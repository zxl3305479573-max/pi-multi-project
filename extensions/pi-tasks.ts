/**
 * pi-tasks — 项目任务栏 (Project Taskbar)
 *
 * 设计原则：真相层只有一份 —— pi 自己的 session 文件（~/.pi/agent/sessions/）。
 * 本扩展不复制任何对话内容，只维护一个「可随时重建的索引缓存」，用于：
 *   (a) 任务栏展示（页脚 + 可选 widget）
 *   (b) 跨项目会话切换
 *   (c) 将来模块 B（长期记忆召回）的数据源 —— 索引 schema 已预留 labels 字段
 *
 * 索引不是第二份存储：删掉它能无损重建，永远不会与 session 漂移。
 *
 * 命令：
 *   /projects              打开项目选择器
 *   /projects bar          切换常驻任务栏 widget
 *   /projects all          包含被过滤的项目
 *   /projects hide <path>  隐藏项目（优先级最高）
 *   /projects unhide <path>
 *   /projects pin <path>   强制常驻（可覆盖 temp 过滤）
 *   /projects unpin <path>
 *   /projects refresh      重建索引
 *   /projects locks        查看活跃并发锁
 *   /projects help
 * 快捷键：alt+t（打开选择器）· 编辑器为空时 ctrl+↓（任务栏导航：↑↓ 选 · Enter 切 · Esc 取消）
 *
 * 为什么导航用 onTerminalInput 而不是 registerShortcut：
 * registerShortcut 一旦匹配就完全吞掉按键（custom-editor.js 的 handleInput 确认无放行机制），
 * 绑方向键会把编辑器行为弄坏。onTerminalInput 支持「不 consume 就正常传给聚焦组件」，
 * 所以编辑器有内容时完全不干预。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────
// 路径与常量
// ─────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const SESSIONS_ROOT = path.join(AGENT_DIR, "sessions");
const INDEX_DIR = path.join(AGENT_DIR, "index");
const INDEX_FILE = path.join(INDEX_DIR, "tasks-index.json");
const LOCKS_DIR = path.join(AGENT_DIR, "locks");
const CONFIG_FILE = path.join(AGENT_DIR, "pi-tasks.json");

const INDEX_VERSION = 1;
const DEFAULT_MAX_ROWS = 5;
const GIT_TIMEOUT_MS = 2500;
const STALE_LOCK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BRANCH_LOOKUPS = 8;
const MAX_BRANCH_CWDS = 3;
const MAX_SESSION_ROWS = 30;

const STATUS_KEY = "pi-tasks";
const WIDGET_KEY = "pi-tasks-bar";

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

interface TasksConfig {
	hidden: string[]; // 归一化 cwd key，显式隐藏
	pinned: string[]; // 归一化 cwd key，强制显示
	bar: boolean; // widget 任务栏是否展开
	maxRows: number; // widget 最多几行
}

interface SessionRef {
	path: string;
	id: string;
	name?: string;
	cwd: string;
	modified: number;
	messageCount: number;
	firstMessage: string;
}

interface ProjectRecord {
	key: string; // 归一化 cwd —— 项目身份
	cwd: string; // 展示用原始路径
	name: string;
	lastActive: number;
	sessionCount: number;
	isGit: boolean;
	isProject: boolean; // 有 .git / 清单文件 / .pi
	branch?: string;
	worktreeCount: number;
	missing: boolean; // 目录已不存在
	pinned: boolean;
	noise: boolean; // 被过滤，不进主列表
	tier: number; // 0 = 真项目，1 = 其他
	sessions: SessionRef[]; // 按 modified 倒序
}

interface TasksIndex {
	version: number;
	builtAt: number;
	projects: ProjectRecord[];
	/** 预留给模块 B：entryId → 记忆条目。v1 恒为空对象。 */
	labels: Record<string, unknown>;
}

interface LockInfo {
	pid: number;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	startedAt: number;
}

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: TasksConfig = {
	hidden: [],
	pinned: [],
	bar: false,
	maxRows: DEFAULT_MAX_ROWS,
};

function loadConfig(): TasksConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf8");
		const parsed = JSON.parse(raw) as Partial<TasksConfig>;
		return {
			...DEFAULT_CONFIG,
			...parsed,
			hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
			pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: TasksConfig): void {
	try {
		fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* 配置写入失败不该影响会话 */
	}
}

// ─────────────────────────────────────────────────────────────
// 路径归一化与过滤
// ─────────────────────────────────────────────────────────────

/** Windows 大小写不敏感：统一小写 + 去尾分隔符，作为稳定 key。 */
function normalizeKey(cwd: string): string {
	if (!cwd) return "";
	let p: string;
	try {
		p = path.resolve(cwd);
	} catch {
		p = cwd;
	}
	if (p.length > 3 && (p.endsWith("/") || p.endsWith("\\"))) {
		p = p.slice(0, -1);
	}
	return process.platform === "win32" ? p.toLowerCase() : p;
}

/** temp / node_modules / 缓存目录 —— 探测垃圾，不是真项目。 */
function isNoiseDir(cwd: string): boolean {
	const key = normalizeKey(cwd);
	if (!key) return true;

	const tmp = normalizeKey(os.tmpdir());
	if (key === tmp || key.startsWith(tmp + path.sep)) return true;

	for (const part of key.split(/[\\/]/)) {
		if (
			part === "node_modules" ||
			part === ".cache" ||
			part === "__pycache__" ||
			part === ".venv" ||
			part === ".git"
		) {
			return true;
		}
	}
	return false;
}

const PROJECT_MARKERS = [
	".git",
	"package.json",
	"pyproject.toml",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	".pi",
];

function pathExists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

function looksLikeProject(cwd: string): boolean {
	for (const marker of PROJECT_MARKERS) {
		if (pathExists(path.join(cwd, marker))) return true;
	}
	return false;
}

// ─────────────────────────────────────────────────────────────
// 并发锁（pid 锁 + 惰性清理避免僵尸锁）
// ─────────────────────────────────────────────────────────────

function lockFileFor(sessionId: string): string {
	return path.join(LOCKS_DIR, `${sessionId}.lock`);
}

function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM = 进程存在但无权限发信号，同样算活着
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/** 读取所有锁，顺手删除进程已死的僵尸锁。 */
function readLocks(): Map<string, LockInfo> {
	const out = new Map<string, LockInfo>();
	let files: string[];
	try {
		files = fs.readdirSync(LOCKS_DIR);
	} catch {
		return out;
	}

	for (const file of files) {
		if (!file.endsWith(".lock")) continue;
		const full = path.join(LOCKS_DIR, file);

		let info: LockInfo;
		try {
			info = JSON.parse(fs.readFileSync(full, "utf8")) as LockInfo;
		} catch {
			try {
				fs.unlinkSync(full);
			} catch {
				/* ignore */
			}
			continue;
		}

		const stale = !isPidAlive(info.pid) || Date.now() - (info.startedAt ?? 0) > STALE_LOCK_MS;
		if (stale) {
			try {
				fs.unlinkSync(full);
			} catch {
				/* ignore */
			}
			continue;
		}
		out.set(info.sessionId, info);
	}
	return out;
}

function acquireLock(sessionId: string, sessionFile: string, cwd: string): void {
	try {
		fs.mkdirSync(LOCKS_DIR, { recursive: true });
		const info: LockInfo = {
			pid: process.pid,
			sessionId,
			sessionFile,
			cwd,
			startedAt: Date.now(),
		};
		fs.writeFileSync(lockFileFor(sessionId), JSON.stringify(info), "utf8");
	} catch {
		/* 锁失败不该阻断会话 */
	}
}

/** 只删属于自己的锁，避免误删其他进程的。 */
function releaseLock(sessionId: string): void {
	if (!sessionId) return;
	try {
		const file = lockFileFor(sessionId);
		if (!fs.existsSync(file)) return;
		const info = JSON.parse(fs.readFileSync(file, "utf8")) as LockInfo;
		if (info.pid === process.pid) fs.unlinkSync(file);
	} catch {
		/* ignore */
	}
}

// ─────────────────────────────────────────────────────────────
// git 分支（尽力而为，失败静默）
// ─────────────────────────────────────────────────────────────

async function getBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const res = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		if (res.code !== 0) return undefined;
		const branch = res.stdout.trim();
		if (!branch || branch === "HEAD") return undefined; // detached HEAD
		return branch;
	} catch {
		return undefined; // git 不存在或超时
	}
}

interface ProjectIdentity {
	key: string;
	displayCwd: string;
	worktreeCount: number;
}

/**
 * 项目身份缓存。
 *
 * 为什么要有缓存：renderStatus / renderBar 每次重绘都要问「当前 cwd 属于哪个项目」。
 * 若每次重绘都起 git 子进程，TUI 会明显卡顿（Windows 上单次探测约 70ms）。
 * 所以索引重建时异步并发算好放进这里，渲染只查表；
 * 表里没有（刚启动、还没重建完）就退化成归一化 cwd，下次重建自动纠正。
 */
const identityCache = new Map<string, { at: number; value: ProjectIdentity }>();
const IDENTITY_TTL_MS = 30_000;

function plainIdentity(cwd: string): ProjectIdentity {
	return { key: normalizeKey(cwd), displayCwd: cwd, worktreeCount: 1 };
}

/** 只查表，绝不起子进程 —— 渲染路径专用。 */
function cachedIdentity(cwd: string): ProjectIdentity {
	return identityCache.get(normalizeKey(cwd))?.value ?? plainIdentity(cwd);
}

/**
 * 用 git 判定 cwd 是否属于一个有多个 worktree 的仓库。
 *
 * 同一仓库的多个 worktree 共享同一份历史和对象库，任务栏里应该是一个项目。
 * 判定依据是两个稳定事实：`--git-common-dir` 指向共同 .git，
 * `worktree list` 列出全部 working tree。任一失败（无 git / 不是仓库 / 超时）
 * 就退化成普通 cwd 身份 —— 宁可少合并，也不能因为 git 不可用而丢项目。
 */
async function resolveIdentity(pi: ExtensionAPI, cwd: string): Promise<ProjectIdentity> {
	const ck = normalizeKey(cwd);
	const hit = identityCache.get(ck);
	if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;

	let value = plainIdentity(cwd);
	try {
		const common = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		});
		const commonDir = common.code === 0 ? common.stdout.trim() : "";

		if (commonDir && path.isAbsolute(commonDir)) {
			const list = await pi.exec("git", ["worktree", "list", "--porcelain"], {
				cwd,
				timeout: GIT_TIMEOUT_MS,
			});
			const roots =
				list.code === 0
					? [...list.stdout.matchAll(/^worktree (.+)$/gm)].map((m) => m[1].trim())
					: [];

			if (roots.length >= 2) {
				value = {
					key: `worktree:${normalizeKey(commonDir)}`,
					displayCwd: roots[0],
					worktreeCount: roots.length,
				};
				// 同组的兄弟 worktree 直接写入缓存：它们的身份必然相同，
				// 没必要各自再去起两次 git 子进程。
				const at = Date.now();
				for (const root of roots) identityCache.set(normalizeKey(root), { at, value });
			}
		}
	} catch {
		/* git 不存在 / 超时 → 用普通 cwd 身份 */
	}

	identityCache.set(ck, { at: Date.now(), value });
	return value;
}

async function getBranches(pi: ExtensionAPI, cwds: string[]): Promise<string | undefined> {
	const branches = new Set<string>();
	// 一个 worktree 集合可能有多个 cwd，但它们通常在同几个分支上。
	// 取前 MAX_BRANCH_CWDS 个即可，避免工作树一多就起一堆子进程。
	for (const cwd of cwds.slice(0, MAX_BRANCH_CWDS)) {
		const branch = await getBranch(pi, cwd);
		if (branch) branches.add(branch);
	}
	return branches.size > 0 ? [...branches].join(" + ") : undefined;
}

// ─────────────────────────────────────────────────────────────
// 索引构建
// ─────────────────────────────────────────────────────────────

function loadIndexFromDisk(): TasksIndex | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8")) as TasksIndex;
		if (parsed?.version !== INDEX_VERSION || !Array.isArray(parsed.projects)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

function persistIndex(index: TasksIndex): void {
	try {
		fs.mkdirSync(INDEX_DIR, { recursive: true });
		fs.writeFileSync(INDEX_FILE, JSON.stringify(index), "utf8");
	} catch {
		/* 缓存写不了不是错误 */
	}
}

function sortProjects(projects: ProjectRecord[]): void {
	projects.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier - b.tier;
		return b.lastActive - a.lastActive;
	});
}

/**
 * 重建索引。数据全部来自 SessionManager.listAll()，本扩展不保存对话内容。
 */
async function buildIndex(pi: ExtensionAPI, config: TasksConfig): Promise<TasksIndex> {
	let sessions: SessionInfo[] = [];
	try {
		sessions = await SessionManager.listAll();
	} catch {
		sessions = [];
	}

	// 0) 先解析所有不同 cwd 的项目身份（同一仓库的 worktree 归为一组）。
	//    并发执行，避免按会话数串行起 git 子进程。
	const distinctCwds = [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c))];
	await Promise.all(distinctCwds.map((cwd) => resolveIdentity(pi, cwd)));

	// 1) 按项目身份分组；同一 Git worktree 集合共享一个任务栏项目
	const grouped = new Map<string, { cwd: string; sessions: SessionRef[]; worktreeCount: number }>();

	for (const s of sessions) {
		const cwd = s.cwd ?? "";
		if (!cwd) continue; // 老会话可能没有 cwd

		const identity = cachedIdentity(cwd);
		let bucket = grouped.get(identity.key);
		if (!bucket) {
			bucket = { cwd: identity.displayCwd, sessions: [], worktreeCount: identity.worktreeCount };
			grouped.set(identity.key, bucket);
		}

		bucket.sessions.push({
			path: s.path,
			id: s.id,
			name: s.name,
			cwd,
			modified: s.modified ? new Date(s.modified).getTime() : 0,
			messageCount: s.messageCount ?? 0,
			firstMessage: (s.firstMessage ?? "").replace(/\s+/g, " ").trim(),
		});
	}

	// 2) 组装项目记录
	const projects: ProjectRecord[] = [];
	for (const [key, bucket] of grouped) {
		bucket.sessions.sort((a, b) => b.modified - a.modified);

		const pinned = config.pinned.includes(key);
		const hiddenByUser = config.hidden.includes(key);
		// 显式 hide 优先级最高；pin 可以覆盖自动过滤，但不能覆盖 hide
		const noise = hiddenByUser || (isNoiseDir(bucket.cwd) && !pinned);

		const isGit = pathExists(path.join(bucket.cwd, ".git"));
		const isProject = isGit || looksLikeProject(bucket.cwd);

		projects.push({
			key,
			cwd: bucket.cwd,
			name: path.basename(bucket.cwd) || bucket.cwd,
			lastActive: bucket.sessions[0]?.modified ?? 0,
			sessionCount: bucket.sessions.length,
			isGit,
			isProject,
			worktreeCount: bucket.worktreeCount,
			missing: !pathExists(bucket.cwd),
			pinned,
			noise,
			tier: isProject ? 0 : 1,
			sessions: bucket.sessions,
		});
	}

	sortProjects(projects);

	// 3) 分支查询：只给最活跃的若干个真项目查，避免 N 次 subprocess
	const branchTargets = projects
		.filter((p) => !p.noise && !p.missing && p.isGit)
		.slice(0, MAX_BRANCH_LOOKUPS);

	await Promise.all(
		branchTargets.map(async (p) => {
			p.branch = await getBranches(pi, [...new Set(p.sessions.map((s) => s.cwd))]);
		}),
	);

	const index: TasksIndex = {
		version: INDEX_VERSION,
		builtAt: Date.now(),
		projects,
		labels: {}, // 模块 B 预留
	};

	persistIndex(index);
	return index;
}

// ─────────────────────────────────────────────────────────────
// 展示格式化
// ─────────────────────────────────────────────────────────────

function ago(ts: number): string {
	if (!ts) return "?";
	const min = Math.floor((Date.now() - ts) / 60000);
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.floor(hr / 24);
	if (day < 30) return `${day}d`;
	const mon = Math.floor(day / 30);
	if (mon < 12) return `${mon}mo`;
	return `${Math.floor(mon / 12)}y`;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function lockOf(locks: Map<string, LockInfo>, project: ProjectRecord): LockInfo | undefined {
	const lock = locks.get(project.sessions[0]?.id ?? "");
	if (!lock) return undefined;
	return lock.pid === process.pid ? undefined : lock;
}

/** 选择器 / widget 共用的行文本。刻意不含颜色，避免污染 select 渲染。 */
function rowText(project: ProjectRecord, current: boolean, lock?: LockInfo): string {
	const cursor = current ? "▸" : " ";
	const lockTag = lock ? " ●" : "  ";
	const branch = project.branch ? `  ${project.branch}` : "";
	const worktrees = project.worktreeCount > 1 ? `  ⎇${project.worktreeCount}` : "";
	const missing = project.missing ? "  (missing)" : "";
	return `${cursor} ${pad(project.name, 22)} ${pad(ago(project.lastActive), 4)}${lockTag} ${pad(`${project.sessionCount}s`, 4)}${worktrees}${branch}${missing}`;
}

// ─────────────────────────────────────────────────────────────
// 扩展主体
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	let index: TasksIndex | undefined = loadIndexFromDisk();
	let locks = new Map<string, LockInfo>();

	// ── 任务栏激活态 ────────────────────────────────────────
	// 用 ctx.ui.onTerminalInput 而不是 pi.registerShortcut：
	// registerShortcut 一旦匹配就完全吞掉按键（custom-editor.js 里确认无放行机制），
	// 绑 ctrl+↓ 会把编辑器行为弄坏。onTerminalInput 则支持「不 consume 就正常
	// 传给聚焦组件」，所以编辑器有内容或不在激活态时完全不干预。
	let taskbarActive = false;
	let taskbarIndex = 0;
	let liveCtx: ExtensionContext | undefined;
	let detachInput: (() => void) | undefined;

	// ── 视图渲染 ────────────────────────────────────────────

	function visibleProjects(): ProjectRecord[] {
		return (index?.projects ?? []).filter((p) => !p.noise);
	}

	function renderStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const list = visibleProjects();
		const currentKey = cachedIdentity(ctx.cwd).key;
		const current = list.find((p) => p.key === currentKey);
		const label = current?.name ?? (path.basename(ctx.cwd) || "?");

		const others = list.length - (current ? 1 : 0);
		const busy = list.filter((p) => lockOf(locks, p)).length;

		const parts = [label, `▸${list.length}`];
		if (others > 0) parts.push(`+${others} other`);
		if (busy > 0) parts.push(`●${busy} busy`);

		ctx.ui.setStatus(STATUS_KEY, parts.join("  ·  "));
	}

	function renderBar(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const list = visibleProjects();
		const currentKey = cachedIdentity(ctx.cwd).key;

		// 激活态：无论 config.bar 开关如何都要显示（用户正看着它导航）
		if (taskbarActive && list.length > 0) {
			const windowSize = Math.max(config.maxRows, 5);
			let start = 0;
			if (taskbarIndex >= windowSize) start = taskbarIndex - windowSize + 1;
			const shown = list.slice(start, start + windowSize);

			const rows = shown.map((p, i) => {
				const selected = start + i === taskbarIndex;
				const line =
					`${selected ? "▶" : " "} ${pad(p.name, 22)} ${pad(ago(p.lastActive), 4)} ` +
					`${lockOf(locks, p) ? "●" : " "} ${pad(`${p.sessionCount}s`, 4)}${p.worktreeCount > 1 ? `  ⎇${p.worktreeCount}` : ""}${p.branch ? `  ${p.branch}` : ""}`;
				if (selected) return ctx.ui.theme.fg("accent", line);
				return ctx.ui.theme.fg(p.key === currentKey ? "text" : "dim", line);
			});

			if (list.length > shown.length) {
				rows.push(ctx.ui.theme.fg("muted", `  … 另有 ${list.length - shown.length} 个`));
			}
			rows.push(ctx.ui.theme.fg("muted", "  ↑↓ 选择 · Enter 切换 · Esc 取消"));

			ctx.ui.setWidget(WIDGET_KEY, rows, { placement: "belowEditor" });
			return;
		}

		if (!config.bar || list.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const rows = list.slice(0, config.maxRows).map((p) => {
			const isCurrent = p.key === currentKey;
			const plain = rowText(p, isCurrent, lockOf(locks, p));
			return isCurrent ? ctx.ui.theme.fg("accent", plain) : ctx.ui.theme.fg("dim", plain);
		});

		if (list.length > config.maxRows) {
			rows.push(ctx.ui.theme.fg("muted", `  … +${list.length - config.maxRows} more`));
		}

		ctx.ui.setWidget(WIDGET_KEY, rows, { placement: "belowEditor" });
	}

	function refreshViews(ctx: ExtensionContext): void {
		locks = readLocks();
		renderStatus(ctx);
		renderBar(ctx);
	}

	// ── 任务栏激活态：状态机 ────────────────────────────────

	function deactivateTaskbar(ctx: ExtensionContext | undefined): void {
		taskbarActive = false;
		if (ctx) renderBar(ctx);
	}

	function activateTaskbar(ctx: ExtensionContext): void {
		const list = visibleProjects();
		if (list.length === 0) {
			ctx.ui.notify("pi-tasks: 没有可切换的项目（试试 /projects refresh）", "info");
			return;
		}
		taskbarActive = true;
		const i = list.findIndex((p) => p.key === cachedIdentity(ctx.cwd).key);
		taskbarIndex = i >= 0 ? i : 0;
		renderBar(ctx);
	}

	function moveTaskbar(ctx: ExtensionContext, delta: number): void {
		const list = visibleProjects();
		if (list.length === 0) return;
		taskbarIndex = (taskbarIndex + delta + list.length) % list.length;
		renderBar(ctx);
	}

	function confirmTaskbar(ctx: ExtensionContext): void {
		const list = visibleProjects();
		const picked = list[taskbarIndex];
		taskbarActive = false;
		renderBar(ctx);
		if (!picked) return;
		// switchSession 只在命令上下文上有 → 派发命令。
		// 已源码验证：扩展命令在任何消息入栈之前 return，不污染对话记录。
		pi.sendUserMessage(`/projects __switch ${picked.key}`, { expandPromptTemplates: true });
	}

	/** 返回 undefined = 不拦截，按键原样交给编辑器。 */
	function handleTerminalInput(data: string): { consume?: boolean } | undefined {
		const ctx = liveCtx;
		if (!ctx?.hasUI) return undefined;

		if (taskbarActive) {
			if (matchesKey(data, "up")) {
				moveTaskbar(ctx, -1);
				return { consume: true };
			}
			if (matchesKey(data, "down")) {
				moveTaskbar(ctx, 1);
				return { consume: true };
			}
			if (matchesKey(data, "enter")) {
				confirmTaskbar(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "escape")) {
				deactivateTaskbar(ctx);
				return { consume: true };
			}
			// 其它任何键：先退出激活态，再原样放行 —— 防止任务栏卡住输入
			deactivateTaskbar(ctx);
			return undefined;
		}

		if (matchesKey(data, "ctrl+down")) {
			let text = "";
			try {
				text = ctx.ui.getEditorText();
			} catch {
				text = "";
			}
			// 编辑器里已经有内容 → 不干预，让 ctrl+↓ 保持原义
			if (text.trim().length > 0) return undefined;
			activateTaskbar(ctx);
			return { consume: true };
		}

		return undefined;
	}

	async function rebuild(ctx: ExtensionContext, notify = false): Promise<void> {
		index = await buildIndex(pi, config);
		refreshViews(ctx);
		if (notify) {
			ctx.ui.notify(`pi-tasks: 索引已重建（${visibleProjects().length} 个项目）`, "info");
		}
	}

	/**
	 * 索引是否陈旧。
	 * 判定依据：任何 session 项目目录的 mtime 晚于索引的 builtAt
	 * （新增会话文件会更新目录 mtime）。这是廉价的探测：
	 * 只需 stat 几十个目录，不用解析全部 JSONL。
	 *
	 * 必要性：你在另一个终端 cd 到新项目启动 pi 后，新会话会落在
	 * 新的项目目录里。若不做此检查，本终端的 /projects 永远看不到它。
	 */
	function isIndexStale(): boolean {
		if (!index) return true;
		let dirs: string[];
		try {
			dirs = fs.readdirSync(SESSIONS_ROOT);
		} catch {
			return false; // 没有 sessions 根目录，保持现状
		}
		for (const d of dirs) {
			try {
				if (fs.statSync(path.join(SESSIONS_ROOT, d)).mtimeMs > index.builtAt) return true;
			} catch {
				return true; // 读不到就保守重建
			}
		}
		return false;
	}

	// ── 事件 ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		liveCtx = ctx;
		taskbarActive = false;

		// 先摘掉上一个会话的监听器，保证每个会话只有一个
		detachInput?.();
		detachInput = ctx.ui.onTerminalInput(handleTerminalInput);

		// 1) 落自己的锁
		const sessionFile = ctx.sessionManager.getSessionFile();
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionFile && sessionId) {
			acquireLock(sessionId, sessionFile, ctx.cwd);
		}

		// 2) 先用磁盘缓存立刻渲染，冷启动不卡
		refreshViews(ctx);

		// 3) 再后台重建
		void rebuild(ctx).catch(() => {
			/* 索引失败不影响会话 */
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		detachInput?.();
		detachInput = undefined;
		liveCtx = undefined;
		taskbarActive = false;

		try {
			releaseLock(ctx.sessionManager.getSessionId());
		} catch {
			/* ignore */
		}
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
	});

	// ── 切换 ────────────────────────────────────────────────

	async function switchTo(
		ctx: ExtensionCommandContext,
		target: SessionRef,
		project: ProjectRecord,
	): Promise<void> {
		// 切到自己 = 拍一扰动作，先拦住
		if (target.path === ctx.sessionManager.getSessionFile()) {
			ctx.ui.notify(`已经是当前会话（${project.name}），无需切换`, "info");
			return;
		}

		if (!pathExists(target.cwd)) {
			ctx.ui.notify(
				`目录已不存在：${target.cwd}\n可用 /projects hide 移除该记录`,
				"error",
			);
			return;
		}

		const lock = locks.get(target.id);
		if (lock && lock.pid !== process.pid && isPidAlive(lock.pid)) {
			const ok = await ctx.ui.confirm(
				"该会话已在别处打开",
				`pid ${lock.pid} 正在使用这个会话文件。\n同时写入可能导致记录损坏。仍要切换？`,
			);
			if (!ok) return;
		}

		await ctx.switchSession(target.path, {
			withSession: async (rctx) => {
				rctx.ui.notify(`pi-tasks: 已切换到 ${project.name}`, "info");
			},
		});
	}

	// ── 选择器（需要命令上下文：switchSession 只有命令层有）──

	async function openPicker(ctx: ExtensionCommandContext, includeAll: boolean): Promise<void> {
		// 切换时刻重新读锁：避免用到陈旧快照，漏判并发冲突
		locks = readLocks();

		const list = includeAll ? (index?.projects ?? []) : visibleProjects();

		if (list.length === 0) {
			ctx.ui.notify("pi-tasks: 没有可切换的项目（试试 /projects refresh）", "info");
			return;
		}

		const currentKey = cachedIdentity(ctx.cwd).key;
		const rows: string[] = [];

		list.forEach((p, i) => {
			const marker = String(i + 1).padStart(2, "0");
			const tags: string[] = [];
			if (p.key === currentKey) tags.push("current");
			if (p.pinned) tags.push("pinned");
			if (p.noise) tags.push("filtered");
			const suffix = tags.length ? `  [${tags.join(",")}]` : "";
			rows.push(
				`${marker}  ${rowText(p, p.key === currentKey, lockOf(locks, p))}${suffix}`,
			);
		});

		const choice = await ctx.ui.select(`项目 (${list.length})`, rows);
		if (!choice) return;

		const picked = list[Number.parseInt(choice.slice(0, 2), 10) - 1];
		if (!picked) return;

		if (picked.sessions.length === 0) {
			ctx.ui.notify(`${picked.name}: 没有会话记录`, "warning");
			return;
		}

		await pickSession(ctx, picked, includeAll);
	}

	/** 选定项目后挑具体会话：单会话直接切，多会话弹选择器。 */
	async function pickSession(
		ctx: ExtensionCommandContext,
		picked: ProjectRecord,
		includeAll: boolean,
	): Promise<void> {
		if (picked.sessions.length === 1) {
			await switchTo(ctx, picked.sessions[0], picked);
			return;
		}

		const currentFile = ctx.sessionManager.getSessionFile();
		const shown = picked.sessions.slice(0, MAX_SESSION_ROWS);
		const sessionRows = shown.map((s, i) => {
			const lock = locks.get(s.id);
			const lockTag = lock && lock.pid !== process.pid ? "  ● 使用中" : "";
			const hereTag = s.path === currentFile ? "  ← 当前" : "";
			const title = s.name?.trim() || s.firstMessage.slice(0, 44) || "(空会话)";
			return `${String(i + 1).padStart(2, "0")}  ${pad(ago(s.modified), 4)}  ${pad(`${s.messageCount}`, 5)} msg  ${title}${hereTag}${lockTag}`;
		});
		const backIndex = shown.length + 1;
		sessionRows.push(`${String(backIndex).padStart(2, "0")}  ← 返回项目列表`);

		const sChoice = await ctx.ui.select(
			`${picked.name} — 选择会话 (${picked.sessions.length})`,
			sessionRows,
		);
		if (!sChoice) return;

		const sIdx = Number.parseInt(sChoice.slice(0, 2), 10) - 1;
		if (sIdx === shown.length) {
			await openPicker(ctx, includeAll); // 返回上一层
			return;
		}

		const session = shown[sIdx];
		if (session) await switchTo(ctx, session, picked);
	}

	// ── 命令 ────────────────────────────────────────────────

	function findProjectByPath(input: string): ProjectRecord | undefined {
		return (index?.projects ?? []).find(
			(p) => p.key === cachedIdentity(input).key || normalizeKey(p.cwd) === normalizeKey(input),
		);
	}

	const HELP = [
		"/projects               打开项目选择器",
		"/projects bar           切换常驻任务栏 widget",
		"/projects all           包含被过滤的项目",
		"/projects refresh       重建索引",
		"/projects locks         查看活跃锁",
		"/projects hide <path>   隐藏项目（优先级最高）",
		"/projects unhide <path>",
		"/projects pin <path>    强制显示（可覆盖 temp 过滤）",
		"/projects unpin <path>",
		"快捷键 alt+t（选择器）· 编辑器为空时 ctrl+↓（任务栏导航）",
	].join("\n");

	pi.registerCommand("projects", {
		description: "项目任务栏：跨项目切换会话",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				"bar",
				"all",
				"refresh",
				"locks",
				"hide",
				"unhide",
				"pin",
				"unpin",
				"help",
			];
			const filtered = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ").trim();

			switch (sub) {
				case "":
				case "all": {
					// 打开任务栏前先检查是否有新项目/新会话，避免看到陈旧列表
					if (isIndexStale()) await rebuild(ctx);
					await openPicker(ctx, sub === "all");
					return;
				}

				case "__switch": {
					// 任务栏激活态按 Enter 派发过来的（见 confirmTaskbar）。
					// 故意用归一化 cwd key 定位而不是数组下标 —— 索引可能因重建而重排。
					if (!arg) return;
					if (isIndexStale()) await rebuild(ctx);
					const picked = (index?.projects ?? []).find(
						(p) => p.key === arg || p.key === cachedIdentity(arg).key,
					);
					if (!picked) {
						ctx.ui.notify(`pi-tasks: 未找到项目 ${arg}`, "error");
						return;
					}
					if (picked.sessions.length === 0) {
						ctx.ui.notify(`${picked.name}: 没有会话记录`, "warning");
						return;
					}
					await pickSession(ctx, picked, false);
					return;
				}

				case "bar": {
					config.bar = !config.bar;
					saveConfig(config);
					renderBar(ctx);
					ctx.ui.notify(`pi-tasks: 任务栏 ${config.bar ? "已展开" : "已收起"}`, "info");
					return;
				}

				case "all": {
					await openPicker(ctx, true);
					return;
				}


				case "refresh": {
					await rebuild(ctx, true);
					return;
				}

				case "locks": {
					locks = readLocks();
					if (locks.size === 0) {
						ctx.ui.notify("pi-tasks: 没有活跃锁", "info");
						return;
					}
					const lines = [...locks.values()].map(
						(l) => `pid ${l.pid}  ${path.basename(l.cwd) || l.cwd}  ${ago(l.startedAt)}`,
					);
					ctx.ui.notify(`活跃锁 (${locks.size}):\n${lines.join("\n")}`, "info");
					refreshViews(ctx);
					return;
				}

				case "hide":
				case "unhide":
				case "pin":
				case "unpin": {
					if (!arg) {
						ctx.ui.notify(`用法：/projects ${sub} <项目路径>`, "warning");
						return;
					}
					const key = cachedIdentity(arg).key;
					if (sub === "hide" || sub === "unhide") {
						config.hidden = config.hidden.filter((k) => k !== key);
						if (sub === "hide") config.hidden.push(key);
					} else {
						config.pinned = config.pinned.filter((k) => k !== key);
						if (sub === "pin") config.pinned.push(key);
					}
					saveConfig(config);
					await rebuild(ctx);
					const label = findProjectByPath(arg)?.name ?? path.basename(arg);
					ctx.ui.notify(`pi-tasks: ${sub} ${label}`, "info");
					return;
				}

				default: {
					ctx.ui.notify(HELP, "info");
					return;
				}
			}
		},
	});

	// 快捷键上下文没有 switchSession（只有命令上下文有），所以走命令派发。
	// 源码确认：扩展命令执行后在任何消息入栈之前 return，不会污染对话记录，
	// 且在 streaming 期间也能执行。
	pi.registerShortcut("alt+t", {
		description: "项目任务栏",
		handler: () => {
			pi.sendUserMessage("/projects", { expandPromptTemplates: true });
		},
	});
}
