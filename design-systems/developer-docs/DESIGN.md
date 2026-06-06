---
version: alpha
name: Developer Docs
description: A clean documentation design system for technical API and platform presentation decks.
colors:
  primary: "#2563EB"
  secondary: "#64748B"
  accent: "#10B981"
  background: "#FFFFFF"
  surface: "#F8FAFC"
  surfaceAlt: "#F1F5F9"
  text: "#111827"
  textMuted: "#64748B"
  border: "#E2E8F0"
  success: "#10B981"
  warning: "#F59E0B"
  danger: "#EF4444"
typography:
  title:
    fontFamily: "Segoe UI"
    fontSize: 30
    fontWeight: 700
    lineHeight: 1.2
  subtitle:
    fontFamily: "Segoe UI"
    fontSize: 18
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "Segoe UI"
    fontSize: 20
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Segoe UI"
    fontSize: 14
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: "Consolas"
    fontSize: 11
    fontWeight: 400
    lineHeight: 1.4
  metric:
    fontFamily: "Consolas"
    fontSize: 36
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 4
  sm: 8
  md: 14
  lg: 20
  xl: 32
rounded:
  sm: 3
  md: 6
  lg: 8
  xl: 12
components:
  slide-background:
    backgroundColor: "{colors.background}"
  hero-card:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 16
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.md}"
    padding: 14
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: 6
---

# Developer Docs

## Overview

Developer Docs is a precise documentation design system for technical decks, API explainers, architecture overviews, and platform guides. It favors clean docs layout, code blocks, precise tables, and low ornamentation.

## Colors

Use white backgrounds and light gray surfaces. Blue primary for headings and links. Green accent for success states, API endpoints, and status badges. Keep the palette neutral and information-dense.

## Typography

Use Segoe UI for prose and Consolas for code snippets, endpoints, and metrics. Smaller body size (14pt) is acceptable because docs slides pack more detail. Never go below 11pt.

## Layout

Favor docs-style two-column layouts: explanation left, code or diagram right. Use consistent indentation and alignment. Tables should be precise with clear headers.

## Elevation & Depth

Flat design only. Thin borders on code blocks and tables. No shadows or gradients.

## Shapes

Use simple rectangles for code blocks, thin dividers, and arrows for request/response flow. Minimal rounding.

## Components

Use hero cards for API overview, content cards for endpoint groups, green badges for HTTP methods, and native tables for parameter references.

## Presentation Patterns

### Cover Slide

Use a blue title, version subtitle in Consolas, and one hero card with the API or platform name. Clean and documentation-like.

### Four-card Overview

Arrange four cards for core concepts: authentication, endpoints, rate limits, and error handling.

### Metrics Slide

Show 3-4 technical metrics: latency p99, requests/sec, uptime, or SDK downloads. Use Consolas numbers.

### Architecture or Method Slide

Use a request-flow diagram: client, gateway, service, database. Label every arrow with protocol or action.

### Comparison Slide

Compare API versions, SDK languages, or deployment options in a precise native table.

### Timeline or Process Slide

Show integration steps or migration phases in a numbered vertical list or horizontal timeline.

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

For developer documentation decks, target Level 4 or above. Code blocks must remain native text.

## Do's and Don'ts

### Do

- Use precise tables for API parameters.
- Use Consolas for code and endpoint names.
- Keep ornamentation minimal.
- Label every box in architecture diagrams.
- Use native text boxes for all generated copy.

### Don't

- Do not use emotional consumer marketing visuals.
- Do not add decorative icons without semantic meaning.
- Do not use low-contrast code text.
- Do not rasterize code blocks unless unavoidable.
- Do not mimic real documentation platform branding.
- Do not create full-slide screenshots as PPT pages by default.
