---
version: alpha
name: Chinese Government
description: A formal government design system for public-sector and institutional presentation decks.
colors:
  primary: "#B91C1C"
  secondary: "#4B5563"
  accent: "#D97706"
  background: "#FDFBF7"
  surface: "#FFF7ED"
  surfaceAlt: "#FEF3C7"
  text: "#1F2937"
  textMuted: "#6B7280"
  border: "#D1D5DB"
  success: "#15803D"
  warning: "#D97706"
  danger: "#B91C1C"
typography:
  title:
    fontFamily: "SimHei"
    fontSize: 32
    fontWeight: 700
    lineHeight: 1.2
  subtitle:
    fontFamily: "Microsoft YaHei"
    fontSize: 20
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "SimHei"
    fontSize: 22
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "Microsoft YaHei"
    fontSize: 16
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: "Microsoft YaHei"
    fontSize: 12
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Arial"
    fontSize: 40
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 36
rounded:
  sm: 2
  md: 4
  lg: 6
  xl: 10
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 20
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 16
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: 8
---

# Chinese Government

## Overview

Chinese Government is a formal design system for government reports, institutional projects, operating system rollouts, and public-sector briefings. It uses a restrained red/gold/deep-blue palette with strong headings and minimal decoration.

## Colors

Use warm off-white backgrounds and cream surfaces. Formal red primary for titles, headers, and key emphasis. Gold accent for achievement badges and milestone markers. Deep gray text for body copy. Decoration must be restrained.

## Typography

Use SimHei for formal headings and Microsoft YaHei for body text. Titles should be bold and authoritative. Body text at 16pt for formal readability in meeting rooms.

## Layout

Use structured layouts with clear section numbering. Favor top-down hierarchy: title bar, content area, footer notes. Align to formal document conventions.

## Elevation & Depth

Flat surfaces with thin borders. No shadows, glows, or gradients. The deck should feel like an official report, not a marketing campaign.

## Shapes

Use simple rectangles, thin horizontal rules, and understated arrows. Red accent lines for section dividers. Minimal rounding.

## Components

Use hero cards for report summaries, content cards for policy points, gold badges for milestones, and native tables for compliance data.

## Presentation Patterns

### Cover Slide

Use a formal red title, gold subtitle accent line, report metadata (date, department), and one hero card with the report scope.

### Four-card Overview

Arrange four cards for key work areas: 系统适配, 平台迁移, 安全合规, 运维保障.

### Metrics Slide

Show 3-5 achievement metrics with large numbers. Each metric includes a formal label and completion status.

### Architecture or Method Slide

Show system architecture or implementation methodology with labeled modules and clear top-to-bottom flow.

### Comparison Slide

Compare domestic vs. imported solutions, or before/after migration states in a formal native table with red headers.

### Timeline or Process Slide

Use a horizontal timeline with gold milestone markers for project phases and delivery dates.

## PPTX Export Rules

- All visible titles must be exported as native PowerPoint text boxes.
- Body text must be exported as native PowerPoint text boxes unless the source is an unreadable raster image.
- Simple rectangles, rounded rectangles, circles, dividers, and arrows must be exported as native PowerPoint shapes.
- Tables must be exported as native PowerPoint tables whenever the cell structure is clear.
- Charts should be exported as native charts when data is available. If only a screenshot is available, use an image asset and mark it in the editable report.
- Complex illustrations, photos, shadows, decorative textures, and noisy backgrounds may be exported as image assets.
- Full-slide raster fallback is only allowed when visual fidelity is explicitly more important than editability.

## Editability Rules

Default target: Level 4.

Level 5 means all major objects are native PowerPoint objects.
Level 4 means all text and main shapes are editable, while complex decorative assets may be rasterized.
Level 3 means text is editable, but many visual objects are rasterized.
Level 2 means only key text and a few shapes are editable.
Level 1 means full-slide raster fallback.

For government reports, target Level 4 or above. Official seals or emblems may be rasterized images if provided by the user.

## Do's and Don'ts

### Do

- Use formal red headings and restrained gold accents.
- Keep decoration minimal and authoritative.
- Use structured section numbering.
- Use native tables for compliance data.
- Use native text boxes for all generated copy.

### Don't

- Do not use playful or consumer marketing styles.
- Do not add unofficial logos or emblems.
- Do not use dark cyber or neon palettes.
- Do not rasterize formal text unless unavoidable.
- Do not mimic specific government agency branding.
- Do not create full-slide screenshots as PPT pages by default.
