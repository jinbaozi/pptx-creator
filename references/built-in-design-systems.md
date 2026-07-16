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

## Host Selection Policy

Built-ins are candidates, not defaults. Resolve style in this order:

1. Honor an explicit user-requested style, brand, template, or visual reference.
2. Honor an explicitly provided project or input-adjacent `DESIGN.md` as a style lock.
3. If no style lock exists, the Host chooses from the audience, content, delivery environment, language, readability, and desired emotional tone. The Host may select any built-in or author a compatible custom HTML/CSS direction.
4. Never map a topic keyword directly to a visual system. In particular, AI, cloud, security, infrastructure, and developer-tool content do not automatically imply `dark-tech`.

The table above describes possible fit and mismatch signals only. It is not a topic router. `business-neutral` remains a deterministic safety fallback when no Host selection reaches the compiler; it is not a creative preference.

## Override Policy

An explicit user style always wins over generic heuristics and implicit defaults. If the user names a built-in design system explicitly, use it. A user- or project-provided `DESIGN.md` also acts as a style lock when the request does not override it.

## No Brand Clone Policy

Do not include real-brand 1:1 templates, logos, trademarked assets, commercial fonts, or large image packs in the built-in systems. Brand-inspired examples belong in a separate optional `inspirations/` collection with clear disclaimers.
