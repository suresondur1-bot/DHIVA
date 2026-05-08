import React, { useState, useEffect, useRef, useCallback } from "react";
import { API, WS, C, s, api, getToken, getUser, GlobalStyle, Spinner, Badge, Empty, Pagination, setAppPageSize } from "./shared.jsx";
import { Login, Dashboard, TestCases, RunModal, RunHistory, RunDetail, Projects } from "./Pages1.jsx";
import { TestSuites, DbConnections, SuiteRunner } from "./Pages2.jsx";
import { Schedules, AiGenerator, FlowBuilder, HelpDocs } from "./Pages3.jsx";
import { ModuleMaster, QueryBuilder, QueryPreview, OrgMaster, UserMaster, ChangePasswordModal, AccessRequests } from "./Admin.jsx";

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
    ]
  },
  {
    section: "CONFIG",
    items: [
      { key:"dbconns",    label:"DB Connections", icon:"🗄️" },
      { key:"schedules",  label:"Schedules",      icon:"⏰" },
      { key:"users",      label:"User Master",    icon:"👥", adminOnly:true },
      { key:"access-req",  label:"Access Requests", icon:"📋", superAdminOnly:true },
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
  const [loading,     setLoading]     = useState(false);
  const [runModal,    setRunModal]    = useState(null);
  const [viewRun,     setViewRun]     = useState(null);
  const [viewProjectId, setViewProjectId] = useState(null);
  const [showChangePw,setShowChangePw]= useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [mustChangePw, setMustChangePw] = useState(false);

  // Auto-navigate to tests tab when extension sends steps via hash
  useEffect(() => {
    const checkHash = () => {
      if (window.location.hash.startsWith('#recorder') && user) {
        setTab('tests');
      }
    };
    checkHash();
    window.addEventListener('hashchange', checkHash);
    window.addEventListener('focus', checkHash);
    return () => {
      window.removeEventListener('hashchange', checkHash);
      window.removeEventListener('focus', checkHash);
    };
  }, [user]);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      // Only fetch small, widely-needed data — tests/runs are lazy-loaded per tab
      const [p, su] = await Promise.all([
        api("/api/projects").catch(()=>[]),
        api("/api/suites").catch(()=>[]),
      ]);
      React.startTransition(() => {
        setProjects(p);
        setSuites(su);
        setLoading(false);
      });
    } catch (e) { console.error(e); setLoading(false); }
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

  const logout = async () => {
    try { await api("/api/auth/logout", { method:"POST" }); } catch {}
    // Tell extension to clear its stored token
    try {
      const extId = window.__ATHMA_EXT_ID__ || localStorage.getItem('athma_ext_id');
      if (extId && window.chrome?.runtime) {
        window.chrome.runtime.sendMessage(extId, { type: 'nat_clear_token' }, () => {});
      }
    } catch(e) {}
    localStorage.clear();
    setUser(null);
  };

  const logoutAll = async () => {
    if (!confirm("Sign out from all devices? You will need to log in again.")) return;
    try { await api("/api/auth/logout-all", { method:"POST" }); } catch {}
    // Tell extension to clear its stored token
    try {
      const extId = window.__ATHMA_EXT_ID__ || localStorage.getItem('athma_ext_id');
      if (extId && window.chrome?.runtime) {
        window.chrome.runtime.sendMessage(extId, { type: 'nat_clear_token' }, () => {});
      }
    } catch(e) {}
    localStorage.clear();
    setUser(null);
  };

  if (!user) return <Login onLogin={u => {
    setUser(u);
    if (u?.must_change_password) { setMustChangePw(true); setShowChangePw(true); }
  }} />;

  const commonProps = { projects, suites, onRefresh: loadAll, user };

  return (
    <div style={s.app}>
      <GlobalStyle />
      {/* Sidebar */}
      <div style={s.sidebar}>
        <div style={s.logo}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:2 }}>
            <div style={{ width:34, height:34,
              background:"linear-gradient(135deg,#1a56db,#3b82f6)",
              borderRadius:9, display:"flex", alignItems:"center",
              justifyContent:"center", fontSize:18, flexShrink:0,
              boxShadow:"0 3px 10px rgba(26,86,219,0.35)" }}>⚡</div>
            <div>
              <div style={s.logoText}>Automation Hub</div>
              <div style={s.logoSub}>ENTERPRISE CONTROL</div>
            </div>
          </div>
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
        <div style={s.topbar}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ color:"#8a96a8", fontSize:13 }}>ATHMA</span>
            <span style={{ color:"#cdd3dc" }}>›</span>
            <span style={{ fontWeight:600, fontSize:14, color:"#1a2332" }}>{NAV.find(n=>n.key===tab)?.label}</span>
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
          {loading && <div style={{ position:"absolute", top:0, left:0, right:0, height:3,
            background:"linear-gradient(90deg,#1a56db,#3b82f6)",
            animation:"pulse 1s ease-in-out infinite", zIndex:10 }} />}
          <>
            {tab==="dashboard" && <Dashboard {...commonProps} />}
            {tab==="tests"     && !viewRun && <TestCases {...commonProps} onRun={t=>setRunModal(t)} initProjectFilter={viewProjectId} onClearProjectFilter={()=>setViewProjectId(null)} />}
            {tab==="runs"      && !viewRun && <RunHistory onViewRun={r=>{ setViewRun(r); }} />}
            {tab==="suite-runs" && <SuiteRunner projects={projects} suites={suites} user={user} />}
            {tab==="runs"      && viewRun  && <RunDetail run={viewRun} onBack={()=>setViewRun(null)} />}
            {tab==="projects"  && <Projects {...commonProps} onViewProject={id=>{ setViewProjectId(id); setTab("tests"); }} />}
            {tab==="suites"     && <TestSuites projects={projects} suites={suites} onRefresh={loadAll} user={user} />}
            {tab==="modules"    && <ModuleMaster projects={projects} user={user} />}
            {tab==="dbconns"   && <DbConnections user={user} />}
            {tab==="schedules" && <Schedules suites={suites} projects={projects} user={user} />}
            {tab==="ai-gen"    && <AiGenerator projects={projects} suites={suites} setTab={setTab} />}
            {tab==="orgs"  && (user?.id===1||user?.uid===1||user?.role==="superadmin") && <OrgMaster user={user} projects={projects} />}
            {tab==="users"      && (user?.role==="admin"||user?.role==="superadmin"||user?.id===1||user?.uid===1) && <UserMaster user={user} projects={projects} />}
            {tab==="access-req" && (user?.id===1||user?.uid===1) && <AccessRequests />}
            {tab==="help"      && <HelpDocs />}
          </>
        </div>

      </div>

      {/* Run Modal */}
      {runModal && (
        <RunModal
          test={runModal}
          onClose={() => setRunModal(null)}
          onStarted={() => {}}
        />
      )}
    </div>
  );
}
