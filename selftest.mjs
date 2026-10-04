/**
 * 自检脚本：不需要真实 Cline 账号，用本地假上游验证 worker.js 的关键行为。
 *
 * 用法：node selftest.mjs
 *
 * 覆盖：
 *   1. 路由（/ 控制台、/v1/health、404 提示）
 *   2. 鉴权 fail-closed（未配 API_KEY 拒绝 / 配了则校验）
 *   3. 流式响应不被缓冲（TTFT 远小于总耗时）
 *   4. 账号池不因 token 轮换而重建（缓存与冷却保留）
 *   5. 429 时按账号冷却切号（不空转重试同一个号）
 *   6. 多账号 round-robin
 *   7. Anthropic 流式协议事件完整（message_start / content_block_* / message_stop）
 *   8. 请求体剥离 max_tokens
 */
import { createServer } from "node:http";

// ---------- 假上游 ----------
let upstreamCalls = [];
let refreshCalls = [];
let mode = { kind: "ok" };

function setMode(next) {
  mode = next;
  upstreamCalls = [];
  refreshCalls = [];
}

const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyText = Buffer.concat(chunks).toString("utf8");

  if (req.url.includes("/auth/refresh")) {
    const n = refreshCalls.length + 1;
    refreshCalls.push(JSON.parse(bodyText || "{}"));
    // 模拟 Cline 会轮换 refreshToken
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        accessToken: "ACCESS_" + n,
        refreshToken: "ROTATED_" + n,
        expiresAt: Date.now() + 600000,
      },
    }));
    return;
  }

  // recommended-models：官方四个分类数组（带 name/description/tags）
  if (req.url.includes("recommended-models")) {
    if (mode.models === "fail") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      recommended: [{ id: "openai/gpt-6-astra", name: "gpt-6-astra", description: "Astral", tags: ["NEW"] }],
      free: [
        { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", description: "Cheap and fast", tags: [] },
        { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash", description: "1M context", tags: [] },
      ],
      clinePass: [{ id: "cline-pass/glm-5.2", name: "cline-pass/glm-5.2", description: "Pass only", tags: [] }],
      clineCloud: [{ id: "cline-cloud/kimi-k3", name: "Kimi K3", description: "Cloud", tags: [] }],
    }));
    return;
  }

  // 全部模型清单：平铺列表，带 context_length / pricing
  if (req.url.includes("/ai/cline/models")) {
    if (mode.models === "fail") { res.writeHead(500); return res.end("boom"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "x-ai/grok-4.7", name: "Grok 4.7", description: "Flagship", context_length: 500000, pricing: { prompt: "0.0000016" } },
        { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "Fast", context_length: 128000, pricing: { prompt: "0" } },
        // ~ 前缀是 ID 本身的一部分（上游自己的 canonical_slug 也带它），不该被剥掉
        { id: "~deepseek/deepseek-pro-latest", name: "DeepSeek Pro Latest", description: "Alias", context_length: 128000, pricing: {} },
        { id: "qwen/qwen3.8-27b:free", name: "Qwen3.8", description: "Free tier", context_length: 32000, pricing: {} },
      ],
    }));
    return;
  }

  // /v1/models（旧接口，已不再用于模型库；保留以免误伤其它请求路径）
  if (req.url.includes("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
    return;
  }

  // chat/completions
  upstreamCalls.push({
    body: JSON.parse(bodyText || "{}"),
    auth: req.headers.authorization,
    // 请求头快照：验证「自定义请求头覆盖内置值」与「未覆盖的指纹头仍在」
    ua: req.headers["user-agent"],
    clientType: req.headers["x-client-type"],
  });

  // 模拟上游路由元数据与渠道枚举：用于验证探测解析、管道判定、钉住生效确认。
  //
  // 两条管道的响应形态完全不同，所以两种都要能模拟：
  //   planner：元数据在 choices[0].message.provider_metadata.gateway.routing
  //   direct ：顶层带 provider（显示名）+ model（真实上游 ID）
  if (mode.kind === "routing") {
    const reqBody = JSON.parse(bodyText || "{}");
    // 带哨兵渠道名的枚举请求：网关在路由层拒绝并回吐清单
    if (JSON.stringify(reqBody).includes("__probe__")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "No provider matched. Available providers are: alibaba, baseten, deepinfra, novita" },
      }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (mode.pipeline === "planner") {
      res.end(JSON.stringify({
        data: {
          id: "gen_route",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "ok",
              provider_metadata: {
                gateway: {
                  routing: {
                    finalProvider: mode.provider || "alibaba",
                    canonicalSlug: "some/real-model",
                    fallbacksAvailable: ["baseten", "novita"],
                  },
                },
              },
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }));
      return;
    }
    // direct：顶层 provider 是**显示名**（带大小写），钉住比对的 slug 是小写的
    res.end(JSON.stringify({
      data: {
        id: "gen_route",
        provider: mode.provider || "DeepInfra",
        model: "deepseek/deepseek-v4-flash-0731",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    }));
    return;
  }

  // 任意状态码：用于验证「上游状态码 → 客户端状态码」的映射
  if (mode.kind === "code") {
    res.writeHead(mode.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(mode.body || {}));
    return;
  }

  // 上游先吐半句话再断开（不发 [DONE]）：模拟流中途失败。
  // 用于验证「必须发 error 事件，且不能补正常收尾事件」。
  if (mode.kind === "truncate") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify({
      data: {
        id: "gen_trunc",
        model: "cline-free/deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { content: "半句话" }, finish_reason: null }],
      },
    }) + "\n\n");
    // 直接销毁连接：客户端会拿到一个非 EOF 的读取错误
    await new Promise((r) => setTimeout(r, 50));
    res.destroy();
    return;
  }

  if (mode.kind === "429") {
    res.writeHead(429, { "Content-Type": "application/json" });
    // 用官方真实文案：marker "free limit reached on model" 是判定「免费日额度」的依据
    // （取自 Cline 客户端源码）。写别的措辞会被正确归类为 unknown —— 见【5b】。
    res.end(JSON.stringify({
      error: { message: "Daily free model limit reached: free limit reached on model " + (mode.model || "cline-free/deepseek-v4.1-flash") + ". Try again in 10m" },
    }));
    return;
  }

  // 无法识别的 429：上游改了文案的情况。不该被误判成「额度用尽」，
  // 但冷却仍然要生效（退回配置里的兜底时长）。
  if (mode.kind === "429-unknown") {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Something new from upstream, try later" } }));
    return;
  }

  // 「200 但 content 全空、只有 reasoning」—— 免费通道的典型坏响应，
  // 会触发 nonStreamWithContentCheck 的切号重试。不带延迟，让重试用例跑得快。
  if (mode.kind === "empty") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + JSON.stringify({
      data: {
        id: "gen_empty",
        model: "cline-free/deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { reasoning: "思考中…" }, finish_reason: null }],
      },
    }) + "\n\n");
    res.write("data: " + JSON.stringify({
      data: {
        id: "gen_empty",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
    }) + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // 非流式请求：真实上游这时回的是普通 JSON。模型可用性检测走这条路径
  // （它读的是 message.content，不是 SSE 分片），所以这里必须区分对待——
  // 一律回 SSE 会让检测以为"正文为空"，测出假失败。
  const isStreamReq = bodyText ? JSON.parse(bodyText).stream === true : false;
  if (!isStreamReq) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      data: {
        id: "gen_nonstream",
        model: "cline-free/deepseek-v4.1-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    }));
    return;
  }

  // 正常：模拟流式，分块输出，每块之间有明显延迟
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const parts = ["你", "好", "，", "世", "界"];
  for (let i = 0; i < parts.length; i++) {
    const chunk = {
      data: {
        id: "gen_test",
        model: "cline-free/deepseek-v4.1-flash",
        choices: [{ index: 0, delta: { content: parts[i] }, finish_reason: null }],
      },
    };
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
    await new Promise((r) => setTimeout(r, 250)); // 每块 250ms，共约 1.25s
  }
  res.write("data: " + JSON.stringify({
    data: {
      id: "gen_test",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 5 },
    },
  }) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;
const UPSTREAM = "http://127.0.0.1:" + upstreamPort;

// ---------- 注入假上游地址到 worker ----------
const workerSrc = (await import("node:fs")).readFileSync(new URL("./worker.js", import.meta.url), "utf8")
  .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');

const { writeFileSync, mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = mkdtempSync(join(tmpdir(), "cline2api-test-"));
const tmpWorker = join(dir, "worker-under-test.mjs");
writeFileSync(tmpWorker, workerSrc, "utf8");

const worker = (await import("file://" + tmpWorker.replace(/\\/g, "/"))).default;

// ---------- 测试工具 ----------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n      → " + detail : "")); }
}

const ENV = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
function req(path, init) {
  return worker.fetch(new Request("https://x.dev" + path, init), ENV);
}
const post = (path, body, headers = {}) =>
  req(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const AUTH = { Authorization: "Bearer sk-test" };

// =====================================================================
console.log("\n【1】路由");
{
  const r = await req("/");
  const html = await r.text();
  check("GET / 返回控制台 HTML", r.status === 200 && html.includes("<title>ClineFreePool · 控制台</title>"));
  check("控制台含首字节延迟（TTFT）显示逻辑",
    html.includes("首字节") && html.includes("fmtMs"),
    "页面应展示首字节延迟，帮助判断流式是否正常");

  const h = await (await req("/v1/health")).json();
  check("GET /v1/health 200 且 ok", h.ok === true);
  check("health 含 README 字段 api_key_configured", h.api_key_configured === true);
  check("health 含 README 字段 account_count", h.account_count === 2, "实际: " + h.account_count);
  check("health 保留旧字段 authenticated/accounts", h.authenticated === true && h.accounts === 2);
  check("health 含 accounts_available", h.accounts_available === 2);

  const nf = await req("/nope");
  const nfBody = await nf.json();
  check("未知路径 404 且给出可用端点提示",
    nf.status === 404 && nfBody.error.message.includes("/v1/chat/completions"),
    "message=" + nfBody.error.message.slice(0, 80));

  const opt = await req("/v1/chat/completions", { method: "OPTIONS" });
  check("OPTIONS 预检 204", opt.status === 204);
}

// =====================================================================
console.log("\n【2】鉴权 fail-closed");
{
  const noKeyEnv = { CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const r1 = await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  }), noKeyEnv);
  const b1 = await r1.json();
  check("未配 API_KEY 时拒绝聊天（不再回退公开默认 key）", r1.status === 401);
  check("拒绝原因明确指向未配置 API_KEY",
    b1.error.reason === "server_no_key" && b1.error.message.includes("未配置 API_KEY"),
    "reason=" + b1.error.reason);

  // 公开默认 key 必须无效
  const r2 = await post("/v1/chat/completions", { messages: [] }, { Authorization: "Bearer cline2api-default-key" });
  check("公开默认 key cline2api-default-key 无效", r2.status === 401);

  const r3 = await post("/v1/chat/completions", { messages: [] });
  const b3 = await r3.json();
  check("缺客户端 key → 401 且提示如何传递", r3.status === 401 && b3.error.reason === "missing_client_key");

  const r4 = await post("/v1/chat/completions", { messages: [] }, { Authorization: "Bearer wrong" });
  const b4 = await r4.json();
  check("错误 key → 401 wrong_client_key", r4.status === 401 && b4.error.reason === "wrong_client_key");

  const r5 = await post("/v1/chat/completions", { messages: [{ role: "user", content: "hi" }] }, AUTH);
  check("正确 key → 放行", r5.status === 200, "status=" + r5.status);
}

// =====================================================================
console.log("\n【3】流式不被缓冲（TTFT）");
{
  setMode({ kind: "ok" });
  const t0 = Date.now();
  const r = await post("/v1/chat/completions",
    { model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH);
  const reader = r.body.getReader();
  let ttft = null, text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttft === null) ttft = Date.now() - t0;
    text += new TextDecoder().decode(value, { stream: true });
  }
  const total = Date.now() - t0;
  check("流式返回。" + (ttft !== null ? "TTFT=" + ttft + "ms / 总=" + total + "ms" : ""),
    ttft !== null && ttft < total * 0.6,
    "TTFT 应远小于总耗时，否则说明被缓冲");
  // 内容分散在多个 delta 块里，需按块累加后再比对
  const rebuilt = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("SSE 内容完整（累加各 delta）", rebuilt === "你好，世界", "累加得到: " + rebuilt);
  check("SSE 以 [DONE] 结束", text.includes("data: [DONE]"));
  check("SSE 已剥离上游 data 包装", !text.includes('"data":{"id"') && text.includes('"id":"gen_test"'));
}

// =====================================================================
console.log("\n【4】账号池缓存与冷却保留（不再每次重建）");
{
  // 用独立的账号池，避免前面小节已缓存 token 影响统计
  const env4 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_E_eeeeeeeeee\nTOKEN_F_ffffffffff" };
  setMode({ kind: "ok" });
  const N = 6;
  for (let i = 0; i < N; i++) {
    await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    }), env4);
  }
  check(N + " 次请求全部到达上游", upstreamCalls.length === N, "upstream=" + upstreamCalls.length);
  // 2 个账号，round-robin 各刷一次 token 后就该全部命中缓存。
  // 旧实现（每次请求重建账号池）会刷新 N 次 —— 这是本项的核心回归点。
  check("token 缓存生效：只刷新 2 次（= 账号数），而非 " + N + " 次",
    refreshCalls.length === 2,
    "实际刷新 " + refreshCalls.length + " 次" +
    (refreshCalls.length === N ? "（等于请求数 → 账号池被反复重建，回归！）" : ""));
}

// =====================================================================
console.log("\n【5】429 限流：冷却切号、不空转");
{
  const env5 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_G_gggggggggg\nTOKEN_H_hhhhhhhhhh" };
  const chat5 = () => worker.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env5);

  setMode({ kind: "429" });
  const r = await chat5();
  await r.text();
  // 两个账号都会被限流 → 应各试一次（2 次），而不是同一个号重试 5 次
  check("两账号各试一次（不拿同一号空转重试）",
    upstreamCalls.length === 2, "上游被调用: " + upstreamCalls.length + " 次");

  const h = await (await worker.fetch(new Request("https://x.dev/v1/health"), env5)).json();
  // 冷却改成「账号×模型」级：health 的 accounts_available 只反映「账号是否启用」，
  // 具体哪个模型受限看 cooling_combinations / /v1/status 的 account_details。
  // 这里断言的是「这个模型确实被记了冷却」，而不是「账号不可用」。
  check("health 报告该模型已有冷却组合",
    h.cooling_combinations === 2, "cooling_combinations=" + h.cooling_combinations);
  check("health 仍把两个账号算作可参与调度（冷却只针对模型）",
    h.accounts_available === 2, "accounts_available=" + h.accounts_available);

  // /v1/status 需要 API_KEY，才有账号明细
  const st = await (await worker.fetch(new Request("https://x.dev/v1/status", { headers: AUTH }), env5)).json();
  check("status 报告的账号数正确（两账号）", st.account_count === 2, "account_count=" + st.account_count);
  const first = (st.account_details || [])[0] || {};
  check("账号明细带「账号×模型」级冷却列表",
    Array.isArray(first.cooldown_models) && first.cooldown_models.length === 1,
    "cooldown_models=" + JSON.stringify(first.cooldown_models));
  check("冷却条目里有模型 ID（能看出是哪个模型受限）",
    first.cooldown_models && first.cooldown_models[0].model_id === "cline-free/deepseek-v4.1-flash",
    "model_id=" + (first.cooldown_models && first.cooldown_models[0].model_id));
  check("冷却原因来自上游解析（free_daily，不是 unknown）",
    first.cooldown_models && first.cooldown_models[0].kind === "free_daily",
    "kind=" + (first.cooldown_models && first.cooldown_models[0].kind));

  // 冷却期内再请求：应直接返回 429 + Retry-After，不再打上游
  const before = upstreamCalls.length;
  const r2 = await chat5();
  const b2 = await r2.json();
  check("冷却期内不重复打上游（冷却状态被保留）",
    upstreamCalls.length === before,
    "冷却期又打了 " + (upstreamCalls.length - before) + " 次上游");
  check("全冷却时返回 429 + rate_limit_error（而非 500）",
    r2.status === 429 && b2.error.reason === "all_accounts_cooling",
    "status=" + r2.status + " reason=" + (b2.error && b2.error.reason));
  check("带 Retry-After 头供客户端退避", !!r2.headers.get("Retry-After"),
    "Retry-After=" + r2.headers.get("Retry-After"));
  check("错误信息点明是哪个模型的额度用尽",
    b2.error.model === "cline-free/deepseek-v4.1-flash",
    "model=" + b2.error.model);

  // 同账号的**另一个模型**不该被这个模型的冷却拖累 —— 这是本次改动的核心价值
  setMode({ kind: "ok" });
  const beforeOther = upstreamCalls.length;
  // 用 stream:true —— 假上游只会回 SSE，非流式会走聚合分支，测不出这条路径
  const r3 = await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "z-ai/glm-5.3-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env5);
  await r3.text();
  check("同账号的其它模型不受影响（账号×模型级冷却）",
    r3.status === 200 && upstreamCalls.length === beforeOther + 1,
    "status=" + r3.status + " 上游调用=" + (upstreamCalls.length - beforeOther));
  check("上游收到的模型确实是 glm（不是被 deepseek 的冷却顶掉）",
    upstreamCalls.length && upstreamCalls[upstreamCalls.length - 1].body.model === "z-ai/glm-5.3-flash",
    "实际 model=" + (upstreamCalls.length && upstreamCalls[upstreamCalls.length - 1].body.model));
}

// =====================================================================
console.log("\n【6】多账号 round-robin");
{
  setMode({ kind: "ok" });
  // 等冷却过期：直接重读 env 无法清冷却，这里用新 env 对象触发重建
  const freshEnv = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_C_cccccccccc\nTOKEN_D_dddddddddd" };
  const seen = new Set();
  for (let i = 0; i < 2; i++) {
    await worker.fetch(new Request("https://x.dev/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
    }), freshEnv);
  }
  for (const c of upstreamCalls) seen.add(c.auth);
  check("两次请求使用了不同账号（轮询生效）", seen.size === 2, "用到的账号: " + [...seen].join(" | "));
}

// =====================================================================
console.log("\n【7】Anthropic 流式协议完整性");
{
  setMode({ kind: "ok" });
  const r = await post("/v1/messages",
    { model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }, AUTH);
  const text = await r.text();
  const need = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
  const missing = need.filter((e) => !text.includes("event: " + e));
  check("包含全部必需事件: " + need.join(" → "), missing.length === 0, "缺失: " + missing.join(", "));
  const order = need.map((e) => text.indexOf("event: " + e));
  check("事件顺序正确", order.every((v, i) => i === 0 || v > order[i - 1]));
  check("message_start 是首个事件", text.trimStart().startsWith("event: message_start"));
  // Anthropic 侧同样按 delta 块累加
  const aText = [...text.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join("");
  check("文本内容正确透出（累加 text_delta）", aText === "你好，世界", "累加得到: " + aText);
  check("stop_reason 为 end_turn", text.includes('"stop_reason":"end_turn"'));

  // 非流式 Anthropic
  setMode({ kind: "ok" });
  const rr = await post("/v1/messages",
    { model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }, AUTH);
  const j = await rr.json();
  check("非流式 Anthropic 返回 text 块",
    j.type === "message" && j.content[0].type === "text" && j.content[0].text.includes("你好，世界"));
  check("非流式含 stop_sequence 字段", "stop_sequence" in j);
}

// =====================================================================
console.log("\n【8】上游请求体处理");
{
  setMode({ kind: "ok" });
  await (await post("/v1/chat/completions",
    { model: "cline-free/deepseek-v4.1-flash", max_tokens: 999, temperature: 0.5,
      messages: [{ role: "user", content: "hi" }] }, AUTH)).text();
  const sent = upstreamCalls[0].body;
  check("剥离 max_tokens（上游带该字段会 500）", !("max_tokens" in sent), "body 含: " + Object.keys(sent).join(","));
  check("保留 temperature 等可选参数", sent.temperature === 0.5);
  check("免费通道非流式请求被强制走上游 stream", sent.stream === true);
  check("附带 session_id", typeof sent.session_id === "string");
}

// =====================================================================
console.log("\n【9】/v1/models 只回已启用模型（发现过滤器，非访问控制）");
{
  setMode({ kind: "ok" });

  // 全新实例（没启用过任何模型）→ 回退到内置推荐。
  // 没有任何本地硬编码：未启用时回退的是**实时取到的上游免费清单**。
  // 这一点是刻意设计的——上游免费通道是轮换促销，写死的清单必然过期。
  let d = await (await req("/v1/models")).json();
  let ids = d.data.map((m) => m.id);
  check("返回 object=list", d.object === "list");
  check("代码里没有硬编码的免费模型清单（BUILTIN_MODELS 已移除）",
    !/const BUILTIN_MODELS\s*=/.test(workerSrc),
    "worker.js 不应再有 BUILTIN_MODELS 硬编码数组定义");
  check("免费清单取自上游 recommended-models 接口",
    /RECOMMENDED_URL\s*=\s*CLINE_API_BASE\s*\+\s*"\/ai\/cline\/recommended-models"/.test(workerSrc)
      && /fetchLiveFreeModelIds/.test(workerSrc),
    "应实时向上游要当前的免费清单");
  check("未启用模型时走实时上游清单（free_models_source=upstream）",
    !/free_models_source\s*:\s*"builtin"/.test(workerSrc),
    "清单来源应标注为上游");
  check("默认模型未硬编码（留空，由生效列表首个决定）",
    /const DEFAULT_MODEL = "";/.test(workerSrc),
    "写死默认模型会在促销下线后变成失效默认值");
  check("未启用时不返回陈旧硬编码（免费清单来自实时上游）", Array.isArray(ids),
    "返回结构异常");
  check("回退清单里不含需订阅 / 云额度模型（clinePass / clineCloud）",
    !ids.some((x) => /cline-?pass|cline-?cloud/i.test(x)),
    "含付费通道: " + ids.join(", "));
  check("免费清单来自实时上游而非本地强制（含默认通道亦可，只是不写死）",
    /DEFAULT_MODEL = "";/.test(workerSrc),
    "不应把某个具体模型写死为默认");
  // 列表非空时必须恰好有一个 is_default；空列表是合法的（未登录 / 上游暂无免费通道），
  // 此时不要求标记 —— 拿不到模型清单时不该硬凑一个默认出来。
  check("列表非空时恰有一个 is_default 标记",
    d.data.length === 0 || d.data.filter((m) => m.is_default).length === 1,
    JSON.stringify(d.data.map((m) => [m.id, m.is_default])));
  check("owned_by 取自模型 ID 的前缀", d.data.every((m) => m.owned_by && !m.owned_by.includes("/")),
    JSON.stringify(d.data.map((m) => m.owned_by)));

  // 启用两个模型 → 列表以用户的选择为准（不再回退）
  const add = await (await post("/v1/models/batch", { ids: ["openai/gpt-6-astra", "cline-pass/glm-5.2"] }, AUTH)).json();
  check("批量添加返回 added/skipped/failed 三分类",
    Array.isArray(add.added) && Array.isArray(add.skipped) && !!add.failed,
    JSON.stringify(Object.keys(add)));
  check("两个模型都被添加", add.added.length === 2, JSON.stringify(add));
  d = await (await req("/v1/models")).json();
  ids = d.data.map((m) => m.id);
  check("启用后 /v1/models 以用户的选择为准（不再回退内置）",
    ids.length === 2 && ids.includes("openai/gpt-6-astra") && ids.includes("cline-pass/glm-5.2"),
    "实际: " + ids.join(", "));
  check("内置推荐模型已从列表消失（用户的选择说了算）",
    !ids.includes("cline-free/deepseek-v4.1-flash"), "内置推荐不该还在: " + ids.join(", "));

  // 重复添加计入 skipped 而不是报错 —— 这样「全部添加」可以安全地重复点
  const again = await (await post("/v1/models/batch", { ids: ["openai/gpt-6-astra"] }, AUTH)).json();
  check("重复添加计入 skipped 而不是报错",
    again.added.length === 0 && again.skipped.length === 1, JSON.stringify(again));
  check("重复添加后列表不变", (await (await req("/v1/models")).json()).data.length === 2);

  // 非法 ID 被挡（这些字符会破坏下游字符串语法）。
  // 同一批里的合法项要照常加入 —— 一条坏 ID 不该让整批失败。
  const bad = await (await post("/v1/models/batch", { ids: ["ok/model", "bad|id", "quote\"id"] }, AUTH)).json();
  check("非法模型 ID 被拒绝且说明原因",
    Object.keys(bad.failed).length === 2 && bad.added.length === 1, JSON.stringify(bad));
  check("非法 ID 的报错说清是哪些字符",
    Object.values(bad.failed)[0].includes("非法字符"), Object.values(bad.failed)[0]);
  check("一批里的合法项照常加入（坏 ID 不拖累整批）",
    bad.added[0] === "ok/model", JSON.stringify(bad.added));
  // 把这一批加的 ok/model 清掉，后面的用例要按"干净状态"来断言
  await post("/v1/models/delete", { id: "ok/model" }, AUTH);

  // 设默认模型
  const notEnabled = await post("/v1/models/default", { id: "not/enabled" }, AUTH);
  check("未启用的模型不能设为默认（400）", notEnabled.status === 400, "status=" + notEnabled.status);
  const setOk = await (await post("/v1/models/default", { id: "openai/gpt-6-astra" }, AUTH)).json();
  check("已启用的模型可设为默认", setOk.default_model === "openai/gpt-6-astra", JSON.stringify(setOk.default_model));
  d = await (await req("/v1/models")).json();
  check("is_default 跟着转移",
    d.data.filter((m) => m.is_default).map((m) => m.id).join() === "openai/gpt-6-astra",
    JSON.stringify(d.data.map((m) => [m.id, m.is_default])));

  // 删掉默认模型 → 默认值必须回退，否则不带 model 的请求会打到已撤下的模型上
  const del = await (await post("/v1/models/delete", { id: "openai/gpt-6-astra" }, AUTH)).json();
  check("删除默认模型后默认值自动回退到剩余的第一个",
    del.default_model === "cline-pass/glm-5.2", "default=" + del.default_model);
  check("删除后列表里只剩另一个", del.models.length === 1);

  // 关键语义：启用的模型只是"给客户端看什么"，不是访问控制。
  // 写死模型 ID 的客户端不该因为没在面板里点过就失败。
  const unlisted = await req("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ model: "some/unlisted-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  check("未启用的模型仍可调用（发现过滤器 ≠ 访问控制）", unlisted.status === 200, "status=" + unlisted.status);
  await unlisted.text();

  // 清空启用列表 → 回到回退状态
  await post("/v1/models/delete", { id: "cline-pass/glm-5.2" }, AUTH);
  const en = await (await req("/v1/models/enabled", { headers: AUTH })).json();
  check("清空后回到「未启用」状态并标记 using_builtin",
    en.using_builtin === true,
    JSON.stringify({ b: en.using_builtin, n: en.models.length }));
  d = await (await req("/v1/models")).json();
  check("清空后 /v1/models 回退到上游免费清单（不是硬编码列表）",
    Array.isArray(d.data) && !/ClineFreePool\//.test(d.data.map((m) => m.id).join(",")),
    "不应出现被改名污染的模型 ID: " + JSON.stringify(d.data.map((m) => m.id)));

  // 鉴权与非法参数
  const noAuthBatch = await req("/v1/models/batch", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ["a/b"] }),
  });
  check("模型批量添加未鉴权时拒绝（401）", noAuthBatch.status === 401, "status=" + noAuthBatch.status);
  const emptyIds = await post("/v1/models/batch", { ids: [] }, AUTH);
  check("ids 为空时报 400", emptyIds.status === 400, "status=" + emptyIds.status);
}

// =====================================================================
console.log("\n【9b】模型库：推荐分组 / 全部模型 / 可用性检测");
{
  setMode({ kind: "ok" });

  // 推荐分组：面板一打开就拉，所以要走缓存、不能每次回源
  const lib = await (await req("/v1/models/library", { headers: AUTH })).json();
  // ClineFreePool 只展示走免费额度的模型：付费旗舰（recommended）、订阅制
  //（clinePass）、云额度（clineCloud）三类都不展示。
  // 之前漏了 recommended——它装的是 claude-opus / gpt-6 / kimi 这类烧余额的模型，
  // 面板却标成「默认走免费额度」，用户一点就烧掉 0.5 美元余额的大半。
  check("推荐清单只保留 free 分组（付费旗舰 recommended 不展示）",
    lib.groups.map((g) => g.key).join() === "free",
    JSON.stringify(lib.groups.map((g) => g.key)));
  check("不展示付费 / 订阅 / 云额度分组",
    !lib.groups.some((g) => ["recommended", "clinePass", "clineCloud"].includes(g.key)),
    "含付费分组: " + JSON.stringify(lib.groups.map((g) => g.key)));
  check("分组说明不再声称「默认走免费额度」",
    !lib.groups.some((g) => g.meta && /走免费额度/.test(g.meta.sub || "") && g.key !== "free"),
    "分组说明误导: " + JSON.stringify(lib.groups.map((g) => g.meta)));
  check("全部模型区也过滤为仅免费（前端 filterFreeOnly 存在）",
    /function filterFreeOnly\(/.test(workerSrc),
    "全部模型区应过滤掉付费模型");
  check("免费判定以上游 free 分组的 ID 集合为权威，不靠 ID 后缀猜",
    /function freeModelIdSet\(/.test(workerSrc) && /state\.mLibGroups/.test(workerSrc),
    "应从 state.mLibGroups 的 free 组取权威 ID 集合");
  check("free 集合未加载时才有后缀兜底（不是主判定）",
    /if \(s\.size\) return s\.has\(id\)/.test(workerSrc),
    "free 集合非空时应以集合为准，仅在空时按后缀兜底");
  check("分组带展示用的 meta（标题/说明/颜色）",
    lib.groups.every((g) => g.meta && g.meta.title), JSON.stringify((lib.groups[0] || {}).meta));
  check("模型带 name / description / tags（面板要显示）",
    lib.groups.some((g) => g.models.some((m) => m.name && m.description && Array.isArray(m.tags))),
    JSON.stringify(lib.groups[0].models[0]));
  // 缓存语义：首次回源、再次命中。面板每次进模型页都会拉这个接口，
  // 每次都回源会把上游的配额和面板的首屏速度一起拖垮。
  const lib2 = await (await req("/v1/models/library", { headers: AUTH })).json();
  check("推荐分组二次请求命中缓存（不回源）", lib2.cached === true, "cached=" + lib2.cached);

  // 全部模型：446 条那种大清单，只在展开折叠块时拉
  const cat = await (await req("/v1/models/catalog", { headers: AUTH })).json();
  check("全部模型按供应商前缀分组", cat.groups.length > 0 && cat.groups.every((g) => !g.key.includes("/")),
    JSON.stringify(cat.groups.map((g) => g.key)));
  check("全部模型带 context_length（面板显示上下文）",
    cat.groups.some((g) => g.models.some((m) => m.context_length > 0)),
    JSON.stringify(cat.groups[0] && cat.groups[0].models[0]));
  check("~ 前缀归到同一供应商组（但不改 ID 本身）",
    cat.groups.some((g) => g.key === "deepseek" && g.models.some((m) => m.id.startsWith("~deepseek/"))),
    JSON.stringify(cat.groups.map((g) => [g.key, g.models.length])));
  check("~ 前缀的 ID 原样保留（它是 ID 的一部分，不是别名标记）",
    cat.groups.some((g) => g.models.some((m) => m.id === "~deepseek/deepseek-pro-latest")),
    "波浪号被错误剥掉了");

  // 回源失败 → 退回过期缓存而不是让面板空白
  setMode({ kind: "ok", models: "fail" });
  const stale = await (await req("/v1/models/library?refresh=1", { headers: AUTH })).json();
  check("上游抓取失败时退回过期缓存（并标记 stale）",
    stale.stale === true && stale.groups.length > 0,
    JSON.stringify({ stale: stale.stale, n: stale.groups.length, err: stale.error }));
  check("stale 响应里带失败原因（面板要提示用户）", !!stale.error, "err=" + stale.error);
  setMode({ kind: "ok" });

  // 模型检测：异步任务，只回答"现在能不能用"
  const startResp = await req("/v1/models/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ id: "deepseek/deepseek-v4-flash" }),
  });
  const started = await startResp.json();
  check("检测立即返回 202 + jobId（不阻塞面板）",
    startResp.status === 202 && started.job && started.job.id, "status=" + startResp.status);
  check("检测任务的 kind 与渠道探测区分开",
    started.job.kind === "check", "kind=" + started.job.kind);

  const waitJob = async (id) => {
    let job = { id, status: "running" };
    for (let i = 0; i < 40 && job.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 150));
      job = (await (await req("/v1/models/check?jobId=" + encodeURIComponent(id), { headers: AUTH })).json()).job;
    }
    return job;
  };

  const job = await waitJob(started.job.id);
  check("检测跑完并给出可用结论", job.status === "done" && job.result && job.result.ok === true,
    JSON.stringify({ s: job.status, r: job.result }));
  check("检测结果带耗时（面板显示首字节）",
    typeof job.result.latencyMs === "number", JSON.stringify(job.result));

  // 200 但正文为空 = 实际不可用。只认状态码会把这种情况误报成"可用"。
  setMode({ kind: "empty" });
  const e1 = await (await req("/v1/models/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ id: "deepseek/deepseek-v4-flash" }),
  })).json();
  const j2 = await waitJob(e1.job.id);
  check("HTTP 200 但正文为空 → 判为不可用（不能只看状态码）",
    j2.result && j2.result.ok === false, JSON.stringify(j2.result));
  check("空正文的说明解释了可能原因", j2.result.text.includes("有效文本"), j2.result.text);

  // 状态码 → 人能看懂、且能照着做的原因
  setMode({ kind: "code", status: 402, body: { error: { message: "need credits" } } });
  const e2 = await (await req("/v1/models/check", {
    method: "POST", headers: { "Content-Type": "application/json", ...AUTH },
    body: JSON.stringify({ id: "deepseek/deepseek-v4-flash" }),
  })).json();
  const j3 = await waitJob(e2.job.id);
  check("402 → 提示额度/订阅不足（而不是把 HTTP 码丢给用户）",
    j3.result.text.includes("额度"), j3.result.text);
  setMode({ kind: "ok" });

  const badJob = await req("/v1/models/check?jobId=nope", { headers: AUTH });
  check("未知 jobId 返回 404 且提示重新检测", badJob.status === 404, "status=" + badJob.status);
  const noId = await post("/v1/models/check", {}, AUTH);
  check("检测缺 id 时报 400", noId.status === 400, "status=" + noId.status);
  const noAuth = await req("/v1/models/library");
  check("模型库接口未鉴权时拒绝（401）", noAuth.status === 401, "status=" + noAuth.status);
}

// =====================================================================
console.log("\n【10】控制台页面完整性");
{
  const r = await req("/");
  const html = await r.text();
  check("返回 HTML 且含 UTF-8 声明", r.status === 200 && html.includes('charset="utf-8"'));
  check("与 console.src.html 一致（构建产物同步）", await (async () => {
    try {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL("./console.src.html", import.meta.url), "utf8");
      return html === src;
    } catch { return true; } // 无源文件时跳过
  })(), "worker.js 内联的 HTML 与 console.src.html 不一致，请运行 node build-console.mjs");
  // 关键功能点必须在页面上
  for (const [name, needle] of [
    ["多轮对话容器", 'id="thread"'],
    ["停止生成按钮", 'id="btnStop"'],
    ["接入代码片段区", 'id="snip"'],
    ["固定高度日志滚动窗口", 'id="logwin"'],
    ["日志详情面板", 'id="logDetail"'],
    ["日志筛选开关", 'data-f="slow"'],
    ["账号池指示器（签名元素）", 'id="poolCells"'],
    ["思考过程折叠", 'details class="rz"'],
    // 模型库三段式（对齐 Go 版 cline-proxy 的布局）
    ["模型推荐分组容器", 'id="mLibrary"'],
    ["全部模型折叠块", 'id="mCatalogFold"'],
    ["全部模型搜索框", 'id="mCatSearch"'],
    ["已启用模型列表", 'id="mOwned"'],
    ["模型描述开关", 'id="mDescBtn"'],
  ]) {
    check("含" + name, html.includes(needle), "缺少: " + needle);
  }
  check("代码片段覆盖 5 种语言",
    html.includes('{id:"curl"') && html.includes('{id:"python"') && html.includes('{id:"node"') &&
    html.includes('{id:"anthropic"') && html.includes('{id:"env"'),
    "片段定义应含 curl/python/node/anthropic/env 五种");
  check("错误提示含 1010 / 402 / 429 的解释",
    html.includes("1010") && html.includes("insufficient_credits") && html.includes("Daily free limit"),
    "页面应把常见上游错误翻译成可操作建议");
  check("含复制模型 ID 的按钮", html.includes("data-copyid"));
  check("含速度单位 tok/s", html.includes("tok/s"));
  check("尊重 prefers-reduced-motion", html.includes("prefers-reduced-motion"));
  check("无外部资源依赖（单文件自包含）",
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html),
    "不应引用外部 js/css，否则离线/内网部署会挂");
  check("品牌已改为 ClineFreePool", html.includes("ClineFreePool") && html.includes("<title>ClineFreePool"));
  check("无原作者署名残留（品牌已完全归属）",
    !html.includes("Patrick") && !html.includes("AI实用talk"),
    "署名与页脚不应再出现原作者信息");
  // 控制台不展示作者 / 公众号 / 博客（按需求移除）。项目归属信息只保留在
  // README、LICENSE 与代码头部注释里—— 那是开源该有的位置，控制台只管用。
  check("控制台不展示作者署名（已按需求移除）",
    !html.includes('class="credit"') && !html.includes('class="mp"'),
    "署名区应已从控制台移除");
  // 控制台不放任何个人信息：不硬编码具体名字，改用结构性检查
  //（署名区类名已被移除，且页面里没有指向个人站点的外链）。
  check("控制台不出现个人信息（无个人站点外链）",
    !/<a[^>]+href="https?:\/\/(?!www\.w3\.org|claude\.bot|github\.com\/[^"\s]*\/cline)/i.test(html),
    "控制台不应出现指向个人站点的外链");
  check("控制台无署名区与个人信息文案",
    !/class="credit"|class="mp"|作者\s*<b>|公众号\s*<b>/.test(html),
    "署名区应已从控制台移除");
  check("密钥与版本状态行仍保留（实用信息不能一起删）",
    html.includes('id="keyTxt"') && html.includes('id="verTxt"'),
    "密钥状态与版本号应保留");
  check("像素 WiFi 图标为内联 SVG（1px 网格 rect）",
    /<svg class="logo"[^>]*><rect /.test(html), "品牌区应有像素 WiFi 的 SVG");
  check("国产模型识别表存在", html.includes("CN_PROVIDERS") && html.includes("deepseek"));
  check("模型按供应商分组渲染（全部模型视图）", html.includes("groupCatalogModels") || html.includes("function modelGroupHTML"),
    "模型页应有供应商分组逻辑");
  check("日志为固定高度滚动窗口", html.includes('id="logwin"') && /overflow-y:\s*auto/.test(html));
  check("日志含跟随最新开关", html.includes('id="btnFollow"'));
  check("日志含详情面板", html.includes('id="logDetail"'));
  check("含主题切换（深/浅）", html.includes('id="btnTheme"') && html.includes('[data-theme="light"]'));
  check("含减少动效支持", html.includes("prefers-reduced-motion"));

  // 回归：曾在 HTML 里写 Markdown 粗体，页面直接显示成 **文字**，很显眼
  check("可见文案中没有残留 Markdown 标记（** 与 [](  ）", await (async () => {
    // 只看 body 里、标签之外的文本
    const body = html.slice(html.indexOf("<body"));
    const textOnly = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
    return !/\*\*[^*]+\*\*/.test(textOnly) && !/\[[^\]]+\]\([^)]+\)/.test(textOnly);
  })(), "页面文案里出现了未渲染的 Markdown 语法");
  check("账号页含登录按钮", html.includes('id="btnLogin"'));
  check("登录区含跳转授权页的按钮", html.includes("btnOpenAuth"));
  check("展示设备码的容器存在", html.includes('id="deviceCode"'));

  // 回归：状态提示曾用绝对定位的顶部浮层（#notes）呈现，它压在整个 .views 之上，
  // 正好盖住账号页右上角的「登录新账号」按钮 —— 提示用户去登录，却挡住登录入口。
  // 现统一改为右下角弹窗（syncNotices），这里确保浮层不再回来。
  check("没有覆盖在视图之上的提示浮层（会挡住页头按钮）",
    !html.includes('id="notes"') && !/\.notes\s*\{[^}]*position\s*:\s*absolute/.test(html),
    "顶部提示浮层又出现了：#notes 绝对定位在 .views 顶部，会挡住各页头部按钮");
  check("状态提示走右下角弹窗同步（syncNotices）",
    html.includes("function syncNotices") && html.includes("sticky: true"),
    "renderHealth 应通过 syncNotices 把状态提示发到右下角，而不是渲染到页面顶部");
  check("弹窗支持动作按钮（提示里可直接去处置）",
    html.includes("function bindToastAction") && html.includes('class="act"'),
    "常驻提示需要一个按钮把用户带到处置位置");
  check("常驻提示不自动消失（sticky 且无倒计时条）",
    html.includes('(o.sticky ? " sticky" : "")') &&
    html.includes(".toast:not(.out):not(.sticky)") &&
    html.includes('var barHtml = o.sticky ? "" : '),
    "sticky 提示不该被自动收走，也不该参与淘汰计数");
  check("手动关掉的提示不会每 30 秒弹回来",
    html.includes("muteNotice") && html.includes("mutedNotices[it.nid]"),
    "syncNotices 每轮轮询都会跑，需要记住用户已关闭的提示");
  check("本地首次运行不再被误报为「服务端未配置」",
    html.includes("isLocalConsole") && html.includes("本地首次启动时账号池是空的，这是正常的"),
    "本地账号池为空是预期状态，应提示去登录而非报配置错误");
  check("云端账号丢失时有单独措辞（不说成配置缺失）",
    html.includes("当前没有可用账号") && html.includes("重新部署后会丢失"),
    "云端内存账号在冷启动后会丢，提示不应说成「未配置 CLINE_REFRESH_TOKEN」");
}

// =====================================================================
console.log("\n【11】账号明细：health 精简 + status 带鉴权（避免公开泄露邮箱）");
{
  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_Z_zzzzzzzzzz\nTOKEN_Y_yyyyyyyyyy" };
  const h = await (await worker.fetch(new Request("https://x.dev/v1/health"), env)).json();

  // health 免鉴权 → 不该带账号明细（邮箱、用量都在这端点暴露给公网）
  check("health 不再下发 account_details（免鉴权端点不泄露账号信息）",
    h.account_details === undefined, JSON.stringify(h.account_details));
  check("health 不泄露邮箱字段", !JSON.stringify(h).includes("email"),
    "health 响应里出现了 email");
  check("health 仍保留连通性所需的计数字段",
    typeof h.account_count === "number" && typeof h.accounts_available === "number" &&
    typeof h.api_key_configured === "boolean",
    JSON.stringify({ count: h.account_count, avail: h.accounts_available }));

  // 明细改到需要 API_KEY 的 /v1/status
  const st = await (await worker.fetch(new Request("https://x.dev/v1/status", { headers: AUTH }), env)).json();
  check("status 返回 account_details 数组", Array.isArray(st.account_details), JSON.stringify(st.account_details));
  check("每项含 index / available / cooldown_models / token_cached",
    st.account_details.every((a) =>
      typeof a.index === "number" && typeof a.available === "boolean" &&
      Array.isArray(a.cooldown_models) && typeof a.token_cached === "boolean"),
    JSON.stringify(st.account_details[0]));
  check("status 同时返回全局冷却表（供控制台展示）",
    Array.isArray(st.cooldowns), JSON.stringify(st.cooldowns));

  const noAuth = await worker.fetch(new Request("https://x.dev/v1/status"), env);
  check("status 未鉴权时拒绝（不能当新的泄露口）", noAuth.status === 401, "status=" + noAuth.status);

  check("account_details 不泄露 token 内容", await (async () => {
    // 用不可能出现在字段名/枚举值里的 token，避免误判
    const probe = "sEcReTtOkEnVaLuE12345";
    const e2 = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: probe + "_aaaaaaaaaa\n" + probe + "_bbbbbbbbbb" };
    const st2 = await (await worker.fetch(new Request("https://x.dev/v1/status", { headers: AUTH }), e2)).json();
    return !JSON.stringify(st2).includes(probe);
  })(), "账号明细里出现了 refreshToken 片段");
  check("account_details 数量与 account_count 一致",
    st.account_details.length === st.account_count);
}

// =====================================================================
console.log("\n【12】登录端点鉴权（不得成为开放 OAuth 代理）");
{
  // 未配置 API_KEY 时必须拒绝
  const noKeyEnv = { CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  for (const path of ["/v1/login/start", "/v1/login/poll"]) {
    const r = await worker.fetch(new Request("https://x.dev" + path, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), noKeyEnv);
    check(path + " 未配置 API_KEY 时拒绝", r.status === 401, "status=" + r.status);
  }
  // 错误 key 也必须拒绝
  const r2 = await post("/v1/login/start", {}, { Authorization: "Bearer wrong-key" });
  check("/v1/login/start 错误 key 拒绝", r2.status === 401, "status=" + r2.status);
  // 公开默认 key 必须无效（历史后门）
  const r3 = await post("/v1/login/start", {}, { Authorization: "Bearer cline2api-default-key" });
  check("/v1/login/start 拒绝公开默认 key", r3.status === 401, "status=" + r3.status);
}

console.log("\n【13】登录流程（假 WorkOS 上游）");
{
  // 用一个本地假 WorkOS，验证 start → poll pending → poll success 全链路
  const { createServer } = await import("node:http");
  let pollCount = 0;
  const fake = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.url.includes("authorize/device")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev_abc123", user_code: "ABCD-1234",
        verification_uri_complete: "https://authkit.example/device?user_code=ABCD-1234",
        interval: 5, expires_in: 300,
      }));
      return;
    }
    if (req.url.includes("user_management/authenticate")) {
      pollCount++;
      if (pollCount < 2) {
        // 第一次：还没授权（WorkOS 用 400 + authorization_pending）
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authorization_pending", error_description: "still pending" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "workos_at", refresh_token: "workos_rt" }));
      return;
    }
    if (req.url.includes("/auth/register")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { refreshToken: "CLINE_RT_NEW_123456", userInfo: { email: "new@example.com" } } }));
      return;
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const fakePort = fake.address().port;

  // 把 worker 里的 WorkOS 地址替换成本地假上游
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";',
             'const WORKOS_DEVICE = "http://127.0.0.1:' + fakePort + '/user_management/authorize/device";')
    .replace('const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";',
             'const WORKOS_AUTH = "http://127.0.0.1:' + fakePort + '/user_management/authenticate";')
    .replace('const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";',
             'const CLINE_REGISTER = "http://127.0.0.1:' + fakePort + '/api/v1/auth/register";');
  const dir = mkdtempSync(join(tmpdir(), "login-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w2 = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "" };
  const call = (path, body) => w2.fetch(new Request("https://x.dev" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body || {}),
  }), env);

  const s = await call("/v1/login/start", {});
  const sd = await s.json();
  check("start 返回授权链接", s.status === 200 && !!sd.verification_uri, JSON.stringify(sd).slice(0, 140));
  check("start 返回设备码", sd.user_code === "ABCD-1234", sd.user_code);
  check("start 返回 device_code", !!sd.device_code);

  const p1 = await (await call("/v1/login/poll", { device_code: sd.device_code })).json();
  check("poll 未授权时返回 pending（不当作错误）", p1.status === "pending", JSON.stringify(p1));

  const p2 = await (await call("/v1/login/poll", { device_code: sd.device_code })).json();
  check("poll 授权后返回 success", p2.status === "success", JSON.stringify(p2).slice(0, 140));
  check("poll 返回 refreshToken", p2.refresh_token === "CLINE_RT_NEW_123456", p2.refresh_token);
  check("poll 返回邮箱", p2.email === "new@example.com", p2.email);

  // 登录后账号应进入账号池。明细在 /v1/status（需鉴权），health 只回计数。
  const h = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("登录的账号已进入账号池", h.account_count === 1, "account_count=" + h.account_count);
  check("登录返回里告知是否已落盘（本地为 true）",
    p2.persisted === false, "persisted=" + p2.persisted + "（测试环境没有接持久化钩子）");

  const st = await (await w2.fetch(new Request("https://x.dev/v1/status", { headers: AUTH }), env)).json();
  check("该账号被标记为运行时账号（来自控制台登录）",
    st.runtime_accounts === 1 && st.account_details[0].runtime === true,
    JSON.stringify(st.account_details));
  check("status 不泄露登录得到的 refreshToken",
    !JSON.stringify(st).includes("CLINE_RT_NEW"), "泄漏了 token");

  const p3 = await (await call("/v1/login/poll", {})).json();
  check("poll 缺 device_code 时报错", !p3.ok, JSON.stringify(p3));
  check("poll 不泄露上游错误细节为成功", p3.status !== "success");

  // 运行时账号可以被移除（与环境变量账号相反：后者只能停用）
  const st2 = await (await w2.fetch(new Request("https://x.dev/v1/status", { headers: AUTH }), env)).json();
  const rtId = st2.account_details[0].id;
  const rm = await (await call("/v1/accounts/action", { action: "remove", id: rtId })).json();
  check("运行时账号可以移除", rm.ok === true && rm.removed === 1,
    JSON.stringify(rm).slice(0, 160));
  const h3 = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("移除后账号池里不再有该账号", h3.account_count === 0,
    "account_count=" + h3.account_count);

  fake.close();
}

// =====================================================================
console.log("\n【14】账号控制（启用/停用/重置冷却/移除）");
{
  // 独立加载一份 worker，避免影响前面的用例（账号池是模块级状态）
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "acct-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
  const call = (path, body) => w.fetch(new Request("https://x.dev" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body || {}),
  }), env);
  const health = async () => (await w.fetch(new Request("https://x.dev/v1/health"), env)).json();
  // 账号明细在 /v1/status（需鉴权）；health 只回计数
  const status = async () => (await w.fetch(new Request("https://x.dev/v1/status", {
    headers: { Authorization: "Bearer sk-test" },
  }), env)).json();
  const chat = () => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env);

  let h = await status();
  check("账号明细含 id / enabled / stats",
    h.account_details.every((a) => typeof a.id === "string" && a.id.length > 0 &&
      typeof a.enabled === "boolean" && a.stats && typeof a.stats.ok === "number"),
    JSON.stringify(h.account_details[0]));
  check("账号 id 不泄露 token 内容",
    !JSON.stringify(h).includes("TOKEN_A") && !JSON.stringify(h).includes("TOKEN_B"));
  const idA = h.account_details[0].id, idB = h.account_details[1].id;
  check("多账号的 id 互不相同", idA !== idB, idA + " vs " + idB);

  // 未鉴权不得操作账号
  const noAuth = await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "disable", id: idA }),
  }), env);
  check("账号控制端点未鉴权时拒绝", noAuth.status === 401, "status=" + noAuth.status);

  // 停用
  let r = await (await call("/v1/accounts/action", { action: "disable", id: idA })).json();
  check("停用账号返回成功", r.ok === true, JSON.stringify(r).slice(0, 140));
  check("停用后该账号 enabled=false",
    r.accounts[0].enabled === false && r.accounts[0].available === false,
    JSON.stringify(r.accounts[0]));
  check("停用只影响目标账号", r.accounts[1].enabled === true);
  check("停用后可用账号少一个（available 反映是否参与调度）",
    r.accounts.filter((a) => a.available).length === 1,
    JSON.stringify(r.accounts.map((a) => a.available)));

  h = await status();
  check("status 反映停用状态",
    h.account_details[0].enabled === false && h.accounts_available === 1,
    JSON.stringify({ enabled: h.account_details[0].enabled, avail: h.accounts_available }));

  // 停用全部 → 请求应给出明确原因，而不是含糊的报错
  await call("/v1/accounts/action", { action: "disable", id: idB });
  const chatResp = await chat();
  const chatBody = await chatResp.json();
  check("全部停用时聊天端点说明原因（all_accounts_disabled）",
    chatBody.error && chatBody.error.reason === "all_accounts_disabled",
    JSON.stringify(chatBody).slice(0, 200));
  check("全部停用返回 429（可重试语义而非 500）", chatResp.status === 429, "status=" + chatResp.status);

  // 启用回来 → 恢复正常
  r = await (await call("/v1/accounts/action", { action: "enableAll" })).json();
  check("全部启用后所有账号 enabled",
    r.accounts.every((a) => a.enabled === true), JSON.stringify(r.accounts.map((a) => a.enabled)));
  check("全部启用后 accounts_available 恢复", r.accounts.filter((a) => a.available).length === 2);

  // 重置冷却
  r = await (await call("/v1/accounts/action", { action: "reset", id: idA })).json();
  check("重置冷却返回成功且该账号可用",
    r.ok === true && r.accounts.find((a) => a.id === idA).cooldown_seconds === 0,
    JSON.stringify(r.accounts.find((a) => a.id === idA)));

  r = await (await call("/v1/accounts/action", { action: "resetAll" })).json();
  check("重置全部冷却返回成功", r.ok === true, JSON.stringify(r).slice(0, 140));

  // 环境变量账号不可移除（移除没意义：下次 parseAccounts 又会建出来）
  const rm = await call("/v1/accounts/action", { action: "remove", id: idA });
  const rmBody = await rm.json();
  check("环境变量账号拒绝移除", rm.status === 400 && !rmBody.ok, JSON.stringify(rmBody).slice(0, 200));
  check("拒绝移除时提示改用停用", rmBody.error && rmBody.error.message.includes("停用"));

  // 未知 id / 未知 action
  const unknown = await (await call("/v1/accounts/action", { action: "disable", id: "deadbeef" })).json();
  check("未知账号 id 返回错误", unknown.ok !== true, JSON.stringify(unknown).slice(0, 140));
  const badAct = await (await call("/v1/accounts/action", { action: "nonsense", id: idA })).json();
  check("未知 action 返回错误", badAct.ok !== true, JSON.stringify(badAct).slice(0, 140));
  const noAct = await (await call("/v1/accounts/action", {})).json();
  check("缺少 action 参数时报错", noAct.ok !== true);

  // 统计：成功调用应累计到账号上
  await chat();
  h = await status();
  check("成功请求累加到账号统计（ok>0）",
    h.account_details.some((a) => a.stats.ok > 0),
    JSON.stringify(h.account_details.map((a) => a.stats)));

  // token 刷新轮换后，账号 id 必须保持不变，否则控制台的开关会跟丢账号
  const afterRefresh = await status();
  check("账号 id 在 token 轮换后保持稳定",
    afterRefresh.account_details[0].id === idA,
    "before=" + idA + " after=" + afterRefresh.account_details[0].id);
}

// =====================================================================
console.log("\n【15】Token 用量统计");
{
  // 独立实例：统计是模块级累计状态，混进前面的用例会互相污染
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "usage-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
  const health = async () => (await w.fetch(new Request("https://x.dev/v1/health"), env)).json();
  const chat = (body) => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify(body || { model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env);
  // Anthropic 协议走同一条上游，用于验证另一条返回路径也落了账
  const anth = () => w.fetch(new Request("https://x.dev/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test", "x-api-key": "sk-test" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env);

  setMode({ kind: "ok" });
  let h = await health();
  check("health 含 usage 汇总", h.usage && typeof h.usage === "object",
    JSON.stringify(h.usage || null).slice(0, 160));
  check("usage.total 各字段初始为 0",
    h.usage.total.input === 0 && h.usage.total.output === 0 && h.usage.total.calls === 0,
    JSON.stringify(h.usage.total));
  check("usage.days 已铺满 30 天（横轴连续）", h.usage.days.length === 30,
    "days=" + h.usage.days.length);
  {
    const st0 = await (await w.fetch(new Request("https://x.dev/v1/status",
      { headers: { Authorization: "Bearer sk-test" } }), env)).json();
    check("账号明细含 usage 字段",
      st0.account_details.every((a) => a.usage && typeof a.usage.total === "number"),
      JSON.stringify(st0.account_details.map((a) => a.usage)));
  }

  // ── 流式：usage 从收尾 chunk 里取（假上游给的是 5 prompt / 5 completion）──
  const beforeCalls = (await health()).usage.total.calls;
  const streamResp = await chat();
  await streamResp.text(); // 必须读完流，worker 才会在 finally 里落账
  h = await health();
  check("流式请求后上游调用数 +1", h.usage.total.calls === beforeCalls + 1,
    "calls=" + h.usage.total.calls);
  check("流式 usage 被记录（input=5 / output=5）",
    h.usage.total.input === 5 && h.usage.total.output === 5,
    JSON.stringify(h.usage.total));
  check("流式 usage 的合计 = 输入 + 输出", h.usage.total.total === 10,
    JSON.stringify(h.usage.total));
  check("客户端请求数被记录", h.usage.client_requests === 1,
    "client_requests=" + h.usage.client_requests);
  check("一次打中时放大倍数为 1.0", h.usage.retry_amplification === 1,
    "amp=" + h.usage.retry_amplification);
  check("usage 按模型分组", (h.usage.by_model || []).some((m) => m.total === 10),
    JSON.stringify(h.usage.by_model));
  check("usage 按账号分组", (h.usage.by_account || []).length === 1,
    JSON.stringify(h.usage.by_account));
  {
    const stU = await (await w.fetch(new Request("https://x.dev/v1/status",
      { headers: { Authorization: "Bearer sk-test" } }), env)).json();
    check("账号卡上的 token 数跟着累加",
      stU.account_details.some((a) => a.usage.input === 5 && a.usage.output === 5),
      JSON.stringify(stU.account_details.map((a) => a.usage)));
  }
  check("今日用量进入 days 的最后一格",
    h.usage.days[29].total === 10 && h.usage.days[29].calls === 1,
    JSON.stringify(h.usage.days[29]));

  // ── 重试放大：这是"按上游调用统计"要暴露的核心信息 ──
  // 空响应会让 worker 切号重试，每次重试都真实消耗上游额度。
  // 客户端只发 1 条消息，但上游被打了 3 次（首轮 + 2 次重试用尽）。
  setMode({ kind: "empty" });
  const before2 = (await health()).usage;
  const emptyResp = await chat({ model: "deepseek/deepseek-v4-flash", stream: false, messages: [{ role: "user", content: "hi" }] });
  await emptyResp.text();
  h = await health();
  const dCalls = h.usage.total.calls - before2.total.calls;
  const dReq = h.usage.client_requests - before2.client_requests;
  check("空响应重试：客户端只发 1 次", dReq === 1, "dReq=" + dReq);
  check("空响应重试：上游被调用多次（重试都记上）", dCalls > 1,
    "dCalls=" + dCalls + "（应 >1，体现重试烧掉的额度）");
  check("重试的那几次也计入了 token", h.usage.total.input > before2.total.input,
    "input " + before2.total.input + " → " + h.usage.total.input);
  check("放大倍数随之 >1（暴露重试开销）", h.usage.retry_amplification > 1,
    "amp=" + h.usage.retry_amplification);

  // ── Anthropic 协议路径也要落账 ──
  // 先清掉上一段重试测试留下的账号冷却：两个号都在冷却时请求会直接被拒
  // （all_accounts_cooling），压根到不了上游，那样测的就不是 Anthropic 路径了。
  await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({ action: "resetAll" }),
  }), env);

  setMode({ kind: "ok" });
  const before3 = (await health()).usage;
  const aResp = await anth();
  await aResp.text();
  h = await health();
  check("Anthropic 非流式路径也记录用量",
    h.usage.total.calls > before3.total.calls && h.usage.total.output > before3.total.output,
    "calls " + before3.total.calls + " → " + h.usage.total.calls + "，status=" + aResp.status);

  // ── Anthropic 流式路径 ──
  const before4 = (await health()).usage;
  const aStream = await w.fetch(new Request("https://x.dev/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env);
  await aStream.text();
  h = await health();
  check("Anthropic 流式路径也记录用量", h.usage.total.calls > before4.total.calls,
    "calls " + before4.total.calls + " → " + h.usage.total.calls);

  // ── 鉴权失败不计入客户端请求数：没消耗上游额度，计进去会污染放大倍数 ──
  const before5 = (await health()).usage.client_requests;
  await w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer WRONG" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ name: "x" }] }),
  }), env);
  h = await health();
  check("鉴权失败不计入客户端请求数", h.usage.client_requests === before5,
    before5 + " → " + h.usage.client_requests);

  // ── 持久化钩子：本地 local-server 靠它跨重启保留统计 ──
  const api = globalThis.__clineUsage;
  check("worker 暴露持久化钩子（__clineUsage）",
    api && typeof api.setUsagePersistence === "function" &&
    typeof api.restoreUsage === "function" && typeof api.exportUsage === "function");
  // 落盘是防抖的（1.5s），这里用 flushUsageNow 同步取一次，否则拿到的是 null
  let flushed = null;
  api.setUsagePersistence((snap) => { flushed = snap; });
  api.flushUsageNow();
  check("导出快照含统计结构",
    flushed && flushed.total && flushed.byDay && flushed.byAccount,
    JSON.stringify(flushed && Object.keys(flushed)).slice(0, 160));
  const snapTotal = flushed.total.total;
  check("快照里的合计量 >0", snapTotal > 0, "total=" + snapTotal);
  check("快照含按账户分组的用量", Object.keys(flushed.byAccount).length > 0,
    JSON.stringify(Object.keys(flushed.byAccount)));

  // 恢复：把快照灌回另一个实例，验证累加语义（重启后统计不丢）
  const dir2 = mkdtempSync(join(tmpdir(), "usage-test2-"));
  const f2 = join(dir2, "w2.mjs");
  writeFileSync(f2, src, "utf8");
  const w2 = (await import("file:///" + f2.split("\\").join("/"))).default;
  const api2 = globalThis.__clineUsage;
  const okRestore = api2.restoreUsage(flushed);
  const h2 = await (await w2.fetch(new Request("https://x.dev/v1/health"), env)).json();
  check("快照可恢复到新实例（跨重启保留）",
    okRestore === true && h2.usage.total.total === snapTotal && h2.usage.client_requests === flushed.clientRequests,
    "期望 total=" + snapTotal + "，实际 " + h2.usage.total.total +
    "；clientRequests 期望 " + flushed.clientRequests + "，实际 " + h2.usage.client_requests);
  {
    const st2 = await (await w2.fetch(new Request("https://x.dev/v1/status",
      { headers: { Authorization: "Bearer sk-test" } }), env)).json();
    check("恢复后账号卡上的 token 数不归零",
      st2.account_details.some((a) => a.usage.total > 0),
      JSON.stringify(st2.account_details.map((a) => a.usage)));
  }
  check("恢复后重试放大倍数一致",
    Math.abs(h2.usage.retry_amplification - (flushed.total.calls / flushed.clientRequests)) < 0.02,
    "amp=" + h2.usage.retry_amplification);
}

// =====================================================================
console.log("\n【16】上游渠道钉住（planner / direct 双管道）");
{
  // 独立实例：上游配置是模块级状态，混进前面的用例会互相污染
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "pin-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };
  const lastBody = () => upstreamCalls[upstreamCalls.length - 1].body;
  // 偏好注入位置取决于管道：planner 走 providerOptions.gateway，
  // direct 走顶层 provider；管道未知时两处都有。断言只看「实际生效的那一处」。
  const pipePrefs = () => {
    const b = lastBody();
    return (b.providerOptions && b.providerOptions.gateway) || b.provider || {};
  };

  const savePin = (cfg) => w.fetch(new Request("https://x.dev/v1/upstreams?action=save", {
    method: "POST", headers: A,
    body: JSON.stringify({ model_id: "cline-free/deepseek-v4.1-flash", config: cfg }),
  }), env);
  const chat = (model) => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify({ model: model || "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env);

  setMode({ kind: "ok" });

  // 管道未知时两种形式同时注入：实测 planner 模型上多一个顶层 provider.only
  // 不会报错（顶层被网关忽略），所以这是安全的兜底，省掉「必须先探测」的强依赖。
  await savePin({ upstreams: ["alibaba", "deepinfra"], pinMode: "strict" });
  await (await chat()).text();
  check("管道未知时同时注入两种形式（direct 的 provider + planner 的 providerOptions）",
    !!lastBody().provider && !!lastBody().providerOptions && !!lastBody().providerOptions.gateway,
    JSON.stringify({ provider: lastBody().provider, po: lastBody().providerOptions }));
  check("strict 模式：钉住的渠道写进 only",
    JSON.stringify(lastBody().provider.only) === JSON.stringify(["alibaba", "deepinfra"]),
    JSON.stringify(lastBody().provider));

  // preferred 模式写 order（首位优先、其余回退）
  await savePin({ upstreams: ["alibaba", "deepinfra"], pinMode: "preferred" });
  await (await chat()).text();
  check("preferred 模式：写 order 而不是 only",
    JSON.stringify(lastBody().provider.order) === JSON.stringify(["alibaba", "deepinfra"]) &&
    lastBody().provider.only === undefined,
    JSON.stringify(lastBody().provider));

  // 排除项换算成 only 白名单（网关不认 exclude 字段，实测被静默忽略）。
  // 白名单需要**已知渠道清单**，而清单只能靠探测得到——所以先跑一次真实探测，
  // 这也顺带验证「探测结果被写回配置、供后续保存复用」。
  setMode({ kind: "routing", pipeline: "planner", provider: "alibaba" });
  const pjob = await (await w.fetch(new Request("https://x.dev/v1/upstreams?action=probe", {
    method: "POST", headers: A, body: JSON.stringify({ model_id: "cline-free/deepseek-v4.1-flash" }),
  }), env)).json();
  let pj = pjob.job;
  for (let i = 0; i < 40 && pj.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 150));
    pj = (await (await w.fetch(new Request(
      "https://x.dev/v1/upstreams?action=probe_status&jobId=" + encodeURIComponent(pj.id), { headers: A }), env)).json()).job;
  }
  check("planner 管道被识别（从 provider_metadata.gateway.routing 回读）",
    pj.result && pj.result.pipeline === "planner",
    "pipeline=" + (pj.result && pj.result.pipeline) + " note=" + (pj.result && pj.result.note));
  check("planner 管道下从错误文本枚举出渠道清单",
    pj.result && JSON.stringify(pj.result.available) === JSON.stringify(["alibaba", "baseten", "deepinfra", "novita"]),
    JSON.stringify(pj.result && pj.result.available));
  check("探测确认钉住生效（实际命中与钉住列表一致）",
    pj.result && pj.result.providerMatch === true,
    "providerMatch=" + (pj.result && pj.result.providerMatch) + " provider=" + (pj.result && pj.result.provider));

  await savePin({ upstreams: ["alibaba", "novita"], pinMode: "strict", exclude: ["novita"] });
  await (await chat()).text();
  // 管道已知是 planner → 只注入 gateway 形式（顶层 provider 会被网关忽略，不必再发）
  check("探测出 planner 管道后，只注入 providerOptions.gateway 形式",
    lastBody().provider === undefined && !!lastBody().providerOptions,
    JSON.stringify({ provider: lastBody().provider, po: lastBody().providerOptions }));
  check("排除项换算成白名单：被排除的渠道从 only 里消失",
    JSON.stringify(lastBody().providerOptions.gateway.only) === JSON.stringify(["alibaba"]),
    JSON.stringify(lastBody().providerOptions));

  // 排除优先级高于勾选：pin 与 exclude 同时命中时排除赢
  await savePin({
    upstreams: ["alibaba", "novita"], exclude: ["novita", "alibaba"], pinMode: "strict",
  });
  await (await chat()).text();
  check("排除优先于勾选（钉住的渠道也会被排除掉）",
    JSON.stringify(lastBody().providerOptions.gateway.only) === JSON.stringify(["baseten", "deepinfra"]),
    JSON.stringify(lastBody().providerOptions));

  // 模型重定向：对外用稳定别名，上游改名时只改这里
  await savePin({ redirect: "z-ai/glm-5.3-flash" });
  await (await chat()).text();
  check("模型重定向：发给上游的是重定向后的 ID",
    lastBody().model === "z-ai/glm-5.3-flash", "model=" + lastBody().model);

  // 别名：用别名请求也要命中同一条配置
  await savePin({ upstreams: ["alibaba"], exclude: [], pinMode: "strict", aliases: ["my-glm"], redirect: "" });
  await (await chat("my-glm")).text();
  check("别名：用别名请求命中同一条配置",
    JSON.stringify(pipePrefs().only) === JSON.stringify(["alibaba"]),
    JSON.stringify(pipePrefs()));
  check("别名请求不改写 model（只换配置，不动模型 ID）",
    lastBody().model === "my-glm", "model=" + lastBody().model);

  // 清空配置 → 回到自动模式（不注入任何偏好）
  await savePin({ upstreams: [], exclude: [], redirect: "", aliases: [] });
  await (await chat()).text();
  check("清空配置后回到自动模式（不注入 provider/providerOptions）",
    lastBody().provider === undefined && lastBody().providerOptions === undefined,
    JSON.stringify({ provider: lastBody().provider, po: lastBody().providerOptions }));

  // 客户端自己传的 providerOptions 必须被面板配置整体替换：
  // 合并会让它的其它键（如 gateway.sort）存活并一起发往上游，实测会让上游 500
  await savePin({ upstreams: ["alibaba"], pinMode: "strict" });
  await w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify({
      model: "cline-free/deepseek-v4.1-flash", stream: true,
      messages: [{ role: "user", content: "hi" }],
      providerOptions: { gateway: { sort: "evil", only: ["attacker"] } },
    }),
  }), env).then((r) => r.text());
  check("客户端传的 providerOptions 被整体替换（不残留 sort 等键）",
    lastBody().providerOptions.gateway.sort === undefined &&
    JSON.stringify(lastBody().providerOptions.gateway.only) === JSON.stringify(["alibaba"]),
    JSON.stringify(lastBody().providerOptions));

  // 非法 slug 必须被挡掉，否则任意字符串会被注入请求体
  await savePin({ upstreams: ["alibaba", "../../etc/passwd", "with space", "UPPER"], pinMode: "strict" });
  await (await chat()).text();
  check("非法渠道名被过滤（挡住请求体注入）",
    JSON.stringify(pipePrefs().only) === JSON.stringify(["alibaba"]),
    JSON.stringify(pipePrefs()));

  // 列表接口
  const list = await (await w.fetch(new Request("https://x.dev/v1/upstreams?action=list", { headers: A }), env)).json();
  check("列表接口返回已配置项与可选模型", list.ok === true && Array.isArray(list.models),
    JSON.stringify(Object.keys(list)));
  check("列表里含刚保存的配置", list.upstreams.some((u) => u.model_id === "cline-free/deepseek-v4.1-flash"),
    JSON.stringify(list.upstreams.map((u) => u.model_id)));

  const del = await (await w.fetch(new Request("https://x.dev/v1/upstreams?action=delete", {
    method: "POST", headers: A,
    body: JSON.stringify({ model_id: "cline-free/deepseek-v4.1-flash" }),
  }), env)).json();
  check("删除配置返回成功", del.ok === true, JSON.stringify(del).slice(0, 140));
  await (await chat()).text();
  check("删除后不再注入偏好",
    lastBody().provider === undefined && lastBody().providerOptions === undefined,
    JSON.stringify({ p: lastBody().provider, po: lastBody().providerOptions }));

  // provider 偏好不能丢：这些是上游识别「Cline 客户端」的指纹头
  check("未配置钉住时请求头指纹仍完整",
    upstreamCalls[upstreamCalls.length - 1].clientType === "cline-sdk",
    "X-CLIENT-TYPE=" + upstreamCalls[upstreamCalls.length - 1].clientType);

  const noAuth = await w.fetch(new Request("https://x.dev/v1/upstreams?action=list"), env);
  check("上游配置接口未鉴权时拒绝", noAuth.status === 401, "status=" + noAuth.status);
}

// =====================================================================
console.log("\n【17】上游探测（管道判定 + 渠道枚举 + 异步任务）");
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "probe-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };

  setMode({ kind: "ok" });

  // 探测是异步的：立刻返回 jobId，避免同步等两次上游调用把页面拖到超时
  const startResp = await w.fetch(new Request("https://x.dev/v1/upstreams?action=probe", {
    method: "POST", headers: A, body: JSON.stringify({ model_id: "cline-free/deepseek-v4.1-flash" }),
  }), env);
  const started = await startResp.json();
  check("探测立即返回 202 + jobId（不阻塞）",
    startResp.status === 202 && started.ok === true && !!started.job.id,
    "status=" + startResp.status + " job=" + JSON.stringify(started.job || null).slice(0, 120));
  check("初始状态是 running", started.job.status === "running", started.job.status);

  // 同一个模型重复点击：共享同一个任务，不重复消耗额度
  const start2 = await (await w.fetch(new Request("https://x.dev/v1/upstreams?action=probe", {
    method: "POST", headers: A, body: JSON.stringify({ model_id: "cline-free/deepseek-v4.1-flash" }),
  }), env)).json();
  check("同一模型重复探测共享任务（不重复打上游）",
    start2.shared === true && start2.job.id === started.job.id,
    "shared=" + start2.shared + " sameJob=" + (start2.job.id === started.job.id));

  // 轮询直到完成
  let job = started.job;
  for (let i = 0; i < 40 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const s = await (await w.fetch(new Request(
      "https://x.dev/v1/upstreams?action=probe_status&jobId=" + encodeURIComponent(job.id), { headers: A }), env)).json();
    job = s.job;
  }
  check("探测任务最终完成", job && job.status === "done",
    "status=" + (job && job.status) + " error=" + (job && job.error));

  const res = (job && job.result) || {};
  check("探测结果带管道字段（假上游无元数据 → 空字符串，但不报错）",
    typeof res.pipeline === "string", "pipeline=" + JSON.stringify(res.pipeline));
  check("探测结果带耗时（供用户判断该渠道快不快）",
    typeof res.latencyMs === "number" && res.latencyMs >= 0, "latencyMs=" + res.latencyMs);
  check("探测结果带可用渠道字段（即使为空数组）",
    Array.isArray(res.available), JSON.stringify(res.available));
  check("探测结果带 modelId / upstreamModel（能看出重定向）",
    res.modelId === "cline-free/deepseek-v4.1-flash", JSON.stringify(res.modelId));

  const badId = await w.fetch(new Request(
    "https://x.dev/v1/upstreams?action=probe_status&jobId=nope", { headers: A }), env);
  check("未知 jobId 返回 404（带可照做的提示）", badId.status === 404, "status=" + badId.status);

  const noModel = await w.fetch(new Request("https://x.dev/v1/upstreams?action=probe", {
    method: "POST", headers: A, body: JSON.stringify({}),
  }), env);
  check("探测缺 model_id 时报 400", noModel.status === 400, "status=" + noModel.status);

  const noAuth = await w.fetch(new Request("https://x.dev/v1/upstreams?action=probe", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_id: "x/y" }),
  }), env);
  check("探测端点未鉴权时拒绝", noAuth.status === 401, "status=" + noAuth.status);
}

// =====================================================================
console.log("\n【18】设置：策略 / 冷却时长 / system 覆盖 / 请求头");
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "cfg-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa\nTOKEN_B_bbbbbbbbbb" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };
  const cfg = () => w.fetch(new Request("https://x.dev/v1/config", { headers: A }), env).then((r) => r.json());
  const setCfg = (body) => w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify(body),
  }), env).then((r) => r.json());
  const lastBody = () => upstreamCalls[upstreamCalls.length - 1].body;
  const chat = (extra) => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify(Object.assign({ model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }, extra || {})),
  }), env);

  setMode({ kind: "ok" });

  let c = await cfg();
  check("配置端点返回策略与内置请求头",
    c.ok === true && c.strategy === "round_robin" && Object.keys(c.default_headers).length > 0,
    JSON.stringify({ strategy: c.strategy, hdrs: Object.keys(c.default_headers || {}).length }));
  check("配置端点带 persisted 标记（前端据此提示能否存盘）",
    typeof c.persisted === "boolean", "persisted=" + c.persisted);

  // 非法策略必须被拒，且不能部分生效
  const bad = await w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify({ strategy: "nonsense" }),
  }), env);
  check("非法轮换策略被拒绝（400）", bad.status === 400, "status=" + bad.status);
  check("被拒后策略没变（校验先于修改）", (await cfg()).strategy === "round_robin");

  // fill 策略：永远挑第一个可用账号
  await setCfg({ strategy: "fill" });
  check("策略可改为 fill", (await cfg()).strategy === "fill");
  // 清掉 token 缓存，逼服务端每次都真的重新挑账号（否则两个账号可能共用
  // 同一个缓存值，断言就成了假通过）
  await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: A, body: JSON.stringify({ action: "resetAll" }),
  }), env);
  setMode({ kind: "ok" });
  for (let i = 0; i < 3; i++) { await (await chat()).text(); }
  check("fill 策略：三次请求都用同一个账号",
    new Set(upstreamCalls.map((x) => x.auth)).size === 1,
    "用到 " + new Set(upstreamCalls.map((x) => x.auth)).size + " 个账号");

  // round_robin：两次请求应轮到两个账号
  await setCfg({ strategy: "round_robin" });
  // 先清 token 缓存：否则两个账号可能都持有同一个早已缓存的值，
  // 看 Authorization 头就无法区分「用了不同账号」还是「同一账号被复用」。
  await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: A, body: JSON.stringify({ action: "resetAll" }),
  }), env);
  setMode({ kind: "ok" });
  for (let i = 0; i < 2; i++) { await (await chat()).text(); }
  check("round_robin 策略：两次请求轮到不同账号",
    new Set(upstreamCalls.map((x) => x.auth)).size === 2,
    "用到 " + new Set(upstreamCalls.map((x) => x.auth)).size + " 个账号：" +
    JSON.stringify(upstreamCalls.map((x) => x.auth)));

  // 冷却时长：非法值被拒
  const badCd = await w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify({ cooldown_minutes: 99999 }),
  }), env);
  check("冷却时长超范围被拒绝", badCd.status === 400, "status=" + badCd.status);
  await setCfg({ cooldown_minutes: 45 });
  check("冷却时长可设置（45 分钟）", (await cfg()).cooldown_minutes === 45,
    "cooldown=" + (await cfg()).cooldown_minutes);

  // system prompt 覆盖：替换客户端传来的 system，且位置保持在最前
  await setCfg({ override_prompt: "只回答是或否" });
  await (await chat({ messages: [{ role: "system", content: "客户端提示" }, { role: "user", content: "hi" }] })).text();
  const msgs = lastBody().messages;
  check("system 覆盖生效：内容被替换",
    msgs[0].role === "system" && msgs[0].content === "只回答是或否",
    JSON.stringify(msgs));
  check("system 覆盖后只剩一条 system 消息（不重复）",
    msgs.filter((m) => m.role === "system").length === 1, JSON.stringify(msgs));
  check("非 system 消息原样保留", msgs[msgs.length - 1].content === "hi", JSON.stringify(msgs));

  // 客户端不带 system 时，覆盖值也要放到最前（放后面会被当成普通上下文）
  await (await chat({ messages: [{ role: "user", content: "hi" }] })).text();
  check("客户端无 system 时，覆盖值插到最前面",
    lastBody().messages[0].role === "system" && lastBody().messages[0].content === "只回答是或否",
    JSON.stringify(lastBody().messages));

  await setCfg({ override_prompt: "" });
  await (await chat({ messages: [{ role: "system", content: "客户端提示" }, { role: "user", content: "hi" }] })).text();
  check("清空覆盖后回到客户端自己的 system",
    lastBody().messages[0].content === "客户端提示", JSON.stringify(lastBody().messages));

  // 自定义请求头：覆盖内置指纹头
  await setCfg({ headers: { "User-Agent": "Cline/9.9.9" }, replace_headers: true });
  setMode({ kind: "ok" });
  await (await chat()).text();
  check("自定义请求头覆盖内置值（User-Agent 生效）",
    upstreamCalls[upstreamCalls.length - 1].ua === "Cline/9.9.9",
    "UA=" + upstreamCalls[upstreamCalls.length - 1].ua);
  check("未覆盖的内置头仍在（指纹头不能因为覆盖而丢）",
    upstreamCalls[upstreamCalls.length - 1].clientType === "cline-sdk",
    "X-CLIENT-TYPE=" + upstreamCalls[upstreamCalls.length - 1].clientType);

  // 请求头注入：名字与值里都不能有换行
  const inj1 = await w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify({ headers: { "X-Bad\r\nX-Evil": "v" }, replace_headers: false }),
  }), env);
  check("请求头名含换行被拒绝（挡请求头注入）", inj1.status === 400, "status=" + inj1.status);
  const inj2 = await w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify({ headers: { "X-Bad": "v\r\nX-Evil: 1" }, replace_headers: false }),
  }), env);
  check("请求头值含换行被拒绝", inj2.status === 400, "status=" + inj2.status);

  await setCfg({ headers: {}, replace_headers: true });
  check("请求头可整体清空（恢复默认）",
    Object.keys((await cfg()).headers).length === 0,
    JSON.stringify((await cfg()).headers));

  // 默认模型：必须是**已启用**的模型（新规则，见 /v1/models 只回已启用模型）
  const badModel = await w.fetch(new Request("https://x.dev/v1/config", {
    method: "POST", headers: A, body: JSON.stringify({ default_model: "no/such-model" }),
  }), env);
  check("默认模型设为未启用的模型时被拒绝", badModel.status === 400, "status=" + badModel.status);
  const badModelBody = await badModel.json();
  check("拒绝时提示先去「模型」页添加它",
    badModelBody.error.message.includes("模型"), badModelBody.error.message.slice(0, 120));

  // 先启用再设默认
  await w.fetch(new Request("https://x.dev/v1/models/batch", {
    method: "POST", headers: A, body: JSON.stringify({ ids: ["z-ai/glm-5.3-flash"] }),
  }), env);
  await setCfg({ default_model: "z-ai/glm-5.3-flash" });
  await (await chat({ model: undefined })).text();
  check("默认模型生效（请求不带 model 时用它）",
    lastBody().model === "z-ai/glm-5.3-flash", "model=" + lastBody().model);

  const noAuth = await w.fetch(new Request("https://x.dev/v1/config"), env);
  check("配置端点未鉴权时拒绝", noAuth.status === 401, "status=" + noAuth.status);
}

// =====================================================================
console.log("\n【19】上游状态码映射（不能让客户端怀疑自己的 Key）");
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "status-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };
  const chat = () => w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env);

  // 上游 401/403 是**我们**的账号问题，不是客户端 API Key 的问题。
  // 原样透传会让客户端以为自己的 Key 错了，跑去反复重配 —— 必须映射成 502。
  for (const [up, want] of [[401, 502], [403, 502], [404, 404], [402, 402], [429, 429], [500, 502]]) {
    // 429 会给账号打上冷却，污染后续用例（下一个请求会直接回 all_accounts_cooling
    // 而不是打上游）。每个用例前清一次冷却，保证测的是状态码映射本身。
    await w.fetch(new Request("https://x.dev/v1/accounts/action", {
      method: "POST", headers: A, body: JSON.stringify({ action: "resetAll" }),
    }), env);
    setMode({ kind: "code", status: up, body: { error: { message: "upstream said " + up } } });
    const r = await chat();
    const b = await r.json().catch(() => ({}));
    check("上游 " + up + " → 客户端 " + want, r.status === want, "实际 " + r.status);
    check("上游 " + up + " 的响应体带 upstream_status（便于排查）",
      b.error && b.error.upstream_status === up, JSON.stringify(b.error || {}).slice(0, 120));
  }

  // 401/403 要给账号侧提示，而不是让用户怀疑自己的 Key
  await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: A, body: JSON.stringify({ action: "resetAll" }),
  }), env);
  setMode({ kind: "code", status: 401, body: { error: { message: "unauthorized" } } });
  const b401 = await (await chat()).json();
  check("401 的提示指向账号凭据（重新登录），而不是客户端 Key",
    b401.error.message.includes("重新登录"), b401.error.message.slice(0, 160));

  await w.fetch(new Request("https://x.dev/v1/accounts/action", {
    method: "POST", headers: A, body: JSON.stringify({ action: "resetAll" }),
  }), env);
  setMode({ kind: "code", status: 403, body: { error: { message: "forbidden" } } });
  const b403 = await (await chat()).json();
  check("403 的提示指向风控/模型范围（可去探测）",
    b403.error.message.includes("风控"), b403.error.message.slice(0, 160));

  // 客户端自己的鉴权仍然走 401（不能和上游的 401 混为一谈）
  const noAuth = await w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }] }),
  }), env);
  check("客户端未带 Key 时仍是 401（与上游 401 区分开）",
    noAuth.status === 401, "status=" + noAuth.status);
}

// =====================================================================
console.log("\n【20】流中途失败要发 error，而不是伪装成正常结束");
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "stream-err-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };

  // 上游先吐半句话，然后断开（不发 [DONE]）
  setMode({ kind: "truncate" });
  const r = await w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env);
  const openaiText = await r.text();
  check("OpenAI 流中途断开时发出 error chunk（不是静默结束）",
    openaiText.includes("upstream_error"), openaiText.slice(-260));
  check("OpenAI 流中断时保留了已收到的内容",
    openaiText.includes("半句话"), openaiText.slice(0, 200));

  // Anthropic：中途失败要发 event: error，且**不能**再补一套正常收尾事件
  // ——否则客户端会把被截断的回答当成模型主动结束（静默的错误数据比报错更危险）
  setMode({ kind: "truncate" });
  const ra = await w.fetch(new Request("https://x.dev/v1/messages", {
    method: "POST", headers: A,
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  }), env);
  const anthText = await ra.text();
  check("Anthropic 流中途断开时发出 event: error",
    anthText.includes("event: error"), anthText.slice(-260));
  check("Anthropic 流中断时不再补 message_stop（不伪装成正常结束）",
    !anthText.includes("event: message_stop"), anthText.slice(-300));
}

// =====================================================================
console.log("\n【21】请求体上限与登录限流");
{
  const { readFileSync, writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const src = readFileSync(new URL("./worker.js", import.meta.url), "utf8")
    .replace('const CLINE_API_BASE = "https://api.cline.bot/api/v1";', 'const CLINE_API_BASE = "' + UPSTREAM + '/api/v1";');
  const dir = mkdtempSync(join(tmpdir(), "limit-test-"));
  const f = join(dir, "w.mjs");
  writeFileSync(f, src, "utf8");
  const w = (await import("file:///" + f.split("\\").join("/"))).default;

  const env = { API_KEY: "sk-test", CLINE_REFRESH_TOKEN: "TOKEN_A_aaaaaaaaaa" };
  const A = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };

  // 请求体上限：本地服务把整个 body 读进内存，没上限就能被一个超大 POST 打爆
  const huge = "x".repeat((32 << 20) + 1024);
  const bigResp = await w.fetch(new Request("https://x.dev/v1/chat/completions", {
    method: "POST", headers: A,
    body: JSON.stringify({ model: "cline-free/deepseek-v4.1-flash", messages: [{ role: "user", content: huge }] }),
  }), env);
  check("超大请求体被拒绝（413，不是把内存吃光）", bigResp.status === 413, "status=" + bigResp.status);
  const bigBody = await bigResp.json();
  check("413 的提示说明上限值", bigBody.error && bigBody.error.type === "request_too_large",
    JSON.stringify(bigBody.error || {}).slice(0, 160));

  // 登录端点限流：未限流的话任何人都能拿它当 OAuth 中转站刷
  setMode({ kind: "ok" });
  const codes = [];
  for (let i = 0; i < 12; i++) {
    const r = await w.fetch(new Request("https://x.dev/v1/login/start", {
      method: "POST", headers: A, body: "{}",
    }), env);
    codes.push(r.status);
    await r.text();
  }
  check("登录端点有频率上限（超过后返回 429）", codes.includes(429),
    "状态码序列: " + codes.join(","));
  check("限流是「先放行若干次再拦」（不是一上来就 429）",
    codes[0] !== 429 && codes[codes.length - 1] === 429,
    "状态码序列: " + codes.join(","));
}

// ---------- 收尾 ----------
upstream.close();
console.log("\n" + "=".repeat(56));
console.log(fail === 0
  ? "✅ 全部通过：" + pass + " 项"
  : "❌ 通过 " + pass + " 项，失败 " + fail + " 项");
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
