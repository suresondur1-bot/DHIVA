// @refresh reset
/**
 * ATHMA Keyword Advisor — Complete Knowledge Base
 * All 80 actions covered.
 * Smart search: instant, free.
 * AI answer: via backend /api/keyword-advisor.
 */

import React, { useState, useRef, useEffect } from "react";

const KEYWORDS = [
  // ── UI Actions ──────────────────────────────────────────────────────────────
  {
    action: "navigate", label: "🌐 Navigate to URL", group: "UI Actions",
    description: "Open a URL in the browser",
    when: "you want to open a page, go to a URL, load a website",
    fields: [{ name: "URL", hint: "Full URL e.g. https://example.com or {{base_url}}/login" }],
    example: "URL: https://app.narayana.com/login",
    tags: ["open", "go to", "visit", "url", "page", "navigate", "load", "browser"],
  },
  {
    action: "click", label: "🖱️ Click element", group: "UI Actions",
    description: "Click any element — button, link, tab, icon",
    when: "you want to click a button, link, tab, icon or any element",
    fields: [{ name: "Selector", hint: "CSS selector or Playwright locator" }],
    example: "Selector: get_by_role('button', name='Submit')",
    tags: ["click", "press", "tap", "button", "link", "submit", "tab"],
  },
  {
    action: "type", label: "⌨️ Type text", group: "UI Actions",
    description: "Type text into an input field (clears first then types)",
    when: "you want to enter text, fill a field, type into an input",
    fields: [
      { name: "Selector", hint: "The input field" },
      { name: "Value", hint: "Text to type — supports {{variables}}" },
    ],
    example: "Selector: #patient-name\nValue: {{patient_name}}",
    tags: ["type", "enter", "fill", "input", "text", "write", "field"],
  },
  {
    action: "clear", label: "✖️ Clear field", group: "UI Actions",
    description: "Clear the contents of an input field without typing anything",
    when: "you want to clear a field, erase its content, empty an input",
    fields: [{ name: "Selector", hint: "The input field to clear" }],
    example: "Selector: #search-input",
    tags: ["clear", "erase", "empty", "reset field", "delete content"],
  },
  {
    action: "select", label: "📋 Select option", group: "UI Actions",
    description: "Select an option from a native HTML dropdown",
    when: "you want to choose from a native select/dropdown element",
    fields: [
      { name: "Selector", hint: "The select element" },
      { name: "Value", hint: "Option value or label to select" },
    ],
    example: "Selector: #gender\nValue: male",
    tags: ["select", "dropdown", "choose", "option", "pick", "native select"],
  },
  {
    action: "search_select", label: "🔍 Search & Select", group: "UI Actions",
    description: "Type in a search box and pick from the autocomplete dropdown that appears",
    when: "you want to search and select from an autocomplete, typeahead or ng-select dropdown",
    fields: [
      { name: "Selector", hint: "The search input or ng-select element" },
      { name: "Search text", hint: "Text to type to filter results" },
      { name: "Value", hint: "Option text to click from the dropdown" },
    ],
    example: "Search text: Cardio\nValue: CARDIOLOGY - ADULT",
    tags: ["search", "autocomplete", "typeahead", "ng-select", "filter dropdown", "search and select"],
  },
  {
    action: "check", label: "☑️ Check checkbox", group: "UI Actions",
    description: "Check (tick) a checkbox",
    when: "you want to tick or enable a checkbox",
    fields: [{ name: "Selector", hint: "The checkbox element" }],
    tags: ["check", "tick", "checkbox", "enable"],
  },
  {
    action: "uncheck", label: "☐ Uncheck checkbox", group: "UI Actions",
    description: "Uncheck (untick) a checkbox",
    when: "you want to untick or disable a checkbox",
    fields: [{ name: "Selector", hint: "The checkbox element" }],
    tags: ["uncheck", "untick", "checkbox", "disable"],
  },
  {
    action: "hover", label: "👆 Hover element", group: "UI Actions",
    description: "Move mouse over an element to trigger hover effects or tooltips",
    when: "you want to hover over an element, show a tooltip, open a hover menu",
    fields: [{ name: "Selector", hint: "The element to hover over" }],
    tags: ["hover", "mouse over", "tooltip", "menu"],
  },
  {
    action: "press", label: "⌨️ Press key", group: "UI Actions",
    description: "Press a keyboard key like Enter, Tab, Escape, Arrow keys",
    when: "you want to press a keyboard key like Enter, Tab, Escape, arrow keys",
    fields: [
      { name: "Selector", hint: "Element to focus (leave blank for global keypress)" },
      { name: "Value", hint: "Key name e.g. Enter, Tab, Escape, ArrowDown, F5" },
    ],
    example: "Value: Enter",
    tags: ["press", "key", "keyboard", "enter", "tab", "escape", "keypress"],
  },
  {
    action: "press_sequentially", label: "⌨️ Type letter by letter", group: "UI Actions",
    description: "Type text character by character — for debounced inputs that trigger search on each keystroke",
    when: "the type action does not trigger autocomplete, Angular debounced input, search triggers on each keystroke",
    fields: [
      { name: "Selector", hint: "The input field" },
      { name: "Value", hint: "Text to type letter by letter" },
    ],
    tags: ["debounce", "letter by letter", "slow type", "angular input", "trigger search", "character"],
  },
  {
    action: "double_click", label: "🖱️ Double Click", group: "UI Actions",
    description: "Double-click an element to open it or trigger edit mode",
    when: "you want to double click an element, open in edit mode, expand a node",
    fields: [{ name: "Selector", hint: "The element to double-click" }],
    tags: ["double click", "dblclick", "open", "edit mode"],
  },
  {
    action: "right_click", label: "🖱️ Right Click", group: "UI Actions",
    description: "Right-click an element to open its context menu",
    when: "you want to right click, open context menu",
    fields: [{ name: "Selector", hint: "The element to right-click" }],
    tags: ["right click", "context menu", "right mouse"],
  },
  {
    action: "drag_and_drop", label: "↔️ Drag and Drop", group: "UI Actions",
    description: "Drag an element from one place and drop it onto another",
    when: "you want to drag and drop, reorder items, move elements",
    fields: [
      { name: "Selector", hint: "The element to drag (source)" },
      { name: "Value", hint: "The drop target element selector" },
    ],
    example: "Selector: .drag-item\nValue: .drop-zone",
    tags: ["drag", "drop", "drag and drop", "reorder", "move"],
  },
  {
    action: "focus", label: "🎯 Focus element", group: "UI Actions",
    description: "Set keyboard focus on an element without clicking it",
    when: "you want to focus an input or element without clicking, trigger focus event",
    fields: [{ name: "Selector", hint: "The element to focus" }],
    tags: ["focus", "set focus", "focus element", "active element"],
  },
  {
    action: "blur", label: "💨 Blur element", group: "UI Actions",
    description: "Remove focus from an element to trigger blur/validation events",
    when: "you want to remove focus, trigger blur event, trigger field validation",
    fields: [{ name: "Selector", hint: "The element to blur" }],
    tags: ["blur", "unfocus", "remove focus", "validation", "blur event"],
  },
  {
    action: "scroll", label: "📜 Scroll to Y", group: "UI Actions",
    description: "Scroll the page to a specific Y pixel position",
    when: "you want to scroll down or up to a specific position on the page",
    fields: [{ name: "Value", hint: "Y position in pixels e.g. 500 or 1000" }],
    example: "Value: 1000",
    tags: ["scroll", "scroll down", "scroll up", "page position"],
  },
  {
    action: "execute_script", label: "⚙️ Execute JS", group: "UI Actions",
    description: "Run any JavaScript on the current page and optionally store the return value",
    when: "you want to run JavaScript, manipulate the DOM, get a value without a selector, scroll, trigger events",
    fields: [
      { name: "Value", hint: "JS to execute e.g. window.scrollTo(0,500) or return document.title" },
      { name: "Store as", hint: "Variable name to store the JS return value (optional)" },
    ],
    example: "Value: return document.querySelector('.mrn').innerText\nStore as: mrn_from_js",
    tags: ["javascript", "js", "execute", "script", "dom", "run code", "eval", "execute js"],
  },
  {
    action: "upload_attachment", label: "📎 Upload File", group: "UI Actions",
    description: "Upload a file through a file input element",
    when: "you want to upload a file, attach a document",
    fields: [
      { name: "Selector", hint: "The file input element" },
      { name: "Value", hint: "Full file path e.g. C:\\Users\\...\\file.pdf" },
    ],
    tags: ["upload", "file", "attach", "document", "browse"],
  },
  {
    action: "download", label: "⬇️ Download", group: "UI Actions",
    description: "Click a download link and save the file",
    when: "you want to download a file by clicking a link or button",
    fields: [
      { name: "Selector", hint: "The download button or link" },
      { name: "Value", hint: "Expected filename (optional, for verification)" },
    ],
    tags: ["download", "save file", "export", "download file"],
  },
  {
    action: "compare_pdf_page", label: "📄 Compare PDF vs Page", group: "UI Actions",
    description: "Compare a PDF file content against what is displayed on the page",
    when: "you want to verify PDF content matches the page, compare printed output with web content",
    fields: [
      { name: "Selector", hint: "Page element to compare against" },
      { name: "Value", hint: "PDF file path" },
    ],
    tags: ["pdf", "compare", "compare pdf", "verify pdf", "pdf vs page"],
  },
  {
    action: "table_action", label: "📊 Table Action (find row)", group: "UI Actions",
    description: "Find a row in a table by matching column content, then perform an action on it",
    when: "you want to find a row in a table and click something in it, like an edit or delete button",
    fields: [
      { name: "Selector", hint: "The table element" },
      { name: "Search column", hint: "Column name or index to search in" },
      { name: "Search value", hint: "Value to find in that column e.g. {{mrn}}" },
      { name: "Action column", hint: "Column where the action button is" },
      { name: "Action", hint: "What to do: click, store_text, assert_text" },
    ],
    example: "Find row where MRN = {{mrn}}, then click Edit button",
    tags: ["table", "find row", "table row", "search table", "row action", "grid"],
  },
  {
    action: "table_multi_action", label: "📊 Table Multi Action", group: "UI Actions",
    description: "Find a row in a table using multiple column conditions, then act on it",
    when: "you need to match a table row by more than one condition before clicking",
    fields: [
      { name: "Selector", hint: "The table element" },
      { name: "Conditions", hint: "Multiple column=value conditions" },
      { name: "Action", hint: "What to do on the matched row" },
    ],
    tags: ["table", "multi condition", "find row", "table multi", "grid"],
  },
  // ── Waits ──────────────────────────────────────────────────────────────────
  {
    action: "wait", label: "⏱️ Wait (ms)", group: "Waits",
    description: "Wait for a fixed number of milliseconds",
    when: "you want to pause, add a delay between steps, wait for animation to finish",
    fields: [{ name: "Value", hint: "Milliseconds to wait e.g. 2000 = 2 seconds" }],
    example: "Value: 2000",
    tags: ["wait", "pause", "delay", "sleep", "2 seconds"],
  },
  {
    action: "wait_for_selector", label: "⏳ Wait for element", group: "Waits",
    description: "Wait until a specific element appears on the page",
    when: "you want to wait for an element to appear, load, become visible",
    fields: [{ name: "Selector", hint: "Element to wait for" }],
    tags: ["wait for element", "element appears", "load", "wait for"],
  },
  {
    action: "wait_for_url", label: "⏳ Wait for URL", group: "Waits",
    description: "Wait until the browser URL contains a specific string",
    when: "you want to wait for navigation to complete, URL to change after login or redirect",
    fields: [{ name: "Value", hint: "URL substring to wait for e.g. /dashboard" }],
    tags: ["wait for url", "navigation", "redirect", "page change"],
  },
  {
    action: "wait_until", label: "⏳ Wait Until condition", group: "Waits",
    description: "Wait until a variable equals an expected value (polling)",
    when: "you want to wait until a variable reaches a certain value, poll until condition is true",
    fields: [
      { name: "Variable", hint: "Variable to check e.g. {{status}}" },
      { name: "Operator", hint: "equals / contains / not_equals" },
      { name: "Value", hint: "Expected value to wait for" },
    ],
    tags: ["wait until", "polling", "wait for condition", "wait variable"],
  },
  // ── Assertions ─────────────────────────────────────────────────────────────
  {
    action: "assert_text", label: "✅ Assert text contains", group: "Assertions",
    description: "Verify an element contains specific text",
    when: "you want to verify text on the page, check a label, confirm a success or error message",
    fields: [
      { name: "Selector", hint: "The element to check" },
      { name: "Value", hint: "Expected text (partial match)" },
    ],
    example: "Selector: .toast-message\nValue: Saved successfully",
    tags: ["assert", "verify", "check text", "contains text", "message", "label", "confirm"],
  },
  {
    action: "assert_not_text", label: "🚫 Assert text NOT contains", group: "Assertions",
    description: "Verify an element does NOT contain specific text",
    when: "you want to check text is absent, verify a message is not shown",
    fields: [
      { name: "Selector", hint: "The element to check" },
      { name: "Value", hint: "Text that should NOT be present" },
    ],
    tags: ["assert not text", "text absent", "not contains", "text not shown"],
  },
  {
    action: "assert_visible", label: "✅ Assert element visible", group: "Assertions",
    description: "Verify an element is visible on the page",
    when: "you want to check if an element is shown, displayed, present on screen",
    fields: [{ name: "Selector", hint: "The element to check" }],
    tags: ["visible", "shown", "displayed", "exists", "assert visible"],
  },
  {
    action: "assert_not_visible", label: "🚫 Assert element hidden", group: "Assertions",
    description: "Verify an element is NOT visible (hidden or absent)",
    when: "you want to check if an element is hidden, disappeared, not shown",
    fields: [{ name: "Selector", hint: "The element to check" }],
    tags: ["hidden", "not visible", "disappeared", "absent", "not shown"],
  },
  {
    action: "assert_enabled", label: "✅ Assert element enabled", group: "Assertions",
    description: "Verify an element is enabled and interactive (not disabled)",
    when: "you want to check a button or input is enabled, not disabled, clickable",
    fields: [{ name: "Selector", hint: "The element to check" }],
    tags: ["enabled", "not disabled", "clickable", "active", "assert enabled"],
  },
  {
    action: "assert_disabled", label: "🚫 Assert element disabled", group: "Assertions",
    description: "Verify an element is disabled and not interactive",
    when: "you want to check a button or input is disabled, greyed out",
    fields: [{ name: "Selector", hint: "The element to check" }],
    tags: ["disabled", "greyed out", "not clickable", "assert disabled"],
  },
  {
    action: "assert_checked", label: "✅ Assert checkbox checked", group: "Assertions",
    description: "Verify a checkbox is in checked/ticked state",
    when: "you want to confirm a checkbox is checked, ticked, selected",
    fields: [{ name: "Selector", hint: "The checkbox element" }],
    tags: ["checkbox checked", "ticked", "assert checked", "checkbox state"],
  },
  {
    action: "assert_not_checked", label: "🚫 Assert checkbox unchecked", group: "Assertions",
    description: "Verify a checkbox is NOT checked",
    when: "you want to confirm a checkbox is unchecked, not ticked",
    fields: [{ name: "Selector", hint: "The checkbox element" }],
    tags: ["checkbox unchecked", "not ticked", "assert not checked"],
  },
  {
    action: "assert_selected", label: "✅ Assert option selected", group: "Assertions",
    description: "Verify a specific option is selected in a dropdown",
    when: "you want to check which option is selected in a dropdown",
    fields: [
      { name: "Selector", hint: "The select element" },
      { name: "Value", hint: "Expected selected option text or value" },
    ],
    tags: ["selected option", "dropdown selected", "assert selected"],
  },
  {
    action: "assert_attribute", label: "✅ Assert attribute value", group: "Assertions",
    description: "Verify an element has a specific HTML attribute value",
    when: "you want to check an attribute like class, href, data-id, placeholder",
    fields: [
      { name: "Selector", hint: "The element to check" },
      { name: "Attribute", hint: "Attribute name e.g. class, href, placeholder" },
      { name: "Value", hint: "Expected attribute value" },
    ],
    example: "Selector: .status-badge\nAttribute: class\nValue: active",
    tags: ["attribute", "assert attribute", "class", "href", "data attribute", "check attribute"],
  },
  {
    action: "assert_css", label: "✅ Assert CSS property", group: "Assertions",
    description: "Verify an element has a specific computed CSS property value",
    when: "you want to check a CSS style like color, display, visibility, font-size",
    fields: [
      { name: "Selector", hint: "The element to check" },
      { name: "Property", hint: "CSS property name e.g. color, display, background-color" },
      { name: "Value", hint: "Expected CSS value" },
    ],
    tags: ["css", "style", "color", "assert css", "computed style"],
  },
  {
    action: "assert_cookie", label: "✅ Assert cookie", group: "Assertions",
    description: "Verify a browser cookie exists and has a specific value",
    when: "you want to check a cookie value, verify authentication cookie",
    fields: [
      { name: "Value", hint: "Cookie name to check" },
      { name: "Value 2", hint: "Expected cookie value" },
    ],
    tags: ["cookie", "assert cookie", "browser cookie", "session cookie"],
  },
  {
    action: "assert_url", label: "✅ Assert URL contains", group: "Assertions",
    description: "Verify the current URL contains a specific string",
    when: "you want to check the current page URL, verify navigation happened",
    fields: [{ name: "Value", hint: "URL substring to check for" }],
    tags: ["url", "assert url", "page url", "current url", "navigation"],
  },
  {
    action: "assert_title", label: "✅ Assert page title", group: "Assertions",
    description: "Verify the browser tab title contains specific text",
    when: "you want to check the page title, browser tab title",
    fields: [{ name: "Value", hint: "Expected title text (partial match)" }],
    example: "Value: Patient Dashboard",
    tags: ["title", "page title", "browser title", "tab title", "assert title"],
  },
  {
    action: "assert_value", label: "✅ Assert input value", group: "Assertions",
    description: "Verify an input field has a specific value",
    when: "you want to check what value is in an input, verify pre-filled field",
    fields: [
      { name: "Selector", hint: "The input field" },
      { name: "Value", hint: "Expected value" },
    ],
    tags: ["input value", "field value", "assert value", "check input"],
  },
  {
    action: "assert_count", label: "🔢 Assert element count", group: "Assertions",
    description: "Verify the number of elements matching a selector equals an expected count",
    when: "you want to check how many elements exist, verify a list has N items",
    fields: [
      { name: "Selector", hint: "The elements to count" },
      { name: "Value", hint: "Expected count e.g. 3" },
    ],
    example: "Selector: .table-row\nValue: 5",
    tags: ["count", "assert count", "number of elements", "how many", "list count"],
  },
  // ── Browser ────────────────────────────────────────────────────────────────
  {
    action: "refresh", label: "🔄 Refresh page", group: "Browser",
    description: "Reload the current page",
    when: "you want to refresh the page, reload, F5",
    fields: [],
    tags: ["refresh", "reload", "f5", "page reload"],
  },
  {
    action: "back", label: "◀️ Go Back", group: "Browser",
    description: "Navigate to the previous page in browser history",
    when: "you want to go back, navigate to previous page, browser back button",
    fields: [],
    tags: ["back", "go back", "previous page", "browser history", "back button"],
  },
  {
    action: "forward", label: "▶️ Go Forward", group: "Browser",
    description: "Navigate to the next page in browser history",
    when: "you want to go forward in browser history",
    fields: [],
    tags: ["forward", "go forward", "browser history", "next page"],
  },
  {
    action: "switch_frame", label: "🖼️ Switch to Frame", group: "Browser",
    description: "Switch automation context into an iframe",
    when: "you want to interact with elements inside an iframe, embedded frame",
    fields: [{ name: "Selector", hint: "The iframe element selector or name/index" }],
    tags: ["frame", "iframe", "switch frame", "embedded", "switch to frame"],
  },
  {
    action: "switch_window", label: "🪟 Switch Window", group: "Browser",
    description: "Switch to a different browser tab or popup window",
    when: "a popup or new tab opened and you want to interact with it",
    fields: [{ name: "Value", hint: "Window index (0=first, 1=second) or title substring" }],
    tags: ["window", "tab", "switch window", "popup", "new tab", "switch tab"],
  },
  {
    action: "close_window", label: "✖️ Close Window", group: "Browser",
    description: "Close the current browser tab or popup window",
    when: "you want to close a popup, close a tab, dismiss a new window",
    fields: [],
    tags: ["close window", "close tab", "close popup", "dismiss"],
  },
  {
    action: "set_cookie", label: "🍪 Set Cookie", group: "Browser",
    description: "Set a browser cookie with a name and value",
    when: "you want to set a cookie, inject a session token, set authentication cookie",
    fields: [
      { name: "Value", hint: "Cookie name" },
      { name: "Value 2", hint: "Cookie value" },
    ],
    tags: ["set cookie", "cookie", "session", "token", "inject cookie"],
  },
  {
    action: "clear_cookie", label: "🍪 Clear Cookie", group: "Browser",
    description: "Remove a browser cookie by name",
    when: "you want to clear a cookie, logout by removing session cookie",
    fields: [{ name: "Value", hint: "Cookie name to remove" }],
    tags: ["clear cookie", "remove cookie", "delete cookie", "logout"],
  },
  // ── Store / Capture ────────────────────────────────────────────────────────
  {
    action: "store_text", label: "💾 Store element text", group: "Store",
    description: "Read the visible text of an element and save it to a variable",
    when: "you want to get the text of an element, save it to use later",
    fields: [
      { name: "Selector", hint: "The element whose text you want" },
      { name: "Store as", hint: "Variable name e.g. patient_name" },
    ],
    example: "Selector: .patient-name\nStore as: patient_name",
    tags: ["get text", "read text", "element text", "store text", "save text", "capture text"],
  },
  {
    action: "store_value", label: "💾 Store input value", group: "Store",
    description: "Read the value of an input field and save to a variable",
    when: "you want to get the value from an input box, save form field value",
    fields: [
      { name: "Selector", hint: "The input field" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["get value", "input value", "store value", "save input", "field value"],
  },
  {
    action: "store_attr", label: "💾 Store attribute", group: "Store",
    description: "Read any HTML attribute of an element and save to variable",
    when: "you want to get an attribute like href, src, data-id, class from an element",
    fields: [
      { name: "Selector", hint: "The element" },
      { name: "Value", hint: "Attribute name e.g. href, data-id, class" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["attribute", "href", "data attribute", "class", "src", "store attribute"],
  },
  {
    action: "store_url", label: "💾 Store current URL", group: "Store",
    description: "Save the current browser URL to a variable",
    when: "you want to save the current page URL for later use",
    fields: [{ name: "Store as", hint: "Variable name e.g. current_url" }],
    tags: ["current url", "page url", "store url", "save url"],
  },
  {
    action: "store_title", label: "💾 Store page title", group: "Store",
    description: "Save the current page title (browser tab title) to a variable",
    when: "you want to capture the page title and use it later",
    fields: [{ name: "Store as", hint: "Variable name e.g. page_title" }],
    tags: ["page title", "store title", "browser title", "tab title"],
  },
  {
    action: "store_count", label: "💾 Store element count", group: "Store",
    description: "Count matching elements and save the number to a variable",
    when: "you want to count elements and use the number in later steps",
    fields: [
      { name: "Selector", hint: "Elements to count" },
      { name: "Store as", hint: "Variable name e.g. row_count" },
    ],
    example: "Selector: .table-row\nStore as: row_count",
    tags: ["count elements", "store count", "number of elements", "element count"],
  },
  {
    action: "store_js", label: "💾 Store JS result", group: "Store",
    description: "Run JavaScript and store the return value into a variable",
    when: "you want to run JS and save what it returns, get computed value from page",
    fields: [
      { name: "Value", hint: "JavaScript that returns a value e.g. return document.title" },
      { name: "Store as", hint: "Variable name" },
    ],
    example: "Value: return window.location.href\nStore as: current_url",
    tags: ["store js", "js result", "javascript result", "return value", "computed value"],
  },
  {
    action: "get_table_value", label: "📋 Get table value by label", group: "Store",
    description: "Find a value in a table by looking up a row label, store it to variable",
    when: "you want to get a value from a key-value table, lookup table, label-value grid",
    fields: [
      { name: "Selector", hint: "The table element" },
      { name: "Value", hint: "Row label to look up e.g. 'Total Amount'" },
      { name: "Store as", hint: "Variable name" },
    ],
    example: "Look up 'Total Amount' in table → store as invoice_total",
    tags: ["get table value", "lookup table", "label value", "key value table"],
  },
  // ── Assert Variables ───────────────────────────────────────────────────────
  {
    action: "assert_equals", label: "✅ Assert equals", group: "Assert Vars",
    description: "Check that a variable equals an expected value exactly",
    when: "you want to verify a variable has an exact value, compare two values",
    fields: [
      { name: "Value", hint: "Variable or value e.g. {{status}}" },
      { name: "Value 2", hint: "Expected value" },
    ],
    example: "Value: {{status}}\nValue 2: IN_PROGRESS",
    tags: ["equals", "compare", "assert equals", "exact match", "check value"],
  },
  {
    action: "assert_not_equals", label: "🚫 Assert not equals", group: "Assert Vars",
    description: "Check that a variable does NOT equal a value",
    when: "you want to verify a variable is not a specific value",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Value 2", hint: "Value it should NOT equal" },
    ],
    tags: ["not equals", "assert not equals", "different value"],
  },
  {
    action: "assert_contains", label: "✅ Assert contains", group: "Assert Vars",
    description: "Check that a variable's value contains a substring",
    when: "you want to check a variable contains some text (partial match)",
    fields: [
      { name: "Value", hint: "Variable to check e.g. {{full_name}}" },
      { name: "Value 2", hint: "Substring to find e.g. Kiran" },
    ],
    tags: ["contains", "assert contains", "partial match", "substring"],
  },
  {
    action: "assert_not_contains", label: "🚫 Assert not contains", group: "Assert Vars",
    description: "Check that a variable does NOT contain a substring",
    when: "you want to verify text is absent from a variable",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Value 2", hint: "Text that should NOT be present" },
    ],
    tags: ["not contains", "assert not contains", "text absent"],
  },
  {
    action: "assert_starts_with", label: "✅ Assert starts with", group: "Assert Vars",
    description: "Check that a variable's value starts with specific text",
    when: "you want to verify a value begins with a prefix",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Value 2", hint: "Expected prefix" },
    ],
    tags: ["starts with", "prefix", "begins with", "assert starts"],
  },
  {
    action: "assert_ends_with", label: "✅ Assert ends with", group: "Assert Vars",
    description: "Check that a variable's value ends with specific text",
    when: "you want to verify a value ends with a suffix",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Value 2", hint: "Expected suffix" },
    ],
    tags: ["ends with", "suffix", "assert ends", "ends with"],
  },
  {
    action: "assert_greater", label: "✅ Assert greater than", group: "Assert Vars",
    description: "Check that a numeric variable is greater than a value",
    when: "you want to verify a number is greater than expected",
    fields: [
      { name: "Value", hint: "Variable with numeric value e.g. {{amount}}" },
      { name: "Value 2", hint: "Threshold value e.g. 100" },
    ],
    tags: ["greater than", "assert greater", "numeric", "more than"],
  },
  {
    action: "assert_less", label: "✅ Assert less than", group: "Assert Vars",
    description: "Check that a numeric variable is less than a value",
    when: "you want to verify a number is less than expected",
    fields: [
      { name: "Value", hint: "Variable with numeric value" },
      { name: "Value 2", hint: "Threshold value" },
    ],
    tags: ["less than", "assert less", "numeric", "smaller than"],
  },
  {
    action: "assert_between", label: "✅ Assert between", group: "Assert Vars",
    description: "Check that a numeric variable falls between two values",
    when: "you want to verify a number is within a range",
    fields: [
      { name: "Value", hint: "Variable with numeric value" },
      { name: "Value 2", hint: "Minimum value" },
      { name: "Value 3", hint: "Maximum value" },
    ],
    tags: ["between", "range", "assert between", "within range"],
  },
  {
    action: "assert_soft", label: "🟡 Soft Assert", group: "Assert Vars",
    description: "Assert a value but continue the test even if it fails (logged as warning)",
    when: "you want to check something but not stop the test on failure, soft assertion",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Operator", hint: "equals / contains / starts_with etc." },
      { name: "Value 2", hint: "Expected value" },
    ],
    tags: ["soft assert", "non-blocking assert", "continue on fail", "warning assert"],
  },
  {
    action: "assert_matches", label: "✅ Assert matches regex", group: "Assert Vars",
    description: "Check that a variable's value matches a regular expression",
    when: "you want to verify a value using a regex pattern e.g. email format, date format",
    fields: [
      { name: "Value", hint: "Variable to check" },
      { name: "Value 2", hint: "Regex pattern e.g. ^APT-\\d+ or \\d{10}" },
    ],
    example: "Value: {{appt_no}}\nValue 2: ^APT-\\d+",
    tags: ["regex", "pattern", "assert regex", "regular expression", "format check"],
  },
  {
    action: "assert_empty", label: "✅ Assert is empty", group: "Assert Vars",
    description: "Check that a variable is empty or blank",
    when: "you want to verify a variable has no value, is empty string",
    fields: [{ name: "Value", hint: "Variable to check e.g. {{error_msg}}" }],
    tags: ["empty", "blank", "assert empty", "no value"],
  },
  {
    action: "assert_not_empty", label: "✅ Assert not empty", group: "Assert Vars",
    description: "Check that a variable has a value (is not empty)",
    when: "you want to verify a variable is not empty, has some value",
    fields: [{ name: "Value", hint: "Variable to check" }],
    tags: ["not empty", "has value", "assert not empty", "populated"],
  },
  // ── String Operations ──────────────────────────────────────────────────────
  {
    action: "str_upper", label: "🔤 String → UPPER", group: "String Ops",
    description: "Convert a string variable to UPPERCASE",
    when: "you want to convert text to uppercase",
    fields: [
      { name: "Value", hint: "Variable to convert e.g. {{name}}" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["uppercase", "upper", "capitalize", "str upper"],
  },
  {
    action: "str_lower", label: "🔤 String → lower", group: "String Ops",
    description: "Convert a string variable to lowercase",
    when: "you want to convert text to lowercase",
    fields: [
      { name: "Value", hint: "Variable to convert" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["lowercase", "lower", "str lower"],
  },
  {
    action: "str_trim", label: "✂️ String trim", group: "String Ops",
    description: "Remove leading and trailing whitespace from a string",
    when: "you want to trim whitespace, remove spaces from start/end of a value",
    fields: [
      { name: "Value", hint: "Variable to trim" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["trim", "whitespace", "strip", "str trim", "remove spaces"],
  },
  {
    action: "str_replace", label: "🔄 String replace", group: "String Ops",
    description: "Replace part of a string with another value",
    when: "you want to replace text in a variable, substitute a substring",
    fields: [
      { name: "Value", hint: "Source variable" },
      { name: "Value 2", hint: "Text to find" },
      { name: "Value 3", hint: "Text to replace with" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["replace", "substitute", "change text", "string replace"],
  },
  {
    action: "str_substring", label: "✂️ String substring", group: "String Ops",
    description: "Extract a portion of a string by start and end position",
    when: "you want to get part of a string by character position",
    fields: [
      { name: "Value", hint: "Source variable" },
      { name: "Value 2", hint: "Start index (0-based)" },
      { name: "Value 3", hint: "End index (leave blank for end of string)" },
      { name: "Store as", hint: "Variable name" },
    ],
    example: "Value: {{appt_no}}\nStart: 4\nResult: 2604002665A",
    tags: ["substring", "substr", "slice", "part of string", "character position"],
  },
  {
    action: "str_concat", label: "➕ String concat", group: "String Ops",
    description: "Combine two strings or variables together",
    when: "you want to join text, combine two values into one",
    fields: [
      { name: "Value", hint: "First string or {{variable}}" },
      { name: "Value 2", hint: "Second string or {{variable}}" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["concat", "combine", "join", "merge strings", "append"],
  },
  {
    action: "str_length", label: "🔢 String length", group: "String Ops",
    description: "Get the number of characters in a string",
    when: "you want to count characters, get string length",
    fields: [
      { name: "Value", hint: "Variable to measure" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["length", "string length", "character count", "str length"],
  },
  {
    action: "str_split", label: "✂️ String split", group: "String Ops",
    description: "Split a string by a separator and get a specific part",
    when: "you want to split by comma, slash or dash and get one part of the result",
    fields: [
      { name: "Value", hint: "Source variable" },
      { name: "Value 2", hint: "Separator e.g. , or / or -" },
      { name: "Value 3", hint: "Part index (0 = first, 1 = second, -1 = last)" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["split", "separator", "part of string", "substring", "delimiter"],
  },
  // ── Math Operations ────────────────────────────────────────────────────────
  {
    action: "math_add", label: "➕ Math add", group: "Math Ops",
    description: "Add two numbers together",
    when: "you want to add numbers, increment a counter, calculate total",
    fields: [
      { name: "Value", hint: "First number or {{variable}}" },
      { name: "Value 2", hint: "Second number" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["add", "sum", "plus", "increment", "total", "calculate"],
  },
  {
    action: "math_subtract", label: "➖ Math subtract", group: "Math Ops",
    description: "Subtract one number from another",
    when: "you want to subtract numbers, find the difference",
    fields: [
      { name: "Value", hint: "First number or {{variable}}" },
      { name: "Value 2", hint: "Number to subtract" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["subtract", "minus", "difference", "math subtract"],
  },
  {
    action: "math_multiply", label: "✖️ Math multiply", group: "Math Ops",
    description: "Multiply two numbers",
    when: "you want to multiply numbers, calculate product",
    fields: [
      { name: "Value", hint: "First number or {{variable}}" },
      { name: "Value 2", hint: "Multiplier" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["multiply", "times", "product", "math multiply"],
  },
  {
    action: "math_divide", label: "➗ Math divide", group: "Math Ops",
    description: "Divide one number by another",
    when: "you want to divide numbers, calculate ratio or percentage",
    fields: [
      { name: "Value", hint: "Dividend (number to divide)" },
      { name: "Value 2", hint: "Divisor" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["divide", "division", "ratio", "math divide"],
  },
  {
    action: "math_round", label: "🔢 Math round", group: "Math Ops",
    description: "Round a number to specified decimal places",
    when: "you want to round a decimal number, format a number",
    fields: [
      { name: "Value", hint: "Number or {{variable}} to round" },
      { name: "Value 2", hint: "Decimal places e.g. 0 for integer, 2 for 2 decimals" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["round", "decimal", "math round", "format number"],
  },
  {
    action: "math_abs", label: "🔢 Math absolute value", group: "Math Ops",
    description: "Get the absolute (positive) value of a number",
    when: "you want to remove negative sign, get magnitude of a number",
    fields: [
      { name: "Value", hint: "Number or {{variable}}" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["absolute", "abs", "positive", "magnitude", "math abs"],
  },
  {
    action: "math_random", label: "🎲 Random number in range", group: "Math Ops",
    description: "Generate a random integer between min and max",
    when: "you want a random number within a range",
    fields: [
      { name: "Value", hint: "Minimum value e.g. 1" },
      { name: "Value 2", hint: "Maximum value e.g. 100" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["random", "random number", "range", "math random"],
  },
  // ── Date / Time ────────────────────────────────────────────────────────────
  {
    action: "date_today", label: "📅 Store today's date", group: "Date Ops",
    description: "Store today's date in a specified format",
    when: "you want today's date, current date in a specific format",
    fields: [
      { name: "Value", hint: "Date format e.g. DD-MM-YYYY or YYYY/MM/DD" },
      { name: "Store as", hint: "Variable name e.g. today" },
    ],
    example: "Format: DD-MM-YYYY\nStore as: today\nResult: 19-04-2026",
    tags: ["today", "current date", "date today", "store date"],
  },
  {
    action: "date_now", label: "📅 Store current datetime", group: "Date Ops",
    description: "Store the current date and time including hours and minutes",
    when: "you want the current date and time, timestamp",
    fields: [
      { name: "Value", hint: "Format e.g. DD-MM-YYYY HH:mm or YYYY-MM-DDTHH:mm:ss" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["now", "current time", "datetime", "timestamp", "date now"],
  },
  {
    action: "date_add", label: "📅 Date add days", group: "Date Ops",
    description: "Add a number of days to a date and store the result",
    when: "you want to calculate a future date, add days to today",
    fields: [
      { name: "Value", hint: "Source date variable or today" },
      { name: "Value 2", hint: "Format e.g. DD-MM-YYYY" },
      { name: "Value 3", hint: "Number of days to add" },
      { name: "Store as", hint: "Variable name" },
    ],
    example: "Add 7 days to today → {{next_week}}",
    tags: ["date add", "future date", "add days", "date calculation"],
  },
  {
    action: "date_subtract", label: "📅 Date subtract days", group: "Date Ops",
    description: "Subtract a number of days from a date",
    when: "you want to calculate a past date, subtract days from today",
    fields: [
      { name: "Value", hint: "Source date variable" },
      { name: "Value 2", hint: "Format" },
      { name: "Value 3", hint: "Number of days to subtract" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["date subtract", "past date", "subtract days", "date calculation"],
  },
  {
    action: "date_format", label: "📅 Date format", group: "Date Ops",
    description: "Convert a date from one format to another",
    when: "you want to change date format e.g. from YYYY-MM-DD to DD/MM/YYYY",
    fields: [
      { name: "Value", hint: "Source date variable" },
      { name: "Value 2", hint: "Input format e.g. YYYY-MM-DD" },
      { name: "Value 3", hint: "Output format e.g. DD/MM/YYYY" },
      { name: "Store as", hint: "Variable name" },
    ],
    tags: ["date format", "reformat date", "convert date", "date conversion"],
  },
  {
    action: "date_diff", label: "📅 Date difference (days)", group: "Date Ops",
    description: "Calculate the number of days between two dates",
    when: "you want to find how many days between two dates, calculate age in days",
    fields: [
      { name: "Value", hint: "First date variable" },
      { name: "Value 2", hint: "Format" },
      { name: "Value 3", hint: "Second date variable or value" },
      { name: "Store as", hint: "Variable name for the difference in days" },
    ],
    tags: ["date diff", "days between", "date difference", "calculate days"],
  },
  // ── Encode / Parse ─────────────────────────────────────────────────────────
  {
    action: "encode_base64", label: "🔐 Encode base64", group: "Encode/Parse",
    description: "Encode a string to Base64 format",
    when: "you want to base64 encode a value, encode credentials for API auth",
    fields: [
      { name: "Value", hint: "String or {{variable}} to encode" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    example: "Value: {{username}}:{{password}}\nStore as: auth_token",
    tags: ["base64", "encode", "encode base64", "auth", "credentials"],
  },
  {
    action: "decode_base64", label: "🔓 Decode base64", group: "Encode/Parse",
    description: "Decode a Base64 encoded string back to plain text",
    when: "you want to decode a base64 value, read an encoded response",
    fields: [
      { name: "Value", hint: "Base64 encoded string or {{variable}}" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["decode", "base64", "decode base64"],
  },
  {
    action: "url_encode", label: "🔗 URL encode", group: "Encode/Parse",
    description: "URL-encode a string so it is safe to use in a URL parameter",
    when: "you want to URL encode a value, encode spaces and special chars for a URL",
    fields: [
      { name: "Value", hint: "String or {{variable}} to encode" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["url encode", "percent encode", "encode url", "url parameter"],
  },
  {
    action: "json_parse", label: "📦 JSON parse string", group: "Encode/Parse",
    description: "Parse a JSON string and store it as a usable variable",
    when: "you want to parse a JSON string, convert raw JSON text into a variable",
    fields: [
      { name: "Value", hint: "Variable holding the JSON string" },
      { name: "Store as", hint: "Variable name for parsed result" },
    ],
    tags: ["json parse", "parse json", "json string", "deserialize"],
  },
  // ── Control Flow ───────────────────────────────────────────────────────────
  {
    action: "if_start", label: "❓ IF condition", group: "Control Flow",
    description: "Run steps conditionally based on a variable value",
    when: "you want to run steps only if a condition is true, conditional branching",
    fields: [
      { name: "Variable", hint: "Variable to check e.g. {{status}}" },
      { name: "Operator", hint: "equals / contains / not_equals / greater / less" },
      { name: "Value", hint: "Value to compare against" },
    ],
    example: "{{status}} equals IN_PROGRESS",
    tags: ["if", "condition", "conditional", "only if", "when", "branch"],
  },
  {
    action: "else", label: "↔️ ELSE", group: "Control Flow",
    description: "Define steps to run when the IF condition is false",
    when: "you want to handle the false case of an IF block",
    fields: [],
    tags: ["else", "otherwise", "if else", "false branch"],
  },
  {
    action: "if_end", label: "❓ END IF", group: "Control Flow",
    description: "Mark the end of an IF/ELSE block",
    when: "you need to close an IF block",
    fields: [],
    tags: ["end if", "close if", "if end"],
  },
  {
    action: "loop_start", label: "🔁 Loop Start", group: "Control Flow",
    description: "Repeat a set of steps a fixed number of times",
    when: "you want to repeat steps N times, loop, iterate a fixed count",
    fields: [{ name: "Count", hint: "Number of times to repeat" }],
    tags: ["loop", "repeat", "iterate", "multiple times", "for loop"],
  },
  {
    action: "loop_end", label: "🔁 Loop End", group: "Control Flow",
    description: "Mark the end of a Loop block",
    when: "you need to close a Loop block",
    fields: [],
    tags: ["loop end", "end loop", "close loop"],
  },
  {
    action: "foreach_start", label: "📋 For Each (list)", group: "Control Flow",
    description: "Repeat steps for each item in a comma-separated list variable",
    when: "you want to repeat steps for each value in a list",
    fields: [
      { name: "List variable", hint: "Variable containing comma-separated values" },
      { name: "Item variable", hint: "Variable name for current item each iteration" },
    ],
    tags: ["foreach", "for each", "list", "iterate list", "each item"],
  },
  {
    action: "foreach_end", label: "📋 For Each End", group: "Control Flow",
    description: "Mark the end of a For Each block",
    when: "you need to close a For Each block",
    fields: [],
    tags: ["foreach end", "end foreach", "close foreach"],
  },
  {
    action: "switch_start", label: "🔀 SWITCH (variable)", group: "Control Flow",
    description: "Branch into different cases based on a variable's value",
    when: "you want different steps for different variable values, multi-branch logic",
    fields: [{ name: "Variable", hint: "Variable whose value determines the case e.g. {{status}}" }],
    tags: ["switch", "case", "multi branch", "switch case", "multiple conditions"],
  },
  {
    action: "case", label: "📌 CASE value", group: "Control Flow",
    description: "Define steps for a specific value in a SWITCH block",
    when: "you are inside a SWITCH and want steps for a specific case value",
    fields: [{ name: "Value", hint: "The case value to match e.g. ARRIVED" }],
    tags: ["case", "switch case", "branch value"],
  },
  {
    action: "switch_end", label: "🔀 END SWITCH", group: "Control Flow",
    description: "Mark the end of a SWITCH block",
    when: "you need to close a SWITCH block",
    fields: [],
    tags: ["switch end", "end switch", "close switch"],
  },
  {
    action: "break", label: "⛔ Break loop", group: "Control Flow",
    description: "Exit the current loop immediately",
    when: "you want to stop looping early, break out of a loop based on a condition",
    fields: [],
    tags: ["break", "exit loop", "stop loop", "break loop"],
  },
  {
    action: "continue", label: "⏭️ Continue", group: "Control Flow",
    description: "Skip the rest of the current iteration and go to the next",
    when: "you want to skip to the next iteration, continue the loop",
    fields: [],
    tags: ["continue", "next iteration", "skip", "loop continue"],
  },
  {
    action: "repeat_until", label: "🔄 Repeat Until condition", group: "Control Flow",
    description: "Repeat steps until a variable condition becomes true",
    when: "you want to keep repeating steps until something changes, polling loop",
    fields: [
      { name: "Variable", hint: "Variable to check" },
      { name: "Operator", hint: "equals / contains / not_equals" },
      { name: "Value", hint: "Target value to stop repeating" },
    ],
    tags: ["repeat until", "until", "polling", "do while", "keep repeating"],
  },
  {
    action: "repeat_until_end", label: "🔄 Repeat Until End", group: "Control Flow",
    description: "Mark the end of a Repeat Until block",
    when: "you need to close a Repeat Until block",
    fields: [],
    tags: ["repeat until end", "end repeat"],
  },
  {
    action: "try_start", label: "🛡️ Try block", group: "Control Flow",
    description: "Start a try block — errors inside go to the Catch block instead of failing",
    when: "you want to handle errors gracefully, run steps that might fail, try/catch",
    fields: [],
    tags: ["try", "error handling", "try catch", "exception", "graceful"],
  },
  {
    action: "catch_start", label: "🚨 Catch (on error)", group: "Control Flow",
    description: "Define steps to run when an error occurs inside the Try block",
    when: "you want to handle errors, run recovery steps when something fails",
    fields: [],
    tags: ["catch", "error", "on error", "exception handler", "try catch"],
  },
  {
    action: "try_end", label: "🛡️ End Try/Catch", group: "Control Flow",
    description: "Mark the end of a Try/Catch block",
    when: "you need to close a Try/Catch block",
    fields: [],
    tags: ["try end", "end try", "close try"],
  },
  // ── Misc ───────────────────────────────────────────────────────────────────
  {
    action: "group", label: "📦 Group / Comment", group: "Misc",
    description: "Group steps together under a label, or add a comment/description",
    when: "you want to organize steps into sections, add comments, create step groups",
    fields: [{ name: "Value", hint: "Group label or comment text" }],
    tags: ["group", "comment", "label", "section", "organize", "annotate"],
  },
  {
    action: "call_test", label: "📞 Call Test Case", group: "Misc",
    description: "Run another test case as a sub-test from the current test",
    when: "you want to reuse a test case, call a shared test, modularize tests",
    fields: [{ name: "Value", hint: "Test case name or ID to call" }],
    tags: ["call test", "reuse", "sub test", "modular", "shared steps"],
  },
  {
    action: "screenshot", label: "📷 Take screenshot", group: "Misc",
    description: "Capture a screenshot of the current page at this point in the test",
    when: "you want to take a screenshot, capture current state for debugging",
    fields: [],
    tags: ["screenshot", "capture", "snapshot", "screen capture"],
  },
  // ── Database ───────────────────────────────────────────────────────────────
  {
    action: "db_validate", label: "🗄️ DB Validate Query", group: "Database",
    description: "Run a SQL query and assert the result or store it as a variable",
    when: "you want to query the database, verify a DB value, store a DB result",
    fields: [
      { name: "Connection", hint: "Saved connection name e.g. NAT_DB" },
      { name: "Query", hint: "SQL query — use {{variables}} in the query" },
      { name: "Validation type", hint: "equals / contains / store / row_count / not_empty" },
      { name: "Store as", hint: "Variable name (when using store type)" },
    ],
    example: "Query: SELECT status FROM patients WHERE mrn='{{mrn}}' LIMIT 1\nValidation: equals\nExpected: ACTIVE",
    tags: ["database", "sql", "query", "db", "postgres", "check db", "store from db"],
  },
  {
    action: "db_extract_multi", label: "🗄️ DB Extract Multi Columns", group: "Database",
    description: "Run one SQL query and store multiple columns into separate variables",
    when: "you want to get multiple values from one DB query into separate variables",
    fields: [
      { name: "Connection", hint: "Saved connection name" },
      { name: "Query", hint: "SELECT col1, col2 FROM table LIMIT 1" },
      { name: "Mappings", hint: "column name → variable name pairs" },
    ],
    example: "Query: SELECT mrn, doctor_name FROM consultation LIMIT 1\nMap: mrn → {{mrn}}, doctor_name → {{doctor}}",
    tags: ["multiple columns", "db extract", "multiple variables", "db query multiple"],
  },
  // ── JSON ───────────────────────────────────────────────────────────────────
  {
    action: "json_extract", label: "📦 JSON Extract (dot-path)", group: "JSON",
    description: "Extract a single value from a JSON object using dot-notation path",
    when: "you want to get a field from JSON, extract from an API response or DB document",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON string e.g. JSON_OBJ" },
      { name: "Dot-path", hint: "Path e.g. patient.mrn or hsc.id or activityTimings.0.status" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    example: "Source: JSON_OBJ\nPath: patient.mrn\nStore as: mrn",
    tags: ["json", "extract", "api response", "json field", "dot path", "get from json"],
  },
  {
    action: "json_multi_extract", label: "📦 JSON Extract Multiple", group: "JSON",
    description: "Extract multiple values from one JSON object in a single step",
    when: "you want to get multiple JSON fields at once instead of multiple steps",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Mappings", hint: "dot-path → variable name pairs" },
    ],
    example: "Source: JSON_OBJ\npatient.mrn → {{mrn}}\nconsultant.displayName → {{doctor}}",
    tags: ["json multiple", "extract multiple", "multiple fields", "batch extract"],
  },
  {
    action: "json_array_get", label: "📦 JSON Array Get (by index)", group: "JSON",
    description: "Get a specific item from a JSON array by its index",
    when: "you want to get the first, last or Nth item from a JSON array",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Array path", hint: "Path to array e.g. activityTimings or slots" },
      { name: "Index", hint: "0 = first, 1 = second, -1 = last" },
      { name: "Store as", hint: "Variable name" },
    ],
    example: "Path: activityTimings\nIndex: 0\nStore as: first_timing",
    tags: ["array", "get item", "first item", "last item", "array index", "json array"],
  },
  {
    action: "json_array_length", label: "📦 JSON Array Length", group: "JSON",
    description: "Count the number of items in a JSON array",
    when: "you want to count items in an array",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Array path", hint: "Path to array e.g. invoiceItems or slots" },
      { name: "Store as", hint: "Variable to store count" },
    ],
    example: "Path: slots\nStore as: slot_count\nResult: 2",
    tags: ["count", "length", "array count", "number of items"],
  },
  {
    action: "json_array_filter", label: "📦 JSON Array Filter (by value)", group: "JSON",
    description: "Find the first item in an array where a key matches a value",
    when: "you want to find an item in a JSON array by condition e.g. where status = IN_PROGRESS",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Array path", hint: "Path to array e.g. activityTimings" },
      { name: "Where key", hint: "Key to match on e.g. status" },
      { name: "Where value", hint: "Value to find e.g. IN_PROGRESS" },
      { name: "Store as", hint: "Variable to store matched item" },
    ],
    example: "Path: activityTimings\nWhere: status = IN_PROGRESS\nStore: timing_obj",
    tags: ["filter", "find in array", "search array", "where", "condition", "match"],
  },
  {
    action: "json_contains", label: "📦 JSON Contains (assert)", group: "JSON",
    description: "Assert that a JSON path exists and optionally equals a value",
    when: "you want to verify a JSON field value, assert an API response field",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Path", hint: "Dot-path to check e.g. consultationStatus" },
      { name: "Expected value", hint: "Leave blank to just check existence" },
    ],
    tags: ["assert json", "verify json", "check json", "json assert"],
  },
  {
    action: "json_build", label: "📦 JSON Build object", group: "JSON",
    description: "Build a JSON object from key-value pairs using variables",
    when: "you want to create a JSON object, build a request body, combine variables into JSON",
    fields: [
      { name: "Store as", hint: "Variable to store the built JSON" },
      { name: "Key-value pairs", hint: "key = value pairs using {{variables}}" },
    ],
    example: "mrn = {{patient_mrn}}\nstatus = ACTIVE\nStore as: request_body",
    tags: ["build json", "create json", "request body", "json object", "combine"],
  },
  {
    action: "json_set", label: "📦 JSON Set value at path", group: "JSON",
    description: "Set or update a value at a dot-path in a JSON object",
    when: "you want to modify a JSON value, update a field in an existing JSON object",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Dot-path", hint: "Path to set e.g. patient.status" },
      { name: "New value", hint: "Value to set — supports {{variables}}" },
      { name: "Store as", hint: "Variable name for updated JSON" },
    ],
    tags: ["json set", "update json", "modify json", "set value"],
  },
  {
    action: "json_stringify", label: "📦 JSON Stringify", group: "JSON",
    description: "Convert a variable or object to a JSON string",
    when: "you want to convert to JSON string, serialize an object",
    fields: [
      { name: "Source variable", hint: "Variable to stringify" },
      { name: "Store as", hint: "Variable name for result" },
    ],
    tags: ["stringify", "json string", "serialize", "to json"],
  },
  {
    action: "json_keys", label: "📦 JSON Get keys", group: "JSON",
    description: "Get all keys of a JSON object as a comma-separated string",
    when: "you want to list the keys of a JSON object, inspect its structure",
    fields: [
      { name: "Source variable", hint: "Variable holding the JSON" },
      { name: "Store as", hint: "Variable name for comma-separated keys" },
    ],
    tags: ["json keys", "object keys", "list keys", "json structure"],
  },
];

// ─── Smart search ──────────────────────────────────────────────────────────────
function smartSearch(query) {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const scored = KEYWORDS.map(k => {
    let score = 0;
    const searchText = [k.action, k.label, k.description, k.when, ...(k.tags || [])].join(" ").toLowerCase();
    if (k.action === q) score += 100;
    if (k.action.includes(q)) score += 30;
    k.tags?.forEach(tag => { if (q.includes(tag) || tag.includes(q)) score += 20; });
    q.split(" ").forEach(word => { if (word.length > 2 && searchText.includes(word)) score += 5; });
    if (searchText.includes(q)) score += 10;
    return { ...k, score };
  });
  return scored.filter(k => k.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
}

// ─── Styles ────────────────────────────────────────────────────────────────────
const st = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" },
  modal: { background: "#fff", borderRadius: 12, width: "min(720px, 95vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)", overflow: "hidden" },
  header: { padding: "16px 20px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", background: "linear-gradient(135deg, #1e40af, #7c3aed)" },
  body: { flex: 1, overflowY: "auto", padding: 20 },
  input: { width: "100%", padding: "10px 14px", border: "2px solid #e5e7eb", borderRadius: 8, fontSize: 14, outline: "none", boxSizing: "border-box" },
  card: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 12, background: "#fafafa" },
  badge: (c) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700, background: c + "20", color: c, marginRight: 6 }),
  btn: (p) => ({ padding: "8px 16px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13, background: p ? "#1e40af" : "#f3f4f6", color: p ? "#fff" : "#374151" }),
};

const GROUP_COLORS = {
  "UI Actions": "#1e40af", "Waits": "#0891b2", "Assertions": "#059669",
  "Assert Vars": "#16a34a", "Store": "#7c3aed", "Database": "#b45309",
  "JSON": "#d97706", "Control Flow": "#dc2626", "String Ops": "#9333ea",
  "Math Ops": "#0284c7", "Date Ops": "#0e7490", "Encode/Parse": "#7c3aed",
  "Browser": "#64748b", "Misc": "#6b7280",
};

// ─── Keyword Card ──────────────────────────────────────────────────────────────
function KeywordCard({ kw, aiResult }) {
  const [expanded, setExpanded] = useState(true);
  const color = GROUP_COLORS[kw.group] || "#6b7280";

  return (
    <div style={{ ...st.card, borderLeft: `4px solid ${color}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <div>
          <span style={st.badge(color)}>{kw.group}</span>
          <strong style={{ fontSize: 14 }}>{kw.label}</strong>
        </div>
        <span style={{ fontSize: 18, color: "#9ca3af" }}>{expanded ? "▲" : "▼"}</span>
      </div>

      <div style={{ fontSize: 13, color: "#4b5563", marginTop: 6 }}>{aiResult?.reason || kw.description}</div>

      {expanded && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
            <strong>✅ Use when:</strong> {kw.when}
          </div>

          {/* AI fields table */}
          {aiResult?.fields?.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#1e40af", marginBottom: 6 }}>📋 What to fill in each field:</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "#eff6ff" }}>
                    <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "25%" }}>Field</th>
                    <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "40%" }}>What to pass</th>
                    <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "35%" }}>Example</th>
                  </tr>
                </thead>
                <tbody>
                  {aiResult.fields.map((f, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f8faff" }}>
                      <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", fontWeight: 600, color: "#1e40af" }}>{f.name}</td>
                      <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", color: "#374151" }}>{f.what_to_pass}</td>
                      <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", fontFamily: "'IBM Plex Mono',monospace", color: "#059669", fontSize: 11 }}>{f.example}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Fallback: knowledge base fields */}
          {!aiResult?.fields && kw.fields?.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#374151", marginBottom: 4 }}>📋 Fields to fill:</div>
              {kw.fields.map((f, i) => (
                <div key={i} style={{ display: "flex", gap: 8, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 6, padding: "6px 10px", marginTop: 4, fontSize: 12 }}>
                  <strong style={{ color: "#1e40af", minWidth: 110, flexShrink: 0 }}>{f.name}:</strong>
                  <span style={{ color: "#4b5563", fontFamily: "'IBM Plex Mono',monospace" }}>{f.hint}</span>
                </div>
              ))}
            </div>
          )}

          {/* Example */}
          {(aiResult?.full_example || kw.example) && (
            <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6, padding: 10, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#92400e", marginBottom: 4 }}>💡 Example:</div>
              <div style={{ fontSize: 11, fontFamily: "'IBM Plex Mono',monospace", color: "#374151", whiteSpace: "pre-line" }}>
                {aiResult?.full_example || kw.example}
              </div>
            </div>
          )}

          <div style={{ marginTop: 8, fontSize: 11, color: "#9ca3af" }}>
            Action: <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 3 }}>{kw.action}</code>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Advisor Modal ────────────────────────────────────────────────────────
export function KeywordAdvisor({ onClose, projectId }) {
  const [query, setQuery]           = useState("");
  const [searchResults, setSearch]  = useState([]);
  const [aiResults, setAiResults]   = useState(null);
  const [smartResults, setSmartResults] = useState(null);
  const [aiLoading, setAiLoading]   = useState(false);
  const [smartLoading, setSmartLoading] = useState(false);
  const [aiError, setAiError]       = useState("");
  const [smartError, setSmartError] = useState("");
  const [tab, setTab]               = useState("search");
  const inputRef                    = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSearch(query.trim().length > 1 ? smartSearch(query) : []); }, [query]);

  const getHeaders = () => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${localStorage.getItem("autoqa_token") || ""}`
  });
  const API_BASE = window.__API_BASE__ || "http://localhost:6001";

  const askAI = async () => {
    if (!query.trim()) return;
    setAiLoading(true); setAiError(""); setAiResults(null); setTab("ai");
    try {
      const resp = await fetch(`${API_BASE}/api/keyword-advisor`, {
        method: "POST", headers: getHeaders(),
        body: JSON.stringify({ query }),
      });
      if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
      setAiResults(await resp.json());
    } catch (e) { setAiError(`AI request failed: ${e.message}`); }
    setAiLoading(false);
  };

  const askFromTests = async () => {
    if (!query.trim()) return;
    setSmartLoading(true); setSmartError(""); setSmartResults(null); setTab("tests");
    try {
      const resp = await fetch(`${API_BASE}/api/keyword-advisor-smart`, {
        method: "POST", headers: getHeaders(),
        body: JSON.stringify({ query, project_id: projectId }),
      });
      if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
      setSmartResults(await resp.json());
    } catch (e) { setSmartError(`Failed: ${e.message}`); }
    setSmartLoading(false);
  };

  const handleEnter = () => { askFromTests(); askAI(); };

  const mapKeywords = (results) => results?.keywords?.map(r => ({
    kw: KEYWORDS.find(k => k.action === r.action) || { action: r.action, label: r.action, group: "Unknown", description: r.reason, when: "", fields: [] },
    aiResult: r,
  })) || [];

  const EXAMPLES = [
    "run javascript on the page", "get text from element", "extract JSON value",
    "wait for element to appear", "check if element is visible", "get data from database",
    "find item in JSON array", "repeat steps multiple times", "handle errors gracefully",
    "check if checkbox is checked", "switch to iframe", "encode to base64",
  ];

  return (
    <div style={st.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={st.modal}>
        <div style={st.header}>
          <div>
            <div style={{ color: "#fff", fontWeight: 700, fontSize: 16 }}>🤖 Keyword Advisor</div>
            <div style={{ color: "#c7d2fe", fontSize: 12, marginTop: 2 }}>80 keywords — tell me what you want to do</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#fff", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        <div style={st.body}>
          <div style={{ marginBottom: 16 }}>
            <input ref={inputRef} style={st.input}
              placeholder="e.g. get text from element, extract JSON value, switch to iframe..."
              value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleEnter()}
              onFocus={e => e.target.style.borderColor = "#1e40af"}
              onBlur={e => e.target.style.borderColor = "#e5e7eb"} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button style={{ ...st.btn(true), background: "#7c3aed" }} onClick={askFromTests} disabled={smartLoading || !query.trim()}>
                {smartLoading ? "⏳ Searching tests..." : "🧪 From your tests"}
              </button>
              <button style={st.btn(false)} onClick={askAI} disabled={aiLoading || !query.trim()}>
                {aiLoading ? "⏳ Asking AI..." : "🤖 Ask AI"}
              </button>
              <div style={{ fontSize: 12, color: "#9ca3af", alignSelf: "center" }}>or type to search instantly ↑</div>
            </div>
          </div>

          {(searchResults.length > 0 || aiResults || smartResults) && (
            <div style={{ display: "flex", borderBottom: "2px solid #e5e7eb", marginBottom: 16 }}>
              {[
                ["search", `🔍 Search (${searchResults.length})`],
                ["tests", `🧪 From your tests${smartResults ? ` (${smartResults.step_count || 0} patterns)` : ""}`],
                ["ai", "🤖 AI Answer"],
              ].map(([t, label]) => (
                <button key={t} onClick={() => setTab(t)} style={{
                  padding: "8px 14px", border: "none", cursor: "pointer", fontWeight: 600, fontSize: 12,
                  background: "none", marginBottom: -2,
                  borderBottom: tab === t ? "2px solid #1e40af" : "2px solid transparent",
                  color: tab === t ? "#1e40af" : "#6b7280",
                }}>{label}</button>
              ))}
            </div>
          )}

          {tab === "search" && (
            <>
              {searchResults.length === 0 && query.trim().length > 1 && (
                <div style={{ textAlign: "center", color: "#9ca3af", padding: 32 }}>
                  No keywords matched "<strong>{query}</strong>"<br />
                  <span style={{ fontSize: 13 }}>Try 🤖 Ask AI for natural language help</span>
                </div>
              )}
              {searchResults.length === 0 && query.trim().length <= 1 && (
                <div style={{ color: "#6b7280", fontSize: 13 }}>
                  <div style={{ fontWeight: 700, marginBottom: 12 }}>💡 Try asking things like:</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {EXAMPLES.map((ex, i) => (
                      <div key={i} onClick={() => setQuery(ex)}
                        style={{ padding: "5px 10px", borderRadius: 6, cursor: "pointer", background: "#f3f4f6", fontSize: 12 }}>
                        {ex}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {searchResults.map(kw => <KeywordCard key={kw.action} kw={kw} />)}
            </>
          )}

          {tab === "tests" && (
            <>
              {smartLoading && (
                <div style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                  <div>Searching your passed test cases...</div>
                </div>
              )}
              {smartError && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 16, color: "#dc2626" }}>{smartError}</div>
              )}
              {smartResults && (
                <>
                  {/* Summary banner */}
                  <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: 12, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, color: "#7c3aed", fontWeight: 700 }}>
                      🧪 AI read {smartResults.test_count || 0} of your passed tests
                    </div>
                    {smartResults.summary && <div style={{ fontSize: 13, color: "#4b5563", marginTop: 4 }}>{smartResults.summary}</div>}
                  </div>

                  {/* Answers */}
                  {(smartResults.answers || []).length === 0 && (
                    <div style={{ textAlign: "center", color: "#9ca3af", padding: 24, fontSize: 13 }}>
                      No matching steps found in your passed tests. Try 🤖 Ask AI.
                    </div>
                  )}

                  {(smartResults.answers || []).map((answer, ai) => {
                    const kw = KEYWORDS.find(k => k.action === answer.action) || {
                      action: answer.action, label: answer.action, group: "Unknown"
                    };
                    const color = GROUP_COLORS[kw.group] || "#7c3aed";
                    return (
                      <div key={ai} style={{ border: `1px solid ${color}30`, borderLeft: `4px solid ${color}`, borderRadius: 10, padding: 16, marginBottom: 16, background: "#fafafa" }}>

                        {/* Header */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <span style={{ background: color+"20", color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700 }}>{kw.group}</span>
                          <strong style={{ fontSize: 15 }}>{kw.label || answer.action}</strong>
                          {answer.from_test && (
                            <span style={{ marginLeft: "auto", fontSize: 11, background: "#d1fae5", color: "#065f46", padding: "2px 10px", borderRadius: 10, fontWeight: 600 }}>
                              ✅ proven in your tests
                            </span>
                          )}
                        </div>

                        {/* Headline */}
                        <div style={{ fontSize: 13, color: "#374151", marginBottom: 10 }}>{answer.headline}</div>

                        {/* From test badge */}
                        {answer.from_test && (
                          <div style={{ fontSize: 11, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 6, padding: "4px 10px", marginBottom: 12, display: "inline-block" }}>
                            🧪 Based on: "{answer.from_test}"
                          </div>
                        )}

                        {/* Fields — what to select and what to pass */}
                        {answer.fields?.length > 0 && (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#1e40af", marginBottom: 8 }}>📋 How to configure this step:</div>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: "#eff6ff" }}>
                                  <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "20%" }}>Field</th>
                                  <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "30%" }}>What to enter</th>
                                  <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "25%" }}>Proven value</th>
                                  <th style={{ padding: "7px 10px", textAlign: "left", border: "1px solid #bfdbfe", color: "#1e40af", fontWeight: 700, width: "25%" }}>Why</th>
                                </tr>
                              </thead>
                              <tbody>
                                {answer.fields.map((f, fi) => (
                                  <tr key={fi} style={{ background: fi % 2 === 0 ? "#fff" : "#f8faff" }}>
                                    <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", fontWeight: 700, color: "#374151" }}>{f.name}</td>
                                    <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", color: "#4b5563" }}>{f.what_to_select}</td>
                                    <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: "#059669", fontWeight: 600 }}>{f.proven_value}</td>
                                    <td style={{ padding: "7px 10px", border: "1px solid #e0e7ff", fontSize: 11, color: "#6b7280", fontStyle: "italic" }}>{f.why}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Real examples from passed tests */}
                        {answer.real_examples?.length > 0 && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed", marginBottom: 6 }}>
                              🧪 Real examples from your passed tests:
                            </div>
                            {answer.real_examples.map((ex, ei) => (
                              <div key={ei} style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 6, padding: 10, marginBottom: 6 }}>
                                <div style={{ fontSize: 11, color: "#7c3aed", fontWeight: 700, marginBottom: 6 }}>
                                  🧪 {ex.test_name} — <span style={{ color: "#10b981" }}>PASSED ✅</span>
                                </div>
                                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                                  <tbody>
                                    {Object.entries(ex.fields).map(([field, value], fi) => (
                                      <tr key={fi}>
                                        <td style={{ padding: "3px 8px", fontWeight: 600, color: "#374151", width: "30%", borderBottom: "1px solid #e9d5ff" }}>{field}</td>
                                        <td style={{ padding: "3px 8px", fontFamily: "'IBM Plex Mono',monospace", color: "#059669", wordBreak: "break-all", borderBottom: "1px solid #e9d5ff" }}>{value}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            ))}
                          </div>
                        )}
                        {answer.real_examples?.length === 0 && (
                          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 8, fontStyle: "italic" }}>
                            No matching steps found in your passed tests yet — use the example values above to get started.
                          </div>
                        )}

                        {/* Tip */}
                        {answer.tip && (
                          <div style={{ background: "#fef3c7", border: "1px solid #fcd34d", borderRadius: 6, padding: "8px 12px", fontSize: 12, color: "#92400e", marginTop: 8 }}>
                            💡 {answer.tip}
                          </div>
                        )}
                      </div>
                    );
                  })}                
                </>
              )}
              {!smartLoading && !smartResults && (
                <div style={{ textAlign: "center", color: "#9ca3af", padding: 32, fontSize: 13 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🧪</div>
                  Click "🧪 From your tests" to find keyword examples from your recently passed test cases.
                </div>
              )}
            </>
          )}

          {tab === "ai" && (
            <>
              {aiLoading && (
                <div style={{ textAlign: "center", padding: 40, color: "#6b7280" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                  <div>Asking AI for the best keyword...</div>
                </div>
              )}
              {aiError && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 16, color: "#dc2626" }}>{aiError}</div>
              )}
              {aiResults && (
                <>
                  {aiResults.summary && (
                    <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14, color: "#1e40af", fontWeight: 500 }}>
                      💡 {aiResults.summary}
                    </div>
                  )}
                  {mapKeywords(aiResults).map(({ kw, aiResult }, i) => <KeywordCard key={i} kw={kw} aiResult={aiResult} />)}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Floating button ───────────────────────────────────────────────────────────
export function KeywordAdvisorButton({ projectId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Keyword Advisor — Find the right action"
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 9000,
          width: 52, height: 52, borderRadius: "50%", border: "none",
          background: "linear-gradient(135deg, #1e40af, #7c3aed)",
          color: "#fff", fontSize: 22, cursor: "pointer",
          boxShadow: "0 4px 16px rgba(30,64,175,0.5)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>🤖</button>
      {open && <KeywordAdvisor projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  );
}
