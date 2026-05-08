import React, { useState, useEffect, useRef } from "react";
import { api, s, C, Empty, APP_PAGE_SIZE, API, statusColor, priorityColor } from "./shared.jsx";

const UM_INPUT = {
  width: "100%", padding: "9px 12px", border: "1.5px solid #e2e6ed",
  borderRadius: 8, fontSize: 13, color: "#1a2332", background: "#fff",
  outline: "none", boxSizing: "border-box", marginBottom: 0,
  fontFamily: "'Inter','Segoe UI',sans-serif",
};
const UM_SELECT = { ...UM_INPUT };
const UM_LABEL  = {
  display: "block", fontSize: 12, fontWeight: 700, color: "#4a5568",
  marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em",
};


// ─── MODULE SELECTOR ─────────────────────────────────────────────────────────
function ModuleSelector({ projectId, value, onChange }) {
  const [modules, setModules] = useState([]);
  useEffect(() => {
    if (!projectId) { setModules([]); return; }
    api(`/api/modules?project_id=${projectId}`)
      .then(m => setModules(Array.isArray(m)?m:[]))
      .catch(() => setModules([]));
  }, [projectId]);

  // Ensure value is always string for select comparison
  const strVal = value ? String(value) : "";

  return (
    <select style={{...s.input}} value={strVal}
      onChange={e => onChange(e.target.value ? parseInt(e.target.value) : null)}>
      <option value="">— No module —</option>
      {modules.map(m => <option key={m.id} value={String(m.id)}>{m.name}</option>)}
    </select>
  );
}

function ModuleMaster({ projects, user }) {
  const [modules,  setModules]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(false);
  const [editing,  setEditing]  = useState(null);
  const [form,     setForm]     = useState({ name:"", description:"", project_id:"" });
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState("");
  const [projFilt, setProjFilt] = useState("");

  const canEdit = ["admin","lead","superadmin"].includes(user?.role);

  const load = async () => {
    setLoading(true);
    try {
      const q = projFilt ? `?project_id=${projFilt}` : "";
      const mods = await api(`/api/modules${q}`);
      setModules(mods||[]);
    } catch(e) {
      setModules([]);
      if (!e.message?.includes("404")) alert(e.message);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [projFilt]);

  const openAdd = () => {
    setForm({ name:"", description:"", project_id: projFilt||"" });
    setEditing(null);
    setModal(true);
  };

  const openEdit = (m) => {
    setForm({ name:m.name, description:m.description||"", project_id:String(m.project_id) });
    setEditing(m.id);
    setModal(true);
  };

  const save = async () => {
    if (!form.name?.trim()) return alert("Module name is required");
    if (!form.project_id)   return alert("Please select a project");
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/modules/${editing}`, { method:"PUT", body: form });
      } else {
        await api("/api/modules", { method:"POST", body: form });
      }
      setModal(false);
      load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const del = async (m) => {
    if (!confirm(`Delete module "${m.name}"?`)) return;
    await api(`/api/modules/${m.id}`, { method:"DELETE" });
    load();
  };

  const filtered = modules.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.project_name?.toLowerCase().includes(search.toLowerCase())
  );

  // Group by project
  const grouped = {};
  filtered.forEach(m => {
    const key = m.project_name || "Unknown Project";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(m);
  });

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
        <div>
          <div style={{fontSize:22,fontWeight:800,color:"#8B0000"}}>📦 Module Master</div>
          <div style={{fontSize:13,color:"#8a96a8",marginTop:2}}>Manage modules per project — used for test case organisation and suite filtering</div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <select style={{...s.input,margin:0,width:180}} value={projFilt}
            onChange={e=>setProjFilt(e.target.value)}>
            <option value="">All Projects</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input style={{...s.input,margin:0,width:200}} placeholder="Search modules..."
            value={search} onChange={e=>setSearch(e.target.value)} />
          {canEdit && <button style={s.btn("primary")} onClick={openAdd}>+ New Module</button>}
        </div>
      </div>

      {loading ? (
        <div style={{textAlign:"center",padding:40,color:"#9ca3af"}}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{textAlign:"center",padding:40,color:"#9ca3af"}}>
          No modules found. {canEdit && "Click \"+ New Module\" to create one."}
        </div>
      ) : (
        Object.entries(grouped).map(([projName, mods]) => (
          <div key={projName} style={{marginBottom:24}}>
            <div style={{fontSize:13,fontWeight:700,color:"#6b7280",
              textTransform:"uppercase",letterSpacing:"0.06em",
              marginBottom:10,paddingBottom:6,
              borderBottom:"1px solid #f3f4f6"}}>
              📁 {projName} <span style={{color:"#9ca3af",fontWeight:400}}>({mods.length})</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
              {mods.map(m => (
                <div key={m.id} style={{background:"#fff",borderRadius:10,
                  border:"1px solid #e5e7eb",padding:"14px 16px",
                  boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                    <div style={{fontSize:14,fontWeight:700,color:"#111827"}}>📦 {m.name}</div>
                    {canEdit && (
                      <div style={{display:"flex",gap:4}}>
                        <button onClick={()=>openEdit(m)}
                          style={{...s.btn("ghost",true),fontSize:11,padding:"2px 8px"}}>Edit</button>
                        <button onClick={()=>del(m)}
                          style={{...s.btn("danger",true),fontSize:11,padding:"2px 8px"}}>Del</button>
                      </div>
                    )}
                  </div>
                  {m.description && (
                    <div style={{fontSize:12,color:"#6b7280",marginTop:4}}>{m.description}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      {modal && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div style={{...s.modalBox,maxWidth:440}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:17,fontWeight:800,color:"#1a2332"}}>
                📦 {editing?"Edit":"New"} Module
              </div>
              <button onClick={()=>setModal(false)}
                style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#8a96a8"}}>×</button>
            </div>
            <div style={{marginBottom:14}}>
              <label style={UM_LABEL}>Project <span style={{color:"#ef4444"}}>*</span></label>
              <select style={UM_INPUT} value={form.project_id}
                onChange={e=>setForm(f=>({...f,project_id:e.target.value}))} autoFocus>
                <option value="">Select project...</option>
                {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{marginBottom:14}}>
              <label style={UM_LABEL}>Module Name <span style={{color:"#ef4444"}}>*</span></label>
              <input style={UM_INPUT} value={form.name} maxLength={255}
                onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                placeholder="e.g. Patient Registration (max 255)" />
            </div>
            <div style={{marginBottom:20}}>
              <label style={UM_LABEL}>Description</label>
              <textarea style={{...UM_INPUT,height:70,resize:"vertical"}}
                value={form.description} maxLength={2000}
                onChange={e=>setForm(f=>({...f,description:e.target.value}))}
                placeholder="Optional description (max 2000)" />
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(false)}>Cancel</button>
              <button style={s.btn("primary")} onClick={save} disabled={saving}>
                {saving?"Saving...":"✓ Save Module"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── QUERY BUILDER ───────────────────────────────────────────────────────────
function QueryBuilder({ filterConfig, onChange, projects, modules }) {
  const conditions = filterConfig?.conditions || [];
  const logic      = filterConfig?.logic || "AND";

  const FIELDS = [
    { value:"project_id", label:"Project",     type:"select" },
    { value:"module_id",  label:"Module",       type:"select" },
    { value:"priority",   label:"Priority",     type:"select" },
    { value:"type",       label:"Type",         type:"select" },
    { value:"name",       label:"Name",         type:"text" },
    { value:"tags",       label:"Tag",          type:"text" },
    { value:"last_status",label:"Last Run",     type:"select" },
  ];

  const OPERATORS = {
    text:   [{value:"contains",label:"contains"},{value:"equals",label:"equals"},{value:"starts",label:"starts with"}],
    select: [{value:"equals",label:"="}],
  };

  const OPTIONS = {
    project_id:  projects.map(p=>({value:String(p.id),label:p.name})),
    module_id:   modules.map(m=>({value:String(m.id),label:`${m.project_name} / ${m.name}`})),
    priority:    [{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"critical",label:"Critical"}],
    type:        [{value:"ui",label:"UI"},{value:"api",label:"API"}],
    last_status: [{value:"passed",label:"Passed"},{value:"failed",label:"Failed"},{value:"never",label:"Never Run"}],
  };

  const addCondition = () => {
    onChange({ logic, conditions: [...conditions, { field:"priority", operator:"equals", value:"" }] });
  };

  const removeCondition = (i) => {
    onChange({ logic, conditions: conditions.filter((_,idx)=>idx!==i) });
  };

  const updateCondition = (i, key, val) => {
    const nc = conditions.map((c,idx) => idx===i ? {...c,[key]:val} : c);
    // Reset operator and value when field changes
    if (key==="field") {
      const fld = FIELDS.find(f=>f.value===val);
      nc[i].operator = fld?.type==="text" ? "contains" : "equals";
      nc[i].value = "";
    }
    onChange({ logic, conditions: nc });
  };

  return (
    <div style={{background:"#f8fafc",border:"1px solid #e2e6ed",borderRadius:8,padding:"12px 14px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
        <span style={{fontSize:12,fontWeight:700,color:"#374151"}}>Match</span>
        <select value={logic} onChange={e=>onChange({logic:e.target.value,conditions})}
          style={{...s.input,margin:0,width:70,fontSize:12,padding:"4px 8px"}}>
          <option value="AND">ALL</option>
          <option value="OR">ANY</option>
        </select>
        <span style={{fontSize:12,color:"#6b7280"}}>of the following conditions:</span>
      </div>

      {conditions.map((cond, i) => {
        const fld  = FIELDS.find(f=>f.value===cond.field) || FIELDS[0];
        const ops  = OPERATORS[fld.type] || OPERATORS.text;
        const opts = OPTIONS[cond.field];
        return (
          <div key={i} style={{display:"flex",gap:6,alignItems:"center",marginBottom:8}}>
            <select value={cond.field}
              onChange={e=>updateCondition(i,"field",e.target.value)}
              style={{...s.input,margin:0,flex:1,fontSize:12,padding:"5px 8px",minWidth:110}}>
              {FIELDS.map(f=><option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <select value={cond.operator}
              onChange={e=>updateCondition(i,"operator",e.target.value)}
              style={{...s.input,margin:0,width:90,fontSize:12,padding:"5px 8px"}}>
              {ops.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {opts ? (
              <select value={cond.value}
                onChange={e=>updateCondition(i,"value",e.target.value)}
                style={{...s.input,margin:0,flex:2,fontSize:12,padding:"5px 8px"}}>
                <option value="">Select...</option>
                {opts.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={cond.value}
                onChange={e=>updateCondition(i,"value",e.target.value)}
                placeholder="value..."
                style={{...s.input,margin:0,flex:2,fontSize:12,padding:"5px 8px"}} />
            )}
            <button onClick={()=>removeCondition(i)}
              style={{background:"none",border:"none",cursor:"pointer",color:"#e53e3e",fontSize:16,flexShrink:0}}>✕</button>
          </div>
        );
      })}

      <button onClick={addCondition}
        style={{...s.btn("ghost",true),fontSize:12,padding:"4px 12px",marginTop:4}}>
        + Add Condition
      </button>
    </div>
  );
}

// ─── QUERY PREVIEW PANEL ─────────────────────────────────────────────────────
function QueryPreview({ filterConfig, onSelect, selectedIds, onSelectedChange }) {
  const [results,  setResults]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [queried,  setQueried]  = useState(false);

  const run = async () => {
    setLoading(true);
    try {
      const r = await api("/api/suites/query-preview", {
        method:"POST", body:{ filter_config: filterConfig }
      });
      setResults(r);
      setQueried(true);
      // Auto-select all
      onSelectedChange(r.map(t=>t.id));
    } catch(e) { alert(e.message); }
    setLoading(false);
  };

  const toggleAll = () => {
    if (selectedIds.length === results.length) onSelectedChange([]);
    else onSelectedChange(results.map(t=>t.id));
  };

  const toggle = (id) => {
    onSelectedChange(prev =>
      prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]
    );
  };

  const priorityColor = { low:"#64748b", medium:"#f59e0b", high:"#f97316", critical:"#e53935" };
  const statusColor   = { passed:"#22c55e", failed:"#ef4444" };

  return (
    <div style={{marginTop:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:13,fontWeight:700,color:"#374151"}}>
          {queried ? `${results.length} matching test cases` : "Click Preview to see matching tests"}
        </span>
        <button onClick={run} disabled={loading}
          style={{...s.btn("primary",true),fontSize:12}}>
          {loading?"Searching...":"🔍 Preview Results"}
        </button>
      </div>

      {queried && results.length > 0 && (
        <div style={{border:"1px solid #e5e7eb",borderRadius:8,overflow:"hidden",maxHeight:320,overflowY:"auto"}}>
          <div style={{background:"#f9fafb",padding:"8px 12px",display:"flex",
            alignItems:"center",gap:10,borderBottom:"1px solid #e5e7eb",position:"sticky",top:0}}>
            <input type="checkbox"
              checked={selectedIds.length===results.length && results.length>0}
              onChange={toggleAll} style={{accentColor:"#1a6fc4"}} />
            <span style={{fontSize:12,color:"#6b7280"}}>
              {selectedIds.length} of {results.length} selected
            </span>
          </div>
          {results.map(t => (
            <div key={t.id} onClick={()=>toggle(t.id)}
              style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",
                cursor:"pointer",borderBottom:"1px solid #f3f4f6",
                background:selectedIds.includes(t.id)?"#eff6ff":"#fff",
                transition:"background 0.1s"}}>
              <input type="checkbox" checked={selectedIds.includes(t.id)}
                onChange={()=>toggle(t.id)} style={{accentColor:"#1a6fc4"}}
                onClick={e=>e.stopPropagation()} />
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:"#111827",
                  overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
                <div style={{fontSize:11,color:"#9ca3af",marginTop:1}}>
                  {t.project_name}{t.module_name?` / ${t.module_name}`:""}
                </div>
              </div>
              <span style={{fontSize:11,fontWeight:700,
                color:priorityColor[t.priority]||"#6b7280",
                background:"#f9fafb",padding:"2px 7px",borderRadius:8}}>
                {t.priority}
              </span>
              <span style={{fontSize:11,color:"#9ca3af",
                background:"#f3f4f6",padding:"2px 7px",borderRadius:8}}>
                {t.type?.toUpperCase()}
              </span>
              {t.last_status && (
                <span style={{fontSize:10,fontWeight:700,
                  color:statusColor[t.last_status]||"#9ca3af"}}>
                  {t.last_status}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {queried && results.length === 0 && (
        <div style={{textAlign:"center",padding:20,color:"#9ca3af",fontSize:13}}>
          No test cases match these conditions
        </div>
      )}
    </div>
  );
}


// No cache — always fetch fresh org data
let _orgCache = null;

function OrgMaster({ user: currentUser, projects: allProjectsProp }) {
  const [orgs,        setOrgs]        = useState([]);
  const [modalProjects, setModalProjects] = useState([]);
  const [allUsers,    setAllUsers]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [modal,       setModal]       = useState(null);
  const [selected,    setSelected]    = useState(null);
  const [form,        setForm]        = useState({ name:"", description:"" });
  const [assigned,    setAssigned]    = useState([]);
  const [saving,      setSaving]      = useState(false);
  const [modalLoading, setModalLoading] = useState(false);
  const [search,      setSearch]      = useState("");
  const [showInactive,    setShowInactive]    = useState(false);
  const [mappedElsewhere, setMappedElsewhere] = useState({});

  const navy = "#8B0000";

  // On mount — only load orgs (fast). Users loaded lazily when Users modal opens.
  const load = async () => {
    setLoading(true);
    try {
      const o = await api("/api/organisations?include_inactive=true");
      setOrgs(o||[]);
    } catch(e) { alert(e.message); }
    setLoading(false);
  };

  // Lazy-load users only when Users modal is about to open
  const ensureUsers = async () => {
    if (allUsers.length > 0) return allUsers;
    const u = await api("/api/users");
    setAllUsers(u||[]);
    return u||[];
  };

  // Lazy-load projects only when Projects modal is about to open
  const ensureProjects = async () => {
    const existing = modalProjects.length > 0 ? modalProjects : (allProjectsProp||[]);
    if (existing.length > 0) { if (modalProjects.length===0) setModalProjects(existing); return existing; }
    const p = await api("/api/projects");
    setModalProjects(p||[]);
    _orgCache = { ..._orgCache, projects: p||[] };
    return p||[];
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setForm({ name:"", description:"" });
    setModal("create");
  };

  const openEdit = (o) => {
    setSelected(o);
    setForm({ name:o.name, description:o.description||"" });
    setModal("edit");
  };

  const openProjects = async (o) => {
    setSelected(o); setAssigned([]); setMappedElsewhere({});
    setModal("projects"); setModalLoading(true);
    try {
      // Fetch org's assigned project IDs + full project list (cached after first load)
      const [ids, projs] = await Promise.all([
        api(`/api/organisations/${o.id}/projects`),
        modalProjects.length > 0
          ? Promise.resolve(modalProjects)
          : (allProjectsProp||[]).length > 0
            ? Promise.resolve((allProjectsProp||[]).filter(p => p.active !== false))
            : api("/api/projects"),
      ]);
      const assignedIds = (ids||[]).map(Number);
      const projList = Array.isArray(projs) ? projs.filter(p => p.active !== false) : [];
      setModalProjects(projList);
      setAssigned(assignedIds);
    } catch(e) { setModalProjects([]); setAssigned([]); }
    setModalLoading(false);
  };

  const openUsers = async (o) => {
    setSelected(o);
    setAssigned([]);
    setModal("users");
    setModalLoading(true);
    try {
      // Fetch all users only if not already loaded (cache across org clicks)
      const [allU, orgUserIds] = await Promise.all([
        allUsers.length > 0 ? Promise.resolve(allUsers) : api("/api/users"),
        api(`/api/organisations/${o.id}/users`)
      ]);
      const users = (allU||[]).filter(u => u.active && u.role !== 'superadmin' && u.id !== 1);
      setAllUsers(users);
      // orgUserIds is array of user objects (new endpoint) or IDs (old)
      const ids = (orgUserIds||[]).map(x => Number(typeof x === 'object' ? x.id : x));
      setAssigned(ids);
    } catch(e) { setAllUsers([]); setAssigned([]); }
    setModalLoading(false);
  };

  const saveCreate = async () => {
    if (!form.name?.trim()) return alert("Name is required");
    setSaving(true);
    try { await api("/api/organisations", { method:"POST", body:form }); setModal(null); load(); }
    catch(e) { alert(e.message); }
    setSaving(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    try { await api(`/api/organisations/${selected.id}`, { method:"PUT", body:form }); setModal(null); load(); }
    catch(e) { alert(e.message); }
    setSaving(false);
  };

  const saveAssigned = async () => {
    setSaving(true);
    try {
      const endpoint = modal==="projects"
        ? `/api/organisations/${selected.id}/projects`
        : `/api/organisations/${selected.id}/users`;
      const key = modal==="projects" ? "project_ids" : "user_ids";
      await api(endpoint, { method:"PUT", body:{ [key]: assigned } });
      setModalProjects([]);
      setAllUsers([]);
      setModal(null); load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const toggleActive = async (o) => {
    const action = o.active ? "Disable" : "Enable";
    if (!confirm(`${action} organisation "${o.name}"?

${o.active
      ? "All users in this org will lose access until it is re-enabled."
      : "This organisation and its users will regain access."}`)) return;
    try { await api(`/api/organisations/${o.id}/toggle-active`, { method:"PATCH" }); load(); }
    catch(e) { alert(e.message); }
  };

  const toggle = (id) => setAssigned(prev =>
    prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]
  );

  // Avatar initials + color
  const initials = (name) => name?.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase() || "?";
  const avatarColor = (name) => {
    const colors = [
      {bg:"#dbeafe",tx:"#1d4ed8"},{bg:"#dcfce7",tx:"#15803d"},
      {bg:"#fef3c7",tx:"#b45309"},{bg:"#fce7f3",tx:"#9d174d"},
      {bg:"#ede9fe",tx:"#6d28d9"},{bg:"#ffedd5",tx:"#c2410c"},
    ];
    const idx = (name||"").charCodeAt(0) % colors.length;
    return colors[idx];
  };

  const filtered = orgs.filter(o =>
    (showInactive || o.active) &&
    (!search || o.name.toLowerCase().includes(search.toLowerCase()))
  );

  const BtnStyle = (primary) => ({
    padding:"7px 14px", borderRadius:7, fontSize:12, fontWeight:600,
    cursor:"pointer", border:"none",
    background: primary ? "#1a56db" : "#f1f3f9",
    color:       primary ? "#fff"     : "#374151",
    transition:"all 0.12s",
  });

  return (
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",
        alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:22,fontWeight:800,color:navy}}>Organisations</div>
          <div style={{fontSize:13,color:"#9ca3af",marginTop:2}}>
            {filtered.length} organisation{filtered.length!==1?"s":""} · Manage orgs, projects and users
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input style={{...s.input,margin:0,width:200}} placeholder="Search..."
            value={search} onChange={e=>setSearch(e.target.value)} />
          <button
            onClick={()=>setShowInactive(v=>!v)}
            style={{ ...BtnStyle(false),
              borderColor: showInactive?"#dc2626":"#e5e7eb",
              color: showInactive?"#dc2626":"#6b7280" }}>
            {showInactive?"🙈 Hide Disabled":"👁 Show Disabled"}
          </button>
          <button style={BtnStyle(true)} onClick={openCreate}>+ New Organisation</button>
        </div>
      </div>

      {loading ? (
        <div style={{textAlign:"center",padding:"60px",color:"#9ca3af"}}>Loading...</div>
      ) : filtered.length===0 ? (
        <div style={{textAlign:"center",padding:"60px",color:"#9ca3af"}}>
          No organisations found
        </div>
      ) : (
        <div style={{display:"grid",
          gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:16}}>
          {filtered.map((o) => {
            const av = avatarColor(o.name);
            const isActive = o.active;
            return (
              <div key={o.id} style={{
                background: isActive ? "#fff" : "#f9fafb",
                borderRadius:14,
                border: isActive ? "1px solid #e8eaf0" : "1px dashed #d1d5db",
                boxShadow:"0 2px 10px rgba(0,0,0,0.05)",
                display:"flex",flexDirection:"column",
                opacity: isActive ? 1 : 0.78,
                transition:"box-shadow 0.15s",
                overflow:"hidden",
              }}
              onMouseEnter={e=>{if(isActive)e.currentTarget.style.boxShadow="0 6px 20px rgba(0,0,0,0.1)";}}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 10px rgba(0,0,0,0.05)"}>

                {/* Disabled banner */}
                {!isActive && (
                  <div style={{background:"#fee2e2",color:"#dc2626",fontSize:10,
                    fontWeight:700,textAlign:"center",padding:"4px",
                    letterSpacing:"0.06em"}}>
                    🔴 DISABLED
                  </div>
                )}

                {/* Card body */}
                <div style={{padding:"20px 20px 14px",flex:1}}>
                  {/* Top row — avatar + status */}
                  <div style={{display:"flex",justifyContent:"space-between",
                    alignItems:"flex-start",marginBottom:14}}>
                    <div style={{width:46,height:46,borderRadius:11,
                      background:av.bg,display:"flex",alignItems:"center",
                      justifyContent:"center",fontSize:17,fontWeight:800,color:av.tx,
                      flexShrink:0,letterSpacing:"0.05em"}}>
                      {initials(o.name)}
                    </div>
                    <span style={{
                      fontSize:10,fontWeight:700,padding:"3px 10px",borderRadius:20,
                      background: isActive?"#dcfce7":"#fee2e2",
                      color:       isActive?"#15803d":"#dc2626",
                      letterSpacing:"0.06em",textTransform:"uppercase"
                    }}>
                      {isActive?"Active":"Disabled"}
                    </span>
                  </div>

                  {/* Name + ID */}
                  <div style={{fontSize:15,fontWeight:800,color:navy,marginBottom:3,
                    lineHeight:1.3}}>{o.name}</div>
                  <div style={{fontSize:11,color:"#9ca3af",marginBottom:10,
                    fontFamily:"'IBM Plex Mono',monospace"}}>
                    ID: ORG-{String(o.id).padStart(4,"0")}
                  </div>
                  {o.description && (
                    <div style={{fontSize:12,color:"#6b7280",lineHeight:1.5,
                      marginBottom:12,overflow:"hidden",display:"-webkit-box",
                      WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>
                      {o.description}
                    </div>
                  )}

                  {/* Stats */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:8}}>
                    {[
                      {label:"PROJECTS",val:+o.project_count||0},
                      {label:"USERS",   val:+o.user_count||0},
                    ].map(st=>(
                      <div key={st.label} style={{background:"#f8f9fc",borderRadius:8,
                        padding:"10px 12px"}}>
                        <div style={{fontSize:9,fontWeight:700,color:"#9ca3af",
                          textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:4}}>
                          {st.label}
                        </div>
                        <div style={{fontSize:22,fontWeight:800,color:navy,
                          fontFamily:"'IBM Plex Mono',monospace",lineHeight:1}}>
                          {st.val>=1000
                            ? `${(st.val/1000).toFixed(1)}k`
                            : String(st.val).padStart(2,"0")}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Footer buttons */}
                <div style={{padding:"12px 16px",borderTop:"1px solid #f3f4f6",
                  display:"flex",gap:6,flexWrap:"wrap"}}>
                  <button onClick={()=>openEdit(o)}
                    style={BtnStyle(false)}
                    onMouseEnter={e=>e.currentTarget.style.background="#e8eaf0"}
                    onMouseLeave={e=>e.currentTarget.style.background="#f1f3f9"}>
                    Edit
                  </button>
                  <button onClick={()=>openProjects(o)}
                    style={BtnStyle(true)}
                    onMouseEnter={e=>e.currentTarget.style.background="#1340b0"}
                    onMouseLeave={e=>e.currentTarget.style.background="#1a56db"}>
                    Projects
                  </button>
                  <button onClick={()=>openUsers(o)}
                    style={BtnStyle(true)}
                    onMouseEnter={e=>e.currentTarget.style.background="#1340b0"}
                    onMouseLeave={e=>e.currentTarget.style.background="#1a56db"}>
                    Users
                  </button>
                  <button
                    onClick={()=>toggleActive(o)}
                    style={{...BtnStyle(false),
                      color: isActive?"#dc2626":"#16a34a",
                      background: isActive?"#fef2f2":"#f0fdf4"}}
                    onMouseEnter={e=>e.currentTarget.style.opacity="0.85"}
                    onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                    {isActive?"Disable":"Enable"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {modal==="create" && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox,maxWidth:460}}>
            <div style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:17,fontWeight:800,color:navy}}>New Organisation</div>
              <button onClick={()=>setModal(null)}
                style={{background:"none",border:"none",fontSize:22,
                  cursor:"pointer",color:"#9ca3af"}}>×</button>
            </div>
            <div style={{marginBottom:16}}>
              <label style={UM_LABEL}>Name <span style={{color:"#ef4444"}}>*</span></label>
              <input style={UM_INPUT} value={form.name} maxLength={255}
                onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                placeholder="e.g. Narayana Health (max 255)" autoFocus />
            </div>
            <div style={{marginBottom:20}}>
              <label style={UM_LABEL}>Description</label>
              <textarea style={{...UM_INPUT,height:80,resize:"vertical"}}
                value={form.description} maxLength={2000}
                onChange={e=>setForm(f=>({...f,description:e.target.value}))}
                placeholder="Optional description (max 2000)" />
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={s.btn("primary")} onClick={saveCreate} disabled={saving}>
                {saving?"Saving...":"Create Organisation"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {modal==="edit" && selected && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox,maxWidth:460}}>
            <div style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:17,fontWeight:800,color:navy}}>Edit Organisation</div>
              <button onClick={()=>setModal(null)}
                style={{background:"none",border:"none",fontSize:22,
                  cursor:"pointer",color:"#9ca3af"}}>×</button>
            </div>
            <div style={{marginBottom:16}}>
              <label style={UM_LABEL}>Name <span style={{color:"#ef4444"}}>*</span></label>
              <input style={UM_INPUT} value={form.name}
                onChange={e=>setForm(f=>({...f,name:e.target.value}))} autoFocus />
            </div>
            <div style={{marginBottom:20}}>
              <label style={UM_LABEL}>Description</label>
              <textarea style={{...UM_INPUT,height:80,resize:"vertical"}}
                value={form.description}
                onChange={e=>setForm(f=>({...f,description:e.target.value}))} />
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={s.btn("primary")} onClick={saveEdit} disabled={saving}>
                {saving?"Saving...":"Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Projects / Users Modal */}
      {(modal==="projects"||modal==="users") && selected && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox,maxWidth:500}}>
            <div style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",marginBottom:20}}>
              <div>
                <div style={{fontSize:17,fontWeight:800,color:navy}}>
                  {modal==="projects" ? "Assign Projects" : "Assign Users"}
                </div>
                <div style={{fontSize:12,color:"#9ca3af",marginTop:2}}>{selected.name}</div>
              </div>
              <button onClick={()=>setModal(null)}
                style={{background:"none",border:"none",fontSize:22,
                  cursor:"pointer",color:"#9ca3af"}}>×</button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:7,
              maxHeight:360,overflowY:"auto",marginBottom:16}}>
              {modalLoading ? (
                <div style={{textAlign:"center",padding:"32px",color:"#9ca3af",fontSize:13}}>⏳ Loading...</div>
              ) : modal==="projects" ? modalProjects.map(item => {
                const id = Number(item.id);
                const checked = assigned.includes(id);
                return (
                  <div key={id} onClick={()=>toggle(id)}
                    style={{display:"flex",alignItems:"center",gap:12,
                      padding:"10px 14px",borderRadius:9,cursor:"pointer",
                      background:checked?"#eff6ff":"#f9fafb",
                      border:`1px solid ${checked?"#3b82f6":"#e5e7eb"}`}}>
                    <div style={{width:20,height:20,borderRadius:5,flexShrink:0,
                      background:checked?"#3b82f6":"#fff",
                      border:`2px solid ${checked?"#3b82f6":"#d1d5db"}`,
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {checked && <span style={{color:"#fff",fontSize:12,fontWeight:700}}>✓</span>}
                    </div>
                    <span style={{fontSize:13,fontWeight:600,color:checked?"#1d4ed8":"#374151"}}>
                      {item.name}
                    </span>
                  </div>
                );
              }) : allUsers.map(item => {
                const id = Number(item.id);
                const checked = assigned.includes(id);
                const label = `${item.username}${item.full_name ? ' — ' + item.full_name : ''}`;
                return (
                  <div key={id} onClick={()=>toggle(id)}
                    style={{display:"flex",alignItems:"center",gap:12,
                      padding:"10px 14px",borderRadius:9,cursor:"pointer",
                      background:checked?"#eff6ff":"#f9fafb",
                      border:`1px solid ${checked?"#3b82f6":"#e5e7eb"}`}}>
                    <div style={{width:20,height:20,borderRadius:5,flexShrink:0,
                      background:checked?"#3b82f6":"#fff",
                      border:`2px solid ${checked?"#3b82f6":"#d1d5db"}`,
                      display:"flex",alignItems:"center",justifyContent:"center"}}>
                      {checked && <span style={{color:"#fff",fontSize:12,fontWeight:700}}>✓</span>}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:600,color:checked?"#1d4ed8":"#374151"}}>{label}</div>
                      <div style={{fontSize:11,color:"#9ca3af"}}>{item.role}</div>
                    </div>
                  </div>
                );
              })
              }
              {!modalLoading && (modal==="projects"?modalProjects:allUsers).length===0 && (
                <div style={{textAlign:"center",padding:"32px",color:"#9ca3af",fontSize:13}}>
                  No {modal==="projects"?"projects":"users"} found for this organisation
                </div>
              )}
            </div>
            {assigned.length===0 && modal==="projects" &&(
              <div style={{background:"#fffbeb",border:"1px solid #fcd34d",
                borderRadius:8,padding:"8px 12px",fontSize:12,color:"#92400e",marginBottom:12}}>
                ⚠ No projects assigned to this organisation
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:12,color:"#6b7280"}}>{assigned.length} selected</span>
              <div style={{display:"flex",gap:10}}>
                <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
                <button style={s.btn("primary")} onClick={saveAssigned} disabled={saving}>
                  {saving?"Saving...":"Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function UserMaster({ user: currentUser, projects }) {
  const [users,        setUsers]        = useState([]);
  const [allProjects,  setAllProjects]  = useState([]);
  const [allOrgs,      setAllOrgs]      = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [modal,        setModal]        = useState(null);
  const [selected,     setSelected]     = useState(null);
  const [saving,       setSaving]       = useState(false);
  const [form,         setForm]         = useState({});
  const [pwForm,       setPwForm]       = useState({ password:"", confirm:"" });
  const [pwError,      setPwError]      = useState("");
  const [search,       setSearch]       = useState("");
  const [roleFilter,   setRoleFilter]   = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assignedProjs,setAssignedProjs]= useState([]);
  const [assignedOrgs, setAssignedOrgs] = useState([]);
  const [selOrgId,     setSelOrgId]     = useState(null);  // selected org in combined modal
  const [orgProjects,  setOrgProjects]  = useState([]);    // projects belonging to selOrgId
  const [assignLoading, setAssignLoading] = useState(false);

  const isSuperAdmin = currentUser?.id===1 || currentUser?.uid===1 || currentUser?.role==="superadmin";
  // superadmin can assign any role; org-admin can only assign lead/tester/viewer
  const ROLES = isSuperAdmin
    ? ["admin","lead","tester","viewer"]
    : ["lead","tester","viewer"];
  const ROLE_COLORS = {
    superadmin: { bg:"#fef3c7", color:"#92400e" },
    admin:  { bg:"#fce7f3", color:"#be185d" },
    lead:   { bg:"#ede9fe", color:"#7c3aed" },
    tester: { bg:"#dbeafe", color:"#1d4ed8" },
    viewer: { bg:"#f0fdf4", color:"#15803d" },
  };
  const ROLE_LABELS = { superadmin:"SUPER ADMIN", admin:"ORG ADMIN", lead:"LEAD TESTER", tester:"SYSTEM TESTER", viewer:"VIEWER" };

  const load = async () => {
    if (currentUser?.role !== "admin" && currentUser?.role !== "superadmin" && currentUser?.id !== 1 && currentUser?.uid !== 1) return;
    setLoading(true);
    try {
      // Deferred loading: only load users on tab open
      // projects + orgs load lazily when Assign modal opens
      const u = await api("/api/users");
      setUsers(u);
    } catch(e) { alert(e.message); }
    setLoading(false);
  };

  // Lazy-load projects + orgs only when Assign modal is about to open
  const loadAdminData = async () => {
    if (allProjects.length > 0 && allOrgs.length > 0) return; // already loaded
    try {
      const [p, o] = await Promise.all([
        api("/api/projects"),
        api("/api/organisations"),
      ]);
      setAllProjects(p); setAllOrgs(o);
    } catch(e) { console.error(e); }
  };

  useEffect(() => { load(); }, []);

  const openAssign = async (u) => {
    // Load ALL data first, then open modal — no shiver from data loading after open
    setAssignLoading(true);
    let projs = allProjects;
    let orgs  = allOrgs;
    let currentOrgId = null;
    let resolvedOrgProjs = [];
    let resolvedProjIds = [];

    try {
      // 1. Load projects + orgs if not cached
      if (allProjects.length === 0 || allOrgs.length === 0) {
        const [p, o] = await Promise.all([
          api("/api/projects"),
          api("/api/organisations"),
        ]);
        setAllProjects(p); setAllOrgs(o);
        projs = p; orgs = o;
      }

      // 2. Load user's current org + project assignment
      const orgIds = await api(`/api/users/${u.id}/orgs`);
      if (orgIds?.length) {
        currentOrgId = orgIds[0];
        const [projIds, orgProjIds] = await Promise.all([
          api(`/api/users/${u.id}/projects`),
          api(`/api/organisations/${currentOrgId}/projects`).catch(()=>[])
        ]);
        resolvedOrgProjs = projs.filter(p => orgProjIds.includes(p.id));
        resolvedProjIds  = projIds || [];
      }
    } catch(e) { console.error(e); }

    // 3. Set all state at once, then open modal — single render, no shiver
    setSelected(u);
    setSelOrgId(currentOrgId);
    setAssignedOrgs(currentOrgId ? [currentOrgId] : []);
    setOrgProjects(resolvedOrgProjs);
    setAssignedProjs(resolvedProjIds);
    setAssignLoading(false);
    setModal("assign");
  };

  const selectOrg = async (orgId) => {
    setSelOrgId(orgId);
    setAssignedOrgs(orgId ? [orgId] : []);
    setAssignedProjs([]);
    if (!orgId) { setOrgProjects([]); return; }
    setOrgProjects(null); // null = loading
    try {
      const ids = await api(`/api/organisations/${orgId}/projects`);
      setOrgProjects(allProjects.filter(p=>ids.includes(p.id)));
    } catch { setOrgProjects([]); }
  };

  const saveAssign = async () => {
    if (!selOrgId) return alert("Please select an organisation first");
    setSaving(true);
    try {
      // 1-to-1: org first, then projects (only from that org)
      await api(`/api/users/${selected.id}/orgs`, { method:"PUT", body:{ org_ids:[selOrgId] } });
      await api(`/api/users/${selected.id}/projects`, { method:"PUT", body:{ project_ids: assignedProjs } });
      setModal(null); load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const toggleProject = (pid) => setAssignedProjs(prev => prev.includes(pid)?prev.filter(x=>x!==pid):[...prev,pid]);

  // Keep these for OrgMaster compatibility (not used in UserMaster anymore)
  const openProjects = async (u) => { openAssign(u); };
  const openOrgs     = async (u) => { openAssign(u); };

  const openCreate = () => {
    setForm({ username:"", full_name:"", email:"", role:"tester", password:"", confirm:"" });
    setPwError(""); setModal("create");
  };
  const openEdit = (u) => {
    setSelected(u);
    setForm({ full_name:u.full_name||"", email:u.email||"", role:u.role||"tester" });
    setModal("edit");
  };
  const openPassword = (u) => {
    setSelected(u); setPwForm({ password:"", confirm:"" }); setPwError(""); setModal("password");
  };

  const saveCreate = async () => {
    if (!form.username?.trim()) return alert("Username is required");
    setSaving(true);
    try {
      await api("/api/users", { method:"POST", body:{
        username: form.username.trim(),
        full_name: form.full_name||"", email: form.email||"", role: form.role||"tester",
      }});
      setModal(null); load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await api(`/api/users/${selected.id}`, { method:"PUT", body:{
        full_name: form.full_name||"", email: form.email||"",
        role: form.role, active: selected.active,
      }});
      setModal(null); load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const savePassword = async () => {
    if (!pwForm.password)               return setPwError("Password is required");
    if (pwForm.password.length < 8)     return setPwError("Minimum 8 characters with uppercase, number and special character");
    if (pwForm.password !== pwForm.confirm) return setPwError("Passwords do not match");
    setSaving(true);
    try { await api(`/api/users/${selected.id}/password`, { method:"PATCH", body:{ password: pwForm.password }}); setModal(null); setPwError(""); }
    catch(e) { setPwError(e.message); }
    setSaving(false);
  };

  const toggleActive = async (u) => {
    if (!confirm(`${u.active?"Disable":"Enable"} user "${u.username}"?`)) return;
    try { await api(`/api/users/${u.id}/active`, { method:"PATCH", body:{ active:!u.active }}); load(); }
    catch(e) { alert(e.message); }
  };

  const filtered = users.filter(u => {
    // Non-superadmin cannot see the superadmin account
    if (!isSuperAdmin && (u.role === "superadmin" || u.id === 1)) return false;
    if (search && !u.username?.toLowerCase().includes(search.toLowerCase()) &&
        !u.full_name?.toLowerCase().includes(search.toLowerCase()) &&
        !u.email?.toLowerCase().includes(search.toLowerCase())) return false;
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter !== "" && (statusFilter==="active" ? !u.active : u.active)) return false;
    return true;
  });

  const totalActive   = users.filter(u=>u.active).length;
  const totalInactive = users.filter(u=>!u.active).length;
  const navy = "#8B0000";

  const initials = (u) => (u.full_name||u.username||"U").charAt(0).toUpperCase();
  const avatarBg = (u) => `hsl(${(u.username.charCodeAt(0)*47)%360},55%,55%)`;

  const iconBtn = (onClick, title, icon, danger=false, active=true) => (
    <button onClick={onClick} title={title}
      style={{ width:32, height:32, border:"1px solid",
        borderColor: danger?"#fca5a5":"#e8eaf0",
        background: danger?"#fff7f7":"#fff",
        borderRadius:8, cursor:"pointer", fontSize:15,
        display:"flex", alignItems:"center", justifyContent:"center",
        transition:"all 0.12s", color: danger?"#dc2626":"#4b5563",
        opacity: active ? 1 : 0.4 }}
      onMouseEnter={e=>{ if(active){ e.currentTarget.style.background=danger?"#fee2e2":"#f3f4f6"; e.currentTarget.style.borderColor=danger?"#f87171":"#c7d2fe"; }}}
      onMouseLeave={e=>{ if(active){ e.currentTarget.style.background=danger?"#fff7f7":"#fff"; e.currentTarget.style.borderColor=danger?"#fca5a5":"#e8eaf0"; }}}>
      {icon}
    </button>
  );

  return (
    <div>
      {/* ── HEADER ──────────────────────────────────────────────────────── */}
      <div style={{display:"flex", justifyContent:"space-between",
        alignItems:"flex-start", marginBottom:24, gap:16, flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:28, fontWeight:900, color:navy, letterSpacing:"-0.03em"}}>
            User Master
          </div>
          <div style={{fontSize:13, color:"#6b7280", marginTop:5, maxWidth:420, lineHeight:1.6}}>
            Manage enterprise access and organisational mapping across the suite.
          </div>
        </div>
        {/* Stat cards */}
        <div style={{display:"flex", gap:12}}>
          {[
            {label:"TOTAL DIRECTORY", val:users.length,   color:navy},
            {label:"ACTIVE USERS",    val:totalActive,    color:"#16a34a"},
            {label:"DISABLED",        val:totalInactive,  color:"#dc2626"},
          ].map(stat=>(
            <div key={stat.label} style={{background:"#fff", borderRadius:12,
              border:"1px solid #e8eaf0", padding:"14px 24px", minWidth:130,
              boxShadow:"0 2px 8px rgba(0,0,0,0.06)"}}>
              <div style={{fontSize:9, fontWeight:700, color:"#9ca3af",
                letterSpacing:"0.14em", textTransform:"uppercase", marginBottom:6}}>
                {stat.label}
              </div>
              <div style={{fontSize:30, fontWeight:900, color:stat.color,
                fontFamily:"'IBM Plex Mono',monospace", lineHeight:1}}>
                {stat.val.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── SEARCH + FILTERS ─────────────────────────────────────────────── */}
      <div style={{display:"flex", gap:10, alignItems:"center", marginBottom:20,
        flexWrap:"wrap"}}>
        <div style={{position:"relative", flex:2, minWidth:220}}>
          <span style={{position:"absolute", left:11, top:"50%",
            transform:"translateY(-50%)", color:"#9ca3af", fontSize:14,
            pointerEvents:"none"}}>🔍</span>
          <input style={{...s.input, paddingLeft:34, margin:0, width:"100%"}}
            placeholder="Search by name, email, or username..."
            value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select style={{...s.input, margin:0, minWidth:130}}
          value={roleFilter} onChange={e=>setRoleFilter(e.target.value)}>
          <option value="">All Roles</option>
          {ROLES.map(r=><option key={r} value={r}>{r.charAt(0).toUpperCase()+r.slice(1)}</option>)}
        </select>
        <select style={{...s.input, margin:0, minWidth:130}}
          value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <button onClick={openCreate}
          style={{padding:"9px 22px", background:navy, border:"none",
            borderRadius:9, color:"#fff", fontSize:13, fontWeight:700,
            cursor:"pointer", display:"flex", alignItems:"center", gap:8,
            whiteSpace:"nowrap", boxShadow:"0 2px 8px rgba(13,20,37,0.25)"}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg>
          Create User
        </button>
      </div>

      {/* ── TABLE ────────────────────────────────────────────────────────── */}
      <div style={{background:"#fff", borderRadius:14, border:"1px solid #e8eaf0",
        boxShadow:"0 2px 8px rgba(0,0,0,0.05)", overflow:"hidden"}}>
        <table style={{width:"100%", borderCollapse:"collapse"}}>
          <thead>
            <tr style={{background:"#f8f9fc"}}>
              {["USER IDENTITY","CONTACT & USERNAME","ENTERPRISE ROLE","STATUS","ADMINISTRATIVE ACTIONS"].map(h=>(
                <th key={h} style={{padding:"12px 16px", textAlign:"left", fontSize:10,
                  fontWeight:700, color:"#6b7280", letterSpacing:"0.1em",
                  borderBottom:"2px solid #f0f2f5", background:"#f8f9fc"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} style={{padding:"48px", textAlign:"center", color:"#9ca3af"}}>
                Loading...</td></tr>
            ) : filtered.length===0 ? (
              <tr><td colSpan={5} style={{padding:"48px", textAlign:"center", color:"#9ca3af"}}>
                No users found</td></tr>
            ) : filtered.map((u,i)=>{
              const rc   = ROLE_COLORS[u.role]||{bg:"#f3f4f6", color:"#374151"};
              const isMe = u.id === currentUser?.id;
              const idx  = String(users.indexOf(u)+1).padStart(4,"0");
              return (
                <tr key={u.id}
                  style={{borderBottom:"1px solid #f9fafb",
                    background: !u.active?"#fafafa": isMe?"#fafbff":"#fff",
                    transition:"background 0.1s"}}
                  onMouseEnter={e=>e.currentTarget.style.background=!u.active?"#f5f5f5":isMe?"#f0f4ff":"#f9fafb"}
                  onMouseLeave={e=>e.currentTarget.style.background=!u.active?"#fafafa":isMe?"#fafbff":"#fff"}>

                  {/* USER IDENTITY */}
                  <td style={{padding:"14px 16px"}}>
                    <div style={{display:"flex", alignItems:"center", gap:12}}>
                      <div style={{width:42, height:42, borderRadius:"50%",
                        background: u.active ? avatarBg(u) : "#d1d5db",
                        display:"flex", alignItems:"center", justifyContent:"center",
                        fontSize:16, fontWeight:800, color:"#fff", flexShrink:0,
                        border:`2px solid ${u.active ? "rgba(255,255,255,0.3)" : "#e5e7eb"}`}}>
                        {initials(u)}
                      </div>
                      <div>
                        <div style={{fontSize:14, fontWeight:700, color: u.active?navy:"#9ca3af",
                          display:"flex", alignItems:"center", gap:6}}>
                          {u.full_name||u.username}
                          {isMe && <span style={{fontSize:9, background:"#dbeafe",
                            color:"#1d4ed8", padding:"1px 6px", borderRadius:6,
                            fontWeight:700, letterSpacing:"0.05em"}}>YOU</span>}
                        </div>
                        <div style={{fontSize:11, color:"#9ca3af", marginTop:2,
                          fontFamily:"monospace"}}>
                          ID: USR-{idx}-{initials(u)}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* CONTACT & USERNAME */}
                  <td style={{padding:"14px 16px"}}>
                    <div style={{fontSize:13, fontWeight:600, color:navy}}>
                      {u.username}
                    </div>
                    <div style={{fontSize:12, color:"#6b7280", marginTop:2}}>
                      {u.email||"—"}
                    </div>
                  </td>

                  {/* ENTERPRISE ROLE */}
                  <td style={{padding:"14px 16px"}}>
                    <span style={{padding:"4px 12px", borderRadius:5,
                      fontSize:11, fontWeight:700, letterSpacing:"0.06em",
                      background:rc.bg, color:rc.color}}>
                      {ROLE_LABELS[u.role]||u.role?.toUpperCase()}
                    </span>
                  </td>

                  {/* STATUS */}
                  <td style={{padding:"14px 16px"}}>
                    <div style={{display:"flex", alignItems:"center", gap:7}}>
                      <div style={{width:8, height:8, borderRadius:"50%", flexShrink:0,
                        background:u.active?"#22c55e":"#d1d5db",
                        boxShadow:u.active?"0 0 0 3px rgba(34,197,94,0.2)":"none"}}/>
                      <span style={{fontSize:13, color:u.active?"#15803d":"#9ca3af",
                        fontWeight:500}}>
                        {u.active?"Active":"Inactive"}
                      </span>
                    </div>
                  </td>

                  {/* ACTIONS */}
                  <td style={{padding:"14px 16px"}}>
                    <div style={{display:"flex", gap:5, alignItems:"center"}}>
                      {iconBtn(()=>openAssign(u), "Assign Organisation & Projects",
                        assignLoading && selected?.id === u.id
                          ? <span style={{fontSize:11}}>⏳</span>
                          : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>,
                        false, !(assignLoading && selected?.id === u.id)
                      )}
                      {iconBtn(()=>openPassword(u), "Change Password",
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="15" r="4"/><line x1="10.85" y1="12.15" x2="19" y2="4"/><line x1="18" y1="5" x2="20" y2="7"/><line x1="15" y1="8" x2="17" y2="6"/></svg>
                      )}
                      {iconBtn(()=>openEdit(u), "Edit User",
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                      )}
                      {!isMe && iconBtn(()=>toggleActive(u),
                        u.active?"Disable User":"Enable User",
                        u.active
                          ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>
                          : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>,
                        u.active, true
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── CREATE MODAL ─────────────────────────────────────────────────── */}
      {modal==="create" && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox, maxWidth:480}}>
            <div style={{display:"flex", justifyContent:"space-between",
              alignItems:"center", marginBottom:20}}>
              <div style={{fontSize:17, fontWeight:800, color:navy}}>👤 Create New User</div>
              <button onClick={()=>setModal(null)}
                style={{background:"none", border:"none", fontSize:22,
                  cursor:"pointer", color:"#9ca3af"}}>×</button>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:14}}>
              <div><label style={UM_LABEL}>Username <span style={{color:"#ef4444"}}>*</span></label>
                <input style={UM_INPUT} value={form.username||""} autoFocus maxLength={50}
                  onChange={e=>setForm(f=>({...f,username:e.target.value}))}
                  placeholder="e.g. john.doe (max 50 chars)" /></div>
              <div><label style={UM_LABEL}>Full Name</label>
                <input style={UM_INPUT} value={form.full_name||""} maxLength={100}
                  onChange={e=>setForm(f=>({...f,full_name:e.target.value}))}
                  placeholder="John Doe (max 100 chars)" /></div>
              <div><label style={UM_LABEL}>Email</label>
                <input style={UM_INPUT} type="email" value={form.email||""}
                  onChange={e=>setForm(f=>({...f,email:e.target.value}))}
                  placeholder="john@athma.org" /></div>
              <div><label style={UM_LABEL}>Role <span style={{color:"#ef4444"}}>*</span></label>
                <select style={UM_INPUT} value={form.role||"tester"}
                  onChange={e=>setForm(f=>({...f,role:e.target.value}))}>
                  {ROLES.map(r=><option key={r} value={r}>{r.charAt(0).toUpperCase()+r.slice(1)}</option>)}
                </select></div>
              <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8,
                padding:"10px 14px",fontSize:12,color:"#1d4ed8",lineHeight:1.7}}>
                🔑 Default password: <strong>Welcome@123</strong><br/>
                <span style={{color:"#6b7280"}}>User will be prompted to change it on first login.</span>
              </div>
            </div>
            <div style={{display:"flex", justifyContent:"flex-end", gap:10, marginTop:20}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={{...s.btn("primary"), background:navy, borderColor:navy}}
                onClick={saveCreate} disabled={saving}>
                {saving?"Creating...":"✓ Create User"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT MODAL ───────────────────────────────────────────────────── */}
      {modal==="edit" && selected && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox, maxWidth:440}}>
            <div style={{display:"flex", justifyContent:"space-between",
              alignItems:"center", marginBottom:16}}>
              <div>
                <div style={{fontSize:17, fontWeight:800, color:navy}}>✏️ Edit User</div>
                <div style={{fontSize:12, color:"#9ca3af", marginTop:2}}>
                  @{selected.username}
                </div>
              </div>
              <button onClick={()=>setModal(null)}
                style={{background:"none", border:"none", fontSize:22,
                  cursor:"pointer", color:"#9ca3af"}}>×</button>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:14}}>
              <div><label style={UM_LABEL}>Full Name</label>
                <input style={UM_INPUT} value={form.full_name||""} autoFocus
                  onChange={e=>setForm(f=>({...f,full_name:e.target.value}))} /></div>
              <div><label style={UM_LABEL}>Email</label>
                <input style={UM_INPUT} type="email" value={form.email||""}
                  onChange={e=>setForm(f=>({...f,email:e.target.value}))} /></div>
              <div><label style={UM_LABEL}>Role <span style={{color:"#ef4444"}}>*</span></label>
                <select style={UM_INPUT} value={form.role||"tester"}
                  onChange={e=>setForm(f=>({...f,role:e.target.value}))}>
                  {ROLES.map(r=><option key={r} value={r}>{r.charAt(0).toUpperCase()+r.slice(1)}</option>)}
                </select></div>
            </div>
            <div style={{display:"flex", justifyContent:"flex-end", gap:10, marginTop:20}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={{...s.btn("primary"), background:navy, borderColor:navy}}
                onClick={saveEdit} disabled={saving}>
                {saving?"Saving...":"✓ Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PASSWORD MODAL ───────────────────────────────────────────────── */}
      {modal==="password" && selected && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox, maxWidth:400}}>
            <div style={{display:"flex", justifyContent:"space-between",
              alignItems:"center", marginBottom:16}}>
              <div>
                <div style={{fontSize:17, fontWeight:800, color:navy}}>🔑 Change Password</div>
                <div style={{fontSize:12, color:"#9ca3af", marginTop:2}}>
                  @{selected.username}
                </div>
              </div>
              <button onClick={()=>setModal(null)}
                style={{background:"none", border:"none", fontSize:22,
                  cursor:"pointer", color:"#9ca3af"}}>×</button>
            </div>
            <div style={{display:"flex", flexDirection:"column", gap:14}}>
              <div>
                <label style={UM_LABEL}>New Password</label>
                <input style={UM_INPUT} type="password" autoFocus
                  value={pwForm.password}
                  onChange={e=>setPwForm(f=>({...f,password:e.target.value}))}
                  placeholder="Min 8 chars, 1 uppercase, 1 number, 1 special" />
                <div style={{background:"#f8fafc",border:"1px solid #e5e7eb",borderRadius:8,
                  padding:"10px 12px",marginTop:8,display:"flex",flexDirection:"column",gap:5}}>
                  {[
                    {ok:pwForm.password.length>=8,             label:"At least 8 characters"},
                    {ok:/[A-Z]/.test(pwForm.password),         label:"One uppercase letter"},
                    {ok:/[0-9]/.test(pwForm.password),         label:"One number"},
                    {ok:/[^A-Za-z0-9]/.test(pwForm.password),  label:"One special character"},
                  ].map(({ok,label})=>(
                    <div key={label} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,
                      color:ok?"#16a34a":"#6b7280",fontWeight:ok?600:400}}>
                      <div style={{width:16,height:16,borderRadius:"50%",flexShrink:0,
                        background:ok?"#dcfce7":"#f3f4f6",border:`1px solid ${ok?"#16a34a":"#d1d5db"}`,
                        display:"flex",alignItems:"center",justifyContent:"center",fontSize:10}}>
                        {ok?"✓":""}
                      </div>
                      {label}
                    </div>
                  ))}
                </div>
              </div>
              <div><label style={UM_LABEL}>Confirm Password</label>
                <input style={UM_INPUT} type="password"
                  value={pwForm.confirm}
                  onChange={e=>setPwForm(f=>({...f,confirm:e.target.value}))} /></div>
            </div>
            {pwError && (
              <div style={{background:"#fef2f2", color:"#dc2626", fontSize:12,
                borderRadius:7, padding:"8px 12px", marginTop:12}}>
                {pwError}
              </div>
            )}
            <div style={{display:"flex", justifyContent:"flex-end", gap:10, marginTop:20}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={{...s.btn("primary"), background:navy, borderColor:navy}}
                onClick={savePassword} disabled={saving}>
                {saving?"Saving...":"✓ Update Password"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── ASSIGN PROJECTS MODAL ────────────────────────────────────────── */}
      {/* ── ASSIGN ORG & PROJECTS MODAL ───────────────────────────────── */}
      {modal==="assign" && selected && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(null)}>
          <div style={{...s.modalBox, maxWidth:520, minHeight:460}}>
            {/* Header */}
            <div style={{display:"flex", justifyContent:"space-between",
              alignItems:"center", marginBottom:20}}>
              <div>
                <div style={{fontSize:17, fontWeight:800, color:navy}}>
                  Assign Organisation & Projects
                </div>
                <div style={{fontSize:12, color:"#9ca3af", marginTop:2}}>
                  @{selected.username} · Select org first, then projects from that org
                </div>
              </div>
              <button onClick={()=>setModal(null)}
                style={{background:"none", border:"none", fontSize:22,
                  cursor:"pointer", color:"#9ca3af"}}>×</button>
            </div>

            {/* Loading skeleton shown while orgs are being fetched */}
            {allOrgs.length === 0 ? (
              <div style={{display:"flex", flexDirection:"column", gap:10, minHeight:300, justifyContent:"center"}}>
                {[1,2,3].map(i => (
                  <div key={i} style={{
                    height:52, borderRadius:9, border:"1px solid #f0f0f0",
                    background:"linear-gradient(90deg, #f3f4f6 25%, #e9eaeb 50%, #f3f4f6 75%)",
                    backgroundSize:"200% 100%",
                    animation:"shimmer 1.2s infinite"
                  }} />
                ))}
                <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
              </div>
            ) : (
              <>
            {/* Step 1: Organisation */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11, fontWeight:700, color:"#374151",
                textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8,
                display:"flex", alignItems:"center", gap:6}}>
                <span style={{width:18, height:18, borderRadius:"50%",
                  background:"#1a56db", color:"#fff", fontSize:10, fontWeight:700,
                  display:"inline-flex", alignItems:"center", justifyContent:"center"}}>1</span>
                Select Organisation
              </div>
              <div style={{display:"flex", flexDirection:"column", gap:6,
                maxHeight:180, overflowY:"auto"}}>
                {allOrgs.filter(o=>o.active).map(o=>{
                  const checked = selOrgId===o.id;
                  return (
                    <div key={o.id} onClick={()=>selectOrg(o.id)}
                      style={{display:"flex", alignItems:"center", gap:12,
                        padding:"10px 14px", borderRadius:9, cursor:"pointer",
                        background:checked?"#eff6ff":"#f9fafb",
                        border:`1.5px solid ${checked?"#1a56db":"#e5e7eb"}`,
                        transition:"all 0.12s"}}>
                      {/* Radio */}
                      <div style={{width:18, height:18, borderRadius:"50%", flexShrink:0,
                        border:`2px solid ${checked?"#1a56db":"#d1d5db"}`,
                        background:"#fff", display:"flex", alignItems:"center",
                        justifyContent:"center"}}>
                        {checked && <div style={{width:8, height:8, borderRadius:"50%",
                          background:"#1a56db"}}/>}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13, fontWeight:600,
                          color:checked?"#1a56db":"#374151"}}>{o.name}</div>
                        {o.description && (
                          <div style={{fontSize:11, color:"#9ca3af", marginTop:1}}>
                            {o.description}
                          </div>
                        )}
                      </div>
                      <span style={{fontSize:10, color:"#9ca3af",
                        background:"#f3f4f6", padding:"2px 8px", borderRadius:10}}>
                        {o.project_count||0} projects
                      </span>
                    </div>
                  );
                })}
                {!allOrgs.filter(o=>o.active).length && (
                  <div style={{padding:"16px", textAlign:"center", color:"#9ca3af",
                    fontSize:13}}>No active organisations</div>
                )}
              </div>
            </div>

            {/* Step 2: Projects */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11, fontWeight:700, color:"#374151",
                textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:8,
                display:"flex", alignItems:"center", gap:6}}>
                <span style={{width:18, height:18, borderRadius:"50%",
                  background: selOrgId?"#1a56db":"#d1d5db",
                  color:"#fff", fontSize:10, fontWeight:700,
                  display:"inline-flex", alignItems:"center", justifyContent:"center"}}>2</span>
                Select Projects
                {selOrgId && (
                  <span style={{fontSize:10, color:"#9ca3af", fontWeight:400,
                    textTransform:"none", letterSpacing:0}}>
                    — from {allOrgs.find(o=>o.id===selOrgId)?.name}
                  </span>
                )}
              </div>
              {/* Fixed min-height prevents layout jump when projects load */}
              <div style={{minHeight:80}}>
              {!selOrgId ? (
                <div style={{padding:"20px", textAlign:"center", color:"#9ca3af",
                  fontSize:13, background:"#f9fafb", borderRadius:9,
                  border:"1px dashed #e5e7eb"}}>
                  Select an organisation above to see its projects
                </div>
              ) : orgProjects === null ? (
                <div style={{display:"flex", flexDirection:"column", gap:8}}>
                  {[1,2].map(i=>(
                    <div key={i} style={{
                      height:40, borderRadius:9, border:"1px solid #f0f0f0",
                      background:"linear-gradient(90deg, #f3f4f6 25%, #e9eaeb 50%, #f3f4f6 75%)",
                      backgroundSize:"200% 100%", animation:"shimmer 1.2s infinite"
                    }}/>
                  ))}
                </div>
              ) : orgProjects.length===0 ? (
                <div style={{padding:"16px", textAlign:"center", color:"#9ca3af",
                  fontSize:13, background:"#f9fafb", borderRadius:9}}>
                  No projects assigned to this organisation yet
                </div>
              ) : (
                <div style={{display:"flex", flexDirection:"column", gap:6,
                  maxHeight:200, overflowY:"auto"}}>
                  <div style={{display:"flex", justifyContent:"space-between",
                    marginBottom:4}}>
                    <span style={{fontSize:11, color:"#9ca3af"}}>
                      {assignedProjs.length} of {orgProjects.length} selected
                    </span>
                    <div style={{display:"flex", gap:8}}>
                      <button onClick={()=>setAssignedProjs(orgProjects.map(p=>p.id))}
                        style={{fontSize:11, color:"#1a56db", background:"none",
                          border:"none", cursor:"pointer", padding:0}}>All</button>
                      <button onClick={()=>setAssignedProjs([])}
                        style={{fontSize:11, color:"#6b7280", background:"none",
                          border:"none", cursor:"pointer", padding:0}}>None</button>
                    </div>
                  </div>
                  {orgProjects.map(p=>{
                    const checked = assignedProjs.includes(p.id);
                    return (
                      <div key={p.id} onClick={()=>toggleProject(p.id)}
                        style={{display:"flex", alignItems:"center", gap:12,
                          padding:"9px 14px", borderRadius:9, cursor:"pointer",
                          background:checked?"#eff6ff":"#f9fafb",
                          border:`1.5px solid ${checked?"#1a56db":"#e5e7eb"}`,
                          transition:"all 0.12s"}}>
                        <div style={{width:18, height:18, borderRadius:4, flexShrink:0,
                          background:checked?"#1a56db":"#fff",
                          border:`2px solid ${checked?"#1a56db":"#d1d5db"}`,
                          display:"flex", alignItems:"center", justifyContent:"center"}}>
                          {checked && <span style={{color:"#fff", fontSize:11,
                            fontWeight:700, lineHeight:1}}>✓</span>}
                        </div>
                        <span style={{fontSize:13, fontWeight:600,
                          color:checked?"#1a56db":"#374151"}}>{p.name}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </div>

            {/* Validation hint */}
            {!selOrgId && (
              <div style={{background:"#fff7ed", border:"1px solid #fed7aa",
                borderRadius:8, padding:"8px 14px", marginBottom:12,
                fontSize:12, color:"#c2410c"}}>
                ⚠️ An organisation must be selected before saving
              </div>
            )}

            <div style={{display:"flex", justifyContent:"flex-end", gap:10}}>
              <button style={s.btn("ghost")} onClick={()=>setModal(null)}>Cancel</button>
              <button style={{...s.btn("primary"), background:navy, borderColor:navy,
                opacity: selOrgId?1:0.5, cursor:selOrgId?"pointer":"not-allowed"}}
                onClick={saveAssign} disabled={saving||!selOrgId}>
                {saving?"Saving...":"✓ Save Assignment"}
              </button>
            </div>
            </>
            )}
          </div>
        </div>
      )}

          </div>
  );
}


function ChangePasswordModal({ user: currentUser, onClose, forcedChange=false, onChanged }) {
  const [form,  setForm]  = useState({ current:"", password:"", confirm:"" });
  const [error, setError] = useState("");
  const [ok,    setOk]    = useState(false);
  const [saving,setSaving]= useState(false);

  const save = async () => {
    if (!form.current)                        return setError("Enter your current password");
    if (!form.password)                       return setError("Enter a new password");
    if (form.password.length < 8)             return setError("Minimum 8 characters");
    if (form.password !== form.confirm)       return setError("Passwords do not match");
    if (form.password === form.current)       return setError("New password must be different from the default");
    setSaving(true); setError("");
    try {
      await api(`/api/users/${currentUser.id}/password`, {
        method:"PATCH",
        body:{ password:form.password, current_password:form.current }
      });
      setOk(true);
      setTimeout(() => { onChanged ? onChanged() : onClose(); }, 1500);
    } catch(e) { setError(e.message); }
    setSaving(false);
  };

  return (
    <div style={s.modal} onClick={e=>{ if(e.target===e.currentTarget && !forcedChange) onClose(); }}>
      <div style={{...s.modalBox,maxWidth:380}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div>
            <div style={{fontSize:17,fontWeight:800,color:"#1a2332"}}>🔑 Change Password</div>
            {forcedChange && (
              <div style={{fontSize:12,color:"#d97706",marginTop:4,background:"#fef3c7",
                padding:"4px 10px",borderRadius:6,border:"1px solid #fde68a"}}>
                ⚠ You must set a new password before continuing
              </div>
            )}
          </div>
          {!forcedChange && (
            <button onClick={onClose}
              style={{background:"none",border:"none",fontSize:22,cursor:"pointer",color:"#8a96a8"}}>×</button>
          )}
        </div>
        {forcedChange && !ok && (
          <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:8,
            padding:"10px 14px",fontSize:12,color:"#1d4ed8",marginBottom:16,lineHeight:1.6}}>
            Your account was created with a default password <strong>Welcome@123</strong>.<br/>
            Please set a new personal password to continue.
          </div>
        )}
        {ok ? (
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:40,marginBottom:12}}>✅</div>
            <div style={{fontSize:15,fontWeight:700,color:"#15803d"}}>Password changed successfully!</div>
            <div style={{fontSize:13,color:"#6b7280",marginTop:6}}>Redirecting...</div>
          </div>
        ) : (
          <>
            <div style={{marginBottom:16}}>
              <label style={s.label}>Current Password <span style={{color:"#ef4444"}}>*</span></label>
              <input style={s.input} type="password" value={form.current}
                onChange={e=>setForm(f=>({...f,current:e.target.value}))}
                placeholder={forcedChange?"Enter: Welcome@123":"Your current password"} />
            </div>
            <div style={{marginBottom:16}}>
              <label style={s.label}>New Password <span style={{color:"#ef4444"}}>*</span></label>
              <input style={s.input} type="password" value={form.password}
                onChange={e=>setForm(f=>({...f,password:e.target.value}))}
                placeholder="Min 8 chars, 1 uppercase, 1 number, 1 special" />
              <div style={{background:"#f8fafc",border:"1px solid #e5e7eb",borderRadius:8,
                padding:"10px 12px",marginTop:8,display:"flex",flexDirection:"column",gap:5}}>
                {[
                  {ok:form.password.length>=8,            label:"At least 8 characters"},
                  {ok:/[A-Z]/.test(form.password),        label:"One uppercase letter"},
                  {ok:/[0-9]/.test(form.password),        label:"One number"},
                  {ok:/[^A-Za-z0-9]/.test(form.password), label:"One special character"},
                ].map(({ok,label})=>(
                  <div key={label} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,
                    color:ok?"#16a34a":"#6b7280",fontWeight:ok?600:400}}>
                    <div style={{width:16,height:16,borderRadius:"50%",flexShrink:0,
                      background:ok?"#dcfce7":"#f3f4f6",border:`1px solid ${ok?"#16a34a":"#d1d5db"}`,
                      display:"flex",alignItems:"center",justifyContent:"center",fontSize:10}}>
                      {ok?"✓":""}
                    </div>
                    {label}
                  </div>
                ))}
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <label style={s.label}>Confirm New Password <span style={{color:"#ef4444"}}>*</span></label>
              <input style={s.input} type="password" value={form.confirm}
                onChange={e=>setForm(f=>({...f,confirm:e.target.value}))}
                placeholder="Repeat new password" />
            </div>
            {error && (
              <div style={{background:"#fff5f5",border:"1px solid #feb2b2",borderRadius:8,
                padding:"8px 12px",fontSize:13,color:"#e53935",marginBottom:12}}>⚠ {error}</div>
            )}
            <div style={{display:"flex",justifyContent:"flex-end",gap:10}}>
              {!forcedChange && <button style={s.btn("ghost")} onClick={onClose}>Cancel</button>}
              <button style={s.btn("primary")} onClick={save} disabled={saving}>
                {saving?"Saving...":"🔑 Change Password"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── ACCESS REQUESTS ADMIN SCREEN ────────────────────────────────────────────
function AccessRequests() {
  const [requests, setRequests]   = useState([]);
  const [loading,  setLoading]    = useState(false);
  const [search,   setSearch]     = useState("");
  const [status,   setStatus]     = useState("");
  const [fromDate, setFromDate]   = useState("");
  const [toDate,   setToDate]     = useState("");
  const [editing,  setEditing]    = useState(null); // { id, status, notes }
  const [saving,   setSaving]     = useState(false);
  const [editErr,  setEditErr]    = useState("");

  const statusColors = {
    pending:    { bg:"#fef9c3", color:"#854d0e", border:"#fde047" },
    inprogress: { bg:"#dbeafe", color:"#1d4ed8", border:"#93c5fd" },
    done:       { bg:"#dcfce7", color:"#166534", border:"#86efac" },
    cancelled:  { bg:"#fee2e2", color:"#991b1b", border:"#fca5a5" },
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status)   params.set("status",    status);
      if (search)   params.set("search",    search);
      if (fromDate) params.set("from_date", fromDate);
      if (toDate)   params.set("to_date",   toDate);
      const r = await api(`/api/access-requests?${params}`);
      setRequests(Array.isArray(r) ? r : []);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openEdit = (req) => {
    setEditing({ id: req.id, status: req.status, notes: req.notes || "" });
    setEditErr("");
  };

  const saveEdit = async () => {
    setSaving(true); setEditErr("");
    try {
      await api(`/api/access-requests/${editing.id}`, {
        method: "PUT", body: { status: editing.status, notes: editing.notes }
      });
      setEditing(null);
      load();
    } catch(e) { setEditErr(e.message); }
    finally { setSaving(false); }
  };

  const quickStatus = async (id, newStatus) => {
    try {
      await api(`/api/access-requests/${id}`, { method:"PUT", body:{ status: newStatus } });
      load();
    } catch(e) { alert(e.message); }
  };

  const statCounts = requests.reduce((acc, r) => {
    acc[r.status] = (acc[r.status]||0) + 1; return acc;
  }, {});

  return (
    <div style={s.col}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
        <div>
          <div style={{ fontSize:20, fontWeight:800, color:"#8B0000" }}>📋 Access Requests</div>
          <div style={{ fontSize:13, color:"#8a96a8", marginTop:2 }}>
            Manage incoming access requests from new organisations
          </div>
        </div>
        <button onClick={load} style={{ ...s.btn("ghost",true), fontSize:12 }}>🔄 Refresh</button>
      </div>

      {/* Stat cards */}
      <div style={{ display:"flex", gap:10, marginBottom:4 }}>
        {[
          { label:"Total",       value: requests.length,           color:"#1a6fc4", bg:"#eff6ff" },
          { label:"Pending",     value: statCounts.pending||0,     color:"#854d0e", bg:"#fef9c3" },
          { label:"In Progress", value: statCounts.inprogress||0,  color:"#1d4ed8", bg:"#dbeafe" },
          { label:"Done",        value: statCounts.done||0,        color:"#166534", bg:"#dcfce7" },
          { label:"Cancelled",   value: statCounts.cancelled||0,   color:"#991b1b", bg:"#fee2e2" },
        ].map(c => (
          <div key={c.label} style={{ flex:1, background:c.bg, borderRadius:10,
            padding:"12px 16px", border:`1px solid ${c.color}30` }}>
            <div style={{ fontSize:22, fontWeight:800, color:c.color }}>{c.value}</div>
            <div style={{ fontSize:11, color:c.color, fontWeight:600, marginTop:2 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ ...s.card, padding:"14px 16px" }}>
        <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr auto", gap:10, alignItems:"end" }}>
          <div>
            <label style={s.label}>Search</label>
            <input style={s.input} placeholder="Org name, admin name, email..."
              value={search} onChange={e=>setSearch(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&load()} />
          </div>
          <div>
            <label style={s.label}>Status</label>
            <select style={s.input} value={status} onChange={e=>setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="inprogress">In Progress</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label style={s.label}>From Date</label>
            <input style={s.input} type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} />
          </div>
          <div>
            <label style={s.label}>To Date</label>
            <input style={s.input} type="date" value={toDate} onChange={e=>setToDate(e.target.value)} />
          </div>
          <div style={{ display:"flex", gap:8, paddingBottom:1 }}>
            <button onClick={load} style={s.btn("primary")}>Search</button>
            <button onClick={()=>{ setSearch(""); setStatus(""); setFromDate(""); setToDate(""); setTimeout(load,0); }}
              style={s.btn("ghost")}>Clear</button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={{ ...s.card, padding:0, overflow:"hidden" }}>
        {loading ? (
          <div style={{ textAlign:"center", padding:40, color:"#8a96a8" }}>Loading...</div>
        ) : requests.length === 0 ? (
          <div style={{ textAlign:"center", padding:40, color:"#8a96a8" }}>
            <div style={{ fontSize:32, marginBottom:8 }}>📭</div>
            <div style={{ fontWeight:600 }}>No requests found</div>
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>{["#","Organisation","Admin / Email / Contact","Project","Submitted","Status","Actions"].map(h=>(
                <th key={h} style={s.th}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const sc = statusColors[r.status] || statusColors.pending;
                return (
                  <tr key={r.id}>
                    <td style={{ ...s.td, fontSize:12, color:"#9ca3af", width:40 }}>#{r.id}</td>
                    <td style={s.td}>
                      <div style={{ fontWeight:700, color:"#1a2332" }}>{r.org_name}</div>
                      {r.description && (
                        <div style={{ fontSize:11, color:"#6b7280", marginTop:2,
                          maxWidth:200, overflow:"hidden", textOverflow:"ellipsis",
                          whiteSpace:"nowrap" }}>{r.description}</div>
                      )}
                    </td>
                    <td style={s.td}>
                      <div style={{ fontWeight:600, fontSize:13, color:"#1a2332" }}>{r.admin_name}</div>
                      <div style={{ fontSize:11, color:"#1a6fc4" }}>{r.email}</div>
                      <div style={{ fontSize:11, color:"#6b7280" }}>{r.contact}</div>
                    </td>
                    <td style={{ ...s.td, fontSize:13, color:"#4a5568" }}>{r.project_name}</td>
                    <td style={{ ...s.td, fontSize:11, color:"#8a96a8" }}>
                      {new Date(r.created_at).toLocaleDateString()}<br/>
                      <span style={{ fontSize:10 }}>{new Date(r.created_at).toLocaleTimeString()}</span>
                    </td>
                    <td style={s.td}>
                      <span style={{ background:sc.bg, color:sc.color, border:`1px solid ${sc.border}`,
                        padding:"3px 10px", borderRadius:20, fontSize:11, fontWeight:700,
                        textTransform:"capitalize", whiteSpace:"nowrap" }}>
                        {r.status === "inprogress" ? "In Progress" : r.status.charAt(0).toUpperCase()+r.status.slice(1)}
                      </span>
                      {r.notes && (
                        <div style={{ fontSize:10, color:"#6b7280", marginTop:3,
                          maxWidth:120, overflow:"hidden", textOverflow:"ellipsis",
                          whiteSpace:"nowrap" }} title={r.notes}>📝 {r.notes}</div>
                      )}
                    </td>
                    <td style={s.td}>
                      <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
                        <button onClick={()=>openEdit(r)}
                          style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                            cursor:"pointer", border:"1px solid #e0e7ff",
                            background:"#eef2ff", color:"#4338ca" }}>
                          Edit
                        </button>
                        {r.status === "pending" && (
                          <button onClick={()=>quickStatus(r.id,"inprogress")}
                            style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                              cursor:"pointer", border:"1px solid #bfdbfe",
                              background:"#eff6ff", color:"#1d4ed8" }}>
                            Start
                          </button>
                        )}
                        {["pending","inprogress"].includes(r.status) && (
                          <button onClick={()=>quickStatus(r.id,"done")}
                            style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                              cursor:"pointer", border:"1px solid #bbf7d0",
                              background:"#f0fdf4", color:"#15803d" }}>
                            Done
                          </button>
                        )}
                        {r.status !== "cancelled" && (
                          <button onClick={()=>{ if(confirm("Cancel this request?")) quickStatus(r.id,"cancelled"); }}
                            style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                              cursor:"pointer", border:"1px solid #fecaca",
                              background:"#fff5f5", color:"#dc2626" }}>
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)",
          display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}>
          <div style={{ background:"#fff", borderRadius:12, padding:"24px 28px",
            width:"100%", maxWidth:440, boxShadow:"0 16px 48px rgba(0,0,0,0.18)" }}>
            <div style={{ fontSize:17, fontWeight:800, color:"#1a2332", marginBottom:20 }}>
              Edit Request #{editing.id}
            </div>
            {editErr && (
              <div style={{ background:"#fff5f5", border:"1px solid #fecaca",
                borderRadius:8, padding:"9px 13px", marginBottom:14,
                fontSize:12, color:"#dc2626" }}>⚠️ {editErr}</div>
            )}
            <div style={{ marginBottom:14 }}>
              <label style={s.label}>Status</label>
              <select style={s.input} value={editing.status}
                onChange={e=>setEditing(ed=>({...ed, status:e.target.value}))}>
                <option value="pending">Pending</option>
                <option value="inprogress">In Progress</option>
                <option value="done">Done</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={s.label}>Notes (optional)</label>
              <textarea style={{ ...s.input, minHeight:80, resize:"vertical", fontFamily:"inherit" }}
                placeholder="Add any notes or comments..."
                value={editing.notes}
                onChange={e=>setEditing(ed=>({...ed, notes:e.target.value}))} />
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button style={s.btn("ghost")} onClick={()=>setEditing(null)}>Cancel</button>
              <button style={s.btn("primary")} onClick={saveEdit} disabled={saving}>
                {saving ? "Saving..." : "💾 Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { ModuleSelector, ModuleMaster, QueryBuilder, QueryPreview,
         OrgMaster, UserMaster, ChangePasswordModal, AccessRequests };
