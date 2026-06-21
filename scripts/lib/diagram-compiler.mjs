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

function expandLayered(element) {
  const layers = element.layers ?? [];
  const gap = 0.16;
  const layerHeight = (element.h - gap * Math.max(0, layers.length - 1)) / Math.max(1, layers.length);
  const output = [];

  layers.forEach((layer, layerIndex) => {
    const y = element.y + layerIndex * (layerHeight + gap);
    output.push(shape(element, `layer-${layerIndex}`, element.x, y, element.w, layerHeight, {
      backgroundColor: "#F3F7FF",
      borderColor: "#8FB3FF"
    }));
    output.push(text(element, `layer-label-${layerIndex}`, layer.label, element.x + 0.2, y + 0.1, 2.0, 0.32, {
      bold: true,
      color: "#172033"
    }));

    const nodes = layer.nodes ?? [];
    const nodeGap = 0.12;
    const nodeW = (element.w - 2.6 - nodeGap * Math.max(0, nodes.length - 1)) / Math.max(1, nodes.length);
    nodes.forEach((node, nodeIndex) => {
      const x = element.x + 2.3 + nodeIndex * (nodeW + nodeGap);
      output.push(shape(element, `node-${layerIndex}-${nodeIndex}`, x, y + 0.18, nodeW, layerHeight - 0.36, {
        backgroundColor: "#FFFFFF",
        borderColor: "#A8B7D3"
      }));
      output.push(text(element, `node-label-${layerIndex}-${nodeIndex}`, node, x + 0.08, y + 0.28, nodeW - 0.16, layerHeight - 0.56, {
        color: "#172033",
        fontSize: 10,
        align: "center",
        valign: "mid"
      }));
    });

    if (layerIndex < layers.length - 1) {
      output.push(line(element, `connector-${layerIndex}`, element.x + element.w / 2, y + layerHeight, 0, gap, {
        color: "#667085",
        width: 1,
        endArrowType: "triangle",
        sourceId: `${element.id}__layer-${layerIndex}`,
        targetId: `${element.id}__layer-${layerIndex + 1}`
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

  cols.forEach((col, colIndex) => {
    output.push(text(element, `col-${colIndex}`, col, element.x + labelW + colIndex * cellW, element.y, cellW, headerH, {
      bold: true,
      align: "center"
    }));
  });
  rows.forEach((row, rowIndex) => {
    const y = element.y + headerH + rowIndex * cellH;
    output.push(text(element, `row-${rowIndex}`, row, element.x, y, labelW, cellH, { bold: true }));
    cols.forEach((_, colIndex) => {
      output.push(shape(element, `cell-${rowIndex}-${colIndex}`, element.x + labelW + colIndex * cellW, y, cellW, cellH, {
        backgroundColor: "#FFFFFF",
        borderColor: "#D0D7E2"
      }));
    });
  });
  return output;
}

function shape(parent, suffix, x, y, w, h, style) {
  return { type: "shape", id: `${parent.id}__${suffix}`, shape: "roundRect", x, y, w, h, style };
}

function text(parent, suffix, value, x, y, w, h, style = {}) {
  return { type: "text", id: `${parent.id}__${suffix}`, text: String(value ?? ""), x, y, w, h, style };
}

function line(parent, suffix, x, y, w, h, style) {
  return { type: "line", id: `${parent.id}__${suffix}`, x, y, w, h, style };
}
