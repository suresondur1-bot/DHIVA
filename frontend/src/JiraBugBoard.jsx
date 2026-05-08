import React, { useState, useEffect, useRef } from "react";
import { API, C, s, api } from "./shared.jsx";
import JiraConfig from "./JiraConfig.jsx";

// ─────────────────────────────────────────────────────────────────────────────
// JIRA Bug Review Board — Excel-style editable grid
// ─────────────────────────────────────────────────────────────────────────────
export default function JiraBugBoard({ user }) {
  const [view,         setView]         = useState("board"); // "board" | "config"
  const [suiteRuns,    setSuiteRuns]    = useState([]);
  const [selSuiteRun,  setSelSuiteRun]  = useState("");
  const [bugs,         setBugs]         = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [checked,      setChecked]      = useState({});       // { run_id: bool }
  const [expanded,     setExpanded]     = useState({});       // { run_id: bool }
  const [edits,        setEdits]        = useState({});       // { run_id: { summary, severity, affect_version, notes } }
  const [posting,      setPosting]      = useState({});       // { run_id: bool }
  const [postResults,  setPostResults]  = useState({});       // { run_id: { ok, ticket_key, ticket_url, error } }
  const [severityOpts, setSeverityOpts] = useState(['Critical','High','Medium','Low']);
  const [filter,       setFilter]       = useState("all");    // all | unposted | posted
  const [sortCol,      setSortCol]      = useState(null);
  const [sortAsc,      setSortAsc]      = useState(true);
  const [postingAll,   setPostingAll]   = useState(false);

  useEffect(() => { loadSuiteRuns(); loadSeverityOpts(); }, []);

  async function loadSeverityOpts() {
    try {
      const cfg = await api('/api/jira/config');
      if (cfg?.severity_options) {
        setSeverityOpts(cfg.severity_options.split(',').map(s => s.trim()).filter(Boolean));
      }
    } catch(e) {}
  }

  async function loadSuiteRuns() {
    try {
      const r = await api('/api/suite-runs?limit=50&status=passed,failed,partial');
      const rows = Array.isArray(r) ? r : (r?.rows || []);
      setSuiteRuns(rows);
    } catch(e) {}
  }

  async function loadBugs(suiteRunId) {
    setLoading(true);
    setBugs([]); setChecked({}); setEdits({}); setPostResults({}); setExpanded({});
    try {
      const d = await api(`/api/jira/bugs/${suiteRunId}`);
      const bugList = d.bugs || [];
      setBugs(bugList);
      // Pre-check all unposted, non-skipped bugs
      const c = {};
      bugList.forEach(b => { c[b.run_id] = !b.jira_ticket && !b.jira_skipped; });
      setChecked(c);
      // Pre-fill edits from saved values
      const e = {};
      bugList.forEach(b => {
        e[b.run_id] = {
          summary:        b.summary        || '',
          severity:       b.severity       || 'High',
          affect_version: b.affect_version || '',
          notes:          '',
          steps_text:     b.steps_text     || '',
          error_msg:      b.failed_step_error || '',
        };
      });
      setEdits(e);
      // Pre-fill post results for already-posted bugs
      const pr = {};
      bugList.forEach(b => {
        if (b.jira_ticket) {
          pr[b.run_id] = { ok:true, ticket_key: b.jira_ticket, ticket_url: null };
        }
      });
      setPostResults(pr);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }

  function updEdit(runId, key, val) {
    setEdits(prev => ({ ...prev, [runId]: { ...(prev[runId]||{}), [key]: val } }));
  }

  async function postBug(runId) {
    const edit = edits[runId] || {};
    setPosting(p => ({ ...p, [runId]: true }));
    try {
      const r = await api('/api/jira/post-bug', {
        method: 'POST',
        body: {
          run_id:         runId,
          summary:        edit.summary,
          severity:       edit.severity,
          affect_version: edit.affect_version,
          extra_notes:    edit.notes,
          steps_text:     edit.steps_text,
          error_msg:      edit.error_msg,
        }
      });
      setPostResults(pr => ({ ...pr, [runId]: r }));
      // Update bug in list
      setBugs(prev => prev.map(b => b.run_id === runId
        ? { ...b, jira_ticket: r.ticket_key, jira_posted_at: new Date().toISOString() }
        : b
      ));
    } catch(e) {
      setPostResults(pr => ({ ...pr, [runId]: { ok:false, error: e.message } }));
    } finally {
      setPosting(p => ({ ...p, [runId]: false }));
    }
  }

  async function skipBug(runId) {
    try {
      await api('/api/jira/skip-bug', { method:'POST', body:{ run_id: runId } });
      setBugs(prev => prev.map(b => b.run_id === runId ? { ...b, jira_skipped: true } : b));
      setChecked(c => ({ ...c, [runId]: false }));
    } catch(e) {}
  }

  async function unskipBug(runId) {
    try {
      await api('/api/jira/unskip-bug', { method:'POST', body:{ run_id: runId } });
      setBugs(prev => prev.map(b => b.run_id === runId ? { ...b, jira_skipped: false } : b));
      setChecked(c => ({ ...c, [runId]: true }));
    } catch(e) {}
  }

  async function postSelected() {
    const toPost = Object.entries(checked).filter(([,v]) => v).map(([k]) => Number(k));
    if (!toPost.length) return;
    if (!confirm(`Post ${toPost.length} bug(s) to JIRA?`)) return;
    setPostingAll(true);
    for (const runId of toPost) {
      if (!postResults[runId]?.ok) await postBug(runId);
    }
    setPostingAll(false);
  }

  function toggleAll(val) {
    const c = {};
    visibleBugs.forEach(b => { c[b.run_id] = val && !b.jira_ticket && !b.jira_skipped; });
    setChecked(c);
  }

  function doSort(col) {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(true); }
  }

  // Filter and sort
  let visibleBugs = [...bugs];
  if (filter === 'unposted') visibleBugs = visibleBugs.filter(b => !b.jira_ticket && !b.jira_skipped);
  if (filter === 'posted')   visibleBugs = visibleBugs.filter(b => !!b.jira_ticket);
  if (sortCol) {
    visibleBugs.sort((a, b) => {
      let va = a[sortCol] || ''; let vb = b[sortCol] || '';
      if (typeof va === 'number') return sortAsc ? va-vb : vb-va;
      return sortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }

  const checkedCount   = Object.values(checked).filter(Boolean).length;
  const postedCount    = bugs.filter(b => b.jira_ticket).length;
  const unpostedCount  = bugs.filter(b => !b.jira_ticket && !b.jira_skipped).length;

  if (view === 'config') return (
    <div>
      <button onClick={()=>setView('board')} style={{ ...s.btn('ghost'), margin:16 }}>
        ← Back to Bug Board
      </button>
      <JiraConfig user={user} />
    </div>
  );

  return (
    <div style={{ padding:'20px 16px', minHeight:'80vh' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:C.text }}>
            🐛 Bug Review Board
          </div>
          <div style={{ fontSize:13, color:C.textDim, marginTop:3 }}>
            Review failed tests, edit details and post bugs to JIRA
          </div>
        </div>
        <button
          onClick={()=>setView('config')}
          style={{ ...s.btn('ghost'), fontSize:13 }}>
          ⚙️ JIRA Config
        </button>
      </div>

      {/* Suite Run Selector */}
      <div style={{ background:'#fff', border:'1px solid #e2e6ed', borderRadius:10,
        padding:'16px 20px', marginBottom:16, display:'flex', alignItems:'center', gap:16 }}>
        <div style={{ fontSize:13, fontWeight:600, color:C.textMid, whiteSpace:'nowrap' }}>
          Select Suite Run:
        </div>
        <select
          value={selSuiteRun}
          onChange={e => { setSelSuiteRun(e.target.value); if(e.target.value) loadBugs(e.target.value); }}
          style={{ flex:1, padding:'8px 12px', border:'1px solid #e2e6ed', borderRadius:6,
            fontSize:13, color:C.text, background:'#fff' }}>
          <option value="">— Select a suite run —</option>
          {suiteRuns.map(sr => (
            <option key={sr.id} value={sr.id}>
              {sr.name || sr.suite_name} — {new Date(sr.started_at||sr.created_at).toLocaleString('en-IN')}
              {' '}({sr.failed||0} failed)
            </option>
          ))}
        </select>
        {selSuiteRun && (
          <button onClick={()=>loadBugs(selSuiteRun)} style={{ ...s.btn('ghost'), fontSize:13, whiteSpace:'nowrap' }}>
            ↺ Refresh
          </button>
        )}
      </div>

      {/* Stats + Actions bar */}
      {bugs.length > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:12,
          marginBottom:12, flexWrap:'wrap' }}>

          {/* Stats chips */}
          <div style={chip('#fdecea','#e53935')}>{bugs.length} Total Failures</div>
          <div style={chip('#fff8e6','#f59e0b')}>{unpostedCount} Not Posted</div>
          <div style={chip('#e6f7f1','#00a86b')}>{postedCount} Posted to JIRA</div>
          <div style={chip('#e3f0fb','#1a6fc4')}>{checkedCount} Selected</div>

          <div style={{ flex:1 }} />

          {/* Filter */}
          <div style={{ display:'flex', gap:4, background:'#f0f2f5',
            borderRadius:8, padding:4 }}>
            {[['all','All'],['unposted','Unposted'],['posted','Posted']].map(([k,l]) => (
              <button key={k} onClick={()=>setFilter(k)}
                style={{ padding:'4px 12px', borderRadius:6, border:'none', cursor:'pointer',
                  fontSize:12, fontWeight:600,
                  background: filter===k ? '#fff' : 'transparent',
                  color:      filter===k ? C.text : C.textDim,
                  boxShadow:  filter===k ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                {l}
              </button>
            ))}
          </div>

          {/* Post Selected */}
          <button
            onClick={postSelected}
            disabled={postingAll || checkedCount === 0}
            style={{ ...s.btn('primary'), fontSize:13, minWidth:150,
              opacity: checkedCount===0 ? 0.5 : 1 }}>
            {postingAll ? '⏳ Posting...' : `📤 Post Selected (${checkedCount})`}
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign:'center', padding:60, color:C.textDim }}>
          ⏳ Loading failures...
        </div>
      )}

      {/* No bugs */}
      {!loading && selSuiteRun && bugs.length === 0 && (
        <div style={{ textAlign:'center', padding:60, color:C.textDim }}>
          <div style={{ fontSize:40, marginBottom:12 }}>✅</div>
          <div style={{ fontSize:16, fontWeight:600 }}>No failures found in this suite run!</div>
          <div style={{ fontSize:13, marginTop:6 }}>All tests passed.</div>
        </div>
      )}

      {/* No suite selected */}
      {!loading && !selSuiteRun && (
        <div style={{ textAlign:'center', padding:60, color:C.textDim }}>
          <div style={{ fontSize:40, marginBottom:12 }}>🐛</div>
          <div style={{ fontSize:16, fontWeight:600 }}>Select a suite run to review failures</div>
          <div style={{ fontSize:13, marginTop:6 }}>Choose a suite run from the dropdown above</div>
        </div>
      )}

      {/* Excel-style Grid */}
      {!loading && visibleBugs.length > 0 && (
        <div style={{ background:'#fff', border:'1px solid #e2e6ed',
          borderRadius:10, overflow:'hidden', boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>

          {/* Fixed field banner */}
          <div style={{ background:'#f8f9fc', borderBottom:'1px solid #e2e6ed',
            padding:'8px 16px', display:'flex', gap:24, fontSize:12, color:C.textMid }}>
            <span>🔒 WorkType: <b>{`Bug`}</b></span>
            <span>🔒 DefectType: <b>{`Functional`}</b></span>
            <span>🔒 Status: <b>{`Open`}</b></span>
            <span style={{ color:C.textDim, marginLeft:'auto', fontSize:11 }}>
              Fixed fields are set automatically — configure in JIRA Config
            </span>
          </div>

          {/* Table */}
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'#f0f2f5', borderBottom:'2px solid #e2e6ed' }}>
                  {/* Select all */}
                  <th style={{ ...th, width:40, textAlign:'center' }}>
                    <input type="checkbox"
                      checked={checkedCount === visibleBugs.filter(b=>!b.jira_ticket&&!b.jira_skipped).length
                        && visibleBugs.filter(b=>!b.jira_ticket&&!b.jira_skipped).length > 0}
                      onChange={e => toggleAll(e.target.checked)}
                      style={{ cursor:'pointer', width:15, height:15 }}
                    />
                  </th>
                  {[
                    ['test_name','Test Case', 180],
                    ['project_name','Source', 120],
                    ['failed_step_idx','Step', 60],
                    ['failed_step_error','Error', 180],
                  ].map(([col, label, w]) => (
                    <th key={col} style={{ ...th, width:w, cursor:'pointer' }}
                      onClick={()=>doSort(col)}>
                      {label} {sortCol===col ? (sortAsc?'↑':'↓') : ''}
                    </th>
                  ))}
                  <th style={{ ...th, width:130 }}>Severity *</th>
                  <th style={{ ...th, width:130 }}>Affect Version *</th>
                  <th style={{ ...th, minWidth:320 }}>Summary *</th>
                  <th style={{ ...th, width:130, textAlign:'center' }}>Status</th>
                  <th style={{ ...th, width:80,  textAlign:'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleBugs.map((bug, idx) => {
                  const edit    = edits[bug.run_id] || {};
                  const result  = postResults[bug.run_id];
                  const isPosted  = !!bug.jira_ticket || result?.ok;
                  const isPosting = posting[bug.run_id];
                  const isSkipped = bug.jira_skipped;
                  const rowBg   = isPosted  ? '#f0faf5'
                                : isSkipped ? '#f9f9f9'
                                : idx%2===0 ? '#ffffff' : '#fafafa';

                  return (
                    <React.Fragment key={bug.run_id}>
                      {/* Main row */}
                      <tr style={{ background:rowBg, borderBottom:'1px solid #f0f2f5',
                        opacity: isSkipped ? 0.75 : 1 }}>

                        {/* Checkbox */}
                        <td style={{ ...td, textAlign:'center' }}>
                          <input type="checkbox"
                            checked={!!checked[bug.run_id]}
                            disabled={isPosted || isSkipped}
                            onChange={e => setChecked(c => ({...c, [bug.run_id]: e.target.checked}))}
                            style={{ cursor: isPosted||isSkipped ? 'default':'pointer', width:15, height:15 }}
                          />
                        </td>

                        {/* Test Case — expand toggle */}
                        <td style={{ ...td, fontWeight:600, color:C.text }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            <button
                              onClick={()=>setExpanded(e=>({...e,[bug.run_id]:!e[bug.run_id]}))}
                              style={{ background:'none', border:'none', cursor:'pointer',
                                fontSize:11, color:C.textDim, padding:'2px 4px' }}>
                              {expanded[bug.run_id] ? '▼' : '▶'}
                            </button>
                            <span style={{ fontSize:12 }} title={bug.test_name}>
                              {bug.test_name?.length > 22
                                ? bug.test_name.slice(0,22)+'...'
                                : bug.test_name}
                            </span>
                          </div>
                        </td>

                        {/* Source (Project) */}
                        <td style={td}>
                          <span style={{ background:'#e3f0fb', color:'#1a6fc4',
                            padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600 }}>
                            {bug.project_name || '—'}
                          </span>
                        </td>

                        {/* Step */}
                        <td style={{ ...td, textAlign:'center' }}>
                          <span style={{ background:'#fdecea', color:'#e53935',
                            padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700 }}>
                            {bug.failed_step_idx != null ? `Step ${bug.failed_step_idx+1}` : '—'}
                          </span>
                        </td>

                        {/* Error */}
                        <td style={{ ...td, color:C.red, fontSize:11 }}>
                          <span title={bug.failed_step_error}>
                            {(bug.failed_step_error||'—').slice(0,60)}{(bug.failed_step_error||'').length>60?'...':''}
                          </span>
                        </td>

                        {/* Severity dropdown — editable */}
                        <td style={td}>
                          <select
                            value={edit.severity || bug.severity || 'High'}
                            disabled={isPosted || isSkipped}
                            onChange={e => updEdit(bug.run_id, 'severity', e.target.value)}
                            style={{ ...editInp,
                              color: severityColor(edit.severity || bug.severity),
                              fontWeight: 700,
                              background: isPosted||isSkipped ? '#f8f9fc' : '#fff' }}>
                            {severityOpts.map(o => (
                              <option key={o} value={o}>{o}</option>
                            ))}
                          </select>
                        </td>

                        {/* Affect Version — editable */}
                        <td style={td}>
                          <input
                            type="text"
                            value={edit.affect_version ?? bug.affect_version ?? ''}
                            disabled={isPosted || isSkipped}
                            onChange={e => updEdit(bug.run_id, 'affect_version', e.target.value)}
                            placeholder="e.g. v2.1.0"
                            style={{ ...editInp, background: isPosted||isSkipped ? '#f8f9fc' : '#fff' }}
                          />
                        </td>

                        {/* Summary — editable */}
                        <td style={td}>
                          <input
                            type="text"
                            value={edit.summary ?? bug.summary ?? ''}
                            disabled={isPosted || isSkipped}
                            onChange={e => updEdit(bug.run_id, 'summary', e.target.value)}
                            placeholder="Bug summary..."
                            style={{ ...editInp, background: isPosted||isSkipped ? '#f8f9fc' : '#fff' }}
                          />
                        </td>

                        {/* Status */}
                        <td style={{ ...td, textAlign:'center' }}>
                          {isPosted ? (
                            <a
                              href={result?.ticket_url || bug.jira_ticket ? `#` : '#'}
                              target="_blank" rel="noreferrer"
                              style={{ color:'#00a86b', fontWeight:700, fontSize:12,
                                textDecoration:'none', display:'flex', alignItems:'center',
                                justifyContent:'center', gap:4 }}>
                              🔗 {result?.ticket_key || bug.jira_ticket}
                            </a>
                          ) : isSkipped ? (
                            <span style={{ color:C.textDim, fontSize:12 }}>⏭ Skipped</span>
                          ) : result?.error ? (
                            <span style={{ color:C.red, fontSize:11 }} title={result.error}>
                              ❌ Failed
                            </span>
                          ) : (
                            <span style={{ color:C.textDim, fontSize:12 }}>⬜ Pending</span>
                          )}
                        </td>

                        {/* Action */}
                        <td style={{ ...td, textAlign:'center' }}>
                          {!isPosted && !isSkipped && (
                            <div style={{ display:'flex', gap:4, justifyContent:'center' }}>
                              <button
                                onClick={()=>postBug(bug.run_id)}
                                disabled={isPosting || !checked[bug.run_id]}
                                title="Post to JIRA"
                                style={{ padding:'4px 8px', borderRadius:5, border:'none',
                                  background: checked[bug.run_id] ? '#1a6fc4' : '#e2e6ed',
                                  color: checked[bug.run_id] ? '#fff' : '#8a96a8',
                                  cursor: checked[bug.run_id] ? 'pointer' : 'default',
                                  fontSize:12, fontWeight:600 }}>
                                {isPosting ? '⏳' : '📤'}
                              </button>
                              <button
                                onClick={()=>skipBug(bug.run_id)}
                                title="Skip this bug"
                                style={{ padding:'4px 8px', borderRadius:5, border:'none',
                                  background:'#f0f2f5', color:C.textDim,
                                  cursor:'pointer', fontSize:12 }}>
                                ⏭
                              </button>
                            </div>
                          )}
                          {isPosted && (
                            <span style={{ fontSize:18 }}>✅</span>
                          )}
                          {isSkipped && !isPosted && (
                            <button
                              onClick={()=>unskipBug(bug.run_id)}
                              title="Unskip — move back to pending"
                              style={{ padding:'4px 8px', borderRadius:5,
                                border:'1px solid #f59e0b',
                                background:'#f59e0b', color:'#fff',
                                cursor:'pointer', fontSize:11, fontWeight:600 }}>
                              ↩ Unskip
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {expanded[bug.run_id] && (
                        <tr style={{ background:'#f8faff', borderBottom:'2px solid #e2e6ed' }}>
                          <td colSpan={10} style={{ padding:'16px 24px' }}>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20 }}>

                              {/* Left — Steps to Reproduce */}
                              <div>
                                <div style={{ fontSize:12, fontWeight:700, color:C.textMid, marginBottom:8 }}>
                                  📋 Steps to Reproduce (Bug Description)
                                </div>
                                <textarea
                                  value={edit.steps_text ?? bug.steps_text ?? ''}
                                  onChange={e => updEdit(bug.run_id, 'steps_text', e.target.value)}
                                  disabled={isPosted || isSkipped}
                                  rows={10}
                                  style={{ width:'100%', padding:'8px 10px',
                                    background: isPosted||isSkipped ? '#1a2332' : '#0d1b2a',
                                    color:'#a8d8a8', borderRadius:8, fontSize:11,
                                    border: isPosted||isSkipped
                                      ? '1px solid #2d3748'
                                      : '1px solid #4a9f6e',
                                    resize:'vertical',
                                    fontFamily:'monospace', lineHeight:1.6,
                                    boxSizing:'border-box',
                                    cursor: isPosted||isSkipped ? 'default' : 'text',
                                    opacity: isPosted||isSkipped ? 0.7 : 1,
                                  }}
                                />
                                <div style={{ marginTop:10 }}>
                                  <div style={{ fontSize:12, fontWeight:700, color:C.textMid, marginBottom:6 }}>
                                    ❌ Error Message
                                  </div>
                                  <input
                                    type="text"
                                    value={edit.error_msg ?? bug.failed_step_error ?? ''}
                                    onChange={e => updEdit(bug.run_id, 'error_msg', e.target.value)}
                                    disabled={isPosted || isSkipped}
                                    placeholder="Error message..."
                                    style={{ width:'100%', padding:'7px 10px',
                                      border: isPosted||isSkipped
                                        ? '1px solid #e2e6ed'
                                        : '1px solid #1a6fc4',
                                      borderRadius:6, fontSize:12,
                                      boxSizing:'border-box',
                                      background: isPosted||isSkipped ? '#f8f9fc':'#fff',
                                      color:'#1a2332',
                                      opacity: isPosted||isSkipped ? 0.7 : 1,
                                    }}
                                  />
                                </div>
                                <div style={{ marginTop:10 }}>
                                  <div style={{ fontSize:12, fontWeight:700, color:C.textMid, marginBottom:6 }}>
                                    📝 Additional Notes (optional)
                                  </div>
                                  <textarea
                                    value={edit.notes || ''}
                                    onChange={e => updEdit(bug.run_id, 'notes', e.target.value)}
                                    placeholder="Add any extra context..."
                                    rows={3}
                                    style={{ width:'100%', padding:'8px 10px',
                                      border:'1px solid #e2e6ed', borderRadius:6,
                                      fontSize:12, resize:'vertical', boxSizing:'border-box' }}
                                  />
                                </div>
                              </div>

                              {/* Right — Details + Screenshot */}
                              <div>
                                <div style={{ fontSize:12, fontWeight:700, color:C.textMid,
                                  marginBottom:8 }}>
                                  ℹ️ Run Details
                                </div>
                                <div style={{ background:'#fff', border:'1px solid #e2e6ed',
                                  borderRadius:8, overflow:'hidden' }}>
                                  {[
                                    ['Test Case', bug.test_name],
                                    ['Source (Project)', bug.project_name],
                                    ['Browser', bug.browser],
                                    ['Base URL', bug.base_url],
                                    ['Run Date', bug.created_at ? new Date(bug.created_at).toLocaleString('en-IN') : '—'],
                                    ['Duration', bug.duration_ms ? `${(bug.duration_ms/1000).toFixed(1)}s` : '—'],
                                    ['Steps Total', bug.steps_count],
                                    ['Run ID', `#${bug.run_id}`],
                                  ].map(([k,v],i) => (
                                    <div key={k} style={{ display:'flex',
                                      borderBottom: i<7 ? '1px solid #f0f2f5' : 'none',
                                      background: i%2===0 ? '#fff' : '#fafafa' }}>
                                      <div style={{ padding:'6px 12px', width:130,
                                        fontSize:11, fontWeight:600, color:C.textMid, flexShrink:0 }}>
                                        {k}
                                      </div>
                                      <div style={{ padding:'6px 12px', fontSize:11,
                                        color:C.text, wordBreak:'break-all' }}>
                                        {v || '—'}
                                      </div>
                                    </div>
                                  ))}
                                </div>

                                {/* Screenshot */}
                                {bug.screenshot && (
                                  <div style={{ marginTop:12 }}>
                                    <div style={{ fontSize:12, fontWeight:700, color:C.textMid, marginBottom:6 }}>
                                      📸 Screenshot
                                    </div>
                                    <img
                                      src={`${API}/api/runs/${bug.run_id}/screenshot-file/${bug.screenshot.filename}`}
                                      alt="Step screenshot"
                                      style={{ maxWidth:'100%', borderRadius:8,
                                        border:'1px solid #e2e6ed', cursor:'pointer' }}
                                      onClick={()=>window.open(`${API}/api/runs/${bug.run_id}/screenshot-file/${bug.screenshot.filename}`)}
                                    />
                                  </div>
                                )}

                                {/* Post result error */}
                                {postResults[bug.run_id]?.error && (
                                  <div style={{ marginTop:10, padding:'8px 12px',
                                    background:'#fdecea', borderRadius:6,
                                    fontSize:12, color:C.red }}>
                                    ❌ {postResults[bug.run_id].error}
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div style={{ padding:'10px 16px', background:'#f8f9fc',
            borderTop:'1px solid #e2e6ed', display:'flex',
            justifyContent:'space-between', fontSize:12, color:C.textDim }}>
            <span>
              * Editable fields: click cell to edit • Severity, Affect Version and Summary are posted to JIRA
            </span>
            <span>{visibleBugs.length} rows shown</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function chip(bg, color) {
  return {
    background:   bg,
    color:        color,
    padding:      '4px 12px',
    borderRadius: 20,
    fontSize:     12,
    fontWeight:   700,
  };
}

function severityColor(sev) {
  const m = { Critical:'#dc2626', High:'#e53935', Medium:'#f59e0b', Low:'#00a86b' };
  return m[sev] || '#1a2332';
}

const th = {
  padding:       '10px 12px',
  textAlign:     'left',
  fontSize:      11,
  fontWeight:    700,
  color:         '#4a5568',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace:    'nowrap',
  userSelect:    'none',
};

const td = {
  padding:   '8px 12px',
  verticalAlign: 'middle',
  fontSize:  12,
  color:     '#1a2332',
};

const editInp = {
  width:        '100%',
  padding:      '5px 8px',
  border:       '1px solid #e2e6ed',
  borderRadius: 5,
  fontSize:     12,
  color:        '#1a2332',
  outline:      'none',
  boxSizing:    'border-box',
};
