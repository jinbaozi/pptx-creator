# Claude Design-like Visual Generation Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a design-artifact pipeline that improves text-to-PPTX quality through requirements extraction, UI/component specs, preview artifacts, screenshot-level review, and handoff packaging.

**Architecture:** Extend the current design-first flow instead of replacing it. New schemas and compiler modules produce upstream design artifacts, then existing manifest rendering, visual review, repair, and packaging continue to create editable PPTX output.

**Tech Stack:** Node.js ESM, Vitest, JSON Schema-style validation via existing schema utilities, static HTML/CSS/JS workbench, existing Python preview helpers where available.

---

## File Structure

- Create `schemas/requirements.schema.json`: validates extracted deck requirements.
- Create `schemas/ui-spec.schema.json`: validates semantic slide layout specs.
- Create `schemas/component-spec.schema.json`: validates editable component specs.
- Create `schemas/design-tokens.schema.json`: validates shared visual tokens.
- Create `schemas/preview-artifacts.schema.json`: validates preview artifact manifest.
- Create `scripts/lib/requirements-extractor.mjs`: deterministic extraction helpers for tests and LLM handoff.
- Create `scripts/lib/ui-spec-compiler.mjs`: storyboard and design direction to UI spec.
- Create `scripts/lib/component-spec-compiler.mjs`: UI spec to component specs.
- Create `scripts/lib/preview-artifact-generator.mjs`: UI/component specs to HTML/CSS/React/data files.
- Create `scripts/run-design-artifact-pipeline.mjs`: CLI orchestration for the new artifact pipeline.
- Modify `scripts/lib/manifest-compiler.mjs`: accept UI/component spec hints when compiling manifest.
- Modify `scripts/lib/vision-review.mjs`: add provider interface while keeping mock default.
- Modify `scripts/lib/run-index.mjs`: record new artifacts in run metadata.
- Modify `workbench/app.js`: display the new artifact types.
- Modify `workbench/index.html`: add navigation affordances for the new views.
- Modify `workbench/styles.css`: style the artifact views without card nesting.
- Modify `package.json`: add a script for the artifact pipeline.
- Modify `references/design-first-workflow.md`: document the upgraded route.
- Modify `references/workflow.md`: add the output contract and CLI command.
- Test with new Vitest files under `tests/`.

---

## Task 1: Add Requirements Schema and Extractor

**Files:**

- Create: `schemas/requirements.schema.json`
- Create: `scripts/lib/requirements-extractor.mjs`
- Create: `tests/requirements-extractor.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, expect, it } from "vitest";
import { extractRequirements } from "../scripts/lib/requirements-extractor.mjs";
import { readJson, validateSchema } from "../scripts/lib/schema-utils.mjs";

describe("requirements extractor", () => {
  it("extracts a deterministic requirements artifact from plain text", async () => {
    const requirements = extractRequirements({
      inputText: "Build a business technology roadshow deck for kycc, a Rust-based GCC-compatible C compiler.",
      options: {
        audience: "technical executives",
        tone: "business technology roadshow"
      }
    });

    expect(requirements.audience).toBe("technical executives");
    expect(requirements.objective).toContain("roadshow");
    expect(requirements.sourceFacts[0].text).toContain("Rust-based");
    expect(requirements.tone).toBe("business technology roadshow");
  });

  it("validates against the requirements schema", async () => {
    const schema = await readJson("schemas/requirements.schema.json");
    const requirements = extractRequirements({
      inputText: "Create a polished deck about Claude Design-like workflows.",
      options: { audience: "product team" }
    });

    expect(() => validateSchema(schema, requirements, "requirements")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests and confirm failure**

Run:

```powershell
npm.cmd test -- tests/requirements-extractor.test.mjs
```

Expected: fail because the schema and module do not exist.

- [ ] **Step 3: Add `schemas/requirements.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PPTX Creator Requirements Artifact",
  "type": "object",
  "required": ["version", "audience", "objective", "sourceFacts", "mustInclude", "mustAvoid", "tone", "confidenceNotes"],
  "additionalProperties": false,
  "properties": {
    "version": { "type": "string", "const": "1.0" },
    "audience": { "type": "string", "minLength": 1 },
    "objective": { "type": "string", "minLength": 1 },
    "sourceFacts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "text", "source"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "minLength": 1 },
          "text": { "type": "string", "minLength": 1 },
          "source": { "type": "string", "minLength": 1 }
        }
      }
    },
    "mustInclude": { "type": "array", "items": { "type": "string" } },
    "mustAvoid": { "type": "array", "items": { "type": "string" } },
    "tone": { "type": "string", "minLength": 1 },
    "confidenceNotes": { "type": "array", "items": { "type": "string" } }
  }
}
```

- [ ] **Step 4: Add `scripts/lib/requirements-extractor.mjs`**

```js
export function extractRequirements({ inputText, options = {} }) {
  const text = String(inputText || "").trim();
  if (!text) {
    throw new Error("inputText is required");
  }

  const audience = options.audience || "general business audience";
  const tone = options.tone || "polished business presentation";
  const objective = options.objective || `Create a ${tone} deck for ${audience}.`;

  return {
    version: "1.0",
    audience,
    objective,
    sourceFacts: [
      {
        id: "fact-001",
        text,
        source: "user-input"
      }
    ],
    mustInclude: Array.isArray(options.mustInclude) ? options.mustInclude : [],
    mustAvoid: Array.isArray(options.mustAvoid) ? options.mustAvoid : [],
    tone,
    confidenceNotes: []
  };
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd test -- tests/requirements-extractor.test.mjs
git add schemas/requirements.schema.json scripts/lib/requirements-extractor.mjs tests/requirements-extractor.test.mjs
git commit -m "feat: add requirements artifact extraction"
```

---

## Task 2: Add UI Spec and Component Spec Compilers

**Files:**

- Create: `schemas/ui-spec.schema.json`
- Create: `schemas/component-spec.schema.json`
- Create: `scripts/lib/ui-spec-compiler.mjs`
- Create: `scripts/lib/component-spec-compiler.mjs`
- Create: `tests/ui-component-spec.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { describe, expect, it } from "vitest";
import { compileUiSpec } from "../scripts/lib/ui-spec-compiler.mjs";
import { compileComponentSpecs } from "../scripts/lib/component-spec-compiler.mjs";

describe("UI and component spec compilers", () => {
  it("creates semantic layout specs from storyboard slides", () => {
    const uiSpec = compileUiSpec({
      storyboard: {
        slides: [
          { id: "s1", title: "Cover", slideRole: "cover", visualIntent: "bold roadshow opening" },
          { id: "s2", title: "Architecture", slideRole: "architecture", visualIntent: "layered compiler pipeline" }
        ]
      },
      designDirection: {
        palette: { primary: "#155EEF", accent: "#F97316" }
      }
    });

    expect(uiSpec.slides).toHaveLength(2);
    expect(uiSpec.slides[0].layoutPattern).toBe("hero");
    expect(uiSpec.slides[1].layoutPattern).toBe("architecture-layered");
  });

  it("creates editable component specs from UI specs", () => {
    const components = compileComponentSpecs({
      uiSpec: {
        version: "1.0",
        slides: [
          {
            id: "s1",
            layoutPattern: "hero",
            regions: [{ id: "title", role: "headline", priority: 1 }]
          }
        ]
      }
    });

    expect(components.slides[0].components[0].type).toBe("textBlock");
    expect(components.slides[0].components[0].editability).toBe("native");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/ui-component-spec.test.mjs
```

Expected: fail because modules and schemas do not exist.

- [ ] **Step 3: Add minimal schemas**

Add `schemas/ui-spec.schema.json` with required `version` and `slides[]`. Each slide requires `id`, `layoutPattern`, and `regions[]`.

Add `schemas/component-spec.schema.json` with required `version` and `slides[]`. Each slide requires `id` and `components[]`. Each component requires `id`, `type`, `editability`, and `region`.

- [ ] **Step 4: Implement `compileUiSpec`**

Use deterministic role mapping:

```js
const ROLE_TO_LAYOUT = {
  cover: "hero",
  architecture: "architecture-layered",
  process: "process-flow",
  metrics: "metrics-dashboard",
  comparison: "comparison-matrix",
  roadmap: "roadmap",
  summary: "executive-summary"
};
```

Return `hero` for cover slides, mapped patterns for known roles, and `executive-summary` as fallback.

- [ ] **Step 5: Implement `compileComponentSpecs`**

For each UI region:

- `headline` becomes `textBlock`
- `metric` becomes `metric`
- `diagram` becomes `semanticDiagram`
- `chart` becomes `nativeChart`
- other roles become `card`

Set `editability: "native"` by default.

- [ ] **Step 6: Run tests and commit**

```powershell
npm.cmd test -- tests/ui-component-spec.test.mjs
git add schemas/ui-spec.schema.json schemas/component-spec.schema.json scripts/lib/ui-spec-compiler.mjs scripts/lib/component-spec-compiler.mjs tests/ui-component-spec.test.mjs
git commit -m "feat: compile UI and component specs"
```

---

## Task 3: Generate HTML/CSS/React/data Preview Artifacts

**Files:**

- Create: `schemas/design-tokens.schema.json`
- Create: `schemas/preview-artifacts.schema.json`
- Create: `scripts/lib/preview-artifact-generator.mjs`
- Create: `tests/preview-artifact-generator.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { describe, expect, it } from "vitest";
import { generatePreviewArtifacts } from "../scripts/lib/preview-artifact-generator.mjs";

describe("preview artifact generator", () => {
  it("generates static HTML, CSS, React, and data artifacts", () => {
    const artifacts = generatePreviewArtifacts({
      uiSpec: {
        version: "1.0",
        slides: [{ id: "s1", layoutPattern: "hero", regions: [{ id: "title", role: "headline", priority: 1 }] }]
      },
      componentSpecs: {
        version: "1.0",
        slides: [{ id: "s1", components: [{ id: "c1", type: "textBlock", editability: "native", region: "title" }] }]
      },
      designTokens: {
        version: "1.0",
        color: { background: "#FFFFFF", text: "#111827", primary: "#155EEF" },
        typography: { heading: "Aptos Display", body: "Aptos" },
        spacing: { slidePadding: 48 }
      }
    });

    expect(artifacts.files["index.html"]).toContain("slides-root");
    expect(artifacts.files["styles.css"]).toContain("--color-primary");
    expect(artifacts.files["components.jsx"]).toContain("function Slide");
    expect(artifacts.files["data.jsx"]).toContain("slides");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/preview-artifact-generator.test.mjs
```

- [ ] **Step 3: Add token and preview schemas**

`design-tokens.schema.json` should require `version`, `color`, `typography`, and `spacing`.

`preview-artifacts.schema.json` should require `version`, `files`, and `generatedFrom`.

- [ ] **Step 4: Implement preview generation**

Return an object with:

- `version: "1.0"`
- `generatedFrom: ["ui-spec", "component-specs", "design-tokens"]`
- `files["index.html"]`
- `files["styles.css"]`
- `files["components.jsx"]`
- `files["data.jsx"]`

Keep output static and deterministic. Do not add bundler dependencies.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- tests/preview-artifact-generator.test.mjs
git add schemas/design-tokens.schema.json schemas/preview-artifacts.schema.json scripts/lib/preview-artifact-generator.mjs tests/preview-artifact-generator.test.mjs
git commit -m "feat: generate preview design artifacts"
```

---

## Task 4: Add Artifact Pipeline CLI

**Files:**

- Create: `scripts/run-design-artifact-pipeline.mjs`
- Create: `tests/design-artifact-pipeline.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing integration test**

The test should create a temporary input text file, run the CLI, and assert that these files exist:

- `requirements.json`
- `ui-spec.json`
- `component-specs.json`
- `design-tokens.json`
- `preview-artifacts/index.html`
- `preview-artifacts/styles.css`
- `preview-artifacts/components.jsx`
- `preview-artifacts/data.jsx`

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/design-artifact-pipeline.test.mjs
```

- [ ] **Step 3: Implement CLI**

CLI contract:

```powershell
node scripts/run-design-artifact-pipeline.mjs input.txt output/design-artifacts --audience "technical executives" --tone "business technology roadshow"
```

Behavior:

- read input text
- call `extractRequirements`
- create a minimal storyboard with 5 to 7 slide roles
- call `compileUiSpec`
- call `compileComponentSpecs`
- create default design tokens
- call `generatePreviewArtifacts`
- write all JSON and preview files

- [ ] **Step 4: Add package script**

Add:

```json
"pipeline:artifacts": "node scripts/run-design-artifact-pipeline.mjs"
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- tests/design-artifact-pipeline.test.mjs
git add scripts/run-design-artifact-pipeline.mjs tests/design-artifact-pipeline.test.mjs package.json
git commit -m "feat: add design artifact pipeline cli"
```

---

## Task 5: Integrate Artifacts with Manifest Compilation

**Files:**

- Modify: `scripts/lib/manifest-compiler.mjs`
- Modify: `scripts/compile-design-first.mjs`
- Create: `tests/artifact-manifest-compiler.test.mjs`

- [ ] **Step 1: Write failing compiler test**

Test that a slide with `layoutPattern: "architecture-layered"` and `semanticDiagram` component compiles to editable manifest elements with text boxes, native lines, and arrowheads.

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/artifact-manifest-compiler.test.mjs
```

- [ ] **Step 3: Extend manifest compiler input**

Allow optional `uiSpec` and `componentSpecs` arguments. If present, use them as layout hints for choosing archetypes and component rendering.

- [ ] **Step 4: Preserve old behavior**

Existing tests for `manifest-compiler`, `design-first-pipeline`, and `render-pptx` must continue to pass without passing new artifacts.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- tests/artifact-manifest-compiler.test.mjs tests/manifest-compiler.test.mjs tests/design-first-pipeline.test.mjs tests/render-pptx.test.mjs
git add scripts/lib/manifest-compiler.mjs scripts/compile-design-first.mjs tests/artifact-manifest-compiler.test.mjs
git commit -m "feat: use design artifacts during manifest compilation"
```

---

## Task 6: Upgrade Vision Review Provider Interface

**Files:**

- Modify: `scripts/lib/vision-review.mjs`
- Modify: `scripts/run-vision-review.mjs`
- Modify: `schemas/vision-review.schema.json`
- Create: `tests/vision-review-provider.test.mjs`

- [ ] **Step 1: Write failing tests**

Test cases:

- default provider is `mock`
- provider output includes `overallScore`, `issues[]`, and `recommendedPatches[]`
- unknown provider fails with a clear error
- provider can review screenshot metadata without requiring network

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/vision-review-provider.test.mjs
```

- [ ] **Step 3: Implement provider interface**

Recommended API:

```js
export async function runVisionReview({ screenshots, manifest, provider = "mock", options = {} }) {
  if (provider === "mock") return runMockVisionReview({ screenshots, manifest, options });
  throw new Error(`Unsupported vision review provider: ${provider}`);
}
```

- [ ] **Step 4: Add CLI flag**

Add `--provider mock` to `scripts/run-vision-review.mjs`.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- tests/vision-review-provider.test.mjs tests/vision-review.test.mjs tests/vision-review-cli.test.mjs
git add scripts/lib/vision-review.mjs scripts/run-vision-review.mjs schemas/vision-review.schema.json tests/vision-review-provider.test.mjs
git commit -m "feat: add vision review provider interface"
```

---

## Task 7: Enhance Visual Workbench for Artifacts

**Files:**

- Modify: `workbench/index.html`
- Modify: `workbench/app.js`
- Modify: `workbench/styles.css`
- Modify: `tests/workbench.test.mjs`

- [ ] **Step 1: Write failing workbench tests**

Assert the workbench can list and render:

- requirements
- UI spec
- component specs
- preview artifacts
- vision review
- repair patch

- [ ] **Step 2: Run and confirm failure**

```powershell
npm.cmd test -- tests/workbench.test.mjs
```

- [ ] **Step 3: Add artifact navigation**

Use tabs or segmented controls for artifact categories. Avoid nested cards. Keep text compact and readable.

- [ ] **Step 4: Add artifact renderers**

Render JSON summaries with collapsible sections or concise tables. Link preview files when available.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test -- tests/workbench.test.mjs
git add workbench/index.html workbench/app.js workbench/styles.css tests/workbench.test.mjs
git commit -m "feat: show design artifacts in workbench"
```

---

## Task 8: Update Documentation and Run Full Verification

**Files:**

- Modify: `references/design-first-workflow.md`
- Modify: `references/workflow.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `tests/agent-docs.test.mjs`

- [ ] **Step 1: Update docs**

Document:

- artifact pipeline command
- generated output package
- mock versus real vision review provider boundary
- strict replica boundary
- Visual Workbench artifact inspection

- [ ] **Step 2: Update docs tests**

Extend `tests/agent-docs.test.mjs` to assert that Chinese and English READMEs mention:

- design artifacts
- preview artifacts
- screenshot-level review
- editable PPTX

- [ ] **Step 3: Run focused tests**

```powershell
npm.cmd test -- tests/agent-docs.test.mjs tests/setup.test.mjs
```

- [ ] **Step 4: Run broader Node tests**

```powershell
npm.cmd test
```

- [ ] **Step 5: Commit documentation**

```powershell
git add references/design-first-workflow.md references/workflow.md README.md README.en.md tests/agent-docs.test.mjs
git commit -m "docs: document design artifact pipeline"
```

---

## Self-review Checklist

- Every new runtime artifact has a schema.
- Existing design-first commands still work.
- Strict HTML/image/PDF replica mode is not changed by creative design exploration.
- Offline tests do not require network, LLM, or real vision APIs.
- Real screenshot-level review is represented as an interface first, with mock mode as default.
- Visual Workbench and screenshot-level review remain explicit ToDo items until fully implemented.
- PPTX output remains editable-first, with rasterization used only when explicitly reported.

