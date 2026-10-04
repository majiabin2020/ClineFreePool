#!/usr/bin/env node
/**
 * ClineFreePool 本地服务启动器（跨平台，中文提示都在这里）
 *
 * 用法：
 *   node start.mjs          直接运行
 *   start.bat               Windows：双击，或命令行运行
 *   ./start.sh              Linux / macOS
 *
 * 为什么逻辑放在 .mjs 而不是 .bat：
 *   cmd.exe 有个已知缺陷——批处理文件里出现 UTF-8 多字节字符（中文）时，
 *   它会按字节偏移逐行读取却算错位置，尤其当多字节字符位于**行尾**时，
 *   会把一行切断成两条命令，报 "xxx 不是内部或外部命令"。
 *   实测中文字符串结尾的 rem 注释必定触发。
 *   所以 .bat 只保留纯 ASCII 的几行引导，中文全部交给 Node 输出
 *   （Node 始终按 UTF-8 写 stdout，只要控制台代码页是 65001 就正常）。
 */
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const envFile = join(root, ".env.local");
const envExample = join(root, ".env.local.example");
const serverFile = join(root, "local-server.js");

console.log("================================================================");
console.log("  ClineFreePool 本地服务启动器");
console.log("================================================================");
console.log();

// ---------- 1. Node 版本 ----------
const major = Number(process.versions.node.split(".")[0]);
console.log(`[1/3] Node.js v${process.versions.node}`);
if (Number.isFinite(major) && major < 22) {
  console.log("      [提示] 版本偏低，建议升级到 22 LTS 或更高");
  console.log("             本项目的 local-server.js 依赖 Node 22+ 的 ESM 语法探测");
}

// ---------- 2. 准备 .env.local ----------
if (existsSync(envFile)) {
  console.log("[2/3] 已存在 .env.local");
} else if (existsSync(envExample)) {
  copyFileSync(envExample, envFile);
  console.log("[2/3] 已由 .env.local.example 创建 .env.local");
} else {
  console.log("[2/3] 未找到 .env.local，服务会自行创建");
}

// ---------- 3. 检查 refreshToken ----------
// 等号后至少 12 个字符才算填过值：直接判断"有内容"会把空白也当成已填。
let tokenFilled = false;
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*CLINE_REFRESH_TOKEN\s*=\s*(.*)$/);
    if (m && m[1].trim().length >= 12) { tokenFilled = true; break; }
  }
}

if (tokenFilled) {
  console.log("[3/3] 已配置 CLINE_REFRESH_TOKEN");
  console.log();
} else {
  console.log("[3/3] [提示] .env.local 里的 CLINE_REFRESH_TOKEN 还是空的");
  console.log();
  console.log("      服务照常启动。不想配 token 也能用，两种办法任选：");
  console.log();
  console.log("      【一】直接在浏览器里登录（最省事，推荐先试这个）");
  console.log("            打开 http://localhost:8787 → 「账号」页 → 「登录新账号」");
  console.log("            页面会给出授权链接，登录后账号立即可用。");
  console.log("            注意：这样登录的账号只在内存里，重启会丢；");
  console.log("            页面会把 refreshToken 显示出来，复制到下面那行即可长期保留。");
  console.log();
  console.log("      【二】跑命令行脚本，自动写入 .env.local（适合长期使用）");
  console.log("            python cline_oauth.py");
  console.log("            它会打印一个授权链接，浏览器里登录一次即可。");
  console.log();
  console.log("      手动填写的话，就是下面这一行（填完不用重启服务）：");
  console.log("        CLINE_REFRESH_TOKEN=你的token");
  console.log();
}

if (!existsSync(serverFile)) {
  console.log("[错误] 找不到 local-server.js，请确认脚本与它在同一目录。");
  process.exit(1);
}

// ---------- 启动 ----------
const child = spawn(process.execPath, [serverFile], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

child.on("error", (err) => {
  console.log();
  console.log("[错误] 无法启动服务：" + err.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  console.log();
  if (signal) {
    console.log(`[服务已停止] 收到信号 ${signal}`);
    process.exit(0);
  }
  if (code && code !== 0) {
    console.log(`[服务异常退出] 退出码：${code}`);
  } else {
    console.log("[服务已停止]");
  }
  process.exit(code ?? 0);
});

// Ctrl+C 时把信号转给子进程，由它自己收尾（避免留下占用端口的孤儿进程）
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
