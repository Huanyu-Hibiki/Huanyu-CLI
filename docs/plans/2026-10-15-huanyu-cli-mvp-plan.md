# Huanyu-CLI 一期（MVP 闭环）实施计划

日期：2026-10-15
依据设计：`docs/designs/2026-10-15-huanyu-cli-design.md`（已批准 + grill-me 压测完毕）

## 总览

纵切一条"发布→安装"闭环：登录（设备码）→ 发布（publish 管道）→ 免费版安装（下载校验 + 事务替换 + 九宿主链接共享）。机制层从 oil-cli 照搬（事务/tar 预检/目录身份/测试基建），领域层按设计三点重组（hosts 数据化、publish 管道、配对数据驱动）。全部开发由假商店服务器驱动，不依赖真实服务端进度。一期**不搬** purchase/checkout 相关逻辑。

## 前置准备

- [x] 设计文档已批准（四段确认 + grill 压测）
- [x] 开发环境就绪：Node 18 与 22 本地可切换，模板 `template/oil-cli` 测试套件可运行（作为继承机制的参照基线）
- [x] 新仓库骨架位置确认：产品代码放本仓库根（`npx github:` 要求根包）；`template/` 与 `.zcode/config.json` 已进 .gitignore；git 已初始化（main 分支）

## 任务列表

### 任务 1: `hy help`/`hy version` 骨架跑起来——双语 + JSON 双通道 ✅（2026-10-15 完成）
- **交付**: 用户运行 `hy help` 看到中/英文全命令帮助，`hy --version` 输出版本号；任何命令加 `--json` 走 JSON 输出通道；未知命令/参数报用法错误并退出码 2。参数解析框架、输出双通道、错误三元组、双语框架、测试基建雏形（虚拟时钟 driver + 假服务器空壳 + CI workflow）全部立起来。
- **验收标准**:
  - [x] help/version/--lang/--json 的行为与退出码符合契约，参数误用（未知参数、重复参数、参数缺值）全部退出码 2 且给出双语提示
  - [x] 输出双通道：文本模式走人类行，--json 走结构化对象，错误输出走 stderr 且经过密钥遮盖框架
  - [x] CI 在 windows/macos/ubuntu × Node 18/22 六格全绿 —— **证据暂缓至首次 push**（仓库尚无远端；workflow 文件就位、本地 23/23 绿，首推后复核）
- **阻塞边**: 无（可立即开始）
- **安全**: 否
- **审查记录**: spec AC1/AC2 通过（20 项条款级核对）；quality 可合入（0 CRITICAL/HIGH）；已修复 notImplemented 文案、helpPublish 对齐、package.json 打包一致性；LOW 项（短密钥遮盖、hy_ 前缀误伤、--lang 宽松校验）留后续任务顺手处理

### 任务 2: `hy list` 列出商店商品——假商店驱动契约消费端 ✅（2026-10-15 完成）
- **交付**: 用户运行 `hy list` 看到试点商品（含免费/付费标记、价格、摘要），假商店服务器提供 catalog/versions 两端点（含形状容错与错误注入），传输层落地：HTTPS 强制（localhost 例外）、超时、响应形状逐字段校验。
- **验收标准**:
  - [x] 试点商品集（2-3 个：≥1 免费 + 1 付费配对预留，买断定价）在 list 输出中正确展示，中英双语价格文案正确
  - [x] catalog 外层三种形状（数组/{products}/{catalog}）都被接受；字段缺失/重复 id/非法 skill 名被拒为 invalid_response
  - [x] `HY_API` 指向非 HTTPS 远程地址时退出码 2 且未发出任何请求（经 userinfo 变体 + 请求计数证明）
- **阻塞边**: 任务 1
- **安全**: 否
- **审查记录**: spec 14/14 通过（无 BLOCKER/MAJOR/MINOR）；quality 可合入；已修复 env 还原强转、request() 错误分支覆盖（fixture failWith 注入位，500/401 用例）；NOTE 登记进任务 6/8 前置（versions 需补 download_url+sha256、node --test 约定、files+LICENSE）

### 任务 3: `hy login` 设备码登录并持久化，`hy status` 显示账号 ✅（2026-10-15 完成）
- **交付**: 用户运行 `hy login`，浏览器打开授权页、显示授权码，确认后令牌落盘；`hy status` 显示邮箱与订阅（未登录显示开源版提示）。待授权状态落盘可跨进程恢复：进程被杀后重跑同命令沿用旧授权码；CI 环境拒绝设备码流程并提示 `HY_TOKEN`。
- **验收标准**:
  - [x] 设备码轮询遵循 interval、slow_down 退避 +5s；授权码在一切输出中被完整隐藏
  - [x] 配置原子写（临时文件 + fsync + rename，0600/ACL），损坏配置被明确报错而非静默重置
  - [x] 令牌只发给签发它的服务器：`HY_API` 换向后不带令牌；`HY_TOKEN` 显式例外；logout 撤销服务端令牌失败时仍清除本机配置
  - [x] SIGKILL 中断后第二进程恢复并完成登录（跨进程恢复测试）
- **阻塞边**: 任务 2
- **安全**: 是（认证·密钥）
- **审查记录**: spec 4/4 通过；quality 可合入；security 通过（与基线等价）。已修复 7 项：相对路径配置目录守卫、短令牌整段隐藏、logout 双令牌撤销、ComSpec 绝对回落、missingAppdata 可达、fixture 惰性复制 node.exe、requireLogin 注释。登记不修：me() publisher 字段（任务 4 前置）、verification_uri 同源/并发写竞态/控制字符剥离（继承基线，入风险表）

### 任务 4: `hy publish` 把本地 skill 目录发布到商店 ✅（2026-10-15 完成）
- **交付**: 用户对一个含 SKILL.md 的目录运行 `hy publish <目录>`：规范名映射（frontmatter 优先，PascalCase 目录名推导）、semver 校验、tar.gz 打包、**对称预检**（用安装侧同一验证器扫自己打的包）、SHA-256 上传；商店返回 409 重复版本时单目录模式报错、`--repo --check` 模式只出对账报告。
- **验收标准**:
  - [x] 发布的包能通过自己验证器：符号链接/junction 跟随、路径越界、Windows 保留名在打包阶段被拒绝
  - [x] 命名映射正确（PPT-design→ppt-design 类）；两个本地目录推导出同一规范名时拒绝并列出；缺可用 version 即拒绝，name 缺失时按目录名推导、推导不可行或与 frontmatter 声明矛盾即拒绝
  - [x] 409 version_exists / 403 not_a_publisher / 413 too_large 语义正确；同 sha256 重传幂等（同机同检出；跨机器边界已写入设计假设 #1）
  - [x] 未登录或无 publisher 角色时给出登录引导（含 next_command）
- **前置（任务 3 审查登记）**: ✅ fixture me 补 publisher、client.me() 校验布尔
- **阻塞边**: 任务 3
- **安全**: 是（认证·上传内容）
- **审查记录**: spec 通过（前置/管道/契约/分期全核对）；quality 修复 HIGH（symlink 源目录 realpath 统一解析）后合入；security 3 MEDIUM 全修（双平台 validateArchive+保留名拒绝、资源预拒前移+流式上传、fixture 付费鉴权与服务端复检）；13 项修复含 SIGINT 双击/notes 限长/冲突全列等。确定字节打包与 X-Notes 已回填设计契约。新模块：src/skills.js（parseSkill/inspectSkill 等）、src/archive.js（validateArchive 共享验证器）

### 任务 5: `hy status` 扫描九宿主报告已装商店 skill ✅（2026-10-15 完成）
- **交付**: 用户运行 `hy status`（未登录也可）看到九宿主里装了哪些商店 skill：版本、位置、可更新状态、链接关系（谁链到谁）、多副本警告、免费/付费配对冲突警告。目录身份三层（canonical/logical/directoryKey 含 Windows 8.3 与大小写归一）与宿主表数据化在此落地。
- **验收标准**:
  - [x] 九宿主自动发现（用户级目录，opencode 实测为 ~/.config/opencode/skill 尊重 XDG——从其二进制反查确认）；项目级目录不作为默认扫描目标但显式 `--to`/`--path` 可达
  - [x] 同一安装经符号链接/大小写变体/短路径被扫到时只报一次；开发目录（含 .git）标记为 development 并跳过
  - [x] 假商店中已发布商品的版本比较与更新提示正确（semver BigInt 比较）
- **阻塞边**: 任务 2
- **安全**: 否
- **审查记录**: spec 通过（宿主表/重组点③配对数据驱动/directoryKey 保真/分期纪律逐项核对）；quality 可合并。修复 10 项：配对判别测试（堵 oil 式硬编码回退）、相对 XDG 统一（absoluteDirectory 共享）、projectRootsOf 数据化、resolveDirectory 下沉 platform 打破循环依赖、8.3 显式 skip、OIL_TEST_HOME 残留、isVersion 复用+HISTORY_LIMIT 常量、参数序统一、localeCompare 'en'、空安装跳过 versions 请求。登记不修：isDevelopmentDirectory 全树递归（基线语义，留性能专项）、UNC 裸错、development 条目列 releaseNotes

### 任务 6: `hy install --to <目录>` 单目标安装——下载校验 + 事务替换 ✅（2026-10-15 完成）
- **交付**: 用户指定单一目标目录安装免费 skill：302 跟随下载、流式 SHA-256 校验、tar 流式预检（拒绝路径穿越/符号链接/Windows 保留名）、系统 tar 解压、复核身份、**事务替换**（同盘暂存/两阶段提交/逆序回滚/回滚失败保留备份并报 recovery_paths）。重复安装同版本幂等；目标被占用时保护不覆盖。
- **验收标准**:
  - [x] 中途失败（下载中断/校验不符/解压失败/rename 失败）时原目录内容与权限完整恢复，测试注入中途失败点验证
  - [x] 恶意归档（路径穿越/链接条目/保留名/大小写碰撞）在预检阶段被拒，目标不可达
  - [x] 开发目录在暂存前与每次 rename 前双重保护；下载期间变成开发目录的场景回滚
  - [x] 付费 skill 在一期给出"暂未开放购买"引导（exit 3 + 商品页 URL，未发下载请求）
- **前置（任务 2 审查登记）**: ✅ fixture versions 补 download_url+sha256（种子发布物）；402 展示一期化为 purchaseUnavailable
- **阻塞边**: 任务 2、任务 5
- **安全**: 是（下载供应链·用户输入路径）
- **审查记录**: spec 通过（机制保真逐行 diff 证实）；quality 无 CRITICAL/HIGH；security 无 CRITICAL/HIGH。修复 11 项：免费摘要 fail-closed（删 302 响应头回退）、下载/解压大小上限对称（100MB/400MB）、占用预检前移、changed 保护 e2e、大小写碰撞用例、解压注入缝、死字段注释、seedCache 隔离、helper 合并、付费闸门排序注释、自定义路径 e2e。登记：POSIX tar PATH/暂存竞态/二次 SIGINT 残留（基线取舍）、fixture 413 与 download_url（契约评审项）

### 任务 7: 全宿主链接共享安装 + 发布→安装闭环验证 ✅（2026-10-15 完成）
- **交付**: 不带 `--to` 时自动发现九宿主：第一个可用（zcode 优先）放真实副本，其余 junction/symlink 共享；其他宿主的同名独立旧副本自动换为链接；已有正确链接时幂等跳过。闭环集成：任务 4 发布的包经 download 端点装回宿主矩阵，端到端验证"发布→安装"回路。
- **验收标准**:
  - [x] Windows 用 junction、POSIX 用 symlink；链接指向真实安装；安装后 status 复核链接关系（1 份实体 + 各宿主链接正确指向；update 属二期仍 not_implemented）
  - [x] 被保护链接/开发目录/未知占用目录跳过且解释原因；多副本合并提示给出精确的修复命令
  - [x] 集成测试：publish 上传 → catalog/versions 反映 → install 装回 ≥3 宿主 → status 报告链接关系，全链路绿（loop.test.js，装回内容与发布源逐字节一致）
- **阻塞边**: 任务 4、任务 6
- **安全**: 是（下载供应链）
- **审查记录**: spec 通过（多目标算法与 template 逐段 diff 证实）；quality 无 CRITICAL/HIGH；security 通过（有条件）。修复 7 项：missingTarget 保留原始标志、overlap 预检前移、realInstallation/悬空链接/linkDirectory 失败位三例补测、二次 SIGINT 前同步打印备份路径、RESERVED 保留名下沉 isSkillName（全链收紧）、install 拆分 resolveRoots/planActions、LOW 五项（纯链接跳过 versions/ENOTDIR/拼写提示/--yes 注释/排序键）。登记二期：副本静默销毁与链接写穿（基线取舍，protectSymlinks 重审时处理）、UNC 混排归一、悬空链接跳过语义（风险表有载）

### 任务 8: 发布收尾——README、skill 更新约定、CI 定稿 ✅（2026-10-15 完成）
- **交付**: 仓库 README（中英）说明安装/发布用法（`npx github:` 直跑）；"skill 内置版本检查"约定文档化（versions 公开接口、节流、HY_NO_AUTO_UPDATE 开关、自更新命令模板）；九宿主 CI 矩阵抽样测试补齐；发布前检查清单（DEFAULT_API 替换点、命令名复验）。
- **验收标准**:
  - [x] README 双语与实际命令行为一致（逐命令与 help 词条实跑核对 + core.test.js 自动钉住，词条改动即红）
  - [x] 版本检查约定文档完整（fenced 模板可整段抄进 SKILL.md；端点与 DEFAULT_API 测试级同步）
  - [x] 六格 CI 矩阵全绿——**证据暂缓至首次 push**（与任务 1 同口径；workflow 就位含 pack 校验步骤，本地 149 测试全绿）；发布检查清单入 docs/release-checklist.md
- **前置（审查登记）**: ✅ npm test 入口约定固化（README 开发节 + scripts 注释）；files 加回 README×2 + LICENSE（MIT）
- **阻塞边**: 任务 7
- **安全**: 否
- **审查记录**: spec 12/12 核心项通过；quality 1 HIGH（端点断言硬编码占位 URL，发布后必假红）已修——断言改由 DEFAULT_API 拼出；MEDIUM 措辞矛盾已修（"以小写字母或数字开头"）；README 补退出码 1/130；清单措辞精确化（README 侧无测试钉 + 版本断言提醒）。登记：npm registry 页相对链接死链（npx github 分发不受影响）、workflow 并发取消、npm pack 内容为目测非断言

## 并行机会（frontier）

- 任务 1 完成后：任务 2 独占（一切依赖它）。
- 任务 2 完成后：**任务 3、任务 5 可并行**（登录域 vs 宿主发现域互不触碰）；任务 4 等任务 3。
- 任务 3、5 完成后：任务 6 独占核心安装域；任务 4 可与任务 6 并行（发布域 vs 安装域）。
- 任务 4 + 6 完成后：任务 7 汇合，然后任务 8。

## 风险 & 缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 假服务器与真实服务端契约漂移 | 中 | 中 | 契约文档为唯一权威；二期联调前做一次契约 diff 复核；fixture 数据结构注释指向契约条目 |
| oil-cli 继承代码含品牌/商品硬编码残留 | 中 | 中 | 净室分析已定位硬编码点（oil-ui-pro 特例等）；搬运时按"配对数据驱动"重写该分支并加测试 |
| opencode 宿主路径假设错误 | 中 | 低 | 任务 5 实测定数据；hosts.js 数据化使修正成本一行 |
| Windows junction/短路径在 CI 与本机行为差异 | 中 | 中 | 任务 6 起每片都跑 windows-latest；8.3 与大小写归一测试前置到任务 5 |
| 一期误搬付费/checkout 逻辑导致范围膨胀 | 低 | 中 | 计划明令一期不搬 purchase；任务 6 以"付费引导"代替 402 流程 |
| 发布包体过大（assets 丰富的 skill） | 低 | 低 | 假设上限 100MB；publish 输出包大小并在超限时本地预拒 |
| 继承基线的已知安全权衡（verification_uri 不校验同源、并发 login 写竞态、服务端字符串未剥离控制字符） | 低 | 低 | security 审查登记为"继承基线"；二期联调前契约评审时统一评估是否加固 |
| 【任务 7 审查登记，二期评估】非交互安装/替换时旧副本内容在事务提交后即销毁（无回收站）；realInstallation 经用户自建链接写穿到链接真实目标（M1/M2，继承基线设计取舍，多宿主放大了半径） | 中 | 中 | 二期付费清理任务重审 protectSymlinks 时一并处理（回收/备份策略与写穿白名单）；一期 fail-closed：未知占用与悬空链接整批拒绝并回滚 |
| 【任务 7 审查登记，二期评估】UNC 与盘符路径混排指向同一实体时 directoryKey 未能完全自愈归一 | 低 | 低 | canonicalDirectory/directoryKey 已归一 8.3、大小写与 `\\?\` 前缀；UNC 混排留二期加测试与归一规则 |
| 【任务 7 审查登记，二期评估】单个宿主位的悬空链接会阻塞整批安装（occupied 全批失败） | 低 | 中 | fail-closed 是正确语义（不覆盖不认识的链接）；已在测试钉住；二期评估改「跳过该宿主+解释」的交互成本 |
