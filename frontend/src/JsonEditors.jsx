// @refresh reset
/**
 * ATHMA JSON Step Actions — UI Forms
 * All JSON-related step forms and action definitions.
 * Imported by Editors.jsx with zero modification to existing logic.
 */

import React, { useState } from "react";
import { s } from "./shared.jsx";

// ─── Action definitions (spread into ACTIONS array in Editors.jsx) ─────────────
export const JSON_ACTION_DEFS = [
  { value: "json_extract",       label: "📦 JSON Extract (dot-path)",      group: "JSON" },
  { value: "json_multi_extract", label: "📦 JSON Extract Multi paths",      group: "JSON" },
  { value: "json_array_get",     label: "📦 JSON Array Get (by index)",     group: "JSON" },
  { value: "json_array_length",  label: "📦 JSON Array Length",             group: "JSON" },
  { value: "json_array_filter",  label: "📦 JSON Array Filter (by value)",  group: "JSON" },
  { value: "json_contains",      label: "📦 JSON Contains (assert path)",   group: "JSON" },
  { value: "json_build",         label: "📦 JSON Build object",             group: "JSON" },
  { value: "json_set",           label: "📦 JSON Set value at path",        group: "JSON" },
  { value: "json_stringify",     label: "📦 JSON Stringify",                group: "JSON" },
  { value: "json_keys",          label: "📦 JSON Get keys",                 group: "JSON" },
];

// ─── Shared styles ─────────────────────────────────────────────────────────────
const J = {
  wrap: {
    marginTop: 10, background: "#fffbeb", border: "1px solid #fcd34d",
    borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 10
  },
  header: { fontSize: 12, fontWeight: 700, color: "#92400e" },
  badge: {
    fontSize: 11, background: "#fef3c7", color: "#92400e",
    padding: "2px 8px", borderRadius: 4, fontWeight: 600
  },
  hint: { fontSize: 11, color: "#78716c", marginTop: 2 },
  code: {
    background: "#fef3c7", padding: "1px 5px", borderRadius: 3,
    fontFamily: "'IBM Plex Mono',monospace", fontSize: 11
  },
  mono: { fontFamily: "'IBM Plex Mono',monospace", fontSize: 12 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
};

const Field = ({ label, hint, children }) => (
  <div>
    <label style={s.label}>{label}</label>
    {children}
    {hint && <div style={J.hint}>{hint}</div>}
  </div>
);

const MonoInput = ({ value, onChange, placeholder }) => (
  <input style={{ ...s.input, ...J.mono }} value={value || ""} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
);

const Header = ({ title }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
    <div style={J.header}>📦 {title}</div>
    <span style={J.badge}>JSON</span>
  </div>
);

// ─── Individual Forms ──────────────────────────────────────────────────────────

function JsonExtractForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Extract (dot-path)" />
      <Field label="Source variable (holds the JSON)" hint="e.g. api_response — the variable containing your JSON string">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to extract" hint={<>e.g. <code style={J.code}>patient.mrn</code> or <code style={J.code}>activityTimings.0.status</code> or <code style={J.code}>paymentDetails.invoiceDocument.netAmount</code></>}>
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="patient.mrn" />
      </Field>
      <Field label="Store result into variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="patient_mrn" />
      </Field>
      {step.store_as && (
        <div style={{ background: "#fef3c7", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
          After this step: <code style={J.code}>{`{{${step.store_as}}}`}</code> = value at <code style={J.code}>{step.value2 || "..."}</code>
        </div>
      )}
    </div>
  );
}

function JsonMultiExtractForm({ step, i, updateStep }) {
  const mappings = step.json_mappings || [{ path: "", variable: "" }];
  const setMapping = (idx, key, val) => {
    const next = mappings.map((m, mi) => mi === idx ? { ...m, [key]: val } : m);
    updateStep(i, "json_mappings", next);
  };
  const add = () => updateStep(i, "json_mappings", [...mappings, { path: "", variable: "" }]);
  const remove = (idx) => updateStep(i, "json_mappings", mappings.filter((_, mi) => mi !== idx));

  return (
    <div style={J.wrap}>
      <Header title="JSON Extract Multiple Paths" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <div>
        <div style={J.row}>
          <label style={{ ...s.label, margin: 0 }}>Path → Variable Mappings</label>
          <button onClick={add} style={{ ...s.btn("ghost", true), fontSize: 11, padding: "3px 10px", borderColor: "#d97706", color: "#d97706" }}>+ Add</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 28px", gap: 6, marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", textTransform: "uppercase" }}>Dot-path</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", textTransform: "uppercase" }}>Store into</div>
          <div />
        </div>
        {mappings.map((m, mi) => (
          <div key={mi} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 28px", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <input style={{ ...s.input, margin: 0, ...J.mono }} value={m.path || ""} onChange={e => setMapping(mi, "path", e.target.value)} placeholder={`e.g. patient.mrn`} />
            <input style={{ ...s.input, margin: 0, ...J.mono }} value={m.variable || ""} onChange={e => setMapping(mi, "variable", e.target.value)} placeholder={`e.g. mrn`} />
            <button onClick={() => remove(mi)} disabled={mappings.length === 1}
              style={{ background: "none", border: "none", cursor: "pointer", color: mappings.length === 1 ? "#d1d5db" : "#e53935", fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>
      {mappings.filter(m => m.variable).length > 0 && (
        <div style={{ background: "#fef3c7", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
          <div style={{ fontWeight: 700, color: "#92400e", marginBottom: 3 }}>After this step:</div>
          {mappings.filter(m => m.variable).map((m, mi) => (
            <div key={mi} style={J.mono}><code style={J.code}>{`{{${m.variable}}}`}</code> ← <code style={J.code}>{m.path}</code></div>
          ))}
        </div>
      )}
    </div>
  );
}

function JsonArrayGetForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Array Get (by index)" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to the array" hint={<>e.g. <code style={J.code}>activityTimings</code> or <code style={J.code}>paymentDetails.invoiceDocument.receipts</code></>}>
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="activityTimings" />
      </Field>
      <Field label="Index (0 = first, -1 = last)" hint="Use negative numbers to count from end">
        <MonoInput value={step.value3} onChange={v => updateStep(i, "value3", v)} placeholder="0" />
      </Field>
      <Field label="Store result into variable" hint="Stored as JSON string if the item is an object">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="first_timing" />
      </Field>
      <div style={J.hint}>💡 Then use <strong>JSON Extract</strong> on <code style={J.code}>{`{{${step.store_as || "result"}}}`}</code> to get fields from the item.</div>
    </div>
  );
}

function JsonArrayLengthForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Array Length" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to the array" hint={<>e.g. <code style={J.code}>slots</code> or <code style={J.code}>paymentDetails.invoiceDocument.invoiceItems</code></>}>
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="invoiceItems" />
      </Field>
      <Field label="Store count into variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="item_count" />
      </Field>
      {step.store_as && (
        <div style={{ background: "#fef3c7", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
          After this step: <code style={J.code}>{`{{${step.store_as}}}`}</code> = number of items in array
        </div>
      )}
    </div>
  );
}

function JsonArrayFilterForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Array Filter (find by value)" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to the array" hint={<>e.g. <code style={J.code}>activityTimings</code></>}>
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="activityTimings" />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Where key equals..." hint="Key name inside each array item">
          <MonoInput value={step.value3} onChange={v => updateStep(i, "value3", v)} placeholder="status" />
        </Field>
        <Field label="...this value" hint="Can use {{variables}}">
          <MonoInput value={step.value4} onChange={v => updateStep(i, "value4", v)} placeholder="IN_PROGRESS" />
        </Field>
      </div>
      <Field label="Store matched item into variable" hint="Stored as JSON string — use JSON Extract to get fields from it">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="matched_timing" />
      </Field>
      <Field label="Store matched index into variable (optional)">
        <MonoInput value={step.store_index} onChange={v => updateStep(i, "store_index", v)} placeholder="matched_idx" />
      </Field>
      {(step.value3 && step.value4) && (
        <div style={{ background: "#fef3c7", borderRadius: 6, padding: "6px 10px", fontSize: 11 }}>
          Finds first item where <code style={J.code}>{step.value3}</code> = <code style={J.code}>{step.value4}</code>
          {step.store_as && <> → stored in <code style={J.code}>{`{{${step.store_as}}}`}</code></>}
        </div>
      )}
    </div>
  );
}

function JsonContainsForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Contains (assert path)" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to check" hint="Step fails if path does not exist">
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="consultationStatus" />
      </Field>
      <Field label="Expected value (optional)" hint="Leave blank to just assert the path exists. Fill to assert exact value.">
        <MonoInput value={step.value3} onChange={v => updateStep(i, "value3", v)} placeholder="IN_PROGRESS" />
      </Field>
      <div style={J.hint}>
        💡 This is an <strong>assertion step</strong> — it passes or fails the test.
        {step.value3 ? ` Will assert path '${step.value2}' equals '${step.value3}'.` : ` Will assert path '${step.value2 || "..."}' exists.`}
      </div>
    </div>
  );
}

function JsonBuildForm({ step, i, updateStep }) {
  const mappings = step.json_mappings || [{ key: "", value: "" }];
  const setMapping = (idx, field, val) => {
    const next = mappings.map((m, mi) => mi === idx ? { ...m, [field]: val } : m);
    updateStep(i, "json_mappings", next);
  };
  const add = () => updateStep(i, "json_mappings", [...mappings, { key: "", value: "" }]);
  const remove = (idx) => updateStep(i, "json_mappings", mappings.filter((_, mi) => mi !== idx));

  return (
    <div style={J.wrap}>
      <Header title="JSON Build Object" />
      <Field label="Store built JSON into variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="request_body" />
      </Field>
      <div>
        <div style={J.row}>
          <label style={{ ...s.label, margin: 0 }}>Key → Value Pairs</label>
          <button onClick={add} style={{ ...s.btn("ghost", true), fontSize: 11, padding: "3px 10px", borderColor: "#d97706", color: "#d97706" }}>+ Add</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 28px", gap: 6, marginBottom: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", textTransform: "uppercase" }}>Key</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#78716c", textTransform: "uppercase" }}>Value (supports {'{{'+'vars'+'}}'})</div>
          <div />
        </div>
        {mappings.map((m, mi) => (
          <div key={mi} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 28px", gap: 6, marginBottom: 6, alignItems: "center" }}>
            <input style={{ ...s.input, margin: 0, ...J.mono }} value={m.key || ""} onChange={e => setMapping(mi, "key", e.target.value)} placeholder="mrn" />
            <input style={{ ...s.input, margin: 0, ...J.mono }} value={m.value || ""} onChange={e => setMapping(mi, "value", e.target.value)} placeholder="{{patient_mrn}}" />
            <button onClick={() => remove(mi)} disabled={mappings.length === 1}
              style={{ background: "none", border: "none", cursor: "pointer", color: mappings.length === 1 ? "#d1d5db" : "#e53935", fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>
      <div style={J.hint}>💡 Values that look like numbers, booleans, or JSON will be parsed automatically.</div>
    </div>
  );
}

function JsonSetForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Set value at path" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to set" hint={<>e.g. <code style={J.code}>patient.status</code> or <code style={J.code}>consultationStatus</code></>}>
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="patient.status" />
      </Field>
      <Field label="New value" hint="Can use {{variables}}. JSON objects/arrays will be parsed automatically.">
        <MonoInput value={step.value3} onChange={v => updateStep(i, "value3", v)} placeholder="ARRIVED" />
      </Field>
      <Field label="Store updated JSON into variable" hint="Leave blank to overwrite the same source variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder={step.value || "updated_json"} />
      </Field>
    </div>
  );
}

function JsonStringifyForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Stringify" />
      <Field label="Source variable to stringify">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="my_object" />
      </Field>
      <Field label="Format">
        <select style={s.input} value={step.value2 || "compact"} onChange={e => updateStep(i, "value2", e.target.value)}>
          <option value="compact">Compact (single line)</option>
          <option value="pretty">Pretty (indented)</option>
        </select>
      </Field>
      <Field label="Store result into variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="json_string" />
      </Field>
    </div>
  );
}

function JsonKeysForm({ step, i, updateStep }) {
  return (
    <div style={J.wrap}>
      <Header title="JSON Get Keys" />
      <Field label="Source variable (holds the JSON)">
        <MonoInput value={step.value} onChange={v => updateStep(i, "value", v)} placeholder="api_response" />
      </Field>
      <Field label="Dot-path to object (optional)" hint="Leave blank for root object keys">
        <MonoInput value={step.value2} onChange={v => updateStep(i, "value2", v)} placeholder="patient" />
      </Field>
      <Field label="Store comma-separated keys into variable">
        <MonoInput value={step.store_as} onChange={v => updateStep(i, "store_as", v)} placeholder="object_keys" />
      </Field>
      <div style={J.hint}>💡 Result will be like: <code style={J.code}>id, mrn, fullName, gender, ageDTO, ...</code></div>
    </div>
  );
}

// ─── Main dispatcher form ──────────────────────────────────────────────────────
export function JsonStepForm({ step, i, updateStep }) {
  const action = step.action;
  const props = { step, i, updateStep };

  if (action === "json_extract")       return <JsonExtractForm {...props} />;
  if (action === "json_multi_extract") return <JsonMultiExtractForm {...props} />;
  if (action === "json_array_get")     return <JsonArrayGetForm {...props} />;
  if (action === "json_array_length")  return <JsonArrayLengthForm {...props} />;
  if (action === "json_array_filter")  return <JsonArrayFilterForm {...props} />;
  if (action === "json_contains")      return <JsonContainsForm {...props} />;
  if (action === "json_build")         return <JsonBuildForm {...props} />;
  if (action === "json_set")           return <JsonSetForm {...props} />;
  if (action === "json_stringify")     return <JsonStringifyForm {...props} />;
  if (action === "json_keys")          return <JsonKeysForm {...props} />;
  return null;
}
