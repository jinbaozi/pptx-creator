---
version: alpha
name: AI Infra
description: A blueprint-style design system for AI infrastructure and toolchain roadshow decks.
colors:
  primary: "#4F46E5"
  secondary: "#64748B"
  accent: "#06B6D4"
  background: "#F8FAFC"
  surface: "#EEF2FF"
  surfaceAlt: "#E0E7FF"
  text: "#0F172A"
  textMuted: "#64748B"
  border: "#CBD5E1"
  success: "#059669"
  warning: "#D97706"
  danger: "#DC2626"
typography:
  title:
    fontFamily: "Segoe UI"
    fontSize: 32
    fontWeight: 700
    lineHeight: 1.18
  subtitle:
    fontFamily: "Segoe UI"
    fontSize: 19
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "Segoe UI"
    fontSize: 21
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Microsoft YaHei"
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
  sm: 4
  md: 8
  lg: 12
  xl: 16
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

# AI Infra

## Overview

AI Infra is a blueprint-inspired design system for model platforms, inference systems, AI infrastructure, and toolchain roadshows. It uses restrained violet and cyan accents on light indigo surfaces with diagram-friendly layouts.

## Colors

Use light slate backgrounds and indigo-tinted surfaces. Violet primary anchors headings and pipeline labels. Cyan accent marks data flow and active components. Keep the palette technical, not consumer-playful.

## Typography

Use Segoe UI for headings and Microsoft YaHei for bilingual body copy. Consolas for throughput metrics and latency numbers. Maintain crisp hierarchy for architecture slides.

## Layout

Favor blueprint grid alignment. Group model-flow components into labeled panels. Use consistent spacing for pipeline diagrams.

## Elevation & Depth

Use light borders and flat indigo fills. Subtle grid-line dividers suggest blueprint paper. No heavy shadows.

## Shapes

Use rounded rectangles for services, arrows for data flow, and circles for model nodes. Keep connectors simple and meaningful.

## Components

Use hero cards for platform overview, content cards for subsystem details, badges for version labels, and native tables for benchmark comparisons.

## Presentation Patterns

### Cover Slide

Use a violet title, cyan subtitle accent, and one hero card describing the platform scope. Optional thin grid-line divider.

### Four-card Overview

Place four indigo-surface cards in a 2x2 grid. Each card covers one subsystem: training, inference, orchestration, or observability.

### Metrics Slide

Show 3-5 infrastructure metrics with Consolas numbers. Include latency, throughput, GPU utilization, or cost per token as appropriate.

### Architecture or Method Slide

Use model-flow diagrams with left-to-right pipelines. Label each stage: ingest, preprocess, infer, postprocess, serve.

### Comparison Slide

Compare frameworks, hardware, or deployment modes in a native table with violet headers.

### Timeline or Process Slide

Use a horizontal roadmap for platform milestones. Vertical stacks for rollout phases.

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

For AI infrastructure roadshows, target Level 4 or above. Complex model diagrams may use Level 3 if decorative glow is rasterized.

## Do's and Don'ts

### Do

- Use blueprint-style grids and pipeline layouts.
- Label every box in architecture diagrams.
- Use violet for structure and cyan for active flow.
- Keep metrics technical and verifiable.
- Use native text boxes for all generated copy.

### Don't

- Do not use lifestyle or consumer marketing visuals.
- Do not add unlabeled decorative nodes.
- Do not use dark backgrounds that hide grid structure.
- Do not rasterize text unless unavoidable.
- Do not mimic real AI vendor branding.
- Do not create full-slide screenshots as PPT pages by default.
