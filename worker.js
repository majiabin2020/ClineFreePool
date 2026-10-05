/**
 * ClineFreePool - Cloudflare Workers 版
 *
 * 把 Cline (https://cline.bot) 的免费模型能力转成 OpenAI / Anthropic 兼容 API。
 *
 * 来源：基于 https://github.com/Patrick-mufeng/cline-free 继续开发（直接代码基础），
 *       其来源链条为 pingmike2/cline2api-workers → luawei1/cline2api (Go 版反向代理)。
 *
 * 核心逻辑：
 *  1. 每次请求用 refreshToken 换 accessToken（缓存到内存，过期自动刷新）
 *  2. 把 OpenAI / Anthropic 请求转发到 https://api.cline.bot/api/v1/chat/completions
 *  3. SSE 流式响应剥掉上游 {data:{...}} 包装，透传给客户端
 *
 * 环境变量：
 *  - CLINE_REFRESH_TOKEN (必需)  Cline 账号的 refreshToken，一行一个支持多账号
 *  - API_KEY           (必需)  客户端访问密钥；未配置时聊天端点一律返回 401（fail-closed）
 *
 * 关于 API_KEY 的说明（澄清一处上游文档错误）：
 *   早期注释写的「不设置则每次部署随机生成并打印到日志」从未实现过，
 *   当时实际行为是回退到硬编码的公开默认值 cline2api-default-key，
 *   等于把账号额度开放给任何知道该默认值的人。现在改为 fail-closed：
 *   没配 API_KEY 就拒绝，绝不回退到公开默认值。
 *   （本地运行 node local-server.js 时会自动生成并写入 .env.local，无需手填。）
 *
 * 用法（OpenAI 兼容）：
 *   curl https://你的worker/v1/chat/completions \
 *     -H "Authorization: Bearer <API_KEY>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"model":"cline/deepseek-v4-flash","messages":[{"role":"user","content":"hi"}]}'
 */

const CLINE_API_BASE = "https://api.cline.bot/api/v1";

// WorkOS 设备授权流程（与 cline_oauth.py 同源），用于控制台里点按钮登录账号
const WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device";
const WORKOS_AUTH = "https://api.workos.com/user_management/authenticate";
const CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register";
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

// 账号池：支持多个 Cline 账号，每个账号独立缓存 accessToken
// CLINE_REFRESH_TOKEN 环境变量可包含多行，每行一个 refreshToken，
// 额度用尽(空响应)时自动轮换下一个账号。
// 结构：{ refreshToken, accessToken, expiry, cooldownUntil }
// 另有三个控制台用的字段：
//   id      前端用来标识账号（token 的短哈希，不可逆，不泄露 token）
//   enabled 是否参与轮询；停用后跳过但不从池里移除（环境变量账号只能这样"下线"）
//   stats   成功/失败计数与最后一次错误，供控制台展示
let accounts = [];
// 运行时通过控制台登录追加的账号存在 runtimeState.dynamicAccounts 里（见「运行时
// 设置」一节）。本地运行时由 local-server.js 落盘，所以**重启不丢**；云端没有可写
// 磁盘，仍只活在内存里，登录成功页会提示把 refreshToken 存进环境变量。
let accountIndex = 0;          // round-robin 游标
let currentAccount = null;     // 当前正在使用的账号（串行队列下安全）

// ===========================================================================
// 模型库
//
// 数据来自 Cline 官方的两个接口（都只对 cline 自家域名放行 CORS，浏览器直连会被
// 拦截，所以统一由服务端抓取后转发给控制台）：
//
//   /ai/cline/recommended-models  按用途分好的几组（推荐 / free / Pass / Cloud，
//                                 实测 24 条），带 name / description / tags
//   /ai/cline/models              上游全部可选模型（实测 446 条、约 500 KB），
//                                 带 context_length / pricing 等字段
//
// 与旧实现（自动聚合免费白名单）的关键差别：**/v1/models 只回控制台里启用的模型**。
// 旧实现把所有"实测免费"的模型自动塞给客户端，等于替用户做了选择，也没法控制客户端
// 看到什么；现在由用户在面板里挑，挑过的才出现在 /v1/models。
//
// 与之配套的一条约束：默认空列表时**实时取上游免费清单**，不让新装的人拿到空列表。
// 同时刻意不做本地硬编码——免费通道是轮换促销，写死的清单必然过期。
// ===========================================================================

// ── 免费模型的唯一真相来源 =上游，不做本地硬编码─────────────────────────
//
// 设计原因：上游的免费通道是**轮换促销**（官方原文 rotating, limited-time），
// 今天免费的那批过段时间可能就下线了。任何写死在代码里的"免费清单"都会过期，
// 表现为客户端拿到一批已失效的模型 ID、调用时 404/429。因此：
//
//   · 不再有 BUILTIN_MODELS 硬编码列表；
//   · 没有任何已启用模型时，/v1/models 实时向上游 recommended-models 取
//     free 分组（外加 recommended 分组里同属免费额度的那部分）；
//   · 取不到才回落到"空 + 明确报错"，而不是拿陈旧列表糊弄客户端。
//
// 另一个刻意的取舍：**0.5 美元新人额度与需订阅的付费模型一律不展示**。
// 那点额度聊胜于无，展示了反而让用户以为能白嫖，结果一调就402，反而更糟。

// 推荐清单的固定分组展示顺序；上游新增的分组按字典序排在末尾（不静默丢弃）。
// 注意：clinePass / clineCloud 属订阅与云端额度，ClineFreePool 不展示，见上方说明。
// ⚠️ **只保留 free 分组，刻意不展示 recommended。**
//
// 上游的 `recommended` 分组（实测 6 个）里装的是 claude-opus-5.5 / gpt-6-astra /
// kimi-k3 这类**付费旗舰模型**——它们走的是账号余额（新用户 0.5 美元），不是免费额度。
// 面板曾把它标成「默认走免费额度」，是错的：那点额度聊胜于无，点一下就烧掉大半。
// 既然本项目的定位是免费额度池，就不该把它们摆在「可用模型」里充数。
//
// 判定依据是**分组归属**而非 cost 字段——实测上游返回的条目里 cost 恒为 null，
// 不可依赖。free 分组的模型 ID 则明确带 `cline-free/` 前缀或 `:free` 后缀，可作交叉验证。
const RECOMMENDED_GROUP_ORDER = ["free"];
const RECOMMENDED_GROUP_META = {
  free: { title: "免费模型", sub: "走免费额度，不需要 credits", color: "var(--ok)" },
};

// 两个清单共用的缓存时长：同一个上游、同一类使用节奏，没有理由不同。
const MODEL_CACHE_TTL = 30 * 60 * 1000;

// 抓取超时。全部模型那份约 500 KB，给宽一点的时限——超时是硬失败，面板只能报错，
// 代价比多等几秒大得多。
const RECOMMENDED_TIMEOUT_MS = 15000;
const CATALOG_TIMEOUT_MS = 30000;

// 单次批量添加的条数上限。上游「全部模型」目前 446 条，这里是它的两倍多，
// 既容得下正常用法（整组添加），也挡住异常的巨大数组。
const MAX_BATCH_MODEL_IDS = 1000;

// 模型 ID 里一律禁止的字符。选取原则：只禁掉"不可能出现在任何模型标识里、
// 但会破坏下游字符串语法"的字符，避免收得过紧误伤真实模型名——像
// openai/gpt-4.1-nano、cline-pass/qwen3.7-max 这类含 / . - 的 ID 必须照常可用。
const MODEL_ID_FORBIDDEN = /[|'"`\\<>]/;
const MAX_MODEL_ID_LENGTH = 200;

const MODEL_CATALOG_URL = CLINE_API_BASE + "/ai/cline/models";
const RECOMMENDED_URL = CLINE_API_BASE + "/ai/cline/recommended-models";

// 缓存。分两份，各自独立刷新：面板的推荐分组先加载，全部模型只在用户展开折叠块时抓。
const modelCache = {
  recommended: { groups: null, at: 0, inflight: null },
  catalog: { models: null, at: 0, inflight: null },
};

// 模型 ID 归一化：只去首尾空白。
//
// ⚠️ 刻意**不**去掉 `~` 前缀。上游清单里那 18 条 `~xxx-latest` 的波浪号是 ID 本身的
// 一部分——上游自己回给我们的 canonical_slug 也带着它，而且每个 `~X` 在清单里都没有
// 对应的非波浪号版本。旧实现把它当"别名标记"剥掉，那是基于一个已证实不成立的假设；
// 在现在这套「启用的模型原样发给上游」的架构下，剥掉只会把这些模型打成不存在的 ID。
function normalizeModelId(id) {
  const raw = String(id === null || id === undefined ? "" : id);
  return raw.trim();
}

// 模型 ID 校验。新增路径才需要它把门（见 normalizeExistingModelId 的说明）。
function validateModelId(id) {
  const s = normalizeModelId(id);
  if (!s) return { ok: false, error: "模型 ID 不能为空" };
  if (s.length > MAX_MODEL_ID_LENGTH) {
    return { ok: false, error: "模型 ID 过长（上限 " + MAX_MODEL_ID_LENGTH + " 字符）" };
  }
  if (MODEL_ID_FORBIDDEN.test(s)) {
    return { ok: false, error: "模型 ID 含非法字符（不允许 | ' \" ` \\ < >）" };
  }
  return { ok: true, id: s };
}

// 已存在的模型 ID 只做 ~ 归一化，不跑字符集校验。
//
// 为什么分开：校验只用于「新增」时把关，而下面这些路径面对的是**已经存下来的**
// 历史数据。若在删除/设默认值也跑严格校验，早期入库的非法 ID 会变得
// 「列得出来、却删不掉、也设不成默认」——删除是清理它们的唯一出口。
function normalizeExistingModelId(id) {
  return normalizeModelId(id);
}

// ---------------------------------------------------------------------------
// 「已启用模型」状态（存在 runtimeState.models 里，随设置一起落盘）
// ---------------------------------------------------------------------------

function enabledModels() {
  if (!Array.isArray(runtimeState.models)) runtimeState.models = [];
  return runtimeState.models;
}

function isModelEnabled(id) {
  const norm = normalizeExistingModelId(id);
  return enabledModels().some((x) => normalizeExistingModelId(x) === norm);
}

// 真正生效的模型列表：用户在面板里启用过的；一个都没有时**实时取上游 free 分组**。
//
// 早期版本这里回退到硬编码的 BUILTIN_MODELS，但免费通道是轮换促销，写死的清单
// 迟早过期。现在改为向上游要当前的免费清单（见 resolveLiveFreeModelIds），
// 拿不到就返回空并让上层如实报错，不用陈旧数据糊弄客户端。
function effectiveModelIds() {
  const list = enabledModels();
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const id = normalizeModelId(raw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of list) push(id);
  // 注意：这里刻意**不**就地回退。上游清单是异步取的，由ensureFreeModelFallback()
  // 在请求链路里补齐（见下方注释），避免把一个async 依赖塞进所有同步调用点。
  return out;
}

// 上游免费清单的同步快照缓存。recommended-models 拉一次会返回全部分组，
// 这里只留 free + recommended 两个分组里的模型，且在内存里缓存到过期为止，
// 供 /v1/models 这类同步路径读取。
let liveFreeModelCache = { ids: [], at: 0 };

// 缓存有效期：10 分钟。上游促销变动不频繁，10 分钟足够新鲜又不会每请求都打上游。
const LIVE_FREE_TTL_MS = 10 * 60 * 1000;

// 从上游 recommended-models 里抽出当前的免费模型 ID。
// 分组取 recommended + free：前者官方标注「默认走免费额度」，后者是纯免费组。
// 刻意排除 clinePass / clineCloud —— 那些要订阅或云端额度，不属于"免费"。
async function fetchLiveFreeModelIds() {
  if (liveFreeModelCache.ids.length && Date.now() - liveFreeModelCache.at < LIVE_FREE_TTL_MS) {
    return liveFreeModelCache.ids.slice();
  }
  let groups = [];
  try {
    groups = parseRecommendedModels(await fetchUpstreamJson(RECOMMENDED_URL, RECOMMENDED_TIMEOUT_MS));
  } catch {
    return liveFreeModelCache.ids.slice();   // 上游挂了就用旧快照；没有就返回空
  }
  const ids = [];
  const seen = new Set();
  for (const key of RECOMMENDED_GROUP_ORDER) {
    const g = groups.find((x) => x.key === key);
    if (!g) continue;
    for (const m of g.models || []) {
      const id = normalizeModelId(m.id || m.canonical_slug);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  // 上游一个免费模型都没给（促销全下线）时，保留旧快照总比给空强——但要如实记为过期。
  if (ids.length) liveFreeModelCache = { ids, at: Date.now() };
  return liveFreeModelCache.ids.slice();
}

// 在请求链路里补齐"用户一个模型都没启用"的情况。
// 挂在模型库里（而不是每个同步调用点），是因为只有 HTTP 入口能等异步。
// 返回 true 表示已把最终生效列表写进 runtimeState.enabledModels。
async function ensureFreeModelFallback() {
  if (effectiveModelIds().length) return true;
  const live = await fetchLiveFreeModelIds();
  if (!live.length) return false;
  // 直接写进 enabledModels：这样 /v1/models、defaultModelId() 等所有同步路径
  // 都能看到同一份列表，不需要各自再判断一次"是不是回退状态"。
  runtimeState.enabledModels = live.slice();
  return true;
}

const DEFAULT_MODEL_MARK = "（当前默认）";

function modelIdInUse(id) {
  const norm = normalizeExistingModelId(id);
  return effectiveModelIds().some((x) => x === norm);
}

// 默认模型：用户设的（且还在启用列表里），否则启用列表的第一个。
//
// "还在启用列表里"这个条件不能省：用户把设成默认的模型删掉后，若不回退，
// 所有不带 model 的请求都会打到一个已被撤下的模型上。
function defaultModelId() {
  const want = normalizeExistingModelId(runtimeState.defaultModel || "");
  if (want && modelIdInUse(want)) return want;
  const eff = effectiveModelIds();
  return eff[0] || DEFAULT_MODEL;
}

// 批量启用：语义与逐个启用等价，但只落盘一次（见 handleModelBatchAdd 的说明）。
// 返回 { added, skipped, failed }，重复项计入 skipped 而不是报错 —— 因此
// 「全部添加」可以安全地重复点击。
function addModelIds(ids) {
  const added = [];
  const skipped = [];
  const failed = {};
  const list = enabledModels();
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const v = validateModelId(raw);
    if (!v.ok) { failed[String(raw)] = v.error; continue; }
    if (seen.has(v.id)) { skipped.push(v.id); continue; }
    seen.add(v.id);
    if (list.some((x) => normalizeExistingModelId(x) === v.id)) { skipped.push(v.id); continue; }
    added.push(v.id);
  }
  if (!added.length) return { added, skipped, failed };
  // 先把内存改完，最后统一落一次盘（调用方负责 scheduleStateFlush）
  const prev = list.slice();
  for (const id of added) list.push(id);
  runtimeState.models = list;
  // 落盘失败无法回滚（没有同步的写盘结果），但下一次 flush 会重试——
  // 这里记一条日志让用户能察觉，比静默丢改动好。
  return { added, skipped, failed, prev };
}

function removeModelId(id) {
  const target = normalizeExistingModelId(id);
  const list = enabledModels();
  const filtered = list.filter((x) => normalizeExistingModelId(x) !== target);
  if (filtered.length === list.length) return false;
  runtimeState.models = filtered;
  // 删掉的正好是默认模型：清空，让 defaultModelId() 回退到列表第一个
  if (normalizeExistingModelId(runtimeState.defaultModel || "") === target) {
    runtimeState.defaultModel = "";
  }
  return true;
}

// ---------------------------------------------------------------------------
// 上游抓取
// ---------------------------------------------------------------------------

async function fetchUpstreamJson(url, timeoutMs) {
  const resp = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (cline2api)" },
  }, timeoutMs);
  if (!resp.ok) {
    await resp.text().catch(() => "");
    throw new Error("上游返回 HTTP " + resp.status);
  }
  // 约 500 KB 的响应体；上限 4 MiB 兜底，避免异常大响应把内存吃掉
  const text = await resp.text();
  if (text.length > (4 << 20)) throw new Error("上游响应过大");
  return JSON.parse(text);
}

// 解析推荐清单成有序分组。
//
// ⚠️ 只保留 RECOMMENDED_GROUP_ORDER 里的免费分组。上游还有 clinePass（需订阅）
// 与 clineCloud（走云端额度）两组，本项目**刻意不展示**它们：ClineFreePool 只做免费额度，
// 展示订阅制模型只会让用户以为能白嫖，点下去却402/403，体验反而更差。
// 上游若新增分组也不静默丢弃——按字典序追加（仍不含付费组）。
function parseRecommendedModels(raw) {
  const groups = [];
  const keys = raw && typeof raw === "object" ? Object.keys(raw) : [];
  for (const key of RECOMMENDED_GROUP_ORDER) {
    const arr = raw[key];
    if (!Array.isArray(arr) || !arr.length) continue;
    groups.push({ key, models: arr.filter((m) => m && m.id).map(normalizeRemoteModel) });
  }
  // 其余分组一律不展示：recommended 是付费旗舰（烧余额），clinePass 要订阅，
  // clineCloud 走云端额度。上游若新增分组同样不自动带上——宁可少展示，
  // 也不把付费模型混进「免费额度池」里误导用户。
  const total = groups.reduce((n, g) => n + g.models.length, 0);
  if (!total) throw new Error("上游返回的免费模型列表为空");
  return groups;
}

// 需付费 / 订阅才能用的分组。用于前端展示与上游解析两处过滤。
function isPaidGroupKey(key) {
  return /^(cline-?pass|cline-?cloud)$/i.test(String(key || ""));
}

// 上游条目的字段保留策略：
//   id / name / description / tags —— 面板要用（tags 渲染 NEW 角标）
//   context_length / pricing       —— 全部模型清单才有，用于展示上下文与是否免费
// 其余字段（architecture / supported_parameters / top_provider …）在解析时丢弃：
// 完整响应约 500 KB，只留这几个能把面板拿到的数据量降一个数量级。
function normalizeRemoteModel(m) {
  const id = String(m.id || "");
  return {
    id,
    name: typeof m.name === "string" && m.name ? m.name : id,
    description: typeof m.description === "string" ? m.description : "",
    tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === "string" && t) : [],
    context_length: Number(m.context_length) || 0,
    pricing: m.pricing && typeof m.pricing === "object" ? m.pricing : null,
  };
}

function parseCatalogModels(raw) {
  const data = raw && Array.isArray(raw.data) ? raw.data : null;
  if (!data || !data.length) throw new Error("上游返回的模型列表为空");
  return data.filter((m) => m && m.id).map(normalizeRemoteModel);
}

// 取数 + 缓存。语义（与上游一致，刻意做成同一个形状）：
//   force 或缓存过期 → 回源
//   fresh 未过期     → 直接返回缓存
//   回源失败         → 退回过期缓存（stale=true）而不是让面板空白
//
// 网络请求放在锁外，且用 inflight 合并并发回源：面板刚打开时可能同时触发
// 推荐分组与全部模型两个请求，各自 back-to-back 会打两次上游。
async function cachedFetch(slot, force, fetchFn) {
  const now = Date.now();
  const fresh = slot.groups !== null || slot.models !== null;
  const hasData = slot.groups !== null || slot.models !== null;
  const age = now - slot.at;

  if (!force && hasData && age < MODEL_CACHE_TTL) {
    return { cached: true, stale: false };
  }
  if (slot.inflight) {
    // 已有一次回源在跑：等它，避免并发重复打上游
    try { await slot.inflight; } catch (e) { /* 失败由发起方处理 */ }
    return { cached: true, stale: false };
  }

  const run = (async () => {
    const data = await fetchFn();
    if (slot.groups !== null || slot.models !== null) {
      slot.data = data;
    }
    // 用统一字段存：groups 与 models 二选一，读的时候按同样的名字取
    slot.groups = data.groups || null;
    slot.models = data.models || null;
    slot.at = Date.now();
    slot.err = "";
  })();
  slot.inflight = run;
  try {
    await run;
    return { cached: false, stale: false };
  } catch (e) {
    // 回源失败：有旧数据就退回旧的（标记 stale 让面板提示），没有就报错
    if (hasData) {
      slot.err = String((e && e.message) || e);
      return { cached: true, stale: true, error: slot.err };
    }
    throw e;
  } finally {
    slot.inflight = null;
  }
}

async function recommendedSnapshot(force) {
  const slot = modelCache.recommended;
  const res = await cachedFetch(slot, force, async () => ({
    groups: parseRecommendedModels(await fetchUpstreamJson(RECOMMENDED_URL, RECOMMENDED_TIMEOUT_MS)),
  }));
  return {
    groups: slot.groups || [],
    fetchedAt: slot.at,
    cached: res.cached,
    stale: !!res.stale,
    error: res.error || "",
    isFresh: !res.cached,
  };
}

async function catalogSnapshot(force) {
  const slot = modelCache.catalog;
  const res = await cachedFetch(slot, force, async () => ({
    models: parseCatalogModels(await fetchUpstreamJson(MODEL_CATALOG_URL, CATALOG_TIMEOUT_MS)),
  }));
  return {
    models: slot.models || [],
    fetchedAt: slot.at,
    cached: res.cached,
    stale: !!res.stale,
    error: res.error || "",
    isFresh: !res.cached,
  };
}

// 按模型 ID 的供应商前缀分组（上游没有可用的供应商字段，而 id 本身就是
// vendor/model 形式，所以以前缀为准）。
//
// `~` 前缀只在这里剥掉、**只用于分组**：`~deepseek/deepseek-pro-latest` 的供应商是
// deepseek 而不是 "~deepseek"，但 ID 本身必须原样保留（波浪号是它的一部分）。
//
// 组按模型数从多到少排、组内按名称排 —— 上游返回顺序不保证稳定，按固定规则排序
// 才能让每次渲染结果一致。
function groupCatalogModels(models) {
  const map = new Map();
  for (const m of models) {
    const key = normalizeModelId(m.id).replace(/^~/, "").split("/")[0] || "其它";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  const groups = [];
  for (const [key, list] of map) {
    list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    groups.push({ key, models: list });
  }
  groups.sort((a, b) => b.models.length - a.models.length || a.key.localeCompare(b.key));
  return groups;
}

// ---------------------------------------------------------------------------
// 「模型已启用」视图：把启用列表补上展示所需的元信息
//
// 启用列表本身只存 ID（落盘文件越小越好，上游数据随时会变，存快照等于埋下过期数据）。
// 展示时现查推荐/全部模型缓存补 name / description / context —— 缓存里没有的（比如
// 用户手填的 ID、或上游已下架的）就退回把 ID 当名字显示，不假装知道。
// ---------------------------------------------------------------------------

function findRemoteModel(id) {
  const norm = normalizeModelId(id);
  for (const slot of [modelCache.catalog, modelCache.recommended]) {
    const lists = slot.models ? [slot.models] : (slot.groups || []).map((g) => g.models);
    for (const list of lists) {
      for (const m of list) if (normalizeModelId(m.id) === norm) return m;
    }
  }
  return null;
}

function modelView(id) {
  const norm = normalizeModelId(id);
  const remote = findRemoteModel(norm);
  return {
    id: norm,
    name: (remote && remote.name) || norm,
    description: (remote && remote.description) || "",
    context_length: (remote && remote.context_length) || 0,
    pricing: (remote && remote.pricing) || null,
    is_default: normalizeExistingModelId(runtimeState.defaultModel || "") === norm,
    // 该模型是否来自上游当前的免费清单（而不是用户手工启用）。
    // 面板据此标注"免费 · 上游当前提供"，让用户知道它的时效性。
    builtin: liveFreeModelCache.ids.includes(norm),
  };
}

// 上游缓存里查得到这个模型吗？用于提示"手填的 ID 可能拼错了"。
// 只在下游都不认识时才返回 false；两份缓存都还没抓过时返回 true（不知道，别乱提示）。
function modelKnownUpstream(id) {
  const norm = normalizeModelId(id);
  const anyLoaded = modelCache.catalog.models !== null || modelCache.recommended.groups !== null;
  if (!anyLoaded) return true;
  if (findRemoteModel(norm)) return true;
  // 上游也查不到：可能是 panel 里手填的私有通道，所以只是「未确认」而不是错误
  return false;
}

// 不带 model 的请求打哪个：取生效列表的第一个（已启用优先，否则上游免费清单第一个）。
// 这里只作为**兜底**，正常路径由 defaultModelId() 从实时列表里取，因此这里刻意留空——
// 写死一个具体ID 会在上游促销下线后变成"已失效的默认模型"，比没有默认值更糟。
const DEFAULT_MODEL = "";
const VERSION = "2.5.1";

// ===== 入口 =====
// Cloudflare Workers 入口。Vercel 入口由 build-vercel.mjs 依据下面的
// #region entry 标记自动生成，改动时保持这两个标记存在即可（勿手改 api/index.js）。
// #region entry
export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
// #endregion entry

// 控制台用的完整状态。与 /v1/health 的区别：本端点**需要 API_KEY**，
// 所以可以下发账号明细（邮箱、每个账号的 token 用量）。
// /v1/health 保持精简（免鉴权），只回答「服务在不在、有没有账号」。
function handleStatus(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  const summaries = accountSummaries(env);
  return jsonResponse({
    ok: true,
    version: VERSION,
    account_count: summaries.length,
    accounts_available: summaries.filter((a) => a.available).length,
    runtime_accounts: summaries.filter((a) => a.runtime).length,
    account_details: summaries,
    cooldowns: cooldownSnapshot(),
    cooldown_minutes: cooldownMinutes(),
    strategy: runtimeState.strategy,
    default_model: defaultModelId(),
    // 客户端能从 /v1/models 看到几个模型；用它替代旧的 models_cached
    models_available: effectiveModelIds().length,
    // 云端没有可写磁盘时前端要据此提示用户
    persisted: !!statePersistCb,
  }, 200, { "Cache-Control": "no-store" });
}

// ---------------------------------------------------------------------------
// 设置与上游渠道（控制台用）
// ---------------------------------------------------------------------------

// 设置项的对外视图（供控制台渲染表单）
function configView() {
  const ids = effectiveModelIds();
  return {
    strategy: runtimeState.strategy,
    headers: { ...(runtimeState.headers || {}) },
    headers_complete: !!runtimeState.headersComplete,
    default_headers: { ...CLINE_FINGERPRINT_HEADERS },
    // 默认模型下拉的选项 = 已启用模型（不是上游全部模型：四百多个没法选）
    default_model: defaultModelId(),
    default_model_options: ids.map(modelView),
    // 处于"没启用任何模型 → 回退上游免费清单"的状态吗？
    // 面板据此提示"下面这些是上游当前提供的免费模型，随时可能变动"。
    using_builtin_models: enabledModels().length === 0,
    // 当前实时取到的免费清单（供面板显示"上游免费模型"区块，不做任何硬编码）
    builtin_models: liveFreeModelCache.ids.slice(),
    free_models_source: "upstream:recommended-models",
    cooldown_minutes: cooldownMinutes(),
    override_prompt: runtimeState.overridePrompt || "",
    // 云端没有可写磁盘：告诉前端「改了能不能存住」，界面据此提示用户
    persisted: !!statePersistCb,
    version: VERSION,
  };
}

async function handleConfig(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  if (request.method === "GET") {
    return jsonResponse({ ok: true, ...configView() }, 200);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "config_error" } }, 405);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }

  // ---- 先把所有参数校验完，再做任何修改 ----
  // 否则会出现「客户端收到 400，但服务端已部分生效」的不一致。
  const next = { ...runtimeState };
  const changedCooldown = [];

  if (body.strategy !== undefined) {
    if (!["round_robin", "fill", "random"].includes(body.strategy)) {
      return jsonResponse({
        error: { message: "strategy 必须是 round_robin / fill / random 之一", type: "config_error" },
      }, 400);
    }
    next.strategy = body.strategy;
  }

  if (body.cooldown_minutes !== undefined) {
    const m = Number(body.cooldown_minutes);
    // 允许 1~1440（1 分钟到 1 天）；0 视为恢复默认
    if (!Number.isFinite(m) || m < 0 || m > 1440) {
      return jsonResponse({
        error: { message: "cooldown_minutes 必须是 0~1440（0 = 恢复默认 30）", type: "config_error" },
      }, 400);
    }
    const applied = m === 0 ? 30 : Math.round(m);
    if (applied !== cooldownMinutes()) changedCooldown.push(applied);
    next.cooldownMinutes = applied;
  }

  if (body.default_model !== undefined) {
    const id = String(body.default_model || "").trim();
    if (id) {
      // 只能把**已启用**的模型设为默认：默认模型是"不带 model 的请求打哪个"，
      // 指向一个没启用的模型会让面板显示与真实行为对不上。
      if (!isModelEnabled(id)) {
        return jsonResponse({
          error: {
            message: "默认模型必须是已启用的模型：" + id + "（请先在「模型」页添加它）",
            type: "config_error",
          },
        }, 400);
      }
      next.defaultModel = normalizeExistingModelId(id);
    } else {
      next.defaultModel = "";
    }
  }

  if (body.override_prompt !== undefined) {
    if (typeof body.override_prompt !== "string") {
      return jsonResponse({ error: { message: "override_prompt 必须是字符串", type: "config_error" } }, 400);
    }
    next.overridePrompt = body.override_prompt;
  }

  if (body.headers !== undefined) {
    if (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers)) {
      return jsonResponse({ error: { message: "headers 必须是对象", type: "config_error" } }, 400);
    }
    const clean = {};
    for (const [k, v] of Object.entries(body.headers)) {
      const key = String(k || "").trim();
      if (!key) continue;
      // 头名里不能有冒号/换行，否则会构造出畸形请求（请求头注入）
      if (/[\r\n:]/.test(key)) {
        return jsonResponse({
          error: { message: "请求头名称不合法：" + key, type: "config_error" },
        }, 400);
      }
      if (typeof v !== "string") {
        return jsonResponse({
          error: { message: "请求头 " + key + " 的值必须是字符串", type: "config_error" },
        }, 400);
      }
      if (/[\r\n]/.test(v)) {
        return jsonResponse({
          error: { message: "请求头 " + key + " 的值不能包含换行", type: "config_error" },
        }, 400);
      }
      if (v) clean[key] = v;
    }
    // replace_headers=true 表示整体替换（支持删除内置头）；否则与现有值合并
    next.headers = body.replace_headers === true ? clean : { ...(runtimeState.headers || {}), ...clean };
    next.headersComplete = body.replace_headers === true ? true : !!runtimeState.headersComplete;
  }

  runtimeState = next;
  scheduleStateFlush();
  // 冷却时长改了：已生效的冷却按旧时长算，清掉让新配置立刻生效。
  // 不清的话用户改小了值却要等旧冷却走完，会以为设置没生效。
  if (changedCooldown.length) {
    const n = clearAllCooldowns();
    if (n) console.log("[config] 冷却时长已变更，清除 " + n + " 条旧冷却记录");
  }
  return jsonResponse({ ok: true, ...configView() }, 200);
}

// 上游渠道配置（列表 / 保存 / 删除 / 探测）
async function handleUpstreams(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  const url = new URL(request.url);
  const action = (url.searchParams.get("action") || "list").trim();

  if (request.method === "GET" && action === "list") {
    // 上游渠道配置的「模型」下拉用**已启用模型**：给用户配渠道的是一个他真在用的
    // 模型，列四百多个全部模型只会让下拉变得没法用。
    const models = effectiveModelIds();
    // 把配置按「模型 ID」平铺出来，另附上别名指向的条目，前端一次就能渲染完整列表
    const items = Object.entries(runtimeState.perModel)
      .map(([modelId, cfg]) => ({ model_id: modelId, ...cfg }))
      .sort((a, b) => a.model_id.localeCompare(b.model_id));
    return jsonResponse({
      ok: true,
      upstreams: items,
      models,
      pipelines: [PIPELINE_DIRECT, PIPELINE_PLANNER],
    }, 200);
  }

  if (request.method === "GET" && action === "probe_status") {
    const id = url.searchParams.get("jobId") || "";
    const job = probeJobs.get(id);
    if (!job) {
      return jsonResponse({
        error: { message: "探测任务已过期或服务已重启，请重新探测", type: "probe_error" },
      }, 404);
    }
    return jsonResponse({ ok: true, job }, 200, { "Cache-Control": "no-store" });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "upstream_error" } }, 405);
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }

  if (action === "probe") {
    const modelId = String(body.model_id || "").trim();
    if (!modelId) {
      return jsonResponse({ error: { message: "缺少 model_id", type: "probe_error" } }, 400);
    }
    const started = startProbeJob(modelId, probeModelUpstreams, "probe");
    if (started.error) {
      return jsonResponse({ error: { message: started.error, type: "probe_error" } }, started.status,
        { "Retry-After": "2" });
    }
    return jsonResponse({
      ok: true,
      job: started.job,
      shared: started.shared,
      message: started.shared ? "该模型已有一个探测在进行，共享其结果" : "探测已开始",
    }, 202, { "Cache-Control": "no-store" });
  }

  if (action === "save") {
    const modelId = String(body.model_id || "").trim();
    if (!modelId) {
      return jsonResponse({ error: { message: "缺少 model_id", type: "upstream_error" } }, 400);
    }
    // 把面板表单的值和已有探测缓存合并：面板不提交探出来的字段，直接整体替换会
    // 把 available/pipeline 这些探测成果抹掉，用户就得重新探一次。
    const existing = runtimeState.perModel[modelId] || {};
    const merged = sanitizeUpstreamConfig({
      ...existing,
      ...body.config,
      // 探测结果永远以缓存为准，不接受表单传入
      pipeline: existing.pipeline,
      available: existing.available,
      observed: existing.observed,
      lastProvider: existing.lastProvider,
      probedAt: existing.probedAt,
    });
    if (!merged) {
      delete runtimeState.perModel[modelId];
      scheduleStateFlush();
      return jsonResponse({ ok: true, message: "已清空该模型的渠道配置（恢复自动模式）", model_id: modelId }, 200);
    }
    merged.updatedAt = Date.now();
    runtimeState.perModel[modelId] = merged;
    scheduleStateFlush();
    return jsonResponse({ ok: true, model_id: modelId, config: merged, message: "已保存" }, 200);
  }

  if (action === "delete") {
    const modelId = String(body.model_id || "").trim();
    if (!modelId) {
      return jsonResponse({ error: { message: "缺少 model_id", type: "upstream_error" } }, 400);
    }
    const existed = !!runtimeState.perModel[modelId];
    delete runtimeState.perModel[modelId];
    scheduleStateFlush();
    return jsonResponse({
      ok: true,
      message: existed ? "已删除该模型的渠道配置" : "该模型没有渠道配置",
    }, 200);
  }

  return jsonResponse({ error: { message: "未知的 action: " + action, type: "upstream_error" } }, 400);
}

async function handleRequest(request, env) {
  rememberEnv(env);
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  // 健康诊断端点（无需鉴权，用于排查环境变量是否生效）
  //
  // ⚠️ 刻意只回「能不能用」这一层信息：完整账号明细（邮箱、每个账号的用量）
  //    放在需要 API_KEY 的 /v1/accounts/action 里，因为本端点免鉴权——
  //    部署到公网时，谁都能读到它。
  if (request.method === "GET" && (path === "/v1/health" || path === "/health")) {
    const keyConfigured = !!(env.API_KEY && env.API_KEY.trim());
    const pool = listAccounts(env);
    // 「可用」= 账号启用。冷却已经是「账号×模型」级，账号本身能不能用要看
    // 具体是哪个模型，这里只回账号层的状态（明细在 /v1/status）。
    const usable = pool.filter((a) => a.enabled).length;
    return jsonResponse({
      ok: true,
      version: VERSION,
      api_key_configured: keyConfigured,
      account_count: pool.length,
      // 兼容旧字段名（README 早期版本用的是这两个）
      authenticated: keyConfigured,
      accounts: pool.length,
      accounts_available: usable,
      // 客户端能从 /v1/models 看到几个模型（含"没有启用过 → 实时取上游免费清单"的情况）
      models_available: effectiveModelIds().length,
      default_model: defaultModelId(),
      strategy: runtimeState.strategy,
      // 冷却中的组合数：介于「账号数」与「账号数×模型数」之间，是额度的真实粒度
      cooling_combinations: cooldowns.size,
      usage: usageSummary(),
    }, 200);
  }

  // 内置控制台（无前端依赖、无需构建，浏览器直接可用）
  if (request.method === "GET" && (path === "/" || path === "/index.html" || path === "/console")) {
    return new Response(CONSOLE_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // GET /v1/models — 免鉴权（GUI 验证需拉模型列表）
  if (request.method === "GET" && (path === "/v1/models" || path === "/models")) {
    return handleModels();
  }

  // ---- 需要鉴权的控制面端点 ----
  if (request.method === "POST") {
    if (path === "/v1/login/start") {
      // OAuth 中转站被滥用的话，攻击者能用你的服务白嫖设备授权流程，所以限流
      if (!allowLoginAttempt(clientIp(request))) {
        return jsonResponse({
          error: { message: "请求过于频繁，请稍后再试", type: "rate_limit_error" },
        }, 429, { "Retry-After": "60" });
      }
      return handleLoginStart(request, env);
    }
    if (path === "/v1/login/poll") return handleLoginPoll(request, env);
    if (path === "/v1/accounts/action") return handleAccountAction(request, env);
    if (path === "/v1/config") return handleConfig(request, env);
    if (path === "/v1/upstreams") return handleUpstreams(request, env);
    if (path === "/v1/models/batch") return handleModelBatchAdd(request, env);
    if (path === "/v1/models/delete") return handleModelDelete(request, env);
    if (path === "/v1/models/default") return handleModelSetDefault(request, env);
    if (path === "/v1/models/check") return handleModelCheck(request, env);
  }
  if (request.method === "GET") {
    if (path === "/v1/status") return handleStatus(request, env);
    if (path === "/v1/accounts/detail") return handleAccountDetail(request, env);
    if (path === "/v1/accounts/balance") return handleAccountBalance(request, env);
    if (path === "/v1/config") return handleConfig(request, env);
    if (path === "/v1/upstreams") return handleUpstreams(request, env);
    if (path === "/v1/models/enabled") return handleModelEnabled(request, env);
    if (path === "/v1/models/library" || path === "/v1/models/catalog") {
      return handleModelLibrary(request, env);
    }
    if (path === "/v1/models/check") return handleModelCheck(request, env);
  }

  // POST 聊天端点
  if (request.method === "POST") {
    if (path === "/v1/chat/completions" || path === "/chat/completions") {
      return handleChat(request, env);
    }
    if (path === "/v1/messages" || path === "/messages") {
      return handleAnthropic(request, env);
    }
  }

  return jsonResponse({
    error: {
      message:
        "Not found: " + request.method + " " + path +
        "。本服务是纯 API，可用端点：GET / (控制台)、GET /v1/health、GET /v1/models、" +
        "POST /v1/chat/completions、POST /v1/messages",
      type: "not_found",
    },
  }, 404);
}

// ---------------------------------------------------------------------------
// Token 管理
// ---------------------------------------------------------------------------

// 最近一次请求带来的 env。
//
// 为什么需要：后台任务（异步探测）没有请求上下文，但同样要读 CLINE_REFRESH_TOKEN
// 拿账号。Worker / Vercel 的 env 是每次调用传进来的，只能在请求入口记一份。
// 只缓存这两个键——它们就是全部运行时配置来源，且不含可变状态。
let lastEnv = { CLINE_REFRESH_TOKEN: "", API_KEY: "" };

function rememberEnv(env) {
  if (!env) return;
  lastEnv = { CLINE_REFRESH_TOKEN: env.CLINE_REFRESH_TOKEN || "", API_KEY: env.API_KEY || "" };
}

// 后台任务用的 env。没有请求上下文时（冷启动后第一个请求之前）返回上次记住的值。
function ambientEnv() {
  return lastEnv;
}

// 从环境变量解析账号池：CLINE_REFRESH_TOKEN 每行一个
// ⚠️ 重建判据必须用「环境变量原文」比较，不能逐位比较池内 refreshToken：
//    上游 /auth/refresh 会轮换 refreshToken，代码会把新 token 写回账号对象，
//    此时池内 token != 环境变量 token，若按 token 比较会导致「每次请求都重建池」，
//    连带把 accessToken 缓存和冷却状态一起清空 →
//    ① 每个请求都多打一次 /auth/refresh；② 冷却失效、429 时不切号空转重试。
let accountsRawEnv = null;   // 上次解析用的环境变量原文
let accountPoolDirty = false; // 运行时登录追加过账号，需要重建

function parseAccounts(env) {
  env = env || ambientEnv();
  const raw = env.CLINE_REFRESH_TOKEN || "";
  const tokens = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 8);

  // 环境变量里的账号 + 运行时通过控制台登录追加的账号
  const dyn = runtimeState.dynamicAccounts.filter((d) => d && d.refreshToken && d.refreshToken.length > 8);

  if (tokens.length === 0 && dyn.length === 0) {
    accounts = [];
    accountsRawEnv = raw;
    accountPoolDirty = false;
    return accounts;
  }

  // 只有环境变量原文变化（增删/调整账号）或运行时追加过账号时才重建，
  // 以保留 accessToken 缓存与冷却状态。
  //
  // 账号身份按 originToken 匹配：上游刷新时会轮换 refreshToken，池内对象的
  // refreshToken 会被换成新值，若按它比较，每次刷新都会认成"新账号"而重建，
  // 连带丢掉 token 缓存与冷却。
  const originOf = (d) => d.originToken || d.refreshToken;
  if (accountsRawEnv !== raw || accountPoolDirty || accounts.length !== tokens.length + dyn.length) {
    const old = accounts;
    const byOrigin = new Map();
    for (const a of old) if (a && a.originToken) byOrigin.set(a.originToken, a);
    const build = (rt, origin, prev) => {
      if (prev && prev.originToken === origin) {
        // 复用旧对象，但同步最新的 refreshToken（上游可能已轮换过）
        prev.refreshToken = rt;
        return prev;
      }
      return {
        refreshToken: rt,
        originToken: origin, // 用于判定账号身份（上游会轮换 refreshToken）
        accessToken: null,
        expiry: 0,
      };
    };
    const out = [];
    for (const t of tokens) {
      out.push(build(t, t, byOrigin.get(t)));
    }
    // 运行时账号接在环境变量账号之后，同 token 不重复计入
    for (const d of dyn) {
      if (tokens.includes(d.refreshToken)) continue;
      const origin = originOf(d);
      const acct = build(d.refreshToken, origin, byOrigin.get(origin));
      acct.email = d.email || "";
      acct.runtime = true;
      out.push(acct);
    }
    accounts = out;
    accountsRawEnv = raw;
    accountPoolDirty = false;
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// 账号控制（控制台用）
//
// 三种控制能力：
//   enabled=false  停用：跳过轮询但保留在池里，随时可再启用
//   reset          清冷却与 token 缓存，让它立刻可以被再次尝试
//   remove         移除运行时登录的账号。环境变量账号只能停用 —— 移除没有意义，
//                  下次 parseAccounts 会照环境变量把它重建出来。
//
// 账号 id 取 originToken 的短哈希：既稳定标识账号，又不泄露 token 内容。
// 用 originToken 而非 refreshToken，是因为上游刷新时会轮换 refreshToken，
// 若用后者，账号每刷新一次 id 就变，控制台的开关会"跟丢"账号。
// ---------------------------------------------------------------------------
function disabledSet() {
  if (!Array.isArray(runtimeState.disabledIds)) runtimeState.disabledIds = [];
  return runtimeState.disabledIds;
}

function accountId(acct) {
  const src = acct.originToken || acct.refreshToken || "";
  // FNV-1a 32 位：够短、无依赖。仅用于标识，不承担安全职责。
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// 解析并为每个账号补上 id / enabled（含已停用的账号，供控制台展示）
function listAccounts(env) {
  const pool = parseAccounts(env);
  const disabled = disabledSet();
  for (const a of pool) {
    if (!a.id) a.id = accountId(a);
    a.enabled = !disabled.includes(a.id);
  }
  // 账号对象每次重建时 usage 是空的，从全局按 id 回填，保证重启后账号卡上的
  // token 数不归零（byAccount 可以从磁盘恢复，账号对象则不行）
  reattachAccountUsage(pool);
  return pool;
}

// 可参与轮询的账号。停用的一律跳过 —— 这是"停用"唯一的实际作用点。
function activeAccounts(env) {
  return listAccounts(env).filter((a) => a.enabled);
}

// 账号池的对外视图。控制台与 /v1/health 共用，避免两处字段定义漂移。
// 绝不包含 refreshToken / accessToken 内容。
function accountSummaries(env) {
  const now = Date.now();
  return listAccounts(env).map((a, i) => ({
    index: i,
    id: a.id,
    enabled: a.enabled,
    // 停用的账号不算"可用"：它不会参与轮询，界面上也不该显示成可用。
    // 冷却改成「账号×模型」级后，这里只表示「账号本身是否可参与调度」——
    // 具体哪个模型在冷却要看 cooldown_models。
    available: a.enabled,
    cooldown_models: cooldownSnapshot(a.id).map((c) => ({
      model_id: c.model_id,
      remaining_seconds: c.remaining_seconds,
      kind: c.kind,
      limited: c.limited,
      detail: c.detail,
      resets_at: c.resets_at,
    })),
    cooldown_seconds: (() => {
      const list = cooldownSnapshot(a.id);
      return list.length ? Math.max(...list.map((c) => c.remaining_seconds)) : 0;
    })(),
    cooldown_reason: (() => {
      const list = cooldownSnapshot(a.id);
      if (!list.length) return null;
      // 展示优先级：明确的「额度用尽」比猜测的未知原因更值得说
      return list.find((c) => c.limited) ? "limit" : "unknown";
    })(),
    token_cached: !!(a.accessToken && now < a.expiry),
    // 控制台登录的账号在云端重启后会消失，界面要据此提示存环境变量；
    // 本地运行时已由 local-server.js 落盘，重启不丢。
    runtime: !!a.runtime,
    email: a.email || "",
    stats: {
      ok: a.okCount || 0,
      fail: a.failCount || 0,
      last_error: a.lastError || null,
      last_error_at: a.lastErrorAt || 0,
      last_used_at: a.lastUsedAt || 0,
    },
    // 该账号消耗的 token（按上游调用计，含切号重试的那几次）
    usage: a.usage || emptyUsage(),
  }));
}

// 记一次账号使用结果。只做统计展示，不影响调度决策。
function markAccountResult(err) {
  const acc = currentAccount;
  if (!acc) return;
  if (err) {
    acc.failCount = (acc.failCount || 0) + 1;
    acc.lastError = String(err).slice(0, 160);
    acc.lastErrorAt = Date.now();
  } else {
    acc.okCount = (acc.okCount || 0) + 1;
    acc.lastError = null;
    acc.lastUsedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Token 用量统计
//
// 记的是每一次**上游调用**的消耗，不是每一个客户端请求。免费通道额度用尽时
// 会自动切号重试，一次客户端请求可能真的打 2~3 次上游，那几次都实打实烧了 token
// —— 按上游调用记，才看得出额度到底去哪了（重试浪费是这里最有价值的信息）。
//
// 改这块之前先读这三条约束，每一条都对应一个具体的坑：
//
//  1. 绝不能在转发前读流。clone().text() 会把整个 SSE 读完，流式首字节要等到模型
//     生成完才到客户端（详见 clineFetchWithRetry 里那段注释）。usage 只能在已有的
//     pump 循环里顺手取，不能为了统计新增 tee/clone。
//
//  2. 账号归属必须在发起 fetch 的瞬间快照。currentAccount 是模块级的，而 enqueue
//     只串行化 fetch 本身 —— 响应头一到就放行，响应体还在流，等 usage 在流尾到达时
//     currentAccount 早被下一个请求改掉了。所以用 WeakMap 把 Response 绑到当时的
//     账号对象上（bindResponseAccount），落账时按 Response 反查。
//
//  3. 上游没给 usage 时（客户端提前 abort、上游省略收尾 chunk）记 missing 计数，
//     不要用字符数估算。估算值混进统计会让整份数字失去意义。
// ---------------------------------------------------------------------------
const USAGE_DAYS_KEEP = 30;   // 按天统计的保留窗口
const USAGE_FLUSH_MS = 1500;  // 落盘防抖：上游请求密集时不至于每次都写文件

// Response → 账号对象。只存引用不存 token，随 Response 一起被 GC。
const respAccounts = new WeakMap();

function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, total: 0, calls: 0, missing: 0 };
}

let usageStats = {
  since: Date.now(),  // 统计起点，界面要据此标注"统计自…"，避免被误读成历史总量
  // 客户端请求数。单独放顶层而不是塞进 usage 桶里：它和 token 不是同一维度的量，
  // 装进桶里会让 per-model / per-account 的桶都带上一个没意义的计数字段。
  // 它唯一的用途是和"上游调用数"（total.calls）对比，算出重试放大倍数。
  clientRequests: 0,
  total: emptyUsage(),
  byModel: {},        // 模型 ID → 用量
  byDay: {},          // YYYY-MM-DD → 用量
  byAccount: {},      // 账号 id → 用量
};

// 每个客户端聊天请求调一次（鉴权通过后、发给上游之前）。
// 与 total.calls 的差值就是"免费的隐性成本"：空响应重试、额度耗尽切号，
// 这些都实打实消耗上游额度，但客户端只感知到一次请求。
function countClientRequest() {
  usageStats.clientRequests += 1;
  scheduleUsageFlush();
}

// 上游 usage 的形状在各条路径上不完全一致（OpenAI 风格 / Anthropic 风格 /
// 上游有时包一层 data），这里统一抽成 {input, output, reasoning, total}。
function pickUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const pos = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  const input = pos(raw.prompt_tokens ?? raw.input_tokens);
  const output = pos(raw.completion_tokens ?? raw.output_tokens);
  let total = pos(raw.total_tokens);
  const reasoning = pos(raw.completion_tokens_details?.reasoning_tokens);
  // 全 0 视为"上游没给有效 usage"：有些上游会在收尾 chunk 里塞一个全 0 的对象，
  // 把它当成"这次消耗为 0"会让成功率虚高，按缺失记更诚实。
  if (!input && !output && !total) return null;
  if (!total) total = input + output;
  return { input, output, reasoning, total };
}

// 本地日期键（YYYY-MM-DD）。用本地时间而非 UTC：免费额度是按自然日重置的，
// 用户看到的"今天"应该和他自己的日历一致。Worker 里 TZ 是 UTC，本地是系统时区，
// 两种环境下用同一套本地取值语义都成立。
function usageDayKey(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function addUsage(bucket, u) {
  bucket.input += u.input;
  bucket.output += u.output;
  bucket.reasoning += u.reasoning;
  bucket.total += u.total;
  bucket.calls += 1;
}

// 上游响应拿到手就立刻调用，把账号钉在这条 Response 上（约束 2）。
function bindResponseAccount(resp) {
  if (resp && currentAccount) respAccounts.set(resp, currentAccount);
  return resp;
}

function accountUsage(acc) {
  if (!acc) return null;
  if (!acc.usage) acc.usage = emptyUsage();
  return acc.usage;
}

// 落一笔用量。resp 用来反查账号；rawUsage 是上游给的原始 usage 对象。
// 注意 calls 记的是"上游调用次数"，与客户端请求数可能不等（见文件头那段）。
function recordUsage(resp, rawUsage, meta) {
  const u = pickUsage(rawUsage);
  const acc = resp ? respAccounts.get(resp) : null;
  const model = (meta && meta.model) || "unknown";

  if (!u) {
    // 没拿到 usage：客户端提前 abort、或上游省略了收尾 chunk。
    usageStats.total.missing += 1;
    const au = accountUsage(acc);
    if (au) au.missing += 1;
    return null;
  }

  addUsage(usageStats.total, u);
  if (!usageStats.byModel[model]) usageStats.byModel[model] = emptyUsage();
  addUsage(usageStats.byModel[model], u);

  const day = usageDayKey(Date.now());
  if (!usageStats.byDay[day]) usageStats.byDay[day] = emptyUsage();
  addUsage(usageStats.byDay[day], u);

  if (acc) {
    const au = accountUsage(acc);
    addUsage(au, u);
    if (acc.id) {
      if (!usageStats.byAccount[acc.id]) usageStats.byAccount[acc.id] = emptyUsage();
      addUsage(usageStats.byAccount[acc.id], u);
    }
  }

  pruneUsageDays();
  scheduleUsageFlush();
  return u;
}

// 只保留最近 USAGE_DAYS_KEEP 天的明细，避免长时间运行后无限增长
function pruneUsageDays() {
  const keys = Object.keys(usageStats.byDay);
  if (keys.length <= USAGE_DAYS_KEEP) return;
  keys.sort();  // YYYY-MM-DD 字典序即时间序
  for (const k of keys.slice(0, keys.length - USAGE_DAYS_KEEP)) {
    delete usageStats.byDay[k];
  }
}

// ---------------------------------------------------------------------------
// 统计持久化（可选）
//
// Worker / Vercel 上不注入，统计只活在当前实例内存里 —— 那边没有可写的本地文件
// 系统，强上 KV/D1 会破坏本项目"单文件复制粘贴即可部署"的定位。
// 本地 local-server.js 会注入一个落盘实现，重启后统计不丢。
//
// 为什么挂在 globalThis 而不是 export：Cloudflare 与 Vercel 都会校验模块的具名导出
// （CF 把具名导出当成额外入口，Vercel 只认 default/config），多出一个函数导出可能
// 导致部署报错。挂全局对象在三个运行时下都成立，也不需要改各自入口的构建脚本。
// ---------------------------------------------------------------------------
let usagePersistCb = null;   // (snapshot) => void
let usageFlushTimer = null;

function setUsagePersistence(fn) {
  usagePersistCb = typeof fn === "function" ? fn : null;
  if (usagePersistCb) scheduleUsageFlush();
}

// 把磁盘上恢复的统计装回内存。累加语义 —— 磁盘快照与内存初值相加，
// 这样即使注入发生在若干次请求之后也不会丢数据。
function restoreUsage(snap) {
  if (!snap || typeof snap !== "object") return false;
  const merge = (target, src) => {
    if (!src || typeof src !== "object") return target;
    for (const k of ["input", "output", "reasoning", "total", "calls", "missing"]) {
      const n = Number(src[k]);
      if (Number.isFinite(n) && n > 0) target[k] += Math.round(n);
    }
    return target;
  };
  merge(usageStats.total, snap.total);
  for (const [k, v] of Object.entries(snap.byModel || {})) {
    if (!usageStats.byModel[k]) usageStats.byModel[k] = emptyUsage();
    merge(usageStats.byModel[k], v);
  }
  for (const [k, v] of Object.entries(snap.byDay || {})) {
    if (!usageStats.byDay[k]) usageStats.byDay[k] = emptyUsage();
    merge(usageStats.byDay[k], v);
  }
  for (const [k, v] of Object.entries(snap.byAccount || {})) {
    if (!usageStats.byAccount[k]) usageStats.byAccount[k] = emptyUsage();
    merge(usageStats.byAccount[k], v);
  }
  if (Number.isFinite(snap.since) && snap.since > 0) {
    usageStats.since = Math.min(usageStats.since, snap.since);
  }
  const cr = Number(snap.clientRequests);
  if (Number.isFinite(cr) && cr > 0) usageStats.clientRequests += Math.round(cr);
  return true;
}

// 账号级用量也要能恢复：磁盘快照里按 id 存着 byAccount，而账号对象的 usage
// 是每次 parseAccounts 重建时新起的，所以恢复后要按 id 回填到账号对象上。
function reattachAccountUsage(pool) {
  for (const a of pool) {
    if (!a.id) continue;
    const u = usageStats.byAccount[a.id];
    if (u && !a.usage) a.usage = { ...u };
  }
}

function exportUsage() {
  return JSON.parse(JSON.stringify(usageStats));
}

function scheduleUsageFlush() {
  if (!usagePersistCb || usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    try { usagePersistCb(exportUsage()); } catch (e) { /* 落盘失败不影响服务 */ }
  }, USAGE_FLUSH_MS);
  // Node 环境下别让这个定时器拖住进程退出（本地 Ctrl+C 要能立刻停）
  if (usageFlushTimer && typeof usageFlushTimer.unref === "function") usageFlushTimer.unref();
}

// 立即冲刷（进程退出前调用），返回是否有回调可用
function flushUsageNow() {
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  if (!usagePersistCb) return false;
  try { usagePersistCb(exportUsage()); return true; } catch (e) { return false; }
}

// 供 local-server.js 这类宿主接入持久化的句柄（见上面「为什么挂在 globalThis」）
globalThis.__clineUsage = { setUsagePersistence, restoreUsage, exportUsage, flushUsageNow };

// 给 /v1/health 用的汇总视图：把内部结构转成前端直接可用的形状
function usageSummary() {
  const t = usageStats.total;
  const round1 = (v) => (v ? Number(v.toFixed(1)) : 0);
  // 按天升序输出最近 USAGE_DAYS_KEEP 天，缺的日子补 0（前端的柱状图要连续的横轴）
  const days = [];
  const now = Date.now();
  for (let i = USAGE_DAYS_KEEP - 1; i >= 0; i--) {
    const key = usageDayKey(now - i * 24 * 3600 * 1000);
    const u = usageStats.byDay[key];
    days.push({
      day: key,
      input: u ? u.input : 0,
      output: u ? u.output : 0,
      total: u ? u.total : 0,
      calls: u ? u.calls : 0,
    });
  }
  const topList = (obj, n) =>
    Object.entries(obj)
      .map(([name, u]) => ({ name, ...u }))
      .sort((a, b) => b.total - a.total)
      .slice(0, n);

  return {
    since: usageStats.since,
    total: { ...t },
    client_requests: usageStats.clientRequests,
    // 重试放大倍数：上游调用数 ÷ 客户端请求数。1.0 表示每次请求都一次打中；
    // 明显大于 1 说明有大量空响应重试/切号在偷偷烧额度 —— 这是用户选
    // "按上游调用记"最想看到的那条信息，所以放后端算，避免两处公式漂移。
    retry_amplification: usageStats.clientRequests
      ? Number((t.calls / usageStats.clientRequests).toFixed(2))
      : 0,
    avg_per_call: t.calls ? Math.round(t.total / t.calls) : 0,
    missing_rate: round1(t.calls + t.missing ? (t.missing / (t.calls + t.missing)) * 100 : 0),
    by_model: topList(usageStats.byModel, 12),
    by_account: topList(usageStats.byAccount, 12),
    days,
  };
}

// ===========================================================================
// 运行时设置（控制台可改）
//
// 云端（Workers / Vercel）没有可写磁盘，所以这份状态主体活在内存里；本地运行时
// 由 local-server.js 通过下面这组钩子落盘，重启不丢（与 token 用量统计同一套模式）。
//
// 为什么要它：冷却时长、轮换策略、请求头、上游渠道钉住、system prompt 覆盖这些
// 都需要「改了就能用」，而不是改环境变量再重新部署。
// ===========================================================================

const STATE_VERSION = 1;

function defaultRuntimeState() {
  return {
    version: STATE_VERSION,
    // 轮换策略：round_robin 轮询 / fill 先用满一个号再换 / random 随机
    strategy: "round_robin",
    // 自定义请求头（覆盖内置 Cline 指纹头里同名的那些）
    headers: {},
    headersComplete: false,
    // 默认模型。空 = 用已启用列表的第一个
    defaultModel: "",
    // 「账号×模型」级 429 冷却的兜底时长（分钟）。上游给出重置时间时以它为准。
    cooldownMinutes: 30,
    // system prompt 覆盖：非空时替换客户端传来的 system 消息
    overridePrompt: "",
    // 「已启用模型」列表（控制台模型页里加进来的）。
    //
    // ⚠️ 这是**发现过滤器**，不是访问控制：/v1/models 只回这里的模型，
    // 但 chat 端点不校验——客户端写死一个不在列表里的模型 ID 仍然能用。
    // 这样设计是有意的：面板的作用是「别让客户端看到四百多个挑不过来的模型」，
    // 而不是给 API 加一道会误伤人的门（写死 ID 的客户端不该因为没在面板点过而失败）。
    models: [],
    // 按模型配置上游渠道（见下方「上游渠道钉住」）。key = 模型 ID
    perModel: {},
    // 控制台登录的账号。落盘后重启不丢（含上游轮换过的最新 refreshToken）。
    dynamicAccounts: [],
    // 被停用的账号 id
    disabledIds: [],
  };
}

let runtimeState = defaultRuntimeState();
let statePersistCb = null;
let stateFlushTimer = null;
const STATE_FLUSH_MS = 800;   // 落盘防抖：改设置时连续点几下只写一次

function exportState() {
  return JSON.parse(JSON.stringify(runtimeState));
}

function scheduleStateFlush() {
  if (!statePersistCb || stateFlushTimer) return;
  stateFlushTimer = setTimeout(() => {
    stateFlushTimer = null;
    try { statePersistCb(exportState()); } catch (e) { /* 落盘失败不影响服务 */ }
  }, STATE_FLUSH_MS);
  if (stateFlushTimer && typeof stateFlushTimer.unref === "function") stateFlushTimer.unref();
}

function flushStateNow() {
  if (stateFlushTimer) { clearTimeout(stateFlushTimer); stateFlushTimer = null; }
  if (!statePersistCb) return false;
  try { statePersistCb(exportState()); return true; } catch (e) { return false; }
}

function setStatePersistence(fn) {
  statePersistCb = fn;
  return true;
}

// 装回上次的设置。只认识自己版本的结构，字段逐个校验后再采用——
// 手工编辑过的文件不该让服务起不来（坏字段退回默认值即可）。
function restoreState(snap) {
  if (!snap || typeof snap !== "object") return false;
  const next = defaultRuntimeState();
  if (["round_robin", "fill", "random"].includes(snap.strategy)) next.strategy = snap.strategy;
  if (snap.headers && typeof snap.headers === "object") {
    for (const [k, v] of Object.entries(snap.headers)) {
      if (typeof k === "string" && k.trim() && typeof v === "string") next.headers[k] = v;
    }
  }
  next.headersComplete = !!snap.headersComplete;
  if (typeof snap.defaultModel === "string") next.defaultModel = snap.defaultModel.trim();
  // 已启用模型：逐条校验后再采用（手改坏一条不该让整个列表作废，只跳过那一条）
  if (Array.isArray(snap.models)) {
    const seen = new Set();
    for (const raw of snap.models) {
      const id = normalizeExistingModelId(raw);
      if (!id || id.length > MAX_MODEL_ID_LENGTH || seen.has(id)) continue;
      seen.add(id);
      next.models.push(id);
    }
  }
  // 默认模型必须仍在启用列表里，否则清空让它回退到列表第一个
  if (next.defaultModel && !next.models.some((m) => normalizeExistingModelId(m) === normalizeExistingModelId(next.defaultModel))) {
    next.defaultModel = "";
  }
  const cm = Number(snap.cooldownMinutes);
  if (Number.isFinite(cm) && cm > 0 && cm <= 1440) next.cooldownMinutes = Math.round(cm);
  if (typeof snap.overridePrompt === "string") next.overridePrompt = snap.overridePrompt;
  if (snap.perModel && typeof snap.perModel === "object") {
    for (const [k, v] of Object.entries(snap.perModel)) {
      const clean = sanitizeUpstreamConfig(v);
      if (clean) next.perModel[k] = clean;
    }
  }
  if (Array.isArray(snap.dynamicAccounts)) {
    for (const a of snap.dynamicAccounts) {
      if (!a || typeof a.refreshToken !== "string" || a.refreshToken.trim().length <= 8) continue;
      next.dynamicAccounts.push({
        refreshToken: a.refreshToken.trim(),
        originToken: (typeof a.originToken === "string" && a.originToken.trim()) || a.refreshToken.trim(),
        email: typeof a.email === "string" ? a.email : "",
      });
    }
  }
  if (Array.isArray(snap.disabledIds)) {
    next.disabledIds = snap.disabledIds.filter((s) => typeof s === "string");
  }
  runtimeState = next;
  accountPoolDirty = true;   // 账号池按新状态重建
  return true;
}

globalThis.__clineState = { setStatePersistence, restoreState, exportState, flushStateNow };

function cooldownMinutes() {
  const m = Number(runtimeState.cooldownMinutes);
  return Number.isFinite(m) && m > 0 ? m : 30;
}

// defaultModelId 定义在「模型库」一节（它依赖启用列表，属于那一层的职责）

// ---------------------------------------------------------------------------
// 「账号 × 模型」级冷却
//
// 上游按「账号 + 模型」组合独立计额：某账号的 deepseek 额度用尽，不代表同账号的
// glm 也不能用。所以冷却必须落在组合粒度上——旧实现把整个账号标成冷却并踢出轮询，
// 模型 A 到上限会让同账号的模型 B 一起不可用。
//
// 刻意不持久化：重启往往意味着运维干预，让全部账号重新回到轮询比带着旧状态继续
// 更符合预期，也避免「永不下线」那类坑。
// ---------------------------------------------------------------------------
const MAX_COOLDOWN_RECORDS = 2000;
const cooldowns = new Map();   // "accId|modelId" -> { until, email, kind, detail, resetsAt }

function cooldownKey(accountId, modelId) {
  return accountId + "|" + modelId;
}

function pruneCooldowns(now) {
  for (const [key, rec] of cooldowns) {
    if (rec.until <= now) cooldowns.delete(key);
  }
}

// 标记冷却。账号或模型为空时跳过：组合级冷却需要一个确定的模型标识，
// 否则会写进一个永远查不到的 key，静默失效。
function markCooldown(accountId, email, modelId, ttlMs, info) {
  if (!accountId || !modelId || !(ttlMs > 0)) return;
  const now = Date.now();
  if (cooldowns.size >= MAX_COOLDOWN_RECORDS) {
    pruneCooldowns(now);
    if (cooldowns.size >= MAX_COOLDOWN_RECORDS) return; // 宁可少一条展示数据也不无限增长
  }
  cooldowns.set(cooldownKey(accountId, modelId), {
    until: now + ttlMs,
    email: email || "",
    kind: (info && info.kind) || "unknown",
    detail: (info && info.detail) || "",
    resetsAt: (info && info.resetsAt) || 0,
  });
}

function isCooling(accountId, modelId, now) {
  const rec = cooldowns.get(cooldownKey(accountId, modelId));
  if (!rec) return false;
  if (rec.until > (now || Date.now())) return true;
  cooldowns.delete(cooldownKey(accountId, modelId));
  return false;
}

function clearCooldownModel(accountId, modelId) {
  return cooldowns.delete(cooldownKey(accountId, modelId));
}

function clearCooldownAccount(accountId) {
  let n = 0;
  for (const key of [...cooldowns.keys()]) {
    if (key.startsWith(accountId + "|")) { cooldowns.delete(key); n++; }
  }
  return n;
}

function clearAllCooldowns() {
  const n = cooldowns.size;
  cooldowns.clear();
  return n;
}

// 冷却快照，按恢复时间升序（控制台与账号详情共用）
function cooldownSnapshot(accountId) {
  const now = Date.now();
  const out = [];
  for (const [key, rec] of cooldowns) {
    if (rec.until <= now) { cooldowns.delete(key); continue; }
    const i = key.indexOf("|");
    if (i < 0) continue;
    const accId = key.slice(0, i), modelId = key.slice(i + 1);
    if (accountId && accId !== accountId) continue;
    out.push({
      account_id: accId,
      email: rec.email,
      model_id: modelId,
      until: rec.until,
      remaining_seconds: Math.ceil((rec.until - now) / 1000),
      // 上游明确告知是「额度用尽」时才为 true；unknown 是我们按配置时长猜的，
      // 两者在界面上要区分开，不能把猜测当事实。
      limited: rec.kind !== "unknown" && rec.kind !== "",
      kind: rec.kind,
      detail: rec.detail,
      resets_at: rec.resetsAt || 0,
    });
  }
  out.sort((a, b) => (a.until - b.until) || a.account_id.localeCompare(b.account_id) || a.model_id.localeCompare(b.model_id));
  return out;
}

// ---------------------------------------------------------------------------
// 上游限流（429）解析
//
// 上游按「账号×模型」限流，且不同额度的重置规律完全不同：
//   免费模型   按自然日 → 重置在次日本地零点
//   ClinePass  订阅额度 → 上游只说 "please try again later."，没有固定周期
//   花费上限   带 resets_at 时间戳 → 用上游给的时刻
// 用一个固定时长兜底还行，但**早于真实重置把请求放回去**只会立刻再撞一次 429，
// 白烧一次额度，所以能解析出真实重置时刻时必须用它。
//
// 标记字符串取自 Cline 官方客户端源码（sdk/packages/llms/src/providers/errors.ts）。
// 上游改文案时这里会退化成 unknown，但不会误报「额度用尽」。
// ---------------------------------------------------------------------------
const LIMIT_MARKER_FREE = "free limit reached on model";
const LIMIT_MARKER_RETRY_IN = "try again in ";
const LIMIT_MARKER_PASS = "clinepass limit";
const LIMIT_MARKER_SPEND = "spend_limit_exceeded";
const MAX_LIMIT_DETAIL = 300;
// 解析出的重置时间能生效的上限：防止上游给出荒唐值（或解析出错）把组合锁死很久。
// 免费模型的每日额度最长也就到明天零点，24 小时足够覆盖。
const MAX_PARSED_COOLDOWN_MS = 24 * 3600 * 1000;

// 上游的 "try again in X" 支持 1h30m 缩写，也支持 "2 hours 30 minutes" 单词写法。
// 只认 h/m/s 单字母会把 "2 hours" 解析成 2h 而丢掉后面的分钟，所以单词形态必须一起认。
const RETRY_UNIT_RE = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
const JSON_TIME_RE = /"resets_at"\s*:\s*"([^"]+)"/;

function parseRetryAfter(text) {
  const idx = text.indexOf(LIMIT_MARKER_RETRY_IN);
  if (idx < 0) return 0;
  // 只在这一小段里找，避免把后面的其它数字（如错误码）当成时长
  const tail = text.slice(idx + LIMIT_MARKER_RETRY_IN.length, idx + LIMIT_MARKER_RETRY_IN.length + 80);
  let total = 0;
  RETRY_UNIT_RE.lastIndex = 0;
  let m;
  while ((m = RETRY_UNIT_RE.exec(tail)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2];
    if (unit.startsWith("h")) total += n * 3600 * 1000;
    else if (unit.startsWith("m")) total += n * 60 * 1000;
    else total += n * 1000;
  }
  return total > 0 ? total : 0;
}

// 下一次本地零点（免费模型每日额度的重置时刻）。
// 用本地时间而非 UTC：额度按用户的自然日重置，界面上的「今天」要和他自己的日历一致。
function nextLocalMidnight(nowMs) {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}

// 从 429 响应体解析额度信息。纯字符串处理，不依赖 body 是合法 JSON
// （可能是纯文本、被截断的片段），解析失败不影响冷却本身。
function parseLimitInfo(bodyText, nowMs) {
  const raw = String(bodyText || "");
  const detail = raw.length > MAX_LIMIT_DETAIL ? raw.slice(0, MAX_LIMIT_DETAIL) + "..." : raw;
  const info = { kind: "unknown", detail, resetsAt: 0, resetInMs: 0 };
  if (!detail.trim()) return info;
  const lower = detail.toLowerCase();

  if (lower.includes(LIMIT_MARKER_FREE)) {
    info.kind = "free_daily";
    const d = parseRetryAfter(lower);
    if (d > 0) info.resetInMs = d;
    else info.resetsAt = nextLocalMidnight(nowMs);
  } else if (lower.includes(LIMIT_MARKER_PASS)) {
    info.kind = "pass_limit";
    const d = parseRetryAfter(lower);
    if (d > 0) info.resetInMs = d;
  } else if (lower.includes(LIMIT_MARKER_SPEND) || lower.includes("spend limit")) {
    info.kind = "spend_limit";
    // resets_at 是上游给的绝对时刻，优先于文字里的相对时长
    const m = detail.match(JSON_TIME_RE);
    const ts = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(ts)) info.resetsAt = ts;
    else {
      const d = parseRetryAfter(lower);
      if (d > 0) info.resetInMs = d;
    }
  }

  // 上游给的重置时间必须落在合理区间，否则丢弃（退回按配置时长冷却）
  if (info.resetsAt) {
    const delta = info.resetsAt - nowMs;
    if (delta <= 0 || delta > MAX_PARSED_COOLDOWN_MS) info.resetsAt = 0;
  }
  if (info.resetInMs > MAX_PARSED_COOLDOWN_MS) info.resetInMs = MAX_PARSED_COOLDOWN_MS;
  return info;
}

// 计算本次冷却时长并标记，返回实际使用的时长（供日志）。
// 上游明确给出重置时刻/时长时用它，否则用配置里的兜底值。
function applyCooldown(acc, modelId, bodyText, nowMs) {
  const info = parseLimitInfo(bodyText, nowMs);
  let ttl = info.resetInMs || (info.resetsAt ? Math.max(info.resetsAt - nowMs, 0) : 0);
  if (!(ttl > 0)) ttl = cooldownMinutes() * 60 * 1000;
  if (ttl > MAX_PARSED_COOLDOWN_MS) ttl = MAX_PARSED_COOLDOWN_MS;
  markCooldown(accountId(acc), acc && acc.email, modelId, ttl, info);
  return { ttl, info };
}

function formatResetAt(ts) {
  if (!ts) return "unknown";
  const d = new Date(ts);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// ---------------------------------------------------------------------------
// 上游渠道钉住（upstream pinning）
//
// 背景：Cline 网关后面是两条完全不同的路由管道，钉住上游的写法互不通用——
//
//   direct（OpenRouter）：响应顶层带 provider（显示名）与 model（真实上游 ID），
//       钉住写进顶层 provider.{only,order}。
//   planner（Vercel AI Gateway）：响应带 provider_metadata.gateway.routing，
//       顶层 provider.* 会被 Cline 丢弃，必须写 providerOptions.gateway.{only,order}。
//
// 管道归属不是固定的：同一个模型在不同时间可能落在这两条之一，所以只能运行时
// 探测 + 缓存，不能硬编码名单。
//
// 「是否免费」与管道无关，因此这里不按 cost 分支。
// ---------------------------------------------------------------------------
const PIPELINE_DIRECT = "direct";
const PIPELINE_PLANNER = "planner";
// 探测用的假上游名。故意带一个不存在的渠道，让网关在**路由层**报错并列出可用
// 渠道清单；若网关忽略筛选，仍可能生成回答并消耗 token。
const PROBE_SENTINEL = "__probe__";
// 探测请求的 max_tokens。刻意不传 reasoning_effort：推理模型的思考过程会先用掉
// 预算，小 max_tokens 下模型还没输出正文就被截断，上游回 500「empty response
// content」，会把「渠道坏了」误判出来。所以探测一律用足够大的预算且不带 effort。
const PROBE_MAX_TOKENS = 512;

const UPSTREAM_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// 渠道 slug 形态校验，挡住把任意字符串注入请求体的可能
function validUpstreamSlug(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 64 && UPSTREAM_SLUG_RE.test(s);
}

// 渠道名归一化：只保留小写字母与数字。
// 必要性来自实测：direct 管道回的 provider 是**显示名**（"DeepInfra"、"Upstage"），
// 而探出来的 slug 是 "deepinfra"、"upstage"。不归一化就无法判断「钉住的渠道」与
// 「实际命中的渠道」是否同一个。
function normalizeProviderSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// 清洗一组渠道名：去空白、跳过非法项、去重（保序）
function sanitizeUpstreams(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw || "").trim();
    if (!validUpstreamSlug(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// 清洗一条模型上游配置（来自控制台或落盘文件）。返回 null 表示这条没有有效内容。
function sanitizeUpstreamConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const out = {
    upstreams: sanitizeUpstreams(cfg.upstreams),
    exclude: sanitizeUpstreams(cfg.exclude),
    pinMode: String(cfg.pinMode || "").toLowerCase() === "preferred" ? "preferred" : "strict",
    redirect: typeof cfg.redirect === "string" ? cfg.redirect.trim() : "",
    aliases: sanitizeUpstreams([]),   // 别名允许含 "/"，不能用 slug 规则，见下
    pipeline: [PIPELINE_DIRECT, PIPELINE_PLANNER].includes(cfg.pipeline) ? cfg.pipeline : "",
    available: sanitizeUpstreams(cfg.available),
    observed: sanitizeUpstreams(cfg.observed),
    lastProvider: typeof cfg.lastProvider === "string" ? cfg.lastProvider : "",
    probedAt: Number(cfg.probedAt) || 0,
    updatedAt: Number(cfg.updatedAt) || 0,
  };
  // 别名是模型 ID（含 "/"），slug 规则会把它们全部过滤掉，所以单独清洗
  if (Array.isArray(cfg.aliases)) {
    const seen = new Set();
    for (const raw of cfg.aliases) {
      const s = String(raw || "").trim();
      if (!s || s.length > 128 || seen.has(s)) continue;
      seen.add(s);
      out.aliases.push(s);
    }
  }
  if (!out.upstreams.length && !out.exclude.length && !out.redirect && !out.aliases.length &&
      !out.pipeline && !out.available.length) {
    return null;
  }
  return out;
}

// 找 modelID 对应的上游配置。modelID 可能是某条记录的别名，所以要扫一遍别名。
function lookupModelUpstream(modelId) {
  if (!modelId) return null;
  const direct = runtimeState.perModel[modelId];
  if (direct) return direct;
  // 别名扫描按 key 排序，保证同一次输入总是得到同一个结果
  for (const key of Object.keys(runtimeState.perModel).sort()) {
    const cfg = runtimeState.perModel[key];
    if (cfg && Array.isArray(cfg.aliases) && cfg.aliases.includes(modelId)) return cfg;
  }
  return null;
}

// 把对外模型 ID 解析成真正发给上游的模型 ID（应用重定向）
function upstreamModelId(modelId) {
  const cfg = lookupModelUpstream(modelId);
  return cfg && cfg.redirect ? cfg.redirect : modelId;
}

// 把一条配置换算成网关认识的偏好键。返回 null 表示不需要注入任何东西。
function buildUpstreamPrefs(cfg) {
  const excluded = new Set(cfg.exclude || []);
  // 钉住列表里剔除被排除的渠道：排除的优先级高于勾选
  const pinned = (cfg.upstreams || []).filter((u) => !excluded.has(u));
  // 排除换算成 only 白名单，需要已知渠道清单（来自探测缓存）。
  // 网关不支持 exclude/ignore 字段（实测被静默忽略），所以只能这样换算。
  const allowList = (cfg.exclude || []).length && (cfg.available || []).length
    ? (cfg.available || []).filter((u) => !excluded.has(u))
    : [];

  if (pinned.length && cfg.pinMode === "preferred") {
    const prefs = { order: pinned };
    // preferred 模式也要限制回退范围，否则网关可能回退到被排除的渠道
    if (allowList.length) prefs.only = allowList;
    return prefs;
  }
  if (pinned.length) return { only: pinned };
  if (allowList.length) return { only: allowList };
  return null;
}

// 就地把上游偏好与模型重定向写进已构造好的请求体。
//
// 管道未知时两种形式**同时**注入：实测在 planner 模型上额外加一个顶层 provider.only
// 不会报错、也不会干扰 providerOptions.gateway（顶层被网关忽略），所以这是安全的
// 兜底，省掉了「必须先探测成功才能钉住」的强依赖。
//
// 用「整体替换」而不是与已有内容合并：客户端也可能自己传 providerOptions，合并会让
// 它的其它键（例如 sort）存活下来并一起发往上游——实测 gateway.sort 会让上游直接
// 500，等于把客户端的错误参数放大成一次失败请求。面板配置存在时这一块由面板说了算。
function applyUpstreamPrefs(body, modelId) {
  const cfg = lookupModelUpstream(modelId);
  if (!cfg) return;
  if (cfg.redirect) body.model = cfg.redirect;
  const prefs = buildUpstreamPrefs(cfg);
  if (!prefs) return;
  const usePlanner = cfg.pipeline === PIPELINE_PLANNER || cfg.pipeline === "";
  const useDirect = cfg.pipeline === PIPELINE_DIRECT || cfg.pipeline === "";
  if (usePlanner) {
    const po = (body.providerOptions && typeof body.providerOptions === "object") ? body.providerOptions : {};
    po.gateway = prefs;
    body.providerOptions = po;
  }
  if (useDirect) body.provider = prefs;
}

// ---------------------------------------------------------------------------
// 上游探测：判定管道归属 + 枚举可用渠道
// ---------------------------------------------------------------------------

// unwrapUpstream 把上游的 {"data":{...}} 包装拆掉，返回真正含 choices 的那层
function unwrapUpstream(obj) {
  if (obj && typeof obj === "object" && obj.data && typeof obj.data === "object" && obj.data.choices) return obj.data;
  return obj;
}

// 沿路径取嵌套对象，任一层缺失就返回 null
function nestedMap(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return (cur && typeof cur === "object") ? cur : null;
}

function firstChoice(obj) {
  const d = unwrapUpstream(obj);
  if (!d || !Array.isArray(d.choices) || !d.choices.length) return null;
  return d.choices[0] && typeof d.choices[0] === "object" ? d.choices[0] : null;
}

function stringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string");
}

// 从响应体里回读管道归属与实际上游。
// 非流式元数据在 choices[0].message.provider_metadata，流式在 choices[0].delta 下，
// 两者都认，所以同一个函数既能解析探测响应也能解析流式分片。
function parseUpstreamRouting(obj) {
  const d = unwrapUpstream(obj);
  const out = { pipeline: "", provider: "", canonicalSlug: "", fallbacks: [], plan: "" };
  if (!d || typeof d !== "object") return out;

  let routing = null;
  const choice = firstChoice(d);
  if (choice) {
    if (choice.message && typeof choice.message === "object") {
      routing = nestedMap(choice.message.provider_metadata, ["gateway", "routing"]);
    }
    if (!routing && choice.delta && typeof choice.delta === "object") {
      routing = nestedMap(choice.delta.provider_metadata, ["gateway", "routing"]);
    }
  }
  if (!routing) routing = nestedMap(d.provider_metadata, ["gateway", "routing"]);

  if (routing) {
    if (typeof routing.finalProvider === "string") {
      out.pipeline = PIPELINE_PLANNER;
      out.provider = routing.finalProvider;
    }
    if (typeof routing.canonicalSlug === "string") out.canonicalSlug = routing.canonicalSlug;
    if (typeof routing.planningReasoning === "string") out.plan = routing.planningReasoning;
    out.fallbacks = stringArray(routing.fallbacksAvailable);
  }

  // direct 管道没有 routing，改看顶层 provider（显示名）与 model（真实上游 ID）
  if (typeof d.provider === "string" && d.provider) {
    if (!out.pipeline) {
      out.pipeline = PIPELINE_DIRECT;
      out.provider = d.provider;
    }
  }
  if (!out.canonicalSlug && typeof d.model === "string" && d.model.includes("/")) {
    out.canonicalSlug = d.model;
  }
  return out;
}

// 从假上游探测的**错误响应**里抽出渠道清单。
// 两条管道的错误形态不同，因此先按管道解析，再退回到通用正则。
function parseAvailableProviders(obj, pipeline) {
  let errText = "";
  if (obj && typeof obj === "object" && obj.error !== undefined) {
    const e = obj.error;
    if (typeof e === "string") errText = e;
    else if (e && typeof e === "object") {
      const list = extractProviderList(e);
      if (list.length) return list;
      if (typeof e.message === "string") errText = e.message;
    }
  }
  // 优先：错误文本里嵌的 JSON 片段
  const brace = errText.indexOf("{");
  if (brace >= 0) {
    try {
      const embedded = JSON.parse(errText.slice(brace));
      const list = extractProviderList(embedded);
      if (list.length) return list;
    } catch (e) { /* 不是 JSON，继续走文本解析 */ }
  }
  // 兜底：两条管道各自的文本形态都试一遍
  for (const re of [PROVIDER_LIST_RE_PLANNER, PROVIDER_LIST_RE_DIRECT]) {
    const list = splitProviderTokens(re, errText);
    if (list.length) return list;
  }
  return [];
}

// 边界刻意写成「slug 的逗号列表」而不是更省事的 [^.]+：错误文本尾部通常还跟着
// JSON 残片（wafer","type":"invalid_request_error"...），用 [^.]+ 会把它们一起吃
// 进去，结果最后一个渠道名被污染后过滤掉——实测表现为「渠道数偶尔少一个」。
const PROVIDER_LIST_RE_DIRECT = /Providers serving [^:]+:\s*([a-z0-9][a-z0-9-]*(?:\s*,\s*[a-z0-9][a-z0-9-]*)*)/;
const PROVIDER_LIST_RE_PLANNER = /Available providers are:\s*([a-z0-9][a-z0-9-]*(?:\s*,\s*[a-z0-9][a-z0-9-]*)*)/;

// 在任意嵌套结构里找 available_providers 数组
function extractProviderList(obj) {
  if (!obj || typeof obj !== "object") return [];
  const fromMeta = (m) => {
    if (!m || typeof m !== "object") return [];
    const list = stringArray(m.available_providers);
    return list.length ? sanitizeUpstreams(list) : [];
  };
  if (obj.error && typeof obj.error === "object") {
    const l = fromMeta(obj.error.metadata);
    if (l.length) return l;
  }
  return fromMeta(obj.metadata);
}

// 用正则抓一段再用 slug 形态过滤。过滤是必需的：错误文本里可能混有 JSON 残片
// （如 ","type":"invalid_request_error"），不过滤会把它们当成渠道名。
function splitProviderTokens(re, text) {
  if (!text) return [];
  const m = String(text).match(re);
  if (!m) return [];
  return sanitizeUpstreams(m[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""))).sort();
}

function appendProbeNote(result, note) {
  if (!note) return;
  // 用追加而非覆盖：探测是多步的，直接赋值会让后一步悄悄盖掉前一步的结论
  // （比如把「钉住未生效」盖成「渠道清单解析失败」）。
  result.note = result.note ? result.note + "；" + note : note;
}

// planner 响应元数据里的候选渠道。刻意与 Available 分开：观察到某个渠道
// 不代表它能被严格钉住，因此不能拿它做排除项的白名单换算。
function observedProviders(routing) {
  if (routing.pipeline !== PIPELINE_PLANNER) return [];
  return sanitizeUpstreams([routing.provider, ...routing.fallbacks]);
}

function probeRequestBody(modelId, maxTokens) {
  return {
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: maxTokens,
    session_id: "sess_" + Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 异步探测任务
//
// 探测要打两次上游、耗时可能几十秒，同步返回会让页面转圈到超时。改成「立即返回
// jobId，前端轮询状态」：也顺带让「连点两下同一个模型」共享同一次探测，不重复
// 消耗额度。
// ---------------------------------------------------------------------------
const PROBE_JOB_TIMEOUT_MS = 5 * 60 * 1000;
const PROBE_JOB_RETENTION_MS = 15 * 60 * 1000;
const MAX_PROBE_JOBS = 32;
const MAX_RUNNING_PROBES = 4;
const probeJobs = new Map();   // jobId -> { id, modelId, status, result, error, createdAt }

function pruneProbeJobs(now) {
  for (const [id, job] of probeJobs) {
    if (job.status !== "running" && now - job.createdAt > PROBE_JOB_RETENTION_MS) probeJobs.delete(id);
  }
}

// kind 用于把「渠道探测」与「可用性检测」两套任务分开去重：
// 同一个模型的两个动作是同名但不同的事，不该互相共享结果。
function startProbeJob(modelId, run, kind) {
  const taskKind = kind || "probe";
  const now = Date.now();
  pruneProbeJobs(now);
  let running = 0;
  for (const job of probeJobs.values()) {
    if (job.status !== "running") continue;
    // 同一模型 + 同类任务重复点击：共享正在跑的那个任务，不重复消耗额度
    if (job.modelId === modelId && job.kind === taskKind) return { job, shared: true };
    running++;
  }
  if (running >= MAX_RUNNING_PROBES) return { error: "任务较多，请稍后重试", status: 429 };
  if (probeJobs.size >= MAX_PROBE_JOBS) {
    let oldest = null;
    for (const job of probeJobs.values()) {
      if (job.status !== "running" && (!oldest || job.createdAt < oldest.createdAt)) oldest = job;
    }
    if (!oldest) return { error: "任务较多，请稍后重试", status: 429 };
    probeJobs.delete(oldest.id);
  }
  const id = "job_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const job = { id, modelId, kind: taskKind, status: "running", result: null, error: null, createdAt: Date.now() };
  probeJobs.set(id, job);
  // 故意不 await：任务是后台跑的，前端按 jobId 轮询结果
  runProbeJob(id, modelId, run, taskKind);
  return { job, shared: false };
}

async function runProbeJob(id, modelId, run, kind) {
  const taskKind = kind || "probe";
  const runner = run || probeModelUpstreams;
  try {
    const result = await withTimeout(runner(modelId), PROBE_JOB_TIMEOUT_MS);
    const job = probeJobs.get(id);
    if (!job) return;
    job.status = "done";
    job.result = result;
    // 只有渠道探测的结果要写回配置缓存（管道归属 + 渠道清单）；
    // 可用性检测不碰配置——它只回答"现在能不能用"，不该顺带改状态。
    if (taskKind === "probe") {
      saveProbeResult(modelId, result);
      scheduleStateFlush();
    }
  } catch (e) {
    const job = probeJobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.error = (e && e.message === "probe_timeout")
      ? "上游响应超时，请稍后重试"
      : String((e && e.message) || e);
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe_timeout")), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 探测一个模型的管道归属与可用渠道清单。共两步：
//  1. 发一次**带上当前钉住配置**的真实请求（有配置就注入，没有就是自动模式），
//     既回读管道归属，也顺带回答「我钉的渠道到底生效了没有」。
//  2. 带假上游名让网关在**路由层**报错并列出渠道清单。
//
// 第 1 步必须真的注入钉住配置：否则「实际命中的渠道」与「用户钉的渠道」无关，
// providerMatch 只表示实际命中与配置一致，不能单独证明网关执行了筛选。
async function probeModelUpstreams(modelId) {
  const upstreamModel = upstreamModelId(modelId);
  const cfg = lookupModelUpstream(modelId);
  const result = {
    modelId, upstreamModel, pipeline: "", provider: "", providerMatch: false,
    available: [], observed: [], fallbacks: [], latencyMs: 0, note: "",
  };

  // 与真实代理链路完全一致地构造请求体，这样探测结果才代表线上行为
  const probeBody = probeRequestBody(upstreamModel, PROBE_MAX_TOKENS);
  if (cfg) applyUpstreamPrefs(probeBody, modelId);

  const start = Date.now();
  const first = await upstreamProbeCall(upstreamModel, probeBody, 180000);
  result.latencyMs = Date.now() - start;
  const routing = parseUpstreamRouting(first.json);
  result.pipeline = routing.pipeline;
  result.provider = routing.provider;
  result.fallbacks = routing.fallbacks;

  if (first.status !== 200) {
    appendProbeNote(result, "基线请求返回 HTTP " + first.status + "：" + String(first.text || "").slice(0, 300));
    return result;
  }
  result.observed = observedProviders(routing);
  if (!routing.pipeline) {
    appendProbeNote(result, "响应里既没有 provider_metadata.gateway.routing，也没有顶层 provider，无法判定管道");
    return result;
  }

  // 钉住生效确认：实际命中的渠道是否就是钉住列表里的某一个（按归一化名比对，
  // 因为 direct 管道回的显示名是 "DeepInfra"，而清单里是 "deepinfra"）
  if (cfg && (cfg.upstreams || []).length) {
    const actual = normalizeProviderSlug(routing.provider);
    result.providerMatch = cfg.upstreams.some((p) => normalizeProviderSlug(p) === actual);
    if (!result.providerMatch) {
      appendProbeNote(result, "钉住 " + cfg.upstreams.join("/") + " 未生效：实际命中 " + routing.provider);
    }
  }

  // 渠道枚举：故意带一个不存在的渠道名，尝试让网关拒绝并回吐清单。
  // 某些模型会忽略筛选并正常生成回答，不能假定这一步一定不消耗 token。
  const enumBody = probeRequestBody(upstreamModel, 16);
  if (routing.pipeline === PIPELINE_PLANNER) {
    enumBody.providerOptions = { gateway: { only: [PROBE_SENTINEL] } };
  } else {
    enumBody.provider = { only: [PROBE_SENTINEL] };
  }
  let enumRes;
  try {
    enumRes = await upstreamProbeCall(upstreamModel, enumBody, 60000);
  } catch (e) {
    appendProbeNote(result, "模型已响应，但渠道枚举请求失败：" + String((e && e.message) || e) +
      "；响应元数据中的候选渠道不代表完整清单或可严格钉住");
    return result;
  }
  if (enumRes.status === 200 && firstChoice(enumRes.json)) {
    appendProbeNote(result, "模型已正常响应，但网关未按 only 筛选拒绝不存在的渠道，无法枚举完整清单；实际命中：" +
      routing.provider + "。响应元数据中的候选渠道仅供参考，不能据此确认严格钉住生效");
    return result;
  }
  result.available = parseAvailableProviders(enumRes.json, routing.pipeline);
  if (!result.available.length) {
    appendProbeNote(result, "模型已响应，但未能从渠道枚举响应（HTTP " + enumRes.status +
      "）解析出完整清单；响应元数据中的候选渠道仅供参考：" + String(enumRes.text || "").slice(0, 300));
  }
  return result;
}

// 探测用的原始上游调用。刻意不复用 clineFetch：探测要读**非 200 响应体**
// （渠道清单就藏在错误里），而正常链路会把非 200 转成错误并丢掉响应体；
// 探测也不该计入使用量、不该触发冷却——那都是真实请求才有的副作用。
async function upstreamProbeCall(modelId, body, timeoutMs) {
  const pool = activeAccounts();
  if (!pool.length) throw new Error("没有可用账号，无法探测");
  const acc = pickAccount(modelId);
  if (!acc) throw new Error("没有可用账号（该模型的额度都在冷却中），无法探测");
  const token = await getAccountToken(acc);
  const sessionId = body.session_id || ("sess_" + Date.now());
  const resp = await fetchWithTimeout(CLINE_API_BASE + "/chat/completions", {
    method: "POST",
    headers: clineHeaders(sessionId, token),
    body: JSON.stringify(body),
  }, timeoutMs);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应留给调用方判断 */ }
  return { status: resp.status, text, json };
}

function saveProbeResult(modelId, result) {
  const existing = runtimeState.perModel[modelId] || sanitizeUpstreamConfig({}) || {
    upstreams: [], exclude: [], pinMode: "strict", redirect: "", aliases: [],
    pipeline: "", available: [], observed: [], lastProvider: "", probedAt: 0, updatedAt: 0,
  };
  const entry = { ...existing };
  // 只在同一条管道内保留部分结果：管道变了，旧的渠道清单就不适用了
  if (result.pipeline) {
    if (result.pipeline !== entry.pipeline) entry.available = [];
    entry.pipeline = result.pipeline;
    entry.observed = result.observed || [];
    entry.lastProvider = result.provider || "";
  }
  if ((result.available || []).length) entry.available = result.available;
  entry.probedAt = Date.now();
  runtimeState.perModel[modelId] = entry;
}

// ---------------------------------------------------------------------------
// 账号余额查询
//
// 官方 app.cline.bot/dashboard 把 API 返回的余额除以 1e6 显示，实测对齐：
// 原始 499186 → 0.499186 Credits（显示 0.4992）。所以单位换算必须固定用这个除数。
// 本地 acc_... ID 不是 Cline 的用户 ID，要先用 /users/me 解析出真正的 ID。
// ---------------------------------------------------------------------------
const MICROCREDITS_PER_CREDIT = 1000000;

async function accountBalanceGET(acc, token, path) {
  const url = CLINE_API_BASE + path;
  let tk = token;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: clineHeaders("", tk),
    }, 12000);
    if (resp.status === 401 && attempt === 0) {
      // token 可能刚失效：强制刷新一次再试（只试一次，避免死循环）
      await resp.text().catch(() => "");
      tk = await refreshAccountToken(acc);
      continue;
    }
    if (resp.status !== 200) {
      await resp.text().catch(() => "");
      throw new Error("官方余额查询失败（HTTP " + resp.status + "）");
    }
    const body = await resp.json().catch(() => null);
    if (!body || body.success === false || body.data === undefined || body.data === null) {
      throw new Error("官方余额接口响应异常，请稍后重试");
    }
    return body.data;
  }
  throw new Error("账号认证失败，请重新登录");
}

// 余额缓存。刻意用「单飞」：并发的多个查询共享同一次上游请求，
// 而失败结果的 TTL 短（10s），避免把一次网络抖动缓存成一分钟的「查不到」。
const balanceCache = new Map();   // accountId -> { value, err, validUntil, pending, waiters }

async function cachedAccountBalance(acc, force) {
  const id = accountId(acc);
  const now = Date.now();
  let state = balanceCache.get(id);
  if (state && state.pending) return state.promise;
  if (state && !force && now < state.validUntil) {
    if (state.err) throw state.err;
    return state.value;
  }

  const promise = (async () => {
    let value = null, err = null;
    try {
      const token = await getAccountToken(acc);
      const user = await accountBalanceGET(acc, token, "/users/me");
      if (!user || !user.id) throw new Error("官方接口未返回用户 ID");
      const credits = await accountBalanceGET(acc, token, "/users/" + encodeURIComponent(user.id) + "/balance");
      if (credits.balance === undefined || credits.balance === null) {
        throw new Error("官方接口未返回 Credit 余额");
      }
      value = { balance: Number(credits.balance) / MICROCREDITS_PER_CREDIT, checkedAt: Date.now() };
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    balanceCache.set(id, {
      value, err,
      // 失败结果只缓存 10s：一次抖动不该变成一分钟的「余额不可用」
      validUntil: Date.now() + (err ? 10000 : 60000),
      pending: false,
    });
    if (err) throw err;
    return value;
  })();

  balanceCache.set(id, { pending: true, promise, validUntil: 0, value: null, err: null });
  // 失败时上面那个 catch 已经把错误记进缓存，这里再挂一次防止 unhandled rejection
  promise.catch(() => {});
  return promise;
}

// ---------------------------------------------------------------------------
// 出口请求：带上超时与取消传播
//
// signal 必须是发起请求那个 HTTP 请求的信号：客户端断开时它会取消，从而中止已经
// 发往上游的请求——否则客户端早走了，我们还在替它消耗账号额度、占着连接直到上游
// 自己结束。首字节超时（ResponseHeaderTimeout 的等价物）单独用 AbortController
// 控制：它限的是「请求发出 → 收到响应头」，对长回答是安全的（SSE 的响应头在生成
// 一开始就发出来了），而整体超时会把正常的长时间流式响应一起掐断。
// ---------------------------------------------------------------------------
const UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 120000;

function fetchWithTimeout(url, init, timeoutMs, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("upstream_timeout")), timeoutMs || UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort(new Error("client_aborted"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  return fetch(url, { ...init, signal: ctrl.signal }).then(
    (resp) => {
      // 响应头已到：首字节超时的使命结束（响应体可能还要流很久）。
      // 但客户端取消的监听要保留到流转发结束，所以把清理句柄挂在响应上。
      clearTimeout(timer);
      resp.__cleanup = cleanup;
      return resp;
    },
    (e) => { cleanup(); throw e; }
  );
}

function releaseUpstream(resp) {
  if (resp && typeof resp.__cleanup === "function") {
    try { resp.__cleanup(); } catch (e) { /* 清理失败无副作用 */ }
    resp.__cleanup = null;
  }
}

// ---------------------------------------------------------------------------
// 请求限流（登录 / 账号操作）
//
// 「先占位再校验」：并发请求会在同一个窗口内同时读到计数、同时通过，所以必须
// 先自增再判断。IP 只取直连对端，**刻意忽略 forwarded 头**——那是客户端可伪造的，
// 拿它做限流键等于把限流关掉。
// ---------------------------------------------------------------------------
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_LIMITER_CLIENTS = 4096;
const loginAttempts = new Map();   // ip -> { count, expires }

function allowLoginAttempt(ip) {
  const now = Date.now();
  for (const [key, rec] of loginAttempts) {
    if (rec.expires <= now) loginAttempts.delete(key);
  }
  let rec = loginAttempts.get(ip);
  if (!rec) {
    if (loginAttempts.size >= MAX_LIMITER_CLIENTS) return false;
    rec = { count: 0, expires: now + LOGIN_WINDOW_MS };
  }
  if (rec.count >= MAX_LOGIN_ATTEMPTS) return false;
  rec.count++;
  loginAttempts.set(ip, rec);
  return true;
}

function clientIp(request) {
  // 本地/直连场景没有 forwarded 头，用占位符即可（限流是进程级的，
  // 单机自用时所有请求都归到同一个桶，正是想要的行为）
  const hit = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip");
  return hit || "local";
}

// 请求体上限：本地服务把整个 body 读进内存，没上限的话任何人都能 POST 一个
// 任意大的 body 直到 OOM。32 MiB 远大于正常请求（128k tokens 上下文约几百 KB～1 MB）。
const MAX_BODY_BYTES = 32 << 20;

// 账号管理动作。返回给前端的是**动作执行后的完整账号列表**，
// 这样前端一次请求就能刷新界面，不用再补一次 /v1/health。
async function handleAccountAction(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }

  const action = String(body.action || "").trim();
  const id = String(body.id || "").trim();
  const modelId = String(body.modelId || body.model_id || "").trim();
  const respond = (extra) =>
    jsonResponse({ ok: true, action, accounts: accountSummaries(env), ...extra }, 200);

  // 批量动作
  if (action === "enableAll") {
    runtimeState.disabledIds = [];
    scheduleStateFlush();
    return respond({ message: "已启用全部账号" });
  }
  if (action === "resetAll") {
    const n = clearAllCooldowns();
    for (const a of listAccounts(env)) {
      a.accessToken = null;
      a.expiry = 0;
    }
    return respond({ message: `已清除 ${n} 个「账号×模型」冷却` });
  }

  if (!action) {
    return jsonResponse({ error: { message: "缺少 action 参数", type: "account_error" } }, 400);
  }

  const target = listAccounts(env).find((a) => a.id === id);
  if (!target) {
    // 找不到通常是控制台拿的是旧列表（账号刚被移除），提示刷新即可
    return jsonResponse({
      error: { message: "找不到该账号，可能已被移除。请点「刷新」重新读取账号池。", type: "account_error" },
    }, 404);
  }

  if (action === "disable") {
    const disabled = disabledSet();
    if (!disabled.includes(target.id)) disabled.push(target.id);
    scheduleStateFlush();
    // 停用当前正在用的账号时立刻让位，否则它会一直用到下次挑号
    if (currentAccount === target) currentAccount = null;
    return respond({ message: "已停用，该账号将不再参与轮询" });
  }

  if (action === "enable") {
    runtimeState.disabledIds = disabledSet().filter((x) => x !== target.id);
    scheduleStateFlush();
    return respond({ message: "已启用，该账号将重新参与轮询" });
  }

  // reset：清掉这个账号**全部模型**的冷却 + token 缓存（整号复活）
  if (action === "reset") {
    const n = clearCooldownAccount(target.id);
    target.accessToken = null;
    target.expiry = 0;
    return respond({ message: n ? `已清除 ${n} 个模型的冷却` : "该账号当前没有冷却中的模型" });
  }

  // clearCooldown：清掉单个「账号 × 模型」的冷却。
  // 冷却时长是我们按 429 猜的（上游有时不说明重置时间），猜错了（比如额度其实
  // 已恢复）用户要能自己纠正，而不是干等。
  if (action === "clearCooldown") {
    if (!modelId) {
      return jsonResponse({ error: { message: "缺少 modelId 参数", type: "account_error" } }, 400);
    }
    const ok = clearCooldownModel(target.id, modelId);
    return respond({ ok: ok, message: ok ? "已解除该模型的冷却" : "该模型当前不在冷却中" });
  }

  if (action === "remove") {
    if (!target.runtime) {
      return jsonResponse({
        error: {
          message: "环境变量里的账号无法移除。它是从 CLINE_REFRESH_TOKEN 读出来的，"
                 + "移掉下一次读取又会出现。要让它不再被使用，请改用「停用」；"
                 + "要永久删除，请编辑部署环境的 CLINE_REFRESH_TOKEN 并重新部署。",
          type: "account_error",
        },
      }, 400);
    }
    // 运行时账号按 originToken 匹配（上游轮换过 refreshToken 也认得出来）
    const list = runtimeState.dynamicAccounts;
    const before = list.length;
    runtimeState.dynamicAccounts = list.filter((d) => (d.originToken || d.refreshToken) !== target.originToken);
    accountPoolDirty = true;
    runtimeState.disabledIds = disabledSet().filter((x) => x !== target.id);
    clearCooldownAccount(target.id);
    scheduleStateFlush();
    if (currentAccount === target) currentAccount = null;
    return respond({ removed: before - runtimeState.dynamicAccounts.length, message: "已移除该账号" });
  }

  return jsonResponse({ error: { message: "未知的 action: " + action, type: "account_error" } }, 400);
}

// 账号详情：这个账号现在哪些模型到了上限、什么时候重置、还有哪些模型可用。
//
// 为什么需要它：冷却表只按「账号×模型」平铺，看不出「某个账号下哪些模型还能用」；
// 而额度的粒度恰恰就是账号×模型，所以视图要对齐这个粒度。
async function handleAccountDetail(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: { message: "缺少 id 参数", type: "account_error" } }, 400);

  const acc = listAccounts(env).find((a) => a.id === id);
  if (!acc) return jsonResponse({ error: { message: "找不到该账号", type: "account_error" } }, 404);

  const limited = cooldownSnapshot(id);
  const limitedSet = new Set(limited.map((c) => c.model_id));
  // 用量按「本地日」口径展示，与账号列表一致
  const today = usageDayKey(Date.now());
  const accUsage = usageStats.byAccount[id];
  // 「现在可用的模型」列的是**已启用模型**：账号详情要回答的是「我常用的这些模型里
  // 哪些现在不能用」，列四百多个上游模型对判断没有帮助。
  const allModels = effectiveModelIds();

  const data = {
    id,
    email: acc.email || "",
    enabled: acc.enabled,
    runtime: !!acc.runtime,
    cooldown_minutes: cooldownMinutes(),
    limited,
    // 受限的模型不再列入「可用」，避免同一模型在两处出现
    other_models: allModels.filter((m) => !limitedSet.has(m)),
    token_cached: !!(acc.accessToken && Date.now() < acc.expiry),
    expiry: acc.expiry || 0,
    stats: {
      ok: acc.okCount || 0,
      fail: acc.failCount || 0,
      last_error: acc.lastError || null,
      last_error_at: acc.lastErrorAt || 0,
      last_used_at: acc.lastUsedAt || 0,
    },
    usage_today: (accUsage && accUsage.byDay && accUsage.byDay[today]) || emptyUsage(),
    usage_total: accUsage || emptyUsage(),
  };

  // reveal=1 才回完整 refreshToken：详情是「看一眼」的常规操作，不该每次都把可长期
  // 使用的凭据送进浏览器；但用户确实需要能把它复制出来的入口（比如换机器部署），
  // 所以留一个显式通道。
  if (url.searchParams.get("reveal") === "1") {
    data.refresh_token = acc.refreshToken;
    // 该账号来自环境变量：上游轮换后的新 token 没法写回环境变量，这里给的是内存里的现值
    data.rotated = !!(acc.originToken && acc.refreshToken && acc.originToken !== acc.refreshToken);
  } else {
    data.refresh_token_masked = maskCredential(acc.refreshToken);
  }
  return jsonResponse({ ok: true, ...data }, 200);
}

// 只留首尾便于辨认，中间一律打码。
// 短于 16 字符时全部打码：这类值几乎不可能是真 token，
// 但按「前6后4」处理会把它们几乎完整暴露出来。
function maskCredential(v) {
  const s = String(v || "");
  if (!s) return "";
  if (s.length < 16) return "*".repeat(s.length);
  return s.slice(0, 6) + "*".repeat(8) + s.slice(-4);
}

// 账号余额。官方 app.cline.bot/dashboard 把 API 余额除以 1e6 显示，所以单位换算
// 固定用这个除数（见 MICROCREDITS_PER_CREDIT 的说明）。
async function handleAccountBalance(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!id) return jsonResponse({ error: { message: "缺少 id 参数", type: "account_error" } }, 400);

  const acc = listAccounts(env).find((a) => a.id === id);
  if (!acc) return jsonResponse({ error: { message: "找不到该账号", type: "account_error" } }, 404);

  try {
    const value = await cachedAccountBalance(acc, url.searchParams.get("refresh") === "1");
    return jsonResponse({ ok: true, ...value }, 200);
  } catch (e) {
    return jsonResponse({
      error: { message: String((e && e.message) || e), type: "balance_error" },
    }, 502);
  }
}

// 取得当前账号的 accessToken（独立缓存，失效则刷新）
//
// 单飞：同一个账号在同一时刻只允许一次 /auth/refresh。上游会轮换 refreshToken，
// 并发刷新时后到的那次会拿着已被换掉的 token 去换，必然 invalid_grant ——表现为
// 「同一账号偶发刷新失败」，把并发请求一起拖垮。后来者等前一个结果即可。
//
// 刻意不再这里做「账号级冷却」：额度是「账号×模型」量级（见 cooldowns），
// 账号级冷却会让模型 A 到上限时同账号的模型 B 也用不了。
async function getAccountToken(account) {
  const now = Date.now();
  if (account.accessToken && now < account.expiry) return account.accessToken;
  if (account.refreshInFlight) return account.refreshInFlight;

  const promise = (async () => {
    const resp = await fetchWithTimeout(CLINE_API_BASE + "/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: account.refreshToken,
        grantType: "refresh_token",
      }),
    }, 30000);
    if (!resp.ok) {
      // 401 是永久性的（refreshToken 已被上游作废），其余按瞬时故障处理
      const permanent = resp.status === 401 || resp.status === 403;
      const bodyText = await resp.text().catch(() => "");
      const err = new Error(permanent ? "refresh_rejected" : "refresh_failed");
      err.permanent = permanent;
      err.status = resp.status;
      err.detail = bodyText.slice(0, 200);
      throw err;
    }
    const data = await resp.json();
    const accessToken = data?.data?.accessToken;
    if (!accessToken) throw new Error("refresh_no_token");
    account.accessToken = accessToken;
    // 顺带采集邮箱：环境变量里的账号本来没有邮箱可显示，而刷新响应带 userInfo.email。
    // 只在缺失时写一次，避免每个刷新周期都覆盖。
    if (!account.email) {
      const em = data?.data?.userInfo?.email;
      if (typeof em === "string" && em.trim()) account.email = em.trim();
    }
    // Cline 会在刷新时轮换 refreshToken。新 token 必须**立刻落盘**：
    // 旧 token 在上游已经作废，只把新值留在内存里，重启后就拿着一把死钥匙，
    // 表现为下次启动起所有请求都 invalid_grant。
    const rotated = typeof data?.data?.refreshToken === "string" ? data.data.refreshToken.trim() : "";
    if (rotated && rotated !== account.refreshToken) {
      account.refreshToken = rotated;
      persistRotatedToken(account);
    }
    // 账号不一致时补写邮箱（旧对象复用时 email 可能刚被采集到）
    account.expiry = parseExpiryMs(data?.data?.expiresAt, now) - 60000;
    return accessToken;
  })();

  account.refreshInFlight = promise;
  try {
    return await promise;
  } finally {
    account.refreshInFlight = null;
  }
}

// 把轮换后的 refreshToken 写回它该在的地方（设置里的运行时账号 + 落盘）。
// 环境变量账号没法改（那是部署配置），只能在控制台提示用户去更新。
function persistRotatedToken(account) {
  const origin = account.originToken || account.refreshToken;
  const list = runtimeState.dynamicAccounts;
  const entry = list.find((d) => (d.originToken || d.refreshToken) === origin);
  if (entry) {
    entry.refreshToken = account.refreshToken;
    if (!entry.originToken) entry.originToken = origin;
    scheduleStateFlush();
    console.log("[token] 已把轮换后的 refreshToken 落盘（账号 " + account.id + "）");
    return true;
  }
  // 环境变量账号：轮换值只存在内存里，重启会退回环境变量里的旧值。
  // 这不是能自动修的问题（改不了用户的部署配置），所以要显式提示。
  if (!account.__rotatedWarned) {
    account.__rotatedWarned = true;
    console.log("[token] 账号 " + account.id + " 来自 CLINE_REFRESH_TOKEN，上游轮换后的 " +
      "refreshToken 无法写回环境变量；请在控制台「账号」页复制最新 token 并更新配置，否则重启后该账号会失效。");
  }
  return false;
}

function parseExpiryMs(expiresAt, now) {
  const fallback = now + 10 * 60 * 1000;
  if (typeof expiresAt === "number") return expiresAt;
  if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (!isNaN(t)) return t;
  }
  return fallback;
}

// 强制刷新某账号的 token（余额查询等场景拿到 401 后调用）
async function refreshAccountToken(account) {
  account.accessToken = null;
  account.expiry = 0;
  return getAccountToken(account);
}

// 按策略挑一个账号。modelId 用于「账号×模型」级冷却过滤：某账号的该模型在冷却中
// 就跳过，同账号的其它模型不受影响。
// strategy: round_robin 轮询 / fill 先用满一个再换 / random 随机
function pickAccount(modelId) {
  const pool = activeAccounts();
  const now = Date.now();
  const usable = pool.filter((a) => !(modelId && isCooling(accountId(a), modelId, now)));
  if (!usable.length) return null;

  const strategy = runtimeState.strategy;
  if (strategy === "fill") return usable[0];
  if (strategy === "random") return usable[Math.floor(Math.random() * usable.length)];

  // round_robin：游标可能落在已被过滤掉的账号上，从游标处往后找第一个可用的
  const start = accountIndex % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const acc = pool[idx];
    if (!usable.includes(acc)) continue;
    accountIndex = (idx + 1) % pool.length;
    return acc;
  }
  return usable[0];
}

async function getAccessToken(env, modelId) {
  const pool = activeAccounts(env); // 已停用的账号不参与轮询
  if (pool.length === 0) {
    const all = listAccounts(env);
    if (all.length > 0) {
      // 有账号但全被停用：这是用户的主动选择，报错要说清原因，否则会被当成配置缺失
      const err = new Error("all_accounts_disabled");
      err.accountCount = all.length;
      throw err;
    }
    throw new Error("缺少 CLINE_REFRESH_TOKEN 环境变量");
  }

  const now = Date.now();
  // 按「账号×模型」过滤：该模型正在冷却的账号直接跳过，不浪费一次上游请求。
  // 这一步必须在发起请求之前——只在响应回来后才判冷却的话，请求已经打出去了，
  // 冷却是"事后"记录，等于每次都要白烧一次额度才发现没号可用。
  const usable = modelId
    ? pool.filter((a) => !isCooling(accountId(a), modelId, now))
    : pool;
  if (!usable.length) {
    // 所有账号的这个模型都在冷却：直接告诉调用方等多久，不要空转
    const snap = cooldownSnapshot(null).filter((c) => c.model_id === modelId);
    const earliest = snap.length ? Math.min(...snap.map((c) => c.until)) : now + 60000;
    const err = new Error("all_accounts_cooling");
    err.retryAfterMs = Math.max(earliest - now, 0);
    err.accountCount = pool.length;
    err.modelId = modelId;
    err.kinds = [...new Set(snap.map((c) => c.kind))];
    throw err;
  }

  // 顺序由策略决定（pickAccount 内部实现）；token 刷新失败则顺延到下一个。
  // 走同一个 pickAccount 而不是各写一套轮询：两处实现漂移会让「设置里改了策略
  // 但真实流量没变」——这类"设置看起来生效了其实没生效"的 bug 最难发现。
  const order = accountOrder(usable);
  let lastErr = null;
  for (const acc of order) {
    try {
      const token = await getAccountToken(acc);
      currentAccount = acc;
      return token;
    } catch (e) {
      lastErr = e;
      continue; // 刷新失败，试下一个号
    }
  }

  // 可用账号的 token 全部刷新失败。永久性失败（refreshToken 已作废）要说清是哪个账号，
  // 否则用户只能看到"所有账号都失败"而不知道去修哪个。
  const err = new Error("all_accounts_refresh_failed");
  err.accountCount = usable.length;
  err.detail = lastErr ? String(lastErr.message || lastErr) : "";
  err.permanentHint = lastErr && lastErr.permanent
    ? "有账号的 refreshToken 已失效（上游返回 401）。请在控制台「账号」页重新登录，或把最新的 refreshToken 填进 CLINE_REFRESH_TOKEN。"
    : "";
  throw err;
}

// 按当前策略把候选账号排成一个尝试顺序。
// fill：永远先用第一个（用满一个号再换）；random：打乱；round_robin：从游标起轮转。
function accountOrder(usable) {
  const strategy = runtimeState.strategy;
  if (strategy === "random") {
    const copy = usable.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  if (strategy === "fill") return usable.slice();
  // round_robin：从游标处开始轮转，游标随后前移一位
  const pool = accounts;
  const start = pool.length ? accountIndex % pool.length : 0;
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    const acc = pool[(start + i) % pool.length];
    if (usable.includes(acc)) out.push(acc);
  }
  for (const acc of usable) if (!out.includes(acc)) out.push(acc);
  accountIndex = (start + 1) % (pool.length || 1);
  return out;
}

// Cline 客户端指纹请求头（官方靠这些头识别"是不是 Cline 客户端"）
// 缺少会被 403: "deepseek/deepseek-v4-flash is only available via Cline product surfaces"
// token 显式传参（原先读模块级 currentToken，切号时可能串到别的账号）
const CLINE_FINGERPRINT_HEADERS = {
  "User-Agent": "Cline/3.0.47",
  "HTTP-Referer": "https://cline.bot",
  "X-Title": "Cline",
  "X-IS-MULTIROOT": "false",
  "X-CLIENT-TYPE": "cline-sdk",
  "X-CLIENT-VERSION": "3.0.47",
  "X-PLATFORM": "terminal",
  "X-PLATFORM-VERSION": "3.0.47",
  "X-CORE-VERSION": "0.0.66",
};

function clineHeaders(sessionId, token) {
  const h = {
    Authorization: "Bearer workos:" + token,
    "Content-Type": "application/json",
    ...CLINE_FINGERPRINT_HEADERS,
    "X-Task-ID": sessionId,
  };
  // 控制台里配的自定义头覆盖内置值。上游会靠这些头判断"是不是 Cline 客户端"，
  // 所以覆盖是危险动作——但版本号变化（客户端升级）时会需要它，交回给用户。
  for (const [k, v] of Object.entries(runtimeState.headers || {})) {
    if (typeof v === "string" && v) h[k] = v;
  }
  return h;
}

async function clineFetch(env, path, bodyObj, sessionId, modelId, signal, retried = false) {
  const token = await getAccessToken(env, modelId);
  const headers = clineHeaders(sessionId, token);
  // 把此刻的账号钉在响应上：usage 要等流读完才拿得到，那时 currentAccount
  // 可能已经被下一个请求改掉了，只有随响应携带的引用才准（见统计模块约束 2）
  const resp = bindResponseAccount(await fetchWithTimeout(CLINE_API_BASE + path, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS, signal));
  if (resp.status === 401 && !retried) {
    // token 失效：清掉该账号的缓存，强制刷新后重试一次。
    // 刻意不在这里标记冷却——401 是账号级凭据问题，与「账号×模型」的额度冷却
    // 是两件事，混在一起会让额度信息被凭据错误覆盖掉。
    if (currentAccount) {
      currentAccount.accessToken = null;
      currentAccount.expiry = 0;
    }
    return clineFetch(env, path, bodyObj, sessionId, modelId, signal, true);
  }
  return resp;
}

// ---------------------------------------------------------------------------
// 并发限流队列：上游免费通道并发超过 1 就返回空响应，这里强制串行 + 间隔
// ---------------------------------------------------------------------------

let queueTail = Promise.resolve(); // 全局串行队列尾巴
const MIN_GAP_MS = 800;            // 两次上游请求最小间隔

function enqueue(fn) {
  // 前一个任务结束后，等待间隔，再执行 fn
  const run = queueTail.then(() => sleep(MIN_GAP_MS)).then(fn);
  // 不管成功失败都继续链，避免队列断裂
  queueTail = run.catch(() => {});
  return run;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 带重试的 clineFetch：429 额度/限流、空响应自动切换账号重试。
// 一个号的某模型额度用完或限流时：
//   - 只冷却「该账号 × 该模型」这一组合（冷却时长优先用上游给的重置时间）
//   - 自动轮换到下一个号重试同一请求
// 所有账号的该模型都在冷却时，直接返回原始响应（不空转）
//
// modelId 是本次实际发给上游的模型（冷却键必须与实际查询的模型一致，
// 否则会标记到一个永远不会被查询的 key 上，冷却静默失效）。
async function clineFetchWithRetry(env, path, bodyObj, sessionId, modelId, maxRetries = 4, signal) {
  let lastResp = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 通过队列串行执行，避免并发空响应
    const resp = await enqueue(() => clineFetch(env, path, bodyObj, sessionId, modelId, signal));
    lastResp = resp;

    // ⚠️ 关键：成功响应必须原样立刻返回，绝不能在这里 clone().text() 读 body。
    //    旧实现在转发前 `await resp.clone().text()` 把整个流读完，
    //    导致流式请求的首字节要等到模型全部生成完才到达客户端（实测 TTFT≈总耗时），
    //    流式退化成"假流式"。限流/错误判定只需在非 2xx 时读 body（体量很小）。
    if (resp.ok) {
      // 只统计"上游接受了这次请求"。流式响应此刻还没读完，但它已成功建连，
      // 用来判断账号是否还能用足够了 —— 这也是唯一不破坏流式透传的埋点位置。
      markAccountResult(null);
      return resp;
    }

    // 非 2xx：读 body 用于判定"额度/限流"信号（需要切号）
    // 1. 429（free limit reached / rate limit）
    // 2. 5xx 且含 empty response content
    let bodyText = "";
    try {
      bodyText = await resp.clone().text();
    } catch (e) { /* body 已不可读：按非限流错误处理 */ }
    const isLimitHit =
      resp.status === 429 ||
      (resp.status >= 500 && bodyText.includes("empty response content"));

    if (isLimitHit) {
      const acc = currentAccount;
      if (acc) {
        const { ttl, info } = applyCooldown(acc, modelId, bodyText, Date.now());
        markAccountResult("HTTP " + resp.status + " 额度/限流");
        const kindNote = info.kind === "unknown" ? "（未识别的 429）" : "（" + info.kind + "）";
        console.log("[account-switch] " + (acc.email || acc.id) + " × " + modelId +
          " 冷却 " + Math.round(ttl / 1000) + "s " + kindNote +
          (info.resetsAt ? "，重置于 " + formatResetAt(info.resetsAt) : "") + "，切换到下一个");
      }
      // 还有账号的该模型可用 → 短退避后重试（会切到下一个号）
      const pool = activeAccounts(env);
      const now = Date.now();
      const hasOther = pool.some((a) => !isCooling(accountId(a), modelId, now));
      if (!hasOther) {
        console.log("[retry] 所有账号的该模型均在冷却，直接返回上游响应");
        return resp; // 不空转，把 429/错误返回给客户端
      }
      await sleep(500 + Math.floor(Math.random() * 500));
      continue;
    }

    // 401：token 可能刚失效（并发下 refresh 慢了一步），强制刷新后重试一次。
    // clineFetch 内部已做过一次同 token 重试，走到这里说明刷新也没救回来。
    if (resp.status === 401 && attempt < maxRetries) {
      const acc = currentAccount;
      if (acc) {
        acc.accessToken = null;
        acc.expiry = 0;
        markAccountResult("HTTP 401 凭据失效");
      }
      await sleep(300);
      continue;
    }

    // 其他错误（403/400/402 等）不重试，直接返回
    markAccountResult("HTTP " + resp.status);
    return resp;
  }
  // 重试次数用完，返回最后一次响应
  return lastResp;
}

// ---------------------------------------------------------------------------
// 账号登录（WorkOS 设备授权码流程）
// 逆向自 cline_oauth.py / cline2api auth.go，逻辑一致，只是搬到 Worker 里，
// 让控制台可以点按钮完成登录，不必装 Python 跑脚本。
//
// 流程：start 拿 device_code + 授权链接 → 用户浏览器授权 →
//       poll 轮询换 WorkOS token → 注册换 Cline refreshToken。
// ⚠️ 两个端点都要求 API_KEY：未鉴权就等于开放 OAuth 代理，会被滥用。
// ---------------------------------------------------------------------------

async function handleLoginStart(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  try {
    const resp = await fetch(WORKOS_DEVICE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }).toString(),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return jsonResponse({
        error: { message: "启动授权失败（HTTP " + resp.status + "）", type: "login_error", detail: t.slice(0, 300) },
      }, 502);
    }
    const d = await resp.json();
    const url = d.verification_uri_complete || d.verification_uri;
    if (!d.device_code || !url) {
      return jsonResponse({ error: { message: "上游返回的授权信息不完整", type: "login_error" } }, 502);
    }
    return jsonResponse({
      ok: true,
      device_code: d.device_code,
      user_code: d.user_code || "",
      verification_uri: url,
      interval: Math.max(d.interval || 5, 5),
      expires_in: d.expires_in || 300,
    }, 200);
  } catch (e) {
    return jsonResponse({ error: { message: "启动授权异常：" + (e && e.message || e), type: "login_error" } }, 500);
  }
}

async function handleLoginPoll(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }
  const deviceCode = (body.device_code || "").trim();
  if (!deviceCode) {
    return jsonResponse({ error: { message: "缺少 device_code", type: "login_error" } }, 400);
  }

  try {
    // WorkOS 用 HTTP 400 + {error:"authorization_pending"} 表示"用户还没授权"，
    // 这是正常等待态，不是错误（cline_oauth.py 早期版本在这里误报过）。
    const resp = await fetch(WORKOS_AUTH, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: WORKOS_CLIENT_ID,
      }).toString(),
    });
    const w = await resp.json().catch(() => ({}));

    if (w.error === "authorization_pending") {
      return jsonResponse({ ok: true, status: "pending" }, 200);
    }
    if (w.error === "slow_down") {
      return jsonResponse({ ok: true, status: "slow_down" }, 200);
    }
    if (w.error) {
      const expired = w.error === "expired_token";
      return jsonResponse({
        ok: false,
        status: "failed",
        error: {
          message: expired ? "授权码已过期，请重新点击登录。" : "授权失败：" + (w.error_description || w.error),
          type: "login_error",
          reason: w.error,
        },
      }, 200);
    }
    if (!w.access_token) {
      return jsonResponse({ ok: true, status: "pending" }, 200);
    }

    // 用 WorkOS token 换 Cline refreshToken
    const reg = await fetch(CLINE_REGISTER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: w.access_token, refreshToken: w.refresh_token }),
    });
    const rj = await reg.json().catch(() => ({}));
    const rt = rj && rj.data && rj.data.refreshToken;
    if (!rt) {
      return jsonResponse({
        ok: false,
        status: "failed",
        error: { message: "注册失败：上游未返回 refreshToken", type: "login_error", detail: JSON.stringify(rj).slice(0, 300) },
      }, 200);
    }
    const email = ((rj.data && rj.data.userInfo) || {}).email || "";

    // 追加到账号池：本次实例立即生效，无需重启。
    // 同时落盘（本地运行时由 local-server.js 写文件），所以重启也不丢。
    const list = runtimeState.dynamicAccounts;
    const existing = list.find((a) => (a.originToken || a.refreshToken) === rt || a.refreshToken === rt);
    if (!existing) {
      list.push({ refreshToken: rt, originToken: rt, email });
      accountPoolDirty = true; // 让 parseAccounts 重建，纳入新账号
      scheduleStateFlush();
    }
    console.log("[login] 新增账号成功，当前账号数:", list.length);

    return jsonResponse({
      ok: true, status: "success", email,
      refresh_token: rt,
      // 告诉前端「这份 token 是否已经落盘」：本地运行会自动存，云端只能手动搬。
      // 用 runtimeState 是否接了持久化钩子来判断，比猜运行环境可靠。
      persisted: !!statePersistCb,
    }, 200);
  } catch (e) {
    return jsonResponse({
      ok: false, status: "failed",
      error: { message: "轮询异常：" + (e && e.message || e), type: "login_error" },
    }, 500);
  }
}



// ---------------------------------------------------------------------------
// 请求/响应公共辅助
// ---------------------------------------------------------------------------

// 读 JSON 请求体，带大小上限。
// 本地服务把整个 body 读进内存，没上限的话任何人都能 POST 一个任意大的 body
// 直到 OOM。Content-Length 存在时先挡一道（省得白读一遍），实际字节数再验一次
// （chunked 请求没有 Content-Length，只信头部会被绕过）。
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared && declared > MAX_BODY_BYTES) {
    const err = new Error("body_too_large");
    err.declared = declared;
    throw err;
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    const err = new Error("body_too_large");
    err.declared = text.length;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("invalid_json");
  }
}

function bodyErrorResponse(e) {
  const msg = String((e && e.message) || e);
  if (msg === "body_too_large") {
    return jsonResponse({
      error: {
        message: "请求体过大（上限 " + Math.round(MAX_BODY_BYTES / 1048576) + " MiB）" +
                 (e && e.declared ? "，实际 " + e.declared + " 字节" : ""),
        type: "request_too_large",
      },
    }, 413);
  }
  if (msg === "invalid_json") {
    return jsonResponse({ error: { message: "Invalid JSON body", type: "parse_error" } }, 400);
  }
  return jsonResponse({ error: { message: msg, type: "api_error" } }, 400);
}

// 把上游状态码映射成给客户端的状态码。
//
// 关键一条：上游 401/403 是**我们**的账号凭据/风控出了问题，不是客户端的 API Key
// 有问题。原样透传会让客户端以为自己的 Key 错了，跑去反复重配。所以映射成 502
// （"我们的链路问题"），并附上账号侧的排查提示。
function clientStatusForUpstream(upstreamStatus) {
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus === 401 || upstreamStatus === 403) return 502;
  if (upstreamStatus >= 400 && upstreamStatus < 500) return upstreamStatus;
  return 502;
}

const UPSTREAM_STATUS_HINT = {
  401: "上游拒绝了账号凭据（401）。请在控制台「账号」页重新登录，或检查 refreshToken 是否已失效。",
  403: "上游拒绝了本次请求（403）。常见原因是账号风控或模型不在该账号可用范围内，可在「上游渠道」页探测该模型。",
  402: "该模型需要付费余额（402）。请改用免费通道（模型名以 cline-free/ 或带 :free 后缀），或在「账号」页查看余额。",
  404: "上游没有这个模型（404）。请在「模型」页确认模型 ID 是否存在。",
};

function upstreamErrorResponse(status, errText) {
  const clientStatus = clientStatusForUpstream(status);
  const body = String(errText || "").slice(0, 500);
  const hint = UPSTREAM_STATUS_HINT[status];
  return jsonResponse({
    error: {
      message: "upstream error: " + body + (hint ? "\n" + hint : ""),
      type: "api_error",
      upstream_status: status,
    },
  }, clientStatus);
}

// 记一次上游失败，供控制台展示（不影响调度）
function recordUpstreamFailure(status, errText) {
  const kind = status === 429 ? "额度/限流"
    : (status === 401 || status === 403) ? "凭据/风控"
    : status === 402 ? "余额不足"
    : "HTTP " + status;
  console.log("[upstream] " + kind + "：" + String(errText || "").slice(0, 200));
}

// system prompt 覆盖：配了 overridePrompt 时替换客户端传来的 system 消息。
//
// 与参考实现的 override.md 同一用途，但这里是设置项而不是文件——云端没有可写
// 磁盘，而且控制台里改一处比让用户去容器里挂载文件方便得多。
function applyOverridePrompt(messages) {
  const override = String(runtimeState.overridePrompt || "").trim();
  const list = Array.isArray(messages) ? messages.slice() : [];
  if (!override) return list;
  const isSystem = (m) => m && typeof m === "object" &&
    String(m.role || "").toLowerCase() === "system";
  // 覆盖值放在原 system 消息的位置；客户端本来没有 system 消息时放到最前面
  // （system 惯例在最前，放后面会被多数上游当成普通上下文）。
  const at = Math.max(list.findIndex(isSystem), 0);
  const rest = list.filter((m) => !isSystem(m));
  // at 是原列表里的下标，剔除 system 后要换算成 rest 里的等价位置：
  // 原下标之前有几个 system 就往前挪几位。
  const before = list.slice(0, at).filter(isSystem).length;
  rest.splice(Math.max(at - before, 0), 0, { role: "system", content: override });
  return rest;
}

// ---------------------------------------------------------------------------
// OpenAI 协议
// ---------------------------------------------------------------------------

async function handleChat(request, env) {
  // API Key 鉴权
  const auth = getApiKey(request, env);
  if (!auth.ok) {
    return authError(auth.reason);
  }
  // 鉴权通过后才计数：鉴权失败的请求不消耗上游额度，计进去会污染重试放大倍数
  countClientRequest();

  let params;
  try {
    params = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }

  const isStream = !!params.stream;
  const sessionId = "sess_" + Date.now();
  const requestedModel = params.model || defaultModelId();
  // 上游模型 ID：优先取控制台里配的重定向，否则原样透传。
  // 注意**不校验**它是否在启用列表里——启用列表是"发现过滤器"（决定 /v1/models
  // 列什么），不是访问控制。写死模型 ID 的客户端不该因为没在面板里点过就失败。
  const cfg = lookupModelUpstream(requestedModel);
  const upstreamModel = (cfg && cfg.redirect) || requestedModel;

  // 构造上游 body（外部模型 ID 与 Cline 上游模型 ID 分离）
  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: params.reasoning_effort || params.reasoningEffort || "high",
    messages: applyOverridePrompt(params.messages || []),
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500 "empty response content"，
  //    剥掉该字段再转发（max_tokens 不影响生成本质，只影响客户端显示）。
  //    注意: 上游生成 finish_reason=stop 时 completion 可能很长，客户端无法提前截断，属已知代价。
  // ⚠️ 免费 DeepSeek 通道：非流式请求被上游限流(500 empty response content)，
  //    流式请求正常。所以客户端要非流式时，强制上游走 stream，再聚合返回。
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  // 透传可选参数
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "stop", "presence_penalty", "frequency_penalty", "response_format", "user", "n", "seed"]) {
    if (params[k] !== undefined) body[k] = params[k];
  }
  // 上游渠道钉住与模型重定向。放在客户端字段透传**之后**，这样面板里配置的偏好
  // 优先于客户端传进来的同名键——否则任意持有 API Key 的调用者都能覆盖后台路由。
  applyUpstreamPrefs(body, requestedModel);

  const signal = request.signal;
  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, upstreamModel, 4, signal);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      recordUpstreamFailure(resp.status, errText);
      return upstreamErrorResponse(resp.status, errText);
    }
    if (isStream) {
      // 客户端要流式：直接透传 SSE
      return streamResponse(resp, requestedModel);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合 chunks 再返回
      // ⚠️ 免费通道(deepseek/ClineFreePool)会概率性返回「HTTP200但content全程为空」的流
      //    （100个chunk全是reasoning，无正式content）。这里做内容检测：空则切号重试。
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, upstreamModel, resp, signal);
      if (retried.error) return retried.error;
      retried.data.model = requestedModel;
      return jsonResponse(retried.data, 200);
    }
    // 非流式 + 非 deepseek：原逻辑
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    recordUsage(resp, normalized?.usage, { model: upstreamModel });
    normalized.model = requestedModel;
    return jsonResponse(normalized, 200);
  } catch (e) {
    return errorResponse(e);
  }
}

// 把上游 SSE 流聚合成 OpenAI 非流式响应对象
// 用于"客户端要非流式，但上游只能流式"的情况（deepseek 免费通道）
// 额外处理：上游 200 但 content 全空（只有 reasoning）→ 视为坏响应，切号重试
// 由调用方传入"已获取的上游响应"，这里负责聚合 + content 检测 + 空则重试。
async function nonStreamWithContentCheck(env, path, bodyObj, sessionId, modelId, firstResp, signal) {
  const maxAttempts = 3; // 最多试 3 次（覆盖多账号切换）
  let lastData = null;
  let resp = firstResp;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!resp) {
      // 需要重新发起上游请求（空响应重试时）
      resp = await clineFetchWithRetry(env, path, bodyObj, sessionId, modelId, 4, signal);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { error: upstreamErrorResponse(resp.status, errText) };
    }
    const ct = resp.headers.get("content-type") || "";
    let normalized = null;
    let rawUsage = null;
    if (ct.includes("text/event-stream")) {
      const agg = await streamToNonStream(resp);
      normalized = agg.data;
      rawUsage = agg.rawUsage;
    } else {
      const raw = await resp.json().catch(() => null);
      if (raw) {
        normalized = unwrapData(raw);
        rawUsage = normalized?.usage;
      }
    }
    if (!normalized) {
      return { error: jsonResponse({ error: { message: "upstream returned non-SSE body", type: "api_error" } }, 502) };
    }
    // 每轮都落账：这一轮真的打了一次上游，失败重试的那几次同样烧了 token。
    // 放在 content 判定之前，才能把"空响应浪费掉的额度"也统计进去。
    recordUsage(resp, rawUsage, { model: bodyObj?.model });
    lastData = normalized;
    const msg = normalized?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const reasoning = (msg.reasoning || "").trim();
    // ⚠️ reasoning 兜底标记：content 为空时 streamToNonStream 会把 reasoning 拼进 content，
    //    这里要识别出来，不能把它当成"好响应"。
    const isReasoningFallback = msg.reasoning_used_as_content === true;
    if (content && !isReasoningFallback) {
      return { data: normalized }; // 有正式 content → 好响应
    }
    // content 为空（或只有兜底 reasoning）：如果只有 reasoning，标记当前账号的
    // 「该模型」冷却并重试。
    // 只冷却这个组合而不是整个账号：空响应是上游对「这个模型」的限流表现，
    // 同账号的其它模型往往是好的，整号冷却会白扔掉可用额度。
    if (reasoning || isReasoningFallback) {
      if (currentAccount) {
        const info = { kind: "empty", detail: "HTTP 200 但 content 全程为空（仅 reasoning）", resetsAt: 0 };
        markCooldown(accountId(currentAccount), currentAccount.email, modelId, 30 * 1000, info);
        currentAccount.accessToken = null;
        currentAccount.expiry = 0;
        console.log("[empty-content] " + (currentAccount.email || "账号") + " × " + modelId +
          " 返回空 content，冷却 30s，重试第 " + (attempt + 2) + " 次");
      }
      await sleep(300 + Math.floor(Math.random() * 300));
      resp = null; // 下次循环重新请求（切到下一个号）
      continue;
    }
    // 完全空（连 reasoning 都没有）→ 也重试
    console.log("[empty-response] 第 " + (attempt + 2) + " 次重试：上游完全空响应");
    await sleep(300 + Math.floor(Math.random() * 300));
    resp = null;
  }
  // 重试用完仍空：返回最后一次（至少带 reasoning，让客户端看到点东西）
  return { data: lastData };
}

async function streamToNonStream(upstream) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = null;
  let model = "";
  let id = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const normalized = unwrapData(obj);
        const choice = normalized?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (normalized.id) id = normalized.id;
        if (normalized.model) model = normalized.model;
        if (normalized.usage) usage = normalized.usage;
      } catch {}
    }
  }

  const msg = { role: "assistant", content };
  if (reasoning) msg.reasoning = reasoning;
  // ⚠️ 兜底：免费通道偶尔整个流只有 reasoning 没有 content（HTTP 200 但空）。
  //    聚合后发现 content 仍为空且 reasoning 非空时，把 reasoning 拼进 content，
  //    保证客户端（qwenpaw 等）至少能收到可见内容，不会"静默不回复"。
  if (!content && reasoning) {
    msg.content = reasoning;
    msg.reasoning_used_as_content = true;
  }
  // usage 一并带出去：调用方按"每次上游调用"落账（重试的那几次也各记一笔）
  return {
    data: {
      id: id || "gen_" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || DEFAULT_MODEL,
      choices: [{
        index: 0,
        message: msg,
        finish_reason: finishReason || "stop",
        logprobs: null,
        native_finish_reason: finishReason || "stop",
      }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    rawUsage: usage,
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API → 转 OpenAI 格式再转发
// ---------------------------------------------------------------------------

async function handleAnthropic(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) {
    return authError(auth.reason);
  }
  // 同 handleChat：鉴权通过后才计入客户端请求数
  countClientRequest();

  let req;
  try {
    req = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }

  const isStream = !!req.stream;
  const sessionId = "sess_" + Date.now();
  const requestedModel = req.model || defaultModelId();
  const upCfg = lookupModelUpstream(requestedModel);
  // 同 handleChat：上游模型 ID 只应用控制台配的重定向，不校验是否在启用列表里
  const upstreamModel = (upCfg && upCfg.redirect) || requestedModel;

  // Anthropic → OpenAI 消息转换
  const messages = [];
  if (req.system) {
    const sysContent = typeof req.system === "string" ? req.system : JSON.stringify(req.system);
    messages.push({ role: "system", content: sysContent });
  }
  for (const m of req.messages || []) {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    messages.push({ role: m.role, content });
  }

  const body = {
    model: upstreamModel,
    session_id: sessionId,
    reasoning_effort: "high",
    messages: applyOverridePrompt(messages),
  };
  // ⚠️ 上游风控: 免费模型请求体带 max_tokens 字段一律 500，剥离（同 chat/completions 路径）
  // ⚠️ 免费 DeepSeek 通道：非流式被上游限流，强制上游 stream 再聚合
  const forceStream = !isStream && (upstreamModel.startsWith("deepseek/") || upstreamModel.startsWith("cline-free/") || upstreamModel.startsWith("cline-pass/"));
  if (isStream || forceStream) body.stream = true;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || {} },
    }));
  }
  // 上游渠道钉住（同 OpenAI 路径，放在客户端字段之后）
  applyUpstreamPrefs(body, requestedModel);

  const signal = request.signal;
  try {
    const resp = await clineFetchWithRetry(env, "/chat/completions", body, sessionId, upstreamModel, 4, signal);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      recordUpstreamFailure(resp.status, errText);
      return upstreamErrorResponse(resp.status, errText);
    }
    if (isStream) {
      // 上游是 OpenAI SSE，转成 Anthropic SSE 格式
      return streamResponseAnthropic(resp, requestedModel);
    }
    if (forceStream) {
      // 客户端要非流式 + 上游是流式：聚合后再转 Anthropic
      // ⚠️ 同样做 content 检测：免费通道会概率性返回"200但content全空"的流，空则切号重试
      const retried = await nonStreamWithContentCheck(env, "/chat/completions", body, sessionId, upstreamModel, resp, signal);
      if (retried.error) return retried.error;
      return jsonResponse(openAItoAnthropic(retried.data), 200);
    }
    const raw = await resp.json();
    const normalized = unwrapData(raw);
    recordUsage(resp, normalized?.usage, { model: upstreamModel });
    // OpenAI → Anthropic
    return jsonResponse(openAItoAnthropic(normalized), 200);
  } catch (e) {
    return errorResponse(e);
  }
}

// ---------------------------------------------------------------------------
// 响应处理
// ---------------------------------------------------------------------------

// 剥掉上游 {data:{...}} 包装（上游有时包一层 data）
function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    const d = obj.data;
    if (d.choices || d.id || d.usage) return d;
  }
  return obj;
}

// OpenAI SSE 流式透传（剥 data 包装）
async function streamResponse(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buf = "";
  let rawUsage = null;   // 上游收尾 chunk 里的 usage，流读完后落账
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // 按行处理
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") {
              await writer.write(encoder.encode(line + "\n\n"));
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const normalized = unwrapData(obj);
              // 顺手捞 usage：这里已经 parse 过一次，不额外读流、不破坏流式透传
              if (normalized?.usage) rawUsage = normalized.usage;
              if (normalized && externalModel) normalized.model = externalModel;
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch {
              await writer.write(encoder.encode(line + "\n"));
            }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch (e) {
      // 上游中途断开（连接被重置、超时、客户端取消）：必须发一个 error chunk 再结束。
      // 旧实现只 break，客户端拿不到任何错误信号，只能等连接关闭才察觉，
      // 看起来就像「回答被莫名截断」——比报错更难排查。
      //
      // 客户端自己取消时（signal.aborted）不发 error chunk：对方已经不在了，
      // 写进去只会得到一个 "write after cancel" 的噪音异常。
      const aborted = e && (e.name === "AbortError" || String(e.message || "").includes("client_aborted"));
      if (!aborted) {
        console.log("[stream] 上游流中断：" + String((e && e.message) || e));
        try {
          const msg = {
            error: { message: "upstream stream failed: " + String((e && e.message) || e), type: "upstream_error" },
          };
          await writer.write(encoder.encode("data: " + JSON.stringify(msg) + "\n\n"));
        } catch (writeErr) { /* 客户端已断开，无法投递 */ }
      }
    } finally {
      // 客户端提前断开也会走到这里：那时 rawUsage 为 null，记一笔 missing
      recordUsage(upstream, rawUsage, { model: externalModel });
      releaseUpstream(upstream);
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// Anthropic SSE：把上游 OpenAI chunk 转成 Anthropic 格式
async function streamResponseAnthropic(upstream, externalModel) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const msgId = "msg_" + Date.now();
  const send = (event, data) =>
    writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  // ⚠️ Anthropic SSE 协议要求按顺序发：message_start → content_block_start →
  //    content_block_delta* → content_block_stop → message_delta → message_stop。
  //    旧实现直接甩 content_block_delta，缺 message_start/content_block_start，
  //    对协议校验严格的 Anthropic SDK / 客户端会解析失败。
  let buf = "";
  let started = false;        // 是否已发 message_start
  let textBlockOpen = false;  // 文本块是否已 start
  let toolBlockIndex = null;  // 当前工具块序号
  let stopReason = "end_turn";
  let outputTokens = 0;
  let rawUsage = null;        // 完整 usage，流结束后用于落账
  // 注：message_start 里的 input_tokens 恒为 0 —— 该事件必须先于内容发出，
  //     而上游的 usage 只在收尾 chunk 才给，这是协议顺序决定的，无法提前得知。

  const ensureStarted = async () => {
    if (started) return;
    started = true;
    await send("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: externalModel || DEFAULT_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const openTextBlock = async () => {
    if (textBlockOpen) return;
    await ensureStarted();
    textBlockOpen = true;
    toolBlockIndex = null;
    await send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
  };
  const closeTextBlock = async () => {
    if (!textBlockOpen) return;
    textBlockOpen = false;
    await send("content_block_stop", { type: "content_block_stop", index: 0 });
  };

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          let normalized;
          try {
            normalized = unwrapData(JSON.parse(payload));
          } catch {
            continue;
          }
          const choice = normalized?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          if (choice.finish_reason) {
            stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
              : choice.finish_reason === "length" ? "max_tokens"
              : "end_turn";
          }
          if (normalized?.usage) {
            rawUsage = normalized.usage;
            if (normalized.usage.completion_tokens) outputTokens = normalized.usage.completion_tokens;
          }

          if (delta.reasoning) {
            // Anthropic 无对应字段，作为 thinking 块透出（客户端不认也可忽略）
            await ensureStarted();
            await send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: delta.reasoning },
            });
          }

          if (delta.content) {
            await openTextBlock();
            await send("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta.content },
            });
          }

          // 工具调用：上游是 OpenAI 增量分片格式（首片含 id/name，后续片是
          // arguments 片段）。Anthropic 需要 input_json_delta.partial_json 只装
          // 参数片段本身，且必须成对出现 content_block_start(type=tool_use)。
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            await closeTextBlock();
            await ensureStarted();
            for (const tc of delta.tool_calls) {
              if (tc.id || tc.function?.name) {
                // 新工具块开始
                if (toolBlockIndex !== null) {
                  await send("content_block_stop", { type: "content_block_stop", index: toolBlockIndex });
                }
                toolBlockIndex = 1;
                await send("content_block_start", {
                  type: "content_block_start",
                  index: toolBlockIndex,
                  content_block: { type: "tool_use", id: tc.id || "toolu_" + Date.now(), name: tc.function?.name || "", input: {} },
                });
                if (tc.function?.arguments) {
                  await send("content_block_delta", {
                    type: "content_block_delta",
                    index: toolBlockIndex,
                    delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                  });
                }
              } else if (tc.function?.arguments && toolBlockIndex !== null) {
                await send("content_block_delta", {
                  type: "content_block_delta",
                  index: toolBlockIndex,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                });
              }
            }
          }
        }
      }

      // 收尾：确保协议事件完整成对
      await ensureStarted();
      await closeTextBlock();
      if (toolBlockIndex !== null) {
        await send("content_block_stop", { type: "content_block_stop", index: toolBlockIndex });
      }
      await send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      await send("message_stop", { type: "message_stop" });
    } catch (e) {
      // 上游中途断开：必须发 error 事件，并且**不能**再补一套「正常结束」的收尾
      // 事件——否则客户端会把被截断的回答当成模型主动结束（这是最坏的结果：
      // 静默的错误数据比报错危险得多）。
      //
      // Anthropic 的 SSE 里中途出错用 event: error，而不是塞进 message_delta。
      const aborted = e && (e.name === "AbortError" || String(e.message || "").includes("client_aborted"));
      if (!aborted) {
        console.log("[stream] Anthropic 转换中断：" + String((e && e.message) || e));
        try {
          await send("error", {
            type: "error",
            error: { type: "upstream_error", message: "upstream stream failed: " + String((e && e.message) || e) },
          });
        } catch (sendErr) { /* 客户端已断开，无法投递 */ }
      }
    } finally {
      // 无论正常结束还是客户端提前断开都记一笔（断开时 rawUsage 为 null → missing）
      recordUsage(upstream, rawUsage, { model: externalModel });
      releaseUpstream(upstream);
      try { await writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...corsHeaders(),
    },
  });
}

// OpenAI 非流式 → Anthropic 非流式
function openAItoAnthropic(openAI) {
  const choice = openAI?.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  const text = message.content;
  if (typeof text === "string" && text) {
    content.push({ type: "text", text });
  }
  // 工具调用：Anthropic 用 tool_use 块，arguments 需解析成对象
  for (const tc of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tc.id || "toolu_" + Date.now(),
      name: tc.function?.name || "",
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const finish = choice?.finish_reason;
  const stopReason = finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
  return {
    id: openAI?.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: openAI?.model || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openAI?.usage?.prompt_tokens || 0,
      output_tokens: openAI?.usage?.completion_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

// GET /v1/models
//
// ⚠️ 只回**控制台里启用的模型**（effectiveModelIds）：没启用过任何模型时实时取上游
// 推荐，所以全新实例也不会拿到空列表。
//
// 这是"发现过滤器"而不是访问控制：chat 端点不校验模型是否在列表里，写死模型 ID
// 的客户端照常可用。目的是"别让客户端看到四百多个挑不过来的模型"，不是代理 API 的门。
async function handleModels() {
  // 用户一个模型都没启用时，实时取上游当前的免费清单（轮换促销会变，不做本地硬编码）。
  await ensureFreeModelFallback();
  const ids = effectiveModelIds();
  const payload = ids.map((id) => {
    const remote = findRemoteModel(id);
    return {
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: normalizeModelId(id).split("/")[0] || "cline",
      // 附加字段（非 OpenAI 标准，普通客户端会忽略）。
      // 上游清单不保证已抓过，所以这些字段可能为 null —— 不假装知道。
      label: (remote && remote.name) || null,
      context_length: (remote && remote.context_length) || null,
      is_default: id === defaultModelId(),
    };
  });
  return jsonResponse({ object: "list", data: payload }, 200, { "X-Cline2api-Version": VERSION });
}

// ---------------------------------------------------------------------------
// 模型库接口（控制台用）
// ---------------------------------------------------------------------------

// GET /v1/models/library — 推荐分组 + 已启用清单
// GET /v1/models/catalog — 上游全部模型（按供应商分组）
//
// 两个分开的理由：推荐清单只有二十几条、面板一打开就要显示；全部模型有四百多条、
// 上游响应约 500 KB，只在用户展开折叠块时才拉。
async function handleModelLibrary(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  if (request.method !== "GET") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "1";
  const kind = url.pathname.endsWith("/catalog") ? "catalog" : "library";

  try {
    if (kind === "catalog") {
      const res = await catalogSnapshot(force);
      return jsonResponse({
        ok: true,
        groups: groupCatalogModels(res.models),
        total: res.models.length,
        fetched_at: res.fetchedAt,
        cached: res.cached,
        stale: res.stale,
        error: res.error || null,
      }, 200, { "Cache-Control": "no-store" });
    }
    const res = await recommendedSnapshot(force);
    return jsonResponse({
      ok: true,
      groups: res.groups.map((g) => ({
        ...g,
        meta: RECOMMENDED_GROUP_META[g.key] || { title: g.key, sub: "", color: "var(--ink-2)" },
      })),
      fetched_at: res.fetchedAt,
      cached: res.cached,
      stale: res.stale,
      error: res.error || null,
    }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    // 完全没有数据（首次就回源失败）：502 让面板能区分"上游挂了"和"还没有数据"
    return jsonResponse({
      error: { message: String((e && e.message) || e), type: "model_library_error" },
    }, 502, { "Cache-Control": "no-store" });
  }
}

// GET /v1/models/enabled — 已启用模型（带展示元信息）
async function handleModelEnabled(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  if (request.method !== "GET") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  const ids = effectiveModelIds();
  return jsonResponse({
    ok: true,
    models: ids.map(modelView),
    // 给前端区分「用户真的启用过」与「实时取的上游免费清单」——界面提示语不一样
    using_builtin: enabledModels().length === 0,
    default_model: defaultModelId(),
  }, 200, { "Cache-Control": "no-store" });
}

// POST /v1/models/batch  {"ids":[...]} —— 批量启用
//
// 整批一次落盘：面板的「全部添加」一个分组可能有近百个模型，逐个落盘就是上百次
// 整文件写（每次都要序列化全部状态），期间所有请求都要排队。
//
// 已存在的 ID 计入 skipped 而不是报错，因此「全部添加」可以安全地重复点击。
async function handleModelBatchAdd(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }
  const ids = Array.isArray(body.ids) ? body.ids : null;
  if (!ids || !ids.length) {
    return jsonResponse({ error: { message: "ids 不能为空", type: "model_error" } }, 400);
  }
  if (ids.length > MAX_BATCH_MODEL_IDS) {
    return jsonResponse({
      error: { message: "一次最多添加 " + MAX_BATCH_MODEL_IDS + " 个（收到 " + ids.length + "）", type: "model_error" },
    }, 400);
  }
  const res = addModelIds(ids);
  if (res.added.length) scheduleStateFlush();
  return jsonResponse({
    ok: true,
    added: res.added,
    skipped: res.skipped,
    failed: res.failed,
    models: effectiveModelIds().map(modelView),
  }, 200);
}

// POST /v1/models/delete  {"id":"..."} —— 移除一个已启用模型
async function handleModelDelete(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }
  const id = normalizeExistingModelId(body.id);
  if (!id) return jsonResponse({ error: { message: "缺少 id", type: "model_error" } }, 400);
  if (!removeModelId(id)) {
    return jsonResponse({ error: { message: "该模型不在启用列表里：" + id, type: "model_error" } }, 404);
  }
  scheduleStateFlush();
  return jsonResponse({
    ok: true,
    message: "已移除 " + id,
    models: effectiveModelIds().map(modelView),
    default_model: defaultModelId(),
  }, 200);
}

// POST /v1/models/default  {"id":"..."} —— 设为默认模型
async function handleModelSetDefault(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }
  const id = normalizeExistingModelId(body.id);
  if (!id) return jsonResponse({ error: { message: "缺少 id", type: "model_error" } }, 400);
  if (!isModelEnabled(id)) {
    return jsonResponse({
      error: { message: "只能把已启用的模型设为默认：" + id, type: "model_error" },
    }, 400);
  }
  runtimeState.defaultModel = id;
  scheduleStateFlush();
  return jsonResponse({
    ok: true,
    message: "已把 " + id + " 设为默认模型",
    default_model: id,
    models: effectiveModelIds().map(modelView),
  }, 200);
}

// ---------------------------------------------------------------------------
// 模型可用性检测
//
// 与上游渠道探测是两件事，所以分开：
//   探测（probe）  判管道归属、枚举渠道清单 —— 读响应**元数据与错误体**
//   检测（check）  只回答"这个模型现在能不能用" —— 发最短的文本请求看有没有正常回答
//
// 复用同一套异步任务存储（去重 + 并发上限 + 过期淘汰），因为交互形态完全一样：
// 都要打上游、都可能慢，同步返回会让面板转圈到超时。
// ---------------------------------------------------------------------------
async function modelCheckRun(modelId) {
  const upstreamModel = upstreamModelId(modelId);
  const body = probeRequestBody(upstreamModel, PROBE_MAX_TOKENS);
  body.messages = [{ role: "user", content: "Reply with only OK." }];
  applyUpstreamPrefs(body, modelId);
  const start = Date.now();
  const res = await upstreamProbeCall(upstreamModel, body, 90000);
  if (res.status !== 200) {
    // 状态码 → 人能看懂的原因。这条信息直接显示在卡片上，所以要说清"该去做什么"，
    // 而不是把 HTTP 码丢给用户自己猜。
    const reason = res.status === 401 || res.status === 403 ? "当前账号认证失败或无权访问此模型"
      : res.status === 402 ? "当前账号额度或订阅不足"
      : res.status === 404 ? "模型或可用渠道不存在"
      : res.status === 429 ? "当前账号或模型受到限流，请稍后重试"
      : "上游请求失败";
    return { ok: false, kind: "http", text: reason + "（HTTP " + res.status + "）", latencyMs: Date.now() - start };
  }
  // HTTP 200 不足以证明可用：上游会返回"200 但 content 全空"（只有 reasoning）。
  // 这种情况在实际使用中等于不可用，所以必须校验正文。
  const d = res.json ? unwrapUpstream(res.json) : null;
  const choice = d ? firstChoice(d) : null;
  const content = choice && choice.message && typeof choice.message.content === "string"
    ? choice.message.content.trim() : "";
  if ((res.json && res.json.error) || (d && d.error) || !content) {
    return {
      ok: false, kind: "empty",
      text: "未获得有效文本回答，暂不能确认可用（可能是上游异常或输出预算不足）",
      latencyMs: Date.now() - start,
    };
  }
  return { ok: true, kind: "ok", text: "可用 · 首字节 " + (Date.now() - start) + "ms", latencyMs: Date.now() - start };
}

async function handleModelCheck(request, env) {
  const auth = getApiKey(request, env);
  if (!auth.ok) return authError(auth.reason);

  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("jobId") || "";
    const job = probeJobs.get(id);
    if (!job) {
      return jsonResponse({
        error: { message: "检测任务已过期或服务已重启，请重新检测", type: "model_error" },
      }, 404, { "Cache-Control": "no-store" });
    }
    return jsonResponse({ ok: true, job }, 200, { "Cache-Control": "no-store" });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: { message: "method not allowed", type: "model_error" } }, 405);
  }
  let body;
  try {
    body = await readJsonBody(request);
  } catch (e) {
    return bodyErrorResponse(e);
  }
  const v = validateModelId(body.id || body.model_id);
  if (!v.ok) return jsonResponse({ error: { message: v.error, type: "model_error" } }, 400);

  const started = startProbeJob(v.id, modelCheckRun, "check");
  if (started.error) {
    return jsonResponse({ error: { message: started.error, type: "model_error" } },
      started.status, { "Retry-After": "2" });
  }
  return jsonResponse({
    ok: true, job: started.job, shared: started.shared,
    message: started.shared ? "该模型已有一次检测在进行，共享其结果" : "检测已开始",
  }, 202, { "Cache-Control": "no-store" });
}

// 鉴权：fail-closed
// ⚠️ 旧实现在未配置 API_KEY 时回退到硬编码的 "cline2api-default-key"，
//    而该值是公开写在 README 里的 —— 等于任何知道这个默认值的人都能用你的
//    Cline 账号（消耗你的免费额度）。这里改为：未配置 API_KEY 时直接拒绝并给出
//    可操作的提示，绝不回退到公开默认值。
//    /v1/health 与 /v1/models 不受影响（不消耗账号额度，且便于部署自检）。
function getApiKey(request, env) {
  const expected = (env.API_KEY || "").trim();

  const auth = request.headers.get("Authorization") || "";
  let provided = null;
  if (auth.startsWith("Bearer ")) {
    provided = auth.slice(7).trim();
  } else {
    const xKey = request.headers.get("x-api-key");
    if (xKey) provided = xKey.trim();
  }

  if (!expected) {
    if (provided) {
      // 用户传了 key 但服务端没配：明确告诉他原因，而不是默默放行
      return { ok: false, reason: "server_no_key" };
    }
    return { ok: false, reason: "server_no_key" };
  }
  if (!provided) return { ok: false, reason: "missing_client_key" };
  return provided === expected ? { ok: true } : { ok: false, reason: "wrong_client_key" };
}

function authError(reason) {
  const messages = {
    server_no_key:
      "服务端未配置 API_KEY，已拒绝请求（为避免账号被他人使用，不再回退到公开默认密钥）。" +
      "请在部署环境的变量/机密里设置 API_KEY，例如：wrangler secret put API_KEY（Cloudflare）或 vercel env add API_KEY production（Vercel），保存后重新部署。",
    missing_client_key: "缺少 API Key。请用 Authorization: Bearer <你的API_KEY> 或 x-api-key 头传递。",
    wrong_client_key: "API Key 不正确。",
  };
  return jsonResponse({ error: { message: messages[reason] || "鉴权失败", type: "auth_error", reason } }, 401);
}

// ---------------------------------------------------------------------------
// 内置控制台页面（根路径 /）
// 本项目本身没有前端，也不需要构建：这是一个自包含的单文件 HTML，
// 用于部署后自检（看健康状态、拉模型列表、直接试聊天）。
// ⚠️ 内嵌 JS 里避免使用反引号与 ${ }，因为它们会终止外层模板字符串。
// ---------------------------------------------------------------------------

// #region console-html
// ⚠️ 本块由 build-console.mjs 从 console.src.html 生成，请勿手改。
//    要改控制台请编辑 console.src.html，然后运行：node build-console.mjs
const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- ClineFreePool · 控制台
     单文件前端（无外部依赖、无构建），由 build-console.mjs 注入 worker.js。
     风格：Claude 官网语言—— 暖调中性色 + 珊瑚橙主色 + 柔和圆角 + 细腻层次，
     无网格底纹、无扫描线。
     ▲ 本文件里的 JS 不要用模板字符串插值（\${}），构建脚本会转义，用了会失效。 -->
<title>ClineFreePool · 控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d97757'/%3E%3Ctext x='16' y='22' font-family='Georgia,serif' font-size='19' font-weight='bold' fill='%23fff' text-anchor='middle'%3EC%3C/text%3E%3C/svg%3E">
<style>
/* ══ 设计令牌 ══════════════════════════════════════════════════════════
   像素终端语言：直角、2px 描边、硬投影（位移块而非模糊）、网格底纹 + 扫描线、
   全站等宽字体 + tabular-nums 对齐数值。 */
:root {
  color-scheme: dark;
  /* Claude 深色：暖调近黑底，而非冷蓝黑 */
  --bg:#1f1e1d; --surface:#262625; --surface-2:#2f2e2d; --raise:#383635;
  --line:#413f3e; --line-soft:#353332;
  --ink:#f5f4f2; --ink-2:#c8c5c1; --ink-3:#948f8a;
  /* 主色：Claude 珊瑚橙 */
  --accent:#d97757; --accent-ink:#fff; --accent-soft:rgba(217,119,87,.14);
  --ok:#5a9a6b; --ok-soft:rgba(90,154,107,.14);
  --warn:#c99a3e; --warn-soft:rgba(201,154,62,.14);
  --bad:#c4614f; --bad-soft:rgba(196,97,79,.14);
  --cn:#b07d4a; --cn-soft:rgba(176,125,74,.14);   /* 国产模型标记色 */
  --inset:rgba(0,0,0,.22);
  /* Claude 用柔和扩散阴影，替代原来的像素硬投影 */
  --shadow:0 1px 3px rgba(0,0,0,.28);
  --shadow-sm:0 1px 2px rgba(0,0,0,.24);
  --shadow-lg:0 8px 24px rgba(0,0,0,.36);
  --grid:transparent; --grid-step:0px;
  --scan:transparent; --scan-opacity:0;   /* Claude 无CRT 质感 */
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",
         "Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,"Cascadia Mono","JetBrains Mono","SF Mono",Consolas,"Courier New",monospace;
  --radius:10px; --radius-sm:6px; --radius-lg:14px;
  --nav-w:212px;
  --z-sticky:20; --z-fx:200;
}
[data-theme="light"] {
  color-scheme: light;
  /* Claude 浅色：暖米白底，避免纯白的冷硬感 */
  --bg:#f5f4f2; --surface:#fff; --surface-2:#faf9f8; --raise:#fff;
  --line:#e3e0dc; --line-soft:#efedea;
  --ink:#1f1e1d; --ink-2:#5d5854; --ink-3:#8a8480;
  --accent:#c15f3f; --accent-ink:#fff; --accent-soft:rgba(193,95,63,.09);
  --ok:#3f7a4f; --ok-soft:rgba(63,122,79,.09);
  --warn:#8a6a1f; --warn-soft:rgba(138,106,31,.09);
  --bad:#a8412f; --bad-soft:rgba(168,65,47,.09);
  --cn:#8a5f2f; --cn-soft:rgba(138,95,47,.09);
  --inset:rgba(31,30,29,.04);
  --shadow:0 1px 3px rgba(31,30,29,.08);
  --shadow-sm:0 1px 2px rgba(31,30,29,.07);
  --shadow-lg:0 8px 24px rgba(31,30,29,.1);
  --grid:transparent; --grid-step:0px;
  --scan-opacity:0;
}
* { box-sizing:border-box; margin:0; padding:0; }
[hidden] { display:none !important; }
html,body { height:100%; }
body {
  background:var(--bg); color:var(--ink);
  font:13px/1.6 var(--mono); -webkit-font-smoothing:antialiased;
  overflow:hidden;   /* 由 .main 内部滚动，保证日志窗口固定高度 */
}
/* 全屏纹理：网格 + 扫描线，置顶且不拦事件 */
body::before {
  content:""; position:fixed; inset:0; z-index:var(--z-fx); pointer-events:none;
  background-image:
    linear-gradient(var(--grid) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid) 1px,transparent 1px);
  background-size:var(--grid-step) var(--grid-step);
}
body::after {
  content:""; position:fixed; inset:0; z-index:var(--z-fx); pointer-events:none;
  background:repeating-linear-gradient(0deg,var(--scan) 0 1px,transparent 1px 3px);
  opacity:var(--scan-opacity);
}
::selection { background:var(--accent); color:var(--accent-ink); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
* { scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
::-webkit-scrollbar { width:12px; height:12px; }
::-webkit-scrollbar-track { background:var(--surface-2); }
::-webkit-scrollbar-thumb { background:var(--line); border:2px solid var(--surface-2); }
::-webkit-scrollbar-thumb:hover { background:var(--accent); }

/* ══ 壳层 ══ */
.shell { display:grid; grid-template-columns:var(--nav-w) 1fr; height:100dvh; position:relative; z-index:1; }
.main { min-width:0; display:flex; flex-direction:column; height:100dvh; overflow:hidden; }

/* ══ 左侧导航 ══ */
.nav { background:var(--surface); border-right:2px solid var(--line); display:flex; flex-direction:column; }
.brand { padding:15px 14px 13px; border-bottom:2px solid var(--line); }
.brand .name { font-weight:700; letter-spacing:.1em; font-size:12.5px; text-transform:uppercase; display:flex; align-items:center; gap:8px; }
.brand .logo { width:18px; height:18px; flex:none; fill:var(--accent); shape-rendering:crispEdges; }
.brand .sub { color:var(--ink-3); font-size:10.5px; margin-top:4px; letter-spacing:.14em; }
.nav ul { list-style:none; padding:9px 9px; flex:1; overflow-y:auto; }
.nav a {
  display:flex; align-items:center; gap:9px; padding:7px 10px; margin-bottom:3px;
  color:var(--ink-2); text-decoration:none; font-size:12.5px;
  border:2px solid transparent; letter-spacing:.02em; cursor:pointer;
}
.nav a:hover { background:var(--surface-2); color:var(--ink); border-color:var(--line-soft); }
.nav a.on { background:var(--accent-soft); color:var(--accent); font-weight:700; border-color:var(--accent); box-shadow:inset 4px 0 0 0 var(--accent); }
.nav a svg { width:15px; height:15px; flex:none; opacity:.9; }
.nav a .cnt { margin-left:auto; font-size:10.5px; color:var(--ink-3); font-variant-numeric:tabular-nums; }
.nav a.on .cnt { color:var(--accent); }
.nav .sig { padding:10px 14px; border-top:2px solid var(--line); font-size:11px; color:var(--ink-3); }
.nav .sig .row { display:flex; align-items:center; gap:7px; }

/* 账号池（左栏） */
.pool { padding:10px 14px; border-top:2px solid var(--line); }
.pool .hd { display:flex; align-items:baseline; gap:6px; margin-bottom:8px; }
.pool .hd .t { font-size:10.5px; color:var(--ink-3); letter-spacing:.08em; text-transform:uppercase; }
.pool .hd .v { margin-left:auto; font-size:11.5px; font-variant-numeric:tabular-nums; }
.pool .hd .v.ok { color:var(--ok); } .pool .hd .v.warn { color:var(--warn); } .pool .hd .v.bad { color:var(--bad); }
.cells { display:flex; gap:4px; flex-wrap:wrap; }
.cell {
  width:20px; height:20px; border:2px solid var(--line); background:var(--bg);
  display:grid; place-items:center; font-size:10px; color:var(--ink-3);
  font-variant-numeric:tabular-nums; cursor:default;
}
.cell.live { border-color:var(--ok); color:var(--ok); background:var(--ok-soft); }
.cell.cool { border-color:var(--warn); color:var(--warn); background:var(--warn-soft); }
/* part：账号可用，只有部分模型在冷却。用左半填充表示「一半」，
   与整格告警色的 cool 区分开——否则用户会以为这个号完全用不了。 */
.cell.part {
  border-color:var(--line); color:var(--ink-2);
  background-image:linear-gradient(135deg,var(--warn-soft) 0 50%,transparent 50% 100%);
}
.cell.tmp { box-shadow:inset 0 -3px 0 var(--accent); }
.pool .empty { font-size:11px; color:var(--ink-3); line-height:1.5; }

/* ══ 顶栏 ══ */
.topbar {
  display:flex; align-items:center; gap:12px; padding:11px 20px;
  border-bottom:2px solid var(--line); background:var(--surface);
  position:sticky; top:0; z-index:var(--z-sticky); flex:none; flex-wrap:wrap;
}
.topbar h2 { font-size:13px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; }
.topbar .sep { color:var(--accent); font-weight:700; }
.topbar .meta { color:var(--ink-3); font-size:11.5px; }
.topbar .grow { flex:1; }
.fact { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--ink-3); }
.fact .sq { width:8px; height:8px; flex:none; background:var(--ink-3); }
.fact .sq.ok { background:var(--ok); } .fact .sq.warn { background:var(--warn); } .fact .sq.bad { background:var(--bad); }

/* ══ 视图 ══ */
.views { flex:1; min-height:0; position:relative; }
.view { position:absolute; inset:0; overflow-y:auto; padding:18px 20px 40px; display:flex; flex-direction:column; gap:16px; }
.view[hidden] { display:none !important; }
.view.flush { padding:0; gap:0; overflow:hidden; }

/* ══ 面板 box ══ */
.box { background:var(--surface); border:2px solid var(--line); box-shadow:var(--shadow); }
.box > header {
  display:flex; align-items:center; gap:10px; padding:9px 14px;
  border-bottom:2px solid var(--line); background:var(--surface-2); flex-wrap:wrap;
}
.box > header h3 { font-size:12px; font-weight:700; letter-spacing:.06em; display:flex; align-items:center; gap:8px; }
.box > header h3::before {
  content:""; width:8px; height:8px; flex:none; background:var(--accent);
  clip-path:polygon(0 0,100% 0,100% 55%,55% 55%,55% 100%,0 100%);
}
.box > header .grow { flex:1; }
.box > header .note { color:var(--ink-3); font-size:11px; }
.box .pad { padding:14px; }
.box .pad0 { padding:0; }

/* 网格布局：紧凑填充，不留大片空白 */
.grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; }
.grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; align-items:start; }
/* 对话页：左栏撑满剩余高度，右栏独立滚动，避免底部留白。
   需要一路 min-height:0，否则 flex/grid 子项按内容高度计算，撑不开。 */
.grid-chat { display:grid; grid-template-columns:1fr 320px; gap:16px; flex:1; min-height:0; align-items:stretch; }
.grid-chat > * { min-height:0; }
.grid-chat .aside { display:flex; flex-direction:column; gap:16px; min-height:0; overflow-y:auto; }
@media (max-width:1200px){ .grid-chat{ grid-template-columns:1fr; flex:none; } .grid-chat .aside{ overflow:visible; } }
@media (max-width:900px){ .grid2,.grid3{ grid-template-columns:1fr; } }

/* ══ 控件 ══ */
button {
  font:inherit; font-size:12.5px; letter-spacing:.02em; color:var(--ink);
  background:var(--surface-2); border:2px solid var(--line); padding:6px 12px; cursor:pointer;
  box-shadow:var(--shadow-sm);
  transition:transform .07s steps(2), box-shadow .07s steps(2), background .12s, border-color .12s, color .12s;
}
button:hover:not(:disabled){ border-color:var(--accent); color:var(--accent); }
button:active:not(:disabled){ transform:translate(3px,3px); box-shadow:0 0 0 0 transparent; }
button:disabled{ opacity:.45; cursor:default; }
button.primary{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
button.primary:hover:not(:disabled){ filter:brightness(1.12); color:var(--accent-ink); }
button.ghost{ background:transparent; }
button.danger{ color:var(--bad); }
button.danger:hover:not(:disabled){ border-color:var(--bad); color:var(--bad); }
button.xs{ padding:2px 8px; font-size:11px; box-shadow:2px 2px 0 0 rgba(0,0,0,.4); }
button.xs:active:not(:disabled){ transform:translate(2px,2px); }
button.done{ background:var(--ok); border-color:var(--ok); color:#04160a; }
input,select,textarea {
  font:inherit; font-size:12.5px; color:var(--ink); background:var(--bg);
  border:2px solid var(--line); padding:6px 9px; width:100%;
}
input:focus,select:focus,textarea:focus{ outline:none; border-color:var(--accent); }
input::placeholder,textarea::placeholder{ color:var(--ink-3); }
textarea{ resize:vertical; line-height:1.55; }
select{
  appearance:none; -webkit-appearance:none; cursor:pointer; padding-right:26px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2361738a' stroke-width='1.6'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right 8px center;
}
label.lb{ display:block; font-size:11px; color:var(--ink-3); margin-bottom:5px; letter-spacing:.04em; }
.chk{ display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-2); cursor:pointer; user-select:none; }
.chk input{ width:auto; accent-color:var(--accent); }

/* ══ 行内提示条 ══
   只用于页面内固定位置（账号页的状态判断、模型页说明、登录结果）。
   全局状态提示不放这里：它原来压在 .views 顶部，会盖住各页头部的按钮，
   现改为右下角弹窗（见 toast / syncNotices）。 */
.note{
  display:flex; align-items:center; gap:10px; padding:9px 12px; font-size:12px;
  border:2px solid; box-shadow:var(--shadow-sm);
}
.note .grow{ flex:1; }
.note.info{ background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
.note.warn{ background:var(--warn-soft); border-color:var(--warn); color:var(--warn); }
.note.bad{ background:var(--bad-soft); border-color:var(--bad); color:var(--bad); }
.note.ok{ background:var(--ok-soft); border-color:var(--ok); color:var(--ok); }

/* ══ 对话 ══ */
.thread{ overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; min-height:240px; }
.thread .empty{ color:var(--ink-3); text-align:center; padding:44px 16px; font-size:12px; }
.turn{ display:grid; grid-template-columns:26px 1fr; gap:10px; }
.turn .who{
  width:26px; height:26px; display:grid; place-items:center; font-size:10px; font-weight:700;
  border:2px solid var(--line); color:var(--ink-3); background:var(--bg);
}
.turn.me .who{ border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.turn.ai .who{ border-color:var(--ok); color:var(--ok); background:var(--ok-soft); }
.turn.err .who{ border-color:var(--bad); color:var(--bad); background:var(--bad-soft); }
.turn .txt{ white-space:pre-wrap; word-break:break-word; font-size:12.5px; line-height:1.65; }
.turn .stats{ margin-top:6px; font-size:10.5px; color:var(--ink-3); font-variant-numeric:tabular-nums; display:flex; flex-wrap:wrap; gap:0 10px; }
.turn .stats .hi{ color:var(--accent); } .turn .stats .lo{ color:var(--warn); }
details.rz{ margin-top:6px; }
details.rz > summary{ font-size:11px; color:var(--ink-3); cursor:pointer; list-style:none; display:inline-block; border-bottom:1px dashed var(--line); }
details.rz > summary::-webkit-details-marker{ display:none; }
details.rz > summary:hover{ color:var(--accent); border-color:var(--accent); }
details.rz pre{
  margin-top:7px; padding:9px 11px; white-space:pre-wrap; word-break:break-word;
  font:11.5px/1.65 var(--mono); color:var(--ink-2); background:var(--bg);
  border:2px solid var(--line-soft); border-left:3px solid var(--accent);
  max-height:260px; overflow:auto;
}
.gen{ color:var(--accent); }
.gen::before{ content:"▌"; animation:blink .9s steps(2) infinite; margin-right:5px; }
@keyframes blink { 50%{ opacity:0; } }

/* ══ 账号 ══ */
/* 概览条：进页面先看到几个账号、几个能用、几个被停用 */
.acctbar{
  display:flex; align-items:center; gap:16px; flex-wrap:wrap;
  padding:10px 12px; margin-bottom:12px;
  background:var(--surface-2); border:2px solid var(--line);
}
.acctbar .stat{ display:flex; align-items:baseline; gap:6px; }
.acctbar .stat .n{ font-size:19px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
.acctbar .stat .l{ font-size:10.5px; color:var(--ink-3); }
.acctbar .stat.ok .n{ color:var(--ok); }
.acctbar .stat.warn .n{ color:var(--warn); }
.acctbar .stat.bad .n{ color:var(--bad); }
.acctbar .stat.off .n{ color:var(--ink-3); }
.acctbar .spacer{ flex:1; }

/* 账号卡片：身份 / 数据 / 错误 / 动作 四层纵向结构 */
.accts{ display:grid; grid-template-columns:repeat(auto-fill,minmax(268px,1fr)); gap:12px; }
.acct{
  background:var(--surface-2); border:2px solid var(--line);
  display:flex; flex-direction:column; box-shadow:var(--shadow-sm);
}
.acct.live{ border-color:var(--ok); }
.acct.cool{ border-color:var(--warn); }
/* warn：账号本身可用，只是部分模型在冷却 —— 与「整号不可用」用不同边框区分，
   否则用户会以为这个号完全用不了 */
.acct.warn{ border-color:var(--line); }
.acct.off{ border-color:var(--line); }
.acct.off .hd .who .ml{ color:var(--ink-3); }

.acct .hd{ display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--line-soft); }
.acct .ix{
  width:22px; height:22px; flex:none; display:grid; place-items:center;
  font-size:10.5px; font-weight:700; border:2px solid var(--line); color:var(--ink-3);
  font-variant-numeric:tabular-nums;
}
.acct.live .ix{ border-color:var(--ok); color:var(--ok); }
.acct.cool .ix{ border-color:var(--warn); color:var(--warn); }
.acct.warn .ix{ border-color:var(--line); color:var(--ink-2); }
.acct .who{ min-width:0; flex:1; }
.acct .who .ml{
  display:block; font-size:11.5px; color:var(--ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.acct .who .src{ display:block; font-size:10px; color:var(--ink-3); margin-top:1px; }
.acct .who .src b{ color:var(--accent); font-weight:400; }

.acct .badge{
  flex:none; padding:2px 7px; font-size:10px; font-weight:700; letter-spacing:.03em;
  border:2px solid; white-space:nowrap;
}
.badge.live{ border-color:var(--ok); color:var(--ok); background:var(--ok-soft); }
.badge.cool{ border-color:var(--warn); color:var(--warn); background:var(--warn-soft); }
.badge.off{ border-color:var(--line); color:var(--ink-3); background:var(--inset); }
.badge.part{ border-color:var(--line); color:var(--ink-2); background:var(--inset); }

/* 数据区：双列小格 */
.acct .kv{ display:grid; grid-template-columns:1fr 1fr; flex:1; align-content:start; }
.acct .kv > div{
  padding:6px 12px; border-bottom:1px solid var(--line-soft);
  display:flex; flex-direction:column; gap:1px; min-width:0;
}
.acct .kv > div:nth-child(odd){ border-right:1px solid var(--line-soft); }
.acct .kv .k{ font-size:9.5px; color:var(--ink-3); letter-spacing:.03em; }
.acct .kv .v{ font-size:11.5px; color:var(--ink-2); font-variant-numeric:tabular-nums; }
.acct .kv .v.ok{ color:var(--ok); }
.acct .kv .v.warn{ color:var(--warn); }
.acct .kv .v.bad{ color:var(--bad); }
.acct .kv .v.dim{ color:var(--ink-3); }

/* 最后一次错误：整行铺开，超长省略，悬浮看全文 */
.acct .last{
  padding:6px 12px; border-bottom:1px solid var(--line-soft); font-size:10.5px;
  color:var(--bad); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.acct .last .k{ color:var(--ink-3); margin-right:5px; }

.acct .act{ display:flex; gap:6px; padding:9px 12px; flex-wrap:wrap; align-items:center; }

/* ══ 右下角通知 ══
   fixed 右下角，多条向上堆叠。几秒后自动消失（时长按类型区分，见 JS 里的
   TOAST_MS），也可手动关闭。 */
#toasts{
  position:fixed; right:16px; bottom:16px; z-index:400;
  display:flex; flex-direction:column-reverse; gap:10px;
  max-width:min(430px,calc(100vw - 32px));
  pointer-events:none;
}
.toast{
  pointer-events:auto; position:relative; overflow:hidden;
  background:var(--surface); border:2px solid var(--line); border-left-width:5px;
  box-shadow:var(--shadow-lg); padding:11px 12px;
  display:flex; gap:9px; align-items:flex-start;
  animation:toast-in .22s cubic-bezier(.2,.9,.3,1.2);
}
@keyframes toast-in{ from{ opacity:0; transform:translate(16px,10px); } to{ opacity:1; transform:none; } }
/* 关闭：先滑出再移除，避免元素瞬间消失显得突兀 */
.toast.out{ animation:toast-out .18s ease-in forwards; }
@keyframes toast-out{ to{ opacity:0; transform:translate(16px,8px); } }

.toast.err{ border-color:var(--bad); border-left-color:var(--bad); }
.toast.ok{ border-color:var(--ok); border-left-color:var(--ok); }
.toast.warn{ border-color:var(--warn); border-left-color:var(--warn); }
.toast.info{ border-color:var(--accent); border-left-color:var(--accent); }
.toast .ic{ flex:none; font-size:13px; line-height:1.3; font-weight:700; }
.toast.err .ic{ color:var(--bad); }
.toast.ok .ic{ color:var(--ok); }
.toast.warn .ic{ color:var(--warn); }
.toast.info .ic{ color:var(--accent); }
.toast .bd{ min-width:0; flex:1; }
.toast .ti{ font-size:11.5px; font-weight:700; margin-bottom:3px; }
.toast.err .ti{ color:var(--bad); }
.toast.ok .ti{ color:var(--ok); }
.toast.warn .ti{ color:var(--warn); }
.toast.info .ti{ color:var(--accent); }
.toast .ms{
  font-size:11.5px; color:var(--ink-2); line-height:1.55;
  word-break:break-word; max-height:5.4em; overflow:auto;
}
.toast .ms code{
  font-size:11px; background:var(--inset); border:1px solid var(--line-soft);
  padding:0 4px; word-break:break-all;
}
/* 动作按钮放在可滚动的 .ms 之外，否则长文案会把按钮挤进滚动区 */
.toast .act{ margin-top:7px; }
.toast .x{
  flex:none; width:20px; height:20px; padding:0; display:grid; place-items:center;
  font-size:13px; line-height:1; background:transparent; border:2px solid var(--line);
  color:var(--ink-3); box-shadow:none; cursor:pointer;
}
.toast .x:hover{ border-color:var(--accent); color:var(--accent); }
.toast .x:active{ transform:none; box-shadow:none; }
/* 剩余时间条：直观显示还有多久自动关闭；悬停暂停（正在读时不该被收走） */
.toast .bar{ height:2px; background:var(--line-soft); margin-top:8px; overflow:hidden; }
.toast .bar i{ display:block; height:100%; width:100%; transform-origin:left; }
.toast.err .bar i{ background:var(--bad); opacity:.6; }
.toast.ok .bar i{ background:var(--ok); opacity:.6; }
.toast.warn .bar i{ background:var(--warn); opacity:.6; }
.toast.info .bar i{ background:var(--accent); opacity:.6; }
.toast .bar i.run{ animation:toast-countdown linear forwards; }
@keyframes toast-countdown{ from{ transform:scaleX(1); } to{ transform:scaleX(0); } }
.toast:hover .bar i.run{ animation-play-state:paused; }

/* 登录 */
.login[hidden]{ display:none !important; }
.code{
  font-size:24px; font-weight:700; letter-spacing:.12em; color:var(--accent);
  text-align:center; padding:11px; margin:10px 0; background:var(--accent-soft);
  border:2px solid var(--accent); user-select:all; font-variant-numeric:tabular-nums;
}
.linkrow{ display:flex; gap:7px; align-items:center; background:var(--bg); border:2px solid var(--line); padding:7px 10px; margin:9px 0; }
.linkrow .u{ flex:1; min-width:0; font-size:11px; color:var(--accent); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.steps{ padding-left:18px; font-size:12px; color:var(--ink-2); line-height:1.9; }
.meter{ height:6px; background:var(--bg); border:2px solid var(--line); overflow:hidden; margin-top:10px; }
.meter i{ display:block; height:100%; width:0; background-image:repeating-linear-gradient(90deg,var(--accent) 0 3px,transparent 3px 5px); transition:width .5s steps(12); }

/* ══ 接入配置 ══ */
.kv dt{ font-size:11px; color:var(--ink-3); margin-top:10px; }
.kv dt:first-child{ margin-top:0; }
.kv dd{ display:flex; gap:7px; align-items:center; }
.kv dd input{ font-size:11.5px; }
.snip-tabs{ display:flex; gap:5px; flex-wrap:wrap; margin-bottom:10px; }
.snip-tabs button{ padding:3px 10px; font-size:11.5px; }
.snip-tabs button.on{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
pre.snip{ background:var(--bg); border:2px solid var(--line); padding:12px 14px; overflow:auto; max-height:380px; font:11.5px/1.7 var(--mono); white-space:pre; }
ul.facts{ list-style:none; display:grid; gap:9px; }
ul.facts li{ font-size:11.5px; color:var(--ink-2); line-height:1.7; padding-left:13px; position:relative; }
ul.facts li::before{ content:""; position:absolute; left:0; top:7px; width:5px; height:5px; background:var(--accent); }
ul.facts code{ font-size:11px; color:var(--accent); background:var(--accent-soft); padding:1px 5px; }

/* ══ 模型 ══ */
.mactions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
/* 指标格：用 flex 让每行格子等宽铺满，避免出现空格子或半行留白 */
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(112px,1fr)); gap:2px; background:var(--line-soft); border:2px solid var(--line-soft); }
.stats:empty::after { content:"等待首次请求…"; display:block; background:var(--surface); padding:12px 11px; color:var(--ink-3); font-size:11px; }
.stats > div{ background:var(--surface); padding:9px 11px; }

/* 侧栏里的指标：两列固定，成对铺满，不会只剩一个格子 */
.stats.pairs { grid-template-columns:1fr 1fr; }
.stats .k{ font-size:10px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase; margin-bottom:2px; }
.stats .v{ font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; }
.stats .v.ok{ color:var(--ok); } .stats .v.cn{ color:var(--cn); }

/* ── Token 统计页 ──────────────────────────────────────────────────────
   沿用本控制台已有的仪表词汇（硬阴影、扫描线、tabular-nums），不另起一套。
   唯一的"签名"是 .ratio 放大读数：它把"上游调用数 ÷ 客户端请求数"画成
   一排方格，多出来的格子就是重试偷偷烧掉的份额 —— 这正是选择按上游调用
   统计的意义所在，所以它占视觉重心，其余数字保持克制。 */
.statgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(108px,1fr)); gap:2px; background:var(--line-soft); border:2px solid var(--line-soft); }
.statgrid > div{ background:var(--surface); padding:10px 11px; }
.statgrid .k{ font-size:10px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase; margin-bottom:3px; }
.statgrid .v{ font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
.statgrid .v.ok{ color:var(--ok); } .statgrid .v.warn{ color:var(--warn); }
.statgrid .v.bad{ color:var(--bad); } .statgrid .v.dim{ color:var(--ink-3); }
.statgrid .sub{ font-size:10px; color:var(--ink-3); margin-top:2px; font-variant-numeric:tabular-nums; }

/* 放大读数：一排方格，前 ratio 个是"实际发出的上游调用" */
.ratio{ display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
.ratio .num{ font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; letter-spacing:-.03em; line-height:1; }
.ratio .num.ok{ color:var(--ok); } .ratio .num.warn{ color:var(--warn); } .ratio .num.bad{ color:var(--bad); }
.ratio .cells{ display:flex; gap:3px; flex-wrap:wrap; max-width:100%; }
.ratio .cells i{
  width:11px; height:20px; background:var(--accent); opacity:.28;
  box-shadow:inset 0 0 0 1px var(--line);
  /* 步进式"亮起"：与全站 steps() 动效语言一致，不用平滑缓动 */
  animation:cell-in .28s steps(4) backwards;
}
.ratio .cells i.over{ background:var(--warn); opacity:1; }
.ratio .cells i.over.bad{ background:var(--bad); }
@keyframes cell-in{ from{ opacity:0; transform:scaleY(.35); } }
.ratio .desc{ font-size:11.5px; color:var(--ink-2); max-width:46ch; }
.ratio .desc b{ color:var(--ink); }

/* 趋势柱：按天，纯 CSS 高度，缺的日子也要占位（横轴连续才有趋势可言） */
.trend{ display:flex; align-items:flex-end; gap:2px; height:132px; padding:9px 10px 0; background:var(--bg); border:2px solid var(--line); overflow:hidden; }
.trend .col{ flex:1; min-width:3px; display:flex; flex-direction:column; justify-content:flex-end; height:100%; position:relative; }
.trend .col i{
  display:block; background:var(--accent); opacity:.72; min-height:1px;
  box-shadow:inset 0 0 0 1px var(--line-soft);
  transition:height .45s steps(9), opacity .12s;
  animation:bar-in .34s steps(5) backwards;
}
@keyframes bar-in{ from{ height:0 !important; opacity:0; } }
/* 今天：唯一一个用实心强调的柱子，让"当前"一眼可见 */
.trend .col.today i{ opacity:1; box-shadow:inset 0 0 0 1px var(--accent); }
.trend .col:hover i{ opacity:1; }
.trend .col .tip{
  position:absolute; bottom:100%; left:50%; transform:translateX(-50%); margin-bottom:5px;
  background:var(--raise); border:2px solid var(--line); box-shadow:var(--shadow-sm);
  padding:5px 8px; font-size:10.5px; white-space:nowrap; opacity:0; pointer-events:none;
  transition:opacity .12s; z-index:5; font-variant-numeric:tabular-nums;
}
.trend .col:hover .tip{ opacity:1; }
.trend .col .tip b{ color:var(--accent); }
.trend .col .tip .k{ color:var(--ink-3); }
.trend-axis{ display:flex; gap:2px; padding:4px 10px 0; font-size:9.5px; color:var(--ink-3); }
.trend-axis span{ flex:1; min-width:3px; text-align:center; overflow:hidden; white-space:nowrap; }
/* 横轴标签太多会糊成一团：只在首/中/末三处显示，靠 JS 控制可见性 */
.trend-axis span.hide{ visibility:hidden; }

/* 排行表：模型 / 账号两个维度共用 */
.rank{ width:100%; border-collapse:collapse; font-size:11.5px; }
.rank th{ text-align:left; font-size:10px; color:var(--ink-3); letter-spacing:.05em; text-transform:uppercase; padding:0 8px 6px 0; font-weight:400; }
.rank td{ padding:5px 8px 5px 0; border-top:1px solid var(--line-soft); vertical-align:middle; }
.rank td.n{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.rank td.name{ max-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rank .mini{ display:block; height:5px; background:var(--accent); opacity:.55; margin-top:3px; min-width:2px; transition:width .45s steps(9); }
.rank tr:hover .mini{ opacity:.9; }
.rank .id{ font-family:var(--mono); font-size:10.5px; color:var(--ink-2); }
.bar{ height:6px; background:var(--bg); border:2px solid var(--line); overflow:hidden; }
.bar i{ display:block; height:100%; width:0; background-image:repeating-linear-gradient(90deg,var(--accent) 0 3px,transparent 3px 5px); }
/* 模型表：固定高度的滚动窗口（白名单放行后仍有几十个模型，页面不能被撑长） */
.tblwrap{ overflow:auto; max-height:calc(100vh - 330px); min-height:220px; border:2px solid var(--line-soft); }
table.m{ width:100%; border-collapse:collapse; font-size:12px; min-width:760px; }
table.m th{
  text-align:left; font-size:10.5px; color:var(--ink-3); letter-spacing:.07em; text-transform:uppercase;
  padding:7px 9px; border-bottom:2px solid var(--line); white-space:nowrap; background:var(--surface-2);
  cursor:default; position:sticky; top:0; z-index:1;
}
table.m th.sort{ cursor:pointer; }
table.m th.sort:hover{ color:var(--accent); }
table.m th .ar{ color:var(--accent); }
table.m td{ padding:8px 9px; border-bottom:1px solid var(--line-soft); vertical-align:middle; }
table.m tr:last-child td{ border-bottom:none; }
table.m tbody tr:hover{ background:var(--surface-2); }
table.m tr.cn td:first-child{ box-shadow:inset 3px 0 0 var(--cn); }
.mid{ font-size:11.5px; word-break:break-all; }
.num{ font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.acts{ white-space:nowrap; text-align:right; }
.tag{ font-size:10px; padding:1px 6px; border:2px solid; white-space:nowrap; }
.tag.cn{ color:var(--cn); border-color:var(--cn); background:var(--cn-soft); }
.tag.ov{ color:var(--ink-3); border-color:var(--line); }
.tag.free{ color:var(--ok); border-color:var(--ok); background:var(--ok-soft); }
.tag.paid{ color:var(--warn); border-color:var(--warn); background:var(--warn-soft); }
.spd{ display:flex; flex-direction:column; gap:3px; min-width:70px; }
.spd .n{ font-size:11.5px; color:var(--accent); font-variant-numeric:tabular-nums; }
.spd .n.na{ color:var(--ink-3); }
.spd .h{ height:3px; background:var(--accent); } .spd .h.na{ background:var(--line); }
.empty{ text-align:center; padding:32px 16px; color:var(--ink-3); font-size:12px; }

/* ══ 弹窗（账号详情等）══
   复用像素终端语言：直角、2px 描边、硬投影。 */
.modal-bg{
  position:fixed; inset:0; z-index:300; background:rgba(0,0,0,.6);
  display:flex; align-items:center; justify-content:center; padding:20px;
}
.modal{
  background:var(--surface); border:2px solid var(--line); box-shadow:var(--shadow-lg);
  width:min(880px,100%); max-height:calc(100vh - 40px); display:flex; flex-direction:column;
}
.modal > header{
  display:flex; align-items:center; gap:9px; padding:10px 13px;
  border-bottom:2px solid var(--line); background:var(--surface-2); flex:none;
}
.modal > header h3{ font-size:12.5px; font-weight:700; }
.modal > .pad{ overflow-y:auto; }
/* 弹窗内的表格不要用页面级的高度限制，按内容自然撑开由弹窗滚动 */
.tblwrap.tblfixed{ max-height:none; min-height:0; }
h4.mh{
  font-size:11px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase;
  margin:15px 0 7px; padding-bottom:5px; border-bottom:1px solid var(--line-soft);
}
h4.mh:first-child{ margin-top:0; }
.kv2{ display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:9px; }
.kv2 > div{ background:var(--surface-2); border:2px solid var(--line-soft); padding:8px 10px; }
.kv2 .k{ display:block; font-size:10px; color:var(--ink-3); letter-spacing:.05em; margin-bottom:3px; }
.kv2 .v{ font-size:12px; font-variant-numeric:tabular-nums; }
.kv2 .v.ok{ color:var(--ok); }
code.chiplite{
  display:inline-block; font-family:var(--mono); font-size:10.5px; padding:2px 7px;
  border:1px solid var(--line-soft); color:var(--ink-2); background:var(--surface-2); margin:0 4px 4px 0;
}
.modal .desc{ font-size:11px; color:var(--ink-3); margin-bottom:7px; }

/* ══ 模型库（三段式：推荐分组 / 全部模型 / 已启用）══
   布局对齐 Go 版 cline-proxy 的模型库，但视觉沿用本项目的像素终端语言：
   直角、2px 描边、硬投影、等宽字体（不搬他的圆角徽章与彩色圆点）。 */
.mgroup{ border-top:2px solid var(--line-soft); padding-top:11px; margin-top:13px; }
.mgroup:first-child{ border-top:none; padding-top:0; margin-top:0; }
.mghead{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:9px; }
.mghead h4{ font-size:12px; font-weight:700; }
/* 分组色点：8px 方块而非圆点，与全站的直角语言一致 */
.gdot{ width:8px; height:8px; flex:none; }
.mghead .gsub{ font-size:10.5px; color:var(--ink-3); }
.mghead .note{ font-size:10.5px; color:var(--ink-3); }

.mcards{ display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:8px; }
.mcard{
  border:2px solid var(--line-soft); background:var(--surface-2);
  padding:7px 9px; min-width:0;
}
.mcard.on{ border-color:var(--ok); background:var(--ok-soft); }
.mcard.def{ border-color:var(--accent); }
/* 卡片内容分两行：第一行是名字（可省略），第二行是操作按钮。
   按钮单独一行是必需的 —— 挤在同一行时 flex 会把按钮压到逐个字符换行
   （"检测" 变成竖排的"检/测"），而模型名也会被压到只剩几个字。 */
.mcard .mrow{ display:flex; align-items:center; gap:7px; min-width:0; }
.mcard .macts{ display:flex; align-items:center; gap:6px; margin-top:6px; flex-wrap:wrap; }
/* nowrap 是这套按钮的硬要求：短标签（检测/移除）绝不该折成两行 */
.mcard button{ white-space:nowrap; flex:none; }
.mcard .mname{
  font-size:11.5px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  min-width:0;
}
.mcard .mid{
  font-size:10px; color:var(--ink-3); font-family:var(--mono);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  flex:1 1 auto; min-width:0;
}
.mcard .grow{ flex:1; }
/* 上下文长度与 tags：小方块标签，不用圆角 */
.mcard .mctx{
  flex:none; font-size:9.5px; padding:2px 6px; color:var(--ink-2);
  border:1px solid var(--line); font-variant-numeric:tabular-nums;
}
.mcard .mtag{
  flex:none; font-size:9.5px; padding:2px 6px; color:var(--accent);
  border:1px solid var(--accent);
}
/* 状态徽章（默认）与上下文/标签同一行，留出左边距免得贴在模型名上 */
.mcard .badge{ flex:none; margin-left:2px; }
.mcard .mchk{ font-size:10.5px; margin-top:5px; padding-top:4px; border-top:1px solid var(--line-soft); }
.mcard .mchk.ok{ color:var(--ok); }
.mcard .mchk.bad{ color:var(--bad); }
/* 描述默认收起（几百张卡片全铺开描述会把页面撑得没法看），由「显示描述」开关控制 */
.mcard .mdesc{ display:none; font-size:10.5px; color:var(--ink-3); line-height:1.6; margin-top:5px; }
body.show-mdesc .mcard .mdesc{ display:block; }

/* 全部模型：折叠块 + 搜索条 */
.fold{ border:2px solid var(--line-soft); }
.foldsum{
  display:flex; align-items:center; gap:9px; cursor:pointer; list-style:none;
  padding:10px 13px; background:var(--surface-2); user-select:none;
}
/* 隐藏 <summary> 的原生三角。三行都要写：::-webkit-details-marker 只对 WebKit 生效，
   这个浏览器引擎认的是 list-style（上面那行）与 ::marker。少写一行就会多出一个
   和自绘 chevron 并存的空方块。 */
.foldsum::-webkit-details-marker{ display:none; }
.foldsum::marker{ content:""; }
.foldsum h3{ font-size:12.5px; font-weight:700; }
/* 折叠标题右侧的计数是纯文本。刻意不复用 .note —— 那是个带 2px 边框的提示条组件，
   空着的时候会渲染成一个小方块。 */
.foldsum .fsub{ font-size:10.5px; color:var(--ink-3); }
.foldsum .grow{ flex:1; }
/* 展开指示：一个直角三角，用 CSS 边框画，不引图标 */
.foldsum .chev{
  flex:none; width:0; height:0; border-left:6px solid var(--ink-3);
  border-top:5px solid transparent; border-bottom:5px solid transparent;
  transition:transform .15s;
}
details[open] > .foldsum .chev{ transform:rotate(90deg); }
details.fold > .pad{ border-top:2px solid var(--line); }
.msearch{ display:flex; align-items:center; gap:9px; margin-bottom:11px; flex-wrap:wrap; }
.msearch input{ flex:1; min-width:220px; }
.msearch .note{ font-size:10.5px; color:var(--ink-3); white-space:nowrap; }

/* ══ 上游渠道面板 ══ */
.upadd{ display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
.upadd input{ flex:1; min-width:240px; }
.upcard{ margin-bottom:13px; }
.upcard header .badge{ flex:none; }
.upbody{ display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:11px; padding:11px 13px; }
.upbody .full{ grid-column:1/-1; }
.upbody label.lb{ margin-bottom:4px; }
.upbody textarea{ min-height:56px; }
.upmeta{ font-size:10.5px; color:var(--ink-3); line-height:1.7; }
.upmeta code{ font-family:var(--mono); color:var(--ink-2); }
/* 探测结果条：管道归属 + 实际命中渠道，一眼看出钉住生效没有 */
.probe{ border:2px solid var(--line-soft); background:var(--surface-2); padding:9px 11px; font-size:11px; line-height:1.75; }
.probe .row{ display:flex; gap:7px; flex-wrap:wrap; }
.probe .k{ color:var(--ink-3); }
.probe .ok{ color:var(--ok); }
.probe .bad{ color:var(--bad); }
.probe .warn{ color:var(--warn); }
.probe .note{ margin-top:6px; color:var(--ink-2); border-top:1px solid var(--line-soft); padding-top:6px; }
/* system prompt / 请求头表单 */
.hdrgrid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:9px; }
.hdrgrid > div{ display:flex; align-items:center; gap:8px; }
.hdrgrid label{ flex:none; width:150px; font-size:11px; color:var(--ink-2); font-family:var(--mono);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hdrgrid input{ flex:1; min-width:0; }
.warnbox{ border:2px solid var(--warn); background:var(--warn-soft); color:var(--ink); padding:9px 11px; font-size:11.5px; line-height:1.7; }
.okbox{ border:2px solid var(--ok); background:var(--ok-soft); padding:9px 11px; font-size:11.5px; }

/* ══ 日志：固定高度滚动窗口 ══ */
.logwrap{ flex:1; min-height:0; display:grid; grid-template-columns:1fr 340px; gap:0; }
@media (max-width:1100px){ .logwrap{ grid-template-columns:1fr; } .logdetail{ border-left:none !important; border-top:2px solid var(--line); max-height:44vh; } }
.logbody{ display:flex; flex-direction:column; min-height:0; min-width:0; }
.logbar{ display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:2px solid var(--line); background:var(--surface-2); flex-wrap:wrap; flex:none; }
.chips{ display:inline-flex; gap:5px; flex-wrap:wrap; }
.chip{ padding:2px 9px; font-size:11px; box-shadow:2px 2px 0 0 rgba(0,0,0,.4); }
.chip.on{ background:var(--accent); border-color:var(--accent); color:var(--accent-ink); font-weight:700; }
.chip .n{ margin-left:5px; font-variant-numeric:tabular-nums; opacity:.8; }
/* 固定高度的滚动窗口：日志再多也只在这里滚，不撑开页面 */
.logwin{
  flex:1; min-height:0; overflow-y:auto; font:11.5px/1.6 var(--mono);
  background:var(--bg);
  background-image:repeating-linear-gradient(0deg,var(--grid) 0 1px,transparent 1px 4px);
}
.ln{
  display:grid; grid-template-columns:66px 1fr 78px 62px 68px 68px;
  gap:9px; align-items:center; padding:4px 11px; cursor:pointer;
  border-bottom:1px solid var(--line-soft); font-variant-numeric:tabular-nums;
}
.ln:hover{ background:var(--surface-2); }
.ln.sel{ background:var(--accent-soft); box-shadow:inset 3px 0 0 var(--accent); }
.ln .t{ color:var(--ink-3); }
.ln .md{ color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ln .st{ font-weight:700; }
.ln .st.ok{ color:var(--ok); } .ln .st.bad{ color:var(--bad); } .ln .st.stop{ color:var(--warn); }
.ln .n{ text-align:right; color:var(--ink-3); }
.ln .n.hi{ color:var(--accent); }
@media (max-width:860px){ .ln{ grid-template-columns:60px 1fr 66px; } .ln .opt{ display:none; } }
.logdetail{ border-left:2px solid var(--line); overflow-y:auto; background:var(--surface); }
.logdetail .dh{ padding:9px 13px; border-bottom:2px solid var(--line); background:var(--surface-2); font-size:11px; color:var(--ink-3); letter-spacing:.06em; text-transform:uppercase; position:sticky; top:0; }
.logdetail .db{ padding:13px; display:grid; gap:12px; }
.metrics{ display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; }
.metrics div{ display:flex; flex-direction:column; gap:1px; min-width:0; }
.metrics .k{ font-size:10px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.05em; }
.metrics .v{ font-size:12px; font-variant-numeric:tabular-nums; word-break:break-all; }
.logdetail h4{ font-size:10.5px; color:var(--ink-3); text-transform:uppercase; letter-spacing:.06em; display:flex; align-items:center; gap:8px; }
.logdetail h4 .grow{ flex:1; }
.logdetail pre{ background:var(--bg); border:2px solid var(--line-soft); padding:9px 11px; overflow:auto; max-height:240px; font:11px/1.6 var(--mono); color:var(--ink-2); white-space:pre-wrap; word-break:break-word; }
.err{ font-size:11.5px; padding:9px 11px; background:var(--bad-soft); border:2px solid var(--bad); color:var(--bad); line-height:1.6; }
.hint{ font-size:11.5px; padding:9px 11px; background:var(--warn-soft); border:2px solid var(--warn); color:var(--warn); line-height:1.6; }

/* ══ 响应式 ══ */
@media (max-width:860px){
  .shell{ grid-template-columns:1fr; height:auto; }
  body{ overflow:auto; }
  .main{ height:auto; overflow:visible; }
  .nav{ border-right:none; border-bottom:2px solid var(--line); }
  .nav ul{ display:flex; flex-wrap:wrap; gap:4px; padding:8px; }
  .nav a{ margin:0; }
  /* 窄屏下不隐藏署名：侧栏已变成顶部横向导航，这里改为紧凑单行展示。
     上游原实现是 display:none，导致作者/公众号/博客在窄屏完全消失、
     且没有任何替代位置——对需要署名的开源项目不合适。 */
  .nav .sig{
    display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px;
    padding:7px 10px; border-top:1px solid var(--line-soft);
    font-size:11px; line-height:1.5;
  }
  .nav .sig .row{ display:flex; align-items:center; gap:7px; }
  .nav .sig .row[style]{ margin-top:0 !important; }
  .nav .sig a{ color:var(--accent); text-decoration:none; }
  .nav .sig a:hover{ text-decoration:underline; }
  .pool{ border-top:2px solid var(--line); }
  .views{ position:static; }
  .view{ position:static; inset:auto; overflow:visible; padding:14px 14px 40px; }
  .view.flush{ overflow:visible; }
  .logwin{ max-height:60vh; }
}
@media (prefers-reduced-motion:reduce){ *{ transition:none !important; animation:none !important; } }

/* 打印/极窄兜底 */
@media (max-width:520px){
  .topbar h2{ font-size:12px; }
  .code{ font-size:19px; }
}

/* ══════════════════════════════════════════════════════════════════
   Claude 官网风格覆盖层
   上游是像素终端风（直角 / 硬位移投影 / 全等宽 / 网格底 / CRT 扫描线）。
   这里按真实类名统一覆写为 Claude 的视觉语言：暖调中性色、珊瑚橙、
   柔和圆角、扩散阴影、无衬线字体。不改动任何上游逻辑代码。
   ══════════════════════════════════════════════════════════════════ */

/* ── 字体：界面文字改无衬线，数字与日志保留等宽对齐 ── */
body,.topbar,.nav,.main,.hd,.ti,.brand,.chip,.badge,.tab,.btn,
.kv,.kv2,.note,.tip,.info,.fact,.tag,.badge,.mcard,.card,.panel,.box{
  font-family:var(--sans);
}
body{ font-size:14px; letter-spacing:.005em; }
.hd,.ti,.brand,.topbar b,.mghead{ letter-spacing:-.015em; }  /* Claude 标题紧字距 */
.num,.ratio,.stat .v,.cells,.acctbar,.bar,.logbox,.log,.sig,.spd,
input,textarea{ font-family:var(--mono); font-variant-numeric:tabular-nums; }

/* ── 圆角柔化：像素直角 → Claude 圆角 ── */
.nav,.topbar,.box,.card,.panel,.mcard,.modal,.toast,.note,.tip,.info,
.kv,.kv2,.chip,.badge,.tab,.cells,.cell,.fact,.stats,.statgrid .stat,
.who,.turn,.logdetail,.probe,.rank .row,.empty{
  border-radius:var(--radius) !important;
}
button,.btn,.tab,.chip,.badge,.on,.off,.sig,.stat,.pool .p{
  border-radius:999px !important;     /* Claude 胶囊按钮 */
}
input,textarea,select{ border-radius:var(--radius-sm) !important; }

/* ── 阴影：硬位移块 → 柔和扩散 ── */
*{ box-shadow:none !important; }
.nav,.topbar,.box,.card,.panel,.statgrid .stat,.who,.mcard{
  box-shadow:var(--shadow) !important;
}
.modal,.toast{ box-shadow:var(--shadow-lg) !important; }

/* ── 描边：2px 硬边 → 1px 柔和边 ── */
.nav,.topbar,.box,.card,.panel,.mcard,.modal,.toast,.note,.tip,.info,
.kv,.kv2,.cell,.statgrid .stat,.who,.turn,.badge,.chip,.tab{
  border:1px solid var(--line-soft) !important;
}
.mcard:hover,.card:hover,.statgrid .stat:hover{ border-color:var(--line) !important; }

/* ── 去掉 CRT 扫描线与网格底纹 ── */
body::before,body::after,.scan,.scanlines,.crt,.grid-bg,.raster{ display:none !important; }
body{ background-image:none !important; }

/* ── 背景：柔和径向光晕（Claude 的暖调层次），不用网格 ── */
body{
  background:
    radial-gradient(1100px 560px at 12% -12%, var(--accent-soft), transparent 62%),
    var(--bg);
}

/* ── 侧栏：暖调深色块 + 细分隔线 ── */
.nav{ background:var(--surface) !important; border-right:1px solid var(--line-soft) !important; }
.brand{ color:var(--accent) !important; }

/* ── 表格：去网格感，改行分隔 ── */
table,.stats th,.stats td,.rank th,.rank td{ background:transparent !important; }
.stats th,.stats td,.rank th,.rank td{
  border-bottom:1px solid var(--line-soft) !important;
}
.stats th,.rank th{ background:var(--surface-2) !important; color:var(--ink-2); font-weight:600; }

/* ── 输入框聚焦：珊瑚橙细边 + 柔光环 ── */
input:focus,textarea:focus,select:focus{
  outline:none !important; border-color:var(--accent) !important;
  box-shadow:0 0 0 3px var(--accent-soft) !important;
}

/* ── 滚动条低调 ── */
::-webkit-scrollbar{ width:10px; height:10px; }
::-webkit-scrollbar-track{ background:transparent; }
::-webkit-scrollbar-thumb{
  background:var(--line); border-radius:999px;
  border:3px solid transparent; background-clip:content-box;
}
::-webkit-scrollbar-thumb:hover{ background:var(--ink-3); background-clip:content-box; }
</style>
</head>
<body>
<div class="shell">

  <!-- ══ 左栏 ══ -->
  <nav class="nav">
    <div class="brand">
      <div class="name">
        <!-- 像素 WiFi：16×16 网格，三条弧 + 底部源点，左右严格对称 -->
        <svg class="logo" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="7" width="6" height="1"/><rect x="3" y="8" width="3" height="1"/><rect x="10" y="8" width="3" height="1"/><rect x="2" y="9" width="2" height="1"/><rect x="12" y="9" width="2" height="1"/><rect x="1" y="10" width="1" height="1"/><rect x="4" y="10" width="8" height="1"/><rect x="14" y="10" width="1" height="1"/><rect x="3" y="11" width="2" height="1"/><rect x="11" y="11" width="2" height="1"/><rect x="6" y="12" width="4" height="1"/><rect x="5" y="13" width="2" height="1"/><rect x="9" y="13" width="2" height="1"/><rect x="7" y="14" width="2" height="1"/><rect x="7" y="15" width="2" height="1"/></svg>
        ClineFreePool
      </div>
      <div class="sub" id="brandSub">控制台</div>
    </div>

    <ul id="nav">
      <li><a data-v="chat" class="on"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2.5h10v8H8l-3 3v-3H3z"/></svg>对话测试</a></li>
      <li><a data-v="accounts"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4"/></svg>账号<span class="cnt" id="cnt-acct"></span></a></li>
      <li><a data-v="models"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.8 14 5v6L8 14.2 2 11V5z"/><path d="M2 5l6 3.2L14 5M8 8.2v6"/></svg>模型<span class="cnt" id="cnt-model"></span></a></li>
      <li><a data-v="usage"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 13.5h11"/><path d="M4.6 13.5V8.6M8 13.5V3.6M11.4 13.5V6.4"/></svg>统计<span class="cnt" id="cnt-usage"></span></a></li>
      <li><a data-v="logs"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/></svg>日志<span class="cnt" id="cnt-log"></span></a></li>
      <li><a data-v="config"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/></svg>接入配置</a></li>
      <li><a data-v="upstreams"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h4M9.5 4h4M2.5 12h4M9.5 12h4"/><circle cx="8" cy="4" r="1.6"/><circle cx="8" cy="12" r="1.6"/><path d="M8 5.6v4.8"/></svg>上游渠道<span class="cnt" id="cnt-up"></span></a></li>
      <li><a data-v="settings"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="5.5" cy="4.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="10.5" cy="8" r="1.5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="11.5" r="1.5" fill="currentColor" stroke="none"/></svg>设置</a></li>
    </ul>

    <div class="pool">
      <div class="hd"><span class="t">账号池</span><span class="v" id="poolV">-</span></div>
      <div class="cells" id="poolCells"><span class="empty">读取中</span></div>
    </div>

    <div class="sig">
      <div class="row"><span class="fact"><span class="sq" id="keySq"></span><span id="keyTxt">密钥检查中</span></span></div>
      <div class="row" style="margin-top:5px"><span id="verTxt">v-</span> <span id="cacheTxt"></span></div>
    </div>
  </nav>

  <!-- ══ 主区 ══ -->
  <div class="main">
    <div class="topbar">
      <h2 id="ttl">对话测试</h2>
      <span class="sep">/</span>
      <span class="meta" id="sub">-</span>
      <span class="grow"></span>
      <button class="xs ghost" id="btnTheme" title="切换明暗主题">主题</button>
      <button class="xs ghost" id="btnRefresh" title="刷新状态与模型">刷新</button>
    </div>

    <div class="views">
      <!-- 全局状态提示不在这里：见右下角 #toasts（本处原有一个绝对定位的提示条，
           会盖住各页头部的按钮，已移除） -->

      <!-- ── 对话 ── -->
      <section class="view" id="v-chat">
        <div class="grid-chat">
          <div class="box" style="display:flex;flex-direction:column;min-width:0">
            <header>
              <h3>对话</h3>
              <span class="grow"></span>
              <button class="xs ghost" id="btnExport">导出记录</button>
              <button class="xs ghost" id="btnClearMsgs">清空</button>
            </header>
            <div class="thread" id="thread" style="flex:1"></div>
            <div style="border-top:2px solid var(--line);padding:11px 13px;flex:none">
              <textarea id="input" rows="2" placeholder="输入消息，Enter 发送 / Shift+Enter 换行"></textarea>
              <div style="display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap">
                <button class="primary" id="btnSend">发送</button>
                <button class="ghost" id="btnStop" hidden>停止生成</button>
                <span class="grow" style="flex:1"></span>
                <span class="num" id="cmeta" style="color:var(--ink-3)"></span>
              </div>
            </div>
          </div>

          <div class="aside">
            <div class="box">
              <header><h3>模型与参数</h3></header>
              <div class="pad">
                <label class="lb" for="model">模型</label>
                <select id="model" style="margin-bottom:9px"></select>
                <label class="chk" style="margin-bottom:9px"><input type="checkbox" id="stream" checked> 流式输出</label>
                <details class="rz"><summary>生成参数（可选）</summary>
                  <div style="margin-top:9px;display:grid;gap:9px">
                    <div><label class="lb" for="sys">system prompt</label><textarea id="sys" rows="2" placeholder="留空则不发送"></textarea></div>
                    <div><label class="lb" for="temp">temperature</label><input id="temp" placeholder="留空则不发送"></div>
                    <div><label class="lb" for="topp">top_p</label><input id="topp" placeholder="留空则不发送"></div>
                    <div style="font-size:10.5px;color:var(--ink-3);line-height:1.6">max_tokens 会被服务端剥离（上游收到会报错），输出长度由模型决定。</div>
                  </div>
                </details>
              </div>
            </div>
            <div class="box">
              <header><h3>本次指标</h3></header>
              <div class="pad0"><div class="stats pairs" id="chatStats"></div></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 账号 ── -->
      <section class="view" id="v-accounts" hidden>
        <div class="box">
          <header>
            <h3>账号池</h3>
            <span class="grow"></span>
            <button class="xs ghost" id="btnResetAll" title="清除所有账号的冷却状态与 token 缓存">重置全部冷却</button>
            <button class="xs ghost" id="btnEnableAll" title="启用被停用的账号">全部启用</button>
            <button class="xs ghost" id="btnRefreshAcct">刷新</button>
            <button class="xs primary" id="btnLogin">登录新账号</button>
          </header>
          <div class="pad">
            <div class="acctbar" id="acctBar">
              <span class="stat ok"><span class="n" id="acOk">0</span><span class="l">可用</span></span>
              <span class="stat warn"><span class="n" id="acCool">0</span><span class="l">冷却中</span></span>
              <span class="stat off"><span class="n" id="acOff">0</span><span class="l">已停用</span></span>
              <span class="stat"><span class="n" id="acTotal">0</span><span class="l">总数</span></span>
              <span class="spacer"></span>
              <span class="note" id="acctHint"></span>
            </div>
            <div class="accts" id="accts"></div>
            <div class="empty" id="acctEmpty" hidden>还没有账号。点右上角「登录新账号」，或把 refreshToken 填进环境变量。</div>
          </div>
        </div>

        <div class="box login" id="loginBox" hidden>
          <header><h3>登录 Cline 账号</h3><span class="grow"></span><button class="xs ghost" id="btnLoginCancel">取消</button></header>
          <div class="pad" id="loginBody"></div>
        </div>

        <div class="box">
          <header><h3>关于账号持久化</h3></header>
          <div class="pad">
            <ul class="facts">
              <li>控制台登录得到的 refreshToken 只存在<b>当前实例内存</b>，进程重启或重新部署后消失。</li>
              <li>要长期生效，把 refreshToken 填进部署环境变量 <code>CLINE_REFRESH_TOKEN</code>（多账号一行一个），保存后重新部署。</li>
              <li>登录来的账号会在卡片上标注「临时」，与环境变量里的常驻账号区分。</li>
              <li><b>停用</b>只影响当前实例的轮询，重启即恢复；环境变量里的账号不能移除（下次读取又会出现），只能用停用让它下线。</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ── 模型 ── -->
      <!-- ── 模型 ──
           三段式布局（对齐 Go 版 cline-proxy 的模型库）：
             ① 可用模型分组 —— 上游当前的免费额度通道（free 组），卡片墙 + 整组添加
             ② 全部模型     —— 折叠，展开才抓（上游四百多条、约 500 KB），按供应商分组
             ③ 已启用模型   —— 真正会出现在 /v1/models 里的那些
           卡片交互三处共用同一套渲染函数，格式与行为完全一致。 -->
      <section class="view" id="v-models" hidden>
        <div class="box">
          <header>
            <h3>模型库</h3>
            <span class="grow"></span>
            <span class="note" id="mStatus"></span>
            <button class="xs ghost" id="mDescBtn" title="显示/隐藏上游的模型描述">显示描述</button>
            <button class="xs ghost" id="mRefreshBtn">刷新数据</button>
          </header>
          <div class="pad">
            <p class="desc">
              数据来自 <code>api.cline.bot</code>（由服务端抓取 —— 浏览器直连会被 CORS 拦截）。
              点分组标题右侧的「全部添加」可一键加入该组所有模型，点单个模型卡片上的 ＋ 单独添加；
  <br><b>这里只列走免费额度的模型。</b>上游另有一个「官方推荐」分组，装的是
  claude-opus / gpt-6 / kimi 这类付费旗舰——它们消耗账号余额（新用户仅 0.5 美元），
  不是免费额度，因此<b>刻意不展示</b>，以免一点就烧掉大半余额。
  需订阅的 ClinePass 与走云端额度的 Cline Cloud 同样不展示。
              重复添加会自动跳过。也可点「检测」先发一次小请求确认它现在能不能用（可能消耗少量额度）。
            </p>
          </div>
        </div>

        <div class="box">
          <header><h3>可用模型分组</h3><span class="grow"></span><span class="note" id="mLibNote"></span></header>
          <div class="pad" id="mLibrary">
            <div class="empty">加载中…</div>
          </div>
        </div>

        <div class="box">
          <details class="fold" id="mCatalogFold">
            <summary class="foldsum">
              <h3>全部模型</h3>
              <span class="fsub" id="mCatNote"></span>
              <span class="chev"></span>
            </summary>
            <div class="pad">
              <p class="desc">
                上游全部可选模型（含付费档），展开后才抓取，服务端缓存 30 分钟。
                按供应商（模型 ID 里 <code>/</code> 前那一段）分组，每组标题右侧都能「全部添加」。
              </p>
              <div class="msearch">
                <input type="search" id="mCatSearch" placeholder="搜索名称或 ID（如 gpt、qwen、flash）" autocomplete="off" spellcheck="false">
                <span class="note" id="mCatCount"></span>
              </div>
              <div id="mCatalog"><div class="empty">展开后加载…</div></div>
            </div>
          </details>
        </div>

        <div class="box">
          <header>
            <h3>已启用模型</h3>
            <span class="grow"></span>
            <span class="note" id="mOwnNote"></span>
          </header>
          <div class="pad">
            <p class="desc" id="mOwnHint">
              只有这里的模型会出现在 <code>/v1/models</code> 里。点「移除」即可撤下。
            </p>
            <div id="mOwned"></div>
          </div>
        </div>
      </section>

      <!-- ── 统计：token 用量 ── -->
      <section class="view" id="v-usage" hidden>
        <!-- 签名读数：重试放大。放最上面是因为它回答的是"额度去哪了"，
             而不是"用了多少" —— 后者看下面的总量就行。 -->
        <div class="box">
          <header>
            <h3>重试放大</h3>
            <span class="grow"></span>
            <span class="note" id="uSince"></span>
          </header>
          <div class="pad">
            <div class="ratio" id="uRatio"></div>
          </div>
        </div>

        <div class="box">
          <header>
            <h3>用量总览</h3>
            <span class="grow"></span>
            <span class="note">按上游调用计，含重试的那几次</span>
          </header>
          <div class="pad">
            <div class="statgrid" id="uTotals"></div>
            <div class="meter" id="uMeter" style="margin-top:12px"><i></i></div>
            <div class="note" id="uMeterNote" style="margin-top:7px"></div>
          </div>
        </div>

        <div class="box">
          <header>
            <h3>近 30 天</h3>
            <span class="grow"></span>
            <span class="note">柱高 = 当日 token 合计</span>
          </header>
          <div class="pad">
            <div class="trend" id="uTrend"></div>
            <div class="trend-axis" id="uTrendAxis"></div>
            <div class="empty" id="uTrendEmpty" hidden>还没有用量记录。发一条消息试试。</div>
          </div>
        </div>

        <div class="grid2">
          <div class="box">
            <header><h3>按模型</h3><span class="grow"></span><span class="note" id="uModelNote"></span></header>
            <div class="pad">
              <table class="rank" id="uModelTbl">
                <thead><tr><th>模型</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr></thead>
                <tbody id="uModelRows"></tbody>
              </table>
              <div class="empty" id="uModelEmpty" hidden>暂无数据。</div>
            </div>
          </div>
          <div class="box">
            <header><h3>按账号</h3><span class="grow"></span><span class="note" id="uAcctNote"></span></header>
            <div class="pad">
              <table class="rank" id="uAcctTbl">
                <thead><tr><th>账号</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr></thead>
                <tbody id="uAcctRows"></tbody>
              </table>
              <div class="empty" id="uAcctEmpty" hidden>暂无数据。</div>
            </div>
          </div>
        </div>

        <div class="box">
          <header><h3>统计说明</h3></header>
          <div class="pad">
            <ul class="facts">
              <li><b>按上游调用计，不按消息数计。</b>免费额度用尽时会自动切号重试，你发一条消息可能真的打了 2~3 次上游，这几次都实打实消耗额度，所以都记上。上方的「重试放大」就是两者之比。</li>
              <li>客户端中途断开（点停止、关页面）时上游还没来得及回报用量，这类会计入<b>无用量回报</b>，不会用字符数瞎估——估算值混进来会让整份数字失去意义。</li>
              <li id="uPersistNote">统计只存在<b>当前实例内存</b>里，进程重启会清零。</li>
              <li>上游按自然日的免费额度结算，所以「近 30 天」用的是本机时区的自然日。</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ── 日志：固定高度滚动窗口 ── -->
      <section class="view flush" id="v-logs" hidden>
        <div class="box" style="border:none;box-shadow:none;display:flex;flex-direction:column;height:100%;min-height:0">
          <header style="flex:none">
            <h3>请求日志</h3>
            <span class="grow"></span>
            <span class="note" id="logNote">最近 60 条</span>
            <button class="xs ghost" id="btnExportLogs">导出 JSON</button>
            <button class="xs ghost danger" id="btnClearLogs">清空</button>
          </header>
          <div class="logwrap">
            <div class="logbody">
              <div class="logbar">
                <span class="chips">
                  <button class="chip on" data-f="all">全部<span class="n" id="cAll">0</span></button>
                  <button class="chip" data-f="ok">成功<span class="n" id="cOk">0</span></button>
                  <button class="chip" data-f="fail">失败<span class="n" id="cFail">0</span></button>
                  <button class="chip" data-f="slow">慢请求<span class="n" id="cSlow">0</span></button>
                </span>
                <span class="grow" style="flex:1"></span>
                <input id="lfilter" placeholder="搜索模型" style="width:140px">
                <button class="xs" id="btnFollow" title="开启后新日志自动滚到最新">跟随最新：开</button>
              </div>
              <div class="logwin" id="logwin"></div>
            </div>
            <div class="logdetail">
              <div class="dh">条目详情</div>
              <div class="db" id="logDetail"><div class="empty">点击左侧任意一行查看完整指标与原始报文。</div></div>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 接入配置 ── -->
      <section class="view" id="v-config" hidden>
        <div class="grid2">
          <div class="box">
            <header><h3>连接信息</h3></header>
            <div class="pad">
              <dl class="kv">
                <dt>Base URL</dt><dd><input id="baseurl" readonly><button class="xs ghost" data-copy="baseurl">复制</button></dd>
                <dt>API Key</dt><dd><input id="key" type="password" autocomplete="off" placeholder="本地运行会自动生成"><button class="xs ghost" data-copy="key">复制</button></dd>
                <dt>当前模型</dt><dd><input id="curmodel" readonly><button class="xs ghost" data-copy="curmodel">复制</button></dd>
              </dl>
              <p style="font-size:10.5px;color:var(--ink-3);line-height:1.7;margin-top:11px">密钥只保存在本机浏览器。本地运行时由 local-server.js 自动生成并注入，无需手填；线上部署请在环境变量里设置。</p>
            </div>
          </div>
          <div class="box">
            <header><h3>接入须知</h3></header>
            <div class="pad">
              <ul class="facts">
                <li>同时兼容 OpenAI（<code>/v1/chat/completions</code>）与 Anthropic（<code>/v1/messages</code>），两边官方 SDK 都能直连。</li>
                <li>Cloudflare 的 workers.dev 域名按 User-Agent 拦请求，非浏览器 UA 可能得到 <code>1010</code>；改用 Vercel 域名或加浏览器 UA。</li>
                <li><code>402</code> 表示付费档余额不足，换带 <code>:free</code> 或 <code>cline-free/</code> 的免费模型。</li>
                <li><code>429 Daily free limit</code> 是账号当日额度用尽，等冷却或追加账号自动切号。</li>
                <li>服务端未配 <code>API_KEY</code> 时聊天端点返回 401，不会回退到公开默认密钥。</li>
              </ul>
            </div>
          </div>
        </div>
        <div class="box">
          <header><h3>客户端接入代码</h3><span class="grow"></span><span class="note">已填入上面的地址与密钥</span></header>
          <div class="pad">
            <div class="snip-tabs" id="snipTabs"></div>
            <pre class="snip" id="snip"></pre>
            <div style="display:flex;gap:9px;align-items:center;margin-top:10px;flex-wrap:wrap">
              <button class="primary" id="btnCopySnip">复制这段代码</button>
              <span class="grow" style="flex:1"></span>
              <span class="num" style="color:var(--ink-3)" id="snipNote"></span>
            </div>
          </div>
        </div>
      </section>

      <!-- ── 上游渠道 ──
           按模型指定走哪条上游渠道。核心概念：Cline 网关后面有两条路由管道
           （direct=OpenRouter / planner=Vercel Gateway），钉住的写法互不通用，
           所以这里要么先探测、要么两种形式同时注入。 -->
      <section class="view" id="v-upstreams" hidden>
        <div class="box">
          <header>
            <h3>按模型钉住上游渠道</h3>
            <span class="grow"></span>
            <span class="note" id="upNote"></span>
            <button class="xs ghost" id="btnUpReload">刷新</button>
          </header>
          <div class="pad">
            <p class="desc">
              留空 = 自动模式（由网关自己挑渠道并自带故障转移，实测最稳）。
              钉住用于：某个渠道总是坏、要优先用便宜/快的渠道、或想把模型 ID 重定向到新名字。
              <b>只有探测过才知道这个模型走哪条管道</b>，所以先点「探测」再钉。
            </p>
            <div class="upadd">
              <input id="upModel" list="upModelList" placeholder="模型 ID，例如 cline-free/deepseek-v4.1-flash">
              <datalist id="upModelList"></datalist>
              <button class="primary" id="btnUpAdd">添加配置</button>
            </div>
          </div>
        </div>
        <div id="upList"></div>
      </section>

      <!-- ── 设置 ── -->
      <section class="view" id="v-settings" hidden>
        <div class="grid2">
          <div class="box">
            <header><h3>调度</h3></header>
            <div class="pad">
              <label class="lb" for="setStrategy">轮换策略</label>
              <select id="setStrategy" style="margin-bottom:11px">
                <option value="round_robin">round_robin — 逐个轮换（默认）</option>
                <option value="fill">fill — 先用满一个号，再换下一个</option>
                <option value="random">random — 随机挑一个</option>
              </select>
              <label class="lb" for="setCooldown">冷却兜底时长（分钟）</label>
              <input id="setCooldown" type="number" min="1" max="1440" style="margin-bottom:4px">
              <p class="desc">
                只在上游<b>没有</b>给出重置时间时使用。上游给了就用上游的
                （免费模型按自然日，自动算到次日本地零点）。
                改这个值会清空现有冷却，让新配置立刻生效。
              </p>
              <label class="lb" for="setDefaultModel">默认模型</label>
              <select id="setDefaultModel" style="margin-bottom:4px"></select>
              <p class="desc">客户端请求里不带 <code>model</code> 字段时用它。</p>
            </div>
          </div>
          <div class="box">
            <header><h3>system prompt 覆盖</h3></header>
            <div class="pad">
              <textarea id="setOverride" rows="7" placeholder="留空 = 用客户端自己的 system 提示"></textarea>
              <p class="desc" style="margin-top:8px">
                填了就<b>替换</b>客户端传来的 system 消息（位置不变，内容换成这里填的）。
                适用于给所有客户端统一注入一段行为约束。
              </p>
            </div>
          </div>
        </div>
        <div class="box">
          <header>
            <h3>自定义请求头</h3>
            <span class="grow"></span>
            <button class="xs ghost" id="btnHdrReset">恢复默认</button>
          </header>
          <div class="pad">
            <p class="desc">
              上游靠这些头识别「是不是 Cline 客户端」，<b>改动有风险</b>：填错会被 403
              （<code>only available via Cline product surfaces</code>）。
              一般只在客户端版本升级、上游要求新版本号时才需要改。留空的行不生效。
            </p>
            <div class="hdrgrid" id="hdrGrid"></div>
          </div>
        </div>
        <div class="box">
          <header><h3>保存</h3></header>
          <div class="pad">
            <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
              <button class="primary" id="btnSetSave">保存设置</button>
              <button class="ghost" id="btnSetReload">放弃改动并重新读取</button>
              <span class="grow" style="flex:1"></span>
              <span class="note" id="setNote"></span>
            </div>
            <div id="setPersist" style="margin-top:11px"></div>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>

<!-- 右下角通知容器：错误/成功提示在此堆叠（JS 填充） -->
<div id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
/* ══════════════════════════════════════════════════════════════════
   ClineFreePool 控制台
   约定：不使用模板字符串插值（构建脚本会转义 \${}），一律用字符串拼接。
   ══════════════════════════════════════════════════════════════════ */
var $ = function (id) { return document.getElementById(id); };
var LS = {
  key:"cf.key", model:"cf.model", msgs:"cf.msgs", params:"cf.params", tab:"cf.tab",
  logs:"cf.logs", filter:"cf.filter", sort:"cf.sort", tests:"cf.tests",
  theme:"cf.theme", follow:"cf.follow", sel:"cf.sel", freeOnly:"cf.freeOnly",
  muted:"cf.mutedNotices"
};

/* 国产模型厂商识别（按 model id 的 provider 段匹配）。
   这份表决定「国产优先」排序与「国产」标签，宁可少标也不要错标。 */
var CN_PROVIDERS = {
  "deepseek":"DeepSeek", "z-ai":"智谱 GLM", "zai":"智谱 GLM", "glm":"智谱 GLM",
  "qwen":"阿里通义", "xiaomi":"小米", "minimax":"MiniMax", "moonshot":"月之暗面",
  "inclusionai":"蚂蚁 inclusionAI", "nex-agi":"Nex AGI", "stepfun":"阶跃星辰",
  "01-ai":"零一万物", "yi":"零一万物", "baichuan":"百川", "doubao":"字节豆包",
  "hunyuan":"腾讯混元", "ernie":"百度文心", "sensetime":"商汤", "thudm":"智谱",
  "kimi":"月之暗面", "bailian":"阿里百炼", "modelscope":"魔搭"
};
/* 已知海外厂商（用于把「未知」与「明确海外」区分开） */
var OV_PROVIDERS = {
  "google":"Google", "nvidia":"NVIDIA", "poolside":"Poolside", "liquid":"Liquid AI",
  "cohere":"Cohere", "thinkingmachines":"Thinking Machines", "anthropic":"Anthropic",
  "openai":"OpenAI", "meta":"Meta", "mistralai":"Mistral", "microsoft":"Microsoft",
  "amazon":"Amazon", "dots-studio":"Dots Studio", "x-ai":"xAI"
};

var VIEWS = {
  chat:{t:"对话测试",s:"多轮对话自动带上下文"},
  accounts:{t:"账号",s:"账号池状态与登录"},
  models:{t:"模型",s:"浏览模型，测延迟与输出速度"},
  usage:{t:"统计",s:"token 用量与重试放大"},
  logs:{t:"日志",s:"固定窗口滚动查看历史请求"},
  upstreams:{t:"上游渠道",s:"按模型钉住上游渠道、重定向模型 ID"},
  settings:{t:"设置",s:"轮换策略、冷却时长、请求头与 system 覆盖"},
  config:{t:"接入配置",s:"把服务接到你的客户端"}
};

var state = {
  key:"", model:"", messages:[], chatStats:null,
  stream:true, temp:"", topp:"", sys:"",
  health:null, logs:[], filter:"all",
  busy:false, abort:null, snip:"curl",
  login:null, loginTimer:null, follow:true, selId:null,
  healthDown:false,   // 上次健康检查是否失败（用于去重连接错误提示）
  hasDetail:false,    // /v1/status 是否读到了账号明细（没配 key 时为 false）
  upstreams:[], upModels:[], config:null,
  // 模型库
  owned:[],           // 已启用模型（/v1/models 真正会返回的那些）
  ownedBuiltin:false, // 是否处在「没启用过 → 实时取上游免费清单」的状态
  mLibGroups:[],      // 推荐分组（面板打开就拉）
  mCatalog:null,      // 全部模型分组（展开折叠块才拉）
  mCatalogTotal:0,
  mCatLoaded:false,
  mchecks:{}          // 模型可用性检测的内存态（服务端不存，只回答"刚才能不能用"）
};

function save(k,v){ try{ localStorage.setItem(k, typeof v==="string"?v:JSON.stringify(v)); }catch(e){} }
function load(k,d){
  try{
    var raw=localStorage.getItem(k);
    if(raw===null||raw==="undefined") return d;
    try{ return JSON.parse(raw); }catch(e){ return raw; }
  }catch(e){ return d; }
}
function esc(s){
  return String(s===null||s===undefined?"":s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function fmtMs(ms){
  if(ms===null||ms===undefined||isNaN(ms)) return "-";
  if(ms<1000) return Math.round(ms)+"ms";
  if(ms<60000) return (ms/1000).toFixed(2)+"s";
  return Math.floor(ms/60000)+"m"+Math.round((ms%60000)/1000)+"s";
}
function fmtNum(n,d){
  if(n===null||n===undefined||isNaN(n)||!isFinite(n)) return "-";
  return d===undefined?String(Math.round(n)):n.toFixed(d);
}
function fmtClock(ts){
  var x=new Date(ts),p=function(n){return (n<10?"0":"")+n;};
  return p(x.getHours())+":"+p(x.getMinutes())+":"+p(x.getSeconds());
}
function baseUrl(){ return location.origin+"/v1"; }
function authHeaders(){
  var h={"Content-Type":"application/json"};
  if(state.key) h["Authorization"]="Bearer "+state.key;
  return h;
}
function selectText(el){
  if(!el) return false;
  try{
    if(el.tagName==="INPUT"||el.tagName==="TEXTAREA"){ el.focus(); el.select(); if(el.setSelectionRange) el.setSelectionRange(0,el.value.length); return true; }
    var r=document.createRange(); r.selectNodeContents(el);
    var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); return true;
  }catch(e){ return false; }
}
function legacyCopy(t){
  try{
    var ta=document.createElement("textarea");
    ta.value=t; ta.setAttribute("readonly","");
    ta.style.position="fixed"; ta.style.top="-1000px"; ta.style.opacity="0";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,ta.value.length);
    var ok=document.execCommand("copy"); document.body.removeChild(ta); return ok;
  }catch(e){ return false; }
}
function flash(btn,text){
  if(!btn) return;
  if(!btn.getAttribute("data-old")) btn.setAttribute("data-old",btn.textContent);
  btn.textContent=text; btn.classList.add("done");
  clearTimeout(btn._t);
  btn._t=setTimeout(function(){ btn.textContent=btn.getAttribute("data-old")||text; btn.classList.remove("done"); btn.removeAttribute("data-old"); },1300);
}

/* ══ 右下角通知 ══
   停留时长按类型区分：报错/警告需要时间读，留久一点；普通提示扫一眼就够，快点收走。
   右上角有关闭按钮，悬停会暂停倒计时 —— 正在读一条长错误时不会被突然收走。 */
var TOAST_MS = {
  err:  30000,   // 报错：30 秒
  warn: 30000,   // 警告：同报错，都是"需要你处理"的信号
  ok:    5000,   // 普通提示：5 秒
  info:  5000
};
// 兜底时长：kind 传了没定义的值时用它，而不是变成 0（那样会瞬间消失）
var TOAST_MS_DEFAULT = 5000;
// 同时最多几条，超出丢最旧的。定为 3 是为了控制堆叠高度：
// 通知固定在右下角，堆到四五条时会长高到盖住对话页的输入框右端。
var TOAST_MAX = 3;

/* 被用户手动关掉的状态提示要记住，否则 30 秒后又被 syncNotices 同步出来，像是关不掉。
   只对带 nid 的常驻提示生效；条件消失后自动解除，下次真出问题仍会提示。 */
var mutedNotices = load(LS.muted, null);
if(!mutedNotices || typeof mutedNotices !== "object") mutedNotices = {};
function muteNotice(nid){
  if(!nid) return;
  mutedNotices[nid] = 1;
  save(LS.muted, mutedNotices);
}

// 取某类通知的停留时长
function toastDuration(kind){
  var ms = TOAST_MS[kind];
  return typeof ms === "number" ? ms : TOAST_MS_DEFAULT;
}

function dismissToast(el){
  if(!el || el._closed) return;
  el._closed = true;
  clearTimeout(el._timer);
  // 先播关闭动画，动画结束再移除；动画缺失时（旧浏览器）用定时器兜底
  el.classList.add("out");
  var gone = function(){ if(el.parentNode) el.parentNode.removeChild(el); };
  el.addEventListener("animationend", gone, {once:true});
  setTimeout(gone, 400);
}

/**
 * 右下角冒出一条通知。
 *   kind: err / ok / warn / info（决定配色与停留时长，见 TOAST_MS）
 *   title: 加粗标题
 *   msg:   正文（纯文本，会转义；需要行内代码请自己拼）
 *   opts（可选）:
 *     nid    唯一标识。带 nid 的通知会被 syncNotices 复用/回收，重复调用只更新不新增
 *     sticky 不自动消失（用于"需要用户处理"的状态提示，如未登录账号）
 *     action {label, fn} 动作按钮，点了执行 fn 并关掉这条
 */
function toast(kind, title, msg, opts){
  var box = $("toasts");
  if(!box) return null;
  var o = opts || {};
  var type = TOAST_MS[kind] ? kind : "info";

  // 同一个 nid 已经挂着 → 原地更新，不新增也不重播入场动画
  // （状态提示每 30 秒由 loadHealth 同步一次，不能每次都闪一条新的）
  // :not(.out) 是必须的：正在播关闭动画的元素还会在 DOM 里待一会儿，
  // 若复用它，条件持续时提示也会跟着消失。
  if(o.nid){
    var prev = box.querySelector('.toast[data-nid="' + o.nid + '"]:not(.out)');
    if(prev) return updateToast(prev, type, title, msg, o);
  }

  // 只留最近几条：账号页连续点按钮时不该堆满整屏。
  // sticky 的不参与淘汰 —— 它是持续状态，不是一次性的操作回执。
  var live = box.querySelectorAll(".toast:not(.out):not(.sticky)");
  for(var i = 0; i < live.length - (TOAST_MAX - 1); i++) dismissToast(live[i]);

  var icons = { err:"!", ok:"✓", warn:"▲", info:"i" };
  var el = document.createElement("div");
  el.className = "toast " + type + (o.sticky ? " sticky" : "");
  if(o.nid) el.setAttribute("data-nid", o.nid);
  el.setAttribute("role", type === "err" ? "alert" : "status");
  // 倒计时条只给会自动消失的通知；sticky 常驻，没有"剩余时间"可言
  var barHtml = o.sticky ? "" : '<div class="bar"><i class="run"></i></div>';
  el.innerHTML =
    '<span class="ic">' + (icons[type] || icons.info) + '</span>' +
    '<div class="bd">' +
      (title ? '<div class="ti">' + esc(title) + '</div>' : '') +
      (msg ? '<div class="ms">' + msg + '</div>' : '') +
      (o.action ? '<div class="act"><button class="xs ghost" type="button"></button></div>' : '') +
      barHtml +
    '</div>' +
    '<button class="x" type="button" title="关闭" aria-label="关闭">×</button>';

  el.querySelector(".x").addEventListener("click", function(){
    muteNotice(o.nid);
    dismissToast(el);
  });
  bindToastAction(el, o);
  el._sig = toastSig(type, title, msg, o);

  // sticky：只显示不自动收走，等条件消失由 syncNotices 回收
  if(o.sticky){
    box.appendChild(el);
    return el;
  }

  // 进度条动画与自动关闭共用同一时长；悬停时 CSS 暂停动画，
  // 但定时器不会暂停，所以额外在 mouseenter/leave 上调整剩余时间。
  var ttl = toastDuration(type);
  var bar = el.querySelector(".bar i");
  bar.style.animationDuration = ttl + "ms";
  var startedAt = Date.now();
  var remaining = ttl;
  var arm = function(ms){
    clearTimeout(el._timer);
    startedAt = Date.now();
    el._timer = setTimeout(function(){ dismissToast(el); }, ms);
  };
  arm(remaining);
  el.addEventListener("mouseenter", function(){
    remaining = Math.max(remaining - (Date.now() - startedAt), 1000);
    clearTimeout(el._timer);
  });
  el.addEventListener("mouseleave", function(){ arm(remaining); });

  box.appendChild(el);
  return el;
}

// 动作按钮：每次重建元素而不是改文案，否则原地更新会叠加监听器
function bindToastAction(el, o){
  var slot = el.querySelector(".act");
  if(!slot) return;
  var old = slot.querySelector("button");
  if(old) old.parentNode.removeChild(old);
  if(!o.action) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "xs ghost";
  btn.textContent = o.action.label || "";
  if(o.action.fn){
    btn.addEventListener("click", function(){
      dismissToast(el);
      o.action.fn();
    });
  }
  slot.appendChild(btn);
}

// 通知内容指纹：用于判断是否真的需要重绘
function toastSig(type, title, msg, o){
  return [type, title || "", msg || "", (o.action && o.action.label) || "", o.sticky ? "s" : ""].join("\\u0000");
}

// 原地更新一条已存在的通知：内容没变就什么都不做，避免每轮轮询都重绘闪烁
function updateToast(el, type, title, msg, o){
  var next = toastSig(type, title, msg, o);
  if(el._sig === next) return el;
  el._sig = next;
  bindToastAction(el, o);
  el.className = "toast " + type + (o.sticky ? " sticky" : "");
  el.querySelector(".ic").textContent = { err:"!", ok:"✓", warn:"▲", info:"i" }[type] || "i";
  var bd = el.querySelector(".bd");
  var ti = el.querySelector(".ti");
  if(title){
    if(!ti){ ti = document.createElement("div"); ti.className = "ti"; bd.insertBefore(ti, bd.firstChild); }
    ti.textContent = title;
  } else if(ti) ti.parentNode.removeChild(ti);
  var ms = el.querySelector(".ms");
  if(msg){
    if(!ms){ ms = document.createElement("div"); ms.className = "ms"; bd.insertBefore(ms, bd.firstChild); }
    ms.innerHTML = msg;
  } else if(ms) ms.parentNode.removeChild(ms);
  return el;
}

/**
 * 把一组"持续状态提示"同步到右下角 —— 列表里没有的会被收走。
 * 专治 loadHealth 每 30 秒跑一次的场景：条件持续时只更新那一两条，
 * 条件消失时自动关闭，避免旧提示一直挂着误导用户。
 *   items: [{nid, kind, title, msg, action}]
 */
function syncNotices(items){
  var box = $("toasts");
  if(!box) return;
  items = items || [];
  var keep = {};
  for(var i = 0; i < items.length; i++){
    var it = items[i];
    keep[it.nid] = 1;
    if(mutedNotices[it.nid]) continue;   // 用户手动关掉的，不再弹回来
    toast(it.kind, it.title, it.msg, { nid: it.nid, sticky: true, action: it.action });
  }
  var have = box.querySelectorAll(".toast[data-nid]");
  for(var j = 0; j < have.length; j++){
    var nid = have[j].getAttribute("data-nid");
    if(!keep[nid]) dismissToast(have[j]);   // 条件已消失
  }
  // 状态恢复后解除"已忽略"，否则下次真出同样的问题就再也提示不出来了
  var cleared = false;
  for(var nid2 in mutedNotices){
    if(!keep[nid2]){ delete mutedNotices[nid2]; cleared = true; }
  }
  if(cleared) save(LS.muted, mutedNotices);
}

// 把 fetch/异常里的错误对象转成"标题 + 正文"两段，供 toast 使用
function toastError(prefix, err, detail){
  var msg = "";
  if(err && err.error && err.error.message) msg = err.error.message;
  else if(err && err.message) msg = err.message;
  else if(typeof err === "string") msg = err;
  else msg = String(err || "未知错误");
  if(detail) msg += (msg ? "<br>" : "") + esc(detail);
  return toast("err", prefix, esc(msg));
}
function copyText(text,btn,src){
  if(!text){ flash(btn,"无内容"); return; }
  var ok=function(){ flash(btn,"已复制"); };
  var bad=function(){ if(selectText(src)) flash(btn,"已选中 Ctrl+C"); else flash(btn,"请手动复制"); };
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){
    navigator.clipboard.writeText(text).then(ok,function(){ legacyCopy(text)?ok():bad(); });
  } else { legacyCopy(text)?ok():bad(); }
}
function explain(status,body){
  var b=String(body||""),low=b.toLowerCase();
  // 顺序要紧：这两个 reason 都以 429 返回，必须排在通用 429 之前，
  // 否则"账号被停用/全部冷却"会被误报成"上游额度用尽"，
  // 把用户引向等冷却，而真正该做的是去账号页启用账号。
  if(low.indexOf("all_accounts_disabled")>=0) return "账号池里的账号全部处于「停用」状态，没有账号可用。到「账号」页点「全部启用」或逐个启用。";
  if(low.indexOf("all_accounts_cooling")>=0) return "所有账号免费额度都在冷却中。等冷却结束，或在「账号」页重置冷却、追加更多账号。";
  if(low.indexOf("missing_refresh_token")>=0) return "服务端没有配置 CLINE_REFRESH_TOKEN。到「账号」页登录一个账号，或把它填进环境变量。";
  if(low.indexOf("server_no_key")>=0) return "服务端没有配置 API_KEY，聊天端点已拒绝请求。";
  if(low.indexOf("missing_client_key")>=0||low.indexOf("wrong_client_key")>=0||status===401) return "API Key 不正确或缺失，到「接入配置」填写。";
  if(status===429) return "被上游限流（429），多为当日免费额度用尽。";
  if(low.indexOf("insufficient_credits")>=0||status===402) return "该模型属付费档且余额不足（402），换免费模型。";
  if(low.indexOf("only available via cline product surfaces")>=0) return "上游把调用识别成第三方（403），可能是风控策略有变。";
  if(low.indexOf("model not found")>=0||status===404) return "模型不存在（404），可能已下架。";
  if(low.indexOf("empty response content")>=0) return "上游返回空响应，免费通道偶发，重试通常即可。";
  if(status===1010||low.indexOf("error code: 1010")>=0) return "被 Cloudflare 网关拦截（1010），给请求加浏览器 UA 或改用 Vercel 域名。";
  if(status>=500) return "服务端或上游出错（"+status+"），可重试。";
  return "请求失败（"+status+"）。";
}

/* ══ 视图切换 ══ */
function showTab(name){
  if(!VIEWS[name]) name="chat";
  var as=$("nav").querySelectorAll("a[data-v]");
  for(var i=0;i<as.length;i++) as[i].classList.toggle("on", as[i].getAttribute("data-v")===name);
  var vs=document.querySelectorAll(".view");
  for(var j=0;j<vs.length;j++){
    var mine=vs[j].id==="v-"+name;
    vs[j].hidden=!mine;
  }
  $("ttl").textContent=VIEWS[name].t;
  $("sub").textContent=VIEWS[name].s;
  document.title=VIEWS[name].t+" · ClineFreePool";
  save(LS.tab,name);
  if(name==="config") renderSnip();
  if(name==="logs") renderLogs();
  if(name==="accounts") renderAccts();
  if(name==="usage") renderUsage();
  if(name==="upstreams") loadUpstreams();
  // 模型页：已启用列表 + 推荐分组一起拉（推荐清单只有二十几条，够快）
  if(name==="models"){ loadModelLibrary(false); loadOwnedModels(); }
  if(name==="settings") loadSettings();
}

/* ══ 健康 / 账号池 ══ */
function renderHealth(h){
  state.health=h;
  var avail=h.accounts_available||0,total=h.account_count||0,det=h.account_details||[];
  var cells=$("poolCells");
  if(!total){ cells.innerHTML='<span class="empty">未配置账号</span>'; }
  else if(!det.length){
    // /v1/status 读不到明细（没填 API Key）：不画格子，免得让人以为账号是坏的
    cells.innerHTML='<span class="empty">'+total+' 个账号（填写 API Key 后显示明细）</span>';
  }
  else{
    cells.innerHTML=det.map(function(a){
      // 冷却已降到「账号×模型」粒度：格子只区分
      //   可用 / 部分模型冷却 / 全部模型冷却 / 停用
      var cms=a.cooldown_models||[];
      // 用「已启用模型数」判断是不是整号冷却：那才是用户实际在用的模型集
      var known=state.owned.length;
      var allCooling=cms.length&&known&&cms.length>=known;
      var cls="cell "+(a.enabled?(cms.length?(allCooling?"cool":"part"):"live"):"off")+(a.runtime?" tmp":"");
      var tip="账号 #"+(a.index+1);
      if(a.email) tip+="（"+a.email+"）";
      tip+="：" +(!a.enabled?"已停用":(cms.length?(allCooling?"全部模型冷却中":"部分模型冷却中"):"可用"));
      if(a.enabled&&cms.length){
        tip+="，共 "+cms.length+" 个模型受限，最长剩约 "+fmtDur(a.cooldown_seconds);
        var lim=null;
        for(var i=0;i<cms.length;i++){ if(cms[i].limited){ lim=cms[i]; break; } }
        tip+="（"+coolLabel((lim||cms[0]).kind)+"）";
      }
      if(a.runtime) tip+="，控制台登录（本地会自动存盘）";
      else if(a.token_cached) tip+="，token 已缓存";
      var lb=!a.enabled?"–":(cms.length?(a.cooldown_seconds?Math.ceil(a.cooldown_seconds/60)+"m":"!"):String(a.index+1));
      return '<span class="'+cls+'" title="'+esc(tip)+'">'+esc(lb)+"</span>";
    }).join("");
  }
  var cls=total===0?"bad":(avail===0?"warn":"ok");
  $("poolV").textContent=avail+" / "+total;
  $("poolV").className="v "+cls;
  $("cnt-acct").textContent=total?String(total):"";

  // 统计页若正在显示，跟着这次健康检查一起刷新（否则要切页才更新）
  if(!$("v-usage").hidden) renderUsage();

  var ok=h.api_key_configured;
  $("keySq").className="sq "+(ok?"ok":"bad");
  $("keyTxt").textContent=ok?"密钥已配置":"密钥未配置";
  $("verTxt").textContent="v"+h.version;
  $("cacheTxt").textContent="· 模型缓存 "+((h.models_cached||0));

  // 状态提示一律走右下角弹窗，不再用顶部横幅。
  // ⚠️ 原因：原先的 #notes 是绝对定位压在 .views 顶部的浮层，会盖住各页头部的
  //    按钮（账号页右上角正是「登录新账号」），而它自己的「去登录」又指向那一页。
  //    本函数每 30 秒被 loadHealth 调一次，所以用 syncNotices 按 nid 复用/回收，
  //    条件持续时只更新那一条，条件消失时自动收走。
  var notices=[];

  if(!ok){
    notices.push({nid:"no-key",kind:"err",title:"服务端未配置 API_KEY",
      msg:"聊天端点会拒绝所有请求。在部署环境里设置 <code>API_KEY</code> 后重新部署。"});
  }else if(!state.key){
    notices.push({nid:"no-client-key",kind:"info",title:"还没有填访问密钥",
      msg:"本地运行会自动生成并注入，无需手填；用第三方客户端时才需要复制过去。",
      action:{label:"去填写",fn:goConfig}});
  }

  if(total===0){
    // 区分两种情形，措辞与处置都不同：
    //  * 本地首次运行：账号池本来就是空的，下一步是去登录，不是"配置错了"。
    //    local-server.js 启动提示也是这个口径（「未配置 — 打开控制台登录即可」）。
    //  * 云端部署：控制台登录得到的是内存账号，冷启动/实例回收后池会变空，
    //    这时说"未配置"会让人以为自己操作失败，需说清是临时账号丢了。
    if(isLocalConsole()){
      notices.push({nid:"no-account",kind:"info",title:"还没有账号",
        msg:"本地首次启动时账号池是空的，这是正常的。登录一个 Cline 账号即可开始使用。",
        action:{label:"去登录",fn:goAccounts}});
    }else{
      notices.push({nid:"no-account",kind:"warn",title:"当前没有可用账号",
        msg:"账号池是空的，请求无法调用上游。可在「账号」页登录，或把 refreshToken 填进环境变量 "+
            "<code>CLINE_REFRESH_TOKEN</code>；控制台登录的账号只存在内存里，重新部署后会丢失。",
        action:{label:"去登录",fn:goAccounts}});
    }
  }

  if(total>0 && avail===0){
    var allOff=det.length>0&&det.every(function(a){return !a.enabled;});
    if(allOff){
      notices.push({nid:"no-avail",kind:"err",title:"没有可用账号",
        msg:"账号池里的 <b>"+total+" 个账号全部被停用</b>，请求会直接失败（429）。",
        action:{label:"全部启用",fn:function(){ goAccounts(); $("btnEnableAll").click(); }}});
    }else{
      notices.push({nid:"no-avail",kind:"warn",title:"没有可用账号",
        msg:"当前 "+total+" 个账号都在冷却中，请求会直接返回 429。等冷却结束会自动恢复。",
        action:{label:"重置全部冷却",fn:function(){ goAccounts(); $("btnResetAll").click(); }}});
    }
  }

  if(h.runtime_accounts>0){
    notices.push({nid:"runtime-acct",kind:"warn",
      title:"有 "+h.runtime_accounts+" 个临时账号",
      msg:"这些账号只存在当前实例内存里，重启或重新部署后消失。要长期保留，把 refreshToken 填进环境变量。",
      action:{label:"查看",fn:goAccounts}});
  }

  syncNotices(notices);
  if(!$("v-accounts").hidden) renderAccts();
}

/* 当前页面是否由本地服务器提供（local-server.js 会注入 __CLINE2API__）。
   用来区分"本地还没登录"和"云端账号丢了" —— 两者提示与处置不同。 */
function isLocalConsole(){
  try{ return !!(window.__CLINE2API__ && window.__CLINE2API__.key); }catch(e){ return false; }
}
function goConfig(){ showTab("config"); $("key").focus(); }
function goAccounts(){ showTab("accounts"); }

function loadHealth(){
  // 两个端点各司其职：
  //   /v1/health 免鉴权、字段精简（只回答「服务在不在」）→ 用来判断连通性；
  //   /v1/status 需要 API_KEY、带账号明细与冷却表 → 用来渲染账号池。
  // 分开的原因：health 面向公网暴露（部署到云端时任何人都能读），账号邮箱
  // 与用量不该出现在那里。
  return fetch("/v1/health",{cache:"no-store"})
    .then(function(r){
      if(!r.ok) throw new Error("服务返回 HTTP "+r.status);
      return r.json();
    })
    .then(function(h){
      if(state.healthDown){ state.healthDown=false; toast("ok","服务已恢复","已重新连上本地服务。"); }
      // 先用手上的公共字段渲染一次（首屏与鉴权失败时的降级视图）
      renderHealth(h);
      // 再拉带明细的完整状态；没配 key 或鉴权失败时保持上面的精简视图
      return fetch("/v1/status",{cache:"no-store",headers:authHeaders()})
        .then(function(r){ return r.ok?r.json():null; })
        .catch(function(){ return null; })
        .then(function(s){
          if(s&&s.ok){
            h.account_details=s.account_details||[];
            h.account_count=s.account_count||0;
            h.accounts_available=s.accounts_available||0;
            h.runtime_accounts=s.runtime_accounts||0;
            h.cooldowns=s.cooldowns||[];
            h.cooldown_minutes=s.cooldown_minutes;
            h.strategy=s.strategy;
            h.default_model=s.default_model;
            h.persisted=s.persisted;
            state.hasDetail=true;
          } else {
            state.hasDetail=false;
          }
          renderHealth(h);
        });
    })
    .catch(function(e){
      $("keySq").className="sq bad";
      $("keyTxt").textContent="无法连接服务";
      $("poolV").textContent="-"; $("poolV").className="v bad";
      // 每 30 秒轮询一次，失败时只提示一遍，避免刷屏；恢复后再失败才会重新提示。
      if(state.healthDown) return;
      state.healthDown=true;
      toastError("无法连接服务", e, diagHint());
    });
}

/* 连接失败时给出可执行的排查方向。
   单独抽出来是因为这三条覆盖了绝大多数情况，而原来的界面只说"无法连接服务"，
   既没区分原因也没有下一步动作。 */
function diagHint(){
  return "排查顺序：<br>"+
    "1. 服务进程还在吗？看启动窗口是否被关掉或按了 Ctrl+C，重新运行 start.bat / start.sh。<br>"+
    "2. 地址对得上吗？确认访问的是 <code>http://localhost:8787</code>，"+
    "改过 <code>PORT</code> 的话端口要跟着换；也别用 <code>https</code>（本服务没有证书）。<br>"+
    "3. 页面是从服务打开的，还是直接双击了 .html 文件？"+
    "直接打开文件时请求发不到服务端，必须通过 <code>http://localhost:8787</code> 访问控制台。";
}

/* ══ 账号页 ══ */

// 冷却原因 → 中文说明。抽出来是因为卡片和概览都要用。
// 冷却种类 → 中文标签。kind 来自上游 429 响应体的解析（见 worker.js parseLimitInfo）。
// 注意 unknown 是「我们按配置时长猜的」，界面上要说成「未识别」而不是假装知道原因。
function coolLabel(reason){
  if(reason==="limit"||reason==="free_daily") return "免费日额度";
  if(reason==="pass_limit") return "订阅额度";
  if(reason==="spend_limit") return "花费上限";
  if(reason==="empty") return "空响应";
  if(reason==="auth") return "鉴权失败";
  if(reason==="unknown") return "未识别";
  return "冷却中";
}
// 秒 → 人类可读的剩余时间
function fmtDur(sec){
  if(!sec||sec<=0) return "-";
  if(sec<60) return Math.ceil(sec)+" 秒";
  if(sec<3600) return Math.ceil(sec/60)+" 分钟";
  var h=Math.floor(sec/3600), m=Math.round((sec%3600)/60);
  return h+" 时"+(m?" "+m+" 分":"");
}
// 相对时间："刚刚 / 3 分钟前"，用于最后一次使用/报错
function fmtAgo(ts){
  if(!ts) return "";
  var d=Math.floor((Date.now()-ts)/1000);
  if(d<10) return "刚刚";
  if(d<60) return d+" 秒前";
  if(d<3600) return Math.floor(d/60)+" 分钟前";
  if(d<86400) return Math.floor(d/3600)+" 小时前";
  return Math.floor(d/86400)+" 天前";
}

/* 一个账号的卡片。
   布局：头部（序号+邮箱+来源+状态徽标）→ 数据格 → 最后错误行 → 动作排。 */
function acctCard(a){
  // 冷却改成「账号×模型」级后，「可用」只表示账号本身参与调度；
  // 具体哪个模型受限看 cooldown_models。卡片状态因此分三档：
  //   停用 / 全部模型都在冷却（真正不可用）/ 部分模型冷却（还能用别的模型）
  var cms = a.cooldown_models || [];
  var allCooling = false;
  if(a.enabled && cms.length){
    var known = state.owned.length;
    // 模型总数未知时（health 降级视图）不轻易判定「全部冷却」
    allCooling = known > 0 && cms.length >= known;
  }
  var st = !a.enabled ? "off" : (cms.length ? (allCooling ? "cool" : "warn") : "live");
  var badge = !a.enabled
    ? '<span class="badge off">已停用</span>'
    : (cms.length
        ? (allCooling ? '<span class="badge cool">冷却中</span>' : '<span class="badge part">部分冷却</span>')
        : '<span class="badge live">可用</span>');

  // 冷却列显示最长的那个剩余时间（多模型冷却时数字旁边标出数量）
  var coolV, coolCls, coolK;
  if(!a.enabled){ coolV="—"; coolCls="dim"; coolK="冷却"; }
  else if(!cms.length){ coolV="无"; coolCls="dim"; coolK="冷却"; }
  else {
    coolV = fmtDur(a.cooldown_seconds)+(cms.length>1?" · "+cms.length+" 个模型":"");
    coolCls="warn";
    // 原因取最明确的那条：额度用尽比「未知」值得说
    var lim = null;
    for(var i=0;i<cms.length;i++){ if(cms[i].limited){ lim=cms[i]; break; } }
    coolK = "冷却（"+coolLabel((lim||cms[0]).kind)+"）";
  }

  var s = a.stats || {};
  // 成功率：只在有调用记录时显示，否则显示 "—"（避免 0% 的误导）
  var total = (s.ok||0)+(s.fail||0);
  var rateV = total ? Math.round((s.ok||0)/total*100)+"%" : "—";
  var rateCls = !total ? "dim" : (total && (s.ok||0)/total>=0.8 ? "ok" : ((s.ok||0)/total>=0.5?"warn":"bad"));

  var email = a.email || ("账号 #"+(a.index+1));
  // token 用量：按上游调用计，与统计页口径一致
  var us = a.usage || {};
  var usCls = us.total ? "" : "dim";
  var lastRow = s.last_error
    ? '<div class="last" title="'+esc(s.last_error+(s.last_error_at?"（"+fmtAgo(s.last_error_at)+"）":""))+'">'+
        '<span class="k">最后错误</span>'+esc(s.last_error)+'</div>'
    : "";

  // 环境变量账号不能移除（下次读取会重新出现），按钮就不显示，避免点了报错
  var removeBtn = a.runtime
    ? '<button class="xs danger" data-act="remove" data-id="'+esc(a.id)+'" title="从账号池移除（仅临时账号）">移除</button>'
    : "";

  return '<div class="acct '+st+'" data-id="'+esc(a.id)+'">'+
    '<div class="hd">'+
      '<span class="ix">'+(a.index+1)+'</span>'+
      '<span class="who">'+
        '<span class="ml" title="'+esc(email)+'">'+esc(email)+'</span>'+
        '<span class="src">'+(a.runtime?'<b>已存盘</b> · 控制台登录':'环境变量')+'</span>'+
      '</span>'+
      badge+
    '</div>'+
    '<div class="kv">'+
      '<div><span class="k">'+esc(coolK)+'</span><span class="v '+coolCls+'">'+esc(coolV)+'</span></div>'+
      '<div><span class="k">token 缓存</span><span class="v'+(a.token_cached?" ok":" dim")+'">'+(a.token_cached?"有":"无")+'</span></div>'+
      '<div><span class="k">成功 / 失败</span><span class="v"><span class="ok">'+(s.ok||0)+'</span> / <span class="'+(s.fail?"bad":"dim")+'">'+(s.fail||0)+'</span></span></div>'+
      '<div><span class="k">成功率</span><span class="v '+rateCls+'">'+rateV+'</span></div>'+
      '<div title="该账号消耗的输入 token（按上游调用累计）"><span class="k">输入 token</span><span class="v '+usCls+'">'+fmtTok(us.input)+'</span></div>'+
      '<div title="该账号消耗的输出 token（按上游调用累计）"><span class="k">输出 token</span><span class="v '+usCls+'">'+fmtTok(us.output)+'</span></div>'+
      '<div><span class="k">最后使用</span><span class="v '+(s.last_used_at?"":"dim")+'">'+esc(s.last_used_at?fmtAgo(s.last_used_at):"—")+'</span></div>'+
      '<div><span class="k">账号 ID</span><span class="v dim" title="'+esc(a.id)+'">'+esc(a.id.slice(0,6))+'</span></div>'+
    '</div>'+
    lastRow+
    '<div class="act">'+
      '<button class="xs" data-detail="'+esc(a.id)+'" title="查看该账号的模型级冷却、可用模型与 token 用量">详情</button>'+
      '<button class="xs" data-balance="'+esc(a.id)+'" title="查询该账号的官方 Credit 余额">余额</button>'+
      (a.enabled
        ? '<button class="xs" data-act="disable" data-id="'+esc(a.id)+'" title="停止参与轮询（可用时仍保留在池里）">停用</button>'
        : '<button class="xs" data-act="enable" data-id="'+esc(a.id)+'" title="重新参与轮询">启用</button>')+
      '<button class="xs" data-act="reset" data-id="'+esc(a.id)+'" title="清除该账号所有模型的冷却与 token 缓存">重置冷却</button>'+
      removeBtn+
    '</div>'+
  '</div>';
}

function renderAccts(){
  var det=(state.health&&state.health.account_details)||[];
  var g=$("accts");
  // 冷却改为「账号×模型」级后，计数口径要跟着改：
  //   可用   = 启用且没有任何模型在冷却
  //   冷却中 = 启用、但有模型在冷却（是否「全部」不影响计数，卡片上会区分）
  var avail=det.filter(function(a){return a.enabled&&!(a.cooldown_models||[]).length;}).length;
  var off=det.filter(function(a){return !a.enabled;}).length;
  var cool=det.filter(function(a){return a.enabled&&(a.cooldown_models||[]).length>0;}).length;

  $("acOk").textContent=avail; $("acCool").textContent=cool;
  $("acOff").textContent=off;  $("acTotal").textContent=det.length;

  // 概览右侧一句话：把最该采取行动的情况说清楚
  var hint="";
  if(!state.hasDetail){
    hint='<span style="color:var(--warn)">读不到账号明细：请在下方填入 API Key（「接入配置」页可复制）</span>';
  } else if(det.length&&avail===0&&cool===0){
    hint = off===det.length
      ? '<span style="color:var(--bad)">全部账号已停用，请求会直接失败</span>'
      : '<span style="color:var(--warn)">当前没有可用账号，请求会返回 429</span>';
  } else if(cool>0&&avail===0){
    hint='<span style="color:var(--warn)">所有账号都有模型在冷却；额度按「账号×模型」独立计算，等恢复或加号</span>';
  } else if(off>0){
    hint='<span style="color:var(--ink-3)">'+off+' 个账号已停用，不参与轮询</span>';
  } else if(det.length){
    hint='<span style="color:var(--ok)">账号池就绪</span>';
  }
  $("acctHint").innerHTML=hint;

  if(!det.length){ g.innerHTML=""; $("acctEmpty").hidden=false; return; }
  $("acctEmpty").hidden=true;
  g.innerHTML=det.map(acctCard).join("");
}

/* 账号控制：把动作发给服务端，用返回的最新账号列表直接刷新界面，
   省掉一次 /v1/health 往返。
   modelId 只在 clearCooldown（解除单个「账号×模型」冷却）时使用。 */
function accountAction(action,id,btn,modelId){
  var busyLabel = {disable:"停用中",enable:"启用中",reset:"重置中",remove:"移除中",
                   enableAll:"启用中",resetAll:"重置中",clearCooldown:"解除中"}[action] || "处理中";
  if(btn){ btn.disabled=true; flash(btn,busyLabel); }
  var payload={action:action};
  if(id) payload.id=id;
  if(modelId) payload.modelId=modelId;

  return fetch("/v1/accounts/action",{method:"POST",headers:authHeaders(),body:JSON.stringify(payload)})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){
        toastError("账号操作失败："+action, o.d, "HTTP "+o.r.status);
        // 服务端说找不到账号 → 多半是列表过期，顺手刷新一次
        if(o.r.status===404) loadHealth();
        return;
      }
      // 用返回的账号列表就地更新，页面立刻反映新状态
      if(state.health){
        state.health.account_details=o.d.accounts;
        state.health.account_count=o.d.accounts.length;
      }
      recalcHealthCounts();
      renderAccts(); renderHealth(state.health);
      if(o.d.message) toast("ok","已完成", esc(o.d.message));
      // 详情弹窗里点的「解除冷却」：列表已刷新，把弹窗内容也更新掉
      if(action==="clearCooldown"&&$("acctModal")&&!$("acctModal").hidden) openAcctDetail(id);
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("账号操作请求失败", e); });
}

// /v1/health 的聚合字段在本地更新后要跟着重算，否则侧栏数字会和卡片对不上
function recalcHealthCounts(){
  var h=state.health; if(!h||!h.account_details) return;
  h.account_count=h.account_details.length;
  h.accounts=h.account_count;
  h.accounts_available=h.account_details.filter(function(a){
    return a.enabled&&!(a.cooldown_models||[]).length;
  }).length;
  h.runtime_accounts=h.account_details.filter(function(a){return a.runtime;}).length;
}

/* ── 账号详情 / 余额 ──
   详情回答的是「这个账号现在哪些模型到了上限、什么时候恢复、还有哪些模型能用」——
   额度的粒度就是「账号×模型」，所以视图要对齐这个粒度，而不是只给一个总数。 */
function openAcctDetail(id){
  var box="acctModal";
  var el=$(box);
  if(!el){
    var d=document.createElement("div");
    d.className="modal-bg"; d.id=box;
    d.innerHTML='<div class="modal"><header><h3 id="acctModalTtl">账号详情</h3>'+
      '<span class="grow"></span><button class="xs ghost" id="acctModalClose">关闭</button></header>'+
      '<div class="pad" id="acctModalBody"></div></div>';
    document.body.appendChild(d);
    $("acctModalClose").addEventListener("click",function(){ $("acctModal").hidden=true; });
    d.addEventListener("click",function(e){ if(e.target===d) d.hidden=true; });
  }
  el.hidden=false;
  $("acctModalBody").innerHTML='<div class="num" style="color:var(--ink-3)">读取中…</div>';
  fetch("/v1/accounts/detail?id="+encodeURIComponent(id),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("acctModalBody").innerHTML='<div class="err"><b>读取失败：</b>'+
          esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+'</div>';
        return;
      }
      renderAcctDetail(o.d);
    })
    .catch(function(e){
      $("acctModalBody").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+'</div>';
    });
}

function renderAcctDetail(d){
  $("acctModalTtl").textContent="账号详情 · "+(d.email||d.id.slice(0,6));
  var lim=d.limited||[];
  var limRows = lim.length
    ? lim.map(function(c){
        return '<tr><td class="mid">'+esc(c.model_id)+'</td>'+
          '<td>'+esc(coolLabel(c.kind))+'</td>'+
          '<td class="num">'+esc(fmtDur(c.remaining_seconds))+'</td>'+
          '<td class="num">'+esc(c.resets_at?fmtClock(new Date(c.resets_at).getTime()):"—")+'</td>'+
          '<td class="acts"><button class="xs" data-clear="'+esc(d.id)+'" data-model="'+esc(c.model_id)+'">解除冷却</button></td></tr>';
      }).join("")
    : '<tr><td colspan="5" class="dim" style="padding:11px">没有模型在冷却中。</td></tr>';

  var others=(d.other_models||[]);
  var otherHtml = others.length
    ? others.slice(0,60).map(function(m){ return '<code class="chiplite">'+esc(m)+'</code>'; }).join(" ")
      + (others.length>60?' <span class="dim">…共 '+others.length+' 个</span>':'')
    : '<span class="dim">没有其它可用模型。</span>';

  var ut=d.usage_total||{}, ud=d.usage_today||{};
  $("acctModalBody").innerHTML=
    '<div class="kv2">'+
      '<div><span class="k">状态</span><span class="v">'+esc(d.enabled?"启用":"已停用")+'</span></div>'+
      '<div><span class="k">来源</span><span class="v">'+esc(d.runtime?"控制台登录（已存盘）":"环境变量")+'</span></div>'+
      '<div><span class="k">token 缓存</span><span class="v">'+esc(d.token_cached?"有":"无")+'</span></div>'+
      '<div><span class="k">兜底冷却时长</span><span class="v">'+esc(d.cooldown_minutes+" 分钟")+'</span></div>'+
    '</div>'+
    '<h4 class="mh">冷却中的模型（额度按「账号×模型」独立计算）</h4>'+
    '<div class="tblwrap tblfixed"><table class="m"><thead><tr><th>模型</th><th>原因</th><th>剩余</th><th>恢复时刻</th><th></th></tr></thead>'+
    '<tbody>'+limRows+'</tbody></table></div>'+
    '<h4 class="mh">现在可用的模型（'+others.length+'）</h4>'+
    '<div class="chips">'+otherHtml+'</div>'+
    '<h4 class="mh">Token 用量（累计 / 今日）</h4>'+
    '<div class="kv2">'+
      '<div><span class="k">输入</span><span class="v">'+esc(fmtTok(ut.input)+" / "+fmtTok(ud.input))+'</span></div>'+
      '<div><span class="k">输出</span><span class="v">'+esc(fmtTok(ut.output)+" / "+fmtTok(ud.output))+'</span></div>'+
      '<div><span class="k">合计</span><span class="v">'+esc(fmtTok(ut.total)+" / "+fmtTok(ud.total))+'</span></div>'+
      '<div><span class="k">上游调用</span><span class="v">'+esc(String(ut.calls||0)+" / "+String(ud.calls||0))+'</span></div>'+
    '</div>'+
    '<h4 class="mh">refreshToken</h4>'+
    '<p class="desc">'+
      (d.rotated
        ? "<b>该账号的 token 已被上游轮换过</b>（内存里是新值）。环境变量账号的新值无法自动写回，请复制下面这份更新配置；控制台登录的账号已自动落盘。"
        : "默认只显示脱敏值。需要换机器部署或手工备份时点「显示」取完整值。")+'</p>'+
    '<div class="snip" id="rtBox" style="margin:0 0 9px">'+esc(d.refresh_token||d.refresh_token_masked||"")+'</div>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="primary" id="btnRtReveal">显示完整值</button>'+
      '<button class="ghost" id="btnRtCopy">复制</button>'+
      '<button class="ghost" id="btnBal">查询官方余额</button>'+
    '</div>'+
    '<div id="balBox" style="margin-top:11px"></div>';

  var rtFull=d.refresh_token||"";
  $("btnRtReveal").addEventListener("click",function(){
    fetch("/v1/accounts/detail?id="+encodeURIComponent(d.id)+"&reveal=1",{headers:authHeaders(),cache:"no-store"})
      .then(function(r){ return r.json(); })
      .then(function(o){
        if(!o.ok){ toastError("读取完整 token 失败",o); return; }
        rtFull=o.refresh_token||"";
        $("rtBox").textContent=rtFull;
        flash($("btnRtReveal"),"已显示");
      })
      .catch(function(e){ toastError("读取完整 token 失败",e); });
  });
  $("btnRtCopy").addEventListener("click",function(){ copyText(rtFull||$("rtBox").textContent,$("btnRtCopy"),$("rtBox")); });
  $("btnBal").addEventListener("click",function(){ queryBalance(d.id,$("btnBal"),$("balBox")); });
}

function queryBalance(id,btn,box){
  if(btn){ btn.disabled=true; flash(btn,"查询中"); }
  fetch("/v1/accounts/balance?id="+encodeURIComponent(id),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn){ btn.disabled=false; btn.textContent="查询官方余额"; }
      if(!o.d.ok){
        box.innerHTML='<div class="err">'+esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+'</div>';
        return;
      }
      box.innerHTML='<div class="kv2">'+
        '<div><span class="k">Credit 余额</span><span class="v ok">'+esc(fmtNum(o.d.balance,6))+'</span></div>'+
        '<div><span class="k">查询时刻</span><span class="v">'+esc(fmtClock(o.d.checkedAt))+'</span></div>'+
      '</div>'+
      '<p class="desc" style="font-size:10.5px;color:var(--ink-3);margin-top:7px">'+
        '官方接口的原始值以微单位计，这里已按 ÷1e6 换算成面板上显示的 Credit。</p>';
    })
    .catch(function(e){
      if(btn){ btn.disabled=false; btn.textContent="查询官方余额"; }
      box.innerHTML='<div class="err">'+esc(String(e&&e.message||e))+'</div>';
    });
}

/* ── 登录 ── */
function startLogin(){
  $("loginBox").hidden=false;
  $("loginBody").innerHTML='<div class="num" style="color:var(--ink-3)">正在申请授权码…</div>';
  fetch("/v1/login/start",{method:"POST",headers:authHeaders(),body:"{}"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        var lm=(o.d.error&&o.d.error.message)||("HTTP "+o.r.status);
        $("loginBody").innerHTML='<div class="err"><b>无法开始登录：</b>'+esc(lm)+'</div>'+
          '<div style="margin-top:11px"><button class="ghost" onclick="startLogin()">重试</button></div>';
        toast("err","无法开始登录", esc(lm));
        return;
      }
      state.login={device_code:o.d.device_code,expires_in:o.d.expires_in,started:Date.now(),interval:o.d.interval};
      renderLogin(o.d);
      pollLogin();
    })
    .catch(function(e){
      $("loginBody").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+'</div>';
      toastError("登录请求异常", e);
    });
}
function renderLogin(d){
  $("loginBody").innerHTML=
    '<p style="font-size:12px;color:var(--ink-2)">点下面按钮打开授权页面，登录 Cline 账号并确认。本页会自动检测结果。</p>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:11px 0 4px">'+
      '<a href="'+esc(d.verification_uri)+'" target="_blank" rel="noopener" style="text-decoration:none"><button class="primary" id="btnOpenAuth">打开授权页面</button></a>'+
      '<button class="ghost" id="btnReopen">在本页打开</button></div>'+
    '<div class="linkrow"><span class="u" title="'+esc(d.verification_uri)+'">'+esc(d.verification_uri)+'</span>'+
      '<button class="xs ghost" id="btnCopyLink">复制链接</button></div>'+
    '<p style="font-size:11px;color:var(--ink-3)">若页面要求输入设备码，即下面这串：</p>'+
    '<div class="code" id="deviceCode">'+esc(d.user_code||"------")+'</div>'+
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'+
      '<button class="xs ghost" id="btnCopyCode">复制设备码</button>'+
      '<span class="grow" style="flex:1"></span>'+
      '<span class="num" style="color:var(--ink-3)" id="loginStatus">等待授权…</span></div>'+
    '<div class="meter" id="loginMeter"><i></i></div>';
  $("btnReopen").addEventListener("click",function(){ window.open(d.verification_uri,"_blank","noopener"); });
  $("btnCopyLink").addEventListener("click",function(){ copyText(d.verification_uri,$("btnCopyLink"),document.querySelector(".linkrow .u")); });
  $("btnCopyCode").addEventListener("click",function(){ copyText(d.user_code||"",$("btnCopyCode"),$("deviceCode")); });
}
function pollLogin(){
  if(!state.login) return;
  clearTimeout(state.loginTimer);
  var el=Date.now()-state.login.started, tot=(state.login.expires_in||300)*1000;
  if(el>tot){ finishLogin(false,"授权超时，请重新登录。"); return; }
  var m=$("loginMeter");
  if(m) m.querySelector("i").style.width=Math.min(el/tot*100,100)+"%";
  var st=$("loginStatus");
  if(st) st.textContent="等待授权…（剩余 "+Math.max(Math.ceil((tot-el)/1000),0)+" 秒）";
  fetch("/v1/login/poll",{method:"POST",headers:authHeaders(),body:JSON.stringify({device_code:state.login.device_code})})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!state.login) return;
      if(d.status==="pending"||d.status==="slow_down"){ state.loginTimer=setTimeout(pollLogin,(state.login.interval||5)*1000); return; }
      if(d.status==="success"){ finishLogin(true,d); return; }
      finishLogin(false,(d.error&&d.error.message)||"授权失败。");
    })
    .catch(function(){ if(state.login) state.loginTimer=setTimeout(pollLogin,6000); });
}
function finishLogin(ok,payload){
  clearTimeout(state.loginTimer);
  if(!ok){
    state.login=null;
    $("loginBody").innerHTML='<div class="err"><b>登录未完成：</b>'+esc(payload)+'</div>'+
      '<div style="margin-top:11px"><button class="ghost" onclick="startLogin()">重新登录</button></div>';
    toast("warn","登录未完成", esc(payload));
    return;
  }
  state.login=null;
  var rt=payload.refresh_token||"";
  $("loginBody").innerHTML=
    '<div class="note ok" style="margin-bottom:11px"><span class="grow">登录成功'+(payload.email?"："+esc(payload.email):"")+'，账号已加入账号池，可立即使用。</span></div>'+
    '<p style="font-size:12px;color:var(--ink-2)">该账号目前只在当前实例内存里，<b>重启或重新部署后会消失</b>。想长期保留，把下面这个 refreshToken 填进环境变量 <code>CLINE_REFRESH_TOKEN</code>：</p>'+
    '<pre class="snip" id="rtBox" style="margin:11px 0">'+esc(rt)+'</pre>'+
    '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="primary" id="btnCopyRt">复制 refreshToken</button>'+
      '<button class="ghost" id="btnDoneLogin">完成</button></div>';
  $("btnCopyRt").addEventListener("click",function(){ copyText(rt,$("btnCopyRt"),$("rtBox")); });
  $("btnDoneLogin").addEventListener("click",function(){ $("loginBox").hidden=true; $("loginBody").innerHTML=""; });
  toast("ok","账号已加入账号池"+(payload.email?"（"+payload.email+"）":""),
    "可以立即使用。注意它<b>重启后会消失</b>，要长期保留请复制页面上的 refreshToken 填进环境变量。");
  setTimeout(loadHealth,400);
}
function cancelLogin(){
  clearTimeout(state.loginTimer); state.login=null;
  $("loginBox").hidden=true; $("loginBody").innerHTML="";
}

/* ══ 模型 ══ */
function providerOf(id){
  var p=String(id||"").split("/")[0].toLowerCase();
  return p;
}
function regionOf(id){
  var p=providerOf(id);
  if(CN_PROVIDERS[p]) return "cn";
  if(OV_PROVIDERS[p]) return "ov";
  if(id.indexOf("cline-free/")===0) return "of";   // 官方免费通道，不归地区
  return "ov";                                      // 未知按海外处理（不冒标国产）
}
function regionName(id){
  var p=providerOf(id), r=regionOf(id);
  if(r==="cn") return CN_PROVIDERS[p]||"国产";
  if(r==="of") return "官方";
  // 已知海外厂商显示厂商名；不在两张表里的**直接显示 provider 本身**，
  // 不要谎称"海外"（上游有 60+ 个 provider，多数我们并不认识）
  return OV_PROVIDERS[p]||p;
}
function isFree(m){ return typeof m.cost==="string" ? m.cost==="free" : (/:free$/.test(m.id)||m.id.indexOf("cline-free/")===0); }
function costPill(m){
  // 服务端只放行确定免费的模型，所以正常情况下这里显示的都是「免费」类；
  // 「实测免费」用于区分来源——官方分类没覆盖、由白名单人工实测登记的模型，
  // 客户端看到它就知道这条免费依据是人工验证而不是官方标注。
  // 保留「需订阅 / 云额度」分支：上游拉取失败时会回退到内置列表，其中含 cline-pass 项。
  if(m.channel==="recommended") return '<span class="tag free">推荐</span>';
  if(m.channel==="verified") return '<span class="tag free">实测免费</span>';
  if(m.channel==="free"||m.channel==="free-suffix"||m.cost==="free") return '<span class="tag free">免费</span>';
  if(m.channel==="cline-pass"||m.cost==="pass") return '<span class="tag paid">需订阅</span>';
  if(m.channel==="cline-cloud"||m.cost==="cloud") return '<span class="tag paid">云额度</span>';
  if(m.cost==="paid") return '<span class="tag paid">付费</span>';
  return '<span class="tag ov">未标价</span>';
}
/* ══ 模型库 ══
   三段式：可用模型分组（推荐清单）/ 全部模型（折叠，按需抓）/ 已启用模型。
   三处的卡片共用 modelCardHTML，保证格式与交互完全一致。

   注意：本文件会被 build-console.mjs 注入 worker.js 的模板字符串，
   反引号与 \${ 会被转义而失效 —— 只能用字符串拼接。 */

// 已启用模型的 ID 集合（判断卡片是否已添加、决定 ＋ 是否可点）
function ownedSet(){
  var s={}; for(var i=0;i<state.owned.length;i++) s[state.owned[i].id]=true; return s;
}

// 模型卡片的「检测」状态：跑着的、跑完的，都从内存里取（服务端不存检测结果，
// 因为它只回答"刚才那一刻能不能用"，存下来反而会被误当成长期结论）
function checkState(id){
  var c=state.mchecks[id];
  if(!c) return { cls:"", text:"", btn:"检测" };
  if(c.status==="running") return { cls:"", text:"检测中…", btn:"检测中" };
  if(c.status==="failed") return { cls:"bad", text:c.error||"检测失败", btn:"重测" };
  var r=c.result||{};
  return { cls:r.ok?"ok":"bad", text:r.text||"", btn:"重测" };
}

// 一张模型卡片。installed=true 时高亮并显示 ✓。
function modelCardHTML(m, installed){
  var has=!!installed[m.id];
  var ck=checkState(m.id);
  var tags=(m.tags||[]).filter(function(t){return t;}).map(function(t){
    return '<span class="mtag">'+esc(t)+"</span>";
  }).join("");
  var name=m.name||m.id;
  var ctx=m.context_length?'<span class="mctx" title="上下文长度">'+fmtCtx(m.context_length)+"</span>":"";
  // 标题提示：把 ID、描述、下一步动作都放进去，卡片本身不用铺满这些信息
  var tip=[name,m.id,m.description,"",has?"已启用 · 点 ⧉ 复制 ID":"点 ＋ 添加"].filter(function(x){return x;}).join("\\n");
  return '<div class="mcard'+(has?" on":"")+'" data-mid="'+esc(m.id)+'" data-on="'+(has?"1":"0")+'" title="'+esc(tip)+'">'+
    '<div class="mrow">'+
      '<span class="mname">'+esc(name)+"</span>"+
      (m.id&&m.id!==name?'<span class="mid">'+esc(m.id)+"</span>":"")+
      ctx+tags+
    "</div>"+
    // 按钮单独一行（见 CSS 里关于折行的说明）
    '<div class="macts">'+
      '<button class="xs ghost" data-check="'+esc(m.id)+'"'+(ck.btn==="检测中"?" disabled":"")+">"+esc(ck.btn)+"</button>"+
      '<button class="xs primary" data-add="'+esc(m.id)+'" title="添加此模型"'+(has?" disabled":"")+">＋ 添加</button>"+
      '<button class="xs ghost" data-copyid="'+esc(m.id)+'" title="复制模型 ID">⧉ 复制</button>'+
    "</div>"+
    (ck.text?'<div class="mchk '+ck.cls+'">'+esc(ck.text)+"</div>":"")+
    (m.description?'<div class="mdesc">'+esc(m.description)+"</div>":"")+
  "</div>";
}

// 一组模型（分组标题 + 整组添加 + 卡片墙）
function modelGroupHTML(g, installed){
  var models=g.models||[];
  var meta=g.meta||{};
  var pending=models.filter(function(m){return !installed[m.id];}).length;
  var addAll = pending
    ? '<button class="xs primary" data-addgroup="'+esc(g.key)+'">全部添加 ('+pending+")</button>"
    : '<button class="xs ghost" disabled>已全部添加</button>';
  return '<div class="mgroup" data-gkey="'+esc(g.key)+'">'+
    '<div class="mghead">'+
      '<span class="gdot" style="background:'+(meta.color||"var(--ink-3)")+'"></span>'+
      "<h4>"+esc(meta.title||g.key)+"</h4>"+
      (meta.sub?'<span class="gsub">（'+esc(meta.sub)+"）</span>":"")+
      '<span class="note">共 '+models.length+" 个"+(pending?" · 待添加 "+pending:" · 已全部添加")+"</span>"+
      '<span class="grow"></span>'+
      addAll+
    "</div>"+
    '<div class="mcards">'+models.map(function(m){ return modelCardHTML(m,installed); }).join("")+"</div>"+
  "</div>";
}

// 上下文长度按 K 显示：500000 → 500K（比 500,000 好读，也和模型页的惯例一致）
function fmtCtx(n){
  n=Number(n)||0;
  if(!n) return "";
  if(n>=1000000) return (n/1000000).toFixed(n%1000000?1:0)+"M";
  if(n>=1000) return Math.round(n/1000)+"K";
  return String(n);
}

// 拉推荐分组（面板打开时调；force 用于「刷新数据」）
function loadModelLibrary(force){
  var btn=$("mRefreshBtn");
  if(force&&btn){ btn.disabled=true; flash(btn,"刷新中"); }
  $("mLibrary").innerHTML='<div class="empty">'+(force?"正在重新抓取上游…":"加载中…")+"</div>";
  return fetch("/v1/models/library"+(force?"?refresh=1":""),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){
        $("mLibrary").innerHTML='<div class="err"><b>加载失败：</b>'+
          esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+
          '<br>请先在「接入配置」页填入 API Key。</div>';
        $("mLibNote").textContent="";
        return;
      }
      state.mLibGroups=o.d.groups||[];
      renderModelLibrary();
      // 折叠区的「已添加」标记也依赖已启用列表，一并刷新免得两处互相矛盾
      if(state.mCatLoaded) renderModelCatalog();
      if(o.d.stale&&o.d.error){
        toast("warn","上游抓取失败，显示上次缓存", esc(o.d.error));
      } else if(force){
        toast("ok","模型数据已刷新","");
      }
    })
    .catch(function(e){
      if(btn) btn.disabled=false;
      $("mLibrary").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+"</div>";
    });
}

function renderModelLibrary(){
  var groups=state.mLibGroups||[];
  var inst=ownedSet();
  if(!groups.length){
    $("mLibrary").innerHTML='<div class="empty">暂无数据，点右上角「刷新数据」。</div>';
    $("mLibNote").textContent="";
    return;
  }
  $("mLibrary").innerHTML=groups.map(function(g){ return modelGroupHTML(g,inst); }).join("");
  var total=groups.reduce(function(n,g){ return n+(g.models||[]).length; },0);
  $("mLibNote").textContent="共 "+total+" 个 · 已启用 "+state.owned.length+" 个";
}

// 全部模型：只在用户展开时抓一次（上游 440+ 条、约 500 KB）
function loadModelCatalog(force){
  state.mCatLoaded=true;
  $("mCatalog").innerHTML='<div class="empty">正在抓取全部模型…（上游约 500 KB，首次会慢几秒）</div>';
  return fetch("/v1/models/catalog"+(force?"?refresh=1":""),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("mCatalog").innerHTML='<div class="err"><b>加载失败：</b>'+
          esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+"</div>";
        return;
      }
      state.mCatalog=o.d.groups||[];
      state.mCatalogTotal=o.d.total||0;
      renderModelCatalog();
    })
    .catch(function(e){
      $("mCatalog").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+"</div>";
    });
}

// 搜索只过滤本地已有数据，不发请求（只过一遍 400+ 条，没必要加防抖）
function filterCatalog(groups,q){
  q=String(q||"").trim().toLowerCase();
  if(!q) return groups;
  var out=[];
  for(var i=0;i<groups.length;i++){
    var hit=groups[i].models.filter(function(m){
      return String(m.name||"").toLowerCase().indexOf(q)>=0||String(m.id||"").toLowerCase().indexOf(q)>=0;
    });
    if(hit.length) out.push({key:groups[i].key,models:hit});
  }
  return out;
}

// 这个区域叫「全部模型」，但既然本项目只做免费额度池，就**只列真走免费额度的**。
// 上游那 400+ 个里绝大多数是付费模型（claude-opus / gpt-6 / kimi 等），摆出来等于
// 诱导用户用 0.5 美元余额去烧。判定沿用 isFree()：\`:free\` 后缀或 \`cline-free/\` 前缀。
// 匹配搜索同样只在这份免费集合里做，不会因为搜到付费模型就把它带出来。
// 免费判定：**以上游 recommended-models 的 free 数组为准**，不靠 ID 后缀猜。
//
// 踩过的坑：原先用 isFree()（只看 \`:free\` 后缀或 \`cline-free/\` 前缀）过滤全量清单，
// 但实测 free 分组里有\`stealth/space-bunny-alpha\` —— 既无后缀也无该前缀，
// 按后缀判定会被漏掉。反过来 \`:free\` 后缀的 17 个（qwen/gemma/nemotron 等 OpenRouter 系）
// 也不在 free 分组里，属于另一套来源，是否真免 credits 由上游决定，不该由前端猜。
//
// 所以这里用 freeModelIdSet()（服务端从 free 分组下发的权威 ID 集合）做判定，
// 后缀判定只作为**补充**（free 集合尚未加载时，先按后缀给出临时结果）。
var _freeIdSet = null;
function freeModelIdSet(){
  if(_freeIdSet) return _freeIdSet;
  _freeIdSet = new Set();
  var gs = state.mLibGroups || [];
  for (var i=0;i<gs.length;i++){
    if (gs[i].key !== "free") continue;
    for (var j=0;j<(gs[i].models||[]).length;j++) _freeIdSet.add(gs[i].models[j].id);
  }
  return _freeIdSet;
}
function isFreeModelId(id){
  var s = freeModelIdSet();
  if (s.size) return s.has(id);          // free 集合已加载 → 以它为准
  return /:free$/.test(id) || id.indexOf("cline-free/") === 0;   // 兜底
}
function filterFreeOnly(groups){
  return (groups||[]).map(function(g){
    return { key:g.key, models:(g.models||[]).filter(function(m){ return isFreeModelId(m.id); }) };
  }).filter(function(g){ return g.models.length; });
}

function renderModelCatalog(){
  var groups=filterFreeOnly(state.mCatalog);
  if(!groups.length){
    $("mCatalog").innerHTML='<div class="empty">上游暂无走免费额度的模型（免费通道是轮换促销，会随时间变化）。</div>';
    return;
  }
  var q=$("mCatSearch").value;
  // 搜索时重新按供应商分组：过滤后空掉的组不该留一个空壳标题
  var shown=q?filterCatalog(groups,q):groups;
  var inst=ownedSet();
  var matched=shown.reduce(function(n,g){ return n+(g.models||[]).length; },0);
  var freeTotal=groups.reduce(function(n,g){ return n+(g.models||[]).length; },0);
  $("mCatCount").textContent=q
    ? ("匹配 "+matched+" 个 / 共 "+freeTotal+" 个免费模型")
    : (freeTotal+" 个免费模型 · "+groups.length+" 个供应商");
  if(!shown.length){
    $("mCatalog").innerHTML='<div class="empty">没有匹配「'+esc(q)+'」的模型。</div>';
    return;
  }
  $("mCatalog").innerHTML=shown.map(function(g){ return modelGroupHTML(g,inst); }).join("");
}

// 已启用模型：这是 /v1/models 真正会返回的内容
function loadOwnedModels(){
  return fetch("/v1/models/enabled",{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("mOwned").innerHTML='<div class="err"><b>读取失败：</b>'+
          esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+"</div>";
        return;
      }
      state.owned=o.d.models||[];
      state.ownedBuiltin=!!o.d.using_builtin;
      renderOwnedModels();
    })
    .catch(function(e){
      $("mOwned").innerHTML='<div class="err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+"</div>";
    });
}

function renderOwnedModels(){
  var list=state.owned||[];
  var cnt=$("cnt-model"); if(cnt) cnt.textContent=list.length?String(list.length):"";
  $("mOwnNote").textContent=list.length?("共 "+list.length+" 个"):"";

  // 一个都没启用时服务端会实时取上游免费清单 —— 必须明确说出来，否则用户会以为
  // 列表里的四个模型是他自己加过的
  var hint=$("mOwnHint");
  if(state.ownedBuiltin){
    hint.innerHTML='<b>还没有手动启用过模型</b>，所以 <code>/v1/models</code> 暂时回退到'
      +'上游当前提供的免费模型（实时获取，可能随时变动）。从上面任一分组里添加模型后，就以你的选择为准。';
  } else {
    hint.innerHTML='只有这里的模型会出现在 <code>/v1/models</code> 里。点「移除」即可撤下。';
  }

  if(!list.length){ $("mOwned").innerHTML='<div class="empty">还没有模型。</div>'; return; }
  $("mOwned").innerHTML='<div class="mcards">'+list.map(function(m){
    var badge=m.is_default?'<span class="badge live">默认</span>':"";
    var ck=checkState(m.id);
    return '<div class="mcard on'+(m.is_default?" def":"")+'" data-mid="'+esc(m.id)+'">'+
      '<div class="mrow">'+
        '<span class="mname">'+esc(m.name||m.id)+"</span>"+
        (m.name&&m.name!==m.id?'<span class="mid">'+esc(m.id)+"</span>":"")+
        (m.context_length?'<span class="mctx">'+fmtCtx(m.context_length)+"</span>":"")+
        badge+
      "</div>"+
      '<div class="macts">'+
        // 检测按钮在已启用卡片上同样需要：加之前能用不代表现在还能用，
        // 而"这个模型到底还行不行"正是这一页最常见的诉求
        '<button class="xs ghost" data-check="'+esc(m.id)+'"'+(ck.btn==="检测中"?" disabled":"")+">"+esc(ck.btn)+"</button>"+
        (m.is_default?"":'<button class="xs ghost" data-setdefault="'+esc(m.id)+'" title="不带 model 的请求默认用它">设为默认</button>')+
        '<button class="xs ghost" data-copyid="'+esc(m.id)+'" title="复制模型 ID">⧉ 复制</button>'+
        '<button class="xs danger" data-rm="'+esc(m.id)+'" title="从 /v1/models 里撤下">移除</button>'+
      "</div>"+
      (ck.text?'<div class="mchk '+ck.cls+'">'+esc(ck.text)+"</div>":"")+
      (m.description?'<div class="mdesc">'+esc(m.description)+"</div>":"")+
    "</div>";
  }).join("");
}

// 添加模型：单卡 ＋ 与整组「全部添加」走同一个接口，服务端把重复项计入 skipped
function addModelIds(ids, okMsg){
  if(!ids||!ids.length) return;
  return fetch("/v1/models/batch",{method:"POST",headers:authHeaders(),body:JSON.stringify({ids:ids})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){ toastError("添加失败",o.d,"HTTP "+o.r.status); return; }
      var added=o.d.added||[], skipped=o.d.skipped||[], failed=o.d.failed||{};
      state.owned=o.d.models||[];
      renderOwnedModels(); renderModelLibrary();
      if(state.mCatLoaded) renderModelCatalog();
      var failN=Object.keys(failed).length;
      if(failN&&!added.length){
        toast("err","添加失败", esc(Object.values(failed)[0]));
      } else if(!added.length){
        toast("warn","这些模型都已添加","未重复添加");
      } else {
        var parts=["新增 "+added.length+" 个"];
        if(skipped.length) parts.push("已存在 "+skipped.length+" 个");
        if(failN) parts.push("失败 "+failN+" 个");
        toast("ok", okMsg||"已添加", esc(parts.join("，")));
      }
    })
    .catch(function(e){ toastError("添加请求失败",e); });
}

function removeModel(id,btn){
  if(btn){ btn.disabled=true; flash(btn,"移除中"); }
  fetch("/v1/models/delete",{method:"POST",headers:authHeaders(),body:JSON.stringify({id:id})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){ toastError("移除失败",o.d,"HTTP "+o.r.status); return; }
      state.owned=o.d.models||[];
      renderOwnedModels(); renderModelLibrary();
      if(state.mCatLoaded) renderModelCatalog();
      toast("ok","已移除", esc(o.d.message||id));
      loadModels();
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("移除请求失败",e); });
}

function setDefaultModel(id,btn){
  if(btn){ btn.disabled=true; flash(btn,"设置中"); }
  fetch("/v1/models/default",{method:"POST",headers:authHeaders(),body:JSON.stringify({id:id})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){ toastError("设置失败",o.d,"HTTP "+o.r.status); return; }
      state.owned=o.d.models||[];
      renderOwnedModels();
      toast("ok","已设为默认", esc(o.d.message||id));
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("设置请求失败",e); });
}

/* 模型检测：跑起来的检测在服务端有并发上限，所以这里让「同一时刻只跑一个」——
   面板上连点一排「检测」不该把上游打出一串并发请求（免费通道并发会返回空响应）。 */
function checkModel(id,btn){
  if(btn) btn.disabled=true;
  state.mchecks[id]={status:"running"};
  refreshCheckUI(id);
  fetch("/v1/models/check",{method:"POST",headers:authHeaders(),body:JSON.stringify({id:id})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        state.mchecks[id]={status:"failed",error:(o.d.error&&o.d.error.message)||("HTTP "+o.r.status)};
        refreshCheckUI(id); return;
      }
      pollCheck(id,o.d.job.id,0);
    })
    .catch(function(e){
      state.mchecks[id]={status:"failed",error:String(e&&e.message||e)};
      refreshCheckUI(id);
    });
}

function pollCheck(id,jobId,tries){
  if(tries>60){
    state.mchecks[id]={status:"failed",error:"检测超时（仍在后台进行）"};
    refreshCheckUI(id); return;
  }
  fetch("/v1/models/check?jobId="+encodeURIComponent(jobId),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.ok){ state.mchecks[id]={status:"failed",error:(d.error&&d.error.message)||"状态不可读"}; refreshCheckUI(id); return; }
      var j=d.job;
      if(j.status==="running"){ setTimeout(function(){ pollCheck(id,jobId,tries+1); },1200); return; }
      if(j.status==="failed"){ state.mchecks[id]={status:"failed",error:j.error||"检测失败"}; refreshCheckUI(id); return; }
      state.mchecks[id]={status:"done",result:j.result};
      refreshCheckUI(id);
    })
    .catch(function(){ setTimeout(function(){ pollCheck(id,jobId,tries+1); },1500); });
}

// 只重绘那张卡片的检测状态，不整页重渲染（否则输入框里的搜索词会被清掉）
function refreshCheckUI(id){
  var cards=document.querySelectorAll('.mcard[data-mid="'+id.replace(/"/g,'\\\\"')+'"]');
  for(var i=0;i<cards.length;i++){
    var ck=checkState(id);
    var old=cards[i].querySelector(".mchk");
    if(ck.text){
      if(old){ old.className="mchk "+ck.cls; old.textContent=ck.text; }
      else{
        var d=document.createElement("div");
        d.className="mchk "+ck.cls; d.textContent=ck.text;
        // 插到整个动作行的后面（动作行现在是第二行，结果行跟在它下面）
        var acts=cards[i].querySelector(".macts");
        var anchor=acts||cards[i].querySelector(".mrow");
        if(anchor&&anchor.nextSibling) cards[i].insertBefore(d,anchor.nextSibling);
        else cards[i].appendChild(d);
      }
    } else if(old){ old.parentNode.removeChild(old); }
    var b=cards[i].querySelector("button[data-check]");
    if(b){ b.disabled=(ck.btn==="检测中"); b.textContent=ck.btn; }
  }
}

// 表格视图（对话页的模型下拉、以及接入配置页要用）——只关心已启用模型，
// 因为客户端能用的就是这些。
function loadModels(){
  return loadOwnedModels().then(function(){
    var ids=(state.owned||[]).map(function(m){ return m.id; });
    var sel=$("model");
    if(!ids.length){
      sel.innerHTML='<option value="">还没有启用模型</option>';
      return;
    }
    sel.innerHTML=ids.map(function(id){
      var mm=state.owned.filter(function(x){return x.id===id;})[0]||{};
      var label=(mm.name&&mm.name!==id)?(mm.name+" · "+id):id;
      return '<option value="'+esc(id)+'"'+(id===state.model?" selected":"")+">"+esc(label)+"</option>";
    }).join("");
    if(ids.indexOf(state.model)<0){ state.model=ids[0]; sel.value=state.model; save(LS.model,state.model); }
  });
}

function cell(k,v,cls){ return '<div><div class="k">'+esc(k)+'</div><div class="v '+(cls||"")+'">'+esc(v)+"</div></div>"; }

/* ══ Token 统计 ══
   注意：本文件会被 build-console.mjs 注入 worker.js 的模板字符串，
   反引号与 \${ 会被转义成字面量而失效 —— 只能用字符串拼接，不要用模板字符串。 */

// token 数动辄上万，直接显示会撑爆数据格；按量级压缩，保留有效位数
function fmtTok(n){
  n=Number(n)||0;
  if(!isFinite(n)) return "-";
  var a=Math.abs(n);
  if(a<1000) return String(Math.round(n));
  if(a<1e6) return (n/1000).toFixed(a<1e4?1:0)+"K";
  if(a<1e9) return (n/1e6).toFixed(a<1e7?2:1)+"M";
  return (n/1e9).toFixed(2)+"B";
}

// 只显示首/中/末三个横轴标签：30 个日期全放会糊成一团，还不如给最小的定位锚点
function trendLabelHide(i,total){
  return !(i===0||i===total-1||i===Math.floor(total/2));
}

/* ══ 上游渠道 ══
   面板只管「用户想钉什么」；管道归属与可用渠道清单是探测出来的，只读展示。
   用户填的表单不提交探测字段，服务端会保留缓存（否则每次保存都得重探）。 */
function loadUpstreams(){
  $("upList").innerHTML='<div class="box"><div class="pad num" style="color:var(--ink-3)">读取中…</div></div>';
  return fetch("/v1/upstreams?action=list",{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("upList").innerHTML='<div class="box"><div class="pad err"><b>读取失败：</b>'+
          esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status))+
          '<br>请先在「接入配置」页填入 API Key。</div></div>';
        return;
      }
      state.upstreams=o.d.upstreams||[];
      state.upModels=o.d.models||[];
      $("upNote").textContent=state.upstreams.length+" 个模型已配置";
      var cnt=$("cnt-up"); if(cnt) cnt.textContent=state.upstreams.length||"";
      $("upModelList").innerHTML=state.upModels.map(function(m){ return '<option value="'+esc(m)+'">'; }).join("");
      if(!state.upstreams.length){
        $("upList").innerHTML='<div class="box"><div class="pad"><div class="empty">'+
          '还没有任何渠道配置。<br>全部模型都在自动模式下运行（由网关自己挑渠道，通常就是最优解）。</div></div></div>';
        return;
      }
      $("upList").innerHTML=state.upstreams.map(upCard).join("");
    })
    .catch(function(e){
      $("upList").innerHTML='<div class="box"><div class="pad err"><b>请求异常：</b>'+esc(String(e&&e.message||e))+'</div></div>';
    });
}

function upCard(cfg){
  var m=cfg.model_id;
  var pipe = cfg.pipeline
    ? '<span class="badge live">'+esc(cfg.pipeline)+'</span>'
    : '<span class="badge part">未探测</span>';
  // 钉住生效确认：探测过、有钉住列表、且知道实际命中时才有意义
  var match="";
  if(cfg.pipeline&&(cfg.upstreams||[]).length&&cfg.lastProvider){
    var hit=(cfg.upstreams||[]).some(function(u){ return normSlug(u)===normSlug(cfg.lastProvider); });
    match=hit?'<span class="ok">✓ 钉住生效</span>':'<span class="bad">✗ 钉住未生效</span>';
  }
  var avail=(cfg.available||[]);
  var probeHtml=
    '<div class="probe">'+
      '<div class="row"><span class="k">管道</span>'+(cfg.pipeline?esc(cfg.pipeline):'<span class="warn">未知（未探测）</span>')+
        '<span class="k" style="margin-left:11px">实际命中</span>'+esc(cfg.lastProvider||"—")+
        (match?' <span style="margin-left:9px">'+match+'</span>':'')+'</div>'+
      '<div class="row" style="margin-top:5px"><span class="k">可用渠道（'+avail.length+'）</span></div>'+
      '<div class="chips" style="margin-top:4px">'+
        (avail.length?avail.map(function(u){return '<code class="chiplite">'+esc(u)+'</code>';}).join("")
                     :'<span style="color:var(--ink-3)">未探到清单；可先点「探测」</span>')+
      '</div>'+
      (cfg.probedAt?'<div class="row" style="margin-top:5px"><span class="k">探测于</span>'+esc(fmtAgo(cfg.probedAt))+'</div>':'')+
      '<div class="note" id="probeNote-'+esc(m)+'" hidden></div>'+
    '</div>';

  function chk(v,val){ return v===val?" selected":""; }
  function chkB(v,val){ return v===val?" selected":""; }

  return '<div class="box upcard" data-model="'+esc(m)+'">'+
    '<header>'+
      '<h3 style="font-size:11.5px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis">'+esc(m)+'</h3>'+
      pipe+
      '<span class="grow"></span>'+
      '<button class="xs" data-upprobe="'+esc(m)+'">探测</button>'+
      '<button class="xs ghost" data-updel="'+esc(m)+'">删除配置</button>'+
    '</header>'+
    '<div class="upbody">'+
      '<div class="full">'+probeHtml+'</div>'+
      '<div>'+
        '<label class="lb">钉住的渠道（逗号分隔，顺序即优先级）</label>'+
        '<input data-up="upstreams" value="'+esc((cfg.upstreams||[]).join(", "))+'" placeholder="留空 = 不钉，例如 alibaba, deepinfra">'+
      '</div>'+
      '<div>'+
        '<label class="lb">排除的渠道（逗号分隔）</label>'+
        '<input data-up="exclude" value="'+esc((cfg.exclude||[]).join(", "))+'" placeholder="例如 baseten, novita">'+
        '<p class="desc" style="margin-top:4px">网关不认排除字段，所以会换算成白名单（依赖上面的可用渠道清单）。</p>'+
      '</div>'+
      '<div>'+
        '<label class="lb">钉住模式</label>'+
        '<select data-up="pinMode">'+
          '<option value="strict"'+chk(cfg.pinMode,"strict")+'>strict — 只用这些渠道，不回退</option>'+
          '<option value="preferred"'+chk(cfg.pinMode,"preferred")+'>preferred — 优先这些，允许回退</option>'+
        '</select>'+
      '</div>'+
      '<div>'+
        '<label class="lb">模型 ID 重定向（发给上游的真实 ID）</label>'+
        '<input data-up="redirect" value="'+esc(cfg.redirect||"")+'" placeholder="留空 = 原样透传">'+
      '</div>'+
      '<div class="full">'+
        '<label class="lb">别名（逗号分隔，同样适用本配置的其它模型 ID）</label>'+
        '<input data-up="aliases" value="'+esc((cfg.aliases||[]).join(", "))+'" placeholder="例如 my-glm, team/glm">'+
      '</div>'+
      '<div class="full" style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">'+
        '<button class="primary" data-upsave="'+esc(m)+'">保存</button>'+
        '<span class="upmeta">管道：<code>'+(cfg.pipeline||"未知")+'</code>　'+
        '探测结果会随保存一起保留，不必重探。</span>'+
      '</div>'+
    '</div>'+
  '</div>';
}

// 渠道名归一化：direct 管道回的 provider 是显示名（"DeepInfra"），
// 而清单里是 slug（"deepinfra"），比对前必须归一化，否则会误判「未生效」。
function normSlug(s){ return String(s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

// 逗号分隔输入 → 数组（去空白与空项）
function splitList(v){
  return String(v||"").split(",").map(function(s){return s.trim();}).filter(function(s){return s;});
}

function upSave(modelId,btn){
  var card=document.querySelector('.upcard[data-model="'+modelId+'"]');
  if(!card){ return; }
  var get=function(f){ var el=card.querySelector('[data-up="'+f+'"]'); return el?el.value:""; };
  var cfg={
    upstreams:splitList(get("upstreams")),
    exclude:splitList(get("exclude")),
    pinMode:get("pinMode"),
    redirect:get("redirect").trim(),
    aliases:splitList(get("aliases"))
  };
  if(btn){ btn.disabled=true; flash(btn,"保存中"); }
  fetch("/v1/upstreams?action=save",{method:"POST",headers:authHeaders(),
    body:JSON.stringify({model_id:modelId,config:cfg})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){ toastError("保存失败",o.d,"HTTP "+o.r.status); return; }
      toast("ok","已保存", esc(o.d.message||""));
      loadUpstreams();
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("保存请求失败",e); });
}

/* 探测是异步的：服务端立刻返回 jobId，这里轮询状态。
   探测要打两次上游，同步等会让页面转圈到超时。 */
function upProbe(modelId,btn){
  if(btn){ btn.disabled=true; flash(btn,"探测中"); }
  var note=document.getElementById("probeNote-"+modelId);
  var showNote=function(html){
    if(!note) return;
    note.hidden=false; note.innerHTML=html;
  };
  showNote('<span class="warn">正在探测：先发一次真实请求判定管道，再枚举可用渠道…</span>');

  fetch("/v1/upstreams?action=probe",{method:"POST",headers:authHeaders(),
    body:JSON.stringify({model_id:modelId})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){
        showNote('<span class="bad">探测启动失败：</span>'+esc((o.d.error&&o.d.error.message)||("HTTP "+o.r.status)));
        toastError("探测启动失败",o.d,"HTTP "+o.r.status);
        return;
      }
      if(o.d.shared) showNote('<span class="warn">该模型已有一个探测在进行，共享其结果…</span>');
      pollProbe(o.d.job.id,modelId,note,0);
    })
    .catch(function(e){
      if(btn) btn.disabled=false;
      showNote('<span class="bad">请求异常：</span>'+esc(String(e&&e.message||e)));
    });
}

function pollProbe(jobId,modelId,note,tries){
  // 最多等 ~2 分钟（探测自身超时是 5 分钟，但页面不该无限转）
  if(tries>80){
    if(note){ note.hidden=false; note.innerHTML='<span class="warn">探测仍在后台进行，稍后点「刷新」查看结果。</span>'; }
    return;
  }
  fetch("/v1/upstreams?action=probe_status&jobId="+encodeURIComponent(jobId),{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.ok){
        if(note){ note.hidden=false; note.innerHTML='<span class="warn">'+esc((d.error&&d.error.message)||"探测状态不可读")+'</span>'; }
        return;
      }
      var j=d.job;
      if(j.status==="running"){ setTimeout(function(){ pollProbe(jobId,modelId,note,tries+1); },1500); return; }
      if(j.status==="failed"){
        if(note){ note.hidden=false; note.innerHTML='<span class="bad">探测失败：</span>'+esc(j.error||"未知原因"); }
        return;
      }
      var r2=j.result||{};
      var hasPin=(r2.modelId?true:false);
      var hit=r2.providerMatch?'<span class="ok">✓ 钉住生效</span>':'<span class="warn">（未配钉住，或钉住未生效）</span>';
      if(note){
        note.hidden=false;
        note.innerHTML=
          '<span class="k">管道</span> '+esc(r2.pipeline||"未知")+
          '　<span class="k">实际命中</span> '+esc(r2.provider||"—")+
          '　'+hit+
          '　<span class="k">耗时</span> '+esc(fmtMs(r2.latencyMs))+
          '<br><span class="k">可用渠道（'+((r2.available||[]).length)+'）</span> '+
          ((r2.available||[]).length?esc(r2.available.join(", ")):'<span class="warn">未能枚举</span>')+
          (r2.note?'<br><span class="k">说明</span> '+esc(r2.note):'');
      }
      toast("ok","探测完成","管道 "+esc(r2.pipeline||"未知")+"，可用渠道 "+((r2.available||[]).length)+" 个");
      // 重新拉一次：管道归属与可用清单已写回配置，卡片上的白名单要跟着更新
      loadUpstreams();
    })
    .catch(function(){
      setTimeout(function(){ pollProbe(jobId,modelId,note,tries+1); },2000);
    });
}

function upDelete(modelId,btn){
  if(!confirm("删除这个模型的渠道配置？\\n\\n删除后该模型回到自动模式（由网关自己挑渠道）。冷却记录不受影响。")) return;
  if(btn){ btn.disabled=true; flash(btn,"删除中"); }
  fetch("/v1/upstreams?action=delete",{method:"POST",headers:authHeaders(),
    body:JSON.stringify({model_id:modelId})})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){ toastError("删除失败",o.d,"HTTP "+o.r.status); return; }
      toast("ok","已删除", esc(o.d.message||"")); loadUpstreams();
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("删除请求失败",e); });
}

/* ══ 设置 ══ */
function loadSettings(){
  return fetch("/v1/config",{headers:authHeaders(),cache:"no-store"})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(!o.r.ok||!o.d.ok){
        $("setNote").innerHTML='<span style="color:var(--bad)">读取失败：请先在「接入配置」页填入 API Key</span>';
        return;
      }
      renderSettings(o.d);
    })
    .catch(function(e){
      $("setNote").innerHTML='<span style="color:var(--bad)">请求异常：'+esc(String(e&&e.message||e))+'</span>';
    });
}

function renderSettings(c){
  state.config=c;
  $("setStrategy").value=c.strategy||"round_robin";
  $("setCooldown").value=c.cooldown_minutes||30;
  $("setOverride").value=c.override_prompt||"";

  // 默认模型下拉：选项来自**已启用模型**（服务端 default_model_options）。
  // 不再从 state.models 取——那曾经是"全部免费模型"，现在是已启用列表，
  // 而默认模型只能从已启用里挑（服务端也这么校验）。
  var opts=['<option value="">（跟随列表第一个：'+esc(c.default_model)+'）</option>'];
  var options=c.default_model_options||[];
  options.forEach(function(m){
    var label=(m.name&&m.name!==m.id)?(m.name+" · "+m.id):m.id;
    opts.push('<option value="'+esc(m.id)+'"'+(c.default_model===m.id?" selected":"")+'>'+esc(label)+'</option>');
  });
  // 一个模型都没启用时（回退上游免费清单）说明一句，否则下拉里只有"跟随"会让人困惑
  if(!options.length){
    opts.push('<option value="" disabled>还没有启用任何模型</option>');
  }
  $("setDefaultModel").innerHTML=opts.join("");

  // 请求头：内置值做占位提示，当前的覆盖值填进输入框
  var def=c.default_headers||{}, cur=c.headers||{};
  var keys=Object.keys(def);
  Object.keys(cur).forEach(function(k){ if(keys.indexOf(k)<0) keys.push(k); });
  keys.sort();
  $("hdrGrid").innerHTML=keys.map(function(k){
    return '<div><label title="'+esc(k)+'">'+esc(k)+'</label>'+
      '<input data-hdr="'+esc(k)+'" value="'+esc(cur[k]||"")+'" placeholder="'+esc(def[k]||"")+'">'+
    '</div>';
  }).join("")||'<div class="desc">没有可配置的请求头。</div>';

  $("setNote").textContent="读取于 "+fmtClock(Date.now());
  $("setPersist").innerHTML = c.persisted
    ? '<div class="okbox">设置在本地会自动存盘（<code>~/.ClineFreePool-state.local.json</code>），重启不丢。</div>'
    : '<div class="warnbox">当前运行环境没有可写磁盘（云端部署），改动只对本次实例生效，重启或重新部署后恢复。<br>'+
      '要长期保留：本地运行本服务，或把改动写进部署环境变量。</div>';
}

function saveSettings(btn){
  var hdrs={};
  var inputs=$("hdrGrid").querySelectorAll("input[data-hdr]");
  for(var i=0;i<inputs.length;i++){
    var k=inputs[i].getAttribute("data-hdr"), v=inputs[i].value.trim();
    if(v) hdrs[k]=v;
  }
  var payload={
    strategy:$("setStrategy").value,
    cooldown_minutes:Number($("setCooldown").value),
    default_model:$("setDefaultModel").value,
    override_prompt:$("setOverride").value,
    headers:hdrs,
    // 请求头整体替换：输入框里空着的行就是要删掉的头，合并语义删不掉
    replace_headers:true
  };
  if(btn){ btn.disabled=true; flash(btn,"保存中"); }
  fetch("/v1/config",{method:"POST",headers:authHeaders(),body:JSON.stringify(payload)})
    .then(function(r){ return r.json().then(function(d){ return {r:r,d:d}; }); })
    .then(function(o){
      if(btn) btn.disabled=false;
      if(!o.r.ok||!o.d.ok){ toastError("保存失败",o.d,"HTTP "+o.r.status); return; }
      renderSettings(o.d);
      toast("ok","设置已保存","");
      // 策略/默认模型也会影响健康页展示，顺手刷新
      loadHealth();
    })
    .catch(function(e){ if(btn) btn.disabled=false; toastError("保存请求失败",e); });
}

function resetHeaders(){
  var inputs=$("hdrGrid").querySelectorAll("input[data-hdr]");
  for(var i=0;i<inputs.length;i++) inputs[i].value="";
  $("setNote").textContent="已清空覆盖值（内置默认仍生效），点「保存设置」提交";
}

function renderUsage(){
  var h=state.health||{};
  var u=h.usage;
  if(!u){
    $("uSince").textContent="";
    $("uRatio").innerHTML='<span class="desc">后台还没有返回统计数据。确认服务是最新版（<b>v2.3.0</b> 以上）。</span>';
    $("uTotals").innerHTML="";
    $("uMeter").innerHTML="<i></i>";
    $("uMeterNote").textContent="";
    $("uTrend").innerHTML=""; $("uTrendAxis").innerHTML="";
    $("uModelRows").innerHTML=""; $("uAcctRows").innerHTML="";
    return;
  }

  var t=u.total||{};
  var calls=t.calls||0, reqs=u.client_requests||0;

  $("uSince").textContent = u.since ? ("统计自 "+fmtClock(u.since)+" · "+fmtAgo(u.since)) : "";

  /* ── 签名读数：重试放大 ──
     calls ÷ reqs。1.0 表示每次消息都一次打中；大于 1 说明有空响应重试/切号
     在偷偷烧额度 —— 这正是"按上游调用统计"要暴露的那条信息。

     ⚠️ 三种"不等于 1"的情况含义完全不同，不能共用一句话糊过去，否则就是假话：
       calls > reqs  重试放大（有额度被重试烧掉）
       calls < reqs  有请求压根没打到上游（账号池不可用 / 全部冷却）
       calls = 0     一次上游都没打通，此时说"没有多余开销"是错的 */
  var amp=Number(u.retry_amplification)||0;
  var extra=Math.max(calls-reqs,0);
  var missed=Math.max(reqs-calls,0);
  var ampCls, verdict;
  if(!reqs){
    ampCls="dim";
    verdict="还没有请求。发一条消息后这里会显示上游调用与客户端请求的比例。";
  }else if(!calls){
    ampCls="bad";
    verdict="这 <b>"+reqs+"</b> 条请求都没打到上游（账号池不可用或额度冷却中），所以没有消耗 token。";
  }else if(amp>1.02){
    ampCls = amp<1.5 ? "warn" : "bad";
    verdict="<b>"+extra+"</b> 次是重试烧掉的 —— 客户端只发了 "+reqs+" 条消息，上游却实打实跑了 "+calls+" 次。";
  }else if(missed>0){
    ampCls="warn";
    verdict="有 <b>"+missed+"</b> 条请求没打到上游（账号池不可用或额度冷却），其余都一次打中。";
  }else{
    ampCls="ok";
    verdict="每次请求都一次打中，没有多余开销。";
  }
  // 没有上游调用时，0.00× 会让人误以为"零开销"，显示 — 更诚实
  var ampTxt = calls ? amp.toFixed(2)+"×" : "—";

  // 方格：每次上游调用一格。过多时按比例缩放，并在文案里给出精确数字，
  // 所以缩放不会让人误读（数字永远比图形优先）。
  var MAXCELL=40, shown=Math.min(calls,MAXCELL);
  var useCells=calls?Math.round(shown*(reqs/calls)):0;
  if(useCells>shown) useCells=shown;
  var cellsHtml="";
  for(var i=0;i<shown;i++){
    var extraCell=i>=useCells;
    cellsHtml+='<i class="'+(extraCell?("over "+ampCls):"")+'" style="animation-delay:'+(i*9)+'ms"></i>';
  }
  var cellsWrap = calls
    ? '<span class="cells">'+cellsHtml+'</span>'
    : "";
  var scaleNote = calls>MAXCELL ? '（方格为等比示意，'+calls+' 格已缩放到 '+MAXCELL+' 格）' : "";

  $("uRatio").innerHTML=
    '<span class="num '+ampCls+'">'+ampTxt+'</span>'+
    cellsWrap+
    '<span class="desc">'+verdict+' '+scaleNote+'</span>';

  /* ── 总览 ── */
  var miss=(t.missing||0);
  $("uTotals").innerHTML=[
    cell("输入 token",fmtTok(t.input),"ok"),
    cell("输出 token",fmtTok(t.output),"cn"),
    cell("合计 token",fmtTok(t.total)),
    cell("上游调用",String(calls)),
    cell("客户端请求",String(reqs)),
    cell("平均每次",calls?fmtTok(u.avg_per_call):"—",calls?"":"dim"),
    cell("无用量回报",String(miss),miss?"warn":"dim")
  ].join("");

  /* ── 思考 token 占比：推理模型下这块经常占掉输出的大头，值得单列 ── */
  var rea=t.reasoning||0, out=t.output||0;
  if(out>0&&rea>0){
    var pct=Math.min(100,Math.round(rea/out*100));
    $("uMeter").innerHTML='<i style="width:'+pct+'%"></i>';
    $("uMeterNote").innerHTML='思考 token <b>'+fmtTok(rea)+'</b>，占输出 '+pct+'%（上游按输出计费时这块也算钱）';
  } else {
    $("uMeter").innerHTML='<i style="width:0"></i>';
    $("uMeterNote").textContent = out>0 ? "上游未回报思考 token 明细。" : "";
  }

  /* ── 近 30 天趋势 ── */
  var days=u.days||[];
  var max=0;
  for(var d=0;d<days.length;d++) if((days[d].total||0)>max) max=days[d].total||0;
  if(!max){
    $("uTrend").innerHTML=""; $("uTrendAxis").innerHTML="";
    $("uTrendEmpty").hidden=false;
  } else {
    $("uTrendEmpty").hidden=true;
    var todayKey=days.length?days[days.length-1].day:"";
    var bars="",axis="";
    for(var k2=0;k2<days.length;k2++){
      var dd=days[k2];
      var pctH=Math.max(Math.round((dd.total||0)/max*100),dd.total?2:1);
      var tip='<span class="tip"><b>'+esc(dd.day)+'</b><br><span class="k">合计</span> '+fmtTok(dd.total)+
              '<br><span class="k">入/出</span> '+fmtTok(dd.input)+" / "+fmtTok(dd.output)+
              '<br><span class="k">调用</span> '+dd.calls+'</span>';
      bars+='<div class="col'+(dd.day===todayKey?" today":"")+'">'+tip+
            '<i style="height:'+pctH+'%;animation-delay:'+(k2*11)+'ms"></i></div>';
      // 轴标签只留首/中/末，其余占位不显示（保持列宽对齐）
      var lbl=dd.day.slice(5);
      axis+='<span'+(trendLabelHide(k2,days.length)?' class="hide"':"")+'>'+esc(lbl)+"</span>";
    }
    $("uTrend").innerHTML=bars;
    $("uTrendAxis").innerHTML=axis;
  }

  /* ── 排行：模型 / 账号 ── */
  function rankRows(list,labelFn,emptyId,tblId){
    var tb=$(tblId);
    if(!list||!list.length){ tb.innerHTML=""; $(emptyId).hidden=false; return; }
    $(emptyId).hidden=true;
    var top=list[0].total||1;
    tb.innerHTML=list.map(function(r){
      var w=Math.max(Math.round((r.total||0)/top*100),1);
      return "<tr>"+
        '<td class="name" title="'+esc(r.name)+'">'+labelFn(r)+
          '<span class="mini" style="width:'+w+'%"></span></td>'+
        '<td class="n">'+fmtTok(r.input)+"</td>"+
        '<td class="n">'+fmtTok(r.output)+"</td>"+
        '<td class="n"><b>'+fmtTok(r.total)+"</b></td>"+
      "</tr>";
    }).join("");
  }
  // 模型名可能很长（如 cline-free/deepseek-v4.1-flash），截断显示、title 给全名
  rankRows(u.by_model,function(r){
    var s=String(r.name||""), short=s.length>30?s.slice(0,29)+"…":s;
    return esc(short);
  },"uModelEmpty","uModelRows");
  // 账号：列表里存的是 id 短哈希，配上邮箱更好认；邮箱从 account_details 取
  var acctMap={};
  ((h.account_details)||[]).forEach(function(a){ acctMap[a.id]=a.email||("账号 #"+(a.index+1)); });
  rankRows(u.by_account,function(r){
    var nm=acctMap[r.name]||("ID "+String(r.name).slice(0,6));
    return esc(nm)+' <span class="id">'+esc(String(r.name).slice(0,6))+"</span>";
  },"uAcctEmpty","uAcctRows");

  $("uModelNote").textContent=(u.by_model||[]).length>12?"仅列前 12 项":"";
  $("uAcctNote").textContent=(u.by_account||[]).length>12?"仅列前 12 项":"";

  // 侧栏角标：总量压缩显示，瞥一眼就知道用量级别
  $("cnt-usage").textContent=t.total?fmtTok(t.total):"";
}


/* ══ 对话 ══ */
function renderThread(){
  var box=$("thread");
  if(!state.messages.length){ box.innerHTML='<div class="empty">还没有消息。在下面输入内容开始测试，多轮对话会自动带上上下文。</div>'; return; }
  box.innerHTML=state.messages.map(function(m){
    var cls=m.role==="user"?"me":(m.error?"err":"ai");
    var who=m.role==="user"?"我":(m.error?"!":"AI");
    var rz=m.reasoning?'<details class="rz"><summary>思考过程 · '+m.reasoning.length+' 字</summary><pre>'+esc(m.reasoning)+"</pre></details>":"";
    var st=(m.stats||[]).map(function(s){ return '<span class="'+(s.hi?"hi":s.lo?"lo":"")+'">'+esc(s.t)+"</span>"; }).join("");
    return '<div class="turn '+cls+'"><div class="who">'+who+'</div><div>'+
      '<div class="txt">'+esc(m.content||"")+"</div>"+rz+
      (st?'<div class="stats">'+st+"</div>":"")+"</div></div>";
  }).join("");
  box.scrollTop=box.scrollHeight;
}
function streamBubble(){
  var box=$("thread");
  var e=box.querySelector(".empty"); if(e) e.remove();
  var last=box.lastElementChild;
  if(last&&last.getAttribute("data-live")==="1") return {root:last,txt:last.querySelector(".txt"),rz:last.querySelector("details.rz")};
  var el=document.createElement("div");
  el.className="turn ai"; el.setAttribute("data-live","1");
  el.innerHTML='<div class="who">AI</div><div><div class="txt"></div>'+
    '<details class="rz" hidden><summary>思考过程</summary><pre></pre></details><div class="stats"></div></div>';
  box.appendChild(el);
  return {root:el,txt:el.querySelector(".txt"),rz:el.querySelector("details.rz")};
}
function renderChatStats(usage,ttft,genMs,totalMs,tps,tokens,finish){
  var items=[];
  items.push(["首字节",fmtMs(ttft)]);
  items.push(["生成耗时",fmtMs(genMs)]);
  items.push(["总耗时",fmtMs(totalMs)]);
  if(tps) items.push(["输出速度",fmtNum(tps,1)+" "+(tokens?"tok/s":"字/s")]);
  if(usage) items.push(["输入 token",String(usage.prompt_tokens||0)]);
  if(usage) items.push(["输出 token",String(usage.completion_tokens||0)]);
  if(finish) items.push(["结束原因",finish]);
  // 两列布局下若为奇数项，补一个占位格，避免最后一格露出灰底像缺失数据
  var html=items.map(function(it){ return cell(it[0],it[1],it[0]==="输出速度"||it[0]==="首字节"?"ok":""); }).join("");
  if(items.length%2===1) html+='<div style="background:var(--surface)"></div>';
  $("chatStats").innerHTML=html;
}
function send(){
  if(state.busy) return;
  var text=$("input").value.trim();
  if(!text) return;
  if(!state.key){
    // 与 renderHealth 的常驻提示区分：这条是对"点了发送"的即时回应，会自动消失
    toast("warn","请先填写 API Key","聊天端点需要密钥才能调用，到「接入配置」页填写。",
      {action:{label:"去填写",fn:goConfig}});
    return;
  }
  state.busy=true;
  $("btnSend").disabled=true; $("btnStop").hidden=false;
  $("cmeta").innerHTML='<span class="gen">生成中</span>';
  state.messages.push({role:"user",content:text});
  $("input").value=""; renderThread(); persistMsgs();

  var msgs=[];
  if(state.sys.trim()) msgs.push({role:"system",content:state.sys.trim()});
  for(var i=0;i<state.messages.length;i++){
    if(state.messages[i].error) continue;
    msgs.push({role:state.messages[i].role,content:state.messages[i].content});
  }
  var body={model:state.model,stream:state.stream,messages:msgs};
  var tv=parseFloat(state.temp), pv=parseFloat(state.topp);
  if(!isNaN(tv)) body.temperature=tv;
  if(!isNaN(pv)) body.top_p=pv;
  var reqBody=JSON.stringify(body,null,2);

  var ctrl=new AbortController(); state.abort=ctrl;
  var t0=performance.now(), ttft=null, raw="";
  var content="", reasoning="", usage=null, finish=null, chars=0;
  // 用显式标记判断是否走到"成功聚合"分支：早前用 btnSend.disabled 判断不可靠，
  // 因为该按钮只在最后一个 then 里才恢复，早期分支也会误判为成功。
  var okPath=false;

  fetch("/v1/chat/completions",{method:"POST",headers:authHeaders(),body:JSON.stringify(body),signal:ctrl.signal})
    .then(function(r){
      if(!r.ok){
        return r.text().then(function(et){
          var hint=explain(r.status,et);
          state.messages.push({role:"assistant",content:hint,error:true,stats:[{t:"HTTP "+r.status,lo:true}]});
          renderThread(); persistMsgs();
          $("cmeta").textContent="失败 · "+fmtMs(performance.now()-t0);
          toast("err","请求失败 · HTTP "+r.status, esc(hint));
          addLog({kind:"chat",model:state.model,stream:state.stream,ok:false,status:r.status,totalMs:performance.now()-t0,
            error:"HTTP "+r.status+" "+et.slice(0,400),hint:hint,requestBody:reqBody,responseRaw:et.slice(0,6000)});
        });
      }
      okPath=true;
      if(!state.stream){
        return r.json().then(function(d){
          var mm=(d.choices&&d.choices[0]&&d.choices[0].message)||{};
          content=mm.content||""; reasoning=mm.reasoning||""; usage=d.usage||null;
          finish=d.choices&&d.choices[0]&&d.choices[0].finish_reason;
          chars=content.length; ttft=performance.now()-t0; raw=JSON.stringify(d,null,2);
        });
      }
      var reader=r.body.getReader(), dec=new TextDecoder(), buf="";
      var bub=streamBubble();
      function pump(){
        return reader.read().then(function(s){
          if(s.done) return null;
          if(ttft===null) ttft=performance.now()-t0;
          var chunk=dec.decode(s.value,{stream:true});
          raw+=chunk; buf+=chunk;
          if(bub.root.isConnected){ var tb=$("thread"); tb.scrollTop=tb.scrollHeight; }
          var ix;
          while((ix=buf.indexOf("\\n"))>=0){
            var line=buf.slice(0,ix); buf=buf.slice(ix+1);
            if(line.indexOf("data:")!==0) continue;
            var p=line.slice(5).trim();
            if(!p||p==="[DONE]") continue;
            try{
              var o=JSON.parse(p), c=o.choices&&o.choices[0], dl=(c&&c.delta)||{};
              if(dl.content){ content+=dl.content; chars+=dl.content.length; bub.txt.textContent=content; }
              if(dl.reasoning){
                reasoning+=dl.reasoning;
                bub.rz.hidden=false;
                bub.rz.querySelector("summary").textContent="思考过程 · "+reasoning.length+" 字（生成中）";
                bub.rz.querySelector("pre").textContent=reasoning;
              }
              if(o.usage) usage=o.usage;
              if(c&&c.finish_reason) finish=c.finish_reason;
            }catch(e){}
          }
          return pump();
        });
      }
      return pump().then(function(){ if(bub.root) bub.root.removeAttribute("data-live"); });
    })
    .then(function(){
      if(!okPath) return;   // 失败/异常分支已各自处理，不要重复写入
      var totalMs=performance.now()-t0;
      if(!content&&reasoning){ content=reasoning; reasoning=""; }
      var genMs=Math.max(totalMs-(ttft||0),1);
      var tokens=usage?usage.completion_tokens:null;
      var tps=tokens? tokens/(genMs/1000) : (chars? chars/(genMs/1000) : null);
      var stats=[];
      if(finish) stats.push({t:"finish="+finish});
      if(usage) stats.push({t:(usage.prompt_tokens||0)+"→"+(usage.completion_tokens||0)+" token"});
      stats.push({t:"首字节 "+fmtMs(ttft),hi:true});
      stats.push({t:"生成 "+fmtMs(genMs)});
      if(tps) stats.push({t:"≈"+fmtNum(tps,1)+(tokens?" tok/s":" 字/s"),hi:true});
      stats.push({t:"总计 "+fmtMs(totalMs)});
      state.messages.push({role:"assistant",content:content||"(空响应)",reasoning:reasoning,stats:stats});
      renderThread(); persistMsgs();
      $("cmeta").textContent="完成 · "+fmtMs(ttft)+" / "+fmtMs(totalMs);
      renderChatStats(usage,ttft,genMs,totalMs,tps,tokens,finish);
      addLog({kind:"chat",model:state.model,stream:state.stream,ok:true,status:200,ttft:ttft,totalMs:totalMs,genMs:genMs,
        promptTokens:usage?usage.prompt_tokens:null,completionTokens:usage?usage.completion_tokens:null,
        reasoningTokens:usage&&usage.completion_tokens_details?usage.completion_tokens_details.reasoning_tokens:null,
        totalTokens:usage?usage.total_tokens:null,chars:chars,reasonChars:reasoning.length,tps:tps,tpsBasis:tokens?"token":"chars",
        finishReason:finish,turns:msgs.length,requestBody:reqBody,responseRaw:raw.slice(0,20000)});
    })
    .catch(function(e){
      var stopped=String(e&&e.name)==="AbortError";
      var msg=String(e&&e.message||e);
      state.messages.push({role:"assistant",content:stopped?(content||"(已停止)"):("请求异常："+msg),
        reasoning:reasoning,error:!stopped,stats:[{t:stopped?"已手动停止":"异常",lo:true},{t:"已接收 "+chars+" 字"}]});
      renderThread(); persistMsgs();
      $("cmeta").textContent=stopped?"已停止":"异常";
      if(!stopped){
        // 流式中断和"发不出去"是两回事：前者服务在跑，后者通常是服务没起来
        var hint = ttft
          ? "连接在生成过程中中断，已收到的内容仍保留在对话里。"
          : diagHint();
        toastError("请求异常", e, hint);
      }
      addLog({kind:"chat",model:state.model,stream:state.stream,ok:false,status:null,ttft:ttft,totalMs:performance.now()-t0,chars:chars,stopped:stopped,
        error:stopped?null:msg,hint:stopped?"你手动停止了生成，已收到的内容仍保留。":"请求异常，确认服务是否在运行。",
        requestBody:reqBody,responseRaw:raw.slice(0,6000)});
    })
    .then(function(){
      state.busy=false; state.abort=null;
      $("btnSend").disabled=false; $("btnStop").hidden=true;
      var live=$("thread").querySelector('[data-live="1"]');
      if(live) live.removeAttribute("data-live");
    });
}
function stopGen(){
  if(state.abort){ try{state.abort.abort();}catch(e){} }
  state.testing=false;
}
function persistMsgs(){
  save(LS.msgs,state.messages.slice(-40).map(function(m){
    return {role:m.role,content:m.content,reasoning:m.reasoning||"",stats:m.stats||[],error:!!m.error};
  }));
}
function exportThread(){
  if(!state.messages.length) return;
  var md="# ClineFreePool 对话记录\\n\\n模型："+state.model+"\\n\\n";
  state.messages.forEach(function(m){
    md+="## "+(m.role==="user"?"用户":"助手")+"\\n\\n"+(m.content||"")+"\\n\\n";
    if(m.reasoning) md+="> 思考过程："+m.reasoning.replace(/\\n/g," ")+"\\n\\n";
  });
  var holder=$("snip"); if(holder) holder.textContent=md;
  copyText(md,$("btnExport"),holder);
}

/* ══ 代码片段 ══ */
var SNIPS=[{id:"curl",l:"cURL"},{id:"python",l:"Python"},{id:"node",l:"Node"},{id:"anthropic",l:"Anthropic"},{id:"env",l:"环境变量"}];
function snipText(id){
  var base=baseUrl(), key=state.key||"你的API_KEY", model=state.model||"模型ID";
  var ua="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  if(id==="curl"){
    return "curl "+base+"/chat/completions \\\\\\n"+
      '  -H "Authorization: Bearer '+key+'" \\\\\\n'+
      '  -H "Content-Type: application/json" \\\\\\n'+
      '  -H "User-Agent: '+ua+'" \\\\\\n'+
      "  -d '{\\n"+'    "model": "'+model+'",\\n'+'    "messages": [{"role": "user", "content": "你好"}],\\n'+'    "stream": true\\n'+"  }'";
  }
  if(id==="python"){
    return "from openai import OpenAI\\n\\nclient = OpenAI(\\n"+'    base_url="'+base+'",\\n'+'    api_key="'+key+'",\\n'+")\\n\\n"+
      "resp = client.chat.completions.create(\\n"+'    model="'+model+'",\\n'+'    messages=[{"role": "user", "content": "你好"}],\\n'+")\\n"+
      "print(resp.choices[0].message.content)\\n\\n# 流式\\n"+
      "stream = client.chat.completions.create(\\n"+'    model="'+model+'",\\n'+'    messages=[{"role": "user", "content": "你好"}],\\n'+"    stream=True,\\n)\\n"+
      "for chunk in stream:\\n    d = chunk.choices[0].delta.content\\n    if d:\\n"+'        print(d, end="", flush=True)';
  }
  if(id==="node"){
    return 'import OpenAI from "openai";\\n\\nconst client = new OpenAI({\\n  baseURL: "'+base+'",\\n  apiKey: "'+key+'",\\n});\\n\\n'+
      "const stream = await client.chat.completions.create({\\n"+'  model: "'+model+'",\\n  messages: [{ role: "user", content: "你好" }],\\n  stream: true,\\n});\\n\\n'+
      "for await (const chunk of stream) {\\n"+'  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");\\n}';
  }
  if(id==="anthropic"){
    return "from anthropic import Anthropic\\n\\n# 本服务同时实现 Anthropic 协议：/v1/messages\\nclient = Anthropic(\\n"+
      '    base_url="'+base+'",\\n    api_key="'+key+'",\\n)\\n\\nmsg = client.messages.create(\\n'+
      '    model="'+model+'",\\n    max_tokens=1024,\\n    messages=[{"role": "user", "content": "你好"}],\\n)\\nprint(msg.content[0].text)';
  }
  return "# 通用 OpenAI 兼容变量，多数工具与 SDK 都认\\nOPENAI_BASE_URL="+base+"\\nOPENAI_API_KEY="+key+
    "\\n\\n# 部分工具用这个名字\\nOPENAI_API_BASE="+base+"\\n\\n# Anthropic 兼容客户端\\nANTHROPIC_BASE_URL="+base+"\\nANTHROPIC_API_KEY="+key;
}
function renderSnip(){
  $("snipTabs").innerHTML=SNIPS.map(function(s){
    return '<button class="'+(s.id===state.snip?"on":"")+'" data-snip="'+s.id+'">'+esc(s.l)+"</button>";
  }).join("");
  $("snip").textContent=snipText(state.snip);
  $("snipNote").textContent=state.key?"":"填入 API Key 后会自动更新";
  $("baseurl").value=baseUrl();
  $("curmodel").value=state.model||"";
}

/* ══ 日志（固定窗口 + 滚动） ══ */
function addLog(e){
  e.id="l"+Date.now()+Math.random().toString(36).slice(2,7);
  e.ts=Date.now(); e.time=fmtClock(e.ts);
  state.logs.unshift(e);
  if(state.logs.length>60) state.logs.length=60;
  save(LS.logs,state.logs.slice(0,30));
  renderLogs();
}
function logMatches(e){
  if(state.filter==="ok"&&!e.ok) return false;
  if(state.filter==="fail"&&e.ok) return false;
  if(state.filter==="slow"&&!((e.ttft&&e.ttft>8000)||(e.totalMs&&e.totalMs>20000))) return false;
  if(state.search&&String(e.model||"").toLowerCase().indexOf(state.search)<0) return false;
  return true;
}
function renderLogs(){
  var okN=0,failN=0,slowN=0;
  for(var i=0;i<state.logs.length;i++){
    var e=state.logs[i];
    if(e.ok) okN++; else failN++;
    if((e.ttft&&e.ttft>8000)||(e.totalMs&&e.totalMs>20000)) slowN++;
  }
  $("cAll").textContent=String(state.logs.length);
  $("cOk").textContent=String(okN);
  $("cFail").textContent=String(failN);
  $("cSlow").textContent=String(slowN);
  $("cnt-log").textContent=state.logs.length?String(state.logs.length):"";
  $("logNote").textContent="最近 "+state.logs.length+" 条";

  var list=state.logs.filter(logMatches);
  var win=$("logwin");
  if(!list.length){
    win.innerHTML='<div class="empty">'+(state.logs.length?"没有符合筛选的条目。":"还没有请求记录。去「对话测试」或「模型」页发一次请求就会出现在这里。")+"</div>";
    renderLogDetail();
    return;
  }
  win.innerHTML=list.map(function(e){
    var st=e.ok?'<span class="st ok">成功</span>':(e.stopped?'<span class="st stop">已停止</span>':'<span class="st bad">失败'+(e.status?" "+e.status:"")+"</span>");
    var sp=typeof e.tps==="number"&&isFinite(e.tps)&&e.tps>0?fmtNum(e.tps,1):"-";
    return '<div class="ln'+(e.id===state.selId?" sel":"")+'" data-log="'+e.id+'">'+
      '<span class="t">'+esc(e.time)+'</span>'+
      '<span class="md" title="'+esc(e.model)+'">'+esc(e.model||"-")+"</span>"+
      st+
      '<span class="n opt">'+(e.ttft?fmtMs(e.ttft):"-")+"</span>"+
      '<span class="n opt'+(sp!=="-"?" hi":"")+'">'+esc(sp)+"</span>"+
      '<span class="n">'+(e.totalMs?fmtMs(e.totalMs):"-")+"</span>"+
    "</div>";
  }).join("");
  renderLogDetail();
  if(state.follow) win.scrollTop=0;   // 最新的在最上面
}
function renderLogDetail(){
  var d=$("logDetail");
  if(!state.selId){ d.innerHTML='<div class="empty">点击左侧任意一行查看完整指标与原始报文。</div>'; return; }
  var e=null;
  for(var i=0;i<state.logs.length;i++) if(state.logs[i].id===state.selId){ e=state.logs[i]; break; }
  if(!e){ d.innerHTML='<div class="empty">该条目已被清理。</div>'; return; }
  d.innerHTML=entryBody(e);
}
function entryBody(e){
  var ms=[];
  function add(k,v){ if(v!==null&&v!==undefined&&v!=="-") ms.push('<div><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+"</div></div>"); }
  add("类型",e.kind==="test"?"模型测速":e.kind==="chat"?"对话":e.kind);
  add("模式",e.stream?"流式":"非流式");
  add("状态",e.ok?"成功":(e.stopped?"已停止":"失败")+(e.status?" "+e.status:""));
  add("首字节",e.ttft?fmtMs(e.ttft):null);
  add("生成耗时",e.genMs?fmtMs(e.genMs):null);
  add("总耗时",e.totalMs?fmtMs(e.totalMs):null);
  add("输出速度",typeof e.tps==="number"&&e.tps>0?fmtNum(e.tps,1)+" "+(e.tpsBasis==="token"?"tok/s":"字/s"):null);
  add("输入 token",e.promptTokens); add("输出 token",e.completionTokens);
  add("思考 token",e.reasoningTokens); add("token 合计",e.totalTokens);
  add("输出字符",e.chars); add("结束原因",e.finishReason); add("时间",e.time);
  var h='<div class="metrics">'+ms.join("")+"</div>";
  if(e.note) h+='<div style="font-size:10.5px;color:var(--ink-3)">'+esc(e.note)+"</div>";
  if(e.error) h+='<div class="err"><b>错误：</b>'+esc(e.error)+"</div>";
  if(e.hint) h+='<div class="hint"><b>建议：</b>'+esc(e.hint)+"</div>";
  if(e.requestBody) h+='<div><h4>请求体<span class="grow"></span><button class="xs ghost" data-copytxt="'+e.id+'|req">复制</button></h4><pre>'+esc(e.requestBody)+"</pre></div>";
  if(e.responseRaw) h+='<div><h4>原始响应'+(e.responseRaw.length>=20000?"（截断）":"")+'<span class="grow"></span><button class="xs ghost" data-copytxt="'+e.id+'|res">复制</button></h4><pre>'+esc(e.responseRaw)+"</pre></div>";
  return h;
}
function exportLogs(){
  var list=state.logs.filter(logMatches).map(function(e){
    return {time:new Date(e.ts).toISOString(),kind:e.kind,model:e.model,stream:!!e.stream,ok:!!e.ok,status:e.status||null,stopped:!!e.stopped,
      ttft_ms:e.ttft||null,gen_ms:e.genMs||null,total_ms:e.totalMs||null,
      tps:typeof e.tps==="number"?Number(e.tps.toFixed(2)):null,tps_basis:e.tpsBasis||null,
      prompt_tokens:e.promptTokens||null,completion_tokens:e.completionTokens||null,total_tokens:e.totalTokens||null,
      chars:e.chars||null,finish_reason:e.finishReason||null,error:e.error||null};
  });
  var txt=JSON.stringify(list,null,2);
  var holder=$("snip"); if(holder) holder.textContent=txt;
  copyText(txt,$("btnExportLogs"),holder);
}

/* ══ 主题 ══ */
function applyTheme(t){
  document.documentElement.setAttribute("data-theme",t);
  save(LS.theme,t);
}
function cycleTheme(){
  var cur=document.documentElement.getAttribute("data-theme")||"dark";
  applyTheme(cur==="dark"?"light":"dark");
}

/* ══ 事件绑定 ══ */
$("nav").addEventListener("click",function(e){
  var a=e.target.closest&&e.target.closest("a[data-v]");
  if(a) showTab(a.getAttribute("data-v"));
});
$("btnTheme").addEventListener("click",cycleTheme);
$("btnRefresh").addEventListener("click",function(){ loadHealth(); loadModels(); });
$("snipTabs").addEventListener("click",function(e){
  var b=e.target.closest&&e.target.closest("button[data-snip]");
  if(b){ state.snip=b.getAttribute("data-snip"); renderSnip(); }
});
document.addEventListener("click",function(e){
  var el=e.target.closest?e.target.closest("[data-copy],[data-copyid],[data-copytxt]"):null;
  if(!el) return;
  var id=el.getAttribute("data-copy");
  if(id){ var f=$(id); copyText(f?f.value:"",el,f); return; }
  var cid=el.getAttribute("data-copyid");
  if(cid){ copyText(cid,el); return; }
  var ct=el.getAttribute("data-copytxt");
  if(ct){
    var parts=ct.split("|"),en=null;
    for(var i=0;i<state.logs.length;i++) if(state.logs[i].id===parts[0]){ en=state.logs[i]; break; }
    if(en){
      var t=parts[1]==="req"?en.requestBody:en.responseRaw;
      var pre=el.closest("div").querySelector("pre");
      copyText(t||"",el,pre);
    }
  }
});
$("logwin").addEventListener("click",function(e){
  var ln=e.target.closest&&e.target.closest("[data-log]");
  if(!ln) return;
  state.selId=ln.getAttribute("data-log");
  save(LS.sel,state.selId);
  var all=$("logwin").querySelectorAll(".ln");
  for(var i=0;i<all.length;i++) all[i].classList.toggle("sel",all[i]===ln);
  renderLogDetail();
});
$("btnFollow").addEventListener("click",function(){
  state.follow=!state.follow;
  save(LS.follow,state.follow);
  $("btnFollow").textContent="跟随最新："+(state.follow?"开":"关");
  $("btnFollow").classList.toggle("on",state.follow);
});
$("lfilter").addEventListener("input",function(){ state.search=this.value.trim().toLowerCase(); renderLogs(); });
document.querySelectorAll(".chip").forEach(function(c){
  c.addEventListener("click",function(){
    state.filter=c.getAttribute("data-f");
    save(LS.filter,state.filter);
    document.querySelectorAll(".chip").forEach(function(x){ x.classList.toggle("on",x===c); });
    renderLogs();
  });
});
$("btnClearLogs").addEventListener("click",function(){ state.logs=[]; state.selId=null; save(LS.logs,[]); renderLogs(); });
$("btnExportLogs").addEventListener("click",exportLogs);
/* 模型库：一个委托处理三种卡片上的动作（推荐分组 / 全部模型 / 已启用三处共用）。
   卡片会整块重绘，所以只能走事件委托，不能逐个绑定。 */
document.addEventListener("click",function(e){
  var t=e.target.closest&&e.target.closest("button[data-add]");
  if(t){ addModelIds([t.getAttribute("data-add")],"已添加"); return; }
  var g=e.target.closest&&e.target.closest("button[data-addgroup]");
  if(g){
    var key=g.getAttribute("data-addgroup");
    var groups=(state.mLibGroups||[]).concat(state.mCatalog||[]);
    var hit=null;
    for(var i=0;i<groups.length;i++) if(groups[i].key===key){ hit=groups[i]; break; }
    if(!hit){ toast("warn","找不到该分组","请点「刷新数据」后重试。"); return; }
    addModelIds(hit.models.map(function(m){ return m.id; }),"已添加整组");
    return;
  }
  var c=e.target.closest&&e.target.closest("button[data-check]");
  if(c){ checkModel(c.getAttribute("data-check"),c); return; }
  var rm=e.target.closest&&e.target.closest("button[data-rm]");
  if(rm){ removeModel(rm.getAttribute("data-rm"),rm); return; }
  var sd=e.target.closest&&e.target.closest("button[data-setdefault]");
  if(sd){ setDefaultModel(sd.getAttribute("data-setdefault"),sd); return; }
  var cp=e.target.closest&&e.target.closest("button[data-copyid]");
  if(cp){ copyText(cp.getAttribute("data-copyid"),cp); return; }
});
/* 全部模型的搜索：只过滤本地已有数据，不发请求。
   绑 input（覆盖键盘与粘贴）与 search（type=search 自带的清除按钮不一定触发 input），
   外加 Esc 清空。 */
(function(){
  var el=$("mCatSearch");
  el.addEventListener("input",function(){ renderModelCatalog(); });
  el.addEventListener("search",function(){ renderModelCatalog(); });
  el.addEventListener("keydown",function(e){
    if(e.key==="Escape"){ el.value=""; renderModelCatalog(); }
  });
})();
// 全部模型折叠块：展开时才抓（上游 440+ 条、约 500 KB，没必要在页面加载时一起拉）
$("mCatalogFold").addEventListener("toggle",function(){
  if(!this.open) return;
  if(state.mCatLoaded){ renderModelCatalog(); return; }
  loadModelCatalog(false);
});
$("mRefreshBtn").addEventListener("click",function(){
  loadModelLibrary(true);
  if(state.mCatLoaded) loadModelCatalog(true);
});
$("mDescBtn").addEventListener("click",function(){
  var on=document.body.classList.toggle("show-mdesc");
  this.textContent=on?"隐藏描述":"显示描述";
});
$("btnRefreshAcct").addEventListener("click",function(){ loadHealth(); });
$("btnLogin").addEventListener("click",startLogin);

/* 账号卡片上的动作按钮与批量按钮：统一走事件委托，
   这样 renderAccts 重绘多少次都不用重新绑定。 */
function onAcctBarClick(e){
  // 详情/余额按钮不带 data-act（它们不发账号动作请求），单独处理
  var db=e.target.closest&&e.target.closest("button[data-detail]");
  if(db){ openAcctDetail(db.getAttribute("data-detail")); return; }
  var bb=e.target.closest&&e.target.closest("button[data-balance]");
  if(bb){
    // 余额也走弹窗：这样「查不到原因」的提示能一起显示，而不是只弹个 toast
    openAcctDetail(bb.getAttribute("data-balance"));
    setTimeout(function(){ var b=$("btnBal"); if(b) b.click(); }, 400);
    return;
  }
  var cb=e.target.closest&&e.target.closest("button[data-clear]");
  if(cb){
    accountAction("clearCooldown",cb.getAttribute("data-clear"),cb,cb.getAttribute("data-model"));
    return;
  }
  var b=e.target.closest&&e.target.closest("button[data-act]");
  if(!b) return;
  var act=b.getAttribute("data-act"), id=b.getAttribute("data-id")||"";
  // 破坏性动作先确认：移除账号无法撤销（停用可以随时启用，不必打扰）
  if(act==="remove"&&!confirm("移除这个账号？\\n\\n移除后需要重新登录才能恢复。")) return;
  accountAction(act,id,b);
}
$("accts").addEventListener("click",onAcctBarClick);
// 详情弹窗里的「解除冷却」也走同一套动作
document.addEventListener("click",function(e){
  var cb=e.target.closest&&e.target.closest("button[data-clear]");
  if(!cb) return;
  if($("accts").contains(cb)) return;   // 卡片上的已由上面的委托处理
  accountAction("clearCooldown",cb.getAttribute("data-clear"),cb,cb.getAttribute("data-model"));
});
$("btnEnableAll").addEventListener("click",function(){ accountAction("enableAll","",this); });
$("btnResetAll").addEventListener("click",function(){ accountAction("resetAll","",this); });

/* 上游渠道面板与设置页的事件委托（面板会整体重绘，不能逐个绑定） */
document.addEventListener("click",function(e){
  var t=e.target.closest&&e.target.closest(
    "button[data-upsave], button[data-updel], button[data-upprobe]");
  if(!t) return;
  if(t.hasAttribute("data-upsave")) return upSave(t.getAttribute("data-upsave"),t);
  if(t.hasAttribute("data-updel")) return upDelete(t.getAttribute("data-updel"),t);
  upProbe(t.getAttribute("data-upprobe"),t);
});
$("btnUpAdd").addEventListener("click",function(){
  var id=$("upModel").value.trim();
  if(!id){ toast("warn","请先选择模型","从下拉里挑一个模型 ID，或直接粘贴。"); return; }
  // 直接建一条空配置（服务端对空配置视为「无有效内容」而删除，所以先给个占位渠道）
  // —— 这里改为：建一条只有 pinMode 的配置，让用户填完再保存。
  fetch("/v1/upstreams?action=save",{method:"POST",headers:authHeaders(),
    body:JSON.stringify({model_id:id,config:{pinMode:"strict",upstreams:[]}})})
    .then(function(r){ return r.json(); })
    .then(function(d){
      if(!d.ok){ toastError("添加失败",d); return; }
      $("upModel").value="";
      // 空配置会被服务端判为无效而删除，此时提示用户先填渠道
      if(!d.config){ toast("warn","已就绪","该模型还没有有效配置，填好钉住的渠道后点「保存」。"); }
      loadUpstreams().then(function(){
        var el=document.querySelector('.upcard[data-model="'+id+'"] input[data-up="upstreams"]');
        if(el) el.focus();
      });
    })
    .catch(function(err){ toastError("添加请求失败",err); });
});
$("btnUpReload").addEventListener("click",loadUpstreams);
$("btnSetSave").addEventListener("click",function(){ saveSettings(this); });
$("btnSetReload").addEventListener("click",function(){ loadSettings(); });
$("btnHdrReset").addEventListener("click",resetHeaders);
$("btnLoginCancel").addEventListener("click",cancelLogin);
$("btnSend").addEventListener("click",send);
$("btnStop").addEventListener("click",stopGen);
$("input").addEventListener("keydown",function(e){
  if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); }
});
$("btnClearMsgs").addEventListener("click",function(){ if(!state.messages.length) return; state.messages=[]; $("chatStats").innerHTML=""; renderThread(); persistMsgs(); });
$("btnExport").addEventListener("click",exportThread);
$("btnCopySnip").addEventListener("click",function(){ copyText(snipText(state.snip),$("btnCopySnip"),$("snip")); });
$("model").addEventListener("change",function(){ state.model=this.value; save(LS.model,state.model); renderSnip(); });
$("stream").addEventListener("change",function(){ state.stream=this.checked; saveParams(); });
$("temp").addEventListener("input",function(){ state.temp=this.value; saveParams(); });
$("topp").addEventListener("input",function(){ state.topp=this.value; saveParams(); });
$("sys").addEventListener("input",function(){ state.sys=this.value; saveParams(); });
function saveParams(){ save(LS.params,{stream:state.stream,temp:state.temp,topp:state.topp,sys:state.sys}); }
$("key").addEventListener("input",function(){
  state.key=this.value.trim(); save(LS.key,state.key); renderSnip();
  if(state.health&&state.health.api_key_configured) renderHealth(state.health);
});
window.addEventListener("beforeunload",function(){ clearTimeout(state.loginTimer); });

/* ══ 启动 ══ */
(function boot(){
  var injected="";
  try{ injected=(window.__CLINE2API__&&window.__CLINE2API__.key)||""; }catch(e){}
  state.key=injected||load(LS.key,"")||"";
  state.model=load(LS.model,"");
  var p=load(LS.params,null);
  if(p&&typeof p==="object"){
    if("stream" in p) state.stream=!!p.stream;
    state.temp=p.temp||""; state.topp=p.topp||""; state.sys=p.sys||"";
  }
  var msgs=load(LS.msgs,[]); if(Array.isArray(msgs)) state.messages=msgs;
  var logs=load(LS.logs,[]); if(Array.isArray(logs)) state.logs=logs;
  state.filter=load(LS.filter,"all")||"all";
  state.selId=load(LS.sel,null);
  var f=load(LS.follow,true); state.follow=(f===false||f==="false")?false:true;
  var srt=load(LS.sort,null);
  if(srt&&srt.key){ state.sort=srt.key; state.sortDir=srt.dir; }

  applyTheme(load(LS.theme,"dark")||"dark");
  $("key").value=state.key;
  $("stream").checked=state.stream;
  $("temp").value=state.temp; $("topp").value=state.topp; $("sys").value=state.sys;
  $("btnFollow").textContent="跟随最新："+(state.follow?"开":"关");
  $("btnFollow").classList.toggle("on",state.follow);
  // 恢复「只看免费」的勾选状态（默认开）。
  // 正常情况下服务端已只返回免费模型，这个筛选几乎不减少条数；保留它是因为
  // 上游拉取失败时会回退到内置列表（含 cline-pass 等非免费项），那时它才有区分作用。
  var fo=load(LS.freeOnly,true);
  $("mfree").checked = !(fo===false||fo==="false");
  document.querySelectorAll(".chip").forEach(function(x){ x.classList.toggle("on",x.getAttribute("data-f")===state.filter); });
  if(state.sort!=="region"){
    var th=document.querySelector('table.m th[data-s="'+state.sort+'"]');
    if(th){ var ar=document.createElement("span"); ar.className="ar"; ar.textContent=state.sortDir>0?"↑":"↓"; th.appendChild(ar); }
  }
  showTab(load(LS.tab,"chat")||"chat");
  renderThread(); renderSnip(); renderLogs(); renderChatStats(null,null,null,null,null,null,null);
  loadHealth();
  loadModels();
  setInterval(loadHealth,30000);
})();
</script>
</body>
</html>
`;
// #endregion console-html

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders },
  });
}

// 统一把内部异常转成对客户端有意义的响应
// 重点：所有账号都在冷却（额度用尽）时返回 429 + Retry-After，
//       而不是 500 —— 这是"等一会儿再来"的语义，客户端/网关可据此退避。
function errorResponse(e) {
  if (e && e.message === "all_accounts_cooling") {
    const secs = Math.ceil((e.retryAfterMs || 0) / 1000);
    const mins = Math.floor(secs / 60);
    const human = mins >= 60
      ? `${Math.floor(mins / 60)}h ${mins % 60}m`
      : mins >= 1 ? `${mins}m` : `${secs}s`;
    // 冷却已经是「账号×模型」级：说清是**哪个模型**没额度，比只说"所有账号"
    // 有用得多——用户换个模型可能就能继续用。
    const kindText = {
      free_daily: "免费日额度已用尽", pass_limit: "订阅额度已用尽",
      spend_limit: "已达花费上限", empty: "上游持续返回空响应",
    };
    const kinds = [...new Set((e.kinds || []).filter((k) => k && k !== "unknown"))]
      .map((k) => kindText[k] || k);
    const why = kinds.length ? "（" + kinds.join("、") + "）" : "";
    return jsonResponse({
      error: {
        message: `${e.accountCount} 个账号的「${e.modelId || "该模型"}」额度均在冷却中${why}，约 ${human} 后恢复。` +
                 `\n可以：等冷却结束、改用其它模型，或在「账号」页追加更多账号。`,
        type: "rate_limit_error",
        reason: "all_accounts_cooling",
        model: e.modelId || null,
        retry_after_seconds: secs,
      },
    }, 429, { "Retry-After": String(secs) });
  }
  if (e && e.message === "all_accounts_disabled") {
    return jsonResponse({
      error: {
        message: `账号池里的 ${e.accountCount} 个账号全部处于「停用」状态，没有账号可用来处理请求。` +
                 `请在控制台「账号」页启用至少一个账号。`,
        type: "rate_limit_error",
        reason: "all_accounts_disabled",
      },
    }, 429);
  }
  if (e && e.message === "all_accounts_refresh_failed") {
    // 全部账号的 token 刷新都失败：这是最需要明确指引的一种故障——
    // 常见成因是 refreshToken 被上游轮换/作废，而用户看到的只是「请求失败」。
    return jsonResponse({
      error: {
        message: `账号池里 ${e.accountCount} 个账号的 token 刷新全部失败` +
                 (e.detail ? `（最后一次：${e.detail}）` : "") + "。\n" +
                 (e.permanentHint || "可能是网络抖动，稍后重试；若持续失败请在控制台「账号」页重新登录。"),
        type: "account_error",
        reason: "all_accounts_refresh_failed",
      },
    }, 502);
  }
  if (e && e.message === "缺少 CLINE_REFRESH_TOKEN 环境变量") {
    return jsonResponse({
      error: {
        message: "服务端未配置 CLINE_REFRESH_TOKEN。请运行 python cline_oauth.py 获取 refreshToken，"
               + "再配置为环境变量（wrangler secret put / vercel env add），保存后重新部署。",
        type: "config_error",
        reason: "missing_refresh_token",
      },
    }, 500);
  }
  // 客户端主动断开：不必回响应（对方已经不在了），但也不该记成 500
  if (e && (e.name === "AbortError" || String(e.message || "").includes("client_aborted"))) {
    return jsonResponse({
      error: { message: "客户端已断开请求", type: "cancelled" },
    }, 499);
  }
  return jsonResponse({ error: { message: (e && e.message) || String(e), type: "api_error" } }, 500);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  };
}

