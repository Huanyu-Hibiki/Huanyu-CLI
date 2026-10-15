中文 · [English](README.en.md)

# hy

环宇商店的命令行工具，用来安装、更新、购买和管理环宇商店的 Skill。

需要 Node.js 18 以上，不用单独安装，直接用 npx 运行：

```bash
npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>   # 安装
npx github:Huanyu-Hibiki/Huanyu-CLI update             # 更新已安装的 Skill
npx github:Huanyu-Hibiki/Huanyu-CLI login              # 登录
npx github:Huanyu-Hibiki/Huanyu-CLI publish <目录>     # 发布自己的 Skill
npx github:Huanyu-Hibiki/Huanyu-CLI status             # 查看已装 Skill 和账号（默认命令）
npx github:Huanyu-Hibiki/Huanyu-CLI help               # 全部命令
```

## 命令

说明与 `hy help` 文案一致。

| 命令 | 说明 |
|------|------|
| `status`（默认） | 查看已安装的 Skill 和账号 |
| `list` | 查看 Skill 和价格 |
| `install <skill> [--to <宿主>\|<路径>]` | 安装到全部或指定宿主 |
| `update [<skill>] [--path <目录>]` | 更新 |
| `login [--token <令牌>]` | 登录 |
| `logout` | 撤销令牌并退出登录 |
| `subscribe <skill> [--plan <方案>]` | 购买并安装 |
| `manage` | 管理购买 |
| `publish <目录> [--notes <说明>]` | 发布；--repo <路径> --all 批量、--check 只对账 |
| `product <skill> --set <字段>=<值>` | 管理商品信息 |
| `unpublish <skill> <版本>` | 下架某个版本 |
| `audit [--repo <路径>]` | 对账本地与商店 |
| `help` / `--version` | 帮助 / 版本 |

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

## 免费版自动清理

免费版和付费版成对的商品（例如 `ppt-design` 与 `ppt-design-pro`）在安装或更新付费版时，同一个 Agent 里已装的免费版会自动移除（列在输出的 `removed` 里），避免两个版本同时抢同一类请求。移除与安装同在一个事务里，失败一起回滚；开发目录、受保护链接指向的免费版等位置会跳过，并在 `skipped` 里说明原因。

## 备份与恢复

替换或清理旧版本时，原目录保留为安装根下的 `.hy-backup-<时间戳>` 备份，`hy status` 会提示备份位置；该 Skill 下一次安装或更新时自动清理，也可以随时手动删除。强制退出（退出码 130）或回滚未完成时，备份位置会打印到 stderr，可以从备份手动恢复。

## 购买与重跑

付款在浏览器完成，付款会话保存在本机：付款超时或命令被中断后，重新运行原命令会恢复同一个付款页继续等待，不会重复收费。已确认购买之后安装仍失败（履约竞态、下载中断等）时，错误信息会附带提示——重新运行原命令即可完成安装，同样不会再次收费。

## 输出与退出码

- 输出语言跟随系统，可用 `--lang zh` / `--lang en` 或环境变量 `HY_LANG` 指定。
- `--json` 输出结构化 JSON（含 `next_command` 等字段，供 Agent 续跑长流程）；错误走 stderr。
- 退出码：`0` 成功；`1` 一般失败（网络/校验/安装/发布等，含错误详情）；`2` 用法错误；`3` 需要登录或付款；`130` 二次 Ctrl+C 强制退出（备份路径会打印到 stderr）。
- 环境变量：`HY_API` 覆盖商店地址（须 HTTPS，本机地址除外）；`HY_TOKEN` 直接提供令牌（优先于本机登录，CI 用）。

## 开发

零 npm 依赖，测试用 Node 内置 `node:test`。测试必须用 `npm test` 运行：入口 `scripts/test.js` 显式列出测试文件；裸 `node --test` 会误扫 `template/` 里的参考实现和 `test/driver.js`、`test/fixture.js` 等测试基建。

CI 在 windows/macos/ubuntu × Node 18/22 六格矩阵运行测试，并在其中一个格子用 `npm pack --dry-run` 校验发布包内容。发布前检查见 [docs/release-checklist.md](docs/release-checklist.md)。

## 许可

[MIT](LICENSE)
