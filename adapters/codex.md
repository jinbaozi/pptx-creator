# Codex Adapter

Use this adapter when `pptx-creator` is used inside Codex CLI, Codex desktop, or a Codex worktree.

## Setup

```powershell
cd pptx-creator
npm install
npx playwright install chromium
npm run setup
```

If `python` is not on PATH, the package will try `PPTX_CREATOR_PYTHON`, `PYTHON`, and the bundled Codex runtime Python. To force a specific interpreter:

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
npm run setup
```

## Codex Workflow

1. Read `SKILL.md`.
2. Read `AGENT.md`.
3. Read the input-specific reference:
   - Text: `references/workflow.md`
   - HTML: `references/html-to-pptx.md`
   - CSS HTML: `references/html-measurement.md`
   - Image: `references/image-to-pptx.md`
4. Write `output/deck.manifest.json`.
5. Run:

```powershell
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

6. Read `output/editable-report.md` and `output/qa-report.md` before replying.

## Codex Safety Notes

- Use `apply_patch` for edits when working in a repository.
- Do not commit `node_modules/`, `output/`, `.pptx-creator/`, or Python caches.
- Keep generated artifacts in `output/` unless the user asks for another directory.
- If opening a PPTX or browser requires desktop access, request approval through the active Codex environment.

## Response Shape

Reply with:

- PPTX path.
- Editability level and important rasterized regions.
- Verification commands run.
- Optional dependency gaps.
