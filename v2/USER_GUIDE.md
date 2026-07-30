# V2 普通用户入口

## 选哪个 Skill

| 你的输入 | 使用 |
|---|---|
| 一段需求、Markdown、长文或大纲，希望 Host 帮你策划 | `$text-to-html` |
| 已有 HTML 演示文稿 | `$html-to-pptx` |
| 一张或多张参考图/截图 | `$image-to-pptx` |

三个入口分别见
[`text-to-html`](../skills/text-to-html/SKILL.md)、
[`html-to-pptx`](../skills/html-to-pptx/SKILL.md) 和
[`image-to-pptx`](../skills/image-to-pptx/SKILL.md)。
源码审计、实测指标、WPS 证据与已知限制见
[`VALIDATION_REPORT.md`](VALIDATION_REPORT.md)。

## 先理解 Host 与脚本的分工

本页的“使用 `$text-to-html`”是给 Codex/Host 的请求，不是把一句自然语言
直接传给脚本。两层职责如下：

| 责任方 | 负责 | 不负责 |
|---|---|---|
| Host/Codex | 读完整材料，确定受众与目标，核对事实和来源，取舍内容，设计故事线、页面脚本与视觉意图，审批 plan，逐页检查预览 | 不把未验证事实或未看过的预览冒充完成 |
| 确定性脚本 | 校验已审核的 plan，编译 HTML，测量浏览器布局，转换 PPTX，执行 OCR/几何/可编辑性/回渲检查和有限安全修复 | 不调用 LLM，不自动理解自然语言，不研究事实，不编写或改写叙事 |

`text-to-html` 的脚本入口实际接收 Host 已审核的
`presentation-plan.json`。`scaffold-plan.mjs` 只能按 Markdown 标题和列表
搭草稿，输出仍要求 Host 审核；它不是自然语言理解器或事实验证器。

## 文本生成 HTML

下面是发给 Host/Codex 的示例：

```text
使用 $text-to-html，把这份季度复盘 Markdown 做成 8 页中文 HTML 演示。
受众是管理层，现场汇报 12 分钟。必须保留收入、续费率和三个风险，
所有数据按原文标注来源；不要生成 PPTX。
```

Host 先形成并审批内容计划，确定性脚本再生成和检查 HTML。交付应包含离线
HTML、资源、设计令牌、来源、演讲者备注、桌面/手机截图和 QA 报告。

## HTML 转可编辑 PPTX

下面是发给 Host/Codex 的示例：

```text
使用 $html-to-pptx，把这个本地 HTML 目录转换为主要元素可编辑的 PPTX。
保持原布局，不做创意重设计；不允许整页截图，记录所有局部降级并运行视觉对比。
```

HTML 可以是用户自己制作的，不需要先运行 `$text-to-html`。

## 参考图重建 PPTX

下面是发给 Host/Codex 的示例：

```text
使用 $image-to-pptx，把这 5 张幻灯片截图重建为一个可编辑 PPTX。
看不清的文字不要猜；在报告中标出 OCR 低置信区域和局部图片区域。
```

Skill 应直接输出 PPTX，不需要安装另外两个 Skill。

## 文本生成 PPTX

这是两个显式步骤：

```text
先使用 $text-to-html 生成并通过浏览器验证 HTML 包；
再使用 $html-to-pptx 将这个 HTML 包转换为可编辑 PPTX。
```

第一步不通过时，不进入第二步。第二步失败也不会修改第一步的事实或叙事。

## 如何判断真正完成

完成不等于“命令退出 0”。至少检查：

- HTML 桌面和手机截图没有文字溢出、模块重叠或横向滚动；
- PPTX 能打开；
- 文字、形状、表格、图表和主要视觉元素可编辑；
- 没有整页图片冒充可编辑页；
- 来源、低置信内容和局部栅格化都有报告；
- PPTX 重新渲染图与 HTML/参考图通过阈值；
- 修复后有新的截图和报告，而不是复用旧证据。

如果门禁失败，Skill 应返回失败原因和剩余问题，不应交付“已完成”。

当前三个 CLI 的机器可读结论以 `passed` / `failed` 为主，互操作包还可能
在执行中使用 `pending`：

- `pending`：尚未形成通过的自动证据；
- `failed`：不能交付，先查看报告中的错误码和最早责任阶段；
- `passed`：该 Skill 的自动门禁通过，但仍须由 Host 逐页查看全尺寸预览。

`review-required` 和 `packaged` 可以用于描述 Host 工作流阶段，但目前不是
三个 CLI 统一写出的协议状态，不要把它们当成跨 Skill 的机器判断条件。
