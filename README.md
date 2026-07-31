# pptx-creator V2

`pptx-creator` V2 发布三个可独立安装、独立运行的演示文稿 Skill：

| Skill | 适用任务 | 主要交付 |
| --- | --- | --- |
| [`text-to-html`](skills/text-to-html/SKILL.md) | 将经过 Host 审核的文本、Markdown 或大纲制作成离线 HTML 演示包 | HTML、预览、QA 证据与 `presentation-package.json` |
| [`html-to-pptx`](skills/html-to-pptx/SKILL.md) | 将本地 HTML 或兼容演示包转换为以原生对象为主的 PPTX | `final.pptx`、可编辑性与回渲 QA 证据 |
| [`image-to-pptx`](skills/image-to-pptx/SKILL.md) | 从图片、截图或参考幻灯片重建可编辑 PPTX | `final.pptx`、OCR/置信度、降级与回渲 QA 证据 |

每个 Skill 都拥有自己的 `SKILL.md`、依赖锁文件、测试与运行时；它们不会导入或调用兄弟 Skill。跨 Skill 组合只能通过版本化的 `pptx-creator.presentation-package` 1.0.0 数据包完成。

## 安装

从仓库根目录构建并验证三个独立安装包：

```bash
npm ci
npm run package:skills
npm run verify:skills
```

在修改协议或跨 Skill 组合后，再运行：

```bash
npm run test:integration
npm run test:composition
```

前者验证版本化交接记录，后者验证三个 Skill 仍能独立安装和执行。

这会生成并验证：

```text
dist/v2/text-to-html.skill
dist/v2/html-to-pptx.skill
dist/v2/image-to-pptx.skill
```

在 Codex 中按需分别导入所需的 `.skill` 包。也可以直接使用任一
`skills/<name>/` 源目录：进入该目录，按其 `SKILL.md` 的安装说明安装依赖、
系统工具和浏览器，再运行该 Skill 的公开命令。不要把仓库根目录当作运行时依赖。

## 组合方式

文本生成 PPTX 时，显式串联两个独立 Skill：

```text
已审核的内容和演示计划
  -> text-to-html
  -> 已通过 QA 的 presentation-package.json
  -> html-to-pptx
  -> final.pptx
```

图片重建可独立完成：

```text
参考图片 -> image-to-pptx -> final.pptx
```

当图片重建需要进入 HTML 到 PPTX 的后续转换时，`image-to-pptx` 可显式输出
兼容的 HTML 演示包，再由 `html-to-pptx` 消费。任何协议版本、路径或验证状态
不符合要求的输入都会被拒绝。

## License

[MIT](LICENSE)
