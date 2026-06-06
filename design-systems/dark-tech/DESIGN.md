---
version: alpha
name: Dark Tech
description: A dark technology design system for AI, cloud, security, and developer tool presentations.
colors:
  primary: "#22D3EE"
  secondary: "#94A3B8"
  accent: "#A78BFA"
  background: "#020617"
  surface: "#0F172A"
  surfaceAlt: "#1E293B"
  text: "#E5E7EB"
  textMuted: "#94A3B8"
  border: "#334155"
  success: "#34D399"
  warning: "#FBBF24"
  danger: "#F87171"
typography:
  title:
    fontFamily: "Segoe UI"
    fontSize: 34
    fontWeight: 700
    lineHeight: 1.15
  subtitle:
    fontFamily: "Segoe UI"
    fontSize: 20
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "Segoe UI"
    fontSize: 22
    fontWeight: 600
    lineHeight: 1.25
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
    fontFamily: "Consolas"
    fontSize: 42
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 36
rounded:
  sm: 4
  md: 8
  lg: 12
  xl: 18
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.lg}"
    padding: 20
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 16
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.xl}"
    padding: 8
---

# Dark Tech

## Overview

Dark Tech is a high-contrast dark design system for AI, cloud, security, infrastructure, and developer tool presentations. It uses cyan and purple luminous accents on deep navy backgrounds.

## Colors

Use near-black backgrounds and slate surfaces. Cyan primary drives headings, links, and key metrics. Purple accent highlights badges and secondary emphasis. Maintain strong text contrast at all times.

## Typography

Use Segoe UI for UI-style copy and Consolas for metrics and code-like numbers. Keep titles bold and compact. Body text must stay readable on dark surfaces.

## Layout

Use card-based grids with clear gutters. Group technical content into labeled panels. Favor left-aligned hierarchies with luminous divider lines.

## Elevation & Depth

Use subtle border glow via thin bright borders on dark surfaces. Avoid heavy drop shadows. Luminous dividers separate sections.

## Shapes

Prefer rounded rectangles, thin lines, and simple arrows. Use circles for node diagrams. Keep shapes flat with border highlights.

## Components

Use hero cards for product positioning, content cards for feature groups, badges for tech labels, and native tables for comparison data.

## Presentation Patterns

### Cover Slide

Use a large cyan title on dark background, a purple-accent subtitle, and one hero card block. Add a thin luminous divider below the title.

### Four-card Overview

Arrange four dark surface cards in a 2x2 grid with cyan headings. Each card has one label, one short description, and an optional badge.

### Metrics Slide

Display 3-5 metrics with large Consolas numbers in cyan. Each metric includes a label and one explanatory line in muted text.

### Architecture or Method Slide

Use left-to-right pipeline layout with labeled nodes and thin connector lines. Group services into surface-alt panels.

### Comparison Slide

Use a two-column or table layout with cyan headers on dark surfaces. Highlight winners with accent purple, not background fills.

### Timeline or Process Slide

Use a horizontal timeline with cyan milestone markers. Vertical stacks work for deployment phases.

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

For dark tech presentations, target Level 4 or above. Glow effects that cannot be native should be rasterized and reported.

## Do's and Don'ts

### Do

- Use dark backgrounds with high-contrast text.
- Use cyan for primary emphasis and purple for secondary accents.
- Use thin luminous dividers between sections.
- Keep architecture diagrams simple and labeled.
- Use native text boxes for all generated copy.

### Don't

- Do not use light backgrounds that break the dark theme.
- Do not use low-contrast gray-on-gray text.
- Do not add decorative cyber stock imagery by default.
- Do not rasterize text unless unavoidable.
- Do not mimic real cloud vendor branding.
- Do not create full-slide screenshots as PPT pages by default.
