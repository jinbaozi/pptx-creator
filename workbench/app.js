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
  "consistency-report": document.querySelector("#consistency-report-panel"),
  "visual-quality": document.querySelector("#visual-quality-panel")
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
  loadVisualQualityReportFromFetch();
});

if (typeof window !== "undefined" && document.readyState !== "loading") {
  loadConsistencyReportFromFetch();
  loadVisualQualityReportFromFetch();
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
  // --- visual quality exports (U10) ---
  window.renderVisualQualityReport = function (visualReviewJson, layoutSafetyJson, errors) {
    const panel = panels["visual-quality"];
    if (!panel) return null;
    panel.dataset.manualOverride = "true";
    const html = renderVisualQualityReportHtml(visualReviewJson, layoutSafetyJson, errors ?? {});
    panel.innerHTML = html;
    return html;
  };
  window.evaluateVisualQualityCells = evaluateVisualQualityCells;
  window.renderTerminationSignals = renderTerminationSignals;
  window.activateTab = activateTab;
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
      // Deeplink: the 9th (layoutSafety) cell in the consistency report
      // switches to the Visual Quality tab instead of expanding inline.
      if (key === "layoutSafety") {
        activateTab("visual-quality");
        return;
      }
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

// --- visual quality tab (U10) ------------------------------------------------

const VISUAL_QUALITY_LAYOUT_SAFETY_KINDS = [
  "bounds",
  "overlap",
  "font-too-small",
  "line-height-too-tight",
  "text-overflow",
  "card-spacing-tight",
  "contrast-fail",
  "letter-spacing-too-tight"
];

// --- visual quality loaders / state machine ---------------------------------

/**
 * Fetch both `output/visual-review.json` and `output/layout-safety-report.json`
 * in parallel and render the resulting state matrix into the panel. The state
 * matrix covers: both files missing, one file missing, malformed JSON, and
 * the success path.
 */
async function loadVisualQualityReportFromFetch() {
  const panel = panels["visual-quality"];
  if (!panel || !window.fetch) return;
  if (panel.dataset.manualOverride === "true") return;
  // Loading state: spinner placeholder.
  panel.innerHTML = renderVisualQualityLoading();
  if (panel.dataset.manualOverride === "true") return;

  let visualReview = null;
  let layoutSafety = null;
  let visualReviewError = null;
  let layoutSafetyError = null;

  const [visualResponse, layoutResponse] = await Promise.all([
    fetch("./output/visual-review.json", { cache: "no-store" }).catch((error) => ({ __error: error })),
    fetch("./output/layout-safety-report.json", { cache: "no-store" }).catch((error) => ({ __error: error }))
  ]);

  if (panel.dataset.manualOverride === "true") return;

  // visual-review parsing
  if (visualResponse && visualResponse.__error) {
    visualReviewError = visualResponse.__error?.message ?? "fetch failed";
  } else if (visualResponse && visualResponse.status === 404) {
    visualReviewError = "404";
  } else if (visualResponse && !visualResponse.ok) {
    visualReviewError = `HTTP ${visualResponse.status}`;
  } else if (visualResponse && typeof visualResponse.json === "function") {
    try {
      visualReview = await visualResponse.json();
    } catch (error) {
      visualReviewError = error?.message ?? "malformed JSON";
    }
  }

  // layout-safety parsing
  if (layoutResponse && layoutResponse.__error) {
    layoutSafetyError = layoutResponse.__error?.message ?? "fetch failed";
  } else if (layoutResponse && layoutResponse.status === 404) {
    layoutSafetyError = "404";
  } else if (layoutResponse && !layoutResponse.ok) {
    layoutSafetyError = `HTTP ${layoutResponse.status}`;
  } else if (layoutResponse && typeof layoutResponse.json === "function") {
    try {
      layoutSafety = await layoutResponse.json();
    } catch (error) {
      layoutSafetyError = error?.message ?? "malformed JSON";
    }
  }

  if (panel.dataset.manualOverride === "true") return;
  panel.innerHTML = renderVisualQualityReportHtml(visualReview, layoutSafety, {
    visualReviewError,
    layoutSafetyError
  });
  // Load consistency report too so we can render termination signals + deeplink.
  loadVisualQualityTerminationSignals();
}

/**
 * Re-render the visual-quality panel with termination signals derived from
 * the consistency report's `feedback` block. Called by the consistency report
 * auto-loader (and by manual renderConsistencyReport overrides).
 */
function loadVisualQualityTerminationSignals() {
  const panel = panels["visual-quality"];
  if (!panel || !window.fetch) return;
  fetch("./output/consistency-report.json", { cache: "no-store" })
    .then((response) => (response && response.ok ? response.json() : null))
    .then((report) => {
      if (panel.dataset.manualOverride === "true") return;
      if (!report) return;
      const feedback = report.feedback;
      if (!feedback) return;
      const banner = renderTerminationSignals(feedback);
      if (!banner) return;
      // Prepend banner to the existing panel content.
      panel.innerHTML = banner + panel.innerHTML;
    })
    .catch(() => {
      // Termination signals are best-effort; never fail the panel.
    });
}

function renderVisualQualityLoading() {
  return `<div class="consistency-empty">Loading visual quality reports&hellip;</div>`;
}

function renderVisualQualityReportHtml(visualReviewJson, layoutSafetyJson, errors = {}) {
  const visualError = errors.visualReviewError ?? null;
  const layoutError = errors.layoutSafetyError ?? null;

  // State matrix: both files missing
  if (visualError === "404" && layoutError === "404") {
    return `<div class="consistency-empty">Run \`npm run pipeline\` first to generate <code>output/visual-review.json</code> and <code>output/layout-safety-report.json</code>.</div>`;
  }
  // State matrix: one file missing — distinguish which one
  if (visualError === "404" || layoutError === "404") {
    // visual-review.json holds slopRisk; layout-safety-report.json holds layout safety.
    const missing = visualError === "404" ? "slopRisk not measured" : "Layout safety not measured";
    return `<div class="consistency-empty">${escapeHtml(missing)} &mdash; run \`npm run pipeline\` to generate the missing report.</div>`;
  }
  // State matrix: malformed JSON
  if (visualError || layoutError) {
    const detail = visualError
      ? `visual-review.json: ${escapeHtml(visualError)}`
      : `layout-safety-report.json: ${escapeHtml(layoutError)}`;
    return `<div class="consistency-empty">Report file is malformed &mdash; see console.<br><code>${detail}</code></div>`;
  }
  if (!visualReviewJson && !layoutSafetyJson) {
    return renderVisualQualityLoading();
  }
  if (!visualReviewJson || typeof visualReviewJson !== "object") {
    return `<div class="consistency-empty">visual-review.json is empty or not an object.</div>`;
  }
  if (!layoutSafetyJson || typeof layoutSafetyJson !== "object") {
    return `<div class="consistency-empty">layout-safety-report.json is empty or not an object.</div>`;
  }

  const cells = evaluateVisualQualityCells(visualReviewJson, layoutSafetyJson);
  const meta = `
    <p class="meta">slopRisk ${escapeHtml(String(visualReviewJson.slopRisk ?? "n/a"))} · layout-safety critical ${escapeHtml(String(layoutSafetyJson?.summary?.criticalCount ?? 0))} / warning ${escapeHtml(String(layoutSafetyJson?.summary?.warningCount ?? 0))}</p>
  `;
  const grid = `
    <div class="consistency-grid">
      ${cells.map((entry) => `
        <div class="cell ${entry.tone}" data-cell="${escapeHtml(entry.key)}">
          <span class="cell-label">${escapeHtml(entry.label)}</span>
          <span class="cell-value">${escapeHtml(entry.display)}</span>
        </div>
      `).join("")}
    </div>
  `;
  return meta + grid;
}

// --- visual quality cell evaluation ----------------------------------------

/**
 * Compute the per-cell tone grid for the Visual Quality tab. The two
 * parallel grids are: (1) a single slopRisk cell with thresholds
 *   - slopRisk >= 75 -> fail
 *   - slopRisk >= 40 -> warn
 *   - slopRisk <  40 -> pass
 * and (2) one cell per layout-safety `kind`, where the cell tone is the
 * worst severity present for that kind (critical -> fail,
 * warning -> warn, none -> pass).
 */
function evaluateVisualQualityCells(visualReviewJson, layoutSafetyJson) {
  const slopRisk = numericOrNull(visualReviewJson?.slopRisk);
  const slopDisplay = slopRisk === null ? "n/a" : `${slopRisk}/100`;
  const slopTone = slopRisk === null
    ? "warn"
    : slopRisk >= 75
      ? "fail"
      : slopRisk >= 40
        ? "warn"
        : "pass";

  const cells = [cell("slopRisk", "slopRisk", slopDisplay, slopTone)];

  const checks = Array.isArray(layoutSafetyJson?.checks) ? layoutSafetyJson.checks : [];
  for (const kind of VISUAL_QUALITY_LAYOUT_SAFETY_KINDS) {
    const matching = checks.filter((entry) => entry && entry.kind === kind);
    const hasCritical = matching.some((entry) => entry.severity === "critical");
    const hasWarning = matching.some((entry) => entry.severity === "warning");
    const tone = hasCritical ? "fail" : hasWarning ? "warn" : "pass";
    const display = matching.length === 0
      ? "none"
      : hasCritical
        ? `${matching.length} critical`
        : `${matching.length} warning`;
    cells.push(cell(kind, kindLabel(kind), display, tone));
  }
  return cells;
}

function kindLabel(kind) {
  switch (kind) {
    case "bounds": return "Bounds";
    case "overlap": return "Overlap";
    case "font-too-small": return "Font size";
    case "line-height-too-tight": return "Line height";
    case "text-overflow": return "Text overflow";
    case "card-spacing-tight": return "Card spacing";
    case "contrast-fail": return "Contrast";
    case "letter-spacing-too-tight": return "Letter spacing";
    default: return kind;
  }
}

// --- termination signals (U10 / R22) ---------------------------------------

/**
 * Render the termination-signal banner from the consistency report's
 * `feedback` block. Returns an empty string when there's nothing to
 * render.
 *   - accepted: true   -> muted checkmark
 *   - retryCount > 0   -> "Attempt N of 3" banner
 *   - retryCount >= 3  -> red banner
 */
function renderTerminationSignals(feedback) {
  if (!feedback || typeof feedback !== "object") return "";
  const retryCount = Number.isFinite(feedback.retryCount) ? feedback.retryCount : 0;
  const accepted = feedback.accepted === true;
  const acceptedAt = typeof feedback.acceptedAt === "string" ? feedback.acceptedAt : null;

  const parts = [];
  if (accepted) {
    const stamp = acceptedAt ? ` at ${escapeHtml(acceptedAt)}` : "";
    parts.push(`<p class="termination-signal termination-accepted" data-signal="accepted">Accepted${escapeHtml(stamp)} ✓</p>`);
  }
  if (retryCount > 0) {
    const cls = retryCount >= 3 ? "termination-signal termination-fail" : "termination-signal termination-warn";
    parts.push(`<p class="${cls}" data-signal="retry">Attempt ${retryCount} of 3</p>`);
  }
  return parts.join("");
}
