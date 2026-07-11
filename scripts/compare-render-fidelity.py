#!/usr/bin/env python3

import json
import sys
from pathlib import Path

try:
    from PIL import Image, ImageChops, ImageDraw
except ImportError as error:
    raise SystemExit("Pillow is required for visual fidelity comparison.") from error


DEFAULT_CASE_THRESHOLD = (0.040, 0.015)
CASE_THRESHOLDS = {
    "adversarial-layers": (0.055, 0.020),
    "layout-exotics": (0.048, 0.018),
    "media-dark": (0.045, 0.018),
    "pagination-nonuniform-a": (0.045, 0.018),
    "pagination-nonuniform-c": (0.045, 0.018),
}

DEFAULT_REGION_THRESHOLD = (0.160, 0.050)
REGION_THRESHOLDS = {
    # Structural geometry should remain almost pixel-identical. These bounds
    # still leave room for one-pixel rasterization differences at rounded edges.
    "table": (0.090, 0.030),
    "complex-table": (0.085, 0.028),
    "callout": (0.105, 0.042),
    "blockquote": (0.080, 0.026),
    "position-stage": (0.080, 0.026),
    "page-stress-band": (0.105, 0.042),
    "sticky-scrollport": (0.100, 0.032),
    "clip-card": (0.100, 0.032),
    "alpha-stack": (0.110, 0.036),
    # Text edges vary slightly after SVG foreignObject rasterization. The old
    # catch-all 35% / 8% bounds were too permissive; these are feature-specific
    # while remaining stable across CoreText/font antialiasing revisions.
    "mark": (0.010, 0.005),
    "del": (0.020, 0.006),
    "code": (0.200, 0.060),
    "long-unbroken": (0.160, 0.048),
    "long-url": (0.160, 0.048),
    "negative-tight": (0.180, 0.055),
    "mixed-direction": (0.160, 0.048),
    "vertical-stack": (0.160, 0.048),
    "font-tiny": (0.180, 0.055),
    "font-huge": (0.160, 0.048),
    "whitespace-normal": (0.150, 0.045),
    "whitespace-pre": (0.150, 0.045),
    "whitespace-pre-wrap": (0.150, 0.045),
    "whitespace-break-spaces": (0.150, 0.045),
    "counter-list": (0.150, 0.045),
    "gradient-text": (0.010, 0.005),
    "stroke-text": (0.010, 0.005),
    "ellipsis-text": (0.160, 0.050),
    "line-clamp-text": (0.160, 0.050),
    "emphasis-text": (0.010, 0.005),
    # Transforms, filters, opacity and resampled media legitimately touch more
    # edge pixels, but their color error is held well below the old 8% ceiling.
    "transform-root": (0.180, 0.055),
    "transform-middle": (0.180, 0.055),
    "transform-child": (0.180, 0.055),
    # The full tiny rotated chips include their axis-aligned bounding-box
    # corners, so antialiasing dominates those broad metrics. Their centered
    # fill/position probes are intentionally strict.
    "absolute-chip": (0.260, 0.075),
    "absolute-chip-core": (0.020, 0.008),
    "fixed-chip": (0.260, 0.075),
    "fixed-chip-core": (0.020, 0.008),
    "sticky-chip": (0.180, 0.055),
    "svg": (0.160, 0.050),
    "canvas": (0.160, 0.050),
    "image": (0.160, 0.050),
    "multicol": (0.120, 0.040),
    "vertical-writing": (0.250, 0.079),
    "ruby": (0.180, 0.055),
    "first-letter": (0.010, 0.005),
    "first-letter-probe": (0.010, 0.005),
    "first-letter-before": (0.160, 0.050),
    "first-letter-before-glyph": (0.060, 0.020),
    "first-letter-aria": (0.090, 0.035),
    "first-letter-glyph": (0.010, 0.005),
    "first-line": (0.050, 0.035),
    "live-state": (0.120, 0.040),
    "details": (0.160, 0.050),
    "textarea": (0.160, 0.050),
    "select": (0.160, 0.050),
    "display-contents-child": (0.160, 0.050),
}

# WKWebView captures the live reference at native backing scale while the
# snapshot passes through SVG foreignObject and a PNG. Keep geometry gates and
# Chrome's pixel-identical thresholds unchanged, but allow measured CoreText /
# resampling variance for the small text-paint regions below.
WEBKIT_REGION_THRESHOLDS = {
    "mark": (0.060, 0.025),
    "del": (0.040, 0.025),
    "input": (0.160, 0.070),
    "gradient-text": (0.120, 0.030),
    "stroke-text": (0.120, 0.030),
    "emphasis-text": (0.060, 0.020),
    "absolute-chip": (0.360, 0.120),
    "fixed-chip": (0.360, 0.120),
    "first-letter": (0.100, 0.030),
    "first-letter-probe": (0.100, 0.030),
    "first-letter-glyph": (0.120, 0.040),
}


def crop_rect(image: Image.Image, rect: dict) -> Image.Image:
    left = int(rect["x"])
    top = int(rect["y"])
    width = int(rect["width"])
    height = int(rect["height"])
    return image.crop((left, top, left + width, top + height)).convert("RGB")


def compare_images(reference: Image.Image, snapshot: Image.Image) -> tuple[float, float, Image.Image]:
    if reference.size != snapshot.size:
        raise ValueError(f"size mismatch: {reference.size} != {snapshot.size}")
    difference = ImageChops.difference(reference, snapshot)
    pixels = list(difference.get_flattened_data() if hasattr(difference, "get_flattened_data") else difference.getdata())
    total = max(1, len(pixels))
    mismatched = sum(1 for pixel in pixels if max(pixel) > 32)
    absolute_error = sum(sum(pixel) for pixel in pixels) / (total * 3 * 255)
    return mismatched / total, absolute_error, difference


def exceeded_metrics(mismatch: float, error: float, mismatch_limit: float, error_limit: float) -> str:
    exceeded: list[str] = []
    if mismatch > mismatch_limit:
        exceeded.append(f"{mismatch:.3%} mismatched > {mismatch_limit:.1%}")
    if error > error_limit:
        exceeded.append(f"{error:.4%} normalized error > {error_limit:.1%}")
    return ", ".join(exceeded)


def main() -> int:
    if len(sys.argv) not in (4, 5):
        raise SystemExit("usage: compare-render-fidelity.py SCREENSHOT RESULTS_JSON OUTPUT_DIR [webkit]")
    screenshot_path = Path(sys.argv[1])
    results_path = Path(sys.argv[2])
    output_dir = Path(sys.argv[3])
    profile = sys.argv[4] if len(sys.argv) == 5 else "default"
    if profile not in ("default", "webkit"):
        raise SystemExit(f"unknown visual comparison profile: {profile}")
    screenshot = Image.open(screenshot_path).convert("RGB")
    results = json.loads(results_path.read_text(encoding="utf-8"))
    failures: list[str] = []
    rows: list[Image.Image] = []

    for case in results["cases"]:
        reference = crop_rect(screenshot, case["source"])
        snapshot = crop_rect(screenshot, case["snapshot"])
        mismatch_ratio, normalized_error, difference = compare_images(reference, snapshot)
        print(f"{case['id']}: mismatched={mismatch_ratio:.3%}, normalized-error={normalized_error:.4%}")
        case_mismatch_limit, case_error_limit = CASE_THRESHOLDS.get(case["id"], DEFAULT_CASE_THRESHOLD)
        if mismatch_ratio > case_mismatch_limit or normalized_error > case_error_limit:
            failures.append(
                f"{case['id']} exceeded visual thresholds "
                f"({exceeded_metrics(mismatch_ratio, normalized_error, case_mismatch_limit, case_error_limit)})"
            )

        for region in case.get("regions", []):
            region_reference = crop_rect(screenshot, region["source"])
            region_snapshot = crop_rect(screenshot, region["snapshot"])
            region_mismatch, region_error, _ = compare_images(region_reference, region_snapshot)
            feature = region["id"].split(":", 1)[0]
            region_thresholds = WEBKIT_REGION_THRESHOLDS if profile == "webkit" else {}
            region_mismatch_limit, region_error_limit = region_thresholds.get(
                feature,
                REGION_THRESHOLDS.get(feature, DEFAULT_REGION_THRESHOLD)
            )
            if region_mismatch > region_mismatch_limit or region_error > region_error_limit:
                failures.append(
                    f"{case['id']} / {region['id']} lost local styling "
                    f"({exceeded_metrics(region_mismatch, region_error, region_mismatch_limit, region_error_limit)})"
                )

        visualization = Image.new("RGB", (reference.width * 3, reference.height), "white")
        visualization.paste(reference, (0, 0))
        visualization.paste(snapshot, (reference.width, 0))
        enhanced = difference.point(lambda value: min(255, value * 4))
        visualization.paste(enhanced, (reference.width * 2, 0))
        ImageDraw.Draw(visualization).text((8, 8), case["id"], fill=(255, 0, 0))
        rows.append(visualization)

    width = max(row.width for row in rows)
    height = sum(row.height for row in rows)
    contact_sheet = Image.new("RGB", (width, height), "white")
    top = 0
    for row in rows:
        contact_sheet.paste(row, (0, top))
        top += row.height
    contact_sheet.save(output_dir / "render-fidelity-comparison.png")

    if failures:
        print("Visual fidelity failures:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(f"Visual fidelity verified for {len(results['cases'])} fixture groups.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
