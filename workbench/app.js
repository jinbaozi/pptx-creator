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
  "repair-patch": document.querySelector("#repair-patch")
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
  reviews: renderReviews
};

input?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const run = JSON.parse(await file.text());
  renderRun(run);
});

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
}
