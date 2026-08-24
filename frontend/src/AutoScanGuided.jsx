/**
 * AutoScanGuided.jsx — Qavya Autonomous Scanner (3-Phase Guided Flow)
 * ENHANCED WITH SCREEN SELECTION
 *
 * Phase 1 DISCOVER : login + crawl all screens (no testing yet)
 * Phase 2 REVIEW   : view each screen's screenshot, select which to test, attach DB queries
 * Phase 3 TEST     : fresh login + run tests on SELECTED screens only
 *
 * Self-contained. Talks to the backend endpoints.
 */

import { useState, useEffect, useRef } from 'react';
import AutoScanRefine from './AutoScanRefine';

const API = '/api/auto-scan';

const SEV_COLOR = { critical:'#dc2626', high:'#ea580c', medium:'#d97706', low:'#16a34a', data:'#7c3aed' };
const SEV_BG    = { critical:'#fef2f2', high:'#fff7ed', medium:'#fffbeb', low:'#f0fdf4', data:'#f5f3ff' };
const SEV_ORDER = { critical:0, high:1, medium:2, low:3, data:1 };
const RES_COLOR = { pass:'#16a34a', fail:'#dc2626', partial:'#d97706', error:'#dc2626' };
const RES_BG    = { pass:'#f0fdf4', fail:'#fef2f2', partial:'#fffbeb', error:'#fef2f2' };
const RES_ICON  = { pass:'✅', fail:'❌', partial:'⚠️', error:'💥' };

export default function AutoScanGuided() {
  // phases: 'form' | 'discovering' | 'review' | 'refine' | 'testing' | 'results'
  const [phase, setPhase] = useState('form');
  const [error, setError] = useState('');

  // connection form
  const [form, setForm] = useState({
    url:'', username:'', password:'', maxPages:15,
    navigationDescription:'', // NEW: User-provided navigation hints
    dbHost:'', dbPort:5432, dbName:'', dbUser:'', dbPass:'', dbSsl:false,
    jiraUrl:'', jiraEmail:'', jiraToken:'', jiraProjectKey:'',
  });
  const [useDb, setUseDb] = useState(false);
  const [enableDelete, setEnableDelete] = useState(false);
  const [useAuth, setUseAuth] = useState(true); // NEW: Toggle auth requirement

  // discovery
  const [discId, setDiscId]   = useState(null);
  const [disc,   setDisc]     = useState(null);   // {status, logs, screens[], origin, dbOk}
  const [queries, setQueries] = useState({});     // idx -> {label, query}
  const [validation, setValidation] = useState({}); // urlMatch -> {ok, dbCount, error}
  const [savingQ, setSavingQ] = useState(false);
  
  // ✨ NEW: Screen selection state
  const [selectedScreens, setSelectedScreens] = useState(new Set()); // Set of selected screen indices

  // test phase (reuses scan results shape)
  const [scanId, setScanId] = useState(null);
  const [scan,   setScan]   = useState(null);
  const [resultsTab, setResultsTab] = useState('mismatches');
  const [selTxn, setSelTxn] = useState(null);
  const [selBug, setSelBug] = useState(null);

  const discPoll = useRef(null);
  const scanPoll = useRef(null);

  const dbConfig = () => useDb && form.dbHost ? {
    host:form.dbHost, port:Number(form.dbPort)||5432, database:form.dbName,
    user:form.dbUser, password:form.dbPass, ssl:!!form.dbSsl,
  } : undefined;

  // ✨ NEW: Toggle screen selection
  const toggleScreenSelection = (idx) => {
    const newSet = new Set(selectedScreens);
    if (newSet.has(idx)) {
      newSet.delete(idx);
    } else {
      newSet.add(idx);
    }
    setSelectedScreens(newSet);
  };

  // ✨ NEW: Select/Deselect all
  const selectAllScreens = () => {
    const screens = disc?.screens || [];
    setSelectedScreens(new Set(screens.map(s => s.idx)));
  };

  const deselectAllScreens = () => {
    setSelectedScreens(new Set());
  };

  // ── PHASE 1: start discovery ────────────────────────────────────────────────
  const startDiscover = async () => {
    // Validate URL (always required)
    if (!form.url) { setError('App URL is required'); return; }
    
    // Validate auth: both required together OR both empty
    if ((form.username || form.password) && (!form.username || !form.password)) {
      setError('If auth is used, provide both username AND password'); return;
    }
    
    // Validate DB config if enabled
    if (useDb && (!form.dbHost||!form.dbName||!form.dbUser)) { 
      setError('DB host, database and user are required when DB check is enabled'); 
      return; 
    }
    
    setError('');
    try {
      const r = await fetch(`${API}/discover`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          url:form.url,
          username: form.username || undefined,
          password: form.password || undefined,
          navigationDescription: form.navigationDescription,
          maxPages:Number(form.maxPages), 
          db:dbConfig(),
        }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setDiscId(d.discoveryId); setDisc(null); setQueries({}); setValidation({});
      setSelectedScreens(new Set()); // Reset selected screens
      setPhase('discovering');
    } catch(e) { setError(e.message); }
  };

  // poll discovery
  useEffect(() => {
    if (phase!=='discovering' || !discId) return;
    discPoll.current = setInterval(async () => {
      try {
        const r = await fetch(`${API}/discover/${discId}`);
        const d = await r.json();
        setDisc(d);
        if (d.status==='completed') {
          clearInterval(discPoll.current);
          // pre-fill any saved queries and select all screens by default
          const pre = {};
          const allIdx = new Set();
          (d.screens||[]).forEach(s => { 
            allIdx.add(s.idx);
            if (s.savedQuery) pre[s.idx] = {label:s.savedLabel||s.title, query:s.savedQuery}; 
          });
          setQueries(pre);
          setSelectedScreens(allIdx); // Select all by default
          setPhase('review');
        } else if (d.status==='failed') {
          clearInterval(discPoll.current);
          setError(d.error||'Discovery failed'); setPhase('form');
        }
      } catch(e) {}
    }, 2000);
    return () => clearInterval(discPoll.current);
  }, [phase, discId]);

  // ── PHASE 2: save + validate queries ────────────────────────────────────────
  const setQ = (idx, screen, field, val) => {
    setQueries(q => ({...q, [idx]: {label: q[idx]?.label ?? screen.title, query: q[idx]?.query ?? '', [field]: val}}));
  };
  const urlMatchFor = (screen) => {
    // derive a stable urlMatch from the path (so it matches across pagination params)
    try { return new URL(screen.url).pathname; } catch(_) { return screen.url; }
  };

  const saveQueries = async () => {
    if (!useDb || !form.dbHost) { setError('Enable and fill DB connection to validate queries'); return; }
    const checks = Object.entries(queries)
      .filter(([,v]) => v && v.query && v.query.trim())
      .map(([idx,v]) => {
        const screen = disc.screens.find(s=>String(s.idx)===String(idx));
        return { urlMatch: urlMatchFor(screen), label: v.label||screen.title, query: v.query.trim() };
      });
    if (!checks.length) { setError('Add at least one query, or skip straight to testing'); return; }
    setError(''); setSavingQ(true);
    try {
      const r = await fetch(`${API}/discover/${discId}/queries`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ db:dbConfig(), checks }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); setSavingQ(false); return; }
      const v = {};
      (d.validated||[]).forEach(res => { v[res.urlMatch] = res; });
      setValidation(v);
    } catch(e) { setError(e.message); }
    setSavingQ(false);
  };

  // ── PHASE 2.5: start refine (ask Claude context questions) ──────────────────
  const startRefine = () => {
    if (selectedScreens.size === 0) {
      setError('Please select at least one screen to test');
      return;
    }
    setError('');
    setPhase('refine');
  };

  // Handle refine completion
  const handleRefineComplete = async () => {
    // Proceed to actual testing
    setError('');
    const dbChecks = (useDb && form.dbHost)
      ? Object.entries(queries)
          .filter(([,v]) => v && v.query && v.query.trim())
          .map(([idx,v]) => {
            const screen = disc.screens.find(s=>String(s.idx)===String(idx));
            return { urlMatch: urlMatchFor(screen), label: v.label||screen.title, query: v.query.trim() };
          })
      : [];
    try {
      const r = await fetch(`${API}/discover/${discId}/test`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          db:dbConfig(), enableDelete, dbChecks,
          selectedScreenIndices: Array.from(selectedScreens),
          jiraUrl:form.jiraUrl||undefined, jiraEmail:form.jiraEmail||undefined,
          jiraToken:form.jiraToken||undefined, jiraProjectKey:form.jiraProjectKey||undefined,
        }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); setPhase('review'); return; }
      setScanId(d.scanId); setScan(null); setSelTxn(null); setSelBug(null);
      setPhase('testing');
    } catch(e) { setError(e.message); setPhase('review'); }
  };

  const handleRefineCancel = () => {
    setPhase('review');
    setError('');
  };

  // ── PHASE 3: start test (WITH SELECTED SCREENS) ─────────────────────────────
  const startTest = () => {
    // Now this just goes to refine phase
    startRefine();
  };

  // ── RERUN: re-run the just-completed scan with identical settings ───────────
  const rerunScan = async () => {
    if (!scanId) return;
    setError('');
    try {
      const r = await fetch(`${API}/${scanId}/rerun`, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setScanId(d.scanId); setScan(null); setSelTxn(null); setSelBug(null);
      setPhase('testing');
    } catch(e) { setError(e.message); }
  };

  // poll test scan
  useEffect(() => {
    if (phase!=='testing' || !scanId) return;
    scanPoll.current = setInterval(async () => {
      try {
        const r = await fetch(`${API}/${scanId}`);
        const d = await r.json();
        setScan(d);
        if (d.status==='completed'||d.status==='failed') {
          clearInterval(scanPoll.current);
          setPhase('results');
        }
      } catch(e) {}
    }, 2000);
    return () => clearInterval(scanPoll.current);
  }, [phase, scanId]);

  const reset = () => {
    clearInterval(discPoll.current); clearInterval(scanPoll.current);
    setPhase('form'); setDiscId(null); setDisc(null); setQueries({}); setValidation({});
    setScanId(null); setScan(null); setSelTxn(null); setSelBug(null); setError('');
    setSelectedScreens(new Set());
  };

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════

  // Stepper header shown on every phase
  const Stepper = () => {
    const steps = [
      {k:'form',        n:1, label:'Connect'},
      {k:'discovering', n:2, label:'Discover'},
      {k:'review',      n:2, label:'Discover'},
      {k:'refine',      n:3, label:'Refine'},
      {k:'testing',     n:3, label:'Refine'},
      {k:'results',     n:3, label:'Test'},
    ];
    const curN = steps.find(s=>s.k===phase)?.n || 1;
    const labels = [{n:1,label:'Connect'},{n:2,label:'Discover'},{n:3,label:'Refine & Test'}];
    return (
      <div style={{display:'flex',alignItems:'center',gap:0,marginBottom:22}}>
        {labels.map((s,i)=>(
          <div key={s.n} style={{display:'flex',alignItems:'center',flex:i<labels.length-1?1:'0 0 auto'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{width:26,height:26,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',
                fontWeight:800,fontSize:13,
                background:curN>=s.n?'#6366f1':'#e2e8f0',color:curN>=s.n?'#fff':'#94a3b8'}}>{s.n}</div>
              <span style={{fontSize:13,fontWeight:curN===s.n?700:500,color:curN>=s.n?'#1e293b':'#94a3b8'}}>{s.label}</span>
            </div>
            {i<labels.length-1 && <div style={{flex:1,height:2,background:curN>s.n?'#6366f1':'#e2e8f0',margin:'0 12px'}} />}
          </div>
        ))}
      </div>
    );
  };

  // ── FORM (Phase 1 input) ─────────────────────────────────────────────────────
  if (phase==='form') return (
    <div style={wrap}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:20}}>
        <div style={{fontSize:30}}>🧭</div>
        <div>
          <h1 style={{margin:0,fontSize:21,fontWeight:700,color:'#1e293b'}}>Guided Auto Scan</h1>
          <p style={{margin:0,color:'#64748b',fontSize:13}}>Discover every screen → select which to test → run full tests</p>
        </div>
      </div>
      <Stepper/>

      <Card title="🌐 Application" mb={14}>
        <Field label="App URL *"><input style={inp} placeholder="http://172.19.1.11:4001/admin/login" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} /></Field>
        
        <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:'#374151',cursor:'pointer',marginBottom:14,marginTop:14}}>
          <input type="checkbox" checked={useAuth} onChange={e=>setUseAuth(e.target.checked)} />
          This app requires login (authentication)
        </label>
        
        {useAuth && (
          <>
            <Grid2>
              <Field label="Username"><input style={inp} placeholder="user@example.com" value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))} /></Field>
              <Field label="Password"><input style={inp} type="password" placeholder="••••••••" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} /></Field>
            </Grid2>
          </>
        )}
        
        <Field label="How to navigate through pages (optional)" mt={14}>
          <textarea style={{...inp,minHeight:80,fontFamily:'system-ui,sans-serif',resize:'vertical'}} 
            placeholder={`E.g.: "Click the blue 'Next' button at the bottom to go to the next page. There are 5 pages total."
OR: "Pagination at the bottom. Click page numbers 1, 2, 3, etc."
OR: "Left sidebar menu. Click each menu item to navigate."
OR leave blank to auto-detect navigation.`}
            value={form.navigationDescription} 
            onChange={e=>setForm(f=>({...f,navigationDescription:e.target.value}))} />
        </Field>
        
        <Field label="Max Pages (1–100)" mt={12}>
          <input style={{...inp,width:90}} type="number" min={1} max={100} value={form.maxPages} onChange={e=>setForm(f=>({...f,maxPages:e.target.value}))} />
        </Field>
      </Card>

      <Card title="🗄️ Database Cross-Check" subtitle="Optional — compare each screen's count against the database" mb={14}>
        <label style={{display:'flex',alignItems:'center',gap:8,fontSize:13,color:'#374151',cursor:'pointer',marginBottom:useDb?14:0}}>
          <input type="checkbox" checked={useDb} onChange={e=>setUseDb(e.target.checked)} />
          Enable database verification (Postgres)
        </label>
        {useDb && (
          <>
            <Grid2>
              <Field label="DB Host *"><input style={inp} placeholder="172.19.1.11" value={form.dbHost} onChange={e=>setForm(f=>({...f,dbHost:e.target.value}))} /></Field>
              <Field label="Port"><input style={inp} type="number" value={form.dbPort} onChange={e=>setForm(f=>({...f,dbPort:e.target.value}))} /></Field>
              <Field label="Database *"><input style={inp} placeholder="surveydb" value={form.dbName} onChange={e=>setForm(f=>({...f,dbName:e.target.value}))} /></Field>
              <Field label="DB User *"><input style={inp} placeholder="readonly_user" value={form.dbUser} onChange={e=>setForm(f=>({...f,dbUser:e.target.value}))} /></Field>
              <Field label="DB Password"><input style={inp} type="password" placeholder="••••••••" value={form.dbPass} onChange={e=>setForm(f=>({...f,dbPass:e.target.value}))} /></Field>
              <Field label="SSL">
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:13,color:'#374151',paddingTop:7}}>
                  <input type="checkbox" checked={form.dbSsl} onChange={e=>setForm(f=>({...f,dbSsl:e.target.checked}))} /> Use SSL
                </label>
              </Field>
            </Grid2>
            <div style={{fontSize:11,color:'#94a3b8',marginTop:4}}>🔒 Credentials are used per-run only and never stored. Use a read-only DB user.</div>
          </>
        )}
      </Card>

      <Card title="⚙️ Test Behavior" subtitle="The scanner creates uniquely-tagged test records (QAVYA_TEST_*) to verify create/list/filter flows" mb={14}>
        <label style={{display:'flex',alignItems:'flex-start',gap:8,fontSize:13,color:'#374151',cursor:'pointer'}}>
          <input type="checkbox" checked={enableDelete} onChange={e=>setEnableDelete(e.target.checked)} style={{marginTop:2}} />
          <span>Also test the <b>delete</b> flow. The scanner will delete ONLY the records it created (its own QAVYA_TEST_* rows) — never your real data. Leave off to create &amp; verify without deleting.</span>
        </label>
      </Card>

      <Card title="🐛 JIRA Config" subtitle="Optional — enables one-click bug posting after the test phase" mb={20}>
        <Grid2>
          <Field label="JIRA URL"><input style={inp} placeholder="https://your-org.atlassian.net" value={form.jiraUrl} onChange={e=>setForm(f=>({...f,jiraUrl:e.target.value}))} /></Field>
          <Field label="Project Key"><input style={inp} placeholder="QA" value={form.jiraProjectKey} onChange={e=>setForm(f=>({...f,jiraProjectKey:e.target.value}))} /></Field>
          <Field label="JIRA Email"><input style={inp} placeholder="you@narayana.com" value={form.jiraEmail} onChange={e=>setForm(f=>({...f,jiraEmail:e.target.value}))} /></Field>
          <Field label="JIRA API Token"><input style={inp} type="password" placeholder="Token" value={form.jiraToken} onChange={e=>setForm(f=>({...f,jiraToken:e.target.value}))} /></Field>
        </Grid2>
      </Card>

      {error && <ErrBox>{error}</ErrBox>}
      <button onClick={startDiscover} style={primaryBtn}>🧭 Start Discovery</button>
    </div>
  );

  // ── DISCOVERING (Phase 1 progress) ───────────────────────────────────────────
  if (phase==='discovering') return (
    <div style={wrap}>
      <Stepper/>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
        <span style={{fontSize:24}}>⏳</span>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>{disc?.status==='running'?'Discovering screens…':'Starting…'}</h2>
          <div style={{fontSize:11,color:'#64748b',marginTop:2,fontFamily:'monospace'}}>{form.url}</div>
        </div>
        <button onClick={reset} style={ghostBtn}>✕ Cancel</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8,marginBottom:14}}>
        <StatCard label="Screens found" value={disc?.screens?.length||0} color="#6366f1" />
        <StatCard label="DB connection" value={disc?.dbOk===true?'OK':disc?.dbOk===false?'Failed':useDb?'…':'—'} color={disc?.dbOk===false?'#dc2626':'#16a34a'} />
      </div>
      <LiveLog logs={disc?.logs} />
    </div>
  );

  // ── REVIEW (Phase 2: select screens + attach queries) ──────────────────────────────
  if (phase==='review') {
    const screens = disc?.screens || [];
    const selectedCount = selectedScreens.size;
    return (
      <div style={{...wrap,maxWidth:1000}}>
        <Stepper/>
        <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:8,flexWrap:'wrap'}}>
          <button onClick={reset} style={ghostBtn}>← Start over</button>
          <div style={{flex:1}}>
            <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>Review & select screens to test</h2>
            <div style={{fontSize:12,color:'#64748b',marginTop:2}}>{screens.length} screens found · {selectedCount} selected · {form.url}</div>
          </div>
          {useDb && <button onClick={saveQueries} disabled={savingQ} style={{...ghostBtn,borderColor:'#6366f1',color:'#6366f1',fontWeight:700,opacity:savingQ?0.6:1}}>{savingQ?'⏳ Validating…':'✓ Validate & Save Queries'}</button>}
          <button onClick={startTest} style={{...primaryBtn,width:'auto',padding:'8px 16px',fontSize:13}} disabled={selectedCount===0}>▶ Refine & Test ({selectedCount} screens)</button>
        </div>

        {!useDb && (
          <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:'#1e40af'}}>
            ℹ️ Database verification was not enabled, so no per-screen queries are needed. Select the screens below you want to test, then click <b>Start Testing</b>.
          </div>
        )}
        {useDb && (
          <div style={{background:'#f5f3ff',border:'1px solid #ddd6fe',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:'#5b21b6'}}>
            🗄️ For each screen with a count, write a query that returns that same number from the DB. Click <b>Validate & Save</b> to confirm each runs. Then select the screens you want to test.
          </div>
        )}

        {/* ✨ NEW: Screen selection controls */}
        <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:'12px 14px',marginBottom:14,display:'flex',alignItems:'center',gap:12}}>
          <span style={{fontSize:13,fontWeight:700,color:'#1e293b'}}>Quick select:</span>
          <button onClick={selectAllScreens} style={{...ghostBtn,borderColor:'#6366f1',color:'#6366f1',fontWeight:600}}>Select all</button>
          <button onClick={deselectAllScreens} style={{...ghostBtn,fontWeight:600}}>Deselect all</button>
          <span style={{marginLeft:'auto',fontSize:12,color:'#64748b'}}>{selectedCount} of {screens.length} selected</span>
        </div>

        {error && <ErrBox>{error}</ErrBox>}

        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(300px,1fr))',gap:14}}>
          {screens.map(s=>{
            const um = urlMatchFor(s);
            const val = validation[um];
            const q = queries[s.idx] || {label:s.title, query:''};
            const isSelected = selectedScreens.has(s.idx);
            return (
              <div key={s.idx} style={{background:'#fff',border:`2px solid ${isSelected?'#6366f1':'#e2e8f0'}`,borderRadius:10,overflow:'hidden',display:'flex',flexDirection:'column',transition:'all 0.2s',opacity:isSelected?1:0.85}}>
                {/* ✨ NEW: Image with checkbox overlay */}
                <div style={{position:'relative',width:'100%',height:150,background:'#f8fafc'}}>
                  <img src={`${API}/discover/${discId}/screenshot/${s.idx}`} alt={s.title}
                    style={{width:'100%',height:150,objectFit:'cover',objectPosition:'top'}}
                    onError={e=>e.target.style.display='none'} />
                  <label style={{position:'absolute',top:8,right:8,display:'flex',alignItems:'center',gap:6,background:'rgba(255,255,255,0.95)',padding:'6px 10px',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:13,color:'#1e293b'}}>
                    <input 
                      type="checkbox" 
                      checked={isSelected}
                      onChange={() => toggleScreenSelection(s.idx)}
                      style={{cursor:'pointer',width:18,height:18}}
                    />
                    {isSelected ? '✓ Selected' : 'Select'}
                  </label>
                </div>
                <div style={{padding:'10px 12px',flex:1,display:'flex',flexDirection:'column'}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#1e293b',marginBottom:2}}>{s.title||'Untitled'}</div>
                  <div style={{fontSize:11,color:'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:8}}>{um}</div>
                  <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:10}}>
                    {s.apiTotal!=null && <span style={{fontSize:10,background:'#eff6ff',color:'#3b82f6',padding:'2px 7px',borderRadius:6,fontWeight:700}}>UI count: {s.apiTotal}</span>}
                    {s.hasForm && <span style={{fontSize:10,background:'#fefce8',color:'#a16207',padding:'2px 7px',borderRadius:6}}>has form</span>}
                  </div>

                  {useDb && (
                    <div style={{marginTop:'auto'}}>
                      <input style={{...inp,fontSize:12,marginBottom:6}} placeholder="Label (e.g. Surveys)"
                        value={q.label} onChange={e=>setQ(s.idx,s,'label',e.target.value)} />
                      <textarea style={{...inp,fontSize:11,fontFamily:'monospace',minHeight:52,resize:'vertical'}}
                        placeholder="SELECT count(*) FROM ... (read-only)"
                        value={q.query} onChange={e=>setQ(s.idx,s,'query',e.target.value)} />
                      {val && (
                        <div style={{marginTop:6,fontSize:11,fontWeight:600,
                          color: val.ok ? (val.dbCount===s.apiTotal?'#16a34a':'#ea580c') : '#dc2626'}}>
                          {val.ok
                            ? (val.dbCount===s.apiTotal
                                ? `✓ DB ${val.dbCount} = UI ${s.apiTotal}`
                                : `⚠ DB ${val.dbCount} vs UI ${s.apiTotal??'?'} (mismatch)`)
                            : `✗ ${val.error}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── REFINE (Phase 2.5: ask Claude context questions) ───────────────────────────────────
  if (phase==='refine') return (
    <div style={wrap}>
      <Stepper/>
      <AutoScanRefine 
        discId={discId} 
        disc={disc}
        selectedScreens={selectedScreens}
        onComplete={handleRefineComplete}
        onCancel={handleRefineCancel}
      />
    </div>
  );

  // ── TESTING (Phase 3 progress) ───────────────────────────────────────────────
  if (phase==='testing') return (
    <div style={wrap}>
      <Stepper/>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
        <span style={{fontSize:24}}>{scan?.status==='failed'?'❌':'⏳'}</span>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>{scan?.phase||'Starting tests…'}</h2>
          <div style={{fontSize:11,color:'#64748b',marginTop:2,fontFamily:'monospace'}}>{form.url}</div>
        </div>
        <button onClick={reset} style={ghostBtn}>✕ Cancel</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginBottom:14}}>
        <StatCard label="Phase"     value={scan?.phase||'—'} />
        <StatCard label="Pages"     value={scan?.pagesDiscovered||0} />
        <StatCard label="Scenarios" value={scan?.scenarioProgress||'0/0'} />
        <StatCard label="Bugs"      value={scan?.bugs?.length||0} color="#dc2626" />
      </div>
      {scan?.status==='failed' && <ErrBox>{scan.error}</ErrBox>}
      <LiveLog logs={scan?.logs} />
    </div>
  );

  // ── RESULTS (Phase 3 output) ─────────────────────────────────────────────────
  const bugs       = scan?.bugs || [];
  const txns       = scan?.transactions || [];
  const dbResults  = scan?.dbCheckResults || [];
  const dbPasses   = dbResults.filter(r=>r.match);
  const mismatches = bugs.filter(b=>b.source==='db_cross_check');
  const otherBugs  = bugs.filter(b=>b.source!=='db_cross_check').sort((a,b)=>(SEV_ORDER[a.severity]||9)-(SEV_ORDER[b.severity]||9));
  const txnPass    = txns.filter(t=>t.result==='pass').length;
  const txnFail    = txns.filter(t=>t.result==='fail'||t.result==='error').length;
  const txnPartial = txns.filter(t=>t.result==='partial').length;

  return (
    <div style={{...wrap,maxWidth:1000}}>
      <Stepper/>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18,flexWrap:'wrap'}}>
        <button onClick={reset} style={ghostBtn}>← New Scan</button>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>Test Complete</h2>
          <div style={{fontSize:11,color:'#64748b',marginTop:2}}>{form.url} · {scan?.pageCount||0} pages · {txns.length} scenarios · {bugs.length} issues</div>
        </div>
        <button onClick={rerunScan} style={{...primaryBtn,width:'auto',padding:'8px 16px',fontSize:13}}>↻ Rerun same scan</button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:18}}>
        <StatCard label="Scenarios" value={txns.length} />
        <StatCard label="Passed"    value={txnPass}    color="#16a34a" />
        <StatCard label="Failed"    value={txnFail}    color="#dc2626" />
        <StatCard label="Partial"   value={txnPartial} color="#d97706" />
        <StatCard label="DB Mismatch" value={mismatches.length} color="#7c3aed" />
        <StatCard label="Other Bugs"  value={otherBugs.length} color="#dc2626" />
      </div>

      <div style={{display:'flex',borderBottom:'2px solid #e2e8f0',marginBottom:18}}>
        {[
          {key:'mismatches',  label:`🗄️ Data Checks (${mismatches.length} ✕ / ${dbPasses.length} ✓)`},
          {key:'scenarios',   label:`📋 Scenarios (${txns.length})`},
          {key:'bugs',        label:`🐛 Bugs (${otherBugs.length})`},
          {key:'pages',       label:`📄 Pages (${scan?.pageCount||0})`},
        ].map(t=>(
          <button key={t.key} onClick={()=>setResultsTab(t.key)}
            style={{padding:'9px 16px',border:'none',borderBottom:`3px solid ${resultsTab===t.key?'#6366f1':'transparent'}`,
              background:'none',cursor:'pointer',fontSize:13,fontWeight:resultsTab===t.key?700:500,
              color:resultsTab===t.key?'#6366f1':'#64748b',marginBottom:-2}}>
            {t.label}
          </button>
        ))}
      </div>

      {/* DATA MISMATCHES */}
      {resultsTab==='mismatches' && (
        mismatches.length===0 ? (
          <div>
            <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,padding:dbPasses.length?24:40,textAlign:'center',marginBottom:dbPasses.length?14:0}}>
              <div style={{fontSize:36,marginBottom:8}}>✅</div>
              <h3 style={{color:'#15803d',margin:0}}>No data mismatches</h3>
              <p style={{color:'#16a34a',fontSize:13,margin:'6px 0 0'}}>Every checked screen's UI count matched the database.</p>
            </div>
            {dbPasses.length>0 && (
              <div>
                <div style={{...secLabel,marginBottom:8}}>PASSED DB CHECKS ({dbPasses.length})</div>
                {dbPasses.map((r,i)=>(
                  <div key={i} style={{background:'#fff',border:'1px solid #bbf7d0',borderLeft:'4px solid #16a34a',borderRadius:10,marginBottom:10,padding:'12px 14px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <span style={{fontSize:18}}>✅</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,color:'#1e293b'}}>{r.label}: UI/API {r.apiTotal} = DB {r.dbCount}</div>
                        <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>{r.page}</div>
                      </div>
                      <span style={{fontSize:11,fontWeight:700,color:'#16a34a',background:'#f0fdf4',padding:'3px 9px',borderRadius:20,textTransform:'uppercase'}}>match</span>
                    </div>
                    <pre style={{whiteSpace:'pre-wrap',fontSize:11,color:'#374151',background:'#f0fdf4',borderRadius:8,padding:'8px 12px',margin:'8px 0 0',fontFamily:'monospace'}}>Query: {r.query}
API endpoint: {r.apiUrl}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div>
            {mismatches.map(b=>(
              <div key={b.id} style={{background:'#fff',border:'1px solid #ddd6fe',borderLeft:'4px solid #7c3aed',borderRadius:10,marginBottom:10,padding:'12px 14px'}}>
                <div style={{display:'flex',alignItems:'center',gap:10}}>
                  <span style={{fontSize:18}}>🗄️</span>
                  <div style={{flex:1}}>
                    <div style={{fontWeight:700,fontSize:13,color:'#1e293b'}}>{b.summary}</div>
                    <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>{b.pageTitle}</div>
                  </div>
                </div>
                <pre style={{whiteSpace:'pre-wrap',fontSize:12,color:'#374151',background:'#faf5ff',borderRadius:8,padding:'10px 12px',margin:'10px 0 0',fontFamily:'monospace'}}>{b.description}</pre>
              </div>
            ))}
            {dbPasses.length>0 && (
              <div style={{marginTop:14}}>
                <div style={{...secLabel,marginBottom:8}}>PASSED DB CHECKS ({dbPasses.length})</div>
                {dbPasses.map((r,i)=>(
                  <div key={i} style={{background:'#fff',border:'1px solid #bbf7d0',borderLeft:'4px solid #16a34a',borderRadius:10,marginBottom:10,padding:'12px 14px'}}>
                    <div style={{display:'flex',alignItems:'center',gap:10}}>
                      <span style={{fontSize:18}}>✅</span>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:700,fontSize:13,color:'#1e293b'}}>{r.label}: UI/API {r.apiTotal} = DB {r.dbCount}</div>
                        <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>{r.page}</div>
                      </div>
                      <span style={{fontSize:11,fontWeight:700,color:'#16a34a',background:'#f0fdf4',padding:'3px 9px',borderRadius:20,textTransform:'uppercase'}}>match</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      )}

      {/* SCENARIOS */}
      {resultsTab==='scenarios' && (
        txns.length===0 ? (
          <Empty>No scenarios were executed — pages may not have had forms or interactions.</Empty>
        ) : txns.map(txn=>{
          const isOpen = selTxn?.id===txn.id;
          return (
            <div key={txn.id} style={{background:'#fff',border:`1px solid ${isOpen?RES_COLOR[txn.result||'partial']:'#e2e8f0'}`,
              borderRadius:10,marginBottom:10,overflow:'hidden',borderLeft:`4px solid ${RES_COLOR[txn.result||'partial']||'#94a3b8'}`}}>
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',cursor:'pointer'}} onClick={()=>setSelTxn(isOpen?null:txn)}>
                <span style={{fontSize:18}}>{RES_ICON[txn.result]||'⏳'}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:13,color:'#1e293b'}}>{txn.name}</div>
                  <div style={{fontSize:11,color:'#94a3b8',marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{txn.type} · {txn.pageTitle}</div>
                </div>
                <span style={{fontSize:11,fontWeight:700,color:RES_COLOR[txn.result||'partial'],background:RES_BG[txn.result||'partial'],padding:'3px 9px',borderRadius:20,textTransform:'uppercase'}}>{txn.result||'—'}</span>
                <span style={{color:'#94a3b8',fontSize:12}}>{isOpen?'▲':'▼'}</span>
              </div>
              {isOpen && (
                <div style={{padding:'0 14px 14px',borderTop:'1px solid #f1f5f9'}}>
                  <div style={{background:RES_BG[txn.result||'partial'],borderRadius:8,padding:'10px 12px',margin:'12px 0 10px',fontSize:13,color:'#374151'}}><b>Outcome:</b> {txn.outcome}</div>
                  {txn.steps?.length>0 && (
                    <div style={{marginBottom:10}}>
                      <div style={{...secLabel,marginBottom:6}}>STEPS ({txn.steps.length})</div>
                      {txn.steps.map((s,i)=>(
                        <div key={i} style={{display:'flex',gap:8,padding:'5px 0',borderBottom:'1px solid #f8fafc',fontSize:12}}>
                          <span>{s.status==='done'?'✅':s.status==='failed'?'❌':'⏳'}</span>
                          <div style={{flex:1,minWidth:0}}>
                            <span style={{fontWeight:600,color:'#374151'}}>{s.action}</span>
                            {s.selector && <span style={{color:'#94a3b8',fontFamily:'monospace',fontSize:10,marginLeft:6}}>{s.selector}</span>}
                            {s.error && <div style={{color:'#dc2626',marginTop:2,fontSize:11}}>{s.error}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                    <div><div style={{...secLabel,marginBottom:4}}>BEFORE</div><img src={`${API}/${scanId}/txn-screenshot/${txn.id}/before`} style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}} onError={e=>e.target.style.display='none'} /></div>
                    <div><div style={{...secLabel,marginBottom:4}}>AFTER</div><img src={`${API}/${scanId}/txn-screenshot/${txn.id}/after`} style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}} onError={e=>e.target.style.display='none'} /></div>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}

      {/* BUGS */}
      {resultsTab==='bugs' && (
        otherBugs.length===0 ? (
          <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,padding:40,textAlign:'center'}}>
            <div style={{fontSize:36,marginBottom:8}}>🎉</div><h3 style={{color:'#15803d',margin:0}}>No bugs found!</h3>
          </div>
        ) : otherBugs.map(bug=>{
          const isOpen = selBug?.id===bug.id;
          return (
            <div key={bug.id} style={{background:'#fff',border:`1px solid ${isOpen?SEV_COLOR[bug.severity]:'#e2e8f0'}`,borderRadius:10,marginBottom:10,overflow:'hidden',borderLeft:`4px solid ${SEV_COLOR[bug.severity]||'#94a3b8'}`}}>
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',cursor:'pointer'}} onClick={()=>setSelBug(isOpen?null:bug)}>
                <span style={{background:SEV_BG[bug.severity],color:SEV_COLOR[bug.severity],fontSize:10,fontWeight:800,padding:'2px 7px',borderRadius:20,textTransform:'uppercase'}}>{bug.severity}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,fontSize:13,color:'#1e293b'}}>{bug.summary}</div>
                  <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>{bug.source==='scenario'?`🔁 ${bug.scenarioName}`:'👁️ Visual check'} · {bug.pageTitle}</div>
                </div>
                <span style={{color:'#94a3b8',fontSize:12}}>{isOpen?'▲':'▼'}</span>
              </div>
              {isOpen && (
                <div style={{padding:'0 14px 14px',borderTop:'1px solid #f1f5f9'}}>
                  <p style={{fontSize:13,color:'#374151',lineHeight:1.7,margin:'10px 0'}}>{bug.description}</p>
                  <img src={`${API}/${scanId}/bug-screenshot/${bug.id}`} style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}} onError={e=>e.target.style.display='none'} />
                </div>
              )}
            </div>
          );
        })
      )}

      {/* PAGES */}
      {resultsTab==='pages' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
          {(scan?.pages||[]).map((p,i)=>(
            <div key={i} style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,overflow:'hidden'}}>
              <img src={`${API}/${scanId}/screenshot/${i}`} style={{width:'100%',height:140,objectFit:'cover',objectPosition:'top'}} onError={e=>e.target.style.display='none'} />
              <div style={{padding:'10px 12px'}}>
                <div style={{fontWeight:600,fontSize:13,color:'#1e293b',marginBottom:3}}>{p.title||'Untitled'}</div>
                <div style={{fontSize:11,color:'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.url}</div>
                <div style={{marginTop:6,display:'flex',gap:6,flexWrap:'wrap'}}>
                  <span style={{fontSize:10,background:'#eff6ff',color:'#3b82f6',padding:'2px 6px',borderRadius:6}}>{txns.filter(t=>t.pageUrl===p.url).length} scenarios</span>
                  <span style={{fontSize:10,background:'#fef2f2',color:'#dc2626',padding:'2px 6px',borderRadius:6}}>{bugs.filter(b=>b.pageUrl===p.url).length} bugs</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helper components ─────────────────────────────────────────────────────────
function LiveLog({logs}) {
  return (
    <div style={{background:'#0f172a',borderRadius:10,padding:14,maxHeight:300,overflowY:'auto',fontFamily:'monospace',fontSize:11}}>
      <div style={{color:'#475569',marginBottom:6,fontSize:10}}>── LIVE LOG ─────────────────────────────────────</div>
      {(logs||[]).slice(-40).map((l,i)=>(
        <div key={i} style={{color:'#e2e8f0',marginBottom:2}}><span style={{color:'#475569'}}>{l.t?.slice(11,19)} </span>{l.m}</div>
      ))}
      {!logs?.length && <div style={{color:'#475569'}}>Waiting…</div>}
    </div>
  );
}
function Empty({children}) { return <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:32,textAlign:'center',color:'#64748b'}}>{children}</div>; }
function Card({title,subtitle,children,mb}) {
  return (
    <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:12,padding:18,marginBottom:mb||0}}>
      <div style={{marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:700,color:'#374151'}}>{title}</div>
        {subtitle&&<div style={{fontSize:12,color:'#94a3b8',marginTop:2}}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}
function Field({label,children,mt}) { return <div style={{marginBottom:10,marginTop:mt||0}}><label style={{display:'block',fontSize:11,fontWeight:700,color:'#6b7280',marginBottom:4,textTransform:'uppercase',letterSpacing:'0.05em'}}>{label}</label>{children}</div>; }
function Grid2({children}) { return <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>{children}</div>; }
function StatCard({label,value,color}) {
  return <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:8,padding:'10px 12px',textAlign:'center'}}>
    <div style={{fontSize:19,fontWeight:800,color:color||'#1e293b'}}>{value}</div>
    <div style={{fontSize:10,color:'#64748b',marginTop:1,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.04em'}}>{label}</div>
  </div>;
}
function ErrBox({children}) { return <div style={{color:'#dc2626',background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'9px 13px',marginBottom:12,fontSize:13}}>{children}</div>; }

const wrap     = {maxWidth:720,margin:'24px auto',padding:'0 20px',fontFamily:'system-ui,sans-serif'};
const inp      = {width:'100%',padding:'7px 11px',border:'1px solid #d1d5db',borderRadius:7,fontSize:13,color:'#1e293b',outline:'none',boxSizing:'border-box'};
const primaryBtn={display:'block',width:'100%',padding:'11px 20px',background:'#6366f1',color:'#fff',border:'none',borderRadius:9,fontSize:14,fontWeight:700,cursor:'pointer'};
const ghostBtn = {background:'none',border:'1px solid #e2e8f0',borderRadius:7,padding:'5px 11px',cursor:'pointer',fontSize:12,color:'#64748b',fontWeight:600};
const secLabel = {fontSize:10,fontWeight:700,color:'#94a3b8',textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:8,display:'block'};
