# Cursor Adapter

Use this adapter when `pptx-creator` is used inside Cursor or an IDE-attached coding agent.

## Setup

Open the `pptx-creator` folder as the working directory, then run:

```bash
npm install
npx playwright install chromium
npm run setup
```

If Cursor's terminal cannot find Python:

```bash
export PPTX_CREATOR_PYTHON=/path/to/python3
```

On Windows PowerShell:

```powershell
$env:PPTX_CREATOR_PYTHON="C:\Path\To\python.exe"
```

## Cursor Workflow

1. Pin or open these files:
   - `SKILL.md`
   - `AGENT.md`
   - `references/workflow.md`
   - The selected `DESIGN.md`
2. Create or edit `output/deck.manifest.json`.
3. Use the terminal to run:

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

4. Open generated reports in the editor:
   - `output/editable-report.md`
   - `output/qa-report.md`
   - `output/output-manifest.json`

## IDE Tips

- Use schema-aware JSON editing for `deck.manifest.json`.
- Keep repeated design tokens as token references, such as `{colors.primary}`.
- Use `references/manifest-spec.md` when editing coordinates or element types.
- For HTML conversion, keep source HTML separate from generated manifests.
- For image replication, store cropped assets under `output/assets/`.

## Final Reply

Tell the user where `output/final.pptx` is, what can be edited, what was rasterized, and which checks passed.
