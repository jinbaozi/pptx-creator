# pptx-creator

**中文** | [English](README.en.md)

## 中文版

`pptx-creator` 是一个面向 Agent 的可编辑 PPTX 生成工具包。它让大模型或宿主 Agent 负责理解、策划、写作、设计与必要的联网检索，让本项目的确定性脚本负责校验、转换、渲染、打包和质量检查，最终输出可在 PowerPoint/WPS 中继续编辑的 `.pptx` 文件。

项目核心原则：**先生成结构化 manifest，再确定性渲染 PPTX**。脚本不会调用 LLM API，也不会自行编造内容。

## 适用场景

- 从文本、Markdown 或结构化内容生成商务路演、技术汇报、产品说明、培训课件和研究报告。
- 将语义 HTML 或 CSS 定位 HTML 转换为可编辑 PPTX。
- 将截图、图片型幻灯片或 PDF 页面重建为尽量可编辑的 PPTX。
- 让 Agent 结合设计系统、联网检索、素材 registry 和质量检查，生成更可靠的交付物。
- 批量生成 PPTX，并输出可编辑性、兼容性、可访问性、视觉回归等报告。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 文本到 PPTX | 宿主 Agent 根据原始内容生成故事线、页面结构、文案和 `deck.manifest.json`，再由 pipeline 渲染。 |
| 创意文本生成 | 通过无坐标的 `deck.plan.json -> deck.manifest.json -> PPTX` 流程，让设计判断、叙事节拍和布局族在渲染前可审查。 |
| 布局原型与编译 | 内置 layout archetypes、设计系统解析和 manifest 编译器，把设计规格转换成确定性的 PPTX manifest。 |
| HTML 到 PPTX | 支持语义 HTML、CSS 定位 HTML、DOM 测量、远程图片本地化和多页转换。 |
| 图片/PDF 输入 | 提供图片检查、颜色提取、OCR、裁剪、图片复刻分析、图层规划、PDF 页面 hints 等辅助脚本，由 Agent 重建可编辑对象。 |
| 可编辑渲染 | 优先输出 PPT 原生文本、形状、线条、表格、图表、图标和语义图解。 |
| 图表与图解 | 支持 `bar`、`line`、`pie`、`stackedBar`、`horizontalBar`、`groupedBar`、`kpiGroup`、`sparkline` 等图表，以及 `layeredArchitecture`、`compilerPipeline`、`capabilityStack`、`swimlane`、`matrixMap` 等语义图解，均会展开成可编辑 PPT 原生对象。 |
| 设计系统 | 使用 `DESIGN.md` 提供颜色、字体、组件、布局规则和导出规则。 |
| 视觉评审与修复 | 包含规则化 visual critic、visual review 契约、repair patch、bounded repair loop 和自动修复 CLI；会拦截小字号、越界、过密图表、缺少描述、空图解层和超大空白装饰容器等问题。 |
| 质量检查 | 包含 manifest 校验、可编辑性报告、QA 报告、WPS 兼容性、可访问性、OpenXML 检查和视觉回归。 |
| Registry | 支持来源 registry 和素材 registry，记录事实来源、素材来源、授权状态和使用位置。 |
| Metadata Flow | 将 registry 校验、run index、design-first pipeline flags 和报告产物串联，便于批量生成、审计和复盘。 |

## 安装部署

### 环境要求

必需：

- Node.js 20+
- npm
- Python 3.10+

建议：

- PowerPoint 或 WPS，用于人工检查最终 `.pptx`
- Windows PowerShell、macOS Terminal 或 Linux shell

可选：

- Playwright Chromium：用于 CSS 定位 HTML 的 DOM 测量
- Tesseract OCR：用于本地 OCR
- LibreOffice：用于 PPTX 预览渲染和视觉回归
- PyMuPDF：用于 PDF 页面渲染

### 安装依赖

```bash
npm install
pip install -r requirements-core.txt
npx playwright install chromium
npm run setup -- core
```

如需指定 Python：

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
npm run setup -- core
```

## 快速开始

按 profile 安装 Python 依赖：core 无第三方 Python 包；image 使用
`pip install -r requirements-image.txt`；pdf 使用
`pip install -r requirements-pdf.txt`。HTML 浏览器依赖由 Node/Playwright 提供。

运行内置文本示例：

```bash
npm run pptx -- text examples/text-input/deck.manifest.json output
```

成功后输出：

```text
output/
  final.pptx
  deck.manifest.json
  editable-report.md
  qa-report.md
  compatibility-report.md
  output-manifest.json
```

## Creative deck plan 创作流程

适合从文本生成更精美、更有变化的商务或技术 PPT：

```bash
npm run pptx -- text examples/text-input/creative/deck.plan.json output/creative --creative
```

唯一创意中间产物是无坐标的 `deck.plan.json`：

```text
deck.plan.json
deck.manifest.json
final.pptx
quality-report.json
quality-report.md
preview/index.html
```

deck plan 记录设计判断、三项上下文旋钮、受众、叙事节拍、页面信息、布局族以及内容/素材引用，再由各布局族的真实编译器转成确定性的 `deck.manifest.json`。方向候选仅在存在实质歧义或高风险时可选；HTML 不是文本路线的必经中间层。

## HTML、图片和 PDF 输入

HTML（语义或 CSS 定位）：

```bash
npm run pptx -- html input.html output/html
```

Replica 模式会从浏览器真实渲染结果提取 DOM 坐标与计算样式，优先转成可编辑 PPT 原生文本、形状、表格、线条、图片和单层外阴影；非 `drop-shadow(...)` 滤镜、backdrop-filter、clip-path、复杂渐变、多重阴影等 PPT 原生难以表达的效果会进入视觉评审报告，避免把整页悄悄退化成截图。

图片或截图使用 `npm run pptx -- image reference.png output/image`。管线会执行真实 OCR、颜色/几何检测，生成原生文本、形状和线条，仅把照片或高复杂度局部区域裁剪为图片；随后从 PPTX 重新渲染并校验 SSIM、OCR CER、文本框 IoU、CIEDE2000 色差、OOXML 原生对象与全部 raster 引用。整页或未声明 raster 会直接阻断。

PDF 页面：

严格 PDF 入口为 `npm run pptx -- pdf source.pdf output/pdf`；在 fidelity-proof compiler 尚未实现时会明确阻断。

PDF 支持是页面级 hints：最终仍应由 Agent 重建可编辑文本、形状、表格和图表，而不是直接整页栅格化。

## 质量检查与修复

统一管线负责 layout、taste/fidelity proof、可编辑性、兼容性和一致性报告。自动修复最多三次；候选没有改善时立即停止并保留最佳版本，硬失败不会进入打包。

## 整体架构

```text
User input
  text / markdown / HTML / image / PDF / mixed references
        |
        v
Host Agent
  Planner      -> audience, outline, storyline
  Writer       -> claims, copy, tables, chart data, speaker notes
  Designer     -> DESIGN.md, layouts, components, visual direction
  Researcher   -> optional web search, sources, asset discovery
  Critic       -> review, repair patch, quality gates
        |
        v
Creative intermediate
  deck.plan.json
        |
        v
deck.manifest.json
  version, designSystem, deck, assets, slides, elements
        |
        v
Deterministic scripts
  validate-manifest.py
  deck-plan.mjs
  html-to-manifest.mjs
  measure-html.mjs
  image/pdf hint scripts
  registry/run-index/visual review helpers
        |
        v
Renderer
  render-pptx.mjs + PptxGenJS
        |
        v
Reports and QA
  editable-report.md
  qa-report.md
  compatibility-report.md
  accessibility-report.md
  visual-review.json
  visual-regression-report.json
        |
        v
final.pptx
```

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `SKILL.md` | 通用 Agent Skill 入口、核心契约和按需路由。 |
| `agents/openai.yaml` | Codex/OpenAI 界面元数据；不参与运行时逻辑。 |
| `references/` | 按输入类型和任务阶段渐进加载的详细流程。 |
| `design-systems/` | 内置通用设计系统。 |
| `layout-archetypes/` | 设计优先流程使用的页面布局原型。 |
| `schemas/` | deck、deck plan、registry、repair、review 等 JSON Schema。 |
| `scripts/` | 转换、渲染、校验、修复和回归脚本。 |
| `scripts/lib/` | 可复用核心逻辑。 |
| `references/` | workflow、manifest、HTML/image/PDF 和 QA 参考。 |
| `examples/` | 文本、HTML、图片、design-first 和 visual-roadmap 示例。 |
| `tests/` | JavaScript 与 Python 回归测试。 |

## 内置设计系统

常用设计系统包括：

- `business-neutral`
- `warm-editorial`
- `paper-minimal`
- `dark-tech`
- `ai-infra`
- `product-roadshow`
- `developer-docs`
- `dashboard-data`
- `premium-black`
- `chinese-government`
- `enterprise-blueprint`
- `executive-crimson`
- `finance-boardroom`

用户提供的 `DESIGN.md` 优先级最高。内置系统是安全基线，不是品牌模板，不应加入真实 logo、商标素材或商业字体。

## 常用 npm scripts

| 命令 | 说明 |
| --- | --- |
| `npm run pptx -- ...` | 唯一公开操作入口。 |
| `npm run setup -- core\|html\|image\|pdf` | 检查指定环境 profile。 |
| `npm test` / `npm run test:unit` | JavaScript 单元测试。 |
| `npm run test:browser` | 浏览器集成测试。 |
| `npm run test:visual` | 视觉管线测试。 |
| `npm run test:py` | Python 测试。 |

## 测试

```bash
npm test
npm run test:py
```

## 输出与可编辑性

默认目标是 Level 4 或 Level 5：

- Level 5：主要对象均为 PPT 原生对象。
- Level 4：文本和主视觉结构可编辑，复杂照片/纹理可作为图片。
- Level 3：文本可编辑，但较多视觉对象为图片。
- Level 1-2：主要用于严格截图复刻或用户明确接受低编辑性的场景。

本项目不应把整页截图包装成“可编辑 PPTX”。

## 联网检索与素材策略

宿主 Agent 可以自行判断是否联网检索，以提升事实准确性、术语质量、视觉参考、素材质量和来源追踪。使用外部资料时必须：

- 不编造事实、指标、案例或引用。
- 尊重版权、授权、商标、logo 和字体限制。
- 将远程素材本地化到输出目录后再写入 manifest。
- 在最终回复、QA 记录或 registry 中保留关键来源。

## 许可证

MIT
