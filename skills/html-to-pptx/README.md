# html-to-pptx

将本地 HTML 演示文稿或兼容的 `presentation-package.json` 转换为以原生对象为主的可编辑 PPTX。Chromium 渲染结果是视觉基线；禁止用整页截图冒充可编辑幻灯片。

## 输入与环境

- 输入可以是单个 `.html`/`.htm`、包含 `index.html` 的目录，或协议版本严格为 `1.0.0` 的演示包。
- 需要 Node.js 20+、Python 3.10+、Playwright Chromium、LibreOffice 和 Poppler 的 `pdftoppm`。
- HTML 应使用稳定的桌面布局和本地资源；脚本生成的 DOM、任意响应式重排和高级 CSS 合成效果不属于完整原生映射范围。

完整输入、输出和 CSS 支持范围见 [SKILL.md](SKILL.md)、[输入输出契约](references/input-output-contract.md) 与 [CSS 兼容性说明](references/css-pptx-compatibility.md)。

## 快速开始

在本 Skill 目录执行：

```bash
npm ci
npx playwright install chromium
python3 -m pip install -r requirements.txt
node scripts/convert.mjs ./input.html ./output
```

对视觉复刻敏感的交付使用严格档，并为至少一个稳定关键区域提供 `data-pptx-visual-key="true"`：

```bash
node scripts/convert.mjs ./input.html ./output --quality-profile replica-strict
```

## 推荐提示词

```text
使用 $html-to-pptx 将【HTML 文件、目录或 presentation-package.json】转换为可编辑 PPTX，输出到【目录】。禁止整页栅格替代；对视觉复刻敏感的任务启用 replica-strict，并保留稳定的关键区域标记。运行全部阻塞 QA，逐页检查预览、局部差异、字体替换和 fallback；仅在 final.pptx 存在、qa-report.status 为 passed 且不存在 failure-report.json 时交付。目标 Office 可用时完成实机抽检，否则明确标注未验证边界。
```

## 交付与当前边界

- 默认档要求可编辑性等级至少为 3、`nativeObjectCoverage >= 0.90`，并自动对变换、裁剪图片、图表、表格、分组、SVG、富文本和局部 fallback 等高风险对象执行局部视觉阻断；`replica-strict` 会比较全部显式关键区域并提高阈值。具体规则见 [质量门禁](references/quality-gates.md)。
- 支持的正交二维变换会保留未变换布局框、最终浏览器边界与 PowerPoint 逻辑框；`object-position` 支持关键字、百分比、像素、边偏移和 `calc(% +/- px)`；混合字形会物化为显式字体 run。倾斜、三维变换和任意合成效果仍按局部 fallback 边界处理。
- 所有局部栅格降级必须记录在 `fallback-ledger.json`；任何整页栅格降级都必须失败。
- 仅当 `qa-report.json` 为 `passed`、`final.pptx` 已生成且结构、几何、视觉和可编辑性门禁均通过时交付。存在 `failure-report.json` 时不得宣称成功。
- LibreOffice 回渲不能替代 PowerPoint 或 WPS 的实机验证；字体和版式敏感交付应在目标应用中复核。
- `layout-measurements.json`、`qa-report.json` 和 `compatibility-report.json` 会记录 Chromium、Node、Python、LibreOffice、Poppler 与 Pillow 的实际运行版本，便于复现差异。
