// Expands chart elements into editable primitive elements (shape/line/text).
// Existing kinds (bar, line, pie) pass through unchanged so the legacy
// rendering path in scripts/render-pptx.mjs keeps working.

const LEGACY_KINDS = new Set(["bar", "line", "pie"]);
const STACK_LIKE_KINDS = new Set(["stackedBar", "groupedBar"]);
const HORIZONTAL_KINDS = new Set(["horizontalBar"]);

function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function numericSeries(series) {
  if (!series || typeof series !== "object") return {};
  return Object.fromEntries(
    Object.entries(series).map(([key, value]) => [key, Number(value) || 0])
  );
}

function resolvePalette(element) {
  const style = element.style ?? {};
  if (Array.isArray(style.palette) && style.palette.length > 0) {
    return style.palette.map((color) => String(color));
  }
  if (style.color) return [String(style.color)];
  return ["#36C5F0", "#7CFFB2", "#FFB86C", "#FF6B9A"];
}

function offsetColor(value, index, total) {
  if (typeof value !== "string") return "#36C5F0";
  if (value.startsWith("{") && value.endsWith("}")) return value;
  return value;
}

function pushText(elements, parentId, text, x, y, w, h, style) {
  elements.push({
    type: "text",
    id: `${parentId}__text-${elements.length}`,
    x,
    y,
    w,
    h,
    text,
    style
  });
}

function pushShape(elements, parentId, shape, x, y, w, h, style) {
  elements.push({
    type: "shape",
    shape,
    id: `${parentId}__shape-${elements.length}`,
    x,
    y,
    w,
    h,
    style
  });
}

function pushLine(elements, parentId, x, y, w, h, style) {
  elements.push({
    type: "line",
    id: `${parentId}__line-${elements.length}`,
    x,
    y,
    w,
    h,
    style
  });
}

function expandStackedBar(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const palette = resolvePalette(element);
  const showValues = style.showValues !== false;

  const seriesNames = [];
  for (const point of data) {
    for (const name of Object.keys(numericSeries(point.series))) {
      if (!seriesNames.includes(name)) seriesNames.push(name);
    }
  }
  const totals = data.map((point) => {
    const series = numericSeries(point.series);
    return seriesNames.reduce((sum, name) => sum + (series[name] || 0), 0);
  });
  const maxTotal = Math.max(1, ...totals);

  const gap = Math.min(0.12, element.w / Math.max(data.length * 4, 1));
  const labelHeight = Math.min(0.32, element.h * 0.18);
  const valueHeight = showValues ? Math.min(0.26, element.h * 0.14) : 0;
  const chartHeight = Math.max(0.2, element.h - labelHeight - valueHeight - 0.1);
  const barWidth = Math.max(0.08, (element.w - gap * (data.length - 1)) / data.length);

  data.forEach((point, index) => {
    const series = numericSeries(point.series);
    const x = element.x + index * (barWidth + gap);
    let runningY = element.y + valueHeight + chartHeight;
    seriesNames.forEach((name) => {
      const value = series[name] || 0;
      const total = totals[index] || 1;
      const segmentHeight = total > 0 ? Math.max(0.02, (value / maxTotal) * chartHeight) : 0.02;
      const color = offsetColor(palette[seriesNames.indexOf(name) % palette.length], seriesNames.indexOf(name), seriesNames.length);
      pushShape(elements, element.id, "rect", x, runningY - segmentHeight, barWidth, segmentHeight, {
        backgroundColor: color,
        borderColor: color
      });
      runningY -= segmentHeight;
    });
    pushText(elements, element.id, String(point.label ?? ""), x, element.y + valueHeight + chartHeight + 0.05, barWidth, labelHeight, {
      align: "center",
      color: style.labelColor
    });
  });

  if (style.showLegend !== false) {
    const legendY = element.y + element.h - Math.min(0.24, labelHeight);
    const legendStartX = element.x;
    let cursorX = legendStartX;
    seriesNames.forEach((name, idx) => {
      const color = offsetColor(palette[idx % palette.length], idx, seriesNames.length);
      pushShape(elements, element.id, "rect", cursorX, legendY + 0.04, 0.12, 0.12, {
        backgroundColor: color,
        borderColor: color
      });
      pushText(elements, element.id, String(name), cursorX + 0.16, legendY, 0.8, 0.2, {
        align: "left",
        color: style.labelColor
      });
      cursorX += 1.0;
    });
  }

  return elements;
}

function expandGroupedBar(element) {
  // Grouped bars are visually the same primitive shape stack as stackedBar
  // when expanded to shape/text, so reuse the implementation.
  return expandStackedBar(element);
}

function expandHorizontalBar(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const palette = resolvePalette(element);
  const showValues = style.showValues !== false;
  const maxValue = Math.max(1, ...data.map((point) => Number(point.value) || 0));
  const rowHeight = Math.max(0.18, Math.min(0.4, element.h / Math.max(data.length, 1)));
  const labelWidth = Math.min(1.2, element.w * 0.22);
  const barAreaX = element.x + labelWidth;
  const barAreaW = Math.max(0.4, element.w - labelWidth);

  data.forEach((point, index) => {
    const value = Number(point.value) || 0;
    const barWidth = Math.max(0.05, (value / maxValue) * barAreaW);
    const y = element.y + index * (rowHeight + 0.08);
    const color = offsetColor(palette[index % palette.length], index, palette.length);
    pushText(elements, element.id, String(point.label ?? ""), element.x, y, labelWidth - 0.08, rowHeight, {
      align: "right",
      color: style.labelColor
    });
    pushShape(elements, element.id, "rect", barAreaX, y, barWidth, rowHeight, {
      backgroundColor: color,
      borderColor: color
    });
    if (showValues) {
      pushText(elements, element.id, String(value), barAreaX + barWidth + 0.05, y, 0.6, rowHeight, {
        align: "left",
        color: style.labelColor
      });
    }
  });
  return elements;
}

function expandKpiGroup(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const palette = resolvePalette(element);
  const cardGap = 0.2;
  const cardWidth = Math.max(0.8, (element.w - cardGap * Math.max(data.length - 1, 0)) / Math.max(data.length, 1));

  data.forEach((point, index) => {
    const x = element.x + index * (cardWidth + cardGap);
    const cardColor = offsetColor(palette[index % palette.length], index, palette.length);
    pushShape(elements, element.id, "roundRect", x, element.y, cardWidth, element.h, {
      backgroundColor: style.cardBackgroundColor ?? "#FFFFFF",
      borderColor: cardColor
    });
    pushShape(elements, element.id, "rect", x, element.y, 0.08, element.h, {
      backgroundColor: cardColor,
      borderColor: cardColor
    });
    pushText(elements, element.id, String(point.value ?? ""), x + 0.2, element.y + 0.1, cardWidth - 0.3, element.h * 0.55, {
      align: "left",
      fontSize: Math.max(14, element.h * 12),
      bold: true,
      color: style.valueColor ?? cardColor
    });
    pushText(elements, element.id, String(point.label ?? ""), x + 0.2, element.y + element.h * 0.6, cardWidth - 0.3, element.h * 0.3, {
      align: "left",
      color: style.labelColor
    });
  });
  return elements;
}

function expandSparkline(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const color = (palette => palette[0])(resolvePalette(element));
  if (data.length < 2) return elements;
  const values = data.map((point) => Number(point.value) || 0);
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 1);
  const range = Math.max(1, maxValue - minValue);
  const stepX = data.length === 1 ? element.w : element.w / (data.length - 1);

  for (let index = 0; index < data.length - 1; index += 1) {
    const currentValue = values[index];
    const nextValue = values[index + 1];
    const x1 = element.x + index * stepX;
    const y1 = element.y + element.h - ((currentValue - minValue) / range) * element.h;
    const x2 = element.x + (index + 1) * stepX;
    const y2 = element.y + element.h - ((nextValue - minValue) / range) * element.h;
    pushLine(elements, element.id, x1, y1, x2 - x1, y2 - y1, { color, width: style.width ?? 1.5 });
  }
  if (style.endLabel !== false) {
    const lastValue = values[values.length - 1];
    pushText(elements, element.id, String(lastValue), element.x + element.w - 0.6, element.y, 0.6, 0.24, {
      align: "right",
      color
    });
  }
  return elements;
}

export function expandChartElement(element) {
  if (!element || element.type !== "chart") return [element];
  const kind = element.kind;
  if (LEGACY_KINDS.has(kind)) return [element];
  if (STACK_LIKE_KINDS.has(kind)) {
    if (kind === "groupedBar") return expandGroupedBar(element);
    return expandStackedBar(element);
  }
  if (HORIZONTAL_KINDS.has(kind)) return expandHorizontalBar(element);
  if (kind === "kpiGroup") return expandKpiGroup(element);
  if (kind === "sparkline") return expandSparkline(element);
  return [element];
}
