# Playbook: CPOE Order

URL contains: cpoe

_Auto-drafted by Study Screen from the live control map. Review and refine as needed._

# CPOE Order — Agent Playbook

One-line: Create a new clinical order (CPOE) for a selected patient, choosing consultant/tariff then adding services/packages before ordering.
URL substring: `cpoe-new`

## Order of Operations

**Stage 0 — Patient context**
1. Search & select the patient in `#patientInput` (e12).
2. Click **New Order** (e15) to open the order form.

**Stage 1 — Order header**
3. Consultant combobox (e20).
4. Tariff Class select (e22).
5. Order Date dateinput (e23) — usually pre-filled; leave unless a change is required.

**Stage 2 — Order line items**
6. Add service/package via `#itemInput` (e25) once it becomes enabled, then fill row fields in `tbl32`.

**Stage 3 — Submit**
7. Click **Order** (e29).

## Control Actions

- **e12 `#patientInput`** (textbox) — `type` the MRN/Name/Phone; treat as type-to-search autocomplete — wait for and **explicitly pick** the patient suggestion.
- **e15 New Order** (button) — `click` to open the form.
- **e20 Consultant** (combobox, ng-select) — `search_select`: type to filter, pick the suggestion. (e21 is its adjacent button — leave unless a picker must be opened.)
- **e22 Tariff Class** (select) — `select` the correct option; current `value="0"` is likely a placeholder, so an explicit choice is required.
- **e23 Order Date** (dateinput) — `type` in format `MM/DD/YYYY hh:mm AM/PM` (e.g. `02/07/2026 05:15 PM`) only if a change is needed; e24 is the calendar-picker button.
- **e25 `#itemInput` Service/Package Name** (textbox, **DISABLED**) — do not touch until enabled; it auto-enables after prerequisite header fields (Consultant/Tariff) are set. When enabled, `type` and explicitly pick a suggestion.
- **e18 SERVICES / e19 PHARMACY / e30 Favourites / e31 My Order Set** (links) — `click` to switch item-source tabs if needed.
- **e26 Cancel** (button) — `click` only to abandon.

## Disabled Controls (do not touch)

- **e25 Service/Package Name** — do not touch; auto-enables from Consultant/Tariff selection.
- **e27 Save Draft** — do not touch; auto-enables once valid order data exists.
- **e28 Save Order Set** — do not touch; auto-enables once valid order data exists.

## Cascades

- Selecting **Consultant** (e20) and/or **Tariff Class** (e22) is the prerequisite that enables **Service/Package Name** (e25) and the **Save Draft/Save Order Set** buttons — fill the header first.
- Tariff Class likely influences the **Tariff** column in the order table (tbl32) once items are added.
- Switching tabs (e18/e19/e30/e31) changes which items `#itemInput` searches against.

## Submit

- Primary submit is **Order** (e29) — click only after patient, Consultant, Tariff Class are set, at least one order line exists in tbl32, and there are no validation errors.
- **Save Draft** (e27) and **Save Order Set** (e28) are alternate saves; do not use unless the task explicitly asks to draft or save an order set.

## Notes / Gotchas

- Patient search (e12), Consultant (e20), and Service/Package (e25) are all type-to-pick — never treat typed text as selected; wait for and click a suggestion.
- Do not attempt Service/Package entry before the header fields enable it; a disabled `#itemInput` means header is incomplete.
- Tariff Class `value="0"` should not be treated as "chosen" — pick a real class.
- Order Date is prefilled; only overwrite if the task requires a specific date/time, matching the `MM/DD/YYYY hh:mm AM/PM` format exactly.
- If Consultant names repeat, disambiguate by code/department shown in the suggestion.
