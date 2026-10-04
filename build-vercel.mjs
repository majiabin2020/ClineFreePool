/**
 * 从 worker.js 生成 api/index.js（Vercel Edge Function 入口）
 *
 * 背景：worker.js（Cloudflare）与 api/index.js（Vercel）逻辑完全同源，
 * 原先靠人工复制粘贴同步，容易漏改导致两端行为不一致。
 * 本脚本把 worker.js 里 `// #region entry` 标记的入口块替换成 Vercel 入口，
 * 其余逻辑原样保留，从而保证两份代码永远一致。
 *
 * 用法：node build-vercel.mjs
 *       （改了 worker.js 之后运行，然后提交 api/index.js）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const srcPath = join(root, "worker.js");
const outPath = join(root, "api", "index.js");

const src = readFileSync(srcPath, "utf8");

const START = "// #region entry";
const END = "// #endregion entry";
const startIdx = src.indexOf(START);
const endIdx = src.indexOf(END);

if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
  console.error("❌ 在 worker.js 中找不到 // #region entry … // #endregion entry 标记块。");
  console.error("   请保留这两个标记（Vercel 入口由它们定位并替换）。");
  process.exit(1);
}

const vercelEntry = `// #region entry
// ===== Vercel Edge Function 入口（本块由 build-vercel.mjs 自动生成，请勿手改）=====
// 逻辑与 Cloudflare Workers 版完全一致（同一份源码），仅入口与运行环境不同：
//   * Vercel 用 export default handler；Cloudflare 用 export default { fetch }
//   * Vercel 环境变量来自 process.env，这里转成 env 对象传给同一处理器
//   * Vercel 区域在文件内用 config 声明（美区 iad1/sfo1，可自行调整）
export const config = { runtime: "edge", regions: ["iad1", "sfo1"] };

export default async function handler(request) {
  const env = {
    CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || "",
    API_KEY: process.env.API_KEY || "",
  };
  return await handleRequest(request, env);
}
// #endregion entry`;

const out = src.slice(0, startIdx) + vercelEntry + src.slice(endIdx + END.length);

const header = `/**
 * ⚠️ 本文件由 build-vercel.mjs 从 worker.js 自动生成，请勿直接编辑！
 *    要改逻辑请改 worker.js，然后运行：node build-vercel.mjs
 */
`;

writeFileSync(outPath, header + out, "utf8");

const lines = out.split("\n").length;
console.log("✅ 已生成 api/index.js（" + lines + " 行）");
console.log("   源文件 worker.js：" + src.split("\n").length + " 行");
