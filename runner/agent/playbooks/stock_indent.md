# Playbook: Stock Indent (New Indent)

URL contains: stock-indent

This screen creates a stock indent in TWO stages on the same page. The fields are
type-to-search autocomplete textboxes (type a few letters, a suggestion list
appears, pick the match) — NOT plain text fields. Use the "search_select" action
on them; it types and picks the matching suggestion.

ORDER OF OPERATIONS:

STAGE 1 — Store selection (a store-selector panel is shown first):
  1. Indent Store: search_select on #indentStoreInput, value = the requesting /
     indent store name from the goal. Type and pick the matching suggestion.
  2. Unit (#unitInput) usually AUTO-FILLS from the store — do NOT fill it unless
     it is empty and the goal names a unit.
  3. Issue Store: search_select on #issueStoreInput, value = the issue store from
     the goal. Type and pick the suggestion.
  4. Click the "Next" button (#btnNext) to advance to the item stage.
  Do NOT try to fill item or quantity until after Next — those fields are not
  active in stage 1.

STAGE 2 — Item + quantity (shown after Next):
  5. Item: search_select on #itemInput, value = the item code/name from the goal
     (e.g. an ITEM_CLASS code or item name). Type and pick the matching suggestion.
  6. UOM (#uomDropDownmodule) is DISABLED and auto-fills from the item — do NOT
     touch it.
  7. Quantity: type the required quantity into #lImQty (e.g. "20" or "02").
  8. If multiple items are requested, repeat 5–7 for each (re-using #itemInput and
     the quantity field for each new row as the UI provides it).

SUBMIT:
  - "Save" (button text "Save") saves the indent as a draft/new document.
  - "Send for Approval" submits it into the approval workflow.
  Choose based on the goal: if it says save -> Save; if it says submit/approval ->
  Send for Approval. Do not click either until at least the stores (stage 1) and
  one item + quantity (stage 2) are filled and there are no validation errors.

NOTES:
  - These #...Input fields require an explicit pick from the suggestion list; just
    typing and tabbing away may NOT register the value. Always pick the suggestion.
  - DISAMBIGUATION: some stores/items share a NAME (e.g. two "Main Store Raipur",
    one of which is "Consignment Main Store Raipur"). If the goal provides a CODE
    for a store or item, search by the CODE, not the name — the code narrows the
    list to a single suggestion. After the list shows ONE suggestion, that is the
    right one; pick it and move on. Do NOT keep re-selecting or second-guessing a
    single narrowed result.
  - If a suggestion list does not appear, the typed text may be too specific or too
    short — try fewer characters of the name, then pick.
  - Item codes like "ITEM_CLASS_001-N-PH-SURE_0001-001" are search VALUES for
    #itemInput, not selectors.
  - Once a field shows a chosen value and the dropdown has closed, treat that field
    as DONE. Move to the next field; do not re-open or re-pick it.
