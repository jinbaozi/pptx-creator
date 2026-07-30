# V2.0 状态：重构前基线与已实现架构

本文分成两个时间截面：

1. **第一部分**冻结
   `creative-director-pipeline@2b4b0e0382fbdd88fae390669f6adbb5da59391d`
   的重构前基线，用来说明 V2 从哪里出发。该部分中的“当前”“现有”
   均只指这个历史基线，不代表 V2.0 工作树现状。
2. **第二部分**记录 `V2.0` 工作树已经落地的三 Skill 架构与实际运行
   边界。判断现在能做什么时，应以第二部分和对应 Skill 的代码为准。

## 第一部分：`creative-director-pipeline@2b4b0e0` 重构前基线

## 审计基线与证据边界

- 分支基线：远端与本地 `codex/creative-director-pipeline`。
- 基线提交：`2b4b0e0382fbdd88fae390669f6adbb5da59391d`（`fix: refine card corner rendering`，2026-07-28）。
- V2 工作分支：`V2.0`。
- 审计日期：2026-07-30。
- 基线存在 5 个用户未提交文件：`scripts/lib/html-to-manifest-core.mjs`、`scripts/measure-html.mjs`、`scripts/render-pptx.mjs`、`tests/html-measurement.test.mjs`、`tests/render-pptx.test.mjs`。它们包含边框内缩和 PowerPoint 行高校准，V2 保留且不冒充本次新增。
- `.superpowers/` 与 `linux-major-version-compatibility-site/` 是无关未跟踪目录；未纳入 V2 设计、测试结论或提交范围。

本报告以代码、测试和实际运行结果为证据。`README`、旧提示词或计划中出现但未进入调用链的内容，不算现有能力。

## 基线目录和入口

该基线项目是一个总路由 Skill，而不是三个可独立安装的 Skill：

| 层 | 真实入口 | 责任 |
|---|---|---|
| Host 路由 | `SKILL.md` | 选择 `text`、`html-replica`、`image-replica`、`pdf-replica` 或 `manifest-repair` |
| CLI | `scripts/pptx.mjs::buildInvocation` | 校验公开参数并转发到单一运行时 |
| 路由绑定 | `scripts/run-route-pipeline.mjs::runRoutePipeline` | 把 route/mode 绑定到具体 pipeline |
| 统一流水线 | `scripts/run-deck-pipeline.mjs::runDeckPipeline` | 验证、预检、渲染、证明、有限修复、几何审计、打包 |
| 渲染器 | `scripts/render-pptx.mjs` | 把 manifest 中的元素渲染为原生 PPTX 对象 |
| 打包 | `scripts/package-output.py` | 输出 PPTX、质量报告和绑定哈希的产物索引 |

该基线 `package.json` 的公开命令是 `npm run pptx -- <route> ...`。所有路线共享根级 `scripts/`、`scripts/lib/`、`schemas/`、设计系统和依赖，因此任一路线不能从基线仓库单独复制出去运行。

## 基线真实调用链

### 文本默认路线

1. Host 根据 `references/routes/text.md`、`references/design-first-workflow.md` 和 `references/text-html-authoring.md` 完成受众、目标、叙事、Creative Direction 和完整 `deck.html`。
2. `scripts/run-text-html-pipeline.mjs::runTextHtmlPipeline` 查找并冻结 HTML，调用 `repairHtmlLayout` 生成 `deck.repaired.html` 和修复报告。
3. 同一模块调用 `runHtmlPipeline(..., mode="creative")`。
4. `scripts/run-html-pipeline.mjs::runHtmlPipeline` 通过真实 Chromium 测量 DOM，调用 `writeManifestFromHtml` 生成 `deck.manifest.json`。
5. `runDeckPipeline` 执行 manifest 验证、creative/replica 预检、PPTX 渲染、来源到 PPTX 的证明、最多三轮有限修复、几何审计和打包。
6. 文本默认路线需要 Host 最终逐页视觉复核后才发布顶层 `final.pptx`。

重要边界：当前脚本没有“理解自然语言并自动写出叙事和 HTML”的 LLM 运行时。内容策划、事实取舍、故事线、标题和视觉方向属于 Host 指令能力；确定性脚本从现成 HTML 开始。这是【原项目已有的 Host 工作流】，不是可脱离 Host 独立调用的文本生成程序。

### 旧 `--native` 文本兼容路线

`scripts/run-design-first-pipeline.mjs` 读取 `deck.plan.json`，通过 `deck-plan`/Semantic Slide IR 编译固定内容家族，再进入 `runDeckPipeline(mode="creative")`。它仍是可调用的兼容路线，但不是默认 HTML-first 路线。

2026-07-30 的基线测试中，这条路线的代表样例被 `creative-layout-taste-preflight` 的 1 个 critical 问题提前阻断；相关 6 个测试失败。因此它不能作为 V2 文本核心的已通过基线。

### HTML 路线

1. `scripts/pptx.mjs` 强制公开 `html` 路线使用 replica 模式。
2. `runHtmlPipeline` 禁止默认网络资源；只有显式 `--allow-remote-assets` 才会通过 `localizeHtmlRemoteAssets` 下载并改写为本地路径。
3. `scripts/measure-html.mjs::measureHtmlFile` 和 `scripts/lib/html-layout-audit.mjs::withSettledHtmlPage` 启动 Chromium，读取计算样式、几何、层叠、裁切和语义标记。
4. `scripts/html-to-manifest.mjs::writeManifestFromHtml` 与 `scripts/lib/html-to-manifest-core.mjs` 编译 text、shape、image、table、chart、diagram、line/connector 等 manifest 对象。
5. 不支持的复杂效果只能按元素边界局部截图；`captureReplicaSourceAndFallbacks` 对接近整页的裁剪显式报错。
6. PPTX 渲染后，`renderAndMeasureHtmlReplica`、`replica-evidence` 和 `pptx-geometry-audit` 检查视觉差异、原生对象召回、几何漂移、哈希和来源绑定。

实际运行 `examples/html-input/replica-golden.html`：

- HTML 布局 critical/warning：`0/0`；
- 内容覆盖：`5/5`、100%；
- 原生覆盖：100%；
- 可编辑性：Level 5；
- 几何审计、来源证明和打包：通过；
- 生成了 HTML 基准图、PPTX 渲染图、`final.pptx`、`replica-evidence.json`、`pptx-geometry-report.json` 和 `output-manifest.json`。

这是【原项目已有且本次重新验证】的真实能力。

### 图片路线

1. `scripts/run-image-pipeline.mjs::runImagePipeline` 调用：
   - `image-replica-analyze.py`：页面、颜色、简单几何、OCR 和复杂局部区域分析；
   - `image-replica-plan.py`：置信度分层和 native/raster 计划；
   - `image-replica-compile.py`：生成 manifest 和局部残差资产。
2. `runDeckPipeline(mode="replica")` 渲染 PPTX。
3. `render-preview.py` 通过 LibreOffice/Poppler 产生真实 PPTX 页面图。
4. `measureImageReplicaEvidence` 计算 SSIM、OCR CER、文字框 IoU、颜色差异、原生覆盖和 OOXML 对象证明。
5. `measure-image-replica.py` 可给出有限文字几何修复；超过三轮或无提升即阻断。

在未安装 `requirements-image.txt` 时，实际运行报告 `ocr-unavailable`，PPTX 中所有文字缺失。补齐 `Pillow` 与 `pytesseract` 后，同一 `replica-golden.png` 能重建文字、形状和局部复杂图像，但最终仍因 `bboxIou=0.885536 < 0.90` 阻断，修复停止原因为 `no-improvement`。

因此图片路线属于【原项目已有但尚未达到自身代表样例门禁】；文档中“完全不可用”的旧措辞已落后于实现，但“可交付”也不能据此宣称。

### PDF 和 manifest 修复

- `manifest` 路线由 `scripts/run-manifest-repair.mjs` 执行，属于现有边界修复能力。
- `pdf` 在 `scripts/run-route-pipeline.mjs::runRoutePipeline` 中显式抛出“fidelity proof capability unavailable”；当前没有可交付的 PDF 复刻编译器。
- V2 三技能目标不包含 PDF 或独立 manifest 修复 Skill；迁移文档保留其状态，不把它们混入三个新核心。

## 阶段状态、错误、回退和重试

统一流水线在 `run-deck-pipeline.mjs` 维护 `steps`、`status`、`blockedBy` 和 `detail`。首个失败阶段写入 `pipeline-blocked.json`，不会继续打包为成功。

| 阶段 | 主要输入 | 主要输出 | 阻断示例 |
|---|---|---|---|
| validate | HTML/manifest/资产 | 已验证 manifest | schema、资源或浏览器启动失败 |
| preflight | manifest、布局报告 | 布局/字体/内容风险 | overflow、critical layout、缺字体 |
| render | manifest | 候选 PPTX、文本拟合报告 | 非法几何、渲染异常 |
| fidelity-proof | 来源图/HTML、PPTX 渲染图 | `replica-evidence.json` | SSIM、IoU、颜色、对象召回未达阈值 |
| bounded-repair | 失败证明、候选产物 | 新候选与新证明 | 最多 3 次、无提升、无安全修复 |
| geometry-audit | manifest、PPTX | `pptx-geometry-report.json` | 负坐标、越界、漂移、对象 lineage 缺失 |
| package | 通过的全部证据 | `final.pptx` 与索引 | 陈旧/缺失/哈希不绑定的证据 |

回退仅允许局部、可登记的 raster 区域。整页 raster、viewer autofit 和伪造跨 Office 套件通过状态均被阻断。

## 内容、设计和技术责任归属

| 能力 | 当前真实实现 |
|---|---|
| 内容理解、演示定位、故事线 | Host 根据 references 执行；无脚本 LLM |
| 主题/Creative Direction | Host 选择；`design-system-resolver.mjs` 只确定性解析现有设计系统 |
| 页面布局 | 默认文本由 Host 写 HTML；旧 native 由 archetype/composition 编译器生成 |
| HTML 渲染和测量 | Playwright + `measure-html.mjs` + `html-layout-audit.mjs` |
| HTML 修复 | `html-layout-repair.mjs` + `layout-safety-repair-adapter.mjs`，最多三轮 |
| PPTX 转换 | `html-to-manifest-core.mjs` + `render-pptx.mjs` |
| 图片识别与重建 | Python image analyze/plan/compile + 共用 renderer |
| 截图和视觉证明 | Chromium、LibreOffice/Poppler、replica metrics |
| 文件交付 | `package-output.py`、`run-index.mjs`、哈希绑定输出索引 |

## 基线耦合与重复

- HTML 和图片路线都依赖根级 `runDeckPipeline`、renderer、Python 包装器、schemas、设计回退、preview 与 package 脚本。
- route-specific pipeline 与统一流水线通过回调耦合，无法只复制某个路线目录。
- 文本默认路线把“Host 生成 HTML”和“HTML 转 PPTX”包装在同一公开命令中，无法只交付 HTML。
- HTML 和图片都使用 replica evidence、preview 和 manifest renderer；复用是根级私有运行时，不是可安装公共包。
- 文档按 route 渐进披露已经存在，但发布单元仍是一个 `pptx-creator.skill`。

## 基线质量问题和未实现能力

1. 【原项目缺口】没有独立 `text-to-html` 交付边界、内容计划 schema、HTML-only 打包或桌面/手机双视口交付契约。
2. 【原项目缺口】三个路线没有独立安装、独立依赖、隔离复制或跨兄弟目录扫描。
3. 【原项目缺口】图片 OCR 依赖未安装时只在证明阶段暴露，用户会先得到无文字候选；V2 应在 preflight 失败。
4. 【原项目缺口】图片修复只处理有限文字框偏移，代表样例的 IoU 无法从 0.885536 提升到 0.90。
5. 【原项目缺口】图片公开入口只处理单张图片。
6. 【原项目缺口】图片可选 HTML/设计令牌输出尚未实现。
7. 【原项目缺口】CSS→PPTX 支持虽有代码和文档，但没有作为独立 Skill 版本化发布的兼容矩阵。
8. 【文档漂移】图片 README/参考仍有“compiler unavailable”措辞，而调用链已经存在；真实状态是“实现存在、代表样例仍被门禁阻断”。
9. 【已知基线问题】旧 native Creative 样例存在 critical layout gate，不能把结构测试退出 0 等同为视觉通过。
10. 【风险】浏览器像素、Office 字体度量和 LibreOffice 渲染存在平台差异，必须保留基准图、全尺寸逐页审查和明确阈值。

## 重构前测试快照

- 未设置 `PPTX_CREATOR_PYTHON` 时，大量测试因找不到 Python 3.10+ 连锁失败；这是环境问题。
- 指定 `/opt/homebrew/bin/python3.12` 并运行正式测试后：1023 通过、6 失败、48 因浏览器关闭而跳过。
- 6 个正式失败集中在旧 native Creative 流程被布局硬门禁提前阻断。
- 另有 1 个失败 test file 来自无关未跟踪站点被 Vitest 全局 glob 扫描，不属于受控仓库基线。
- Python unittest 在指定 Python 3.12 后通过。
- HTML 实际路线通过；图片实际路线在 OCR 依赖齐备后仍按阈值失败。

这些结果是 V2 最终回归的比较基线；不得通过降低现有阈值或删除失败证据让它们“变绿”。

---

## 第二部分：V2.0 已实现状态

本部分描述当前 `V2.0` 工作树中的可调用代码，不把设计稿、未来迁移步骤、
命令退出 0 或候选文件存在当成已交付能力。测试汇总与包哈希会随收尾变化，
因此不在此固化。

### 已落地的发布边界

V2.0 已在 `skills/` 下建立三个独立发布根。每个目录都有自己的
`SKILL.md`、`agents/openai.yaml`、依赖声明、脚本、schema、references、
examples 和 tests：

| Skill | Host/用户入口 | 确定性 CLI | CLI 实际输入 | 通过门禁后的核心输出 |
|---|---|---|---|---|
| `text-to-html` | `$text-to-html` / `skills/text-to-html/SKILL.md` | `scripts/run-pipeline.mjs` | Host 已审核的 `presentation-plan.json` | 离线 `index.html`、本地资源、来源/备注、浏览器截图、QA 与 `presentation-package.json` |
| `html-to-pptx` | `$html-to-pptx` / `skills/html-to-pptx/SKILL.md` | `scripts/convert.mjs` | 本地 HTML、HTML 目录或兼容的 `presentation-package.json` | `final.pptx`、manifest、局部降级账本、几何/可编辑性/视觉对比报告 |
| `image-to-pptx` | `$image-to-pptx` / `skills/image-to-pptx/SKILL.md` | `scripts/image-to-pptx.mjs build` | 一张或按顺序排列的多张 PNG/JPEG/WebP | 通过 OCR/重建/回渲门禁的 `final.pptx`、置信度/降级/QA 报告、设计令牌和默认生成的可选 HTML 包 |

根级 `SKILL.md`、`npm run pptx -- ...` 和共享 `runDeckPipeline` 仍保留，
但只属于兼容层。它们没有被三个 V2 Skill 在运行时导入，也不是 V2 的
隐式第四个阶段。

### Host 内容推理与脚本执行边界

`text-to-html` 的标准 Skill 能接收自然语言，是因为调用它的 Host/Codex
负责读取材料并完成演示定位、事实边界、来源、叙事、页面脚本、视觉意图
和最终逐页判断。确定性脚本本身不调用 LLM，也不把原始自然语言自动改写
成可交付叙事：

- `scripts/scaffold-plan.mjs` 只按 Markdown 标题和列表搭出草稿结构；
  它保留 `hostReview.status: required`，不代表内容理解或事实验证。
- `scripts/run-pipeline.mjs` 只接受通过 schema、来源、路径和
  `hostReview.status: approved` 检查的 plan，再进行 HTML 编译、真实浏览器
  QA 和有限的密度修复。
- 自动修复不得改变 claim、source、页数、布局语义或故事线；自动门禁通过
  后仍由 Host 逐页查看全尺寸预览并决定是否交付。

`html-to-pptx` 和 `image-to-pptx` 同样是转换运行时。前者以浏览器计算后的
HTML 为视觉基线，不负责重新策划内容；后者只重建参考图中有证据的文字和
视觉对象，低置信文字不得补写，无法恢复的数据不得伪称原生图表。

### 独立性、协议与显式组合

- 三个 Skill 的本地 import、运行脚本和依赖都限制在自身发布根；不允许
  访问仓库根、兄弟 Skill、开发机绝对路径、软链接或本地路径依赖。
- `scripts/check-v2-skill-independence.mjs` 实现静态独立性检查，并核对
  三份 `pptx-creator.presentation-package@1.0.0` schema 与 validator。
- `scripts/package-v2-skills.mjs` 和 `scripts/verify-v2-skills.mjs` 分别实现
  三包构建与验证；这里不记录仍可能变化的包哈希或测试总数。
- `presentation-package.json` 是可选互操作协议，不是 Skill manifest。
  普通 HTML 可以直接进入 `html-to-pptx`；任一 Skill 都不会自动发现或
  启动另一个 Skill。
- 文本生成 PPTX 必须由用户或 Host 显式执行
  `$text-to-html → $html-to-pptx`。`image-to-pptx` 可独立直接生成 PPTX，
  也会在通过门禁后默认生成可选 HTML 包；可用 `--no-html-package` 关闭。

### 当前状态与交付边界

三个 CLI 当前统一使用 `passed`/`failed` 作为自动运行结论；互操作协议
还允许中间值 `pending`。`review-required` 和 `packaged` 可作为 Host
工作流中的描述词，但尚不是三个 CLI 共同写出的跨 Skill 协议状态，调用方
不应依赖它们做机器判断。

`passed` 只证明对应脚本的自动门禁通过，不替代 Host 的全尺寸逐页视觉
判断，也不保证目标 PowerPoint/WPS/Office 环境的字体与渲染完全一致。
只有与本次输入、候选文件和回渲结果绑定的新鲜报告才能支持交付；失败候选、
旧截图、整页 raster 或未登记的局部降级都不能改名为完成品。

V2 三核心仍明确不包含 PDF 复刻或独立 manifest-repair Skill。PDF 与根级
manifest 修复继续按兼容层的既有阻断/工具边界处理，不得写成 V2 已实现
能力。
