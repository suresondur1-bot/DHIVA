# Playbook: Service Purchase Requisition

URL contains: service-purchase-requisition

---

## FLOW A — Create New SPR (URL contains: service-purchase-requisition-new)

### Stage A — Prerequisite modal
1. `#supplierInput` → search_select
2. `#currencyList` → search_select
3. `#serviceCategoryList` → search_select
4. `#btnNext` → click (closes modal)

### Stage B — PR header
5. Wait for `#prDescription` → type

### Stage C — Line item row (LEFT to RIGHT)
6. `#itemInput` → search_select (SERVICE CODE field)
7. `table > tbody > tr > td:nth-of-type(2) > ng-select` → search_select (Rate Contract)
8. `td:7 input` → type (Qty)
9. `#serviceStartDate` → date_picker (calendar button td:12)
10. `#serviceEndDate` → date_picker (calendar button td:13)
11. `tbody > tr > td:nth-of-type(14) > div > ng-select` → search_select (Budget Ref No)
12. `table > tbody > tr > td:nth-of-type(15) > button` → click (+ add row)

### Stage D — Submit
13. Save button → click
14. Store PR number from `.td-pr` as variable

---

## FLOW B — Find and Edit Existing SPR (URL contains: service-purchase-requisition;status)

Used when goal says "find", "search", "open", "edit", "update" an existing PR.

### Stage 1 — Navigate to list page
- Navigate to: `https://sqa.narayanahealth.org/spmweb/service-purchase-requisition`

### Stage 2 — Search for the PR
- Select 'PR' from Search By dropdown: `#divFilter > div:nth-child(1) > div > ng-select` → search_select value 'PR'
- Type PR number into Document No. field: `#divFilter > div:nth-child(2) > div > input`
- Click search button: `#divFilter > div.col-3 > button.athma-btn.athma-btn-priamry-outline.athma-btn-height-sm`
- Click on the PR number link in results: `get_by_text("{{PR_NUMBER}}")` (the DRAFT-xxx link in SPR No. column)

### Stage 3 — Edit fields
- Wait for the edit form to load (wait for `#prDescription`)
- Edit only the fields mentioned in the goal
- All other fields: DO NOT TOUCH

### Stage 4 — Save
- Click Save button: `div:nth-of-type(2) > purchase-requisition-button > div > div:nth-of-type(2) > button:nth-of-type(1)`

---

## CRITICAL SELECTOR MAP

| Field | Selector | Action |
|---|---|---|
| Supplier Name | `#supplierInput` | search_select |
| Currency | `#currencyList` | search_select |
| Service Category | `#serviceCategoryList` | search_select |
| Continue button | `#btnNext` | click |
| PR Description | `#prDescription` | type |
| Service code/Item | `#itemInput` | search_select |
| Rate Contract | `table > tbody > tr > td:nth-of-type(2) > ng-select` | search_select |
| Long Description | `#longDescriptionInput` | auto-fills — DO NOT touch |
| Qty | `table > tbody > tr > td:nth-of-type(7) > input` | type |
| Start Date | `#serviceStartDate` | date_picker — DO NOT add separate calendar button click, system handles it |
| End Date | `#serviceEndDate` | date_picker — DO NOT add separate calendar button click, system handles it |
| Budget Ref No | `tbody > tr > td:nth-of-type(14) > div > ng-select` | search_select |
| + Add row | `table > tbody > tr > td:nth-of-type(15) > button` | click |
| Save | `div:nth-of-type(2) > purchase-requisition-button > div > div:nth-of-type(2) > button:nth-of-type(1)` | click |
| **Send for Approval** | **`div:nth-of-type(2) > purchase-requisition-button > div > div:nth-of-type(2) > button:nth-of-type(2)`** | click |
| **Approve** | **`div:nth-of-type(2) > purchase-requisition-button > div > div:nth-of-type(2) > button:nth-of-type(1)`** | click — only visible after Send for Approval, on Pending Approval status |
| **Confirmation message** | **`ngb-alert`** | store_text — contains "DRAFT-xxx saved successfully", PR number is first word |
| **List search box** | `#divFilter > div:nth-child(2) > div > input` | type |
| **Search By dropdown** | `#divFilter > div:nth-child(1) > div > ng-select` | search_select — select 'PR' before searching |
| **List search button** | `#divFilter > div.col-3 > button.athma-btn.athma-btn-priamry-outline.athma-btn-height-sm` | click |
| **PR Number (after save)** | `.td-pr` | store_text |

## Critical Rules
- `#longDescriptionInput` auto-fills after item selection — NEVER include it
- Start/End Date are readonly ngbdatepicker — always use calendar picker
- For EDIT flow: navigate to list → search → click result → edit → save
- For FIND flow: use the PR number variable e.g. {{SAIPR}}
- DO NOT re-fill fields that are already correct when editing
