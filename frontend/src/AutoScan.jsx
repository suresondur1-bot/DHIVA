/**
 * AutoScan.jsx — Qavya Autonomous Scanner UI
 * Shows: Bugs + Transactions (scenarios tested + data saved verification)
 */

import { useState, useEffect, useRef } from 'react';

const API = '/api/auto-scan';

const SEV_COLOR = { critical:'#dc2626', high:'#ea580c', medium:'#d97706', low:'#16a34a' };
const SEV_BG    = { critical:'#fef2f2', high:'#fff7ed', medium:'#fffbeb', low:'#f0fdf4' };
const SEV_ORDER = { critical:0, high:1, medium:2, low:3 };

const RES_COLOR = { pass:'#16a34a', fail:'#dc2626', partial:'#d97706', error:'#dc2626' };
const RES_BG    = { pass:'#f0fdf4', fail:'#fef2f2', partial:'#fffbeb', error:'#fef2f2' };
const RES_ICON  = { pass:'✅', fail:'❌', partial:'⚠️', error:'💥' };

export default function AutoScan() {
  const [view,       setView]       = useState('form');
  const [resultsTab, setResultsTab] = useState('transactions'); // transactions | bugs | pages
  const [form,       setForm]       = useState({
    url:'', username:'', password:'', maxPages:15,
    jiraUrl:'', jiraEmail:'', jiraToken:'', jiraProjectKey:'',
  });
  const [scanId,     setScanId]     = useState(null);
  const [scan,       setScan]       = useState(null);
  const [error,      setError]      = useState('');
  const [history,    setHistory]    = useState([]);
  const [selTxn,     setSelTxn]     = useState(null);
  const [selBug,     setSelBug]     = useState(null);
  const [posting,    setPosting]    = useState({});
  const [postingAll, setPostingAll] = useState(false);
  const [jiraResult, setJiraResult] = useState({});
  const pollRef = useRef(null);

  useEffect(() => {
    fetch(`${API}/list`).then(r=>r.json()).then(d=>setHistory(d.scans||[])).catch(()=>{});
  }, []);

  useEffect(() => {
    if (view !== 'started') return;
    const t = setTimeout(() => setView('running'), 2500);
    return () => clearTimeout(t);
  }, [view]);

  useEffect(() => {
    if (!scanId || view !== 'running') return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${API}/${scanId}`);
        const d = await r.json();
        setScan(d);
        if (d.status==='completed'||d.status==='failed') {
          clearInterval(pollRef.current);
          setView('results');
          fetch(`${API}/list`).then(r=>r.json()).then(d=>setHistory(d.scans||[])).catch(()=>{});
        }
      } catch(e) {}
    }, 2000);
    return () => clearInterval(pollRef.current);
  }, [scanId, view]);

  const startScan = async () => {
    if (!form.url||!form.username||!form.password) { setError('URL, Username and Password are required'); return; }
    setError('');
    try {
      const r = await fetch(`${API}/start`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          url:form.url, username:form.username, password:form.password, maxPages:Number(form.maxPages),
          jiraUrl:form.jiraUrl||undefined, jiraEmail:form.jiraEmail||undefined,
          jiraToken:form.jiraToken||undefined, jiraProjectKey:form.jiraProjectKey||undefined,
        }),
      });
      const d = await r.json();
      if (d.error) { setError(d.error); return; }
      setScanId(d.scanId); setScan(null); setJiraResult({}); setSelTxn(null); setSelBug(null);
      setView('started');
    } catch(e) { setError(e.message); }
  };

  const postOneBug = async (bug) => {
    const {jiraUrl,jiraEmail,jiraToken,jiraProjectKey} = form;
    if (!jiraUrl||!jiraEmail||!jiraToken||!jiraProjectKey) { alert('Fill JIRA config first'); return; }
    setPosting(p=>({...p,[bug.id]:true}));
    try {
      const r = await fetch(`${API}/${scanId}/post-bug/${bug.id}`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({jiraUrl,jiraEmail,jiraToken,jiraProjectKey}),
      });
      const d = await r.json();
      if (d.success) {
        setJiraResult(j=>({...j,[bug.id]:{key:d.jiraKey,url:d.url}}));
        setScan(s=>({...s,bugs:s.bugs.map(b=>b.id===bug.id?{...b,jiraPosted:true,jiraKey:d.jiraKey}:b)}));
      } else { alert('JIRA error: '+(d.error||'Unknown')); }
    } catch(e) { alert('Failed: '+e.message); }
    setPosting(p=>({...p,[bug.id]:false}));
  };

  const postAllBugs = async () => {
    const {jiraUrl,jiraEmail,jiraToken,jiraProjectKey} = form;
    if (!jiraUrl||!jiraEmail||!jiraToken||!jiraProjectKey) { alert('Fill JIRA config first'); return; }
    const unpCnt = (scan?.bugs||[]).filter(b=>!b.jiraPosted&&!jiraResult[b.id]).length;
    if (!confirm(`Post all ${unpCnt} unposted bugs to JIRA project "${jiraProjectKey}"?`)) return;
    setPostingAll(true);
    try {
      const r = await fetch(`${API}/${scanId}/post-all`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({jiraUrl,jiraEmail,jiraToken,jiraProjectKey}),
      });
      const d = await r.json();
      const r2 = await fetch(`${API}/${scanId}`); const updated = await r2.json(); setScan(updated);
      const newResults={};
      for (const res of (d.results||[])) if (res.success) newResults[res.bugId]={key:res.jiraKey,url:`${jiraUrl}/browse/${res.jiraKey}`};
      setJiraResult(j=>({...j,...newResults}));
      alert(`✅ Posted ${d.posted} bug${d.posted!==1?'s':''} to JIRA${d.failed>0?`. ${d.failed} failed.`:''}`);
    } catch(e) { alert('Failed: '+e.message); }
    setPostingAll(false);
  };

  const reset = () => { clearInterval(pollRef.current); setScanId(null); setScan(null); setSelTxn(null); setSelBug(null); setPosting({}); setJiraResult({}); setPostingAll(false); setView('form'); };
  const loadScan = async (s) => { setScanId(s.id); const r=await fetch(`${API}/${s.id}`); const d=await r.json(); setScan(d); setView(d.status==='completed'||d.status==='failed'?'results':'running'); };

  const bugs        = scan?.bugs || [];
  const txns        = scan?.transactions || [];
  const sortedBugs  = [...bugs].sort((a,b)=>(SEV_ORDER[a.severity]||9)-(SEV_ORDER[b.severity]||9));
  const unposted    = sortedBugs.filter(b=>!b.jiraPosted&&!jiraResult[b.id]);
  const jiraReady   = !!(form.jiraUrl&&form.jiraEmail&&form.jiraToken&&form.jiraProjectKey);
  const txnPass     = txns.filter(t=>t.result==='pass').length;
  const txnFail     = txns.filter(t=>t.result==='fail'||t.result==='error').length;
  const txnPartial  = txns.filter(t=>t.result==='partial').length;
  const dataSavedOk = txns.filter(t=>t.dataSaved===true).length;

  // ── FORM ─────────────────────────────────────────────────────────────────────
  if (view==='form') return (
    <div style={wrap}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:24}}>
        <div style={{fontSize:30}}>🔍</div>
        <div>
          <h1 style={{margin:0,fontSize:21,fontWeight:700,color:'#1e293b'}}>Auto Scan</h1>
          <p style={{margin:0,color:'#64748b',fontSize:13}}>Give me a URL + credentials → I'll explore, run transactions, verify data, and find bugs</p>
        </div>
      </div>

      <Card title="🌐 Application" mb={14}>
        <Field label="App URL *"><input style={inp} placeholder="https://athma-uat.narayana.com" value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} /></Field>
        <Grid2>
          <Field label="Username *"><input style={inp} placeholder="user@narayana.com" value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))} /></Field>
          <Field label="Password *"><input style={inp} type="password" placeholder="••••••••" value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))} /></Field>
        </Grid2>
        <Field label="Max Pages (1–25)" mt={12}>
          <input style={{...inp,width:90}} type="number" min={1} max={25} value={form.maxPages} onChange={e=>setForm(f=>({...f,maxPages:e.target.value}))} />
        </Field>
      </Card>

      <Card title="🐛 JIRA Config" subtitle="Pre-fill to enable one-click bug posting after scan" mb={20}>
        <Grid2>
          <Field label="JIRA URL"><input style={inp} placeholder="https://your-org.atlassian.net" value={form.jiraUrl} onChange={e=>setForm(f=>({...f,jiraUrl:e.target.value}))} /></Field>
          <Field label="Project Key"><input style={inp} placeholder="ACT" value={form.jiraProjectKey} onChange={e=>setForm(f=>({...f,jiraProjectKey:e.target.value}))} /></Field>
          <Field label="JIRA Email"><input style={inp} placeholder="you@narayana.com" value={form.jiraEmail} onChange={e=>setForm(f=>({...f,jiraEmail:e.target.value}))} /></Field>
          <Field label="JIRA API Token"><input style={inp} type="password" placeholder="Token from id.atlassian.com" value={form.jiraToken} onChange={e=>setForm(f=>({...f,jiraToken:e.target.value}))} /></Field>
        </Grid2>
      </Card>

      {error && <ErrBox>{error}</ErrBox>}
      <button onClick={startScan} style={primaryBtn}>🚀 Start Autonomous Scan</button>

      {history.length>0 && (
        <div style={{marginTop:28}}>
          <div style={secLabel}>RECENT SCANS</div>
          {history.map(s=>(
            <div key={s.id} onClick={()=>loadScan(s)}
              style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',background:'#fff',
                border:'1px solid #e2e8f0',borderRadius:8,marginBottom:7,cursor:'pointer'}}
              onMouseEnter={e=>e.currentTarget.style.borderColor='#6366f1'}
              onMouseLeave={e=>e.currentTarget.style.borderColor='#e2e8f0'}>
              <span style={{fontSize:16}}>{s.status==='completed'?'✅':s.status==='failed'?'❌':'⏳'}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:'#1e293b',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.url}</div>
                <div style={{fontSize:11,color:'#94a3b8',marginTop:2}}>{s.pageCount} pages · {s.txnCount||0} scenarios · {s.bugCount} bugs · {s.started_at?.slice(0,16).replace('T',' ')}</div>
              </div>
              <div style={{fontSize:12,fontWeight:600,color:s.status==='completed'?'#16a34a':s.status==='failed'?'#dc2626':'#6366f1'}}>{s.phase}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // ── STARTED SPLASH ────────────────────────────────────────────────────────────
  if (view==='started') return (
    <div style={{...wrap,display:'flex',alignItems:'center',justifyContent:'center',minHeight:420}}>
      <div style={{textAlign:'center',maxWidth:460}}>
        <div style={{fontSize:52,marginBottom:14}}>🚀</div>
        <h2 style={{margin:'0 0 10px',fontSize:21,color:'#1e293b',fontWeight:700}}>Scan Started!</h2>
        <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:10,padding:'14px 20px',marginBottom:18,textAlign:'left'}}>
          <div style={{fontSize:13,color:'#15803d',fontWeight:600,marginBottom:8}}>✅ Autonomous scan is now running</div>
          <div style={{fontSize:13,color:'#374151',lineHeight:1.8}}>
            <div>🌐 <b>URL:</b> {form.url}</div>
            <div>👤 <b>User:</b> {form.username}</div>
            <div>📄 <b>Max Pages:</b> {form.maxPages}</div>
            <div>🆔 <b>Scan ID:</b> <span style={{fontFamily:'monospace',fontSize:11,color:'#6366f1'}}>{scanId}</span></div>
          </div>
        </div>
        <div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:8,padding:'10px 14px',marginBottom:18,fontSize:12,color:'#1e40af',textAlign:'left'}}>
          <b>What it will do:</b><br/>
          1️⃣ Log in with your credentials<br/>
          2️⃣ Crawl all reachable pages<br/>
          3️⃣ Plan test scenarios for each form/transaction<br/>
          4️⃣ Execute each scenario &amp; verify data was saved<br/>
          5️⃣ Report all bugs with screenshots
        </div>
        <div style={{display:'flex',gap:6,justifyContent:'center',marginTop:4}}>
          {[0,1,2].map(i=><div key={i} style={{width:8,height:8,borderRadius:'50%',background:'#6366f1',
            animation:`bounce${i} 0.6s ${i*0.2}s infinite`}} />)}
        </div>
        <style>{`.bounce0,.bounce1,.bounce2{animation-name:bounce!important} @keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}`}</style>
      </div>
    </div>
  );

  // ── RUNNING ───────────────────────────────────────────────────────────────────
  if (view==='running') return (
    <div style={wrap}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:18}}>
        <span style={{fontSize:26}}>{scan?.status==='failed'?'❌':'⏳'}</span>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>{scan?.phase||'Starting...'}</h2>
          <div style={{fontSize:11,color:'#64748b',marginTop:2,fontFamily:'monospace'}}>{form.url}</div>
        </div>
        <button onClick={reset} style={ghostBtn}>✕ Cancel</button>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:8,marginBottom:14}}>
        <StatCard label="Phase"     value={scan?.phase||'—'} />
        <StatCard label="Pages"     value={scan?.pagesDiscovered||0} />
        <StatCard label="Scenarios" value={scan?.scenarioProgress||'0/0'} />
        <StatCard label="Bugs"      value={scan?.bugs?.length||0} color="#dc2626" />
        <StatCard label="Live Txns" value={scan?.transactions?.length||0} color="#6366f1" />
      </div>

      {/* Live transactions */}
      {(scan?.transactions?.length||0)>0 && (
        <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:14,marginBottom:14}}>
          <div style={{...secLabel,marginBottom:10}}>LIVE SCENARIO RESULTS</div>
          {(scan?.transactions||[]).slice(-5).map(t=>(
            <div key={t.id} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 0',borderBottom:'1px solid #f8fafc',fontSize:12}}>
              <span style={{fontSize:14}}>{RES_ICON[t.result]||'⏳'}</span>
              <div style={{flex:1,minWidth:0}}>
                <span style={{fontWeight:600,color:'#1e293b'}}>{t.name}</span>
                <span style={{color:'#94a3b8',marginLeft:8}}>{t.pageTitle}</span>
              </div>
              {t.dataSaved===true && <span style={{fontSize:10,background:'#f0fdf4',color:'#16a34a',padding:'2px 6px',borderRadius:10,fontWeight:700}}>DATA SAVED ✓</span>}
              {t.dataSaved===false && <span style={{fontSize:10,background:'#fef2f2',color:'#dc2626',padding:'2px 6px',borderRadius:10,fontWeight:700}}>SAVE FAILED</span>}
            </div>
          ))}
        </div>
      )}

      {scan?.status==='failed' && <ErrBox>{scan.error}</ErrBox>}

      <div style={{background:'#0f172a',borderRadius:10,padding:14,maxHeight:240,overflowY:'auto',fontFamily:'monospace',fontSize:11}}>
        <div style={{color:'#475569',marginBottom:6,fontSize:10}}>── LIVE LOG ─────────────────────────────────────</div>
        {(scan?.logs||[]).slice(-35).map((l,i)=>(
          <div key={i} style={{color:'#e2e8f0',marginBottom:2}}>
            <span style={{color:'#475569'}}>{l.t?.slice(11,19)} </span>{l.m}
          </div>
        ))}
        {!scan?.logs?.length && <div style={{color:'#475569'}}>Waiting for scanner...</div>}
      </div>

      {scan?.status==='failed' && <button onClick={reset} style={{...primaryBtn,marginTop:14}}>← Try Again</button>}
    </div>
  );

  // ── RESULTS ───────────────────────────────────────────────────────────────────
  return (
    <div style={{...wrap,maxWidth:1000}}>
      {/* Header */}
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18,flexWrap:'wrap'}}>
        <button onClick={reset} style={ghostBtn}>← New Scan</button>
        <div style={{flex:1}}>
          <h2 style={{margin:0,fontSize:17,color:'#1e293b',fontWeight:700}}>Scan Complete</h2>
          <div style={{fontSize:11,color:'#64748b',marginTop:2}}>{form.url} · {scan?.pageCount||0} pages · {txns.length} scenarios · {bugs.length} bugs</div>
        </div>
        {unposted.length>0 && (
          <button onClick={postAllBugs} disabled={postingAll}
            style={{...primaryBtn,width:'auto',padding:'8px 16px',fontSize:12,opacity:postingAll?0.6:1}}>
            {postingAll?'⏳ Posting...':`🐛 Post All ${unposted.length} Bugs to JIRA`}
          </button>
        )}
      </div>

      {/* Top stats */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8,marginBottom:18}}>
        <StatCard label="Scenarios"   value={txns.length}    />
        <StatCard label="Passed"      value={txnPass}        color="#16a34a" />
        <StatCard label="Failed"      value={txnFail}        color="#dc2626" />
        <StatCard label="Partial"     value={txnPartial}     color="#d97706" />
        <StatCard label="Data Saved"  value={`${dataSavedOk}/${txns.filter(t=>t.dataSaved!==null).length}`} color="#6366f1" />
        <StatCard label="Bugs"        value={bugs.length}    color="#dc2626" />
      </div>

      {/* Tabs */}
      <div style={{display:'flex',borderBottom:'2px solid #e2e8f0',marginBottom:18,gap:0}}>
        {[
          {key:'transactions', label:`📋 Scenarios & Transactions (${txns.length})`},
          {key:'bugs',         label:`🐛 Bugs (${bugs.length})`},
          {key:'pages',        label:`📄 Pages (${scan?.pageCount||0})`},
        ].map(t=>(
          <button key={t.key} onClick={()=>setResultsTab(t.key)}
            style={{padding:'9px 16px',border:'none',borderBottom:`3px solid ${resultsTab===t.key?'#6366f1':'transparent'}`,
              background:'none',cursor:'pointer',fontSize:13,fontWeight:resultsTab===t.key?700:500,
              color:resultsTab===t.key?'#6366f1':'#64748b',marginBottom:-2}}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── TRANSACTIONS TAB ──────────────────────────────────────────────────── */}
      {resultsTab==='transactions' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:14,alignItems:'start'}}>
          <div>
            {txns.length===0 ? (
              <div style={{background:'#f8fafc',border:'1px solid #e2e8f0',borderRadius:10,padding:32,textAlign:'center',color:'#64748b'}}>
                No scenarios were executed — pages may not have had forms or interactions
              </div>
            ) : txns.map(txn=>{
              const isOpen = selTxn?.id===txn.id;
              return (
                <div key={txn.id}
                  style={{background:'#fff',border:`1px solid ${isOpen?RES_COLOR[txn.result||'partial']:'#e2e8f0'}`,
                    borderRadius:10,marginBottom:10,overflow:'hidden',
                    borderLeft:`4px solid ${RES_COLOR[txn.result||'partial']||'#94a3b8'}`}}>

                  {/* Header row */}
                  <div style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',cursor:'pointer'}}
                    onClick={()=>setSelTxn(isOpen?null:txn)}>
                    <span style={{fontSize:18,flexShrink:0}}>{RES_ICON[txn.result]||'⏳'}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:13,color:'#1e293b'}}>{txn.name}</div>
                      <div style={{fontSize:11,color:'#94a3b8',marginTop:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                        {txn.type} · {txn.pageTitle}
                      </div>
                    </div>
                    <div style={{display:'flex',gap:6,alignItems:'center',flexShrink:0}}>
                      {txn.dataSaved===true  && <span style={{fontSize:10,background:'#f0fdf4',color:'#16a34a',padding:'2px 7px',borderRadius:10,fontWeight:700}}>💾 DATA SAVED</span>}
                      {txn.dataSaved===false && <span style={{fontSize:10,background:'#fef2f2',color:'#dc2626',padding:'2px 7px',borderRadius:10,fontWeight:700}}>💾 SAVE FAILED</span>}
                      <span style={{fontSize:11,fontWeight:700,color:RES_COLOR[txn.result||'partial'],
                        background:RES_BG[txn.result||'partial'],padding:'3px 9px',borderRadius:20,textTransform:'uppercase'}}>
                        {txn.result||'—'}
                      </span>
                      <span style={{color:'#94a3b8',fontSize:12}}>{isOpen?'▲':'▼'}</span>
                    </div>
                  </div>

                  {/* Expanded */}
                  {isOpen && (
                    <div style={{padding:'0 14px 14px',borderTop:'1px solid #f1f5f9'}}>
                      {/* Outcome */}
                      <div style={{background:RES_BG[txn.result||'partial'],borderRadius:8,padding:'10px 12px',margin:'12px 0 10px',fontSize:13,color:'#374151'}}>
                        <b>Outcome:</b> {txn.outcome}
                      </div>

                      {/* Data save */}
                      {txn.dataDetails && (
                        <div style={{background:'#f8fafc',borderRadius:8,padding:'8px 12px',marginBottom:10,fontSize:12,color:'#374151'}}>
                          <b>💾 Data Verification:</b> {txn.dataDetails}
                        </div>
                      )}

                      {/* Changes observed */}
                      {txn.changesObserved && (
                        <div style={{background:'#f0f9ff',borderRadius:8,padding:'8px 12px',marginBottom:10,fontSize:12,color:'#0c4a6e'}}>
                          <b>🔄 Changes observed:</b> {txn.changesObserved}
                        </div>
                      )}

                      {/* Test data */}
                      {txn.testData && Object.keys(txn.testData).length>0 && (
                        <div style={{background:'#fafaf9',borderRadius:8,padding:'8px 12px',marginBottom:10,fontSize:12}}>
                          <b>📝 Test data used:</b>
                          <div style={{marginTop:4,display:'flex',gap:8,flexWrap:'wrap'}}>
                            {Object.entries(txn.testData).map(([k,v])=>(
                              <span key={k} style={{background:'#e2e8f0',borderRadius:6,padding:'2px 8px',fontFamily:'monospace',fontSize:11}}>
                                {k}: {String(v)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Steps */}
                      {txn.steps?.length>0 && (
                        <div style={{marginBottom:10}}>
                          <div style={{...secLabel,marginBottom:6}}>STEPS EXECUTED ({txn.steps.length})</div>
                          {txn.steps.map((s,i)=>(
                            <div key={i} style={{display:'flex',alignItems:'flex-start',gap:8,padding:'5px 0',borderBottom:'1px solid #f8fafc',fontSize:12}}>
                              <span style={{fontSize:12,flexShrink:0}}>{s.status==='done'?'✅':s.status==='failed'?'❌':'⏳'}</span>
                              <div style={{flex:1,minWidth:0}}>
                                <span style={{fontWeight:600,color:'#374151'}}>{s.action}</span>
                                {s.selector && <span style={{color:'#94a3b8',fontFamily:'monospace',fontSize:10,marginLeft:6}}>{s.selector}</span>}
                                {s.value    && <span style={{color:'#6366f1',fontSize:11,marginLeft:6}}>= "{s.value}"</span>}
                                {s.description && <div style={{color:'#64748b',marginTop:2}}>{s.description}</div>}
                                {s.error && <div style={{color:'#dc2626',marginTop:2,fontSize:11}}>{s.error}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Before/After screenshots */}
                      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                        <div>
                          <div style={{...secLabel,marginBottom:4}}>BEFORE</div>
                          <img src={`${API}/${scanId}/txn-screenshot/${txn.id}/before`} alt="before"
                            style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}}
                            onError={e=>e.target.style.display='none'} />
                        </div>
                        <div>
                          <div style={{...secLabel,marginBottom:4}}>AFTER</div>
                          <img src={`${API}/${scanId}/txn-screenshot/${txn.id}/after`} alt="after"
                            style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}}
                            onError={e=>e.target.style.display='none'} />
                        </div>
                      </div>

                      {/* Bugs found in this scenario */}
                      {txn.bugs?.length>0 && (
                        <div style={{marginTop:10,background:'#fef2f2',borderRadius:8,padding:'8px 12px',fontSize:12,color:'#dc2626'}}>
                          🐛 {txn.bugs.length} bug{txn.bugs.length>1?'s':''} found during this scenario
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Sidebar summary */}
          <div style={{position:'sticky',top:16}}>
            <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:16,marginBottom:12}}>
              <div style={secLabel}>TEST COVERAGE</div>
              {['form_submit','search','navigation','data_entry','validation'].map(type=>{
                const cnt = txns.filter(t=>t.type===type).length;
                if (!cnt) return null;
                const pass = txns.filter(t=>t.type===type&&t.result==='pass').length;
                return (
                  <div key={type} style={{display:'flex',alignItems:'center',gap:8,padding:'5px 0',borderBottom:'1px solid #f8fafc',fontSize:12}}>
                    <div style={{flex:1,color:'#374151',fontWeight:500,textTransform:'capitalize'}}>{type.replace('_',' ')}</div>
                    <div style={{fontSize:11,color:'#94a3b8'}}>{pass}/{cnt} passed</div>
                  </div>
                );
              })}
            </div>
            <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:16}}>
              <div style={secLabel}>DATA SAVE SUMMARY</div>
              <div style={{fontSize:13,color:'#374151',lineHeight:2}}>
                <div>✅ Saved OK: <b style={{color:'#16a34a'}}>{txns.filter(t=>t.dataSaved===true).length}</b></div>
                <div>❌ Save failed: <b style={{color:'#dc2626'}}>{txns.filter(t=>t.dataSaved===false).length}</b></div>
                <div>➖ Not applicable: <b style={{color:'#94a3b8'}}>{txns.filter(t=>t.dataSaved===null).length}</b></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── BUGS TAB ──────────────────────────────────────────────────────────── */}
      {resultsTab==='bugs' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 300px',gap:14,alignItems:'start'}}>
          <div>
            {!jiraReady && (
              <div style={{background:'#fffbeb',border:'1px solid #fcd34d',borderRadius:8,padding:'10px 14px',marginBottom:14,fontSize:12,color:'#92400e'}}>
                ⚠️ JIRA not configured — <button onClick={reset} style={{background:'none',border:'none',color:'#92400e',cursor:'pointer',textDecoration:'underline',fontSize:12,padding:0}}>go back to form</button> and fill JIRA details to enable posting
              </div>
            )}
            {sortedBugs.length===0 ? (
              <div style={{background:'#f0fdf4',border:'1px solid #bbf7d0',borderRadius:12,padding:40,textAlign:'center'}}>
                <div style={{fontSize:36,marginBottom:8}}>🎉</div>
                <h3 style={{color:'#15803d',margin:0}}>No bugs found!</h3>
              </div>
            ) : sortedBugs.map(bug=>{
              const isPosted  = bug.jiraPosted||!!jiraResult[bug.id];
              const jiraInfo  = jiraResult[bug.id]||(bug.jiraKey?{key:bug.jiraKey,url:`${form.jiraUrl}/browse/${bug.jiraKey}`}:null);
              const isOpen    = selBug?.id===bug.id;
              return (
                <div key={bug.id}
                  style={{background:'#fff',border:`1px solid ${isOpen?SEV_COLOR[bug.severity]:'#e2e8f0'}`,
                    borderRadius:10,marginBottom:10,overflow:'hidden',
                    borderLeft:`4px solid ${SEV_COLOR[bug.severity]||'#94a3b8'}`}}>
                  <div style={{display:'flex',alignItems:'center',gap:10,padding:'11px 14px',cursor:'pointer'}}
                    onClick={()=>setSelBug(isOpen?null:bug)}>
                    <span style={{background:SEV_BG[bug.severity],color:SEV_COLOR[bug.severity],
                      fontSize:10,fontWeight:800,padding:'2px 7px',borderRadius:20,textTransform:'uppercase',flexShrink:0}}>
                      {bug.severity}
                    </span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:13,color:'#1e293b'}}>{bug.summary}</div>
                      <div style={{fontSize:11,color:'#94a3b8',marginTop:1}}>
                        {bug.source==='scenario'?`🔁 Found in: ${bug.scenarioName}`:`👁️ Visual check`} · {bug.pageTitle}
                      </div>
                    </div>
                    {isPosted ? (
                      <a href={jiraInfo?.url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
                        style={{fontSize:12,color:'#6366f1',fontWeight:700,textDecoration:'none',
                          background:'#eef2ff',padding:'4px 10px',borderRadius:6,flexShrink:0}}>
                        ✅ {jiraInfo?.key} ↗
                      </a>
                    ) : (
                      <button onClick={e=>{e.stopPropagation();postOneBug(bug);}} disabled={posting[bug.id]}
                        style={{fontSize:12,background:posting[bug.id]?'#e2e8f0':'#6366f1',color:posting[bug.id]?'#94a3b8':'#fff',
                          border:'none',borderRadius:6,padding:'5px 12px',cursor:posting[bug.id]?'not-allowed':'pointer',
                          flexShrink:0,fontWeight:600}}>
                        {posting[bug.id]?'⏳...':'🐛 Post to JIRA'}
                      </button>
                    )}
                    <span style={{color:'#94a3b8',fontSize:12,flexShrink:0,marginLeft:4}}>{isOpen?'▲':'▼'}</span>
                  </div>
                  {isOpen && (
                    <div style={{padding:'0 14px 14px',borderTop:'1px solid #f1f5f9'}}>
                      <p style={{fontSize:13,color:'#374151',lineHeight:1.7,margin:'10px 0 10px'}}>{bug.description}</p>
                      <img src={`${API}/${scanId}/bug-screenshot/${bug.id}`} alt="screenshot"
                        style={{width:'100%',borderRadius:8,border:'1px solid #e2e8f0'}}
                        onError={e=>e.target.style.display='none'} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{position:'sticky',top:16}}>
            <div style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,padding:16}}>
              <div style={secLabel}>BUG SUMMARY</div>
              {['critical','high','medium','low'].map(sev=>{
                const cnt=bugs.filter(b=>b.severity===sev).length;
                return <div key={sev} style={{display:'flex',justifyContent:'space-between',padding:'6px 0',borderBottom:'1px solid #f8fafc',fontSize:13}}>
                  <span style={{color:SEV_COLOR[sev],fontWeight:600,textTransform:'capitalize'}}>{sev}</span>
                  <span style={{fontWeight:700,color:'#1e293b'}}>{cnt}</span>
                </div>;
              })}
              <div style={{marginTop:12,display:'flex',justifyContent:'space-between',fontSize:13}}>
                <span style={{color:'#64748b'}}>Posted to JIRA</span>
                <span style={{fontWeight:700,color:'#16a34a'}}>{bugs.filter(b=>b.jiraPosted||jiraResult[b.id]).length}/{bugs.length}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PAGES TAB ─────────────────────────────────────────────────────────── */}
      {resultsTab==='pages' && (
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))',gap:12}}>
          {(scan?.pages||[]).map((p,i)=>(
            <div key={i} style={{background:'#fff',border:'1px solid #e2e8f0',borderRadius:10,overflow:'hidden'}}>
              <img src={`${API}/${scanId}/screenshot/${i}`} alt={p.title}
                style={{width:'100%',height:140,objectFit:'cover',objectPosition:'top'}}
                onError={e=>e.target.style.display='none'} />
              <div style={{padding:'10px 12px'}}>
                <div style={{fontWeight:600,fontSize:13,color:'#1e293b',marginBottom:3}}>{p.title||'Untitled'}</div>
                <div style={{fontSize:11,color:'#94a3b8',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.url}</div>
                <div style={{marginTop:6,display:'flex',gap:6,flexWrap:'wrap'}}>
                  <span style={{fontSize:10,background:'#eff6ff',color:'#3b82f6',padding:'2px 6px',borderRadius:6}}>
                    {txns.filter(t=>t.pageUrl===p.url).length} scenarios
                  </span>
                  <span style={{fontSize:10,background:'#fef2f2',color:'#dc2626',padding:'2px 6px',borderRadius:6}}>
                    {bugs.filter(b=>b.pageUrl===p.url).length} bugs
                  </span>
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
