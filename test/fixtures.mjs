/**
 * 测试夹具：在沙箱里造出「看起来像真项目」的会话记录。
 *
 * 用 pi 自己的 SessionManager 生成，而不是手写 JSONL —— 这样目录命名规则
 * 和文件格式一定与 pi 一致，pi 升级改了格式也不会让测试假绿。
 *
 * 注意：pi 只在会话里出现 assistant 消息后才真正落盘，
 * 所以夹具必须补一条 assistant 回复。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PI_DIR } from "./_harness.mjs";

/** 造一个项目目录；默认带 .git 让它被判定为「真项目」 */
export function makeProjectDir(dir, { git = true } = {}) {
	fs.mkdirSync(dir, { recursive: true });
	if (git) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

/**
 * 给某个 cwd 造一条会话。
 * 依赖调用方已经把 PI_CODING_AGENT_DIR 指向沙箱。
 */
export async function addSession(cwd, firstMessage, opts = {}) {
	// 动态 import：必须在调用方设好 PI_CODING_AGENT_DIR 之后才求值
	const { SessionManager } = await import(
		pathToFileURL(path.join(PI_DIR, "dist/index.js")).href
	);

	const sm = SessionManager.create(cwd);
	sm.appendMessage({ role: "user", content: firstMessage });
	sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: opts.reply ?? "（夹具回复）" }],
		provider: "fixture",
		model: "fixture-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	});
	if (opts.name && typeof sm.appendSessionInfo === "function") {
		sm.appendSessionInfo(opts.name);
	}
	return sm.getSessionFile();
}
