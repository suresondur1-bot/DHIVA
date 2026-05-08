import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api, s, APP_PAGE_SIZE, getAppPageSize, setAppPageSize, C, Badge, Empty, Pagination, Spinner, getToken, getUser, API, WS, priorityColor, statusColor, statusBg, smartSel } from "./shared.jsx";
import { ACTIONS, ACTION_GROUPS,VAR_TYPES,
         StepEditor, ScriptEditor,VariablesPanel,
         stepsToScript, stepsToCode, codeToSteps, normalizeScriptQuotes,
         scriptToSteps, DbQueryForm, DbValidateStepForm } from "./Editors.jsx";
import { ModuleSelector } from "./Admin.jsx";
// API Testing - Enhanced Version
import { ApiEditor } from "./api-testing/ApiEditor.jsx";
import { API_ASSERTIONS } from "./api-testing/constants.js";

function Login({ onLogin }) {
  const [form,     setForm]   = useState({ username: "", password: "" });
  const [err,      setErr]    = useState("");
  const [loading,  setL]      = useState(false);
  const [orgs,     setOrgs]   = useState(null);
  const [userId,   setUserId] = useState(null);
  const [selOrg,   setSelOrg] = useState("");
  const [showPass, setShowPass] = useState(false);

  // ── Request Access ──────────────────────────────────────────────────────
  const [showReq,  setShowReq] = useState(false);
  const [reqForm,  setReqForm] = useState({ org_name:"", description:"", admin_name:"", email:"", contact:"", project_name:"" });
  const [reqErr,   setReqErr]  = useState("");
  const [reqOk,    setReqOk]   = useState(false);
  const [reqLoad,  setReqLoad] = useState(false);

  const submitRequest = async () => {
    setReqErr("");
    const { org_name, admin_name, email, contact, project_name } = reqForm;
    if (!org_name.trim())     return setReqErr("Organisation name is required.");
    if (!admin_name.trim())   return setReqErr("Admin user name is required.");
    if (!email.trim())        return setReqErr("Official email is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setReqErr("Please enter a valid email address.");
    if (!contact.trim())      return setReqErr("Contact number is required.");
    if (!project_name.trim()) return setReqErr("Project name is required.");
    setReqLoad(true);
    try {
      await api("/api/access-requests", { method:"POST", body: reqForm });
      setReqOk(true);
      setTimeout(() => {
        setShowReq(false); setReqOk(false);
        setReqForm({ org_name:"", description:"", admin_name:"", email:"", contact:"", project_name:"" });
      }, 2500);
    } catch(e) { setReqErr(e.message); }
    finally { setReqLoad(false); }
  };

  const closeReq = () => {
    setShowReq(false); setReqErr(""); setReqOk(false);
    setReqForm({ org_name:"", description:"", admin_name:"", email:"", contact:"", project_name:"" });
  };

  const submit = async () => {
    setL(true); setErr("");
    try {
      const d = await api("/api/auth/login", { method:"POST", body:form });
      if (d.needs_org) {
        setOrgs(d.orgs); setUserId(d.user_id);
        setSelOrg(d.orgs.length===1 ? String(d.orgs[0].id) : "");
      } else {
        localStorage.setItem("autoqa_token", d.token);
        localStorage.setItem("autoqa_user", JSON.stringify(d.user));
        if (d.page_size) { setAppPageSize(d.page_size); }
        onLogin(d.user);
      }
    } catch(e) { setErr(e.message); }
    finally { setL(false); }
  };

  const selectOrg = async () => {
    if (!selOrg) return setErr("Please select an organisation");
    setL(true); setErr("");
    try {
      const d = await api("/api/auth/select-org", { method:"POST", body:{ user_id:userId, org_id:+selOrg } });
      localStorage.setItem("autoqa_token", d.token);
      localStorage.setItem("autoqa_user", JSON.stringify(d.user));
      if (d.page_size) { setAppPageSize(d.page_size); }
      onLogin(d.user);
    } catch(e) { setErr(e.message); }
    finally { setL(false); }
  };

  const features = [
    { icon:"\uD83D\uDD34", title:"Record & Run UI Tests",     desc:"Visual interaction capture" },
    { icon:"\uD83D\uDCE1", title:"Live Execution Logs",        desc:"Real-time streaming" },
    { icon:"\uD83D\uDDC4\uFE0F", title:"DB Data Validation",        desc:"Integrity checks" },
    { icon:"\u23F0", title:"Scheduled Test Runs",        desc:"Precision orchestration" },
    { icon:"\uD83E\uDD16", title:"AI Script Generator",        desc:"LLM-powered scripts" },
    { icon:"\uD83D\uDD27", title:"AI Self-Healing",            desc:"Dynamic re-targeting" },
    { icon:"\uD83C\uDF10", title:"Multi-browser Support",      desc:"Chrome, Firefox, Edge" },
    { icon:"\uD83D\uDCCA", title:"Analytics & Reports",        desc:"Katalon-style reports" },
  ];

  const blue  = "#1a6fc4";
  const light = "#e8f1fb";
  const navy  = blue;  // alias for Request Access modal

  return (
    <div style={{ height:"100vh", display:"flex", fontFamily:"'Segoe UI',system-ui,Arial,sans-serif",
      overflow:"hidden", background:"#f5f8ff" }}>

      {/* ── Left panel — light blue gradient ── */}
      <div style={{ width:"52%", background:"linear-gradient(145deg,#fff5f0 0%,#fdf0e8 50%,#fff8f0 100%)",
        display:"flex", flexDirection:"column", height:"100%",
        boxSizing:"border-box", padding:"32px 40px 28px",
        borderRight:"1px solid #f5c5a3" }}>

        {/* Logo */}
        <div style={{ flexShrink:0, marginBottom:28 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:36, height:36, background:"linear-gradient(135deg,#8B0000,#cc5500)", borderRadius:10,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:16, fontWeight:900, color:"#fff", boxShadow:"0 4px 12px rgba(139,0,0,0.3)" }}>D</div>
            <div>
              <div style={{ fontSize:20, fontWeight:900, color:"#8B0000", letterSpacing:"0.04em" }}>daiva health</div>
              <div style={{ fontSize:8, color:"#cc5500", letterSpacing:"0.18em",
                textTransform:"uppercase" }}>AI-POWERED TEST AUTOMATION</div>
            </div>
          </div>
        </div>

        {/* Headline */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:26, fontWeight:800, color:"#1e3a5f", lineHeight:1.25, marginBottom:8 }}>
            Accelerate Your<br/>
            <span style={{ color:blue }}>Engineering Velocity.</span>
          </div>
          <div style={{ fontSize:12, color:"#4b7fc4", lineHeight:1.7, maxWidth:320 }}>
            End-to-end test automation for healthcare systems — record, run, schedule and heal your tests with AI.
          </div>
        </div>

        {/* Feature grid */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, flex:1, minHeight:0 }}>
          {features.map(f => (
            <div key={f.title} style={{ background:"rgba(255,255,255,0.7)",
              border:"1px solid rgba(26,111,196,0.15)", borderRadius:10,
              padding:"12px 14px", display:"flex", alignItems:"flex-start",
              gap:10, overflow:"hidden", backdropFilter:"blur(4px)" }}>
              <span style={{ fontSize:18, flexShrink:0, marginTop:1 }}>{f.icon}</span>
              <div>
                <div style={{ fontSize:11, fontWeight:700, color:"#1e3a5f",
                  marginBottom:2, lineHeight:1.3 }}>{f.title}</div>
                <div style={{ fontSize:10, color:"#64a0d4", lineHeight:1.5 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ flexShrink:0, marginTop:20, paddingTop:16,
          borderTop:"1px solid rgba(139,0,0,0.15)" }}>
          <div style={{ fontSize:9, color:"#cc5500", letterSpacing:"0.14em",
            textTransform:"uppercase" }}>DAIVA HEALTH © 2025 — AI-POWERED TESTING</div>
        </div>
      </div>

      {/* ── Right panel — pure white ── */}
      <div style={{ flex:1, display:"flex", flexDirection:"column",
        height:"100%", boxSizing:"border-box", background:"#fff" }}>

        {/* Top accent line */}
        <div style={{ height:4, background:`linear-gradient(90deg,${blue},#60a5fa)`, flexShrink:0 }} />

        <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center",
          padding:"0 48px", minHeight:0 }}>
          <div style={{ width:"100%", maxWidth:340 }}>

            <div style={{ marginBottom:28 }}>
              <div style={{ fontSize:26, fontWeight:800, color:"#1e3a5f",
                marginBottom:6, letterSpacing:"-0.01em" }}>Welcome Back {"\uD83D\uDC4B"}</div>
              <div style={{ fontSize:12, color:"#94a3b8", lineHeight:1.6 }}>
                Sign in to your ATHMA workspace
              </div>
            </div>

            {err && (
              <div style={{ background:"#fff5f5", color:"#dc2626", border:"1px solid #fecaca",
                padding:"10px 14px", borderRadius:8, marginBottom:16, fontSize:12,
                display:"flex", gap:8, alignItems:"center" }}>
                <span>{"\u26A0\uFE0F"}</span><span>{err}</span>
              </div>
            )}

            {/* USERNAME */}
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:10, fontWeight:700, color:"#94a3b8",
                letterSpacing:"0.12em", textTransform:"uppercase",
                display:"block", marginBottom:6 }}>Username</label>
              <input
                style={{ width:"100%", padding:"12px 14px", fontSize:13,
                  border:"1.5px solid #e2e8f0", borderRadius:9, outline:"none",
                  background:"#f8fafc", color:"#1e3a5f", boxSizing:"border-box",
                  transition:"all 0.2s" }}
                value={form.username}
                onChange={e=>setForm(f=>({...f,username:e.target.value}))}
                onKeyDown={e=>e.key==="Enter"&&submit()}
                onFocus={e=>{ e.target.style.borderColor=blue; e.target.style.background="#fff"; e.target.style.boxShadow="0 0 0 3px rgba(26,111,196,0.1)"; }}
                onBlur={e=>{ e.target.style.borderColor="#e2e8f0"; e.target.style.background="#f8fafc"; e.target.style.boxShadow="none"; }}
                placeholder="Enter your username" />
            </div>

            {/* PASSWORD */}
            <div style={{ marginBottom:24 }}>
              <label style={{ fontSize:10, fontWeight:700, color:"#94a3b8",
                letterSpacing:"0.12em", textTransform:"uppercase",
                display:"block", marginBottom:6 }}>Password</label>
              <div style={{ position:"relative" }}>
                <input
                  style={{ width:"100%", padding:"12px 42px 12px 14px", fontSize:13,
                    border:"1.5px solid #e2e8f0", borderRadius:9, outline:"none",
                    background:"#f8fafc", color:"#1e3a5f", boxSizing:"border-box",
                    transition:"all 0.2s" }}
                  type={showPass?"text":"password"}
                  value={form.password}
                  onChange={e=>setForm(f=>({...f,password:e.target.value}))}
                  onKeyDown={e=>e.key==="Enter"&&submit()}
                  onFocus={e=>{ e.target.style.borderColor=blue; e.target.style.background="#fff"; e.target.style.boxShadow="0 0 0 3px rgba(26,111,196,0.1)"; }}
                  onBlur={e=>{ e.target.style.borderColor="#e2e8f0"; e.target.style.background="#f8fafc"; e.target.style.boxShadow="none"; }}
                  placeholder="Enter your password" />
                <button onClick={()=>setShowPass(p=>!p)}
                  style={{ position:"absolute", right:12, top:"50%",
                    transform:"translateY(-50%)", background:"none",
                    border:"none", cursor:"pointer", color:"#94a3b8", fontSize:15, padding:0 }}>
                  {showPass?"\uD83D\uDE48":"\uD83D\uDC41"}
                </button>
              </div>
            </div>

            {/* Org picker */}
            {orgs && (
              <div style={{ background:"#f8fafc", border:"1.5px solid #e2e8f0",
                borderRadius:9, padding:"12px 14px", marginBottom:20 }}>
                <div style={{ fontSize:11, fontWeight:700, color:blue, marginBottom:8 }}>{"\uD83C\uDFE2"} Select Organisation</div>
                {orgs.map(o => (
                  <label key={o.id} style={{ display:"flex", alignItems:"center", gap:8,
                    padding:"8px 10px", borderRadius:7, cursor:"pointer", marginBottom:4,
                    background:selOrg===String(o.id)?light:"transparent",
                    border:`1px solid ${selOrg===String(o.id)?blue:"transparent"}`,
                    transition:"all 0.15s" }}>
                    <input type="radio" name="org" value={o.id}
                      checked={selOrg===String(o.id)} onChange={()=>setSelOrg(String(o.id))} />
                    <span style={{ fontSize:12, fontWeight:600, color:blue }}>{o.name}</span>
                  </label>
                ))}
              </div>
            )}

            {/* Sign In button */}
            <button onClick={orgs?selectOrg:submit} disabled={loading}
              style={{ width:"100%", padding:"13px", fontSize:14, fontWeight:700,
                background: loading ? "#93c5fd" : `linear-gradient(135deg,${blue},#2563eb)`,
                color:"#fff", border:"none", borderRadius:9,
                cursor:loading?"not-allowed":"pointer",
                letterSpacing:"0.02em", marginBottom:20,
                boxShadow: loading?"none":"0 4px 14px rgba(26,111,196,0.35)",
                transition:"all 0.2s" }}>
              {loading?(orgs?"Logging in...":"Checking..."):(orgs?"Continue \u2192":"Sign In \u2192")}
            </button>

            <div style={{ textAlign:"center", marginBottom:10 }}>
              <span onClick={()=>setShowReq(true)}
                style={{ fontSize:11, fontWeight:600, color:blue,
                  cursor:"pointer", letterSpacing:"0.05em",
                  padding:"6px 16px", borderRadius:20,
                  border:"1px solid #bfdbfe", background:"#eff6ff",
                  display:"inline-block", transition:"all 0.15s" }}
                onMouseEnter={e=>{ e.target.style.background=light; e.target.style.borderColor=blue; }}
                onMouseLeave={e=>{ e.target.style.background="#eff6ff"; e.target.style.borderColor="#bfdbfe"; }}>
                + Request Access
              </span>
            </div>
            <div style={{ textAlign:"center" }}>
              <span style={{ fontSize:9, color:"#cbd5e1", letterSpacing:"0.12em",
                textTransform:"uppercase" }}>{"\uD83D\uDD12"} SSO Authentication Protected</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Request Access Modal ── */}
      {showReq && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)",
          display:"flex", alignItems:"center", justifyContent:"center", zIndex:9999 }}
          onClick={e=>e.target===e.currentTarget&&closeReq()}>
          <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:520,
            padding:"32px 32px 28px", boxShadow:"0 20px 60px rgba(0,0,0,0.25)",
            fontFamily:"'Segoe UI',Arial,sans-serif", maxHeight:"92vh", overflowY:"auto" }}>

            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:20, fontWeight:800, color:"#1a2332" }}>Request Access</div>
              <div style={{ fontSize:11, fontWeight:700, color:"#6b7280",
                letterSpacing:"0.14em", textTransform:"uppercase", marginTop:2 }}>
                STRATOS CONSOLE MANAGEMENT
              </div>
            </div>

            {reqOk ? (
              <div style={{ textAlign:"center", padding:"32px 0" }}>
                <div style={{ fontSize:48, marginBottom:12 }}>{"\u2705"}</div>
                <div style={{ fontSize:16, fontWeight:700, color:"#15803d" }}>Request Submitted!</div>
                <div style={{ fontSize:13, color:"#6b7280", marginTop:6 }}>
                  Your access request has been received. We will get back to you soon.
                </div>
              </div>
            ) : (<>
              {reqErr && (
                <div style={{ background:"#fff5f5", border:"1px solid #fecaca", borderRadius:8,
                  padding:"10px 14px", marginBottom:14, fontSize:13, color:"#dc2626" }}>
                  {"\u26A0\uFE0F"} {reqErr}
                </div>
              )}

              {[
                { key:"org_name",     label:"ORGANISATION NAME", placeholder:"e.g. Acme Corp Infrastructure", full:true },
              ].map(f => (
                <div key={f.key} style={{ marginBottom:14 }}>
                  <label style={{ fontSize:10, fontWeight:700, color:"#6b7280",
                    letterSpacing:"0.12em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                    {f.label}
                  </label>
                  <input style={{ width:"100%", padding:"11px 14px", fontSize:13,
                    border:"1.5px solid #e5e7eb", borderRadius:8, outline:"none",
                    background:"#f9fafb", boxSizing:"border-box", color:"#1a2332" }}
                    placeholder={f.placeholder}
                    value={reqForm[f.key]}
                    onChange={e=>setReqForm(p=>({...p,[f.key]:e.target.value}))}
                    onFocus={e=>e.target.style.borderColor=navy}
                    onBlur={e=>e.target.style.borderColor="#e5e7eb"} />
                </div>
              ))}

              <div style={{ marginBottom:14 }}>
                <label style={{ fontSize:10, fontWeight:700, color:"#6b7280",
                  letterSpacing:"0.12em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                  DESCRIPTION
                </label>
                <textarea style={{ width:"100%", padding:"11px 14px", fontSize:13,
                  border:"1.5px solid #e5e7eb", borderRadius:8, outline:"none",
                  background:"#f9fafb", boxSizing:"border-box", color:"#1a2332",
                  resize:"vertical", minHeight:80, fontFamily:"inherit" }}
                  placeholder="Briefly describe the purpose of this console access..."
                  value={reqForm.description}
                  onChange={e=>setReqForm(p=>({...p,description:e.target.value}))}
                  onFocus={e=>e.target.style.borderColor=navy}
                  onBlur={e=>e.target.style.borderColor="#e5e7eb"} />
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
                {[
                  { key:"admin_name", label:"ADMIN USER NAME",  placeholder:"Full Name" },
                  { key:"email",      label:"OFFICIAL EMAIL ID", placeholder:"work@company.com" },
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize:10, fontWeight:700, color:"#6b7280",
                      letterSpacing:"0.12em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                      {f.label}
                    </label>
                    <input style={{ width:"100%", padding:"11px 14px", fontSize:13,
                      border:"1.5px solid #e5e7eb", borderRadius:8, outline:"none",
                      background:"#f9fafb", boxSizing:"border-box", color:"#1a2332" }}
                      placeholder={f.placeholder}
                      value={reqForm[f.key]}
                      onChange={e=>setReqForm(p=>({...p,[f.key]:e.target.value}))}
                      onFocus={e=>e.target.style.borderColor=navy}
                      onBlur={e=>e.target.style.borderColor="#e5e7eb"} />
                  </div>
                ))}
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
                {[
                  { key:"contact",      label:"CONTACT NO",    placeholder:"+91 00000-00000" },
                  { key:"project_name", label:"PROJECT NAME",  placeholder:"e.g. Internal Infrastructure" },
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize:10, fontWeight:700, color:"#6b7280",
                      letterSpacing:"0.12em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                      {f.label}
                    </label>
                    <input style={{ width:"100%", padding:"11px 14px", fontSize:13,
                      border:"1.5px solid #e5e7eb", borderRadius:8, outline:"none",
                      background:"#f9fafb", boxSizing:"border-box", color:"#1a2332" }}
                      placeholder={f.placeholder}
                      value={reqForm[f.key]}
                      onChange={e=>setReqForm(p=>({...p,[f.key]:e.target.value}))}
                      onFocus={e=>e.target.style.borderColor=navy}
                      onBlur={e=>e.target.style.borderColor="#e5e7eb"} />
                  </div>
                ))}
              </div>

              <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:8,
                padding:"10px 14px", marginBottom:20, display:"flex", gap:10, alignItems:"flex-start" }}>
                <span style={{ color:"#1565c0", fontSize:16, flexShrink:0 }}>{"\u2139\uFE0F"}</span>
                <span style={{ fontSize:12, color:"#1e40af", lineHeight:1.5 }}>
                  These details are requested to create a user and organization so that they can proceed with test box setup.
                </span>
              </div>

              <div style={{ display:"flex", gap:12 }}>
                <button onClick={submitRequest} disabled={reqLoad}
                  style={{ flex:1, padding:"13px", fontSize:14, fontWeight:700,
                    background:reqLoad?"#94a3b8":navy, color:"#fff", border:"none",
                    borderRadius:8, cursor:reqLoad?"not-allowed":"pointer",
                    display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                  {reqLoad ? "Submitting..." : <><span>Submit</span><span style={{fontSize:16}}>{"\u27A4"}</span></>}
                </button>
                <button onClick={closeReq}
                  style={{ flex:1, padding:"13px", fontSize:14, fontWeight:700,
                    background:"#fff", color:"#1a2332", border:"1.5px solid #e5e7eb",
                    borderRadius:8, cursor:"pointer" }}>
                  Cancel
                </button>
              </div>
            </>)}
          </div>
        </div>
      )}
    </div>
  );
}
function Dashboard({ projects, suites }) {
  const [data,       setData]       = useState(null);
  const [dateFilter, setDateFilter] = useState("today");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo,   setCustomTo]   = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [scriptDetail, setScriptDetail] = useState(false);
  const [liveSessions, setLiveSessions] = useState([]);

  // Live sessions — loaded once on mount, refreshed manually
  useEffect(() => {
    api('/api/runs/live')
      .then(data => setLiveSessions(data || []))
      .catch(() => {});
  }, []);

  const navy = "#1a6fc4";

  const getDateRange = (filter) => {
    const now = new Date(), pad = n=>String(n).padStart(2,"0");
    const fmt = d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const today = fmt(now);
    if (filter==="today")  return { from:today, to:today };
    if (filter==="week")   { const d=new Date(now-6*864e5); return {from:fmt(d),to:today}; }
    if (filter==="month")  { const d=new Date(now-29*864e5); return {from:fmt(d),to:today}; }
    if (filter==="custom" && customFrom && customTo) return {from:customFrom,to:customTo};
    return { from:today, to:today };
  };

  const loadData = async (filter=dateFilter) => {
    setLoading(true);
    const range = getDateRange(filter);
    try { const d = await api(`/api/dashboard?from=${range.from}&to=${range.to}`); setData(d); }
    catch(e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { loadData(); }, []);

  const handleFilter = (f) => {
    setDateFilter(f);
    if (f==="custom") { setShowCustom(true); return; }
    setShowCustom(false); loadData(f);
  };

  const DATE_TABS = [
    {key:"today",label:"Today"},{key:"week",label:"This Week"},
    {key:"month",label:"Month"},{key:"custom",label:"Custom"},
  ];

  const SC  = { passed:"#16a34a", failed:"#dc2626", running:"#2563eb", queued:"#d97706", error:"#ea580c" };
  const SBG = { passed:"#dcfce7", failed:"#fee2e2", running:"#dbeafe", queued:"#fef3c7", error:"#ffedd5" };

  const todayRuns       = data?.today_runs || 0;
  const passRateOverall = data?.pass_rate_by_project?.length
    ? Math.round(data.pass_rate_by_project.reduce((s,p)=>s+(+p.rate||0),0)/data.pass_rate_by_project.length)
    : 0;
  const filterLabel = DATE_TABS.find(t=>t.key===dateFilter)?.label || "Today";
  const scriptsByProject = data?.scripts_by_project || [];
  const maxScripts = Math.max(...scriptsByProject.map(p=>+p.total||0), 1);

  const Donut = ({pct, color, size=72, stroke=8}) => {
    const r = (size-stroke*2)/2, circ = 2*Math.PI*r;
    const dash = (pct/100)*circ;
    return (
      <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={stroke}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round"
          style={{transition:"stroke-dasharray 0.8s ease"}}/>
      </svg>
    );
  };

  const cardStyle = {background:"#fff", borderRadius:14, padding:"20px",
    border:"1px solid #e8eaf0", boxShadow:"0 2px 12px rgba(26,39,68,0.06)"};

  return (
    <div style={{padding:"0"}}>

      {/* ── TOP BAR ─────────────────────────────────────────────────── */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:26,fontWeight:900,color:"#8B0000",letterSpacing:"-0.02em"}}>
            Dashboard
          </div>
          <div style={{fontSize:12,color:"#9ca3af",marginTop:2,display:"flex",
            alignItems:"center",gap:6}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:"#22c55e",
              display:"inline-block"}}/>
            All systems operational · Last sync just now
          </div>
        </div>
        <div style={{display:"flex",gap:4,position:"relative"}}>
          {DATE_TABS.map(t=>(
            <button key={t.key} onClick={()=>handleFilter(t.key)}
              style={{padding:"7px 16px",borderRadius:8,border:"1.5px solid",
                fontSize:13,fontWeight:600,cursor:"pointer",transition:"all 0.12s",
                background:dateFilter===t.key?navy:"#fff",
                borderColor:dateFilter===t.key?navy:"#e5e7eb",
                color:dateFilter===t.key?"#fff":"#6b7280"}}>
              {t.label}
            </button>
          ))}
          {showCustom && (
            <div style={{position:"absolute",top:"calc(100% + 8px)",right:0,zIndex:200,
              background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,
              padding:"16px",boxShadow:"0 12px 32px rgba(0,0,0,0.15)",
              display:"flex",gap:12,alignItems:"flex-end"}}>
              <div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:4,fontWeight:600}}>FROM</div>
                <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}
                  style={{...s.input,margin:0,fontSize:13}} />
              </div>
              <div>
                <div style={{fontSize:11,color:"#6b7280",marginBottom:4,fontWeight:600}}>TO</div>
                <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)}
                  style={{...s.input,margin:0,fontSize:13}} />
              </div>
              <button onClick={()=>{setShowCustom(false);loadData("custom");}}
                style={{...s.btn("primary"),padding:"8px 16px",fontSize:13,
                  background:navy,borderColor:navy}}>Apply</button>
            </div>
          )}
        </div>
      </div>

      {/* Live Sessions — always visible, outside the loading gate */}
      {liveSessions.length > 0 && (
        <div style={{background:"#fff",borderRadius:14,border:"1px solid #fecaca",
          boxShadow:"0 2px 12px rgba(229,57,53,0.08)",overflow:"hidden",marginBottom:18}}>
          <div style={{padding:"12px 20px",borderBottom:"1px solid #fee2e2",
            display:"flex",justifyContent:"space-between",alignItems:"center",
            background:"#fff8f8"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:10,height:10,borderRadius:"50%",background:"#e53935",
                boxShadow:"0 0 0 3px rgba(229,57,53,0.25)"}} />
              <span style={{fontWeight:800,fontSize:15,color:"#c62828"}}>Live Sessions</span>
              <span style={{background:"#e53935",color:"#fff",borderRadius:20,
                fontSize:11,fontWeight:700,padding:"2px 9px"}}>
                {liveSessions.length} running
              </span>
            </div>
            <span style={{fontSize:11,color:"#9ca3af"}}>Click ↻ Refresh to update</span>
          </div>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:"#fff8f8"}}>
                {["Test Case","Project","Triggered By","User","Browser","Running For"].map(h=>(
                  <th key={h} style={{padding:"8px 16px",textAlign:"left",fontSize:10,
                    fontWeight:700,color:"#9ca3af",letterSpacing:"0.08em",
                    borderBottom:"1px solid #fee2e2",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {liveSessions.map(s => {
                const mins   = Math.floor((s.elapsed_seconds||0)/60);
                const secs   = (s.elapsed_seconds||0)%60;
                const dur    = mins>0 ? mins+"m "+secs+"s" : secs+"s";
                const isLong = (s.elapsed_seconds||0)>300;
                return (
                  <tr key={s.id}
                    onMouseEnter={e=>e.currentTarget.style.background="#fff5f5"}
                    onMouseLeave={e=>e.currentTarget.style.background=""}
                    style={{borderBottom:"1px solid #fff5f5"}}>
                    <td style={{padding:"10px 16px"}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#1a6fc4"}}>{s.test_name}</div>
                      {s.suite_name&&<div style={{fontSize:10,color:"#9ca3af",marginTop:2}}>🗂️ {s.suite_name}</div>}
                    </td>
                    <td style={{padding:"10px 16px",fontSize:12,color:"#6b7280"}}>{s.project_name}</td>
                    <td style={{padding:"10px 16px"}}>
                      <span style={{fontSize:11,fontWeight:600,padding:"2px 8px",borderRadius:4,
                        background:s.triggered_by==="suite"?"#f5f0ff":"#eff6ff",
                        color:s.triggered_by==="suite"?"#6b46c1":"#1a6fc4"}}>
                        {s.triggered_by==="suite"?"🗂️ Suite":"▶ Manual"}
                      </span>
                    </td>
                    <td style={{padding:"10px 16px",fontSize:12,color:"#6b7280"}}>{s.run_by_name||s.run_by||"System"}</td>
                    <td style={{padding:"10px 16px",fontSize:12,color:"#6b7280",textTransform:"capitalize"}}>{s.browser}</td>
                    <td style={{padding:"10px 16px"}}>
                      <span style={{fontSize:12,fontWeight:700,padding:"3px 9px",borderRadius:20,
                        color:isLong?"#dc2626":"#e53935",
                        background:isLong?"#fee2e2":"#fff1f0",
                        border:"1px solid "+(isLong?"#fca5a5":"#fecaca")}}>
                        ⏱ {dur}{isLong?" ⚠️":""}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {loading && (
        <div style={{textAlign:"center",padding:"60px 0",color:"#9ca3af"}}>
          <div style={{width:36,height:36,border:"3px solid #e5e7eb",
            borderTop:`3px solid ${navy}`,borderRadius:"50%",
            animation:"spin 0.8s linear infinite",margin:"0 auto 12px"}}/>
          Loading dashboard...
        </div>
      )}

      {!loading && (
        <>
          {/* ── HERO STAT CARDS ─────────────────────────────────────── */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:18}}>

            {/* Card 1 — Total Scripts */}
            <div style={cardStyle}>
              <div style={{display:"flex",justifyContent:"space-between",
                alignItems:"flex-start",marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",
                    letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>
                    Total Scripts
                  </div>
                  <div style={{fontSize:38,fontWeight:900,color:navy,
                    fontFamily:"'IBM Plex Mono',monospace",lineHeight:1}}>
                    {data?.scripts_by_type?.total||0}
                  </div>
                </div>
                <div style={{width:36,height:36,background:"#eff6ff",borderRadius:10,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{"\uD83E\uDDEA"}</div>
              </div>
              {[
                {val:data?.scripts_by_type?.ai||0,       label:"AI Gen",   color:"#22c55e"},
                {val:data?.scripts_by_type?.recorded||0, label:"Recorded", color:"#3b82f6"},
                {val:data?.scripts_by_type?.manual||0,   label:"Manual",   color:"#f97316"},
              ].map(item=>(
                <div key={item.label} style={{marginBottom:7}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                    <span style={{fontSize:11,color:"#6b7280"}}>{item.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:item.color}}>{item.val}</span>
                  </div>
                  <div style={{height:5,background:"#f3f4f6",borderRadius:4,overflow:"hidden"}}>
                    <div style={{height:"100%",
                      width:`${(data?.scripts_by_type?.total||0)>0?(item.val/(data?.scripts_by_type?.total||1))*100:0}%`,
                      background:item.color,borderRadius:4,transition:"width 0.8s ease"}}/>
                  </div>
                </div>
              ))}
            </div>

            {/* Card 2 — Active Projects */}
            <div style={cardStyle}>
              <div style={{display:"flex",justifyContent:"space-between",
                alignItems:"flex-start",marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",
                    letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>
                    Active Projects
                  </div>
                  <div style={{fontSize:38,fontWeight:900,color:navy,
                    fontFamily:"'IBM Plex Mono',monospace",lineHeight:1}}>
                    {projects.length}
                  </div>
                </div>
                <div style={{width:36,height:36,background:"#f0fdf4",borderRadius:10,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{"\uD83D\uDCC1"}</div>
              </div>
              <div style={{display:"flex",alignItems:"flex-end",gap:4,height:72}}>
                {scriptsByProject.slice(0,7).map((p,i)=>{
                  const total = +p.total||0;
                  const h = total>0 ? Math.max((total/maxScripts)*60,8) : 4;
                  return (
                    <div key={i} style={{flex:1,display:"flex",flexDirection:"column",
                      alignItems:"center",gap:3}}>
                      <div style={{fontSize:9,fontWeight:700,color:"#6b7280"}}>{total||""}</div>
                      <div style={{width:"100%",height:h,background:"#C4C7C9",borderRadius:"3px 3px 0 0",
                        transition:"height 0.8s ease"}} title={`${p.project}: ${total} scripts`}/>
                      <div style={{fontSize:7,color:"#9ca3af",textAlign:"center",
                        overflow:"hidden",whiteSpace:"nowrap",maxWidth:28,
                        textOverflow:"ellipsis"}}>
                        {(p.project||"").slice(0,5)}
                      </div>
                    </div>
                  );
                })}
                {scriptsByProject.length===0 && (
                  <div style={{flex:1,textAlign:"center",color:"#d1d5db",fontSize:11,
                    alignSelf:"center"}}>No data</div>
                )}
              </div>
            </div>

            {/* Card 3 — Pass Rate */}
            <div style={cardStyle}>
              <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",
                letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:14}}>
                Pass Rate
              </div>
              <div style={{display:"flex",alignItems:"center",gap:14}}>
                <div style={{position:"relative",flexShrink:0}}>
                  <Donut pct={passRateOverall}
                    color={passRateOverall>=80?"#22c55e":passRateOverall>=50?"#f59e0b":"#ef4444"}
                    size={76} stroke={8}/>
                  <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",
                    alignItems:"center",justifyContent:"center"}}>
                    <span style={{fontSize:18,fontWeight:900,color:navy,
                      fontFamily:"'IBM Plex Mono',monospace"}}>{passRateOverall}%</span>
                  </div>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,color:"#6b7280",marginBottom:8,lineHeight:1.5}}>
                    Avg stability · {filterLabel}
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {(data?.pass_rate_by_project||[]).slice(0,3).map((p,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:6}}>
                        <div style={{height:4,flex:1,background:"#f3f4f6",borderRadius:4,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${p.rate||0}%`,borderRadius:4,
                            background:p.rate>=80?"#22c55e":p.rate>=50?"#f59e0b":"#ef4444",
                            transition:"width 0.8s ease"}}/>
                        </div>
                        <span style={{fontSize:10,color:"#9ca3af",width:28,textAlign:"right",
                          fontWeight:600}}>{p.rate}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Card 4 — Runs Today */}
            <div style={cardStyle}>
              <div style={{display:"flex",justifyContent:"space-between",
                alignItems:"flex-start",marginBottom:14}}>
                <div>
                  <div style={{fontSize:11,fontWeight:700,color:"#9ca3af",
                    letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>
                    Runs Today
                  </div>
                  <div style={{fontSize:38,fontWeight:900,color:navy,
                    fontFamily:"'IBM Plex Mono',monospace",lineHeight:1}}>
                    {todayRuns}
                  </div>
                </div>
                <div style={{width:36,height:36,background:"#eff6ff",borderRadius:10,
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{"\u25B6"}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:"#22c55e",
                  boxShadow:"0 0 0 3px rgba(34,197,94,0.25)"}}/>
                <span style={{fontSize:12,color:"#6b7280"}}>
                  {data?.running_now||0} Live Session{(data?.running_now||0)!==1?"s":""} Active
                </span>
              </div>
              <div style={{display:"flex",gap:3,height:6,borderRadius:4,overflow:"hidden",marginBottom:8}}>
                {(()=>{
                  const passed = data?.runs_passed_today||0;
                  const failed = data?.runs_failed_today||0;
                  const other  = Math.max(0,todayRuns-passed-failed);
                  return [
                    {c:"#22c55e",v:passed},{c:"#ef4444",v:failed},{c:"#f59e0b",v:other}
                  ].map(({c,v},i)=>(
                    <div key={i} style={{flex:Math.max(v,0.1),height:"100%",background:c,borderRadius:2}}/>
                  ));
                })()}
              </div>
              <div style={{display:"flex",gap:14}}>
                {[
                  {c:"#22c55e",l:`${data?.runs_passed_today||0} Passed`},
                  {c:"#ef4444",l:`${data?.runs_failed_today||0} Failed`},
                ].map(({c,l})=>(
                  <div key={l} style={{display:"flex",alignItems:"center",gap:4}}>
                    <div style={{width:7,height:7,borderRadius:2,background:c}}/>
                    <span style={{fontSize:11,color:"#6b7280",fontWeight:600}}>{l}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── BOTTOM SECTION ───────────────────────────────────────── */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1.6fr",gap:14}}>

            {/* Script History */}
            <div style={{background:"#fff",borderRadius:14,border:"1px solid #e8eaf0",
              boxShadow:"0 2px 12px rgba(26,39,68,0.06)",overflow:"hidden"}}>
              <div style={{padding:"16px 20px",borderBottom:"1px solid #f3f4f6",
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:800,fontSize:15,color:navy}}>Script History</div>
                  <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{filterLabel}</div>
                </div>
                <button onClick={()=>setScriptDetail(v=>!v)}
                  style={{fontSize:12,color:"#1d4ed8",fontWeight:600,cursor:"pointer",
                    background:"none",border:"none",padding:0}}>
                  {scriptDetail?"\u2191 Summary":"View All \u2192"}
                </button>
              </div>

              {!scriptDetail ? (
                <div style={{padding:"8px 0"}}>
                  {(data?.script_history||[]).slice(0,5).map((row,i)=>{
                    const icons=["\uD83D\uDCCB","\u270F\uFE0F","\uD83D\uDD04","\uD83D\uDCE6","\uD83D\uDDC2\uFE0F"];
                    const colors=["#eff6ff","#f0fdf4","#fff7ed","#f5f3ff","#f9fafb"];
                    const tcolors=["#1d4ed8","#16a34a","#d97706","#7c3aed","#6b7280"];
                    const hasNew = +row.new_scripts>0;
                    const hasUpd = +row.updated_scripts>0;
                    if (!hasNew && !hasUpd) return null;
                    return (
                      <div key={i} style={{display:"flex",alignItems:"center",gap:12,
                        padding:"10px 20px",borderBottom:"1px solid #f9fafb"}}>
                        <div style={{width:34,height:34,borderRadius:9,
                          background:colors[i%colors.length],display:"flex",
                          alignItems:"center",justifyContent:"center",
                          fontSize:16,flexShrink:0}}>{icons[i%icons.length]}</div>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{fontSize:13,fontWeight:700,color:navy,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {row.project}
                          </div>
                          <div style={{fontSize:11,color:"#9ca3af",marginTop:1}}>
                            {hasNew?`${row.new_scripts} new`:""}{hasNew&&hasUpd?" · ":""}{hasUpd?`${row.updated_scripts} updated`:""}
                          </div>
                        </div>
                        <span style={{fontSize:10,color:tcolors[i%tcolors.length],
                          background:colors[i%colors.length],padding:"2px 8px",
                          borderRadius:20,fontWeight:600,flexShrink:0}}>{filterLabel}</span>
                      </div>
                    );
                  })}
                  {!(data?.script_history?.filter(r=>+r.new_scripts>0||+r.updated_scripts>0).length) && (
                    <div style={{padding:"28px",textAlign:"center",color:"#9ca3af",fontSize:13}}>
                      No scripts in this period
                    </div>
                  )}
                </div>
              ) : (
                <div style={{overflowX:"auto",maxHeight:320,overflowY:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",minWidth:400}}>
                    <thead>
                      <tr style={{background:"#f9fafb",position:"sticky",top:0}}>
                        {["PROJECT","SCRIPT NAME","ACTION","DATE"].map(h=>(
                          <th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:10,
                            fontWeight:700,color:"#6b7280",letterSpacing:"0.08em",
                            borderBottom:"1px solid #f0f2f5",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.script_history_detail?.length
                        ? data.script_history_detail
                        : []
                      ).map((r,i)=>(
                        <tr key={i} style={{borderBottom:"1px solid #f9fafb"}}
                          onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
                          onMouseLeave={e=>e.currentTarget.style.background=""}>
                          <td style={{padding:"9px 14px",fontSize:12,fontWeight:600,
                            color:"#6b7280",maxWidth:130,overflow:"hidden",
                            textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                            title={r.project_name}>
                            {r.project_name}
                          </td>
                          <td style={{padding:"9px 14px",fontSize:13,fontWeight:700,
                            color:navy,maxWidth:180,overflow:"hidden",
                            textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                            title={r.script_name}>
                            {r.script_name}
                          </td>
                          <td style={{padding:"9px 14px"}}>
                            <span style={{fontSize:11,fontWeight:700,
                              color:r.action==="Created"?"#16a34a":"#2563eb",
                              background:r.action==="Created"?"#dcfce7":"#dbeafe",
                              padding:"3px 10px",borderRadius:20}}>
                              {r.action==="Created"?"\u2705 Created":"\u270F\uFE0F Updated"}
                            </span>
                          </td>
                          <td style={{padding:"9px 14px",fontSize:11,color:"#9ca3af",
                            whiteSpace:"nowrap"}}>
                            {new Date(r.action==="Created"?r.created_at:r.updated_at)
                              .toLocaleString("en-IN",{
                                day:"2-digit",month:"short",year:"numeric",
                                hour:"2-digit",minute:"2-digit"
                              })}
                          </td>
                        </tr>
                      ))}
                      {!(data?.script_history_detail?.length) && (
                        <tr><td colSpan={4} style={{padding:"24px",textAlign:"center",
                          color:"#9ca3af",fontSize:13}}>No scripts changed in this period</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Recent Runs */}
            <div style={{background:"#fff",borderRadius:14,border:"1px solid #e8eaf0",
              boxShadow:"0 2px 12px rgba(26,39,68,0.06)",overflow:"hidden"}}>
              <div style={{padding:"16px 20px",borderBottom:"1px solid #f3f4f6",
                display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontWeight:800,fontSize:15,color:navy}}>Recent Runs</div>
                  <div style={{fontSize:11,color:"#9ca3af",marginTop:2}}>{filterLabel}</div>
                </div>
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
                  <thead>
                    <tr style={{background:"#f9fafb"}}>
                      {["SCRIPT NAME","USER","BROWSER","STATUS","TESTS","TIME"].map(h=>(
                        <th key={h} style={{padding:"9px 14px",textAlign:"left",fontSize:11,
                          fontWeight:700,color:"#6b7280",letterSpacing:"0.08em",
                          borderBottom:"1px solid #f0f2f5",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.recent_runs||[]).map((r,i)=>(
                      <tr key={r.id}
                        style={{borderBottom:"1px solid #f9fafb",cursor:"default",
                          transition:"background 0.1s"}}
                        onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
                        onMouseLeave={e=>e.currentTarget.style.background=""}>
                        <td style={{padding:"11px 14px",fontSize:13,fontWeight:700,
                          color:navy,maxWidth:140,overflow:"hidden",
                          textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                          {r.test_name||"\u2014"}
                        </td>
                        <td style={{padding:"11px 14px",fontSize:12,color:"#6b7280"}}>
                          {r.run_by_name||"Daiva"}
                        </td>
                        <td style={{padding:"11px 14px",fontSize:12,color:"#6b7280",
                          textTransform:"capitalize"}}>
                          {r.browser||"chrome"}
                        </td>
                        <td style={{padding:"11px 14px"}}>
                          <span style={{fontSize:11,fontWeight:700,
                            color:SC[r.status]||"#6b7280",
                            background:SBG[r.status]||"#f3f4f6",
                            padding:"3px 10px",borderRadius:20,
                            textTransform:"uppercase",letterSpacing:"0.05em"}}>
                            {r.status}
                          </span>
                        </td>
                        <td style={{padding:"11px 14px",fontSize:13,
                          fontFamily:"'IBM Plex Mono',monospace",
                          color:r.status==="failed"?"#dc2626":navy,fontWeight:700}}>
                          {r.steps_passed!=null&&r.steps_total!=null
                            ?`${r.steps_passed}/${r.steps_total}`:"\u2014"}
                        </td>
                        <td style={{padding:"11px 14px",fontSize:11,color:"#9ca3af",
                          whiteSpace:"nowrap"}}>
                          {r.created_at?new Date(r.created_at).toLocaleString("en-IN",
                            {day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"\u2014"}
                        </td>
                      </tr>
                    ))}
                    {!(data?.recent_runs?.length) && (
                      <tr><td colSpan={6} style={{padding:"28px",textAlign:"center",
                        color:"#9ca3af",fontSize:13}}>No runs in this period</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {(data?.recent_runs?.length||0)>0 && (
                <div style={{padding:"12px 20px",borderTop:"1px solid #f3f4f6"}}>
                  <span style={{fontSize:12,color:"#9ca3af"}}>
                    Showing {data.recent_runs.length} of {data.total_runs||data.recent_runs.length} executions
                  </span>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}


function TestCases({ projects, suites, onRefresh, user, onRun, initProjectFilter, onClearProjectFilter }) {
  const [tests,      setTests]      = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(false);
  const [editing,    setEditing]    = useState(null);
  const [stepsExpanded, setStepsExpanded] = useState(false); // fullscreen step editor
  const [search,     setSearch]     = useState("");
  const [projFilter, setProj]       = useState(initProjectFilter||"");
  const [jql,      setJql]      = useState("");
  const [jqlError, setJqlError] = useState("");
  const [jqlMode,  setJqlMode]  = useState(false);
  const jqlRef      = useRef("");
  const projectsRef = useRef([]);
  useEffect(() => { projectsRef.current = projects || []; }, [projects]);
  useEffect(()=>{ if(initProjectFilter && initProjectFilter !== projFilter){ setProj(initProjectFilter); } }, [initProjectFilter]);

  // ── Recorder state (must be declared BEFORE the hash-reader useEffect) ──
  const [scriptModal, setScriptModal] = useState(null);
  const [recModal,    setRecModal]    = useState(false);
  const [recSession,  setRecSession]  = useState(null);
  const [recScript,   setRecScript]   = useState("");
  const [recSteps,    setRecSteps]    = useState([]);
  const [recStartUrl, setRecStartUrl] = useState("");
  const [recSaving,   setRecSaving]   = useState(false);
  const [recName,     setRecName]     = useState("");
  const [recProject,  setRecProject]  = useState("");
  const [recSuite,    setRecSuite]    = useState("medium");
  const [recEditing,  setRecEditing]  = useState(false);
  const [recPasteJson, setRecPasteJson] = useState("");
  const [recPasteErr,  setRecPasteErr]  = useState("");
  const recWsRef   = useRef(null);
  const recStepsRef = useRef([]);

  // ── Hash reader: called on mount, hashchange, and focus ──────────────────
  const handleRecorderHash = () => {
    const hash = window.location.hash;
    if (!hash.startsWith('#recorder')) return;
    try {
      // Parse safely without URLSearchParams (which corrupts base64 + and = chars)
      const raw = hash.slice(1); // remove '#'
      const stepsMatch = raw.match(/[?&]steps=([^&]*)/);
      if (!stepsMatch) return;
      // Decode URI encoding if present (happens when browser URL-encodes the hash)
      const encoded = decodeURIComponent(stepsMatch[1]);
      if (!encoded) return;
      let steps = JSON.parse(decodeURIComponent(escape(atob(encoded))));
      if (!Array.isArray(steps) || !steps.length) return;
      steps = steps.filter(s => !(s.action === 'navigate' && s.value && (
        s.value.startsWith('chrome://') || s.value.startsWith('chrome-extension://') ||
        s.value.startsWith('about:')    || s.value.startsWith('edge://')
      )));
      if (!steps.length) return;
      // Extension sends the FULL accumulated steps — just replace
      recStepsRef.current = steps;
      setRecSteps(steps);
      setRecSession({ status: 'stopped', source: 'extension' });
      setRecModal(true);
      // Only reset the save form if no name entered yet
      if (!recStepsRef.current.length || recStepsRef.current.length === steps.length) {
        setRecName('');
        setRecProject('');
        setRecSuite('medium');
      }
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch(e) { console.warn('[ATHMA] hash parse error:', e); }
  };

  useEffect(() => {
    handleRecorderHash();
    window.addEventListener('hashchange', handleRecorderHash);
    window.addEventListener('focus', handleRecorderHash);
    return () => {
      window.removeEventListener('hashchange', handleRecorderHash);
      window.removeEventListener('focus', handleRecorderHash);
    };
  }, []);

  // Live-poll extension for steps while recording modal is open
  useEffect(() => {
    if (recSession?.status !== 'recording') return;
    const extId = window.__ATHMA_EXT_ID__ || localStorage.getItem('athma_ext_id');
    if (!extId || !window.chrome?.runtime) return;
    const timer = setInterval(() => {
      try {
        window.chrome.runtime.sendMessage(extId, { type: 'nat_get_steps' }, (resp) => {
          if (window.chrome.runtime.lastError || !resp) return;
          const steps = resp.steps || [];
          if (steps.length > (recStepsRef.current?.length || 0)) {
            recStepsRef.current = steps;
            setRecSteps([...steps]);
          }
        });
      } catch(e) {}
    }, 800);
    return () => clearInterval(timer);
  }, [recSession?.status]);
  const [scriptText,  setScriptText]  = useState("");
  const [scriptSaving, setScriptSaving] = useState(false);
  const [form, setForm] = useState({ name:"", description:"", type:"ui", browser:"chrome", base_url:"", suite_id:"", project_id:"", steps:[], variables:[], api_config: null, tags:"", priority:"medium", module_id:"", is_callable:false, heal_update:false });

  const canEdit = ["superadmin","admin","lead","tester"].includes(user?.role);

  const [tcPage,   setTcPage]   = useState(() => parseInt(sessionStorage.getItem('tc_page')||'1'));
  const [tcTotal,  setTcTotal]  = useState(0);
  const [tcPages,  setTcPages]  = useState(1);

  const loadTests = useCallback(async (pg=1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page:pg, limit:getAppPageSize() });
      if (!jqlMode) {
        if (projFilter) params.set("project_id", projFilter);
        if (search)     params.set("search", search);
      } else {
        if (search) params.set("search", search);
        const latestProjects = projectsRef.current || [];
        const jqlP = parseJQL(jqlRef.current, latestProjects);
        Object.entries(jqlP).forEach(([k,v]) => { if(v) params.set(k, v); });
      }
      const r = await api(`/api/tests?${params}`);
      const rows = Array.isArray(r) ? r : (r.rows||[]);
      if (Array.isArray(r)) {
        setTests(rows); setTcTotal(rows.length); setTcPages(1);
      } else {
        setTests(rows); setTcTotal(r.total||0); setTcPages(r.pages||1);
      }
      setTcPage(pg);
      sessionStorage.setItem('tc_page', pg);
    } finally { setLoading(false); }
  }, [projFilter, search, jqlMode]); // removed 'projects' — it's read inside via closure, not a dep

  // Track previous filter values to only reload when filters actually change
  const prevFilters = useRef({ projFilter: undefined, search: undefined, jqlMode: undefined });
  useEffect(() => {
    const prev = prevFilters.current;
    const isFirstRun = prev.projFilter === undefined;
    const filtersChanged = prev.projFilter !== projFilter || prev.search !== search || prev.jqlMode !== jqlMode;
    prevFilters.current = { projFilter, search, jqlMode };
    if (isFirstRun) {
      // On mount — load the saved page (restores page after remount)
      const savedPage = parseInt(sessionStorage.getItem('tc_page') || '1');
      loadTests(savedPage);
    } else if (filtersChanged) {
      // On filter change — reset to page 1
      sessionStorage.removeItem('tc_page');
      loadTests(1);
    }
  }, [projFilter, search, jqlMode, loadTests]);

  const parseJQL = (raw, projList) => {
    const out = {};
    if (!raw?.trim()) return out;
    const parts = raw.trim().split(/\s+and\s+/i).map(c=>c.trim()).filter(Boolean);
    for (const clause of parts) {
      const c = clause.trim();
      if (/^project\s*=/i.test(c)) {
        const m = c.match(/^project\s*=\s*(.+)$/i);
        if (m) {
          const pName = m[1].trim().replace(/^["'\s]+|["'\s]+$/g,"");
          const proj =
            (projList||[]).find(p => p.name.toLowerCase() === pName.toLowerCase()) ||
            (projList||[]).find(p => p.name.toLowerCase().includes(pName.toLowerCase())) ||
            (projList||[]).find(p => pName.toLowerCase().includes(p.name.toLowerCase()));
          if (proj) { out.project_id = String(proj.id); }
        }
        continue;
      }
      if (/^project\s+in\s*\(/i.test(c)) {
        const m = c.match(/\(([^)]+)\)/);
        if (m) {
          const names = m[1].split(",").map(s=>s.trim().replace(/^["']|["']$/g,""));
          for (const n of names) {
            const proj =
              (projList||[]).find(p => p.name.toLowerCase() === n.toLowerCase()) ||
              (projList||[]).find(p => p.name.toLowerCase().includes(n.toLowerCase()));
            if (proj) { out.project_id = String(proj.id); break; }
          }
        }
        continue;
      }
      const inM = c.match(/^(\w+)\s+in\s*\(([^)]+)\)/i);
      if (inM) {
        const field = inM[1].toLowerCase().replace(/^status$/,"last_status");
        let vals = inM[2].split(",").map(s=>s.trim().replace(/^["']|["']$/g,"")).filter(Boolean);
        if (["priority","last_status","type"].includes(field)) vals = vals.map(v=>v.toLowerCase());
        if (vals.length) out[field] = vals.join(",");
        continue;
      }
      const eqM = c.match(/^(\w+)\s*=\s*(.+)$/i);
      if (eqM) {
        const field = eqM[1].toLowerCase().replace(/^status$/,"last_status");
        let val = eqM[2].trim().replace(/^["']|["']$/g,"");
        if (["priority","last_status","type"].includes(field)) val = val.toLowerCase();
        if (val) out[field] = val;
      }
    }
    return out;
  };

  const openAdd = () => {
    setForm({ name:"", description:"", type:"ui", browser:"chrome", base_url:"", suite_id:"", project_id: projFilter||"", steps:[], variables:[], api_config:{ method:"GET", url:"", headers:{}, body:"", assertions:[] }, tags:"", priority:"medium", module_id:"", is_callable:false });
    setEditing(null);
    setModal(true);
  };

  const openEdit = async (test) => {
    // Always fetch fresh from DB so we get latest version (not stale cached copy)
    try {
      const fresh = await api(`/api/tests/${test.id}`);
      setForm({ ...fresh, tags: (fresh.tags||[]).join(", "), steps: fresh.steps||[], variables: fresh.variables||[], api_config: fresh.api_config || { method:"GET", url:"", headers:{}, body:"", assertions:[] }, module_id: fresh.module_id||"" });
    } catch(e) {
      // Fallback to cached if fetch fails
      setForm({ ...test, tags: (test.tags||[]).join(", "), steps: test.steps||[], variables: test.variables||[], api_config: test.api_config || { method:"GET", url:"", headers:{}, body:"", assertions:[] }, module_id: test.module_id||"" });
    }
    setEditing(test.id);
    setModal(true);
  };

  const [saveError, setSaveError] = useState("");
  const [savedOk,    setSavedOk]   = useState(false);

  const save = async (closeAfter = false) => {
    setSaveError("");
    if (!form.name?.trim()) { setSaveError("Test case name is required."); return; }
    if (!form.project_id)   { setSaveError("Project is required — please select a project."); return; }
    const duplicate = tests.find(t =>
      t.name.trim().toLowerCase() === form.name.trim().toLowerCase() &&
      String(t.project_id) === String(form.project_id) &&
      (!editing || t.id !== editing)
    );
    if (duplicate) { setSaveError(`A test case named "${form.name.trim()}" already exists in this project.`); return; }
    const payload = {
      ...form,
      name:      form.name.trim(),
      tags:      form.tags ? form.tags.split(",").map(t=>t.trim()).filter(Boolean) : [],
      module_id: form.module_id ? parseInt(form.module_id) : null,
      priority:  form.priority || "medium",
    };
    try {
      let saved;
      if (editing) saved = await api(`/api/tests/${editing}`, { method: "PUT", body: payload });
      else         saved = await api("/api/tests", { method: "POST", body: payload });
      setSaveError("");
      loadTests();
      if (closeAfter) { setModal(false); }
      else {
        // Stay open — update editing id and form with saved data
        if (!editing && saved?.id) setEditing(saved.id);
        if (saved) setForm(f => ({ ...f, ...saved, tags: (saved.tags||[]).join(", ") }));
        setSaveError("");
        // Show brief success indicator
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
      }
    } catch (e) { setSaveError(e.message || "Failed to save test case."); }
  };

  const deleteTest = async (id) => {
    if (!confirm("Delete this test?")) return;
    await api(`/api/tests/${id}`, { method: "DELETE" });
    loadTests();
  };

  const copyTest = async (t) => {
    try {
      const res = await api(`/api/tests/${t.id}/copy`, { method: "POST" });
      loadTests();
      openEdit({ ...res, tags: (res.tags||[]).join(", "),
        steps: res.steps||[], variables: res.variables||[],
        api_config: res.api_config || { method:"GET", url:"", headers:{}, body:"", assertions:[] } });
    } catch(e) { alert("Copy failed: " + e.message); }
  };

  const openScript = (t) => {
    const script = stepsToScript(t.steps||[], t.variables||[], t.name);
    setScriptText(script);
    setScriptModal(t);
  };

  const [scriptImportMode, setScriptImportMode] = useState("replace");
  const [scriptPreview,    setScriptPreview]    = useState(null);

  const previewScript = () => {
    try {
      const parsed = codeToSteps(scriptText);
      setScriptPreview(parsed.length ? parsed : scriptToSteps(scriptText));
    } catch(e) {
      setScriptPreview(scriptToSteps(scriptText));
    }
  };

  const saveScript = async () => {
    if (!scriptModal) return;
    setScriptSaving(true);
    try {
      let newSteps = [];
      try { newSteps = codeToSteps(scriptText); } catch(e) {}
      if (newSteps.length === 0) newSteps = scriptToSteps(scriptText);
      if (newSteps.length === 0) return alert("No steps could be parsed.\n\nMake sure your script uses valid Playwright syntax.\nExample: page.fill(\"#username\", \"admin\")");
      // ── Simplify fragile recorded selectors ──
      newSteps = newSteps.map(step => ({
        ...step,
        selector: step.selector ? smartSel(step.selector) : step.selector,
      }));
      const existing = scriptModal.steps || [];
      const merged   = scriptImportMode === "replace" ? newSteps : [...existing, ...newSteps];
      await api(`/api/tests/${scriptModal.id}`, { method:"PUT", body: { ...scriptModal, steps: merged, tags:(scriptModal.tags||[]) } });
      setScriptModal(null); setScriptPreview(null);
      loadTests();
      alert(`\u2713 ${newSteps.length} step(s) ${scriptImportMode === "replace" ? "imported" : "appended"} successfully!`);
    } catch(e) { alert(e.message); }
    finally { setScriptSaving(false); }
  };

  // ── ATHMA Recorder ──────────────────────────────────────────────────
  const BOOKMARKLET_URL = atob("amF2YXNjcmlwdDooZnVuY3Rpb24oKXtpZih3aW5kb3cuX19OQVRfUkVDX18pe3ZhciBleD1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKCdfbmF0X3N0ZXBzJyl8fCdbXScpO2lmKGNvbmZpcm0oJ0NvcHkgJytleC5sZW5ndGgrJyByZWNvcmRlZCBzdGVwcz8nKSl7dHJ5e25hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KEpTT04uc3RyaW5naWZ5KGV4KSk7fWNhdGNoKGUpe3ZhciB0YT1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCd0ZXh0YXJlYScpO3RhLnZhbHVlPUpTT04uc3RyaW5naWZ5KGV4KTtkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKHRhKTt0YS5zZWxlY3QoKTtkb2N1bWVudC5leGVjQ29tbWFuZCgnY29weScpO3RhLnJlbW92ZSgpO31hbGVydCgnQ29waWVkICcrZXgubGVuZ3RoKycgc3RlcHMhIFBhc3RlIGluIE5BVCByZWNvcmRlci4nKTt9cmV0dXJuO313aW5kb3cuX19OQVRfUkVDX189dHJ1ZTtsb2NhbFN0b3JhZ2Uuc2V0SXRlbSgnX25hdF9zdGVwcycsJ1tdJyk7dmFyIFc9J3dzOi8vMTAuOC43LjE3Njo2MDAxJyx3cz1udWxsLHNpZD0ncmVjXycrRGF0ZS5ub3coKTtmdW5jdGlvbiBsZCgpe3RyeXtyZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgnX25hdF9zdGVwcycpfHwnW10nKTt9Y2F0Y2goZSl7cmV0dXJuW107fX1mdW5jdGlvbiB1cGQoKXt2YXIgZT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnX25jJyk7aWYoZSl7dmFyIHN0PWxkKCk7ZS50ZXh0Q29udGVudD1zdC5sZW5ndGgrJyBzdGVwJysoc3QubGVuZ3RoIT09MT8ncyc6JycpO319ZnVuY3Rpb24gc25kKHN0ZXApe3ZhciBzdD1sZCgpO3N0LnB1c2goc3RlcCk7bG9jYWxTdG9yYWdlLnNldEl0ZW0oJ19uYXRfc3RlcHMnLEpTT04uc3RyaW5naWZ5KHN0KSk7dXBkKCk7aWYod3MmJndzLnJlYWR5U3RhdGU9PT0xKXdzLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6J05BVF9TVEVQJyxzdGVwOnN0ZXAsc2Vzc2lvbklkOnNpZH0pKTt9ZnVuY3Rpb24gZ3MoZWwpe2lmKCFlbHx8ZWw9PT1kb2N1bWVudC5ib2R5KXJldHVybiAnYm9keSc7aWYoZWwuaWQpcmV0dXJuICcjJytlbC5pZDt2YXIgYT1lbC5nZXRBdHRyaWJ1dGUoJ2RhdGEtdGVzdGlkJyk7aWYoYSlyZXR1cm4gJ1tkYXRhLXRlc3RpZD0iJythKyciXSc7dmFyIGI9ZWwuZ2V0QXR0cmlidXRlKCduYW1lJyk7aWYoYilyZXR1cm4gJ1tuYW1lPSInK2IrJyJdJzt2YXIgYz1lbC5nZXRBdHRyaWJ1dGUoJ3BsYWNlaG9sZGVyJyk7aWYoYylyZXR1cm4gJ1twbGFjZWhvbGRlcj0iJytjKyciXSc7dmFyIGZjPWVsLmdldEF0dHJpYnV0ZSgnZm9ybWNvbnRyb2xuYW1lJyk7aWYoZmMpcmV0dXJuICdbZm9ybWNvbnRyb2xuYW1lPSInK2ZjKyciXSc7dmFyIGFsPWVsLmdldEF0dHJpYnV0ZSgnYXJpYS1sYWJlbCcpO2lmKGFsJiZkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbYXJpYS1sYWJlbD0iJythbCsnIl0nKS5sZW5ndGg9PT0xKXJldHVybiAnW2FyaWEtbGFiZWw9IicrYWwrJyJdJzt2YXIgdHh0PShlbC50ZXh0Q29udGVudHx8JycpLnRyaW0oKS5yZXBsYWNlKC9ccysvZywnICcpLnNsaWNlKDAsNDApO3ZhciB0YWc9ZWwudGFnTmFtZS50b0xvd2VyQ2FzZSgpO2lmKCh0YWc9PT0nYnV0dG9uJ3x8dGFnPT09J2EnKSYmdHh0JiZ0eHQubGVuZ3RoPjEmJnR4dC5sZW5ndGg8NTApe3ZhciBieD10YWcrJzpoYXMtdGV4dCgiJyt0eHQrJyIpJzt0cnl7aWYoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCh0YWcpLmxlbmd0aDwyMClyZXR1cm4gYng7fWNhdGNoKGUpe319dmFyIGNsPUFycmF5LmZyb20oZWwuY2xhc3NMaXN0KS5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIHgmJnguaW5kZXhPZignbmctJykhPT0wJiZ4LmluZGV4T2YoJ21hdC0nKSE9PTAmJnguaW5kZXhPZignY2RrLScpIT09MCYmeC5pbmRleE9mKCdfbmcnKSE9PTA7fSk7dmFyIGF0aG1hPWNsLmZpbmQoZnVuY3Rpb24oeCl7cmV0dXJuIHguaW5kZXhPZignYXRobWEtJyk9PT0wJiZ4LmluZGV4T2YoJy1tb2R1bGUtaWNvbicpPjA7fSk7aWYoYXRobWEpcmV0dXJuICcuJythdGhtYTt2YXIgc2I9Y2wuZmluZChmdW5jdGlvbih4KXtyZXR1cm4geC5pbmRleE9mKCdzYi1pY29uJyk9PT0wfHx4LmluZGV4T2YoJ2ljb24tYXRobWEnKT09PTA7fSk7aWYoc2IpcmV0dXJuICcuJytzYjt2YXIgc3RhYmxlQ2w9Y2wuZmlsdGVyKGZ1bmN0aW9uKHgpe3JldHVybiB4Lmxlbmd0aD4zJiYheC5tYXRjaCgvYWN0aXZlfHNlbGVjdGVkfG9wZW58c2hvd3xmb2N1c3xob3Zlci8pO30pLnNsaWNlKDAsMikuam9pbignLicpO2lmKHN0YWJsZUNsKXt2YXIgc3g9dGFnKycuJytzdGFibGVDbDt0cnl7aWYoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzeCkubGVuZ3RoPT09MSlyZXR1cm4gc3g7fWNhdGNoKGUpe319dmFyIHBhcj1lbC5wYXJlbnRFbGVtZW50O2lmKCFwYXIpcmV0dXJuIHRhZzt2YXIgaWM9ZWwuY2xvc2VzdCgnLmF0aG1hLXBoYXJtYWN5LW1vZHVsZS1pY29uLC5zaWRlYmFyLW1haW5tZW51LWl0ZW0nKTtpZighaWMmJmVsLmNsb3Nlc3QoJ2poaS1zaWRlYmFyJykpe3ZhciBzcD1lbC5xdWVyeVNlbGVjdG9yKCcuYXRobWEtbW9kdWxlLWljb24sLnNiLWljb24sW2NsYXNzKj0iLW1vZHVsZS1pY29uIl0nKTtpZihzcCl7dmFyIG1jPUFycmF5LmZyb20oc3AuY2xhc3NMaXN0KS5maW5kKGZ1bmN0aW9uKHgpe3JldHVybiB4LmluZGV4T2YoJ2F0aG1hLScpPT09MDt9KTtpZihtYylyZXR1cm4gJy4nK21jO312YXIgc2liPUFycmF5LmZyb20ocGFyLmNoaWxkcmVuKTt2YXIgaWR4PXNpYi5pbmRleE9mKGVsKSsxO3ZhciBwc2VsPWdzKHBhcik7cmV0dXJuIHBzZWwrJz4nK3RhZysnOm50aC1jaGlsZCgnK2lkeCsnKSc7fXZhciBpPUFycmF5LmZyb20ocGFyLmNoaWxkcmVuKS5pbmRleE9mKGVsKSsxO3JldHVybiBncyhwYXIpKyc+Jyt0YWcrJzpudGgtY2hpbGQoJytpKycpJzt9ZnVuY3Rpb24gb2MoZSl7dmFyIGVsPWUudGFyZ2V0O2lmKCFlbHx8ZWw9PT1kb2N1bWVudC5ib2R5fHxlbC5jbG9zZXN0KCcjX19uYXRfXycpKXJldHVybjtpZihbJ2lucHV0JywndGV4dGFyZWEnLCdzZWxlY3QnXS5pbmRleE9mKGVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKSk+PTApcmV0dXJuO3NuZCh7YWN0aW9uOidjbGljaycsaGlnaGxpZ2h0OnRydWUsc2VsZWN0b3I6Z3MoZWwpLHZhbHVlOicnfSk7fWZ1bmN0aW9uIG9jaChlKXt2YXIgZWw9ZS50YXJnZXQ7aWYoIWVsfHxlbC5jbG9zZXN0KCcjX19uYXRfXycpKXJldHVybjtlbC5zdHlsZS5vdXRsaW5lPSc0cHggc29saWQgIzIyZDNhMCc7c2V0VGltZW91dChmdW5jdGlvbigpe2VsLnN0eWxlLm91dGxpbmU9Jyc7fSw0MDApO3ZhciBzPWdzKGVsKSx0PWVsLnRhZ05hbWUudG9Mb3dlckNhc2UoKTtpZih0PT09J3NlbGVjdCcpc25kKHthY3Rpb246J3NlbGVjdCcsc2VsZWN0b3I6cyx2YWx1ZTplbC52YWx1ZX0pO2Vsc2UgaWYodD09PSdpbnB1dCcmJmVsLnR5cGU9PT0nY2hlY2tib3gnKXNuZCh7YWN0aW9uOmVsLmNoZWNrZWQ/J2NoZWNrJzondW5jaGVjaycsaGlnaGxpZ2h0OnRydWUsc2VsZWN0b3I6cyx2YWx1ZTonJ30pO2Vsc2UgaWYodD09PSdpbnB1dCd8fHQ9PT0ndGV4dGFyZWEnKXNuZCh7YWN0aW9uOid0eXBlJyxzZWxlY3RvcjpzLHZhbHVlOmVsLnZhbHVlfSk7fWRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvYyx0cnVlKTtkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLG9jaCx0cnVlKTtzbmQoe2FjdGlvbjonbmF2aWdhdGUnLHNlbGVjdG9yOicnLHZhbHVlOmxvY2F0aW9uLmhyZWZ9KTtmdW5jdGlvbiBjcHkoKXt2YXIgc3Q9bGQoKTt0cnl7bmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQoSlNPTi5zdHJpbmdpZnkoc3QpKS50aGVuKGZ1bmN0aW9uKCl7YWxlcnQoJ0NvcGllZCAnK3N0Lmxlbmd0aCsnIHN0ZXBzISBQYXN0ZSBpbiBOQVQgcmVjb3JkZXIuJyk7fSk7fWNhdGNoKGV4KXt2YXIgdGE9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgndGV4dGFyZWEnKTt0YS52YWx1ZT1KU09OLnN0cmluZ2lmeShzdCk7ZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZCh0YSk7dGEuc2VsZWN0KCk7ZG9jdW1lbnQuZXhlY0NvbW1hbmQoJ2NvcHknKTt0YS5yZW1vdmUoKTthbGVydCgnQ29waWVkICcrc3QubGVuZ3RoKycgc3RlcHMhJyk7fX1mdW5jdGlvbiBzdG9wKCl7ZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcignY2xpY2snLG9jLHRydWUpO2RvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsb2NoLHRydWUpO2lmKHdzKXt3cy5jbG9zZSgpO3dzPW51bGw7fXZhciB0Yj1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnX19uYXRfXycpO2lmKHRiKXRiLnJlbW92ZSgpO2RvY3VtZW50LmJvZHkuc3R5bGUubWFyZ2luVG9wPScnO3dpbmRvdy5fX05BVF9SRUNfXz1mYWxzZTtjcHkoKTt9dHJ5e3dzPW5ldyBXZWJTb2NrZXQoVysnP2Jvb2ttYXJrUmVjb3JkZXI9JytzaWQpO3dzLm9ub3Blbj1mdW5jdGlvbigpe3ZhciBlPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdfbnMnKTtpZihlKWUudGV4dENvbnRlbnQ9J0Nvbm5lY3RlZCc7fTt3cy5vbmNsb3NlPWZ1bmN0aW9uKCl7dmFyIGU9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoJ19ucycpO2lmKGUpZS50ZXh0Q29udGVudD0nRGlzY29ubmVjdGVkJzt9O31jYXRjaChlKXt9dmFyIHN0PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7c3QudGV4dENvbnRlbnQ9J0BrZXlmcmFtZXMgbmF0cHswJSwxMDAle29wYWNpdHk6MX01MCV7b3BhY2l0eTowLjN9fSc7ZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdCk7dmFyIHRiPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpO3RiLmlkPSdfX25hdF9fJzt0Yi5zdHlsZS5jc3NUZXh0PSdwb3NpdGlvbjpmaXhlZDt0b3A6MDtsZWZ0OjA7cmlnaHQ6MDt6LWluZGV4OjIxNDc0ODM2NDc7YmFja2dyb3VuZDojMWUyOTNiO2JvcmRlci1ib3R0b206M3B4IHNvbGlkICNlNTM5MzU7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O3BhZGRpbmc6NnB4IDEycHg7Zm9udC1mYW1pbHk6QXJpYWwsc2Fucy1zZXJpZjtmb250LXNpemU6MTNweDtjb2xvcjojZTJlOGYwJzt0Yi5pbm5lckhUTUw9JzxzcGFuIHN0eWxlPSJ3aWR0aDoxMHB4O2hlaWdodDoxMHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2U1MzkzNTtkaXNwbGF5OmlubGluZS1ibG9jaztmbGV4LXNocmluazowO2FuaW1hdGlvbjpuYXRwIDFzIGluZmluaXRlIj48L3NwYW4+PGIgc3R5bGU9ImNvbG9yOiNmZmY7ZmxleC1zaHJpbms6MCI+TkFUIFJlY29yZGVyPC9iPjxzcGFuIGlkPSJfbmMiIHN0eWxlPSJiYWNrZ3JvdW5kOiMwZjE3MmE7Y29sb3I6IzIyZDNhMDtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoycHggMTBweDtmb250LXNpemU6MTJweDtmb250LWZhbWlseTptb25vc3BhY2U7Zm9udC13ZWlnaHQ6NzAwO3doaXRlLXNwYWNlOm5vd3JhcCI+MCBzdGVwczwvc3Bhbj48c3BhbiBpZD0iX25zIiBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6Izk0YTNiODtmbGV4OjEiPkNvbm5lY3RpbmcuLi48L3NwYW4+PGJ1dHRvbiBvbmNsaWNrPSJ3aW5kb3cuX05BVENQWSgpIiBzdHlsZT0iYmFja2dyb3VuZDojMjU2M2ViO2NvbG9yOiNmZmY7Ym9yZGVyOm5vbmU7Ym9yZGVyLXJhZGl1czo1cHg7cGFkZGluZzo0cHggMTJweDtjdXJzb3I6cG9pbnRlcjtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo3MDA7d2hpdGUtc3BhY2U6bm93cmFwIj5Db3B5IFN0ZXBzPC9idXR0b24+PGJ1dHRvbiBvbmNsaWNrPSJ3aW5kb3cuX19OQVRfU1RPUF9fKCkiIHN0eWxlPSJiYWNrZ3JvdW5kOiNlNTM5MzU7Y29sb3I6I2ZmZjtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjVweDtwYWRkaW5nOjRweCAxMnB4O2N1cnNvcjpwb2ludGVyO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDt3aGl0ZS1zcGFjZTpub3dyYXAiPlN0b3AgJmFtcDsgQ29weTwvYnV0dG9uPic7ZG9jdW1lbnQuYm9keS5zdHlsZS5tYXJnaW5Ub3A9JzQ2cHgnO2RvY3VtZW50LmJvZHkuaW5zZXJ0QmVmb3JlKHRiLGRvY3VtZW50LmJvZHkuZmlyc3RDaGlsZCk7d2luZG93Ll9fTkFUX1NUT1BfXz1zdG9wO3dpbmRvdy5fTkFUQ1BZPWNweTt1cGQoKTt9KSgpOw==");


  const startRecording = () => {
    recStepsRef.current = [];
    setRecSteps([]);
    setRecScript('');
    setRecSession({ status: 'waiting' });
    setRecEditing(false);
    const ws = new WebSocket(`${WS}?bookmarkRecorder=listen`);
    ws.onopen    = () => setRecSession({ status: 'recording' });
    ws.onclose   = () => {};
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'NAT_STEP') {
          recStepsRef.current = [...recStepsRef.current, msg.step];
          setRecSteps(prev => [...prev, msg.step]);
        }
        if (msg.type === 'recorder_step' && msg.step) {
          recStepsRef.current = [...recStepsRef.current, msg.step];
          setRecSteps(prev => [...prev, msg.step]);
          setRecSession({ status: 'recording', source: 'extension' });
        }
        if (msg.type === 'recorder_started') {
          setRecSession({ status: 'recording', source: 'extension', session_id: msg.session_id });
        }
        if (msg.type === 'recorder_stopped') {
          if (msg.steps && msg.steps.length > recStepsRef.current.length) {
            const clean = msg.steps.map(step => ({
              ...step,
              selector: step.selector ? smartSel(step.selector) : step.selector,
            }));
            recStepsRef.current = clean;
            setRecSteps(clean);
          }
          setRecSession(prev => ({ ...(prev||{}), status: 'stopped' }));
        }
      } catch {}
    };
    recWsRef.current = ws;
  };

  const stopRecording = () => {
    if (recWsRef.current) { recWsRef.current.close(); recWsRef.current = null; }
    const steps = recStepsRef.current;
    // ── Simplify selectors immediately on stop ──
    const cleanSteps = steps.map(step => ({
      ...step,
      selector: step.selector ? smartSel(step.selector) : step.selector,
    }));
    recStepsRef.current = cleanSteps;
    setRecSession({ status: 'stopped' });
    setRecSteps([...cleanSteps]);
    const lines = cleanSteps.map(s => {
      if (s.action==='navigate') return `page.goto("${s.value}")`;
      if (s.action==='click')    return `page.locator("${s.selector}").click()`;
      if (s.action==='type')     return `page.locator("${s.selector}").fill("${s.value}")`;
      if (s.action==='select')   return `page.locator("${s.selector}").select_option("${s.value}")`;
      if (s.action==='check')    return `page.locator("${s.selector}").check()`;
      if (s.action==='uncheck')  return `page.locator("${s.selector}").uncheck()`;
      return '';
    }).filter(Boolean);
    setRecScript(lines.join('\n'));
  };

  const saveRecording = async () => {
    if (!recName.trim()) return alert('Please enter a test case name');
    if (!recProject)     return alert('Please select a project');
    const steps = recStepsRef.current;
    if (!steps.length)   return alert('No steps recorded — click the NAT Record bookmarklet on your app first');
    // ── Simplify fragile recorded selectors before saving ──
    const cleanSteps = steps.map(step => ({
      ...step,
      selector: step.selector ? smartSel(step.selector) : step.selector,
    }));
    setRecSaving(true);
    try {
      await api('/api/tests', { method:'POST', body:{
        name:        recName,
        description: `Recorded via ATHMA on ${new Date().toLocaleDateString('en-IN')}`,
        type: 'ui', browser: 'chrome',
        project_id: recProject, suite_id: null,
        priority:   recSuite || 'medium',
        steps:      cleanSteps, variables: [], tags: ['recorded'],
      }});
      setRecModal(false); setRecSession(null); setRecScript(''); setRecName(''); setRecSuite('medium');
      recStepsRef.current = []; setRecSteps([]);
      loadTests();
      alert(`\u2713 Test case saved with ${steps.length} steps!`);
    } catch(err) { alert(err.message); }
    finally { setRecSaving(false); }
  };

  const closeRecorder = () => {
    if (recWsRef.current) { recWsRef.current.close(); recWsRef.current = null; }
    recStepsRef.current = [];
    setRecModal(false); setRecSession(null); setRecScript(''); setRecSteps([]); setRecEditing(false);
    setRecPasteJson(''); setRecPasteErr('');
  };

  const importPastedSteps = () => {
    setRecPasteErr('');
    try {
      const parsed = JSON.parse(recPasteJson.trim());
      const steps = Array.isArray(parsed) ? parsed : (parsed.steps || []);
      if (!steps.length) { setRecPasteErr('No steps found in pasted JSON'); return; }
      recStepsRef.current = steps;
      setRecSteps(steps);
      setRecSession({ status: 'stopped' });
      setRecPasteJson('');
      alert(`✓ ${steps.length} steps imported! Now enter a name and save.`);
    } catch(e) { setRecPasteErr('Invalid JSON — copy the full text from the alert box'); }
  };

  const filtered = tests.filter(t => {
    const q = search.toLowerCase();
    return !q || t.name.toLowerCase().includes(q) || (t.tags||[]).some(x=>x.includes(q));
  });

  const FIELD_MAX = { name:255, description:2000, base_url:500, tags:500 };

  const F = (label, key, type = "text", opts) => (
    <div>
      <label style={s.label}>
        {label}
        {FIELD_MAX[key] && <span style={{fontSize:10,color:"#9ca3af",marginLeft:6,fontWeight:400}}>max {FIELD_MAX[key]}</span>}
      </label>
      {type === "select"
        ? <select style={s.input} value={form[key]||""} onChange={e => setForm(f=>({...f,[key]:e.target.value}))}>
            <option value="">— Select —</option>
            {(opts||[]).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        : type === "textarea"
        ? <textarea style={{ ...s.input, height: 60, resize: "vertical" }} maxLength={FIELD_MAX[key]||undefined} value={form[key]||""} onChange={e => setForm(f=>({...f,[key]:e.target.value}))} />
        : <input style={s.input} type={type} maxLength={FIELD_MAX[key]||undefined} value={form[key]||""} onChange={e => setForm(f=>({...f,[key]:e.target.value}))} />
      }
    </div>
  );

  return (
    <div style={s.col}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ fontSize:22, fontWeight:800, color:"#8B0000" }}>{"\uD83E\uDDEA"} Test Cases</div>
        <div style={{ display:"flex", gap:10 }}>
          {canEdit && (
            <button style={{ ...s.btn("ghost"), border:"1px solid #e53935", color:"#e53935",
              display:"flex", alignItems:"center", gap:6, fontWeight:600 }}
              onClick={()=>{ setRecModal(true); setRecSession(null); setRecSteps([]); setRecName(""); setRecSuite("medium"); }}>
              <span style={{ width:10, height:10, borderRadius:"50%", background:"#e53935",
                display:"inline-block", animation:"none" }} />
              Record
            </button>
          )}
          {canEdit && (
            <button
              title="Download ATHMA Chrome Extension — install it in Chrome to start recording"
              onClick={() => {
                const token = localStorage.getItem('autoqa_token');
                const a = document.createElement('a');
                a.href = `${window.location.protocol}//${window.location.hostname}:6001/api/extension/download?token=${token}`;
                a.download = 'ATHMA-Extension.zip';
                a.click();
              }}
              style={{ ...s.btn('ghost'), border:'1px solid #e53935', color:'#e53935',
                display:'flex', alignItems:'center', gap:5, fontWeight:600, fontSize:12 }}>
              🧩
              <span style={{ fontSize:10, opacity:0.8 }}>Get Extension ⬇️</span>
            </button>
          )}
          {canEdit && <button style={s.btn("primary")} onClick={openAdd}>+ New Test</button>}
        </div>
      </div>

      {/* ── FILTER BAR ─────────────────────────────────────────────── */}
      <div style={{ ...s.card, padding:"12px 16px" }}>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {!jqlMode ? (
            <div style={{ position:"relative", flex:1 }}>
              <span style={{ position:"absolute", left:10, top:"50%",
                transform:"translateY(-50%)", color:"#9ca3af", fontSize:13,
                pointerEvents:"none" }}>{"\uD83D\uDD0D"}</span>
              <input style={{ ...s.input, paddingLeft:32, margin:0, width:"100%" }}
                placeholder="Search by name..."
                value={search} onChange={e=>setSearch(e.target.value)} />
            </div>
          ) : (
            <div style={{ flex:1, display:"flex", alignItems:"center", gap:6,
              background:"#f8f9fc",
              border:"1.5px solid " + (jqlError?"#fca5a5":"#1a56db"),
              borderRadius:8, padding:"6px 12px" }}>
              <span style={{ fontSize:10, fontWeight:700, color:"#1a56db",
                background:"#dbeafe", padding:"2px 7px", borderRadius:4,
                letterSpacing:"0.06em", flexShrink:0, fontFamily:"monospace" }}>JQL</span>
              <input
                autoFocus
                style={{ flex:1, border:"none", background:"transparent",
                  fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                  color:"#1a2332", outline:"none", minWidth:0 }}
                placeholder={`Project = "Patient Portal" AND Priority = high AND Status = failed`}
                value={jql}
                onChange={e=>{ setJql(e.target.value); jqlRef.current=e.target.value; setJqlError(""); }}
                onKeyDown={e=>{ if(e.key==="Enter") loadTests(1); }}
              />
              {jql && (
                <span onClick={()=>{ setJql(""); jqlRef.current=""; setJqlError(""); }}
                  style={{ cursor:"pointer", color:"#9ca3af", fontSize:16, lineHeight:1 }}>{"×"}</span>
              )}
              <button onClick={()=>loadTests(1)}
                style={{ ...s.btn("primary",true), fontSize:12, padding:"5px 14px",
                  background:"#1a56db", borderColor:"#1a56db", flexShrink:0 }}>
                Run
              </button>
            </div>
          )}

          {!jqlMode && (
            <select style={{ ...s.input, width:180, margin:0 }}
              value={projFilter} onChange={e=>setProj(e.target.value)}>
              <option value="">All Projects</option>
              {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}

          <button
            onClick={()=>{ setJqlMode(v=>!v); setJql(""); jqlRef.current=""; setJqlError(""); setSearch(""); }}
            style={{ ...s.btn(jqlMode?"primary":"ghost",true), fontSize:12,
              padding:"7px 14px", flexShrink:0,
              background: jqlMode?"#1a56db":"#fff",
              borderColor: jqlMode?"#1a56db":"#e5e7eb",
              color: jqlMode?"#fff":"#6b7280",
              fontWeight:600 }}>
            JQL
          </button>
        </div>

        {jqlMode && (
          <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid #f3f4f6" }}>
            {jqlError && (
              <div style={{ fontSize:11, color:"#dc2626", marginBottom:6 }}>{"\u26A0\uFE0F"} {jqlError}</div>
            )}
            <div style={{ fontSize:11, lineHeight:2, display:"flex",
              flexWrap:"wrap", gap:4, alignItems:"center" }}>
              <span style={{ color:"#6b7280", fontWeight:600, fontSize:11 }}>Supported:</span>
              {[
                {label:'Project = "name"',     insert:'Project = "'},
                {label:'Project IN ("A","B")',  insert:'Project IN ("'},
                {label:'Priority = high',       insert:'Priority = high'},
                {label:'Priority = medium',     insert:'Priority = medium'},
                {label:'Priority = low',        insert:'Priority = low'},
                {label:'Priority in (high,medium)', insert:'Priority in (high,medium)'},
                {label:'Status = passed',       insert:'Status = passed'},
                {label:'Status = failed',       insert:'Status = failed'},
                {label:'Status = never',        insert:'Status = never'},
                {label:'Status in (passed,failed)', insert:'Status in (passed,failed)'},
                {label:'Type = ui',             insert:'Type = ui'},
                {label:'Type = api',            insert:'Type = api'},
                {label:'Tag = smoke',           insert:'Tag = smoke'},
                {label:'name ~ "login"',        insert:'name ~ "'},
              ].map(item => (
                <span key={item.label}
                  onClick={()=>{
                    const cur = jqlRef.current.trim();
                    const next = cur ? cur + " AND " + item.insert : item.insert;
                    setJql(next); jqlRef.current = next;
                    setTimeout(()=>loadTests(1), 0);
                  }}
                  style={{ cursor:"pointer", fontSize:10, fontFamily:"'IBM Plex Mono',monospace",
                    background:"#eff6ff", color:"#1a56db", border:"1px solid #bfdbfe",
                    borderRadius:4, padding:"1px 7px", whiteSpace:"nowrap",
                    transition:"all 0.1s" }}
                  onMouseEnter={e=>{ e.target.style.background="#dbeafe"; }}
                  onMouseLeave={e=>{ e.target.style.background="#eff6ff"; }}>
                  {item.label}
                </span>
              ))}
            </div>
            {projects?.length > 0 && (
              <div style={{ fontSize:11, color:"#9ca3af", marginTop:3,
                fontFamily:"'IBM Plex Mono',monospace" }}>
                <span style={{ color:"#6b7280", fontWeight:600 }}>Projects: </span>
                {projects.map(p => (
                  <span key={p.id}
                    onClick={()=>{
                      setJql(`Project = "${p.name}"`);
                      jqlRef.current = `Project = "${p.name}"`;
                      setTimeout(()=>loadTests(1),0);
                    }}
                    style={{ cursor:"pointer", color:"#1a56db", marginRight:8,
                      textDecoration:"underline", textDecorationStyle:"dotted" }}>
                    {p.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading && tests.length === 0 ? <Spinner /> : (
        <div style={s.card}>
          {loading && <div style={{ height:2, background:"linear-gradient(90deg,#1a56db,#3b82f6)", borderRadius:2, marginBottom:4, opacity:0.7 }} />}
          <table style={s.table}>
            <thead>
              <tr>{["Test Name","Module","Browser","Priority","Last Run","Status","Actions"].map(h=><th key={h} style={s.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {tests.map(t => (
                <tr key={t.id}>
                  <td style={s.td}>
                    <div style={{ fontWeight:700 }}>{t.name}</div>
                    {t.project_name && (
                      <div style={{ fontSize:11, color:"#1a56db", marginTop:2,
                        display:"flex", alignItems:"center", gap:4 }}>
                        <span style={{ width:6, height:6, borderRadius:"50%",
                          background:"#1a56db", flexShrink:0 }}/>
                        {t.project_name}
                      </div>
                    )}
                    <div style={{ marginTop:3, display:"flex", gap:4, flexWrap:"wrap" }}>
                      {(t.tags||[]).map(tag=><span key={tag} style={s.tag}>{tag}</span>)}
                    </div>
                  </td>
                  <td style={{ ...s.td, fontSize:12, color:"#6b7280" }}>{t.module_name||"\u2014"}</td>
                  <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:"#4a5568" }}>{t.browser}</td>
                  <td style={s.td}><span style={{ color: priorityColor[t.priority]||"#4a5568", fontWeight:700, fontSize:12 }}>{t.priority?.toUpperCase()}</span></td>
                  <td style={{ ...s.td, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", color:"#8a96a8" }}>{t.last_run ? new Date(t.last_run).toLocaleDateString() : "Never"}</td>
                  <td style={s.td}>{t.last_status ? <Badge status={t.last_status} /> : <span style={{color:"#8a96a8",fontSize:12}}>\u2014</span>}</td>
                  <td style={s.td}>
                    <div style={{ display:"flex", gap:6 }}>
                      <button onClick={()=>onRun(t)}
                        style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                          cursor:"pointer", border:"1px solid #bbf7d0",
                          background:"#f0fdf4", color:"#15803d" }}>
                        {"\u25B6"} Run
                      </button>
                      {canEdit && (
                        <button onClick={()=>openEdit(t)}
                          style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                            cursor:"pointer", border:"1px solid #e0e7ff",
                            background:"#eef2ff", color:"#4338ca" }}>
                          Edit
                        </button>
                      )}
                      {canEdit && (
                        <button onClick={()=>copyTest(t)}
                          title="Copy this test case"
                          style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                            cursor:"pointer", border:"1px solid #d1fae5",
                            background:"#f0fdf4", color:"#065f46" }}>
                          Copy
                        </button>
                      )}
                      {["superadmin","admin","lead"].includes(user?.role) && (
                        <button onClick={()=>deleteTest(t.id)}
                          style={{ padding:"3px 10px", borderRadius:5, fontSize:11, fontWeight:600,
                            cursor:"pointer", border:"1px solid #fecaca",
                            background:"#fff5f5", color:"#dc2626" }}>
                          Del
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {tests.length===0 && !loading && <tr><td colSpan={7}><Empty msg="No tests found" /></td></tr>}
            </tbody>
          </table>
          <Pagination page={tcPage} pages={tcPages} total={tcTotal} pageSize={getAppPageSize()}
            onPage={pg => loadTests(pg)} />
        </div>
      )}


      {recModal && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}
          onClick={e => e.target === e.currentTarget && closeRecorder()}>
          <div style={{ background:'#fff', borderRadius:12,
            boxShadow:'0 8px 40px rgba(0,0,0,0.22)', width:'100%', maxWidth:840,
            maxHeight:'92vh', display:'flex', flexDirection:'column',
            border:'1px solid #e2e6ed' }}>

            {/* Header */}
            <div style={{ padding:'16px 24px', borderBottom:'1px solid #e2e6ed',
              display:'flex', alignItems:'center', justifyContent:'space-between',
              borderRadius:'12px 12px 0 0',
              background: recSession?.status==='recording' ? '#fff8f8' : '#fff' }}>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                <div style={{ width:12, height:12, borderRadius:'50%', flexShrink:0,
                  background: recSession?.status==='recording' ? '#e53935'
                    : recSession?.status==='stopped' ? '#00a86b' : '#1a56db',
                  boxShadow: recSession?.status==='recording' ? '0 0 0 4px #e5393530' : 'none' }} />
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:'#1a2332' }}>
                    {"🔴"} ATHMA Recorder
                  </div>
                  <div style={{ fontSize:12, color:'#8a96a8' }}>
                    {!recSession
                      ? 'Enter your app URL to start recording'
                      : recSession.status==='recording'
                      ? `Recording — ${recSteps?.length || 0} steps captured`
                      : `${recSteps?.length || 0} steps ready — fill details and save`}
                  </div>
                </div>
              </div>
              <button onClick={closeRecorder}
                style={{ background:'none', border:'none', fontSize:22,
                  cursor:'pointer', color:'#8a96a8', lineHeight:1 }}>×</button>
            </div>

            <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

              {/* Left panel */}
              <div style={{ width:300, borderRight:'1px solid #e2e6ed', padding:20,
                display:'flex', flexDirection:'column', gap:14, overflowY:'auto' }}>

                {/* PHASE 1 — no session or pending more: ask for URL */}
                {(!recSession || recSession?.status === 'pending_more') && (<>
                  <div style={{ fontSize:13, fontWeight:700, color:'#1a2332' }}>Enter App URL</div>
                  <div>
                    <label style={{ fontSize:11, fontWeight:700, color:'#6b7280',
                      letterSpacing:'0.08em', textTransform:'uppercase',
                      display:'block', marginBottom:6 }}>URL *</label>
                    <input autoFocus type="url"
                      style={{ ...s.input, margin:0, width:'100%', boxSizing:'border-box',
                        border:'1.5px solid #1a56db' }}
                      placeholder="https://your-app.example.com"
                      value={recStartUrl}
                      onChange={e => setRecStartUrl(e.target.value)}
                      onKeyDown={e => {
                        if (e.key !== 'Enter' || !recStartUrl.trim()) return;
                        const url = recStartUrl.trim().startsWith('http')
                          ? recStartUrl.trim() : 'https://' + recStartUrl.trim();
                        recStepsRef.current = []; setRecSteps([]);
                        setRecSession({ status:'recording', url });
                        const extId = window.__ATHMA_EXT_ID__ || localStorage.getItem('athma_ext_id');
                        if (extId) {
                          try {
                            window.chrome.runtime.sendMessage(extId,
                              { type:'nat_start_recording', url },
                              (resp) => { if (chrome.runtime.lastError || !resp?.ok) window.open(url, '_blank'); });
                            return;
                          } catch(err) {}
                        }
                        window.open(url, '_blank');
                      }}
                    />
                  </div>
                  <button
                    disabled={!recStartUrl.trim()}
                    style={{ ...s.btn('primary'), padding:11, fontSize:13,
                      background: recStartUrl.trim() ? '#1a56db' : '#93c5fd',
                      cursor: recStartUrl.trim() ? 'pointer' : 'not-allowed',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}
                    onClick={() => {
                      const url = recStartUrl.trim().startsWith('http')
                        ? recStartUrl.trim() : 'https://' + recStartUrl.trim();
                      recStepsRef.current = []; setRecSteps([]);
                      setRecSession({ status:'recording', url });
                      // Try to tell extension to open URL and auto-start recording
                      const extId = window.__ATHMA_EXT_ID__ || localStorage.getItem('athma_ext_id');
                      if (extId && window.chrome?.runtime?.sendMessage) {
                        window.chrome.runtime.sendMessage(extId,
                          { type: 'nat_start_recording', url },
                          (resp) => {
                            if (!resp?.ok) window.open(url, '_blank');
                          }
                        );
                      } else {
                        // Fallback: just open the URL in new tab
                        window.open(url, '_blank');
                      }
                    }}>
                    <span style={{ fontSize:16 }}>▶</span> Start Recording
                  </button>
                  <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe',
                    borderRadius:8, padding:'10px 12px', fontSize:12,
                    color:'#1e40af', lineHeight:1.8 }}>
                    <b>How it works:</b><br/>
                    1. Enter URL → click <b>Start Recording</b><br/>
                    2. Browser opens your app automatically<br/>
                    3. Perform your actions<br/>
                    4. Click <b>⏹ Stop</b> in the ATHMA extension<br/>
                    5. Click <b>💾 Save to NAT</b> — steps load here
                  </div>
                  {/* Show accumulated steps count when user clicks Record More */}
                  {recSession?.status === 'pending_more' && recSteps?.length > 0 && (
                    <div style={{ background:'#e6f7f1', border:'1px solid #b7edda',
                      borderRadius:8, padding:'10px 14px', fontSize:12,
                      fontWeight:700, color:'#00a86b', textAlign:'center' }}>
                      ✓ {recSteps.length} step{recSteps.length !== 1 ? 's' : ''} captured — new steps will be appended
                    </div>
                  )}
                </>)}

                {/* PHASE 2 — recording */}
                {recSession?.status === 'recording' && (<>
                  <div style={{ background:'#fff8f8', border:'1px solid #fecaca',
                    borderRadius:8, padding:'12px 14px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                      <div style={{ width:9, height:9, borderRadius:'50%',
                        background:'#e53935', flexShrink:0 }} />
                      <span style={{ fontSize:13, fontWeight:700, color:'#c62828' }}>
                        Recording...
                      </span>
                    </div>
                    <div style={{ fontSize:11, color:'#9ca3af', wordBreak:'break-all' }}>
                      {recSession.url}
                    </div>
                  </div>
                  <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0',
                    borderRadius:8, padding:'10px 12px', fontSize:12,
                    color:'#166534', lineHeight:1.7 }}>
                    Do your actions in the browser.<br/>
                    When done → click <b>⏹ Stop</b> in the ATHMA extension → click <b>💾 Save to NAT</b>.
                  </div>
                </>)}

                {/* PHASE 3 — stopped with steps: save form */}
                {recSession?.status === 'stopped' && recSteps?.length > 0 && (<>
                  <div style={{ background:'#e6f7f1', border:'1px solid #b7edda',
                    borderRadius:8, padding:'10px 14px', fontSize:13,
                    fontWeight:700, color:'#00a86b', textAlign:'center' }}>
                    ✓ {recSteps.length} step{recSteps.length !== 1 ? 's' : ''} captured
                  </div>
                  <div style={{ fontSize:13, fontWeight:700, color:'#1a2332' }}>
                    Save as Test Case
                  </div>
                  <div>
                    <label style={s.label}>Test Case Name *</label>
                    <input autoFocus style={{ ...s.input, borderColor: !recName.trim() ? '#fca5a5' : undefined }}
                      placeholder="e.g. Login and navigate to Bay Management"
                      value={recName}
                      onChange={e => setRecName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && saveRecording()} />
                  </div>
                  <div>
                    <label style={s.label}>Project *</label>
                    <select style={{ ...s.input, borderColor: !recProject ? '#fca5a5' : undefined }}
                      value={recProject} onChange={e => setRecProject(e.target.value)}>
                      <option value="">— Select Project —</option>
                      {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={s.label}>Priority</label>
                    <select style={s.input} value={recSuite}
                      onChange={e => setRecSuite(e.target.value)}>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="low">Low</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <button
                    style={{ padding:12, fontSize:13, fontWeight:700, borderRadius:8,
                      background: recSaving ? '#9ca3af' : '#16a34a',
                      color:'#fff', border:'none',
                      cursor: recSaving ? 'not-allowed' : 'pointer',
                      display:'flex', alignItems:'center', justifyContent:'center', gap:8 }}
                    onClick={saveRecording} disabled={recSaving}>
                    {recSaving ? 'Saving...' : '💾 Save as Test Case'}
                  </button>
                  <button
                    style={{ padding:9, fontSize:12, fontWeight:600, borderRadius:8,
                      background:'#fff', color:'#6b7280',
                      border:'1.5px solid #e5e7eb', cursor:'pointer' }}
                    onClick={() => { setRecSession({ status: 'pending_more' }); setRecStartUrl(''); }}>
                    ↩ Record More Steps
                  </button>
                </>)}

                {/* PHASE 3 — stopped with no steps */}
                {recSession?.status === 'stopped' && (!recSteps || recSteps.length === 0) && (
                  <div style={{ background:'#fff7ed', border:'1px solid #fed7aa',
                    borderRadius:8, padding:'14px', textAlign:'center',
                    fontSize:13, color:'#c2410c' }}>
                    No steps were captured.<br/>
                    <button style={{ marginTop:8, color:'#1a56db', background:'none',
                      border:'none', cursor:'pointer', fontWeight:600, fontSize:12 }}
                      onClick={() => { setRecSession(null); setRecStartUrl(''); }}>
                      Try Again
                    </button>
                  </div>
                )}

              </div>

              {/* Right panel — step list */}
              <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

                {!recSession && (
                  <div style={{ flex:1, display:'flex', flexDirection:'column',
                    alignItems:'center', justifyContent:'center', gap:12,
                    padding:40, textAlign:'center', color:'#9ca3af' }}>
                    <div style={{ fontSize:48 }}>🗺️</div>
                    <div style={{ fontSize:15, fontWeight:700, color:'#4a5568' }}>
                      Enter URL to Start Recording
                    </div>
                    <div style={{ fontSize:13, maxWidth:340, lineHeight:1.8, color:'#9ca3af' }}>
                      Enter your app URL on the left and click{' '}
                      <b style={{ color:'#1a56db' }}>Start Recording</b>.
                      The browser will open automatically and recording begins.
                    </div>
                  </div>
                )}

                {(recSession?.status === 'recording' || recSession?.status === 'stopped') && (
                  <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
                    <div style={{ padding:'12px 16px', borderBottom:'1px solid #f0f2f5',
                      display:'flex', alignItems:'center', justifyContent:'space-between',
                      background:'#fafafa' }}>
                      <div style={{ fontSize:13, fontWeight:700, color:'#1a2332' }}>
                        Recorded Steps
                        {recSteps?.length > 0 && (
                          <span style={{ marginLeft:8, background:'#eff6ff', color:'#1a56db',
                            borderRadius:20, padding:'1px 10px', fontSize:11, fontWeight:700 }}>
                            {recSteps.length}
                          </span>
                        )}
                      </div>
                      {recSession?.status === 'recording' && (
                        <div style={{ display:'flex', alignItems:'center', gap:5,
                          fontSize:11, color:'#e53935', fontWeight:700 }}>
                          <div style={{ width:7, height:7, borderRadius:'50%',
                            background:'#e53935' }} /> LIVE
                        </div>
                      )}
                    </div>
                    <div style={{ flex:1, overflowY:'auto', padding:'6px 0' }}>
                      {(!recSteps || recSteps.length === 0) ? (
                        <div style={{ padding:'40px 24px', textAlign:'center',
                          color:'#9ca3af', fontSize:13 }}>
                          {recSession?.status === 'recording'
                            ? 'Perform actions in your browser — steps appear here...'
                            : 'No steps captured'}
                        </div>
                      ) : recSteps.map((st, idx) => (
                        <div key={idx} style={{ display:'flex', alignItems:'flex-start',
                          gap:10, padding:'7px 16px', borderBottom:'1px solid #f9fafb',
                          background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                          <span style={{ fontSize:10, color:'#9ca3af', minWidth:26,
                            textAlign:'right', paddingTop:2, fontFamily:'monospace',
                            flexShrink:0 }}>{idx + 1}.</span>
                          <span style={{
                            background:
                              st.action==='navigate' ? '#eff6ff' :
                              st.action==='click'    ? '#f0fdf4' :
                              st.action==='type'     ? '#fff7ed' : '#f5f3ff',
                            color:
                              st.action==='navigate' ? '#1d4ed8' :
                              st.action==='click'    ? '#16a34a' :
                              st.action==='type'     ? '#d97706' : '#7c3aed',
                            padding:'2px 8px', borderRadius:4, fontSize:10,
                            fontWeight:700, textTransform:'uppercase', flexShrink:0 }}>
                            {st.action}
                          </span>
                          <span style={{ fontSize:12, color:'#374151', lineHeight:1.5,
                            wordBreak:'break-all', flex:1 }}>
                            {st.label || st.selector || st.value || '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>
        </div>
      )}


      {scriptModal && (
        <div style={{ ...s.modal, alignItems:"stretch", padding:"24px" }}>
          <div style={{ background:"#ffffff", borderRadius:10, boxShadow:"0 8px 40px rgba(0,0,0,0.2)",
            display:"flex", flexDirection:"column", width:"100%", maxWidth:860, maxHeight:"90vh",
            border:"1px solid #e2e6ed" }}>
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
                style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:"#8a96a8", lineHeight:1 }}>{"×"}</button>
            </div>
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
            {scriptPreview && (
              <div style={{ padding:"10px 24px", borderTop:"1px solid #e2e6ed",
                background:"#f8f9fc", maxHeight:160, overflowY:"auto" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#4a5568", marginBottom:6,
                  textTransform:"uppercase", letterSpacing:"0.06em" }}>
                  Preview — {scriptPreview.length} step(s) detected
                </div>
                {scriptPreview.map((st,i)=>(
                  <div key={i} style={{ fontSize:12, color:"#1a2332", fontFamily:"'IBM Plex Mono',monospace",
                    padding:"2px 0", borderBottom:"1px solid #f0f2f5" }}>
                    <span style={{ color:"#8a96a8", marginRight:8 }}>#{i+1}</span>
                    <span style={{ color:"#1a6fc4", fontWeight:700, marginRight:8 }}>{st.action}</span>
                    {st.selector && <span style={{ color:"#00a86b", marginRight:6 }}>{st.selector.slice(0,40)}</span>}
                    {st.value    && <span style={{ color:"#f59e0b" }}>"{st.value.slice(0,30)}"</span>}
                  </div>
                ))}
              </div>
            )}
            <div style={{ padding:"14px 24px", borderTop:"1px solid #e2e6ed",
              display:"flex", alignItems:"center", justifyContent:"space-between",
              background:"#f8f9fc" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:12, color:"#4a5568", fontWeight:600 }}>Mode:</span>
                {["replace","append"].map(m=>(
                  <button key={m} onClick={()=>setScriptImportMode(m)}
                    style={{ ...s.btn(scriptImportMode===m?"primary":"ghost",true), fontSize:12 }}>
                    {m==="replace" ? "\u21BA Replace all steps" : "+ Append steps"}
                  </button>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button style={s.btn("ghost")} onClick={()=>{setScriptModal(null);setScriptPreview(null);}}>Cancel</button>
                <button style={{ ...s.btn("ghost",true), borderColor:"#1a6fc4", color:"#1a6fc4" }}
                  onClick={previewScript}>{"\uD83D\uDC41"} Preview</button>
                <button style={s.btn("primary")} onClick={saveScript} disabled={scriptSaving}>
                  {scriptSaving ? "Saving..." : scriptImportMode==="replace" ? "\u21BA Save & Replace Steps" : "+ Save & Append Steps"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div style={s.modal} onClick={e=>{
          if(e.target===e.currentTarget){
            // Warn before closing if user has typed anything
            const hasContent = form.name?.trim() || form.steps?.length > 0 || form.description?.trim();
            if(hasContent){
              if(!window.confirm('You have unsaved changes. Close anyway?')) return;
            }
            setModal(false); setSaveError("");
          }
        }}>
          <div style={{ ...s.modalBox, display:"flex", flexDirection:"column", maxHeight:"92vh", padding:0, overflow:"hidden" }}>
            {/* ── Fixed Header — title only ── */}
            <div style={{ padding:"16px 24px 12px 24px", flexShrink:0, borderBottom:"1px solid #e2e6ed" }}>
              <div style={{ fontSize:17, fontWeight:800, color:"#1a2332", display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                {editing ? "Edit Test" : "New Test Case"}
                {editing && form.name && (
                  <span style={{ fontSize:13, fontWeight:500, color:"#8B0000", background:"#fff0f0", border:"1px solid #fca5a5", borderRadius:6, padding:"2px 10px", maxWidth:320, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {form.name}
                  </span>
                )}
              </div>
            </div>

            {/* ── Scrollable middle — all fields + steps ── */}
            <div style={{ flex:1, overflowY:"auto", padding:"16px 24px", minHeight:0 }}>
            {saveError && (
              <div style={{ background:"#fff5f5", border:"1px solid #fecaca", borderRadius:8,
                padding:"10px 14px", marginBottom:14, fontSize:13, color:"#dc2626",
                display:"flex", alignItems:"flex-start", gap:8 }}>
                <span style={{ fontSize:16, flexShrink:0 }}>{"\u26A0\uFE0F"}</span>
                <span>{saveError}</span>
              </div>
            )}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
              {F("Test Name *",  "name")}
              {F("Project *",   "project_id","select", projects.map(p=>({value:p.id,label:p.name})))}
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"4px 0 8px 0" }}>
                <input type="checkbox" id="healUpdateChk"
                  checked={!!form.heal_update}
                  onChange={e=>setForm(f=>({...f,heal_update:e.target.checked}))}
                  style={{ width:15, height:15, cursor:"pointer", accentColor:"#7c3aed" }}
                />
                <label htmlFor="healUpdateChk" style={{ fontSize:13, color:"#6d28d9", cursor:"pointer", fontWeight:600, display:"flex", alignItems:"center", gap:5 }}>
                  🤖 AI Heal Update
                </label>
                <span style={{ fontSize:11, color:"#94a3b8" }}>(auto-save healed selectors to DB)</span>
              </div>
              {F("Type",        "type",     "select", [{value:"ui",label:"UI (Browser)"},{value:"api",label:"API Test"}])}
              {form.type==="ui" && F("Browser", "browser", "select", [{value:"chrome",label:"Chrome"},{value:"firefox",label:"Firefox"},{value:"edge",label:"Edge"},{value:"safari",label:"Safari"}])}
              <div>
                <label style={s.label}>Module</label>
                <ModuleSelector projectId={form.project_id} value={form.module_id||""} onChange={v=>setForm(f=>({...f,module_id:v}))} />
              </div>
              {F("Priority",    "priority", "select", [{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"critical",label:"Critical"}])}
              {form.type==="ui" && F("Base URL", "base_url")}
              {F("Tags (comma separated)", "tags")}
              <div style={{ gridColumn:"1/-1", display:"flex", alignItems:"center", gap:10,
                padding:"10px 14px", background:"#f0fdf4", border:"1px solid #86efac",
                borderRadius:8, marginTop:4 }}>
                <input type="checkbox" id="is_callable_chk"
                  checked={!!form.is_callable}
                  onChange={e=>setForm(f=>({...f,is_callable:e.target.checked}))}
                  style={{ width:16, height:16, cursor:"pointer", accentColor:"#16a34a" }} />
                <label htmlFor="is_callable_chk" style={{ cursor:"pointer", userSelect:"none" }}>
                  <span style={{ fontSize:13, fontWeight:700, color:"#15803d" }}>
                    {"\uD83D\uDCDE"} Can be called by other test cases
                  </span>
                  <span style={{ fontSize:11, color:"#4ade80", marginLeft:8 }}>
                    Enables this test to appear in the "Call Test Case" search
                  </span>
                </label>
              </div>
            </div>
            {F("Description", "description", "textarea")}
            <div style={{ marginTop:16 }}>
              <VariablesPanel variables={form.variables||[]} onChange={variables=>setForm(f=>({...f,variables}))} />
              {form.type === "ui" ? (
                <div>
                  <div style={{ display:"flex", gap:0, marginBottom:14, borderBottom:"1px solid #e2e6ed" }}>
                    {[["Steps","\uD83D\uDD27 Steps"],["Script","\uD83D\uDCDD Script"]].map(([tab,label]) => (
                      <div key={tab}
                        onClick={()=>setForm(f=>({...f,_editorTab:tab}))}
                        style={{ padding:"8px 20px", cursor:"pointer", fontSize:13, fontWeight:600,
                          color: (form._editorTab||"Steps")===tab ? "#1a6fc4" : "#8a96a8",
                          borderBottom: (form._editorTab||"Steps")===tab ? "2px solid #1a6fc4" : "2px solid transparent",
                          marginBottom:-1, transition:"all 0.15s" }}>
                        {label}
                      </div>
                    ))}
                    <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8, paddingBottom:8 }}>
                      <span style={{ fontSize:11, color:"#8a96a8" }}>
                        {(form.steps||[]).length} step{(form.steps||[]).length !== 1 ? "s" : ""}
                      </span>
                      {(form._editorTab||"Steps") === "Steps" && (
                        <button
                          onClick={()=>setStepsExpanded(true)}
                          title="Expand steps to full screen"
                          style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px", display:"flex", alignItems:"center", gap:4 }}>
                          ⛶ Full Screen
                        </button>
                      )}
                    </div>
                  </div>
                  {(form._editorTab||"Steps") === "Steps"
                    ? <StepEditor steps={form.steps||[]} onChange={steps=>setForm(f=>({...f,steps}))} variables={form.variables||[]} projectId={form.project_id} />
                    : <ScriptEditor steps={form.steps||[]} onChange={steps=>setForm(f=>({...f,steps}))} />
                  }
                  {/* ── Full screen step editor overlay ── */}
                  {stepsExpanded && (
                    <div style={{ position:"fixed", inset:0, zIndex:9999, background:"#ffffff",
                      display:"flex", flexDirection:"column" }}>
                      {/* Header */}
                      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                        padding:"12px 20px", borderBottom:"2px solid #e2e6ed", background:"#f8f9fc",
                        flexShrink:0 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                          <span style={{ fontSize:15, fontWeight:800, color:"#1a2332" }}>🔧 Steps — {form.name||"Test Case"}</span>
                          <span style={{ fontSize:12, color:"#8a96a8" }}>{(form.steps||[]).length} step{(form.steps||[]).length!==1?"s":""}</span>
                        </div>
                        <div style={{ display:"flex", gap:8 }}>
                          <button style={s.btn("ghost")} onClick={()=>setStepsExpanded(false)}>Cancel</button>
                          <button style={s.btn("ghost")} onClick={()=>{ setStepsExpanded(false); save(false); }}>Save</button>
                          <button style={s.btn("primary")} onClick={()=>{ setStepsExpanded(false); save(true); }}>Save &amp; Close</button>
                        </div>
                      </div>
                      {/* Scrollable steps */}
                      <div style={{ flex:1, overflowY:"auto", padding:"16px 24px", minHeight:0 }}>
                        <StepEditor steps={form.steps||[]} onChange={steps=>setForm(f=>({...f,steps}))} variables={form.variables||[]} projectId={form.project_id} />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <label style={{ ...s.label, marginBottom:10 }}>API Configuration</label>
                  <ApiEditor config={form.api_config} onChange={cfg=>setForm(f=>({...f,api_config:cfg}))} />
                </div>
              )}
            </div>
            </div>

            {/* ── Fixed Footer — Cancel / Save buttons ── */}
            <div style={{ padding:"14px 24px", borderTop:"1px solid #e2e6ed", flexShrink:0,
              display:"flex", gap:10, justifyContent:"flex-end", background:"#f8f9fc",
              borderRadius:"0 0 12px 12px" }}>
              <button style={s.btn("ghost")} onClick={()=>{ setModal(false); setSaveError(""); setSavedOk(false); }}>Cancel</button>
              {savedOk && (
                <span style={{ fontSize:12, color:"#16a34a", fontWeight:600,
                  display:"flex", alignItems:"center", gap:4, padding:"0 8px" }}>
                  ✓ Saved
                </span>
              )}
              <button style={s.btn("ghost")} onClick={()=>save(false)}>Save</button>
              <button style={s.btn("primary")} onClick={()=>save(true)}>Save &amp; Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function RunModal({ test, onClose, onStarted }) {
  const [browser,     setBrowser]     = useState(test.browser || "chrome");
  const [running,     setRunning]     = useState(false);
  const [runId,       setRunId]       = useState(null);
  const [logs,        setLogs]        = useState([]);
  const [status,      setStatus]      = useState("queued");
  const [screenshots, setScreenshots] = useState([]);
  const [liveScreen,  setLiveScreen]  = useState(null);
  const [showScreen,  setShowScreen]  = useState(true);
  const [aborting,    setAborting]    = useState(false);
  const [slowWarning, setSlowWarning] = useState(null); // slow run detection
  const wsRef  = useRef(null);
  const logRef = useRef(null);

  const [debugMode,    setDebugMode]    = useState(false);
  const [slowMo,       setSlowMo]       = useState(500);
  const [breakpoints,  setBreakpoints]  = useState(new Set());
  const [debugPaused,  setDebugPaused]  = useState(null);
  const [stepThrough,  setStepThrough]  = useState(false);

  const [parallelMode,    setParallelMode]    = useState(false);
  const [parallelConfigs, setParallelConfigs] = useState([
    { browser:"chrome",  label:"Run 1", variable_overrides:{} },
    { browser:"firefox", label:"Run 2", variable_overrides:{} },
  ]);
  const [parallelRunId,   setParallelRunId]   = useState(null);
  const [parallelRunIds,  setParallelRunIds]  = useState([]);
  const [parallelLogs,    setParallelLogs]    = useState({});
  const [parallelStatus,  setParallelStatus]  = useState({});
  const parallelWsRefs = useRef({});

  const toggleBreakpoint = (idx) => {
    setBreakpoints(prev => {
      const n = new Set(prev);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });
  };

  const sendDebugCommand = async (cmd) => {
    if (!runId) return;
    setDebugPaused(null);
    await api(`/api/runs/${runId}/debug-command`, { method:"POST", body:{ command:cmd } });
  };

  const connectWS = (rid) => {
    const ws = new WebSocket(`${WS}?runId=${rid}`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "log") {
        setLogs(l => [...l, msg].sort((a,b) => (a.seq||0) - (b.seq||0)));
        setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }), 50);
      }
      if (msg.type === "status")       setStatus(msg.status);
      if (msg.type === "screenshot")   setScreenshots(s => [...s, msg]);
      if (msg.type === "live_screen")  setLiveScreen({ data: msg.data, label: msg.label });
      if (msg.type === "debug_paused") setDebugPaused({ stepIndex: msg.step_index, variables: msg.variables });
      if (msg.type === "done")         { setRunning(false); setDebugPaused(null); }
      if (msg.type === "aborted")      { setRunning(false); setStatus("aborted"); setAborting(false); }
      if (msg.type === "slow_run")     setSlowWarning(msg);
    };
  };

  const abortRun = async () => {
    if (!runId) return;
    setAborting(true);
    try {
      await api(`/api/runs/${runId}/abort`, { method: "DELETE" });
    } catch(e) { setAborting(false); alert("Abort failed: " + e.message); }
  };

  const handleClose = () => {
    if (running) {
      if (!window.confirm("Test is still running. Abort and close?")) return;
      abortRun();
    }
    wsRef.current?.close();
    Object.values(parallelWsRefs.current).forEach(ws => { if (ws?.close) ws.close(); });
    onClose(!!runId); // pass true if a run was actually started
  };

  const connectParallelWS = (runId, label, browser) => {
    const ws = new WebSocket(`${WS}?runId=${runId}`);
    parallelWsRefs.current[runId] = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "log") {
        setParallelLogs(prev => ({ ...prev, [runId]: [...(prev[runId]||[]), msg] }));
      }
      if (msg.type === "status") {
        setParallelStatus(prev => {
          const cur = prev[runId];
          if (cur === "passed" || cur === "failed") return prev;
          return { ...prev, [runId]: msg.status };
        });
      }
      if (msg.type === "done") {
        setTimeout(() => {
          api(`/api/runs/${runId}`)
            .then(run => setParallelStatus(prev => ({ ...prev, [runId]: run.status || "failed" })))
            .catch(() => setParallelStatus(prev => ({ ...prev, [runId]: "failed" })));
        }, 500);
      }
    };
    ws.onclose = () => {
      setTimeout(() => {
        api(`/api/runs/${runId}`)
          .then(run => {
            if (["passed","failed","error"].includes(run.status)) {
              setParallelStatus(prev => ({ ...prev, [runId]: run.status }));
            }
          })
          .catch(() => {});
      }, 1500);
    };
  };

  const startParallel = async () => {
    setRunning(true); setParallelLogs({}); setParallelStatus({});
    try {
      const d = await api(`/api/tests/${test.id}/parallel-run`, { method:"POST", body:{ parallel_configs: parallelConfigs } });
      setParallelRunId(d.parallel_run_id);
      const runs = d.run_ids.map((rid,i) => ({ runId:rid, label:parallelConfigs[i]?.label||`Run ${i+1}`, browser:parallelConfigs[i]?.browser||"chrome" }));
      setParallelRunIds(runs);
      const initStatus = {};
      runs.forEach(r => { initStatus[r.runId]="queued"; });
      const pollInterval = setInterval(async () => {
        try {
          const statuses = await Promise.all(runs.map(r => api(`/api/runs/${r.runId}`)));
          const allDone = statuses.every(r => ["passed","failed","error"].includes(r.status));
          if (allDone) {
            const updated = {};
            statuses.forEach((r, i) => { updated[runs[i].runId] = r.status; });
            setParallelStatus(prev => ({ ...prev, ...updated }));
            setRunning(false);
            clearInterval(pollInterval);
          }
        } catch { /* ignore */ }
      }, 5000);
      parallelWsRefs.current._pollInterval = pollInterval;
      setParallelStatus(initStatus);
      runs.forEach(r => connectParallelWS(r.runId, r.label, r.browser));
    } catch(e) { alert(e.message); setRunning(false); }
  };

  const addParallelConfig    = () => setParallelConfigs(prev => [...prev, { browser:"chrome", label:`Run ${prev.length+1}`, variable_overrides:{} }]);
  const removeParallelConfig = (i) => setParallelConfigs(prev => prev.filter((_,idx)=>idx!==i));
  const updateParallelConfig = (i,key,val) => setParallelConfigs(prev => { const n=[...prev]; n[i]={...n[i],[key]:val}; return n; });
  const updateParallelOverride = (i,vn,val) => setParallelConfigs(prev => { const n=[...prev]; n[i]={...n[i],variable_overrides:{...n[i].variable_overrides,[vn]:val}}; return n; });

  const start = async () => {
    setRunning(true); setLogs([]); setScreenshots([]); setDebugPaused(null);
    try {
      const bps = stepThrough
        ? Array.from({ length: (test.steps||[]).length }, (_,i) => i)
        : Array.from(breakpoints);
      const d = debugMode
        ? await api(`/api/tests/${test.id}/debug`, { method:"POST", body:{ browser, slow_mo:slowMo, breakpoints:bps } })
        : await api(`/api/tests/${test.id}/run`,   { method:"POST", body:{ browser } });
      setRunId(d.run_id);
      onStarted && onStarted(d.run_id);
      connectWS(d.run_id);
    } catch (e) { alert(e.message); setRunning(false); }
  };

  useEffect(() => () => {
    wsRef.current?.close();
    Object.values(parallelWsRefs.current).forEach(ws => { if (ws?.close) ws.close(); });
    if (parallelWsRefs.current._pollInterval) clearInterval(parallelWsRefs.current._pollInterval);
  }, []);

  return (
    <div style={s.modal} onClick={e=>e.target===e.currentTarget&&handleClose()}>
      <div style={{ ...s.modalBox, maxWidth: 720 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800 }}>{"\u25B6"} Run Test</div>
            <div style={{ fontSize:13, color:"#8a96a8", marginTop:2 }}>{test.name}</div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            {runId && <Badge status={status} />}
            {running && (
              <button
                onClick={abortRun}
                disabled={aborting}
                style={{ display:"flex", alignItems:"center", gap:6,
                  padding:"6px 14px", borderRadius:7, border:"1.5px solid #e53935",
                  background: aborting ? "#fee2e2" : "#fff5f5", color:"#e53935",
                  fontSize:12, fontWeight:700, cursor: aborting ? "not-allowed" : "pointer" }}>
                {aborting ? "Aborting..." : "\u23f9 Abort"}
              </button>
            )}
            <button onClick={handleClose}
              style={{ background:"none", border:"none", fontSize:22,
                cursor:"pointer", color:"#8a96a8", lineHeight:1, padding:"0 4px" }}>×</button>
          </div>
        </div>

        {slowWarning && (
          <div style={{ margin:"0 0 12px 0", background:"#fff7ed", border:"2px solid #f97316",
            borderRadius:8, padding:"12px 16px", display:"flex", alignItems:"flex-start", gap:10 }}>
            <span style={{ fontSize:20 }}>⚠️</span>
            <div style={{ flex:1 }}>
              <div style={{ fontWeight:700, color:"#c2410c", fontSize:13 }}>Slow Run Detected</div>
              <div style={{ fontSize:12, color:"#7c2d12", marginTop:2 }}>{slowWarning.message}</div>
            </div>
            <button onClick={()=>setSlowWarning(null)}
              style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:"#9ca3af" }}>×</button>
          </div>
        )}

        {!runId && (
          <div style={{ marginBottom:20 }}>
            <div style={{ display:"flex", gap:14, marginBottom:12, alignItems:"flex-end" }}>
              {test.type === "ui" && (
                <div style={{ flex:1 }}>
                  <label style={s.label}>Browser</label>
                  <select style={s.input} value={browser} onChange={e=>setBrowser(e.target.value)}>
                    {["chrome","firefox","edge","safari"].map(b=><option key={b}>{b}</option>)}
                  </select>
                </div>
              )}
              {!parallelMode && (
                <button style={{ ...s.btn("success"), padding:"10px 24px" }} onClick={()=>{setDebugMode(false);start();}}>
                  {"\u25B6"} Run
                </button>
              )}
              {parallelMode && (
                <button style={{ ...s.btn("success"), padding:"10px 24px", background:"#7c3aed" }}
                  onClick={startParallel}>
                  {"\u26A1"} Run Parallel ({parallelConfigs.length})
                </button>
              )}
              {!parallelMode && (
                <button style={{ ...s.btn("warning"), padding:"10px 20px",
                  background:debugMode?"#d97706":"#f59e0b",
                  boxShadow:debugMode?"0 0 0 3px rgba(217,119,6,0.3)":"none" }}
                  onClick={()=>setDebugMode(m=>!m)}>
                  {"\uD83D\uDC1B"} Debug {debugMode?"ON":"OFF"}
                </button>
              )}
              <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer",
                fontSize:12, fontWeight:600,
                color:parallelMode?"#7c3aed":"#6b7280",
                background:parallelMode?"#ede9fe":"#f3f4f6",
                padding:"8px 12px", borderRadius:8,
                border:`1px solid ${parallelMode?"#c4b5fd":"#e5e7eb"}` }}>
                <input type="checkbox" checked={parallelMode}
                  onChange={e=>setParallelMode(e.target.checked)} />
                {"\u26A1"} Parallel
              </label>
            </div>

            {parallelMode && (
              <div style={{ background:"#f5f3ff", border:"1px solid #c4b5fd",
                borderRadius:10, padding:"14px 16px", marginTop:4 }}>
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"center", marginBottom:12 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:"#6b46c1" }}>{"\u26A1"} Parallel Run Configuration</div>
                  <button onClick={addParallelConfig}
                    style={{ ...s.btn("ghost",true), fontSize:12, borderColor:"#7c3aed", color:"#7c3aed" }}>
                    + Add Run
                  </button>
                </div>
                {(() => {
                  const vars = (test.variables||[]).filter(v=>v.type!=="db_query");
                  return (
                    <div style={{ overflowX:"auto" }}>
                      <table style={{ borderCollapse:"collapse", width:"100%", fontSize:12 }}>
                        <thead>
                          <tr style={{ background:"#ede9fe" }}>
                            <th style={{ padding:"6px 10px", border:"1px solid #c4b5fd", color:"#6b46c1", fontWeight:700, minWidth:80 }}>Label</th>
                            <th style={{ padding:"6px 10px", border:"1px solid #c4b5fd", color:"#6b46c1", fontWeight:700, minWidth:90 }}>Browser</th>
                            {vars.map(v => (
                              <th key={v.name} style={{ padding:"6px 10px", border:"1px solid #c4b5fd", color:"#6b46c1", fontWeight:700, minWidth:100 }}>
                                {"{{"+v.name+"}}"}
                              </th>
                            ))}
                            <th style={{ border:"1px solid #c4b5fd", width:28 }}/>
                          </tr>
                        </thead>
                        <tbody>
                          {parallelConfigs.map((cfg, ci) => (
                            <tr key={ci} style={{ background:ci%2===0?"#fff":"#faf5ff" }}>
                              <td style={{ padding:"3px", border:"1px solid #c4b5fd" }}>
                                <input value={cfg.label} onChange={e=>updateParallelConfig(ci,"label",e.target.value)}
                                  style={{ ...s.input, margin:0, fontSize:11, padding:"4px 6px", border:"none", outline:"none", width:"100%", background:"transparent" }} />
                              </td>
                              <td style={{ padding:"3px", border:"1px solid #c4b5fd" }}>
                                <select value={cfg.browser} onChange={e=>updateParallelConfig(ci,"browser",e.target.value)}
                                  style={{ ...s.input, margin:0, fontSize:11, padding:"4px 6px", border:"none", width:"100%", background:"transparent" }}>
                                  {["chrome","firefox","edge","safari"].map(b=><option key={b}>{b}</option>)}
                                </select>
                              </td>
                              {vars.map(v => (
                                <td key={v.name} style={{ padding:"3px", border:"1px solid #c4b5fd" }}>
                                  <input
                                    value={cfg.variable_overrides[v.name]!==undefined ? cfg.variable_overrides[v.name] : (typeof v.config==="object"?v.config?.value||"":v.config||"")}
                                    onChange={e=>updateParallelOverride(ci,v.name,e.target.value)}
                                    style={{ ...s.input, margin:0, fontSize:11, padding:"4px 6px", border:"none", outline:"none", width:"100%", background:"transparent", minWidth:70 }} />
                                </td>
                              ))}
                              <td style={{ padding:"2px", border:"1px solid #c4b5fd", textAlign:"center" }}>
                                {parallelConfigs.length>1 && (
                                  <button onClick={()=>removeParallelConfig(ci)}
                                    style={{ background:"none", border:"none", cursor:"pointer", color:"#e53e3e", fontSize:13 }}>{"\u2715"}</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
                <div style={{ fontSize:11, color:"#6b46c1", marginTop:8 }}>
                  {"\uD83D\uDCA1"} Each row runs simultaneously in its own browser. Edit variable values per row.
                </div>
              </div>
            )}

            {debugMode && (
              <div style={{ background:"#fffbeb", border:"1px solid #f59e0b",
                borderRadius:10, padding:"14px 16px" }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#92400e", marginBottom:12 }}>
                  {"\uD83D\uDC1B"} Debug Options
                </div>
                <div style={{ display:"flex", gap:16, alignItems:"center", flexWrap:"wrap", marginBottom:12 }}>
                  <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:13 }}>
                    <input type="checkbox" checked={stepThrough}
                      onChange={e=>setStepThrough(e.target.checked)} />
                    <span>Pause after <b>every</b> step</span>
                  </label>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontSize:13 }}>Slow motion:</span>
                    <select style={{ ...s.input, margin:0, width:120 }}
                      value={slowMo} onChange={e=>setSlowMo(+e.target.value)}>
                      <option value={0}>Off</option>
                      <option value={300}>Slow (0.3s)</option>
                      <option value={500}>Normal (0.5s)</option>
                      <option value={1000}>Very slow (1s)</option>
                      <option value={2000}>Crawl (2s)</option>
                    </select>
                  </div>
                </div>
                {(test.steps||[]).length > 0 && !stepThrough && (
                  <div>
                    <div style={{ fontSize:12, color:"#92400e", marginBottom:6 }}>
                      {"\uD83D\uDD34"} Click a step number to set a breakpoint:
                    </div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                      {(test.steps||[]).map((step, idx) => (
                        <button key={idx}
                          onClick={()=>toggleBreakpoint(idx)}
                          title={ACTIONS.find(a=>a.value===step.action)?.label||step.action}
                          style={{ width:28, height:28, borderRadius:4, fontSize:11, fontWeight:700,
                            cursor:"pointer", border:"1px solid",
                            background: breakpoints.has(idx)?"#dc2626":"#fff",
                            borderColor: breakpoints.has(idx)?"#dc2626":"#e2e6ed",
                            color: breakpoints.has(idx)?"#fff":"#4a5568" }}>
                          {idx+1}
                        </button>
                      ))}
                    </div>
                    {breakpoints.size > 0 && (
                      <div style={{ fontSize:11, color:"#92400e", marginTop:6 }}>
                        {breakpoints.size} breakpoint{breakpoints.size>1?"s":""} set
                        <button onClick={()=>setBreakpoints(new Set())}
                          style={{ ...s.btn("ghost",true), fontSize:10, marginLeft:8, padding:"2px 6px" }}>
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button style={{ ...s.btn("warning"), marginTop:12, width:"100%" }}
                  onClick={start}>
                  {"\uD83D\uDC1B"} Start Debug Run
                </button>
              </div>
            )}
          </div>
        )}

        {parallelRunId && parallelRunIds.length > 0 && (
          <div style={{ marginTop:16 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ fontSize:14, fontWeight:700, color:"#6b46c1" }}>{"\u26A1"} Parallel Run Results</div>
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                <span style={{ fontSize:12, color:"#8a96a8" }}>
                  {parallelRunIds.filter(r=>parallelStatus[r.runId]==="passed").length} passed /
                  {parallelRunIds.filter(r=>parallelStatus[r.runId]==="failed").length} failed /
                  {parallelRunIds.filter(r=>!["passed","failed"].includes(parallelStatus[r.runId])).length} running
                </span>
                <button onClick={()=>window.open(`${API}/api/parallel-runs/${parallelRunId}/report?token=${localStorage.getItem("autoqa_token")}`,"_blank")}
                  style={{ ...s.btn("primary",true), fontSize:12 }}>{"\uD83D\uDCC4"} Download Report</button>
              </div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:`repeat(${Math.min(parallelRunIds.length,3)},1fr)`, gap:10 }}>
              {parallelRunIds.map(r => {
                const rawSt = parallelStatus[r.runId] || "queued";
                const st = rawSt === "queued" ? "running" : rawSt;
                const logs = parallelLogs[r.runId] || [];
                const sc = st==="passed"?"#22c55e":st==="failed"?"#ef4444":st==="running"?"#f59e0b":"#9ca3af";
                return (
                  <div key={r.runId} style={{ background:"#0f172a", borderRadius:8, border:`1px solid ${sc}33`, overflow:"hidden" }}>
                    <div style={{ padding:"8px 12px", background:"#1e293b", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <div>
                        <span style={{ fontSize:12, fontWeight:700, color:"#e2e8f0" }}>{r.label}</span>
                        <span style={{ fontSize:11, color:"#64748b", marginLeft:6 }}>{r.browser}</span>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                        <div style={{ width:8, height:8, borderRadius:"50%", background:sc }}/>
                        <span style={{ fontSize:11, color:sc, fontWeight:600 }}>{st.toUpperCase()}</span>
                      </div>
                    </div>
                    <div style={{ height:200, overflowY:"auto", padding:"8px 10px", fontFamily:"'IBM Plex Mono',monospace", fontSize:11, lineHeight:1.6 }}>
                      {logs.map((l,i) => {
                          const isSoft = l.message?.includes('[SOFT FAIL]');
                          const isAI   = l.message?.includes('[AI') || l.message?.includes('AI suggestion') || l.message?.includes('AI healed') || l.message?.includes('AI Heal');
                          const col = l.level==="pass"?"#22d3a0":l.level==="fail"?"#ff6b6b":l.level==="error"?"#f97316":isSoft?"#fbbf24":isAI?"#a78bfa":l.level==="warn"?"#fb923c":"#94a3b8";
                          const bg  = isSoft?"rgba(251,191,36,0.12)":isAI?"rgba(167,139,250,0.12)":"transparent";
                          const bl  = isSoft?"3px solid #fbbf24":isAI?"3px solid #a78bfa":"3px solid transparent";
                          return (
                          <div key={i} style={{ marginBottom:isSoft||isAI?4:1, color:col,
                            background:bg, borderLeft:bl,
                            paddingLeft:isSoft||isAI?6:0, borderRadius:isSoft||isAI?3:0 }}>
                            <span style={{ color:"#475569", marginRight:4, fontSize:10 }}>[{l.timestamp?.slice(11,19)}]</span>
                            {isSoft ? <><span style={{background:"#fbbf24",color:"#000",fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:3,marginRight:6}}>SOFT FAIL</span><b>{l.message.replace('[SOFT FAIL]','').trim()}</b></> :
                             isAI   ? <><span style={{background:"#7c3aed",color:"#fff",fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:3,marginRight:6}}>AI</span><b style={{color:"#c4b5fd"}}>{l.message}</b></> :
                             l.message}
                          </div>
                          );
                        })}
                      {st==="queued"  && <div style={{color:"#64748b"}}>{"\u23F3"} Waiting...</div>}
                      {st==="running" && <div style={{color:"#fbbf24"}}>{"\u23F3"} Running...</div>}
                      {st==="passed"  && <div style={{color:"#22c55e",fontWeight:700}}>{"\u2705"} Completed — PASSED</div>}
                      {st==="failed"  && <div style={{color:"#ef4444",fontWeight:700}}>{"\u274C"} Completed — FAILED</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {runId && !parallelRunId && (
          <>
            {/* Live Screen Preview */}
            {liveScreen && showScreen && (
              <div style={{ position:"relative", background:"#0f172a", borderRadius:8,
                overflow:"hidden", border:"1px solid #1e293b" }}>
                <img
                  src={`data:image/jpeg;base64,${liveScreen.data}`}
                  alt="live"
                  style={{ width:"100%", display:"block", maxHeight:320, objectFit:"contain" }}
                />
                <div style={{ position:"absolute", bottom:6, left:8,
                  background:"rgba(0,0,0,0.6)", color:"#94a3b8",
                  fontSize:10, padding:"2px 8px", borderRadius:10,
                  fontFamily:"'IBM Plex Mono',monospace" }}>
                  {liveScreen.label || "Live"}
                </div>
                <button
                  onClick={()=>setShowScreen(false)}
                  style={{ position:"absolute", top:6, right:6,
                    background:"rgba(0,0,0,0.5)", border:"none",
                    color:"#94a3b8", borderRadius:4, cursor:"pointer",
                    fontSize:11, padding:"2px 7px" }}>
                  hide
                </button>
              </div>
            )}
            {!showScreen && liveScreen && (
              <button
                onClick={()=>setShowScreen(true)}
                style={{ ...s.btn("ghost",true), fontSize:11, width:"100%" }}>
                🖥️ Show Live Screen
              </button>
            )}
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <label style={s.label}>Live Logs</label>
                {runId && (
                  <button
                    onClick={()=>window.open(`${API}/live/${runId}`,"_blank","width=1200,height=750,menubar=no,toolbar=no,location=no")}
                    style={{ ...s.btn("primary",true), fontSize:12, display:"flex", alignItems:"center", gap:6 }}>
                    {"\uD83D\uDDA5\uFE0F"} Open Live Screen
                  </button>
                )}
              </div>
              <div ref={logRef} style={{ background:"#0f172a", borderRadius:8, padding:12,
                height:300, overflowY:"auto", fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:1.7 }}>
                <VirtualLogList logs={logs} isRunning={running} />
              </div>
            </div>

            {debugPaused && (
              <div style={{ background:"#fffbeb", border:"2px solid #f59e0b",
                borderRadius:10, padding:"16px 20px", marginTop:16 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                  <div>
                    <div style={{ fontSize:15, fontWeight:700, color:"#92400e" }}>
                      {"\u23F8"} Paused at Step {debugPaused.stepIndex + 1}
                    </div>
                    <div style={{ fontSize:12, color:"#b45309", marginTop:2 }}>
                      {(test.steps||[])[debugPaused.stepIndex]
                        ? ACTIONS.find(a=>a.value===(test.steps||[])[debugPaused.stepIndex].action)?.label
                        : ""}
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button onClick={()=>sendDebugCommand("step")}
                      style={{ ...s.btn("warning"), padding:"8px 16px", fontSize:13 }}>
                      {"\u23ED"} Step
                    </button>
                    <button onClick={()=>sendDebugCommand("skip")}
                      style={{ ...s.btn("ghost"), padding:"8px 14px", fontSize:13 }}>
                      {"\u23E9"} Skip
                    </button>
                    <button onClick={()=>sendDebugCommand("continue")}
                      style={{ ...s.btn("success"), padding:"8px 16px", fontSize:13 }}>
                      {"\u25B6"} Continue
                    </button>
                    <button onClick={()=>sendDebugCommand("stop")}
                      style={{ ...s.btn("danger"), padding:"8px 14px", fontSize:13 }}>
                      {"\u23F9"} Stop
                    </button>
                  </div>
                </div>
                {debugPaused.variables && Object.keys(debugPaused.variables).length > 0 && (
                  <div>
                    <div style={{ fontSize:11, fontWeight:700, color:"#92400e",
                      textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>
                      Variable Watch
                    </div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                      {Object.entries(debugPaused.variables).map(([k,v]) => (
                        <div key={k} style={{ background:"#fff", border:"1px solid #fcd34d",
                          borderRadius:6, padding:"4px 10px", fontSize:12 }}>
                          <span style={{ color:"#92400e", fontFamily:"'IBM Plex Mono',monospace",
                            fontWeight:700 }}>{"{{"+k+"}}"}</span>
                          <span style={{ color:"#4a5568", marginLeft:6 }}>=</span>
                          <span style={{ color:"#1a2332", fontFamily:"'IBM Plex Mono',monospace" }}>
                            {String(v).slice(0,50)}{String(v).length>50?"\u2026":""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {screenshots.length > 0 && (
              <div>
                <label style={s.label}>Captured Screenshots</label>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {screenshots.map((sc,i) => (
                    <a key={i} href={`${API}/api/screenshots/${sc.filename}?token=${getToken()}`} target="_blank" rel="noreferrer">
                      <div style={{ background:"#f0f7ff", border:"1px solid #bdd7f5", borderRadius:6,
                        padding:"6px 10px", fontSize:11, color:"#1a6fc4", cursor:"pointer" }}>
                        {"\uD83D\uDCF7"} {sc.label}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:20 }}>
          <button style={s.btn("ghost")} onClick={onClose} disabled={running}>
            {running ? "Running..." : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}



// ─── VIRTUAL LOG LIST ───────────────────────────────────────────────────────
// Renders only the ~25 rows visible in the 480px window instead of all N rows.
// Identical colour/badge logic to the old logs.map() — drop-in replacement.
function VirtualLogList({ logs, isRunning }) {
  const ROW_H     = 22;   // px per log line (monospace 12px + gap)
  const VISIBLE_H = 300;  // container height in px
  const OVERSCAN  = 5;    // extra rows above/below viewport

  const containerRef  = useRef(null);
  const [scrollTop,   setScrollTop]   = useState(0);
  const [autoScroll,  setAutoScroll]  = useState(true); // follow tail during live run

  // Scroll to bottom whenever new logs arrive (only if autoScroll is on)
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs.length, autoScroll]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    // If user scrolls up, stop auto-following; if they reach the bottom, resume
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    setAutoScroll(atBottom);
  };

  // Which slice of logs is visible?
  const startIdx   = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visibleCnt = Math.ceil(VISIBLE_H / ROW_H) + OVERSCAN * 2;
  const endIdx     = Math.min(logs.length, startIdx + visibleCnt);
  const visibleLogs = logs.slice(startIdx, endIdx);

  const totalH    = logs.length * ROW_H;
  const paddingTop = startIdx * ROW_H;

  if (logs.length === 0) {
    return (
      <div style={{ background:"#0f172a", borderRadius:8, padding:14,
        height:VISIBLE_H, display:"flex", alignItems:"center", justifyContent:"center",
        fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}>
        <span style={{ color:"#4a5568" }}>
          {isRunning ? "⏳ Waiting for logs… (auto-refreshing)" : "No logs available for this run"}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      style={{ background:"#0f172a", borderRadius:8, padding:"14px 14px 14px 14px",
        height:VISIBLE_H, overflowY:"auto",
        fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:1.7,
        position:"relative" }}
    >
      {/* top spacer — represents off-screen rows above */}
      <div style={{ height: paddingTop }} />

      {visibleLogs.map((l, relIdx) => {
        const i      = startIdx + relIdx;
        const isSoft = l.message?.includes('[SOFT FAIL]');
        const isAI   = l.message?.includes('[AI') || l.message?.includes('AI suggestion')
                    || l.message?.includes('AI healed') || l.message?.includes('AI Heal');
        const col = l.level==="pass"  ? "#22d3a0"
                  : l.level==="fail"  ? "#ff6b6b"
                  : l.level==="error" ? "#f97316"
                  : isSoft            ? "#fbbf24"
                  : isAI              ? "#a78bfa"
                  : l.level==="warn"  ? "#fb923c"
                  :                     "#94a3b8";
        const bg = isSoft ? "rgba(251,191,36,0.12)" : isAI ? "rgba(167,139,250,0.12)" : "transparent";
        const bl = isSoft ? "3px solid #fbbf24" : isAI ? "3px solid #a78bfa" : "3px solid transparent";
        return (
          <div key={i} style={{ height:ROW_H, display:"flex", alignItems:"center",
            color:col, background:bg, borderLeft:bl,
            paddingLeft: isSoft||isAI ? 8 : 0, borderRadius:3,
            overflow:"hidden", whiteSpace:"nowrap" }}>
            <span style={{ color:"#475569", marginRight:8, fontSize:11, flexShrink:0 }}>
              [{l.timestamp?.slice(11,19)||"--:--:--"}]
            </span>
            {isSoft ? (
              <><span style={{ background:"#fbbf24", color:"#000", fontSize:10,
                fontWeight:800, padding:"1px 6px", borderRadius:3, marginRight:6,
                flexShrink:0 }}>SOFT FAIL</span>
              <b style={{ overflow:"hidden", textOverflow:"ellipsis" }}>
                {l.message.replace('[SOFT FAIL]','').trim()}
              </b></>
            ) : isAI ? (
              <><span style={{ background:"#7c3aed", color:"#fff", fontSize:10,
                fontWeight:800, padding:"1px 6px", borderRadius:3, marginRight:6,
                flexShrink:0 }}>AI</span>
              <b style={{ color:"#c4b5fd", overflow:"hidden", textOverflow:"ellipsis" }}>
                {l.message}
              </b></>
            ) : (
              <span style={{ overflow:"hidden", textOverflow:"ellipsis" }}>{l.message}</span>
            )}
          </div>
        );
      })}

      {/* bottom spacer — represents off-screen rows below */}
      <div style={{ height: Math.max(0, totalH - paddingTop - visibleLogs.length * ROW_H) }} />

      {isRunning && (
        <div style={{ color:"#fbbf24", padding:"4px 0" }}>⏳ Running…</div>
      )}

      {/* Jump-to-bottom button — shown when user has scrolled up */}
      {!autoScroll && logs.length > 0 && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
            setAutoScroll(true);
          }}
          style={{ position:"sticky", bottom:8, float:"right",
            background:"#1e40af", color:"#fff", border:"none",
            borderRadius:20, padding:"4px 12px", fontSize:11,
            cursor:"pointer", opacity:0.9 }}>
          ↓ Jump to bottom
        </button>
      )}
    </div>
  );
}

function RunHistory({ runs, onViewRun }) {
  const [search,       setSearch]  = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setSF]      = useState("");
  const [page,         setPage]    = useState(1);
  const [allRuns,      setAllRuns] = useState(null);
  const [loading,      setLoading] = useState(false);

  // Debounce search input — wait 400ms after user stops typing before firing API
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const loadRuns = useCallback(async (pg=1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page:pg, limit:getAppPageSize() });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (statusFilter)    params.set("status", statusFilter);
      const r = await api(`/api/runs?${params}`);
      const data = Array.isArray(r) ? { rows:r, total:r.length, page:1, pages:1 } : r;
      setAllRuns(data);
      setPage(pg);
    } catch(e) { console.error(e); }
    setLoading(false);
  }, [debouncedSearch, statusFilter]);

  useEffect(() => { loadRuns(1); }, [loadRuns]);

  const rows  = allRuns?.rows  || [];
  const total = allRuns?.total || 0;
  const pages = allRuns?.pages || 1;
  const paged = rows;

  return (
    <div style={s.col}>
      <div style={{ fontSize:22, fontWeight:800, color:"#8B0000" }}>{"\uD83D\uDCCB"} Run History</div>
      <div style={{ ...s.card, padding:14 }}>
        <div style={s.row}>
          <input style={{ ...s.input, flex:2 }} placeholder={"\uD83D\uDD0D Search..."} value={search} onChange={e=>setSearch(e.target.value)} />
          <select style={{ ...s.input, flex:1 }} value={statusFilter} onChange={e=>setSF(e.target.value)}>
            <option value="">All Statuses</option>
            {["passed","failed","running","queued","error"].map(s2=><option key={s2}>{s2}</option>)}
          </select>
        </div>
      </div>
      <div style={s.card}>
        <table style={s.table}>
          <thead><tr>{["#","Test","Project","Type","Browser","Status","Steps","Duration","Triggered","Date","Action"].map(h=><th key={h} style={s.th}>{h}</th>)}</tr></thead>
          <tbody>
            {loading && <tr><td colSpan={11} style={{textAlign:"center",padding:20,color:"#8a96a8"}}>{"\u23F3"} Loading...</td></tr>}
            {!loading && paged.map(r => (
              <tr key={r.id}>
                <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:"#8a96a8" }}>#{r.id}</td>
                <td style={{ ...s.td, fontWeight:600 }}>{r.test_name}</td>
                <td style={{ ...s.td, fontSize:12, color:"#8a96a8" }}>{r.project_name||"\u2014"}</td>
                <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{r.test_type?.toUpperCase()}</td>
                <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#4a5568" }}>{r.browser}</td>
                <td style={s.td}><Badge status={r.status} /></td>
                <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 }}>
                  <span style={{color:"#00a86b"}}>{r.steps_passed}</span>
                  <span style={{color:"#8a96a8"}}>/{r.steps_total}</span>
                  {r.steps_failed>0&&<span style={{color:"#e53935"}}> ({r.steps_failed} fail)</span>}
                </td>
                <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8a96a8" }}>{r.duration_ms ? `${(r.duration_ms/1000).toFixed(1)}s` : "\u2014"}</td>
                <td style={{ ...s.td, fontSize:11, color:"#8a96a8" }}>{r.triggered_by}</td>
                <td style={{ ...s.td, fontSize:11, fontFamily:"'IBM Plex Mono',monospace", color:"#8a96a8" }}>{new Date(r.created_at).toLocaleString()}</td>
                <td style={s.td}>
                  <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                    <button style={s.btn("ghost",true)} onClick={()=>onViewRun(r)}>View</button>
                    {(r.status === 'running' || r.status === 'queued') && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm('Abort this run?')) return;
                          try {
                            await api(`/api/runs/${r.id}/abort`, { method: 'DELETE' });
                            loadRuns(page);
                          } catch(err) { alert('Abort failed: ' + err.message); }
                        }}
                        style={{ padding:"3px 10px", borderRadius:5, fontSize:11,
                          fontWeight:600, cursor:"pointer",
                          border:"1.5px solid #e53935",
                          background:"#fff5f5", color:"#e53935" }}>
                        ⏹ Abort
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && paged.length===0&&<tr><td colSpan={11}><Empty msg="No runs found" /></td></tr>}
          </tbody>
        </table>
        <Pagination page={page} pages={pages} total={total} pageSize={getAppPageSize()}
          onPage={pg => loadRuns(pg)} />
      </div>
    </div>
  );
}


function RunDetail({ run, onBack }) {
  const [detail,      setDetail]      = useState(run);
  const [refreshing,  setRefreshing]  = useState(false);
  const [analysing,   setAnalysing]   = useState(false);
  const [analysis,    setAnalysis]    = useState(null);
  const [analyseErr,  setAnalyseErr]  = useState("");
  const pollRef = useRef(null);

  const loadDetail = async () => {
    try {
      const d = await api(`/api/runs/${run.id}`);
      try {
        const fileLogs = await api(`/api/runs/${run.id}/logs`);
        if (Array.isArray(fileLogs) && fileLogs.length > 0) d.logs = fileLogs;
      } catch {}
      setDetail(d);
      return d;
    } catch {}
  };

  useEffect(() => {
    loadDetail();
    pollRef.current = setInterval(async () => {
      const d = await loadDetail();
      if (d && !["running","queued"].includes(d.status)) {
        clearInterval(pollRef.current);
      }
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [run.id]);

  const refresh = async () => {
    setRefreshing(true);
    await loadDetail();
    setRefreshing(false);
  };

  const analyse = async () => {
    setAnalysing(true); setAnalysis(null); setAnalyseErr("");
    try {
      const r = await api(`/api/runs/${detail.id}/analyse`, { method:"POST" });
      setAnalysis(r);
    } catch(e) { setAnalyseErr(e.message); }
    setAnalysing(false);
  };

  const categoryConfig = {
    selector_changed:    { icon:"\uD83D\uDD0D", color:"#f97316", bg:"#fff7ed", label:"Selector Changed" },
    timing_issue:        { icon:"\u23F1\uFE0F", color:"#f59e0b", bg:"#fffbeb", label:"Timing Issue" },
    data_mismatch:       { icon:"\uD83D\uDCCA", color:"#8b5cf6", bg:"#f5f3ff", label:"Data Mismatch" },
    navigation_error:    { icon:"\uD83E\uDDED", color:"#ef4444", bg:"#fef2f2", label:"Navigation Error" },
    environment_issue:   { icon:"\uD83C\uDF10", color:"#6366f1", bg:"#eef2ff", label:"Environment Issue" },
    test_data_stale:     { icon:"\uD83D\uDDC3\uFE0F", color:"#d97706", bg:"#fef3c7", label:"Stale Test Data" },
    regression:          { icon:"\uD83D\uDCC9", color:"#dc2626", bg:"#fef2f2", label:"Regression" },
    flaky:               { icon:"\u26A1", color:"#f59e0b", bg:"#fffbeb", label:"Flaky Test" },
    assertion_failure:   { icon:"\u2717",  color:"#ef4444", bg:"#fef2f2", label:"Assertion Failure" },
    configuration_error: { icon:"\u2699\uFE0F", color:"#6b7280", bg:"#f9fafb", label:"Config Error" },
    unknown:             { icon:"\u2753", color:"#6b7280", bg:"#f9fafb", label:"Unknown" },
  };

  const confidenceColor = { high:"#16a34a", medium:"#f59e0b", low:"#dc2626" };

  const steps  = detail?.test_steps || [];
  const logs   = detail?.logs       || [];
  const shots  = detail?.screenshots|| [];

  return (
    <div style={s.col}>
      <div style={{ display:"flex", alignItems:"center", gap:12 }}>
        <button style={s.btn("ghost",true)} onClick={onBack}>{"\u2190"} Back</button>
        <div style={{ fontSize:22, fontWeight:800 }}>Run #{detail.id} — {detail.test_name}</div>
        <Badge status={detail.status} />
        <button style={{ ...s.btn("ghost",true), fontSize:12, marginLeft:"auto" }}
          onClick={refresh} disabled={refreshing}>
          {refreshing ? "Refreshing..." : "\u21BB Refresh"}
        </button>
        {(detail.status==="failed"||detail.status==="error") && (
          <button style={{ ...s.btn("primary",true), fontSize:12,
            background: analysing ? "#94a3b8" : "#7c3aed" }}
            onClick={analyse} disabled={analysing}>
            {analysing ? "\uD83D\uDD0D Analysing..." : "\uD83D\uDD0D Analyse Failure"}
          </button>
        )}
      </div>

      <div style={s.row}>
        {[
          {label:"Status",   value:<Badge status={detail.status}/> },
          {label:"Duration", value:detail.duration_ms ? `${(detail.duration_ms/1000).toFixed(2)}s`:"\u2014"},
          {label:"Steps",    value:`${detail.steps_passed||0}/${detail.steps_total||0}`},
          {label:"Browser",  value:detail.browser},
          {label:"Triggered",value:detail.triggered_by},
        ].map(st=>(
          <div key={st.label} style={{ ...s.card, flex:1, minWidth:120, padding:"14px 16px" }}>
            <div style={{ fontSize:11, color:"#8a96a8", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.06em" }}>{st.label}</div>
            <div style={{ fontWeight:700, fontFamily:"'IBM Plex Mono',monospace" }}>{st.value}</div>
          </div>
        ))}
      </div>

      {analyseErr && (
        <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8,
          padding:"12px 16px", color:"#dc2626", fontSize:13 }}>
          {"\u274C"} Analysis failed: {analyseErr}
        </div>
      )}

      {analysis && (() => {
        const cat = categoryConfig[analysis.category] || categoryConfig.unknown;
        return (
          <div style={{ background:"#fff", border:`2px solid ${cat.color}33`,
            borderRadius:12, padding:0, overflow:"hidden",
            boxShadow:"0 4px 20px rgba(0,0,0,0.08)" }}>
            <div style={{ background:`linear-gradient(135deg, ${cat.color}15, ${cat.color}08)`,
              borderBottom:`1px solid ${cat.color}22`, padding:"16px 20px",
              display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                <div style={{ fontSize:28 }}>{cat.icon}</div>
                <div>
                  <div style={{ fontSize:16, fontWeight:800, color:"#1a2332" }}>
                    {"\uD83D\uDD0D"} AI Root Cause Analysis
                  </div>
                  <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>
                    {analysis.test_name} · analysed {new Date(analysis.analysed_at).toLocaleTimeString()}
                  </div>
                </div>
              </div>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <span style={{ background:cat.bg, color:cat.color, border:`1px solid ${cat.color}44`,
                  padding:"4px 12px", borderRadius:20, fontSize:12, fontWeight:700 }}>
                  {cat.icon} {cat.label}
                </span>
                <span style={{ background: confidenceColor[analysis.confidence]+"22",
                  color: confidenceColor[analysis.confidence],
                  border:`1px solid ${confidenceColor[analysis.confidence]}44`,
                  padding:"4px 12px", borderRadius:20, fontSize:11, fontWeight:700,
                  textTransform:"uppercase", letterSpacing:"0.05em" }}>
                  {analysis.confidence} confidence
                </span>
              </div>
            </div>
            <div style={{ padding:"20px 24px" }}>
              <div style={{ background:cat.bg, border:`1px solid ${cat.color}22`,
                borderRadius:8, padding:"12px 16px", marginBottom:16 }}>
                <div style={{ fontSize:15, fontWeight:700, color:"#1a2332" }}>
                  {analysis.summary}
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#6b7280",
                    letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>
                    {"\uD83E\uDDE0"} Likely Cause
                  </div>
                  <div style={{ fontSize:13, color:"#374151", lineHeight:1.7,
                    background:"#f9fafb", borderRadius:8, padding:"12px 14px" }}>
                    {analysis.likely_cause}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#6b7280",
                    letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>
                    {"\uD83D\uDCCB"} Evidence
                  </div>
                  <div style={{ background:"#f9fafb", borderRadius:8, padding:"12px 14px" }}>
                    {(analysis.evidence||[]).map((e,i) => (
                      <div key={i} style={{ display:"flex", gap:8, marginBottom:6,
                        fontSize:12, color:"#374151", lineHeight:1.5 }}>
                        <span style={{ color:cat.color, fontWeight:700, flexShrink:0 }}>{"\u2192"}</span>
                        <span>{e}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ background:"#f0fdf4", border:"1px solid #bbf7d0",
                borderRadius:8, padding:"14px 16px", marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#16a34a",
                  letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6 }}>
                  {"\u2705"} Suggested Fix
                </div>
                <div style={{ fontSize:13, color:"#166534", lineHeight:1.7 }}>
                  {analysis.suggested_fix}
                </div>
                {analysis.selector_suggestion && (
                  <div style={{ marginTop:10, background:"#fff",
                    border:"1px solid #bbf7d0", borderRadius:6, padding:"8px 12px" }}>
                    <div style={{ fontSize:11, color:"#6b7280", marginBottom:4 }}>
                      Suggested selector:
                    </div>
                    <code style={{ fontSize:13, color:"#166534",
                      fontFamily:"'IBM Plex Mono',monospace" }}>
                      {analysis.selector_suggestion}
                    </code>
                  </div>
                )}
              </div>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                {analysis.is_regression && (
                  <span style={{ background:"#fef2f2", color:"#dc2626",
                    border:"1px solid #fecaca", padding:"4px 12px",
                    borderRadius:20, fontSize:11, fontWeight:700 }}>
                    {"\uD83D\uDCC9"} Regression Detected
                  </span>
                )}
                {analysis.is_flaky && (
                  <span style={{ background:"#fffbeb", color:"#d97706",
                    border:"1px solid #fde68a", padding:"4px 12px",
                    borderRadius:20, fontSize:11, fontWeight:700 }}>
                    {"\u26A1"} Flaky Test
                  </span>
                )}
                {analysis.was_passing_before && (
                  <span style={{ background:"#eff6ff", color:"#2563eb",
                    border:"1px solid #bfdbfe", padding:"4px 12px",
                    borderRadius:20, fontSize:11, fontWeight:700 }}>
                    {"\u2713"} Was passing before
                  </span>
                )}
                <span style={{ background:"#f9fafb", color:"#6b7280",
                  border:"1px solid #e5e7eb", padding:"4px 12px",
                  borderRadius:20, fontSize:11 }}>
                  Based on {analysis.history_count} previous run{analysis.history_count!==1?"s":""}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={{ display:"flex", gap:16, flexWrap:"nowrap", alignItems:"flex-start" }}>
        <div style={{ ...s.card, flex:2, minWidth:0, overflow:"hidden" }}>
          <div style={{ fontWeight:700, marginBottom:12, fontSize:14 }}>{"\uD83D\uDCC4"} Execution Logs</div>
          <div style={{ background:"#0f172a", borderRadius:8, padding:14, maxHeight:300, overflowY:"auto",
            fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:1.7 }}>
            {logs.length===0 ? (
              <div style={{ color:"#4a5568", textAlign:"center", padding:"20px 0" }}>
                { ["running","queued"].includes(detail.status)
                  ? "\u23F3 Waiting for logs..."
                  : "No logs available for this run" }
              </div>
            ) : logs.map((l,i) => {
              const isSoft = l.message?.includes('[SOFT FAIL]');
              const isAI   = l.message?.includes('[AI') || l.message?.includes('AI suggestion') || l.message?.includes('AI healed') || l.message?.includes('AI Heal');
              const col = l.level==="pass"?"#22d3a0":l.level==="fail"?"#ff6b6b":l.level==="error"?"#f97316":isSoft?"#fbbf24":isAI?"#a78bfa":l.level==="warn"?"#fb923c":"#94a3b8";
              const bg  = isSoft?"rgba(251,191,36,0.12)":isAI?"rgba(167,139,250,0.12)":"transparent";
              const bl  = isSoft?"3px solid #fbbf24":isAI?"3px solid #a78bfa":"3px solid transparent";
              return (
              <div key={i} style={{ marginBottom:isSoft||isAI?4:3, color:col,
                background:bg, borderLeft:bl, paddingLeft:isSoft||isAI?8:0, borderRadius:3 }}>
                <span style={{ color:"#475569", marginRight:8, fontSize:11 }}>
                  [{l.timestamp?.slice(11,19)||"--:--:--"}]
                </span>
                {isSoft ? <><span style={{background:"#fbbf24",color:"#000",fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:3,marginRight:6}}>SOFT FAIL</span><b>{l.message.replace('[SOFT FAIL]','').trim()}</b></> :
                 isAI   ? <><span style={{background:"#7c3aed",color:"#fff",fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:3,marginRight:6}}>AI</span><b style={{color:"#c4b5fd"}}>{l.message}</b></> :
                 l.message}
              </div>
              );
            })}
            {["running","queued"].includes(detail.status) && logs.length > 0 && (
              <div style={{ color:"#fbbf24", marginTop:8 }}>\u23F3 Running...</div>
            )}
          </div>
        </div>

        <div style={{ ...s.card, flex:1, minWidth:160 }}>
          <div style={{ fontWeight:700, marginBottom:12, fontSize:14 }}>{"\uD83D\uDCF7"} Screenshots</div>
          {shots.length === 0 ? <Empty msg="No screenshots" /> :
            shots.map((sc,i) => (
              <a key={i} href={`${API}/api/screenshots/${sc.filename}?token=${getToken()}`} target="_blank" rel="noreferrer"
                style={{ display:"block", padding:"8px 10px", background:"#ffffff", borderRadius:6, marginBottom:6, fontSize:12, color:"#1a6fc4", textDecoration:"none" }}>
                {"\uD83D\uDCF7"} {sc.label} <span style={{color:"#8a96a8", fontSize:10}}>{"\u2197"}</span>
              </a>
            ))
          }
        </div>
      </div>
    </div>
  );
}


function ProjectVariables({ project, onClose }) {
  const [vars,    setVars]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [editId,  setEditId]  = useState(null);
  const [form,    setForm]    = useState({ name:"", value:"", type:"fixed", description:"" });
  const [showModal, setShowModal] = useState(false);
  const [showVals,  setShowVals]  = useState({});

  const load = async () => {
    setLoading(true);
    try { setVars(await api(`/api/projects/${project.id}/variables`)); }
    catch(e) { alert(e.message); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [project.id]);

  const openAdd = () => {
    setEditId(null);
    setForm({ name:"", value:"", type:"fixed", description:"" });
    setShowModal(true);
  };

  const openEdit = (v) => {
    setEditId(v.id);
    setForm({ name:v.name, value:v.value||"", type:v.type, description:v.description||"" });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name?.trim()) return alert("Variable name required");
    setSaving(true);
    try {
      if (editId) {
        await api(`/api/projects/${project.id}/variables/${editId}`, { method:"PUT", body:form });
      } else {
        await api(`/api/projects/${project.id}/variables`, { method:"POST", body:form });
      }
      setShowModal(false);
      load();
    } catch(e) { alert(e.message); }
    setSaving(false);
  };

  const del = async (v) => {
    if (!confirm(`Delete variable "${v.name}"?`)) return;
    try { await api(`/api/projects/${project.id}/variables/${v.id}`, { method:"DELETE" }); load(); }
    catch(e) { alert(e.message); }
  };

  const typeColor = { fixed:"#1a6fc4", secret:"#e53935", runtime:"#f59e0b" };
  const typeBg    = { fixed:"#e8f0fd", secret:"#fdecea", runtime:"#fef9e7" };
  const typeDesc  = {
    fixed:   "Static value — same for all runs",
    secret:  "Encrypted — masked in UI, decrypted only at runtime",
    runtime: "Can be written by test runs and persists to next run",
  };

  return (
    <div style={s.modal} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ ...s.modalBox, maxWidth:680 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800 }}>{"\uD83D\uDD10"} Project Variables</div>
            <div style={{ fontSize:12, color:"#8a96a8", marginTop:2 }}>{project.name}</div>
          </div>
          <button style={s.btn("primary")} onClick={openAdd}>+ Add Variable</button>
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
          {Object.entries(typeDesc).map(([t,d]) => (
            <div key={t} style={{ display:"flex", alignItems:"center", gap:6,
              background:typeBg[t], borderRadius:6, padding:"4px 10px" }}>
              <span style={{ fontSize:11, fontWeight:700, color:typeColor[t],
                textTransform:"uppercase" }}>{t}</span>
              <span style={{ fontSize:11, color:"#6b7280" }}>— {d}</span>
            </div>
          ))}
        </div>

        {loading ? (
          <div style={{ textAlign:"center", padding:32, color:"#8a96a8" }}>{"\u23F3"} Loading...</div>
        ) : vars.length === 0 ? (
          <div style={{ textAlign:"center", padding:32, color:"#8a96a8" }}>
            <div style={{ fontSize:32, marginBottom:8 }}>{"\uD83D\uDD10"}</div>
            No variables yet. Add your first project variable.
          </div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {["Name","Type","Value","Description",""].map(h=>(
                  <th key={h} style={s.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vars.map(v => (
                <tr key={v.id} style={{ borderBottom:"1px solid #f0f2f5" }}>
                  <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontWeight:700,
                    color:"#1a2332", fontSize:13 }}>
                    {"{{"+v.name+"}}"}
                  </td>
                  <td style={s.td}>
                    <span style={{ background:typeBg[v.type], color:typeColor[v.type],
                      padding:"2px 8px", borderRadius:4, fontSize:11, fontWeight:700,
                      textTransform:"uppercase" }}>{v.type}</span>
                  </td>
                  <td style={{ ...s.td, fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                    maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {v.type==="secret" ? (
                      <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span>{showVals[v.id] ? v.value : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"}</span>
                        <button onClick={()=>setShowVals(p=>({...p,[v.id]:!p[v.id]}))}
                          style={{ background:"none", border:"none", cursor:"pointer",
                            color:"#8a96a8", fontSize:12 }}>
                          {showVals[v.id] ? "\uD83D\uDE48" : "\uD83D\uDC41"}
                        </button>
                      </span>
                    ) : (
                      <span title={v.value}>{v.value||<em style={{color:"#ccc"}}>empty</em>}</span>
                    )}
                  </td>
                  <td style={{ ...s.td, fontSize:12, color:"#8a96a8" }}>{v.description||"\u2014"}</td>
                  <td style={s.td}>
                    <div style={{ display:"flex", gap:4 }}>
                      <button onClick={()=>openEdit(v)}
                        style={{ ...s.btn("ghost",true), fontSize:11, padding:"3px 8px" }}>Edit</button>
                      <button onClick={()=>del(v)}
                        style={{ background:"#fdecea", border:"1px solid #ffcdd2", borderRadius:4,
                          cursor:"pointer", color:"#c62828", fontSize:11, padding:"3px 8px" }}>Del</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
          marginTop:20, paddingTop:16, borderTop:"1px solid #f0f2f5" }}>
          <div style={{ fontSize:12, color:"#8a96a8" }}>
            {"\uD83D\uDCA1"} Use <code style={{ background:"#f0f2f5", padding:"1px 6px", borderRadius:3,
              fontFamily:"monospace" }}>{"{{variable_name}}"}</code> in any test step value
          </div>
          <button style={s.btn("ghost")} onClick={onClose}>Close</button>
        </div>

        {showModal && (
          <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,0.4)",
            display:"flex", alignItems:"center", justifyContent:"center",
            borderRadius:10, zIndex:10 }}>
            <div style={{ background:"#fff", borderRadius:10, padding:24,
              width:400, boxShadow:"0 8px 32px rgba(0,0,0,0.2)" }}>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:16 }}>
                {editId ? "Edit Variable" : "New Variable"}
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <div>
                  <label style={s.label}>Variable Name *</label>
                  <input style={s.input} value={form.name}
                    disabled={!!editId}
                    placeholder="e.g. base_url, auth_token"
                    onChange={e=>setForm(f=>({...f,name:e.target.value}))} />
                  <div style={{ fontSize:11, color:"#8a96a8", marginTop:2 }}>
                    Use in steps as {"{{"+form.name+"}}"}
                  </div>
                </div>
                <div>
                  <label style={s.label}>Type</label>
                  <select style={s.input} value={form.type}
                    onChange={e=>setForm(f=>({...f,type:e.target.value}))}>
                    <option value="fixed">{"\uD83D\uDD35"} Fixed — static value</option>
                    <option value="secret">{"\uD83D\uDD34"} Secret — encrypted, masked in UI</option>
                    <option value="runtime">{"\uD83D\uDFE1"} Runtime — written by tests, persists</option>
                  </select>
                  <div style={{ fontSize:11, color:typeColor[form.type], marginTop:2 }}>
                    {typeDesc[form.type]}
                  </div>
                </div>
                <div>
                  <label style={s.label}>
                    {form.type==="runtime" ? "Initial Value (optional)" : "Value"}
                  </label>
                  <input style={s.input}
                    type={form.type==="secret" ? "password" : "text"}
                    value={form.value}
                    placeholder={form.type==="runtime" ? "Leave empty — set by test runs" : "Enter value"}
                    onChange={e=>setForm(f=>({...f,value:e.target.value}))} />
                </div>
                <div>
                  <label style={s.label}>Description (optional)</label>
                  <input style={s.input} value={form.description}
                    placeholder="What is this variable for?"
                    onChange={e=>setForm(f=>({...f,description:e.target.value}))} />
                </div>
              </div>
              <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
                <button style={s.btn("ghost")} onClick={()=>setShowModal(false)}>Cancel</button>
                <button style={s.btn("primary")} onClick={save} disabled={saving}>
                  {saving ? "Saving..." : editId ? "Save Changes" : "Create Variable"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Projects({ projects, onRefresh, user, onViewProject }) {
  const [modal,     setModal]     = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [form,      setForm]      = useState({ name:"", description:"", base_url:"", org_id:"" });
  const [editForm,  setEditForm]  = useState({ description:"", base_url:"" });
  const [saving,    setSaving]    = useState(false);
  const [orgs,      setOrgs]      = useState([]);
  const [varModal,  setVarModal]  = useState(null);
  const [menuOpen,      setMenuOpen]      = useState(null);
  const [detailModal,   setDetailModal]   = useState(null);
  const [showInactive,  setShowInactive]  = useState(false);
  const [allProjects,   setAllProjects]   = useState(null);

  const canManage = ["superadmin","admin","lead"].includes(user?.role);

  useEffect(() => {
    if (canManage) api("/api/organisations").then(o=>setOrgs(o||[])).catch(()=>{});
  }, []);

  useEffect(() => {
    if (user?.role === "admin" || user?.role === "superadmin" || user?.id === 1 || user?.uid === 1) {
      api("/api/projects?include_inactive=true")
        .then(p => setAllProjects(p||[]))
        .catch(()=>{});
    }
  }, []);

  const refreshAll = async () => {
    await onRefresh();
    if (user?.role === "admin" || user?.role === "superadmin" || user?.id === 1 || user?.uid === 1) {
      const p = await api("/api/projects?include_inactive=true").catch(()=>[]);
      setAllProjects(p||[]);
    }
  };

  const save = async () => {
    if (!form.name?.trim()) return alert("Project name is required");
    if (!form.org_id && orgs.length > 0) return alert("Please select an organisation for this project");
    setSaving(true);
    try { await api("/api/projects", { method:"POST", body:form }); await refreshAll(); setModal(false); }
    catch(e){ alert(e.message); } finally { setSaving(false); }
  };

  const toggleActive = async (p) => {
    const action = p.active ? "disable" : "enable";
    if (!confirm(`${action === "disable" ? "Disable" : "Enable"} project "${p.name}"?\n\n${action === "disable" ? "It will be hidden from all users and cannot be used in new tests." : "It will become visible and usable again."}`)) return;
    try {
      await api(`/api/projects/${p.id}/toggle-active`, { method:"PATCH" });
      await refreshAll();
      setMenuOpen(null);
      setDetailModal(null);
    } catch(e) { alert(e.message); }
  };

  const saveEdit = async () => {
    if (!editModal) return;
    setSaving(true);
    try {
      await api(`/api/projects/${editModal.id}`, {
        method: "PATCH",
        body: { description: editForm.description||null, base_url: editForm.base_url||null }
      });
      await refreshAll(); setEditModal(null);
    } catch(e){ alert(e.message); } finally { setSaving(false); }
  };

  const openEdit = (p) => {
    setEditForm({ description: p.description||"", base_url: p.base_url||"" });
    setEditModal(p); setMenuOpen(null);
  };

  const cardColors = [
    { icon:"\uD83D\uDDC4", bg:"#e8eeff", ic:"#3b5bdb" },
    { icon:"\u26A1", bg:"#fef3c7", ic:"#d97706" },
    { icon:"\uD83D\uDD2C", bg:"#ecfdf5", ic:"#059669" },
    { icon:"\uD83D\uDE80", bg:"#fdf4ff", ic:"#9333ea" },
    { icon:"\uD83C\uDF10", bg:"#fff1f2", ic:"#e11d48" },
    { icon:"\uD83D\uDEE1", bg:"#f0fdf4", ic:"#16a34a" },
  ];

  return (
    <div style={s.col}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:"#8B0000" }}>Projects</div>
          <div style={{ fontSize:13, color:"#9ca3af", marginTop:2 }}>
            {projects.length} project{projects.length!==1?"s":""} · Manage your automation projects
          </div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {(user?.role === "admin" || user?.role === "superadmin" || user?.id === 1 || user?.uid === 1) && (
            <button
              onClick={()=>setShowInactive(v=>!v)}
              style={{ ...s.btn("ghost"), padding:"8px 14px", fontSize:12,
                borderColor: showInactive?"#dc2626":"#e5e7eb",
                color: showInactive?"#dc2626":"#6b7280" }}>
              {showInactive ? "\uD83D\uDC41 Hide Disabled" : "\uD83D\uDC41 Show Disabled"}
            </button>
          )}
          {canManage && (
            <button style={{ ...s.btn("primary"), padding:"9px 18px" }}
              onClick={()=>{ setForm({name:"",description:"",base_url:"",org_id:""}); setModal(true); }}>
              + New Project
            </button>
          )}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(340px,1fr))", gap:18 }}>
        {(showInactive && allProjects ? allProjects : projects).map((p, idx) => {
          const col       = cardColors[idx % cardColors.length];
          const passRate  = parseFloat(p.pass_rate||0);
          const hasRate   = p.test_count > 0;
          const passColor = !hasRate?"#9ca3af":passRate>=80?"#16a34a":passRate>=50?"#f59e0b":"#ef4444";
          const updatedAgo = p.updated_at ? (() => {
            const diff = (Date.now()-new Date(p.updated_at))/1000;
            if (diff<3600)  return `${Math.floor(diff/60)}m ago`;
            if (diff<86400) return `${Math.floor(diff/3600)}h ago`;
            return `${Math.floor(diff/86400)}d ago`;
          })() : null;

          return (
            <div key={p.id} style={{ background: !p.active?"#f9fafb":"#fff",
              borderRadius:16,
              border: !p.active?"1px dashed #d1d5db":"1px solid #e8eaf0",
              boxShadow:"0 2px 12px rgba(0,0,0,0.06)",
              display:"flex", flexDirection:"column", position:"relative",
              transition:"box-shadow 0.2s",
              cursor: !p.active?"default":"pointer",
              opacity: !p.active?0.75:1 }}
              onMouseEnter={e=>{ if(p.active!==false) e.currentTarget.style.boxShadow="0 6px 24px rgba(0,0,0,0.1)"; }}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="0 2px 12px rgba(0,0,0,0.06)"}
              onClick={e=>{ if(!e.target.closest("button") && p.active!==false) setDetailModal(p); }}>
              {!p.active && (
                <div style={{ background:"#fee2e2", color:"#dc2626", fontSize:11,
                  fontWeight:700, textAlign:"center", padding:"5px",
                  letterSpacing:"0.05em" }}>
                  {"\uD83D\uDD34"} DISABLED — Not visible to users
                </div>
              )}
              <div style={{ padding:"22px 22px 16px", flex:1 }}>
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"flex-start", marginBottom:12 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:44, height:44, borderRadius:11, background:col.bg,
                      display:"flex", alignItems:"center", justifyContent:"center",
                      fontSize:22, flexShrink:0 }}>
                      {col.icon}
                    </div>
                    <div>
                      <div style={{ fontSize:15, fontWeight:800, color:"#0d1425",
                        lineHeight:1.3 }}>{p.name}</div>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:4, flexWrap:"wrap" }}>
                        {p.org_name && (
                          <span style={{ fontSize:9, fontWeight:700, color:col.ic,
                            background:col.bg, padding:"2px 8px", borderRadius:20,
                            letterSpacing:"0.06em", textTransform:"uppercase" }}>
                            {"\uD83C\uDFE2"} {p.org_name}
                          </span>
                        )}
                        {updatedAgo && (
                          <span style={{ fontSize:11, color:"#9ca3af", display:"flex",
                            alignItems:"center", gap:3 }}>
                            {"\uD83D\uDD50"} {updatedAgo}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {canManage && (
                    <div style={{ position:"relative" }}>
                      <button onClick={()=>setMenuOpen(menuOpen===p.id?null:p.id)}
                        style={{ background:"none", border:"1px solid #e5e7eb",
                          borderRadius:7, cursor:"pointer", color:"#9ca3af",
                          fontSize:16, padding:"3px 8px", lineHeight:1 }}>{"\u22EE"}</button>
                      {menuOpen===p.id && (
                        <>
                          <div style={{ position:"fixed", inset:0, zIndex:50 }}
                            onClick={()=>setMenuOpen(null)} />
                          <div style={{ position:"absolute", right:0, top:"calc(100% + 4px)",
                            background:"#fff", border:"1px solid #e5e7eb", borderRadius:10,
                            boxShadow:"0 8px 24px rgba(0,0,0,0.12)", zIndex:51,
                            minWidth:160, overflow:"hidden" }}>
                            {[
                              { label:"\u270F\uFE0F Edit Project", action:()=>openEdit(p) },
                              ...(user?.role==="admin" || user?.role==="superadmin" || user?.id===1 || user?.uid===1 ? [{
                                label: !p.active ? "\uD83D\uDFE2 Enable Project" : "\uD83D\uDD34 Disable Project",
                                action: ()=>toggleActive(p),
                                color: !p.active?"#16a34a":"#dc2626"
                              }] : [])
                            ].map(item => (
                              <button key={item.label} onClick={item.action}
                                style={{ width:"100%", padding:"10px 16px", border:"none",
                                  background:"none", cursor:"pointer", textAlign:"left",
                                  fontSize:13, color:item.color||"#374151", display:"block",
                                  fontWeight: item.color?"600":"400" }}
                                onMouseEnter={e=>e.currentTarget.style.background="#f9fafb"}
                                onMouseLeave={e=>e.currentTarget.style.background="none"}>
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div style={{ fontSize:13, color:"#6b7280", lineHeight:1.65,
                  minHeight:52, marginBottom:12 }}>
                  {p.description || <em style={{color:"#d1d5db"}}>No description added yet.</em>}
                </div>

                {p.base_url && (
                  <div style={{ fontSize:11, color:"#3b82f6",
                    fontFamily:"'IBM Plex Mono',monospace", marginBottom:8,
                    overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                    {"\uD83D\uDD17"} {p.base_url}
                  </div>
                )}
              </div>

              <div style={{ borderTop:"1px solid #f3f4f6", padding:"14px 22px",
                display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", gap:22 }}>
                  <div>
                    <div style={{ fontSize:9, fontWeight:700, color:"#9ca3af",
                      textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:2 }}>
                      TEST CASES
                    </div>
                    <div style={{ fontSize:22, fontWeight:800, color:"#0d1425",
                      fontFamily:"'IBM Plex Mono',monospace", lineHeight:1 }}>
                      {String(p.test_count||0).padStart(p.test_count>=100?3:2,"0")}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:9, fontWeight:700, color:"#9ca3af",
                      textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:2 }}>
                      PASS RATE
                    </div>
                    <div style={{ fontSize:22, fontWeight:800, color:passColor,
                      fontFamily:"'IBM Plex Mono',monospace", lineHeight:1 }}>
                      {hasRate ? passRate.toFixed(1)+"%" : "\u2014"}
                    </div>
                  </div>
                  {p.var_count>0 && (
                    <div>
                      <div style={{ fontSize:9, fontWeight:700, color:"#9ca3af",
                        textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:2 }}>
                        VARIABLES
                      </div>
                      <div style={{ fontSize:22, fontWeight:800, color:"#7c3aed",
                        fontFamily:"'IBM Plex Mono',monospace", lineHeight:1 }}>
                        {String(p.var_count||0).padStart(2,"0")}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ display:"flex", gap:8 }}>
                  {(user?.role==="admin" || user?.role==="superadmin" || user?.id===1 || user?.uid===1) && (
                    <button onClick={()=>setVarModal(p)}
                      style={{ ...s.btn("ghost",true), fontSize:12, padding:"8px 14px",
                        border:"1.5px solid #e5e7eb", borderRadius:8,
                        display:"flex", alignItems:"center", gap:5 }}>
                      {"\uD83D\uDD10"} Variables
                      {p.var_count>0 && (
                        <span style={{ background:"#7c3aed", color:"#fff",
                          borderRadius:20, padding:"1px 6px", fontSize:10, fontWeight:700 }}>
                          {p.var_count}
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {projects.length===0 && (
          <div style={{ gridColumn:"1/-1" }}>
            <Empty msg="No projects yet — create your first project" />
          </div>
        )}
      </div>

      {varModal && <ProjectVariables project={varModal} onClose={()=>setVarModal(null)} />}

      {detailModal && (() => {
        const p = detailModal;
        const passRate = p.test_count>0 ? parseFloat(p.pass_rate||0) : null;
        const passColor = passRate===null?"#9ca3af":passRate>=80?"#16a34a":passRate>=50?"#f59e0b":"#ef4444";
        return (
          <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setDetailModal(null)}>
            <div style={{ ...s.modalBox, maxWidth:520 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
                <div>
                  <div style={{ fontSize:20, fontWeight:800, color:"#0d1425" }}>{p.name}</div>
                  {p.org_name && (
                    <div style={{ fontSize:12, color:"#6b7280", marginTop:3 }}>{"\uD83C\uDFE2"} {p.org_name}</div>
                  )}
                </div>
                <button onClick={()=>setDetailModal(null)}
                  style={{ background:"none", border:"none", fontSize:20,
                    cursor:"pointer", color:"#9ca3af", lineHeight:1 }}>{"×"}</button>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12, marginBottom:20 }}>
                {[
                  { label:"TEST CASES", value:String(p.test_count||0).padStart(2,"0"), color:"#0d1425" },
                  { label:"PASS RATE",  value:passRate===null?"\u2014":`${passRate.toFixed(1)}%`, color:passColor },
                  { label:"VARIABLES",  value:String(p.var_count||0).padStart(2,"0"), color:"#7c3aed" },
                ].map(stat => (
                  <div key={stat.label} style={{ background:"#f8f9fc", borderRadius:10,
                    padding:"14px 16px", textAlign:"center" }}>
                    <div style={{ fontSize:9, fontWeight:700, color:"#9ca3af",
                      textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:6 }}>
                      {stat.label}
                    </div>
                    <div style={{ fontSize:26, fontWeight:800, color:stat.color,
                      fontFamily:"'IBM Plex Mono',monospace" }}>
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                {[
                  { label:"Description", value:p.description||"No description" },
                  { label:"Base URL",    value:p.base_url||"Not set" },
                  { label:"Organisation",value:p.org_name||"None" },
                  { label:"Created by",  value:`User #${p.created_by||"\u2014"}` },
                  { label:"Created",     value:p.created_at?new Date(p.created_at).toLocaleString("en-IN"):"\u2014" },
                ].map(row => (
                  <div key={row.label} style={{ display:"flex", gap:12,
                    padding:"10px 0", borderBottom:"1px solid #f3f4f6" }}>
                    <div style={{ fontSize:12, fontWeight:700, color:"#6b7280",
                      minWidth:120, flexShrink:0 }}>{row.label}</div>
                    <div style={{ fontSize:12,
                      fontFamily:row.label==="Base URL"?"'IBM Plex Mono',monospace":"inherit",
                      color:row.label==="Base URL"?"#3b82f6":"#0d1425" }}>
                      {row.value}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
                {canManage && (
                  <button onClick={()=>{ setDetailModal(null); openEdit(p); }}
                    style={s.btn("ghost")}>{"\u270F\uFE0F"} Edit Project</button>
                )}
                <button onClick={()=>setDetailModal(null)}
                  style={{ ...s.btn("primary"), background:"#0d1425", borderColor:"#0d1425" }}>
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {modal && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setModal(false)}>
          <div style={{ ...s.modalBox, maxWidth:440 }}>
            <div style={{ fontSize:18, fontWeight:800, marginBottom:20 }}>New Project</div>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div><label style={s.label}>Project Name *</label>
                <input style={s.input} value={form.name} placeholder="e.g. Patient Registration" maxLength={255}
                  onChange={e=>setForm(f=>({...f,name:e.target.value}))} /></div>
              <div><label style={s.label}>Description</label>
                <textarea style={{ ...s.input, height:72, resize:"vertical" }} value={form.description} maxLength={2000}
                  placeholder="What does this project test? (max 2000 chars)"
                  onChange={e=>setForm(f=>({...f,description:e.target.value}))} /></div>
              <div><label style={s.label}>Base URL</label>
                <input style={s.input} value={form.base_url} placeholder="https://sqa.example.org" maxLength={500}
                  onChange={e=>setForm(f=>({...f,base_url:e.target.value}))} /></div>
              <div>
                <label style={s.label}>Organisation *</label>
                <select style={{ ...s.input, borderColor: !form.org_id?"#fca5a5":"" }}
                  value={form.org_id}
                  onChange={e=>setForm(f=>({...f,org_id:e.target.value}))}>
                  <option value="">— Select Organisation —</option>
                  {orgs.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {!form.org_id && (
                  <div style={{ fontSize:11, color:"#dc2626", marginTop:3 }}>
                    Organisation is required
                  </div>
                )}
              </div>
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
              <button style={s.btn("ghost")} onClick={()=>setModal(false)}>Cancel</button>
              <button style={s.btn("primary")} onClick={save} disabled={saving}>
                {saving?"Creating...":"Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editModal && (
        <div style={s.modal} onClick={e=>e.target===e.currentTarget&&setEditModal(null)}>
          <div style={{ ...s.modalBox, maxWidth:440 }}>
            <div style={{ fontSize:18, fontWeight:800, marginBottom:4 }}>Edit Project</div>
            <div style={{ fontSize:13, color:"#9ca3af", marginBottom:20 }}>
              Editing <b style={{color:"#0d1425"}}>{editModal.name}</b> — name cannot be changed
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              <div><label style={s.label}>Description</label>
                <textarea style={{ ...s.input, height:80, resize:"vertical" }}
                  value={editForm.description}
                  placeholder="What does this project test?"
                  onChange={e=>setEditForm(f=>({...f,description:e.target.value}))} /></div>
              <div><label style={s.label}>Base URL</label>
                <input style={s.input} value={editForm.base_url} maxLength={500}
                  placeholder="https://sqa.example.org"
                  onChange={e=>setEditForm(f=>({...f,base_url:e.target.value}))} /></div>
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:20 }}>
              <button style={s.btn("ghost")} onClick={()=>setEditModal(null)}>Cancel</button>
              <button style={s.btn("primary")} onClick={saveEdit} disabled={saving}>
                {saving?"Saving...":"Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


export { Login, Dashboard, TestCases, RunModal, RunHistory, RunDetail, Projects };
