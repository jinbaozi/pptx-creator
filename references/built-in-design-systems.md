# Built-in Design Systems

PPTX Creator ships a small curated set of generic, scenario-based `DESIGN.md` files. These are safe baselines, not real-brand clones.

## Built-ins

| ID | Use when | Avoid when |
| --- | --- | --- |
| `business-neutral` | enterprise briefings, product summaries, technical proposals | artistic, entertainment, or highly cinematic decks |
| `warm-editorial` | courses, whitepapers, research reports, content-heavy decks | dense dashboards or developer-console demos |
| `paper-minimal` | Chinese handouts, academic material, lecture decks | high-energy launches or dark cyber visuals |
| `dark-tech` | AI, cloud, security, infrastructure, developer tools | print-heavy reports or low-contrast display environments |
| `ai-infra` | model platforms, AI infrastructure, inference systems, toolchain roadshows | lifestyle marketing or government reports |
| `product-roadshow` | product launches, roadshows, business plans, sales decks | dense research reports or legal documents |
| `developer-docs` | technical documentation, architecture explainers, API/platform decks | high-emotion consumer campaigns |
| `dashboard-data` | analytics, observability, monitoring, operations reviews | sparse premium covers or lecture handouts |
| `premium-black` | premium covers, hard-tech launches, cinematic brand pages | dense enterprise reports or print-heavy handouts |
| `chinese-government` | Government, public-sector, operating systems, formal reports | consumer marketing or playful product launches |
| `enterprise-blueprint` | consulting-style strategy decks, transformation programs, technical executive summaries | creative campaigns, cinematic brand pages, or playful consumer content |
| `executive-crimson` | formal leadership reports, audit findings, milestone summaries, serious organizational communication | decorative entertainment decks, consumer marketing, or government identity systems |
| `finance-boardroom` | KPI reviews, investment memos, financial planning, boardroom analysis, operating dashboards | consumer marketing, decorative finance imagery, or print-heavy narrative handouts |

## Selection Heuristics

- AI / cloud / security / developer tools -> `dark-tech`.
- 模型平台 / 推理系统 / AI 基础设施 / 工具链 -> `ai-infra`.
- 技术文档 / 架构说明 / API / 平台说明 -> `developer-docs`.
- 数据看板 / 监控 / 可观测性 / 运营分析 -> `dashboard-data`.
- 产品介绍 / 路演 / 发布 / 商业计划书 -> `product-roadshow`.
- 学术 / 课程 / 白皮书 / 研究报告 -> `warm-editorial`.
- 中文讲义 / 东方纸感 / 克制学术材料 -> `paper-minimal`.
- 高端封面 / 硬科技发布 / 电影感品牌页 -> `premium-black`.
- 政务 / 公共部门 / 操作系统 -> `chinese-government`.
- 集团战略 / 业务架构 / 组织流程 / 长期规划 -> `enterprise-blueprint`.
- 政务汇报 / 红色主题 / 党政机关 / 央企 -> `executive-crimson`.
- 金融路演 / 投行报告 / 财务披露 / 投资者沟通 -> `finance-boardroom`.
- Everything else -> `business-neutral`.

## Override Policy

User-provided `DESIGN.md` always wins over built-ins. If the user names a built-in design system explicitly, use it unless a higher-priority local `DESIGN.md` is also explicitly provided.

## No Brand Clone Policy

Do not include real-brand 1:1 templates, logos, trademarked assets, commercial fonts, or large image packs in the built-in systems. Brand-inspired examples belong in a separate optional `inspirations/` collection with clear disclaimers.
