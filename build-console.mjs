/**
 * 从 console.src.html 生成 worker.js 中内联的控制台 HTML。
 *
 * 背景：控制台页面需要内联进 worker.js（Cloudflare 那种「复制粘贴一个文件」的
 * 部署方式要求单文件、无外部依赖）。但直接把 200 多行 HTML/JS 写在模板字符串里
 * 难以编辑和校验，所以拆成独立文件维护，由本脚本注入。
 *
 * 用法：node build-console.mjs
 *       （改了 console.src.html 之后运行，然后重新构建/部署）
 *
 * 转义规则（模板字符串安全）：
 *   \  -> \\      反斜杠
 *   `  -> \`      反引号
 *   ${ -> \${     插值起始（否则会被外层模板当成变量插值）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const srcPath = join(root, "console.src.html");
const workerPath = join(root, "worker.js");

const html = readFileSync(srcPath, "utf8");

// 顺序很重要：先转义反斜杠，再处理反引号与插值
const escaped = html
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const worker = readFileSync(workerPath, "utf8");
const START = "// #region console-html";
const END = "// #endregion console-html";
const sIdx = worker.indexOf(START);
const eIdx = worker.indexOf(END);

if (sIdx < 0 || eIdx < 0 || eIdx < sIdx) {
  console.error("❌ 在 worker.js 中找不到 // #region console-html … // #endregion console-html 标记块。");
  console.error("   请保留这两个标记（控制台 HTML 由它们定位并替换）。");
  process.exit(1);
}

const block =
  START + "\n" +
  "// ⚠️ 本块由 build-console.mjs 从 console.src.html 生成，请勿手改。\n" +
  "//    要改控制台请编辑 console.src.html，然后运行：node build-console.mjs\n" +
  "const CONSOLE_HTML = `" + escaped + "`;\n" +
  END;

const out = worker.slice(0, sIdx) + block + worker.slice(eIdx + END.length);
writeFileSync(workerPath, out, "utf8");

console.log("✅ 已把 console.src.html 注入 worker.js");
console.log("   源 HTML：" + html.split("\n").length + " 行 / " + html.length + " 字符");
console.log("   转义后：" + escaped.length + " 字符");
console.log("   请接着运行 node build-vercel.mjs 同步 api/index.js");
