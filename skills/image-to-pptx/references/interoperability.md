# Optional interoperability

Core image-to-PPTX execution does not need another Skill or the presentation-package protocol.

When `--html-package` is enabled, emit protocol `pptx-creator.presentation-package` version `1.0.0` with:

- `kind: image-reconstruction`;
- producer `image-to-pptx`;
- page size, stable slide IDs, order, components, and z-order;
- component confidence and source references;
- local asset paths and SHA-256 values;
- extracted design tokens;
- validation status and report paths;
- every editability degradation.

Validate the package with:

```bash
node scripts/validate-presentation-package.mjs \
  output/html-package/presentation-package.json
```

The HTML package is optional and self-contained. It can be passed explicitly to a compatible HTML-to-PPTX implementation, but the directly generated PPTX must never invoke or import that implementation.

The optional `index.html` carries the same component identities as
`presentation-package.json`:

- mark the deck with `.pptx-deck` and `data-pptx-deck`;
- mark every page with `.pptx-slide`, `data-slide`, `data-slide-id`,
  `data-title`, and `data-notes`;
- use the protocol component ID unchanged in both `data-component-id` and
  `data-pptx-id`;
- emit `data-pptx-kind="text|shape|table|image"` for those component types;
- expose visually detected, unanchored divider objects as protocol `shape`
  components and `data-pptx-kind="shape"` thin rectangles;
- reserve protocol `connector`, `data-pptx-kind="line"`, and
  `data-connector` for objects that provide valid `sourceId` and `targetId`
  references together;
- when a lower-z shape geometrically contains at least 95% of a higher-z
  component, mark that shape as `data-layout-role="background"` and list only
  those contained component IDs in `data-allow-overlap-with`; do not add a
  global overlap exemption;
- reject unknown object kinds or globally duplicated semantic IDs instead of
  emitting a package that a converter would silently omit.

These are portable HTML semantics, not imports from another Skill. A consumer
may ignore them; a compatible converter can use them for stable measurement
and native-object reconstruction.

Reject any protocol version other than `1.0.0` with `E_PROTOCOL_VERSION`. Do not guess compatibility or silently coerce unknown fields.
