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


def canonical_sha256(value) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return f"sha256:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


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

    exploration_paths = {
        "creativeCandidates": "creative-candidates.json",
        "creativeSelection": "creative-selection.json",
        "blindPacket": "creative-direction-blind/blind-packet.json",
    }
    marker_state = {
        key: lexical_marker_exists(relative)
        for key, relative in exploration_paths.items()
    }
    if any(marker_state.values()):
        if not all(marker_state.values()):
            fail("creative direction evidence requires candidates, selection, and blind packet together")
        loaded = {}
        for key, relative in exploration_paths.items():
            if artifacts.get(key) != relative:
                fail(f"creative run artifact pointer {key} must equal {relative}")
            target = require_regular_relative(output_dir, relative, f"run.artifacts.{key}")
            try:
                loaded[key] = json.loads(target.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                fail(f"invalid creative direction artifact {relative}: {error}")
        candidates = loaded["creativeCandidates"]
        selection = loaded["creativeSelection"]
        packet = loaded["blindPacket"]
        unsigned_candidates = dict(candidates)
        declared_candidate_hash = unsigned_candidates.pop("candidateSetHash", None)
        if declared_candidate_hash != canonical_sha256(unsigned_candidates):
            fail("creative candidate set hash mismatch")
        unsigned_packet = dict(packet)
        declared_packet_hash = unsigned_packet.pop("packetHash", None)
        if declared_packet_hash != canonical_sha256(unsigned_packet):
            fail("creative blind packet hash mismatch")
        if selection.get("candidateSetHash") != declared_candidate_hash:
            fail("creative selection candidateSetHash is stale")
        if selection.get("packetHash") != declared_packet_hash:
            fail("creative selection packetHash is stale")
        exploration_id = packet.get("explorationId")
        if candidates.get("explorationId") != exploration_id:
            fail("creative candidate set explorationId is stale")
        if selection.get("explorationId") != exploration_id:
            fail("creative selection explorationId is stale")
        if candidates.get("blindPacketHash") != declared_packet_hash:
            fail("creative candidate set blindPacketHash is stale")
        if candidates.get("probeSlideIds") != packet.get("probeSlideIds"):
            fail("creative candidate probe slide IDs are stale")
        packet_candidates = packet.get("candidates")
        if not isinstance(packet_candidates, list) or len(packet_candidates) < 2:
            fail("creative blind packet candidates are missing")
        screenshot_evidence = {}
        for blind_entry in packet_candidates:
            if not isinstance(blind_entry, dict) or not isinstance(blind_entry.get("blindId"), str):
                fail("creative blind packet contains an invalid blind candidate")
            blind_id = blind_entry["blindId"]
            if blind_id in screenshot_evidence:
                fail("creative blind packet contains duplicate blind IDs")
            screenshots = blind_entry.get("screenshots")
            if not isinstance(screenshots, list) or not screenshots:
                fail(f"creative blind candidate {blind_id} has no screenshots")
            paths = []
            hashes = []
            for screenshot in screenshots:
                if not isinstance(screenshot, dict):
                    fail(f"creative blind candidate {blind_id} has an invalid screenshot")
                relative = screenshot.get("path")
                if not isinstance(relative, str) or not relative.startswith(f"creative-direction-blind/{blind_id}/") or not relative.endswith(".png"):
                    fail(f"creative blind screenshot path is outside its anonymous candidate directory: {blind_id}")
                target = require_regular_relative(output_dir, relative, f"blind screenshot {blind_id}")
                actual_hash = f"sha256:{hashlib.sha256(target.read_bytes()).hexdigest()}"
                if actual_hash != screenshot.get("hash"):
                    fail(f"creative blind screenshot hash mismatch: {blind_id}")
                paths.append(relative)
                hashes.append(actual_hash)
            screenshot_evidence[blind_id] = {"paths": paths, "hashes": hashes}
        packet_blind_ids = packet.get("blindIds")
        if (
            not isinstance(packet_blind_ids, list)
            or packet_blind_ids != list(screenshot_evidence.keys())
            or len(set(packet_blind_ids)) != len(packet_blind_ids)
        ):
            fail("creative blind packet ID order is inconsistent")
        expected_pairs = [
            [packet_blind_ids[left], packet_blind_ids[right]]
            for left in range(len(packet_blind_ids))
            for right in range(left + 1, len(packet_blind_ids))
        ]
        if packet.get("requiredPairs") != expected_pairs:
            fail("creative blind packet required pairs are incomplete")
        selected_id = selection.get("selectedCandidateId")
        candidate_entries = candidates.get("candidates", [])
        if not isinstance(candidate_entries, list) or not 2 <= len(candidate_entries) <= 4:
            fail("creative candidate set must contain two to four candidates")
        if any(not isinstance(entry, dict) or not isinstance(entry.get("id"), str) for entry in candidate_entries):
            fail("creative candidate set contains an invalid candidate")
        candidate_ids = {entry["id"] for entry in candidate_entries}
        if len(candidate_ids) != len(candidate_entries) or len(candidate_ids) != len(packet_blind_ids):
            fail("creative candidate IDs are incomplete or duplicated")
        if selected_id not in candidate_ids:
            fail("creative selection winner is not present in the candidate set")
        selected_blind = selection.get("selectedBlindId")
        if not isinstance(selection.get("reveal"), dict) or selection["reveal"].get(selected_blind) != selected_id:
            fail("creative selection reveal mapping does not match the winner")
        if set(selection["reveal"].keys()) != set(screenshot_evidence.keys()):
            fail("creative selection reveal mapping does not cover every blind candidate")
        if set(selection["reveal"].values()) != candidate_ids:
            fail("creative selection reveal mapping does not cover every private candidate")
        candidate_by_id = {entry.get("id"): entry for entry in candidate_entries if isinstance(entry, dict)}
        for blind_id, candidate_id in selection["reveal"].items():
            candidate = candidate_by_id.get(candidate_id)
            candidate_artifacts = candidate.get("artifacts") if isinstance(candidate, dict) else None
            if not isinstance(candidate_artifacts, dict):
                fail(f"creative candidate {candidate_id} is missing artifact evidence")
            if candidate_artifacts.get("blindScreenshots") != screenshot_evidence[blind_id]["paths"]:
                fail(f"creative candidate {candidate_id} blind screenshot paths are stale")
            if candidate_artifacts.get("screenshotHashes") != screenshot_evidence[blind_id]["hashes"]:
                fail(f"creative candidate {candidate_id} blind screenshot hashes are stale")
        host_review = selection.get("hostReview")
        pairwise = selection.get("pairwise")
        if not isinstance(host_review, dict) or host_review.get("available") is not True:
            fail("creative Host visual review is unavailable")
        if host_review.get("explorationId") != exploration_id or host_review.get("packetHash") != declared_packet_hash:
            fail("creative Host visual review is stale")
        if not isinstance(pairwise, list) or pairwise != host_review.get("pairs"):
            fail("creative selection pairwise evidence is inconsistent")
        required_pair_keys = {tuple(sorted(pair)) for pair in expected_pairs}
        seen_pair_keys = set()
        wins = {blind_id: 0 for blind_id in packet_blind_ids}
        for pair in pairwise:
            if not isinstance(pair, dict):
                fail("creative Host review contains an invalid pair")
            left = pair.get("left")
            right = pair.get("right")
            if left not in wins or right not in wins or left == right:
                fail("creative Host review pair references invalid blind IDs")
            pair_key = tuple(sorted([left, right]))
            if pair_key not in required_pair_keys or pair_key in seen_pair_keys:
                fail("creative Host review pairs are missing or duplicated")
            seen_pair_keys.add(pair_key)
            if pair.get("leftScreenshotHash") != screenshot_evidence[left]["hashes"][0]:
                fail("creative Host review left screenshot hash is stale")
            if pair.get("rightScreenshotHash") != screenshot_evidence[right]["hashes"][0]:
                fail("creative Host review right screenshot hash is stale")
            preference = pair.get("preference")
            if preference not in {"left", "right", "tie"}:
                fail("creative Host review preference is invalid")
            if not isinstance(pair.get("reason"), str) or not pair["reason"].strip():
                fail("creative Host review pair requires an evidence reason")
            if preference == "left":
                wins[left] += 1
            elif preference == "right":
                wins[right] += 1
        if seen_pair_keys != required_pair_keys:
            fail("creative Host review is missing a required pair")
        highest = max(wins.values())
        leaders = [blind_id for blind_id, count in wins.items() if count == highest]
        if len(leaders) == 1:
            expected_selected_blind = leaders[0]
        else:
            adjudication = host_review.get("adjudication")
            if (
                not isinstance(adjudication, dict)
                or adjudication.get("blindId") not in leaders
                or not isinstance(adjudication.get("reason"), str)
                or not adjudication["reason"].strip()
            ):
                fail("creative Host review tie or cycle requires adjudication")
            expected_selected_blind = adjudication["blindId"]
        if selected_blind != expected_selected_blind:
            fail("creative selection winner does not match Host pairwise review")
        if selection.get("acceptance") != {"status": "selected", "primaryBasis": "host-blind-pairwise"}:
            fail("creative selection acceptance basis is invalid")
        metadata = run.get("metadata")
        if not isinstance(metadata, dict):
            fail("creative direction run metadata is missing")
        if metadata.get("explorationId") != packet.get("explorationId"):
            fail("creative run explorationId is stale")
        if metadata.get("blindPacketHash") != declared_packet_hash:
            fail("creative run blindPacketHash is stale")
        if metadata.get("selectedCandidateId") != selected_id:
            fail("creative run selectedCandidateId is stale")
    else:
        for key in exploration_paths:
            if artifacts.get(key) is not None:
                fail(f"creative run artifact pointer {key} must be null without direction evidence")


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
