import React, { useState, useEffect, useRef, useCallback } from "react";
import { api, s, APP_PAGE_SIZE, C, Badge, Empty, getToken, API, WS } from "./shared.jsx";
import { StepEditor, ACTIONS, ACTION_GROUPS, VAR_TYPES, API_ASSERTIONS } from "./Editors.jsx";

const CRON_PRESETS = [
  { label:"Every hour",    value:"0 * * * *" },
  { label:"Every 6 hours", value:"0 */6 * * *" },
  { label:"Daily 9am",     value:"0 9 * * *" },
  { label:"Daily midnight",value:"0 0 * * *" },
  { label:"Every Monday",  value:"0 9 * * 1" },
];

function Schedules({ suites, projects, user }) {
  const [schedules,  setSchedules]  = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [tests,      setTests]      = useState([]); // lazy-loaded when modal opens
  const [modal,      setModal]      = useState(false);
  const [delConfirm, setDelConfirm] = useState(null);
  const [form,       setForm]       = useState({
    schedule_type: "suite",
    suite_id:      "",
    test_case_id:  "",
    cron_expr:     "0 9 * * *",
    label:         "",
    browser:       "chrome",
    notify_email:  "",
  });
  const [saving, setSaving] = useState(false);
  const [cronErr, setCronErr] = useState("");

  const isSA = user?.id === 1 || user?.uid === 1 || user?.role === 'superadmin';
  const openModal = () => {
    // Lazy-load tests only when modal opens and schedule type is "test"
    if (tests.length === 0) {
      api("/api/tests?limit=500").then(r => setTests(Array.isArray(r) ? r : (r?.rows||[]))).catch(()=>{});
    }
    setModal(true);
  };

  const canManage = isSA || ["admin","lead"].includes(user?.role);

  const load = async () => {
    setLoading(true);
    try { setSchedules(await api("/api/schedules")); }
    catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Cron presets
  const PRESETS = [
    { label:"Every day at 9 AM",   cron:"0 9 * * *"   },
    { label:"Every day at 6 PM",   cron:"0 18 * * *"  },
    { label:"Every hour",          cron:"0 * * * *"   },
    { label:"Every 30 minutes",    cron:"*/30 * * * *" },
    { label:"Mon–Fri at 8 AM",     cron:"0 8 * * 1-5" },
    { label:"Every Sunday 2 AM",   cron:"0 2 * * 0"   },
    { label:"First of month 1 AM", cron:"0 1 1 * *"   },
  ];

  // Human-readable cron
  const describeCron = (expr) => {
    const found = PRESETS.find(p => p.cron === expr);
    if (found) return found.label;
    const parts = expr.split(" ");
    if (parts.length !== 5) return expr;
    const [min, hr, dom, mon, dow] = parts;
    if (dom==="*" && mon==="*" && dow==="*") {
      if (hr==="*") return `Every hour at :${min.padStart(2,"0")}`;
      if (hr.startsWith("*/")) return `Every ${hr.slice(2)} hours`;
      if (min.startsWith("*/")) return `Every ${min.slice(2)} minutes`;
      return `Daily at ${hr.padStart(2,"0")}:${min.padStart(2,"0")}`;
    }
    if (dow !== "*") {
      const days = {0:"Sun",1:"Mon",2:"Tue",3:"Wed",4:"Thu",5:"Fri",6:"Sat"};
      return `${days[dow]||dow} at ${hr}:${min.padStart(2,"0")}`;
    }
    return expr;
  };

  const validateCron = (expr) => {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) { setCronErr("Must have 5 parts: min hour day month weekday"); return false; }
    setCronErr("");
    return true;
  };

  const save = async () => {
    if (!validateCron(form.cron_expr)) return;
    if (form.schedule_type === "suite"  && !form.suite_id)     { alert("Select a test suite"); return; }
    if (form.schedule_type === "test"   && !form.test_case_id) { alert("Select a test case"); return; }
    setSaving(true);
    try {
      await api("/api/schedules", { method:"POST", body: {
        ...form,
        suite_id:     form.suite_id     ? parseInt(form.suite_id)     : null,
        test_case_id: form.test_case_id ? parseInt(form.test_case_id) : null,
      }});
      setModal(false);
      setForm({ schedule_type:"suite", suite_id:"", test_case_id:"", cron_expr:"0 9 * * *", label:"", browser:"chrome", notify_email:"" });
      load();
    } catch(e) { alert(e.message); }
    finally { setSaving(false); }
  };

  const toggle = async (id, active) => {
    try { await api(`/api/schedules/${id}`, { method:"PATCH", body:{ active } }); load(); }
    catch(e) { alert(e.message); }
  };

  const del = async (id) => {
    try { await api(`/api/schedules/${id}`, { method:"DELETE" }); setDelConfirm(null); load(); }
    catch(e) { alert(e.message); }
  };

  // Group suites by project
  const suitesByProject = (projects||[]).map(p => ({
    ...p,
    suites: (suites||[]).filter(s => String(s.project_id) === String(p.id))
  })).filter(p => p.suites.length > 0);

  return (
    <div style={{ padding:"20px 24px" }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:"#8B0000" }}>⏰ Schedules</div>
          <div style={{ fontSize:13, color:"#8a96a8", marginTop:2 }}>
            Automatically run test suites or individual tests on a schedule
          </div>
        </div>
        {canManage && (
          <button style={s.btn("primary")} onClick={openModal}>
            + New Schedule
          </button>
        )}
      </div>

      {/* Schedule list */}
      <div style={{ background:"#fff", border:"1px solid #e2e6ed", borderRadius:12, overflow:"hidden" }}>
        {loading ? (
          <div style={{ padding:40, textAlign:"center", color:"#8a96a8" }}>Loading...</div>
        ) : schedules.length === 0 ? (
          <div style={{ padding:48, textAlign:"center" }}>
            <div style={{ fontSize:40, marginBottom:12 }}>⏰</div>
            <div style={{ fontSize:15, fontWeight:600, color:"#4a5568", marginBottom:6 }}>No schedules yet</div>
            <div style={{ fontSize:13, color:"#8a96a8" }}>
              Create a schedule to automatically run your test suites
            </div>
          </div>
        ) : (
          <table style={{ width:"100%", borderCollapse:"collapse" }}>
            <thead>
              <tr style={{ background:"#f8f9fc", borderBottom:"1px solid #e2e6ed" }}>
                {["Type","Name","Schedule","Browser","Status","Last Run","Next Run",""].map(h => (
                  <th key={h} style={{ ...s.th, textAlign:"left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedules.map(sc => (
                <tr key={sc.id} style={{ borderBottom:"1px solid #f0f2f5" }}>

                  {/* Type badge */}
                  <td style={s.td}>
                    <span style={{ fontSize:11, fontWeight:700, padding:"3px 8px", borderRadius:4,
                      background: sc.schedule_type==="suite"?"#f5f0ff":"#f0f7ff",
                      color:      sc.schedule_type==="suite"?"#6b46c1":"#1a6fc4",
                      border:     `1px solid ${sc.schedule_type==="suite"?"#d6bcfa":"#bdd7f5"}` }}>
                      {sc.schedule_type==="suite" ? "🗂️ Suite" : "🧪 Test"}
                    </span>
                  </td>

                  {/* Name */}
                  <td style={{ ...s.td }}>
                    <div style={{ fontWeight:600, color:"#1a2332", fontSize:13 }}>
                      {sc.schedule_type==="suite" ? sc.suite_name : sc.test_name}
                    </div>
                    {sc.label && (
                      <div style={{ fontSize:11, color:"#8a96a8", marginTop:2 }}>{sc.label}</div>
                    )}
                    {sc.notify_email && (
                      <div style={{ fontSize:11, color:"#38a169", marginTop:3 }}>
                        ✉ {sc.notify_email}
                      </div>
                    )}
                  </td>

                  {/* Cron */}
                  <td style={s.td}>
                    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                      color:"#1a6fc4", marginBottom:2 }}>{sc.cron_expr}</div>
                    <div style={{ fontSize:11, color:"#8a96a8" }}>{describeCron(sc.cron_expr)}</div>
                  </td>

                  {/* Browser */}
                  <td style={{ ...s.td, fontSize:12, color:"#4a5568", fontFamily:"'IBM Plex Mono',monospace" }}>
                    {sc.browser}
                  </td>

                  {/* Status */}
                  <td style={s.td}>
                    <span style={{ display:"inline-flex", alignItems:"center", gap:5,
                      fontSize:12, fontWeight:700,
                      color: sc.active ? "#00a86b" : "#8a96a8" }}>
                      <span style={{ width:7, height:7, borderRadius:"50%",
                        background: sc.active?"#00a86b":"#cbd5e0",
                        display:"inline-block",
                        boxShadow: sc.active?"0 0 0 3px #00a86b20":"none" }} />
                      {sc.active ? "ACTIVE" : "PAUSED"}
                    </span>
                  </td>

                  {/* Last run */}
                  <td style={{ ...s.td, fontSize:11, color:"#8a96a8" }}>
                    {sc.last_run_at
                      ? new Date(sc.last_run_at).toLocaleString()
                      : <span style={{ color:"#cbd5e0" }}>Never</span>}
                  </td>

                  {/* Next run (approximate) */}
                  <td style={{ ...s.td, fontSize:11, color:"#8a96a8" }}>
                    {sc.active ? "Calculated by server" : "—"}
                  </td>

                  {/* Actions */}
                  <td style={s.td}>
                    {canManage && (
                      <div style={{ display:"flex", gap:6 }}>
                        <button
                          onClick={()=>toggle(sc.id, !sc.active)}
                          style={{ ...s.btn(sc.active?"warn":"success", true), fontSize:11 }}>
                          {sc.active ? "Pause" : "Resume"}
                        </button>
                        <button
                          onClick={()=>setDelConfirm(sc.id)}
                          style={{ ...s.btn("danger", true), fontSize:11 }}>
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Cron reference */}
      <div style={{ marginTop:16, background:"#f8f9fc", border:"1px solid #e2e6ed",
        borderRadius:10, padding:"12px 16px" }}>
        <div style={{ fontSize:12, fontWeight:700, color:"#4a5568", marginBottom:8 }}>
          ⏰ Cron Expression Reference
        </div>
        <div style={{ display:"flex", gap:24, flexWrap:"wrap", fontSize:12, color:"#8a96a8",
          fontFamily:"'IBM Plex Mono',monospace" }}>
          {PRESETS.slice(0,5).map(p => (
            <div key={p.cron}><span style={{ color:"#1a6fc4" }}>{p.cron}</span>  {p.label}</div>
          ))}
        </div>
        <div style={{ marginTop:6, fontSize:11, color:"#a0aec0" }}>
          Format: minute hour day-of-month month day-of-week &nbsp;·&nbsp;
          * = any &nbsp;·&nbsp; */5 = every 5 &nbsp;·&nbsp; 1-5 = Mon–Fri
        </div>
      </div>

      {/* ── Add Schedule Modal ── */}
      {modal && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div style={{ ...s.modalBox, maxWidth:520 }}>
            <div style={{ fontSize:17, fontWeight:700, color:"#1a2332", marginBottom:20 }}>
              ⏰ New Schedule
            </div>

            {/* Schedule type toggle */}
            <div style={{ marginBottom:16 }}>
              <label style={s.label}>Schedule Type</label>
              <div style={{ display:"flex", gap:0, border:"1px solid #e2e6ed", borderRadius:8, overflow:"hidden" }}>
                {[["suite","🗂️ Test Suite"],["test","🧪 Single Test"]].map(([val,lbl]) => (
                  <button key={val} onClick={()=>setF("schedule_type",val)}
                    style={{ flex:1, padding:"10px 0", border:"none", cursor:"pointer", fontSize:13, fontWeight:600,
                      background: form.schedule_type===val ? "#1a6fc4" : "#fff",
                      color:      form.schedule_type===val ? "#fff"    : "#4a5568",
                      transition:"all 0.15s" }}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Suite picker */}
            {form.schedule_type === "suite" && (
              <div style={{ marginBottom:16 }}>
                <label style={s.label}>Test Suite *</label>
                <select style={s.input} value={form.suite_id} onChange={e=>setF("suite_id",e.target.value)}>
                  <option value="">— Select a suite —</option>
                  {suitesByProject.map(p => (
                    <optgroup key={p.id} label={p.name}>
                      {p.suites.map(su => (
                        <option key={su.id} value={su.id}>
                          {su.name} ({su.test_count||0} tests)
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  {/* Suites without project grouping fallback */}
                  {suitesByProject.length===0 && (suites||[]).map(su=>(
                    <option key={su.id} value={su.id}>{su.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Test case picker */}
            {form.schedule_type === "test" && (
              <div style={{ marginBottom:16 }}>
                <label style={s.label}>Test Case *</label>
                <select style={s.input} value={form.test_case_id} onChange={e=>setF("test_case_id",e.target.value)}>
                  <option value="">— Select a test case —</option>
                  {(tests||[]).map(t=>(
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Label */}
            <div style={{ marginBottom:16 }}>
              <label style={s.label}>Label <span style={{ fontWeight:400, color:"#8a96a8" }}>(optional)</span></label>
              <input style={s.input} value={form.label}
                placeholder="e.g. Nightly regression, Morning smoke test"
                onChange={e=>setF("label",e.target.value)} />
            </div>

            {/* Cron */}
            <div style={{ marginBottom:16 }}>
              <label style={s.label}>Schedule (cron expression) *</label>

              {/* Presets */}
              <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:8 }}>
                {PRESETS.map(p => (
                  <button key={p.cron} onClick={()=>{ setF("cron_expr",p.cron); setCronErr(""); }}
                    style={{ ...s.btn("ghost",true), fontSize:11,
                      background: form.cron_expr===p.cron?"#e8f4ff":"",
                      borderColor: form.cron_expr===p.cron?"#1a6fc4":"",
                      color:       form.cron_expr===p.cron?"#1a6fc4":"#4a5568" }}>
                    {p.label}
                  </button>
                ))}
              </div>

              <input style={{ ...s.input, fontFamily:"'IBM Plex Mono',monospace",
                borderColor: cronErr?"#e53e3e":"" }}
                value={form.cron_expr}
                placeholder="0 9 * * *"
                onChange={e=>{ setF("cron_expr",e.target.value); validateCron(e.target.value); }} />
              {cronErr
                ? <div style={{ fontSize:11, color:"#e53e3e", marginTop:4 }}>{cronErr}</div>
                : <div style={{ fontSize:11, color:"#8a96a8", marginTop:4 }}>
                    → {describeCron(form.cron_expr)}
                  </div>
              }
            </div>

            {/* Browser */}
            <div style={{ marginBottom:20 }}>
              <label style={s.label}>Browser</label>
              <select style={s.input} value={form.browser} onChange={e=>setF("browser",e.target.value)}>
                {["chrome","firefox","edge","safari"].map(b=>(
                  <option key={b} value={b}>{b.charAt(0).toUpperCase()+b.slice(1)}</option>
                ))}
              </select>
            </div>

            {/* Notify Email */}
            <div style={{ marginBottom:20 }}>
              <label style={s.label}>
                Notify Email
                <span style={{ fontWeight:400, color:"#8a96a8", marginLeft:6 }}>
                  (optional — receive HTML report after suite run)
                </span>
              </label>
              <input style={s.input}
                type="email"
                placeholder="e.g. qa-team@narayanahealth.org"
                value={form.notify_email||""}
                onChange={e=>setF("notify_email", e.target.value)} />
              {form.notify_email && (
                <div style={{ fontSize:11, color:"#38a169", marginTop:4 }}>
                  ✉ Report will be emailed to {form.notify_email} after each run
                </div>
              )}
            </div>

            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={s.btn("ghost")} onClick={()=>setModal(false)}>Cancel</button>
              <button style={s.btn("primary")} onClick={save} disabled={saving}>
                {saving ? "Saving..." : "⏰ Create Schedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {delConfirm && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setDelConfirm(null)}>
          <div style={{ ...s.modalBox, maxWidth:380, textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>🗑️</div>
            <div style={{ fontSize:16, fontWeight:700, color:"#1a2332", marginBottom:8 }}>Delete Schedule?</div>
            <div style={{ fontSize:13, color:"#8a96a8", marginBottom:20 }}>
              The schedule will be removed. Existing test runs won't be affected.
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
              <button style={s.btn("ghost")} onClick={()=>setDelConfirm(null)}>Cancel</button>
              <button style={s.btn("danger")} onClick={()=>del(delConfirm)}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── TEST DATA GENERATOR ─────────────────────────────────────────────────────
function TestDataGenerator({ projects }) {
  const [formDesc,     setFormDesc]    = useState("");
  const [profile,      setProfile]     = useState("realistic");
  const [count,        setCount]       = useState(5);
  const [screenshot,   setScreenshot]  = useState(null);
  const [generating,   setGenerating]  = useState(false);
  const [result,       setResult]      = useState(null);
  const [error,        setError]       = useState("");
  const [selectedRows, setSelectedRows]= useState(new Set());
  const fileRef = useRef(null);

  const profiles = [
    { value:"realistic",  label:"Realistic",      icon:"✅", desc:"Valid, production-like data" },
    { value:"edge_cases", label:"Edge Cases",      icon:"⚠️", desc:"Empty, max-length, special chars" },
    { value:"boundary",   label:"Boundary Values", icon:"📐", desc:"Min/max values, date limits" },
    { value:"invalid",    label:"Invalid Data",    icon:"❌", desc:"Wrong formats, validation testing" },
    { value:"mixed",      label:"Mixed",           icon:"🔀", desc:"Combination of all profiles" },
  ];

  const onScreenshot = (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = e => setScreenshot({ base64: e.target.result.split(",")[1], preview: e.target.result, name: file.name });
    reader.readAsDataURL(file);
  };

  const generate = async () => {
    if (!formDesc.trim() && !screenshot) return setError("Please describe the form or upload a screenshot");
    setGenerating(true); setError(""); setResult(null);
    try {
      const r = await api("/api/ai/generate-test-data", {
        method: "POST",
        body: { form_description: formDesc, profile, count, screenshot_base64: screenshot?.base64 || null }
      });
      setResult(r);
      setSelectedRows(new Set()); // default unchecked — user picks rows
    } catch(e) { setError(e.message); }
    setGenerating(false);
  };

  const downloadCSV = () => {
    if (!result?.data?.length) return;
    const rows = result.data.filter((_,i)=>selectedRows.has(i));
    if (!rows.length) return;
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(","),
      ...rows.map(r => headers.map(h => `"${String(r[h]||"").replace(/"/g,'""')}"`).join(","))
    ].join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = `test_data_${Date.now()}.csv`;
    a.click();
  };

  const fields = result?.data?.length ? Object.keys(result.data[0]) : [];

  return (
    <div style={{ display:"flex", gap:20 }}>
      {/* ── Left panel ─────────────────────────────────────────────── */}
      <div style={{ width:340, flexShrink:0 }}>
        <div style={{ ...s.card, marginBottom:14 }}>
          <div style={{ fontSize:15, fontWeight:700, color:"#1a2332", marginBottom:16 }}>
            🧬 Generate Test Data
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={s.label}>Describe the form / feature *</label>
            <textarea
              style={{ ...s.input, height:90, resize:"vertical", fontSize:12, lineHeight:1.6 }}
              value={formDesc} onChange={e=>setFormDesc(e.target.value)}
              placeholder={"e.g. Patient registration form with fields:\n- Full name (Indian names)\n- Date of birth\n- Mobile number\n- Blood group"} />
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={s.label}>Form screenshot (optional)</label>
            {screenshot ? (
              <div style={{ position:"relative" }}>
                <img src={screenshot.preview} alt="form"
                  style={{ width:"100%", maxHeight:100, objectFit:"cover",
                    borderRadius:6, border:"1px solid #e2e6ed" }} />
                <button onClick={()=>setScreenshot(null)}
                  style={{ position:"absolute", top:4, right:4, background:"#fff",
                    border:"1px solid #e2e6ed", borderRadius:4, cursor:"pointer",
                    fontSize:11, padding:"2px 6px", color:"#e53935" }}>✕</button>
              </div>
            ) : (
              <div onClick={()=>fileRef.current?.click()}
                style={{ border:"2px dashed #e2e6ed", borderRadius:8, padding:"14px",
                  textAlign:"center", cursor:"pointer", color:"#8a96a8", fontSize:12,
                  background:"#f8f9fc" }}>
                📷 Click to upload screenshot
                <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }}
                  onChange={e=>onScreenshot(e.target.files[0])} />
              </div>
            )}
          </div>

          <div style={{ marginBottom:14 }}>
            <label style={s.label}>Data Profile</label>
            <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
              {profiles.map(p => (
                <label key={p.value} onClick={()=>setProfile(p.value)}
                  style={{ display:"flex", alignItems:"center", gap:10,
                    padding:"7px 10px", borderRadius:7, cursor:"pointer",
                    background:profile===p.value?"#eff6ff":"#f8f9fc",
                    border:`1.5px solid ${profile===p.value?"#1a6fc4":"#e2e6ed"}` }}>
                  <input type="radio" checked={profile===p.value} readOnly
                    style={{ accentColor:"#1a6fc4" }} />
                  <div>
                    <div style={{ fontSize:12, fontWeight:600,
                      color:profile===p.value?"#1a6fc4":"#1a2332" }}>
                      {p.icon} {p.label}
                    </div>
                    <div style={{ fontSize:10, color:"#8a96a8" }}>{p.desc}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom:16 }}>
            <label style={s.label}>Number of rows: <b>{count}</b></label>
            <input type="range" min={1} max={20} value={count}
              onChange={e=>setCount(+e.target.value)}
              style={{ width:"100%", accentColor:"#1a6fc4" }} />
            <div style={{ display:"flex", justifyContent:"space-between",
              fontSize:10, color:"#8a96a8" }}>
              <span>1</span><span>20</span>
            </div>
          </div>

          {error && (
            <div style={{ background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca",
              borderRadius:6, padding:"8px 12px", fontSize:12, marginBottom:12 }}>
              {error}
            </div>
          )}

          <button onClick={generate} disabled={generating}
            style={{ ...s.btn("primary"), width:"100%", padding:"11px",
              fontSize:13, fontWeight:700,
              background:generating?"#94a3b8":"linear-gradient(135deg,#1a6fc4,#7c3aed)" }}>
            {generating ? "⏳ Generating..." : "✨ Generate Test Data"}
          </button>
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────── */}
      <div style={{ flex:1, minWidth:0 }}>
        {!result && !generating && (
          <div style={{ ...s.card, textAlign:"center", padding:"60px 24px", color:"#8a96a8" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>🧬</div>
            <div style={{ fontSize:16, fontWeight:700, color:"#1a2332", marginBottom:8 }}>
              AI Test Data Generator
            </div>
            <div style={{ fontSize:13, lineHeight:1.7, maxWidth:380, margin:"0 auto" }}>
              Describe your form and select a profile.
              AI generates realistic data ready for use as{" "}
              <code style={{background:"#f0f2f5",padding:"1px 6px",
                borderRadius:3,fontFamily:"monospace"}}>{"{{variable}}"}</code>{" "}
              values in your test steps.
            </div>
          </div>
        )}

        {generating && (
          <div style={{ ...s.card, textAlign:"center", padding:"60px 24px" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>⏳</div>
            <div style={{ fontSize:15, fontWeight:600, color:"#1a2332", marginBottom:6 }}>
              Generating {count} data set{count!==1?"s":""}...
            </div>
            <div style={{ fontSize:12, color:"#8a96a8" }}>
              {profiles.find(p=>p.value===profile)?.label} profile
            </div>
          </div>
        )}

        {result && (
          <>
            {/* Data table card */}
            <div style={{ ...s.card, marginBottom:14 }}>
              <div style={{ display:"flex", justifyContent:"space-between",
                alignItems:"center", marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:700, color:"#1a2332" }}>
                    ✅ {result.data.length} rows generated
                  </div>
                  <div style={{ fontSize:11, color:"#8a96a8", marginTop:2 }}>
                    {fields.length} field{fields.length!==1?"s":""} · {selectedRows.size} rows selected
                  </div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={()=>setSelectedRows(new Set(result.data.map((_,i)=>i)))}
                    style={{ ...s.btn("ghost",true), fontSize:11 }}>All</button>
                  <button onClick={()=>setSelectedRows(new Set())}
                    style={{ ...s.btn("ghost",true), fontSize:11 }}>None</button>
                  <button onClick={downloadCSV} disabled={!selectedRows.size}
                    style={{ ...s.btn("ghost",true), fontSize:11 }}>⬇ CSV</button>
                </div>
              </div>

              {result.notes && (
                <div style={{ background:"#eff6ff", border:"1px solid #bdd7f5",
                  borderRadius:7, padding:"9px 13px", marginBottom:12,
                  fontSize:12, color:"#1a6fc4" }}>
                  💡 {result.notes}
                </div>
              )}

              <div style={{ overflowX:"auto", overflowY:"auto", maxHeight:320, border:"1px solid #e5e7eb", borderRadius:8 }}>
                <table style={{ ...s.table, fontSize:12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...s.th, width:32, position:"sticky", top:0, zIndex:2, background:"#f8f9fc" }}>
                        <input type="checkbox"
                          checked={selectedRows.size===result.data.length}
                          onChange={e=>setSelectedRows(e.target.checked
                            ? new Set(result.data.map((_,i)=>i)) : new Set())} />
                      </th>
                      <th style={{ ...s.th, width:36, position:"sticky", top:0, zIndex:2, background:"#f8f9fc" }}>#</th>
                      {fields.map(f=>(
                        <th key={f} style={{ ...s.th, position:"sticky", top:0, zIndex:2, background:"#f8f9fc" }}>
                          <div>{f}</div>
                          <div style={{ fontSize:9, color:"#8a96a8", fontWeight:400,
                            fontFamily:"monospace" }}>{"{{"}{f}{"}}"}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.map((row,i)=>(
                      <tr key={i}
                        onClick={()=>setSelectedRows(prev=>{
                          const n=new Set(prev); n.has(i)?n.delete(i):n.add(i); return n;
                        })}
                        style={{ background:selectedRows.has(i)?"#f0f7ff":"#fff",
                          cursor:"pointer", borderBottom:"1px solid #f3f4f6" }}>
                        <td style={{ ...s.td, textAlign:"center" }}>
                          <input type="checkbox" checked={selectedRows.has(i)} readOnly />
                        </td>
                        <td style={{ ...s.td, color:"#8a96a8", fontWeight:600 }}>{i+1}</td>
                        {fields.map(f=>(
                          <td key={f} style={{ ...s.td, maxWidth:150, overflow:"hidden",
                            textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                            title={String(row[f]||"")}>
                            {row[f]===""||row[f]===null
                              ? <em style={{color:"#d1d5db"}}>empty</em>
                              : String(row[f])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Inject into Test Case card */}
            <SaveToTestCase
              fields={fields}
              data={result.data}
              selectedRows={[...selectedRows]}
              projects={projects}
              profile={profile}
              onDownloadCSV={downloadCSV}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ─── SAVE TO TEST CASE ────────────────────────────────────────────────────────
function SaveToTestCase({ fields, data, selectedRows: selectedRowsArr, projects, profile, onDownloadCSV }) {
  // selectedRowsArr is an array of selected indices passed from parent
  const selectedRows = new Set(selectedRowsArr);
  const [saveProjectId, setSaveProjectId] = useState("");
  const [saveTestId,    setSaveTestId]    = useState("");
  const [tcTests,       setTcTests]       = useState([]);
  const [selCols,       setSelCols]       = useState(new Set());
  const [conflicts,     setConflicts]     = useState([]);
  const [saving,        setSaving]        = useState(false);
  const [saveMsg,       setSaveMsg]       = useState("");
  const [saveErr,       setSaveErr]       = useState("");

  // Default: no columns selected — user picks which ones to save
  useEffect(() => {
    setSelCols(new Set());
    setSaveMsg(""); setSaveErr("");
  }, [fields.join(",")]);

  // Load test cases when project changes
  useEffect(() => {
    if (!saveProjectId) { setTcTests([]); setSaveTestId(""); return; }
    api(`/api/tests?project_id=${saveProjectId}&limit=500`)
      .then(r => setTcTests(Array.isArray(r)?r:(r?.rows||[])))
      .catch(()=>setTcTests([]));
  }, [saveProjectId]);

  // Detect conflicts: selected columns that already exist in the chosen test case
  useEffect(() => {
    setSaveMsg(""); setSaveErr("");
    if (!saveTestId) { setConflicts([]); return; }
    const tc = tcTests.find(t=>String(t.id)===String(saveTestId));
    if (!tc) { setConflicts([]); return; }
    const existing = new Set((tc.variables||[]).map(v=>v.name));
    setConflicts([...selCols].filter(f=>existing.has(f)));
  }, [saveTestId, [...selCols].sort().join(","), tcTests.length]);

  const toggleCol = (f) => setSelCols(prev => {
    const n = new Set(prev); n.has(f)?n.delete(f):n.add(f); return n;
  });

  const save = async () => {
    setSaveErr(""); setSaveMsg("");
    if (!saveTestId)      return setSaveErr("Select a test case");
    if (!selCols.size)    return setSaveErr("Select at least one column to save");
    if (!selectedRowsArr.length) return setSaveErr("Select at least one data row from the table");
    if (conflicts.length > 0)
      return setSaveErr(`Resolve conflicts first: ${conflicts.join(", ")}`);

    // Get the first checked row directly from the array prop
    const firstIdx = selectedRowsArr[0];
    const firstRow = data[firstIdx];
    if (!firstRow) return setSaveErr("Row not found — try selecting a row again");

    setSaving(true);
    try {
      // Fetch full TC to get current variables + steps
      const tc = await api(`/api/tests/${saveTestId}`);
      if (!tc?.id) { setSaveErr("Test case not found"); setSaving(false); return; }

      // Build variables — field name is the key, value from firstRow
      const existingNames = new Set((tc.variables||[]).map(v=>v.name));
      const newVars = [];
      for (const field of selCols) {
        const safeName = field.replace(/[^a-zA-Z0-9_]/g,"_").replace(/^[0-9]/,"_$&");
        if (!safeName || existingNames.has(safeName)) continue;
        const val = firstRow[field] !== undefined && firstRow[field] !== null
          ? String(firstRow[field]) : "";
        newVars.push({ name: safeName, type: "fixed", config: val });
      }

      if (!newVars.length) {
        setSaveErr("Nothing to save — all selected columns already exist as variables");
        setSaving(false); return;
      }

      const merged = [...(tc.variables||[]), ...newVars];
      await api(`/api/tests/${saveTestId}`, {
        method: "PUT",
        body: {
          name: tc.name, description: tc.description||"",
          type: tc.type||"ui", browser: tc.browser||"chrome",
          base_url: tc.base_url||"", steps: tc.steps||[],
          variables: merged,
          api_config: tc.api_config||null,
          tags: Array.isArray(tc.tags)?tc.tags:[],
          priority: tc.priority||"medium",
          suite_id: tc.suite_id||null,
          module_id: tc.module_id||null,
        }
      });
      setSaveMsg(`✅ Saved ${newVars.length} variable${newVars.length!==1?"s":""} into "${tc.name}"`);
    } catch(e) { setSaveErr(e.message); }
    setSaving(false);
  };

  const selectedTc = tcTests.find(t=>String(t.id)===String(saveTestId));
  const existingVarNames = new Set((selectedTc?.variables||[]).map(v=>v.name));

  return (
    <div style={{ ...s.card }}>
      <div style={{ fontSize:14, fontWeight:700, color:"#1a2332", marginBottom:14 }}>
        💉 Inject into Test Case Variables
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
        <div>
          <label style={s.label}>Project</label>
          <select style={s.input} value={saveProjectId}
            onChange={e=>{ setSaveProjectId(e.target.value); setSaveTestId(""); }}>
            <option value="">— Select project —</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label style={s.label}>Test Case</label>
          <select style={s.input} value={saveTestId}
            onChange={e=>setSaveTestId(e.target.value)}
            disabled={!saveProjectId}>
            <option value="">— Select test case —</option>
            {tcTests.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      </div>

      {/* Column selector */}
      {fields.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ display:"flex", justifyContent:"space-between",
            alignItems:"center", marginBottom:8 }}>
            <label style={s.label}>Select columns to inject ({selCols.size}/{fields.length})</label>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={()=>setSelCols(new Set(fields))}
                style={{ ...s.btn("ghost",true), fontSize:10, padding:"2px 8px" }}>All</button>
              <button onClick={()=>setSelCols(new Set())}
                style={{ ...s.btn("ghost",true), fontSize:10, padding:"2px 8px" }}>None</button>
            </div>
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
            {fields.map(f => {
              const isConflict = existingVarNames.has(f);
              const isSelected = selCols.has(f);
              return (
                <div key={f}
                  onClick={()=>toggleCol(f)}
                  style={{ display:"flex", alignItems:"center", gap:6,
                    padding:"6px 12px", borderRadius:20, cursor:"pointer",
                    background: isConflict
                      ? (isSelected?"#fef2f2":"#f9fafb")
                      : (isSelected?"#eff6ff":"#f8f9fc"),
                    border:`1.5px solid ${
                      isConflict&&isSelected?"#fca5a5":
                      isConflict?"#e5e7eb":
                      isSelected?"#1a6fc4":"#e2e6ed"}`,
                    transition:"all 0.12s" }}>
                  <input type="checkbox" checked={isSelected} readOnly
                    style={{ accentColor:"#1a6fc4", margin:0 }} />
                  <span style={{ fontSize:12, fontWeight:600,
                    color: isConflict&&isSelected?"#dc2626":
                           isConflict?"#9ca3af":
                           isSelected?"#1a6fc4":"#4a5568",
                    fontFamily:"monospace" }}>{f}</span>
                  {isConflict && isSelected && (
                    <span style={{ fontSize:9, background:"#fecaca", color:"#dc2626",
                      padding:"1px 5px", borderRadius:3, fontWeight:700 }}>CONFLICT</span>
                  )}
                  {isConflict && !isSelected && (
                    <span style={{ fontSize:9, background:"#f3f4f6", color:"#9ca3af",
                      padding:"1px 5px", borderRadius:3 }}>exists</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Conflict warning */}
      {conflicts.length > 0 && (
        <div style={{ background:"#fff7ed", border:"1px solid #fed7aa",
          borderRadius:7, padding:"10px 14px", marginBottom:12 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#c2410c", marginBottom:4 }}>
            ⚠️ Conflicts detected — {conflicts.length} variable{conflicts.length!==1?"s":""} already exist
          </div>
          <div style={{ fontSize:11, color:"#7c2d12", lineHeight:1.6 }}>
            The following are already defined in this test case:{" "}
            <strong>{conflicts.join(", ")}</strong>
            <br/>
            Deselect them above or delete them from the test case first.
          </div>
        </div>
      )}

      {/* Values preview — shows first selected row */}
      {selCols.size > 0 && data.length > 0 && (
        <div style={{ background:"#f8f9fc", border:"1px solid #e2e6ed",
          borderRadius:7, padding:"10px 14px", marginBottom:12,
          fontSize:11, color:"#4a5568" }}>
          {(() => {
            const previewIdx = selectedRowsArr[0] ?? 0;
            const previewRow = data[previewIdx] || data[0];
            const rowIdx = previewIdx;
            return (<>
              <div style={{ fontWeight:700, marginBottom:6, color:"#1a2332" }}>
                Preview — values from row {rowIdx+1}:
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:4 }}>
                {[...selCols].map(f => (
                  <div key={f} style={{ display:"flex", gap:4, alignItems:"center" }}>
                    <span style={{ fontFamily:"monospace", color:"#1a6fc4", flexShrink:0 }}>{"{{"}{f}{"}}"}</span>
                    <span style={{ color:"#6b7280", flexShrink:0 }}>= </span>
                    <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                      maxWidth:120, color:"#1a2332", fontWeight:600 }}>
                      {previewRow?.[f]!==undefined&&previewRow?.[f]!==""
                        ? String(previewRow[f])
                        : <em style={{color:"#d1d5db", fontWeight:400}}>empty</em>}
                    </span>
                  </div>
                ))}
              </div>
            </>);
          })()}
        </div>
      )}

      {saveErr && (
        <div style={{ background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca",
          borderRadius:6, padding:"8px 12px", fontSize:12, marginBottom:12 }}>
          ❌ {saveErr}
        </div>
      )}
      {saveMsg && (
        <div style={{ background:"#f0fdf4", color:"#16a34a", border:"1px solid #bbf7d0",
          borderRadius:6, padding:"8px 12px", fontSize:12, marginBottom:12 }}>
          {saveMsg}
        </div>
      )}

      {/* Row selection hint */}
      {!selectedRowsArr.length && (
        <div style={{ background:"#fffbeb", border:"1px solid #fde68a",
          borderRadius:7, padding:"9px 14px", marginBottom:10,
          fontSize:12, color:"#92400e", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:16 }}>⚠️</span>
          <span>Select at least one row from the data table above as sample data before saving.</span>
        </div>
      )}

      <div style={{ display:"flex", gap:10 }}>
        <button onClick={save}
          disabled={saving || conflicts.length>0 || !saveTestId || !selCols.size || !selectedRowsArr.length}
          style={{ ...s.btn("primary"), flex:1, padding:"10px",
            background: conflicts.length>0?"#94a3b8":
                        !saveTestId||!selCols.size||!selectedRowsArr.length?"#e5e7eb":"#1a6fc4",
            cursor: conflicts.length>0||!saveTestId||!selCols.size||!selectedRowsArr.length?"not-allowed":"pointer" }}>
          {saving ? "Saving..." : `💉 Inject ${selCols.size} Variable${selCols.size!==1?"s":""} into Test Case`}
        </button>
        <button onClick={onDownloadCSV}
          style={{ ...s.btn("ghost",true), fontSize:12 }}>⬇ CSV</button>
      </div>

      <div style={{ fontSize:11, color:"#8a96a8", marginTop:8 }}>
        The <strong>selected row's values</strong> will be injected into the test case.
        Use <code style={{fontFamily:"monospace"}}>{'{{field_name}}'}</code> in any test step.</div>
    </div>
  );
}


// ─── AI GENERATOR (tabbed — Script Generator + Test Data Generator) ───────────
function AiGenerator({ projects, suites, setTab }) {
  const [aiTab, setAiTab] = useState("script"); // "script" | "data"

  return (
    <div style={s.col}>
      <div style={{ fontSize:22, fontWeight:800, marginBottom:4, color:"#8B0000" }}>🤖 AI Generator</div>

      {/* Tab switcher */}
      <div style={{ display:"flex", gap:0, borderBottom:"2px solid #e2e6ed",
        marginBottom:20 }}>
        {[
          { key:"script", label:"✍️ Script Generator",    desc:"Screenshot → test steps" },
          { key:"data",   label:"🧬 Test Data Generator", desc:"AI-generated test data sets" },
        ].map(t => (
          <button key={t.key} onClick={()=>setAiTab(t.key)}
            style={{ padding:"10px 24px", border:"none", cursor:"pointer",
              background:"transparent", fontSize:13, fontWeight:600,
              color:aiTab===t.key?"#1a6fc4":"#8a96a8",
              borderBottom:aiTab===t.key?"3px solid #1a6fc4":"3px solid transparent",
              marginBottom:-2, transition:"all 0.15s" }}>
            {t.label}
          </button>
        ))}
      </div>

      {aiTab === "script" && <ScriptGeneratorContent projects={projects} suites={suites} setTab={setTab} />}
      {aiTab === "data"   && <TestDataGenerator projects={projects} />}
    </div>
  );
}

// ─── SCRIPT GENERATOR (extracted from old AiGenerator) ───────────────────────
function ScriptGeneratorContent({ projects, suites, setTab }) {
  const [screenshots,  setScreenshots]  = useState([]);
  const [dragOver,     setDragOver]     = useState(false);
  const [preview,      setPreview]      = useState(null);
  const [context,      setContext]      = useState("");
  const [generating,   setGenerating]   = useState(false);
  const [genProgress,  setGenProgress]  = useState("");
  const [error,        setError]        = useState(null);
  const [genSteps,     setGenSteps]     = useState(null);
  const [editingStep,  setEditingStep]  = useState(null);
  const [targetProjectId,setTargetProjectId]= useState("");
  const [targetPriority,setTargetPriority]= useState("medium");
  const [newTestName,  setNewTestName]  = useState("");
  const [saving,       setSaving]       = useState(false);
  const [saveMsg,      setSaveMsg]      = useState(null);
  const [savedId,      setSavedId]      = useState(null);

  const readFiles = (files) => {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target.result;
        setScreenshots(prev => [...prev, {
          id: Date.now() + Math.random(), base64: dataUrl.split(",")[1],
          preview: dataUrl, label: file.name.replace(/\.[^.]+$/, ""),
        }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeShot  = (id)        => setScreenshots(p => p.filter(s => s.id !== id));
  const setLabel    = (id, label) => setScreenshots(p => p.map(s => s.id===id ? {...s,label} : s));
  const moveShotUp  = (i) => setScreenshots(p => { if(!i) return p; const a=[...p]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const moveShotDn  = (i) => setScreenshots(p => { if(i>=p.length-1) return p; const a=[...p]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });

  const generate = async () => {
    if (!screenshots.length) return;
    setGenerating(true); setError(null); setGenSteps(null);
    setSaveMsg(null); setSavedId(null);
    setGenProgress("Sending screenshots to AI...");
    try {
      setGenProgress("Analyzing " + screenshots.length + " screenshot" + (screenshots.length>1?"s":"") + "...");
      const data = await api("/api/ai/generate-steps", {
        method: "POST",
        body: { screenshots: screenshots.map(s=>({base64:s.base64,label:s.label})), context_description: context }
      });
      const steps = (data.steps||[]).map(st=>({ action:st.action||"click", selector:st.selector||"", value:st.value||"", timeout:30000 }));
      setGenSteps(steps);
      setNewTestName("AI Generated Test " + new Date().toLocaleDateString());
      setGenProgress("");
    } catch(err) { setError(err.message); setGenProgress(""); }
    finally { setGenerating(false); }
  };

  const updateStep   = (i,f,v) => setGenSteps(p=>{ const a=[...p]; a[i]={...a[i],[f]:v}; return a; });
  const removeStep   = (i)     => setGenSteps(p=>p.filter((_,j)=>j!==i));
  const moveStepUp   = (i)     => setGenSteps(p=>{ if(!i) return p; const a=[...p]; [a[i-1],a[i]]=[a[i],a[i-1]]; return a; });
  const moveStepDn   = (i)     => setGenSteps(p=>{ if(i>=p.length-1) return p; const a=[...p]; [a[i],a[i+1]]=[a[i+1],a[i]]; return a; });
  const addGenStep   = ()      => setGenSteps(p=>[...p,{action:"click",selector:"",value:"",timeout:30000}]);

  const NEEDS_SEL = ["click","type","clear","select","check","uncheck","hover","press",
    "assert_text","assert_not_text","assert_visible","assert_not_visible",
    "assert_value","assert_count","store_text","store_value","wait_for_selector"];
  const NEEDS_VAL = ["navigate","type","select","press","wait","wait_for_url",
    "assert_text","assert_not_text","assert_url","assert_title","assert_value",
    "assert_count","store_text","store_value","store_url","scroll","execute_script","screenshot"];

  const save = async () => {
    if (!targetProjectId || !newTestName.trim() || !genSteps?.length) return;
    setSaving(true); setSaveMsg(null);
    try {
      const proj = (projects||[]).find(p=>String(p.id)===String(targetProjectId));
      const res = await api("/api/tests", { method:"POST", body:{
        name:newTestName.trim(), suite_id:null, project_id:parseInt(targetProjectId),
        type:"ui", steps:genSteps, browser:"chrome", base_url:"", variables:[],
        tags:["ai-generated"], priority:targetPriority||"medium",
      }});
      setSavedId(res.id);
      const projName = proj?.name||"project";
      setSaveMsg({ ok:true, text: "Saved \"" + newTestName + "\" in " + projName });
    } catch(err) { setSaveMsg({ ok:false, text:err.message }); }
    finally { setSaving(false); }
  };

  const aColor = (a) => {
    if (!a) return "#8a96a8";
    if (a==="navigate") return "#3182ce";
    if (["click","hover","press"].includes(a)) return "#805ad5";
    if (["type","clear","select","check","uncheck"].includes(a)) return "#38a169";
    if (a.startsWith("assert")) return "#d69e2e";
    if (a.startsWith("store")) return "#e53e3e";
    if (["wait","wait_for_selector","wait_for_url"].includes(a)) return "#dd6b20";
    return "#4a5568";
  };

  return (
    <div style={{padding:"20px 24px", maxWidth:1200}}>
      <div style={{marginBottom:24}}>
        <div style={{fontSize:22, fontWeight:800, color:"#1a2332"}}>🤖 AI Script Generator</div>
        <div style={{fontSize:13, color:"#8a96a8", marginTop:4}}>
          Upload screenshots of any screen flow → AI writes the complete test script automatically
        </div>
      </div>

      <div style={{display:"grid", gridTemplateColumns:"420px 1fr", gap:24, alignItems:"start"}}>

        {/* LEFT */}
        <div style={{display:"flex", flexDirection:"column", gap:16}}>

          {/* Upload */}
          <div style={{background:"#fff", border:"1px solid #e2e6ed", borderRadius:12, padding:20}}>
            <div style={{fontSize:13, fontWeight:700, color:"#1a2332", marginBottom:14, display:"flex", alignItems:"center", gap:8}}>
              <span style={{background:"#1a6fc4", color:"#fff", borderRadius:"50%", width:22, height:22,
                display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800}}>1</span>
              Upload Screenshots
            </div>

            <div
              onDrop={e=>{e.preventDefault();setDragOver(false);readFiles(e.dataTransfer.files);}}
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onClick={()=>document.getElementById("ai-ss-input").click()}
              style={{border:"2px dashed " + (dragOver?"#1a6fc4":"#bdd7f5"),
                borderRadius:10, padding:"22px 16px", textAlign:"center", cursor:"pointer",
                background:dragOver?"#e8f4ff":"#f8fbff", transition:"all 0.15s",
                marginBottom:screenshots.length?12:0}}>
              <div style={{fontSize:28, marginBottom:6}}>🖼️</div>
              <div style={{fontSize:13, color:"#1a6fc4", fontWeight:600}}>Click to upload or drag &amp; drop</div>
              <div style={{fontSize:12, color:"#8a96a8", marginTop:3}}>PNG / JPG — upload in order of your flow</div>
              <input id="ai-ss-input" type="file" accept="image/*" multiple style={{display:"none"}}
                onChange={e=>readFiles(e.target.files)} />
            </div>

            {screenshots.length > 0 && (
              <div style={{display:"flex", flexDirection:"column", gap:6}}>
                {screenshots.map((ss, i) => (
                  <div key={ss.id} style={{display:"flex", gap:8, alignItems:"center",
                    background:"#f8f9fc", border:"1px solid #e2e6ed", borderRadius:8, padding:"6px 8px"}}>
                    <img src={ss.preview} alt="" onClick={()=>setPreview(ss.preview)}
                      style={{width:56, height:38, objectFit:"cover", borderRadius:4,
                        border:"1px solid #e2e6ed", cursor:"zoom-in", flexShrink:0}} />
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{display:"flex", alignItems:"center", gap:6}}>
                        <span style={{fontSize:10, fontWeight:700, color:"#fff", background:"#1a6fc4",
                          borderRadius:3, padding:"1px 6px"}}>{i+1}</span>
                        <input value={ss.label} onChange={e=>setLabel(ss.id,e.target.value)}
                          placeholder="label this screenshot..."
                          style={{...s.input, flex:1, margin:0, fontSize:11, padding:"3px 7px"}} />
                      </div>
                    </div>
                    <div style={{display:"flex", flexDirection:"column", gap:1}}>
                      <button onClick={()=>moveShotUp(i)} disabled={!i}
                        style={{background:"none", border:"none", cursor:i?"pointer":"default",
                          fontSize:10, color:i?"#4a5568":"#cbd5e0", padding:"1px 4px"}}>▲</button>
                      <button onClick={()=>moveShotDn(i)} disabled={i===screenshots.length-1}
                        style={{background:"none", border:"none",
                          cursor:i<screenshots.length-1?"pointer":"default",
                          fontSize:10, color:i<screenshots.length-1?"#4a5568":"#cbd5e0", padding:"1px 4px"}}>▼</button>
                    </div>
                    <button onClick={()=>removeShot(ss.id)}
                      style={{background:"none", border:"none", cursor:"pointer",
                        fontSize:18, color:"#e53e3e", padding:"0 2px"}}>×</button>
                  </div>
                ))}
                <button onClick={()=>setScreenshots([])}
                  style={{...s.btn("ghost",true), fontSize:11, marginTop:2, alignSelf:"flex-end"}}>
                  Clear all
                </button>
              </div>
            )}
          </div>

          {/* Context */}
          <div style={{background:"#fff", border:"1px solid #e2e6ed", borderRadius:12, padding:20}}>
            <div style={{fontSize:13, fontWeight:700, color:"#1a2332", marginBottom:10, display:"flex", alignItems:"center", gap:8}}>
              <span style={{background:"#1a6fc4", color:"#fff", borderRadius:"50%", width:22, height:22,
                display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800}}>2</span>
              Context
              <span style={{fontWeight:400, color:"#8a96a8", fontSize:12}}>(optional but recommended)</span>
            </div>
            <textarea value={context} onChange={e=>setContext(e.target.value)} rows={4}
              placeholder={"Example:\nThis is the patient registration flow for ATHMA.\nLogin: admin / admin123\nAfter registering verify the patient appears in the list."}
              style={{...s.input, resize:"vertical", fontFamily:"inherit", fontSize:13, lineHeight:1.6}} />
          </div>

          {/* Generate button */}
          <button onClick={generate} disabled={generating||!screenshots.length}
            style={{...s.btn("primary"), padding:"13px 0", fontSize:15, fontWeight:700,
              opacity:(!screenshots.length||generating)?0.5:1,
              display:"flex", alignItems:"center", justifyContent:"center", gap:10}}>
            {generating
              ? <><span style={{width:18, height:18, border:"2px solid rgba(255,255,255,0.4)",
                  borderTop:"2px solid #fff", borderRadius:"50%",
                  animation:"spin 0.7s linear infinite", display:"inline-block"}} />
                  {genProgress||"Generating..."}</>
              : <>🤖 Generate Test Steps{screenshots.length>0&&" ("+screenshots.length+" screenshot"+(screenshots.length>1?"s":"")+")"}</>}
          </button>

          {error && (
            <div style={{background:"#fff5f5", border:"1px solid #feb2b2", borderRadius:10,
              padding:"12px 16px", fontSize:13, color:"#c53030", lineHeight:1.6}}>
              <b>Error:</b> {error}
              <div style={{marginTop:8, fontSize:12}}>
                Make sure <code>ANTHROPIC_API_KEY</code> is set before starting the backend.
              </div>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <div>
          {!genSteps && !generating && (
            <div style={{background:"#f8f9fc", border:"2px dashed #e2e6ed", borderRadius:12,
              padding:"60px 32px", textAlign:"center", color:"#8a96a8"}}>
              <div style={{fontSize:52, marginBottom:16, opacity:0.4}}>🤖</div>
              <div style={{fontSize:15, fontWeight:600, marginBottom:8}}>Generated steps will appear here</div>
              <div style={{fontSize:13}}>Upload screenshots → add context → click Generate</div>
            </div>
          )}

          {generating && (
            <div style={{background:"#fff", border:"1px solid #e2e6ed", borderRadius:12,
              padding:"60px 32px", textAlign:"center"}}>
              <div style={{width:52, height:52, border:"4px solid #e2e6ed",
                borderTop:"4px solid #1a6fc4", borderRadius:"50%",
                animation:"spin 0.8s linear infinite", margin:"0 auto 20px"}} />
              <div style={{fontSize:15, fontWeight:600, color:"#1a2332", marginBottom:8}}>AI is analyzing your screenshots...</div>
              <div style={{fontSize:13, color:"#8a96a8"}}>{genProgress||"This usually takes 5–15 seconds"}</div>
            </div>
          )}

          {genSteps && (
            <div style={{background:"#fff", border:"1px solid #e2e6ed", borderRadius:12, overflow:"hidden"}}>

              {/* Result header */}
              <div style={{padding:"14px 20px", borderBottom:"1px solid #e2e6ed",
                display:"flex", alignItems:"center", justifyContent:"space-between", background:"#f8f9fc"}}>
                <div>
                  <div style={{fontWeight:700, color:"#1a2332", fontSize:14}}>
                    ✅ {genSteps.length} steps generated
                  </div>
                  <div style={{fontSize:12, color:"#8a96a8", marginTop:2}}>Review and edit before saving</div>
                </div>
                <div style={{display:"flex", gap:8}}>
                  <button onClick={generate} style={{...s.btn("ghost",true), fontSize:12}}>🔄 Regenerate</button>
                  <button onClick={()=>{setGenSteps(null);setSaveMsg(null);setSavedId(null);}}
                    style={{...s.btn("ghost",true), fontSize:12}}>Reset</button>
                </div>
              </div>

              {/* Steps */}
              <div style={{maxHeight:420, overflowY:"auto", padding:"12px 16px",
                display:"flex", flexDirection:"column", gap:6}}>
                {genSteps.map((step, i) => (
                  <div key={i} style={{border:"1px solid " + (editingStep===i?"#1a6fc4":"#e2e6ed"),
                    borderRadius:8, background:editingStep===i?"#f0f7ff":"#fafbfc", overflow:"hidden"}}>

                    <div style={{display:"flex", gap:6, alignItems:"center", padding:"7px 10px"}}>
                      <span style={{fontSize:10, fontWeight:700, color:"#fff",
                        background:aColor(step.action), borderRadius:4, padding:"2px 5px",
                        minWidth:20, textAlign:"center", flexShrink:0}}>{i+1}</span>

                      <select value={step.action} onChange={e=>updateStep(i,"action",e.target.value)}
                        style={{...s.input, margin:0, fontSize:12, padding:"3px 6px",
                          flex:"0 0 auto", width:170, borderColor:aColor(step.action)}}>
                        {ACTION_GROUPS.map(grp=>(
                          <optgroup key={grp} label={"── "+grp+" ──"}>
                            {ACTIONS.filter(a=>a.group===grp).map(a=>(
                              <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>

                      {editingStep !== i && (
                        <div style={{flex:1, fontSize:11, color:"#4a5568",
                          fontFamily:"'IBM Plex Mono',monospace",
                          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>
                          {step.selector && <span style={{color:"#805ad5"}}>{step.selector.slice(0,40)}</span>}
                          {step.selector && step.value && <span style={{color:"#8a96a8"}}> → </span>}
                          {step.value && <span>{String(step.value).slice(0,40)}</span>}
                        </div>
                      )}

                      <div style={{display:"flex", gap:3, marginLeft:"auto", flexShrink:0}}>
                        <button onClick={()=>moveStepUp(i)} style={{...s.btn("ghost",true), padding:"2px 5px", fontSize:11}}>↑</button>
                        <button onClick={()=>moveStepDn(i)} style={{...s.btn("ghost",true), padding:"2px 5px", fontSize:11}}>↓</button>
                        <button onClick={()=>setEditingStep(editingStep===i?null:i)}
                          style={{...s.btn(editingStep===i?"primary":"ghost",true), padding:"2px 7px", fontSize:11}}>
                          {editingStep===i?"Done":"Edit"}
                        </button>
                        <button onClick={()=>removeStep(i)}
                          style={{...s.btn("danger",true), padding:"2px 6px", fontSize:11}}>✕</button>
                      </div>
                    </div>

                    {editingStep === i && (
                      <div style={{padding:"6px 10px 10px", borderTop:"1px solid #bdd7f5",
                        display:"flex", flexDirection:"column", gap:6}}>
                        {NEEDS_SEL.includes(step.action) && (
                          <div>
                            <div style={{fontSize:11, color:"#8a96a8", marginBottom:3}}>Selector</div>
                            <input value={step.selector||""} onChange={e=>updateStep(i,"selector",e.target.value)}
                              placeholder="get_by_role(...) or CSS selector"
                              style={{...s.input, margin:0, fontSize:12, fontFamily:"'IBM Plex Mono',monospace"}} />
                          </div>
                        )}
                        {NEEDS_VAL.includes(step.action) && (
                          <div>
                            <div style={{fontSize:11, color:"#8a96a8", marginBottom:3}}>Value</div>
                            <input value={step.value||""} onChange={e=>updateStep(i,"value",e.target.value)}
                              placeholder="value" style={{...s.input, margin:0, fontSize:12}} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <button onClick={addGenStep}
                  style={{...s.btn("ghost"), width:"100%", marginTop:4, fontSize:13, border:"1px dashed #cdd3dc"}}>
                  + Add Step
                </button>
              </div>

              {/* Save */}
              <div style={{padding:"16px 20px", borderTop:"1px solid #e2e6ed", background:"#f8f9fc"}}>
                <div style={{fontSize:13, fontWeight:700, color:"#1a2332", marginBottom:12,
                  display:"flex", alignItems:"center", gap:8}}>
                  <span style={{background:"#1a6fc4", color:"#fff", borderRadius:"50%", width:22, height:22,
                    display:"inline-flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:800}}>3</span>
                  Save Test Case
                </div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:10}}>
                  <div>
                    <div style={{fontSize:11, color:"#8a96a8", marginBottom:4}}>Test case name *</div>
                    <input value={newTestName} onChange={e=>setNewTestName(e.target.value)}
                      placeholder="e.g. Patient Registration Flow"
                      style={{...s.input, margin:0}} />
                  </div>
                  <div>
                    <div style={{fontSize:11, color:"#8a96a8", marginBottom:4}}>Project *</div>
                    <select value={targetProjectId}
                      onChange={e=>setTargetProjectId(e.target.value)}
                      style={{...s.input, margin:0}}>
                      <option value="">— Select project —</option>
                      {(projects||[]).map(p=>(
                        <option key={p.id} value={String(p.id)}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:11, color:"#8a96a8", marginBottom:4}}>Priority</div>
                    <select value={targetPriority} onChange={e=>setTargetPriority(e.target.value)}
                      style={{...s.input, margin:0}}>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="low">Low</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                </div>
                <div style={{display:"flex", gap:10}}>
                  <button onClick={save} disabled={saving||!targetProjectId||!newTestName.trim()}
                    style={{...s.btn("primary"), flex:1,
                      opacity:(!targetProjectId||!newTestName.trim()||saving)?0.5:1}}>
                    {saving?"Saving...":"💾 Save Test Case"}
                  </button>
                  {savedId && (
                    <button onClick={()=>setTab("tests")}
                      style={{...s.btn("ghost"), flex:1, fontSize:13}}>
                      Open in Test Cases →
                    </button>
                  )}
                </div>
                {saveMsg && (
                  <div style={{marginTop:10, padding:"10px 14px", borderRadius:8, fontSize:13,
                    background:saveMsg.ok?"#f0fff4":"#fff5f5",
                    border:"1px solid "+(saveMsg.ok?"#9ae6b4":"#feb2b2"),
                    color:saveMsg.ok?"#276749":"#c53030"}}>
                    {saveMsg.ok?"✅ ":"❌ "}{saveMsg.text}
                    {saveMsg.ok && <span style={{fontSize:12, color:"#38a169", marginLeft:8}}>Tagged [ai-generated] — ready to run!</span>}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Preview modal */}
      {preview && (
        <div style={{...s.modal, background:"rgba(0,0,0,0.85)"}} onClick={()=>setPreview(null)}>
          <div style={{maxWidth:"90vw", maxHeight:"90vh", position:"relative"}}>
            <img src={preview} alt="preview"
              style={{maxWidth:"90vw", maxHeight:"90vh", borderRadius:8,
                boxShadow:"0 20px 60px rgba(0,0,0,0.5)"}} />
            <button onClick={()=>setPreview(null)}
              style={{position:"absolute", top:-12, right:-12, background:"#fff",
                border:"none", borderRadius:"50%", width:28, height:28, cursor:"pointer",
                fontSize:16, fontWeight:700, color:"#1a2332",
                display:"flex", alignItems:"center", justifyContent:"center",
                boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}



// ─── FLOW BUILDER ─────────────────────────────────────────────────────────────
// Visual N8N-style canvas. Reads/writes the same steps[] array as StepEditor.

const NODE_W = 220;
const NODE_H = 64;
const H_GAP  = 100;  // horizontal gap between nodes on branches
const V_GAP  = 90;   // vertical gap between nodes

// Action color map
const nodeColor = (action) => {
  if (!action) return { bg:"#f8f9fc", border:"#e2e6ed", text:"#4a5568" };
  if (["navigate","wait_for_url","wait_for_selector","wait"].includes(action))
    return { bg:"#ebf8ff", border:"#3182ce", text:"#1a365d" };
  if (["click","hover","press","scroll"].includes(action))
    return { bg:"#faf5ff", border:"#805ad5", text:"#44337a" };
  if (["type","clear","select","check","uncheck"].includes(action))
    return { bg:"#f0fff4", border:"#38a169", text:"#1c4532" };
  if (action.startsWith("assert"))
    return { bg:"#fffff0", border:"#d69e2e", text:"#744210" };
  if (["store_text","store_value","store_url"].includes(action))
    return { bg:"#fff5f5", border:"#e53e3e", text:"#63171b" };
  if (["if_start","if_end","else"].includes(action))
    return { bg:"#fffbeb", border:"#f59e0b", text:"#78350f" };
  if (["loop_start","loop_end","foreach_start","foreach_end","repeat_until","repeat_until_end"].includes(action))
    return { bg:"#f5f3ff", border:"#7c3aed", text:"#3b0764" };
  if (["switch_start","case","switch_end"].includes(action))
    return { bg:"#ecfdf5", border:"#059669", text:"#064e3b" };
  if (["try_start","catch_start","try_end"].includes(action))
    return { bg:"#fff1f2", border:"#e11d48", text:"#881337" };
  if (action === "group")
    return { bg:"#f8f9fc", border:"#a0aec0", text:"#4a5568" };
  if (action === "screenshot")
    return { bg:"#f0f9ff", border:"#0ea5e9", text:"#0c4a6e" };
  return { bg:"#f8f9fc", border:"#cbd5e0", text:"#4a5568" };
};

const actionIcon = (action) => ({
  navigate:"🌐", click:"🖱️", type:"⌨️", clear:"✖️", select:"📋",
  check:"☑️", uncheck:"☐", hover:"👆", press:"⌨️", scroll:"📜",
  execute_script:"⚙️", wait:"⏱️", wait_for_selector:"⏳", wait_for_url:"⏳",
  assert_text:"✅", assert_not_text:"🚫", assert_visible:"✅", assert_not_visible:"🚫",
  assert_url:"✅", assert_title:"✅", assert_value:"✅", assert_count:"🔢",
  store_text:"💾", store_value:"💾", store_url:"💾",
  loop_start:"🔁", loop_end:"🔁", foreach_start:"📋", foreach_end:"📋",
  if_start:"❓", else:"↔️", if_end:"❓",
  switch_start:"🔀", case:"📌", switch_end:"🔀",
  break:"⛔", continue:"⏭️",
  repeat_until:"🔄", repeat_until_end:"🔄",
  try_start:"🛡️", catch_start:"🚨", try_end:"🛡️",
  wait_until:"⏳", group:"📦", screenshot:"📷", db_validate:"🗄️",
}[action] || "⚡");

// Layout engine: convert flat steps[] into positioned nodes
function layoutNodes(steps) {
  // Simple top-down layout with branch indentation for CF blocks
  const nodes = [];
  const INDENT_ACTIONS = ["loop_start","foreach_start","if_start","switch_start","try_start","repeat_until"];
  const DEDENT_ACTIONS = ["loop_end","foreach_end","if_end","switch_end","try_end","repeat_until_end"];
  const MID_ACTIONS    = ["else","catch_start","case"];

  let x = 40, y = 40;
  let xStack = []; // stack of x positions for indentation

  steps.forEach((step, i) => {
    const action = step.action || "";
    const isMid   = MID_ACTIONS.includes(action);
    const isDedent = DEDENT_ACTIONS.includes(action);
    const isIndent = INDENT_ACTIONS.includes(action);

    if (isDedent && xStack.length > 0) x = xStack.pop();
    if (isMid   && xStack.length > 0) x = xStack[xStack.length - 1];

    nodes.push({ ...step, _idx: i, _x: x, _y: y });

    y += NODE_H + V_GAP;

    if (isIndent) {
      xStack.push(x);
      x = x + H_GAP;
    }
  });

  return nodes;
}

function FlowBuilder({ steps, onChange, variables }) {
  const [nodes,    setNodes]    = useState(() => layoutNodes(steps));
  const [selected, setSelected] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [pan,      setPan]      = useState({ x:0, y:0 });
  const [panStart, setPanStart] = useState(null);
  const [zoom,     setZoom]     = useState(1);
  const [panel,    setPanel]    = useState(null); // node being edited in side panel

  // Sync when steps change externally
  const [lastSteps, setLastSteps] = useState(steps);
  if (steps !== lastSteps) {
    setLastSteps(steps);
    setNodes(layoutNodes(steps));
  }

  const canvasW = Math.max(1400, ...nodes.map(n => n._x + NODE_W + 100));
  const canvasH = Math.max(900,  ...nodes.map(n => n._y + NODE_H + 100));

  const commitNodes = (newNodes) => {
    const sorted  = [...newNodes].sort((a,b) => a._y - b._y || a._x - b._x);
    const newSteps = sorted.map(({ _idx, _x, _y, ...rest }) => rest);
    onChange(newSteps);
    setNodes(sorted.map((n,i) => ({ ...n, _idx:i })));
  };

  const onNodeMouseDown = (e, idx) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const node = nodes.find(n => n._idx === idx);
    setDragging({ idx, ox: e.clientX - node._x, oy: e.clientY - node._y });
    setSelected(idx);
    // Open panel for clicked node
    setPanel({ ...node });
  };

  const onMouseMove = (e) => {
    if (dragging !== null) {
      setNodes(prev => prev.map(n =>
        n._idx === dragging.idx
          ? { ...n, _x: Math.max(8, e.clientX - dragging.ox), _y: Math.max(8, e.clientY - dragging.oy) }
          : n
      ));
    } else if (panStart) {
      setPan({ x: e.clientX - panStart.ox, y: e.clientY - panStart.oy });
    }
  };

  const onMouseUp = () => {
    if (dragging !== null) commitNodes(nodes);
    setDragging(null);
    setPanStart(null);
  };

  const onCanvasMouseDown = (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      setPanStart({ ox: e.clientX - pan.x, oy: e.clientY - pan.y });
    } else if (e.target === e.currentTarget) {
      setSelected(null);
    }
  };

  const onWheel = (e) => {
    e.preventDefault();
    setZoom(z => Math.min(2.5, Math.max(0.25, z - e.deltaY * 0.001)));
  };

  const deleteNode = (idx) => {
    const newNodes = nodes.filter(n => n._idx !== idx).map((n,i) => ({ ...n, _idx:i }));
    setNodes(newNodes);
    onChange(newNodes.map(({ _idx, _x, _y, ...rest }) => rest));
    setSelected(null);
    setPanel(null);
  };

  const addNode = (action) => {
    const maxY = nodes.length ? Math.max(...nodes.map(n => n._y)) : -NODE_H - V_GAP;
    const newNode = { action, selector:"", value:"", timeout:30000,
      _idx: nodes.length, _x:40, _y: maxY + NODE_H + V_GAP };
    const newNodes = [...nodes, newNode];
    setNodes(newNodes);
    onChange(newNodes.map(({ _idx, _x, _y, ...rest }) => rest));
    setSelected(newNode._idx);
    setPanel({ ...newNode });
  };

  const savePanel = (updated) => {
    const newNodes = nodes.map(n =>
      n._idx === updated._idx ? { ...updated, _x:n._x, _y:n._y } : n
    );
    setNodes(newNodes);
    onChange(newNodes.map(({ _idx, _x, _y, ...rest }) => rest));
    setPanel({ ...updated });
  };

  // Arrows between vertically sorted nodes
  const sorted = [...nodes].sort((a,b) => a._y - b._y || a._x - b._x);
  const arrows = sorted.slice(0,-1).map((a, i) => {
    const b  = sorted[i+1];
    const x1 = a._x + NODE_W/2, y1 = a._y + NODE_H;
    const x2 = b._x + NODE_W/2, y2 = b._y;
    const cy = (y1+y2)/2;
    return (
      <path key={i}
        d={`M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`}
        fill="none" stroke="#cbd5e0" strokeWidth="2"
        markerEnd="url(#arrowhead)" />
    );
  });

  const panelOpen = panel !== null;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 280px)", minHeight:540 }}>

      {/* Top toolbar */}
      <div style={{ display:"flex", gap:6, alignItems:"center", padding:"8px 0 10px",
        borderBottom:"1px solid #e2e6ed", flexWrap:"wrap" }}>
        <span style={{ fontSize:11, fontWeight:700, color:"#8a96a8", textTransform:"uppercase", letterSpacing:"0.05em" }}>Add</span>
        {[["navigate","🌐","Navigate"],["click","🖱️","Click"],["type","⌨️","Type"],
          ["assert_text","✅","Assert"],["wait","⏱️","Wait"],["screenshot","📷","Screenshot"]
        ].map(([a,ic,lb]) => (
          <button key={a} onClick={()=>addNode(a)}
            style={{ ...s.btn("ghost",true), fontSize:12 }}>{ic} {lb}</button>
        ))}
        <div style={{ width:1, height:18, background:"#e2e6ed" }} />
        <span style={{ fontSize:11, fontWeight:700, color:"#8a96a8", textTransform:"uppercase", letterSpacing:"0.05em" }}>Flow</span>
        {[["loop_start","🔁","Loop"],["if_start","❓","IF"],
          ["foreach_start","📋","ForEach"],["try_start","🛡️","Try/Catch"]
        ].map(([a,ic,lb]) => (
          <button key={a} onClick={()=>addNode(a)}
            style={{ ...s.btn("ghost",true), fontSize:12 }}>{ic} {lb}</button>
        ))}
        <div style={{ marginLeft:"auto", display:"flex", gap:6, alignItems:"center" }}>
          <button onClick={()=>setZoom(z=>Math.min(2.5,+(z+0.1).toFixed(1)))}
            style={{ ...s.btn("ghost",true), padding:"3px 8px", fontWeight:700 }}>+</button>
          <span style={{ fontSize:12, color:"#8a96a8", minWidth:38, textAlign:"center" }}>
            {Math.round(zoom*100)}%
          </span>
          <button onClick={()=>setZoom(z=>Math.max(0.25,+(z-0.1).toFixed(1)))}
            style={{ ...s.btn("ghost",true), padding:"3px 8px", fontWeight:700 }}>−</button>
          <button onClick={()=>{setZoom(1);setPan({x:0,y:0});}}
            style={{ ...s.btn("ghost",true), fontSize:12 }}>Reset</button>
        </div>
      </div>

      {/* Main area: canvas + side panel */}
      <div style={{ flex:1, display:"flex", overflow:"hidden", position:"relative" }}>

        {/* Canvas */}
        <div
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseDown={onCanvasMouseDown}
          onWheel={onWheel}
          style={{ flex:1, overflow:"hidden", background:"#f7f8fa",
            cursor: panStart?"grabbing":"default",
            position:"relative", borderRadius:"0 0 0 8px",
            borderRight: panelOpen ? "1px solid #e2e6ed" : "none" }}>

          {/* Dot grid */}
          <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none" }}>
            <defs>
              <pattern id="fbdots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#dde1e7"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#fbdots)" />
          </svg>

          {/* Zoomable layer */}
          <div style={{ position:"absolute", transformOrigin:"0 0",
            transform:`translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
            width:canvasW, height:canvasH }}>
            <svg style={{ position:"absolute", inset:0, width:canvasW, height:canvasH,
              pointerEvents:"none", overflow:"visible" }}>
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0,8 3,0 6" fill="#b0bac5"/>
                </marker>
              </defs>
              {arrows}
            </svg>

            {nodes.map(node => {
              const col   = nodeColor(node.action);
              const icon  = actionIcon(node.action);
              const isSel = selected === node._idx;
              const label = (node.value||node.selector||"");
              const short = label.length > 26 ? label.slice(0,26)+"…" : label;

              return (
                <div key={node._idx}
                  onMouseDown={e => onNodeMouseDown(e, node._idx)}
                  style={{ position:"absolute", left:node._x, top:node._y,
                    width:NODE_W, height:NODE_H,
                    background: col.bg,
                    border:`2px solid ${isSel?"#1a6fc4":col.border}`,
                    borderRadius:10,
                    boxShadow: isSel
                      ? "0 0 0 3px rgba(26,111,196,0.2),0 4px 14px rgba(0,0,0,0.13)"
                      : "0 2px 6px rgba(0,0,0,0.07)",
                    cursor:"grab", userSelect:"none",
                    display:"flex", alignItems:"center", gap:10, padding:"0 12px",
                    transition: dragging?.idx===node._idx ? "none" : "box-shadow 0.12s",
                  }}>
                  <div style={{ fontSize:10, fontWeight:700, color:"#fff",
                    background:col.border, borderRadius:4,
                    padding:"2px 5px", minWidth:20, textAlign:"center", flexShrink:0 }}>
                    {node._idx+1}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12, fontWeight:700, color:col.text,
                      display:"flex", gap:5, alignItems:"center" }}>
                      <span style={{ flexShrink:0 }}>{icon}</span>
                      <span style={{ textTransform:"capitalize" }}>
                        {(node.action||"step").replace(/_/g," ")}
                      </span>
                    </div>
                    {short && (
                      <div style={{ fontSize:10, color:"#8a96a8", marginTop:1,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                        fontFamily:"'IBM Plex Mono',monospace" }}>
                        {short}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Empty state */}
          {nodes.length === 0 && (
            <div style={{ position:"absolute", top:"50%", left:"50%",
              transform:"translate(-50%,-50%)", textAlign:"center", pointerEvents:"none" }}>
              <div style={{ fontSize:36, marginBottom:10 }}>🎨</div>
              <div style={{ fontSize:14, fontWeight:600, color:"#8a96a8" }}>Canvas is empty</div>
              <div style={{ fontSize:12, color:"#a0aec0", marginTop:4 }}>Click a button above to add your first step</div>
            </div>
          )}

          <div style={{ position:"absolute", bottom:8, left:"50%", transform:"translateX(-50%)",
            fontSize:11, color:"#b0bac5", pointerEvents:"none", whiteSpace:"nowrap" }}>
            Click node to edit · Drag to reorder · Alt+drag or scroll to pan/zoom
          </div>
        </div>

        {/* Side panel */}
        {panelOpen && (
          <div style={{ width:300, background:"#fff", borderLeft:"1px solid #e2e6ed",
            display:"flex", flexDirection:"column", overflow:"hidden", flexShrink:0 }}>
            <NodeSidePanel
              node={panel}
              variables={variables}
              onChange={savePanel}
              onDelete={() => deleteNode(panel._idx)}
              onClose={() => { setPanel(null); setSelected(null); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── N8N-style Side Panel ──────────────────────────────────────────────────────
function NodeSidePanel({ node, variables, onChange, onDelete, onClose }) {
  const [form, setForm] = useState({ ...node });
  const set = (k,v) => {
    const updated = { ...form, [k]:v };
    setForm(updated);
    onChange(updated);   // live update as user types
  };

  // Sync when a different node is selected
  const [lastIdx, setLastIdx] = useState(node._idx);
  if (node._idx !== lastIdx) {
    setLastIdx(node._idx);
    setForm({ ...node });
  }

  const col = nodeColor(form.action);
  const icon = actionIcon(form.action);

  const needsSelector = ["click","type","clear","select","search_select","check","uncheck","hover","press",
    "double_click","right_click","upload_attachment","download","drag_and_drop","focus","blur",
    "assert_text","assert_not_text","assert_visible","assert_not_visible",
    "assert_attribute","assert_css","assert_enabled","assert_disabled","assert_checked",
    "assert_not_checked","assert_selected","assert_value","assert_count","store_text","store_value","wait_for_selector"];
  const needsValue = ["navigate","type","select","press","wait","wait_for_url",
    "assert_text","assert_not_text","assert_url","assert_title","assert_value",
    "assert_count","store_text","store_value","store_url","scroll","execute_script",
    "loop_start","foreach_start","if_start","switch_start","group","screenshot","repeat_until","wait_until"];

  const showSel = needsSelector.includes(form.action);
  const showVal = needsValue.includes(form.action);

  const IF_CONDITIONS = [
    { value:"element_visible",    label:"Element is visible" },
    { value:"element_not_visible",label:"Element is NOT visible" },
    { value:"var_equals",         label:"Variable == value" },
    { value:"var_not_equals",     label:"Variable != value" },
    { value:"var_contains",       label:"Variable contains" },
    { value:"url_contains",       label:"URL contains" },
    { value:"url_not_contains",   label:"URL does NOT contain" },
    { value:"page_title_contains",label:"Page title contains" },
  ];

  const showIfCondition = ["if_start","repeat_until","wait_until"].includes(form.action);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      {/* Panel header */}
      <div style={{ padding:"14px 16px 12px", borderBottom:"1px solid #e2e6ed",
        background: col.bg, flexShrink:0 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:18, lineHeight:1 }}>{icon}</div>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:col.text, textTransform:"capitalize" }}>
                {(form.action||"step").replace(/_/g," ")}
              </div>
              <div style={{ fontSize:11, color:"#8a96a8" }}>Step {node._idx+1}</div>
            </div>
          </div>
          <button onClick={onClose}
            style={{ background:"none", border:"none", cursor:"pointer",
              fontSize:18, color:"#8a96a8", padding:"2px 6px", lineHeight:1 }}>×</button>
        </div>
      </div>

      {/* Scrollable fields */}
      <div style={{ flex:1, overflowY:"auto", padding:"16px" }}>

        {/* Action type */}
        <div style={{ marginBottom:14 }}>
          <label style={{ ...s.label, marginBottom:5 }}>Action</label>
          <select style={{ ...s.input, margin:0 }} value={form.action}
            onChange={e=>set("action",e.target.value)}>
            {ACTION_GROUPS.map(grp=>(
              <optgroup key={grp} label={"── "+grp+" ──"}>
                {ACTIONS.filter(a=>a.group===grp).map(a=>(
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Selector */}
        {showSel && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>Selector</label>
            <input style={{ ...s.input, margin:0, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}
              value={form.selector||""}
              placeholder="CSS selector / get_by_role(...)"
              onChange={e=>set("selector",e.target.value)} />
          </div>
        )}

        {/* Value */}
        {showVal && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>
              { form.action==="navigate"     ? "URL"
              : form.action==="loop_start"   ? "Repeat times"
              : form.action==="foreach_start"? "Items (comma separated)"
              : form.action==="wait"         ? "Wait (ms)"
              : form.action==="execute_script"? "JavaScript"
              : form.action==="switch_start" ? "Variable to switch on"
              : form.action==="group"        ? "Label"
              : "Value" }
            </label>
            <input style={{ ...s.input, margin:0 }}
              value={form.value||""}
              placeholder={
                form.action==="navigate"      ? "https://example.com"
              : form.action==="loop_start"    ? "3"
              : form.action==="foreach_start" ? "item1, item2, item3 or {{var}}"
              : form.action==="wait"          ? "2000"
              : "value"
              }
              onChange={e=>set("value",e.target.value)} />
          </div>
        )}

        {/* IF / Repeat Until / Wait Until condition */}
        {showIfCondition && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>Condition</label>
            <select style={{ ...s.input, margin:0 }}
              value={form.if_condition||"element_visible"}
              onChange={e=>set("if_condition",e.target.value)}>
              {IF_CONDITIONS.map(c=>(
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            {["element_visible","element_not_visible"].includes(form.if_condition||"element_visible") && (
              <input style={{ ...s.input, margin:"8px 0 0", fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}
                placeholder="selector"
                value={form.if_selector||""}
                onChange={e=>set("if_selector",e.target.value)} />
            )}
            {["var_equals","var_not_equals","var_contains"].includes(form.if_condition||"") && (
              <div style={{ display:"flex", gap:8, marginTop:8 }}>
                <input style={{ ...s.input, flex:1, margin:0 }} placeholder="{{variable}}"
                  value={form.if_var||""} onChange={e=>set("if_var",e.target.value)} />
                <input style={{ ...s.input, flex:1, margin:0 }} placeholder="expected"
                  value={form.if_value||""} onChange={e=>set("if_value",e.target.value)} />
              </div>
            )}
            {["url_contains","url_not_contains","page_title_contains"].includes(form.if_condition||"") && (
              <input style={{ ...s.input, margin:"8px 0 0" }} placeholder="text to match"
                value={form.if_value||""} onChange={e=>set("if_value",e.target.value)} />
            )}
          </div>
        )}

        {/* ForEach item variable name */}
        {form.action === "foreach_start" && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>Item variable name</label>
            <input style={{ ...s.input, margin:0 }}
              placeholder="current_item"
              value={form.loop_var||"current_item"}
              onChange={e=>set("loop_var",e.target.value)} />
            <div style={{ fontSize:11, color:"#8a96a8", marginTop:4 }}>
              Use <code style={{ background:"#f0f0f0", padding:"1px 4px", borderRadius:3 }}>
                {"{{"}{ form.loop_var||"current_item" }{"}}"}
              </code> inside the loop
            </div>
          </div>
        )}

        {/* Catch error variable */}
        {form.action === "catch_start" && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>Store error message in</label>
            <input style={{ ...s.input, margin:0 }}
              placeholder="error_message"
              value={form.error_var||""}
              onChange={e=>set("error_var",e.target.value)} />
          </div>
        )}

        {/* Repeat Until retries */}
        {form.action === "repeat_until" && (
          <div style={{ display:"flex", gap:8, marginBottom:14 }}>
            <div style={{ flex:1 }}>
              <label style={{ ...s.label, marginBottom:5 }}>Max retries</label>
              <input style={{ ...s.input, margin:0 }} type="number" min="1"
                placeholder="10" value={form.max_retries||""}
                onChange={e=>set("max_retries",e.target.value)} />
            </div>
            <div style={{ flex:1 }}>
              <label style={{ ...s.label, marginBottom:5 }}>Interval (ms)</label>
              <input style={{ ...s.input, margin:0 }} type="number" min="500"
                placeholder="2000" value={form.interval_ms||""}
                onChange={e=>set("interval_ms",e.target.value)} />
            </div>
          </div>
        )}

        {/* Variables quick-insert */}
        {(variables||[]).length > 0 && (showSel || showVal) && (
          <div style={{ marginBottom:14 }}>
            <label style={{ ...s.label, marginBottom:5 }}>Insert variable</label>
            <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
              {variables.map(v=>(
                <button key={v.name}
                  onClick={()=>set("value",(form.value||"")+"{{"+v.name+"}}")}
                  style={{ ...s.btn("purple",true), fontFamily:"monospace", fontSize:10,
                    padding:"3px 7px" }}>
                  {"{{"+v.name+"}}"}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Timeout */}
        <div style={{ marginBottom:14 }}>
          <label style={{ ...s.label, marginBottom:5 }}>Timeout (ms)</label>
          <input style={{ ...s.input, margin:0 }} type="number"
            value={form.timeout||30000}
            onChange={e=>set("timeout",parseInt(e.target.value)||30000)} />
        </div>

        {/* Continue on fail */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:14 }}>
          <input type="checkbox" id="fb-cof" checked={!!form.continue_on_fail}
            onChange={e=>set("continue_on_fail",e.target.checked)}
            style={{ width:14, height:14, cursor:"pointer" }} />
          <label htmlFor="fb-cof" style={{ fontSize:12, color:"#4a5568", cursor:"pointer" }}>
            Continue on fail
          </label>
        </div>
      </div>

      {/* Footer: delete */}
      <div style={{ padding:"12px 16px", borderTop:"1px solid #e2e6ed", flexShrink:0 }}>
        <button onClick={onDelete}
          style={{ ...s.btn("danger"), width:"100%", fontSize:13 }}>
          🗑️ Delete Step
        </button>
      </div>
    </div>
  );
}



function HelpDocs() {
  const [activeSection, setActiveSection] = useState("overview");

  const sections = [
    { key:"overview",     label:"Overview",            icon:"🏠" },
    { key:"quickstart",   label:"Quick Start",         icon:"🚀" },
    { key:"projects",     label:"Projects & Suites",   icon:"📁" },
    { key:"testcases",    label:"Test Cases",          icon:"🧪" },
    { key:"actions",      label:"All Actions",         icon:"⚡" },
    { key:"controlflow",  label:"Control Flow",        icon:"🔀" },
    { key:"variables",    label:"Variables",           icon:"⚙️" },
    { key:"selectors",    label:"Finding Selectors",   icon:"🎯" },
    { key:"inspector",    label:"CSS Inspector",       icon:"🔍" },
    { key:"recorder",     label:"Recorder",            icon:"🔴" },
    { key:"scripteditor", label:"Script Editor",       icon:"📝" },
    { key:"suiterunner",  label:"Suite Runner",        icon:"🚀" },
    { key:"schedules",    label:"Schedules",           icon:"⏰" },
    { key:"debug",        label:"Debug Mode",          icon:"🐛" },
    { key:"dbvalidate",   label:"DB Validation",       icon:"🗄️" },
    { key:"reports",      label:"Reports & Email",     icon:"📊" },
    { key:"aigenerate",   label:"AI Generator",        icon:"🤖" },
    { key:"architecture", label:"Architecture",        icon:"🏗️" },
    { key:"troubleshoot", label:"Troubleshooting",     icon:"🔧" },
  ];

  const SectionBtn = ({ s: sec }) => (
    <div onClick={() => setActiveSection(sec.key)}
      style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 14px", borderRadius:7, cursor:"pointer",
        background: activeSection===sec.key ? "#1a6fc418" : "transparent",
        color: activeSection===sec.key ? "#1a6fc4" : "#4a5568",
        fontWeight: activeSection===sec.key ? 700 : 400,
        borderLeft: activeSection===sec.key ? "2px solid #1a6fc4" : "2px solid transparent",
        fontSize: 13, transition:"all 0.15s", marginBottom:2 }}>
      <span>{sec.icon}</span><span>{sec.label}</span>
    </div>
  );

  const H2 = ({children}) => (
    <div style={{ fontSize:18, fontWeight:800, color:"#1a6fc4", marginBottom:12, marginTop:24,
      borderBottom:"1px solid #e2e6ed", paddingBottom:8 }}>{children}</div>
  );
  const H3 = ({children}) => (
    <div style={{ fontSize:14, fontWeight:700, color:"#1a2332", marginBottom:8, marginTop:16 }}>{children}</div>
  );
  const P = ({children}) => (
    <p style={{ fontSize:13, color:"#4a5568", lineHeight:1.8, marginBottom:10 }}>{children}</p>
  );
  const Code = ({children}) => (
    <code style={{ background:"#f0f2f5", padding:"2px 7px", borderRadius:4,
      fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:"#1a2332" }}>{children}</code>
  );
  const CodeBlock = ({children}) => (
    <pre style={{ background:"#0f172a", color:"#e2e8f0", padding:"14px 16px", borderRadius:8,
      fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:1.7, overflowX:"auto",
      marginBottom:12, whiteSpace:"pre-wrap" }}>{children}</pre>
  );
  const Note = ({children, type="info"}) => {
    const colors = { info:["#ebf8ff","#1a6fc4","#bee3f8"], warn:["#fffbeb","#d69e2e","#fbd38d"], danger:["#fff5f5","#e53e3e","#fed7d7"] };
    const [bg,tc,bc] = colors[type]||colors.info;
    return (
      <div style={{ background:bg, border:`1px solid ${bc}`, borderRadius:8, padding:"10px 14px",
        fontSize:13, color:tc, marginBottom:12, lineHeight:1.7 }}>{children}</div>
    );
  };
  const Step = ({n,children}) => (
    <div style={{ display:"flex", gap:12, marginBottom:10 }}>
      <div style={{ width:24, height:24, borderRadius:"50%", background:"#1a6fc4", color:"#fff",
        fontSize:12, fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center",
        flexShrink:0 }}>{n}</div>
      <div style={{ fontSize:13, color:"#4a5568", lineHeight:1.8, paddingTop:2 }}>{children}</div>
    </div>
  );
  const Table = ({headers, rows}) => (
    <table style={{ width:"100%", borderCollapse:"collapse", marginBottom:16, fontSize:13 }}>
      <thead>
        <tr>{headers.map(h=><th key={h} style={{ padding:"8px 12px", background:"#f0f2f5",
          textAlign:"left", fontWeight:700, color:"#1a2332", borderBottom:"2px solid #e2e6ed" }}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row,i)=>(
          <tr key={i} style={{ background:i%2===0?"#fff":"#f8f9fc" }}>
            {row.map((cell,j)=><td key={j} style={{ padding:"8px 12px", borderBottom:"1px solid #e2e6ed",
              color:"#4a5568", verticalAlign:"top" }}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );

  const renderSection = () => {
    switch(activeSection) {

      // ─────────────────────────────────────────────────────────────────────
      case "overview": return (
        <div>
          <div style={{ background:"linear-gradient(135deg,#1a2332 0%,#1a6fc4 100%)",
            borderRadius:12, padding:"28px 32px", color:"#fff", marginBottom:24 }}>
            <div style={{ fontSize:28, fontWeight:800, marginBottom:8, color:"#8B0000" }}>Daiva Health — AI-Powered Test Automation</div>
            <div style={{ fontSize:14, opacity:0.8, lineHeight:1.8 }}>
              A full-stack, browser-based test automation platform built specifically for<br/>
              the ATHMA healthcare application suite. No coding knowledge required.
            </div>
          </div>
          <H2>What is ATHMA?</H2>
          <P>ATHMA (Automation Tool for Healthcare Management Applications) is a purpose-built web testing platform that allows QA engineers, testers, and business analysts to create, manage, run, and schedule automated UI and API tests — all from a browser interface.</P>
          <P>Unlike Selenium or Playwright standalone, ATHMA provides a complete workflow: from recording user actions to generating detailed HTML reports and emailing them to stakeholders after scheduled runs.</P>
          <H2>Key Capabilities</H2>
          <Table
            headers={["Feature","Description"]}
            rows={[
              ["🧪 Test Case Builder","Create tests with 30+ actions using a visual step editor — no coding required"],
              ["📝 Script Editor","Write or paste Python Playwright scripts directly and sync to steps"],
              ["🔴 Recorder","Record user actions in Chrome and auto-import as test steps"],
              ["🎯 CSS Inspector","Hover over any element in a live browser and capture its selectors"],
              ["🔀 Control Flow","Loops, ForEach, IF/ELSE, Switch/Case, Try/Catch, Repeat Until"],
              ["⚙️ Variables","7 variable types: fixed, random email/text/number, timestamp, from list, increment"],
              ["🗄️ DB Validation","Run SQL queries and assert results as test steps"],
              ["🚀 Suite Runner","Run multiple tests as a batch with live progress tracking"],
              ["⏰ Scheduler","Schedule suite or single test runs with cron expressions"],
              ["🐛 Debug Mode","Step-through debugging with breakpoints and variable watch"],
              ["📊 HTML Reports","Katalon-style reports auto-generated after suite runs"],
              ["✉️ Email Reports","Automatically email HTML report to configured addresses"],
              ["🤖 AI Generator","Upload screenshots → AI generates complete test scripts"],
            ]}
          />
          <H2>Who is it for?</H2>
          <Table
            headers={["Role","How they use ATHMA"]}
            rows={[
              ["QA Engineer","Create and maintain automated regression tests for all application flows"],
              ["Business Analyst","Record user journeys and validate expected behaviours"],
              ["Team Lead","Schedule nightly suite runs and receive email reports every morning"],
              ["Developer","Use the DB Validator to assert database state after API calls"],
            ]}
          />
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "quickstart": return (
        <div>
          <H2>Quick Start Guide</H2>
          <P>Get your first automated test running in under 5 minutes.</P>
          <H3>Prerequisites</H3>
          <Note>Node.js 18+, Python 3.9+, PostgreSQL 14+, and a modern browser are required.</Note>
          <H3>1. Start the Backend</H3>
          <CodeBlock>{`cd backend
npm install
node server.js
# Server starts on http://localhost:6001`}</CodeBlock>
          <H3>2. Start the Frontend</H3>
          <CodeBlock>{`cd frontend
npm install
npm run dev
# Opens at http://localhost:5176`}</CodeBlock>
          <H3>3. Login</H3>
          <P>Default credentials: <Code>admin</Code> / <Code>admin123</Code></P>
          <H3>4. Create Your First Test</H3>
          <Step n={1}>Click <b>📁 Projects</b> → Create a project</Step>
          <Step n={2}>Click <b>🗂️ Test Suites</b> → Create a suite inside your project</Step>
          <Step n={3}>Click <b>🧪 Test Cases</b> → Click <b>+ New Test</b></Step>
          <Step n={4}>Select your suite, give it a name</Step>
          <Step n={5}>In the <b>Steps</b> tab, click <b>+ Step</b></Step>
          <Step n={6}>Choose action <b>🌐 Navigate to URL</b>, enter your URL</Step>
          <Step n={7}>Add more steps as needed</Step>
          <Step n={8}>Click <b>Save</b></Step>
          <Step n={9}>Click <b>▶ Run</b> to execute the test</Step>
          <H3>5. Watch it Run</H3>
          <P>A live log panel shows each step executing in real-time. Green = passed, Red = failed. Click <b>🖥️ Open Live Screen</b> to watch the browser as it runs.</P>
          <Note type="warn">For UI tests, Python and Playwright must be installed: <Code>pip install playwright --break-system-packages</Code> then <Code>playwright install chromium</Code></Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "projects": return (
        <div>
          <H2>Projects & Test Suites</H2>
          <H3>Projects</H3>
          <P>A <b>Project</b> is the top-level container. Typically one project = one application or module (e.g. "Patient Registration", "OPD Workflow", "Billing").</P>
          <P>To create a project: <b>📁 Projects</b> → <b>+ New Project</b> → Enter name and description → Save.</P>
          <H3>Test Suites</H3>
          <P>A <b>Test Suite</b> lives inside a project and groups related test cases. Examples: "Login Suite", "Patient Registration Suite", "Smoke Tests".</P>
          <P>To create a suite: <b>🗂️ Test Suites</b> → <b>+ New Suite</b> → Select project → Enter name → Save.</P>
          <H3>Test Cases</H3>
          <P>A <b>Test Case</b> belongs to a suite and contains the actual test steps. Each test case can be run independently or as part of a suite run.</P>
          <H3>Hierarchy</H3>
          <CodeBlock>{`Project
  └── Test Suite
        └── Test Case (steps, variables, browser config)
              └── Test Run (execution result with logs)`}</CodeBlock>
          <Note>Only Admin and Lead roles can create/edit projects and suites. Testers can create and run test cases.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "testcases": return (
        <div>
          <H2>Test Cases</H2>
          <H3>Creating a Test Case</H3>
          <P>Go to <b>🧪 Test Cases</b> → <b>+ New Test</b>. Fill in:</P>
          <Table headers={["Field","Description"]} rows={[
            ["Name","Descriptive name e.g. 'Patient Registration - New Patient'"],
            ["Suite","Which test suite this belongs to"],
            ["Type","UI (browser test) or API (HTTP test)"],
            ["Browser","chrome / firefox / edge / safari"],
            ["Base URL","Optional starting URL — browser navigates here before step 1"],
            ["Priority","low / medium / high — for filtering and reporting"],
            ["Tags","Comma-separated labels e.g. 'smoke, regression, login'"],
          ]} />
          <H3>The Steps Tab</H3>
          <P>Add individual steps using the step builder. Each step has an <b>Action</b>, an optional <b>Selector</b> (which element), and an optional <b>Value</b> (what to do with it).</P>
          <P>Use the <b>Insert Block</b> toolbar at the bottom to add complete control flow blocks (Loop, IF, ForEach, etc.) with one click.</P>
          <H3>The Script Tab</H3>
          <P>View and edit the steps as Python Playwright code. Changes are synced back to the Steps tab when you click <b>💾 Save to Steps</b>. Supports pasting existing Playwright scripts.</P>
          <H3>Variables Panel</H3>
          <P>Define test-level variables that are resolved before each run. Variables are referenced in steps using <Code>{"{{variable_name}}"}</Code> syntax.</P>
          <H3>Running a Test</H3>
          <P>Click <b>▶ Run</b> on any test case row. A modal opens where you select the browser and start. Live logs appear in real time. Final screenshots are saved automatically.</P>
          <H3>Run History</H3>
          <P>Go to <b>📋 Run History</b> to see all past runs. Click any run to see detailed logs, step results, and screenshots.</P>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "actions": return (
        <div>
          <H2>All Available Actions</H2>
          <H3>Navigation</H3>
          <Table headers={["Action","Selector","Value","Description"]} rows={[
            ["🌐 Navigate to URL","—","Full URL","Opens the URL in the browser"],
            ["⏳ Wait for URL","—","Partial URL","Waits until browser URL contains value"],
            ["⏳ Wait for element","CSS selector","—","Waits until element is visible"],
            ["⏱️ Wait (ms)","—","Milliseconds","Pauses for a fixed time"],
          ]} />
          <H3>Interactions</H3>
          <Table headers={["Action","Selector","Value","Description"]} rows={[
            ["🖱️ Click element","CSS/locator","—","Clicks the element"],
            ["⌨️ Type text","CSS/locator","Text to type","Fills an input field"],
            ["✖️ Clear field","CSS/locator","—","Clears an input field"],
            ["📋 Select option","CSS/locator","Option value/text","Selects from a dropdown"],
            ["☑️ Check checkbox","CSS/locator","—","Ticks a checkbox"],
            ["☐ Uncheck checkbox","CSS/locator","—","Unticks a checkbox"],
            ["👆 Hover element","CSS/locator","—","Moves mouse over element"],
            ["⌨️ Press key","CSS/locator","Key name e.g. Enter","Presses a keyboard key"],
            ["📜 Scroll to Y","—","Y pixels","Scrolls window to Y position"],
            ["⚙️ Execute JS","—","JavaScript code","Runs arbitrary JavaScript"],
            ["📷 Take screenshot","—","Label (optional)","Captures a screenshot"],
          ]} />
          <H3>Assertions</H3>
          <Table headers={["Action","Selector","Value","Description"]} rows={[
            ["✅ Assert text contains","CSS/locator","Expected text","Fails if element text doesn't contain value"],
            ["🚫 Assert text NOT contains","CSS/locator","Text","Fails if text IS present"],
            ["✅ Assert element visible","CSS/locator","—","Fails if element is not visible"],
            ["🚫 Assert element hidden","CSS/locator","—","Fails if element IS visible"],
            ["✅ Assert URL contains","—","Partial URL","Fails if current URL doesn't match"],
            ["✅ Assert page title","—","Title text","Checks page title"],
            ["✅ Assert input value","CSS/locator","Expected value","Checks input field value"],
            ["🔢 Assert element count","CSS/locator","Number","Checks how many matching elements exist"],
          ]} />
          <H3>Store (capture values)</H3>
          <Table headers={["Action","Selector","Value","Description"]} rows={[
            ["💾 Store element text","CSS/locator","variable_name","Captures element text into a variable"],
            ["💾 Store input value","CSS/locator","variable_name","Captures input field value into a variable"],
            ["💾 Store current URL","—","variable_name","Captures current page URL into a variable"],
          ]} />
          <H3>DB Validate</H3>
          <P>Runs a SQL query and asserts the result. See <b>DB Validation</b> section for full details.</P>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "controlflow": return (
        <div>
          <H2>Control Flow</H2>
          <P>ATHMA supports full programming-style control flow inside test cases. All blocks are added via the <b>Insert Block</b> toolbar at the bottom of the Steps tab.</P>
          <H3>🔁 Loop (Repeat N times)</H3>
          <P>Repeats a block of steps a fixed number of times. Use <Code>{"{{__loop_index__}}"}</Code> to get the current iteration (0-based).</P>
          <P><b>Use case:</b> Create 5 patients with different random names in one test run.</P>
          <H3>📋 ForEach (Iterate a list)</H3>
          <P>Runs steps once per item in a comma-separated list. Use <Code>{"{{current_item}}"}</Code> (or your chosen variable name) to access the current item.</P>
          <P><b>Use case:</b> Test login with multiple roles: <Code>admin, doctor, nurse, receptionist</Code></P>
          <H3>❓ IF / ELSE</H3>
          <P>Runs different steps based on a condition. Available conditions:</P>
          <Table headers={["Condition","Description"]} rows={[
            ["Element is visible","Checks if a CSS selector is visible on page"],
            ["Element is NOT visible","Checks if element is hidden"],
            ["Variable == value","Compares a variable to an exact string"],
            ["Variable != value","Variable does not equal value"],
            ["Variable contains","Variable contains a substring"],
            ["URL contains","Current page URL contains text"],
            ["URL does NOT contain","URL does not contain text"],
            ["Page title contains","Browser title bar contains text"],
          ]} />
          <H3>🔀 Switch / Case</H3>
          <P>Matches a variable against multiple exact values and runs the matching block. Like a multi-branch IF.</P>
          <P><b>Use case:</b> Based on <Code>{"{{department}}"}</Code> variable, navigate to different ward pages.</P>
          <H3>🔄 Repeat Until</H3>
          <P>Keeps running a block until a condition becomes TRUE. Set max retries and interval between checks.</P>
          <P><b>Use case:</b> Keep clicking Refresh until a status element shows "Completed".</P>
          <H3>🛡️ Try / Catch</H3>
          <P>If any step in the Try block fails, execution jumps to the Catch block instead of stopping the test. Store the error message in a variable for logging.</P>
          <P><b>Use case:</b> Try to click an optional popup dismiss button — if it's not there, catch the error and continue.</P>
          <H3>⏳ Wait Until</H3>
          <P>Pauses the test until a condition becomes TRUE, polling every 500ms up to a configurable timeout.</P>
          <H3>⛔ Break / ⏭️ Continue</H3>
          <P><b>Break</b> exits the current loop immediately. <b>Continue</b> skips the remaining steps in this iteration and moves to the next one.</P>
          <Note>All control flow blocks are also available in the Script Editor as Python syntax — <Code>for ... in range(N):</Code>, <Code>if ...: / else:</Code>, <Code>try: / except:</Code></Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "variables": return (
        <div>
          <H2>Variables</H2>
          <P>Variables are defined at the test case level and resolved before each run. They are referenced in any step field using <Code>{"{{variable_name}}"}</Code>.</P>
          <H3>Variable Types</H3>
          <Table headers={["Type","Config","Example output","Use case"]} rows={[
            ["📌 Fixed Value","The exact value","admin123","Reusable passwords, codes"],
            ["🎲 Random Email","Prefix (optional)","user_48291032@test.com","Create unique test users"],
            ["🔢 Random Number","Range e.g. 100-999","742","Patient IDs, order numbers"],
            ["🔤 Random Text","Length e.g. 8","XkqPbmrT","Random names, notes"],
            ["🕒 Timestamp","Format e.g. YYYYMMDD","20260319","Date-stamped filenames"],
            ["📋 From List","a, b, c","b (random pick)","Test with multiple values"],
            ["🔢 Increment","Start number e.g. 1","1, 2, 3… per run","Sequential test data"],
            ["🗄️ DB Query","SQL query","First cell result","Fetch real data from DB"],
          ]} />
          <H3>Using Variables in Steps</H3>
          <P>In any step field, click the <Code>{"{{..}}"}</Code> button to insert a variable, or type it manually:</P>
          <CodeBlock>{`Type text → selector: #firstName → value: {{patient_name}}
Navigate  → value: https://sqa.athma.org/patient/{{patient_id}}`}</CodeBlock>
          <H3>Random Variables in Loops</H3>
          <P>Variables of type <b>random_email</b>, <b>random_text</b>, <b>random_number</b>, <b>timestamp</b>, <b>from_list</b> and <b>uuid</b> are <b>regenerated on every loop iteration</b>. This means a Loop of 5 will create 5 patients with 5 different names.</P>
          <P><b>Fixed</b>, <b>increment</b>, and <b>db_query</b> variables stay consistent throughout the run.</P>
          <H3>Stored Variables (from Store steps)</H3>
          <P>Use <b>💾 Store element text</b> to capture a value from the page into a variable at runtime. That variable is then available in all subsequent steps.</P>
          <CodeBlock>{`Step 1: Store element text → selector: #patientId → variable: pid
Step 2: Assert URL contains → value: /patient/{{pid}}`}</CodeBlock>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "selectors": return (
        <div>
          <H2>Finding Selectors</H2>
          <P>A selector tells ATHMA which element on the page to interact with. ATHMA supports multiple selector formats.</P>
          <H3>Selector Formats</H3>
          <Table headers={["Format","Example","When to use"]} rows={[
            ["CSS ID","#username","Element has a unique id attribute"],
            ["CSS Class",".btn-primary","Element has a unique class"],
            ["CSS Attribute","input[name='dob']","Target by any attribute"],
            ["CSS Combined","form#registration .submit-btn","Precise targeting"],
            ["Text match","text=Create New","Match by visible text"],
            ["Exact text",":text-is(\"Submit\")","Exact text, case sensitive"],
            ["Placeholder","[placeholder='Search']","Input with placeholder"],
            ["Aria Label","[aria-label='Close dialog']","Accessible elements"],
            ["get_by_role","get_by_role(\"button\", name=\"Submit\")","Playwright modern API"],
            ["get_by_text","get_by_text(\"Patient List\")","Text-based Playwright locator"],
            ["get_by_label","get_by_label(\"Date of Birth\")","Form label association"],
            ["get_by_placeholder","get_by_placeholder(\"Enter name\")","Input placeholder"],
          ]} />
          <H3>How to Find a Selector</H3>
          <P><b>Method 1 — CSS Inspector (recommended):</b> Click the 🎯 button next to any selector field → a browser opens → hover over the element and press F2 → multiple selectors are sent to ATHMA, pick the best one.</P>
          <P><b>Method 2 — Browser DevTools:</b> Right-click element → Inspect → right-click in DevTools → Copy → Copy selector.</P>
          <P><b>Method 3 — Recorder:</b> Record your actions and selectors are captured automatically.</P>
          <H3>Selector Best Practices</H3>
          <Note type="info">Prefer <Code>get_by_role</Code>, <Code>get_by_label</Code>, and <Code>get_by_placeholder</Code> — they are stable even when CSS classes change.</Note>
          <Note type="warn">Avoid auto-generated selectors like <Code>#mat-input-47</Code> — these numbers change after each Angular component re-render.</Note>
          <Note type="danger">Never use XPath in ATHMA — use CSS selectors or Playwright locators instead.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "inspector": return (
        <div>
          <H2>CSS Inspector</H2>
          <P>The CSS Inspector opens a live browser window where you can navigate freely, then hover over any element and press <b>F2</b> to capture multiple selectors for it.</P>
          <H3>How to Use</H3>
          <Step n={1}>In any test step that needs a selector, click the <b>🎯 button</b></Step>
          <Step n={2}>Optionally enter a Start URL and click <b>Open Inspector Browser</b></Step>
          <Step n={3}>A Chrome window opens — navigate to your page, login if needed</Step>
          <Step n={4}>Hover over the element you want to target</Step>
          <Step n={5}>Press <b>F2</b> — the element's selectors are sent to ATHMA</Step>
          <Step n={6}>A panel shows multiple selector options — click the best one to use it</Step>
          <Step n={7}>The browser stays open — press F2 on another element for <b>Pick Again</b></Step>
          <Step n={8}>Click <b>Cancel & Close Browser</b> when done</Step>
          <H3>Selector Priority</H3>
          <P>ATHMA shows selectors in this order of reliability: <b>get_by_role</b> → <b>get_by_placeholder</b> → <b>aria-label</b> → <b>id</b> → <b>name attribute</b> → <b>text match</b>. The first option (marked BEST) is recommended.</P>
          <Note>The Inspector browser must stay open until you pick a selector. It closes automatically when you click a selector option or Cancel.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "recorder": return (
        <div>
          <H2>Recorder — Chrome Extension</H2>

          {/* Download Card */}
          <div style={{ background:"linear-gradient(135deg,#1a2332,#1a6fc4)",
            borderRadius:12, padding:"20px 24px", marginBottom:24,
            display:"flex", alignItems:"center", justifyContent:"space-between", gap:16 }}>
            <div>
              <div style={{ fontSize:16, fontWeight:800, color:"#fff", marginBottom:4 }}>
                🧩 ATHMA Chrome Extension
              </div>
              <div style={{ fontSize:12, color:"#93c5fd", lineHeight:1.7 }}>
                Download and install the extension to record test steps directly in Chrome.
                <br/>Login to NAT is required to use the recorder.
              </div>
            </div>
            <button
              onClick={() => {
                const a = document.createElement('a');
                a.href = `${window.location.protocol}//${window.location.hostname}:6001/api/extension/download?token=${localStorage.getItem('autoqa_token')}`;
                a.download = 'ATHMA-Extension.zip';
                a.click();
              }}
              style={{ background:"#fff", color:"#1a2332", border:"none",
                borderRadius:9, padding:"11px 22px", fontSize:13, fontWeight:800,
                cursor:"pointer", whiteSpace:"nowrap", flexShrink:0,
                boxShadow:"0 4px 14px rgba(0,0,0,0.2)",
                display:"flex", alignItems:"center", gap:8 }}>
              ⬇️ Download Extension
            </button>
          </div>

          <H3>How to Install</H3>
          <Step n={1}>Click <b>⬇️ Download Extension</b> above</Step>
          <Step n={2}>Extract the ZIP file anywhere on your computer</Step>
          <Step n={3}>Open Chrome and go to <Code>chrome://extensions</Code></Step>
          <Step n={4}>Enable <b>Developer mode</b> (toggle in top-right corner)</Step>
          <Step n={5}>Click <b>Load unpacked</b> and select the extracted folder</Step>
          <Step n={6}>The ATHMA extension icon appears in Chrome toolbar</Step>

          <H3>How to Record</H3>
          <Step n={1}>Log in to <b>ATHMA NAT</b> first (required for auth)</Step>
          <Step n={2}>Navigate to the page you want to test in Chrome</Step>
          <Step n={3}>Click the <b>ATHMA extension</b> icon in the toolbar</Step>
          <Step n={4}>Click <b>⏺ Start Recording Here</b> — recording starts on the current page</Step>
          <Step n={5}>Perform your test actions (click, type, navigate)</Step>
          <Step n={6}>Click <b>⏹ Stop</b> in the extension popup</Step>
          <Step n={7}>Click <b>💾 Save to NAT</b> — steps load automatically in ATHMA</Step>
          <Step n={8}>Enter a name, select a project, click <b>Save</b></Step>

          <H3>Record More Steps</H3>
          <P>After stopping, click <b>⏺ Record More Steps</b> to go back and record additional actions. All sessions are accumulated and sent together when you click Save to NAT.</P>

          <Note>Only users logged into ATHMA NAT can use the recorder. The extension verifies your session before allowing any recording.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "scripteditor": return (
        <div>
          <H2>Script Editor</H2>
          <P>The Script tab shows your test steps as Python Playwright code. You can edit the code directly and save it back to steps.</P>
          <H3>Supported Code Patterns</H3>
          <CodeBlock>{`def run(page):
    # Navigation
    page.goto("https://sqa.athma.org/")
    page.wait_for_url("https://sqa.athma.org/home", timeout=30000)

    # Interactions (with or without timeout= argument)
    page.fill("#username", "admin", timeout=30000)
    page.click('button[type="submit"]', timeout=30000)
    page.select_option("#department", "Cardiology")

    # Assertions
    assert "Dashboard" in page.title()
    assert page.locator(".patient-count").is_visible()

    # Store values
    patient_id = page.locator("#patientId").inner_text()

    # DB Validate comment
    # DB Validate: SELECT count(*) FROM patients WHERE status='active'

    # Control Flow
    for __loop_index__ in range(3):
        page.goto("https://sqa.athma.org/register")

    if page.locator(".popup").is_visible():
        page.click(".popup-close")
    else:
        page.click(".continue-btn")`}</CodeBlock>
          <H3>Insert Toolbar</H3>
          <P>Use the Insert toolbar at the top to add code snippets at the cursor position: <Code>goto</Code>, <Code>click</Code>, <Code>fill</Code>, <Code>assert</Code>, <Code>sleep</Code>, <Code>screenshot</Code>, <Code>for N times</Code>, <Code>for each</Code>, <Code>if/else</Code>, <Code>try/except</Code>.</P>
          <H3>Keyboard Shortcuts</H3>
          <Table headers={["Key","Action"]} rows={[
            ["Tab","Insert 4 spaces (indent)"],
            ["Ctrl+S","Save to Steps"],
          ]} />
          <Note>After saving, switch to the <b>Steps tab</b> to verify the steps were parsed correctly. If a line could not be parsed it is silently skipped — check for typos in the selector or action name.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "suiterunner": return (
        <div>
          <H2>Suite Runner</H2>
          <P>The Suite Runner lets you execute all (or selected) test cases in a suite as a batch, with a single click.</P>
          <H3>Running a Suite</H3>
          <Step n={1}>Go to <b>🚀 Suite Runner</b> in the sidebar</Step>
          <Step n={2}>Select a <b>Project</b> then a <b>Test Suite</b></Step>
          <Step n={3}>Select individual tests or click <b>Select All</b></Step>
          <Step n={4}>Choose a browser</Step>
          <Step n={5}>Click <b>🚀 Run Suite</b></Step>
          <H3>Live Progress</H3>
          <P>A progress bar shows how many tests have passed / failed / are pending in real time. Each test runs sequentially — one completes before the next starts.</P>
          <H3>Results Table</H3>
          <P>After completion, each test case shows its status, duration, and failure reason. Click any row to see full step-by-step logs.</P>
          <H3>History</H3>
          <P>Click the <b>📋 History</b> tab to see all past suite runs. Click <b>📥 HTML</b> to download a Katalon-style report for any run.</P>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "schedules": return (
        <div>
          <H2>Schedules</H2>
          <P>Schedules allow you to run a test case or an entire suite automatically on a recurring basis using cron expressions.</P>
          <H3>Creating a Schedule</H3>
          <Step n={1}>Go to <b>⏰ Schedules</b> → click <b>+ New Schedule</b></Step>
          <Step n={2}>Choose <b>Suite</b> (runs all tests in a suite) or <b>Single Test</b></Step>
          <Step n={3}>Select the suite or test case</Step>
          <Step n={4}>Choose a preset time or enter a custom cron expression</Step>
          <Step n={5}>Select browser</Step>
          <Step n={6}>Optionally enter a <b>Notify Email</b> — an HTML report will be emailed after each run</Step>
          <Step n={7}>Click <b>⏰ Create Schedule</b></Step>
          <H3>Cron Expression Guide</H3>
          <Table headers={["Preset","Cron","Meaning"]} rows={[
            ["Every day at 9am","0 9 * * *","Runs Monday–Sunday at 09:00"],
            ["Every weekday at 8am","0 8 * * 1-5","Runs Mon–Fri only"],
            ["Every hour","0 * * * *","Top of every hour"],
            ["Every 30 minutes","*/30 * * * *","Every half hour"],
            ["Every Sunday at midnight","0 0 * * 0","Weekly on Sunday"],
          ]} />
          <H3>Email Reports</H3>
          <P>If <b>Notify Email</b> is set, after each suite run ATHMA will:</P>
          <Step n={1}>Generate a Katalon-style HTML report with full logs</Step>
          <Step n={2}>Email it to the configured address as an attachment</Step>
          <Note type="warn">Email requires SMTP settings in your <Code>.env</Code> file: <Code>SMTP_HOST</Code>, <Code>SMTP_PORT</Code>, <Code>SMTP_USER</Code>, <Code>SMTP_PASS</Code></Note>
          <H3>Managing Schedules</H3>
          <P>Toggle a schedule on/off with the Active switch. Delete schedules with the 🗑️ button. Schedules survive server restarts — they are reloaded from the database on startup.</P>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "debug": return (
        <div>
          <H2>Debug Mode</H2>
          <P>Debug Mode lets you run a test with a live visible browser, pause at specific steps, inspect variables, and step through execution one step at a time.</P>
          <H3>Activating Debug Mode</H3>
          <Step n={1}>Open any test case → click <b>▶ Run</b></Step>
          <Step n={2}>Click <b>🐛 Debug OFF</b> to toggle it ON (button turns orange)</Step>
          <Step n={3}>Configure options (see below)</Step>
          <Step n={4}>Click <b>🐛 Start Debug Run</b></Step>
          <H3>Debug Options</H3>
          <Table headers={["Option","Description"]} rows={[
            ["Slow motion","Adds a delay between each step so you can watch the browser"],
            ["Pause after every step","Step-through mode — pauses after each step"],
            ["Breakpoints","Click step number badges to set red breakpoints — test pauses before that step"],
          ]} />
          <H3>Debug Controls (when paused)</H3>
          <Table headers={["Button","Action"]} rows={[
            ["⏭ Step","Execute this step then pause again"],
            ["⏩ Skip","Skip this step entirely without executing it"],
            ["▶ Continue","Run until the next breakpoint"],
            ["⏹ Stop","Abort the run immediately"],
          ]} />
          <H3>Variable Watch</H3>
          <P>When paused, a <b>Variable Watch</b> panel shows all current variable values. This lets you see exactly what <Code>{"{{patient_name}}"}</Code> resolved to at that point in the test.</P>
          <Note>Debug mode opens the browser visibly (headed mode). The browser window appears on your desktop — you can see every step execute in real time.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "dbvalidate": return (
        <div>
          <H2>DB Validation</H2>
          <P>The <b>🗄️ DB Validate Query</b> action runs a SQL query against your database and asserts the result, making it possible to verify that test actions correctly updated the database.</P>
          <H3>Setting Up DB Connections</H3>
          <Step n={1}>Go to <b>🗄️ DB Connections</b> in the sidebar</Step>
          <Step n={2}>Click <b>+ New Connection</b></Step>
          <Step n={3}>Enter: Name, DB Type (PostgreSQL/MySQL), Host, Port, Database, Username, Password</Step>
          <Step n={4}>Click <b>Test Connection</b> to verify it works</Step>
          <Step n={5}>Save the connection</Step>
          <H3>Adding a DB Validate Step</H3>
          <P>In the Steps tab, from the action dropdown select <b>🗄️ DB Validate Query</b>. Configure:</P>
          <Table headers={["Field","Description"]} rows={[
            ["Connection","Select a saved connection or enter manual credentials"],
            ["SQL Query","The SELECT query to run. Use {{variables}} for dynamic values"],
            ["Assertion type","equals / contains / row_count / store"],
            ["Expected value","What the query result should be"],
          ]} />
          <H3>Assertion Types</H3>
          <Table headers={["Type","Description"]} rows={[
            ["equals","First cell of first row equals expected value exactly"],
            ["contains","First cell contains expected value as substring"],
            ["row_count","Number of rows returned equals expected number"],
            ["store","Store first cell value into a variable for later steps"],
          ]} />
          <H3>Example</H3>
          <CodeBlock>{`Query:     SELECT count(*) FROM patients WHERE mrn = '{{patient_mrn}}'
Assertion: equals
Expected:  1`}</CodeBlock>
          <P>This passes if exactly 1 patient with that MRN exists after your registration step ran.</P>
          <Note type="warn">DB Validate requires <Code>psycopg2-binary</Code> (PostgreSQL) or <Code>mysql-connector-python</Code> (MySQL) installed: <Code>pip install psycopg2-binary --break-system-packages</Code></Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "reports": return (
        <div>
          <H2>Reports & Email Notifications</H2>
          <H3>HTML Report Format</H3>
          <P>After any suite run, ATHMA generates a standalone Katalon-style HTML report that includes:</P>
          <Table headers={["Section","Contents"]} rows={[
            ["Execution Environment","Host name, OS, browser, suite name, start/end time, elapsed duration"],
            ["Summary","Total tests, passed (green), failed (red), skipped — with large number display"],
            ["Test Execution Log","Each test case as an expandable row with full step-by-step logs"],
          ]} />
          <H3>Downloading Reports</H3>
          <P>In <b>🚀 Suite Runner</b> → <b>📋 History</b> tab:</P>
          <P>• Click the <b>📥 HTML</b> button on any history row</P>
          <P>• Or open the detail modal and click <b>📥 Download HTML Report</b></P>
          <P>The report is regenerated fresh from the database every time — always reflects the latest data.</P>
          <H3>Email Notifications</H3>
          <P>When a scheduled suite run completes, if the schedule has a <b>Notify Email</b> configured, an email is automatically sent with:</P>
          <P>• Subject: <Code>✅ PASSED — Suite Name (42/64 passed)</Code></P>
          <P>• Body: Summary table</P>
          <P>• Attachment: Full HTML report file</P>
          <H3>SMTP Configuration</H3>
          <CodeBlock>{`# In backend/.env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password    # Gmail: use App Password
SMTP_FROM=ATHMA Reports <your@gmail.com>`}</CodeBlock>
          <Note type="warn">For Gmail, generate an <b>App Password</b> at myaccount.google.com → Security → App passwords. Do not use your regular Gmail password.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "aigenerate": return (
        <div>
          <H2>AI Script Generator</H2>
          <P>The AI Generator uses Claude (Anthropic's AI model) to analyze screenshots of your application and generate complete test scripts automatically.</P>
          <H3>Prerequisites</H3>
          <P>Set your Anthropic API key in <Code>backend/.env</Code>:</P>
          <CodeBlock>{`ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx`}</CodeBlock>
          <P>Get your key at <Code>console.anthropic.com</Code>.</P>
          <H3>How to Use</H3>
          <Step n={1}>Go to <b>🤖 AI Generator</b> in the sidebar</Step>
          <Step n={2}>Upload screenshots of the flow you want to automate (drag & drop or click)</Step>
          <Step n={3}>Label each screenshot (e.g. "Login page", "Patient form", "Success message")</Step>
          <Step n={4}>Add optional context: "This is patient registration. Login: admin/admin123"</Step>
          <Step n={5}>Click <b>🤖 Generate Test Steps</b></Step>
          <Step n={6}>Review and edit the generated steps inline</Step>
          <Step n={7}>Enter a test name, select a suite, click <b>💾 Save Test Case</b></Step>
          <H3>What the AI generates</H3>
          <P>The AI analyzes each screenshot and infers: page navigation, form field interactions, button clicks, and suggested assertions. It uses Playwright locators based on visible text and element roles.</P>
          <Note type="warn">Always review generated steps before running. The AI may not perfectly capture every element — use the Inspector or Recorder to fix any missing or incorrect selectors.</Note>
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "architecture": return (
        <div>
          <H2>ATHMA Architecture</H2>
          <H3>System Overview</H3>
          <CodeBlock>{`┌─────────────────────────────────────────────────────────────────┐
│                        ATHMA Platform                          │
│                                                                 │
│  ┌──────────────────┐     HTTP/WS      ┌──────────────────┐   │
│  │   React Frontend  │ ◄────────────── │  Node.js Backend  │   │
│  │  (Vite, port 5176)│ ────────────── ► │  (Express, 6001)  │   │
│  └──────────────────┘                  └─────────┬────────┘   │
│                                                   │             │
│                                         ┌─────────▼────────┐   │
│                                         │   PostgreSQL DB    │   │
│                                         │  (automation_db)  │   │
│                                         └──────────────────┘   │
│                                                   │             │
│                                         ┌─────────▼────────┐   │
│                                         │  Python Runner    │   │
│                                         │  (Playwright)     │   │
│                                         └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘`}</CodeBlock>
          <H3>Component Breakdown</H3>
          <H3>1. React Frontend (app.jsx)</H3>
          <P>Single-file React application (~6800 lines) using Vite as the build tool. Communicates with the backend over REST HTTP and WebSocket for live logs.</P>
          <Table headers={["Component","Responsibility"]} rows={[
            ["App","Root component, routing between tabs, user session"],
            ["TestCases","CRUD for test cases, run trigger, script import"],
            ["StepEditor","Visual step builder with all 30+ action types"],
            ["ScriptEditor","Python code editor with live parse → steps sync"],
            ["FlowBuilder","N8N-style visual canvas (available for future use)"],
            ["RunModal","Live log viewer, debug controls, screenshot gallery"],
            ["SuiteRunner","Batch test execution with live progress"],
            ["Schedules","Cron-based scheduling with email notifications"],
            ["AiGenerator","Screenshot upload → AI test generation"],
            ["HelpDocs","This documentation"],
          ]} />
          <H3>2. Node.js Backend (server.js)</H3>
          <P>Express server providing REST API and WebSocket server. Also responsible for spawning test runner processes.</P>
          <Table headers={["Module","Responsibility"]} rows={[
            ["Authentication","JWT-based sessions, role-based access (admin/lead/tester/viewer)"],
            ["Projects/Suites/Tests","Full CRUD API for test hierarchy"],
            ["Test Runner","Spawns Python runner process per test run, streams logs via WebSocket"],
            ["Scheduler","node-cron based job scheduler, reloaded from DB on startup"],
            ["Inspector","Spawns inspector.py, manages session lifecycle"],
            ["Recorder","Spawns Playwright codegen, reads generated script"],
            ["Suite Runs","Manages batch execution, tracks pass/fail counts"],
            ["HTML Reports","Generates Katalon-style HTML from run data"],
            ["Email","nodemailer SMTP integration for report delivery"],
            ["AI Endpoints","/api/ai/generate-steps calls Anthropic Claude API"],
            ["WebSocket","Broadcasts live logs, screenshots, debug events to frontend"],
          ]} />
          <H3>3. Python Runner (runner.py)</H3>
          <P>Playwright-based test executor. Spawned as a separate OS process for each test run by the Node.js backend.</P>
          <Table headers={["Feature","Implementation"]} rows={[
            ["Step execution","run_step() handles all 30+ action types"],
            ["Control flow","run_steps_with_flow() recursive interpreter"],
            ["Variable resolution","resolve_variable() with 7 types, regenerates randoms in loops"],
            ["Live screenshots","JPEG capture sent to backend every step"],
            ["DB Validation","psycopg2/mysql-connector direct DB queries"],
            ["API testing","requests library for HTTP assertions"],
            ["Debug mode","--debug flag, polls /api/runs/:id/debug-command"],
          ]} />
          <H3>4. PostgreSQL Database</H3>
          <Table headers={["Table","Contents"]} rows={[
            ["auto_users","User accounts, roles, hashed passwords"],
            ["auto_sessions","JWT session tokens"],
            ["projects","Project definitions"],
            ["test_suites","Suite definitions, linked to projects"],
            ["test_cases","Test definitions with steps (JSON), variables (JSON)"],
            ["test_runs","Each execution result with logs (JSON array), screenshots"],
            ["suite_runs","Batch suite execution records"],
            ["schedules","Cron job definitions with suite_id or test_case_id"],
            ["db_connections","Saved database connection credentials"],
          ]} />
          <H3>5. Python Inspector (inspector.py)</H3>
          <P>A separate Playwright browser instance that injects JavaScript overlay into any page. The overlay tracks mouse position and captures element selectors on F2 press. Communicates results back to the backend via HTTP POST.</P>
          <H3>Data Flow: Running a Test</H3>
          <CodeBlock>{`User clicks ▶ Run
    │
    ▼
Frontend POST /api/tests/:id/run
    │
    ▼
Backend creates test_run record in DB (status: queued)
Backend spawns: python runner.py --run-id 42 --config {...}
Backend responds: { run_id: 42 }
    │
    ▼
Frontend connects WebSocket: ws://localhost:6001?runId=42
    │
    ▼
runner.py executes steps with Playwright
    ├── Each step: POST /api/runs/42/log  (log entry)
    ├── Each step: POST /api/runs/42/live-screen  (JPEG screenshot)
    └── Each step: WebSocket broadcasts to all subscribers
    │
    ▼
runner.py completes
PATCH /api/runs/42 { status: "passed", duration_ms: 12450, ... }
WebSocket broadcasts { type: "done" }
    │
    ▼
Frontend shows final status, screenshots available`}</CodeBlock>
          <H3>Data Flow: Scheduled Suite Run</H3>
          <CodeBlock>{`node-cron fires at scheduled time
    │
    ▼
Fetch suite → fetch all active test cases
Create suite_runs record
    │
    ▼
For each test case (sequentially):
    ├── Create test_runs record
    ├── Spawn runner.py process
    └── Wait for process exit
    │
    ▼
Compute passed/failed counts
Update suite_runs record
Generate HTML report → save to disk
If notify_email set → send email with attachment`}</CodeBlock>
          <H3>Security Architecture</H3>
          <Table headers={["Concern","Implementation"]} rows={[
            ["Authentication","SHA-256 hashed passwords, JWT tokens, 8-hour session expiry"],
            ["Authorization","Role-based middleware (admin > lead > tester > viewer)"],
            ["DB credentials","Stored in PostgreSQL, never exposed to frontend"],
            ["API keys","Anthropic key stored in .env, never sent to client"],
            ["WebSocket","Filtered by runId — clients only receive their own run's events"],
          ]} />
          <H3>Port Reference</H3>
          <Table headers={["Service","Port","Protocol"]} rows={[
            ["React Frontend","5176","HTTP (dev)"],
            ["Node.js Backend","6001","HTTP + WebSocket"],
            ["PostgreSQL","5432","TCP"],
          ]} />
        </div>
      );

      // ─────────────────────────────────────────────────────────────────────
      case "troubleshoot": return (
        <div>
          <H2>Troubleshooting</H2>
          <H3>Test fails: "Timeout waiting for element"</H3>
          <P>The selector didn't find the element within 30 seconds.</P>
          <P>• Use the 🎯 Inspector to verify the selector is correct</P>
          <P>• Add a <Code>wait_for_selector</Code> step before the failing step</P>
          <P>• Check if the element is inside an iframe — ATHMA doesn't currently support iframes</P>
          <P>• Increase the step timeout in Settings tab of the step</P>
          <H3>Test fails: "Navigation timeout"</H3>
          <P>Page took too long to load. Options:</P>
          <P>• Add <Code>wait_for_url</Code> step after navigation</P>
          <P>• Increase base timeout in step settings</P>
          <H3>Inspector not working</H3>
          <P>• Ensure <Code>inspector.py</Code> is in the <Code>runner/</Code> folder (same as runner.py)</P>
          <P>• Check the backend console for "[inspector] Found at: ..." message</P>
          <P>• Ensure Python path is correct in <Code>server.js</Code> line ~25</P>
          <H3>Recorder produces no steps</H3>
          <P>• Paste the generated script into Script tab → Save to Steps</P>
          <P>• The script parser handles <Code>timeout=</Code> args and mixed quotes</P>
          <H3>Suite scheduler not running</H3>
          <P>• Check that the schedule shows as <b>Active</b> (green dot)</P>
          <P>• Run the SQL migrations: <Code>01_create_suite_runs.sql</Code> and <Code>02_add_suite_scheduler.sql</Code></P>
          <P>• Check backend console for <Code>⏰ Schedule #N triggered</Code> messages</P>
          <H3>Email reports not sending</H3>
          <P>• Verify SMTP settings in <Code>.env</Code></P>
          <P>• Run <Code>npm install nodemailer</Code> in backend folder</P>
          <P>• For Gmail: use an App Password, not your account password</P>
          <H3>AI Generator error</H3>
          <P>• Set <Code>ANTHROPIC_API_KEY</Code> in <Code>.env</Code> and restart the backend</P>
          <P>• Ensure billing is active at <Code>console.anthropic.com</Code></P>
          <P>• Image format must be PNG or JPG</P>
          <H3>DB Validation fails to connect</H3>
          <P>• Run <Code>pip install psycopg2-binary --break-system-packages</Code></P>
          <P>• Test the connection in <b>🗄️ DB Connections</b> page first</P>
          <P>• Ensure the DB host is reachable from the machine running the backend</P>
        </div>
      );

      default: return null;
    }
  };

  return (
    <div style={{ display:"flex", gap:0, minHeight:600 }}>
      {/* Sidebar nav */}
      <div style={{ width:210, flexShrink:0, borderRight:"1px solid #e2e6ed",
        padding:"16px 8px", background:"#f8f9fc" }}>
        <div style={{ fontSize:11, fontWeight:700, color:"#a0aec0", textTransform:"uppercase",
          letterSpacing:"0.08em", padding:"0 14px 8px" }}>DOCUMENTATION</div>
        {sections.map(sec => <SectionBtn key={sec.key} s={sec} />)}
      </div>
      {/* Content */}
      <div style={{ flex:1, padding:"20px 32px", overflowY:"auto", maxHeight:"80vh" }}>
        {renderSection()}
      </div>
    </div>
  );
}



export { Schedules, AiGenerator, layoutNodes, FlowBuilder, NodeSidePanel, HelpDocs };
