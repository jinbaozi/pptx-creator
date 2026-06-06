---
version: alpha
name: Dashboard Data
description: A data operations design system for analytics, observability, and monitoring presentation decks.
colors:
  primary: "#14B8A6"
  secondary: "#9CA3AF"
  accent: "#FACC15"
  background: "#0B1120"
  surface: "#111827"
  surfaceAlt: "#1F2937"
  text: "#E5E7EB"
  textMuted: "#9CA3AF"
  border: "#374151"
  success: "#22C55E"
  warning: "#EAB308"
  danger: "#EF4444"
typography:
  title:
    fontFamily: "Segoe UI"
    fontSize: 28
    fontWeight: 700
    lineHeight: 1.2
  subtitle:
    fontFamily: "Segoe UI"
    fontSize: 16
    fontWeight: 500
    lineHeight: 1.35
  heading:
    fontFamily: "Segoe UI"
    fontSize: 18
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "Segoe UI"
    fontSize: 13
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "Segoe UI"
    fontSize: 10
    fontWeight: 400
    lineHeight: 1.35
  metric:
    fontFamily: "Consolas"
    fontSize: 44
    fontWeight: 700
    lineHeight: 1.0
spacing:
  xs: 3
  sm: 6
  md: 12
  lg: 18
  xl: 28
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
    padding: 14
  content-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
    padding: 12
  table-header:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.primary}"
    typography: "{typography.body}"
  badge:
    backgroundColor: "{colors.surfaceAlt}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: 5
---

# Dashboard Data

## Overview

Dashboard Data is a dense operations design system for analytics, observability, monitoring, and operations review decks. It uses dark data panels, teal primary accents, yellow highlight metrics, and clear label hierarchy.

## Colors

Use near-black backgrounds and charcoal surfaces. Teal primary for healthy metrics and active panels. Yellow accent for alerts, thresholds, and attention items. Status colors: green success, yellow warning, red danger.

## Typography

Use Segoe UI for labels and Consolas for metric values. Smaller body text (13pt) is acceptable for data-dense slides. Metric numbers should be large and monospace.

## Layout

Favor dashboard grids with multiple metric cards per slide. Use consistent card sizing. Pack information efficiently but maintain readable gutters.

## Elevation & Depth

Flat dark panels with thin borders. No shadows. Data density is the priority.

## Shapes

Use compact rectangles for metric tiles, thin sparkline placeholders as lines, and small badges for status. Minimal rounding.

## Components

Use hero cards for dashboard overview, content cards for metric groups, yellow badges for alerts, and native tables for incident logs.

## Presentation Patterns

### Cover Slide

Use a teal title, dashboard subtitle, and one hero card with the monitoring scope (e.g., "Q4 Operations Review").

### Four-card Overview

Arrange four metric tiles in a 2x2 grid: availability, latency, error rate, and throughput.

### Metrics Slide

Display 4-6 KPIs with large Consolas numbers. Each tile includes metric name, value, delta, and threshold badge.

### Architecture or Method Slide

Show observability stack: agents, collectors, storage, dashboards. Label data flow paths.

### Comparison Slide

Compare periods, regions, or services in a dense native table with teal headers and yellow delta highlights.

### Timeline or Process Slide

Show incident timeline or deployment windows on a horizontal axis with status-colored markers.

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

For dashboard decks, target Level 4 or above. Chart screenshots may be rasterized if native chart data is unavailable.

## Do's and Don'ts

### Do

- Use dense metric grids with clear labels.
- Use teal for healthy metrics and yellow for alerts.
- Keep tables precise with sortable-looking headers.
- Use Consolas for all numeric values.
- Use native text boxes for all generated copy.

### Don't

- Do not use sparse layouts meant for premium covers.
- Do not use light backgrounds that reduce data contrast.
- Do not hide labels behind decorative graphics.
- Do not rasterize metric text unless unavoidable.
- Do not mimic real observability vendor branding.
- Do not create full-slide screenshots as PPT pages by default.
