# Errors and recovery

Repair the earliest responsible boundary and rerun the full conversion.

| Code | Meaning | Earliest safe action |
|---|---|---|
| `E_ARGUMENT` | Missing or invalid CLI option | Correct the command; browser timeout must be at least 90000 ms and repair count at most 3 |
| `E_INPUT_NOT_FOUND` | Input or package entrypoint is unreadable | Correct the path or restore the file |
| `E_INPUT_TYPE` | Input is not HTML, a directory, or a package JSON | Pass a supported input |
| `E_INPUT_AMBIGUOUS` | Directory contains several possible HTML files | Add `index.html` or pass the intended file directly |
| `E_OUTPUT_EXISTS` | Destination is non-empty | Choose a new directory or explicitly use `--overwrite` |
| `E_PROTOCOL_VERSION` | Protocol is not exactly 1.0.0 | Migrate the producer package; do not coerce fields silently |
| `E_PROTOCOL_SCHEMA` and `E_PROTOCOL_*` | Strict schema, path, ID, source, asset, or degradation violation | Fix the producer package using the reported JSON path |
| `E_PROTOCOL_ENTRYPOINT` | HTML package has no usable entrypoint | Add a safe relative HTML entrypoint |
| `E_REMOTE_ASSET` | Remote dependency is blocked or cannot be safely localized | Use a local asset, or explicitly authorize remote localization |
| `E_ASSET_PATH` | Local image path is unreadable or invalid | Correct the relative path and permissions |
| `E_HTML_LAYOUT` | Desktop source has critical layout defects | Fix the source HTML and validate it again in Chromium |
| `E_HTML_EMPTY` | No visible convertible elements were measured | Use stable slide elements and avoid JavaScript-generated DOM |
| `E_CHART_MARKER` | Native chart marker is malformed | Correct the JSON, supported kind, data array, or stable ID |
| `E_LOCAL_FALLBACK` | Unsupported local effect cannot be cropped safely | Simplify the effect or provide a bounded visible region |
| `E_FULL_SLIDE_RASTER_FORBIDDEN` | A proposed fallback covers a whole slide | Rebuild the page with native elements or smaller local regions |
| `E_MANIFEST_CONTRACT` | Compiled render truth is internally invalid | Repair the compiler mapping or invalid source semantics |
| `E_PPTX_RENDER` | Native PPTX generation failed | Inspect the subprocess message and failing element |
| `E_PREVIEW` | LibreOffice or Poppler rendering failed | Install/fix explicit renderer dependencies and rerun |
| `E_VISUAL_COMPARE` | Reference or candidate images cannot be compared | Restore screenshots, preview pages, Pillow, or matching slide count |
| `E_QUALITY_GATE` | Layout, geometry, visual, or editability gate did not pass | Read the last attempt and fix the earliest failing source or mapping |

`failure-report.json` contains the code, message, structured details, input kind,
run ID, and `finalPublished: false`. Candidate files under `evidence/` are
diagnostic only.

Do not increase the visual threshold merely to hide a deterministic defect.
Change a threshold only when the acceptance policy itself changes, document the
reason, and retain the prior evidence.
