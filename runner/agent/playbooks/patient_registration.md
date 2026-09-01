# Playbook: Patient Registration

This screen has dependent fields and custom widgets. Follow these screen-specific rules.

ORDER OF OPERATIONS — do these FIRST, before anything else:
1. Select the Consultant (search_select).
2. Immediately pick the Slot with "pick_first" (it depends on the consultant being set).
   The slot opens a popup/modal that loads slots after a few seconds; do NOT cancel it
   if it looks empty at first — pick_first waits and selects the first AVAILABLE slot.
   Earlier (elapsed) times are disabled; that is normal.
Only after Consultant AND Slot are set should you fill the patient fields.
Do NOT click Register/Save until Consultant, Slot, and all required fields are filled and
there are no validation errors. If a modal/popup is open, deal with it before doing anything
else — never click other fields while a modal is on screen.

AGE / DATE OF BIRTH: entering Age and leaving the field auto-calculates Date of Birth. If the
goal gives an Age, fill the Age field and do NOT type into Date of Birth — it populates from Age.

ADDRESS CASCADE — there are TWO blocks, CORRESPONDENCE and PERMANENT:
- Correspondence: (1) type the PIN/Zip Code and leave the field; (2) CITY is a searchable
  dropdown — use search_select and pick the suggestion (it does not auto-fill); (3) selecting
  City auto-fills District / State / Country — do NOT type those.
- Permanent: fill it the SAME WAY (do not look for a 'Same as' checkbox): Permanent Pincode,
  then search_select Permanent City; District/State/Country auto-fill from City.
- NEVER use 'check' on a Pincode/City/text field — those are text inputs, not checkboxes.
- If District/State/Country stay red/required, City was not actually selected — pick it again.

UNIQUENESS: append {{random}} to the patient first name (e.g. "Test{{random}}") to avoid
duplicate-patient errors. If a 'duplicate/already exists' error appears, re-enter the name with
a {{random}} suffix and submit again.
