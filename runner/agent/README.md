# ATHMA Visual QA Agent — Parallel Layer

This folder is an **additive, parallel layer** on top of the existing runner.
It does NOT modify `async_runner.py`, `runner_json.py`, `recorder.py`, or any
existing file. If you delete this `agent/` folder, the automation tool behaves
exactly as it does today.

## Core principle

**The AI authors and judges. The runner executes.**

The agent looks at a screen, decides one action at a time like a QA engineer,
and emits steps in the EXACT same JSON step format the runner already runs.
The output of an agent run is a normal step list — replayable later with zero
AI in the loop.

## What it REUSES (nothing changed)

- The 112 existing actions in `async_runner.py` (`click`, `type`,
  `search_select`, `select`, `check`/`uncheck`, `get_table_value`,
  `table_action`, the whole `assert_*` family, `navigate`, `screenshot`, ...).
- The `json_*` actions in `runner_json.py`.
- The step format: a dict `{action, selector, value, value2, value3, value4,
  store_as, mappings, ...}` with `{{variable}}` interpolation.
- The `resolved_vars` variable store — this is the agent's cross-screen MEMORY.
  When the agent registers a patient and stores the MRN, that's just a
  `{{patient_mrn}}` variable the later steps reconcile against.

## What is NEW (lives only here)

- `perception.py`  — turn a live screen into a typed, numbered element digest
                     (textbox / combobox / checkbox / dateinput / table / button).
- `actions.py`     — map an agent decision to a valid runner step dict. This is
                     the contract: every agent action == one existing runner action.
- `llm_client.py`  — Claude vision call: screen + goal -> one action (JSON only).
- `loop.py`        — the perceive -> reason -> act -> verify orchestrator + caps.
- `script_writer.py` — emit a clean runner step list from a completed run.
- `config.py`      — model, caps (max steps / heals), budgets, masking rules.

## Build order (each stage independently testable)

1. perception.py  — correct typed digest of ONE screen (no AI). VERIFY BY EYE.
2. actions.py     — hand-written action dict -> real runner step. Prove contract.
3. llm_client.py  — one screen + goal -> one valid action.
4. loop.py        — close the loop with rule-based verify + caps.
5. script_writer  — emit a replayable step list; replay with zero AI.  <-- v1
6+ redaction / oracle / heal / human-gate (hardening).

## Data policy

Runs use DUMMY patient data on SQA only. Mask the operator/account bar
(top-right of the screen) before sending screenshots to the cloud LLM —
see `config.py: MASK_REGIONS`.

## How it plugs in

The agent imports the runner's action execution and calls it. It never edits
it. New runner capability (if ever needed) = a NEW action in the runner,
never a change to an existing one.
