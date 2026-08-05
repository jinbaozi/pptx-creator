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

主机需要 Tesseract、LibreOffice 和 `pdftoppm`。图片按命令行顺序成为幻灯片；可用 `--langs` 指定本机已安装的 OCR 语言。详细契约见 [SKILL.md](SKILL.md) 和 [references/input-output-contract.md](references/input-output-contract.md)。

## 推荐提示词

```text
使用 $image-to-pptx 按顺序将【图片路径】重建为可编辑 PPTX；仅还原可见内容，不猜测低置信 OCR、模糊文字或图表数据；文字、形状、线条和可靠表格优先使用原生对象，复杂区域只允许局部裁剪；通过 QA 后输出【目录】/final.pptx，并保留置信度与降级报告。
```

## 交付标准

- `qa-report.json` 必须为 `passed`，且 `final.pptx` 来自同一批输入的回渲证据。
- 保留 OCR 置信度、场景分析、降级和校准报告；低置信文本不得被猜写。
- 只有可靠源数据才能生成原生图表；禁止把整张参考图作为幻灯片背景。
