# 从旧入口迁移到 V2

## 核心变化

V1 的 `pptx-creator` 是一个总路由 Skill。V2 的核心发布单元是三个独立 Skill，不再把“文本直接生成 PPTX”作为单一核心入口。

```text
旧 HTML-first：npm run pptx -- text <deck.html> <output>
旧 native：    npm run pptx -- text <deck.plan.json> <output> --native

新：$text-to-html
      → HTML presentation package
    $html-to-pptx
      → editable PPTX
```

V1 根级入口目前仍保留为兼容路径；三个 `skills/<name>/SKILL.md` 是 V2
核心入口。兼容层与 V2 运行时并存，不表示三个新 Skill 会导入或启动旧
根级 pipeline。

## 名称映射

| 旧概念 | V2 逻辑标识 | 标准 Skill 名 |
|---|---|---|
| text / text-to-pptx | `text_to_html` | `text-to-html` |
| html-replica | `html_to_pptx` | `html-to-pptx` |
| image-replica | `image_to_pptx` | `image-to-pptx` |
| pdf-replica | 不在 V2 三核心中 | 继续显式阻断 |
| manifest-repair | 不在 V2 三核心中 | 旧兼容工具 |

下划线名称是需求和协议中的逻辑标识；Skill 目录/frontmatter 使用当前规范允许的连字符。

## 用户迁移

### 文本、Markdown、长文本或大纲

旧方式要求 Host 先写 HTML，再由一个 `text` 命令完成后半段。

V2：

1. 调用 `$text-to-html`。
2. 由 Host 检查并审批演示定位、事实/来源、叙事、分页脚本和视觉意图。
3. 确定性脚本只从已审批的 `presentation-plan.json` 开始编译并执行浏览器 QA。
4. 如果只需要网页演示，直接交付 HTML 包。
5. 如果需要 PPTX，再显式调用 `$html-to-pptx`。

好处是 HTML 成为可独立验收的正式产物，内容/视觉问题不会和 PowerPoint 转换问题混在一个错误阶段。

`$text-to-html` 能接受自然语言请求，是因为 Host/Codex 负责内容理解。
`scripts/run-pipeline.mjs` 不调用 LLM，也不会从一句需求自动写出事实、
故事线或页面文案；手工调用脚本时必须先准备并审批 plan。

### 用户自带 HTML

直接调用 `$html-to-pptx`。不要求 HTML 来自 `$text-to-html`，也不要求存在 `presentation-package.json`。

若存在兼容的 `presentation-package 1.0.0`，Skill 可读取稳定页面 ID、备注、来源和组件语义；版本不兼容会返回 `E_PROTOCOL_VERSION`，不会静默忽略。

### 一张或多张参考图

直接调用 `$image-to-pptx`。它必须独立完成 OCR、分层、原生重建和视觉证明。

通过质量门禁后，当前 CLI 默认生成 `html-package/`，可用
`--no-html-package` 关闭；`design-tokens.json` 是常规输出。若后续需要
手工微调 HTML 或把风格用于新内容，由用户或 Host 显式把这些产物传给
下一 Skill。它们不是直接 PPTX 输出的前置条件。

## 开发者迁移

### 根级共享 import

V1：

```js
import { runDeckPipeline } from "./run-deck-pipeline.mjs";
```

V2 每个 Skill 只导入自身发布根内的相对实现。例如
`html-to-pptx/scripts/convert.mjs` 使用：

```js
import { writeMeasurements } from "./measure-html.mjs";
```

禁止：

```js
import { runDeckPipeline } from "../../../scripts/run-deck-pipeline.mjs";
import something from "../html-to-pptx/...";
```

### manifest 与 presentation package

- `deck.manifest.json` 继续是具体 PPTX renderer 的渲染真相。
- `presentation-package.json` 是三个 Skill 之间可选的轻量交换包。
- 二者不能混为同一个 schema；`text-to-html` 无需生成 PPTX renderer manifest 才算完成。

### 质量门禁与状态

V1 的统一 pipeline gate 被拆为：

- `text-to-html`：内容、来源、HTML 桌面/手机/打印；
- `html-to-pptx`：DOM→native PPTX、局部降级、PPTX 几何和视觉差异；
- `image-to-pptx`：OCR 置信、分层、native/raster 计划和参考图差异。

共同评价维度保持一致，但报告、错误码和最早责任阶段属于各自 Skill。
当前三个 CLI 共同使用 `passed`/`failed` 作为自动运行结论，协议包还允许
`pending`。`review-required`/`packaged` 是可用的 Host 工作流描述，不是
三个 CLI 已统一实现的协议值；自动 `passed` 后仍须逐页检查全尺寸预览。

## 兼容策略

| 旧输入 | 过渡处理 |
|---|---|
| 已有 `deck.html` | 直接交给 `html-to-pptx` |
| 已有文本/Markdown | 先交给 `text-to-html` |
| 已有 `deck.plan.json` | 旧 `--native` 仅作兼容；建议转换为 V2 plan/HTML |
| 已有 `deck.manifest.json` | 可继续用旧 direct renderer；不视为 V2 文本入口 |
| 已有图片 | 交给 `image-to-pptx` |
| 已有 PDF | V2 三核心不处理；不得自动转成整页图片冒充可编辑 |

## 发布迁移

旧发布物：

```text
dist/pptx-creator.skill
```

V2 发布物：

```text
dist/v2/text-to-html.skill
dist/v2/html-to-pptx.skill
dist/v2/image-to-pptx.skill
```

`scripts/package-v2-skills.mjs` 与 `scripts/verify-v2-skills.mjs` 分别实现
三个包的构建和验证。组合测试使用三个独立 Skill 入口，不使用仓库根
运行时；发布判断以当次包验证和隔离执行证据为准，不以文档中的固定测试
数量或包哈希为准。

## 废弃节奏

1. 当前阶段：旧总路由保留，并明确标为兼容；V2 核心使用三个独立 Skill。
2. 稳定阶段：新样例与质量改进优先进入对应 Skill，并继续验证隔离和显式组合。
3. 后续主版本：根据实际使用情况决定是否删除旧 `text --native`/`text --direct`，删除前保留可执行迁移工具和明确版本说明。

删除旧入口不是 V2 独立性的证明。三 Skill 的源码、依赖、包、隔离执行与
组合证据必须各自成立。
