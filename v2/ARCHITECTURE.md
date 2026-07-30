# V2.0 已实现架构与边界

## 决策摘要

V2 把原来的单一总路由发布单元拆成三个标准 Skill：

| 逻辑标识 | 标准目录/Skill 名 | Host 层输入 | 确定性运行时输入与核心输出 |
|---|---|---|---|
| `text_to_html` | `text-to-html` | 自然语言、Markdown、长文本、结构化大纲 | 已审核的 `presentation-plan.json` → 经过浏览器验证的离线 HTML 演示包 |
| `html_to_pptx` | `html-to-pptx` | 已有 HTML 或上一阶段交付包 | 本地 HTML、目录或可选协议包 → 主要元素可编辑的 PPTX 与转换证据 |
| `image_to_pptx` | `image-to-pptx` | 一张或多张参考图 | PNG/JPEG/WebP 序列 → 主要元素可编辑的 PPTX、设计令牌与默认启用的可选 HTML 包 |

连字符命名来自当前标准 Skill 规则：目录名与 frontmatter `name` 一致，只允许小写字母、数字和连字符。

这里的“自然语言输入”描述标准 Skill 的 Host 入口，不是脚本 CLI。Host
负责把原始材料变成经过事实、叙事、布局和来源审核的 plan；脚本不会直接
理解自然语言或自动完成内容策划。

## 目录

```text
skills/
├── text-to-html/
│   ├── SKILL.md
│   ├── agents/openai.yaml
│   ├── package.json
│   ├── LICENSE
│   ├── scripts/
│   ├── schemas/
│   ├── references/
│   ├── assets/
│   ├── examples/
│   └── tests/
├── html-to-pptx/
│   └── 同样的自包含边界
└── image-to-pptx/
    └── 同样的自包含边界
```

每个目录是一个发布根。复制后只允许访问：

- 该目录内的文件；
- Node/Python 包管理器声明的公开依赖；
- 明确列出的系统程序，例如 Chromium、LibreOffice、Poppler、Tesseract；
- 用户传入的输入和输出路径。

禁止访问仓库根运行时、`../<兄弟 Skill>`、未声明的本机脚本、软链接或 `file:../` 依赖。

## 标准 Skill 结构

每个 `SKILL.md` 只保留：

1. 核心能力和触发描述；
2. 一条公开入口；
3. Host 与脚本责任边界；
4. 核心阶段和决策分支；
5. 必须阻断的条件；
6. 何时读取哪一个 `references/`。

详细内容按需放入：

- `workflow.md`：阶段、输入输出和恢复；
- `input-output-contract.md`：稳定文件/字段；
- `quality-gates.md`：可执行阈值；
- `error-model.md`：错误码和责任阶段；
- `presentation-package.md`：可选组合协议；
- Skill 特有的内容、CSS 兼容或 OCR 参考。

确定性、重复工作进入 `scripts/`；输出模板、主题和本地运行时资产进入 `assets/`；不在 Skill 内创建重复的 README/安装手册。

## 三个独立运行时

### `text-to-html`

```text
原始输入
  → Host 形成定位与来源清单
  → Host 形成并审批 presentation plan
  → plan contract gate
  → 多布局 HTML 编译
  → desktop/mobile/print Chromium 渲染
  → overflow/overlap/asset/font/nav/contrast gate
  → 最多三轮安全密度修复
  → HTML presentation package
```

脚本不调用 LLM，不发明事实。自然语言理解、长文取舍、MECE 叙事和结论
标题由调用该 Skill 的 Host 完成；plan schema 和生成器把这些判断变成
稳定、可复现、可测试的产物。`scaffold-plan.mjs` 只按 Markdown 结构生成
未审批草稿，不能替代 Host 的内容理解与审核。

核心成功条件：

- 一页一个 `coreMessage`；
- 支撑点默认不超过三个；
- 来源状态区分 provided/verified/inferred/unverified/placeholder；
- `index.html` 离线可运行；
- 1280×720、常见桌面和手机视口真实截图；
- 无横向滚动、文字溢出、模块重叠、错误图片裁切；
- 修复后重新截图，失败不能标记完成。

### `html-to-pptx`

```text
HTML/目录/可选协议包
  → 安全解析与本地资产检查
  → Chromium 计算样式/几何/层叠/裁切
  → HTML-to-manifest
  → native PPTX renderer
  → 局部不支持效果登记
  → PPTX 重新渲染
  → source-vs-render + OOXML + geometry gate
  → 最多三轮有界修复
  → PPTX delivery
```

V2 已把 HTML replica 编译核心放入该 Skill 自身目录，而不是从仓库根导入。
项目内代码的重复由版本和测试管理；运行时独立性优先于单仓库 DRY。

普通 HTML 永远是合法输入。`presentation-package` 只提供更精确的页面、备注、来源和组件语义，不是前置依赖。

### `image-to-pptx`

```text
图片序列
  → 依赖/页面预检
  → OCR + 页面/颜色/几何/组件分析
  → provided/observed/inferred 证据分层
  → native/local-raster 重建计划
  → 多页 manifest 与 PPTX
  → PPTX 重新渲染
  → SSIM/OCR CER/bbox IoU/color/native-object gate
  → 最多三轮文字/几何校准
  → PPTX + confidence/degradation reports
```

低置信文字不得补写。无法恢复图表原始数据时，必须标记为 shapes 或 local raster，而不是伪称数据图表。整页图片不得成为“可编辑重建”。

## 可选互操作协议

协议名：`pptx-creator.presentation-package`
当前版本：`1.0.0`
规范文件：`schemas/presentation-package.schema.json`

这是项目协议，不是 Codex Skill manifest。三个 Skill 各自携带字节一致的 schema 和 validator。

协议覆盖：

- 页面尺寸、比例、顺序、稳定 ID；
- 标题、核心观点、备注、来源引用；
- 设计令牌和相对资源路径；
- component 类型、几何、z-order、可编辑意图和置信度；
- 来源的事实状态；
- 验证状态和报告；
- 局部降级及可编辑性影响；
- 最低读取版本和功能标记。

不兼容版本必须返回 `E_PROTOCOL_VERSION`。普通 HTML、图片或文本输入无需协议。

## 显式组合

### 文本生成可编辑 PPTX

```text
$text-to-html
  → presentation-package 1.0.0 + index.html
  → $html-to-pptx
  → final.pptx
```

### 参考图直接重建

```text
$image-to-pptx
  → final.pptx
```

### 参考图经 HTML 再编译

```text
$image-to-pptx
  → 默认生成 html-package/（CLI 可用 --no-html-package 关闭）
  → presentation-package 1.0.0 + index.html
  → $html-to-pptx
```

### 参考风格生成新内容

```text
$image-to-pptx
  → design-tokens.json
  → 用户或 Host 显式映射到 text-to-html plan
  → $text-to-html
  → $html-to-pptx
```

每个箭头都是用户或 Host 的显式调用；任一 Skill 都不得在内部发现并启动另一个 Skill。

## 统一错误模型

错误码前缀：

| 前缀 | 责任 |
|---|---|
| `E_INPUT_*` | 输入不可读、类型不支持、资源缺失 |
| `E_PLAN_*` | 内容计划、来源或页面契约 |
| `E_PROTOCOL_*` | 互操作版本、字段、路径、引用 |
| `E_BROWSER_*` | Chromium、字体、导航、打印 |
| `E_LAYOUT_*` | overflow、overlap、越界、连接线 |
| `E_COMPILE_*` | CSS/图片计划到 PPTX 的映射 |
| `E_RENDER_*` | Office/LibreOffice/Poppler 渲染 |
| `E_FIDELITY_*` | 视觉差异或阈值 |
| `E_EDITABILITY_*` | 原生对象覆盖或整页 raster |
| `E_REPAIR_*` | 无安全修复、无提升、次数耗尽 |
| `E_DEPENDENCY_*` | 显式依赖或系统程序缺失 |

这些前缀是共同的责任分类，不是已经统一的错误 JSON schema。当前三个
CLI 都会以非零退出和 `code`/`message` 报告失败，但 `stage`、artifact
path、details 和 recoverable 等字段仍按各 Skill 的报告契约输出，并非
每个错误都同时具备。任何运行时都不能因此静默降级或发布失败候选。

## 已实现的运行状态

三个 CLI 当前以 `passed` / `failed` 表达自动执行结论；
`presentation-package.validation.status` 还允许中间值 `pending`：

| 状态 | 当前含义 | 是否可直接交付 |
|---|---|---|
| `pending` | 协议包尚未形成通过的自动证据 | 否 |
| `failed` | 输入、依赖、硬门禁或修复耗尽导致失败 | 否 |
| `passed` | 对应 CLI 的自动门禁通过 | 还需 Host 完成全尺寸逐页视觉判断 |

`running`、`blocked`、`review-required` 和 `packaged` 可以作为上层 Host
工作流词汇，但当前不是三个 CLI 共同序列化的跨 Skill 状态。不得把候选
PPTX/HTML 已生成或命令退出 0 改写成 `passed`；修复后的证据必须绑定新的
输入与输出哈希。

## 独立性证明

根级 `scripts/check-v2-skill-independence.mjs` 执行静态门禁：

- 必需目录和入口存在；
- 无软链接；
- JS 本地 import 不逃出 Skill 根；
- 不引用兄弟 Skill 或开发机绝对路径；
- `package.json` 不含 `file:`、`link:`、`workspace:`；
- 三份协议 schema 与 canonical 字节一致。

隔离执行进一步把每个 Skill 单独复制到新的临时目录：

1. 安装该 Skill 自己声明的依赖；
2. 运行自己的单元、契约和错误测试；
3. 运行最小核心样例；
4. 检查核心产物和报告；
5. 确认另外两个 Skill 不存在。

## 测试分层

| 层 | `text-to-html` | `html-to-pptx` | `image-to-pptx` |
|---|---|---|---|
| 单元 | plan/来源/布局选择 | 样式/单位/对象映射 | OCR/置信度/几何 |
| 契约 | plan + package | HTML/package + PPTX reports | image/package + confidence |
| 错误 | 事实/路径/版本 | CSS/字体/资源/版本 | 缺 OCR/低置信/版本 |
| 浏览器 | desktop/mobile/print | source geometry | 可选 HTML |
| 视觉 | HTML 截图 | HTML vs PPTX | image vs PPTX |
| 隔离 | HTML core | PPTX core | PPTX core |
| 组合 | 输出给 H2P | 接收 T2H/I2P | 输出可选 HTML/tokens |

结构检查、退出码和 schema 通过只能证明技术契约；视觉交付必须同时有真实渲染图和门禁报告。

## 已落地的迁移组件

- 三个自包含 Skill 目录与各自的公开 CLI、依赖、schema、references、
  examples 和 tests；
- canonical `presentation-package 1.0.0` schema/validator 及三份包内副本；
- 根级独立性扫描、三 Skill 打包器与包验证器；
- 文本 HTML 包到 HTML→PPTX、图片 HTML 包到 HTML→PPTX、图片设计令牌到
  文本计划的显式组合测试入口；
- 保留但降级为兼容层的根级 `SKILL.md` 与 `npm run pptx -- ...`。

这些文件存在只证明实现边界已经落地，不替代每个 Skill 的隔离执行、
浏览器/Office 渲染、视觉审查或发布包验证；具体交付仍以当次新鲜证据为准。

## 非目标

- 不在 V2 三核心内实现 PDF 复刻。
- 不把 Anthropic 专有代码、Guizang AGPL 代码或来源不明模板复制进仓库。
- 不把 Reveal/Marp 的全页截图 PPTX 作为 HTML→PPTX 核心。
- 不在确定性脚本内调用 LLM 或网络搜索。
- 不为追求像素相似而取消主要元素可编辑性。
