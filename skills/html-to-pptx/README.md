# html-to-pptx

将本地 HTML 演示文稿或兼容的 `presentation-package.json` 转换为以原生对象为主的可编辑 PPTX。浏览器渲染结果是视觉基线，不使用整页截图替代可编辑对象。

## 快速使用

在本 Skill 目录执行：

```bash
npm ci
npx playwright install chromium
python3 -m pip install -r requirements.txt
node scripts/convert.mjs ./input.html ./output
```

主机还需要 LibreOffice 和 `pdftoppm`，用于 PPTX 回渲验证。输入可以是单个 HTML、包含 `index.html` 的目录，或协议版本为 `1.0.0` 的演示包。详细契约见 [SKILL.md](SKILL.md) 和 [references/input-output-contract.md](references/input-output-contract.md)。

## 推荐提示词

```text
使用 $html-to-pptx 将【HTML 文件、目录或 presentation-package.json】转换为可编辑 PPTX；保持内容和版式一致，优先使用原生文字、形状、图片、表格和可恢复图表，禁止整页截图；仅在 qa-report.json 为 passed、可编辑性等级至少为 3 且原生覆盖率至少为 0.90 时输出【目录】/final.pptx。
```

## 交付标准

- 输出 `final.pptx` 及完整的布局、可编辑性、回渲和视觉 QA 报告。
- `qa-report.json` 必须为 `passed`；存在 `failure-report.json` 时不得宣称成功。
- 所有栅格降级都写入 `fallback-ledger.json`；禁止整页栅格降级。
