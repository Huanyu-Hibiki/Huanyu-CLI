中文 · [English](README.en.md)

# hy

环宇商店的命令行工具，用来安装、更新和管理环宇商店的 Skill。当前一期提供安装、登录与发布；更新和购买二期上线。

需要 Node.js 18 以上，不用单独安装，直接用 npx 运行：

```bash
npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>   # 安装
npx github:Huanyu-Hibiki/Huanyu-CLI login              # 登录
npx github:Huanyu-Hibiki/Huanyu-CLI publish <目录>     # 发布自己的 Skill
npx github:Huanyu-Hibiki/Huanyu-CLI status             # 查看已装 Skill 和账号（默认命令）
npx github:Huanyu-Hibiki/Huanyu-CLI help               # 全部命令
```

## 命令

说明与 `hy help` 文案一致。标注二期的命令参数合法，执行时提示尚未实现。

| 命令 | 说明 | 状态 |
|------|------|------|
| `status`（默认） | 查看已安装的 Skill 和账号 | 一期 |
| `list` | 查看 Skill 和价格 | 一期 |
| `install <skill> [--to <宿主>\|<路径>]` | 安装到全部或指定宿主 | 一期 |
| `login [--token <令牌>]` | 登录 | 一期 |
| `logout` | 撤销令牌并退出登录 | 一期 |
| `publish <目录> [--notes <说明>]` | 发布；--repo <路径> --all 批量、--check 只对账 | 一期 |
| `help` / `--version` | 帮助 / 版本 | 一期 |
| `update [<skill>] [--path <目录>]` | 更新 | 二期 |
| `subscribe <skill> [--plan <方案>]` | 购买并安装 | 二期 |
| `manage` | 管理购买 | 二期 |
| `product` | 管理商品信息 | 二期 |
| `unpublish` | 下架某个版本 | 二期 |
| `audit` | 对账本地与商店 | 二期 |

发布 Skill 的目录命名与 frontmatter 约定见 [docs/skill-convention.md](docs/skill-convention.md)。

## 九宿主自动发现

安装不带 `--to` 时自动发现本机已有的 Agent 宿主（只发现、不创建），按下面的顺序第一个可用的目录放真实副本，其余宿主用链接共享（Windows 用 junction，macOS/Linux 用 symlink）——本机只保留一份实体。

| 宿主 | 用户级目录 |
|------|-----------|
| zcode | `~/.zcode/skills` |
| agents | `~/.agents/skills` |
| claude | `~/.claude/skills` |
| codex | `~/.codex/skills`（尊重 `CODEX_HOME`） |
| cursor | `~/.cursor/skills` |
| opencode | `~/.config/opencode/skill`（尊重 `XDG_CONFIG_HOME`） |
| trae | `~/.trae/skills` |
| qwenwork | `~/.qwenworkcn/skills` |
| workbuddy | `~/.workbuddy/skills` |

用 `--to <宿主>`（上表 id）或 `--to <路径>` 指定目标，可写多次：第一个目标放实体，其余链接。项目里的目录不作默认目标，需要时用 `--to` 显式指定。其他宿主里的同名独立副本会换成指向实体的链接；开发目录（含 `.git`）跳过不动。

## 输出与退出码

- 输出语言跟随系统，可用 `--lang zh` / `--lang en` 或环境变量 `HY_LANG` 指定。
- `--json` 输出结构化 JSON（含 `next_command` 等字段，供 Agent 续跑长流程）；错误走 stderr。
- 退出码：`0` 成功；`1` 一般失败（网络/校验/安装/发布等，含错误详情）；`2` 用法错误（含尚未实现的命令）；`3` 需要登录或付款；`130` 二次 Ctrl+C 强制退出（备份路径会打印到 stderr）。
- 环境变量：`HY_API` 覆盖商店地址（须 HTTPS，本机地址除外）；`HY_TOKEN` 直接提供令牌（优先于本机登录，CI 用）。

## 开发

零 npm 依赖，测试用 Node 内置 `node:test`。测试必须用 `npm test` 运行：入口 `scripts/test.js` 显式列出测试文件；裸 `node --test` 会误扫 `template/` 里的参考实现和 `test/driver.js`、`test/fixture.js` 等测试基建。

CI 在 windows/macos/ubuntu × Node 18/22 六格矩阵运行测试，并在其中一个格子用 `npm pack --dry-run` 校验发布包内容。发布前检查见 [docs/release-checklist.md](docs/release-checklist.md)。

## 许可

[MIT](LICENSE)
