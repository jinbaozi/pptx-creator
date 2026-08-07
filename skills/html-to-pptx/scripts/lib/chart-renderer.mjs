// Expands the V2 chart vocabulary into editable primitive elements
// (shape/line/text).

export const CHART_KINDS = new Set([
  "stackedBar",
  "groupedBar",
  "horizontalBar",
  "kpiGroup",
  "sparkline",
  "line",
  "area",
  "lineArea"
]);
export const FIDELITY_CHART_KINDS = new Set([
  "stackedBar",
  "groupedBar",
  "horizontalBar",
  "kpiGroup",
  "sparkline"
]);
const STACK_LIKE_KINDS = new Set(["stackedBar", "groupedBar"]);
const NATIVE_CHART_KINDS = new Set([
  "stackedBar",
  "groupedBar",
  "horizontalBar",
  "line",
  "area",
  "lineArea"
]);

function resolveDesignValue(value, tokens) {
  if (typeof value === "string") {
    const match = value.match(/^\{([^}]+)\}$/);
    if (!match) return value;
    let cursor = tokens;
    for (const part of match[1].split(".")) cursor = cursor?.[part];
    return cursor === undefined ? value : cursor;
  }
  if (Array.isArray(value)) return value.map((item) => resolveDesignValue(item, tokens));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveDesignValue(item, tokens)]));
  }
  return value;
}

function normalizeSemanticKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function semanticBase(value, fallback) {
  const candidates = value && typeof value === "object"
    ? [value.id, value.name, value.label]
    : [value];
  for (const candidate of candidates) {
    const normalized = normalizeSemanticKey(candidate);
    if (normalized) return normalized;
  }
  return fallback;
}

function semanticKeys(values, fallbackRole) {
  const occurrences = new Map();
  return values.map((value, index) => {
    const base = semanticBase(value, `${fallbackRole}__position-${index + 1}`);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return occurrence === 1 ? base : `${base}__occurrence-${occurrence}`;
  });
}

function chartChildId(parent, semanticPath) {
  return `${parent.id}__chart__${semanticPath}`;
}

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

function pushText(elements, parent, semanticPath, text, x, y, w, h, style) {
  elements.push({
    type: "text",
    id: chartChildId(parent, semanticPath),
    semanticParentId: parent.id,
    x,
    y,
    w,
    h,
    text,
    style: {
      ...(parent.style?.fontFamily ? { fontFamily: parent.style.fontFamily } : {}),
      ...style
    }
  });
}

function pushShape(elements, parent, semanticPath, shape, x, y, w, h, style) {
  elements.push({
    type: "shape",
    shape,
    id: chartChildId(parent, semanticPath),
    semanticParentId: parent.id,
    x,
    y,
    w,
    h,
    style
  });
}

function pushLine(elements, parent, semanticPath, x, y, w, h, style) {
  elements.push({
    type: "line",
    id: chartChildId(parent, semanticPath),
    semanticParentId: parent.id,
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
  const pointKeys = semanticKeys(data, "point");

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
  const seriesKeys = semanticKeys(seriesNames, "series");

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
      const seriesIndex = seriesNames.indexOf(name);
      pushShape(elements, element, `point-${pointKeys[index]}__series-${seriesKeys[seriesIndex]}__segment`, "rect", x, runningY - segmentHeight, barWidth, segmentHeight, {
        backgroundColor: color,
        borderColor: color
      });
      runningY -= segmentHeight;
    });
    pushText(elements, element, `point-${pointKeys[index]}__label`, String(point.label ?? ""), x, element.y + valueHeight + chartHeight + 0.05, barWidth, labelHeight, {
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
      pushShape(elements, element, `series-${seriesKeys[idx]}__legend-segment`, "rect", cursorX, legendY + 0.04, 0.12, 0.12, {
        backgroundColor: color,
        borderColor: color
      });
      pushText(elements, element, `series-${seriesKeys[idx]}__legend-label`, String(name), cursorX + 0.16, legendY, 0.8, 0.2, {
        align: "left",
        color: style.labelColor
      });
      cursorX += 1.0;
    });
  }

  return elements;
}

function expandGroupedBar(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const palette = resolvePalette(element);
  const showValues = style.showValues !== false;
  const pointKeys = semanticKeys(data, "point");

  const seriesNames = [];
  for (const point of data) {
    for (const name of Object.keys(numericSeries(point.series))) {
      if (!seriesNames.includes(name)) seriesNames.push(name);
    }
  }
  const seriesKeys = semanticKeys(seriesNames, "series");
  const maxValue = Math.max(
    1,
    ...data.flatMap((point) => {
      const series = numericSeries(point.series);
      return seriesNames.map((name) => series[name] || 0);
    })
  );

  const gap = Math.min(0.12, element.w / Math.max(data.length * 4, 1));
  const labelHeight = Math.min(0.32, element.h * 0.18);
  const valueHeight = showValues ? Math.min(0.26, element.h * 0.14) : 0;
  const chartHeight = Math.max(0.2, element.h - labelHeight - valueHeight - 0.1);
  const groupWidth = Math.max(0.08, (element.w - gap * (data.length - 1)) / Math.max(data.length, 1));
  const innerGap = seriesNames.length > 1
    ? Math.min(0.04, element.w / Math.max(data.length * seriesNames.length * 8, 1))
    : 0;
  const barWidth = Math.max(
    0.08,
    (groupWidth - innerGap * Math.max(seriesNames.length - 1, 0)) / Math.max(seriesNames.length, 1)
  );

  data.forEach((point, index) => {
    const series = numericSeries(point.series);
    const groupX = element.x + index * (groupWidth + gap);
    const baselineY = element.y + valueHeight + chartHeight;
    seriesNames.forEach((name, seriesIndex) => {
      const value = series[name] || 0;
      const barHeight = value > 0 ? Math.max(0.02, (value / maxValue) * chartHeight) : 0.02;
      const color = offsetColor(palette[seriesIndex % palette.length], seriesIndex, seriesNames.length);
      pushShape(elements, element, `point-${pointKeys[index]}__series-${seriesKeys[seriesIndex]}__segment`, "rect",
        groupX + seriesIndex * (barWidth + innerGap), baselineY - barHeight, barWidth, barHeight, {
          backgroundColor: color,
          borderColor: color
        });
    });
    pushText(elements, element, `point-${pointKeys[index]}__label`, String(point.label ?? ""), groupX, baselineY + 0.05, groupWidth, labelHeight, {
      align: "center",
      color: style.labelColor
    });
  });

  if (style.showLegend !== false) {
    const legendY = element.y + element.h - Math.min(0.24, labelHeight);
    let cursorX = element.x;
    seriesNames.forEach((name, index) => {
      const color = offsetColor(palette[index % palette.length], index, seriesNames.length);
      pushShape(elements, element, `series-${seriesKeys[index]}__legend-segment`, "rect", cursorX, legendY + 0.04, 0.12, 0.12, {
        backgroundColor: color,
        borderColor: color
      });
      pushText(elements, element, `series-${seriesKeys[index]}__legend-label`, String(name), cursorX + 0.16, legendY, 0.8, 0.2, {
        align: "left",
        color: style.labelColor
      });
      cursorX += 1.0;
    });
  }

  return elements;
}

function expandHorizontalBar(element) {
  const elements = [];
  const data = Array.isArray(element.data) ? element.data : [];
  const style = element.style ?? {};
  const palette = resolvePalette(element);
  const showValues = style.showValues !== false;
  const pointKeys = semanticKeys(data, "point");
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
    pushText(elements, element, `point-${pointKeys[index]}__label`, String(point.label ?? ""), element.x, y, labelWidth - 0.08, rowHeight, {
      align: "right",
      color: style.labelColor
    });
    pushShape(elements, element, `point-${pointKeys[index]}__segment`, "rect", barAreaX, y, barWidth, rowHeight, {
      backgroundColor: color,
      borderColor: color
    });
    if (showValues) {
      pushText(elements, element, `point-${pointKeys[index]}__value`, String(value), barAreaX + barWidth + 0.05, y, 0.6, rowHeight, {
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
  const kpiKeys = semanticKeys(data, "kpi");
  const cardGap = 0.2;
  const cardWidth = Math.max(0.8, (element.w - cardGap * Math.max(data.length - 1, 0)) / Math.max(data.length, 1));

  data.forEach((point, index) => {
    const x = element.x + index * (cardWidth + cardGap);
    const cardColor = offsetColor(palette[index % palette.length], index, palette.length);
    pushShape(elements, element, `kpi-${kpiKeys[index]}__card`, "roundRect", x, element.y, cardWidth, element.h, {
      backgroundColor: style.cardBackgroundColor ?? "#FFFFFF",
      borderColor: cardColor
    });
    pushShape(elements, element, `kpi-${kpiKeys[index]}__accent`, "rect", x, element.y, 0.08, element.h, {
      backgroundColor: cardColor,
      borderColor: cardColor
    });
    pushText(elements, element, `kpi-${kpiKeys[index]}__value`, String(point.value ?? ""), x + 0.2, element.y + 0.1, cardWidth - 0.3, element.h * 0.55, {
      align: "left",
      fontSize: Math.max(14, element.h * 12),
      bold: true,
      color: style.valueColor ?? cardColor
    });
    pushText(elements, element, `kpi-${kpiKeys[index]}__label`, String(point.label ?? ""), x + 0.2, element.y + element.h * 0.6, cardWidth - 0.3, element.h * 0.3, {
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
  const pointKeys = semanticKeys(data, "point");
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
    pushLine(elements, element, `series-main__segment__source-${pointKeys[index]}__target-${pointKeys[index + 1]}`, x1, y1, x2 - x1, y2 - y1, { color, width: style.width ?? 1.5 });
  }
  if (style.endLabel !== false) {
    const lastValue = values[values.length - 1];
    pushText(elements, element, `point-${pointKeys.at(-1)}__value`, String(lastValue), element.x + element.w - 0.6, element.y, 0.6, 0.24, {
      align: "right",
      color
    });
  }
  return elements;
}

export function isNativeChartElement(element) {
  const mode = element?.renderMode ?? element?.style?.renderMode ?? element?.mode;
  return ["native", "semantic", "semantic-first"].includes(String(mode ?? "").trim().toLowerCase());
}

function finiteChartNumber(value, path) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    throw new Error(`${path} must be a finite numeric value`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${path} must be a finite numeric value`);
  return number;
}

function chartPointLabel(point, index) {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    throw new Error(`chart data point ${index + 1} must be an object`);
  }
  if (!Object.prototype.hasOwnProperty.call(point, "label") || point.label === null || point.label === undefined) {
    throw new Error(`chart data point ${index + 1} requires a label`);
  }
  return String(point.label);
}

function strictNativeSeriesData(element) {
  const data = element?.data;
  const id = element?.id ?? "chart";
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`chart ${id} requires a non-empty data array`);
  }
  const labels = data.map((point, index) => chartPointLabel(point, index));
  const valueFlags = data.map((point) => Object.prototype.hasOwnProperty.call(point, "value"));
  const seriesFlags = data.map((point) => point?.series !== undefined);
  const hasValues = valueFlags.some(Boolean);
  const hasSeries = seriesFlags.some(Boolean);
  if (hasValues && hasSeries) {
    throw new Error(`chart ${id} data must use one consistent value or series shape`);
  }
  if (!hasValues && !hasSeries) {
    throw new Error(`chart ${id} data requires numeric value or series fields`);
  }

  if (hasValues) {
    if (!valueFlags.every(Boolean)) throw new Error(`chart ${id} data has inconsistent value fields`);
    const values = data.map((point, index) => finiteChartNumber(point.value, `chart ${id} data[${index}].value`));
    return [{ name: String(element.style?.seriesName ?? "Value"), labels, values }];
  }

  if (!seriesFlags.every(Boolean) || data.some((point) => !point.series || typeof point.series !== "object" || Array.isArray(point.series))) {
    throw new Error(`chart ${id} data series must be consistent objects`);
  }
  const seriesNames = Object.keys(data[0].series);
  if (seriesNames.length === 0) throw new Error(`chart ${id} data series must not be empty`);
  for (const [index, point] of data.entries()) {
    const names = Object.keys(point.series);
    if (names.length !== seriesNames.length || seriesNames.some((name) => !Object.prototype.hasOwnProperty.call(point.series, name))) {
      throw new Error(`chart ${id} data series keys are inconsistent at data[${index}]`);
    }
  }
  return seriesNames.map((name) => ({
    name: String(name),
    labels,
    values: data.map((point, index) => finiteChartNumber(point.series[name], `chart ${id} data[${index}].series.${name}`))
  }));
}

export function validateNativeChartData(element) {
  if (!element || element.type !== "chart") throw new Error("native chart data requires a chart element");
  if (!NATIVE_CHART_KINDS.has(element.kind)) {
    throw new Error(`native chart mode does not support ${String(element.kind ?? "missing")}; use fidelity-first primitives`);
  }
  const series = strictNativeSeriesData(element);
  if (["groupedBar", "stackedBar"].includes(element.kind) && series.length === 1 && element.data.some((point) => Object.prototype.hasOwnProperty.call(point, "value"))) {
    throw new Error(`chart ${element.id ?? "chart"} ${element.kind} requires series data`);
  }
  if (element.kind === "horizontalBar" && series.length !== 1) {
    throw new Error(`chart ${element.id ?? "chart"} horizontalBar requires a single value series`);
  }
  if (element.kind === "lineArea" && series.length !== 1) {
    throw new Error(`chart ${element.id ?? "chart"} lineArea currently requires a single series`);
  }
  return series;
}

export function nativeChartSpec(element, designTokens = {}) {
  if (!element || element.type !== "chart" || !isNativeChartElement(element)) return null;
  const style = resolveDesignValue(element.style ?? {}, designTokens);
  const resolvedElement = { ...element, style };
  const seriesData = validateNativeChartData(resolvedElement);
  const palette = resolvePalette(resolvedElement).map((color) => String(color).replace(/^#/, ""));
  const baseOptions = {
    x: element.x,
    y: element.y,
    w: element.w,
    h: element.h,
    ...(element.id ? { objectName: element.id } : {}),
    ...(palette.length > 0 ? { chartColors: palette } : {}),
    showLegend: style.showLegend !== false,
    showValue: style.showValues !== false,
    ...(style.showTitle ? { showTitle: true, title: String(style.title ?? element.title ?? "") } : {}),
    ...(style.fontFamily ? {
      catAxisLabelFontFace: String(style.fontFamily),
      valAxisLabelFontFace: String(style.fontFamily),
      legendFontFace: String(style.fontFamily),
      titleFontFace: String(style.fontFamily)
    } : {}),
    ...(style.catAxisLabelFontSize ? { catAxisLabelFontSize: Number(style.catAxisLabelFontSize) } : {}),
    ...(style.valAxisLabelFontSize ? { valAxisLabelFontSize: Number(style.valAxisLabelFontSize) } : {})
  };
  if (["groupedBar", "stackedBar", "horizontalBar"].includes(element.kind)) {
    return {
      type: "bar",
      data: seriesData,
      options: {
        ...baseOptions,
        barDir: element.kind === "horizontalBar" ? "bar" : "col",
        barGrouping: element.kind === "stackedBar" ? "stacked" : "clustered"
      }
    };
  }
  if (element.kind === "lineArea") {
    return {
      type: [
        { type: "area", data: seriesData, options: { ...baseOptions, objectName: `${element.id ?? "chart"}__area` } },
        { type: "line", data: seriesData, options: { ...baseOptions, objectName: `${element.id ?? "chart"}__line` } }
      ],
      data: undefined,
      options: baseOptions
    };
  }
  return {
    type: element.kind,
    data: seriesData,
    options: baseOptions
  };
}

export function expandChartElement(element) {
  if (!element || element.type !== "chart") return [element];
  if (isNativeChartElement(element)) return [element];
  const kind = element.kind;
  if (!CHART_KINDS.has(kind)) {
    throw new Error(`unsupported chart kind ${String(kind ?? "missing")}; expected ${[...CHART_KINDS].join(",")}`);
  }
  if (STACK_LIKE_KINDS.has(kind)) {
    if (kind === "groupedBar") return expandGroupedBar(element);
    return expandStackedBar(element);
  }
  if (kind === "horizontalBar") return expandHorizontalBar(element);
  if (kind === "kpiGroup") return expandKpiGroup(element);
  if (["line", "area", "lineArea"].includes(kind)) {
    throw new Error(`chart ${element.id ?? "unknown"} kind ${kind} requires native or semantic renderMode`);
  }
  return expandSparkline(element);
}
