# image-to-pptx

将 PNG、JPEG、WebP、截图或参考幻灯片重建为以原生对象为主的可编辑 PPTX。只还原图片中可见且有证据的内容，不猜测模糊文字、图表数据、品牌或事实，也不把整张参考图作为幻灯片背景。

## 输入与环境

- 接受一个或多个本地图片或图片目录；页面按命令行或文件名顺序排列，宽高比差异不得超过 1%。
- 需要 Node.js 20+、Python、Tesseract、LibreOffice、`pdftoppm`，以及 `requirements.txt` 中的 OCR、图像和字体依赖。
- `--langs` 可使用已安装的 `eng`、`chi_sim+eng` 或有 OSD 脚本证据的 `auto`；不会静默替换缺失语言包。

完整限制和产物定义见 [SKILL.md](SKILL.md) 与 [输入输出契约](references/input-output-contract.md)。

## 快速开始

在本 Skill 目录执行：

```bash
npm ci
python3 -m pip install -r requirements.txt
node scripts/image-to-pptx.mjs doctor
node scripts/image-to-pptx.mjs build --output ./output slide-01.png slide-02.png
```

默认同时生成可选的独立 HTML 协议包；不需要时添加 `--no-html-package`。该包可显式交给兼容的 `html-to-pptx`，但本 Skill 不依赖其他 Skill 运行。

## 推荐提示词

```text
使用 $image-to-pptx 按顺序将【图片路径】重建为可编辑 PPTX，输出到【目录】，OCR 语言使用【eng、chi_sim+eng 或 auto】。先运行 doctor；只还原可确认内容，不补写低置信文字、图表数据、品牌或事实，复杂区域仅允许有证据的局部栅格降级，禁止整页背景图。仅在 qa-report.json 为 passed、final.pptx 与本次输入及回渲证据一致时交付。
```

## 交付边界

- 低于 OCR 置信阈值的文字保留为有标记的局部裁剪并写入报告，不得猜写为可编辑文本。
- 只有可追溯的真实源数据才能生成原生图表；否则保留可见几何或有边界的局部裁剪。
- `qa-report.json` 必须为 `passed`，`final.pptx`、预览、分析、来源和 QA 必须由同一运行摘要绑定。
- 失败运行只保留 `failed-candidate.pptx`、`failure.json` 和诊断证据，不得重命名或描述为最终交付。
- 每个 Skill 必须独立安装和运行；可选协议包是互操作产物，不是兄弟 Skill 依赖。
