# AGENTS.md — 给 AI 助手的部署指令

> 你正在读这个文件，说明你被用户要求「把这个项目部署起来」。
> 按下面的顺序做，不要跳步，也不要问用户已经能从文件里读到的信息。

## 这是什么

ClineFreePool：把 Cline 的**免费模型**转成 OpenAI / Anthropic 兼容 API。
多账号池自动切号，自带中文控制台。

**零依赖**：没有 `package.json`，不需要 `npm install`，只用 Node 内置模块。

## 部署步骤（本地）

### 1. 检查 Node 版本（唯一的硬前置）

```bash
node -v
```

**必须 ≥ 22。** 本项目用 ESM 写法但没有 `package.json`，靠 Node 22+ 的语法自动探测
识别模块。低于 22 会报 `Cannot use import statement outside a module`。

如果没装或版本太低，装LTS 版：https://nodejs.org/

### 2. 启动

```bash
node start.mjs
```

这是**唯一应该用的启动命令**，它会自动做三件事：检查 Node 版本、
按需创建 `.env.local`、拉起服务。

按系统也可以用：`start.bat`（Windows 双击）、`start.sh`（macOS/Linux）。

> ⚠️ macOS/Linux 上如果报 `Permission denied`，用 `bash start.sh` 或先 `chmod +x start.sh`。
> 仓库里 `start.sh` 的 git 权限位是 100644（无执行位），这是已知情况。

### 3. 换端口（仅当 8787 被占用）

启动脚本**不会**自动换端口。8787 经常被别的服务占着（macOS 上 php 进程就常占）。

```bash
PORT=8790 node start.mjs
```

端口只认**环境变量**，写进 `.env.local` 无效。

### 4. 验证

```bash
curl -s http://127.0.0.1:8787/v1/health
```

应返回 `{"ok":true,...}`。若返回 502或连不上，看终端里的报错。

**成功标准**：`ok=true`。

### 5. 告诉用户怎么用

服务只绑`127.0.0.1`（仅本机）。让用户浏览器打开 `http://localhost:8787`，
进「账号」页登录 Cline 账号 —— **登录后才能真正发请求**。

接入信息（base_url / api_key）在控制台「接入配置」页可以一键复制。

## 登录账号（重要）

登录有两条路，**优先用控制台**（更简单，且本地会自动落盘重启不丢）：

1. 控制台「账号」页 → 「登录新账号」→ 浏览器打开给的授权链接 → 登录授权
2. 或命令行 `python3 cline_oauth.py`（会把 token 写进 `.env.local`，永久生效）

登录后控制台会显示 refreshToken。

> 多账号请在控制台里**逐个登录**。`.env.local` 解析器逐行读 `key=value`，
> 只支持**一个** `CLINE_REFRESH_TOKEN`，写多行会被丢弃。

## 不要做的事

|❌ 别做 | 为什么 |
|---|---|
| `npm install` | 没有 package.json，装了也没用 |
| 把 `CLINE_REFRESH_TOKEN` 提交到 git | 已在 .gitignore |
| 改 `local-server.js` 里的 host 常量 | 默认绑 127.0.0.1 是刻意的，见下方安全说明 |
| 手动改 `worker.js` 里内联的控制台 HTML | 它由 `console.src.html` 构建生成，会被覆盖 |
| 绑定 `0.0.0.0` 暴露服务 | 见下方 |

## 安全说明（改配置前务必读）

服务默认**只绑 127.0.0.1**，且控制台页面会被注入 `API_KEY`。
改成 `HOST=0.0.0.0` 等于把钥匙连同门送给同网段所有人。
确有需要时再放开，且只在可信网络里用，用完关掉。

## 云端部署

用户明确要云端时才做，细节见 `docs/部署到云端.md`（Cloudflare Workers / Vercel）。
要点：API_KEY 与 CLINE_REFRESH_TOKEN 都必须用平台的**机密变量**设置，不能写进代码。

## 已知限制

- 免费模型清单是**实时取上游**的（促销轮换，会变），不做本地硬编码。
  未登录时 `/v1/models` 返回空，这是正确行为，不是故障。
- 免费额度有上限，用尽返回 429；多账号可缓解。
- 控制台里只展示免费通道，订阅制（clinePass）与云额度（clineCloud）不展示。
- refreshToken 会被上游轮换。控制台登录的会自动落盘；写进 `.env.local` 的
  在上游轮换后失效，需重新获取并更新。

## 排障速查

| 现象 | 原因与处理 |
|---|---|
| `Cannot use import statement outside a module` | Node < 22，升级 |
| 窗口一闪就没了 | 改从命令行运行 `node start.mjs` 看报错 |
| `EADDRINUSE` | 端口被占，换 `PORT=8790 node start.mjs` |
| 页面打不开 | 确认进程还在、地址是 `http://`（不是 https）、试 `/v1/health` |
| 401 `missing_client_key` | 客户端没带 `Authorization: Bearer <API_KEY>` |
| 500 缺少 CLINE_REFRESH_TOKEN | 还没登录，去控制台「账号」页 |
| 429 | 额度用尽，等冷却或加账号 |
| 402 insufficient_credits | 用了付费档模型，换免费通道（`cline-free/` 前缀） |

更多见 `docs/常见问题.md`。

## 品牌与署名（改动时务必保持）

- 项目名：**ClineFreePool**（不是 ClinePool、不是 cline-free）
- 许可：MIT（保留上游致谢，见 LICENSE 与 README）

**以下字符串是 API 契约或协议标识，改名时绝对不能动**：

| 字符串 | 原因 |
|---|---|
| `cline-free/` | 上游模型通道前缀。改成别的会导致所有模型调不通 |
| `CLINE_REFRESH_TOKEN` | 环境变量名，改了用户现有配置立即失效 |
| `X-Cline2api-Version` | HTTP 响应头 |
| `luawei1/cline2api`、`pingmike2/cline2api-workers` | 上游溯源，MIT 归属 |

这是历史上真实踩过的坑：批量替换项目名时误伤了 `cline-free/` 前缀，
导致客户端拿到的模型 ID 全部失效。**改名时先把这些串保护起来再替换。**
