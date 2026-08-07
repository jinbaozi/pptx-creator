# image-to-pptx

从 PNG、JPEG、截图或参考幻灯片重建以原生对象为主的可编辑 PPTX。只还原图片中可见且有证据的内容，不猜测模糊文字、图表数据或品牌信息。

## 快速使用

在本 Skill 目录执行：

```bash
npm install
python3 -m pip install -r requirements.txt
node scripts/image-to-pptx.mjs doctor
node scripts/image-to-pptx.mjs build --output ./output slide-01.png slide-02.png
```

主机需要 Tesseract、LibreOffice 和 `pdftoppm`；Python 依赖还包括 Pillow、pytesseract、NumPy、scikit-image 与 fontTools。图片按命令行顺序成为幻灯片；`--langs` 支持 `eng`、`chi_sim+eng` 或必须有 OSD 脚本证据的 `auto`，缺少解析出的语言包会稳定失败。分析结果还会输出可审计的页面/布局区域画像、区域 OCR PSM 选择和预算延期原因，以及三路线区域候选计划和独立报告 digest。详细契约见 [SKILL.md](SKILL.md) 和 [references/input-output-contract.md](references/input-output-contract.md)。

## 推荐提示词

```text
使用 $image-to-pptx 按顺序将【图片路径】重建为可编辑 PPTX。严格执行 SKILL.md，先运行 node scripts/image-to-pptx.mjs doctor，再运行 node scripts/image-to-pptx.mjs build --output 【目录】 【图片路径】；仅还原可确认内容，不猜测低置信文字、图表数据或品牌，禁止整页背景图。仅在 qa-report.json 为 passed、final.pptx 与本次输入的回渲证据一致时交付。
```

## 交付标准

- `qa-report.json` 必须为 `passed`，且 `final.pptx` 来自同一批输入的回渲证据。
- 保留 OCR 置信度、场景分析、降级和校准报告；低置信文本不得被猜写。区域 QA 从真实 source/preview crop 记录 SSIM、CER、bbox、MAE、色彩、areaShare、severityWeight 与稳定 top-5 impact；不可测项带原因，不以 planner 估值替代。
- 只有可靠源数据才能生成原生图表；禁止把整张参考图作为幻灯片背景。
- `analysis.json` 与 `reports/reconstruction-plan.json` 必须记录每个区域的三条可执行路线、硬 gate、确定性 loss/tie-break、唯一 object/asset coverage；渲染只使用 winner refs，计划或报告篡改会 fail closed。
