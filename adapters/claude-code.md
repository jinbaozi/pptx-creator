# Claude Code Adapter

Use this adapter when `pptx-creator` is used from Claude Code or another terminal-first agent that can read files and run shell commands.

## Setup

```bash
cd pptx-creator
npm install
npx playwright install chromium
npm run setup
```

For Python discovery, prefer:

```bash
export PPTX_CREATOR_PYTHON=/path/to/python3
npm run setup
```

## Claude Code Workflow

1. Read `SKILL.md` and `AGENT.md`.
2. Read the selected `DESIGN.md`.
3. Read the reference file for the user input type.
4. Author `output/deck.manifest.json`.
5. Run:

```bash
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

6. Inspect reports:

```bash
cat output/editable-report.md
cat output/qa-report.md
```

## Notes For Claude Code

- Keep reasoning in the host agent. The scripts do not call model APIs.
- Use the manifest as the single source of truth.
- Do not rely on a full-slide screenshot fallback unless the user accepts low editability.
- Report missing optional tools clearly.
- Preserve user-provided files and do not overwrite reference images or input HTML unless requested.

## Verification

Before final response, run at least:

```bash
npm test
npm run test:py
node scripts/run-deck-pipeline.mjs output/deck.manifest.json output
```

For a quick package health check, `npm run setup` is acceptable when no user deck has been authored yet.
