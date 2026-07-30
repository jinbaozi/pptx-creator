# Installation, isolated execution, and publishing

Requirements: Node.js 20 or newer and a Chromium binary installed by Playwright.

From this Skill directory:

```bash
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run test:visual
```

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
