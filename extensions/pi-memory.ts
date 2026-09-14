/**
 * pi-memory — 项目级长期记忆
 *
 * 职责边界（方案 B）：
 *   本扩展**只管项目层**。全局偏好不在职责内 —— pi 原生就会加载
 *   ~/.pi/agent/AGENTS.md，几条稳定的偏好由用户手写更划算
 *   （零依赖、完全可控），扩展在这里是负收益。
 *
 * 设计原则：
 *   1. 不重复造 pi 原生机制。pi 已按 cwd 逐级向上查找并全量注入 AGENTS.md，
 *      所以**注入部分零代码**。
 *   2. 记忆单位是「一次任务执行过程的压缩结论」，不是原子事实。
 *      最重的第一道压缩 pi 的 compaction 已经做完，本扩展只提取与去临时化。
 *   3. 存储落在人可读可编辑的文件里，不是隐藏的数据库：
 *        项目知识  <项目>/AGENTS.md                「## 项目记忆」
 *        冷归档    <项目>/.pi/memory-archive.md    （不进 system prompt）
 *   4. 软上限只提示，不自动删。超限时把最旧条目剪切进归档，一条不丢。
 *   5. 门禁：只在「看起来是项目」的目录写。因为 AGENTS.md 是逐级向上查找的，
 *      在祖先目录（尤其家目录）写会渗漏到其下所有项目。
 *   6. 确认框只在任务结束后弹（agent_settled），**绝不打断任务执行**。
 *
 * 命令：/remember  /memory [status|list|absorb|prune|archive|recall|pending|flush|dryrun|help]
 * 工具：memory_write（入队 → 任务结束统一确认 → 才写）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const CONFIG_FILE = path.join(AGENT_DIR, "pi-memory.json");
const PENDING_FILE = path.join(AGENT_DIR, "pi-memory-pending.json");
const STATUS_KEY = "pi-memory";

const START = "<!-- pi-memory:start -->";
const END = "<!-- pi-memory:end -->";

const TAGS = ["decision", "pitfall", "api", "context", "preference", "milestone", "note"] as const;

/** 判定一个目录“是不是项目”。与 pi-tasks 用同一套标记，但两者独立。 */
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

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

interface MemConfig {
	/** true = 只展示将要写入的内容，不落盘（首次试用默认开） */
	dryRun: boolean;
	/** 热记忆行数软上限，超了只提示 */
	softLimit: number;
}

interface MemEntry {
	tag: string;
	text: string;
	extra: string[];
}

interface MemorySection {
	/** 整个文件内容；文件不存在时为 "" */
	content: string;
	exists: boolean;
	/** 记忆节是否已存在 */
	hasSection: boolean;
	entries: MemEntry[];
	pointer?: string;
}

interface Target {
	file: string;
	archive: string;
	heading: string;
	note: string;
	/** 展示用的层次标签，直接进页脚 */
	layer: "全局" | "项目";
}

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MemConfig = { dryRun: true, softLimit: 60 };

function loadConfig(): MemConfig {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Partial<MemConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: MemConfig): void {
	try {
		fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
	} catch {
		/* ignore */
	}
}

// ─────────────────────────────────────────────────────────────
// 目标文件解析
// ─────────────────────────────────────────────────────────────

function samePath(a: string, b: string): boolean {
	const norm = (p: string) => {
		try {
			const r = path.resolve(p);
			return process.platform === "win32" ? r.toLowerCase() : r;
		} catch {
			return p;
		}
	};
	return norm(a) === norm(b);
}

function isHomeDir(cwd: string): boolean {
	try {
		return samePath(cwd, os.homedir());
	} catch {
		return false;
	}
}

/**
 * 全局层现在是纯手写 markdown（无 pi-memory 标记），所以不能走 parseBody，
 * 按 markdown 列表项计数。本函数只读不写 —— 方案的 B 限制的是写入职责，不是读取。
 */
function countBullets(file: string): number {
	return (readFileSafe(file).match(/^\s*[-*]\s+\S/gm) ?? []).length;
}

/** 目标永远是当前 cwd 的项目层。全局层不再由本扩展管。 */
function resolveTarget(cwd: string): Target {
	return {
		file: path.join(cwd, "AGENTS.md"),
		archive: path.join(cwd, ".pi", "memory-archive.md"),
		heading: "项目记忆",
		note: "项目层",
		layer: "项目",
	};
}

function isProjectDir(cwd: string): boolean {
	for (const marker of PROJECT_MARKERS) {
		if (pathExists(path.join(cwd, marker))) return true;
	}
	return false;
}

function pathExists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/**
 * 写入前的门禁。
 *
 * 为什么需要它：pi 的 AGENTS.md 是**从 cwd 逐级向上查找**的。如果在一个
 * 祖先目录（尤其是家目录）里写，这份记忆会渗漏到其下**所有**项目。
 * 所以只在“看起来是项目”的目录里才写；否则拒绝并告知替代做法。
 */
function canHostProjectMemory(cwd: string): boolean {
	return !isHomeDir(cwd) && isProjectDir(cwd);
}

function projectGate(cwd: string): string | undefined {
	if (canHostProjectMemory(cwd)) return undefined;

	const why = isHomeDir(cwd)
		? "当前 cwd 是家目录。家目录是几乎所有项目的祖先，且本身可能就是个 git 仓库。"
		: `当前 cwd 不像项目目录（没找到 ${PROJECT_MARKERS.slice(0, 3).join(" / ")} 等标记）。`;

	return [
		why,
		"→ 拒绝写入项目层，否则会渗漏到其下所有子项目。",
		"",
		"pi-memory 只负责项目层记忆。全局偏好请直接手写 ~/.pi/agent/AGENTS.md：",
		"pi 原生就会加载它，不需要扩展参与。",
		"",
		"或者 cd 到一个真实项目目录再记。",
	].join("\n");
}

// ─────────────────────────────────────────────────────────────
// 跨进程写锁
// ─────────────────────────────────────────────────────────────
//
// 问题：两个 pi 进程在同一个项目里同时 flush 记忆时，双方都是
// 「读 AGENTS.md → 改 → 写」。writeAtomic 保证单次写入不会写坏文件，
// 但它是 last-write-wins —— 后写的那次会**静默吃掉**另一次的记忆。
//
// 做法：写之前拿一把基于文件的独占锁（O_EXCL 创建，原子操作），
// 拿到之后**重新读取**再应用本次增量（见 transact）。
// 锁统一放在 ~/.pi/agent/locks/ 下按目标路径哈希命名，
// 不往项目目录里扔额外文件。

const MEM_LOCK_WAIT_MS = 3000;
const MEM_LOCK_RETRY_MS = 60;
const MEM_LOCK_STALE_MS = 30_000;

interface MemLockInfo {
	pid: number;
	at: number;
	file: string;
}

function normPathKey(p: string): string {
	try {
		const r = path.resolve(p);
		return process.platform === "win32" ? r.toLowerCase() : r;
	} catch {
		return p;
	}
}

function memLockPathFor(targetFile: string): string {
	const hash = createHash("sha1").update(normPathKey(targetFile)).digest("hex").slice(0, 16);
	return path.join(AGENT_DIR, "locks", `mem-${hash}.lock`);
}

function readMemLock(lockPath: string): MemLockInfo | undefined {
	try {
		return JSON.parse(fs.readFileSync(lockPath, "utf8")) as MemLockInfo;
	} catch {
		return undefined;
	}
}

function memPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * 取独占锁。拿不到时会在 MEM_LOCK_WAIT_MS 内重试，
 * 并在检测到僵尸锁（进程已死 / 超时）时主动清理。
 */
async function acquireMemoryLock(
	targetFile: string,
): Promise<{ ok: true; release: () => void } | { ok: false; holder?: MemLockInfo }> {
	const lockPath = memLockPathFor(targetFile);
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	} catch {
		return { ok: false };
	}

	const deadline = Date.now() + MEM_LOCK_WAIT_MS;
	for (;;) {
		try {
			// flag "wx" = 文件已存在则失败，且创建是原子的
			fs.writeFileSync(
				lockPath,
				JSON.stringify({ pid: process.pid, at: Date.now(), file: targetFile }),
				{ flag: "wx" },
			);
			return {
				ok: true,
				release: () => {
					try {
						fs.unlinkSync(lockPath);
					} catch {
						/* ignore */
					}
				},
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return { ok: false };

			const holder = readMemLock(lockPath);
			const stale =
				!holder || !memPidAlive(holder.pid) || Date.now() - (holder.at ?? 0) > MEM_LOCK_STALE_MS;
			if (stale) {
				try {
					fs.unlinkSync(lockPath);
				} catch {
					/* ignore */
				}
				continue; // 清掉僵尸锁后立即重试
			}
			if (Date.now() >= deadline) return { ok: false, holder };
			await new Promise((r) => setTimeout(r, MEM_LOCK_RETRY_MS));
		}
	}
}

// ─────────────────────────────────────────────────────────────
// 记忆节：读取 / 解析 / 序列化 / 写入
// ─────────────────────────────────────────────────────────────

function readFileSafe(file: string): string {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** 容错解析：`- ` 开头是新条目；`> ` 是归档指针；其余归入上一条的续行。 */
function parseBody(body: string): { entries: MemEntry[]; pointer?: string } {
	const entries: MemEntry[] = [];
	let pointer: string | undefined;
	let cur: MemEntry | undefined;

	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim()) continue;

		if (line.startsWith(">")) {
			pointer = line;
			continue;
		}
		if (line.startsWith("- ")) {
			const m = line.match(/^- \[([^\]]+)\]\s*(.*)$/);
			cur = m ? { tag: m[1], text: m[2].trim(), extra: [] } : { tag: "note", text: line.slice(2).trim(), extra: [] };
			entries.push(cur);
			continue;
		}
		if (line.startsWith("#")) continue; // 标题行由序列化时重建
		if (cur) cur.extra.push(line.trim());
	}
	return { entries, pointer };
}

function readMemory(file: string): MemorySection {
	const content = readFileSafe(file);
	const exists = content.length > 0;

	const s = content.indexOf(START);
	const e = s === -1 ? -1 : content.indexOf(END, s);
	if (s === -1 || e === -1) {
		return { content, exists, hasSection: false, entries: [] };
	}

	const { entries, pointer } = parseBody(content.slice(s + START.length, e));
	return { content, exists, hasSection: true, entries, pointer };
}

function renderEntry(entry: MemEntry): string[] {
	return [`- [${entry.tag}] ${entry.text}`, ...entry.extra.map((l) => `  ${l}`)];
}

function entryLines(entries: MemEntry[]): number {
	return entries.reduce((n, e) => n + renderEntry(e).length, 0);
}

function renderSection(heading: string, entries: MemEntry[], pointer?: string): string {
	const lines = [START, `## ${heading}`, ""];
	for (const e of entries) lines.push(...renderEntry(e));
	if (pointer) {
		lines.push("");
		lines.push(pointer);
	}
	lines.push(END);
	return lines.join("\n");
}

/** 只替换记忆节，文件其余内容原样保留。节不存在则追加到文件末尾。 */
function composeFile(section: MemorySection, heading: string, entries: MemEntry[], pointer?: string): string {
	const block = renderSection(heading, entries, pointer);

	if (!section.hasSection) {
		const base = section.content.replace(/\s+$/, "");
		return base ? `${base}\n\n${block}\n` : `${block}\n`;
	}

	const s = section.content.indexOf(START);
	const e = section.content.indexOf(END, s) + END.length;
	return section.content.slice(0, s) + block + section.content.slice(e);
}

function writeAtomic(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, file);
}

/** 路径展示统一用正斜杠 —— 它会被写进 markdown 里，反斜杠既难读也容易被当转义。 */
function relForDisplay(from: string, to: string): string {
	try {
		return path.relative(from, to).split(path.sep).join("/") || to;
	} catch {
		return to;
	}
}

function pointerLine(target: Target, count: number): string {
	return `> 更早的 ${count} 条已归档：\`${relForDisplay(path.dirname(target.file), target.archive)}\`（需要时自行 read/grep）`;
}

function readPointerCount(pointer: string | undefined): number {
	return Number.parseInt(pointer?.match(/更早的 (\d+) 条/)?.[1] ?? "0", 10) || 0;
}

/** 小文件显示字节，不然 200B 会被 round 成 0KB。 */
function sizeText(file: string): string {	try {
		const bytes = fs.statSync(file).size;
		return bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`;
	} catch {
		return "?";
	}
}

function archiveEntries(archive: string, title: string, entries: MemEntry[]): void {
	if (entries.length === 0) return;
	const date = new Date().toISOString().slice(0, 10);
	const lines = [`## ${date} 归档（${entries.length} 条）`, ""];
	for (const e of entries) lines.push(...renderEntry(e));
	lines.push("");

	fs.mkdirSync(path.dirname(archive), { recursive: true });
	if (!fs.existsSync(archive)) {
		const header = [
			`# ${title} — 记忆归档`,
			"",
			"> 由 pi-memory 扩展维护。本文件**不注入** system prompt，需要时手动 read/grep。",
			"> 条目从热记忆区移出时写入这里，只追加，不删除。",
			"",
			"",
		].join("\n");
		fs.writeFileSync(archive, header + lines.join("\n"), "utf8");
		return;
	}
	fs.appendFileSync(archive, `\n${lines.join("\n")}`, "utf8");
}

// ─────────────────────────────────────────────────────────────
// 匹配旧的同义条目（用于 supersedes）
// ─────────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
	return s
		.toLowerCase()
		.replace(/\s+/g, "")
		.replace(/[，。；：、,.;:!？?！"'`]/g, "");
}

function findSuperseded(entries: MemEntry[], needle: string): number {
	const target = normalizeForMatch(needle);
	if (!target) return -1;
	// 先精确，再前缀，再包含
	let idx = entries.findIndex((e) => normalizeForMatch(e.text) === target);
	if (idx >= 0) return idx;
	idx = entries.findIndex((e) => normalizeForMatch(e.text).startsWith(target));
	if (idx >= 0) return idx;
	return entries.findIndex((e) => normalizeForMatch(e.text).includes(target));
}

// ─────────────────────────────────────────────────────────────
// 扩展主体
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config = loadConfig();
	/** 检测到新的 compaction 摘要，等待 /memory absorb */
	let pendingAbsorb = 0;

	/**
	 * 统一落盘入口：追加条目 → 超限则把最旧条目剪进归档 → 写文件。
	 * 所有写入都走 transact，不再有其它读-改-写路径。
	 */
	interface TxOutcome {
		ok: boolean;
		kept: MemEntry[];
		moved: number;
		removed: number;
		/** 失败原因（锁冲突 / 目录消失 / IO 错误） */
		reason?: string;
		/** true = 瞬态失败（锁冲突），值得重试；false = 永久失败，重试也没用 */
		transient?: boolean;
	}

	/**
	 * 事务性修改：拿锁 → **重新读取** → 应用本次增量 → 裁剪归档 → 原子写入 → 解锁。
	 *
	 * 「拿到锁后重读」是关键：两个进程各自基于**最新**内容追加，
	 * 而不是各自基于旧快照互相覆盖。
	 */
	async function transact(
		target: Target,
		opts: { adds?: MemEntry[]; removes?: string[]; archiveRemoved?: boolean } = {},
	): Promise<TxOutcome> {
		const lock = await acquireMemoryLock(target.file);
		if (!lock.ok) {
			const by = lock.holder ? `pid ${lock.holder.pid}` : "未知进程";
			return {
				ok: false,
				kept: [],
				moved: 0,
				removed: 0,
				reason: `另一个 pi 进程（${by}）正在写这个文件，本次跳过以免覆盖它的修改。`,
				transient: true,
			};
		}

		try {
			const dir = path.dirname(target.file);
			// 项目目录可能在入队之后被删除/移动。
			// 绝不能靠 writeAtomic 里的 mkdir('recursive') 把它凭空创建回来。
			if (!fs.existsSync(dir)) {
				return {
					ok: false,
					kept: [],
					moved: 0,
					removed: 0,
					reason: `目标目录已不存在：${dir}`,
					transient: false,
				};
			}

			const fresh = readMemory(target.file);
			const entries = [...fresh.entries];
			const archived: MemEntry[] = [];
			let removed = 0;

			for (const needle of opts.removes ?? []) {
				const i = findSuperseded(entries, needle);
				if (i >= 0) {
					const gone = entries.splice(i, 1)[0];
					if (gone) {
						archived.push(gone);
						removed++;
					}
				}
			}
			for (const e of opts.adds ?? []) entries.push(e);

			const dropped: MemEntry[] = [];
			if (entryLines(entries) > config.softLimit) {
				const keepTarget = Math.floor(config.softLimit * 0.8);
				while (entries.length > 1 && entryLines(entries) > keepTarget) {
					const oldest = entries.shift();
					if (oldest) dropped.push(oldest);
				}
			}

			const toArchive = [...(opts.archiveRemoved ? archived : []), ...dropped];
			let pointer = fresh.pointer;
			if (toArchive.length > 0) {
				archiveEntries(target.archive, target.heading, toArchive);
				pointer = pointerLine(target, readPointerCount(fresh.pointer) + toArchive.length);
			}

			writeAtomic(target.file, composeFile(fresh, target.heading, entries, pointer));
			return { ok: true, kept: entries, moved: dropped.length, removed };
		} catch (err) {
			return {
				ok: false,
				kept: [],
				moved: 0,
				removed: 0,
				reason: `写入失败：${err instanceof Error ? err.message : String(err)}`,
				transient: false,
			};
		} finally {
			lock.release();
		}
	}

	// ── 写入流程：暂存 → 任务结束后统一确认 ──────────────────
	//
	// 硬约束（用户明确要求）：记忆确认框**不能打断任务执行**。
	// 所以 memory_write 只入队、立即返回；真正的确认与落盘放在
	// agent_settled（pi 不会再自动继续时）统一做。
	// 副作用：顺带修掉了「N 条记忆弹 N 次框」的体验问题。

	interface StagedWrite {
		cwd: string;
		text: string;
		tag: string;
		supersedes?: string;
		source: string;
	}

	let pending: StagedWrite[] = [];

	function toEntry(s: StagedWrite): MemEntry {
		const parts = s.text.trim().split(/\r?\n/);
		return {
			tag: s.tag,
			text: parts[0].trim(),
			extra: parts.slice(1).map((l) => l.trim()).filter(Boolean),
		};
	}

	function savePending(): void {
		try {
			fs.mkdirSync(AGENT_DIR, { recursive: true });
			fs.writeFileSync(PENDING_FILE, JSON.stringify(pending), "utf8");
		} catch {
			/* ignore */
		}
	}

	function loadPending(): void {
		try {
			const parsed = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
			pending = Array.isArray(parsed) ? parsed : [];
		} catch {
			pending = [];
		}
	}

	function clearPendingFile(): void {
		try {
			if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
		} catch {
			/* ignore */
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		// 全局层：本扩展不写，但仍展示它的规模 —— 它每轮都被注入，成本应当可见。
		const globalCount = countBullets(path.join(AGENT_DIR, "AGENTS.md"));
		const parts: string[] = [];

		if (canHostProjectMemory(ctx.cwd)) {
			const target = resolveTarget(ctx.cwd);
			const n = entryLines(readMemory(target.file).entries);
			parts.push(`项目 ${n}/${config.softLimit}`);
			if (n > config.softLimit) parts.push("⚠ 超上限");
		}

		parts.push(`全局 ${globalCount}`);
		if (pending.length > 0) parts.push(`待确认 ${pending.length}`);
		if (pendingAbsorb > 0) parts.push(`absorb?(${pendingAbsorb})`);
		if (config.dryRun) parts.push("DRY-RUN");

		ctx.ui.setStatus(STATUS_KEY, `mem ${parts.join("  ·  ")}`);
	}

	/** 只入队，不弹任何框。 */
	function stageWrite(
		ctx: ExtensionContext,
		req: { text: string; tag: string; supersedes?: string },
		source: string,
	): string {
		const text = req.text.trim();
		if (!text) return "拒绝：内容为空";

		// 门禁：非项目目录不入队，避免写到会向子目录渗漏的位置
		const blocked = projectGate(ctx.cwd);
		if (blocked) return `未入队。\n\n${blocked}`;

		const item: StagedWrite = { cwd: ctx.cwd, text, tag: req.tag, supersedes: req.supersedes, source };
		pending.push(item);
		savePending();
		updateStatus(ctx);

		const target = resolveTarget(ctx.cwd);
		return [
			`已排队（第 ${pending.length} 条 · 来源 ${source}）`,
			...renderEntry(toEntry(item)).map((l) => `  ${l}`),
			`目标：${target.file}`,
			"",
			"任务结束后会统一弹一次确认框再写入，不打断当前执行。",
		].join("\n");
	}

	async function commitGroup(
		target: Target,
		items: StagedWrite[],
	): Promise<{ ok: boolean; text: string; items: StagedWrite[]; reason?: string; transient: boolean }> {
		const removes = items.map((s) => s.supersedes).filter((x): x is string => typeof x === "string" && x.length > 0);
		const res = await transact(target, { adds: items.map(toEntry), removes });

		if (!res.ok) {
			return {
				ok: false,
				items,
				reason: res.reason,
				transient: res.transient === true,
				text: `✗ ${target.heading} — ${res.reason}`,
			};
		}
		return {
			ok: true,
			items,
			transient: false,
			text: `${target.heading}: +${items.length}${res.removed ? ` \u2212${res.removed}` : ""}${res.moved ? ` · 归档 ${res.moved}` : ""} → ${entryLines(res.kept)} 行`,
		};
	}

	/** 统一确认并落盘。任务进行中直接返回，绝不打断。 */
	async function flushPending(ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<boolean> {
		if (pending.length === 0) return false;
		if (!ctx.hasUI) {
			pending = [];
			clearPendingFile();
			return false;
		}
		// 只在空闲时弹框；任务进行中保留队列
		if (!opts.force && !ctx.isIdle()) return false;

		const batch = pending;
		pending = [];
		clearPendingFile();
		updateStatus(ctx);

		const groups = new Map<string, { target: Target; items: StagedWrite[] }>();
		for (const s of batch) {
			const target = resolveTarget(s.cwd);
			let g = groups.get(target.file);
			if (!g) {
				g = { target, items: [] };
				groups.set(target.file, g);
			}
			g.items.push(s);
		}

		const preview = [...groups.values()]
			.flatMap((g) => [
				`▶ ${g.target.heading}（${g.target.note}）`,
				`    ${g.target.file}`,
				...g.items.flatMap((s) => renderEntry(toEntry(s)).map((l) => `    ${l}`)),
				"",
			])
			.join("\n");

		if (config.dryRun) {
			ctx.ui.notify(
				`[DRY RUN] 未写入，队列已清空（dry-run 下不保留）。待确认内容：\n\n${preview}`,
				"warning",
			);
			return false;
		}

		let chosen: StagedWrite[] = batch;
		if (batch.length === 1) {
			const ok = await ctx.ui.confirm("写入这条记忆？", preview);
			if (!ok) {
				ctx.ui.notify("pi-memory: 已丢弃 1 条待确认记忆", "info");
				return false;
			}
		} else {
			const action = await ctx.ui.select(`待确认 ${batch.length} 条记忆`, [
				"全部写入",
				"逐条确认",
				"全部丢弃",
			]);
			if (!action || action === "全部丢弃") {
				ctx.ui.notify(`pi-memory: 已丢弃 ${batch.length} 条待确认记忆`, "info");
				return false;
			}
			if (action === "逐条确认") {
				chosen = [];
				for (const s of batch) {
					const keep = await ctx.ui.confirm("写入这条？", renderEntry(toEntry(s)).join("\n"));
					if (keep) chosen.push(s);
				}
				if (chosen.length === 0) {
					ctx.ui.notify("pi-memory: 全部跳过", "info");
					return false;
				}
			}
		}

		const report: string[] = [];
		let written = 0;
		const retryable: StagedWrite[] = [];
		const giveUp: StagedWrite[] = [];
		for (const g of groups.values()) {
			const items = g.items.filter((s) => chosen.includes(s));
			if (items.length === 0) continue;
			const r = await commitGroup(g.target, items);
			report.push(r.text);
			if (r.ok) written += items.length;
			else if (r.transient) retryable.push(...items);
			else giveUp.push(...items);
		}

		// 瞬态失败（锁冲突）放回队列重试；永久失败（目录没了）直接丢弃，
		// 否则会永远卡在队列里、每次 flush 都重试并抱怨一次。
		if (retryable.length > 0) {
			pending.push(...retryable);
			savePending();
			report.push(`↻ ${retryable.length} 条已放回待确认队列，下次重试`);
		}
		if (giveUp.length > 0) {
			report.push(`✗ ${giveUp.length} 条已丢弃（原因不可恢复，重试也没用）`);
		}

		const tail = retryable.length + giveUp.length > 0 ? "（部分失败）" : "";
		ctx.ui.notify(
			written > 0
				? `pi-memory: 已写入 ${written} 条${tail}\n${report.join("\n")}`
				: `pi-memory: 未能写入任何条目\n${report.join("\n")}`,
			written > 0 ? "info" : "error",
		);
		updateStatus(ctx);
		return written > 0;
	}

	// ── 事件 ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadPending();
		updateStatus(ctx);
		if (ctx.hasUI && pending.length > 0) {
			ctx.ui.notify(
				`pi-memory: 有 ${pending.length} 条上次未确认的记忆，完成任务后会自动弹框（或 /memory flush 立即处理）`,
				"info",
			);
		}
	});

	// compaction 产生新摘要 → 只记计数，不打断
	pi.on("session_compact", async (_event, ctx) => {
		pendingAbsorb++;
		updateStatus(ctx);
	});

	// pi 不会再自动继续了 → 这时才弹确认框，绝不打断任务执行
	pi.on("agent_settled", async (_event, ctx) => {
		await flushPending(ctx);
	});

	// 每回合结束重算一次页脚，避免显示陈旧计数
	// （文件可能被外部编辑、或由 _preload 之外的工具改动）
	pi.on("turn_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// ── 工具：memory_write ──────────────────────────────────

	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description:
			"把值得长期记住的项目结论写进当前项目的 <cwd>/AGENTS.md。用于记录：项目的架构决策及其理由、踩过的坑、不易从代码推断的约定。" +
			"不要记录：能从仓库文件读出来的事实（会过时）、一次性的问答、临时的下一步计划。" +
			"跨项目的个人偏好不要用本工具（请让用户手写 ~/.pi/agent/AGENTS.md）。" +
			"本工具只入队、立即返回，不会打断任务；任务真正结束后会统一弹一次确认框，用户可能拒绝。",
		promptSnippet: "把项目级的长期结论（决策/坑/约定）写进项目记忆，写前会弹确认",
		promptGuidelines: [
			"当一个任务阶段收尾、或用户明确纠正了你、或定下了一个不易从代码推断的约定时，用 memory_write 记一条。",
			"memory_write 的 text 要写「压缩后的结论」，不要粘贴对话原文。",
			"能从仓库读出的东西不要写进记忆。",
			"只在真实项目目录里用；在家目录等非项目目录会被门禁拒绝。",
			"跨项目的个人偏好（如回复语言）不用本工具，让用户手写全局 AGENTS.md。",
			"memory_write 是入队式的，不会打断当前任务；不要在调用后等确认框，继续干活。",
		],
		parameters: Type.Object({
			text: Type.String({
				description: "记忆内容。一句话或几行；第一行是结论，后续行可写理由/细节。",
			}),
			tag: StringEnum(TAGS, { description: "分类：decision=决策, pitfall=坑, api=接口事实, context=关键上下文, preference=偏好, milestone=里程碑" }),
			supersedes: Type.Optional(
				Type.String({ description: "可选。要取代的旧条目文本（前缀匹配），用于推翻过时记忆。" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = stageWrite(
				ctx,
				{
					text: params.text,
					tag: params.tag,
					supersedes: params.supersedes,
				},
				"memory_write",
			);
			return { content: [{ type: "text", text: result }], details: { tag: params.tag } };
		},
	});

	// ── 命令 ────────────────────────────────────────────────

	const HELP = [
		"/remember <内容>           记一条项目记忆（--tag decision）",
		"/memory                    列出当前项目的记忆",
		"/memory status             行数 / 目标文件 / dry-run 状态",
		"/memory absorb             从本会话的压缩摘要提炼",
		"/memory prune              超限时把最旧条目剪进归档",
		"/memory pending            查看待确认队列",
		"/memory flush              立即弹框确实（不等任务结束）",
		"/memory archive            查看归档文件概况",
		"/memory recall <关键词>    在记忆与归档里搜",
		"/memory dryrun on|off      切换 dry-run",
		"/memory help",
	].join("\n");

	function statusText(ctx: ExtensionContext): string {
		const target = resolveTarget(ctx.cwd);
		const section = readMemory(target.file);
		const n = entryLines(section.entries);
		const lines = [
			`dry-run   : ${config.dryRun ? "开（只预览不写入）" : "关（会真实写入）"}`,
			`软上限    : ${config.softLimit} 行`,
			`当前项目  : ${ctx.cwd}`,
			`热记忆    : ${target.file}`,
			`            ${section.exists ? (section.hasSection ? "已存在记忆节" : "文件存在但无记忆节（首次写入时自动追加）") : "文件不存在（首次写入时自动创建）"}`,
			`            条目 ${section.entries.length} 条 / ${n} 行${n > config.softLimit ? "  ⚠ 超软上限，建议 /memory prune" : ""}`,
			`冷归档    : ${target.archive} ${fs.existsSync(target.archive) ? `(${sizeText(target.archive)})` : "(尚未创建)"}`,
			"",
			`本扩展只管项目层。全局偏好请手写 ${path.join(AGENT_DIR, "AGENTS.md")}`,
			"（pi 原生加载，不需要扩展参与）",
		];
		return lines.join("\n");
	}

	async function doList(ctx: ExtensionCommandContext): Promise<void> {
		const target = resolveTarget(ctx.cwd);
		const section = readMemory(target.file);

		if (!section.exists) {
			ctx.ui.notify(`pi-memory: ${target.file} 还不存在\n先用 /remember 记一条试试`, "info");
			return;
		}
		if (section.entries.length === 0) {
			ctx.ui.notify(`pi-memory: ${target.file} 里还没有记忆条目`, "info");
			return;
		}

		const rows = section.entries.map((e, i) => {
			const head = `${String(i + 1).padStart(2, "0")}  [${e.tag}] ${e.text.slice(0, 60)}`;
			const extra = e.extra.length ? `  (+${e.extra.length} 行)` : "";
			return head + extra;
		});
		rows.push(`${String(section.entries.length + 1).padStart(2, "0")}  ← 关闭`);

		const n = entryLines(section.entries);
		const choice = await ctx.ui.select(
			`${target.heading} — ${section.entries.length} 条 / ${n} 行 / 上限 ${config.softLimit}`,
			rows,
		);
		if (!choice) return;

		const idx = Number.parseInt(choice.slice(0, 2), 10) - 1;
		const entry = section.entries[idx];
		if (!entry) return;

		const body = renderEntry(entry).join("\n");
		const action = await ctx.ui.select(body.slice(0, 70), ["查看完整内容", "移到归档", "删除", "取消"]);
		if (!action || action === "取消") return;

		if (action === "查看完整内容") {
			ctx.ui.notify(`[${entry.tag}] ${entry.text}${entry.extra.length ? `\n\n${entry.extra.join("\n")}` : ""}`, "info");
			return;
		}

		if (config.dryRun) {
			ctx.ui.notify(`[DRY RUN] 本应${action === "删除" ? "删除" : "归档"}：\n${body}`, "warning");
			return;
		}
		const ok = await ctx.ui.confirm(`${action}这一条？`, body);
		if (!ok) return;

		const res = await transact(target, {
			removes: [entry.text],
			archiveRemoved: action === "移到归档",
		});
		if (!res.ok) {
			ctx.ui.notify(`pi-memory: ${res.reason}`, "error");
			return;
		}
		ctx.ui.notify(
			`pi-memory: 已${action === "删除" ? "删除" : "归档"} 1 条（余 ${entryLines(res.kept)} 行）`,
			"info",
		);
		updateStatus(ctx);
	}

	async function doPrune(ctx: ExtensionCommandContext): Promise<void> {
		const target = resolveTarget(ctx.cwd);
		const section = readMemory(target.file);
		const n = entryLines(section.entries);

		if (n <= config.softLimit) {
			ctx.ui.notify(`pi-memory: ${n} 行，未超软上限 ${config.softLimit}，无需裁剪`, "info");
			return;
		}

		const keepTarget = Math.floor(config.softLimit * 0.8);
		const next = [...section.entries];
		const moved: MemEntry[] = [];
		while (next.length > 1 && entryLines(next) > keepTarget) {
			const oldest = next.shift();
			if (oldest) moved.push(oldest);
		}

		const preview = [
			"将移入归档（不删除）：",
			...moved.flatMap((e) => renderEntry(e).map((l) => `  ${l}`)),
			"",
			`归档文件：${target.archive}`,
			`记忆区：${n} 行 → ${entryLines(next)} 行`,
		].join("\n");

		if (config.dryRun) {
			ctx.ui.notify(`[DRY RUN]\n\n${preview}`, "warning");
			return;
		}
		const ok = await ctx.ui.confirm("裁剪记忆区？", preview);
		if (!ok) return;

		const result = await transact(target, {});
		if (!result.ok) {
			ctx.ui.notify(`pi-memory: ${result.reason}`, "error");
			return;
		}
		ctx.ui.notify(
			`pi-memory: 已把 ${result.moved} 条移入归档，记忆区回到 ${entryLines(result.kept)} 行`,
			"info",
		);
		updateStatus(ctx);
	}

	/** 从 compaction 摘要里提取持久部分 */
	function extractFromSummary(summary: string): { tag: string; text: string }[] {
		const out: { tag: string; text: string }[] = [];
		const sectionTag: Record<string, string> = {
			"key decisions": "decision",
			"critical context": "context",
			"constraints & preferences": "preference",
		};

		let current: string | null = null;
		for (const raw of summary.split(/\r?\n/)) {
			const line = raw.trim();
			const h = line.match(/^##\s+(.+)$/);
			if (h) {
				const key = h[1].trim().toLowerCase();
				current = sectionTag[key] ?? null;
				continue;
			}
			if (!current) continue;
			const b = line.match(/^[-*]\s+(.*)$/);
			if (!b) continue;
			const text = b[1].replace(/^\[[ x]\]\s*/i, "").replace(/\*\*/g, "").trim();
			if (text.length < 4) continue; // 过滤 "- [x]" 这类空壳
			out.push({ tag: current, text });
		}
		return out;
	}

	async function doAbsorb(ctx: ExtensionCommandContext): Promise<void> {
		const blocked = projectGate(ctx.cwd);
		if (blocked) {
			ctx.ui.notify(blocked, "warning");
			return;
		}

		const summaries = ctx.sessionManager
			.getEntries()
			.filter((e) => e.type === "compaction")
			.map((e) => (e as { summary: string }).summary)
			.filter((s) => typeof s === "string" && s.length > 0);

		if (summaries.length === 0) {
			ctx.ui.notify(
				"pi-memory: 本会话还没有压缩摘要。\n摘要只在上下文超过阈值时自动产生，或手动 /compact 触发。\n短会话可以直接 /remember 记。",
				"info",
			);
			return;
		}

		const candidates = extractFromSummary(summaries[summaries.length - 1]);
		if (candidates.length === 0) {
			ctx.ui.notify("pi-memory: 最近的摘要里没有可提炼的段落（Key Decisions / Critical Context / Constraints）", "info");
			return;
		}

		// 目标固定为当前 cwd 的项目层（门禁已在入口拦住非项目目录）
		const groups: { target: Target; items: { tag: string; text: string }[] }[] = [];
		groups.push({ target: resolveTarget(ctx.cwd), items: candidates });

		const preview = [
			`来源：最近一次 compaction 摘要（共 ${summaries.length} 份）`,
			"",
			...groups.flatMap((g) => [
				`▶ ${g.target.heading}（${g.target.note}）→ ${g.target.file}`,
				...g.items.flatMap((c) => renderEntry({ tag: c.tag, text: c.text, extra: [] }).map((l) => `  ${l}`)),
				"",
			]),
		].join("\n");

		if (config.dryRun) {
			ctx.ui.notify(`[DRY RUN]\n\n${preview}`, "warning");
			return;
		}
		const ok = await ctx.ui.confirm(`吸收 ${candidates.length} 条到记忆？`, preview);
		if (!ok) return;

		const report: string[] = [];
		for (const group of groups) {
			const res = await transact(group.target, {
				adds: group.items.map((c) => ({ tag: c.tag, text: c.text, extra: [] })),
			});
			report.push(
				res.ok
					? `${group.target.heading}: +${group.items.length}${res.moved ? ` · 归档 ${res.moved}` : ""} → ${entryLines(res.kept)} 行`
					: `✗ ${group.target.heading} — ${res.reason}`,
			);
		}

		pendingAbsorb = 0;
		ctx.ui.notify(`pi-memory: 已吸收 ${candidates.length} 条\n${report.join("\n")}`, "info");
	}

	function doRecall(ctx: ExtensionContext, keyword: string): void {
		if (!keyword) {
			ctx.ui.notify("用法：/memory recall <关键词>", "warning");
			return;
		}
		const target = resolveTarget(ctx.cwd);
		const needle = keyword.toLowerCase();
		const hits: string[] = [];

		const scan = (file: string, label: string) => {
			const content = readFileSafe(file);
			if (!content) return;
			content.split(/\r?\n/).forEach((line, i) => {
				if (line.toLowerCase().includes(needle)) {
					hits.push(`${label}:${i + 1}  ${line.trim().slice(0, 110)}`);
				}
			});
		};
		scan(target.file, "热记忆");
		scan(target.archive, "归档");
		scan(path.join(AGENT_DIR, "AGENTS.md"), "全局");
		scan(path.join(AGENT_DIR, "memory-archive.md"), "全局归档");

		if (hits.length === 0) {
			ctx.ui.notify(`pi-memory: 记忆里没找到「${keyword}」\n（如需搜原始对话，用 grep 搜 ~/.pi/agent/sessions/）`, "info");
			return;
		}
		ctx.ui.notify(`命中 ${hits.length} 处：\n${hits.slice(0, 20).join("\n")}`, "info");
	}

	function doArchive(ctx: ExtensionContext): void {
		const target = resolveTarget(ctx.cwd);
		if (!fs.existsSync(target.archive)) {
			ctx.ui.notify(`pi-memory: 还没有归档文件\n${target.archive}`, "info");
			return;
		}
		const content = readFileSafe(target.archive);
		const heads = content
			.split(/\r?\n/)
			.filter((l) => l.startsWith("## "))
			.slice(-8);
		ctx.ui.notify(
			[
				`归档：${target.archive}`,
				`大小：${sizeText(target.archive)}`,
				"",
				...heads,
				"",
				"（用 /memory recall <关键词> 搜内容，或直接 read 该文件）",
			].join("\n"),
			"info",
		);
	}

	pi.registerCommand("remember", {
		description: "记一条项目记忆（--tag decision）",
		handler: async (args, ctx) => {
			let tag = "note";
			const rest: string[] = [];

			for (const token of args.trim().split(/\s+/)) {
				if (token.startsWith("--tag=")) tag = token.slice(6);
				else if (token === "--decision") tag = "decision";
				else if (token === "--pitfall") tag = "pitfall";
				else if (token === "--preference") tag = "preference";
				else if (token) rest.push(token);
			}

			const text = rest.join(" ").trim();
			if (!text) {
				ctx.ui.notify(`用法：/remember [--tag decision] <内容>\n\n${HELP}`, "warning");
				return;
			}

			const msg = stageWrite(ctx, { text, tag }, "/remember");
			ctx.ui.notify(msg, projectGate(ctx.cwd) ? "warning" : "info");
			// 用户主动发起，且当前空闲 → 立即确认，不必等到下一个任务结束
			await flushPending(ctx);
		},
	});

	pi.registerCommand("memory", {
		description: "查看 / 整理长期记忆",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "list", "absorb", "prune", "archive", "recall", "dryrun", "help"];
			const filtered = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			const arg = rest.join(" ").trim();

			switch (sub) {
				case "":
				case "list": {
					await doList(ctx);
					return;
				}
				case "status": {
					updateStatus(ctx);
					ctx.ui.notify(statusText(ctx), "info");
					return;
				}
				case "absorb": {
					await doAbsorb(ctx);
					return;
				}
				case "prune": {
					await doPrune(ctx);
					return;
				}
				case "pending": {
					if (pending.length === 0) {
						ctx.ui.notify("pi-memory: 待确认队列为空", "info");
						return;
					}
					const lines = pending.flatMap((s, i) => {
						const target = resolveTarget(s.cwd);
						return [
							`${String(i + 1).padStart(2, "0")}  [${s.tag}] ${s.text.split(/\r?\n/)[0].slice(0, 60)}`,
							`     → ${target.heading} · 来源 ${s.source}`,
						];
					});
					ctx.ui.notify(`待确认 ${pending.length} 条：\n${lines.join("\n")}\n\n任务结束后会自动弹框，或 /memory flush 立即处理`, "info");
					return;
				}
				case "flush": {
					const wrote = await flushPending(ctx, { force: true });
					if (!wrote) ctx.ui.notify("pi-memory: 队列为空或已处理完毕", "info");
					return;
				}
				case "archive": {
					doArchive(ctx);
					return;
				}
				case "recall": {
					doRecall(ctx, arg);
					return;
				}
				case "dryrun": {
					if (arg === "on") config.dryRun = true;
					else if (arg === "off") config.dryRun = false;
					else {
						ctx.ui.notify(`dry-run 当前：${config.dryRun ? "开" : "关"}。用法 /memory dryrun on|off`, "info");
						return;
					}
					saveConfig(config);
					ctx.ui.notify(
						config.dryRun
							? "pi-memory: dry-run 已开启，只预览不写入"
							: "pi-memory: dry-run 已关闭 —— 之后会真实写入 AGENTS.md",
						config.dryRun ? "info" : "warning",
					);
					return;
				}
				default: {
					ctx.ui.notify(HELP, "info");
					return;
				}
			}
		},
	});
}
