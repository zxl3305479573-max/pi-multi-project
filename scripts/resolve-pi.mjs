/**
 * 定位本机的 pi 安装目录。
 *
 * 被 scripts/setup-dev.mjs（建软链接）和 test/_harness.mjs（加载扩展）共用，
 * 避免两处各写一套判断。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PI_PKG = "@earendil-works/pi-coding-agent";

export function resolvePiPackageDir() {
	const tried = [];

	// 1) pi 自己支持的环境变量
	if (process.env.PI_PACKAGE_DIR) {
		tried.push(`PI_PACKAGE_DIR=${process.env.PI_PACKAGE_DIR}`);
		const asParent = path.join(process.env.PI_PACKAGE_DIR, PI_PKG);
		if (fs.existsSync(asParent)) return asParent;
		if (fs.existsSync(path.join(process.env.PI_PACKAGE_DIR, "package.json"))) {
			return process.env.PI_PACKAGE_DIR;
		}
	}

	// 2) 全局 node_modules
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
		tried.push(`npm root -g → ${globalRoot}`);
		const p = path.join(globalRoot, PI_PKG);
		if (fs.existsSync(p)) return p;
	} catch {
		tried.push("npm root -g → 执行失败");
	}

	// 3) 本仓库 node_modules 里的软链接（npm run setup 建的）
	tried.push("本仓库 node_modules（需先 npm run setup）");

	throw new Error(
		[
			"找不到 pi 的安装目录。",
			"",
			"已尝试：",
			...tried.map((t) => `  - ${t}`),
			"",
			"解法（任选其一）：",
			"  1) npm run setup          # 若 pi 已全局安装，这个就够了",
			"  2) 设置 PI_PACKAGE_DIR 指向 pi 安装位置，例如：",
			'       PowerShell: $env:PI_PACKAGE_DIR = "$env:APPDATA\\npm\\node_modules\\@earendil-works\\pi-coding-agent"',
			"  3) 确认 pi 已安装：pi --version",
		].join("\n"),
	);
}
