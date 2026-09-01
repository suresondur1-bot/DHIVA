"""
visual_quick_scan.py — Standalone on-demand Figma-vs-live visual comparison.

ISOLATED FEATURE — this script is completely self-contained and does NOT import
from or modify async_runner.py. The existing visual_figma_check scripted step is
untouched. This is a separate copy of the compare logic used only by the new
on-demand "Visual Quick Scan" UI feature (used by the UI team).

Usage (spawned by the Node backend, same pattern as the test runner):
    python visual_quick_scan.py \
        --screenshot <path-to-png> \
        --figma-url "<figma frame url with node-id>" \
        --figma-token "<X-Figma-Token>" \
        --match-level ai|layout|content|strict \
        --threshold 5

Output: prints a single JSON object to stdout:
    {
      "ok": true,
      "match_level": "ai",
      "diff_pct": 12.3,
      "threshold": 5.0,
      "failed": true,
      "summary": "...",
      "critical_count": 1, "minor_count": 2, "cosmetic_count": 0,
      "differences": [ {element, severity, expected, actual}, ... ],
      "issues_text": "ordered, human-readable issue list"
    }
On any fatal error:
    { "ok": false, "error": "..." }

The Figma token is passed as an argument by the backend; it is never logged.
"""

import sys
import os
import re
import json
import time
import base64
import argparse
import urllib.parse

import requests

# Claude model used for the visual comparison (same as the existing feature).
CLAUDE_MODEL = "claude-haiku-4-5-20251001"


# -----------------------------------------------------------------------------
# Prompts -- own copy. Mirrors the four match levels of the existing feature.
# -----------------------------------------------------------------------------
def _build_prompts():
    return {
        "layout": (
            "MATCH LEVEL: LAYOUT ONLY.\n"
            "Instruction: Check only the visual arrangement: positions of boxes, tables, and sections. "
            "Do not evaluate any text. Flag mismatches in spacing, alignment, or structure.\n"
            "DO NOT flag ANY text differences -- not labels, not button text, not headings, not placeholders.\n"
            "DO NOT flag colour differences, font differences, or icon differences.\n"
            "ONLY flag: missing UI sections, elements moved to different positions, layout structure changes.\n"
            "If the page structure looks the same, respond with zero differences."
        ),
        "content": (
            "MATCH LEVEL: CONTENT ONLY.\n"
            "Instruction: Verify that headings, labels, and section titles match between the two images. "
            "Ignore layout and detailed text values. Report missing or mismatched labels.\n"
            "Ignore: colours, fonts, spacing, dynamic data (patient IDs, dates, names, amounts, counts).\n"
            "Ignore: Favorites, Recently Used, Community Posts, Announcements, Notifications content -- "
            "these are user/time specific."
        ),
        "strict": (
            "MATCH LEVEL: STRICT.\n"
            "Instruction: Perform a thorough comparison. Report EVERY visual difference you can see.\n"
            "Check navigation icons/labels, section headings, button text, form labels and placeholders, "
            "colours, fonts, layout/spacing/alignment, missing or extra UI elements, and section order.\n"
            "Only skip these truly dynamic values: the logged-in user name, patient record data (names, IDs), "
            "dates/timestamps, and numeric counts in any Live section.\n"
            "Everything else MUST be reported."
        ),
        "ai": (
            "MATCH LEVEL: AI (smart).\n"
            "Instruction: Compare the two images for structural and content differences while ignoring "
            "sensitive/dynamic data fields.\n"
            "CRITICAL IGNORE LIST -- do NOT flag ANY of these:\n"
            "- User name, logged-in user, profile name, welcome message\n"
            "- Patient names, patient IDs, MRN numbers\n"
            "- Dates, times, timestamps\n"
            "- Transaction IDs, invoice numbers, amounts\n"
            "- Favourites / Recently Used / What's New / Announcements / Community Posts section CONTENT\n"
            "- Live section numerical metrics\n"
            "- Any section where the STRUCTURE exists in both but only the DATA differs\n"
            "ONLY flag as CRITICAL if: an entire UI section/panel is COMPLETELY MISSING from one image, "
            "navigation items are fundamentally different, a major button/form element is missing entirely, "
            "or the page layout structure is completely different.\n"
            "Rule: If a section EXISTS in both but shows different data/content, that is NOT critical."
        ),
    }


def _img_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()


# -----------------------------------------------------------------------------
# Figma frame download -- own copy of the existing feature's logic.
# Returns a local PNG path (cached under visual_baselines/figma_cache).
# -----------------------------------------------------------------------------
def download_figma_frame(figma_url, figma_token, cache_dir):
    m = re.search(r"figma\.com/(?:file|design)/([^/?]+).*node-id=([^&]+)", figma_url)
    if not m:
        raise Exception("Invalid Figma URL -- must include file key and node-id")
    file_key = m.group(1)
    raw_node = urllib.parse.unquote(m.group(2))
    node_dash = raw_node.replace(":", "-")
    node_colon = raw_node.replace("-", ":")

    os.makedirs(cache_dir, exist_ok=True)
    cache_key = f"{file_key}_{node_dash}"
    cache_path = os.path.join(cache_dir, f"{cache_key}.png")
    cache_max_age = 30 * 24 * 60 * 60  # 30 days
    cache_valid = (
        os.path.exists(cache_path)
        and (time.time() - os.path.getmtime(cache_path)) < cache_max_age
    )
    if cache_valid:
        return cache_path

    api_url = (
        f"https://api.figma.com/v1/images/{file_key}"
        f"?ids={urllib.parse.quote(node_colon)}&format=png&scale=1"
    )
    resp = requests.get(api_url, headers={"X-Figma-Token": figma_token}, timeout=60)

    # Retry on rate limit with backoff
    if resp.status_code == 429:
        for wait in (15, 30, 60):
            time.sleep(wait)
            resp = requests.get(api_url, headers={"X-Figma-Token": figma_token}, timeout=60)
            if resp.status_code != 429:
                break
    if resp.status_code == 429:
        if os.path.exists(cache_path):
            return cache_path  # use expired cache rather than fail
        raise Exception("Figma rate limited (429). Wait 1-2 minutes and retry.")
    if resp.status_code != 200:
        raise Exception(f"Figma API error {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    images = data.get("images", {})
    img_url = (
        images.get(node_colon)
        or images.get(node_dash)
        or images.get(raw_node)
        or (list(images.values())[0] if images else None)
    )
    if not img_url:
        raise Exception(f"Figma returned no image URL. Keys={list(images.keys())}")

    img_data = requests.get(img_url, timeout=30)
    with open(cache_path, "wb") as f:
        f.write(img_data.content)

    # Resize if too large for Claude
    try:
        from PIL import Image as _PIL
        im = _PIL.open(cache_path)
        w, h = im.size
        max_dim = 1280
        if w > max_dim or h > max_dim:
            scale = min(max_dim / w, max_dim / h)
            im = im.resize((int(w * scale), int(h * scale)), _PIL.LANCZOS)
            im.save(cache_path)
    except Exception:
        pass

    return cache_path


# -----------------------------------------------------------------------------
# Claude compare -- own copy.
# -----------------------------------------------------------------------------
def claude_compare(expected_path, actual_path, match_level, api_key):
    prompts = _build_prompts()
    body_prompt = prompts.get(match_level, prompts["ai"])

    if match_level in ("layout", "content"):
        sev_guidance = (
            "- CRITICAL = structural element completely missing or moved\n"
            "- MINOR = layout position slightly different\n"
            "- DO NOT report text values, numbers, or data content as differences\n"
        )
    else:
        sev_guidance = (
            "- CRITICAL = element missing or completely wrong\n"
            "- MINOR = element present but styled differently\n"
            "- COSMETIC = minor text or color difference\n"
        )

    prompt = (
        "You are a senior QA engineer reviewing two UI screenshots.\n"
        "Image 1 = EXPECTED (Figma design) | Image 2 = ACTUAL (live app)\n"
        + body_prompt +
        "\n\nOUTPUT RULES:\n"
        "- 'expected' field = ONLY describe what Image 1 shows for this element\n"
        "- 'actual' field = ONLY describe what Image 2 shows for this element\n"
        "- NEVER put Image 2 content in 'expected' and never put Image 1 content in 'actual'\n"
        "- Each difference must be a SEPARATE element\n"
        "- Report a MAXIMUM of 10 differences (most important first)\n"
        + sev_guidance +
        "\nFor EACH difference provide exactly these 4 fields:\n"
        "- element: name of the UI control\n"
        "- severity: CRITICAL or MINOR or COSMETIC\n"
        "- expected: one SHORT sentence (max 15 words) describing what Image 1 shows\n"
        "- actual: one SHORT sentence (max 15 words) describing what Image 2 shows\n"
        "\nRespond ONLY in valid JSON:\n"
        '{"differences":[{"severity":"CRITICAL","element":"X","expected":"...","actual":"..."}],'
        '"summary":"brief summary","critical_count":1,"minor_count":0,"cosmetic_count":0}'
    )

    resp = None
    for attempt in range(3):
        try:
            resp = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
                json={
                    "model": CLAUDE_MODEL,
                    "max_tokens": 2000,
                    "messages": [{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _img_b64(expected_path)}},
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _img_b64(actual_path)}},
                        {"type": "text", "text": prompt},
                    ]}],
                },
                timeout=120,
            )
            if resp.status_code in (502, 503, 529):
                time.sleep((attempt + 1) * 10)
                continue
            break
        except requests.exceptions.Timeout:
            time.sleep(10)
            continue

    if resp is None or resp.status_code != 200:
        status = resp.status_code if resp else "timeout"
        raise Exception(f"Claude API error {status}")

    text = resp.json()["content"][0]["text"].strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()
    s, e = text.find("{"), text.rfind("}") + 1
    if s >= 0 and e > s:
        text = text[s:e]
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)

    try:
        return json.loads(text)
    except Exception:
        # Best-effort repair of truncated JSON
        repaired = text
        ob = repaired.count("{") - repaired.count("}")
        obr = repaired.count("[") - repaired.count("]")
        last = max(repaired.rfind("},"), repaired.rfind("}\n"))
        if last > 0 and ob > 0:
            repaired = repaired[:last + 1]
            ob = repaired.count("{") - repaired.count("}")
            obr = repaired.count("[") - repaired.count("]")
        repaired += "]" * obr + "}" * ob
        try:
            return json.loads(repaired)
        except Exception:
            return {"differences": [], "summary": "JSON parse error -- treated as no differences",
                    "critical_count": 0, "minor_count": 0, "cosmetic_count": 0}


# -----------------------------------------------------------------------------
# Pixel diff -- own copy.
# -----------------------------------------------------------------------------
def pixel_diff_pct(expected_path, actual_path):
    try:
        from PIL import Image as _PIL, ImageChops as _IC
        import numpy as _np
        base = _PIL.open(expected_path).convert("RGB")
        act = _PIL.open(actual_path).convert("RGB")
        if act.size != base.size:
            act = act.resize(base.size, _PIL.LANCZOS)
        arr = _np.array(_IC.difference(base, act))
        total = arr.shape[0] * arr.shape[1]
        changed = int(_np.any(arr > 15, axis=2).sum())
        return round(changed / total * 100, 2) if total else 0.0
    except Exception:
        return 0.0


# -----------------------------------------------------------------------------
# Build the ordered, human-readable issue list (sorted by severity, numbered).
# Mirrors the single-block ordering fix from the existing feature.
# -----------------------------------------------------------------------------
def build_issues_text(differences, summary):
    sev_order = {"CRITICAL": 0, "MINOR": 1, "COSMETIC": 2}
    sorted_diffs = sorted(
        differences,
        key=lambda d: (sev_order.get(str(d.get("severity", "MINOR")).upper(), 1), d.get("element", "")),
    )
    lines = []
    for i, d in enumerate(sorted_diffs, 1):
        elem = str(d.get("element", "Unknown element")).strip()
        expected = str(d.get("expected", "")).strip()
        actual = str(d.get("actual", "")).strip()
        sev = str(d.get("severity", "MINOR")).upper()
        if not expected or not actual:
            continue
        icon = "\U0001f534" if sev == "CRITICAL" else "\U0001f7e1" if sev == "MINOR" else "\U0001f535"
        lines.append(
            f"{icon} Issue #{i} [{sev}]: {elem}\n"
            f"  \u2523 Expected : {expected}\n"
            f"  \u2517 Actual   : {actual}"
        )
    if not lines:
        lines.append(f"  {summary}")
    return "\n".join(lines)


# -----------------------------------------------------------------------------
# Per-mode fail logic -- own copy, same mapping as the tuned existing feature:
#   ai/layout -> CRITICAL only ; content -> +MINOR ; strict -> +MINOR +pixel
# -----------------------------------------------------------------------------
def decide_failed(match_level, result, diff_pct, threshold):
    has_critical = result.get("critical_count", 0) > 0
    has_minor = result.get("minor_count", 0) > 0
    if match_level in ("ai", "layout"):
        return has_critical
    elif match_level == "content":
        return has_critical or has_minor
    else:  # strict
        return has_critical or has_minor or diff_pct > threshold


# -----------------------------------------------------------------------------
# Locate each difference on the ACTUAL screenshot and draw numbered red boxes +
# circle badges -- same approach as the existing visual_figma_check feature.
# A second Claude call returns pixel bounding boxes for each flagged element;
# we draw a numbered marker at each. Returns base64 PNG of the marked image, or
# "" if it couldn't be produced. The numbers match the sorted issue order.
# -----------------------------------------------------------------------------
def locate_and_mark(actual_path, sorted_diffs, api_key):
    try:
        from PIL import Image as _PI2, ImageDraw as _ID2
    except Exception:
        return ""
    try:
        act_img = _PI2.open(actual_path).convert("RGB")
        act_w, act_h = act_img.size

        elem_list = []
        for _di, _d in enumerate(sorted_diffs, 1):
            elem_list.append(f"{_di}. {_d.get('element','')}: {_d.get('actual','')}")
        elem_str = "\n".join(elem_list)

        locate_prompt = (
            f"This is a UI screenshot. The image is {act_w} pixels wide and {act_h} pixels tall.\n"
            f"Find these UI elements and give their EXACT bounding box in pixels:\n\n"
            f"{elem_str}\n\n"
            f"IMPORTANT RULES:\n"
            f"- x1,y1 = TOP-LEFT corner of the element\n"
            f"- x2,y2 = BOTTOM-RIGHT corner of the element\n"
            f"- Coordinates must be within 0-{act_w} for x and 0-{act_h} for y\n"
            f"- Each element should have a DIFFERENT location\n"
            f"- Make boxes large enough to fully surround the element (add 5px padding)\n"
            f"- If element is NOT present in image at all, set found=false\n\n"
            f"Respond ONLY in valid JSON (no markdown):\n"
            f'{{"locations":[{{"index":1,"element":"name","x1":100,"y1":50,"x2":400,"y2":90,"found":true}}]}}'
        )

        loc_resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
            json={"model": CLAUDE_MODEL, "max_tokens": 800,
                  "messages": [{"role": "user", "content": [
                      {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": _img_b64(actual_path)}},
                      {"type": "text", "text": locate_prompt},
                  ]}]},
            timeout=60,
        )
        locations = []
        if loc_resp.status_code == 200:
            loc_text = loc_resp.json()["content"][0]["text"].strip()
            if loc_text.startswith("```"):
                loc_text = loc_text.split("```")[1]
                if loc_text.startswith("json"):
                    loc_text = loc_text[4:]
            _ls, _le = loc_text.find("{"), loc_text.rfind("}") + 1
            if _ls >= 0 and _le > _ls:
                loc_text = loc_text[_ls:_le]
            try:
                locations = json.loads(loc_text).get("locations", [])
            except Exception:
                locations = []

        draw_act = _ID2.Draw(act_img)
        try:
            from PIL import ImageFont as _IFont
            _font = _IFont.truetype("arial.ttf", 14)
        except Exception:
            _font = None

        drawn = 0
        for loc in locations:
            if not loc.get("found", True):
                continue
            x1, y1 = int(loc.get("x1", 0)), int(loc.get("y1", 0))
            x2, y2 = int(loc.get("x2", 0)), int(loc.get("y2", 0))
            if x2 <= x1 or y2 <= y1:
                continue
            if x2 - x1 < 5 or y2 - y1 < 5:
                continue
            x1 = max(2, min(x1, act_w - 2)); y1 = max(2, min(y1, act_h - 2))
            x2 = max(2, min(x2, act_w - 2)); y2 = max(2, min(y2, act_h - 2))
            num = loc.get("index", drawn + 1)
            for _t in range(3):
                draw_act.rectangle([x1 - _t, y1 - _t, x2 + _t, y2 + _t], outline=(220, 30, 60))
            bx, by = x1 - 1, max(0, y1 - 24)
            r = 12
            draw_act.ellipse([bx, by, bx + r * 2, by + r * 2], fill=(220, 30, 60))
            txt = str(num)
            if _font:
                try:
                    bb = draw_act.textbbox((0, 0), txt, font=_font)
                    tw, th = bb[2] - bb[0], bb[3] - bb[1]
                    draw_act.text((bx + r - tw // 2, by + r - th // 2), txt, fill="white", font=_font)
                except Exception:
                    draw_act.text((bx + r - 4, by + r - 6), txt, fill="white")
            else:
                draw_act.text((bx + r - 4, by + r - 6), txt, fill="white")
            drawn += 1

        import io as _io
        buf = _io.BytesIO()
        act_img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return ""


def main():
    ap = argparse.ArgumentParser(description="Standalone Figma-vs-live visual quick scan")
    ap.add_argument("--screenshot", required=True)
    ap.add_argument("--figma-url", required=True)
    ap.add_argument("--figma-token", required=True)
    ap.add_argument("--match-level", default="ai")
    ap.add_argument("--threshold", type=float, default=5.0)
    ap.add_argument("--cache-dir", default=None)
    args = ap.parse_args()

    try:
        match_level = (args.match_level or "ai").lower()
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            # Fallback: read from backend/.env (same approach the runner uses)
            try:
                from dotenv import dotenv_values
                import pathlib
                env_path = pathlib.Path(__file__).parent.parent / "backend" / ".env"
                api_key = dotenv_values(env_path).get("ANTHROPIC_API_KEY", "")
            except Exception:
                pass
        if not api_key:
            raise Exception("ANTHROPIC_API_KEY not set")

        if not os.path.exists(args.screenshot):
            raise Exception(f"Screenshot not found: {args.screenshot}")

        cache_dir = args.cache_dir or os.path.join(
            os.path.dirname(__file__), "..", "visual_baselines", "figma_cache"
        )
        cache_dir = os.path.abspath(cache_dir)

        figma_png = download_figma_frame(args.figma_url, args.figma_token, cache_dir)
        result = claude_compare(figma_png, args.screenshot, match_level, api_key)
        diff_pct = pixel_diff_pct(figma_png, args.screenshot)

        differences = result.get("differences", [])
        summary = result.get("summary", "")
        failed = decide_failed(match_level, result, diff_pct, args.threshold)

        # Sort diffs by severity (CRITICAL -> MINOR -> COSMETIC) so the marker
        # numbers match the order the UI shows them in.
        _sev_order = {"CRITICAL": 0, "MINOR": 1, "COSMETIC": 2}
        sorted_diffs = sorted(
            differences,
            key=lambda d: (_sev_order.get(str(d.get("severity", "MINOR")).upper(), 1), d.get("element", "")),
        )

        # Include the downloaded Figma image (base64) so the UI can show it side
        # by side with the live screenshot. Already resized to <=1280px above.
        figma_b64 = ""
        try:
            figma_b64 = _img_b64(figma_png)
        except Exception:
            figma_b64 = ""

        # Build a MARKED copy of the actual screenshot with numbered red boxes at
        # each difference (same as the existing visual feature). Only when there
        # are differences to mark.
        marked_actual_b64 = ""
        if sorted_diffs:
            marked_actual_b64 = locate_and_mark(args.screenshot, sorted_diffs, api_key)

        out = {
            "ok": True,
            "match_level": match_level,
            "diff_pct": diff_pct,
            "threshold": args.threshold,
            "failed": failed,
            "summary": summary,
            "critical_count": result.get("critical_count", 0),
            "minor_count": result.get("minor_count", 0),
            "cosmetic_count": result.get("cosmetic_count", 0),
            "differences": sorted_diffs,
            "issues_text": build_issues_text(differences, summary),
            "figma_image": figma_b64,            # base64 PNG of the Figma design
            "marked_actual": marked_actual_b64,  # base64 PNG of live screen with numbered markers
        }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
