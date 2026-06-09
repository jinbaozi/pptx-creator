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
| Design-first 创作 | 通过 `storyboard -> design direction -> slide design specs -> deck manifest -> PPTX` 的流程，让故事、视觉方向和页面设计在渲染前可审查。 |
| 布局原型与编译 | 内置 layout archetypes、设计系统解析和 manifest 编译器，把设计规格转换成确定性的 PPTX manifest。 |
| 多方向设计探索 | 生成多个设计方向候选、scorecard 和 run index，帮助 Agent 在完整出稿前选择更合适的视觉路线。 |
| HTML 到 PPTX | 支持语义 HTML、CSS 定位 HTML、DOM 测量、远程图片本地化和多页转换。 |
| 图片/PDF 输入 | 提供图片检查、颜色提取、OCR、裁剪、图片复刻分析、图层规划、PDF 页面 hints 等辅助脚本，由 Agent 重建可编辑对象。 |
| 可编辑渲染 | 优先输出 PPT 原生文本、形状、线条、表格、图表、图标和语义图解。 |
| 图表与图解 | 支持 `bar`、`line`、`pie`、`stackedBar`、`horizontalBar`、`groupedBar`、`kpiGroup`、`sparkline` 等图表，以及 `layeredArchitecture`、`compilerPipeline`、`capabilityStack`、`swimlane`、`matrixMap` 等语义图解，均会展开成可编辑 PPT 原生对象。 |
| 设计系统 | 使用 `DESIGN.md` 提供颜色、字体、组件、布局规则和导出规则。 |
| 视觉评审与修复 | 包含规则化 visual critic、visual review 契约、repair patch、bounded repair loop 和自动修复 CLI；会拦截小字号、越界、过密图表、缺少描述、空图解层和超大空白装饰容器等问题。 |
| Screenshot-Level Vision Model Review | 提供 mock CLI、review 合并逻辑和稳定输出契约，为后续接入真实截图级视觉模型评审预留接口。 |
| 质量检查 | 包含 manifest 校验、可编辑性报告、QA 报告、WPS 兼容性、可访问性、OpenXML 检查、视觉回归和截图级视觉评审。 |
| Registry | 支持来源 registry 和素材 registry，记录事实来源、素材来源、授权状态和使用位置。 |
| Metadata Flow | 将 registry 校验、run index、方向探索、design-first pipeline flags 和报告产物串联，便于批量生成、审计和复盘。 |
| Visual Workbench | 提供本地可视化工作台外壳，用于浏览设计方向、报告和生成产物。 |

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

- Playwright Chromium：用于 CSS 定位 HTML 的 DOM 测量和 Workbench 测试
- Tesseract OCR：用于本地 OCR
- LibreOffice：用于 PPTX 预览渲染和视觉回归
- PyMuPDF：用于 PDF 页面渲染

### 安装依赖

```bash
npm install
pip install -r requirements.txt
npx playwright install chromium
node scripts/setup.mjs
```

如需指定 Python：

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
npm run setup
```

## 快速开始

运行内置文本示例：

```bash
npm run pipeline -- examples/text-input/deck.manifest.json output
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

分步执行：

```bash
node scripts/validate-design-md.mjs design-systems/business-neutral/DESIGN.md
python scripts/validate-manifest.py examples/text-input/deck.manifest.json
node scripts/render-pptx.mjs examples/text-input/deck.manifest.json output/final.pptx
python scripts/package-output.py output
```

## Design-first 创作流程

适合从文本生成更精美、更有变化的商务或技术 PPT：

```bash
npm run design:first -- examples/design-first/compiler-roadshow output/design-first/deck.manifest.json
npm run pipeline:design-first -- examples/design-first/compiler-roadshow output/design-first --emit-run-index --validate-registry --run-id compiler-roadshow --input-summary "Compiler Roadshow"
```

核心中间产物（design artifacts）：

```text
deck.storyboard.json
deck.design-direction.json
slide-design-specs.json
deck.manifest.json
final.pptx
visual-review.json
run.json
```

设计产物（design artifacts）由 storyboard、design direction、slide design specs、UI component spec、preview artifacts 等组成，按 schema 落盘后由编译器转成确定性的 `deck.manifest.json`，再渲染为可在 PowerPoint/WPS 中继续编辑的 editable PPTX。preview artifacts 用于离线查看设计走向，screenshot-level review 走 mock provider 边界，未来可平替为真实视觉模型。

多方向探索：

```bash
npm run explore:directions -- examples/design-first/compiler-roadshow/deck.storyboard.json output/directions
```

## HTML、图片和 PDF 输入

语义 HTML：

```bash
npm run html:manifest -- input.html output/deck.manifest.json
npm run pipeline -- output/deck.manifest.json output
```

CSS 定位 HTML：

```bash
npm run html:measure -- input.html output/layout-measurements.json
node scripts/html-to-manifest.mjs input.html output/deck.manifest.json --measurements output/layout-measurements.json
npm run pipeline -- output/deck.manifest.json output
```

图片或截图：

```bash
npm run image:inspect -- reference.png
npm run image:hints -- reference.png output/image-hints.json
npm run image:replica:analyze -- reference.png output/image-replica-analysis.json
npm run image:replica:plan -- output/image-replica-analysis.json output/replica-layer-plan.json
npm run image:ocr -- reference.png -o output/ocr.json
npm run image:palette -- reference.png output/palette.json
npm run image:crop -- reference.png crops.json output/assets
```

PDF 页面：

```bash
npm run pdf:hints -- source.pdf output/pdf-pages -o output/pdf-page-hints.json
```

PDF 支持是页面级 hints：最终仍应由 Agent 重建可编辑文本、形状、表格和图表，而不是直接整页栅格化。

## 质量检查与修复

```bash
npm run accessibility:check -- output/deck.manifest.json output/accessibility-report.md
npm run openxml:repair -- output/final.pptx output/openxml-repair-report.json
npm run visual:critic -- output/deck.manifest.json output/visual-review.json --mode creative
npm run repair:apply -- output/deck.manifest.json output/repair-patch.json output/deck.repaired.json
npm run visual:regression -- output/deck.manifest.json output
npm run vision:review -- output --provider mock
npm run run:index -- output run-001 creative "deck summary"
```

`visual:critic` 会检查越界、小字号、过密图表、缺少图表/图解描述、空图解层，以及影响美观的超大空白装饰容器。

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
Design-first artifacts
  deck.storyboard.json
  deck.design-direction.json
  slide-design-specs.json
        |
        v
deck.manifest.json
  version, designSystem, deck, assets, slides, elements
        |
        v
Deterministic scripts
  validate-manifest.py
  compile-design-first.mjs
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
  vision-review.json
  visual-regression-report.json
        |
        v
final.pptx
```

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `SKILL.md` | Agent Skill 入口说明。 |
| `AGENT.md` | 宿主 Agent 使用规范。 |
| `adapters/` | Codex、Claude Code、Cursor 等宿主适配说明。 |
| `design-systems/` | 内置通用设计系统。 |
| `layout-archetypes/` | 设计优先流程使用的页面布局原型。 |
| `schemas/` | deck、storyboard、design direction、registry、repair、review 等 JSON Schema。 |
| `scripts/` | 转换、渲染、校验、修复、回归和工作台脚本。 |
| `scripts/lib/` | 可复用核心逻辑。 |
| `references/` | workflow、manifest、HTML/image/PDF、QA 和 prompt 参考。 |
| `examples/` | 文本、HTML、图片、design-first 和 visual-roadmap 示例。 |
| `workbench/` | 本地可视化工作台前端。 |
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
| `npm run setup` | 初始化示例和环境报告。 |
| `npm run pipeline` | 校验 manifest、渲染 PPTX、打包输出。 |
| `npm run pipeline:design-first` | 运行 design-first 端到端流程。 |
| `npm run explore:directions` | 生成多方向设计候选。 |
| `npm run render` | 仅从 manifest 渲染 PPTX。 |
| `npm run html:manifest` | HTML 转 manifest。 |
| `npm run html:measure` | 测量 CSS 定位 HTML。 |
| `npm run image:hints` | 图片转重建 hints。 |
| `npm run image:replica:analyze` | 输出图片复刻分析 JSON，包含版面区域、对象候选、检测器状态和质量目标。 |
| `npm run image:replica:plan` | 从复刻分析 JSON 生成图层规划，明确参考层、背景修补层、可编辑文本/形状层和裁剪兜底层。 |
| `npm run pdf:hints` | PDF 页面转 hints。 |
| `npm run visual:critic` | 规则化视觉评审。 |
| `npm run vision:review` | mock 截图级视觉评审。 |
| `npm run registry:validate` | 校验来源和素材 registry。 |
| `npm run run:index` | 生成 run index。 |
| `npm test` | JavaScript 测试。 |
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
