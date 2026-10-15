# Huanyu-CLI 设计文档

日期：2026-10-15
状态：已批准（四段设计经用户逐段确认）
参考实现：`template/oil-cli`（净室分析见会话记录；机制资产直接继承）

## 目标

从 0-1 构建一个 Agent-first 的 skill 商店客户端 `hy`（包名 huanyu-cli）：面向 Huanyu 托管商店（含账号与付费订阅）的安装/更新消费端 + 发布管理端，参考 oil-cli 的思路，机制层照搬其已验证资产，领域层按 Huanyu 的双渠道分发模型重组。

## 用户场景

- **消费者**：`npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>` 一条命令把 skill 装进本机全部 Agent（zcode/Claude/Codex/Cursor/opencode/Trae/千问办公/WorkBuddy 等），一份实体 + 链接共享；`hy update` 一键全量更新。付费 skill 缺权时内联完成 登录→付款→安装。
- **发布者（作者本人）**：从 Huanyu-Skills 仓库（https://github.com/Huanyu-Hibiki/Huanyu-Skills）`hy publish --repo . --all` 批量发布/对账；付费版推商店，免费版双渠道分发（GitHub 仓 + 商店公开附件）。
- **AI Agent**：读 JSON 输出（`--json`）中的 `next_command`/`purchase_url` 续跑长流程；退出码 `3` 触发登录/付款分支。

## 技术方案

**方案 B：机制层照搬 + 领域层重组**（对比过 A 镜像重建 / C 从零自研后选定）。

- Node ≥18、ESM、**零 npm 依赖**、`node:test`，`npx github:` 直跑。
- **机制资产原样继承**（来自 oil-cli 净室分析）：`replaceAll` 多目标事务替换（同盘暂存/两阶段提交/逆序回滚/回滚失败保留备份）；tar.gz 流式预检验证器（ustar/PAX/GNU base-256、拒绝符号/硬链接与路径穿越、Windows 保留名/ADS/大小写碰撞）；目录身份三层（canonical/logical/directoryKey，含 Windows 8.3 与 `\\?\` 归一）；设备码/checkout 可恢复状态机；`wx+fsync+rename` 原子配置写；Output 双通道 + 密钥遮盖；假商店服务器 + 虚拟时钟测试基建。
- **领域层重组三点**：① 宿主表数据化（`src/hosts.js`，9 宿主 zcode 置顶）；② publish 独立管道与命名规范化层；③ 免费版清理规则由商品配对数据驱动（修正 oil 的 `oil-ui-pro` 硬编码）。

### 模块分层

```
bin/hy.js                  入口【继承模式】
src/cli.js                 参数解析 + 命令编排 + ctx 依赖注入【机制继承，命令面扩充】
src/hosts.js               ★重组：宿主表数据化
src/skills.js              发现/识别/版本/冲突【机制继承】
src/install.js             下载校验管道 + 事务替换【机制继承】
src/publish.js             ★新增：发布管道 + 命名规范化 + 对账
src/client.js              传输层 + 响应形状校验【继承，换契约】
src/auth.js / purchase.js / config.js / io.js / i18n.js / platform.js / browser.js
                          【继承，换品牌域 hy_* / HY_*】
test/fixture.js + driver.js  假服务器 + 虚拟时钟【基建平移 + publish 端点 mock】
```

### 品牌域映射

| oil-cli | Huanyu-CLI |
|---|---|
| 命令 `oil` | `hy`（bin: huanyu-cli） |
| `OIL_API`/`OIL_TOKEN`/`OIL_LANG` | `HY_API`/`HY_TOKEN`/`HY_LANG` |
| token 前缀 `oil_` | `hy_`（遮盖兜底正则同步） |
| 配置 `%APPDATA%\oil\config.json` | `%APPDATA%\huanyu\config.json`（POSIX: XDG `huanyu`） |
| `DEFAULT_API = ui.oiloil.org` | 占位常量（服务端另建后定稿） |

### 宿主表（hosts.js，数据驱动；默认只扫用户级目录做自动发现）

| 优先序 | id | 用户级目录 | 项目级目录 | 依据 |
|---|---|---|---|---|
| 1 | zcode | `~/.zcode/skills` | `.zcode/skills` | zcode 官方文档 |
| 2 | agents | `~/.agents/skills` | `.agents/skills` | 同上 |
| 3 | claude | `~/.claude/skills` | `.claude/skills` | oil-cli 已验证 |
| 4 | codex | `~/.codex/skills`（尊重 `CODEX_HOME`） | `.codex/skills` | 同上 |
| 5 | cursor | `~/.cursor/skills` | — | 同上 |
| 6 | opencode | 待实测 | `.opencode/skill` | 实现前验证 |
| 7 | trae | `~/.trae/skills` | `.trae/skills` | Trae 官方文档 |
| 8 | qwenwork | `~/.qwenworkcn/skills` | — | 阿里云官方文档 |
| 9 | workbuddy | `~/.workbuddy/skills` | — | oil-cli 已验证 |

规则：第一个可用目录（zcode 优先）放真实副本，其余 junction/symlink 链接共享；项目级目录不作默认目标；`--to` 可多次指定覆盖。**豆包工作**无本地 skill 目录（技能走客户端 UI/云端），排除出宿主表，记为未来 publish 侧推送渠道。

### 命令面

`status`（默认）`list` `install` `update` `login` `logout` `subscribe` `manage` `help` `version` + 新增 `publish` `product` `unpublish` `audit`。

## 数据模型

```
Product      { id, name, summary, repo?, page?, free: {skill}|null, paid: {skill}|null,
               offer: [plan...], prices: { plan: { amount, currency } } }
SkillRelease versions[name] = { latest, history: [{ version, published_at, notes, yanked? }],
               download_url?, sha256? }        // sha256 对免费版必填
本地 Skill    SKILL.md frontmatter: name（规范名）+ metadata.version（semver）
规范名        ^[a-z0-9][a-z0-9-]*$；安装目录名 = 规范名
```

**命名规范化**（publish 管道内）：frontmatter 有合法 `name` 则以其为准；否则从目录名推导（`PPT-design`→`ppt-design`）。两个本地目录推导出同一规范名 → 拒绝并列出。对账按规范名匹配本地目录 ↔ 商店条目。

**免费版双渠道分发**（参考 oil-ui 仓库模式）：

| 渠道 | 载体 | 作用 |
|---|---|---|
| GitHub 仓 Huanyu-Skills | 源码本体，根目录平铺 skill（兼容 `npx skills add` 与 Agent-URL 安装） | 开源展示 + 生态通用安装 |
| 商店公开附件 | `hy publish` 统一上传 tar.gz，302 公开服务 | hy-cli 安装渠道 + 版本/sha256 完整性权威 + 自动更新数据源 |

分发格式 **tar.gz 单格式**：三平台自带 tar、Node 内置 zlib 流式校验、生态惯例；zip 在 Linux 常缺工具且 Node 无内置支持。

**Skill 内置更新检查约定**（发布文档约定，非 CLI 强制）：SKILL.md 可含版本检查段——使用时查 `HY_API/api/store/versions`（10 分钟节流、超时跳过、静默失败），发现新版提示 Agent 运行 `npx github:Huanyu-Hibiki/Huanyu-CLI update <skill> --path "<安装路径>"`；开关 `HY_NO_AUTO_UPDATE`/`HY_NO_UPDATE_CHECK`。

## 接口设计（API 契约，服务端另建、双方共建依据）

消费端（与 oil-cli 契约同构）：

| 接口 | 方法/鉴权 | 说明 |
|---|---|---|
| `/api/store/catalog` | GET | 商品目录（容错 `{products}`/数组/`{catalog}`） |
| `/api/store/versions` | GET | 版本与历史（含免费版 sha256），公开 |
| `/api/store/download/<name>?version=&format=tar.gz` | 免费：302→公开附件（无令牌）；付费 🔒：200 + `X-Content-SHA256` + `X-Skill-Version` | API 禁止重定向，仅免费发布物 302 允许 follow |
| `/api/cli/device` `/api/cli/token` | POST | OAuth 设备码（`authorization_pending`/`slow_down`/`expired_token`/`access_denied`） |
| `/api/auth/me` | GET 🔒 | `{ email, subscriptions, publisher }` |
| `/api/store/checkout`(+`/status`) | POST/GET 🔒 | `{ id, url, reused, amount, currency, notice? }`；409 `already_active` |
| `/api/account/portal` `/api/cli/logout` | POST 🔒 | 管理入口 / 令牌撤销 |

发布端（新增）：

| 接口 | 方法/鉴权 | 说明 |
|---|---|---|
| `/api/store/publish` | POST 🔒 publisher | 体 = tar.gz 二进制；头 `X-Skill-Name`+`X-Skill-Version`+`X-Content-SHA256`。响应 `{ skill, version, sha256, size, url }`。错误：409 `version_exists`、403 `not_a_publisher`、400 `invalid_package`、413 `too_large` |
| `/api/store/products/<skill>` | PUT 🔒 publisher | 商品元数据（与版本发布解耦） |
| `/api/store/releases/<skill>/<version>` | DELETE 🔒 publisher | 下架（yank；新安装 404，已装不受影响） |
| `/api/store/releases/<skill>/<version>/notes` | PUT 🔒 publisher | 补充/修订更新说明 |

对账无需新接口：CLI 比对本地目录与 `catalog`+`versions`。

### publish 管道（与安装管道对称）

```
读 SKILL.md → 规范名映射 + semver 校验（缺失拒绝）
→ 临时目录组装 <规范名>/（目录重命名，内容原样）
→ 系统 tar 打包（tarInvocation 对称复用）→ 流式 SHA-256
→ 客户端预检：安装侧同一 validateArchive 扫自己打的包 + checkTree + inspectSkill 复核
→ POST /api/store/publish；409 单目录→报错 / --all→跳过
→ 输出摘要 + 下一步提示（product 注册 / notes）
```

`hy publish --repo <路径> [--all|--check]`：扫仓库全部 skill 目录 → 对账 → 确认后批量发布；`--check` 只报告。`hy audit`：独立对账报告（商店缺/本地落后/商店多）。

## 错误处理

- `CliError(exitCode, error, details)` 三元组贯穿；退出码契约 `0` 成功 / `2` 用法 / `3` 需登录或付款。
- 安装事务：暂存前 + 每次 rename 前双重保护检查（开发目录/链接占用/目标被第三方改动 dev+ino 校验）；失败逆序回滚；回滚失败保留备份并以 `recovery_paths` 报告，绝不清理。
- API 响应逐字段形状校验（`invalid_response`）；轮询中 5xx/网络抖动不中断等待（重试至期限）。
- 令牌只发签发服务器（`HY_API` 换向视为未登录），`HY_TOKEN` 显式例外；HTTPS 强制（localhost 例外）；一切输出过密钥遮盖（`hy_` 前缀兜底）。
- 免费版自动清理：装付费版时按 product 配对移除同宿主免费版，受保护的链接/开发目录跳过并解释原因。

## 测试策略

- `node:test`；fixture 假商店服务器平移 + publish/product/audit 端点 mock + 错误注入（409/403/413/5xx 序列）。
- driver 虚拟时钟/预设问答/假浏览器（Windows `ComSpec` 劫持方案平移）。
- 测试文件按域：`agent`（端到端：一条命令 登录→付款→安装；SIGKILL 后跨进程恢复）、`auth`、`cli`、`core`、`install 事务`、`purchase`、`publish`（★对称验证：恶意内容打包被自己验证器拒绝；命名映射冲突）、`hosts`（★9 宿主发现/链接矩阵）、`security`（令牌域隔离/HTTPS/遮盖）、`windows`、`review`（双语文案与 JSON 审查）。
- CI：windows/macos/ubuntu × Node 18/22（`.github/workflows/test.yml`）。

## 分期计划（grill-me 压力测试后确定）

**一期（MVP，纵切最小闭环）**：`login`（设备码）+ `publish`（发布管道）+ `install`（免费版安装 + 事务 + 多宿主链接）——"发布→安装"全链路先通，契约两端（publish 端 + catalog/download 端）被真实调用检验。服务端首期最小接口集：`/api/cli/device`、`/api/cli/token`、`/api/auth/me`、`/api/store/publish`、`/api/store/catalog`、`/api/store/versions`、`/api/store/download`（七 个）。契约文档整体一次定稿（含二期接口），客户端分期实现。

**二期（闭环加厚）**：付费订阅（`subscribe`/checkout/402 内联购买/恢复购买）、`product`/`unpublish`/`audit` 细化、`update` 全量更新、`manage`、九宿主中的低频宿主补齐验证。

**上架策略**：试点 2-3 个 skill（至少 1 免费 + 1 付费配对预留）先跑真闭环，批量上架随后用 `hy publish --repo --all` 一条命令完成（具体挑哪些属运营决策，不阻塞开发）。

## 假设清单（技术默认值，已按 grilling 规则显式标注）

| # | 假设 | 默认值 | 何时可推翻 |
|---|------|--------|-----------|
| 1 | 上传幂等 | 同 `sha256` 重传视为幂等成功；不做断点续传 | 首期联调时按服务端实现微调 |
| 2 | 包大小上限 | 100MB（`413 too_large` 阈值） | 服务端定稿 |
| 3 | 版本单调性 | 服务端拒绝重复版本（409）与低于 latest 的版本；允许跳版本 | 契约评审 |
| 4 | yank 语义 | history 保留 + `yanked` 标记；`latest` 回落到最高未 yank 版本 | 契约评审 |
| 5 | 发布者模型 | 单发布者账号（`me.publisher: bool`），无协作者体系 | 二期如需多人协作 |
| 6 | DEFAULT_API | 占位常量一处定义，联调前替换 | 域名定稿时 |
| 7 | 试点定价 | 买断制 `lifetime`（订阅 plan 是将来纯数据扩容） | 二期上订阅时 |
| 8 | `hy` 命令名 | 已验证本机 PATH 无占用 | 发布前在目标平台复验 |

## 已拍板决策一览

1. 托管商店（含账号 + 付费订阅），服务端另建、契约先行，CLI 用假服务器驱动开发。
2. 消费 + 发布管理双角色；付费体系完整保留（checkout/订阅/恢复购买）。
3. Node 零依赖 ESM；tar.gz 单格式。
4. 免费版双渠道（GitHub 仓 + 商店公开附件）；付费版仅商店。
5. 宿主表 9 项 zcode 置顶；豆包排除（未来发布渠道）。
6. 方案 B：机制层照搬 oil-cli 已验证资产 + 领域层三点重组（hosts 数据化 / publish 管道 / 配对数据驱动）。
7. 【grill】MVP 纵切：login + publish + 免费版 install 闭环；付费与维护命令二期。
8. 【grill】试点 2-3 个 skill 先行，批量上架用 `--repo --all`。
9. 【grill】试点付费商品用买断制。
10. 【grill】DEFAULT_API 占位常量，联调前替换。
