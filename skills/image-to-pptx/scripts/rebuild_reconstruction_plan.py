#!/usr/bin/env python3
"""Rebuild a candidate reconstruction plan after bounded calibration.

This is intentionally a small Skill-local entrypoint.  It never re-runs OCR,
never changes source/assets, and only recomputes the deterministic planner from
the candidate analysis object and its current object/asset geometry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from reconstruction_planner import ReconstructionPlanError, build_reconstruction_plan


def _safe_report_path(report_path: Path, package_root: Path) -> Path:
    """Resolve the report target without touching the filesystem first."""

    root = package_root.resolve()
    raw = str(report_path)
    if report_path.is_absolute() or "\x00" in raw or ".." in report_path.parts:
        raise ReconstructionPlanError("E_RECONSTRUCTION_PLAN", "reconstruction report path must be relative and traversal-free")
    resolved = (root / report_path).resolve()
    if resolved == root or not str(resolved).startswith(f"{root}{Path('/').anchor or '/'}"):
        raise ReconstructionPlanError("E_RECONSTRUCTION_PLAN", "reconstruction report path escapes package root")
    return resolved


def rebuild(analysis_path: Path, report_path: Path, package_root: Path) -> dict:
    report_path = _safe_report_path(report_path, package_root)
    analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
    pages = []
    for slide in analysis.get("slides", []):
        bound_refs = {str(slide.get("sourceRef", ""))}
        bound_refs.update(str(item.get("sourceRef")) for item in slide.get("objects", []) if item.get("sourceRef"))
        bound_refs.update(str(item.get("sourceRef")) for item in slide.get("ownershipReport", {}).get("assets", []) if item.get("sourceRef"))
        source_records = [source for source in analysis.get("sources", []) if str(source.get("id")) in bound_refs]
        try:
            route_overrides = dict(slide.get("routeOverrides", {}))
            page = build_reconstruction_plan(
                str(slide["id"]),
                (
                    int(slide.get("sizePx", {}).get("width", slide.get("sizePx", {}).get("widthPx", 0))),
                    int(slide.get("sizePx", {}).get("height", slide.get("sizePx", {}).get("heightPx", 0))),
                ),
                list(slide.get("regionProfiles", [])),
                list(slide.get("objects", [])),
                dict(slide.get("ownershipReport", {})),
                source_records,
                route_overrides=route_overrides,
                package_root=package_root,
            )
        except ReconstructionPlanError:
            raise
        slide["reconstructionPlan"] = page
        # Route overrides are a transient calibration input; the rebuilt page
        # plan is the sole canonical route record consumed by renderer and
        # validators.
        slide.pop("routeOverrides", None)
        pages.append(page)
    report = {
        "version": "1.0.0",
        "kind": "image-reconstruction-plan",
        "pages": pages,
        "lossConfig": {"version": "1.0.0", "estimatedFrom": "analysis"},
        "provenance": {
            "sourceRefs": sorted(str(source["id"]) for source in analysis.get("sources", []) if source.get("id")),
            "planner": "deterministic-region-candidate-selector",
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    analysis["reconstructionPlan"] = report
    analysis["reconstructionPlanRef"] = {
        "path": report_path.relative_to(package_root.resolve()).as_posix(),
        "sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
    }
    analysis_path.write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return analysis


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("analysis", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--package-root", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = rebuild(args.analysis, args.report, args.package_root)
    except Exception as error:
        print(json.dumps({"status": "failed", "code": getattr(error, "code", "E_RECONSTRUCTION_PLAN"), "message": str(error)}))
        raise SystemExit(1) from error
    print(json.dumps({"status": "ok", "plan": result.get("reconstructionPlanRef")}))


if __name__ == "__main__":
    main()
