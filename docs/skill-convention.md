# Skill 约定：frontmatter、发布与内置更新检查

写给准备上架环宇商店的 Skill 作者：目录命名、SKILL.md frontmatter 契约、发布命令，以及可直接抄进 SKILL.md 的内置更新检查模板。内置更新检查是约定不是门槛——CLI 不强制 Skill 自带。

## frontmatter 契约

SKILL.md 的 YAML frontmatter 至少包含：

```yaml
---
name: ppt-design
description: 分步设计演示文稿的结构与版式。
metadata:
  version: 0.2.0
---
```

- `name`：规范名，须匹配 ^[a-z0-9][a-z0-9-]*$（以小写字母或数字开头，只含小写字母、数字、连字符），且不能是 Windows 保留设备名（con、prn、aux、nul、com1-9、lpt1-9；带扩展名如 con.txt 也算）。安装目录名就是规范名。
- `metadata.version`：语义化版本 x.y.z（如 0.2.0）。缺版本或格式不对会拒绝发布。
- `name` 可以省略：发布时从目录名推导规范名（小写化并去掉 [a-z0-9-] 以外的字符，如 PascalCase 目录 `PPT-design` 自动推导为 `ppt-design`）；推导结果须以小写字母开头且非保留名，否则拒绝。写了 `name` 但与最终规范名不一致（含写法不合法）也会被拒——按提示把 `name` 修正为规范名，或删掉该字段改用目录名推导。

## 发布

```bash
hy publish <目录>                        # 发布单个 Skill（目录里须有 SKILL.md）
hy publish <目录> --notes "<更新说明>"    # 附更新说明（≤2000 字符）
hy publish --repo <路径> --all           # 批量发布仓库里的全部 Skill
hy publish --repo <路径> --check         # 只对账本地与商店，不发布
```

用 npx 时把 `hy` 换成 `npx github:Huanyu-Hibiki/Huanyu-CLI`。发布前包内容会按安装侧同一套验证器自检：符号链接、路径越界、Windows 保留名都会在打包阶段被拒绝。同版本重传：内容一致按幂等处理；内容不同提示提升版本号（跨机器重新打包字节可能不同，属预期）。

## 内置更新检查（可抄进 SKILL.md）

Skill 可以在自己被使用时顺手查一下新版本并提示 Agent 更新。约定如下，模板整段抄进 SKILL.md 即可：

```markdown
## 版本更新检查

被使用时执行本节：

1. 环境变量 `HY_NO_AUTO_UPDATE` 或 `HY_NO_UPDATE_CHECK` 已设置（非空）→ 直接跳过本节。
2. 距上次检查不足 10 分钟（自行记录时间戳）→ 跳过。
3. 以 2 秒超时请求 `${HY_API:-https://store.huanyu.example}/api/store/versions`；超时、网络错误或响应无法解析一律静默跳过，绝不因更新检查打断正常工作。
4. 在响应的 `skills` 里按 frontmatter `name` 找到本 Skill；若 `latest` 高于当前 `metadata.version`，提示：

   发现新版本 <latest>（当前 <version>）。请运行：
   npx github:Huanyu-Hibiki/Huanyu-CLI update <skill> --path "<安装路径>"

   `<安装路径>` 取本 SKILL.md 所在目录的绝对路径。
```

一期 `update` 命令尚未实现；提示后由用户重跑 `npx github:Huanyu-Hibiki/Huanyu-CLI install <skill>` 也能把实体副本更新到最新版（各宿主链接自动跟随）。
