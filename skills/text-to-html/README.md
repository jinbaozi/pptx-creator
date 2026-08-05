# text-to-html

将已审核的文本、Markdown 或大纲制作成离线 HTML 演示文稿包。输出可在浏览器中查看，也可作为后续 `html-to-pptx` 的可选输入。

## 快速使用

在本 Skill 目录执行：

```bash
npm ci
node scripts/run-pipeline.mjs presentation-plan.json ./output
```

输入必须是 Plan 2.0 的 `presentation-plan.json`。先完成内容、受众、分页、设计意图、来源和资产权属，再运行流水线。详细字段见 [SKILL.md](SKILL.md) 和 [references/plan-contract.md](references/plan-contract.md)。

输出包括 HTML、预览图、来源与资产记录、QA 证据，以及可选的 `presentation-package.json`。只有 `qa-report.json` 的状态为 `passed` 时才算交付完成；需要 PPTX 时，再将通过 QA 的演示包交给 `html-to-pptx`。

## 推荐提示词

```text
使用 $text-to-html 将【来源或文件】制作成 16:9 离线 HTML 演示文稿；受众是【受众】，目的为【目的】，风格为【风格】。所有事实、来源和资产必须可追溯，不得编造；生成 Plan 2.0，并仅在 qa-report.json 为 passed 后输出到【目录】。
```

## 约束

- 不直接生成 PPTX，不替 Host 编造事实、来源、品牌或审批。
- 资产必须本地化并保留权属信息；拒绝绝对路径、遍历路径、符号链接和缺失资源。
- 脚本离线、确定性运行，不调用 LLM。
