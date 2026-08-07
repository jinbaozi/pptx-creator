# text-to-html

将自然语言需求、Markdown、长文本或结构化大纲整理为经过审核的 Plan 2.0，并生成可离线浏览的 HTML 演示文稿包。本 Skill 不生成 PPTX；输出的 `presentation-package.json` 可选择是否交给后续 Skill，不构成运行时依赖。

## 输入与环境

- Node.js 20 或更高版本，并安装 Playwright Chromium。
- 正式流水线只接受 `version: "2.0.0"` 的 `presentation-plan.json`。内容、叙事、设计意图、来源、资产权属和必需审核必须完整。
- 只有 Markdown 或纯文本时，可先用 `scripts/scaffold-plan.mjs` 生成草稿；草稿不会自动获得事实、设计、权属或交付审批。

完整字段和责任边界见 [SKILL.md](SKILL.md) 与 [Plan 2.0 契约](references/plan-contract.md)。

## 快速开始

在本 Skill 目录执行：

```bash
npm ci
npx playwright install chromium
node scripts/run-pipeline.mjs presentation-plan.json ./output
```

输出包含离线 HTML、全尺寸预览、来源与资产证据、QA 报告；质量与验收通过后还可生成协议 `1.0.0` 的互操作包。

## 推荐提示词

```text
使用 $text-to-html 将【来源文件或文本】制作成面向【受众】、用于【目的】的 16:9 离线 HTML 演示文稿，输出到【目录】。先完成并审核 Plan 2.0；不得编造事实、来源、资产权属或审批。运行完整浏览器 QA，仅在 qa-report.json 为 passed，且所有 attention-required 项均已由 Host 复核后交付。
```

## 交付边界

- `qa-report.json` 和 `presentation-package.json.validation.status` 都必须为 `passed`。
- `visual-scorecard.json` 为 `attention-required` 时，必须由 Host 提供与当前证据绑定的逐项决策；脚本不会代替 Host 审批。
- 所有运行资产必须本地化并保留来源与权属记录；拒绝绝对路径、目录遍历、符号链接和缺失资源。
- 脚本确定性运行，不调用 LLM，也不补写事实、品牌、来源或审批。Plan 1.x 会以 `E_PLAN_VERSION` 拒绝。
