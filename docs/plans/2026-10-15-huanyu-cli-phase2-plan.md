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

### 任务 1: `hy update` 全量更新——链接只更新实体、整批事务
- **交付**: 用户运行 `hy update`（可选 `<skill>` 过滤、`--path <目录>` 定点）看到全部过期安装被批量更新：按 real_path 去重（链接安装只更新真实目标一次）、整批事务替换、开发目录跳过并解释、更新后冲突/多副本警告复扫、`--json` 区分 updated/up_to_date/skipped 计数；交互确认批量更新数、非交互 auto_confirmed 警示沿用。
- **验收标准**:
  - [ ] 链接宿主里的旧版本：只更新真实目录，链接保持指向且新版本即刻生效（status 复核）
  - [ ] 多宿主多副本各自更新；开发目录 skipped 只报一次；`--path` 定点更新拒绝未知/不匹配目录
  - [ ] 无可更新时 up_to_date；全为开发目录时 skipped 状态；批量中途失败整批回滚（注入验证）
- **阻塞边**: 无（一期已备齐全部机制）
- **安全**: 否

### 任务 2: `hy product` / `hy unpublish` / `hy audit` 三个管理命令
- **交付**: `hy product <skill> --set summary=... --set prices.lifetime=6900,cny ...`（PUT products 注册/更新商品元数据与 free-paid 配对）；`hy unpublish <skill> <version>`（DELETE yank，输出已装用户不受影响的说明）；`hy audit`（对账报告独立入口：商店缺/本地落后/版本一致/商店多，复用 publish 的对账逻辑，支持 --repo 路径）。
- **验收标准**:
  - [ ] product 元数据落库后 `hy list` 立即反映（摘要/价格/配对标记）；非法字段/未知 skill 拒绝
  - [ ] unpublish 后新安装该版本 404、status 显示历史含 yanked 标记、已装不受影响；未登录/非 publisher 引导
  - [ ] audit 双语报告四类分类准确，`--json` 结构化
- **阻塞边**: 无
- **安全**: 是（认证·管理操作）

### 任务 3: `hy manage` + 付费下载路径激活
- **交付**: `hy manage` 打开账号管理门户（portal 接口 + 浏览器）；install/subscribe 的付费路径解锁：requireLogin → 令牌下载（redirect:error、X-Content-SHA256/X-Skill-Version 头校验已备）→ 已购直接安装；未购 402 触发任务 4 的购买流程（本任务先留 402 引导位）。
- **验收标准**:
  - [ ] manage 打开浏览器返回门户 URL；无法打开时给出可复制链接
  - [ ] 已购（fixture grants）付费 skill 一条命令安装成功，302 禁止/令牌直连/头校验语义激活并有测试
  - [ ] 未购 402 → `inactive` 语义输出（purchase_url + subscribe 命令引导，暂不进 checkout——任务 4 接线）
- **阻塞边**: 无
- **安全**: 是（认证·付费下载）

### 任务 4: checkout 支付会话 + `hy subscribe`
- **交付**: 移植 purchase.js：`hy subscribe <skill> [--plan]` 创建支付会话（浏览器打开付款页、notice 转告、3s 轮询、非交互 60s/交互 15min 预算）；**会话落盘可跨进程恢复**（pending_checkout，重跑不重复收费、不重复建会话）；409 already_active 当已购；超时 exit 3 带付款 URL 与原命令；购买生效后非交互自动接续安装。fixture 补 checkout/status 端点（含 5xx 注入、复用语义、币种语言核对）。
- **验收标准**:
  - [ ] 设备码同款可恢复语义：SIGKILL 后重跑沿用会话；已付未确认（payment_processing）重跑直接安装
  - [ ] 409 already_active / 会话过期换新 / 计划不存在 / 免费技能购买拒绝，语义与文案正确
  - [ ] 一条命令端到端：登录 → subscribe → 付款（假浏览器 approve）→ 轮询解锁 → 自动安装（含多宿主链接共享）
- **阻塞边**: 任务 3（付费下载路径）
- **安全**: 是（支付·密钥）

### 任务 5: install/update 的 402 内联购买 + 免费版配对清理
- **交付**: install/update 遇 402（下载时才知未购）内联进购买流程后自动续装（purchaseOnInactive 模式）；**addFreeReplacements 移植并数据驱动化**：安装/更新任何配对商品的付费版时自动移除同宿主的免费版（freeReplacements 扫描、protectSymlinks 保护、被保护链接/开发目录跳过并解释）；removed 输出列明移除的免费版。
- **验收标准**:
  - [ ] 402 内联购买→安装续接（JSON 输出顺序可追溯）；重复 402 不重复购买（unlocked 缓存）
  - [ ] 装付费版自动清理同宿主免费版；跨宿主/自定义目录只清理能归属宿主组的；链接指向的免费版真实目标受保护
  - [ ] 反例：无配对的付费 skill 安装不清理任何东西
- **阻塞边**: 任务 4
- **安全**: 是（支付·删除操作）

### 任务 6: 安全加固——副本销毁/写穿白名单/UNC 归一/悬空链接
- **交付**: 一期登记的四项基线取舍落地：①非交互替换旧副本前内容差异门槛（本地修改过的副本跳过并警告，而非静默销毁）；②realInstallation 写穿白名单（链接真实目标必须落在已知宿主根集合内，否则按 occupied 拒绝）；③UNC/盘符同实体 directoryKey 归一；④悬空链接从"阻塞整批"改为"跳过该宿主+解释"（保持 fail-closed 于单宿主位）。
- **验收标准**:
  - [ ] 四项各有判别性测试（含攻击场景的正反例）；既有行为回归不破坏（146+ 基线）
  - [ ] security-auditor 复审通过（对照一期 M1/M2 登记）
- **阻塞边**: 任务 5（清理路径定形后再加固）
- **安全**: 是（本任务即安全专项）

### 任务 7: 收尾——README 命令面转正、v0.2.0、tag
- **交付**: README 双语把 6 个二期命令从"二期"标注转为正式说明（help 词条同步）；release-checklist 复核；版本 0.2.0（core 版本断言同步）；六格 CI 绿后打 tag v0.2.0；二期审查记录回填计划文档。
- **验收标准**:
  - [ ] README/help/实际行为三方一致（测试钉住）；六格 CI 绿；tag v0.2.0 推送
- **阻塞边**: 任务 1-6
- **安全**: 否

## 并行机会（frontier）

单工作树串行执行（同仓共享 cli.js/i18n.js/fixture.js，并行会冲突）：1 → (2 ∥ 3) 逻辑上可并行但实际按 2→3 串行；4 → 5 → 6 → 7。

## 风险 & 缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| checkout 状态机移植引入支付语义回归 | 中 | 高 | template 状态机逐行移植 + 假商店全错误注入（5xx/过期/复用/already_active）；SIGKILL 恢复测试 |
| 免费清理误删用户数据 | 中 | 高 | 配对数据驱动 + protectSymlinks + 任务 6 内容门槛；删除只走事务（可回滚） |
| 二期命令与一期 help/README 漂移 | 低 | 中 | core 一致性测试已钉 help↔README，词条改动即红 |
| 真实服务端契约与假商店分叉 | 中 | 中 | 契约文档为唯一权威；联调前 diff（release-checklist 第 1 项） |
