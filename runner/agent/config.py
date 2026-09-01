"""
ATHMA Visual QA Agent — config.

Central knobs for the agent layer. Nothing here affects the existing runner.
"""

# ── LLM ────────────────────────────────────────────────────────────────────────
# The reasoning/vision model. Vision-capable Claude model string.
MODEL = "claude-opus-4-8"
# Keep per-step output small; we want ONE action, not an essay.
MAX_TOKENS = 1024

# ── Loop safety caps (stop runaway agents) ─────────────────────────────────────
MAX_STEPS_PER_RUN = 90     # hard ceiling on actions in a single explore run
MAX_HEALS_PER_STEP = 2     # retries when a step's verify fails before giving up
NO_PROGRESS_LIMIT = 5      # consecutive no-screen-change steps -> stop.
WALL_CLOCK_SECONDS = 420   # raised 240->420 for long multi-stage forms like SPR
                           # (Stage A prereqs + grid fill + date/budget + save)

# ── Perception ──────────────────────────────────────────────────────────────────
SCREENSHOT_MAX_WIDTH = 1024   # downscale before sending to control token cost
# Only these accessibility roles are considered "interactable" and included in
# the digest the model reasons over.
INTERACTABLE_ROLES = {
    "textbox", "combobox", "checkbox", "radio", "button",
    "link", "menuitem", "option", "switch", "searchbox", "spinbutton",
}

# ── Data policy (dummy data on SQA only) ────────────────────────────────────────
# Pixel regions [x, y, w, h] of the screenshot to blank out before sending to
# the LLM. Default masks the top-right operator/account bar on the HMS.
# Tune these to the actual app resolution used by the runner.
MASK_REGIONS = [
    # [1400, 110, 520, 60],   # operator/account bar — enable + tune for your res
]

# Environments the agent is allowed to drive. Guards against pointing at prod.
ALLOWED_HOST_SUBSTRINGS = ["sqa.narayanahealth.org", "localhost", "127.0.0.1"]

# Actions the agent must NEVER take autonomously — it proposes, a human confirms.
# (Names match the runner's action vocabulary.)
HUMAN_GATE_ACTIONS = {"download", "upload_attachment"}
# Selectors/text that mark a destructive control needing confirmation.
HUMAN_GATE_TEXT = {"delete", "cancel appointment", "discharge", "submit payment"}
