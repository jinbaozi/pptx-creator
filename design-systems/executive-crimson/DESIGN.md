---
version: alpha
name: Executive Crimson
description: A formal crimson-accent enterprise theme for leadership reports, audits, and formal summaries.
colors:
  primary: "#B91C1C"
  secondary: "#3F3F46"
  accent: "#C2410C"
  background: "#FFFFFF"
  surface: "#FAFAFA"
  surfaceAlt: "#FEF2F2"
  text: "#18181B"
  textMuted: "#52525B"
  border: "#E4E4E7"
  success: "#15803D"
  warning: "#B45309"
  danger: "#991B1B"
typography:
  title: { fontFamily: "Microsoft YaHei", fontSize: 33, fontWeight: 700, lineHeight: 1.18 }
  subtitle: { fontFamily: "Microsoft YaHei", fontSize: 19, fontWeight: 500, lineHeight: 1.35 }
  heading: { fontFamily: "Microsoft YaHei", fontSize: 22, fontWeight: 700, lineHeight: 1.25 }
  body: { fontFamily: "Microsoft YaHei", fontSize: 15, fontWeight: 400, lineHeight: 1.55 }
  caption: { fontFamily: "Microsoft YaHei", fontSize: 10, fontWeight: 400, lineHeight: 1.35 }
  metric: { fontFamily: "Arial", fontSize: 38, fontWeight: 700, lineHeight: 1.0 }
spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 34 }
rounded: { sm: 2, md: 4, lg: 6, xl: 10 }
components:
  slide-background: { backgroundColor: "{colors.background}" }
  hero-card: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.md}", padding: 18 }
  content-card: { backgroundColor: "{colors.surface}", textColor: "{colors.text}", borderColor: "{colors.border}", rounded: "{rounded.md}", padding: 14 }
  table-header: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", typography: "{typography.body}" }
  badge: { backgroundColor: "{colors.surfaceAlt}", textColor: "{colors.primary}", rounded: "{rounded.lg}", padding: 8 }
---

# Executive Crimson

## Overview

Executive Crimson is a formal report theme. It suits leadership summaries, audit findings, milestone reports, and serious organizational communication.

## Colors

Use crimson as a restrained emphasis color. Keep backgrounds white and surfaces quiet. Use warm warning colors only for status signals.

## Typography

Use Microsoft YaHei for all Chinese text. Titles should feel formal and stable, not decorative.

## Layout

Prefer title bars, structured sections, numbered findings, evidence tables, and compact conclusion slides.

## PPTX Export Rules

- Export all visible text as native PowerPoint text boxes.
- Export cards, lines, section bars, status marks, and table structure as native objects.
- Preserve formal alignment and consistent margins.
- Rasterize only complex screenshots or approved visual references.

## Editability Rules

Target Level 4 or Level 5. Formal report decks should remain easy to revise.

## Do's and Don'ts

### Do

- Use concise headings and explicit status labels.
- Keep red accents limited to hierarchy and warnings.
- Use tables for evidence and comparison.

### Don't

- Do not overuse red backgrounds.
- Do not add ornamental decoration.
- Do not clone government or enterprise identity systems.
