import assert from "node:assert/strict";
import test from "node:test";
import { componentAttrs } from "../../scripts/lib/component-metadata.mjs";

test("component metadata always declares a semantic type tier and QA region", () => {
  assert.equal(
    componentAttrs("body-copy", "text"),
    'data-pptx-id="body-copy" data-pptx-kind="text" data-type-tier="body" data-qa-region="content"'
  );
  assert.equal(
    componentAttrs("footer/source", "text", 'data-layout-role="source"', { typeTier: "source", qaRegion: "footer" }),
    'data-pptx-id="footer/source" data-pptx-kind="text" data-type-tier="source" data-qa-region="footer" data-layout-role="source"'
  );
  assert.equal(
    componentAttrs("decor", "shape", "", { qaRegion: "decoration" }),
    'data-pptx-id="decor" data-pptx-kind="shape" data-type-tier="none" data-qa-region="decoration"'
  );
});
