# Contributor constraints

## V2 scope

- The published runtime consists only of `skills/text-to-html`,
  `skills/html-to-pptx`, and `skills/image-to-pptx`.
- Keep the repository root limited to public documentation, contributor rules,
  MIT license, package metadata, CI, and `integration/` verification tooling.
- Do not add a root `SKILL.md`, a root runtime entrypoint, or alternate routes
  around the three Skill contracts.
- Do not introduce migration guidance, historical runtime descriptions, or
  compatibility interfaces into V2 public files.

## Skill independence

- Each Skill must install, test, and execute from its own directory with only
  its declared dependencies.
- Do not import from a parent repository, sibling Skill, shared local path, or
  machine-specific absolute path.
- Exchange data across Skills only through the versioned
  `pptx-creator.presentation-package` protocol. Treat it as an optional input
  or output contract, not a runtime dependency.
- Keep protocol schema and validator copies byte-aligned with the integration
  contract when a Skill declares protocol support.

## Delivery and QA

- Scripts are deterministic: they do not call an LLM or invent facts, sources,
  text, brands, or data.
- Preserve local asset provenance and reject traversal, absolute paths, and
  missing package resources.
- Do not publish a failed or pending QA result as complete.
- Do not use a full-slide raster as a substitute for an editable PPTX.

## Change discipline

- Make the smallest change that satisfies the V2 contract. Do not refactor
  adjacent behavior without a task requirement.
- This is a shared worktree. Preserve unrelated edits; never reset, revert, or
  delete work owned by another contributor.
- Keep generated `node_modules/`, `dist/`, `output/`, Python caches, and local
  editor files out of commits.
- Preserve the MIT `LICENSE`.

## Verification

- Run the relevant Skill-local tests after changing a Skill.
- For root integration changes, run `npm run test:integration`.
- Before publishing Skill packages, run `npm run package:skills` and
  `npm run verify:skills`.
- Run `npm run test:composition` when a change can affect cross-Skill protocol,
  packaging, or runtime composition.
