export function expandDiagramElement(element) {
  if (element.kind === "layeredArchitecture" || element.kind === "capabilityStack" || element.kind === "compilerPipeline") {
    return expandLayered(element);
  }
  if (element.kind === "swimlane") {
    return expandSwimlane(element);
  }
  if (element.kind === "matrixMap") {
    return expandMatrixMap(element);
  }
  throw new Error(`unsupported diagram kind: ${element.kind}`);
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

function diagramChildId(parent, semanticPath) {
  return `${parent.id}__diagram__${semanticPath}`;
}

function expandLayered(element) {
  const layers = element.layers ?? [];
  const gap = 0.16;
  const layerHeight = (element.h - gap * Math.max(0, layers.length - 1)) / Math.max(1, layers.length);
  const output = [];
  const layerKeys = semanticKeys(layers, "layer");

  layers.forEach((layer, layerIndex) => {
    const layerPath = `layer-${layerKeys[layerIndex]}`;
    const y = element.y + layerIndex * (layerHeight + gap);
    output.push(shape(element, `${layerPath}__shape`, element.x, y, element.w, layerHeight, {
      backgroundColor: "#F3F7FF",
      borderColor: "#8FB3FF"
    }));
    output.push(text(element, `${layerPath}__label`, layer.label, element.x + 0.2, y + 0.1, 2.0, 0.32, {
      bold: true,
      color: "#172033"
    }));

    const nodes = layer.nodes ?? [];
    const nodeKeys = semanticKeys(nodes, "node");
    const nodeGap = 0.12;
    const nodeW = (element.w - 2.6 - nodeGap * Math.max(0, nodes.length - 1)) / Math.max(1, nodes.length);
    nodes.forEach((node, nodeIndex) => {
      const nodePath = `${layerPath}__node-${nodeKeys[nodeIndex]}`;
      const x = element.x + 2.3 + nodeIndex * (nodeW + nodeGap);
      output.push(shape(element, `${nodePath}__shape`, x, y + 0.18, nodeW, layerHeight - 0.36, {
        backgroundColor: "#FFFFFF",
        borderColor: "#A8B7D3"
      }));
      output.push(text(element, `${nodePath}__label`, node, x + 0.08, y + 0.28, nodeW - 0.16, layerHeight - 0.56, {
        color: "#172033",
        fontSize: 10,
        align: "center",
        valign: "mid"
      }));
    });

    if (layerIndex < layers.length - 1) {
      const sourcePath = `layer-${layerKeys[layerIndex]}`;
      const targetPath = `layer-${layerKeys[layerIndex + 1]}`;
      output.push(line(element, `connector__source-${layerKeys[layerIndex]}__target-${layerKeys[layerIndex + 1]}`, element.x + element.w / 2, y + layerHeight, 0, gap, {
        color: "#667085",
        width: 1,
        endArrowType: "triangle",
        sourceId: diagramChildId(element, `${sourcePath}__shape`),
        targetId: diagramChildId(element, `${targetPath}__shape`)
      }));
    }
  });

  return output;
}

function expandSwimlane(element) {
  const lanes = element.lanes ?? element.layers ?? [];
  return expandLayered({ ...element, layers: lanes });
}

function expandMatrixMap(element) {
  const rows = element.rows ?? [];
  const cols = element.columns ?? [];
  const output = [];
  const labelW = Math.min(1.5, element.w * 0.22);
  const headerH = Math.min(0.45, element.h * 0.16);
  const cellW = (element.w - labelW) / Math.max(1, cols.length);
  const cellH = (element.h - headerH) / Math.max(1, rows.length);
  const rowKeys = semanticKeys(rows, "row");
  const columnKeys = semanticKeys(cols, "column");

  cols.forEach((col, colIndex) => {
    output.push(text(element, `column-${columnKeys[colIndex]}__label`, col, element.x + labelW + colIndex * cellW, element.y, cellW, headerH, {
      bold: true,
      align: "center"
    }));
  });
  rows.forEach((row, rowIndex) => {
    const y = element.y + headerH + rowIndex * cellH;
    output.push(text(element, `row-${rowKeys[rowIndex]}__label`, row, element.x, y, labelW, cellH, { bold: true }));
    cols.forEach((_, colIndex) => {
      output.push(shape(element, `row-${rowKeys[rowIndex]}__column-${columnKeys[colIndex]}__cell`, element.x + labelW + colIndex * cellW, y, cellW, cellH, {
        backgroundColor: "#FFFFFF",
        borderColor: "#D0D7E2"
      }));
    });
  });
  return output;
}

function shape(parent, suffix, x, y, w, h, style) {
  return { type: "shape", id: diagramChildId(parent, suffix), semanticParentId: parent.id, shape: "roundRect", x, y, w, h, style };
}

function text(parent, suffix, value, x, y, w, h, style = {}) {
  return { type: "text", id: diagramChildId(parent, suffix), semanticParentId: parent.id, text: String(value ?? ""), x, y, w, h, style };
}

function line(parent, suffix, x, y, w, h, style) {
  return { type: "line", id: diagramChildId(parent, suffix), semanticParentId: parent.id, x, y, w, h, style };
}
