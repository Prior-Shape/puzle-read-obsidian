/*
 * 生成模板 vault 并打包：
 *   templates/vault/PuzleRead/{Articles,Highlights,Chats}/.gitkeep
 *   templates/vault/PuzleRead/{Articles.base,Highlights.base,README.md}
 *   dist/puzle-read-template-vault.zip
 *
 * 内容定义复用 src/vault/bases.ts 与 src/vault/scaffold.ts（buildReadme），
 * 通过 esbuild 把 "obsidian" 别名到 tests/mocks/obsidian.ts 以便在 Node 中执行。
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_FOLDER = "PuzleRead";
const templateDir = join(repoRoot, "templates", "vault");
const vaultDir = join(templateDir, ROOT_FOLDER);
const distDir = join(repoRoot, "dist");
const zipPath = join(distDir, "puzle-read-template-vault.zip");
const bundlePath = join(distDir, ".template-content.mjs");

await mkdir(distDir, { recursive: true });
await build({
	stdin: {
		contents: [
			'export { buildArticlesBase, buildHighlightsBase } from "./src/vault/bases";',
			'export { buildReadme } from "./src/vault/scaffold";'
		].join("\n"),
		resolveDir: repoRoot,
		loader: "ts"
	},
	bundle: true,
	format: "esm",
	platform: "node",
	external: ["yaml"],
	alias: { obsidian: join(repoRoot, "tests", "mocks", "obsidian.ts") },
	outfile: bundlePath
});

const { buildArticlesBase, buildHighlightsBase, buildReadme } = await import(
	pathToFileURL(bundlePath).href
);

await rm(vaultDir, { recursive: true, force: true });
for (const folder of ["Articles", "Highlights", "Chats"]) {
	await mkdir(join(vaultDir, folder), { recursive: true });
	await writeFile(join(vaultDir, folder, ".gitkeep"), "");
}
await writeFile(join(vaultDir, "Articles.base"), buildArticlesBase(ROOT_FOLDER));
await writeFile(join(vaultDir, "Highlights.base"), buildHighlightsBase(ROOT_FOLDER));
await writeFile(join(vaultDir, "README.md"), buildReadme(ROOT_FOLDER));

await rm(zipPath, { force: true });
execFileSync("zip", ["-r", "-q", zipPath, ROOT_FOLDER], { cwd: templateDir });
await rm(bundlePath, { force: true });

console.log(`模板 vault 已生成：${vaultDir}`);
console.log(`压缩包已生成：${zipPath}`);
