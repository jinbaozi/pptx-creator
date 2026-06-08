# pptx-creator

`pptx-creator` is a portable agent skill and deterministic rendering toolkit for producing beautiful, mostly editable PowerPoint files from text, HTML, images, PDFs, and host-agent-authored deck manifests.

`pptx-creator` 是一个面向智能体的可移植 PPTX 生成工具包。它将大模型或宿主 Agent 生成的 `deck.manifest.json` 渲染为尽量可编辑的 PowerPoint 文件，并支持文本生成、HTML 转换、图片/截图复刻、PDF 页面输入、视觉回归和质量检查。

---

## 中文版

### 功能介绍

`pptx-creator` 的目标是让 Agent 负责理解、策划、写作和设计，让脚本负责确定性校验与渲染。最终输出的是可在 PowerPoint/WPS 中继续编辑的 `.pptx`，而不是简单的整页截图。

核心能力：

- **文本到 PPTX**：宿主 Agent 根据原始文本生成大纲、页面结构、文案和 `deck.manifest.json`，再由工具渲染成 PPTX。
- **HTML 到可编辑 PPTX**：支持语义 HTML、CSS 定位 HTML、DOM 测量、远程图片本地化和多页 HTML。
- **图片/截图复刻**：提供图片尺寸、色板、布局带、对象提示、OCR、裁切资产等辅助工具，由 Agent 重建可编辑对象。
- **PDF 页面输入**：将 PDF 页面渲染为 PNG 参考图，再进入图片到 PPTX 的提示流程。
- **设计系统驱动**：所有视觉样式由 `DESIGN.md` 提供，包括颜色、字体、组件、布局和导出规则。
- **原生可编辑对象优先**：支持文本框、形状、线条、表格、图片、图表和基础图标。
- **内置主题包**：提供商务、科技、数据看板、政府汇报、产品路演、金融董事会等场景风格。
- **联网增强策略**：宿主 Agent 可自行判断是否联网搜索事实、素材、视觉参考和行业内容，并记录来源与版权/商标限制。
- **质量检查**：包含 manifest 校验、PPTX 渲染报告、可编辑性报告、WPS 兼容性报告、OpenXML 检查、可访问性检查和视觉回归。
- **跨 Agent 使用**：提供 Codex、Claude Code、Cursor 等宿主适配说明。

适合场景：

- 业务汇报、路演 PPT、技术架构说明、产品版本说明、课程讲义、数据看板、投融资材料、政务/公共部门汇报。
- 将已有 HTML 页面、图片型幻灯片、PDF 页面重建为更可编辑的 PPTX。
- 让大模型完成内容策划和页面设计，同时用确定性脚本保证输出结构稳定。

### 设计原则

- **Manifest first**：`deck.manifest.json` 是 Agent 推理和渲染器之间的契约。
- **Design-system guided**：生成前必须选择或读取 `DESIGN.md`。
- **Editable first**：优先使用 PPT 原生对象，只有照片、复杂纹理、复杂图标、阴影和不可拆分区域才使用图片。
- **Deterministic scripts**：脚本不调用 LLM API，不自行发明内容；所有内容判断由宿主 Agent 完成。
- **Source-safe assets**：远程素材必须保存到本地 `output/assets/` 后再进入 manifest。
- **Honest reporting**：如果依赖缺失或区域被图像化，必须在报告或最终回复中说明。

### 安装部署

#### 1. 环境要求

必需：

- Node.js 20+
- npm
- Python 3.10+

建议：

- Windows PowerShell、macOS Terminal 或 Linux shell
- PowerPoint 或 WPS，用于人工打开和检查最终 PPTX

可选：

- Playwright Chromium：用于 CSS 定位 HTML 的 DOM 测量。
- Tesseract OCR：用于本地 OCR。
- LibreOffice：用于 PPTX 预览渲染和视觉回归。
- PyMuPDF：用于 PDF 页面渲染。

#### 2. 安装 Node 依赖

```bash
npm install
```

主要 Node 依赖：

- `pptxgenjs`：生成 PPTX。
- `jszip`：读取和检查 PPTX/OpenXML 包。
- `node-html-parser`：解析 HTML。
- `yaml`：解析 `DESIGN.md` frontmatter。
- `playwright`：开发依赖，用于 HTML DOM 测量。
- `vitest`：JavaScript 测试框架。

#### 3. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

主要 Python 依赖：

- `Pillow`：图片读取、裁切、色板分析。
- `pytesseract`：可选 OCR 封装，需要系统安装 Tesseract。
- `PyMuPDF`：可选 PDF 页面渲染。

#### 4. 安装 Playwright 浏览器

```bash
npx playwright install chromium
```

仅在需要 `measure-html.mjs` 或 Playwright 集成测试时必需。

#### 5. 初始化示例文件

```bash
node scripts/setup.mjs
```

### 快速开始

运行内置文本示例：

```bash
node scripts/run-deck-pipeline.mjs examples/text-input/deck.manifest.json output
```

成功后会生成：

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

分步运行：

```bash
node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md
python scripts/validate-manifest.py examples/text-input/deck.manifest.json
node scripts/render-pptx.mjs examples/text-input/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

### 整体架构

```text
User input
  text / markdown / HTML / image / PDF / mixed references
        |
        v
Host Agent
  Planner: audience, story, outline, slide plan
  Writer: claims, copy, tables, charts, speaker notes
  Designer: DESIGN.md selection, layout, visual system
  Researcher: optional web search, source tracking, asset discovery
        |
        v
deck.manifest.json
  version, designSystem, deck, assets, slides, elements
        |
        v
Deterministic helpers
  validate-manifest.py
  parse-design-md.mjs
  html-to-manifest.mjs
  measure-html.mjs
  image/pdf hint scripts
        |
        v
Renderer
  render-pptx.mjs with PptxGenJS
        |
        v
Reports and QA
  editable-report.md
  qa-report.md
  compatibility-report.md
  accessibility-report.md
  openxml-repair-report.json
  visual-regression-report.json
        |
        v
final.pptx
```

架构分层：

| 层级 | 职责 | 代表文件 |
| --- | --- | --- |
| Agent 规范 | 定义宿主 Agent 如何使用工具 | `SKILL.md`, `AGENT.md`, `adapters/*.md` |
| 参考文档 | 描述 workflow、manifest、HTML、图片、QA 规则 | `references/*.md` |
| 设计系统 | 提供可复用视觉 token 和导出规则 | `design-systems/*/DESIGN.md` |
| Manifest | PPTX 内容和布局契约 | `schemas/deck.schema.json`, `examples/*/deck.manifest.json` |
| 转换工具 | HTML、图片、PDF、模板等输入转提示或 manifest | `scripts/html-to-manifest.mjs`, `scripts/pdf-to-page-hints.py`, `scripts/import-template.mjs` |
| 渲染器 | 将 manifest 渲染为 PPTX | `scripts/render-pptx.mjs` |
| 管线 | 校验、渲染、打包、批量、视觉回归 | `scripts/run-deck-pipeline.mjs`, `scripts/run-batch-pipeline.mjs`, `scripts/run-visual-regression.mjs` |
| 测试 | JS/Python 回归测试 | `tests/*.mjs`, `tests/*_test.py` |

### 输入流程

#### 文本 / Markdown 输入

文本输入由宿主 Agent 生成页面大纲、文案和 manifest：

```text
用户内容
  -> Agent 可选联网核验事实、补充术语、寻找视觉参考
  -> Agent 选择 DESIGN.md
  -> Agent 编写 deck.manifest.json
  -> run-deck-pipeline.mjs
  -> 读取报告并回复用户
```

参考：

- `references/workflow.md`
- `references/prompt-library.md`
- `examples/text-input/`

设计优先（design-first）创意 PPTX 在渲染之前会先生成三份中间产物：`deck.storyboard.json`、`deck.design-direction.json` 和 `slide-design-specs.json`。这样在编译为 manifest 之前，故事、视觉方向和页面结构都已显式表达。

#### HTML 输入

语义 HTML：

```bash
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

CSS 定位 HTML：

```bash
node scripts/measure-html.mjs input.html output/layout-measurements.json
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

说明：

- `.pptx-slide` 可表示单页。
- `[data-pptx-kind]` 和 `[data-pptx-id]` 可标记需要测量的元素。
- HTML 中的远程图片会被本地化到输出目录的 `assets/` 下。
- 严格 1:1 复刻时，外部素材只能用于补齐缺失资源，不得改变原始视觉。

#### 图片 / 截图输入

```bash
python scripts/inspect-image.py reference.png
python scripts/image-to-manifest-hints.py reference.png output/image-hints.json
python scripts/ocr-image.py reference.png -o output/ocr.json
python scripts/extract-palette.py reference.png output/palette.json
python scripts/crop-assets.py reference.png crops.json output/assets
```

宿主 Agent 根据提示和视觉盘点完成 manifest，再运行管线：

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

#### PDF 页面输入

```bash
node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

如果 PyMuPDF 未安装，该命令会返回 `status: deferred`，宿主 Agent 应诚实报告依赖缺口。

#### 模板导入

```bash
node scripts/import-template.mjs template.pptx output/template-summary.json
```

该命令提取 PPTX 模板中的 slide/layout/master/theme 计数和主题色摘要。它不会克隆品牌资产。

### 常用命令

| 任务 | 命令 |
| --- | --- |
| 初始化 | `node scripts/setup.mjs` |
| 校验设计系统 | `node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md` |
| 校验 manifest | `python scripts/validate-manifest.py output/deck.manifest.json` |
| 渲染 PPTX | `node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx` |
| 一键管线 | `node scripts/run-deck-pipeline.mjs output/deck.manifest.json output` |
| HTML 转 manifest | `node scripts/html-to-manifest.mjs input.html output/deck.manifest.json` |
| HTML DOM 测量 | `node scripts/measure-html.mjs input.html output/layout-measurements.json` |
| 图片提示 | `node scripts/run-python.mjs scripts/image-to-manifest-hints.py reference.png output/image-hints.json` |
| PDF 页面提示 | `node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json` |
| 批量运行 | `node scripts/run-batch-pipeline.mjs batch.json output/batch` |
| 视觉回归 | `node scripts/run-visual-regression.mjs output/deck.manifest.json output --reference-dir baselines` |
| 可访问性检查 | `node scripts/analyze-accessibility.mjs output/deck.manifest.json output/accessibility-report.md` |
| OpenXML 检查 | `node scripts/openxml-repair.mjs output/final.pptx output/openxml-repair-report.json` |

### Manifest 概览

最小结构：

```json
{
  "version": "0.1.1",
  "designSystem": {
    "source": "../../design-systems/business-neutral/DESIGN.md",
    "name": "Business Neutral",
    "mode": "balanced"
  },
  "deck": {
    "title": "Example Deck",
    "language": "zh-CN",
    "size": { "preset": "wide", "width": 13.333, "height": 7.5, "unit": "in" }
  },
  "assets": [],
  "slides": [
    {
      "id": "slide-001",
      "type": "content",
      "title": "Example",
      "notes": "",
      "background": { "type": "solid", "color": "{colors.background}" },
      "elements": [
        {
          "type": "text",
          "id": "title-001",
          "text": "Example",
          "x": 0.8,
          "y": 0.6,
          "w": 8.0,
          "h": 0.7,
          "style": { "typography": "{typography.title}", "color": "{colors.text}" }
        }
      ]
    }
  ]
}
```

支持元素：

- `text`
- `shape`
- `line`
- `image`
- `table`
- `chart`，支持 `bar`、`line`、`pie`
- `icon`，支持 `check`、`x`、`info`、`arrow-right`

### 内置设计系统

| 设计系统 | 适用场景 |
| --- | --- |
| `business-neutral` | 企业汇报、技术方案、产品总结 |
| `warm-editorial` | 课程、白皮书、研究报告、内容型页面 |
| `paper-minimal` | 中文讲义、学术材料、纸面风格课件 |
| `dark-tech` | AI、云、安全、基础设施、开发者工具 |
| `ai-infra` | 模型平台、AI 基础设施、推理系统、工具链路演 |
| `developer-docs` | 技术文档、架构解释、API/平台说明 |
| `dashboard-data` | 数据分析、监控、运营复盘 |
| `premium-black` | 高端封面、硬科技发布、电影感品牌页 |
| `enterprise-blueprint` | 咨询风企业战略和转型汇报 |
| `executive-crimson` | 正式领导汇报、审计、里程碑总结 |
| `finance-boardroom` | KPI 复盘、投资备忘录、董事会分析 |
| `chinese-government` | 政务、公共部门、操作系统、正式汇报 |
| `product-roadshow` | 产品发布、路演、商业计划书、销售材料 |

用户提供的 `DESIGN.md` 优先级最高。内置设计系统只是通用场景基线，不代表真实品牌模板，不应自动加入 Logo、商标素材或商业字体。

### 输出报告

一键管线会生成：

- `final.pptx`：最终 PPTX。
- `deck.manifest.json`：渲染使用的 manifest 副本。
- `editable-report.md`：页数、原生文本数量、图像化对象数量、可编辑性等级。
- `qa-report.md`：设计系统、渲染状态、布局摘要和风险。
- `compatibility-report.md`：WPS/PowerPoint 可移植性风险。
- `output-manifest.json`：打包摘要。

可选报告：

- `accessibility-report.md`
- `openxml-repair-report.json`
- `visual-regression-report.json`
- `preview/`
- `layout-measurements.json`
- `image-hints.json`
- `pdf-page-hints.json`
- `ocr.json`
- `template-summary.json`

### 联网搜索和素材策略

宿主 Agent 可以全程联网搜索相关内容、资料、素材和视觉参考。搜索由 Agent 自行判断，不是强制步骤。

推荐搜索：

- 事实、日期、标准、技术版本、行业背景可能不稳定。
- 页面需要更好的素材、视觉参考、图标方向或版式灵感。
- 用户明确允许或要求联网搜索。

限制：

- 不要编造事实、指标、案例、引用或来源。
- 搜索得到的重要事实和素材应保留来源 URL。
- 不要滥用 Logo、商标、版权图片、商业字体或品牌专属素材。
- 远程图片必须先保存到本地，manifest 只引用本地相对路径。
- 严格 1:1 复刻任务不能因为外部参考改变原始设计。

### Visual Ceiling Roadmap

The design-first pipeline is the foundation for higher-quality creative decks. Future roadmap items include a Visual Workbench for browser-based preview, direction selection, repair comparison, and export, plus Screenshot-Level Vision Model Review for slide PNG evaluation with a vision-capable model.

### 测试与验证

运行 JavaScript 测试：

```bash
npm test
```

运行 Python 测试：

```bash
npm run test:py
```

语法检查示例：

```bash
node --check scripts/render-pptx.mjs
```

Playwright 集成测试默认可跳过；本地需要时可安装 Chromium 后运行相关测试。

### 故障排查

| 问题 | 处理方式 |
| --- | --- |
| `Python not found` | 设置 `PPTX_CREATOR_PYTHON` 或安装 Python 3.10+ |
| 图片路径缺失 | 确认 manifest 中 `image.src` 是相对 manifest 的本地路径 |
| 远程图片渲染失败 | 先保存到 `output/assets/`，再引用本地路径 |
| PDF hints 返回 `status: deferred` | 安装 `PyMuPDF` |
| OCR 不可用 | 安装系统 Tesseract，并安装 `pytesseract` |
| 预览或视觉回归 deferred | 安装 LibreOffice |
| 文本溢出 | 缩短文案、增加文本框高度、拆页，不要用整页截图掩盖 |
| 可编辑性低 | 将文本、表格、几何图形从图片替换为 PPT 原生对象 |

### 目录结构

```text
pptx-creator/
  adapters/              # Codex, Claude Code, Cursor 使用说明
  design-systems/        # 内置 DESIGN.md 设计系统
  examples/              # 文本、HTML、图片输入示例
  references/            # 工作流、manifest、HTML、图片、QA 参考文档
  schemas/               # deck manifest JSON schema
  scripts/               # 渲染、转换、检查、批量、视觉回归工具
  scripts/lib/           # JS/Python 工具库
  tests/                 # Vitest 和 Python unittest
  AGENT.md               # 宿主 Agent 操作指南
  SKILL.md               # Agent skill 描述
  README.md              # 本文档
```

---

## English

### Features

`pptx-creator` separates reasoning from rendering. The host agent plans the story, writes content, chooses layout, and authors `deck.manifest.json`; deterministic scripts validate the manifest and render a mostly editable PowerPoint file.

Key features:

- **Text to PPTX**: generate an outline, slide structure, copy, and manifest from raw text.
- **HTML to editable PPTX**: convert semantic HTML or CSS-positioned HTML into editable slide elements.
- **Image and screenshot reconstruction**: inspect images, extract palettes, create layout hints, run optional OCR, and crop complex assets.
- **PDF page input**: render PDF pages into PNG references and reuse the image-to-PPTX hint workflow.
- **DESIGN.md driven styling**: every deck is guided by design tokens, component rules, and export rules.
- **Editable-native rendering**: prefer PowerPoint text boxes, shapes, lines, tables, charts, and simple icons.
- **Built-in design systems**: business, technology, dashboard, government, product roadshow, finance, and editorial styles.
- **Optional web research**: host agents may search for facts, source material, visual references, and assets when it improves quality.
- **Quality reports**: editability, QA, WPS compatibility, accessibility, OpenXML inspection, visual regression, and packaging reports.
- **Cross-agent support**: adapter notes for Codex, Claude Code, and Cursor.

### Design Principles

- **Manifest first**: `deck.manifest.json` is the contract between agent reasoning and deterministic rendering.
- **Design-system guided**: every run should select or read a `DESIGN.md`.
- **Editable first**: use native PowerPoint objects whenever possible.
- **Deterministic scripts**: package scripts do not call LLM APIs or invent content.
- **Source-safe assets**: remote assets must be saved locally before rendering.
- **Honest reporting**: missing dependencies and rasterized regions are reported clearly.

### Installation

#### Requirements

Required:

- Node.js 20+
- npm
- Python 3.10+

Recommended:

- PowerPoint or WPS for final manual inspection

Optional:

- Playwright Chromium for DOM measurement
- Tesseract OCR for local OCR
- LibreOffice for preview rendering and visual regression
- PyMuPDF for PDF page rendering

#### Install Node dependencies

```bash
npm install
```

Main Node dependencies:

- `pptxgenjs` for PPTX generation
- `jszip` for PPTX/OpenXML package inspection
- `node-html-parser` for HTML parsing
- `yaml` for `DESIGN.md` frontmatter parsing
- `playwright` for DOM measurement
- `vitest` for JavaScript tests

#### Install Python dependencies

```bash
pip install -r requirements.txt
```

Main Python dependencies:

- `Pillow` for image analysis and cropping
- `pytesseract` for optional OCR
- `PyMuPDF` for optional PDF rendering

#### Install Playwright Chromium

```bash
npx playwright install chromium
```

#### Initialize examples

```bash
node scripts/setup.mjs
```

### Quick Start

Run the sample deck pipeline:

```bash
node scripts/run-deck-pipeline.mjs examples/text-input/deck.manifest.json output
```

Expected output:

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

Run the same flow step by step:

```bash
node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md
python scripts/validate-manifest.py examples/text-input/deck.manifest.json
node scripts/render-pptx.mjs examples/text-input/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

### Architecture

```text
User input
  text / markdown / HTML / image / PDF / mixed references
        |
        v
Host Agent
  Planner: audience, story, outline, slide plan
  Writer: claims, copy, tables, charts, speaker notes
  Designer: DESIGN.md selection, layout, visual system
  Researcher: optional web search, source tracking, asset discovery
        |
        v
deck.manifest.json
        |
        v
Deterministic helpers
  validation, parsing, HTML conversion, DOM measurement, image/PDF hints
        |
        v
Renderer
  render-pptx.mjs with PptxGenJS
        |
        v
Reports and QA
        |
        v
final.pptx
```

Layers:

| Layer | Responsibility | Files |
| --- | --- | --- |
| Agent contract | How host agents use the package | `SKILL.md`, `AGENT.md`, `adapters/*.md` |
| References | Workflow, manifest, HTML, image, and QA guidance | `references/*.md` |
| Design systems | Reusable design tokens and export rules | `design-systems/*/DESIGN.md` |
| Manifest | Slide content and layout contract | `schemas/deck.schema.json`, `examples/*/deck.manifest.json` |
| Conversion tools | HTML, image, PDF, and template inputs | `scripts/html-to-manifest.mjs`, `scripts/pdf-to-page-hints.py`, `scripts/import-template.mjs` |
| Renderer | Manifest to PPTX | `scripts/render-pptx.mjs` |
| Pipelines | Validation, rendering, packaging, batch, visual regression | `scripts/run-deck-pipeline.mjs`, `scripts/run-batch-pipeline.mjs`, `scripts/run-visual-regression.mjs` |
| Tests | JavaScript and Python regression tests | `tests/*.mjs`, `tests/*_test.py` |

### Workflows

#### Text or Markdown

```text
User content
  -> optional web research
  -> choose DESIGN.md
  -> author deck.manifest.json
  -> run-deck-pipeline.mjs
  -> read reports and respond
```

See:

- `references/workflow.md`
- `references/prompt-library.md`
- `examples/text-input/`

Design-first creative decks use three intermediate artifacts before rendering: `deck.storyboard.json`, `deck.design-direction.json`, and `slide-design-specs.json`. This keeps story, visual direction, and page composition explicit before the manifest is compiled.

#### HTML

Semantic HTML:

```bash
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

CSS-positioned HTML:

```bash
node scripts/measure-html.mjs input.html output/layout-measurements.json
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

Notes:

- `.pptx-slide` marks a slide.
- `[data-pptx-kind]` and `[data-pptx-id]` mark measurable elements.
- Remote images in HTML are localized under `assets/`.
- For strict 1:1 replicas, outside references must not alter the original design.

#### Image or Screenshot

```bash
python scripts/inspect-image.py reference.png
python scripts/image-to-manifest-hints.py reference.png output/image-hints.json
python scripts/ocr-image.py reference.png -o output/ocr.json
python scripts/extract-palette.py reference.png output/palette.json
python scripts/crop-assets.py reference.png crops.json output/assets
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

#### PDF Pages

```bash
node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

If PyMuPDF is missing, the command returns `status: deferred`.

#### Template Import

```bash
node scripts/import-template.mjs template.pptx output/template-summary.json
```

This summarizes slide, layout, master, theme, and color information. It does not clone brand assets.

### Common Commands

| Task | Command |
| --- | --- |
| Setup | `node scripts/setup.mjs` |
| Validate design system | `node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md` |
| Validate manifest | `python scripts/validate-manifest.py output/deck.manifest.json` |
| Render PPTX | `node scripts/render-pptx.mjs output/deck.manifest.json output/final.pptx` |
| Run pipeline | `node scripts/run-deck-pipeline.mjs output/deck.manifest.json output` |
| HTML to manifest | `node scripts/html-to-manifest.mjs input.html output/deck.manifest.json` |
| Measure HTML | `node scripts/measure-html.mjs input.html output/layout-measurements.json` |
| Image hints | `node scripts/run-python.mjs scripts/image-to-manifest-hints.py reference.png output/image-hints.json` |
| PDF hints | `node scripts/run-python.mjs scripts/pdf-to-page-hints.py source.pdf output/pdf-pages -o output/pdf-page-hints.json` |
| Batch pipeline | `node scripts/run-batch-pipeline.mjs batch.json output/batch` |
| Visual regression | `node scripts/run-visual-regression.mjs output/deck.manifest.json output --reference-dir baselines` |
| Accessibility check | `node scripts/analyze-accessibility.mjs output/deck.manifest.json output/accessibility-report.md` |
| OpenXML check | `node scripts/openxml-repair.mjs output/final.pptx output/openxml-repair-report.json` |

### Manifest Overview

Minimal structure:

```json
{
  "version": "0.1.1",
  "designSystem": {
    "source": "../../design-systems/business-neutral/DESIGN.md",
    "name": "Business Neutral",
    "mode": "balanced"
  },
  "deck": {
    "title": "Example Deck",
    "language": "en-US",
    "size": { "preset": "wide", "width": 13.333, "height": 7.5, "unit": "in" }
  },
  "assets": [],
  "slides": [
    {
      "id": "slide-001",
      "type": "content",
      "title": "Example",
      "notes": "",
      "background": { "type": "solid", "color": "{colors.background}" },
      "elements": [
        {
          "type": "text",
          "id": "title-001",
          "text": "Example",
          "x": 0.8,
          "y": 0.6,
          "w": 8.0,
          "h": 0.7,
          "style": { "typography": "{typography.title}", "color": "{colors.text}" }
        }
      ]
    }
  ]
}
```

Supported element types:

- `text`
- `shape`
- `line`
- `image`
- `table`
- `chart` with `bar`, `line`, or `pie`
- `icon` with `check`, `x`, `info`, or `arrow-right`

### Built-in Design Systems

| Design system | Use case |
| --- | --- |
| `business-neutral` | Enterprise briefings, technical proposals, product summaries |
| `warm-editorial` | Courses, whitepapers, research reports |
| `paper-minimal` | Chinese handouts, academic material, lecture decks |
| `dark-tech` | AI, cloud, security, infrastructure, developer tools |
| `ai-infra` | Model platforms, AI infrastructure, inference systems |
| `developer-docs` | Technical docs, architecture explainers, API/platform decks |
| `dashboard-data` | Analytics, observability, monitoring, operations reviews |
| `premium-black` | Premium covers, hard-tech launches, cinematic brand pages |
| `enterprise-blueprint` | Enterprise strategy and transformation decks |
| `executive-crimson` | Formal leadership reports, audits, milestone summaries |
| `finance-boardroom` | KPI reviews, investment memos, boardroom analysis |
| `chinese-government` | Government, public sector, operating systems, formal reports |
| `product-roadshow` | Product launches, roadshows, business plans, sales decks |

User-provided `DESIGN.md` files override built-ins. Built-ins are generic scenario baselines, not real-brand templates.

### Reports

Pipeline output:

- `final.pptx`: generated presentation
- `deck.manifest.json`: manifest copy used for rendering
- `editable-report.md`: slide count, native text count, rasterized object count, editability level
- `qa-report.md`: design system, render status, layouts, risks
- `compatibility-report.md`: WPS/PowerPoint portability risks
- `output-manifest.json`: package summary

Optional output:

- `accessibility-report.md`
- `openxml-repair-report.json`
- `visual-regression-report.json`
- `preview/`
- `layout-measurements.json`
- `image-hints.json`
- `pdf-page-hints.json`
- `ocr.json`
- `template-summary.json`

### Web Search and Assets

Host agents may search the web for content, source material, visual references, and assets. Search is optional and agent-decided.

Use search when:

- facts, dates, standards, versions, or market context may be current or uncertain;
- better visual references, image素材, or layout inspiration would improve the deck;
- the user explicitly allows or requests web search.

Rules:

- Do not invent facts, metrics, examples, citations, or sources.
- Keep important source URLs.
- Respect copyright, licenses, trademarks, logos, brand assets, and commercial fonts.
- Save remote assets locally before rendering.
- Do not alter strict 1:1 replicas with outside references.

### Visual Ceiling Roadmap

The design-first pipeline is the foundation for higher-quality creative decks. Future roadmap items include a Visual Workbench for browser-based preview, direction selection, repair comparison, and export, plus Screenshot-Level Vision Model Review for slide PNG evaluation with a vision-capable model.

### Visual Workbench

Open `workbench/index.html` in a browser and load a generated `run.json` file to inspect run status, direction candidates, preview paths, and review artifacts. The first workbench is read-only and does not edit PPTX files.

### Tests

JavaScript tests:

```bash
npm test
```

Python tests:

```bash
npm run test:py
```

Syntax check example:

```bash
node --check scripts/render-pptx.mjs
```

### Troubleshooting

| Problem | Fix |
| --- | --- |
| `Python not found` | Install Python 3.10+ or set `PPTX_CREATOR_PYTHON` |
| Missing image path | Ensure `image.src` is a local path relative to the manifest |
| Remote image render failure | Save it under `output/assets/` and reference the local path |
| PDF hints are deferred | Install `PyMuPDF` |
| OCR unavailable | Install system Tesseract and `pytesseract` |
| Preview or visual regression deferred | Install LibreOffice |
| Text overflow | Shorten copy, resize text boxes, or split slides |
| Low editability | Replace raster regions with native text, tables, and shapes |

### Project Structure

```text
pptx-creator/
  adapters/              # Codex, Claude Code, Cursor notes
  design-systems/        # Built-in DESIGN.md profiles
  examples/              # Text, HTML, and image examples
  references/            # Workflow, manifest, HTML, image, QA references
  schemas/               # Deck manifest JSON schema
  scripts/               # Rendering, conversion, QA, batch, visual tools
  scripts/lib/           # Shared JS/Python helpers
  tests/                 # Vitest and Python unittest suites
  AGENT.md               # Host-agent operating guide
  SKILL.md               # Agent skill metadata and rules
  README.md              # This document
```
