const input = document.querySelector("#run-file");
const summary = document.querySelector("#run-summary");
const panels = {
  directions: document.querySelector("#directions"),
  previews: document.querySelector("#previews"),
  reviews: document.querySelector("#reviews"),
  requirements: document.querySelector("#requirements"),
  "ui-spec": document.querySelector("#ui-spec"),
  "component-specs": document.querySelector("#component-specs"),
  "preview-artifacts": document.querySelector("#preview-artifacts"),
  "vision-review": document.querySelector("#vision-review"),
  "repair-patch": document.querySelector("#repair-patch"),
  "consistency-report": document.querySelector("#consistency-report-panel")
};

const renderers = {
  requirements: renderRequirements,
  "ui-spec": renderUiSpec,
  "component-specs": renderComponentSpecs,
  "preview-artifacts": renderPreviewArtifacts,
  "vision-review": renderVisionReview,
  "repair-patch": renderRepairPatch,
  directions: renderDirections,
  slides: renderSlidePreviews,
  reviews: renderReviews,
  "consistency-report": renderConsistencyReportHtml
};

input?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const run = JSON.parse(await file.text());
  renderRun(run);
});

// Auto-load consistency-report.json on page load (workbench is served alongside
// /output/). When the file is missing, the panel shows a guidance message.
document.addEventListener("DOMContentLoaded", () => {
  loadConsistencyReportFromFetch();
});

if (typeof window !== "undefined" && document.readyState !== "loading") {
  loadConsistencyReportFromFetch();
}

async function loadConsistencyReportFromFetch() {
  const panel = panels["consistency-report"];
  if (!panel || !window.fetch) return;
  // If a test or caller has already populated the panel (manual override),
  // skip the auto-fetch — manual wins.
  if (panel.dataset.manualOverride === "true") return;
  try {
    const response = await fetch("./output/consistency-report.json", { cache: "no-store" });
    if (panel.dataset.manualOverride === "true") return;
    if (response.status === 404) {
      panel.innerHTML = renderConsistencyEmpty();
      return;
    }
    if (!response.ok) {
      panel.innerHTML = renderConsistencyEmpty(`HTTP ${response.status}`);
      return;
    }
    const report = await response.json();
    panel.innerHTML = renderConsistencyReportHtml(report);
  } catch (error) {
    if (panel.dataset.manualOverride === "true") return;
    panel.innerHTML = renderConsistencyEmpty(error?.message ?? "fetch failed");
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const isActive = tab.dataset.tab === name;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  const target = document.querySelector(`[data-panel='${name}']`);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderRun(run) {
  summary.textContent = JSON.stringify({
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    input: run.input
  }, null, 2);

  for (const [key, renderer] of Object.entries(renderers)) {
    const node = panels[key];
    if (!node) continue;
    node.innerHTML = renderer(run);
  }
}

function renderDirections(run) {
  return renderList(run.directions ?? [], (direction) => `${direction.id}: ${direction.label} (${direction.status}, score ${direction.score ?? "n/a"})`);
}

function renderSlidePreviews(run) {
  return renderList(run.artifacts?.previews ?? [], (preview) => preview);
}

function renderReviews(run) {
  return renderList(run.artifacts?.reviews ?? [], (review) => review);
}

function renderRequirements(run) {
  const req = run.artifacts?.requirements;
  if (!req) return emptyState("No requirements artifact loaded.");
  return `
    <dl class="kv">
      ${kvRow("Audience", req.audience)}
      ${kvRow("Objective", req.objective)}
      ${kvRow("Tone", req.tone)}
      ${kvRow("Version", req.version)}
    </dl>
    ${collapsible("Must include", renderList(req.mustInclude ?? [], (item) => item))}
    ${collapsible("Must avoid", renderList(req.mustAvoid ?? [], (item) => item))}
    ${collapsible("Confidence notes", renderList(req.confidenceNotes ?? [], (item) => item))}
  `;
}

function renderUiSpec(run) {
  const spec = run.artifacts?.uiSpec;
  if (!spec) return emptyState("No UI spec artifact loaded.");
  const slides = spec.slides ?? [];
  return `
    <p class="meta">${escapeHtml(spec.version ?? "?")} · ${slides.length} slides</p>
    <table class="data-table">
      <thead><tr><th>Slide</th><th>Layout</th><th>Regions</th></tr></thead>
      <tbody>${slides.map((slide) => `
        <tr>
          <td>${escapeHtml(slide.id)}</td>
          <td>${escapeHtml(slide.layoutPattern)}</td>
          <td>${(slide.regions ?? []).map((region) => `${escapeHtml(region.id)}/${escapeHtml(region.role)}`).join(", ")}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderComponentSpecs(run) {
  const spec = run.artifacts?.componentSpecs;
  if (!spec) return emptyState("No component spec artifact loaded.");
  const slides = spec.slides ?? [];
  const componentCount = slides.reduce((total, slide) => total + (slide.components?.length ?? 0), 0);
  return `
    <p class="meta">${escapeHtml(spec.version ?? "?")} · ${componentCount} components across ${slides.length} slides</p>
    <table class="data-table">
      <thead><tr><th>Slide</th><th>Component</th><th>Type</th><th>Editability</th><th>Region</th></tr></thead>
      <tbody>${slides.map((slide) => {
        const components = slide.components ?? [];
        if (!components.length) {
          return `<tr><td>${escapeHtml(slide.id)}</td><td colspan="4" class="empty">No components defined.</td></tr>`;
        }
        return components.map((component) => `
          <tr>
            <td>${escapeHtml(slide.id)}</td>
            <td>${escapeHtml(component.id)}</td>
            <td>${escapeHtml(component.type)}</td>
            <td>${escapeHtml(component.editability)}</td>
            <td>${escapeHtml(component.region)}</td>
          </tr>`).join("");
      }).join("")}
      </tbody>
    </table>
  `;
}

function renderPreviewArtifacts(run) {
  const previews = run.artifacts?.previews ?? [];
  if (!previews.length) return emptyState("No preview artifacts available.");
  return `<ul class="file-list">${previews.map((entry) => previewLink(entry)).join("")}</ul>`;
}

function renderVisionReview(run) {
  const review = run.artifacts?.visionReview;
  if (!review) return emptyState("No vision review artifact loaded.");
  const findings = (review.slides ?? []).flatMap((slide) => (slide.findings ?? []).map((finding) => ({ ...finding, slideId: slide.slideId })));
  return `
    <p class="meta">${escapeHtml(review.reviewer?.model ?? "model")} · deck score ${escapeHtml(String(review.deckScore ?? "n/a"))}</p>
    ${collapsible("Slide scores", `<ul>${(review.slides ?? []).map((slide) => `<li>${escapeHtml(slide.slideId)}: ${escapeHtml(String(slide.score))}</li>`).join("")}</ul>`)}
    ${collapsible("Findings", renderList(findings, (finding) => `${finding.severity} ${finding.category}: ${finding.message}`))}
  `;
}

function renderRepairPatch(run) {
  const patch = run.artifacts?.repairPatch;
  if (!patch) return emptyState("No repair patch artifact loaded.");
  return `
    <p class="meta">attempt ${escapeHtml(String(patch.attempt ?? "?"))} · ${(patch.patches ?? []).length} patches</p>
    <table class="data-table">
      <thead><tr><th>Slide</th><th>Operation</th><th>Target</th><th>Changes</th></tr></thead>
      <tbody>${(patch.patches ?? []).map((entry) => `
        <tr>
          <td>${escapeHtml(entry.slideId ?? "")}</td>
          <td>${escapeHtml(entry.operation)}</td>
          <td>${escapeHtml(entry.targetElementId ?? "")}</td>
          <td><code>${escapeHtml(JSON.stringify(entry.changes ?? {}))}</code></td>
        </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function renderList(items, label) {
  if (!items.length) return "<p class=\"empty\">No artifacts found.</p>";
  return `<ul>${items.map((item) => `<li>${escapeHtml(label(item))}</li>`).join("")}</ul>`;
}

function previewLink(entry) {
  const value = typeof entry === "string" ? entry : entry.file ?? entry.path ?? JSON.stringify(entry);
  return `<li><a href="${escapeHtml(value)}" target="_blank" rel="noopener">${escapeHtml(value)}</a></li>`;
}

function collapsible(title, content) {
  return `
    <details class="collapse">
      <summary>${escapeHtml(title)}</summary>
      <div class="collapse-body">${content}</div>
    </details>
  `;
}

function kvRow(label, value) {
  return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value ?? "n/a")}</dd>`;
}

function emptyState(message) {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

// Expose for tests and ad-hoc inspection.
if (typeof window !== "undefined") {
  window.renderRun = renderRun;
  // renderConsistencyReport mutates the panel directly (sets innerHTML and
  // marks manualOverride so the auto-fetch on DOMContentLoaded cannot clobber
  // a manual render).
  window.renderConsistencyReport = function (report) {
    const panel = panels["consistency-report"];
    if (!panel) return null;
    panel.dataset.manualOverride = "true";
    const html = renderConsistencyReportHtml(report);
    panel.innerHTML = html;
    return html;
  };
  window.evaluateConsistencyCells = evaluateConsistencyCells;
}

function renderConsistencyReportHtml(report) {
  if (!report || typeof report !== "object") {
    return renderConsistencyEmpty();
  }
  const cells = evaluateConsistencyCells(report);
  const meta = `
    <p class="meta">input ${escapeHtml(report.inputType ?? "unknown")} · source ${escapeHtml(String(report.inputSource ?? "n/a"))}</p>
  `;
  const grid = `
    <div class="consistency-grid">
      ${cells.map((cell) => `
        <div class="cell ${cell.tone}" role="button" tabindex="0" data-cell="${escapeHtml(cell.key)}" aria-expanded="false">
          <span class="cell-label">${escapeHtml(cell.label)}</span>
          <span class="cell-value">${escapeHtml(cell.display)}</span>
        </div>
      `).join("")}
    </div>
    <div id="consistency-cell-detail" class="cell-detail" hidden></div>
  `;
  queueMicrotask(() => bindConsistencyCellHandlers(cells));
  return meta + grid;
}

// --- consistency report (traffic-light UI) -----------------------------------

function renderConsistencyEmpty(reason) {
  const message = reason
    ? `Run \`npm run pipeline\` first. (${escapeHtml(reason)})`
    : "Run `npm run pipeline` first to generate <code>output/consistency-report.json</code>.";
  return `<div class="consistency-empty">${message}</div>`;
}

function evaluateConsistencyCells(report) {
  const drift = numericOrNull(report.coordinateDriftPx);
  const palette = numericOrNull(report.paletteMatch);
  const level = numericOrNull(report.editabilityLevel);
  const floor = report.editabilityFloor ?? {};
  const fontFallback = Array.isArray(report.fontFallback) ? report.fontFallback : [];
  const rasterized = Array.isArray(report.rasterizedRegions) ? report.rasterizedRegions : [];
  const preview = report.previewDiff ?? { status: "deferred" };
  const layoutSafety = report.layoutSafety;

  return [
    cell("editabilityLevel", "Editability", level === null ? "n/a" : `L${level}`, toneForLevel(level)),
    cell("coordinateDriftPx", "Coord drift (px)", drift === null ? "not measured" : String(drift), toneForDrift(drift)),
    cell("fontFallback", "Font fallback", fontFallback.length === 0 ? "none" : `${fontFallback.length} fallback(s)`, fontFallback.length === 0 ? "pass" : "fail"),
    cell("paletteMatch", "Palette match", palette === null ? "not measured" : palette.toFixed(2), toneForPalette(palette)),
    cell("rasterizedRegions", "Rasterized", rasterized.length === 0 ? "none" : `${rasterized.length} region(s)`, rasterized.length === 0 ? "pass" : "warn"),
    cell("layoutSafety", "Layout safety", layoutSafety === undefined ? "not measured" : layoutSafety, toneForLayoutSafety(layoutSafety)),
    cell("editabilityFloor", "Floor", describeFloor(floor), toneForFloor(floor)),
    cell("previewDiff", "Preview diff", preview.status === "ok" ? `ok (${(preview.perSlide ?? []).length})` : "deferred", preview.status === "ok" ? "pass" : "warn"),
    cell("inputType", "Input type", report.inputType ?? "unknown", "pass")
  ];
}

function cell(key, label, display, tone) {
  return { key, label, display, tone, raw: { key, label, display, tone } };
}

function toneForLevel(value) {
  if (value === null) return "warn";
  if (value >= 4) return "pass";
  if (value === 3) return "warn";
  return "fail";
}

function toneForDrift(value) {
  if (value === null) return "warn";
  if (value <= 1) return "pass";
  if (value <= 3) return "warn";
  return "fail";
}

function toneForPalette(value) {
  if (value === null) return "warn";
  if (value >= 0.85) return "pass";
  if (value >= 0.7) return "warn";
  return "fail";
}

function toneForFloor(floor) {
  if (!floor) return "warn";
  if (floor.satisfied === true) return "pass";
  if (floor.satisfied === "with-justification") return "warn";
  return "fail";
}

function toneForLayoutSafety(value) {
  if (value === undefined || value === null) return "warn";
  if (value === "passed") return "pass";
  if (value === "violated-with-flag") return "warn";
  if (value === "violated-blocked") return "fail";
  return "warn";
}

function describeFloor(floor) {
  if (!floor) return "n/a";
  const level = floor.level ?? "n/a";
  const satisfied = floor.satisfied;
  if (satisfied === true) return `L${level} satisfied`;
  if (satisfied === "with-justification") return `L${level} with justification`;
  return `L${level} violated`;
}

function numericOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bindConsistencyCellHandlers(cells) {
  const panel = panels["consistency-report"];
  if (!panel) return;
  const detail = panel.querySelector("#consistency-cell-detail");
  panel.querySelectorAll(".cell").forEach((node) => {
    const key = node.dataset.cell;
    const handler = () => {
      const cell = cells.find((entry) => entry.key === key);
      if (!cell || !detail) return;
      const isExpanded = node.getAttribute("aria-expanded") === "true";
      const next = !isExpanded;
      panel.querySelectorAll(".cell").forEach((other) => other.setAttribute("aria-expanded", "false"));
      node.setAttribute("aria-expanded", next ? "true" : "false");
      if (next) {
        detail.hidden = false;
        detail.textContent = formatCellDetail(cell, key);
      } else {
        detail.hidden = true;
        detail.textContent = "";
      }
    };
    node.addEventListener("click", handler);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler();
      }
    });
  });
}

function formatCellDetail(cell, key) {
  const payload = cell.raw;
  return JSON.stringify({ key, label: payload.label, display: payload.display, tone: payload.tone }, null, 2);
}
