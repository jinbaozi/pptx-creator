---
version: alpha
name: Enterprise Blueprint
description: A crisp consulting-style enterprise theme for strategy, transformation, and technical executive decks.
colors:
  primary: "#1D4ED8"
  secondary: "#334155"
  accent: "#0284C7"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  surfaceAlt: "#E0F2FE"
  text: "#0F172A"
  textMuted: "#475569"
  border: "#CBD5E1"
  success: "#059669"
  warning: "#D97706"
  danger: "#B91C1C"
typography:
  title: { fontFamily: "Microsoft YaHei", fontSize: 34, fontWeight: 700, lineHeight: 1.15 }
  subtitle: { fontFamily: "Microsoft YaHei", fontSize: 20, fontWeight: 500, lineHeight: 1.35 }
  heading: { fontFamily: "Microsoft YaHei", fontSize: 22, fontWeight: 700, lineHeight: 1.25 }
  body: { fontFamily: "Microsoft YaHei", fontSize: 15, fontWeight: 400, lineHeight: 1.5 }
  caption: { fontFamily: "Microsoft YaHei", fontSize: 10, fontWeight: 400, lineHeight: 1.3 }
  metric: { fontFamily: "Arial", fontSize: 40, fontWeight: 700, lineHeight: 1.0 }
spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 36 }
rounded: { sm: 3, md: 6, lg: 8, xl: 12 }
components:
  slide-background: { backgroundColor: "{colors.background}" }
  hero-card: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.lg}", padding: 20 }
  content-card: { backgroundColor: "{colors.surface}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.md}", padding: 16 }
  table-header: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", typography: "{typography.body}" }
  badge: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", rounded: "{rounded.xl}", padding: 8 }
---

# Enterprise Blueprint

## Overview

Enterprise Blueprint is for strategy, transformation, and executive technical decks. It uses a white base, precise blue accents, compact grids, and native PowerPoint components.

## Colors

Use primary blue for hierarchy and section anchors. Keep secondary tones neutral. Avoid decorative gradients and brand-like marks.

## Typography

Use Microsoft YaHei for Chinese content and Arial for metrics. Keep text dense but readable, with clear title/body contrast.

## Layout

Prefer structured grids, section headers, process lanes, and four-card summaries. Use a restrained amount of whitespace and align content to shared axes.

## PPTX Export Rules

- Export all title, body, metric, and label text as native PowerPoint text boxes.
- Export cards, dividers, arrows, badges, and chart primitives as native PowerPoint shapes.
- Use native tables for structured rows and columns.
- Use raster images only for photos, screenshots, complex illustrations, and user-approved low-editability regions.
- Keep slide elements aligned to repeatable enterprise grids.

## Editability Rules

Target Level 4 or Level 5. Text, tables, charts, and simple process diagrams should remain editable.

## Do's and Don'ts

### Do

- Use clear section anchors and compact labels.
- Keep table headers and chart labels consistent.
- Use native arrows for process flow.

### Don't

- Do not introduce unrelated color accents.
- Do not rasterize text.
- Do not mimic a real consulting brand template.
