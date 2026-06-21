# Prompt Library

Copy and adapt these prompts in the host agent. Replace `{theme_name}` and paths as needed. Scripts must not call LLM APIs.

Web search source policy: host agents may search autonomously, keep source URLs, and localize remote assets under `output/assets/`.

## Visual Roadmap Metadata Rules

```text
For creative decks, create or preserve source metadata:
1. Record source URLs for external claims in sources.json.
2. Mark external assets as visual-reference, embedded-asset, icon-source, font-reference, replica-source, or user-provided.
3. Generate multiple design directions when the task benefits from visual exploration, then choose one approved direction before full-deck generation.
4. Save remote assets locally before rendering and reference only local paths in deck.manifest.json.
5. Use screenshot-level vision review as structured QA feedback only. Do not let VLM feedback directly edit PPTX files.
6. For strict replica mode, VLM feedback may flag fidelity issues but must not redesign the source layout, colors, typography, or content.
```

## 通用联网增强规则

```text
你正在使用 pptx-creator skill。你可以在 Planner / Writer / Designer / 素材整理阶段自行判断是否联网搜索。

可以联网搜索的场景：
1. 需要核验事实、日期、产品/项目/标准/政策/技术版本、市场背景、竞品信息。
2. 需要提升页面视觉表现：参考路演风格、图表表达、图标方向、版式节奏、图片/素材线索。
3. 用户明确允许或要求搜索相关内容、素材、案例、视觉风格。

不应联网或应限制联网的场景：
1. 用户明确禁止联网。
2. 输入材料已经足够，且搜索不会提升准确性或效果。
3. 任务是严格 1:1 复刻图片/HTML/PDF，外部参考不得改变原始布局、字体、配色、内容和效果。

使用搜索结果时：
1. 不要编造事实、指标、案例、引用或来源。
2. 重要事实和素材要保留来源 URL。
3. 注意版权、许可证、商标、Logo、商业字体和品牌素材限制。
4. 远程图片/素材必须先保存到 output/assets/，manifest 中只引用本地相对路径。
5. 最终回复或 QA 说明中列出关键来源和使用限制。
```

## Content generation PPT

```text
你正在使用 pptx-creator skill。请将用户内容转换为 deck.manifest.json。

要求：
1. 先判断目标受众、汇报场景、推荐页数和叙事主线。
2. 按需判断是否联网搜索：需要核验事实、补充行业/技术背景、寻找视觉参考或素材时可以搜索。
3. 阅读并遵守 DESIGN.md；优先使用用户提供的设计系统，否则选择最匹配的内置 design-systems。
4. 将内容拆成清晰的故事线，每页只表达一个中心观点。
5. 优先使用可编辑 PPT 原生对象：text、shape、table、line、chart、icon。
6. 不要编造事实、数据、案例、竞品结论或引用。没有来源的量化内容只能标注为“示例/假设/建议值”。
7. 页面风格使用 {theme_name} 的 token 引用，例如 {colors.primary}。
8. 输出符合 references/manifest-spec.md 的 JSON，坐标使用英寸。
9. 远程素材必须保存到 output/assets/，manifest 使用本地相对路径。
10. 完成后运行：
    node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
11. 阅读 editable-report.md、qa-report.md、compatibility-report.md 后再回复用户。
12. 如果使用了联网来源，在最终回复中列出关键来源 URL 和版权/商标限制。
```

## HTML 转 PPT

```text
你正在使用 pptx-creator skill。请将 HTML 视觉稿转换为 deck.manifest.json。

要求：
1. 识别页面宽高、视觉分区、背景、排版、字体、颜色、图片、图标和表格。
2. 对 1:1 复刻任务，不得改变原始 HTML 的背景、布局、配色、字体、内容、效果和色调。
3. 简单文本、卡片、表格、线条转为 text/shape/table/line 元素。
4. 复杂背景、照片、纹理、阴影、滤镜、复杂图标可作为 image 资产。
5. 如果 HTML 使用 CSS 定位，为可测量元素添加 data-pptx-kind 和 data-pptx-id。
6. 可以联网搜索缺失素材、字体线索、图标来源或公共图片，但不得改变原始视觉稿。
7. 文本生成的 creative HTML 必须运行：npm run pipeline:html -- input.html output。
8. 连接器必须使用 SVG，并提供 data-pptx-id、data-pptx-kind="line"、data-source-id、data-target-id 和 marker-end。
9. 只有 html-layout-report.json 为零 critical 且内容覆盖率为 100% 时才允许生成 PPTX。
10. html-to-manifest.mjs 会将 HTML 中的远程图片本地化到 output/assets/；手写 manifest 时也必须这样做。
11. 不要将整页 HTML 截图作为唯一内容，除非用户明确接受 Level 1 fallback。
12. 验证并渲染后报告 HTML 修复轮次、可编辑性等级和任何图像化区域原因。
```

## 图片复刻 PPT

```text
你正在使用 pptx-creator skill。请将参考图片复刻为尽量可编辑的 PPTX manifest。

先输出对象盘点：
- 背景、标题、正文、卡片、图标、表格、图片、线条、箭头、装饰元素。

然后：
1. 运行 python scripts/image-to-manifest-hints.py reference.png output/image-hints.json
2. 可选 OCR：python scripts/ocr-image.py reference.png -o output/ocr.json
3. 用 manifestSkeleton 作为起点，替换占位文本，细化坐标。
4. 可识别文字 -> text；简单几何 -> shape/line；表格 -> table；复杂区域 -> crop-assets.py 裁切图片。
5. 对 1:1 复刻，联网搜索只用于识别缺失字体/图标/公开素材线索，不得改变原图内容、配色或布局。
6. 严禁默认整页截图。
7. 运行 node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
8. 在 editable-report.md 或最终回复中说明图像化原因和素材来源。
```

## 风格迁移（图片 + 内容）

```text
你正在使用 pptx-creator skill。参考图片仅用于提取配色、布局密度、标题风格和视觉节奏；用户文本用于生成新内容。

1. 可联网搜索同类路演/商务/科技/行业页面，提炼版式和视觉参考。
2. python scripts/extract-palette.py reference.png output/palette.json
3. 选择最接近的内置 DESIGN.md，或根据 palette 调整 token 引用。
4. 生成新内容 manifest，不是 1:1 像素复刻。
5. 使用本地化素材，目标可编辑性 Level 4-5。
6. 保留关键参考来源 URL，避免商标/Logo/版权图片误用。
```

## 溢出修复

```text
manifest 校验或 QA 报告提示溢出时：
1. 优先缩短文案。
2. 调整 y/h 或拆分页面。
3. 单页要求下保留核心信息，并在 qa-report.md 说明压缩策略。
4. 不要将正文字号降到 11pt 以下。
5. 不要用整页截图掩盖文本溢出。
```

## Design-First Creative Deck Roles

### Planner

Write `deck.storyboard.json`. Define audience, goal, language, slide roles, slide messages, and content blocks. Do not write final coordinates.

### Art Director

Write `deck.design-direction.json`. Choose style, tone, palette, typography, layout strategy, and avoid-list based on the selected `DESIGN.md` and user requirements.

### Slide Designer

Write `slide-design-specs.json`. For each slide, choose `layoutType`, state intent, main idea, focal point, density, visual weight, content slots, and editable target.

### Critic

Review rendered output using `references/visual-critic-rubric.md`. Score hierarchy, alignment, density, contrast, variety, editability, design-system fit, and source faithfulness when in Replica mode.

### Repair

Write `repair.patch.json` using `references/repair-patch-spec.md`. Keep changes bounded and do not reduce editability or beautify strict replicas.
