// ATHMA Recorder Popup

// Fallback defaults
const FALLBACK_API = 'http://10.8.7.176:6001';
const FALLBACK_NAT = 'http://10.8.7.176:6001';

let DEFAULT_API = FALLBACK_API;
let DEFAULT_NAT = FALLBACK_NAT;

// Fetch config from backend
(async function() {
  try {
    const r = await fetch(`${FALLBACK_API}/api/extension/config`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const cfg = await r.json();
      DEFAULT_API = cfg.api || FALLBACK_API;
      DEFAULT_NAT = cfg.nat || FALLBACK_NAT;
      console.log('[ATHMA Popup] Config loaded:', { api: DEFAULT_API, nat: DEFAULT_NAT });
    }
  } catch(e) {
    console.warn('[ATHMA Popup] Using fallback config:', e.message);
  }
})();

function getServerConfig(cb) {
  chrome.storage.local.get(['athma_server_api', 'athma_server_nat'], (d) => {
    cb({
      api: (d.athma_server_api || DEFAULT_API).replace(/\/$/, ''),
      nat: (d.athma_server_nat || DEFAULT_NAT).replace(/\/$/, ''),
    });
  });
}

const NAT_URLS = ['http://localhost:5176','http://localhost:5177','http://localhost:6001','http://10.8.7.176:5176','http://10.8.7.176:5177','http://10.8.7.176:6001'];

const screenUrl=document.getElementById('screen-url'),screenRec=document.getElementById('screen-rec'),screenDone=document.getElementById('screen-done'),screenSettings=document.getElementById('screen-settings');
const urlInput=document.getElementById('urlInput'),goBtn=document.getElementById('goBtn'),currentPageCard=document.getElementById('currentPageCard'),currentPageUrl=document.getElementById('currentPageUrl');
const startHereBtn=document.getElementById('startHereBtn'),orDivider=document.getElementById('orDivider'),recUrlEl=document.getElementById('recUrl'),stepNumEl=document.getElementById('stepNum');
const stepsListEl=document.getElementById('stepsList'),stopBtn=document.getElementById('stopBtn'),goNatBtn=document.getElementById('goNatBtn'),recordMoreBtn=document.getElementById('recordMoreBtn');
const resetBtn=document.getElementById('resetBtn'),doneTxt=document.getElementById('doneTxt'),doneSub=document.getElementById('doneSub'),connDot=document.getElementById('connDot'),connText=document.getElementById('connText');
const settingsBtn=document.getElementById('settingsBtn'),saveSettingsBtn=document.getElementById('saveSettingsBtn'),cancelSettingsBtn=document.getElementById('cancelSettingsBtn');
const settingsApiInput=document.getElementById('settingsApiInput'),settingsNatInput=document.getElementById('settingsNatInput'),settingsStatus=document.getElementById('settingsStatus');

let pollTimer=null,allSteps=[],currentTab=null;

function saveSteps(){chrome.storage.local.set({athma_accumulated_steps:allSteps});}
function loadSteps(cb){chrome.storage.local.get('athma_accumulated_steps',(d)=>{allSteps=d.athma_accumulated_steps||[];cb();});}
function clearSavedSteps(){allSteps=[];chrome.storage.local.remove('athma_accumulated_steps');}

loadSteps(()=>{checkStatus();});
if(urlInput)urlInput.addEventListener('keydown',e=>{if(e.key==='Enter')goBtn&&goBtn.click();});

chrome.tabs.query({active:true,currentWindow:true},(tabs)=>{
  currentTab=tabs[0]||null;
  if(!currentTab?.url)return;
  const url=currentTab.url;
  getServerConfig(({nat})=>{
    const allNatUrls=[...new Set([...NAT_URLS,nat])];
    const isValid=!url.startsWith('chrome://')&&!url.startsWith('chrome-extension://')&&!url.startsWith('about:')&&!url.startsWith('edge://')&&!allNatUrls.some(u=>url.startsWith(u));
    if(isValid){currentPageUrl.textContent=url;currentPageCard.style.display='flex';orDivider.style.display='flex';urlInput.value=url;}
  });
});

function checkStatus(){
  chrome.runtime.sendMessage({type:'get_status'},(resp)=>{
    if(chrome.runtime.lastError||!resp){if(connDot)connDot.className='dot red';if(connText)connText.textContent='Extension error';return;}
    if(connDot)connDot.className='dot '+(resp.natOnline?'green':'red');
    if(connText)connText.textContent=resp.natOnline?'Connected to ATHMA NAT':'NAT offline';
    if(resp.recording){showScreen('rec');if(stepNumEl)stepNumEl.textContent=(allSteps.length||0)+(resp.stepCount||0);startPoll();}
  });
}

function showScreen(name){
  if(screenUrl)screenUrl.style.display=name==='url'?'flex':'none';
  if(screenRec)screenRec.style.display=name==='rec'?'flex':'none';
  if(screenDone)screenDone.style.display=name==='done'?'flex':'none';
  if(screenSettings)screenSettings.style.display=name==='settings'?'flex':'none';
}

function updateAccHint(){
  let hint=document.getElementById('accHint');
  if(allSteps.length===0){if(hint)hint.style.display='none';return;}
  if(!hint){hint=document.createElement('div');hint.id='accHint';hint.style.cssText='background:#0f2a1a;border:1px solid #166534;border-radius:7px;padding:8px 12px;font-size:11px;color:#4ade80;text-align:center;margin-top:4px';screenUrl.appendChild(hint);}
  hint.style.display='block';
  hint.textContent='\u2713 '+allSteps.length+' step'+(allSteps.length!==1?'s':'')+' accumulated \u2014 recording more will append';
}

function showError(msg){
  let el=document.getElementById('authError');
  if(!el){el=document.createElement('div');el.id='authError';el.style.cssText='background:#1a0f0f;border:1px solid #ef4444;border-radius:8px;padding:10px 12px;font-size:11px;color:#f87171;line-height:1.7;margin-bottom:4px';screenUrl.insertBefore(el,screenUrl.firstChild);}
  const isAuthErr=/log.?in|session|not logged|authori/i.test(msg);
  const isServerErr=/reach|running|check Settings/i.test(msg);
  el.innerHTML='\u26a0\ufe0f '+msg+(isAuthErr?'<br><a href="'+DEFAULT_NAT+'" target="_blank" style="color:#60a5fa;text-decoration:underline">Open ATHMA NAT to log in \u2192</a>':'')+(isServerErr?'<br><span style="color:#94a3b8;font-size:10px">Tip: Click \u2699\ufe0f to set the server URL</span>':'');
  el.style.display='block';
}
function clearError(){const el=document.getElementById('authError');if(el)el.style.display='none';}

function handleStartResponse(resp,btnEl,origText){
  if(btnEl){btnEl.disabled=false;btnEl.textContent=origText;}
  if(chrome.runtime.lastError||!resp?.ok){showError(resp?.error||chrome.runtime.lastError?.message||'Unknown error');return;}
  clearError();showScreen('rec');
  if(stepNumEl)stepNumEl.textContent=allSteps.length>0?allSteps.length+'+':'0';
  if(stepsListEl)stepsListEl.innerHTML='';
  startPoll();
}

if(startHereBtn)startHereBtn.addEventListener('click',()=>{
  if(!currentTab)return;
  startHereBtn.disabled=true;startHereBtn.textContent='Starting...';
  if(recUrlEl)recUrlEl.textContent=currentTab.url;
  chrome.runtime.sendMessage({type:'start_recording',url:null,label:'Recording'},resp=>handleStartResponse(resp,startHereBtn,'\u23fa Start Recording Here'));
});

if(goBtn)goBtn.addEventListener('click',()=>{
  const raw=urlInput.value.trim();if(!raw){urlInput.focus();return;}
  const url=raw.startsWith('http')?raw:'https://'+raw;
  goBtn.disabled=true;goBtn.textContent='Opening...';
  if(recUrlEl)recUrlEl.textContent=url;
  chrome.runtime.sendMessage({type:'start_recording',url,label:'Recording'},resp=>handleStartResponse(resp,goBtn,'\u25b6 Go & Start Recording'));
});

if(stopBtn)stopBtn.addEventListener('click',()=>{
  clearInterval(pollTimer);pollTimer=null;stopBtn.disabled=true;stopBtn.textContent='Stopping...';
  chrome.runtime.sendMessage({type:'stop_recording'},(resp)=>{
    stopBtn.disabled=false;stopBtn.textContent='\u23f9 Stop';
    allSteps=[...allSteps,...(resp?.steps||[])];saveSteps();showDone();
  });
});

function showDone(){
  if(doneTxt)doneTxt.textContent='Recording Complete';
  if(doneSub)doneSub.textContent=allSteps.length+' step'+(allSteps.length!==1?'s':'')+' total captured';
  showScreen('done');
}

if(recordMoreBtn)recordMoreBtn.addEventListener('click',()=>{showScreen('url');updateAccHint();});

if(goNatBtn)goNatBtn.addEventListener('click',()=>{
  if(!allSteps.length){alert('No steps recorded.');return;}
  let encoded;try{encoded=btoa(unescape(encodeURIComponent(JSON.stringify(allSteps))));}catch(e){alert('Failed to encode steps: '+e.message);return;}
  getServerConfig(({nat})=>{
    const allNatUrls=[...new Set([...NAT_URLS,nat])];
    const hash='recorder?steps='+encoded;
    chrome.tabs.query({},(tabs)=>{
      const natTab=tabs.find(t=>t.url&&allNatUrls.some(u=>t.url.startsWith(u)));
      if(natTab){
        chrome.scripting.executeScript({target:{tabId:natTab.id},func:(h)=>{window.location.hash=h;},args:[hash]},()=>{
          if(chrome.runtime.lastError){chrome.tabs.update(natTab.id,{url:nat+'#'+hash,active:true},()=>{chrome.windows.update(natTab.windowId,{focused:true});});}
          else{chrome.tabs.update(natTab.id,{active:true});chrome.windows.update(natTab.windowId,{focused:true});}
        });
      }else{chrome.tabs.create({url:nat+'#'+hash});}
      clearSavedSteps();showScreen('url');
      const hint=document.getElementById('accHint');if(hint)hint.style.display='none';
    });
  });
});

if(resetBtn)resetBtn.addEventListener('click',()=>{
  if(allSteps.length&&!confirm('Discard '+allSteps.length+' steps?'))return;
  clearSavedSteps();clearInterval(pollTimer);pollTimer=null;showScreen('url');urlInput.value='';
  const hint=document.getElementById('accHint');if(hint)hint.style.display='none';
});

if(settingsBtn){
  settingsBtn.addEventListener('click',()=>{
    getServerConfig(({api,nat})=>{if(settingsApiInput)settingsApiInput.value=api;if(settingsNatInput)settingsNatInput.value=nat;});
    if(settingsStatus)settingsStatus.textContent='';showScreen('settings');
  });
}
if(cancelSettingsBtn)cancelSettingsBtn.addEventListener('click',()=>showScreen('url'));
if(saveSettingsBtn){
  saveSettingsBtn.addEventListener('click',()=>{
    const api=(settingsApiInput.value.trim()||DEFAULT_API).replace(/\/$/,'');
    const nat=(settingsNatInput.value.trim()||DEFAULT_NAT).replace(/\/$/,'');
    saveSettingsBtn.disabled=true;saveSettingsBtn.textContent='Testing...';
    if(settingsStatus){settingsStatus.style.color='#94a3b8';settingsStatus.textContent='Connecting to '+api+'...';}
    fetch(api+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>r.ok).catch(()=>false).then(ok=>{
      saveSettingsBtn.disabled=false;saveSettingsBtn.textContent='\u2713 Save & Test Connection';
      if(ok){chrome.storage.local.set({athma_server_api:api,athma_server_nat:nat},()=>{if(settingsStatus){settingsStatus.style.color='#4ade80';settingsStatus.textContent='\u2705 Connected! Settings saved.';}setTimeout(()=>{checkStatus();showScreen('url');},1200);});}
      else{if(settingsStatus){settingsStatus.style.color='#f87171';settingsStatus.textContent='\u274c Cannot reach '+api;}}
    });
  });
}

// Inspector
const inspectorBtn=document.getElementById('inspectorBtn');
const inspectorStatus=document.getElementById('inspectorStatus');
const stopInspectorBtn=document.getElementById('stopInspectorBtn');

if(inspectorBtn){
  inspectorBtn.addEventListener('click',async()=>{
    chrome.tabs.query({active:true,currentWindow:true},async(tabs)=>{
      const tab=tabs[0];
      if(!tab||tab.url.startsWith('chrome://')||tab.url.startsWith('chrome-extension://')){
        alert('Please go to your app tab first, then open this popup and click Activate Inspector.');return;
      }
      // Get fresh token via background
      const {token} = await new Promise(r=>chrome.runtime.sendMessage({type:'get_token'},r));
      if(!token){
        alert('Not logged in. Please log into ATHMA at localhost:6001 first.');
        return;
      }
      // Poll for session created by the ATHMA frontend (via launchInspector)
      let sessionId=null;
      const { api: inspApi } = await new Promise(r => getServerConfig(r));
      for(let attempt=0; attempt<20; attempt++) {
        try{
          const r=await fetch(`${inspApi}/api/inspector/pending`,{headers:{Authorization:`Bearer ${token}`}});
          if(r.ok){const d=await r.json();sessionId=d.sessionId;if(sessionId)break;}
        }catch(e){}
        await new Promise(r=>setTimeout(r,500));
      }
      if(!sessionId){        
        // No pending session — create one directly
        try{
          const r=await fetch(`${inspApi}/api/inspector/start`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({})});
          if(r.ok){const d=await r.json();sessionId=d.sessionId||d.session_id;}
          else{const t=await r.text();alert('Server error '+r.status+': '+t.slice(0,100));return;}
        }catch(e){alert('Cannot reach server: '+e.message);return;}
      }
      if(!sessionId){alert('Could not create session.');return;}
      console.log('[ATHMA Popup] Inspector sessionId:', sessionId);
      // Tell the ATHMA frontend tab about this session so it subscribes via WebSocket
      chrome.tabs.query({}, async (allTabs) => {
        const { api: athmaApi, nat: athmaNat } = await new Promise(r => getServerConfig(r));
        const athmaTabs = allTabs.filter(t => t.url && (
          t.url.includes('localhost:6001') || t.url.includes('localhost:5176') ||
          t.url.includes(athmaApi.replace('http://','').replace('https://','')) ||
          t.url.includes(athmaNat.replace('http://','').replace('https://',''))
        ));
        for (const athmaTab of athmaTabs) {
          chrome.scripting.executeScript({
            target: { tabId: athmaTab.id },
            func: (sid) => {
              // Dispatch event so ATHMA frontend can subscribe to this session
              window.dispatchEvent(new CustomEvent('athma_inspector_session', { detail: { sessionId: sid } }));
              // Also store it so the frontend can pick it up
              window.__athma_pending_inspector_session__ = sid;
              console.log('[ATHMA] Inspector session announced:', sid);
            },
            args: [sessionId]
          }).catch(() => {});
        }
      });
      chrome.runtime.sendMessage({type:'start_inspector',sessionId,tabId:tab.id},(resp)=>{
        if(resp&&resp.ok){
          inspectorBtn.textContent='\u2713 Activated!';
          inspectorBtn.style.background='#22c55e';
          chrome.tabs.update(tab.id,{active:true},()=>{
            chrome.windows.update(tab.windowId,{focused:true},()=>{
              setTimeout(()=>window.close(),300);
            });
          });
        } else {
          alert('Inspector inject failed.');
        }
      });
    });
  });
}

if(stopInspectorBtn){
  stopInspectorBtn.addEventListener('click',()=>{
    chrome.runtime.sendMessage({type:'stop_inspector'});
    if(inspectorBtn){inspectorBtn.style.display='block';inspectorBtn.textContent='\ud83c\udfaf Activate Inspector on Current Tab';inspectorBtn.style.background='';}
    if(inspectorStatus)inspectorStatus.style.display='none';
  });
}

function startPoll(){
  if(pollTimer)return;
  pollTimer=setInterval(()=>{
    chrome.runtime.sendMessage({type:'get_steps'},(resp)=>{
      if(chrome.runtime.lastError||!resp)return;
      if(stepNumEl)stepNumEl.textContent=allSteps.length+(resp.steps||[]).length;
      renderSteps((resp.steps||[]).slice(-15));
    });
  },600);
}

function renderSteps(steps){
  if(!stepsListEl)return;
  stepsListEl.innerHTML='';
  if(allSteps.length>0&&steps.length>0){
    const prevEl=document.createElement('div');prevEl.style.cssText='padding:3px 8px;font-size:9px;color:#475569;font-style:italic';
    prevEl.textContent='+ '+allSteps.length+' previous step'+(allSteps.length!==1?'s':'')+' accumulated';stepsListEl.appendChild(prevEl);
  }
  steps.forEach(step=>{
    const div=document.createElement('div');div.className='step-item';
    const badge=document.createElement('span');badge.className='step-badge';badge.textContent=step.action;
    const label=document.createElement('span');label.className='step-label';label.textContent=(step.label||step.selector||step.value||'').slice(0,45);
    div.appendChild(badge);div.appendChild(label);stepsListEl.appendChild(div);
  });
  stepsListEl.scrollTop=stepsListEl.scrollHeight;
}
