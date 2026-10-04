/**
 * 本地运行入口（不部署也能跑）
 *
 * 用法：
 *   1. 在项目根目录的 .env.local 里填 CLINE_REFRESH_TOKEN（和可选的 API_KEY）
 *   2. node local-server.js
 *   3. 浏览器/curl 访问 http://localhost:8787
 *
 * 原理：把 Node 的 http 请求转成 Web Request 交给 worker.js 的 fetch 处理器，
 *       响应再转回 Node http（支持 SSE 流式透传）。生产代码 worker.js 不做任何改动。
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync, renameSync, unlinkSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 端口用let：默认 8787 被占用时，EADDRINUSE 处理里会自动往后找空闲端口
// （仅当用户没显式设 PORT 时才这么做，见 server.on("error") 的说明）。
let PORT = Number(process.env.PORT || 8787);
let triedPorts = 0;

/**
 * 监听地址。默认只绑回环（127.0.0.1），不要图省事绑 0.0.0.0：
 * 这个服务把自己登录过的账号额度开放给任何能访问它的人，而控制台页面会把
 * API_KEY 注入进去（本地首次运行自动生成的那个）。绑 0.0.0.0 等于把钥匙
 * 连同门一起送给同网段的人。
 *
 * 确实要让别的机器连（比如手机）时显式设 HOST=0.0.0.0，并自己配置
 * API_KEY ——此时浏览器打开控制台仍会拿到 key，请只在可信网络里这么做。
 */
const HOST = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";

// ---- 读取 .env.local（简易解析，不引依赖）----
function loadEnvLocal() {
  const file = join(__dirname, ".env.local");
  const out = {};
  if (!existsSync(file)) return out;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// 每次请求都重新读配置，这样 cline_oauth.py 写入 token 后无需重启服务
function currentEnv() {
  const fileEnv = loadEnvLocal();
  return {
    CLINE_REFRESH_TOKEN: process.env.CLINE_REFRESH_TOKEN || fileEnv.CLINE_REFRESH_TOKEN || "",
    API_KEY: process.env.API_KEY || fileEnv.API_KEY || "",
  };
}

/**
 * 本地首次运行时自动生成一个 API_KEY 并写回 .env.local，省得手填。
 * 只写本地文件（已被 .gitignore 忽略），不影响线上部署。
 * 若用户已显式设置（环境变量或文件里已有非空值），则尊重原值不动。
 */
function ensureLocalApiKey() {
  if ((process.env.API_KEY || "").trim()) {
    return { key: process.env.API_KEY.trim(), generated: false, why: "env" };
  }
  const fileEnv = loadEnvLocal();
  if ((fileEnv.API_KEY || "").trim()) {
    return { key: fileEnv.API_KEY.trim(), generated: false, why: "file" };
  }

  const key = "sk-cline-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const path = join(__dirname, ".env.local");
  let lines = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } else {
    lines = ["# 本地运行配置（.gitignore 已忽略，不会提交）", "CLINE_REFRESH_TOKEN="];
  }
  // 替换已有的空 API_KEY 行，没有就追加
  let replaced = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*API_KEY\s*=/.test(line)) {
      if (!replaced) { out.push("API_KEY=" + key); replaced = true; }
      continue;
    }
    out.push(line);
  }
  if (!replaced) out.push("API_KEY=" + key);
  writeFileSync(path, out.join("\n").replace(/\n+$/, "") + "\n", "utf8");
  return { key, generated: true, why: "generated" };
}

function countAccounts(token) {
  return String(token || "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 8).length;
}

const bootEnv = currentEnv();
const tokenCount = countAccounts(bootEnv.CLINE_REFRESH_TOKEN);
const keyInfo = ensureLocalApiKey();

console.log("=".repeat(64));
console.log("ClineFreePool 本地服务");
console.log("=".repeat(64));
console.log("CLINE_REFRESH_TOKEN :", tokenCount > 0 ? `已配置 ${tokenCount} 个账号` : `未配置 — 打开 http://localhost:${PORT} 在「账号」页登录即可`);
if (keyInfo.generated) {
  console.log("API_KEY             :", keyInfo.key);
  console.log("                      ↑ 首次运行自动生成，已写入 .env.local（无需手填）");
} else {
  console.log("API_KEY             :", keyInfo.key, keyInfo.why === "env" ? "(来自环境变量)" : "(来自 .env.local)");
}
console.log("监听地址            : http://" + (HOST === "0.0.0.0" ? "localhost" : HOST) + ":" + PORT +
  (HOST === "0.0.0.0" ? "  ⚠ 已绑所有网卡，同网段的人都能访问并拿到页面里的 API_KEY" : "  （仅本机可访问）"));
console.log("-".repeat(64));
console.log("端点：");
console.log(`  GET  http://localhost:${PORT}/           控制台（浏览器打开）`);
console.log(`  GET  http://localhost:${PORT}/v1/health`);
console.log(`  GET  http://localhost:${PORT}/v1/models`);
console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
console.log(`  POST http://localhost:${PORT}/v1/messages      (Anthropic 格式)`);
console.log("=".repeat(64));

// 落盘目录：放用户主目录而不是项目目录，避免误提交（.gitignore 里 *.local 也能挡，
// 但多一层保险不亏）。两个文件都不大。
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || __dirname;
console.log("设置与账号存盘：" + join(HOME_DIR, ".ClineFreePool-state.local.json"));

/**
 * Token 统计的本地持久化。
 *
 * worker.js 本身不碰文件系统（Cloudflare / Vercel 上没有可写磁盘，强上 KV/D1 会
 * 破坏"单文件复制粘贴即可部署"的定位），它只暴露 globalThis.__clineUsage 这几个
 * 钩子；由本地服务负责落盘，重启后统计不丢。
 *
 * 放在 USERPROFILE / HOME 而不是项目目录，是为了避免误提交 —— 虽然 .gitignore 里
 * 的 *.local 已经能挡住，但多一层保险不亏。文件很小（几十 KB 上限）。
 */
const USAGE_FILE = join(HOME_DIR, ".ClineFreePool-usage.local.json");

function loadUsageSnapshot() {
  try {
    if (!existsSync(USAGE_FILE)) return null;
    const txt = readFileSync(USAGE_FILE, "utf8");
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    console.error("[usage] 读取统计文件失败，从零开始：", String(e.message || e).slice(0, 120));
    return null;
  }
}

function saveUsageSnapshot(snap) {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(snap), "utf8");
  } catch (e) {
    console.error("[usage] 写入统计文件失败：", String(e.message || e).slice(0, 120));
  }
}

/**
 * 设置与账号池的本地持久化。
 *
 * worker.js 本身不碰文件系统（Cloudflare / Vercel 上没有可写磁盘，强上 KV/D1 会
 * 破坏"单文件复制粘贴即可部署"的定位），它只暴露 globalThis.__clineState 这几个
 * 钩子；由本地服务负责落盘，所以控制台里改的设置、登录的账号、上游轮换过的
 * refreshToken 重启都不丢。
 *
 * 放在 USERPROFILE / HOME 而不是项目目录，是为了避免误提交 —— 虽然 .gitignore 里
 * 的 *.local 已经能挡住，但多一层保险不亏。文件里含 refreshToken，权限收到 0600。
 */
const STATE_FILE = join(HOME_DIR, ".ClineFreePool-state.local.json");

/**
 * 原子写：先写临时文件再 rename。
 *
 * 不能直接 writeFileSync 覆盖：进程若在截断之后、写入完成之前被杀，会留下一个
 * 0 字节文件——而状态文件里是用户的 refreshToken，读不出来等于账号全丢。
 * rename 在同一文件系统内是原子的，写一半崩溃只会留下一个无人引用的 .tmp。
 */
function atomicWrite(file, text) {
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (e) {
    // 某些文件系统/Windows 上 rename 会被占用挡住。退一步用「先写后截断」：
    // 中途被杀最坏是「新内容 + 旧内容尾巴」，解析必然失败 → 按损坏处理并留副本，
    // 而不是像 O_TRUNC 那样直接把文件清空。
    writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    try { unlinkSync(tmp); } catch (e2) { /* 临时文件残留无害 */ }
  }
}

function loadStateSnapshot() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const txt = readFileSync(STATE_FILE, "utf8");
    const obj = JSON.parse(txt);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    // 解析失败：留一份副本再从头开始。
    // 不留副本的话，下一次保存就把用户唯一的 refreshToken 覆盖掉了。
    console.error("[state] 读取设置文件失败，从零开始：", String(e.message || e).slice(0, 160));
    try {
      const backup = STATE_FILE + ".corrupt-" + Date.now();
      copyFileSync(STATE_FILE, backup);
      console.error("[state] 原文件已备份到 " + backup);
    } catch (e2) {
      console.error("[state] 副本也留不下来，本次不覆盖原文件：", String(e2.message || e2).slice(0, 120));
    }
    return null;
  }
}

function saveStateSnapshot(snap) {
  try {
    atomicWrite(STATE_FILE, JSON.stringify(snap, null, 2));
  } catch (e) {
    console.error("[state] 写入设置文件失败：", String(e.message || e).slice(0, 160));
  }
}

/** 把持久化钩子接到当前 worker 模块上，并装回上次的设置。
 *  ⚠️ 顺序很关键：worker.js 在模块顶层会重设 globalThis.__clineState，所以
 *  新版一导入，全局引用就指向新实例了。旧实例的改动必须先冲刷出去，
 *  否则热重载会把上次写盘之后的改动悄悄丢掉。
 *  也因此这里不用 globalThis 上的引用去冲旧实例，而是调用方传来的 prevApi。 */
function attachStatePersistence(prevApi) {
  const api = globalThis.__clineState;
  if (!api) return false;
  if (prevApi && prevApi !== api) {
    try { prevApi.flushStateNow(); } catch (e) { /* 旧实例冲刷失败无补救手段 */ }
  }
  api.setStatePersistence(saveStateSnapshot);
  const snap = loadStateSnapshot();
  if (snap) api.restoreState(snap);
  return true;
}

/** 把 token 统计的持久化钩子接到当前 worker 模块上，并装回上次的统计。
 *  ⚠️ 顺序同样关键：旧实例的计数必须先冲刷出去（见 attachStatePersistence）。 */
function attachUsagePersistence(prevApi) {
  const api = globalThis.__clineUsage;
  if (!api) return false;
  if (prevApi && prevApi !== api) {
    try { prevApi.flushUsageNow(); } catch (e) {}
  }
  api.setUsagePersistence(saveUsageSnapshot);
  const snap = loadUsageSnapshot();
  if (snap) api.restoreUsage(snap);
  return true;
}

/**
 * 加载 worker.js，并在文件变化时自动重新加载。
 * 背景：Node 会缓存 ESM 导入，改完 worker.js（尤其是跑过 build-console.mjs
 * 重新生成内联 HTML 之后）如果只重启不够或忘了重启，服务会继续返回旧页面，
 * 排查时极易误判成"改动没生效"。这里用 mtime 轮询 + 带时间戳的动态导入实现热重载。
 */
let worker = null;
let workerMtime = 0;
let reloads = 0;
const workerPath = join(__dirname, "worker.js");

async function getWorker() {
  try {
    const mtime = statSync(workerPath).mtimeMs;
    if (!worker || mtime !== workerMtime) {
      // 先记下旧实例的句柄：新模块顶层会把 globalThis.__cline* 覆盖掉
      const prevUsageApi = globalThis.__clineUsage;
      const prevStateApi = globalThis.__clineState;
      // 用 query 参数绕开 ESM 模块缓存
      const mod = await import("./worker.js?t=" + mtime);
      worker = mod.default;
      workerMtime = mtime;
      reloads++;
      attachStatePersistence(prevStateApi);
      attachUsagePersistence(prevUsageApi);
      if (reloads > 1) console.log(`[hot-reload] worker.js 已更新，已重新加载（第 ${reloads - 1} 次）`);
    }
  } catch (e) {
    if (!worker) throw e;
    console.error("[hot-reload] 重新加载失败，继续用上一版：", String(e.message || e).slice(0, 160));
  }
  return worker;
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const url = "http://localhost:" + PORT + req.url;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => headers.append(k, item));
    else headers.set(k, v);
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });

  try {
    const w = await getWorker();
    const resp = await w.fetch(request, currentEnv());

    // 本地便利：把自动生成的 API_KEY 注入控制台页面，省得手填。
    // 仅在本地开发服务器生效，线上 Worker 不会注入。
    const ctype = resp.headers.get("content-type") || "";
    if (req.method === "GET" && ctype.includes("text/html")) {
      let html = await resp.text();
      const inject =
        "<script>window.__CLINE2API__={key:" + JSON.stringify(keyInfo.key) + "};</script>\n";
      html = html.includes("</head>")
        ? html.replace("</head>", inject + "</head>")
        : inject + html;
      const headers = Object.fromEntries(resp.headers);
      headers["content-length"] = String(Buffer.byteLength(html));
      res.writeHead(resp.status, headers);
      return res.end(html);
    }

    res.writeHead(resp.status, Object.fromEntries(resp.headers));
    if (!resp.body) return res.end();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // 流式响应立即 flush，保证 SSE 逐块到达（不被 Node 缓冲吞掉）
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    console.error("[local-server] 处理异常:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(err && err.message || err), type: "local_server_error" } }));
  }
});

server.listen(PORT, HOST, () => {
  // 启动时就把 worker 载进来：一是让设置与统计文件立刻被读取（控制台首屏就有数），
  // 二是提前暴露语法错误，而不是等到第一个请求才报
  getWorker().then(() => {
    console.log(`\n✅ 服务已启动，按 Ctrl+C 停止\n`);
  }).catch((e) => {
    console.error("\n❌ worker.js 加载失败：", String(e.message || e));
    console.error("   修好后再访问页面；本进程会继续监听，改动会自动重载。\n");
  });
});

// 端口被占用时的处理。
//
//默认行为（与上游一致）：打印一句能照做的话然后退出，不静默换端口——
// 静默换端口会让用户以为打开的是原端口，反而更难排查。
//
// 但当 PORT 是**默认值** 8787 时例外：8787 是极常见的端口（macOS 上常被 php
// 进程占着，Windows 上也常撞），而这个项目又常被 AI 助手自动化部署——
// 撞上端口后进程直接退出，AI 就得反复重试。���这种情况自动往后找一个空端口，
// 并明确告知最终用了哪个，避免"服务没起来"的误判。
const AUTO_FALLBACK_MAX = 20;   // 最多往后试20 个端口

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    if (!process.env.PORT && triedPorts < AUTO_FALLBACK_MAX) {
      const next = PORT + 1 + triedPorts;
      triedPorts += 1;
      console.warn("⚠️  端口 " + PORT + " 已被占用（未被显式指定 PORT，自动改用 " + next + "）");
      console.warn("   如需指定端口：PORT=8790 node start.mjs\n");
      PORT = next;
      server.listen(PORT, HOST);
      return;
    }
    console.error("\n❌ 端口 " + PORT + " 已被占用。");
    console.error("   多半是上一个 ClineFreePool 窗口还开着（关掉它，或换个端口）：");
    console.error("     Windows:  set PORT=8788 && node local-server.js");
    console.error("     Linux/macOS:  PORT=8788 node local-server.js\n");
  } else if (err && err.code === "EACCES") {
    console.error("\n❌ 没有权限绑定 " + HOST + ":" + PORT + "（端口 <1024 需要管理员/root）。\n");
  } else {
    console.error("\n❌ 服务启动失败：", String((err && err.message) || err) + "\n");
  }
  process.exit(1);
});

// 退出前把设置与统计冲刷到磁盘：两者都是防抖的（默认 0.8s / 1.5s），
// 否则 Ctrl+C 会丢掉最后一点改动
let flushed = false;
function flushOnExit() {
  if (flushed) return;
  flushed = true;
  try { globalThis.__clineState?.flushStateNow(); } catch (e) {}
  try { globalThis.__clineUsage?.flushUsageNow(); } catch (e) {}
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushOnExit();
    process.exit(0);
  });
}
process.on("exit", flushOnExit);
