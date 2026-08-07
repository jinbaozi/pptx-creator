# Installation, isolated execution, and publishing

> **Purpose:** Install, exercise, and package this Skill as an independent offline runtime.
>
> **Trigger:** Use before a fresh install, an isolation proof, or publishing this Skill directory.
>
> **Prereqs:** Node.js 20 or newer and permission to install the declared npm and Playwright dependencies.
>
> **Next:** [workflow.md](workflow.md)
>
> **Contract:** The installed `skills/text-to-html` directory must execute without a parent repository or sibling Skill.

Requirements: Node.js 20 or newer and a Chromium binary installed by Playwright.

For reproducible visual-golden execution, CI pins Ubuntu 24.04, Playwright/Chromium from this Skill's lockfile, `zh_CN.UTF-8`, `Asia/Shanghai`, device scale factor 1, Liberation fonts, and Noto CJK fonts. Local runs use the same browser locale, timezone, viewport, and scale settings; small platform rasterization differences are compared through bounded perceptual hashes and color-grid distance rather than byte-identical screenshots.

From this Skill directory:

```bash
npm ci
npx playwright install chromium
node scripts/lint-references.mjs
npm test
npm run test:browser
npm run test:visual
```

The visual suite compares six persistent framework fixtures covering long titles, footer safety, five-step process layout, dense timelines, mobile-reader behavior, and source wrapping. Updating `tests/visual/goldens/framework-fixtures.json` is a reviewed baseline change, not an automatic side effect of a normal test run.

Run a deck:

```bash
node scripts/run-pipeline.mjs examples/minimal/presentation-plan.json /tmp/text-to-html-minimal
```

Validate outputs independently:

```bash
node scripts/validate-plan.mjs /tmp/text-to-html-minimal/presentation-plan.json
node scripts/validate-presentation-package.mjs /tmp/text-to-html-minimal/presentation-package.json
```

For an isolation proof, copy only `skills/text-to-html` into a fresh directory; do not copy the repository root or sibling Skills. Then run `npm ci`, install Chromium if the environment has no cached browser, execute the minimal example, and confirm the package validator and browser QA pass. The automated form is:

```bash
npm run test:isolation
```

Publish or archive this directory as one unit. Include `SKILL.md`, `agents/`, `scripts/`, `references/`, `assets/`, `schemas/`, `examples/`, `tests/`, `package.json`, `package-lock.json`, and `LICENSE`. No parent workspace component is required at runtime.
