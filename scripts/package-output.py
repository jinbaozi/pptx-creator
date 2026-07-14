#!/usr/bin/env python3
import hashlib
import json
import os
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath


REQUIRED = [
    "final.pptx",
    "editable-report.md",
    "qa-report.md",
    "compatibility-report.md",
    "consistency-report.json",
    "consistency-report.md",
]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def assert_no_symlink_below_trusted_anchor(candidate: Path) -> Path:
    target = Path(os.path.abspath(candidate))
    lexical = [
        Path(tempfile.gettempdir()),
        Path.home(),
        Path.cwd(),
        Path(__file__).resolve().parents[1],
        Path("/private/tmp"),
        Path("/tmp"),
    ]
    anchors = []
    for anchor in lexical:
        absolute = Path(os.path.abspath(anchor))
        anchors.append(absolute)
        anchors.append(Path(os.path.realpath(absolute)))
    eligible = []
    for anchor in set(anchors):
        try:
            if os.path.commonpath([str(anchor), str(target)]) == str(anchor):
                eligible.append(anchor)
        except ValueError:
            continue
    if not eligible:
        fail(f"package output is outside trusted filesystem anchors: {target}")
    anchor = max(eligible, key=lambda value: len(str(value)))
    cursor = anchor
    for part in target.relative_to(anchor).parts:
        cursor = cursor / part
        try:
            mode = cursor.lstat().st_mode
        except FileNotFoundError:
            fail(f"package output path does not exist: {cursor}")
        if stat.S_ISLNK(mode):
            fail(f"package output path must not traverse a symbolic link: {cursor}")
        if cursor != target and not stat.S_ISDIR(mode):
            fail(f"package output ancestor must be a real directory: {cursor}")
    return target


def require_regular_relative(output_dir: Path, relative: str, label: str) -> Path:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        fail(f"{label} must be a normalized relative POSIX path")
    portable = PurePosixPath(relative)
    if portable.is_absolute() or portable.as_posix() != relative or any(part in {"", ".", ".."} for part in portable.parts):
        fail(f"{label} must be a normalized relative POSIX path")
    cursor = output_dir
    for index, part in enumerate(portable.parts):
        cursor = cursor / part
        try:
            mode = cursor.lstat().st_mode
        except FileNotFoundError:
            fail(f"missing creative artifact: {relative}")
        if stat.S_ISLNK(mode):
            fail(f"creative artifact must not traverse a symbolic link: {relative}")
        if index < len(portable.parts) - 1 and not stat.S_ISDIR(mode):
            fail(f"creative artifact ancestor must be a real directory: {relative}")
    if not stat.S_ISREG(cursor.lstat().st_mode):
        fail(f"creative artifact must be a real regular file: {relative}")
    return cursor


def validate_creative_evidence(output_dir: Path) -> None:
    run_path = output_dir / "run.json"
    def lexical_marker_exists(relative: str) -> bool:
        cursor = output_dir
        parts = PurePosixPath(relative).parts
        for index, part in enumerate(parts):
            cursor = cursor / part
            try:
                mode = cursor.lstat().st_mode
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(mode):
                return index == len(parts) - 1
            if index < len(parts) - 1 and not stat.S_ISDIR(mode):
                return False
        return True

    has_creative_marker = any(lexical_marker_exists(relative) for relative in [
        "deck.plan.json",
        "semantic-slide-ir.json",
        "assets/asset-registry.json",
    ])
    if not run_path.exists() and not run_path.is_symlink():
        if has_creative_marker:
            fail("creative public evidence requires a real run.json with creative mode")
        return
    if run_path.is_symlink() or not run_path.is_file():
        fail("run.json must be a real regular file")
    try:
        run = json.loads(run_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid run.json: {error}")
    if run.get("mode") != "creative":
        if has_creative_marker:
            fail("creative public evidence requires run.json mode creative")
        return
    expected = {
        "deckPlan": "deck.plan.json",
        "semanticIr": "semantic-slide-ir.json",
        "manifest": "deck.manifest.json",
        "assetRegistry": "assets/asset-registry.json",
    }
    artifacts = run.get("artifacts")
    if not isinstance(artifacts, dict):
        fail("creative run.json is missing artifacts")
    for key, relative in expected.items():
        if artifacts.get(key) != relative:
            fail(f"creative run artifact pointer {key} must equal {relative}")
        require_regular_relative(output_dir, relative, f"run.artifacts.{key}")
    registry_path = output_dir / expected["assetRegistry"]
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid creative asset registry: {error}")
    if registry.get("version") != "0.2.0" or not isinstance(registry.get("assets"), list):
        fail("creative asset registry must use version 0.2.0 with an assets array")
    for asset in registry["assets"]:
        if not isinstance(asset, dict) or not isinstance(asset.get("localPath"), str):
            fail("creative asset registry contains an invalid localPath")
        local_path = asset["localPath"]
        if not local_path.startswith("assets/"):
            fail(f"creative asset localPath must remain below assets/: {local_path}")
        target = require_regular_relative(output_dir, local_path, "asset localPath")
        actual_hash = f"sha256:{hashlib.sha256(target.read_bytes()).hexdigest()}"
        if actual_hash != asset.get("contentHash"):
            fail(f"creative asset content hash mismatch: {asset.get('id', 'asset')}")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: package-output.py <output-dir>")
    output_dir = assert_no_symlink_below_trusted_anchor(Path(sys.argv[1]))
    if output_dir.is_symlink() or not output_dir.is_dir():
        fail(f"package output must be a real directory, not a symbolic link: {output_dir}")
    validate_creative_evidence(output_dir)
    missing = [
        name
        for name in REQUIRED
        if not (output_dir / name).exists()
        or (output_dir / name).is_symlink()
        or not (output_dir / name).is_file()
    ]
    if missing:
        fail(f"missing output files: {', '.join(missing)}")
    files = [
        path.name
        for path in output_dir.iterdir()
        if path.name != "output-manifest.json"
        and not path.name.startswith(".pptx-generated-assets.")
    ]
    assets_dir = output_dir / "assets"
    asset_registry = assets_dir / "asset-registry.json"
    if (
        not assets_dir.is_symlink()
        and assets_dir.is_dir()
        and not asset_registry.is_symlink()
        and asset_registry.is_file()
    ):
        files.append("assets/asset-registry.json")
    manifest = {
        "outputDir": str(output_dir),
        "files": sorted(files),
    }
    output_manifest = output_dir / "output-manifest.json"
    if output_manifest.is_symlink():
        fail(f"package manifest target must not be a symbolic link: {output_manifest}")
    output_manifest.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
