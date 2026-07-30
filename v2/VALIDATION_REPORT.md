# V2.0 实施与验证报告

## 审计与实施基线

- V2 工作分支：`V2.0`
- 源码审计基线分支：`creative-director-pipeline`
- 基线 commit：`2b4b0e0382fbdd88fae390669f6adbb5da59391d`
- 实施日期：2026-07-30
- 当前工作树尚未提交，因此 `HEAD` 仍是上述基线 commit；本报告只把工作树中真实存在并实际运行过的代码、产物和报告列为已实现。
- 基线已有的 5 个用户未提交文件和 2 个无关未跟踪目录均保留，详见
  [`CURRENT_STATE.md`](CURRENT_STATE.md)；它们不冒充 V2 新增成果。

## 结论

V2 核心目标已经落地为三个可分别复制、安装、运行、测试、打包和维护的
标准 Skill：

- [`text-to-html`](../skills/text-to-html/SKILL.md)
- [`html-to-pptx`](../skills/html-to-pptx/SKILL.md)
- [`image-to-pptx`](../skills/image-to-pptx/SKILL.md)

静态独立性门禁未发现兄弟目录 import、仓库根运行时依赖、软链接、开发机
绝对路径或本地路径依赖。五条显式组合链全部真实运行通过，证据见
[`composition-report.json`](composition-report.json)。三个最终 `.skill`
包均通过内容、哈希、manifest、来源 branch/commit 和重复构建确定性验证，
证据见 [`package-verification.json`](package-verification.json)。

以下三项不能写成“全面验证完成”：

1. 根级旧 `--native` 兼容流水线仍有 6 个基线失败，均在
   `creative-layout-taste-preflight` 被 1 个 critical 问题阻断；
2. 当前机器没有 Microsoft PowerPoint，已改用 WPS 对代表性最终文件执行
   只读打开与原生对象选择验证；
3. Tesseract 当前只有 `eng`、`osd`、`snum`，中文 OCR 尚未验证。

## 状态标记

| 标记 | 含义 |
|---|---|
| 原项目已有 | 基线代码已有真实运行实现，本次只迁移、复用或重新验证 |
| 本次新增 | V2 工作树中新建的协议、边界、实现、测试或文档 |
| 借鉴后重新实现 | 参考外部项目的机制，但按本项目协议和许可证边界重新实现 |
| 仅完成设计、尚未实现 | 文档中保留了方向，但没有统一运行时代码或完整验证 |
| 因技术或权限原因无法验证 | 当前环境缺少目标软件、语言数据或平台 |

## 能力来源与实现状态

| 能力 | 状态 | 真实实现与证据 |
|---|---|---|
| 浏览器 DOM 测量、HTML→manifest、native PPTX renderer | 原项目已有 | 基线调用链与函数证据见 [`CURRENT_STATE.md`](CURRENT_STATE.md)；V2 在 `html-to-pptx/scripts/` 内自包含复制并继续维护 |
| 图片 OCR、分层计划、PPTX 回渲指标 | 原项目已有 | 基线实现存在但代表样例未过自身 IoU 门禁；V2 在 `image-to-pptx` 内重构并补齐依赖预检、多页、修复与隔离测试 |
| Host 负责内容理解、事实边界、叙事和视觉方向 | 原项目已有 | 旧流程已经由 Host 承担；V2 明确脚本不调用 LLM，见 [`USER_GUIDE.md`](USER_GUIDE.md) |
| 三个独立标准 Skill 发布根 | 本次新增 | 每个目录都有 `SKILL.md`、`agents/`、依赖、scripts、schemas、references、assets、examples、tests 和 LICENSE |
| HTML-only 正式交付边界与已审核 plan contract | 本次新增 | `text-to-html/schemas/presentation-plan.schema.json`、`scripts/run-pipeline.mjs` |
| 普通 HTML 独立转换入口 | 本次新增 | `html-to-pptx/scripts/convert.mjs` 接受文件、目录或可选协议包，不要求来源为 `text-to-html` |
| 多图顺序重建、OCR 置信度、可选 HTML/设计令牌 | 本次新增 | `image-to-pptx/scripts/image-to-pptx.mjs` 与 `build_html_package.mjs` |
| 版本化互操作协议与失败关闭 | 本次新增 | [`presentation-package.schema.json`](../schemas/presentation-package.schema.json) 和三个 Skill 内字节一致的 schema/validator |
| 生成→渲染→截图→检查→修复→重验闭环 | 借鉴后重新实现 | 借鉴 Visual Proof Gate 的证据闭环思想，分别在三个 Skill 内实现可执行门禁，没有引入其运行时代码 |
| 渐进披露、设计令牌、语义 HTML 属性 | 借鉴后重新实现 | 参考项目选型、许可证与不采用项见 [`REFERENCE_CAPABILITY_MATRIX.md`](REFERENCE_CAPABILITY_MATRIX.md) |
| 统一的跨 Skill 错误 JSON 和 `review-required`/`packaged` 状态机 | 仅完成设计、尚未实现 | 当前共享错误前缀，但三个 CLI 的 details/stage/artifact 字段仍各自定义；机器状态统一为 `passed`/`failed`，协议另允许 `pending` |
| Microsoft PowerPoint 打开和编辑验证 | 因技术或权限原因无法验证 | 当前机器未安装 PowerPoint；没有用 LibreOffice 或 WPS 结果冒充 PowerPoint 结果 |
| 中文 OCR 质量验证 | 因技术或权限原因无法验证 | 当前 Tesseract 无 `chi_sim`；现有图片样例和阈值只证明英文 OCR |

外部参考不是名称清单。每项实际机制、适用 Skill、缺口、采用方式、收益、
风险、许可证和验证方法均记录在
[`REFERENCE_CAPABILITY_MATRIX.md`](REFERENCE_CAPABILITY_MATRIX.md)。

## 交付物对应关系

| 用户要求 | 状态 | 交付位置 |
|---|---|---|
| 源码级架构、调用链、回退与真实边界分析 | 本次新增 | [`CURRENT_STATE.md`](CURRENT_STATE.md) |
| 文档描述与实际实现差异 | 本次新增 | [`CURRENT_STATE.md`](CURRENT_STATE.md) 的基线缺口、文档漂移和 V2 状态 |
| 11 个参考项目的能力/许可证选型矩阵 | 本次新增 | [`REFERENCE_CAPABILITY_MATRIX.md`](REFERENCE_CAPABILITY_MATRIX.md) |
| 三个独立标准 Skill | 本次新增 | [`skills/`](../skills/) |
| 输入输出契约、流程和错误模型 | 本次新增 | 各 Skill 的 `references/` 与 `schemas/` |
| 互操作协议 | 本次新增 | [`presentation-package.schema.json`](../schemas/presentation-package.schema.json)、[`ARCHITECTURE.md`](ARCHITECTURE.md) |
| `text-to-html` 内容计划、HTML 生成和浏览器 QA | 本次新增 | [`text-to-html`](../skills/text-to-html/) |
| `html-to-pptx` 转换、兼容、降级和回渲 | 原项目已有 + 本次新增 | [`html-to-pptx`](../skills/html-to-pptx/) |
| `image-to-pptx` 识别、重建、置信度和视觉验证 | 原项目已有 + 本次新增 | [`image-to-pptx`](../skills/image-to-pptx/) |
| 单元、契约、错误、视觉、隔离和组合测试 | 本次新增 | 三个 `tests/`、根级 `tests/v2-*.test.mjs`、本报告的测试结果 |
| 最小/复杂示例、预览和报告 | 本次新增 | 各 Skill 的 `examples/` |
| 旧入口迁移说明 | 本次新增 | [`MIGRATION.md`](MIGRATION.md) |
| 普通用户入口 | 本次新增 | [`USER_GUIDE.md`](USER_GUIDE.md) |
| 渐进披露高级文档 | 本次新增 | 各 Skill 的 `references/` |
| 已知限制、风险和后续优先级 | 本次新增 | 本报告末尾 |

## 三个 Skill 的实际验证

### `text-to-html`

- 单元/契约/错误测试：10/10。
- 浏览器测试：2/2；视觉测试：1/1；隔离复制测试：1/1。
- 标准 Skill 快速校验：通过。
- 最小示例：3 页，在 1280×720、1440×900、390×844 三个视口生成
  9 张截图，0 blocking finding、无横向滚动。
- 复杂示例：9 页，在三个视口生成 27 张截图，0 blocking finding、
  无横向滚动；最终模板使用 solid 基底与显式可编辑装饰元素，不再把
  full-slide gradient 交给下游栅格化。
- 核心证据：
  - [`minimal/generated/qa-report.json`](../skills/text-to-html/examples/minimal/generated/qa-report.json)
  - [`complex/generated/qa-report.json`](../skills/text-to-html/examples/complex/generated/qa-report.json)

### `html-to-pptx`

- 单元/契约/错误测试：18/18。
- 浏览器测试：2/2；视觉测试：1/1；隔离复制测试：1/1。
- 标准 Skill 快速校验：通过。
- 最小示例：1 页、Level 5、native coverage `1.0`、最低视觉相似度
  `0.983710`、整页 raster 违规 0。
- 复杂示例：2 页、Level 4、native coverage `0.9965`、最低视觉相似度
  `0.972056`；HTML/手机 critical 0、PPTX geometry critical 0；
  只有 1 个已登记的局部 `clip-path` raster fallback，整页 raster 违规 0。
- 隐藏页会逐页临时激活、测量和截图后精确恢复；内容覆盖只排除备注、
  真正隐藏语义和被稳定子元素完整表达的重复父容器，未降低覆盖阈值。
- 核心证据：
  - [`minimal/output/qa-report.json`](../skills/html-to-pptx/examples/minimal/output/qa-report.json)
  - [`complex/output/qa-report.json`](../skills/html-to-pptx/examples/complex/output/qa-report.json)
  - [`complex/output/editable-report.json`](../skills/html-to-pptx/examples/complex/output/editable-report.json)

### `image-to-pptx`

- Node 测试：7 通过、3 个需显式系统门禁的测试默认跳过、0 失败。
- Python 测试：5/5；契约子集：3/3；视觉回归：2/2；隔离复制：1/1。
- 标准 Skill 快速校验与 dependency doctor：通过；实际环境为
  Tesseract 5.5.2、LibreOfficeDev 26.8、pdftoppm 26.05。
- 最小示例：1 页、SSIM `0.95832575`、OCR CER `0`、bbox IoU
  `0.931662`、Level 5、10 个原生对象、0 raster。
- 复杂示例：2 页、SSIM `0.97948207`、OCR CER `0`、bbox IoU
  `0.951624`、Level 4、30 个原生对象、2 个已登记局部 raster、
  raster 面积占比 `0.062568`、整页 raster 0。
- 低置信文字和高局部颜色复杂区域保留在 degradation ledger；无端点
  divider 归类为 editable shape，只有完整 `sourceId + targetId` 才归类
  为 connector。
- 核心证据：
  - [`minimal/output/qa-report.json`](../skills/image-to-pptx/examples/minimal/output/qa-report.json)
  - [`complex/output/qa-report.json`](../skills/image-to-pptx/examples/complex/output/qa-report.json)

## 独立性与组合验证

`node scripts/check-v2-skill-independence.mjs` 的最终结果：

| Skill | 扫描文件数 | Findings |
|---|---:|---:|
| `text-to-html` | 109 | 0 |
| `html-to-pptx` | 142 | 0 |
| `image-to-pptx` | 38 | 0 |

隔离测试会把单个 Skill 复制到新的临时目录，不提供另外两个 Skill，安装
自身依赖并运行核心示例。三项均通过。

根级组合测试共 3/3，其中完整集成用例顺序执行五条链：

| 链路 | 结果 | 关键证据 |
|---|---|---|
| `text-to-html → html-to-pptx` | 通过 | 3 页、Level 5、native coverage 1、最低相似度 `0.971857`、整页 raster 0 |
| `image-to-pptx` 独立生成 | 通过 | Level 5、SSIM `0.95832575`、整页 raster 0 |
| `image-to-pptx → HTML → html-to-pptx` | 通过 | Level 5、native coverage 1、相似度 `0.994510`、整页 raster 0 |
| 参考图 design tokens → text → HTML → PPTX | 通过 | 3 页、Level 5、native coverage 1、相似度 `0.969917`；未导入参考图事实 |
| 协议 `2.0.0` 不兼容 | 通过 | consumer 与 canonical validator 均返回 `E_PROTOCOL_VERSION`，未发布 `final.pptx` |

完整命令、临时目录、产物哈希和每条链的报告见
[`composition-report.json`](composition-report.json)。组合只调用三个公开
CLI，没有隐式启动兄弟 Skill。

## WPS 实际打开与编辑性抽查

两个代表性最终文件已在 `/Applications/wpsoffice.app` 中只读打开：

- `html-to-pptx-final-validated.pptx`：窗口标题和两页缩略图可见，原生
  shape 可单独选中并显示绘图工具；
- `image-to-pptx-final-validated.pptx`：窗口标题和两页缩略图可见，OCR
  重建文本可单独选中并显示字体、字号和文本工具。

机器可读记录和截图：

- [`validation.json`](evidence/wps/validation.json)
- [`html-to-pptx-final-open.jpeg`](evidence/wps/html-to-pptx-final-open.jpeg)
- [`html-to-pptx-final-editable-shape.jpeg`](evidence/wps/html-to-pptx-final-editable-shape.jpeg)
- [`image-to-pptx-final-open.jpeg`](evidence/wps/image-to-pptx-final-open.jpeg)
- [`image-to-pptx-final-editable-text.jpeg`](evidence/wps/image-to-pptx-final-editable-text.jpeg)

该抽查证明代表性文件能在当前 WPS 环境打开并选择主要原生对象，不代表
所有 WPS/Office 版本，也不替代未安装的 Microsoft PowerPoint 验证。

## 根级回归

| 测试 | 结果 |
|---|---|
| V2 协议、独立性、打包、组合快速测试与入口文档回归 | 52 通过、1 个完整组合用例默认跳过 |
| 根级 Python unittest | 71/71 |
| 根级 JavaScript 全量 | 1053 通过、6 失败、49 跳过 |

6 个失败与基线相同，集中在旧 `--native` Creative 流程被
`creative-layout-taste-preflight` 的 1 个 critical finding 提前阻断。
V2 没有删除失败测试、降低阈值或伪造通过状态。新的三个 Skill、五条组合
链和包验证不依赖这条旧兼容路线。

## 最终发布包

重复构建前后的 SHA-256 完全一致；随后又执行了最终验证：

| 包 | 文件数 | SHA-256 |
|---|---:|---|
| `dist/v2/text-to-html.skill` | 109 | `9a039ed0ca6fe04064fae77d188f4bc176b71feb92da452aa7e46e22a09a7c4d` |
| `dist/v2/html-to-pptx.skill` | 141 | `e90f7573027c12bb9ddbf5723a0b2dc412f1d9be01457f7a655c10bc3e1921c5` |
| `dist/v2/image-to-pptx.skill` | 38 | `9e5c54eaaf852bd88940af264d9b7680cddee131e7f789959c647d0493e77302` |

每个包旁都有 `.sha256` 与 `.skill-manifest.json`。`dist/` 仍按仓库规则
忽略，没有被加入 Git。

## 已知限制与后续优先级

### P0

1. 安装 `chi_sim` 并新增中文标题、正文、数字、低置信区域的 OCR/视觉基准，
   在通过前不能宣称中文图片重建质量。
2. 修复旧根级 `--native` Creative 样例的
   `creative-layout-taste-preflight` critical；它不阻塞 V2 三 Skill，
   但仍是兼容层真实回归缺口。

### P1

1. 在 Microsoft PowerPoint 与 Windows 字体环境增加打开、回渲和编辑抽查；
   当前只验证了 LibreOffice 回渲与 macOS WPS。
2. 把 9 页复杂文本示例加入完整 `text-to-html → html-to-pptx` 组合回归；
   当前完整组合使用 3 页代表性样例，9 页只完成 HTML 三视口视觉回归。
3. 扩展 CSS→PPTX 兼容矩阵。任意第三方 HTML 的未支持效果仍可能局部降级
   或失败；整页 raster 禁令不会因此放宽。

### P2

1. 在不引入公共私有运行时的前提下，统一三个 CLI 的错误 JSON 字段和
   Host review 状态词。
2. 增加更多图表、复杂 SVG、RTL、CJK 字体替换与跨平台度量基准。

V2 三核心不包含 PDF 复刻或独立 manifest-repair Skill；旧 PDF 路线仍会
因缺少 fidelity-proof compiler 明确失败，不能用整页图片绕过。
