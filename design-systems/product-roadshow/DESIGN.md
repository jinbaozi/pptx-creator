---
version: alpha
name: Product Roadshow
description: A bold roadshow design system for product launches, pitches, and business plans.
colors:
  primary: "#7C3AED"
  secondary: "#6B7280"
  accent: "#F97316"
  background: "#FFFFFF"
  surface: "#F5F3FF"
  surfaceAlt: "#EDE9FE"
  text: "#111827"
  textMuted: "#6B7280"
  border: "#E5E7EB"
  success: "#16A34A"
  warning: "#F59E0B"
  danger: "#DC2626"
typography:
  title:
    fontFamily: "Microsoft YaHei"
    fontSize: 38
    fontWeight: 800
    lineHeight: 1.1
  subtitle:
    fontFamily: "Microsoft YaHei"
    fontSize: 22
    fontWeight: 500
    lineHeight: 1.3
  heading:
    fontFamily: "Microsoft YaHei"
    fontSize: 24
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: "Microsoft YaHei"
    fontSize: 16
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Microsoft YaHei"
    fontSize: 12
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Arial"
    fontSize: 48
    fontWeight: 800
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 10
  md: 18
  lg: 28
  xl: 40
rounded:
  sm: 6
  md: 10
  lg: 16
  xl: 24
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.xl}"
    padding: 24
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: 18
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.xl}"
    padding: 10
---

# Product Roadshow

## Overview

Product Roadshow is a persuasive launch design system for product pitches, business plans, and sales decks. It features large headlines, bold hero cards, big metrics, and a confident purple-orange rhythm.

## Colors

Use white backgrounds and violet-tinted surfaces. Purple primary drives headlines and key claims. Orange accent powers CTAs, badges, and highlight metrics. Keep contrast high for stage projection.

## Typography

Use Microsoft YaHei with extra-bold titles up to 38pt. Large Arial metrics for impact numbers. Keep body copy punchy and short—this is a pitch, not a report.

## Layout

Favor hero-first layouts with one dominant message per slide. Use asymmetric emphasis: big left title, supporting cards on the right. Maintain persuasive vertical rhythm.

## Elevation & Depth

Use bold rounded cards with light borders. Minimal shadows. Hero cards should feel prominent through size and color, not effects.

## Shapes

Use large rounded rectangles for hero blocks, bold badges, and simple arrows for narrative flow. Circles for milestone markers.

## Components

Use hero cards for value propositions, content cards for feature pillars, orange badges for proof points, and native tables for competitive comparisons.

## Presentation Patterns

### Cover Slide

Use an oversized purple title, orange-accent subtitle, and one bold hero card with the core pitch line. Maximum visual impact, minimum text.

### Four-card Overview

Arrange four violet-surface cards in a 2x2 grid. Each card sells one benefit: speed, scale, savings, or security.

### Metrics Slide

Display 3-5 hero metrics with 48pt numbers. Each metric needs a bold label and one proof sentence. This slide should wow investors.

### Architecture or Method Slide

Show how the product works in three to five clear steps. Use bold headings and orange accent arrows between stages.

### Comparison Slide

Compare against alternatives in a table or two-column layout. Highlight your advantages with purple headers and orange callouts.

### Timeline or Process Slide

Use a horizontal launch roadmap with bold milestone markers. Show go-to-market phases with clear dates.

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

For roadshow decks, target Level 4 or above. Marketing hero imagery may be rasterized if reported.

## Do's and Don'ts

### Do

- Use large bold headlines and big metrics.
- Keep each slide focused on one persuasive claim.
- Use orange accents for proof points and CTAs.
- Use hero cards for the main message on every slide.
- Use native text boxes for all generated copy.

### Don't

- Do not write dense paragraphs—pitches are concise.
- Do not use more than three font sizes per slide.
- Do not use low-energy muted palettes.
- Do not rasterize text unless unavoidable.
- Do not mimic real startup or VC branding.
- Do not create full-slide screenshots as PPT pages by default.
