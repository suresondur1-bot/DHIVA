// ATHMA Extension — Background Service Worker

// Fallback defaults (used if backend is unreachable)
const FALLBACK_API = 'http://10.8.7.176:6001';
const FALLBACK_NAT = 'http://10.8.7.176:6001';

// Try to fetch config from backend on startup
let DEFAULT_API = FALLBACK_API;
let DEFAULT_NAT = FALLBACK_NAT;

async function fetchBackendConfig() {
  try {
    const response = await fetch(`${FALLBACK_API}/api/extension/config`, {
      signal: AbortSignal.timeout(3000)
    });
    if (response.ok) {
      const config = await response.json();
      DEFAULT_API = config.api || FALLBACK_API;
      DEFAULT_NAT = config.nat || FALLBACK_NAT;
      console.log('[ATHMA] Config loaded from backend:', { api: DEFAULT_API, nat: DEFAULT_NAT });
    }
  } catch (e) {
    console.warn('[ATHMA] Could not reach backend, using fallback:', e.message);
  }
}

fetchBackendConfig();

async function getServerConfig() {
  return new Promise(resolve => {
    chrome.storage.local.get(['athma_server_api', 'athma_server_nat'], (d) => {
      resolve({
        api: (d.athma_server_api || DEFAULT_API).replace(/\/$/, ''),
        nat: (d.athma_server_nat || DEFAULT_NAT).replace(/\/$/, ''),
      });
    });
  });
}

let ATHMA_API    = DEFAULT_API;
let ATHMA_WS_URL = DEFAULT_API.replace('http', 'ws');

const NAT_ORIGINS = [
  'http://localhost:5176', 'http://localhost:5177',
  'http://localhost:6001',
  'http://10.8.7.176:5176', 'http://10.8.7.176:5177',
  'http://10.8.7.176:6001',
];

let ws = null;

// ── Smart Study 2.0 State — completely separate from rec object ─────────────────
let smartRec = {
  active:    false,
  sessionId: null,
  tabId:     null,
  events:    [],       // local buffer for reconnect resilience
  pending:   [],       // events waiting to be sent (during WS reconnect)
};

async function startSmartStudy(sessionId) {
  // Set active + sessionId IMMEDIATELY before any async operations
  smartRec.active    = true;
  smartRec.sessionId = sessionId;
  smartRec.events    = [];
  smartRec.pending   = [];
  // Find the active non-ATHMA tab
  const ATHMA_P = ['localhost:5176','localhost:5177','localhost:6001','10.8.7.176:5176','10.8.7.176:5177','10.8.7.176:6001'];
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = active;
  if (!tab || ATHMA_P.some(p => (tab.url||'').includes(p))) {
    const all = await chrome.tabs.query({});
    tab = all.filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !ATHMA_P.some(p => t.url.includes(p))).sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
  }
  if (!tab) return { ok: false, error: 'No target tab found. Open the app page first.' };
  smartRec = { active: true, sessionId, tabId: tab.id, events: [], pending: [] };
  chrome.storage.local.set({ athma_smart_events: [], athma_smart_session: sessionId }).catch(()=>{});

  // Step 0: Clear any previous recording state
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: () => {
        window.__athmaSmartStudyLocalEvents = [];
        window.__athmaSmartStudyActive = false;
        window.__athmaSmartBridgeActive = false;
        window.__athmaPreWatcher = false;
      },
    });
  } catch(e) {}

  // Step 1: Inject isolated world bridge FIRST — must be ready before any input events
  // This listens for postMessage from MAIN world and relays via chrome.runtime
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'ISOLATED',
    func: (extId) => {
      if (window.__athmaSmartBridgeActive) return;
      window.__athmaSmartBridgeActive = true;
      window.addEventListener('message', function(e) {
        if (e.source !== window) return;
        if (e.data && e.data.__athmaSmartStudy) {
          try {
            chrome.runtime.sendMessage(e.data.__athmaSmartStudy, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch(err) {}
        }
      });
      console.log('[ATHMA SmartStudy Bridge] Isolated world bridge ready');
    },
    args: [chrome.runtime.id],
  });

  // Step 2: Set sessionId in MAIN world
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (sid) => {
      window.__athmaSmartStudySessionId = sid;
      window.__athmaSmartStudyActive    = false;
    },
    args: [sessionId],
  });

  // Step 3: Inject recorder into MAIN world
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    files: ['smart_study_recorder.js'],
  });

  // Verify
  const verify = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => ({ sid: window.__athmaSmartStudySessionId, active: window.__athmaSmartStudyActive }),
  });
  console.log('[SmartStudy] Page state after inject:', verify?.[0]?.result);
  console.log('[SmartStudy] Recording started on tab', tab.id, 'session', sessionId);
  return { ok: true, tabId: tab.id, url: tab.url };
}

async function stopSmartStudy() {
  if (!smartRec.active) return { ok: false };

  // Step 1: Tell recorder to stop + take final snapshot
  try {
    await chrome.scripting.executeScript({
      target: { tabId: smartRec.tabId }, world: 'MAIN',
      func: () => { if (window.__athmaSmartStudyStop) window.__athmaSmartStudyStop(); },
    });
  } catch(e) {}

  // Step 2: Wait for final snapshot to complete
  await new Promise(r => setTimeout(r, 500));

  // Step 3: Read current page's local events and merge
  // Note: smartRec.events already has events from ALL pages via postMessage
  // The current page's local store only has events from the current page
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: smartRec.tabId }, world: 'MAIN',
      func: () => window.__athmaSmartStudyLocalEvents || [],
    });
    const pageEvents = result?.[0]?.result || [];
    console.log('[SmartStudy] Background events:', smartRec.events.length, '| Page events:', pageEvents.length);
    // Merge all sources
    const allEvents = [...smartRec.events, ...pageEvents];
    // Deduplicate by ts+action+selector
    const seen = new Set();
    smartRec.events = allEvents.filter(e => {
      const key = `${Math.round((e.ts||0)/100)}|${e.action}|${e.selector}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).sort((a,b) => (a.ts||0)-(b.ts||0));
    console.log('[SmartStudy] Final merged events:', smartRec.events.length);
  } catch(e) {
    console.warn('[SmartStudy] Could not read page events:', e.message);
  }

  // Step 4: Push to server
  if (smartRec.events.length > 0 && smartRec.sessionId) {
    try {
      const { api } = await getServerConfig();
      const token = await getFreshToken();
      await fetch(`${api}/api/smart-study/session/${smartRec.sessionId}/push-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ events: smartRec.events }),
      });
      console.log('[SmartStudy] Pushed', smartRec.events.length, 'events to server');
    } catch(e) {
      console.warn('[SmartStudy] Failed to push events to server:', e.message);
    }
  }

  smartRec.active = false;
  return { ok: true };
}

// Re-inject smart_study_recorder on FULL page reload only
// Angular SPA navigation doesn't trigger tabs.onUpdated status:complete
// so we only need to re-inject when the page fully reloads
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!smartRec.active || tabId !== smartRec.tabId) return;
  if (changeInfo.status !== 'complete') return;
  // Only re-inject if the recorder is no longer active on the page
  // (i.e. a full page reload happened, not just Angular router change)
  chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN',
    func: () => window.__athmaSmartStudyActive,
  }).then(result => {
    const recorderStillActive = result?.[0]?.result;
    if (recorderStillActive) {
      console.log('[SmartStudy] Recorder still active on page, skipping re-injection');
      return; // recorder is running fine, don't touch it
    }
    // Re-inject: pre-watcher first, then bridge, then recorder
    console.log('[SmartStudy] Recorder gone, re-injecting...');
    const sid = smartRec.sessionId;
    // Bridge first, then recorder
    chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: () => {
        if (window.__athmaSmartBridgeActive) return;
        window.__athmaSmartBridgeActive = true;
        window.addEventListener('message', function(e) {
          if (e.source !== window) return;
          if (e.data && e.data.__athmaSmartStudy) {
            try { chrome.runtime.sendMessage(e.data.__athmaSmartStudy, () => { if (chrome.runtime.lastError) {} }); } catch(err) {}
          }
        });
      },
    })
    .then(() => chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (s, startSeq) => {
        window.__athmaSmartStudyLocalEvents = [];
        window.__athmaSmartStudySessionId = s;
        window.__athmaSmartStudyStartSeq = startSeq;
        window.__athmaSmartStudyActive = false;
      },
      args: [sid, smartRec.events.length + 100],
    }))
    .then(() => chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', files: ['smart_study_recorder.js'],
    }))
    .then(() => { console.log('[SmartStudy] Re-injected, session:', sid); })
    .catch(err => { console.warn('[SmartStudy] Re-inject failed:', err?.message); });
  }).catch(() => {});
});

// ── Recorder ──────────────────────────────────────────────────────────────────
let rec = { active: false, tabId: null, sessionId: null, steps: [] };

async function injectRecorder(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder.js'] });
  } catch(e) {}
}

async function startRecording(sessionId, targetUrl) {
  let tab;
  if (targetUrl) {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 3000);
      const fn = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(fn);
          clearTimeout(timeout);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(fn);
    });
    tab = await chrome.tabs.get(tab.id);
  } else {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) return { ok: false, error: 'No active tab' };
    tab = active;
  }
  rec = { active: true, tabId: tab.id, sessionId, steps: [] };
  const url = tab.url || '';
  if (url && !url.startsWith('chrome://') && !url.startsWith('chrome-extension://')) {
    rec.steps.push({ action: 'navigate', selector: '', value: url, label: 'Navigate to ' + url, timeout: 30000 });
  }
  await injectRecorder(tab.id);
  return { ok: true, tabId: tab.id, url };
}

async function stopRecording() {
  if (!rec.active) return { ok: false, steps: [] };
  try { await chrome.tabs.sendMessage(rec.tabId, { type: 'stop_recording' }); } catch(e) {}
  const steps = [...rec.steps];
  rec.active = false;
  rec.tabId = null;
  return { ok: true, steps };
}

// Re-inject recorder on navigation + pick up token from ATHMA pages
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (rec.active && tabId === rec.tabId && changeInfo.status === 'complete') {
    injectRecorder(tabId);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    const allNatOrigins = [...new Set([...NAT_ORIGINS])];
    if (allNatOrigins.some(o => tab.url.startsWith(o))) {
      chrome.scripting.executeScript({
        target: { tabId },
        func: (extId) => {
          window.__ATHMA_EXT_ID__ = extId;
          try { localStorage.setItem('athma_ext_id', extId); } catch(e) {}
          window.dispatchEvent(new CustomEvent('athma_ext_ready', { detail: { extId } }));
        },
        args: [chrome.runtime.id],
      }).catch(() => {});
      // Always pick up fresh token from ATHMA page
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => localStorage.getItem('autoqa_token'),
      }).then(results => {
        const token = results?.[0]?.result;
        if (token) chrome.storage.local.set({ athma_token: token });
      }).catch(() => {});
    }
  }
});

// ── Inspector ─────────────────────────────────────────────────────────────────
let inspectorSessions = new Map(); // Map<tabId, { sessionId, startTime }>

// Persist inspector sessions to survive MV3 service worker restarts
async function saveInspectorSessions() {
  const obj = {};
  for (const [tabId, session] of inspectorSessions) {
    obj[String(tabId)] = session;
  }
  await chrome.storage.session.set({ athma_inspector_sessions: obj }).catch(()=>{});
}

async function loadInspectorSessions() {
  try {
    const d = await chrome.storage.session.get('athma_inspector_sessions');
    const obj = d.athma_inspector_sessions || {};
    for (const [tabId, session] of Object.entries(obj)) {
      // Only restore recent sessions (last 5 minutes)
      if (Date.now() - (session.startTime || 0) < 300000) {
        inspectorSessions.set(parseInt(tabId), session);
      }
    }
    console.log('[Inspector] Restored', inspectorSessions.size, 'sessions from storage');
  } catch(e) {}
}

// Load on startup
loadInspectorSessions();

function isNatUrl(url) {
  return !url || url.includes(':5176') || url.includes(':5177') ||
    url.startsWith('chrome://') || url.startsWith('chrome-extension://');
}

async function getFreshToken() {
  // Always try to read fresh token from ATHMA page first
  try {
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    for (const t of tabs) {
      if (t.url && (t.url.includes('localhost:6001') || t.url.includes('localhost:5176') || t.url.includes('10.8.7.176:6001') || t.url.includes('10.8.7.176:5176'))) {
        const res = await chrome.scripting.executeScript({
          target: { tabId: t.id },
          func: () => localStorage.getItem('autoqa_token') || ''
        });
        const token = res?.[0]?.result || '';
        if (token) {
          chrome.storage.local.set({ athma_token: token });
          return token;
        }
      }
    }
  } catch(e) {}
  // Fallback to storage
  return new Promise(r => chrome.storage.local.get('athma_token', d => r(d.athma_token || '')));
}

async function startInspector(sessionId, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isNatUrl(tab.url)) {
      console.warn('[Inspector] Refused - NAT/chrome page:', tab.url);
      return false;
    }
  } catch(e) { return false; }

  inspectorSessions.set(tabId, { sessionId, startTime: Date.now() });
  saveInspectorSessions();
  console.log(`[Inspector] Started for tab ${tabId}, session ${sessionId}`);

  try {
    // Give page user activation
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => { document.body.click(); window.focus(); }
    });

    // Store session info for fallback
    const token = await getFreshToken();
    const { api } = await getServerConfig();
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: (sid, api, tok) => {
        sessionStorage.setItem('__athma_session_id__', sid);
        sessionStorage.setItem('__athma_api__', api);
        if (tok) sessionStorage.setItem('__athma_token__', tok);
      },
      args: [sessionId, api, token]
    });

    // Inject isolated world bridge FIRST, then inspector
    await chrome.scripting.executeScript({
      target: { tabId }, world: 'ISOLATED',
      func: (captureTabId) => {
        if (window.__athma_isolated_listener__) {
          window.removeEventListener('message', window.__athma_isolated_listener__);
        }
        window.__athma_isolated_listener__ = function(e) {
          if (e.source !== window) return;
          if (e.data && e.data.type === '__athma_inspector_captured__') {
            try {
              chrome.runtime.sendMessage({
                type: 'inspector_captured',
                result: e.data.result,
                tabId: captureTabId
              });
            } catch(err) {
              console.warn('[ATHMA Bridge] sendMessage failed:', err.message);
            }
          }
          if (e.data && e.data.type === '__athma_inspector_stopped__') {
            try { chrome.runtime.sendMessage({ type: 'inspector_stopped', tabId: captureTabId }); } catch(err) {}
          }
        };
        window.addEventListener('message', window.__athma_isolated_listener__);
        console.log('[ATHMA Bridge] Isolated world listener ready for tab', captureTabId);
      },
      args: [tabId]
    });

    // Then inject inspector into MAIN world
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['inspector.js'], world: 'MAIN'
    });

    console.log('[Inspector] Injected into tab', tabId);
    return true;
  } catch(e) {
    console.warn('[Inspector] Inject failed:', e.message);
    inspectorSessions.delete(tabId);
    return false;
  }
}

async function stopInspector(tabId) {
  const session = inspectorSessions.get(tabId);
  if (!session) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { if (window.__athma_stop_inspector__) window.__athma_stop_inspector__(); }
    });
  } catch(e) {}
  inspectorSessions.delete(tabId);
  saveInspectorSessions();
}

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'smart_study_events') {
    // Events from smart_study_recorder.js — store locally + relay via WebSocket
    // Check sessionId match only (not active flag — active may be false during stop)
    if (msg.sessionId && msg.sessionId === smartRec.sessionId) {
      smartRec.events.push(...(msg.events || []));
      // Relay to backend over existing WebSocket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type:      'smart_study_event',
          sessionId: msg.sessionId,
          events:    msg.events,
        }));
      } else {
        smartRec.pending.push(...(msg.events || []));
      }
    }
    // Persist to storage so events survive service worker restart
    chrome.storage.local.set({ athma_smart_events: smartRec.events, athma_smart_session: smartRec.sessionId }).catch(()=>{});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'smart_study_start') {
    (async () => {
      const result = await startSmartStudy(msg.sessionId);
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === 'smart_study_stop') {
    (async () => {
      const result = await stopSmartStudy();
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === 'smart_study_status') {
    sendResponse({ active: smartRec.active, sessionId: smartRec.sessionId, eventCount: smartRec.events.length });
    return true;
  }

  if (msg.type === 'smart_study_get_events') {
    // Return from memory first, fall back to storage if service worker restarted
    if (smartRec.events.length > 0) {
      sendResponse({ ok: true, events: smartRec.events, sessionId: smartRec.sessionId });
    } else {
      chrome.storage.local.get(['athma_smart_events','athma_smart_session'], (d) => {
        sendResponse({ ok: true, events: d.athma_smart_events || [], sessionId: d.athma_smart_session || smartRec.sessionId });
      });
    }
    return true;
  }

  if (msg.type === 'get_token') {
    (async () => {
      const token = await getFreshToken();
      sendResponse({ token });
    })();
    return true;
  }

  if (msg.type === 'start_inspector') {
    (async () => {
      const ok = await startInspector(msg.sessionId, msg.tabId);
      sendResponse({ ok });
    })();
    return true;
  }

  if (msg.type === 'stop_inspector') {
    stopInspector(msg.tabId || sender.tab?.id);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'inspector_captured') {
    (async () => {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false }); return; }

      const session = inspectorSessions.get(tabId);
      if (!session) {
        console.error(`[Inspector] No active session for tab ${tabId}`);
        sendResponse({ ok: false });
        return;
      }

      const sessionId = session.sessionId;
      console.log(`[Inspector] Captured in tab ${tabId}, session ${sessionId}`);

      const token = await getFreshToken();
      try {
        const r = await fetch(`${(await getServerConfig()).api}/api/inspector/${sessionId}/result`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ type: 'picked', ...msg.result })
        });
        console.log(`[Inspector] Result sent, status: ${r.status}`);
      } catch(e) {
        console.error('[Inspector] Failed to send result:', e.message);
      }

      inspectorSessions.delete(tabId);
      saveInspectorSessions();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'inspector_stopped') {
    const tabId = sender.tab?.id;
    if (tabId) inspectorSessions.delete(tabId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'get_status') {
    getServerConfig().then(({ api }) => {
      fetch(`${api}/api/health`, { signal: AbortSignal.timeout(2000) })
        .then(r => r.ok).catch(() => false)
        .then(natOnline => sendResponse({ natOnline, recording: rec.active, stepCount: rec.steps.length, recordingTabId: rec.tabId }));
    });
    return true;
  }

  if (msg.type === 'start_recording') {
    (async () => {
      const { api } = await getServerConfig();
      let sessionId = 'rec_' + Date.now();
      try {
        const token = await getFreshToken();
        const r = await fetch(`${api}/api/recorder/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ label: msg.label || 'Recording' }),
        });
        if (r.ok) { const d = await r.json(); sessionId = d.session_id || sessionId; }
      } catch(e) {}
      const result = await startRecording(sessionId, msg.url);
      sendResponse({ ...result, sessionId });
    })();
    return true;
  }

  if (msg.type === 'stop_recording') {
    (async () => sendResponse(await stopRecording()))();
    return true;
  }

  if (msg.type === 'recorder_step') {
    if (rec.active) {
      rec.steps.push(msg.step);
      rec.steps.sort((a, b) => (a._ts || 0) - (b._ts || 0));
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'get_steps') {
    sendResponse({ steps: rec.steps });
    return true;
  }

  if (msg.type === 'execute_test') {
    executeTest(msg.runId, msg.config);
    sendResponse({ ok: true });
    return true;
  }
});

// ── External Messages ─────────────────────────────────────────────────────────
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // Smart Study — allow ATHMA frontend to directly control recording
  if (msg.type === 'smart_study_start') {
    (async () => { sendResponse(await startSmartStudy(msg.sessionId)); })();
    return true;
  }
  if (msg.type === 'smart_study_stop') {
    (async () => { sendResponse(await stopSmartStudy()); })();
    return true;
  }
  if (msg.type === 'smart_study_get_events') {
    if (smartRec.events.length > 0) {
      sendResponse({ ok: true, events: smartRec.events, sessionId: smartRec.sessionId });
    } else {
      chrome.storage.local.get(['athma_smart_events', 'athma_smart_session'], (d) => {
        sendResponse({ ok: true, events: d.athma_smart_events || [], sessionId: d.athma_smart_session || smartRec.sessionId });
      });
    }
    return true;
  }
  if (msg.type === 'nat_clear_token') {
    chrome.storage.local.remove('athma_token');
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'nat_start_recording') {
    (async () => {
      let sessionId = 'rec_' + Date.now();
      try {
        const r = await fetch(`${ATHMA_API}/api/recorder/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Recording' }) });
        if (r.ok) { const d = await r.json(); sessionId = d.session_id || sessionId; }
      } catch(e) {}
      sendResponse({ ...(await startRecording(sessionId, msg.url)), sessionId });
    })();
    return true;
  }
  if (msg.type === 'nat_get_steps') {
    sendResponse({ steps: rec.steps, active: rec.active });
    return true;
  }
  if (msg.type === 'nat_stop_recording') {
    (async () => sendResponse(await stopRecording()))();
    return true;
  }

  // ── Smart Page Study — scan active tab ──────────────────────────────────
  if (msg.type === 'nat_scan_page') {
    (async () => {
      try {
        console.log('[ATHMA SmartStudy] nat_scan_page received');
        const ATHMA_P = ['localhost:5176','localhost:5177','localhost:6001','10.8.7.176:5176','10.8.7.176:5177','10.8.7.176:6001'];
        const allTabs = await chrome.tabs.query({});
        // Find best tab to scan — prefer active non-ATHMA tab
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        let tab = active;
        if (!tab || ATHMA_P.some(p => (tab.url||'').includes(p))) {
          tab = allTabs
            .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !ATHMA_P.some(p => t.url.includes(p)))
            .sort((a,b) => (b.lastAccessed||0) - (a.lastAccessed||0))[0];
        }
        console.log('[ATHMA SmartStudy] Scanning tab:', tab?.url, 'id:', tab?.id);
        if (!tab) { sendResponse({ ok:false, error:'No target tab found. Open the page you want to study in a separate Chrome tab first.' }); return; }
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
          sendResponse({ ok:false, error:'Cannot scan browser pages. Navigate to your ATHMA page first.' }); return;
        }
        // Run scanner as real function (CSP-compliant — no eval/new Function)
        const scanResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function() {
            if (window.__athmaScannerDone) return window.__athmaScannerResult || null;
            window.__athmaScannerDone = true;
            const result = {
              url: location.href, title: document.title,
              fields: [], buttons: [], tableColumns: [], checkboxes: [], pageType: 'form',
              scannedAt: new Date().toISOString(),
            };
            function findLabel(el) {
              if (!el) return '';
              if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
              if (el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) return l.innerText.replace('*','').trim(); }
              const fcn = el.getAttribute('formcontrolname') || el.closest('[formcontrolname]')?.getAttribute('formcontrolname');
              if (fcn) return fcn.replace(/([A-Z])/g,' $1').replace(/_/g,' ').trim();
              if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
              let node = el;
              for (let i = 0; i < 6; i++) {
                node = node.parentElement; if (!node) break;
                const l = node.querySelector('label,.label,.field-label,.form-label,.col-form-label');
                if (l && l !== el && !l.contains(el)) return l.innerText.replace('*','').trim();
              }
              return '';
            }
            function buildSel(el) {
              for (const a of ['data-testid','data-cy','data-qa','data-test'])
                if (el.getAttribute(a)) return '['+a+'="'+el.getAttribute(a)+'"]';
              if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !/^(ng-|ember|react-|\d)/.test(el.id)) return '#'+el.id;
              if (el.tagName==='NG-SELECT'||el.closest('ng-select')) {
                const ng=el.tagName==='NG-SELECT'?el:el.closest('ng-select');
                const f=ng.getAttribute('formcontrolname'); if (f) return 'ng-select[formcontrolname="'+f+'"]';
              }
              const fcn=el.getAttribute('formcontrolname'); if (fcn) return '[formcontrolname="'+fcn+'"]';
              if (el.getAttribute('aria-label')) return '[aria-label="'+el.getAttribute('aria-label')+'"]';
              if (el.name&&['INPUT','SELECT','TEXTAREA'].includes(el.tagName)) return el.tagName.toLowerCase()+'[name="'+el.name+'"]';
              if (el.getAttribute('placeholder')) return '[placeholder="'+el.getAttribute('placeholder')+'"]';
              const txt=(el.innerText||'').trim().replace(/\s+/g,' ').slice(0,50);
              if (el.tagName==='BUTTON'&&txt) return 'button:has-text("'+txt+'")';
              if (el.tagName==='A'&&el.getAttribute('href')) return 'a[href="'+el.getAttribute('href')+'"]';
              const cls=Array.from(el.classList).filter(c=>c.length>2&&!/^(ng-|d-|m-|p-|col-|row|is-|has-)/.test(c)).slice(0,2).join('.');
              return el.tagName.toLowerCase()+(cls?'.'+cls:'');
            }
            // ng-select
            document.querySelectorAll('ng-select').forEach(ng => {
              const fcn=ng.getAttribute('formcontrolname')||'';
              const label=findLabel(ng)||findLabel(ng.querySelector('input')||ng)||fcn;
              const selector=fcn?'ng-select[formcontrolname="'+fcn+'"]':buildSel(ng);
              const options=[];
              ng.querySelectorAll('.ng-option').forEach(o=>{ const t=o.innerText.trim(); if(t&&t!=='No items found'&&!options.includes(t)) options.push(t); });
              if(label||fcn) result.fields.push({ label:label||fcn, selector, action:'search_select', type:'ng-select', required:false, options:options.slice(0,30), searchable:!!ng.querySelector('input'), fcn });
            });
            // native select
            document.querySelectorAll('select').forEach(sel => {
              const options=Array.from(sel.options).map(o=>o.text.trim()).filter(Boolean);
              result.fields.push({ label:findLabel(sel)||sel.name||'Select', selector:buildSel(sel), action:'select', type:'select', required:sel.required, options:options.slice(0,30) });
            });
            // inputs
            const SKIP='[type="hidden"],[type="checkbox"],[type="radio"],[type="submit"],[type="button"],[type="file"]';
            document.querySelectorAll('input:not('+SKIP+')').forEach(inp => {
              if(inp.closest('ng-select')||inp.closest('table, athma-grid')) return;
              result.fields.push({ label:findLabel(inp)||inp.placeholder||inp.name||'Input', selector:buildSel(inp), action:'type', type:inp.type||'text', required:inp.required, placeholder:inp.getAttribute('placeholder')||'' });
            });
            // textareas
            document.querySelectorAll('textarea').forEach(ta => {
              result.fields.push({ label:findLabel(ta)||ta.name||'Remarks', selector:buildSel(ta), action:'type', type:'textarea', required:ta.required });
            });
            // checkboxes
            document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
              result.checkboxes.push({ label:findLabel(cb)||cb.name||'Checkbox', selector:buildSel(cb), action:'check', insideTable:!!cb.closest('table,athma-grid'), checked:cb.checked });
            });
            // buttons
            const BKWS=['cancel','delete','discard','close','back','remove','reset','reject','clear'];
            document.querySelectorAll('button:not([disabled])').forEach(btn => {
              const txt=(btn.innerText||btn.textContent||'').trim().replace(/\s+/g,' ').slice(0,60);
              if(!txt||txt.length<2) return;
              const rect=btn.getBoundingClientRect(); if(rect.width<2||rect.height<2) return;
              result.buttons.push({ text:txt, selector:buildSel(btn), action:'click', isBranchTrigger:BKWS.some(k=>txt.toLowerCase().includes(k)) });
            });
            // tables
            document.querySelectorAll('table,athma-grid').forEach(tbl => {
              const headers=[]; tbl.querySelectorAll('th').forEach(th=>{ const t=th.innerText.trim().replace(/\s+/g,' '); if(t) headers.push(t); });
              if(!headers.length) return;
              result.tableColumns.push({ selector:buildSel(tbl), headers, hasCheckbox:!!tbl.querySelector('input[type="checkbox"]'), hasInputs:!!tbl.querySelector('input:not([type="checkbox"])'), hasNgSelect:!!tbl.querySelector('ng-select'), rowCount:tbl.querySelectorAll('tbody tr').length });
            });
            // page type
            const bt=document.body.innerText.toLowerCase();
            if(bt.includes('indent')) result.pageType='Indent';
            else if(bt.includes('receipt')) result.pageType='Receipt';
            else if(bt.includes('dispense')) result.pageType='Dispense';
            else if(bt.includes('patient')) result.pageType='Patient';
            else if(bt.includes('purchase')) result.pageType='Purchase';
            else if(bt.includes('billing')) result.pageType='Billing';
            // dedupe
            const seen=new Set();
            result.fields=result.fields.filter(f=>{ if(seen.has(f.selector)) return false; seen.add(f.selector); return true; });
            window.__athmaScannerResult=result;
            return result;
          },
        });
        console.log('[ATHMA SmartStudy] Scan complete, result:', scanResults?.[0]?.result ? 'ok' : 'empty');
        sendResponse({ ok:true, result: scanResults?.[0]?.result || null, tabUrl: tab.url, tabTitle: tab.title });
      } catch(e) {
        console.error('[ATHMA SmartStudy] Error:', e.message);
        sendResponse({ ok:false, error: e.message });
      }
    })();
    return true;
  }
});

// ── Test Runner ───────────────────────────────────────────────────────────────
function connectToATHMA() {
  ws = new WebSocket(ATHMA_WS_URL + '?runId=ext_runner');
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register_browser_runner', browser: 'chrome', version: chrome.runtime.getManifest().version }));
    // Flush any buffered smart study events from during reconnect
    if (smartRec.pending.length && smartRec.sessionId) {
      ws.send(JSON.stringify({ type: 'smart_study_event', sessionId: smartRec.sessionId, events: smartRec.pending }));
      smartRec.pending = [];
    }
  };
  ws.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'execute_test') await executeTest(message.runId, message.config);
    if (message.type === 'smart_study_start') {
      const result = await startSmartStudy(message.sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'smart_study_started', sessionId: message.sessionId, ...result }));
      }
    }
    if (message.type === 'smart_study_stop_ext') {
      await stopSmartStudy();
    }
    // ── Smart Page Study scan via WebSocket ─────────────────────────────────
    if (message.type === 'smart_study_scan') {
      (async () => {
        try {
          const ATHMA_P = ['localhost:5176','localhost:5177','localhost:6001','10.8.7.176:5176','10.8.7.176:5177','10.8.7.176:6001'];
          const allTabs = await chrome.tabs.query({});
          const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          let tab = active;
          if (!tab || ATHMA_P.some(p => (tab.url||'').includes(p))) {
            tab = allTabs
              .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !ATHMA_P.some(p => t.url.includes(p)))
              .sort((a,b) => (b.lastAccessed||0) - (a.lastAccessed||0))[0];
          }
          if (!tab) throw new Error('No target tab found. Open the page you want to study first.');
          console.log('[SmartStudy] Scanning tab:', tab.url);
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: function() {
              if (window.__athmaScannerDone) return window.__athmaScannerResult || null;
              window.__athmaScannerDone = true;
              var r={url:location.href,title:document.title,fields:[],buttons:[],tableColumns:[],checkboxes:[],pageType:'Form'};
              function lbl(el){if(!el)return'';if(el.getAttribute('aria-label'))return el.getAttribute('aria-label').trim();if(el.id){var l=document.querySelector('label[for="'+el.id+'"]');if(l)return l.innerText.replace('*','').trim();}var f=el.getAttribute('formcontrolname');if(f)return f.replace(/([A-Z])/g,' $1').trim();if(el.getAttribute('placeholder'))return el.getAttribute('placeholder').trim();var n=el;for(var i=0;i<5;i++){n=n&&n.parentElement;if(!n)break;var ll=n.querySelector('label,.label,.field-label,.col-form-label');if(ll&&!ll.contains(el))return ll.innerText.replace('*','').trim();}return'';}
              function sel(el){for(var a of['data-testid','data-cy','data-qa','data-test'])if(el.getAttribute(a))return'['+a+'="'+el.getAttribute(a)+'"]';if(el.id&&/^[a-zA-Z][\w-]*$/.test(el.id)&&!/^ng-/.test(el.id))return'#'+el.id;if(el.tagName==='NG-SELECT'||el.closest&&el.closest('ng-select')){var ng=el.tagName==='NG-SELECT'?el:el.closest('ng-select');var ff=ng.getAttribute('formcontrolname');if(ff)return'ng-select[formcontrolname="'+ff+'"]';}var f=el.getAttribute('formcontrolname');if(f)return'[formcontrolname="'+f+'"]';if(el.getAttribute('aria-label'))return'[aria-label="'+el.getAttribute('aria-label')+'"]';if(el.name&&['INPUT','SELECT','TEXTAREA'].includes(el.tagName))return el.tagName.toLowerCase()+'[name="'+el.name+'"]';if(el.getAttribute('placeholder'))return'[placeholder="'+el.getAttribute('placeholder')+'"]';var t=(el.innerText||'').trim().slice(0,40);if(el.tagName==='BUTTON'&&t)return'button:has-text("'+t+'")';return el.tagName.toLowerCase();}
              document.querySelectorAll('ng-select').forEach(function(ng){var f=ng.getAttribute('formcontrolname')||'';var opts=[];ng.querySelectorAll('.ng-option').forEach(function(o){var t=o.innerText.trim();if(t&&t!='No items found')opts.push(t);});var label=lbl(ng)||f;if(label)r.fields.push({label:label,selector:f?'ng-select[formcontrolname="'+f+'"]':sel(ng),action:'search_select',type:'ng-select',options:opts.slice(0,20)});});
              document.querySelectorAll('select').forEach(function(el){r.fields.push({label:lbl(el)||el.name||'Select',selector:sel(el),action:'select',type:'select',options:Array.from(el.options).map(function(o){return o.text.trim();}).filter(Boolean).slice(0,20)});});
              document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file])').forEach(function(el){if(el.closest&&el.closest('ng-select'))return;r.fields.push({label:lbl(el)||el.placeholder||el.name||'Input',selector:sel(el),action:'type',type:el.type||'text'});});
              document.querySelectorAll('input[type=checkbox]').forEach(function(el){r.checkboxes.push({label:lbl(el)||'Checkbox',selector:sel(el),action:'check'});});
              var bkw=['cancel','delete','discard','close','back','remove','reset'];
              document.querySelectorAll('button:not([disabled])').forEach(function(btn){var t=(btn.innerText||'').trim().replace(/\s+/g,' ').slice(0,50);if(!t||t.length<2)return;var rc=btn.getBoundingClientRect();if(rc.width<2)return;r.buttons.push({text:t,selector:sel(btn),action:'click',isBranchTrigger:bkw.some(function(k){return t.toLowerCase().includes(k);})});});
              document.querySelectorAll('table,athma-grid').forEach(function(tbl){var h=[];tbl.querySelectorAll('th').forEach(function(th){var t=th.innerText.trim();if(t)h.push(t);});if(h.length)r.tableColumns.push({headers:h,hasInputs:!!tbl.querySelector('input:not([type=checkbox])'),hasNgSelect:!!tbl.querySelector('ng-select'),rowCount:tbl.querySelectorAll('tbody tr').length});});
              var bt=document.body.innerText.toLowerCase();if(bt.includes('indent'))r.pageType='Indent';else if(bt.includes('receipt'))r.pageType='Receipt';else if(bt.includes('dispense'))r.pageType='Dispense';else if(bt.includes('patient'))r.pageType='Patient';else if(bt.includes('purchase'))r.pageType='Purchase';else if(bt.includes('billing'))r.pageType='Billing';
              var seen=new Set();r.fields=r.fields.filter(function(f){if(seen.has(f.selector))return false;seen.add(f.selector);return true;});
              window.__athmaScannerDone=true;window.__athmaScannerResult=r;return r;
            },
          });
          // Post result back to server
          const { api } = await getServerConfig();
          const token = await getFreshToken();
          await fetch(`${api}/api/smart-study/scan-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ scanId: message.scanId, result: res?.result || null }),
          });
        } catch(e) {
          console.error('[SmartStudy] Scan error:', e.message);
          const { api } = await getServerConfig();
          const token = await getFreshToken();
          fetch(`${api}/api/smart-study/scan-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ scanId: message.scanId, error: e.message }),
          }).catch(()=>{});
        }
      })();
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => setTimeout(connectToATHMA, 3000);
}

async function executeTest(runId, config) {
  try {
    const tab = await chrome.tabs.create({ url: config.base_url || 'about:blank', active: true });
    await waitForTabLoad(tab.id);
    sendToBackend({ type: 'test_started', runId, timestamp: new Date().toISOString() });
    for (let i = 0; i < config.steps.length; i++) {
      try {
        await executeStep(tab.id, config.steps[i], config.variables || {});
        sendToBackend({ type: 'step_completed', runId, stepIndex: i, status: 'passed', timestamp: new Date().toISOString() });
      } catch(error) {
        sendToBackend({ type: 'step_completed', runId, stepIndex: i, status: 'failed', error: error.message, timestamp: new Date().toISOString() });
        break;
      }
    }
    sendToBackend({ type: 'test_completed', runId, timestamp: new Date().toISOString() });
  } catch(error) {
    sendToBackend({ type: 'test_failed', runId, error: error.message });
  }
}

async function executeStep(tabId, step, variables) {
  const sel = replaceVariables(step.selector, variables);
  const val = replaceVariables(step.value, variables);
  switch (step.action) {
    case 'navigate':
      await chrome.tabs.update(tabId, { url: val });
      await waitForTabLoad(tabId);
      break;
    case 'click':
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (s) => { const e = document.querySelector(s); if (!e) throw new Error('Not found: ' + s); e.click(); },
        args: [sel],
      });
      break;
    case 'type':
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (s, v) => {
          const e = document.querySelector(s); if (!e) throw new Error('Not found: ' + s);
          e.value = v;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [sel, val],
      });
      break;
    case 'wait': await sleep(parseInt(val) || 1000); break;
  }
  await sleep(300);
}

function replaceVariables(text, vars) {
  if (!text) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (_, n) => vars[n] || _);
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const fn = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(fn); resolve(); } };
    chrome.tabs.onUpdated.addListener(fn);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); resolve(); }, 30000);
  });
}

function sendToBackend(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

try { connectToATHMA(); } catch(e) {}
console.log('[ATHMA] Extension loaded');

// ── Smart Page Study — poll server for scan requests ─────────────────────────────────
// Polls /api/smart-study/poll every 1s, runs scanner, posts result back
async function smartStudyPoll() {
  try {
    const { api } = await getServerConfig();
    const token = await getFreshToken();
    const r = await fetch(`${api}/api/smart-study/poll`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!r.ok) {
      // 404 = endpoint not available, poll less frequently
      setTimeout(smartStudyPoll, r.status === 404 ? 30000 : 2000); return;
    }
    const data = await r.json();
    if (!data.pending) { setTimeout(smartStudyPoll, 1000); return; }

    console.log('[SmartStudy] 🔍 Scan request received, scanId:', data.scanId);
    const ATHMA_P = ['localhost:5176','localhost:5177','localhost:6001','10.8.7.176:5176','10.8.7.176:5177','10.8.7.176:6001'];
    const allTabs = await chrome.tabs.query({});
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    let tab = active;
    if (!tab || ATHMA_P.some(p => (tab.url||'').includes(p))) {
      tab = allTabs
        .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://') && !ATHMA_P.some(p => t.url.includes(p)))
        .sort((a,b) => (b.lastAccessed||0) - (a.lastAccessed||0))[0];
    }

    let scanResult = null, scanError = null;
    if (!tab) {
      scanError = 'No target tab found. Open the page you want to study in a separate tab first.';
      console.warn('[SmartStudy] ❌ No target tab found. All tabs:', allTabs.map(t=>t.url).join(' | '));
    } else {
      console.log('[SmartStudy] 🎯 Target tab:', tab.url, 'id:', tab.id);
      try {
        console.log('[SmartStudy] Scanning:', tab.url);
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: function() {
            window.__athmaScannerDone = false; // always rescan
            var r={url:location.href,title:document.title,fields:[],buttons:[],tableColumns:[],checkboxes:[],pageType:'Form'};
            function lbl(el){if(!el)return'';if(el.getAttribute('aria-label'))return el.getAttribute('aria-label').trim();if(el.id){var l=document.querySelector('label[for="'+el.id+'"]');if(l)return l.innerText.replace('*','').trim();}var f=el.getAttribute('formcontrolname');if(f)return f.replace(/([A-Z])/g,' $1').trim();if(el.getAttribute('placeholder'))return el.getAttribute('placeholder').trim();var n=el;for(var i=0;i<5;i++){n=n&&n.parentElement;if(!n)break;var ll=n.querySelector('label,.label,.field-label,.col-form-label');if(ll&&!ll.contains(el))return ll.innerText.replace('*','').trim();}return'';}
            function sel(el){for(var a of['data-testid','data-cy','data-qa','data-test'])if(el.getAttribute(a))return'['+a+'="'+el.getAttribute(a)+'"]';if(el.id&&/^[a-zA-Z][\w-]*$/.test(el.id)&&!/^ng-/.test(el.id))return'#'+el.id;if(el.tagName==='NG-SELECT'||el.closest&&el.closest('ng-select')){var ng=el.tagName==='NG-SELECT'?el:el.closest('ng-select');var ff=ng.getAttribute('formcontrolname');if(ff)return'ng-select[formcontrolname="'+ff+'"]';}var f=el.getAttribute('formcontrolname');if(f)return'[formcontrolname="'+f+'"]';if(el.getAttribute('aria-label'))return'[aria-label="'+el.getAttribute('aria-label')+'"]';if(el.name&&['INPUT','SELECT','TEXTAREA'].includes(el.tagName))return el.tagName.toLowerCase()+'[name="'+el.name+'"]';if(el.getAttribute('placeholder'))return'[placeholder="'+el.getAttribute('placeholder')+'"]';var t=(el.innerText||'').trim().slice(0,40);if(el.tagName==='BUTTON'&&t)return'button:has-text("'+t+'")';return el.tagName.toLowerCase();}
            document.querySelectorAll('ng-select').forEach(function(ng){var f=ng.getAttribute('formcontrolname')||'';var opts=[];ng.querySelectorAll('.ng-option').forEach(function(o){var t=o.innerText.trim();if(t&&t!='No items found')opts.push(t);});var label=lbl(ng)||f;if(label)r.fields.push({label:label,selector:f?'ng-select[formcontrolname="'+f+'"]':sel(ng),action:'search_select',type:'ng-select',options:opts.slice(0,20)});});
            document.querySelectorAll('select').forEach(function(el){r.fields.push({label:lbl(el)||el.name||'Select',selector:sel(el),action:'select',type:'select',options:Array.from(el.options).map(function(o){return o.text.trim();}).filter(Boolean).slice(0,20)});});
            document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=file])').forEach(function(el){if(el.closest&&el.closest('ng-select'))return;r.fields.push({label:lbl(el)||el.placeholder||el.name||'Input',selector:sel(el),action:'type',type:el.type||'text'});});
            document.querySelectorAll('input[type=checkbox]').forEach(function(el){r.checkboxes.push({label:lbl(el)||'Checkbox',selector:sel(el),action:'check'});});
            var bkw=['cancel','delete','discard','close','back','remove','reset'];
            document.querySelectorAll('button:not([disabled])').forEach(function(btn){var t=(btn.innerText||'').trim().replace(/\s+/g,' ').slice(0,50);if(!t||t.length<2)return;var rc=btn.getBoundingClientRect();if(rc.width<2)return;r.buttons.push({text:t,selector:sel(btn),action:'click',isBranchTrigger:bkw.some(function(k){return t.toLowerCase().includes(k);})});});
            document.querySelectorAll('table,athma-grid').forEach(function(tbl){var h=[];tbl.querySelectorAll('th').forEach(function(th){var t=th.innerText.trim();if(t)h.push(t);});if(h.length)r.tableColumns.push({headers:h,hasInputs:!!tbl.querySelector('input:not([type=checkbox])'),hasNgSelect:!!tbl.querySelector('ng-select'),rowCount:tbl.querySelectorAll('tbody tr').length});});
            var bt=document.body.innerText.toLowerCase();if(bt.includes('indent'))r.pageType='Indent';else if(bt.includes('receipt'))r.pageType='Receipt';else if(bt.includes('dispense'))r.pageType='Dispense';else if(bt.includes('patient'))r.pageType='Patient';else if(bt.includes('purchase'))r.pageType='Purchase';else if(bt.includes('billing'))r.pageType='Billing';
            var seen=new Set();r.fields=r.fields.filter(function(f){if(seen.has(f.selector))return false;seen.add(f.selector);return true;});
            return r;
          },
        });
        scanResult = res?.result || null;
        console.log('[SmartStudy] ✅ Scan complete. Fields:', scanResult?.fields?.length, 'Buttons:', scanResult?.buttons?.length, 'URL:', scanResult?.url);
      } catch(e) {
        scanError = e.message;
        console.error('[SmartStudy] Scan error:', e.message);
      }
    }

    // Post result back
    console.log('[SmartStudy] 📤 Posting result back to server...');
    const postResp = await fetch(`${api}/api/smart-study/scan-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ scanId: data.scanId, result: scanResult, error: scanError }),
    });
    console.log('[SmartStudy] 📨 Server responded:', postResp.status);
  } catch(e) {
    console.warn('[SmartStudy] Poll error:', e.message);
  }
  setTimeout(smartStudyPoll, 1000);
}
smartStudyPoll();

// ── MV3 keepalive: use chrome.alarms (correct MV3 pattern) ──────────────────────────
chrome.alarms.create('smartStudyKeepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'smartStudyKeepalive') {
    // Just wake the service worker — smartStudyPoll handles the actual work
    console.log('[ATHMA] keepalive tick');
  }
});
