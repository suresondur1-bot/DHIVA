# Playbook: Admission

URL contains: admission

_Auto-drafted by Study Screen from the live control map. Review and refine as needed._

# Admission Screen — Agent Playbook

## 1. Description
New inpatient admission form for a patient. URL substring: **`/adtweb/admission-new`**

## 2. Order of Operations
Single-page form (no Next button; one dialog). Fill in this order, then submit:

**Stage A — Clinical / Consultant**
1. Vulnerable (e26)
2. Primary Consultant (e27)
3. Admission Category (e28)
4. Opted Class (e29)

**Stage B — Dates**
5. Admission Date (e30)
6. Expected Discharge Date (e31)

**Stage C — Bed / Class**
7. Ward (e32)
8. Bed No. (e33)
9. Stay Class (e34)
10. Charge Class (e35)

**Stage D — Financial / Reason (optional + required)**
11. Cost Estimation (e36, optional)
12. Advance Amount (e37, optional)
13. Diet Preference (e38, optional)
14. Reason For Admission (e39, required)
15. Billing Remarks (e40, optional)

**Stage E — Submit** (e44 / e45)

## 3. Control Actions
| Control | Ref | Type | Action |
|---|---|---|---|
| Vulnerable | e26 | combobox | search_select |
| Primary Consultant | e27 | combobox | search_select |
| Admission Category | e28 | combobox | search_select |
| Opted Class | e29 | combobox | search_select |
| Admission Date | e30 | button | click to open picker, pick date |
| Expected Discharge Date | e31 | button | click to open picker, pick date |
| Ward | e32 | textbox | type (likely autocomplete — see Notes) |
| Bed No. | e33 | textbox | type (likely autocomplete — see Notes) |
| Stay Class | e34 | combobox | search_select |
| Charge Class | e35 | combobox | search_select |
| Cost Estimation | e36 | textbox | type (numeric, optional) |
| Advance Amount | e37 | textbox | type (numeric, optional) |
| Diet Preference | e38 | combobox | search_select (optional) |
| Reason For Admission | e39 | textbox | type (required) |
| Billing Remarks | e40 | textbox | type (optional) |
| Authorization / Add New Plan | e41 / e42 | link | click only if a payer plan is needed |

## 4. Disabled — Do Not Touch
These are the MLC block; disabled until an MLC/vulnerable prerequisite is set. **Do not attempt to fill:**
- MLC Number (e21) — auto-enables from Vulnerable/MLC selection
- Reason For MLC (e22) — same prerequisite
- Identification Mark 1 (e23), Identification Mark 2 (e24) — same
- Police Station (e25) — same
- Header quick-action buttons e14–e19 — disabled, ignore

## 5. Cascades
- **Vulnerable (e26)** likely gates the disabled MLC fields (e21–e25). If a vulnerable/MLC value is chosen, those fields may enable and become required — re-scan after picking.
- **Opted Class (e29) / Stay Class (e34) / Charge Class (e35)** are class-related; Opted Class or Ward may constrain the available Stay/Charge Class options. Fill Opted Class and Ward first, then pick Stay/Charge Class.
- **Ward (e32) → Bed No. (e33)**: Bed list typically depends on the chosen Ward. Select Ward before Bed No.

## 6. Submit
Two save actions at the bottom of the dialog:
- **Save Draft** (e44) — saves without admitting.
- **Admit** (e45) — final submit.

Do **not** click **Admit** (e45) until all required fields (e26, e27, e28, e29, e30, e31, e32, e33, e34, e35, e39) are filled and no validation errors are shown. **Cancel** (e43) discards — never click as part of a fill flow.

## 7. Notes / Gotchas
- **Ward (e32) and Bed No. (e33)** are typed textboxes but almost certainly type-to-search autocompletes — type, wait for suggestions, and explicitly pick a suggestion. Do not treat raw typed text as accepted.
- After choosing **Vulnerable**, re-scan: MLC fields (e21–e25) may enable and become required.
- For all comboboxes, type-to-filter then click the suggestion; don't assume the first match — disambiguate by code if consultant/plan names repeat.
- Dates are **button-triggered pickers** (e30/e31), not free-text fields — click to open, navigate, and select.
- **Add New Plan** (e42) opens the plan table (tbl47) for payer/sponsor entry; only use if an authorization/insurance plan is required for the admission.
- Treat a combobox as "done" only after the selection renders in the field, not just after typing.
