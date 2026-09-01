# Playbook: Direct_Transfer

URL contains: direct-transfer

_Auto-drafted by Study Screen from the live control map. Review and refine as needed._

# Direct_Transfer — Agent Playbook

One-line: Create a stock direct-transfer (issue) between stores by selecting the receiving store, adding items with batch/quantity, then sending for approval. URL substring: `direct-transfer-new`.

## Order of Operations

This screen has a **store-selection stage** gated by a Continue button, then an **item-entry stage**.

**Stage 1 — Select receiving/issue store**
1. Confirm issue store (e23 `#indentStoreInput`) — pre-filled `BLOOD-BANK`.
2. Pick the target store in the store-selector combobox (e25) or its input (e24).
3. Optionally add a comment (e22).
4. Click **Continue** (e27 `#btnNext`) to advance.

**Stage 2 — Add items**
5. Enter item code/name in e14 `#itemInput` (autocomplete pick).
6. Fill the item-grid row (tbl28): Batch No, Issue UOM, Issue Quantity, Date Of Expiry as required/editable.
7. Repeat for additional items.

**Stage 3 — Submit** (see SUBMIT).

## Control Actions

| Ref | Control | Action |
|-----|---------|--------|
| e23 `#indentStoreInput` | Type Issue Store Name (value `BLOOD-BANK`) | type-to-search autocomplete; verify pre-filled value, only retype if wrong — must explicitly pick a suggestion |
| e24 store-selector input | Select store | type to filter, then pick suggestion |
| e25 store-selector ng-select | Select (combobox) | search_select — type then pick the suggestion |
| e22 `#comments` | Add new comment | type (optional) |
| e27 `#btnNext` "Continue" | stage gate | click after store is chosen |
| e14 `#itemInput` | Enter Item Code/Name | type-to-search autocomplete; pick suggestion — do not assume free text registers |
| tbl28 row cells | Batch No / Issue UOM / Issue Quantity / Date Of Expiry | per-cell: select for UOM dropdown, type for qty, dateinput for expiry |
| e16 "Save Draft" | save | click only when ready |
| e17 "Send for Approval" | submit | click only when valid |
| e15 / e26 "Cancel" | abort | do not click |

## Disabled — Do Not Touch
- **e18** (button) — disabled; auto-enables from upstream state.
- **e20 Creation Date** (`#date`, value `14/06/2026`) — disabled; auto-fills from system date.
- **e21 Approval Date** (`#date`) — disabled; auto-fills after approval workflow.

## Cascades
- **e23 issue store** is the source store; the **e25/e24 store-selector** is the destination — destination options may depend on the chosen issue store.
- **Continue (e27)** gates item entry: the item grid (e14, tbl28) is only meaningful after the store selection is committed.
- **e14 item pick** populates the grid row (tbl28) Current Stock / Cost / Issue UOM — let these auto-fill; only edit Batch No, Issue Quantity, Date Of Expiry as required.
- **e19 "0 Docs"** is an attachments/docs counter, not a form field.

## Submit
- Primary submit: **"Send for Approval"** (e17).
- Intermediate save: **"Save Draft"** (e16).
- Do NOT click either until: a destination store is selected, at least one item is added with valid Issue Quantity/Batch/Expiry, and no validation errors are shown.

## Notes / Gotchas
- e23 and the e20/e21 share selector `#date` and `#indentStoreInput` patterns — disambiguate by the `name` attribute, not selector alone (two `#date` fields exist).
- Both store fields and the item field are **type-to-search autocompletes**: typing text is NOT enough — you must select an offered suggestion or the value won't bind.
- e23 looks done (pre-filled `BLOOD-BANK`); verify it's the intended *issue* store before proceeding.
- If store/item names repeat, disambiguate by code in e14/e25.
- Two Cancel buttons (e15, e26) belong to different sections — neither should be clicked during a fill flow.
