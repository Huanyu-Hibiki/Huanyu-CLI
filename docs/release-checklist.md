# 发布前检查清单

每次对外发布（首次上架、商店域名定稿、版本发布）前过一遍。

- [ ] **DEFAULT_API 占位替换**：`src/client.js` 一处的 `https://store.huanyu.example` 换成正式商店地址（联调前完成）；同步更新 `docs/skill-convention.md` 的端点模板（测试钉住它与 DEFAULT_API 一致，漏改会红）与 README 的 `HY_API` 说明（此侧无测试钉住，人工核对）。
- [ ] **`hy` 命令名复验**：在目标平台确认 `hy` 未被 PATH 里的其他程序占用（任务 1 已在本机 Windows 验过；macOS/Linux 发布前再查）。冲突时用户仍可用 `npx github:Huanyu-Hibiki/Huanyu-CLI` 运行。
- [ ] **六格 CI 矩阵全绿**：windows/macos/ubuntu × Node 18/22；首次 push 后复核 workflow 实跑结果（本地全绿不能替代）。
- [ ] **打包核对**：`npm pack --dry-run` 确认 tarball 只含 bin/、src/、README.md、README.en.md、LICENSE、package.json；核对 package.json 版本号（`test/core.test.js` 有版本断言，升版本时需同步改）；打 git tag。
- [ ] **试点商品集上架**：2-3 个（至少 1 免费 + 1 付费配对预留）；用 `hy publish --repo <Huanyu-Skills 路径> --check` 先对账，再 `--all` 批量发布。
- [ ] **联调前契约评审清单**：过一遍 `docs/designs/2026-10-15-huanyu-cli-design.md` 里标注【联调评审补充】与「契约评审」的各条（checkout 响应回显 plan、复用响应重发 notice、新建会话过期旧 open 会话、会话 URL 短 TTL 与不可预测 id、过期用 expired 而非 404；上传幂等的跨机器字节差异；版本单调性；yank 占位语义）。逐条与真实服务端核对，评估假商店 `test/fixture.js` 是否需要跟随调整。
