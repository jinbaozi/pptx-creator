# Image input example (M1.3)

Sample 1920×1080 business slide for image replication workflow.

## Generate sample image

```powershell
pip install -r requirements.txt
python scripts/generate-sample-slide.py
```

## Inspect

```powershell
python scripts/inspect-image.py examples/image-input/business-slide.png
python scripts/image-to-manifest-hints.py examples/image-input/business-slide.png examples/image-input/image-hints.json
```

## Host agent next steps

1. Read `image-hints.json` and visually inventory objects on `business-slide.png`.
2. Complete `deck.manifest.skeleton.json` — replace `<HOST_AGENT: ...>` placeholders.
3. Remove `assets` reference entry unless rasterizing a region.
4. Validate and render:

```powershell
python scripts/validate-manifest.py examples/image-input/deck.manifest.skeleton.json
node scripts/render-pptx.mjs examples/image-input/deck.manifest.skeleton.json output/image-replica.pptx
```

See `references/image-to-pptx.md` for full workflow.
