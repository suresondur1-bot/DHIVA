"""
ATHMA JSON Action Handlers
All JSON-related step actions are handled here.
This file is imported by runner.py with zero modification to existing logic.
"""
import json as _json

# ── All JSON action names handled by this module ──────────────────────────────
JSON_ACTIONS = {
    "json_extract",        # extract single value by dot-path (enhanced)
    "json_multi_extract",  # extract multiple paths in one step
    "json_array_get",      # get array item by index
    "json_array_length",   # count items in array
    "json_array_filter",   # find first item where key=value
    "json_contains",       # assert key/value exists (pass/fail)
    "json_build",          # build JSON object from key-value pairs
    "json_set",            # set a value at a dot-path
    "json_stringify",      # convert variable/object to JSON string
    "json_keys",           # get all keys of an object as comma-separated string
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve(src, resolved_vars):
    """Parse src as JSON. If it's a variable name, look it up first."""
    if not src:
        raise ValueError("No source JSON provided")
    # Look up variable value
    looked_up = resolved_vars.get(src, src)
    # If already a dict/list, return directly
    if isinstance(looked_up, (dict, list)):
        return looked_up
    raw = str(looked_up).strip()
    if not raw:
        raise ValueError(f"Variable '{src}' is empty")
    # Try standard JSON parse first
    try:
        return _json.loads(raw)
    except _json.JSONDecodeError:
        pass
    # Try replacing single quotes with double quotes (Python repr format)
    try:
        import ast
        return ast.literal_eval(raw)
    except Exception:
        pass
    # Try fixing common issues: True/False/None → true/false/null
    fixed = raw.replace("True", "true").replace("False", "false").replace("None", "null")
    try:
        return _json.loads(fixed)
    except _json.JSONDecodeError as e:
        raise ValueError(f"Could not parse JSON from variable '{src}': {e}. Value starts with: {raw[:80]}")


def _get_by_path(obj, path):
    """
    Navigate a JSON object using dot-notation path.
    Supports:
      - dot keys:     patient.mrn
      - array index:  slots.0
      - nested:       paymentDetails.invoiceDocument.invoiceItems.0.item.name
      - negative idx: items.-1  (last item)
    """
    if not path or path.strip() == "":
        return obj
    parts = path.split(".")
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if isinstance(obj, list):
            try:
                obj = obj[int(part)]
            except (ValueError, IndexError) as e:
                raise KeyError(f"Array index '{part}' failed: {e}")
        elif isinstance(obj, dict):
            if part not in obj:
                raise KeyError(f"Key '{part}' not found. Available: {list(obj.keys())}")
            obj = obj[part]
        else:
            raise TypeError(f"Cannot navigate into {type(obj).__name__} with key '{part}'")
    return obj


def _apply_variables(value, resolved_vars):
    """Replace {{var}} placeholders."""
    if not isinstance(value, str):
        return value
    for k, v in resolved_vars.items():
        value = value.replace("{{" + k + "}}", str(v))
    return value


# ── Main dispatcher ───────────────────────────────────────────────────────────

def handle_json_action(action, step, resolved_vars, run_id, idx, apply_variables, log):
    """
    Entry point called from runner.py.
    log and apply_variables are passed in from runner to avoid circular import.
    Returns {"status": "passed"|"failed", "step": idx, ...}
    """
    def av(val):
        return apply_variables(val or "", resolved_vars)

    try:
        if action == "json_extract":
            return _json_extract(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_multi_extract":
            return _json_multi_extract(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_array_get":
            return _json_array_get(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_array_length":
            return _json_array_length(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_array_filter":
            return _json_array_filter(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_contains":
            return _json_contains(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_build":
            return _json_build(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_set":
            return _json_set(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_stringify":
            return _json_stringify(step, resolved_vars, run_id, idx, av, log)

        elif action == "json_keys":
            return _json_keys(step, resolved_vars, run_id, idx, av, log)

        else:
            return {"status": "failed", "step": idx, "error": f"Unknown json action: {action}"}

    except Exception as e:
        import traceback
        msg = f"{action} failed: {e}"
        log(run_id, "fail", f"[FAIL] {msg}", idx)
        return {"status": "failed", "step": idx, "error": msg}


# ── Action implementations ────────────────────────────────────────────────────

def _json_extract(step, resolved_vars, run_id, idx, av, log):
    src_name  = av(step.get("value", "")).strip()
    path      = av(step.get("value2", "")).strip()
    store_as  = av(step.get("store_as", "")).strip()

    log(run_id, "info", f"  [json_extract] source={src_name} | path={path} | store_as={store_as or '(not set)'}", idx)

    obj = _resolve(src_name, resolved_vars)
    result = _get_by_path(obj, path)
    result_str = _json.dumps(result) if isinstance(result, (dict, list)) else str(result)

    log(run_id, "info", f"  [json_extract] extracted value: '{result_str[:100]}'", idx)

    if store_as:
        resolved_vars[store_as] = result_str
        log(run_id, "pass", f"[OK] json_extract PASSED -- {{{{{store_as}}}}} = '{result_str[:80]}'", idx)
    else:
        log(run_id, "warn", f"  [json_extract] \u26a0\ufe0f store_as is empty -- value '{result_str[:80]}' was NOT stored into any variable", idx)
        log(run_id, "fail", f"[FAIL] json_extract: store_as is required to save the extracted value", idx)
        return {"status": "failed", "step": idx, "error": "store_as is empty -- extracted value not stored"}

    return {"status": "passed", "step": idx}


def _json_multi_extract(step, resolved_vars, run_id, idx, av, log):
    """
    Extract multiple paths from one JSON variable in a single step.

    Step fields:
      value    → variable name holding the JSON
      mappings → list of {path, variable} dicts
                 e.g. [{path: "patient.mrn", variable: "mrn"},
                       {path: "consultant.displayName", variable: "doctor"}]
    """
    src_name = av(step.get("value", "")).strip()
    mappings = step.get("mappings", [])

    log(run_id, "info", f"  [json_multi_extract] source={src_name} mappings={len(mappings)}", idx)

    obj = _resolve(src_name, resolved_vars)
    stored = []

    for m in mappings:
        path     = av(m.get("path", "")).strip()
        var_name = av(m.get("variable", "")).strip()
        if not var_name:
            continue
        try:
            result = _get_by_path(obj, path)
            result_str = _json.dumps(result) if isinstance(result, (dict, list)) else str(result)
            resolved_vars[var_name] = result_str
            stored.append(f"{{{{{var_name}}}}} = '{result_str[:40]}'")
            log(run_id, "info", f"  [json_multi_extract] {{{{{var_name}}}}} = '{result_str[:60]}'", idx)
        except Exception as e:
            log(run_id, "warn", f"  [json_multi_extract] ⚠️ path '{path}' failed: {e} -- skipping {{{{{var_name}}}}}", idx)

    log(run_id, "pass", f"[OK] json_multi_extract: stored {len(stored)} variable(s)", idx)
    return {"status": "passed", "step": idx}


def _json_array_get(step, resolved_vars, run_id, idx, av, log):
    """
    Get a specific item from an array by index.

    Step fields:
      value    → variable name holding the JSON
      value2   → dot-path to the array   e.g. activityTimings  or  paymentDetails.invoiceDocument.receipts
      value3   → index (0-based, negative = from end)  e.g. 0 or -1
      store_as → variable to store the result (as JSON string if object)
    """
    src_name = av(step.get("value", "")).strip()
    path     = av(step.get("value2", "")).strip()
    index    = int(av(step.get("value3", "0")).strip() or "0")
    store_as = av(step.get("store_as", "")).strip()

    log(run_id, "info", f"  [json_array_get] source={src_name} path={path} index={index}", idx)

    obj = _resolve(src_name, resolved_vars)
    arr = _get_by_path(obj, path) if path else obj

    if not isinstance(arr, list):
        raise TypeError(f"Expected array at path '{path}', got {type(arr).__name__}")
    if index >= len(arr) or index < -len(arr):
        raise IndexError(f"Index {index} out of range (array has {len(arr)} items)")

    result = arr[index]
    result_str = _json.dumps(result) if isinstance(result, (dict, list)) else str(result)

    if store_as:
        resolved_vars[store_as] = result_str
        log(run_id, "pass", f"[OK] json_array_get[{index}]: {{{{{store_as}}}}} = '{result_str[:80]}'", idx)
    else:
        log(run_id, "pass", f"[OK] json_array_get[{index}]: '{result_str[:80]}'", idx)

    return {"status": "passed", "step": idx}


def _json_array_length(step, resolved_vars, run_id, idx, av, log):
    """
    Get the length of an array and store it as a variable.

    Step fields:
      value    → variable name holding the JSON
      value2   → dot-path to the array  e.g. invoiceItems  or  paymentDetails.invoiceDocument.invoiceItems
      store_as → variable to store the count  e.g. item_count
    """
    src_name = av(step.get("value", "")).strip()
    path     = av(step.get("value2", "")).strip()
    store_as = av(step.get("store_as", "")).strip()

    log(run_id, "info", f"  [json_array_length] source={src_name} path={path}", idx)

    obj = _resolve(src_name, resolved_vars)
    arr = _get_by_path(obj, path) if path else obj

    if not isinstance(arr, list):
        raise TypeError(f"Expected array at path '{path}', got {type(arr).__name__}")

    count = str(len(arr))

    if store_as:
        resolved_vars[store_as] = count
        log(run_id, "pass", f"[OK] json_array_length: {{{{{store_as}}}}} = {count}", idx)
    else:
        log(run_id, "pass", f"[OK] json_array_length: {count} item(s)", idx)

    return {"status": "passed", "step": idx}


def _json_array_filter(step, resolved_vars, run_id, idx, av, log):
    """
    Find the first item in an array where a key equals a value.

    Step fields:
      value     → variable name holding the JSON
      value2    → dot-path to the array  e.g. activityTimings
      value3    → key to match on        e.g. status
      value4    → expected value         e.g. IN_PROGRESS
      store_as  → variable to store the matched item (as JSON string)
      store_index → optional variable to store the matched index
    """
    src_name    = av(step.get("value", "")).strip()
    path        = av(step.get("value2", "")).strip()
    filter_key  = av(step.get("value3", "")).strip()
    filter_val  = av(step.get("value4", "")).strip()
    store_as    = av(step.get("store_as", "")).strip()
    store_index = av(step.get("store_index", "")).strip()

    log(run_id, "info", f"  [json_array_filter] source={src_name} path={path} where {filter_key}={filter_val}", idx)

    obj = _resolve(src_name, resolved_vars)
    arr = _get_by_path(obj, path) if path else obj

    if not isinstance(arr, list):
        raise TypeError(f"Expected array at path '{path}', got {type(arr).__name__}")

    matched = None
    matched_idx = -1
    for i, item in enumerate(arr):
        if isinstance(item, dict):
            item_val = item.get(filter_key)
            if str(item_val) == str(filter_val):
                matched = item
                matched_idx = i
                break

    if matched is None:
        raise ValueError(f"No item found where '{filter_key}' = '{filter_val}' in array of {len(arr)} items")

    result_str = _json.dumps(matched)

    if store_as:
        resolved_vars[store_as] = result_str
        log(run_id, "info", f"  [json_array_filter] matched at index {matched_idx}", idx)
        log(run_id, "pass", f"[OK] json_array_filter: {{{{{store_as}}}}} = '{result_str[:80]}'", idx)
    if store_index:
        resolved_vars[store_index] = str(matched_idx)
        log(run_id, "info", f"  [json_array_filter] {{{{{store_index}}}}} = {matched_idx}", idx)

    return {"status": "passed", "step": idx}


def _json_contains(step, resolved_vars, run_id, idx, av, log):
    """
    Assert that a JSON path exists and optionally equals an expected value.
    Fails the step if assertion doesn't pass.

    Step fields:
      value    → variable name holding the JSON
      value2   → dot-path to check       e.g. consultationStatus
      value3   → expected value (optional, leave blank to just check existence)
    """
    src_name = av(step.get("value", "")).strip()
    path     = av(step.get("value2", "")).strip()
    expected = av(step.get("value3", "")).strip()

    log(run_id, "info", f"  [json_contains] source={src_name} path={path} expected={expected or '(exists)'}", idx)

    obj = _resolve(src_name, resolved_vars)
    result = _get_by_path(obj, path)
    result_str = _json.dumps(result) if isinstance(result, (dict, list)) else str(result)

    if expected:
        if str(result) != expected and result_str != expected:
            raise AssertionError(f"Expected '{expected}' at path '{path}', got '{result_str}'")
        log(run_id, "pass", f"[OK] json_contains: '{path}' = '{result_str}' ✓", idx)
    else:
        log(run_id, "pass", f"[OK] json_contains: path '{path}' exists, value='{result_str[:60]}'", idx)

    return {"status": "passed", "step": idx}


def _json_build(step, resolved_vars, run_id, idx, av, log):
    """
    Build a JSON object from key-value pairs and store it as a variable.

    Step fields:
      store_as → variable to store the built JSON string
      mappings → list of {key, value} dicts
                 e.g. [{key: "mrn", value: "{{patient_mrn}}"},
                       {key: "status", value: "ARRIVED"}]
    """
    store_as = av(step.get("store_as", "")).strip()
    mappings = step.get("mappings", [])

    log(run_id, "info", f"  [json_build] building object with {len(mappings)} key(s)", idx)

    obj = {}
    for m in mappings:
        key = av(m.get("key", "")).strip()
        val = av(m.get("value", ""))
        if not key:
            continue
        # Try to parse value as JSON for nested objects/arrays/numbers/booleans
        try:
            parsed = _json.loads(val)
            obj[key] = parsed
        except Exception:
            obj[key] = val
        log(run_id, "info", f"  [json_build] {key} = {repr(str(val)[:40])}", idx)

    result_str = _json.dumps(obj)

    if store_as:
        resolved_vars[store_as] = result_str
        log(run_id, "pass", f"[OK] json_build: {{{{{store_as}}}}} = '{result_str[:100]}'", idx)
    else:
        log(run_id, "pass", f"[OK] json_build: '{result_str[:100]}'", idx)

    return {"status": "passed", "step": idx}


def _json_set(step, resolved_vars, run_id, idx, av, log):
    """
    Set a value at a dot-path in a JSON object and store the updated JSON.

    Step fields:
      value    → variable name holding the JSON
      value2   → dot-path to set     e.g. patient.status
      value3   → new value           e.g. ARRIVED  or  {{new_status}}
      store_as → variable to store updated JSON (defaults to same as source)
    """
    src_name = av(step.get("value", "")).strip()
    path     = av(step.get("value2", "")).strip()
    new_val  = av(step.get("value3", ""))
    store_as = av(step.get("store_as", "")).strip() or src_name

    log(run_id, "info", f"  [json_set] source={src_name} path={path} value={new_val[:40]}", idx)

    obj = _resolve(src_name, resolved_vars)

    # Try to parse new_val as JSON
    try:
        parsed_val = _json.loads(new_val)
    except Exception:
        parsed_val = new_val

    # Navigate to parent, set key
    parts = path.split(".")
    target = obj
    for part in parts[:-1]:
        part = part.strip()
        if isinstance(target, list):
            target = target[int(part)]
        else:
            target = target[part]

    last_key = parts[-1].strip()
    if isinstance(target, list):
        target[int(last_key)] = parsed_val
    else:
        target[last_key] = parsed_val

    result_str = _json.dumps(obj)
    resolved_vars[store_as] = result_str

    log(run_id, "pass", f"[OK] json_set: set '{path}' = '{str(new_val)[:40]}' → stored in {{{{{store_as}}}}}", idx)
    return {"status": "passed", "step": idx}


def _json_stringify(step, resolved_vars, run_id, idx, av, log):
    """
    Convert a variable to a JSON string (pretty or compact).

    Step fields:
      value    → variable name to stringify
      store_as → variable to store result
      value2   → "pretty" for indented output (optional)
    """
    src_name = av(step.get("value", "")).strip()
    store_as = av(step.get("store_as", "")).strip()
    pretty   = av(step.get("value2", "")).strip().lower() == "pretty"

    raw = resolved_vars.get(src_name, src_name)
    if isinstance(raw, (dict, list)):
        result_str = _json.dumps(raw, indent=2 if pretty else None)
    else:
        try:
            parsed = _json.loads(str(raw))
            result_str = _json.dumps(parsed, indent=2 if pretty else None)
        except Exception:
            result_str = str(raw)

    if store_as:
        resolved_vars[store_as] = result_str
        log(run_id, "pass", f"[OK] json_stringify: {{{{{store_as}}}}} = '{result_str[:80]}'", idx)
    else:
        log(run_id, "pass", f"[OK] json_stringify: '{result_str[:80]}'", idx)

    return {"status": "passed", "step": idx}


def _json_keys(step, resolved_vars, run_id, idx, av, log):
    """
    Get all keys of a JSON object as a comma-separated string.

    Step fields:
      value    → variable name holding the JSON
      value2   → dot-path to the object (optional, blank = root)
      store_as → variable to store comma-separated keys
    """
    src_name = av(step.get("value", "")).strip()
    path     = av(step.get("value2", "")).strip()
    store_as = av(step.get("store_as", "")).strip()

    log(run_id, "info", f"  [json_keys] source={src_name} path={path}", idx)

    obj = _resolve(src_name, resolved_vars)
    target = _get_by_path(obj, path) if path else obj

    if not isinstance(target, dict):
        raise TypeError(f"Expected object at path '{path}', got {type(target).__name__}")

    keys_str = ", ".join(target.keys())

    if store_as:
        resolved_vars[store_as] = keys_str
        log(run_id, "pass", f"[OK] json_keys: {{{{{store_as}}}}} = '{keys_str[:100]}'", idx)
    else:
        log(run_id, "pass", f"[OK] json_keys: '{keys_str[:100]}'", idx)

    return {"status": "passed", "step": idx}
