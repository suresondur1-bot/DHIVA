import React, { useState, useEffect, useRef, useCallback } from "react";
import { API, WS, C, s, api, getToken, getUser, GlobalStyle, Spinner, Badge, Empty, Pagination, setAppPageSize } from "./shared.jsx";
import { Login, Dashboard, TestCases, RunModal, RunHistory, RunDetail, Projects } from "./Pages1.jsx";
import { TestSuites, DbConnections, SuiteRunner } from "./Pages2.jsx";
import { Schedules, AiGenerator, FlowBuilder, HelpDocs } from "./Pages3.jsx";
import CicdConfig from "./CicdConfig.jsx";
import JiraBugBoard from "./JiraBugBoard.jsx";
import JiraConfig   from "./JiraConfig.jsx";
import { ModuleMaster, QueryBuilder, QueryPreview, OrgMaster, UserMaster, ChangePasswordModal, AccessRequests, VisualPrompts } from "./Admin.jsx";
import { KeywordAdvisorButton } from "./KeywordAdvisor.jsx";
import SmartPageStudy from "./SmartPageStudy.jsx";
import MultilingualTest from "./MultilingualTest.jsx";
import VisualScan from "./VisualScan.jsx";
import CustomControls from "./CustomControls.jsx";
import AutoScan from "./AutoScan.jsx";
import AutoScanGuided from "./AutoScanGuided.jsx";
import AgentTests from "./AgentTests.jsx";



const NAV_SECTIONS = [
  {
    section: "GENERAL",
    items: [
      { key:"dashboard",  label:"Dashboard",      icon:"📊" },
      { key:"projects",   label:"Projects",       icon:"📁" },
      { key:"orgs",       label:"Organisations",  icon:"🏢", superAdminOnly:true },
    ]
  },
  {
    section: "TESTING",
    items: [
      { key:"tests",      label:"Test Cases",     icon:"🧪" },
      { key:"runs",       label:"Run History",    icon:"📋" },
      { key:"suite-runs", label:"Suite Runner",   icon:"🚀" },
      { key:"suites",     label:"Test Suites",    icon:"🗂️" },
      { key:"modules",    label:"Modules",        icon:"📦", adminOnly:true },
      { key:"ai-gen",     label:"AI Generator",   icon:"🤖" },
      { key:"jira-bugs",  label:"Bug Board",       icon:"🐛" },
      { key:"smart-study",label:"Smart Study",     icon:"🧠" },
      { key:"multilingual",label:"Multilingual",    icon:"🌐" },
      { key:"visual-scan",label:"Visual Scan",     icon:"🎨" },
      { key:"custom-controls",label:"Custom Controls", icon:"🧩" },
      { key:"agent-tests",label:"Agent Tests", icon:"🤖" },
      { key:"auto-scan",  label:"Auto Scan",   icon:"🔍" },
      { key:"auto-scan-guided", label:"Guided Auto Scan", icon:"🧭" },
    ]
  },

  {
    section: "CONFIG",
    items: [
      { key:"dbconns",    label:"DB Connections", icon:"🗄️" },
      { key:"schedules",  label:"Schedules",      icon:"⏰" },
      { key:"cicd",       label:"CI/CD Config",   icon:"⚙️", adminOnly:true },
      { key:"users",      label:"User Master",    icon:"👥", adminOnly:true },
      { key:"access-req",  label:"Access Requests", icon:"📋", superAdminOnly:true },
      { key:"visual-prompts", label:"Visual Prompts",  icon:"🖼️", adminOnly:true },
    ]
  },
  {
    section: "SUPPORT",
    items: [
      { key:"help",       label:"Help & Docs",    icon:"📖" },
    ]
  },
];

// Flat NAV for lookups
const NAV = NAV_SECTIONS.flatMap(sec => sec.items);

export default function App() {
  const [user,     setUser]     = useState(getUser());
  const [tab,      setTab]      = useState("dashboard");
  const [projects, setProjects] = useState([]);
  const [suites,   setSuites]   = useState([]);
  const [tests,    setTests]    = useState([]);
  const [runs,     setRuns]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [runModal,    setRunModal]    = useState(null);
  const [viewRun,     setViewRun]     = useState(null);
  const [viewProjectId, setViewProjectId] = useState(null);
  const [showChangePw,setShowChangePw]= useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mustChangePw, setMustChangePw] = useState(false);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Load each independently so one failure doesn't block others
      const [p, su, t, r] = await Promise.all([
        api("/api/projects").catch(()=>[]),
        api("/api/suites").catch(()=>[]),
        api("/api/tests").catch(()=>[]),
        api("/api/runs?limit=100").catch(()=>[]),
      ]);
      setProjects(p);
      setSuites(su);
      setTests(Array.isArray(t) ? t : (t?.rows || []));
      // Handle both array (old) and paginated object {rows, total} (new)
      setRuns(Array.isArray(r) ? r : (r?.rows || []));
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [user]);
   
  // Fetch server config (page size etc.) FIRST, then load data
  useEffect(() => {
    if (!user) return;
    fetch(`${API}/api/health`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("autoqa_token")}` }
    })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => {
        if (cfg?.page_size && cfg.page_size > 0) {
          setAppPageSize(cfg.page_size);
          console.log("[ATHMA] Page size from server:", cfg.page_size);
        }
      })
      .catch(() => {})
      .finally(() => loadAll());
  }, [user]);
  //=================================
  const logout = async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    localStorage.clear();
    setUser(null);
  };

  const logoutAll = async () => {
    if (!confirm("Sign out from all devices? You will need to log in again.")) return;
    try { await api("/api/auth/logout-all", { method:"POST" }); } catch {}
    localStorage.clear();
    setUser(null);
  };

  if (!user) return <Login onLogin={u => {
    setUser(u);
    if (u?.must_change_password) { setMustChangePw(true); setShowChangePw(true); }
  }} />;
 //===================================  
  const commonProps = { projects, suites, tests, runs, onRefresh: loadAll, user };

  return (
    <div style={s.app}>
      <GlobalStyle />
      {/* Sidebar */}
      <div style={s.sidebar}>
        <div style={{ width:240, height:60, borderBottom:"1px solid #e2e8f0", overflow:"hidden", flexShrink:0, background:"#fff", display:"flex", alignItems:"center", paddingLeft:12 }}>
          <img src="/qavya.png" alt="QAVYA" style={{ width:200, height:"auto", display:"block", objectFit:"contain" }} />
        </div>
        <div style={{ flex:1, overflowY:"auto", overflowX:"hidden", minHeight:0, padding:"8px 0" }}>
          {NAV_SECTIONS.map(section => {
            const isSA = user?.id === 1 || user?.uid === 1 || user?.role === "superadmin";
            const visibleItems = section.items.filter(n => {
              if (n.superAdminOnly) return isSA;
              if (n.adminOnly) return isSA || user?.role === "admin";
              return true;
            });
            if (!visibleItems.length) return null;
            return (
              <div key={section.section}>
                <div style={{ padding:"14px 16px 5px",
                  fontSize:9, fontWeight:700,
                  color:"#9ca3af",
                  letterSpacing:"0.16em", textTransform:"uppercase" }}>
                  {section.section}
                </div>
                {visibleItems.map(n => (
                  <div key={n.key} style={s.nav(tab===n.key)}
                    onClick={()=>{ setViewRun(null); setTab(n.key); }}>
                    <span style={{ fontSize:15 }}>{n.icon}</span>
                    <span>{n.label}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

      </div>
      {/* Main */}
      <div style={s.main}>
        <div style={{...s.topbar, padding:"0 24px 0 0"}}>
          <div style={{ display:"flex", alignItems:"center", gap:8, paddingLeft:0 }}>
            <span style={{ color:"#8B0000", fontSize:13, fontWeight:700 }}>QAVYA</span>
            <span style={{ color:"#cdd3dc" }}>›</span>
            <span style={{ fontWeight:700, fontSize:14, color:"#8B0000" }}>{NAV.find(n=>n.key===tab)?.label}</span>
          </div>
          
          <div style={{ display:"flex", alignItems:"center", gap:12 }}>
            <span style={{ fontSize:12, color:"#8a96a8" }}>
              {new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}
            </span>
            <button style={{ ...s.btn("ghost"), fontSize:12, padding:"5px 14px" }} onClick={loadAll}>↻ Refresh</button>

            {/* User avatar + dropdown */}
            <div style={{ position:"relative" }}>
              <div
                onClick={()=>setShowUserMenu(m=>!m)}
                style={{ width:36, height:36, borderRadius:"50%", cursor:"pointer",
                  background:`hsl(${((user.username||"A").charCodeAt(0)*47)%360},55%,55%)`,
                  display:"flex", alignItems:"center", justifyContent:"center",
                  fontSize:15, fontWeight:800, color:"#fff",
                  boxShadow:"0 2px 8px rgba(0,0,0,0.15)",
                  border:"2px solid #e2e6ed",
                  userSelect:"none", transition:"transform 0.15s" }}
                title={`${user.full_name||user.username} (${user.role})`}
                onMouseEnter={e=>e.currentTarget.style.transform="scale(1.08)"}
                onMouseLeave={e=>e.currentTarget.style.transform=""}>
                {(user.full_name||user.username||"A").charAt(0).toUpperCase()}
              </div>

              {showUserMenu && (
                <>
                  {/* Backdrop */}
                  <div style={{ position:"fixed", inset:0, zIndex:999 }}
                    onClick={()=>setShowUserMenu(false)} />
                  {/* Dropdown */}
                  <div style={{ position:"absolute", top:"calc(100% + 8px)", right:0,
                    background:"#fff", borderRadius:12, zIndex:1000, minWidth:220,
                    boxShadow:"0 8px 32px rgba(0,0,0,0.14)", border:"1px solid #e5e7eb",
                    overflow:"hidden" }}>
                    {/* User info header */}
                    <div style={{ padding:"14px 16px", borderBottom:"1px solid #f3f4f6",
                      background:"#f9fafb" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:38, height:38, borderRadius:"50%",
                          background:`hsl(${((user.username||"A").charCodeAt(0)*47)%360},55%,55%)`,
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:16, fontWeight:800, color:"#fff", flexShrink:0 }}>
                          {(user.full_name||user.username||"A").charAt(0).toUpperCase()}
                        </div>
                        <div style={{ minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:700, color:"#111827",
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {user.full_name||user.username}
                          </div>
                          <div style={{ fontSize:11, color:"#6b7280",
                            textTransform:"uppercase", letterSpacing:"0.05em" }}>
                            {user.role}
                          </div>
                          {user.org_name && (
                            <div style={{ fontSize:11, color:"#3b82f6", marginTop:2 }}>
                              🏢 {user.org_name}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {/* Actions */}
                    <div style={{ padding:"6px" }}>
                      <button
                        onClick={()=>{ setShowUserMenu(false); setShowChangePw(true); }}
                        style={{ width:"100%", padding:"9px 14px", border:"none", borderRadius:8,
                          background:"transparent", cursor:"pointer", fontSize:13, fontWeight:600,
                          color:"#374151", textAlign:"left", display:"flex", alignItems:"center",
                          gap:10, transition:"background 0.12s" }}
                        onMouseEnter={e=>e.currentTarget.style.background="#f3f4f6"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        🔑 Change Password
                      </button>
                      <div style={{ height:1, background:"#f3f4f6", margin:"4px 0" }}/>
                      <button
                        onClick={()=>{ setShowUserMenu(false); logout(); }}
                        style={{ width:"100%", padding:"9px 14px", border:"none", borderRadius:8,
                          background:"transparent", cursor:"pointer", fontSize:13, fontWeight:600,
                          color:"#ef4444", textAlign:"left", display:"flex", alignItems:"center",
                          gap:10, transition:"background 0.12s" }}
                        onMouseEnter={e=>e.currentTarget.style.background="#fff5f5"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        ⏻ Sign Out
                      </button>
                      <button
                        onClick={()=>{ setShowUserMenu(false); logoutAll(); }}
                        style={{ width:"100%", padding:"9px 14px", border:"none", borderRadius:8,
                          background:"transparent", cursor:"pointer", fontSize:13, fontWeight:600,
                          color:"#dc2626", textAlign:"left", display:"flex", alignItems:"center",
                          gap:10, transition:"background 0.12s" }}
                        onMouseEnter={e=>e.currentTarget.style.background="#fff5f5"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        ⏻⏻ Sign Out All Devices
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          {showChangePw && <ChangePasswordModal user={user} forcedChange={mustChangePw} onClose={()=>{ if(!mustChangePw){ setShowChangePw(false); } }} onChanged={()=>{ setMustChangePw(false); setShowChangePw(false); const u2={...user,must_change_password:false}; localStorage.setItem("autoqa_user",JSON.stringify(u2)); setUser(u2); }} />}
        </div>

        <div style={s.content}>
          {loading ? <Spinner /> : (
            <>
              {tab==="dashboard" && <Dashboard {...commonProps} />}
              {tab==="tests"     && !viewRun && <TestCases {...commonProps} onRun={t=>setRunModal(t)} initProjectFilter={viewProjectId} onClearProjectFilter={()=>setViewProjectId(null)} />}
              {tab==="runs"      && !viewRun && <RunHistory onViewRun={r=>{ setViewRun(r); }} />}
              {tab==="suite-runs" && <SuiteRunner projects={projects} suites={suites} tests={tests} user={user} />}
              {tab==="runs"      && viewRun  && <RunDetail run={viewRun} onBack={()=>setViewRun(null)} />}
              {tab==="projects"  && <Projects {...commonProps} onViewProject={id=>{ setViewProjectId(id); setTab("tests"); }} />}
              {tab==="suites"     && <TestSuites projects={projects} suites={suites} onRefresh={loadAll} user={user} />}
              {tab==="modules"    && <ModuleMaster projects={projects} user={user} />}
              {tab==="dbconns"   && <DbConnections user={user} />}
              {tab==="schedules" && <Schedules tests={tests} suites={suites} projects={projects} user={user} />}
              {tab==="cicd"      && <CicdConfig user={user} />}
              {tab==="jira-bugs" && <JiraBugBoard user={user} />}
              {tab==="ai-gen"    && <AiGenerator projects={projects} suites={suites} tests={tests} setTab={setTab} />}
              {tab==="smart-study" && <SmartPageStudy user={user} projects={projects} />}
              {tab==="multilingual" && <MultilingualTest user={user} projects={projects} />}
              {tab==="visual-scan" && <VisualScan user={user} />}
              {tab==="custom-controls" && <CustomControls user={user} projects={projects} />}
              {tab==="agent-tests" && <AgentTests user={user} projects={projects} />}

              {tab==="auto-scan"   && <AutoScan user={user} />}
              {tab==="auto-scan-guided" && <AutoScanGuided user={user} />}
              {tab==="orgs"  && (user?.id===1||user?.uid===1||user?.role==="superadmin") && <OrgMaster user={user} />}
              {tab==="users"      && (user?.role==="admin"||user?.role==="superadmin"||user?.id===1||user?.uid===1) && <UserMaster user={user} projects={projects} />}
              {tab==="access-req" && (user?.id===1||user?.uid===1) && <AccessRequests />}
              {tab==="visual-prompts" && (user?.role==="admin"||user?.role==="superadmin"||user?.id===1||user?.uid===1) && <VisualPrompts />}
              {tab==="help"      && <HelpDocs />}
            </>
          )}
        </div>

      </div>

      {/* Run Modal */}
      {runModal && (
        <RunModal
          test={runModal}
          onClose={() => { setRunModal(null); }}
          onStarted={() => {}}
        />
      )}
      {/* Keyword Advisor floating button */}
      <KeywordAdvisorButton />
    </div>
  );
}
