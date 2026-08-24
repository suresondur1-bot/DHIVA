import React, { useState, useEffect, useRef, useCallback } from "react";
import { api, s, C, WS } from "./shared.jsx";

const EXT_ID = "kjcdbdllalehljpjdfljcekgikompmkf";

// ─── EXISTING Quick Scan prompt (unchanged) ───────────────────────────────────
function buildPrompt(pm) {
  const branches = (pm.buttons||[]).filter(b => b.isBranchTrigger||b.isBranch).map(b => b.text);
  const reqFields = (pm.fields||[]).filter(f => f.required).map(f => f.label);
  const dateFields = (pm.fields||[]).filter(f => f.isDate).map(f => f.label);
  const radioGroups = (pm.radioGroups||[]);
  const tabs = (pm.tabs||[]);

  // Group fields by section
  const sections = {};
  (pm.fields||[]).forEach(f => {
    const sec = f.section || 'General';
    if (!sections[sec]) sections[sec] = [];
    sections[sec].push(f);
  });

  const fieldLines = (pm.fields||[]).map((f,i) =>
    `${i+1}. "${f.label}"${f.required?' [REQUIRED]':''} sel:"${f.selector}" action:${f.action}${f.isDate?' [DATE:DD/MM/YYYY]':''}${f.options?.length?` opts:[${f.options.slice(0,4).join(',')}]`:''}`
  ).join('\n');

  const radioLines = radioGroups.map(g =>
    `RADIO "${g.label}" options:[${g.options.join(',')}] sel:"${g.selector}"`
  ).join('\n');

  const checkboxes = (pm.checkboxes||[]);
  const checkboxLines = checkboxes.map(c =>
    `CHECKBOX "${c.label}" sel:"${c.selector}"${c.checked?' [currently checked]':''}`
  ).join('\n');

  const tabLines = tabs.map(t => `TAB "${t.label}"${t.active?' [ACTIVE]':''}`).join(' | ');

  return `You are an ATHMA test automation expert. ATHMA uses Angular + ng-select components.

PAGE: ${pm.url}
TITLE: ${pm.title}
TYPE: ${pm.pageType}
${tabs.length ? `TABS: ${tabLines}` : ''}

FIELDS (${(pm.fields||[]).length}):
${fieldLines}

${radioGroups.length ? `RADIO GROUPS:
${radioLines}
` : ''}
${checkboxes.length ? `CHECKBOXES (${checkboxes.length}) — include check/uncheck steps for relevant ones:
${checkboxLines}
` : ''}
BUTTONS: ${(pm.buttons||[]).map(b => `"${b.text}"${(b.isBranchTrigger||b.isBranch)?' [BRANCH]':''}`).join(' | ')}
TABLES: ${(pm.tableColumns||[]).map(t => `[${t.headers?.join('|')}] inp:${t.hasInputs} ng:${t.hasNgSelect}`).join(' | ')||'none'}
REQUIRED FIELDS: ${reqFields.join(', ')||'none'}
DATE FIELDS: ${dateFields.join(', ')||'none'} (format: DD/MM/YYYY)
BRANCH TRIGGERS: ${branches.join(', ')||'none'}

RULES:
- search_select: for ng-select dropdowns — use value from options list
- select: for native dropdowns
- type: for text inputs — use realistic sample data
- check/uncheck: for checkboxes
- click: for radio options — use selector like input[name="x"][value="y"]
- navigate: ALWAYS first step with full URL
- wait_for_selector: add after navigate and after each tab click (use first required field selector)
- assert_text: MANDATORY — always add as the LAST step after save/submit button click
  Use selector: ".toast-message" or ".alert-success" or ".ng-trigger" or "div.toast"
  Use value: "" (empty — just check element appears, don't match exact text)
  Example: {"action":"assert_text","selector":".toast-message","value":"","timeout":10000}
- For DATE fields: use format DD/MM/YYYY with realistic dates
- For REQUIRED fields: always include in happy path script
- For RADIO groups: click one option per group
- Generate variable names like {{patient_name}}, {{date_of_birth}} for dynamic data

Return ONLY valid JSON array of script objects:
[{"name":"${pm.pageType}_HappyPath","description":"...","branchType":"happy_path","steps":[
  {"action":"navigate","selector":"","value":"${pm.url}","timeout":30000},
  {"action":"wait_for_selector","selector":"FIRST_REQUIRED_FIELD","value":"","timeout":10000},
  {"action":"search_select","selector":"ng-select[formcontrolname='x']","value":"Option","timeout":30000},
  {"action":"type","selector":"#field","value":"{{variable_name}}","timeout":10000},
  {"action":"click","selector":"button:has-text('Save')","value":"","timeout":10000},
  {"action":"assert_text","selector":".toast-message","value":"","timeout":10000}
]}]

Generate scripts: HappyPath${branches.some(b=>/cancel/i.test(b))?', CancelFlow':''}${branches.some(b=>/delete/i.test(b))?', DeleteFlow':''}${(pm.tableColumns||[]).some(t=>t.hasInputs||t.hasNgSelect)?', MultipleRows':''}.
branchType values: happy_path|cancel|validation|delete|variation.
RESPOND WITH ONLY THE JSON ARRAY — NO OTHER TEXT.`;
}

function buildPromptWithAnswers(pm, questions, answers, extraContext) {
  const answerContext = questions.map((q, i) => {
    const ans = answers[i];
    if (!ans) return null;
    return 'Q: ' + q.question + '\nA: ' + ans;
  }).filter(Boolean).join('\n');

  const base = buildPrompt(pm);
  if (!answerContext) return base;
  let extra = '';
  if (extraContext && extraContext.trim()) {
    extra = '\n\nADDITIONAL USER CONTEXT:\n' + extraContext.trim() + '\n(Use this information directly in the script — e.g. hardcode credentials, URLs, expected values as specified)';
  }
  return base + '\n\nUSER PREFERENCES & CONTEXT (incorporate these into the script):\n' + answerContext + extra + '\n\nIMPORTANT: Use ALL the above information to generate a more accurate script.';
}

// ─── PROCESSING PIPELINE ─────────────────────────────────────────────────────
// Mental model: a person watched the user. What did they do?
// - navigate: page they visited
// - type: something they typed (value changed during their focus)
// - click: button/link they pressed
// - search_select/select: dropdown they picked
// Dynamic = ask for new value each run. Static = always same.

function processRecording(rawEvents) {
  if (!rawEvents || !rawEvents.length) return { pages: [], variables: [], rawEventCount: 0 };

  // Keep events in arrival order (already correct from extension)
  // Only sort within same timestamp to break ties
  const events = [...rawEvents].sort((a, b) => {
    if (a.ts !== b.ts) return (a.ts || 0) - (b.ts || 0);
    return (a.seq || 0) - (b.seq || 0);
  });

  // Keep all events — recorder only captures real user actions
  const filtered = events;

  // Deduplicate: keep last value per selector for type/search_select
  const lastTyped = new Map();
  filtered.forEach(ev => {
    if (ev.action === 'type' || ev.action === 'search_select')
      lastTyped.set(ev.selector, ev);
  });
  // Deduplicate clicks — same selector within 2 seconds = one click
  const deduped = filtered.filter((ev, idx) => {
    if (ev.action === 'type' || ev.action === 'search_select') {
      return lastTyped.get(ev.selector) === ev;
    }
    if (ev.action === 'click') {
      // Remove duplicate clicks on same selector
      const prev = filtered.slice(0, idx).reverse()
        .find(e => e.action === 'click' && e.selector === ev.selector);
      if (prev && (ev.ts - prev.ts) < 2000) return false;
    }
    return true;
  });

  // Sort: username before password
  // Also sort: fromSnapshot events come AFTER click events on same page
  // (snapshot captures final state, clicks happened before)
  const finalDeduped = deduped.map((ev, idx, arr) => ev);
  // Within each navigate group, ensure username before password
  for (let i = 0; i < finalDeduped.length - 1; i++) {
    const ev = finalDeduped[i];
    const next = finalDeduped[i+1];
    if (ev.action === 'type' && next.action === 'type' &&
        ev.url === next.url &&
        /password|pass|pwd/.test((ev.label||ev.selector||'').toLowerCase()) &&
        /user|login|email/.test((next.label||next.selector||'').toLowerCase())) {
      // Swap — username should come before password
      finalDeduped[i] = next;
      finalDeduped[i+1] = ev;
    }
  }

  // Group into pages
  const pages = [];
  let cur = null;
  for (const ev of finalDeduped) {
    if (ev.action === 'navigate') {
      if (!cur || ev.url !== cur.url) {
        cur = { url: ev.url, title: ev.pageTitle || ev.value || ev.url,
          steps: [{ ...ev, label: 'Navigate to page', value: ev.url, dynamic: false }] };
        pages.push(cur);
      }
    } else {
      if (!cur) { cur = { url: ev.url||'', title: ev.pageTitle||'', steps: [] }; pages.push(cur); }
      cur.steps.push(ev);
    }
  }

  // Classify each step and build variables list
  const usedNames = new Set();
  const variables = [];
  const classifiedPages = pages.map(p => ({
    ...p,
    steps: p.steps.map(step => {
      const c = classifyStep(step);
      if (c.dynamic && c.action === 'type') {
        const varName = makeVarName(step.label || step.selector, usedNames);
        c.variable = varName;
        c.example = step.value;
        variables.push({ name: varName, label: step.label || step.selector,
          example: step.value, dynamic: true, confidence: c.confidence,
          type: /date|dob|birth/i.test(step.label) ? 'date' : 'string' });
      }
      return c;
    })
  }));

  // Success = URL changed between first and last navigate
  const navs = finalDeduped.filter(e => e.action === 'navigate');
  const successCondition = navs.length >= 2 && navs[0].url !== navs[navs.length-1].url
    ? { type: 'url_change', url: navs[navs.length-1].url } : null;

  return { pages: classifiedPages, variables, successCondition, rawEventCount: rawEvents.length };
}

function classifyStep(step) {
  // Actions — never parameterised
  if (['navigate','click','check','uncheck','assert_text','assert_visible'].includes(step.action))
    return { ...step, dynamic: false, confidence: 'high' };
  // Dropdowns — fixed options, static by default (user can override)
  if (step.action === 'search_select' || step.action === 'select')
    return { ...step, dynamic: false, confidence: 'medium' };
  // Type events — smart classification
  if (step.action === 'type') {
    const lbl = (step.label || '').toLowerCase();
    const val = step.value || '';
    if (/name|patient|doctor|staff|contact|person/.test(lbl))   return { ...step, dynamic: true, confidence: 'high' };
    if (/id|mrn|uhid|code|number|ref|reg|ipno|order/.test(lbl)) return { ...step, dynamic: true, confidence: 'high' };
    if (/date|dob|birth|from|to|start|end/.test(lbl))           return { ...step, dynamic: true, confidence: 'high' };
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(val))      return { ...step, dynamic: true, confidence: 'high' };
    if (/remark|note|comment|reason|description|address/.test(lbl)) return { ...step, dynamic: true, confidence: 'high' };
    if (/user|login|email|password|pass|pwd/.test(lbl))         return { ...step, dynamic: true, confidence: 'high' };
    if (/amount|qty|quantity|dose|price|rate/.test(lbl))        return { ...step, dynamic: true, confidence: 'medium' };
    return { ...step, dynamic: true, confidence: 'medium' }; // user typed it → probably varies
  }
  return { ...step, dynamic: false, confidence: 'medium' };
}

function makeVarName(label, usedNames) {
  const base = (label||'field').toLowerCase().replace(/[^a-z0-9\s]/g,'').trim().replace(/\s+/g,'_').slice(0,40)||'field';
  let n = base, i = 2;
  while (usedNames.has(n)) n = `${base}_${i++}`;
  usedNames.add(n);
  return n;
}

// ─── Quick Scan: extract {{variable}} tokens from a generated script's steps ──
// The AI puts {{var}} placeholders into step values; this pulls them out into a
// variables list (deduped, with a guessed type) so they can be shown at the top
// in an editable variable column. Mirrors Smart Record's variables list.
function extractScriptVariables(script) {
  const seen = new Set();
  const vars = [];
  (script.steps || []).forEach(step => {
    const val = step.value || '';
    const matches = val.match(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g) || [];
    matches.forEach(m => {
      const name = m.replace(/[{}\s]/g, '');
      if (seen.has(name)) return;
      seen.add(name);
      // Guess type from the variable name / the step.
      const lname = name.toLowerCase();
      let type = 'string';
      if (/date|dob|birth|from|to|start|end/.test(lname)) type = 'date';
      else if (/amount|qty|quantity|price|rate|count|number|age|dose/.test(lname)) type = 'number';
      vars.push({ name, label: step.label || name, example: '', type });
    });
  });
  return vars;
}


// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────
export default function SmartPageStudy({ user, projects }) {
  const [mode,      setMode]      = useState('choose'); // choose | quickscan | smartrecord
  // Quick Scan state (existing — unchanged)
  const [qsPhase,   setQsPhase]   = useState('idle');
  const [pageMap,   setPageMap]   = useState(null);
  const [qsScripts, setQsScripts] = useState([]);
  const [qsExpanded,setQsExpanded]= useState(null);
  const [qsQuestions, setQsQuestions] = useState([]); // AI-generated questions
  const [qsAnswers,   setQsAnswers]   = useState({}); // user answers
  const [qsCurQ,      setQsCurQ]      = useState(0);  // current question index
  const [qsExtraContext, setQsExtraContext] = useState(''); // free text extra info
  const [qsEditNames, setQsEditNames] = useState({}); // edited script names
  const [qsVars,    setQsVars]    = useState({}); // idx -> [{name,label,type,example}] editable variables per script
  const [qsSaving,  setQsSaving]  = useState({});
  const [qsSaved,   setQsSaved]   = useState({});
  const [qsError,   setQsError]   = useState('');
  const [qsScanLog, setQsScanLog] = useState([]);
  // Smart Record state (new)
  const [srPhase,   setSrPhase]   = useState('idle');   // idle|recording|processing|review|done
  const [srSessionId,setSrSessionId]=useState(null);
  const [srEvents,  setSrEvents]  = useState([]);       // live event stream
  const srEventsRef = useRef([]);                        // ref mirror — always current in async closures
  const [srProcessed,setSrProcessed]=useState(null);    // output of processRecording()
  const [srScripts, setSrScripts] = useState([]);
  const [srError,   setSrError]   = useState('');
  const [srSaving,  setSrSaving]  = useState({});
  const [srSaved,   setSrSaved]   = useState({});
  const [srExpanded,setSrExpanded]= useState(null);
  // Shared
  const [selProj,   setSelProj]   = useState('');
  const wsRef = useRef(null);

  useEffect(() => {
    window.__ATHMA_EXT_ID__ = EXT_ID;
    localStorage.setItem('athma_ext_id', EXT_ID);
  }, []);

  // ── Live WebSocket for smart record events ────────────────────────────────
  const connectSmartStudyWS = useCallback((sessionId) => {
    if (wsRef.current) wsRef.current.close();
    const wsUrl = (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
      window.location.host + `?smartStudyId=${sessionId}`;
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'smart_study_event' && msg.events?.length) {
          setSrEvents(prev => {
            const next = [...prev, ...msg.events].slice(-500);
            srEventsRef.current = next;
            return next;
          });
        }
      } catch(err) {}
    };
    ws.onerror = () => {};
    ws.onclose = () => {};
    wsRef.current = ws;
  }, []);

  const disconnectSmartStudyWS = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // ── Smart Record: Start ───────────────────────────────────────────────────
  async function startSmartRecord() {
    setSrError(''); setSrEvents([]); srEventsRef.current = []; setSrProcessed(null);
    setSrScripts([]); setSrSaved({}); setSrSaving({});
    setSrPhase('recording');
    try {
      const resp = await api('/api/smart-study/session/start', { method: 'POST', body: {} });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to start session');
      const sessionId = resp.sessionId;
      setSrSessionId(sessionId);
      // Tell extension directly to start recording with this session ID
      let extResult = null;
      await new Promise((resolve) => {
        try {
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
            console.warn('[SmartRecord] chrome.runtime not available — extension may not be connected');
            return resolve();
          }
          chrome.runtime.sendMessage(EXT_ID, { type: 'smart_study_start', sessionId }, (r) => {
            if (chrome.runtime.lastError) {
              console.warn('[SmartRecord] Ext msg error:', chrome.runtime.lastError.message);
            } else {
              extResult = r;
              console.log('[SmartRecord] Extension responded:', JSON.stringify(r));
            }
            resolve(r);
          });
          setTimeout(resolve, 5000); // increased from 3000
        } catch(e) {
          console.warn('[SmartRecord] sendMessage threw:', e.message);
          resolve();
        }
      });
      if (extResult && !extResult.ok) {
        throw new Error(extResult.error || 'Extension failed to start recording');
      }
      connectSmartStudyWS(sessionId);
    } catch(e) {
      setSrError(e.message);
      setSrPhase('idle');
    }
  }

  // ── Smart Record: Stop & Process ─────────────────────────────────────────
// ── Smart Record: Stop & Process ──────────────────────────────────────────────
  async function stopSmartRecord() {
    if (!srSessionId) return;
    setSrPhase('processing');
    disconnectSmartStudyWS(); // stop WS first — collect remaining srEvents
    try {
      // Step 1: Tell extension to stop + flush its events to server
      let extEvents = [];
      await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(EXT_ID, { type: 'smart_study_stop' }, (r) => {
            if (chrome.runtime.lastError) console.warn('Ext stop:', chrome.runtime.lastError.message);
            resolve(r);
          });
          setTimeout(resolve, 3000); // give ext 3s to stop + push
        } catch(e) { resolve(); }
      });

      // Step 2: Give extension extra time to finish pushing events to server
      await new Promise(r => setTimeout(r, 2000));

      // Step 3: Get events directly from extension memory (most reliable source)
      await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(EXT_ID, { type: 'smart_study_get_events' }, (r) => {
            if (!chrome.runtime.lastError && r?.events?.length) extEvents = r.events;
            resolve();
          });
          setTimeout(resolve, 2000);
        } catch(e) { resolve(); }
      });

      // Step 4: Tell server the session is done
      const resp = await api(`/api/smart-study/session/${srSessionId}/stop`, { method: 'POST', body: {} });

      // Step 5: Fetch events from server (retry up to 3x to handle push delay)
      let serverEvents = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const evResp = await api(`/api/smart-study/session/${srSessionId}/events`, { method: 'GET' });
        serverEvents = evResp?.events || resp?.events || [];
        if (serverEvents.length > 0) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500)); // wait and retry
      }

      console.log(`[SmartStudy] Sources — server:${serverEvents.length} ws:${srEventsRef.current.length} ext:${extEvents.length}`);

      // Step 6: Merge all sources (server + WS live feed ref + extension memory)
      const allEvents = [...serverEvents, ...srEventsRef.current, ...extEvents];
      const seen = new Set();
      const deduped = allEvents
        .filter(e => {
          const key = `${Math.round((e.ts||0)/100)}_${e.action}_${e.selector}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        })
        .sort((a,b) => (a.ts||0) - (b.ts||0));

      console.log(`[SmartStudy] Total deduped events: ${deduped.length}`);

      if (!deduped.length) {
        setSrError('No events captured. Make sure you performed actions in the app during recording.');
        setSrPhase('recording');
        return;
      }

      const processed = processRecording(deduped);
      setSrProcessed(processed);
      setSrPhase('review');
    } catch(e) {
      setSrError(e.message);
      setSrPhase('recording');
    }
  }
  // ── Smart Record: Generate script from reviewed data ─────────────────────
  async function generateScript() {
    if (!srProcessed || !srSessionId) return;
    setSrPhase('generating');
    setSrError('');
    try {
      const resp = await api(`/api/smart-study/session/${srSessionId}/generate`, {
        method: 'POST',
        body:   { processedRecording: srProcessed },
      });
      if (!resp?.ok) throw new Error(resp?.error || 'Generation failed');
      setSrScripts(resp.scripts || []);
      setSrPhase('done');
    } catch(e) {
      setSrError(e.message);
      setSrPhase('review');
    }
  }

  // ── Variable toggle handler ───────────────────────────────────────────────
  function toggleVariable(varName, newDynamic) {
    setSrProcessed(prev => {
      if (!prev) return prev;
      const variables = prev.variables.map(v =>
        v.name === varName ? { ...v, dynamic: newDynamic } : v
      );
      const pages = prev.pages.map(p => ({
        ...p,
        steps: p.steps.map(s =>
          s.variable === varName ? { ...s, dynamic: newDynamic } : s
        ),
      }));
      return { ...prev, variables, pages };
    });
  }

  function renameVariable(oldName, newName) {
    if (!newName.trim() || newName === oldName) return;
    const clean = newName.trim().replace(/[^a-z0-9_]/gi,'_').toLowerCase();
    setSrProcessed(prev => {
      if (!prev) return prev;
      const variables = prev.variables.map(v => v.name === oldName ? { ...v, name: clean } : v);
      const pages     = prev.pages.map(p => ({
        ...p,
        steps: p.steps.map(s => s.variable === oldName ? { ...s, variable: clean } : s),
      }));
      return { ...prev, variables, pages };
    });
  }

  // ── Save script ───────────────────────────────────────────────────────────
  async function saveScript(script, idx) {
    if (!selProj) { setSrError('Select a project first'); return; }
    setSrSaving(p => ({ ...p, [idx]: true }));
    try {
      const baseUrl = srProcessed?.pages?.[0]?.url || '';

      // Map Smart Record variable types to runner-understood types:
      // dynamic  -> dynamic  (resolve_dynamic_value: "Suresh$" style patterns)
      // fixed    -> fixed    (static hardcoded value)
      // anything else (including null/undefined) -> random_text
      const mapVarType = (v) => {
        if (!v.dynamic && v.dynamic !== null) return 'fixed';  // user marked Static
        // If user marked as Dynamic (v.dynamic === true or null), determine type based on actual variable type
        const t = (v.type || '').toLowerCase();
        if (t === 'date') return 'random_date';
        if (t === 'number') return 'random_number';
        if (t === 'email') return 'random_email';
        if (t === 'phone') return 'random_phone';
        return 'random_text';  // default for string/unknown types
      };

      await api('/api/tests', { method: 'POST', body: {
        project_id:  parseInt(selProj),
        name:        script.name,
        description: script.description || 'Smart Study Recording',
        type:        'ui', browser: 'chrome', base_url: baseUrl,
        steps:       script.steps || [],
        variables:   (srProcessed?.variables || [])
          .map(v => {
            const vType = mapVarType(v);
            const vValue = v.example || '';
            // Build proper config based on type and whether it's fixed or dynamic
            let vConfig = vValue;  // default: the actual value
            if (vType.startsWith('random_')) {
              // For random types, config should specify generation parameters
              if (vType === 'random_text') {
                vConfig = String(vValue.length || 8);  // length for text generation
              } else if (vType === 'random_number') {
                vConfig = '1-100';  // default range for numbers
              } else if (vType === 'random_date') {
                vConfig = 'YYYY-MM-DD';  // format for dates
              } else if (vType === 'random_phone') {
                vConfig = '10';  // phone length
              } else if (vType === 'random_email') {
                vConfig = 'domain.com';  // default email domain
              } else {
                vConfig = vValue;  // fallback to value
              }
            }
            // For fixed/static variables, config is the actual value
            if (!v.dynamic && v.dynamic !== null) {
              vConfig = vValue;
            }
            return {
              name: v.name,
              value: vValue,
              type: vType,
              config: vConfig,
            };
          }),
        tags:        ['smart-study','smart-record'],
        priority:    'high',
      }});
      setSrSaved(p => ({ ...p, [idx]: true }));
    } catch(e) { setSrError('Save failed: ' + e.message); }
    setSrSaving(p => ({ ...p, [idx]: false }));
  }

  function resetSmartRecord() {
    disconnectSmartStudyWS();
    setSrPhase('idle'); setSrSessionId(null);
    setSrEvents([]); srEventsRef.current = [];
    setSrProcessed(null); setSrScripts([]); setSrError('');
    setSrSaved({}); setSrSaving({});
  }

  // ── EXISTING Quick Scan handlers (unchanged logic) ────────────────────────
  const qsLog = msg => setQsScanLog(p => [...p, msg]);

  // Ask the extension in THE USER'S OWN browser to scan its active tab,
  // mirroring how Smart Record messages the extension directly. This avoids the
  // backend poll queue, where another browser (e.g. one on the server) could
  // answer with the wrong screen. Falls back to the old server path only if the
  // direct message can't be delivered.
  function scanViaExtension() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          return resolve({ ok: false, error: '__no_ext__' });
        }
        chrome.runtime.sendMessage(EXT_ID, { type: 'nat_scan_page' }, (r) => {
          if (chrome.runtime.lastError) {
            return resolve({ ok: false, error: '__no_ext__' });
          }
          resolve(r || { ok: false, error: 'No response from extension' });
        });
        // Safety timeout — if the extension never calls back
        setTimeout(() => resolve({ ok: false, error: '__no_ext__' }), 15000);
      } catch (e) {
        resolve({ ok: false, error: '__no_ext__' });
      }
    });
  }

  async function scanPage() {
    setQsError(''); setQsScanLog([]); setQsPhase('scanning');
    qsLog('📡 Asking the extension to scan your active tab...');
    try {
      // 1) Preferred: direct message to the user's own extension (like Smart Record)
      let sc = null;
      const direct = await scanViaExtension();
      if (direct && direct.ok && direct.result) {
        sc = direct.result;
        qsLog('✅ Scanned your active tab directly');
      } else if (direct && direct.error && direct.error !== '__no_ext__') {
        // Extension responded with a real error (e.g. no target tab) — surface it.
        throw new Error(direct.error);
      } else {
        // 2) Fallback: old server-queue path (only when the extension can't be reached directly)
        qsLog('ℹ️ Extension not reachable directly — falling back to server...');
        const resp = await api('/api/smart-study/scan', { method: 'POST', body: {} });
        if (!resp?.ok) throw new Error(resp?.error || 'Scan failed');
        if (!resp.result) throw new Error('No data returned — is the target page fully loaded?');
        sc = resp.result;
      }
      qsLog(`✅ ${sc.fields.length} fields, ${sc.buttons.length} buttons, ${sc.tableColumns.length} tables`);
      setPageMap(sc);
      setQsPhase('studied');
    } catch(e) {
      qsLog('❌ Error: ' + e.message);
      setQsError(e.message);
      setQsPhase('idle');
    }
  }

  async function askQuestions() {
    if (!pageMap) return;
    setQsPhase('questioning'); setQsError('');
    setQsAnswers({}); setQsCurQ(0);
    try {
      const resp = await api('/api/ai/quick-scan-questions', { method: 'POST', body: { pageMap } });
      if (!resp?.ok) throw new Error(resp?.error || 'Failed to generate questions');
      setQsQuestions(resp.questions || []);
    } catch(e) { setQsError(e.message); setQsPhase('studied'); }
  }

  async function generateQsScripts() {
    if (!pageMap) return;
    setQsPhase('generating'); setQsError('');
    try {
      const resp = await api('/api/ai/generate-scripts', { method: 'POST', body: { prompt: buildPromptWithAnswers(pageMap, qsQuestions, qsAnswers, qsExtraContext) } });
      let parsed = [];
      if (resp?.scripts?.length) { parsed = resp.scripts; }
      else if (resp?.raw) {
        const clean = resp.raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
        const si = clean.indexOf('['), ei = clean.lastIndexOf(']');
        if (si !== -1 && ei !== -1) parsed = JSON.parse(clean.slice(si, ei+1));
      }
      if (!parsed.length) throw new Error('AI returned no scripts');
      // Post-process: ensure every script has assert_text as last step after save/submit
      parsed = parsed.map(script => {
        const steps = script.steps || [];
        const lastStep = steps[steps.length - 1];
        const hasAssert = steps.some(s => s.action === 'assert_text' || s.action === 'assert_visible');
        const hasSave = steps.some(s => s.action === 'click' && /save|submit|register|create|add|confirm/i.test(s.value || s.selector || ''));
        if (!hasAssert && hasSave) {
          steps.push({ action: 'assert_text', selector: '.toast-message,.alert-success,.ng-trigger,.cdk-overlay-container', value: '', timeout: 10000 });
        }
        return { ...script, steps };
      });
      setQsScripts(parsed);
      // Extract {{variable}} tokens from each script into an editable list so they
      // show in the variable column at the top (user can change type before save).
      const varsByIdx = {};
      parsed.forEach((sc, i) => { varsByIdx[i] = extractScriptVariables(sc); });
      setQsVars(varsByIdx);
      setQsPhase('done');
    } catch(e) { setQsError('Generation failed: ' + e.message); setQsPhase('studied'); }
  }

  async function saveQsScript(script, idx) {
    if (!selProj) { setQsError('Select a project first'); return; }
    const scriptName = qsEditNames[idx] || script.name;
    setQsSaving(p => ({...p,[idx]:true}));
    try {
      await api('/api/tests', { method:'POST', body: {
        project_id: parseInt(selProj), name: scriptName,
        description: script.description||'Smart Page Study',
        type:'ui', browser:'chrome', base_url: pageMap?.url||'',
        steps: script.steps||[],
        variables: (qsVars[idx] || []).map(v => ({ name: v.name, value: v.example || '', type: v.type || 'string' })),
        tags:['smart-study',(pageMap?.pageType||'').toLowerCase()],
        priority: script.branchType==='happy_path'?'high':'medium',
      }});
      setQsSaved(p => ({...p,[idx]:true}));
    } catch(e) {
      const msg = e.message || '';
      if (msg.includes('already exists')) {
        setQsError(`Name "${scriptName}" already exists — click the name above to rename it, then save again.`);
      } else {
        setQsError('Save failed: ' + msg);
      }
    }
    setQsSaving(p => ({...p,[idx]:false}));
  }

  // Update one variable's field (type / example / name) for a given script idx.
  function updateQsVar(idx, varName, field, value) {
    setQsVars(prev => {
      const list = (prev[idx] || []).map(v => v.name === varName ? { ...v, [field]: value } : v);
      return { ...prev, [idx]: list };
    });
  }

  // ── Style helpers ─────────────────────────────────────────────────────────
  const AI = { navigate:'🌐',click:'🖱️',type:'⌨️',select:'📋',search_select:'🔍',
    check:'☑️',uncheck:'☐',wait:'⏱️',assert_text:'✅',assert_visible:'👁️',
    wait_for_selector:'⏳',store_text:'💾',press:'⌨️' };

  const BC = {
    happy_path:{bg:'#e6f7f1',color:'#00a86b',label:'✅ Happy Path'},
    cancel:{bg:'#fff8e6',color:'#f59e0b',label:'⚠️ Cancel Flow'},
    validation:{bg:'#fdecea',color:'#e53935',label:'❌ Validation'},
    delete:{bg:'#fdecea',color:'#c53030',label:'🗑 Delete Flow'},
    variation:{bg:'#e3f0fb',color:'#1a6fc4',label:'🔀 Variation'},
  };

  const confColor = { high:'#00a86b', medium:'#f59e0b', low:'#e53935' };
  const confLabel = { high:'AI confident', medium:'AI likely', low:'Please decide' };

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding:'20px 24px', minHeight:'80vh' }}>
      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:24, fontWeight:800, color:'#1a2332', marginBottom:4 }}>🧠 Smart Page Study</div>
        <div style={{ fontSize:13, color:C.textDim }}>
          Study a page snapshot <b>or</b> record a full transaction — AI generates robust test scripts.
        </div>
      </div>

      {/* Mode chooser */}
      {mode === 'choose' && (
        <div style={{ display:'flex', gap:16, marginBottom:24 }}>
          {[
            { key:'quickscan', icon:'⚡', title:'Quick Scan', sub:'Scan active page snapshot → AI generates scripts. Fast, one page.', color:'#1a6fc4', btn:'Quick Scan' },
            { key:'smartrecord', icon:'🎬', title:'Smart Record', sub:'Do your real transaction → AI watches, understands, generates robust parameterised scripts.', color:'#6c5ce7', btn:'Start Smart Recording', badge:'NEW' },
          ].map(opt => (
            <div key={opt.key} onClick={() => { setMode(opt.key); if(opt.key==='quickscan') setQsPhase('idle'); }}
              style={{ flex:1, background:'#fff', border:`2px solid ${opt.color}20`, borderRadius:12,
                padding:24, cursor:'pointer', position:'relative',
                boxShadow:'0 2px 8px rgba(0,0,0,0.06)', transition:'all 0.15s' }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=opt.color}
              onMouseLeave={e=>e.currentTarget.style.borderColor=`${opt.color}20`}>
              {opt.badge && (
                <span style={{ position:'absolute', top:12, right:12, background:opt.color,
                  color:'#fff', fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20 }}>
                  {opt.badge}
                </span>
              )}
              <div style={{ fontSize:36, marginBottom:10 }}>{opt.icon}</div>
              <div style={{ fontSize:16, fontWeight:800, color:'#1a2332', marginBottom:6 }}>{opt.title}</div>
              <div style={{ fontSize:12, color:C.textDim, lineHeight:1.6, marginBottom:16 }}>{opt.sub}</div>
              <button style={{ ...s.btn('primary'), background:opt.color, fontSize:13 }}>{opt.btn}</button>
            </div>
          ))}
        </div>
      )}

      {/* ── QUICK SCAN MODE (existing flow — unchanged) ───────────────────── */}
      {mode === 'quickscan' && (
        <div>
          <button onClick={() => setMode('choose')} style={{ ...s.btn('ghost',true), marginBottom:16, fontSize:12 }}>← Back</button>
          {qsError && (
            <div style={{ background:'#fdecea', border:'1px solid #fca5a5', borderRadius:8,
              padding:'10px 14px', marginBottom:16, fontSize:13, color:'#c53030' }}>
              ❌ {qsError} <button onClick={()=>setQsError('')} style={{ background:'none',border:'none',cursor:'pointer',color:'#c53030',float:'right' }}>×</button>
            </div>
          )}
          {qsPhase === 'idle' && (
            <div style={{ textAlign:'center', padding:'32px 0' }}>
              <div style={{ fontSize:56, marginBottom:16 }}>⚡</div>
              <div style={{ fontSize:17, fontWeight:800, color:'#1a2332', marginBottom:8 }}>Quick Scan</div>
              <div style={{ fontSize:13, color:C.textDim, marginBottom:24 }}>Navigate to the page you want to test, then click below.</div>
              <button onClick={scanPage} style={{ fontSize:15, padding:'12px 32px', borderRadius:10, border:'none',
                cursor:'pointer', background:'linear-gradient(135deg,#1a6fc4,#6c5ce7)', color:'#fff',
                fontWeight:700, boxShadow:'0 4px 20px rgba(26,111,196,0.35)' }}>
                🔍 Scan Active Page
              </button>
            </div>
          )}
          {qsPhase === 'scanning' && (
            <div style={{ background:'#fff', border:'1px solid #e2e6ed', borderRadius:10, padding:32, textAlign:'center' }}>
              <div style={{ fontSize:40, marginBottom:12 }}>🔍</div>
              <div style={{ fontSize:14, fontWeight:700, color:'#1a2332', marginBottom:12 }}>Scanning...</div>
              {qsScanLog.map((l,i)=><div key={i} style={{ fontSize:11,color:'#4a5568',padding:'2px 0' }}>{l}</div>)}
            </div>
          )}
          {/* ── QUESTIONING PHASE ─────────────────────────────────────── */}
          {qsPhase === 'questioning' && (
            <div style={{ background:'#fff', border:'1px solid #e2e6ed', borderRadius:12, padding:24 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
                <div style={{ fontSize:28 }}>🤖</div>
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:'#1a2332' }}>AI is asking you a few questions</div>
                  <div style={{ fontSize:12, color:'#64748b' }}>Your answers will make the script much more accurate</div>
                </div>
                <div style={{ marginLeft:'auto', fontSize:12, color:'#64748b', fontWeight:600 }}>
                  {qsCurQ + 1} / {qsQuestions.length}
                </div>
              </div>

              {/* Progress bar */}
              <div style={{ height:4, background:'#f1f5f9', borderRadius:2, marginBottom:24, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${((qsCurQ+1)/Math.max(qsQuestions.length,1))*100}%`,
                  background:'linear-gradient(90deg,#1a6fc4,#6c5ce7)', borderRadius:2, transition:'width 0.3s' }} />
              </div>

              {qsQuestions[qsCurQ] && (
                <div>
                  <div style={{ background:'#f8fafc', borderRadius:10, padding:16, marginBottom:16, borderLeft:'3px solid #1a6fc4' }}>
                    <div style={{ fontSize:14, fontWeight:600, color:'#1a2332', marginBottom:4 }}>
                      {qsQuestions[qsCurQ].question}
                    </div>
                    {qsQuestions[qsCurQ].hint && (
                      <div style={{ fontSize:11, color:'#64748b', marginTop:4 }}>💡 {qsQuestions[qsCurQ].hint}</div>
                    )}
                  </div>

                  {qsQuestions[qsCurQ].options?.length > 0 ? (
                    <div>
                      {qsQuestions[qsCurQ].multi && (
                        <div style={{ fontSize:11, color:'#64748b', marginBottom:8 }}>✅ Select all that apply</div>
                      )}
                      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12 }}>
                        {qsQuestions[qsCurQ].options.map((opt, oi) => {
                          const isMulti = qsQuestions[qsCurQ].multi;
                          const curAns = qsAnswers[qsCurQ] || '';
                          const selected = isMulti
                            ? (curAns ? curAns.split('|') : []).includes(opt)
                            : curAns === opt;
                          return (
                            <button key={oi}
                              onClick={() => {
                                if (isMulti) {
                                  const prev = qsAnswers[qsCurQ] ? qsAnswers[qsCurQ].split('|') : [];
                                  const next = selected ? prev.filter(x => x !== opt) : [...prev, opt];
                                  setQsAnswers(a => ({ ...a, [qsCurQ]: next.join('|') }));
                                } else {
                                  setQsAnswers(a => ({ ...a, [qsCurQ]: opt }));
                                  if (qsCurQ < qsQuestions.length - 1) setQsCurQ(q => q + 1);
                                }
                              }}
                              style={{ padding:'8px 18px', borderRadius:20, border:'1px solid', cursor:'pointer',
                                fontSize:13, transition:'all 0.15s',
                                background: selected ? '#1a6fc4' : '#fff',
                                color: selected ? '#fff' : '#1a2332',
                                borderColor: selected ? '#1a6fc4' : '#e2e6ed',
                                fontWeight: selected ? 600 : 400 }}>
                              {isMulti && selected ? '✓ ' : ''}{opt}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginBottom:20 }}>
                      <input type="text"
                        placeholder={qsQuestions[qsCurQ].placeholder || 'Type your answer...'}
                        value={qsAnswers[qsCurQ] || ''}
                        onChange={e => setQsAnswers(a => ({ ...a, [qsCurQ]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter' && qsCurQ < qsQuestions.length - 1) setQsCurQ(q => q + 1); }}
                        style={{ width:'100%', padding:'10px 14px', borderRadius:8, border:'1px solid #e2e6ed', fontSize:13, outline:'none' }}
                        autoFocus />
                    </div>
                  )}

                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <button onClick={() => setQsCurQ(q => Math.max(0, q-1))}
                      disabled={qsCurQ === 0}
                      style={{ ...s.btn('ghost'), opacity: qsCurQ === 0 ? 0.4 : 1 }}>← Back</button>
                    <div style={{ display:'flex', gap:8 }}>
                      <button onClick={() => { if (qsCurQ < qsQuestions.length - 1) setQsCurQ(q => q + 1); else generateQsScripts(); }}
                        style={{ ...s.btn('ghost'), fontSize:12 }}>Skip →</button>
                      {qsCurQ < qsQuestions.length - 1 ? (
                        <button onClick={() => setQsCurQ(q => q + 1)} style={s.btn('primary')}>Next →</button>
                      ) : (
                        <button onClick={generateQsScripts}
                          style={{ ...s.btn('primary'), background:'linear-gradient(135deg,#1a6fc4,#6c5ce7)' }}>
                          🚀 Generate Script
                        </button>
                      )}
                    </div>
                  </div>

                  {Object.keys(qsAnswers).length > 0 && (
                    <div style={{ marginTop:20, padding:'12px 16px', background:'#f8fafc', borderRadius:8, border:'1px solid #e2e6ed' }}>
                      <div style={{ fontSize:11, fontWeight:600, color:'#64748b', marginBottom:8, textTransform:'uppercase' }}>Answers so far</div>
                      {Object.entries(qsAnswers).map(([qi, ans]) => (
                        <div key={qi} style={{ display:'flex', gap:8, fontSize:12, marginBottom:4, cursor:'pointer' }}
                          onClick={() => setQsCurQ(parseInt(qi))}>
                          <span style={{ color:'#94a3b8', minWidth:30 }}>Q{parseInt(qi)+1}.</span>
                          <span style={{ color:'#64748b', flex:1 }}>{qsQuestions[qi]?.question?.slice(0,45)}...</span>
                          <span style={{ color:'#1a6fc4', fontWeight:600 }}>{ans}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Extra context free text */}
                  <div style={{ marginTop:16, paddingTop:16, borderTop:'1px solid #f1f5f9' }}>
                    <div style={{ fontSize:12, fontWeight:600, color:'#1a2332', marginBottom:6 }}>
                      📝 Any extra information? <span style={{ fontWeight:400, color:'#94a3b8' }}>(optional)</span>
                    </div>
                    <textarea
                      rows={3}
                      placeholder="e.g. username is admin, password is admin123, login URL is http://172.19.1.11, after save check toast says saved successfully..."
                      value={qsExtraContext}
                      onChange={e => setQsExtraContext(e.target.value)}
                      style={{ width:'100%', padding:'10px 14px', borderRadius:8, border:'1px solid #e2e6ed',
                        fontSize:12, resize:'vertical', outline:'none', lineHeight:1.5,
                        color:'#1a2332', fontFamily:'inherit', boxSizing:'border-box' }}
                    />
                    <div style={{ fontSize:11, color:'#94a3b8', marginTop:4 }}>
                      Write in plain English — credentials, URLs, expected results, anything that helps
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {(qsPhase === 'studied' || qsPhase === 'generating') && pageMap && (
            <div>
              <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:10,padding:20,marginBottom:16 }}>
                <div style={{ fontSize:16,fontWeight:800,color:'#1a2332' }}>{pageMap.title}</div>
                <div style={{ fontSize:11,color:C.textDim,fontFamily:'monospace',marginTop:2 }}>{pageMap.url}</div>
                <div style={{ display:'flex',gap:10,flexWrap:'wrap',marginTop:12 }}>
                  {[[`📝 ${(pageMap.fields||[]).length}`,  'Fields'],
                    [`🔍 ${(pageMap.fields||[]).filter(f=>f.action==='search_select').length}`,'Dropdowns'],
                    [`🔘 ${(pageMap.buttons||[]).length}`, 'Buttons'],
                    [`📊 ${(pageMap.tableColumns||[]).length}`,'Tables']].map(([n,l])=>(
                    <div key={l} style={{ background:'#f8f9fc',borderRadius:8,padding:'8px 14px',textAlign:'center',border:'1px solid #e2e6ed' }}>
                      <div style={{ fontSize:18,fontWeight:800,color:'#1a2332' }}>{n}</div>
                      <div style={{ fontSize:10,color:C.textDim }}>{l}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ textAlign:'center' }}>
                {qsPhase === 'studied' ? (
                  <button onClick={askQuestions} style={{ fontSize:14,padding:'11px 30px',borderRadius:10,border:'none',
                    cursor:'pointer',background:'linear-gradient(135deg,#6c5ce7,#1a6fc4)',color:'#fff',fontWeight:700 }}>
                    🚀 Generate Scripts
                  </button>
                ) : (
                  <div style={{ color:C.textDim,fontSize:13 }}>🧠 AI generating...</div>
                )}
                <div style={{ marginTop:10 }}>
                  <button onClick={()=>{setQsPhase('idle');setPageMap(null);setQsScripts([]);setQsExtraContext('');setQsError('');}} style={{ background:'none',border:'none',cursor:'pointer',color:C.textDim,fontSize:12 }}>← Scan again</button>
                </div>
              </div>
            </div>
          )}
          {qsPhase === 'done' && qsScripts.length > 0 && (
            <div>
              <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:10,padding:'14px 20px',marginBottom:16,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap' }}>
                <div style={{ fontSize:15,fontWeight:800,color:'#1a2332' }}>🎉 {qsScripts.length} Script{qsScripts.length>1?'s':''} Generated</div>
                <div style={{ flex:1 }} />
                <select value={selProj} onChange={e=>setSelProj(e.target.value)} style={{ ...s.input,width:200 }}>
                  <option value="">— Project —</option>
                  {(projects||[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={async()=>{for(let i=0;i<qsScripts.length;i++)if(!qsSaved[i])await saveQsScript(qsScripts[i],i);}} disabled={!selProj} style={{ ...s.btn('success'),opacity:selProj?1:0.5 }}>💾 Save All</button>
                <button onClick={()=>{setQsPhase('idle');setPageMap(null);setQsScripts([]);setQsExtraContext('');}} style={s.btn('ghost')}>← Scan Another</button>
              </div>
              {qsScripts.map((sc,idx)=>{
                const bc=BC[sc.branchType]||BC.variation;
                const isExp=qsExpanded===idx;
                return (
                  <div key={idx} style={{ background:'#fff',borderRadius:10,marginBottom:8,border:qsSaved[idx]?'2px solid #00a86b':'1px solid #e2e6ed',overflow:'hidden' }}>
                    <div style={{ display:'flex',alignItems:'center',gap:12,padding:'12px 16px',cursor:'pointer' }} onClick={()=>setQsExpanded(isExp?null:idx)}>
                      <span style={{ background:bc.bg,color:bc.color,padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:700 }}>{bc.label}</span>
                      <div style={{ flex:1 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <input
                            value={qsEditNames[idx] !== undefined ? qsEditNames[idx] : sc.name}
                            onChange={e => setQsEditNames(p => ({ ...p, [idx]: e.target.value }))}
                            onClick={e => e.stopPropagation()}
                            style={{ fontSize:14, fontWeight:700, color:'#1a2332', border:'1px solid transparent',
                              borderRadius:4, padding:'2px 6px', background:'transparent', outline:'none',
                              cursor:'text', width: '100%' }}
                            onFocus={e => { e.target.style.borderColor='#1a6fc4'; e.target.style.background='#fff'; }}
                            onBlur={e => { e.target.style.borderColor='transparent'; e.target.style.background='transparent'; }}
                          />
                        </div>
                        <div style={{ fontSize:11,color:C.textDim }}>{sc.description} <span style={{ color:'#1a6fc4',fontWeight:600 }}>{sc.steps?.length} steps</span></div>
                      </div>
                      {qsSaved[idx]?<span style={{ color:'#00a86b',fontWeight:700,fontSize:12 }}>✅ Saved</span>:
                        <button onClick={e=>{e.stopPropagation();saveQsScript(sc,idx);}} disabled={!selProj||qsSaving[idx]} style={{ ...s.btn('primary',true),opacity:selProj?1:0.5 }}>{qsSaving[idx]?'⏳':'💾 Save'}</button>}
                      <span style={{ color:C.textDim }}>{isExp?'▼':'▶'}</span>
                    </div>
                    {isExp && (
                      <div style={{ borderTop:'1px solid #f0f2f5',padding:'12px 16px',background:'#fafbfc' }}>
                        {/* Variable column — extracted {{variables}}, type editable before save */}
                        {(qsVars[idx] || []).length > 0 && (
                          <div style={{ marginBottom:14 }}>
                            <div style={{ fontSize:10,fontWeight:700,color:C.textMid,marginBottom:8,textTransform:'uppercase' }}>
                              Variables ({(qsVars[idx]||[]).length}) — set type &amp; default value before saving
                            </div>
                            <table style={{ width:'100%',borderCollapse:'collapse',marginBottom:4 }}>
                              <thead>
                                <tr style={{ background:'#f1f5f9' }}>
                                  {['Variable','Type','Default value'].map(h=>(
                                    <th key={h} style={{ ...s.th,padding:'6px 10px',fontSize:10 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(qsVars[idx]||[]).map(v => (
                                  <tr key={v.name}>
                                    <td style={{ ...s.td,padding:'6px 10px' }}>
                                      <span style={{ fontFamily:'monospace',fontSize:11,color:'#6c5ce7',
                                        background:'#ede9fe',padding:'2px 7px',borderRadius:4 }}>{`{{${v.name}}}`}</span>
                                    </td>
                                    <td style={{ ...s.td,padding:'6px 10px' }}>
                                      <select value={v.type} onChange={e=>updateQsVar(idx, v.name, 'type', e.target.value)}
                                        onClick={e=>e.stopPropagation()}
                                        style={{ ...s.input,width:120,padding:'4px 8px',fontSize:11 }}>
                                        <option value="string">string</option>
                                        <option value="number">number</option>
                                        <option value="date">date</option>
                                        <option value="runtime">runtime (ask each run)</option>
                                      </select>
                                    </td>
                                    <td style={{ ...s.td,padding:'6px 10px' }}>
                                      <input value={v.example||''} placeholder="optional"
                                        onChange={e=>updateQsVar(idx, v.name, 'example', e.target.value)}
                                        onClick={e=>e.stopPropagation()}
                                        style={{ ...s.input,width:160,padding:'4px 8px',fontSize:11 }} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        <div style={{ fontSize:10,fontWeight:700,color:C.textMid,marginBottom:8,textTransform:'uppercase' }}>Steps</div>
                        {(sc.steps||[]).map((step,si)=>(
                          <div key={si} style={{ display:'flex',gap:8,alignItems:'center',padding:'4px 10px',background:'#fff',borderRadius:6,border:'1px solid #f0f2f5',marginBottom:2 }}>
                            <span style={{ color:C.textDim,minWidth:20,fontSize:10 }}>{si+1}</span>
                            <span>{AI[step.action]||'•'}</span>
                            <span style={{ fontWeight:700,color:'#1a6fc4',minWidth:120,fontSize:11 }}>{step.action}</span>
                            {step.selector&&<span style={{ color:'#6c5ce7',fontFamily:'monospace',fontSize:10,flex:1 }}>{step.selector}</span>}
                            {step.value&&<span style={{ color:'#00a86b',fontWeight:600,fontSize:11,background:'#e6f7f1',padding:'1px 7px',borderRadius:4 }}>"{step.value}"</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── SMART RECORD MODE (new) ───────────────────────────────────────── */}
      {mode === 'smartrecord' && (
        <div>
          <button onClick={() => { resetSmartRecord(); setMode('choose'); }} style={{ ...s.btn('ghost',true), marginBottom:16, fontSize:12 }}>← Back</button>
          {srError && (
            <div style={{ background:'#fdecea',border:'1px solid #fca5a5',borderRadius:8,
              padding:'10px 14px',marginBottom:16,fontSize:13,color:'#c53030',display:'flex',justifyContent:'space-between' }}>
              <span>❌ {srError}</span>
              <button onClick={()=>setSrError('')} style={{ background:'none',border:'none',cursor:'pointer',color:'#c53030' }}>×</button>
            </div>
          )}

          {/* IDLE */}
          {srPhase === 'idle' && (
            <div>
              <div style={{ display:'flex',gap:12,marginBottom:28,flexWrap:'wrap' }}>
                {[
                  {n:'1',icon:'🌐',title:'Navigate to your page',desc:'Go to the Daiva Health module you want to test'},
                  {n:'2',icon:'🎬',title:'Click Start Recording',desc:'Purple banner appears — system is watching'},
                  {n:'3',icon:'📝',title:'Do your transaction',desc:'Fill fields, select options, click buttons — exactly as normal'},
                  {n:'4',icon:'⏹',title:'Stop & Review',desc:'Review dynamic vs static decisions, then generate the script'},
                ].map(item=>(
                  <div key={item.n} style={{ flex:1,minWidth:140,background:'#fff',border:'1px solid #e2e6ed',borderRadius:10,padding:'14px 16px',boxShadow:'0 1px 4px rgba(0,0,0,0.04)' }}>
                    <div style={{ fontSize:22,marginBottom:6 }}>{item.icon}</div>
                    <div style={{ fontSize:10,fontWeight:700,color:'#6c5ce7',letterSpacing:'0.08em',marginBottom:3 }}>STEP {item.n}</div>
                    <div style={{ fontSize:13,fontWeight:700,color:'#1a2332',marginBottom:4 }}>{item.title}</div>
                    <div style={{ fontSize:11,color:C.textDim,lineHeight:1.5 }}>{item.desc}</div>
                  </div>
                ))}
              </div>
              <div style={{ textAlign:'center', padding:'20px 0' }}>
                <div style={{ fontSize:56, marginBottom:16 }}>🎬</div>
                <div style={{ fontSize:17,fontWeight:800,color:'#1a2332',marginBottom:8 }}>Smart Recording</div>
                <div style={{ fontSize:13,color:C.textDim,marginBottom:24 }}>Navigate to your app page, then click Start. The system will watch everything you do.</div>
                <button onClick={startSmartRecord} style={{ fontSize:15,padding:'13px 36px',borderRadius:10,border:'none',
                  cursor:'pointer',background:'linear-gradient(135deg,#6c5ce7,#8b5cf6)',color:'#fff',
                  fontWeight:700,boxShadow:'0 4px 20px rgba(108,92,231,0.4)' }}>
                  🎬 Start Smart Recording
                </button>
              </div>
            </div>
          )}

          {/* RECORDING */}
          {srPhase === 'recording' && (
            <div>
              <div style={{ background:'#fff',border:'2px solid #6c5ce7',borderRadius:12,padding:20,marginBottom:16 }}>
                <div style={{ display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16 }}>
                  <div style={{ display:'flex',alignItems:'center',gap:10 }}>
                    <div style={{ width:12,height:12,borderRadius:'50%',background:'#6c5ce7',
                      animation:'pulse 1.2s ease-in-out infinite' }} />
                    <div style={{ fontSize:15,fontWeight:800,color:'#6c5ce7' }}>Smart Recording Active</div>
                  </div>
                  <button onClick={stopSmartRecord} style={{ ...s.btn('danger'), fontSize:13 }}>⏹ Stop & Process</button>
                </div>
                <div style={{ fontSize:12,color:C.textDim,marginBottom:12 }}>
                  Go to your app and perform the transaction. The system is watching every action.
                </div>
                {/* Live event feed */}
                <div style={{ background:'#f8f9fc',borderRadius:8,padding:12,maxHeight:280,overflowY:'auto' }}>
                  <div style={{ fontSize:10,fontWeight:700,color:C.textDim,marginBottom:8,textTransform:'uppercase' }}>
                    Live Feed — {srEvents.length} actions captured
                  </div>
                  {srEvents.length === 0 && (
                    <div style={{ color:C.textDim,fontSize:12,textAlign:'center',padding:20 }}>
                      Waiting for actions... Go to your app and start your transaction.
                    </div>
                  )}
                  {srEvents.slice(-20).map((ev,i) => (
                    <div key={ev.seq || i} style={{ display:'flex',gap:8,alignItems:'center',
                      padding:'4px 0',borderBottom:'1px solid #f0f2f5',fontSize:12 }}>
                      <span style={{ fontSize:14,width:20,flexShrink:0 }}>{AI[ev.action]||'•'}</span>
                      <span style={{ fontWeight:600,color:'#1a6fc4',minWidth:100,flexShrink:0 }}>{ev.action}</span>
                      {ev.label && <span style={{ color:'#4a5568',flex:1 }}>{ev.label}</span>}
                      {ev.value && !ev.autoFilled && (
                        <span style={{ color:'#6c5ce7',fontFamily:'monospace',fontSize:11,
                          background:'#ede9fe',padding:'1px 6px',borderRadius:4,maxWidth:120,
                          overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>
                          {ev.value}
                        </span>
                      )}
                      {ev.autoFilled && (
                        <span style={{ color:'#f59e0b',fontSize:10,background:'#fef9e7',
                          padding:'1px 6px',borderRadius:4 }}>auto-filled</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>
            </div>
          )}

          {/* PROCESSING */}
          {srPhase === 'processing' && (
            <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:12,padding:40,textAlign:'center' }}>
              <div style={{ fontSize:48,marginBottom:16 }}>⚙️</div>
              <div style={{ fontSize:15,fontWeight:700,color:'#1a2332',marginBottom:8 }}>Processing Recording...</div>
              <div style={{ fontSize:12,color:C.textDim }}>Filtering noise · Detecting auto-fills · Classifying values · Building script structure</div>
              <div style={{ fontSize:11,color:'#6c5ce7',marginTop:8 }}>All processing on your machine — no server load</div>
            </div>
          )}

          {/* REVIEW — Variable decisions */}
          {srPhase === 'review' && (
            <div>
              <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:10,padding:20,marginBottom:16 }}>
                <div style={{ fontSize:15,fontWeight:800,color:'#1a2332',marginBottom:4 }}>
                  📋 Review Before Generating
                </div>
                <div style={{ fontSize:12,color:C.textDim,marginBottom:16 }}>
                  {srProcessed ? (
                    <>{srProcessed.rawEventCount} actions captured · {srProcessed.pages.length} page{srProcessed.pages.length!==1?'s':''} · {srProcessed.variables.length} variables identified. Review which values should change per run.</>
                  ) : 'Processing complete — ready to generate.'}
                </div>

                {/* Variable Review Table */}
                {srProcessed.variables.length > 0 && (
                  <div style={{ marginBottom:20 }}>
                    <div style={{ fontSize:12,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:'uppercase' }}>
                      Variables — Should This Value Change Each Run?
                    </div>
                    <table style={{ width:'100%',borderCollapse:'collapse' }}>
                      <thead>
                        <tr style={{ background:'#f8f9fc' }}>
                          {['Field','Captured Value','Edit Value','AI Suggestion','Dynamic?','Variable Name'].map(h=>(
                            <th key={h} style={{ ...s.th,padding:'8px 12px' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {srProcessed.variables.map((v,i) => (
                          <tr key={v.name}>
                            <td style={{ ...s.td,fontWeight:600 }}>{v.label}</td>
                            <td style={{ ...s.td,fontFamily:'monospace',fontSize:12,color:'#6c5ce7' }}>
                              {(v.example||'').slice(0,30)}
                            </td>
                            <td style={{ ...s.td,padding:'6px 8px' }}>
                              <input
                                type="text"
                                defaultValue={v.example||''}
                                onChange={e => {
                                  setSrProcessed(prev => ({
                                    ...prev,
                                    variables: prev.variables.map((varItem, idx) =>
                                      idx === i ? { ...varItem, example: e.target.value } : varItem
                                    ),
                                    pages: prev.pages.map(p => ({
                                      ...p,
                                      steps: p.steps.map(s => 
                                        s.variable === v.name ? { ...s, value: e.target.value, example: e.target.value } : s
                                      )
                                    }))
                                  }));
                                }}
                                style={{ width:'100%',padding:'4px 6px',fontSize:12,borderRadius:4,border:'1px solid #e2e6ed',fontFamily:'monospace' }}
                                placeholder="Enter value..."
                              />
                            </td>
                            <td style={{ ...s.td }}>
                              <span style={{ fontSize:11,color:confColor[v.confidence],fontWeight:600 }}>
                                {v.dynamic === true ? '🔵 Dynamic' : v.dynamic === false ? '🟡 Static' : '❓ Unsure'}
                                <span style={{ color:C.textDim,fontWeight:400,marginLeft:4 }}>({confLabel[v.confidence]})</span>
                              </span>
                            </td>
                            <td style={{ ...s.td }}>
                              <div style={{ display:'flex',gap:4 }}>
                                {[{val:true,label:'Dynamic'},{val:false,label:'Static'},{val:null,label:'Default'}].map(opt=>(
                                  <button key={String(opt.val)} onClick={() => toggleVariable(v.name, opt.val)}
                                    style={{ padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:600,cursor:'pointer',border:'1px solid',
                                      background: v.dynamic===opt.val ? (opt.val===true?'#1a6fc4':opt.val===false?'#f59e0b':'#6c5ce7') : '#fff',
                                      color:      v.dynamic===opt.val ? '#fff' : C.textDim,
                                      borderColor:v.dynamic===opt.val ? 'transparent' : '#e2e6ed' }}>
                                    {opt.label}
                                  </button>
                                ))}
                              </div>
                            </td>
                            <td style={{ ...s.td }}>
                              {(v.dynamic || v.dynamic === null) ? (
                                <input
                                  defaultValue={v.name}
                                  onBlur={e => renameVariable(v.name, e.target.value)}
                                  style={{ ...s.input,width:140,padding:'4px 8px',fontSize:12,fontFamily:'monospace' }}
                                />
                              ) : (
                                <span style={{ color:C.textDim,fontSize:12 }}>hardcoded</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Step preview — collapsed by page */}
                <div>
                  <div style={{ fontSize:12,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:'uppercase' }}>
                    Recorded Steps Preview
                  </div>
                  {srProcessed.pages.map((p,pi)=>(
                    <div key={pi} style={{ marginBottom:12 }}>
                      <div style={{ fontSize:12,fontWeight:700,color:'#1a6fc4',marginBottom:6,padding:'4px 8px',background:'#e3f0fb',borderRadius:6 }}>
                        Page {pi+1}: {p.title}
                      </div>
                      {p.steps.map((step,si)=>(
                        <div key={si} style={{ display:'flex',gap:8,alignItems:'center',padding:'4px 10px',
                          background:'#fff',borderRadius:6,border:'1px solid #f0f2f5',marginBottom:2,
                          opacity: step.autoFilled ? 0.4 : 1 }}>
                          <span style={{ color:C.textDim,minWidth:20,fontSize:10 }}>{si+1}</span>
                          <span>{AI[step.action]||'•'}</span>
                          <span style={{ fontWeight:700,color:'#1a6fc4',minWidth:110,fontSize:11 }}>{step.action}</span>
                          {step.label && <span style={{ color:'#4a5568',fontSize:12,flex:1 }}>{step.label}</span>}
                          {step.dynamic || step.dynamic===null ? (
                            <span style={{ color:'#6c5ce7',fontFamily:'monospace',fontSize:11,
                              background:'#ede9fe',padding:'1px 7px',borderRadius:4 }}>
                              {`{{${step.variable}}}`}
                            </span>
                          ) : (
                            <span style={{ color:'#00a86b',fontWeight:600,fontSize:11,
                              background:'#e6f7f1',padding:'1px 7px',borderRadius:4 }}>
                              "{step.value}"
                            </span>
                          )}
                          {step.autoFilled && <span style={{ color:'#f59e0b',fontSize:10 }}>⏭ auto-skip</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <div style={{ display:'flex',gap:10,justifyContent:'flex-end',marginTop:16 }}>
                  <button onClick={resetSmartRecord} style={s.btn('ghost')}>🔄 Record Again</button>
                  <button onClick={generateScript} style={{ ...s.btn('primary'),background:'linear-gradient(135deg,#6c5ce7,#1a6fc4)' }}>
                    🚀 Generate Script
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* GENERATING */}
          {srPhase === 'generating' && (
            <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:12,padding:40,textAlign:'center' }}>
              <div style={{ fontSize:48,marginBottom:16 }}>🧠</div>
              <div style={{ fontSize:15,fontWeight:700,color:'#1a2332',marginBottom:8 }}>AI Writing Your Script...</div>
              <div style={{ fontSize:12,color:C.textDim }}>Building robust, parameterised test steps from your recording.</div>
            </div>
          )}

          {/* DONE — Generated scripts */}
          {srPhase === 'done' && srScripts.length > 0 && (
            <div>
              <div style={{ background:'#fff',border:'1px solid #e2e6ed',borderRadius:10,
                padding:'14px 20px',marginBottom:16,display:'flex',alignItems:'center',gap:14,flexWrap:'wrap' }}>
                <div>
                  <div style={{ fontSize:16,fontWeight:800,color:'#1a2332' }}>🎉 Script Generated from Recording</div>
                  <div style={{ fontSize:11,color:C.textDim,marginTop:2 }}>
                    {srProcessed?.variables?.filter(v=>v.dynamic||v.dynamic===null).length || 0} dynamic variables ·
                    {srProcessed?.pages?.length || 0} pages ·
                    {srScripts[0]?.steps?.length || 0} steps
                  </div>
                </div>
                <div style={{ flex:1 }} />
                <select value={selProj} onChange={e=>setSelProj(e.target.value)} style={{ ...s.input,width:200 }}>
                  <option value="">— Select Project —</option>
                  {(projects||[]).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button onClick={()=>srScripts.forEach((sc,i)=>{if(!srSaved[i])saveScript(sc,i);})} disabled={!selProj}
                  style={{ ...s.btn('success'),opacity:selProj?1:0.5 }}>
                  💾 Save to Project
                </button>
                <button onClick={resetSmartRecord} style={s.btn('ghost')}>🔄 Record Again</button>
              </div>

              {srScripts.map((script,idx) => {
                const isExp = srExpanded === idx;
                return (
                  <div key={idx} style={{ background:'#fff',borderRadius:10,marginBottom:10,
                    border:srSaved[idx]?'2px solid #00a86b':'1px solid #6c5ce730',overflow:'hidden' }}>
                    <div style={{ display:'flex',alignItems:'center',gap:12,padding:'13px 16px',cursor:'pointer' }}
                      onClick={()=>setSrExpanded(isExp?null:idx)}>
                      <span style={{ background:'#ede9fe',color:'#6c5ce7',padding:'3px 11px',
                        borderRadius:20,fontSize:11,fontWeight:700 }}>🎬 Smart Recording</span>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:14,fontWeight:700,color:'#1a2332' }}>{script.name}</div>
                        <div style={{ fontSize:11,color:C.textDim }}>
                          {script.description} <span style={{ color:'#6c5ce7',fontWeight:600 }}>{script.steps?.length} steps</span>
                        </div>
                      </div>
                      {srSaved[idx] ? (
                        <span style={{ color:'#00a86b',fontWeight:700,fontSize:12 }}>✅ Saved</span>
                      ) : (
                        <button onClick={e=>{e.stopPropagation();saveScript(script,idx);}}
                          disabled={!selProj||srSaving[idx]}
                          style={{ ...s.btn('primary',true),background:'#6c5ce7',opacity:selProj?1:0.5 }}>
                          {srSaving[idx]?'⏳':'💾 Save'}
                        </button>
                      )}
                      <span style={{ color:C.textDim }}>{isExp?'▼':'▶'}</span>
                    </div>
                    {isExp && (
                      <div style={{ borderTop:'1px solid #f0f2f5',padding:'12px 16px',background:'#fafbfc' }}>
                        <div style={{ fontSize:10,fontWeight:700,color:C.textMid,marginBottom:10,textTransform:'uppercase' }}>
                          Steps ({script.steps?.length||0})
                        </div>
                        {(script.steps||[]).map((step,si)=>(
                          <div key={si} style={{ display:'flex',gap:8,alignItems:'center',
                            padding:'5px 10px',background:'#fff',borderRadius:6,
                            border:'1px solid #f0f2f5',marginBottom:3 }}>
                            <span style={{ color:C.textDim,minWidth:22,fontSize:10 }}>{si+1}</span>
                            <span>{AI[step.action]||'•'}</span>
                            <span style={{ fontWeight:700,color:'#6c5ce7',minWidth:120,fontSize:11 }}>{step.action}</span>
                            {step.selector&&<span style={{ color:'#4a5568',fontFamily:'monospace',fontSize:10,flex:1 }}>{step.selector}</span>}
                            {step.value&&<span style={{ color:step.value.startsWith('{{')?'#6c5ce7':'#00a86b',fontWeight:600,fontSize:11,
                              background:step.value.startsWith('{{')?'#ede9fe':'#e6f7f1',
                              padding:'1px 7px',borderRadius:4,flexShrink:0 }}>"{step.value}"</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
