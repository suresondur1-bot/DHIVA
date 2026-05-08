import React, { useState, useEffect, useRef, useCallback } from "react";
import { api, s, getAppPageSize, C, Badge, Empty, getToken, API, WS, statusColor, statusBg } from "./shared.jsx";
import { StepEditor, ScriptEditor, VariablesPanel, stepsToScript, scriptToSteps } from "./Editors.jsx";
import { QueryBuilder, QueryPreview } from "./Admin.jsx";


// ─── STATIC SUITE PICKER ─────────────────────────────────────────────────────
// Cache fetched tests per project so re-opening the modal doesn't re-fetch
const _suitePickerCache = {};

function StaticSuitePicker({ projectId, selectedCases, setSelectedCases, testOrder, setTestOrder }) {
  const [tests,   setTests]   = useState(() => _suitePickerCache[projectId] || []);
  const [loading, setLoading] = useState(!_suitePickerCache[projectId]);
  const [search,  setSearch]  = useState("");

  useEffect(() => {
    if (!projectId) return;
    if (_suitePickerCache[projectId]) {
      setTests(_suitePickerCache[projectId]);
      setLoading(false);
      return;
    }
    setLoading(true);
    api(`/api/tests?project_id=${projectId}&limit=500`)
      .then(r => {
        const rows = Array.isArray(r) ? r : r?.rows||[];
        _suitePickerCache[projectId] = rows;
        setTests(rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [projectId]);

  const filtered = tests.filter(t =>
    !search || t.name?.toLowerCase().includes(search.toLowerCase())
  );

  const orderValues = Object.values(testOrder||{}).filter(Boolean).map(Number);
  const dupOrders = orderValues.filter((o,i) => orderValues.indexOf(o) !== i);

  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
        <label style={s.label}>Select Test Cases ({selectedCases.size} selected)</label>
        <div style={{ display:"flex", gap:6 }}>
          <button style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px" }}
            onClick={()=>setSelectedCases(new Set(filtered.map(t=>t.id)))}>Select All</button>
          <button style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px" }}
            onClick={()=>setSelectedCases(new Set())}>Clear</button>
        </div>
      </div>
      <input style={{ ...s.input, marginBottom:6 }} placeholder="🔍 Search test cases..."
        value={search} onChange={e=>setSearch(e.target.value)} />
      {dupOrders.length > 0 && (
        <div style={{ background:"#fffbeb", border:"1px solid #fcd34d", borderRadius:6,
          padding:"6px 10px", fontSize:11, color:"#92400e", marginBottom:6 }}>
          ⚠️ Duplicate order number{dupOrders.length>1?"s":""}: <b>{[...new Set(dupOrders)].join(", ")}</b> — tie broken by original order
        </div>
      )}
      {loading ? (
        <div style={{ padding:16, textAlign:"center", color:"#9ca3af" }}>⏳ Loading...</div>
      ) : (
        <div style={{ background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:8,
          maxHeight:260, overflowY:"auto" }}>
          {/* Header */}
          <div style={{ display:"grid", gridTemplateColumns:"32px 1fr 70px",
            gap:8, padding:"6px 12px", background:"#f3f4f6",
            borderBottom:"1px solid #e5e7eb", position:"sticky", top:0 }}>
            <div/>
            <div style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase" }}>Test Case</div>
            <div style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase" }}>Order</div>
          </div>
          {filtered.length===0 && (
            <div style={{ padding:16, textAlign:"center", color:"#9ca3af", fontSize:13 }}>
              No test cases found in this project
            </div>
          )}
          {filtered.map(t => {
            const checked = selectedCases.has(t.id);
            const pc = t.priority==="critical"?"#e53935":t.priority==="high"?"#f97316":t.priority==="medium"?"#f59e0b":"#64748b";
            const sid = String(t.id);
            const isDup = dupOrders.includes(Number(testOrder?.[sid]));
            return (
              <div key={t.id}
                style={{ display:"grid", gridTemplateColumns:"32px 1fr 70px",
                  gap:8, padding:"8px 12px", alignItems:"center",
                  cursor:"pointer", borderBottom:"1px solid #f3f4f6",
                  background:checked?"#eff6ff":"transparent" }}>
                <input type="checkbox" checked={checked} readOnly
                  onClick={e=>{ e.stopPropagation(); setSelectedCases(prev=>{ const n=new Set(prev); n.has(t.id)?n.delete(t.id):n.add(t.id); return n; }); }}
                  style={{ cursor:"pointer" }} />
                <div onClick={()=>setSelectedCases(prev=>{ const n=new Set(prev); n.has(t.id)?n.delete(t.id):n.add(t.id); return n; })}>
                  <div style={{ fontSize:12, fontWeight:600, color:"#111827" }}>{t.name}</div>
                  <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>
                    {t.module_name && <span style={{ marginRight:8 }}>📦 {t.module_name}</span>}
                    <span style={{ color:pc, fontWeight:600 }}>{t.priority}</span>
                  </div>
                </div>
                <input
                  type="number" min="1"
                  placeholder="—"
                  value={testOrder?.[sid] || ""}
                  onClick={e=>e.stopPropagation()}
                  onChange={e=>setTestOrder(prev=>({
                    ...prev,
                    [sid]: e.target.value ? parseInt(e.target.value) : null
                  }))}
                  style={{ ...s.input, margin:0, width:60, fontSize:12, padding:"3px 6px",
                    textAlign:"center",
                    borderColor: isDup ? "#f59e0b" : "#e5e7eb",
                    background: isDup ? "#fffbeb" : "#fff" }}
                />
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize:11, color:"#9ca3af", marginTop:4 }}>
        💡 Set order numbers to control run sequence. Ordered tests run first, blank = after ordered ones.
      </div>
    </div>
  );
}

function TestSuites({ projects, suites, onRefresh, user }) {
  const [recModal] = useState(false);
  const [scriptModal] = useState(null);
  const [modal,      setModal]      = useState(false);
  const [editItem,   setEditItem]   = useState(null);
  const [delItem,    setDelItem]    = useState(null);
  const [form,       setForm]       = useState({ name:"", description:"", project_id:"", suite_type:"static", filter_config:{ conditions:[], logic:"AND" } });
  const [allModules, setAllModules] = useState([]);
  const [preview,    setPreview]    = useState(null); // matching test cases
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedCases,  setSelectedCases]  = useState(new Set()); // selected from preview
  const [testOrder,      setTestOrder]      = useState({});         // { tcId: orderNumber }
  useEffect(()=>{ api("/api/modules").then(m=>setAllModules(m||[])).catch(()=>setAllModules([])); },[]);
  const [saving,     setSaving]     = useState(false);
  const [projFilter, setProjFilter] = useState("");
  const canManage = ["admin","lead","tester","superadmin"].includes(user?.role);

  const openNew  = () => { setEditItem(null); setForm({ name:"", description:"", project_id: projFilter||"", suite_type:"static", filter_config:{conditions:[],logic:"AND"} }); setPreview(null); setSelectedCases(new Set()); setTestOrder({}); setModal(true); };
  const openEdit = async (s) => {
    setEditItem(s);
    setForm({ name:s.name, description:s.description||"", project_id:String(s.project_id||""), suite_type:s.suite_type||"static", filter_config:s.filter_config||{conditions:[],logic:"AND"} });
    setPreview(null);
    setModal(true);
    const existingIds = (s.filter_config?.selected_case_ids || []).map(Number);
    setSelectedCases(new Set(existingIds));
    // Load existing test order — normalize keys to strings
    const existingOrder = s.filter_config?.test_order || {};
    const normalizedOrder = {};
    Object.entries(existingOrder).forEach(([k, v]) => { normalizedOrder[String(k)] = v; });
    setTestOrder(normalizedOrder);
    console.log('[openEdit]', s.name, '| ids:', existingIds.length, '| order keys:', Object.keys(normalizedOrder).length);
  };

  const save = async () => {
    if (!form.name.trim()) return alert("Suite name is required");
    if (!form.project_id)  return alert("Please select a project");
    setSaving(true);
    try {
      let sortedIds = [];
      let cleanOrder = {};

      if (form.suite_type === 'static') {
        // Static suite: sort selected cases by their order number
        const orderedIds = [...selectedCases]
          .filter(id => testOrder[String(id)])
          .sort((a, b) => (testOrder[String(a)]||0) - (testOrder[String(b)]||0));
        const unorderedIds = [...selectedCases]
          .filter(id => !testOrder[String(id)]);
        sortedIds = [...orderedIds, ...unorderedIds];

        // Clean test_order — only keep entries for selected cases with valid order
        for (const id of selectedCases) {
          if (testOrder[String(id)]) cleanOrder[String(id)] = testOrder[String(id)];
        }
      } else {
        // Dynamic suite: selected_case_ids comes from preview selection (if any)
        // Order applies to whatever is currently selected in preview
        const previewIds = preview ? [...selectedCases] : [...selectedCases];
        const orderedIds = previewIds
          .filter(id => testOrder[String(id)])
          .sort((a, b) => (testOrder[String(a)]||0) - (testOrder[String(b)]||0));
        const unorderedIds = previewIds.filter(id => !testOrder[String(id)]);
        sortedIds = [...orderedIds, ...unorderedIds];

        for (const id of selectedCases) {
          if (testOrder[String(id)]) cleanOrder[String(id)] = testOrder[String(id)];
        }
      }

      const payload = {
        ...form,
        filter_config: {
          ...(form.filter_config || {}),
          selected_case_ids: sortedIds,
          test_order: Object.keys(cleanOrder).length > 0 ? cleanOrder : null,
        },
        selected_case_ids: sortedIds,
        test_order: Object.keys(cleanOrder).length > 0 ? cleanOrder : null,
      };

      console.log('[save] suite_type:', form.suite_type, 'selectedCases:', selectedCases.size, 'sortedIds:', sortedIds.length, 'cleanOrder keys:', Object.keys(cleanOrder).length);

      // Warn about duplicate order numbers
      const orderNums = Object.values(cleanOrder).map(Number);
      const dupNums = orderNums.filter((v, i) => orderNums.indexOf(v) !== i);
      if (dupNums.length > 0) {
        if (!window.confirm(`⚠️ Duplicate order numbers: ${[...new Set(dupNums)].join(', ')}\nTests with same order will run in original sequence. Save anyway?`)) {
          setSaving(false);
          return;
        }
      }
      editItem ? await api(`/api/suites/${editItem.id}`, { method:"PUT",  body:payload })
               : await api("/api/suites",                 { method:"POST", body:payload });
      await onRefresh(); setModal(false);
    } catch(e) { alert(e.message); } finally { setSaving(false); }
  };

  const deleteSuite = async () => {
    try { await api(`/api/suites/${delItem.id}`, { method:"DELETE" }); await onRefresh(); setDelItem(null); }
    catch(e) { alert(e.message); }
  };

  const filtered = projFilter ? suites.filter(s => String(s.project_id) === projFilter) : suites;

  return (
    <div style={s.col}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
        <div style={{ fontSize:20, fontWeight:700, color:"#8B0000" }}>🗂️ Test Suites</div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          <select style={{ ...s.input, width:200, padding:"6px 10px" }} value={projFilter} onChange={e=>setProjFilter(e.target.value)}>
            <option value="">All Projects</option>
            {projects.map(p=><option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select>
          {canManage && <button style={s.btn("primary")} onClick={openNew}>+ New Suite</button>}
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:16 }}>
        {filtered.map(suite => {
          const proj = projects.find(p=>p.id===suite.project_id);
          return (
            <div key={suite.id} style={{ ...s.card, borderLeft:"4px solid #6c5ce7" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                <div style={{ fontSize:11, background:"#ede9fe", color:"#5b21b6", padding:"2px 10px", borderRadius:4, fontWeight:600 }}>
                  📁 {proj?.name||"Unknown"}
                </div>
                {canManage && (
                  <div style={{ display:"flex", gap:4 }}>
                    <button onClick={()=>openEdit(suite)} style={{ background:"#f0f2f5", border:"1px solid #e2e6ed", borderRadius:4, cursor:"pointer", color:"#4a5568", fontSize:12, padding:"3px 8px" }}>Edit</button>
                    <button onClick={()=>setDelItem(suite)} style={{ background:"#fdecea", border:"1px solid #ffcdd2", borderRadius:4, cursor:"pointer", color:"#c62828", fontSize:12, padding:"3px 8px" }}>Delete</button>
                  </div>
                )}
              </div>
              <div style={{ fontSize:15, fontWeight:700, color:"#1a2332", marginBottom:4 }}>{suite.name}</div>
              {suite.description && <div style={{ fontSize:12, color:"#8a96a8", marginBottom:10 }}>{suite.description}</div>}
              <div style={{ paddingTop:10, borderTop:"1px solid #f0f2f5", display:"flex", justifyContent:"space-between" }}>
                <div><span style={{ fontSize:18, fontWeight:700, color:"#1a6fc4" }}>{suite.test_count||0}</span><span style={{ fontSize:12, color:"#8a96a8", marginLeft:4 }}>tests</span></div>
                <div style={{ fontSize:11, color:"#8a96a8" }}>ID: {suite.id}</div>
              </div>
            </div>
          );
        })}
        {filtered.length===0 && <div style={{ gridColumn:"1/-1" }}><Empty msg="No suites yet" /></div>}
      </div>


      {/* ── Recorder Modal ── */}
      {recModal && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.5)", zIndex:999,
          display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
          <div style={{ background:"#ffffff", borderRadius:12, boxShadow:"0 8px 40px rgba(0,0,0,0.2)",
            display:"flex", flexDirection:"column", width:"100%", maxWidth:860,
            maxHeight:"92vh", border:"1px solid #e2e6ed" }}>

            {/* Header */}
            <div style={{ padding:"16px 24px", borderBottom:"1px solid #e2e6ed",
              display:"flex", alignItems:"center", justifyContent:"space-between",
              background: recSession?.status==="recording" ? "#fff8f8" : "#ffffff",
              borderRadius:"12px 12px 0 0" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ width:12, height:12, borderRadius:"50%",
                  background: recSession?.status==="recording" ? "#e53935" : recSession?.status==="stopped" ? "#00a86b" : "#8a96a8",
                  boxShadow: recSession?.status==="recording" ? "0 0 0 4px #e5393520" : "none",
                  animation: recSession?.status==="recording" ? "pulse 1.2s infinite" : "none" }} />
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:"#1a2332" }}>
                    🎬 Playwright Recorder
                  </div>
                  <div style={{ fontSize:12, color:"#8a96a8" }}>
                    {!recSession ? "Launches Playwright codegen — records every action accurately"
                      : recSession.status==="recording" ? "Recording in Playwright browser — close browser or click Stop when done"
                      : `Done — ${scriptToSteps(recScript).length} steps detected`}
                  </div>
                </div>
              </div>
              <button onClick={closeRecorder}
                style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:"#8a96a8" }}>×</button>
            </div>

            <div style={{ display:"flex", flex:1, overflow:"hidden" }}>

              {/* Left panel — controls */}
              <div style={{ width:300, borderRight:"1px solid #e2e6ed", padding:20,
                display:"flex", flexDirection:"column", gap:14, overflowY:"auto" }}>

                {/* How it works */}
                {!recSession && (
                  <div style={{ background:"#f0f7ff", border:"1px solid #bdd7f5",
                    borderRadius:8, padding:12, fontSize:12, color:"#1a6fc4", lineHeight:1.7 }}>
                    <div style={{ fontWeight:700, marginBottom:4 }}>How it works:</div>
                    <div>1. Enter start URL (optional)</div>
                    <div>2. Click <b>Launch Recorder</b></div>
                    <div>3. Playwright opens a browser window with its own recorder toolbar</div>
                    <div>4. Perform your actions in the browser</div>
                    <div>5. Close the browser <b>or</b> click Stop</div>
                    <div>6. Script is auto-converted to steps</div>
                  </div>
                )}

                {/* Start URL */}
                {!recSession && (
                  <div>
                    <label style={s.label}>Start URL (optional)</label>
                    <input style={s.input} value={recStartUrl}
                      placeholder="https://sqa.narayanahealth.org/"
                      onChange={e=>setRecStartUrl(e.target.value)} />
                  </div>
                )}

                {/* Launch / Stop */}
                {!recSession ? (
                  <button style={{ ...s.btn("danger"), padding:12, fontSize:14,
                    display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}
                    onClick={startRecording}>
                    <span style={{ width:10, height:10, borderRadius:"50%", background:"#fff", display:"inline-block" }} />
                    Launch Recorder
                  </button>
                ) : recSession.status === "recording" ? (
                  <>
                    <div style={{ background:"#fff8f8", border:"1px solid #ffcdd2",
                      borderRadius:8, padding:12, fontSize:12, color:"#c62828", lineHeight:1.6 }}>
                      <b>Recording in progress...</b><br/>
                      Perform your actions in the Playwright browser window.<br/><br/>
                      When done: <b>close the browser</b> or click Stop below.
                    </div>
                    <button style={{ ...s.btn("warn"), padding:10, fontSize:13 }} onClick={stopRecording}>
                      ■ Stop Recording
                    </button>
                  </>
                ) : (
                  <div style={{ background:"#e6f7f1", color:"#00a86b", borderRadius:8,
                    padding:"10px 14px", fontSize:13, fontWeight:600, textAlign:"center",
                    border:"1px solid #b7edda" }}>
                    ✓ {scriptToSteps(recScript).length} steps captured
                  </div>
                )}

                {/* Save as Test Case */}
                {recSession?.status === "stopped" && recScript && (
                  <div style={{ display:"flex", flexDirection:"column", gap:12,
                    borderTop:"1px solid #e2e6ed", paddingTop:14 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:"#1a2332" }}>Save as Test Case</div>
                    <div>
                      <label style={s.label}>Test Name *</label>
                      <input style={s.input} value={recName}
                        placeholder="e.g. Patient Registration Flow"
                        onChange={e=>setRecName(e.target.value)} />
                    </div>
                    <div>
                      <label style={s.label}>Project *</label>
                      <select style={s.input} value={recProject} onChange={e=>setRecProject(e.target.value)}>
                        <option value="">-- Select --</option>
                        {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={s.label}>Suite (optional)</label>
                      <select style={s.input} value={recSuite} onChange={e=>setRecSuite(e.target.value)}>
                        <option value="">None</option>
                        {suites.filter(s2=>!recProject||String(s2.project_id)===String(recProject))
                          .map(s2=><option key={s2.id} value={s2.id}>{s2.name}</option>)}
                      </select>
                    </div>
                    <button style={{ ...s.btn("success"), padding:11, fontSize:13 }}
                      onClick={saveRecording} disabled={recSaving}>
                      {recSaving ? "Saving..." : "💾 Save as Test Case"}
                    </button>
                  </div>
                )}
              </div>

              {/* Right panel — script / steps preview */}
              <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>

                {!recSession && (
                  <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                    flexDirection:"column", gap:12, color:"#8a96a8", padding:40, textAlign:"center" }}>
                    <div style={{ fontSize:48 }}>🎬</div>
                    <div style={{ fontSize:15, fontWeight:600, color:"#4a5568" }}>Ready to Record</div>
                    <div style={{ fontSize:13, maxWidth:320 }}>
                      Click <b>Launch Recorder</b> to open Playwright's browser with built-in recording toolbar
                    </div>
                  </div>
                )}

                {recSession?.status === "recording" && (
                  <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
                    flexDirection:"column", gap:16, color:"#8a96a8", padding:40, textAlign:"center" }}>
                    <div style={{ fontSize:48, animation:"pulse 1.2s infinite" }}>🔴</div>
                    <div style={{ fontSize:15, fontWeight:600, color:"#c62828" }}>Recording...</div>
                    <div style={{ fontSize:13, maxWidth:320 }}>
                      The Playwright browser is open. Perform your test actions.<br/>
                      The script is being generated automatically.
                    </div>
                  </div>
                )}

                {recSession?.status === "stopped" && recScript && (
                  <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
                    {/* Tabs */}
                    <div style={{ display:"flex", borderBottom:"1px solid #e2e6ed", background:"#f8f9fc" }}>
                      {[["steps","📋 Converted Steps"], ["script","📄 Raw Script"]].map(([v,l])=>(
                        <button key={v} onClick={()=>setRecEditing(v==="script")}
                          style={{ padding:"10px 18px", fontSize:13, fontWeight:600, border:"none",
                            cursor:"pointer", borderBottom: (recEditing?(v==="script"):(v==="steps")) ? "2px solid #1a6fc4" : "2px solid transparent",
                            color: (recEditing?(v==="script"):(v==="steps")) ? "#1a6fc4" : "#8a96a8",
                            background:"transparent" }}>
                          {l}
                        </button>
                      ))}
                    </div>

                    {/* Steps view */}
                    {!recEditing && (
                      <div style={{ flex:1, overflowY:"auto", padding:16 }}>
                        {scriptToSteps(recScript).map((step,i) => {
                          const cols = { navigate:"#1a6fc4", click:"#6c5ce7", type:"#00a86b",
                            select:"#f59e0b", wait:"#8a96a8", press:"#f97316" };
                          const col = cols[step.action] || "#4a5568";
                          return (
                            <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:8,
                              padding:"8px 10px", borderRadius:6, marginBottom:5,
                              background:"#f8f9fc", border:"1px solid #e2e6ed" }}>
                              <span style={{ fontSize:11, color:"#8a96a8", minWidth:24 }}>#{i+1}</span>
                              <span style={{ fontSize:11, fontWeight:700, color:col,
                                background:col+"18", padding:"2px 7px", borderRadius:4,
                                minWidth:64, textAlign:"center", textTransform:"uppercase", flexShrink:0 }}>
                                {step.action}
                              </span>
                              <div style={{ flex:1, fontSize:12, fontFamily:"'IBM Plex Mono',monospace",
                                color:"#1a2332", wordBreak:"break-all" }}>
                                {step.selector && <span style={{ color:"#4a5568" }}>{step.selector.slice(0,50)}</span>}
                                {step.value && <span style={{ color:"#1a6fc4" }}> → "{step.value.slice(0,40)}"</span>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Raw script view */}
                    {recEditing && (
                      <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
                        <div style={{ padding:"8px 16px", fontSize:11, color:"#8a96a8",
                          background:"#f8f9fc", borderBottom:"1px solid #e2e6ed" }}>
                          Edit the script below if needed, then save — changes will be reflected in steps
                        </div>
                        <textarea value={recScript} onChange={e=>setRecScript(e.target.value)}
                          spellCheck={false}
                          style={{ flex:1, fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                            lineHeight:1.6, background:"#0f172a", color:"#e2e8f0",
                            border:"none", outline:"none", padding:"16px 20px",
                            resize:"none", boxSizing:"border-box" }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Script Modal ── */}
      {scriptModal && (
        <div style={{ ...s.modal, alignItems:"stretch", padding:"24px" }}>
          <div style={{ background:"#ffffff", borderRadius:10, boxShadow:"0 8px 40px rgba(0,0,0,0.2)",
            display:"flex", flexDirection:"column", width:"100%", maxWidth:860, maxHeight:"90vh",
            border:"1px solid #e2e6ed" }}>

            {/* Header */}
            <div style={{ padding:"16px 24px", borderBottom:"1px solid #e2e6ed",
              display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, color:"#1a2332", display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ background:"#e3f0fb", color:"#1a6fc4", padding:"3px 10px",
                    borderRadius:5, fontSize:12, fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>JS · Python · Playwright</span>
                  {scriptModal.name}
                </div>
                <div style={{ fontSize:12, color:"#8a96a8", marginTop:3 }}>
                  Paste any Playwright script (JS or Python) — it will be auto-converted to steps
                </div>
              </div>
              <button onClick={()=>setScriptModal(null)}
                style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:"#8a96a8", lineHeight:1 }}>×</button>
            </div>

            {/* Editor */}
            <div style={{ flex:1, overflow:"hidden", position:"relative" }}>
              <textarea
                value={scriptText}
                onChange={e=>setScriptText(e.target.value)}
                spellCheck={false}
                style={{
                  width:"100%", height:"100%", minHeight:420,
                  fontFamily:"'IBM Plex Mono','Fira Code','Courier New',monospace",
                  fontSize:13, lineHeight:1.6,
                  background:"#0f172a", color:"#e2e8f0",
                  border:"none", outline:"none", padding:"20px 24px",
                  resize:"none", boxSizing:"border-box",
                  tabSize:4,
                }}
                onKeyDown={e => {
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const s = e.target.selectionStart;
                    const v = e.target.value;
                    setScriptText(v.slice(0,s)+"    "+v.slice(e.target.selectionEnd));
                    requestAnimationFrame(()=>{ e.target.selectionStart = e.target.selectionEnd = s+4; });
                  }
                }}
              />
            </div>

            {/* Footer */}
            <div style={{ padding:"14px 24px", borderTop:"1px solid #e2e6ed",
              display:"flex", alignItems:"center", justifyContent:"space-between",
              background:"#f8f9fc" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:12, color:"#4a5568", fontWeight:600 }}>Mode:</span>
                {["replace","append"].map(m=>(
                  <button key={m} onClick={()=>setScriptImportMode(m)}
                    style={{ ...s.btn(scriptImportMode===m?"primary":"ghost",true), fontSize:12 }}>
                    {m==="replace" ? "↺ Replace all steps" : "+ Append steps"}
                  </button>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button style={s.btn("ghost")} onClick={()=>{setScriptModal(null);setScriptPreview(null);}}>Cancel</button>
                <button style={{ ...s.btn("ghost",true), borderColor:"#1a6fc4", color:"#1a6fc4" }}
                  onClick={previewScript}>👁 Preview</button>
                <button style={s.btn("primary")} onClick={saveScript} disabled={scriptSaving}>
                  {scriptSaving ? "Saving..." : scriptImportMode==="replace" ? "↺ Save & Replace Steps" : "+ Save & Append Steps"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div style={{ ...s.modalBox, maxWidth:680 }}>
            <div style={{ fontSize:17, fontWeight:700, color:"#1a2332", marginBottom:20 }}>
              {editItem ? "✏️ Edit Suite" : "🗂️ New Test Suite"}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
              <div><label style={s.label}>Project *</label>
                <select style={s.input} value={form.project_id}
                  onChange={e=>{ setForm(f=>({...f,project_id:e.target.value})); setPreview(null); setSelectedCases(new Set()); }}>
                  <option value="">-- Select --</option>
                  {projects.map(p=><option key={p.id} value={String(p.id)}>{p.name}</option>)}
                </select>
              </div>
              <div><label style={s.label}>Suite Name *</label>
                <input style={s.input} value={form.name} placeholder="e.g. Regression Suite"
                  onChange={e=>setForm(f=>({...f,name:e.target.value}))} />
              </div>
              <div><label style={s.label}>Suite Type</label>
                <select style={s.input} value={form.suite_type||"static"}
                  onChange={e=>setForm(f=>({...f,suite_type:e.target.value}))}>
                  <option value="static">📌 Static — manually pick test cases</option>
                  <option value="dynamic">🔄 Dynamic — auto from query (re-evaluates on run)</option>
                </select>
              </div>
              <div><label style={s.label}>Description</label>
                <input style={s.input} value={form.description}
                  onChange={e=>setForm(f=>({...f,description:e.target.value}))}
                  placeholder="Optional description..." />
              </div>
            </div>

            {/* Static suite — show all project test cases for selection */}
            {form.project_id && form.suite_type === "static" && (
              <StaticSuitePicker
                projectId={form.project_id}
                selectedCases={selectedCases}
                setSelectedCases={setSelectedCases}
                testOrder={testOrder}
                setTestOrder={setTestOrder}
              />
            )}

            {/* Query Builder — only for dynamic suites */}
            {form.project_id && form.suite_type !== "static" && (
              <div style={{ marginBottom:14 }}>
                <QueryBuilder
                  filterConfig={form.filter_config||{conditions:[],logic:"AND"}}
                  onChange={fc=>{ setForm(f=>({...f,filter_config:fc})); setPreview(null); }}
                  projects={projects}
                  modules={allModules.filter(m=>String(m.project_id)===String(form.project_id))}
                />
                <div style={{ display:"flex", gap:10, marginTop:10, alignItems:"center" }}>
                  <button
                    style={{ ...s.btn("primary",true), fontSize:12 }}
                    disabled={previewLoading}
                    onClick={async()=>{
                      setPreviewLoading(true);
                      try {
                        const res = await api("/api/suites/query-preview", {
                          method:"POST",
                          body:{ filter_config:form.filter_config, project_id:form.project_id }
                        });
                        setPreview(res);
                        // Auto-select all
                        setSelectedCases(new Set(res.map(t=>t.id)));
                      } catch(e){ alert(e.message); }
                      setPreviewLoading(false);
                    }}>
                    {previewLoading ? "⏳ Loading..." : "🔍 Preview Matching Tests"}
                  </button>
                  {preview && (
                    <span style={{ fontSize:12, color:"#6b7280" }}>
                      {preview.length} test{preview.length!==1?"s":""} matched
                      · {selectedCases.size} selected
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Preview results */}
            {preview && (
              <div style={{ background:"#f9fafb", border:"1px solid #e5e7eb", borderRadius:8,
                marginBottom:14, maxHeight:280, overflowY:"auto" }}>
                <div style={{ padding:"8px 12px", background:"#f0f9ff", borderBottom:"1px solid #e5e7eb",
                  display:"flex", justifyContent:"space-between", alignItems:"center",
                  position:"sticky", top:0, zIndex:1 }}>
                  <span style={{ fontSize:12, fontWeight:700, color:"#1d4ed8" }}>
                    Matching Test Cases
                  </span>
                  <div style={{ display:"flex", gap:8 }}>
                    <button style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px" }}
                      onClick={()=>setSelectedCases(new Set(preview.map(t=>t.id)))}>
                      Select All
                    </button>
                    <button style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px" }}
                      onClick={()=>setSelectedCases(new Set())}>
                      Deselect All
                    </button>
                  </div>
                </div>
                {/* Column headers */}
                <div style={{ display:"grid", gridTemplateColumns:"32px 1fr 70px",
                  gap:8, padding:"6px 12px", background:"#f3f4f6",
                  borderBottom:"1px solid #e5e7eb" }}>
                  <div/>
                  <div style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase" }}>Test Case</div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#6b7280", textTransform:"uppercase" }}>Order</div>
                </div>
                {preview.length === 0 ? (
                  <div style={{ padding:"16px", textAlign:"center", color:"#9ca3af", fontSize:13 }}>
                    No test cases match the current filters
                  </div>
                ) : preview.map(t => {
                  const checked = selectedCases.has(t.id);
                  const pc = t.priority==="critical"?"#e53935":t.priority==="high"?"#f97316":t.priority==="medium"?"#f59e0b":"#64748b";
                  const orderVals2 = Object.values(testOrder||{}).filter(Boolean).map(Number);
                  const isDup2 = testOrder?.[t.id] && orderVals2.filter(v=>v===Number(testOrder[t.id])).length > 1;
                  return (
                    <div key={t.id}
                      style={{ display:"grid", gridTemplateColumns:"32px 1fr 70px",
                        gap:8, padding:"8px 12px", alignItems:"center",
                        borderBottom:"1px solid #f3f4f6",
                        background:checked?"#eff6ff":"transparent" }}>
                      <input type="checkbox" checked={checked} readOnly
                        onClick={e=>{ e.stopPropagation(); setSelectedCases(prev=>{
                          const n=new Set(prev); n.has(t.id)?n.delete(t.id):n.add(t.id); return n;
                        }); }}
                        style={{ cursor:"pointer" }} />
                      <div onClick={()=>setSelectedCases(prev=>{
                          const n=new Set(prev); n.has(t.id)?n.delete(t.id):n.add(t.id); return n;
                        })} style={{ cursor:"pointer" }}>
                        <div style={{ fontSize:12, fontWeight:600, color:"#111827" }}>{t.name}</div>
                        <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>
                          {t.module_name && <span style={{ marginRight:8 }}>📦 {t.module_name}</span>}
                          <span style={{ color:pc, fontWeight:600 }}>{t.priority}</span>
                          <span style={{ marginLeft:8, color:"#6b7280" }}>{t.type?.toUpperCase()}</span>
                          {t.last_status && <span style={{ marginLeft:8,
                            color:t.last_status==="passed"?"#22c55e":t.last_status==="failed"?"#ef4444":"#9ca3af" }}>
                            {t.last_status==="passed"?"✅":t.last_status==="failed"?"❌":"○"} {t.last_status}
                          </span>}
                        </div>
                      </div>
                      <input
                        type="number" min="1"
                        placeholder="—"
                        value={testOrder?.[t.id] || ""}
                        onClick={e=>e.stopPropagation()}
                        onChange={e=>setTestOrder(prev=>({
                          ...prev,
                          [t.id]: e.target.value ? parseInt(e.target.value) : null
                        }))}
                        style={{ ...s.input, margin:0, width:60, fontSize:12, padding:"3px 6px",
                          textAlign:"center",
                          borderColor: isDup2 ? "#f59e0b" : "#e5e7eb",
                          background: isDup2 ? "#fffbeb" : "#fff" }}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={s.btn("ghost")} onClick={()=>setModal(false)}>Cancel</button>
              <button style={s.btn("primary")} onClick={save} disabled={saving}>
                {saving ? "Saving..." : editItem ? "Save Changes" : "Create Suite"}
              </button>
            </div>
          </div>
        </div>
      )}
      {delItem && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setDelItem(null)}>
          <div style={{ ...s.modalBox, maxWidth:400 }}>
            <div style={{ fontSize:17, fontWeight:700, color:"#c62828", marginBottom:12 }}>Delete Suite?</div>
            <div style={{ fontSize:14, color:"#4a5568", marginBottom:20 }}>
              Delete <b style={{color:"#1a2332"}}>{delItem.name}</b>? Test cases inside will not be deleted.
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={s.btn("ghost")} onClick={()=>setDelItem(null)}>Cancel</button>
              <button style={s.btn("danger")} onClick={deleteSuite}>Yes, Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function DbConnections({ user }) {
  const [conns,    setConns]    = useState([]);
  const [orgs,     setOrgs]     = useState([]);
  const [modal,    setModal]    = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [testing,  setTesting]  = useState(null);
  const [testRes,  setTestRes]  = useState({});
  const [form,     setForm]     = useState({ 
    name: "", 
    host: "localhost", 
    port: "5432", 
    database: "", 
    username: "", 
    password: "", 
    description: "", 
    org_id: "" 
  });
  const [saving,   setSaving]   = useState(false);

  const canManage = ["admin","lead","superadmin"].includes(user?.role);

  const load = async () => {
    try { 
      const [connections, organisations] = await Promise.all([
        api("/api/db-connections"),
        api("/api/user/organisations")
      ]);
      setConns(connections); 
      setOrgs(organisations);
    } catch (e) {
      console.error("[DbConnections] Load error:", e);
    }
  };
  
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditItem(null);
    setForm({ 
      name: "", 
      host: "localhost", 
      port: "5432", 
      database: "", 
      username: "", 
      password: "", 
      description: "",
      org_id: orgs.length === 1 ? String(orgs[0].id) : ""
    });
    setModal(true);
  };

  const openEdit = (c) => {
    setEditItem(c);
    setForm({ 
      name: c.name, 
      host: c.host, 
      port: String(c.port || "5432"), 
      database: c.database, 
      username: c.username, 
      password: "", 
      description: c.description || "",
      org_id: String(c.org_id || "")
    });
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim())     return alert("Connection name is required");
    if (!form.host.trim())     return alert("Host is required");
    if (!form.database.trim()) return alert("Database name is required");
    if (!form.username.trim()) return alert("Username is required");
    if (!editItem && !form.password.trim()) return alert("Password is required");
    if (!form.org_id) return alert("Please select an organisation");
    
    setSaving(true);
    try {
      if (editItem) {
        await api(`/api/db-connections/${editItem.id}`, { method: "PUT", body: form });
      } else {
        await api("/api/db-connections", { method: "POST", body: form });
      }
      await load(); 
      setModal(false);
    } catch(e) { 
      alert(e.message); 
    } finally { 
      setSaving(false); 
    }
  };

  const deleteConn = async (id) => {
    if (!confirm("Delete this connection? This cannot be undone.")) return;
    try { 
      await api(`/api/db-connections/${id}`, { method: "DELETE" }); 
      await load(); 
    } catch(e) { 
      alert(e.message); 
    }
  };

  const testConn = async (c) => {
    setTesting(c.id); 
    setTestRes(r => ({ ...r, [c.id]: null }));
    try {
      const res = await api(`/api/db-connections/${c.id}/test`, { method: "POST" });
      setTestRes(r => ({ ...r, [c.id]: { ok: res.ok !== false, msg: res.message }}));
    } catch(e) {
      setTestRes(r => ({ ...r, [c.id]: { ok: false, msg: e.message }}));
    }
    setTesting(null);
  };

  return (
    <div style={s.col}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#8B0000" }}>🗄️ DB Connections</div>
          <div style={{ fontSize: 13, color: "#8a96a8", marginTop: 3 }}>
            Save PostgreSQL connections here — then reference them by name in 🗄️ DB Validate steps
          </div>
        </div>
        {canManage && <button style={s.btn("primary")} onClick={openNew}>+ New Connection</button>}
      </div>

      {/* How to use hint */}
      <div style={{ 
        background: "#f0f7ff", 
        border: "1px solid #bdd7f5", 
        borderRadius: 8, 
        padding: "12px 16px",
        display: "flex", 
        alignItems: "flex-start", 
        gap: 12 
      }}>
        <span style={{ fontSize: 20 }}>💡</span>
        <div style={{ fontSize: 13, color: "#1a6fc4" }}>
          <strong>How to use:</strong> Add a connection below, then in any test case add a step with action
          <code style={{ 
            background: "#dbeafe", 
            padding: "2px 8px", 
            borderRadius: 4, 
            margin: "0 4px",
            fontFamily: "'IBM Plex Mono',monospace", 
            fontSize: 12 
          }}>
            🗄️ DB Validate Query
          </code>
          and enter the connection name in the <em>Saved Connection</em> field.
        </div>
      </div>

      {conns.length === 0 ? (
        <div style={{ 
          ...s.card, 
          textAlign: "center", 
          padding: "52px 24px", 
          color: "#8a96a8" 
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🐘</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#4a5568", marginBottom: 6 }}>
            No connections yet
          </div>
          <div style={{ fontSize: 13, maxWidth: 360, margin: "0 auto" }}>
            Add a PostgreSQL connection to start using DB validation steps in your test cases.
          </div>
          {canManage && (
            <button style={{ ...s.btn("primary"), marginTop: 20 }} onClick={openNew}>
              + Add First Connection
            </button>
          )}
        </div>
      ) : (
        <div style={{ 
          display: "grid", 
          gridTemplateColumns: "repeat(auto-fill, minmax(360px,1fr))", 
          gap: 16 
        }}>
          {conns.map(c => (
            <div key={c.id} style={{ ...s.card, borderLeft: "4px solid #1a6fc4" }}>
              <div style={{ 
                display: "flex", 
                justifyContent: "space-between", 
                alignItems: "flex-start", 
                marginBottom: 12 
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 32 }}>🐘</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#1a2332" }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: "#8a96a8" }}>PostgreSQL</div>
                  </div>
                </div>
                {canManage && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button style={s.btn("ghost", true)} onClick={() => openEdit(c)}>Edit</button>
                    <button style={{ ...s.btn("danger", true) }} onClick={() => deleteConn(c.id)}>
                      Delete
                    </button>
                  </div>
                )}
              </div>

              {/* Organisation Badge */}
              {c.org_name && (
                <div style={{ 
                  background: "#f0f7ff", 
                  borderRadius: 5, 
                  padding: "6px 10px", 
                  marginBottom: 12,
                  fontSize: 12,
                  color: "#1a6fc4",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: 6
                }}>
                  <span>🏢</span> {c.org_name}
                </div>
              )}

              {/* Connection details grid */}
              <div style={{ 
                display: "grid", 
                gridTemplateColumns: "1fr 1fr", 
                gap: 6, 
                marginBottom: 12 
              }}>
                {[
                  ["Host", c.host],
                  ["Port", c.port],
                  ["Database", c.database],
                  ["Username", c.username]
                ].map(([k, v]) => (
                  <div key={k} style={{ 
                    background: "#f8f9fc", 
                    borderRadius: 5, 
                    padding: "6px 10px" 
                  }}>
                    <div style={{ 
                      fontSize: 10, 
                      fontWeight: 700, 
                      color: "#8a96a8", 
                      textTransform: "uppercase", 
                      letterSpacing: "0.06em" 
                    }}>
                      {k}
                    </div>
                    <div style={{ 
                      fontSize: 13, 
                      color: "#1a2332", 
                      fontFamily: "'IBM Plex Mono',monospace", 
                      marginTop: 2 
                    }}>
                      {v}
                    </div>
                  </div>
                ))}
              </div>

              {c.description && (
                <div style={{ 
                  fontSize: 12, 
                  color: "#8a96a8", 
                  marginBottom: 12, 
                  fontStyle: "italic" 
                }}>
                  {c.description}
                </div>
              )}

              {/* Test connection */}
              <div style={{ 
                display: "flex", 
                alignItems: "center", 
                gap: 10, 
                paddingTop: 10, 
                borderTop: "1px solid #f0f2f5" 
              }}>
                <button 
                  style={{ ...s.btn("primary", true) }}
                  onClick={() => testConn(c)} 
                  disabled={testing === c.id}
                >
                  {testing === c.id ? "Testing..." : "▶ Test Connection"}
                </button>
                {testRes[c.id] && (
                  <span style={{ 
                    fontSize: 12, 
                    fontWeight: 600,
                    color: testRes[c.id].ok ? "#00a86b" : "#e53935" 
                  }}>
                    {testRes[c.id].ok ? "✓" : "✗"} {testRes[c.id].msg}
                  </span>
                )}
              </div>

              {/* Usage hint */}
              <div style={{ marginTop: 10, fontSize: 11, color: "#8a96a8" }}>
                Reference as:
                <code style={{ 
                  background: "#e3f0fb", 
                  color: "#1a6fc4", 
                  padding: "1px 8px",
                  borderRadius: 4, 
                  marginLeft: 6, 
                  fontFamily: "'IBM Plex Mono',monospace",
                  fontSize: 12, 
                  fontWeight: 700 
                }}>
                  {c.name}
                </code>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Modal */}
      {modal && (
        <div style={s.modal} onClick={e => e.target === e.currentTarget && setModal(false)}>
          <div style={{ ...s.modalBox, maxWidth: 500 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <span style={{ fontSize: 28 }}>🐘</span>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#1a2332" }}>
                {editItem ? "Edit Connection" : "New PostgreSQL Connection"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              
              {/* Organisation Dropdown */}
              <div>
                <label style={s.label}>
                  Organisation <span style={{ color: "#e53935" }}>*</span>
                </label>
                <select 
                  style={{
                    ...s.input,
                    borderColor: !form.org_id ? "#f59e0b" : "#e2e6ed",
                    background: !form.org_id ? "#fffbeb" : "#fff"
                  }} 
                  value={form.org_id}
                  onChange={e => setForm(f => ({ ...f, org_id: e.target.value }))}
                >
                  <option value="">-- Select Organisation --</option>
                  {orgs.map(org => (
                    <option key={org.id} value={String(org.id)}>
                      {org.name}
                    </option>
                  ))}
                </select>
                {!form.org_id && (
                  <div style={{ fontSize: 11, color: "#f59e0b", marginTop: 4 }}>
                    ⚠️ Please select an organisation
                  </div>
                )}
              </div>

              <div>
                <label style={s.label}>
                  Connection Name <span style={{ color: "#e53935" }}>*</span>
                  <span style={{ fontWeight: 400, color: "#8a96a8", marginLeft: 6 }}>
                    used in DB Validate steps
                  </span>
                </label>
                <input 
                  style={s.input} 
                  value={form.name}
                  placeholder="e.g. NAT_DB or HIS_PROD"
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} 
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={s.label}>
                    Host <span style={{ color: "#e53935" }}>*</span>
                  </label>
                  <input 
                    style={s.input} 
                    value={form.host} 
                    placeholder="localhost"
                    onChange={e => setForm(f => ({ ...f, host: e.target.value }))} 
                  />
                </div>
                <div>
                  <label style={s.label}>Port</label>
                  <input 
                    style={s.input} 
                    value={form.port} 
                    placeholder="5432"
                    onChange={e => setForm(f => ({ ...f, port: e.target.value }))} 
                  />
                </div>
                <div>
                  <label style={s.label}>
                    Database <span style={{ color: "#e53935" }}>*</span>
                  </label>
                  <input 
                    style={s.input} 
                    value={form.database} 
                    placeholder="his_db"
                    onChange={e => setForm(f => ({ ...f, database: e.target.value }))} 
                  />
                </div>
                <div>
                  <label style={s.label}>
                    Username <span style={{ color: "#e53935" }}>*</span>
                  </label>
                  <input 
                    style={s.input} 
                    value={form.username} 
                    placeholder="postgres"
                    onChange={e => setForm(f => ({ ...f, username: e.target.value }))} 
                  />
                </div>
              </div>

              <div>
                <label style={s.label}>
                  Password <span style={{ color: "#e53935" }}>*</span>
                  {editItem && (
                    <span style={{ fontWeight: 400, color: "#8a96a8", marginLeft: 6 }}>
                      (leave blank to keep existing)
                    </span>
                  )}
                </label>
                <input 
                  style={s.input} 
                  type="password" 
                  value={form.password} 
                  placeholder="••••••••"
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))} 
                />
              </div>

              <div>
                <label style={s.label}>
                  Description <span style={{ fontWeight: 400, color: "#8a96a8" }}>(optional)</span>
                </label>
                <input 
                  style={s.input} 
                  value={form.description} 
                  placeholder="e.g. HIS production database"
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))} 
                />
              </div>
            </div>

            <div style={{ 
              display: "flex", 
              gap: 10, 
              justifyContent: "flex-end", 
              marginTop: 22 
            }}>
              <button style={s.btn("ghost")} onClick={() => setModal(false)}>
                Cancel
              </button>
              <button 
                style={s.btn("primary")} 
                onClick={save} 
                disabled={saving || !form.org_id}
              >
                {saving ? "Saving..." : editItem ? "Save Changes" : "Add Connection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



function SuiteRunner({ projects, suites, user }) {
  const [tab,         setTab]         = useState("run");      // "run" | "history"
  const [selSuite,    setSelSuite]     = useState("");
  const [selProject,  setSelProject]  = useState("");
  const [selTests,    setSelTests]     = useState([]);        // selected test ids
  const [browser,     setBrowser]     = useState("chrome");
  const [suiteTests,  setSuiteTests]  = useState([]);        // tests loaded for selected suite
  const [loadingTests,setLoadingTests]= useState(false);
  const [testOrders,  setTestOrders]  = useState({});        // { tcId: orderNumber } for this run
  const [notifyEmail, setNotifyEmail] = useState("");         // email to notify on completion
  const [running,     setRunning]     = useState(false);
  const [suiteRunId,  setSuiteRunId]  = useState(null);
  const [aborting,    setAborting]    = useState(false);
  const [progress,    setProgress]    = useState(null);       // { passed, failed, pending }
  const [results,     setResults]     = useState(null);
  const [history,     setHistory]     = useState([]);
  const [viewResult,  setViewResult]  = useState(null);
  const [liveTest,    setLiveTest]    = useState(null);   // currently running test name
  const [liveScreen,  setLiveScreen]  = useState(null);  // latest screenshot base64
  const [liveLog,     setLiveLog]     = useState([]);    // recent log lines
  const [testStatuses,setTestStatuses]= useState({});    // runId -> { status, name, steps_passed, steps_total }
  const wsRef = useRef(null);
  const liveLogRef = useRef([]);

  // ── Restore active suite run from localStorage on mount (survives navigation) ──────
  useEffect(() => {
    const saved = sessionStorage.getItem('daiva_active_suite');
    if (!saved) return;
    try {
      const d = JSON.parse(saved);
      if (!d.suiteRunId) return;
      // Check if the suite run is still actually running on the server
      api(`/api/suite-runs/${d.suiteRunId}`).then(r => {
        if (r?.status === 'running') {
          setSuiteRunId(d.suiteRunId);
          setSelTests(d.selTests || []);
          setSelSuite(d.selSuite || "");
          setBrowser(d.browser || "chrome");
          setRunning(true);
          // Calculate correct pending count from server data
          const passed  = r.passed  || 0;
          const failed  = r.failed  || 0;
          const total   = r.total   || (d.selTests || []).length;
          const pending = Math.max(0, total - passed - failed);
          setProgress({ passed, failed, pending });
          setTab("progress");
          // Reconnect WebSocket to resume live updates
          const ws = new WebSocket(`${WS}?runId=${d.suiteRunId}`);
          wsRef.current = ws;
          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === "progress")
                setProgress({ passed:msg.passed, failed:msg.failed, pending:msg.pending });
              if (msg.type === "test_start") {
                setLiveTest(msg.test_name);
                setLiveScreen(null);
                liveLogRef.current = [];
                setLiveLog([]);
                setTestStatuses(prev => ({ ...prev, [msg.test_name]: { status:"running", run_id:msg.run_id } }));
              }
              if (msg.type === "test_done") {
                setTestStatuses(prev => ({ ...prev, [msg.test_name]: { status:msg.status, run_id:msg.run_id, steps_passed:msg.steps_passed, steps_total:msg.steps_total } }));
              }
              if (msg.type === "live_screen" && msg.data) setLiveScreen(msg.data);
              if (msg.type === "log" && msg.message) {
                const lines = msg.message.split('\n').map(l=>l.trim()).filter(Boolean);
                lines.forEach(rawLine => {
                  const line = rawLine.replace(/^\[.*?\]\s*/,"").slice(0,120);
                  if (line) { liveLogRef.current = [...liveLogRef.current.slice(-100), line]; }
                });
                setLiveLog([...liveLogRef.current]);
              }
              if (msg.type === "suite_done") {
                setProgress({ passed:msg.passed, failed:msg.failed, pending:0 });
                setLiveTest(null);
                sessionStorage.removeItem('daiva_active_suite');
                setTimeout(() => {
                  api(`/api/suite-runs/${d.suiteRunId}`)
                    .then(r => { setResults(r); setRunning(false); loadHistory(); })
                    .catch(() => setRunning(false));
                }, 1000);
              }
              if (msg.type === "suite_aborted") {
                setRunning(false); setLiveTest(null);
                setProgress(prev => ({ ...prev, pending:0 }));
                sessionStorage.removeItem('daiva_active_suite');
              }
            } catch(e) {}
          };
        } else {
          // Suite already finished — clear storage
          sessionStorage.removeItem('daiva_active_suite');
        }
      }).catch(() => sessionStorage.removeItem('daiva_active_suite'));
    } catch(e) { sessionStorage.removeItem('daiva_active_suite'); }
  }, []);

  // When suite is selected, fetch its test cases via the new /api/suites/:id/tests endpoint
  useEffect(() => {
    if (!selSuite) {
      setSuiteTests([]);
      setSelTests([]);
      setTestOrders({});
      return;
    }
    setLoadingTests(true);
    setSelTests([]);
    setTestOrders({});
    // Fetch tests AND suite details (for test_order)
    Promise.all([
      api(`/api/suites/${selSuite}/tests`),
      api(`/api/suites/${selSuite}`)
    ]).then(([rows, suite]) => {
        const tests = Array.isArray(rows) ? rows : [];
        setSuiteTests(tests);
        setSelTests(tests.map(t=>t.id));
        // Pre-fill order from suite's saved test_order
        const savedOrder = suite?.filter_config?.test_order || {};
        setTestOrders(savedOrder);
        setLoadingTests(false);
      }).catch(() => setLoadingTests(false));
  }, [selSuite]);

  // Only show tests when a suite is explicitly selected
  const suitedTests = selSuite ? suiteTests : [];

  const allSelected  = suitedTests.length > 0 && selTests.length === suitedTests.length;
  const someSelected = selTests.length > 0;

  const toggleTest = (id) =>
    setSelTests(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);

  const toggleAll = () =>
    setSelTests(allSelected ? [] : suitedTests.map(t=>t.id));

  const loadHistory = async () => {
    try {
      const r = await api("/api/suite-runs");
      setHistory(Array.isArray(r) ? r : []);
    } catch(e) {
      console.error("[SuiteRunner] loadHistory failed:", e.message);
      setHistory([]);
    }
  };

  useEffect(() => { if (tab === "history") loadHistory(); }, []);

  const runSuite = async () => {
    if (!selTests.length) return alert("Please select at least one test case");

    // Sort selected tests: ordered first (by number), unordered after (original order)
    const sortedTests = [
      ...selTests.filter(id => testOrders[id]).sort((a,b) => (testOrders[a]||0) - (testOrders[b]||0)),
      ...selTests.filter(id => !testOrders[id])
    ];

    // Check for duplicate order numbers — warn but don't block
    const orderVals = selTests.filter(id=>testOrders[id]).map(id=>testOrders[id]);
    const hasDups = orderVals.length !== new Set(orderVals).size;
    if (hasDups) {
      const dupNums = orderVals.filter((v,i)=>orderVals.indexOf(v)!==i);
      if (!window.confirm(`⚠️ Duplicate order numbers found: ${[...new Set(dupNums)].join(", ")}\nTie broken by original order. Continue?`)) return;
    }

    setRunning(true);
    setProgress({ passed:0, failed:0, pending:selTests.length });
    setResults(null);
    setLiveScreen(null); setLiveTest(null); setLiveLog([]);
    setTestStatuses({});

    try {
      const suite = suites.find(s=>String(s.id)===String(selSuite));
      const d = await api("/api/suite-runs", { method:"POST", body:{
        suite_id:  selSuite || null,
        run_order: sortedTests,
        browser,
        name: suite ? `${suite.name} — ${new Date().toLocaleTimeString("en-IN")}` : `Suite Run — ${new Date().toLocaleTimeString("en-IN")}`,
        notify_email: notifyEmail.trim() || null,
      }});

      setSuiteRunId(d.suite_run_id);

      // Save to sessionStorage so Live Run tab survives navigation (per-tab — no cross-user interference)
      sessionStorage.setItem('daiva_active_suite', JSON.stringify({
        suiteRunId: d.suite_run_id,
        selTests,
        selSuite,
        browser,
      }));

      // Open WebSocket BEFORE switching tab to avoid missing early messages
      const ws = new WebSocket(`${WS}?runId=${d.suite_run_id}`);
      wsRef.current = ws;
      ws.onopen = () => { setTab("progress"); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "progress")
            setProgress({ passed:msg.passed, failed:msg.failed, pending:msg.pending });

          if (msg.type === "test_start") {
            setLiveTest(msg.test_name);
            setLiveScreen(null);
            liveLogRef.current = [];
            setLiveLog([]);
            // Key by test_name for easy lookup in test queue
            setTestStatuses(prev => ({ ...prev, [msg.test_name]: { status:"running", run_id:msg.run_id } }));
          }

          if (msg.type === "test_done") {
            setTestStatuses(prev => ({
              ...prev,
              [msg.test_name]: {
                status: msg.status,
                run_id: msg.run_id,
                steps_passed: msg.steps_passed,
                steps_total:  msg.steps_total,
              }
            }));
          }

          if (msg.type === "live_screen" && msg.data) {
            setLiveScreen(msg.data);
          }

          if (msg.type === "log" && msg.message) {
            const lines = msg.message.split('\n').map(l => l.trim()).filter(Boolean);
            lines.forEach(rawLine => {
              const line = rawLine.replace(/^\[.*?\]\s*/, "").slice(0, 120);
              if (line) {
                liveLogRef.current = [...liveLogRef.current.slice(-100), line];
              }
            });
            setLiveLog([...liveLogRef.current]);
          }

          if (msg.type === "suite_done") {
            setProgress({ passed:msg.passed, failed:msg.failed, pending:0 });
            setLiveTest(null);
            sessionStorage.removeItem('daiva_active_suite');
            setTimeout(() => {
              api(`/api/suite-runs/${d.suite_run_id}`)
                .then(r => { setResults(r); setRunning(false); loadHistory(); })
                .catch(() => setRunning(false));
            }, 1000);
          }
          if (msg.type === "suite_aborted") {
            setRunning(false);
            setAborting(false);
            setLiveTest(null);
            setProgress(prev => ({ ...prev, pending: 0 }));
            sessionStorage.removeItem('daiva_active_suite');
            setTimeout(() => {
              api(`/api/suite-runs/${d.suite_run_id}`)
                .then(r => { setResults(r); loadHistory(); })
                .catch(() => {});
            }, 500);
          }
        } catch(e) {}
      };
    } catch(e) { alert(e.message); setRunning(false); }
  };

  const stopWs = () => { if(wsRef.current) { wsRef.current.close(); wsRef.current=null; } };
  useEffect(() => stopWs, []);

  const abortSuite = async () => {
    if (!suiteRunId) return;
    setAborting(true);
    try {
      await api(`/api/suite-runs/${suiteRunId}/abort`, { method: 'DELETE' });
    } catch(e) {
      alert('Abort failed: ' + e.message);
      setAborting(false);
    }
  };

  const statusColor = { passed:"#00a86b", failed:"#e53935", partial:"#f59e0b", running:"#1a6fc4" };
  const statusBgCol = { passed:"#e6f7f1", failed:"#fdecea", partial:"#fef9e7", running:"#e3f0fb" };

  return (
    <div style={s.col}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:20, fontWeight:700, color:"#8B0000" }}>🚀 Suite Runner</div>
          <div style={{ fontSize:13, color:"#8a96a8", marginTop:3 }}>
            Select a suite, pick test cases and run them all at once
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={()=>{
              setTab("run");
              // Only reset if not currently running
              if (!running) {
                setProgress(null); setResults(null);
                setLiveTest(null); setLiveScreen(null);
                setLiveLog([]); setTestStatuses({});
                sessionStorage.removeItem('daiva_active_suite');
              }
            }}
            style={{ ...s.btn(tab==="run"?"primary":"ghost", true) }}>
            🚀 New Run
          </button>
          {(tab==="progress" || progress) && (
            <button onClick={()=>setTab("progress")}
              style={{ ...s.btn(tab==="progress"?"primary":"ghost", true) }}>
              {running ? "⏳ Live" : "📊 Results"}
            </button>
          )}
          <button onClick={async ()=>{
              setTab("history");
              await loadHistory();
            }}
            style={{ ...s.btn(tab==="history"?"primary":"ghost", true) }}>
            📋 History
          </button>
        </div>
      </div>

      {/* ── New Run Tab ── */}
      {tab === "run" && (
        <div style={{ display:"flex", gap:16, alignItems:"flex-start" }}>

          {/* Left — filters + run button */}
          <div style={{ width:280, display:"flex", flexDirection:"column", gap:12 }}>
            <div style={s.card}>
              <div style={{ fontSize:13, fontWeight:700, color:"#1a2332", marginBottom:14 }}>
                Configure Run
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <div>
                  <label style={s.label}>Project <span style={{color:"#e53e3e"}}>*</span></label>
                  <select style={{ ...s.input,
                    borderColor: !selProject ? "#f59e0b" : "#e2e6ed",
                    background:  !selProject ? "#fffbeb" : "#fff" }}
                    value={selProject}
                    onChange={e=>{ setSelProject(e.target.value); setSelSuite(""); setSelTests([]); setSuiteTests([]); }}>
                    <option value="">— Select Project —</option>
                    {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                {selProject && (
                  <div>
                    <label style={s.label}>Suite <span style={{color:"#e53e3e"}}>*</span></label>
                    <select style={{ ...s.input,
                      borderColor: !selSuite ? "#f59e0b" : "#e2e6ed",
                      background:  !selSuite ? "#fffbeb" : "#fff" }}
                      value={selSuite}
                      onChange={e=>{ setSelSuite(e.target.value); setSelTests([]); }}>
                      <option value="">— Select Suite —</option>
                      {suites
                        .filter(s2=>String(s2.project_id)===String(selProject))
                        .map(s2=><option key={s2.id} value={s2.id}>{s2.name}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label style={s.label}>Browser</label>
                  <select style={s.input} value={browser} onChange={e=>setBrowser(e.target.value)}>
                    <option value="chrome">Chrome</option>
                    <option value="chromium">Chromium</option>
                    <option value="firefox">Firefox</option>
                  </select>
                </div>
                <div>
                  <label style={s.label}>Notify Email on Completion</label>
                  <input style={s.input} type="email" value={notifyEmail}
                    onChange={e=>setNotifyEmail(e.target.value)}
                    placeholder="e.g. team@hospital.org (optional)" />
                  <div style={{ fontSize:11, color:"#8a96a8", marginTop:4 }}>
                    📧 Email sent when suite finishes with pass/fail summary
                  </div>
                </div>
              </div>
            </div>

            {/* Summary */}
            <div style={{ ...s.card, background: !selProject||!selSuite?"#fffbeb":"#f0f7ff",
              border: `1px solid ${!selProject||!selSuite?"#fde68a":"#bdd7f5"}` }}>
              <div style={{ fontSize:13, color: !selProject||!selSuite?"#92400e":"#1a6fc4" }}>
                <div style={{ fontWeight:700, marginBottom:8 }}>
                  {!selProject ? "⚠️ Select a project" : !selSuite ? "⚠️ Select a suite" : "Run Summary"}
                </div>
                {selProject && selSuite && (<>
                  <div>Total: <b>{suitedTests.length}</b></div>
                  <div>Selected: <b style={{ color: someSelected?"#1a6fc4":"#8a96a8" }}>{selTests.length}</b></div>
                  <div>Browser: <b>{browser}</b></div>
                </>)}
                {(!selProject || !selSuite) && (
                  <div style={{ fontSize:11, lineHeight:1.6 }}>
                    {!selProject ? "Choose a project to get started" : "Choose a suite to load test cases"}
                  </div>
                )}
              </div>
            </div>

            <button
              style={{ ...s.btn("primary"), padding:12, fontSize:14,
                display:"flex", alignItems:"center", justifyContent:"center", gap:8,
                opacity: (someSelected && selProject && selSuite) ? 1 : 0.5 }}
              onClick={runSuite} disabled={running || !someSelected || !selProject || !selSuite}>
              {running ? "⏳ Running..." : !selProject ? "Select a project first" : !selSuite ? "Select a suite first" : `▶ Run ${selTests.length} Test${selTests.length!==1?"s":""}`}
            </button>
          </div>

          {/* Right — test case list */}
          <div style={{ flex:1, ...s.card, padding:0, overflow:"hidden" }}>

            {/* Empty state — guide user */}
            {!selProject && (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                justifyContent:"center", padding:"60px 24px", gap:12, textAlign:"center" }}>
                <div style={{ fontSize:40 }}>📁</div>
                <div style={{ fontSize:15, fontWeight:700, color:"#1a2332" }}>Select a Project</div>
                <div style={{ fontSize:13, color:"#8a96a8", maxWidth:280, lineHeight:1.6 }}>
                  Choose a project from the left panel to see its test suites
                </div>
              </div>
            )}

            {selProject && !selSuite && (
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center",
                justifyContent:"center", padding:"60px 24px", gap:12, textAlign:"center" }}>
                <div style={{ fontSize:40 }}>🗂️</div>
                <div style={{ fontSize:15, fontWeight:700, color:"#1a2332" }}>Select a Suite</div>
                <div style={{ fontSize:13, color:"#8a96a8", maxWidth:280, lineHeight:1.6 }}>
                  Choose a test suite to load its test cases here
                </div>
                {suites.filter(s2=>String(s2.project_id)===String(selProject)).length === 0 && (
                  <div style={{ fontSize:12, color:"#e53e3e", marginTop:4 }}>
                    No suites found for this project. Create one in Test Suites.
                  </div>
                )}
              </div>
            )}

            {selProject && selSuite && loadingTests && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center",
                padding:40, gap:10, color:"#8a96a8", fontSize:13 }}>
                <div>⏳ Loading test cases...</div>
              </div>
            )}

            {selSuite && !loadingTests && suitedTests.length > 0 && (
              <div style={{ padding:"8px 16px", background:"#f0f7ff",
                borderTop:"1px solid #e2e6ed", fontSize:11, color:"#1a6fc4" }}>
                💡 Order pre-filled from suite settings. Changes here only affect <b>this run</b>.
                Ordered tests run first — blank = runs after ordered ones.
              </div>
            )}

            {/* Table + rows — only shown when suite selected and not loading */}
            {selSuite && !loadingTests && (
              <div>
                <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px",
                  borderBottom:"2px solid #e2e6ed", background:"#f8f9fc" }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll}
                    style={{ width:16, height:16, cursor:"pointer" }} />
                  <div style={{ flex:1, fontSize:12, fontWeight:700, color:"#4a5568",
                    textTransform:"uppercase", letterSpacing:"0.06em" }}>
                    Test Case
                    <span style={{ marginLeft:8, fontWeight:400, color:"#8a96a8" }}>
                      ({suitedTests.length} loaded)
                    </span>
                  </div>
                  <div style={{ fontSize:12, fontWeight:700, color:"#4a5568",
                    textTransform:"uppercase", letterSpacing:"0.06em", width:80 }}>Type</div>
                  <div style={{ fontSize:12, fontWeight:700, color:"#4a5568",
                    textTransform:"uppercase", letterSpacing:"0.06em", width:80 }}>Priority</div>
                  <div style={{ fontSize:12, fontWeight:700, color:"#1a6fc4",
                    textTransform:"uppercase", letterSpacing:"0.06em", width:70, textAlign:"center" }}>Order</div>
                </div>
                {suitedTests.length === 0 ? (
                  <div style={{ textAlign:"center", padding:"48px 24px", color:"#8a96a8" }}>
                    <div style={{ fontSize:36, marginBottom:8 }}>🧪</div>
                    <div style={{ fontWeight:600, color:"#4a5568" }}>No test cases in this suite</div>
                    <div style={{ fontSize:13, marginTop:4 }}>Add test cases to this suite from Test Suites page</div>
                  </div>
                ) : (
                  <div style={{ maxHeight:500, overflowY:"auto" }}>
                    {suitedTests.map(t => (
                      <div key={t.id} onClick={()=>toggleTest(t.id)}
                        style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 16px",
                          borderBottom:"1px solid #f0f2f5", cursor:"pointer",
                          background: selTests.includes(t.id) ? "#f0f7ff" : "white",
                          transition:"background 0.1s" }}>
                        <input type="checkbox" checked={selTests.includes(t.id)} onChange={()=>toggleTest(t.id)}
                          onClick={e=>e.stopPropagation()}
                          style={{ width:16, height:16, cursor:"pointer", flexShrink:0 }} />
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:13, fontWeight:600, color:"#1a2332" }}>{t.name}</div>
                          {t.tags?.length > 0 && (
                            <div style={{ display:"flex", gap:4, marginTop:3 }}>
                              {t.tags.map(tag=>(
                                <span key={tag} style={{ ...s.tag, fontSize:10, padding:"1px 6px" }}>{tag}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ width:80 }}>
                          <span style={{ fontSize:11, background:"#e3f0fb", color:"#1a6fc4",
                            padding:"2px 8px", borderRadius:4, fontWeight:600 }}>{t.type}</span>
                        </div>
                        <div style={{ width:80 }}>
                          <span style={{ fontSize:11, fontWeight:600,
                            color: t.priority==="critical"?"#e53935":t.priority==="high"?"#f97316":t.priority==="medium"?"#f59e0b":"#64748b" }}>
                            {t.priority}
                          </span>
                        </div>
                        {/* Run order input — pre-filled from suite, editable for this run */}
                        <div style={{ width:70, display:"flex", justifyContent:"center" }}
                          onClick={e=>e.stopPropagation()}>
                          <input
                            type="number" min="1"
                            placeholder="—"
                            value={testOrders[t.id] || ""}
                            onChange={e=>setTestOrders(prev=>({
                              ...prev,
                              [t.id]: e.target.value ? parseInt(e.target.value) : null
                            }))}
                            style={{ width:54, padding:"3px 6px", fontSize:12,
                              border:"1px solid #e2e6ed", borderRadius:5,
                              textAlign:"center", outline:"none",
                              background: testOrders[t.id] ? "#eff6ff" : "#f9fafb",
                              color: testOrders[t.id] ? "#1a6fc4" : "#9ca3af",
                              fontWeight: testOrders[t.id] ? 700 : 400 }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Progress Tab ── */}
      {tab === "progress" && progress && (
        <div style={s.col}>

          {/* Stats row */}
          <div style={{ display:"flex", gap:12 }}>
            {[
              { label:"Passed",  value:progress.passed,  color:"#00a86b", bg:"#e6f7f1" },
              { label:"Failed",  value:progress.failed,  color:"#e53935", bg:"#fdecea" },
              { label:"Pending", value:progress.pending, color:"#8a96a8", bg:"#f8f9fc" },
              { label:"Total",   value:selTests.length,  color:"#1a6fc4", bg:"#e3f0fb" },
            ].map(st=>(
              <div key={st.label} style={{ flex:1, background:st.bg, borderRadius:8,
                padding:"12px 16px", textAlign:"center", border:`1px solid ${st.color}30` }}>
                <div style={{ fontSize:28, fontWeight:800, color:st.color }}>{st.value}</div>
                <div style={{ fontSize:11, color:st.color, fontWeight:700, textTransform:"uppercase",
                  letterSpacing:"0.06em", marginTop:4 }}>{st.label}</div>
              </div>
            ))}
          </div>

          {/* Progress bar */}
          <div style={s.card}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:14, fontWeight:700, color:"#1a2332" }}>
                {running ? "⏳ Running Tests..." : "✅ Suite Run Complete"}
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ fontSize:12, color:"#8a96a8" }}>
                  {selTests.length > 0 ? Math.round(((progress.passed+progress.failed)/selTests.length)*100) : 0}%
                </div>
                {running && (
                  <button
                    onClick={() => {
                      if (!window.confirm('Abort suite run? Tests already completed will keep their results.')) return;
                      abortSuite();
                    }}
                    disabled={aborting}
                    style={{ display:'flex', alignItems:'center', gap:5,
                      padding:'5px 12px', borderRadius:6, border:'1.5px solid #e53935',
                      background: aborting ? '#fee2e2' : '#fff5f5', color:'#e53935',
                      fontSize:12, fontWeight:700, cursor: aborting ? 'not-allowed' : 'pointer' }}>
                    {aborting ? 'Aborting...' : '⏹ Abort Suite'}
                  </button>
                )}
              </div>
            </div>
            <div style={{ background:"#f0f2f5", borderRadius:20, height:8, overflow:"hidden" }}>
              <div style={{ height:"100%", borderRadius:20, transition:"width 0.5s ease",
                background: progress.failed > 0 ? "#e53935" : "#00a86b",
                width:`${selTests.length > 0 ? Math.round(((progress.passed+progress.failed)/selTests.length)*100) : 0}%` }} />
            </div>
            {liveTest && running && (
              <div style={{ marginTop:10, fontSize:12, color:"#1a6fc4",
                display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:"#1a6fc4",
                  animation:"pulse 1.2s infinite" }} />
                Running: <b>{liveTest}</b>
              </div>
            )}
          </div>

          {/* Live Navigation View — full width, immersive */}
          {running && (
            <div style={{ background:"#0f172a", borderRadius:12, overflow:"hidden",
              border:"1px solid #1e293b" }}>

              {/* Top bar */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                padding:"10px 16px", background:"#1e293b", borderBottom:"1px solid #334155" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:10, height:10, borderRadius:"50%", flexShrink:0,
                    background: liveTest ? "#22c55e" : "#475569",
                    boxShadow: liveTest ? "0 0 0 3px rgba(34,197,94,0.25)" : "none" }} />
                  <span style={{ fontSize:13, color:"#e2e8f0", fontWeight:600 }}>
                    {liveTest ? `▶  ${liveTest}` : "⏳  Waiting for test to start..."}
                  </span>
                </div>
                <div style={{ display:"flex", gap:16, fontSize:11, color:"#64748b" }}>
                  <span>✓ <b style={{color:"#4ade80"}}>{progress.passed}</b></span>
                  <span>✗ <b style={{color:"#f87171"}}>{progress.failed}</b></span>
                  <span>⏳ <b style={{color:"#94a3b8"}}>{progress.pending}</b></span>
                </div>
              </div>

              {/* Main body — 3 columns */}
              <div style={{ display:"flex", height:"calc(100vh - 300px)", minHeight:520 }}>

                {/* Col 1 — Test queue (narrow) */}
                <div style={{ width:240, flexShrink:0, borderRight:"1px solid #1e293b",
                  overflowY:"auto" }}>
                  <div style={{ padding:"8px 12px", fontSize:10, fontWeight:700,
                    color:"#475569", letterSpacing:"0.1em", textTransform:"uppercase",
                    borderBottom:"1px solid #1e293b" }}>
                    Queue ({selTests.length})
                  </div>
                  {suitedTests.filter(t => selTests.includes(t.id)).map(t => {
                    const ts       = testStatuses[t.name];
                    const status   = ts?.status || "pending";
                    const isActive = liveTest === t.name;
                    const dot = status==="passed"?"#22c55e":status==="failed"?"#f87171":
                                status==="running"?"#38bdf8":"#334155";
                    const icon = status==="passed"?"✓":status==="failed"?"✗":
                                 status==="running"?"▶":"·";
                    return (
                      <div key={t.id} style={{ padding:"9px 12px",
                        borderBottom:"1px solid #1e293b",
                        background: isActive ? "rgba(56,189,248,0.08)" : "transparent",
                        borderLeft: isActive ? "3px solid #38bdf8" : "3px solid transparent",
                        display:"flex", alignItems:"flex-start", gap:8, cursor:"default" }}>
                        <span style={{ color:dot, fontSize:12, fontWeight:900,
                          marginTop:1, flexShrink:0 }}>{icon}</span>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:11, color: isActive?"#e2e8f0":"#94a3b8",
                            fontWeight: isActive?700:400,
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                            lineHeight:1.4 }}>{t.name}</div>
                          {ts?.steps_total > 0 && (
                            <div style={{ fontSize:9, color:"#475569", marginTop:2 }}>
                              {ts.steps_passed}/{ts.steps_total} steps
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Col 2 — Live screenshot (big) */}
                <div style={{ flex:1, display:"flex", alignItems:"center",
                  justifyContent:"center", background:"#0f172a", overflow:"hidden",
                  position:"relative" }}>
                  {liveScreen ? (
                    <img src={`data:image/png;base64,${liveScreen}`}
                      style={{ maxWidth:"100%", maxHeight:"100%",
                        objectFit:"contain", display:"block" }}
                      alt="Live browser" />
                  ) : (
                    <div style={{ textAlign:"center", color:"#334155" }}>
                      <div style={{ fontSize:48, marginBottom:12 }}>🖥️</div>
                      <div style={{ fontSize:13, color:"#475569" }}>
                        {liveTest ? "Capturing screenshots..." : "Waiting for test to start..."}
                      </div>
                    </div>
                  )}
                  {/* Overlay label bottom-left */}
                  {liveScreen && liveTest && (
                    <div style={{ position:"absolute", bottom:10, left:10,
                      background:"rgba(15,23,42,0.8)", color:"#94a3b8",
                      fontSize:10, padding:"3px 10px", borderRadius:20,
                      fontFamily:"monospace", backdropFilter:"blur(4px)" }}>
                      {liveTest}
                    </div>
                  )}
                </div>

                {/* Col 3 — Live log (wide, scrollable) */}
                <div style={{ width:400, flexShrink:0, borderLeft:"1px solid #1e293b",
                  display:"flex", flexDirection:"column" }}>
                  <div style={{ padding:"8px 12px", fontSize:10, fontWeight:700,
                    color:"#475569", letterSpacing:"0.1em", textTransform:"uppercase",
                    borderBottom:"1px solid #1e293b", display:"flex",
                    alignItems:"center", gap:6 }}>
                    <span style={{ width:6, height:6, borderRadius:"50%",
                      background:"#22c55e", display:"inline-block" }} />
                    Live Log
                  </div>
                  <div id="suite-live-log" style={{ flex:1, overflowY:"auto", padding:"10px 12px",
                    fontFamily:"'IBM Plex Mono',monospace", fontSize:11, lineHeight:1.7 }}
                    ref={el => { if(el) el.scrollTop = el.scrollHeight; }}>
                    {liveLog.length === 0 ? (
                      <div style={{ color:"#334155", fontStyle:"italic" }}>
                        Waiting for logs...
                      </div>
                    ) : (
                      liveLog.map((line, i) => {
                        const isPass = line.includes("[OK]") || line.includes("PASSED");
                        const isFail = line.includes("[FAIL]") || line.includes("FAILED");
                        const isWarn = line.includes("[WARN]") || line.includes("warn");
                        const isInfo = line.includes(">>") || line.includes("Step") || line.includes("Loop");
                        const isSoft = line.includes("[SOFT");
                        const color  = isFail?"#f87171":isPass?"#4ade80":isSoft?"#fbbf24":
                                       isWarn?"#fbbf24":isInfo?"#60a5fa":"#64748b";
                        return (
                          <div key={i} style={{ color, marginBottom:2,
                            wordBreak:"break-all",
                            paddingLeft: 8,
                            borderLeft: isFail?"2px solid #f87171":isPass?"2px solid #4ade80":
                                        isSoft?"2px solid #fbbf24":"2px solid transparent",
                            fontSize: isFail||isPass ? 11 : 10 }}>
                            {line}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Results table once done */}
          {results && (
            <div style={s.card}>
              <div style={{ fontSize:14, fontWeight:700, color:"#1a2332", marginBottom:14 }}>
                Test Results
              </div>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Test Case","Type","Status","Duration","Steps","Failure Reason"].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.runs?.map((run,i) => {
                    // Extract failure reason from logs
                    const failLog = (run.logs||[]).find(l=>l.level==="fail");
                    const failMsg = failLog?.message?.replace(/^\[FAIL\]\s*/,"") || "";
                    return (
                      <tr key={run.id} style={{ background: i%2===0?"#ffffff":"#f8f9fc" }}>
                        <td style={s.td}><b style={{color:"#1a2332"}}>{run.test_name}</b></td>
                        <td style={s.td}><span style={s.tag}>{run.test_type}</span></td>
                        <td style={s.td}>
                          <span style={s.badge(
                            statusColor[run.status]||"#8a96a8",
                            statusBgCol[run.status]||"#f8f9fc"
                          )}>
                            {run.status}
                          </span>
                        </td>
                        <td style={s.td}>{run.duration_ms ? `${(run.duration_ms/1000).toFixed(1)}s` : "—"}</td>
                        <td style={s.td}>{run.steps_passed||0}/{run.steps_total||0}</td>
                        <td style={s.td}>
                          {failMsg ? (
                            <span style={{ fontSize:11, color:"#c62828",
                              background:"#fdecea", padding:"3px 8px", borderRadius:4,
                              display:"inline-block", maxWidth:220,
                              whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}
                              title={failMsg}>
                              ✗ {failMsg.slice(0,60)}{failMsg.length>60?"...":""}
                            </span>
                          ) : (run.status==="passed" ? (
                            <span style={{ fontSize:11, color:"#00a86b" }}>✓ All steps passed</span>
                          ) : "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!running && (
            <div style={{ display:"flex", gap:10, alignSelf:"flex-start" }}>
              <button style={s.btn("primary")}
                onClick={()=>{
                  setTab("run");
                  setProgress(null); setResults(null);
                  setLiveTest(null); setLiveScreen(null);
                  setLiveLog([]); setTestStatuses({});
                  sessionStorage.removeItem('daiva_active_suite');
                }}>
                ← New Run
              </button>
              <button style={s.btn("ghost")}
                onClick={()=>{ setTab("history"); loadHistory(); }}>
                📋 View History
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div style={s.card}>
          <div style={{ fontSize:14, fontWeight:700, color:"#1a2332", marginBottom:16 }}>
            Suite Run History
          </div>
          {history.length === 0 ? (
            <div style={{ textAlign:"center", padding:"48px 24px", color:"#8a96a8" }}>
              <div style={{ fontSize:36, marginBottom:8 }}>📋</div>
              <div style={{ fontWeight:600, color:"#4a5568" }}>No suite runs yet</div>
              <div style={{ fontSize:13, marginTop:4 }}>Run a suite to see history here</div>
              <button onClick={loadHistory} style={{ ...s.btn("ghost",true), marginTop:12, fontSize:12 }}>🔄 Refresh</button>
            </div>
          ) : (
            <table style={s.table}>
              <thead>
                <tr>
                  {["Suite","Project","Status","Passed","Failed","Total","Browser","Date","Report","Action"].map(h=>(
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((sr,i) => (
                  <tr key={sr.id} style={{ background:i%2===0?"#ffffff":"#f8f9fc", cursor:"pointer" }}
                    onClick={async ()=>{
                      const d = await api(`/api/suite-runs/${sr.id}`);
                      setViewResult(d);
                    }}>
                    <td style={s.td}><b style={{color:"#1a2332"}}>{sr.name||sr.suite_name||"—"}</b></td>
                    <td style={s.td}>{sr.project_name||"—"}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge(
                        statusColor[sr.status]||"#8a96a8",
                        statusBgCol[sr.status]||"#f8f9fc"
                      )}}>
                        {sr.status}
                      </span>
                    </td>
                    <td style={{ ...s.td, color:"#00a86b", fontWeight:700 }}>{sr.passed||sr.passed_tests||0}</td>
                    <td style={{ ...s.td, color:"#e53935", fontWeight:700 }}>{sr.failed||sr.failed_tests||0}</td>
                    <td style={s.td}>{sr.total||sr.total_tests||0}</td>
                    <td style={s.td}>{sr.browser}</td>
                    <td style={{ ...s.td, color:"#8a96a8", fontSize:12 }}>
                      {new Date(sr.started_at).toLocaleString("en-IN")}
                    </td>
                    <td style={s.td} onClick={e=>e.stopPropagation()}>
                      <a href={`${API}/api/suite-runs/${sr.id}/report?token=${getToken()}`}
                        target="_blank" rel="noreferrer"
                        style={{ ...s.btn("primary",true), fontSize:11, textDecoration:"none",
                          display:"inline-block", padding:"3px 10px" }}>
                        📥 HTML
                      </a>
                    </td>
                    <td style={s.td} onClick={e=>e.stopPropagation()}>
                      {sr.status === 'running' && (
                        <button
                          onClick={async ()=>{
                            if (!window.confirm('Abort this suite run? Currently running test will stop and all pending tests will be cancelled.')) return;
                            try {
                              await api(`/api/suite-runs/${sr.id}/abort`, { method:'DELETE' });
                              await loadHistory();
                            } catch(e) { alert('Abort failed: ' + e.message); }
                          }}
                          style={{ fontSize:11, padding:"3px 10px", borderRadius:5,
                            background:"#fff5f5", color:"#e53935",
                            border:"1.5px solid #e53935", cursor:"pointer",
                            fontWeight:700, display:"flex", alignItems:"center", gap:4 }}>
                          ⏹ Abort
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* History detail modal */}
      {viewResult && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setViewResult(null)}>
          <div style={{ ...s.modalBox, maxWidth:800 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
              <div>
                <div style={{ fontSize:17, fontWeight:700, color:"#1a2332" }}>{viewResult.name||viewResult.suite_name}</div>
                <div style={{ fontSize:12, color:"#8a96a8", marginTop:3 }}>
                  {new Date(viewResult.started_at).toLocaleString("en-IN")} · {viewResult.browser}
                </div>
              </div>
              <div style={{ display:"flex", gap:12, alignItems:"center" }}>
                <span style={{ fontSize:13, color:"#00a86b", fontWeight:700 }}>
                  ✓ {viewResult.passed || (viewResult.runs||[]).filter(r=>r.status==="passed").length} passed
                </span>
                <span style={{ fontSize:13, color:"#e53935", fontWeight:700 }}>
                  ✗ {viewResult.failed || (viewResult.runs||[]).filter(r=>r.status==="failed").length} failed
                </span>
                <a href={`${API}/api/suite-runs/${viewResult.id}/report?token=${getToken()}`}
                  target="_blank" rel="noreferrer"
                  style={{ ...s.btn("primary",true), fontSize:12, textDecoration:"none",
                    display:"inline-flex", alignItems:"center", gap:4 }}>
                  📥 Download HTML Report
                </a>
                <button onClick={()=>setViewResult(null)}
                  style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:"#8a96a8" }}>×</button>
              </div>
            </div>
            <table style={s.table}>
              <thead>
                <tr>
                  {["Test Case","Status","Duration","Steps","Failure Reason"].map(h=>(
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {viewResult.runs?.map((run,i)=>{
                  const failLog = (run.logs||[]).find(l=>l.level==="fail");
                  const failMsg = failLog?.message?.replace(/^\[FAIL\]\s*/,"") || "";
                  return (
                    <tr key={run.id} style={{ background:i%2===0?"#fff":"#f8f9fc" }}>
                      <td style={s.td}>
                        <b style={{color:"#1a2332"}}>{run.test_name}</b>
                        {run.retried && run.status==="passed" && (
                          <span style={{ marginLeft:8, background:"#fff7ed", color:"#c2410c",
                            border:"1px solid #fed7aa", borderRadius:10, padding:"2px 7px",
                            fontSize:10, fontWeight:700 }}>🔁 Passed on retry</span>
                        )}
                        {run.retried && run.status==="failed" && (
                          <span style={{ marginLeft:8, background:"#fef2f2", color:"#dc2626",
                            border:"1px solid #fecaca", borderRadius:10, padding:"2px 7px",
                            fontSize:10, fontWeight:700 }}>⚠️ Failed on retry</span>
                        )}
                      </td>
                      <td style={s.td}>
                        <span style={s.badge(statusColor[run.status]||"#8a96a8", statusBgCol[run.status]||"#f8f9fc")}>
                          {run.status}
                        </span>
                      </td>
                      <td style={s.td}>{run.duration_ms ? `${(run.duration_ms/1000).toFixed(1)}s`:"-"}</td>
                      <td style={s.td}>{run.steps_passed||0}/{run.steps_total||0}</td>
                      <td style={s.td}>
                        {failMsg ? (
                          <span style={{ fontSize:11, color:"#c62828", background:"#fdecea",
                            padding:"3px 8px", borderRadius:4, display:"inline-block",
                            maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}
                            title={failMsg}>
                            ✗ {failMsg.slice(0,55)}{failMsg.length>55?"...":""}
                          </span>
                        ) : run.status==="passed" ? (
                          <span style={{ fontSize:11, color:"#00a86b" }}>{run.retried ? "🔁 Passed on retry" : "✓ Passed"}</span>
                        ) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


export { TestSuites, DbConnections, SuiteRunner };
