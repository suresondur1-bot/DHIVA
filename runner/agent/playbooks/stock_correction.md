# Playbook: Correction_document

URL contains: stock-correction

_Auto-drafted by Study Screen from the live control map. Review and refine as needed._

# Stock Corrections — Correction_document Playbook

## 1. Overview
Create a new stock correction document. URL substring: `stock-correction-new`

## 2. Order of Operations
This screen has a **two-stage** flow. A "Select Store" MODAL appears FIRST,
before the correction document body is usable.

**Stage A — Store selection (this is a MODAL — handle it before anything else):**
1. Set Store — author this as THREE explicit steps, NOT search_select:
   a. **type** the store CODE into `#storeInput` (e19) — e.g. `157-IP1` from the
      goal (use the CODE, not the name, so the list narrows to one row).
   b. **press** key `ArrowDown` on `#storeInput`.
   c. **press** key `Enter` on `#storeInput`.
   This selects the highlighted suggestion via the keyboard. Do NOT use
   search_select here: this field lives in a TRANSIENT ngb-modal-window whose
   typeahead dropdown renders outside the modal, so a mouse-click pick lands
   outside the modal boundary and the dropdown closes WITHOUT selecting. The
   keyboard ArrowDown+Enter picks the already-highlighted row with no click and
   no blur race. After Enter, the field shows the store — that field is DONE.
2. Click **Continue** (`#continueButton`, e21) ONCE to dismiss the modal and
   enter the correction document. Do not click Continue more than once.

IMPORTANT: If you have already set the store and the store field shows a value,
do NOT repeat the store search. Move on to Continue, then to the item. Repeating
the same store selection is a failure mode — never select the same field twice.

**Stage B — Correction document:**
3. Confirm Correction Date (`#date`, e17) — auto-filled, do not touch.
4. Add the item via Item search (`#itemInput`, e13).
5. Edit correction values in the items table (`tbl22`).
6. Add a comment (`#comments`, e18) if required.
7. Submit (Save or Send for Approval).

## 3. Control Actions
| Control | Ref | Type | Action |
|---|---|---|---|
| Type Store name | e19 | textbox (autocomplete) | type store name, then pick the suggestion (e.g. `BLOOD-BANK`) |
| Continue | e21 | button | click after store chosen |
| Correction Date | e17 | dateinput (disabled) | do not touch — value `14/06/2026` |
| Enter Item Code/Item Name / Scan Bar code | e13 | textbox (autocomplete) | type item code or name, then pick the matching suggestion |
| Add new Comment | e18 | textbox | type free-text comment |
| Items table | tbl22 | table | edit Batch/MRP/Expiry/Correction Qty cells per row |
| Cancel | e14 / e20 | button | click to abort (do not use in normal flow) |
| Save | e15 | button | click to save (see Submit) |
| Send for Approval | e16 | button | click to submit for approval (see Submit) |

## 4. Disabled Controls
- **Correction Date (e17)** — disabled. Do not touch — auto-fills from system/server date.

## 5. Cascades
- **Store (e19) → Continue (e21)**: store must be selected before the document body becomes usable; Continue gates Stage B.
- **Item search (e13)** populates a new row in `tbl22` with `Batch No Old`, `MRP Old`, `Expiry Date Old`, `Batch Qty` — these auto-fill from the chosen item/batch. Only the `Current` and `Correction Qty` columns are meant to be edited.

## 6. Submit
- Primary submit buttons (by visible text): **Save** (e15) and **Send for Approval** (e16).
- Do **not** click either until: a store is selected, at least one item row exists, correction quantities are filled, and there are no validation errors.
- Use **Save** to persist a draft; **Send for Approval** to route for sign-off.

## 7. Notes / Gotchas
- **Store (e19)** is in a TRANSIENT modal — author it as type + press ArrowDown +
  press Enter (keyboard pick), NOT search_select (see Stage A). **Item (e13)** is
  a normal type-to-search autocomplete in the document body AFTER Continue — for
  it, use **search_select** (it types AND picks), same as the indent screen.
- DISAMBIGUATE BY CODE: when the goal gives a store code (e.g. `157-IP1` for
  IP-Pharmacy-Raipur) or an item code (e.g. `KI-RA-N-0901-PH`), search by the
  CODE, not the name — it narrows to one suggestion. After one suggestion
  appears, that is the right one: pick it and move on.
- NEVER re-select a field that already shows a value. If the store is set, go to
  Continue. If the item is set, go to the batch/MRP/quantity cells. Selecting the
  same field repeatedly is the main failure to avoid on this screen.
- After **Continue**, enter the item with search_select on `#itemInput` (e13),
  pick the item, then fill the row's editable cells: Batch No Current, MRP
  Current, Expiry Date Current, and **Correction Qty**. The `Old` columns and
  Batch Qty auto-fill from the item/batch — do not edit them.
- Store may already be pre-filled (`BLOOD-BANK`); if the goal names a DIFFERENT
  store, clear/replace it via search_select, then verify before Continue.
- Two **Cancel** buttons exist (e14 store-stage, e20 select-stage) — avoid both unless aborting.
- The `Old` table columns are read-only context; treat them as auto-filled. Edit only `Current` and `Correction Qty`.
