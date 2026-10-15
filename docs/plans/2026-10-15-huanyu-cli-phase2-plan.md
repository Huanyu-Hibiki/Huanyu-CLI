# Huanyu-CLI 二期（付费与维护命令）实施计划

日期：2026-10-15
依据设计：`docs/designs/2026-10-15-huanyu-cli-design.md`（全文设计已批准，二期范围见「分期计划」；一期计划 `2026-10-15-huanyu-cli-mvp-plan.md` 已完成并 CI 六格绿）
基线：v0.1.0（149 测试；假商店服务器/虚拟时钟/假浏览器/错误注入基建齐备）

## 总览

二期把剩余 6 个命令（update/subscribe/manage/product/unpublish/audit）全部转正，激活付费链路（付费下载 → 402 内联购买 → checkout 可恢复会话 → 订阅状态）与免费版配对清理，并落地一期登记的 4 项安全加固。机制全部继承一期（事务替换/目录身份/状态机模式），purchase.js 按 template 移植但配对清理数据驱动化。

## 前置准备

- [x] 一期完成且 CI 六格绿（v0.1.0）
- [x] 设计文档覆盖全部二期契约（checkout/products/releases/portal 接口已定义）
- [x] 假商店基建可扩展（fixture 已有 grants/publishers/releases 等注入位）

## 任务列表

### 任务 1: `hy update` 全量更新——链接只更新实体、整批事务 ✅（2026-10-15 完成）
- **交付**: 用户运行 `hy update`（可选 `<skill>` 过滤、`--path <目录>` 定点）看到全部过期安装被批量更新：按 real_path 去重（链接安装只更新真实目标一次）、整批事务替换、开发目录跳过并解释、更新后冲突/多副本警告复扫、`--json` 区分 updated/up_to_date/skipped 计数；交互确认批量更新数、非交互 auto_confirmed 警示沿用。
- **验收标准**:
  - [x] 链接宿主里的旧版本：只更新真实目录，链接保持指向且新版本即刻生效（status 复核）
  - [x] 多宿主多副本各自更新；开发目录 skipped 只报一次；`--path` 定点更新拒绝未知/不匹配目录
  - [x] 无可更新时 up_to_date；全为开发目录时 skipped 状态；批量中途失败整批回滚（failRenameAt 注入验证）
- **阻塞边**: 无（一期已备齐全部机制）
- **安全**: 否
- **审查记录**: spec 通过（与 template 逐段对齐、裁剪边界严格落在任务 3/5）；quality 无 CRITICAL/HIGH。修复 6 项：assertReplaceable 占用预检共享件（update 也下载前失败）、purchaseGate 抽取（install/update 两处去重）、复扫段交叉注释、conflicts 复扫判别例 + 四个覆盖缺口（--path 链接/交互接受/不降级/--path 开发目录）、eligible_count 口径注释。登记任务 7：releaseDelay 竞态 Promise 门控、测试助手上移 fixture

### 任务 2: `hy product` / `hy unpublish` / `hy audit` 三个管理命令 ✅（2026-10-15 完成）
- **交付**: `hy product <skill> --set ...`（PUT products 注册/更新商品元数据与 free-paid 配对）；`hy unpublish <skill> <version>`（DELETE yank）；`hy audit`（对账报告独立入口，五态分类与 publish --check 同源）。
- **验收标准**:
  - [x] product 元数据落库后 `hy list` 立即反映（摘要/价格/配对标记）；非法字段/未知 skill 拒绝
  - [x] unpublish 后新安装该版本 404、status 显示历史含 yanked 标记、已装不受影响；未登录/非 publisher 引导
  - [x] audit 双语报告（五态：商店缺/待发布/本地领先/一致/商店多 + yanked 提示——对账与 publish --check 同源一致性优先于计划文字"四类"），`--json` 结构化
- **阻塞边**: 无
- **安全**: 是（认证·管理操作）
- **审查记录**: spec 16/16 通过；quality 无 CRITICAL/HIGH。修复 5 项：全下架占位语义一致（status/update 共用 latestYanked 判定，"全部版本已下架"词条）、服务端 400 独立文案 + 本地跨商品冲突预判（product_conflict）、--set 重复键拒绝、金额上限 10^9 分、audit 零令牌断言钉死。契约同步：prices 补 interval? 字段、假设 #4 补全下架占位语义（设计文档已更新）。登记：PUT 无法删除方案/清空 summary（联调评审）

### 任务 3: `hy manage` + 付费下载路径激活 ✅（2026-10-15 完成）
- **交付**: `hy manage` 打开账号管理门户；install/subscribe 付费路径解锁：requireLogin → 令牌下载（redirect:error、双头校验）→ 已购直接安装；未购 402 → inactive 引导。
- **验收标准**:
  - [x] manage 打开浏览器返回门户 URL；无法打开时给出可复制链接
  - [x] 已购（fixture grants）付费 skill 一条命令安装成功，302 禁止/令牌直连/头校验语义激活并有测试
  - [x] 未购 402 → `inactive` 语义输出（subscribe_command + subscription_url，不进 checkout——任务 4 接线）
- **阻塞边**: 无
- **安全**: 是（认证·付费下载）
- **审查记录**: spec 有条件通过→修复后闭合（1 MAJOR）；quality 1 HIGH；security 通过（0 CRITICAL/HIGH，付费访问控制/下载链/令牌生命周期全正面结论）。修复 7 项：tmpdir 竞态根治（fixture 级私有 tmpdir 三通道 + 快照断言改私有目录）、**--token= 遮盖漏注册实 bug**（argv.slice→arg.slice，原 bug 会损坏全部输出）、invalidateAccount 契约（任务 5 用）、订阅状态表驱动（5 正例+3 fail-closed）、付费头摘要负例、me() 条目形状校验、portal 恶意 URL 测试。登记契约评审：订阅到期/past_due 宽限服务端义务、付费摘要交叉核对、portal URL 控制字符（继承基线）

### 任务 4: checkout 支付会话 + `hy subscribe` ✅（2026-10-15 完成）
- **交付**: 移植 purchase.js 全状态机：subscribe 创建支付会话（notice 转告、3s 轮询、非交互 60s/交互 15min）、会话落盘可跨进程恢复（重跑不重复收费）、409 already_active 当已购、超时 exit 3 附付款 URL、购买生效自动接续安装。14 命令全部转正。
- **验收标准**:
  - [x] SIGKILL 后重跑沿用会话；已付未确认重跑直接安装（processing 三段测试）
  - [x] 409 already_active / 会话过期换新 / 计划不存在 / 免费技能购买拒绝，语义与文案正确
  - [x] 一条命令端到端：登录 → subscribe → 付款解锁 → 自动安装（多宿主链接共享）
- **阻塞边**: 任务 3
- **安全**: 是（支付·密钥）
- **审查记录**: spec 通过（purchase.js 与 template 逐行 diff 零漂移）；quality 无 CRITICAL/HIGH；security PASS（重复收费防护链逐环验证）。修复 9 项：6 测试缺口（15min 预算/恢复期 5xx 重核币种/CI 恢复保留/saveAuth 保留进度/绑定负例×2）+ 4 安全加固（恢复链 404 纵深防御清换新会话、notice 消毒 500 字上限、checkout url 协议对齐、金额正数校验）。契约登记（设计文档已更新）：响应回显 plan、复用重发 notice、新建过期兄弟会话、会话 URL 短 TTL/不可预测 id、404→expired 优先。遗留：requireEntitlement 的 unlockedSkills 旁通为任务 5 接缝

### 任务 5: install/update 的 402 内联购买 + 免费版配对清理 ✅（2026-10-15 完成）
- **交付**: 402 内联购买（下载竞态窗口 → requirePurchase → 重试下载续装，unlockedSkills 防重复购买）；addFreeReplacements 数据驱动化（任意配对商品装付费版自动清理同宿主免费版，保护三态跳过并解释，事务内 remove 可回滚）。
- **验收标准**:
  - [x] 402 内联购买→安装续接；重复 402 不重复购买（重试再 402 透出原错误，checkoutRequests=1）
  - [x] 自动清理同宿主免费版（第二组配对商品正例钉死数据驱动）；跨宿主/自定义目录按归属；链接真实目标受保护
  - [x] 反例：无配对付费 skill 安装不清理任何东西
- **阻塞边**: 任务 4
- **安全**: 是（支付·删除操作）
- **审查记录**: spec 通过（14/14，特判全灭核实）；quality 1 HIGH；security 1 HIGH。**必修三项全修（9ef9260）**：①update 纯清理路径绕过权益闸门（实证：失效订阅静默删免费版）→ 清理目标过只读权益判定，fail-safe 不清理；②支付前置于用法校验（付款后才报 missing_target）→ checkEntitlement 只读拆分，购买移到规划/确认之后下载之前；③删除无预先确认 → 清理规划前移确认前 + 文案计入移除数 + 纯清理批次交互确认/非交互警示。另修 spec 3 测试缺口 + quality 5 LOW（名字守卫/死参数/replaced_by/cleanup_only/canonicalRootKeys）。登记任务 6：remove 内容差异门槛、三个 template 边缘清理用例；任务 7：help/README 清理说明、购买后失败重跑指引

### 任务 6: 安全加固——副本销毁/写穿白名单/UNC 归一/悬空链接 ✅（2026-10-15 完成）
- **交付**: ①**方案 C 备份保留**（replaceAll 提交后备份改名 `.hy-backup-*` 保留，M1 从不可逆降为可恢复——商店无旧版归档，内容比对基准不存在，方案 A/B 不可行）；②realInstallation 写穿白名单（install planActions + update 全路径含 --path，共享判定 assertManagedTarget + managedRoots 管辖根，TOCTOU 执行期复检）；③UNC/盘符归一按"登记限制 + 测试钉现状"定案（Node 无可靠盘符映射查询）；④悬空链接链接位跳过+解释、主目标位/声明位保持 fail-closed。三个 template 边缘清理用例补齐。
- **验收标准**:
  - [x] 四项各有判别性测试（正反例）；基线不回归（254 测试 253 过+1 平台跳过）
  - [x] security-auditor 复审：M1 通过（带登记）、M4 通过；M2 初判"需补充"（update 白名单缺失）→ 修复后闭环（三审一致 HIGH 全修：update 全路径白名单 + 交互透出写穿目标 + TOCTOU 复检 + 备份清理按 skill 身份收窄 + retained_backups 可发现性 + .hy-stage 残留上报）
- **阻塞边**: 任务 5
- **安全**: 是（本任务即安全专项）
- **审查记录**: spec 有条件通过→修复闭合（1 MAJOR 同源）；quality 1 HIGH 同源；security HIGH-1 同源 + M1 备份连带清理。全部修复于 c3cc06b。登记：备份权限继承在装目录、白名单广度含 cwd 项目根（自声明）、根级符号链接放行、悬空跳过持续可见、UNC 定案。①方案 C 取舍已回填本记录

### 任务 7: 收尾——README 命令面转正、v0.2.0、tag ✅（2026-10-15 完成）
- **交付**: README 双语六命令转正 + 三块机制说明（免费版自动清理/备份与恢复/购买重跑）；登记事项落地（Promise 门控、rescanWarnings 抽取、402 重试 hint、helpIntro 补齐）；版本 0.2.0；六格 CI 绿（run 38769598786）；tag v0.2.0 推送；release-checklist 更新为联调评审清单。
- **验收标准**:
  - [x] README/help/实际行为三方一致（一致性测试升级为用法+说明双向逐字钉住 + 无分期标注断言）；六格 CI 绿；tag v0.2.0 推送
  - [x] 登记事项 (a) Promise 门控 (b) 复扫抽取 (c) 重跑 hint 全部落地有测试
  - [x] npm test 全绿（256 测试）
- **阻塞边**: 任务 1-6
- **安全**: 否
- **审查记录**: spec 14/15（MAJOR 为文档未提交——计划回填与设计契约标注滞后于 tag，由主线补交；MINOR checklist 漏 4 条已补）；quality 无 CRITICAL/HIGH（MEDIUM 恒真断言 + LOW 数项已派修复）。CI 首跑暴露 macOS 语言钉住遗漏（任务 6 遗留）已修。全部命令（14 个）在 v0.2.0 转正

## 并行机会（frontier）

单工作树串行执行（同仓共享 cli.js/i18n.js/fixture.js，并行会冲突）：1 → (2 ∥ 3) 逻辑上可并行但实际按 2→3 串行；4 → 5 → 6 → 7。

## 风险 & 缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| checkout 状态机移植引入支付语义回归 | 中 | 高 | template 状态机逐行移植 + 假商店全错误注入（5xx/过期/复用/already_active）；SIGKILL 恢复测试 |
| 免费清理误删用户数据 | 中 | 高 | 配对数据驱动 + protectSymlinks + 任务 6 内容门槛；删除只走事务（可回滚） |
| 二期命令与一期 help/README 漂移 | 低 | 中 | core 一致性测试已钉 help↔README，词条改动即红 |
| 真实服务端契约与假商店分叉 | 中 | 中 | 契约文档为唯一权威；联调前 diff（release-checklist 第 1 项） |
