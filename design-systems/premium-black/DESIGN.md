---
version: alpha
name: Premium Black
description: A cinematic premium design system for hard-tech launches and dramatic brand pages.
colors:
  primary: "#E5E7EB"
  secondary: "#9CA3AF"
  accent: "#D4AF37"
  background: "#050505"
  surface: "#111111"
  surfaceAlt: "#1A1A1A"
  text: "#F9FAFB"
  textMuted: "#9CA3AF"
  border: "#374151"
  success: "#34D399"
  warning: "#FBBF24"
  danger: "#F87171"
typography:
  title:
    fontFamily: "Segoe UI"
    fontSize: 44
    fontWeight: 300
    lineHeight: 1.1
  subtitle:
    fontFamily: "Segoe UI"
    fontSize: 18
    fontWeight: 300
    lineHeight: 1.4
  heading:
    fontFamily: "Segoe UI"
    fontSize: 24
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Segoe UI"
    fontSize: 15
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "Segoe UI"
    fontSize: 11
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Segoe UI Light"
    fontSize: 56
    fontWeight: 300
    lineHeight: 1.0
spacing:
  xs: 6
  sm: 12
  md: 24
  lg: 40
  xl: 60
rounded:
  sm: 0
  md: 2
  lg: 4
  xl: 8
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 32
  content-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 20
  table-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
    rounded: "{rounded.md}"
    padding: 8
---

# Premium Black

## Overview

Premium Black is a cinematic design system for premium covers, hard-tech launches, and dramatic brand pages. It uses a black canvas, large light typography, metallic gold accents, and sparse dramatic layouts.

## Colors

Use true black backgrounds and charcoal surfaces. Light gray primary for headlines. Gold accent for premium highlights, badges, and key lines. Maximum contrast, minimum color count.

## Typography

Use Segoe UI Light for oversized titles up to 44pt. Thin, elegant, spacious. Body text stays readable but secondary to the headline drama. Metrics use 56pt light weight.

## Layout

Favor sparse layouts with extreme whitespace. One message per slide. Center or left-align with dramatic negative space. Less is more.

## Elevation & Depth

No shadows. Use thin gold border lines for premium accents. Flat black surfaces only.

## Shapes

Use minimal rectangles with sharp or barely-rounded corners. Thin gold divider lines. No decorative shapes unless they carry meaning.

## Components

Use hero cards sparingly for key reveals, content cards for feature highlights, gold badges for premium labels, and native tables only when data is essential.

## Presentation Patterns

### Cover Slide

Use an oversized light title on black, a gold accent line, and one sparse subtitle. This slide should feel cinematic.

### Four-card Overview

Use four minimal dark cards with gold headings. Each card has one word headline and one sentence. Keep it dramatic, not dense.

### Metrics Slide

Show 2-3 hero metrics with 56pt light numbers and gold labels. Fewer metrics, more impact.

### Architecture or Method Slide

Use a minimal three-step reveal with gold connectors. Each step gets one bold label and one line of description.

### Comparison Slide

Compare tiers or editions with a sparse table. Gold headers on black. Highlight the premium tier.

### Timeline or Process Slide

Use a horizontal gold timeline with minimal markers. Show launch phases with dramatic spacing.

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

For premium launches, target Level 4 or above. Cinematic background textures may be rasterized if reported.

## Do's and Don'ts

### Do

- Use black backgrounds and large light typography.
- Use gold accents sparingly for premium feel.
- Keep layouts sparse and dramatic.
- Use one central message per slide.
- Use native text boxes for all generated copy.

### Don't

- Do not overcrowd slides with dense content.
- Do not use bright saturated colors beyond gold accent.
- Do not use playful or casual typography.
- Do not rasterize headline text unless unavoidable.
- Do not mimic real luxury brand identities.
- Do not create full-slide screenshots as PPT pages by default.
