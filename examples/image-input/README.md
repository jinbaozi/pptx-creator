# Image input example

`business-slide.png` is a reference image used by image analysis and replica fixtures. `deck.manifest.skeleton.json` and `image-hints.json` are intermediate examples; neither is proof of an editable replica.

The only public route is:

```bash
npm run pptx -- image examples/image-input/business-slide.png output/image-replica
```

Until the image compiler and fidelity proof are available, this command must block explicitly. Do not bypass the block by rendering the skeleton or packaging the source image as a full-slide raster.

Before image work, install and verify the selected profile:

```bash
python3 -m pip install -r requirements-image.txt
npm run setup -- image
```

Expected future strict output includes `final.pptx`, `deck.manifest.json`, `quality-report.json/md`, `replica-evidence.json`, `output-manifest.json`, and `preview/index.html`.
