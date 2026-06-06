---
version: alpha
name: Finance Boardroom
description: A calm executive finance theme for KPI reviews, investment memos, and boardroom analysis.
colors:
  primary: "#0F766E"
  secondary: "#334155"
  accent: "#4F46E5"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  surfaceAlt: "#ECFDF5"
  text: "#111827"
  textMuted: "#475569"
  border: "#D1D5DB"
  success: "#047857"
  warning: "#B45309"
  danger: "#B91C1C"
typography:
  title: { fontFamily: "Microsoft YaHei", fontSize: 32, fontWeight: 700, lineHeight: 1.16 }
  subtitle: { fontFamily: "Microsoft YaHei", fontSize: 19, fontWeight: 500, lineHeight: 1.35 }
  heading: { fontFamily: "Microsoft YaHei", fontSize: 21, fontWeight: 700, lineHeight: 1.25 }
  body: { fontFamily: "Microsoft YaHei", fontSize: 14, fontWeight: 400, lineHeight: 1.5 }
  caption: { fontFamily: "Microsoft YaHei", fontSize: 10, fontWeight: 400, lineHeight: 1.3 }
  metric: { fontFamily: "Arial", fontSize: 42, fontWeight: 700, lineHeight: 1.0 }
spacing: { xs: 4, sm: 8, md: 14, lg: 22, xl: 34 }
rounded: { sm: 3, md: 5, lg: 8, xl: 12 }
components:
  slide-background: { backgroundColor: "{colors.background}" }
  hero-card: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.lg}", padding: 18 }
  content-card: { backgroundColor: "{colors.surface}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.md}", padding: 14 }
  table-header: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", typography: "{typography.body}" }
  badge: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", rounded: "{rounded.xl}", padding: 8 }
---

# Finance Boardroom

## Overview

Finance Boardroom is for KPI reviews, investment memos, financial planning, and operating dashboards. It emphasizes calm contrast and editable data visuals.

## Colors

Use teal for positive emphasis and indigo for secondary analysis. Keep surfaces light and print-friendly.

## Typography

Use compact body text and large numeric metrics. Avoid tiny footnotes unless absolutely needed.

## Layout

Prefer dashboard grids, metric rows, variance tables, and concise executive summaries.

## PPTX Export Rules

- Export metrics, labels, tables, and chart annotations as native text.
- Export charts as native shape-based charts when data is available.
- Use native tables for financial rows and comparison matrices.
- Raster images are acceptable only for source screenshots or complex third-party visuals.

## Editability Rules

Target Level 4 or Level 5. Financial decks need editable numbers, labels, and table cells.

## Do's and Don'ts

### Do

- Use consistent decimal and percent notation.
- Keep charts simple and labeled.
- Use status colors only when they carry meaning.

### Don't

- Do not hide key numbers in images.
- Do not overfill slides with ungrouped metrics.
- Do not use decorative finance imagery.
