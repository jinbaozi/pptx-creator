const input = document.querySelector("#run-file");
const summary = document.querySelector("#run-summary");
const directions = document.querySelector("#directions");
const previews = document.querySelector("#previews");
const reviews = document.querySelector("#reviews");

input?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  const run = JSON.parse(await file.text());
  renderRun(run);
});

export function renderRun(run) {
  summary.textContent = JSON.stringify({
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    input: run.input
  }, null, 2);
  directions.innerHTML = renderList(run.directions ?? [], (direction) => `${direction.id}: ${direction.label} (${direction.status}, score ${direction.score ?? "n/a"})`);
  previews.innerHTML = renderList(run.artifacts?.previews ?? [], (preview) => preview);
  reviews.innerHTML = renderList(run.artifacts?.reviews ?? [], (review) => review);
}

function renderList(items, label) {
  if (!items.length) return "<p class=\"empty\">No artifacts found.</p>";
  return `<ul>${items.map((item) => `<li>${escapeHtml(label(item))}</li>`).join("")}</ul>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}
