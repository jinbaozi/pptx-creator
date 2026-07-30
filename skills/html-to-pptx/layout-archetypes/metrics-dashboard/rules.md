# Metrics-dashboard archetype — role-aware rules

- **Headline claim**: One clear KPI statement using `{typography.title}`; floor `fontSize >= 24pt`, `lineHeight >= 1.10`.
- **Metric value**: Each KPI number uses `{typography.metric}`; floor `fontSize >= 32pt`, `lineHeight >= 1.05`. Never below 28pt.
- **Metric label**: KPI label / unit uses `{typography.body}`; floor `fontSize >= 11pt`, `lineHeight >= 1.35`.
- **KPI card count**: At most `6` KPI cards per slide; overflow must move to a "more metrics" slide.
- **Card spacing**: Gap between KPI cards `>= {spacing.md}`; outer card padding `>= {spacing.sm}`.
- **Whitespace**: Page margins `>= {spacing.lg}`; section title to first row `>= {spacing.md}`.
- **Color discipline**: Use `{colors.primary}` plus at most one accent (delta / trend color); total accents `<= 2`. No per-card rainbow.
- **Font-family cap**: Distinct `font-family` count `<= 3` (numeric + label + secondary) across the dashboard.
- **Decorative density**: At most one rounded-token variance; `<= 1` icon-circle triad across the slide.
- **Trend treatment**: Up/down/trend markers use shape primitives (triangle, arrow) — never a rasterized sparkline.
- **Editable target**: Each KPI card is a native group of text + shape; aim for Editability Ladder Level 5.
