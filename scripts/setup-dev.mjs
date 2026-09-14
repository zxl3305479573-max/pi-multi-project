/**
 * 开发环境准备。
 *
 * 为什么需要这个脚本：
 *   扩展里 `import ... from "@earendil-works/pi-coding-agent"` 这类导入，
 *   在 pi 运行时不走 node_modules 解析，而是由 pi 用 jiti + 一组 alias 注入
 *   （见 pi-coding-agent 的 dist/core/extensions/loader.js 里的 getAliases()）。
 *
 *   但 tsc 需要真实的模块解析。这个脚本就在本仓库的 node_modules/ 下建几个
 *   指向本机 pi 安装目录的软链接（Windows 上用 junction，不需要管理员权限）。
 *
 * 结果：tsconfig 里不需要任何机器相关的路径，仓库可以直接 clone 到任何地方。
 *
 * 用法：npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PKG, resolvePiPackageDir } from "./resolve-pi.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piDir = path.resolve(resolvePiPackageDir());
console.log(`pi 安装目录: ${piDir}`);

/** 需要在仓库 node_modules 下可见的包 → 真实目录 */
const LINKS = {
	[PI_PKG]: piDir,
	"@earendil-works/pi-tui": path.join(piDir, "node_modules/@earendil-works/pi-tui"),
	"@earendil-works/pi-ai": path.join(piDir, "node_modules/@earendil-works/pi-ai"),
	typebox: path.join(piDir, "node_modules/typebox"),
};

let created = 0;
let ready = 0;

for (const [spec, target] of Object.entries(LINKS)) {
	const linkPath = path.join(ROOT, "node_modules", ...spec.split("/"));

	if (!fs.existsSync(target)) {
		console.warn(`  ⚠ 跳过 ${spec}：目标不存在 ${target}`);
		continue;
	}

	// 已存在且指向同一目标 → 无需重建
	if (fs.existsSync(linkPath)) {
		try {
			if (path.resolve(fs.realpathSync(linkPath)) === path.resolve(fs.realpathSync(target))) {
				console.log(`  = ${spec}（已就绪）`);
				ready++;
				continue;
			}
		} catch {
			/* 坏链接，删掉重来 */
		}
		fs.rmSync(linkPath, { recursive: true, force: true });
	}

	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	// Windows 上用 junction：目标是目录，且不需要管理员权限
	fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
	console.log(`  + ${spec} → ${target}`);
	created++;
}

console.log(`\n完成：新建 ${created} 个链接，已就绪 ${ready} 个。`);
console.log("接下来可以跑：npm run check / npm test");
