/**
 * 测试共用工具。
 *
 * 两个职责：
 *   1. 定位本机 pi 安装目录（见 scripts/resolve-pi.mjs）
 *   2. 用 jiti 加载扩展，并**复刻 pi 运行时的 alias**
 *
 * 为什么要复刻 alias：pi 加载扩展时不走 node_modules 解析，而是
 *   pi-coding-agent/dist/core/extensions/loader.js 的 getAliases()。
 * 测试必须用同一套映射，否则测的就不是真实运行路径。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolvePiPackageDir } from "../scripts/resolve-pi.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PI_DIR = path.resolve(resolvePiPackageDir());

/** 复刻 loader.js 的 getAliases()（无 bundle 的 Node 构建走这一支） */
export function piAliases() {
	const nested = (...p) => path.join(PI_DIR, "node_modules", ...p);
	return {
		"@earendil-works/pi-coding-agent": path.join(PI_DIR, "dist/index.js"),
		"@earendil-works/pi-tui": nested("@earendil-works/pi-tui", "dist/index.js"),
		"@earendil-works/pi-ai": nested("@earendil-works/pi-ai", "dist/compat.js"),
		"@earendil-works/pi-ai/compat": nested("@earendil-works/pi-ai", "dist/compat.js"),
		typebox: nested("typebox", "build/index.mjs"),
	};
}

/** 用与 pi 相同的方式加载一个扩展，返回它的默认导出（工厂函数） */
export async function loadExtension(relPath) {
	const require = createRequire(path.join(PI_DIR, "noop.js"));
	const jitiMod = require("jiti");
	const createJiti = jitiMod.createJiti ?? jitiMod.default?.createJiti ?? jitiMod;

	const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piAliases() });
	const factory = await jiti.import(path.join(ROOT, relPath), { default: true });
	if (typeof factory !== "function") {
		throw new Error(`${relPath} 的默认导出不是函数（实际：${typeof factory}）`);
	}
	return factory;
}

/**
 * 每个测试跑在自己的临时目录里，不污染仓库也不碰真实 ~/.pi。
 *
 * 故意放在仓库内的 .tmp/（已 gitignore）而不是系统 temp：
 * pi-tasks 会把位于系统 temp 下的目录当作探测垃圾过滤掉，
 * 放系统 temp 会让夹具造的项目全部变成不可见，测不到主流程。
 */
export function makeSandbox(label) {
	const base = path.join(ROOT, ".tmp");
	fs.mkdirSync(base, { recursive: true });
	const dir = fs.mkdtempSync(path.join(base, `${label}-`));
	return {
		dir,
		path: (...p) => path.join(dir, ...p),
		cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

/** 极简断言器：打印 ✅/❌，有失败则设置退出码 */
export function makeChecker() {
	const state = { pass: 0, fail: 0 };
	const check = (label, cond, extra = "") => {
		if (cond) state.pass++;
		else {
			state.fail++;
			process.exitCode = 1;
		}
		console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? `  ${extra}` : ""}`);
	};
	const summary = () => {
		console.log(`\n${state.fail === 0 ? "✔" : "✘"} 断言：${state.pass} 通过 / ${state.fail} 失败`);
		return state.fail === 0;
	};
	return { check, summary, state };
}
