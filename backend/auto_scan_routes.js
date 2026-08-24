/**
 * AUTO-SCAN ROUTES — Qavya Autonomous Scanner
 * UPDATED: With screen selection feature
 *
 * Completely isolated. Mount with ONE line in server.js:
 *   app.use('/api/auto-scan', require('./auto_scan_routes'));
 */

const express = require('express');
const https   = require('https');
const http    = require('http');
const router  = express.Router();

const scans = new Map();
function newId() { return 'scan_' + Date.now() + '_' + Math.random().toString(36).slice(2,6); }

// ── Claude helper ─────────────────────────────────────────────────────────────
function callClaude(messages, system, maxTokens=1500) {
  return new Promise((resolve, reject) => {
    const key = process.env.ANTHROPIC_API_KEY || '';
    if (!key) return reject(new Error('ANTHROPIC_API_KEY not set'));
    const body = JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:maxTokens, system, messages });
    const req = https.request({
      hostname:'api.anthropic.com', path:'/v1/messages', method:'POST',
      headers:{ 'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),
                'x-api-key':key,'anthropic-version':'2023-06-01' }
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const p=JSON.parse(d);
          res.statusCode!==200
            ? reject(new Error(p.error?.message||`Claude ${res.statusCode}`))
            : resolve(p.content?.[0]?.text||'');
        } catch(e) { reject(new Error('Invalid Claude response')); }
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

function parseJson(raw) {
  // Remove markdown code blocks
  let text = raw.replace(/```json|```/g,'').trim();
  
  // Try to find JSON object if there's extra text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    text = jsonMatch[0];
  }
  
  try {
    return JSON.parse(text);
  } catch (e) {
    // Enhance error with position context
    console.error(`[parseJson] Parse failed: ${e.message}`);
    console.error(`[parseJson] Text length: ${text.length}`);
    
    // Show context around error position
    const match = e.message.match(/position (\d+)/);
    if (match) {
      const pos = parseInt(match[1]);
      const start = Math.max(0, pos - 200);
      const end = Math.min(text.length, pos + 200);
      console.error(`[parseJson] Context around position ${pos}: ...${text.substring(start, end)}...`);
    }
    
    // Check bracket/quote balance
    const braces = (text.match(/\{/g) || []).length;
    const closeBraces = (text.match(/\}/g) || []).length;
    const brackets = (text.match(/\[/g) || []).length;
    const closeBrackets = (text.match(/\]/g) || []).length;
    console.error(`[parseJson] Bracket count: { ${braces} vs } ${closeBraces}, [ ${brackets} vs ] ${closeBrackets}`);
    
    // HEALING: If we have more opening brackets than closing, try to close them
    const bracesDiff = braces - closeBraces;
    const bracketsDiff = brackets - closeBrackets;
    
    if (bracesDiff > 0 || bracketsDiff > 0) {
      console.error(`[parseJson] Attempting to heal JSON: closing ${bracesDiff} braces and ${bracketsDiff} brackets`);
      let healed = text;
      
      // Close open brackets in reverse order (brackets before braces)
      for (let i = 0; i < bracketsDiff; i++) healed += ']';
      for (let i = 0; i < bracesDiff; i++) healed += '}';
      
      try {
        const result = JSON.parse(healed);
        console.error(`[parseJson] ✓ Healing succeeded! Parsed healed JSON.`);
        return result;
      } catch (healErr) {
        console.error(`[parseJson] Healing failed: ${healErr.message}`);
        throw e;  // Throw original error
      }
    }
    
    throw e;
  }
}

// ── JIRA poster ───────────────────────────────────────────────────────────────
function postToJira({jiraUrl,jiraEmail,jiraToken,projectKey,summary,description,priority}) {
  return new Promise((resolve,reject) => {
    const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
    const body = JSON.stringify({
      fields:{
        project:{key:projectKey}, summary,
        description:{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:description}]}]},
        issuetype:{name:'Bug'}, priority:{name:priority||'Medium'}
      }
    });
    const u = new URL(`${jiraUrl}/rest/api/3/issue`);
    const lib = u.protocol==='https:'?https:http;
    const req = lib.request({
      hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),path:u.pathname,method:'POST',
      headers:{'Authorization':`Basic ${auth}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try { const p=JSON.parse(d); res.statusCode<300?resolve(p):reject(new Error(JSON.stringify(p.errors||p))); }
        catch(e){ reject(new Error('Invalid JIRA response')); }
      });
    });
    req.on('error',reject); req.write(body); req.end();
  });
}

const SEV_MAP = {critical:'Highest',high:'High',medium:'Medium',low:'Low'};

// ── DB CROSS-CHECK HELPERS ────────────────────────────────────────────────
function makePgPool(dbConfig) {
  const { Pool } = require('pg');
  return new Pool({
    host:     dbConfig.host,
    port:     dbConfig.port || 5432,
    database: dbConfig.database,
    user:     dbConfig.user,
    password: dbConfig.password,
    ssl:      dbConfig.ssl ? { rejectUnauthorized:false } : undefined,
    max: 3,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 5000,
  });
}

function isReadOnlySql(sql) {
  const s = String(sql||'').trim().replace(/;+\s*$/,'');
  if (/;/.test(s)) return false;
  if (!/^select\b/i.test(s) && !/^with\b/i.test(s)) return false;
  if (/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy)\b/i.test(s)) return false;
  return true;
}

async function runDbCount(pool, sql) {
  if (!isReadOnlySql(sql)) throw new Error('Only read-only SELECT queries are allowed');
  const r = await pool.query(sql);
  const row = r.rows && r.rows[0];
  if (!row) return 0;
  const firstVal = Object.values(row)[0];
  const n = Number(firstVal);
  return Number.isFinite(n) ? n : null;
}

function matchDbCheck(dbChecks, pageUrl) {
  if (!Array.isArray(dbChecks)) return null;
  return dbChecks.find(c => c.urlMatch && pageUrl.includes(c.urlMatch)) || null;
}
// React-aware fill: sets the value via the native setter and fires input/change
// so React/Next.js controlled inputs actually register the text. Falls back to
// Playwright .fill() then .type() (keystroke simulation).
async function reactFill(page, locator, value, log) {
  try {
    const handle = await locator.elementHandle({timeout:4000});
    if (handle) {
      await handle.evaluate((el, val) => {
        const proto = el.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
      const got = await locator.inputValue().catch(()=> '');
      if (got === value) return true;
    }
  } catch(_) {}
  try { await locator.fill(value, {timeout:4000}); const g = await locator.inputValue().catch(()=> ''); if (g===value) return true; } catch(_) {}
  try { await locator.click({timeout:3000}); await locator.fill('', {timeout:2000}).catch(()=>{}); await locator.type(value, {delay:25, timeout:5000}); const g = await locator.inputValue().catch(()=> ''); if (g===value) return true; } catch(_) {}
  return false;
}

async function smartCreateFill(page, scenario, tag, log) {
  let opened = false;
  const triggerStep = (scenario.steps||[]).find(s =>
    s.action==='click' && /new|create|add/i.test((s.description||'')+(s.value||''))
  );
  const tryClick = async (locator) => {
    try { await locator.first().click({timeout:5000}); return true; } catch(_) { return false; }
  };
  if (triggerStep && triggerStep.selector) {
    opened = await tryClick(page.locator(triggerStep.selector));
  }
  if (!opened) {
    for (const re of ['New','Create','Add']) {
      const loc = page.getByRole('button', {name:new RegExp(re,'i')});
      if (await loc.count() && await tryClick(loc)) { opened = true; break; }
      const link = page.getByRole('link', {name:new RegExp(re,'i')});
      if (await link.count() && await tryClick(link)) { opened = true; break; }
    }
  }
  if (!opened) return {ok:false, detail:'Could not find/click a New/Create/Add control'};

  try { await page.waitForSelector('form input:not([type=hidden]), form textarea, [role=dialog] input, .input', {timeout:8000}); }
  catch(_) { await page.waitForTimeout(1500); }
  await page.waitForTimeout(800);

  const nameRe = /name|title|label|subject/i;
  const valueFor = (f) => {
    if (f.type==='email') return 'qavya_test@example.com';
    if (f.type==='number') return '1';
    if (f.type==='date') return '';
    if (f.type==='tel')  return '9999999999';
    if (f.type==='url')  return 'https://example.com';
    return 'QAVYA Test';
  };
  const filledLog = [];
  let filledName = false;
  let dumpStep = 0;

  // DIAGNOSTIC: dump the real DOM of the current wizard step to the log so we can
  // see exact element attributes (tag, type, id, name, class, label, placeholder,
  // select options, button text) and write precise selectors. Logged once per step.
  const dumpStepDom = async () => {
    dumpStep++;
    try {
      const info = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
        const fields = Array.from(document.querySelectorAll('input,textarea,select')).filter(vis).map(el => {
          const o = { tag: el.tagName.toLowerCase(), type: (el.type||''), id: el.id||'', name: el.getAttribute('name')||'',
            cls: (el.className||'').toString().slice(0,80), placeholder: el.getAttribute('placeholder')||'',
            aria: el.getAttribute('aria-label')||'', required: el.required||el.getAttribute('aria-required')==='true' };
          let lbl = '';
          if (el.labels && el.labels[0]) lbl = el.labels[0].textContent||'';
          if (!lbl) { let p=el.parentElement,h=0; while(p&&h<3&&!lbl){const l=p.querySelector('label'); if(l&&l.textContent)lbl=l.textContent; p=p.parentElement;h++;} }
          o.label = (lbl||'').replace(/\s+/g,' ').trim().slice(0,50);
          if (o.tag==='select') o.options = Array.from(el.querySelectorAll('option')).map(op=>((op.textContent||'').trim()+'['+op.value+']')).slice(0,12);
          return o;
        });
        const buttons = Array.from(document.querySelectorAll('button,[role=button],a[role=button]')).filter(vis)
          .map(b=>({ text:(b.textContent||'').replace(/\s+/g,' ').trim().slice(0,30), disabled:b.disabled===true, cls:(b.className||'').toString().slice(0,60) }))
          .filter(b=>b.text);
        // custom dropdown triggers (divs/buttons that show 'Select ...')
        const pickers = Array.from(document.querySelectorAll('[role=combobox],[class*=select],[class*=dropdown]')).filter(vis)
          .map(d=>({ tag:d.tagName.toLowerCase(), role:d.getAttribute('role')||'', cls:(d.className||'').toString().slice(0,60), text:(d.textContent||'').replace(/\s+/g,' ').trim().slice(0,40) }))
          .filter(d=>d.text).slice(0,10);
        const stepHdr = (document.querySelector('h1,h2,h3,[class*=step][class*=active],[class*=tab][class*=active]')||{}).textContent||'';
        return { fields, buttons, pickers, stepHdr: stepHdr.replace(/\s+/g,' ').trim().slice(0,60) };
      });
      log('  [DOM DUMP step '+dumpStep+'] header="'+info.stepHdr+'"');
      info.fields.forEach((f,i)=> log('    field#'+i+' <'+f.tag+(f.type?(' type='+f.type):'')+'>'+(f.required?' *REQ':'')+' id="'+f.id+'" name="'+f.name+'" label="'+f.label+'" ph="'+f.placeholder+'" aria="'+f.aria+'" cls="'+f.cls+'"'+(f.options?(' opts='+JSON.stringify(f.options)):'')));
      if (info.pickers.length) info.pickers.forEach((p,i)=> log('    picker#'+i+' <'+p.tag+' role='+p.role+'> text="'+p.text+'" cls="'+p.cls+'"'));
      log('    buttons=' + JSON.stringify(info.buttons.map(b=>b.text+(b.disabled?'(disabled)':''))));
    } catch(e) { log('  [DOM DUMP step '+dumpStep+'] failed: '+e.message); }
  };

  // Fill all visible fields on the current wizard step. Handles inputs that have
  // NO id and NO name (common in React/Next apps using class="input") by also
  // capturing the field's label text, placeholder, and its index among same-tag
  // controls — so we can locate it by label, placeholder, or nth position.
  const fillVisibleStep = async () => {
    const fields = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
      const all = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select'));
      const visibleAll = all.filter(vis);
      const out = [];
      for (const el of visibleAll) {
        const tag = el.tagName.toLowerCase();
        let sel = '';
        if (el.id) sel = '#' + CSS.escape(el.id);
        else if (el.getAttribute('name')) sel = tag + '[name="' + el.getAttribute('name') + '"]';
        // associated label text: explicit labels, else nearest label in an ancestor wrapper
        let labelText = '';
        if (el.labels && el.labels[0]) labelText = el.labels[0].textContent || '';
        if (!labelText) {
          let p = el.parentElement, hops = 0;
          while (p && hops < 3 && !labelText) {
            const lab = p.querySelector('label');
            if (lab && lab.textContent) labelText = lab.textContent;
            p = p.parentElement; hops++;
          }
        }
        const placeholder = el.getAttribute('placeholder') || '';
        labelText = (labelText || placeholder || el.getAttribute('aria-label') || '').replace(/\*/g,'').trim();
        const tagIndex = visibleAll.filter(e2 => e2.tagName.toLowerCase()===tag).indexOf(el);
        out.push({ tag, type: (el.type||'').toLowerCase(),
          required: el.required || el.getAttribute('aria-required')==='true',
          sel, label: labelText.slice(0,60), placeholder: placeholder.slice(0,80), tagIndex });
      }
      return out;
    });
    if (!fields.length) return 0;

    // Resolve a locator for a field, even when it has no id/name.
    const locatorFor = (f) => {
      if (f.sel) return page.locator(f.sel).first();
      if (f.placeholder) return page.getByPlaceholder(f.placeholder).first();
      if (f.label) { try { return page.getByLabel(f.label).first(); } catch(_) {} }
      return page.locator(f.tag).nth(f.tagIndex);
    };

    const isText = (f) => (f.tag==='input'||f.tag==='textarea') &&
      !['checkbox','radio','file','date','number','email','password'].includes(f.type);

    let nameField = fields.find(f => isText(f) && nameRe.test(f.label));
    if (!nameField) nameField = fields.find(f => isText(f) && nameRe.test(f.placeholder));
    if (!nameField) nameField = fields.find(f => isText(f));

    // Skip the placeholder option ("Select ...", "Choose ...", "--", empty).
    const isPlaceholderOpt = (label) => {
      const t = (label||'').trim().toLowerCase();
      if (!t) return true;
      return t.startsWith('select') || t.startsWith('choose') || t.startsWith('--') || t==='none' || t==='all';
    };

    let filledThisStep = 0;
    // Fill NON-select fields first (text/textarea), so that any dropdown whose
    // options depend on a typed value can react. Selects are handled after, in
    // DOM order, ONE AT A TIME with a re-read between each — this is essential
    // for CASCADING dropdowns (e.g. Unit options only load after Sponsor Type is
    // chosen). Generic: helps any screen with dependent dropdowns, not just surveys.
    for (const f of fields) {
      try {
        if (f.tag==='select') continue;  // handled in the dedicated pass below
        if (['checkbox','radio'].includes(f.type)) continue;
        if (f.type==='file' || f.type==='date') continue;  // start date already prefilled
        const loc = locatorFor(f);
        if (nameField && f===nameField && !filledName) {
          if (await reactFill(page, loc, tag, log)) { filledName = true; filledLog.push((f.label||'name')+'='+tag); filledThisStep++; }
        } else if (f.required && isText(f)) {
          if (await reactFill(page, loc, valueFor(f), log)) { filledLog.push((f.label||'field')+'='+valueFor(f)); filledThisStep++; }
        }
      } catch(_) {}
    }

    // SELECT pass — cascade-aware. Re-find selects fresh each iteration (the DOM
    // and option lists change as earlier selects are set). Loop a few rounds so a
    // dropdown that was empty becomes fillable once its parent select is chosen.
    const selectLabel = (el) => {
      let lbl = '';
      if (el.labels && el.labels[0]) lbl = el.labels[0].textContent || '';
      if (!lbl) { let p=el.parentElement,h=0; while(p&&h<3&&!lbl){const l=p.querySelector('label'); if(l&&l.textContent)lbl=l.textContent; p=p.parentElement;h++;} }
      return (lbl||'').replace(/\*/g,'').trim().slice(0,60);
    };
    const doneSelects = new Set();
    for (let round=0; round<4; round++) {
      // snapshot current visible selects and which have a real value chosen
      const selData = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
        return Array.from(document.querySelectorAll('select')).filter(vis).map((el,idx) => ({
          idx,
          hasValue: !!(el.value && el.value.trim()),
          optCount: el.querySelectorAll('option').length,
          realOpts: Array.from(el.querySelectorAll('option')).filter(o=>o.value && o.value.trim()).length
        }));
      });
      let didOne = false;
      for (const sd of selData) {
        if (doneSelects.has(sd.idx)) continue;
        if (sd.hasValue) { doneSelects.add(sd.idx); continue; }   // already set (e.g. user/default)
        if (sd.realOpts < 1) continue;                            // no real options yet (cascade not ready)
        const sel = page.locator('select').nth(sd.idx);
        const opts = await sel.locator('option').evaluateAll(els => els.map(o=>({value:o.value, label:(o.textContent||'').trim()})));
        let pick = opts.find(o => o.value && o.value.trim() && !isPlaceholderOpt(o.label));
        if (!pick) pick = opts.find(o => o.value && o.value.trim());
        if (!pick) continue;
        let lbl = '';
        try { lbl = await sel.evaluate(selectLabel); } catch(_) {}
        try {
          await sel.selectOption(pick.value, {timeout:4000});
        } catch(_) {
          try { await sel.selectOption({label:pick.label}, {timeout:3000}); } catch(_) {}
        }
        // fire change so dependent (child) dropdowns load their options
        try { await sel.evaluate(el => { el.dispatchEvent(new Event('change',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); }); } catch(_) {}
        doneSelects.add(sd.idx);
        filledLog.push((lbl||'select#'+sd.idx)+'='+pick.label);
        filledThisStep++;
        didOne = true;
        await page.waitForTimeout(700);  // let a cascading child dropdown populate
      }
      if (!didOne) {
        // nothing more we can set this round; if any select still has 0 real opts,
        // give it one more short wait then re-loop, else stop.
        const anyPending = selData.some(sd => !doneSelects.has(sd.idx) && !sd.hasValue);
        if (!anyPending) break;
        await page.waitForTimeout(800);
      }
    }

    // CUSTOM dropdowns (not native <select>): some apps render required pickers
    // as a button/div that opens a popup list. If a Next button is still
    // disabled, try clicking any visible "Select ..." trigger and choosing the
    // first real option from the popup that appears.
    try {
      const triggers = page.locator('button, [role=combobox], [role=button], div[class*=select]')
        .filter({ hasText: /select|choose/i });
      const tcount = await triggers.count();
      for (let ti=0; ti<Math.min(tcount,4); ti++) {
        const trig = triggers.nth(ti);
        if (!(await trig.isVisible().catch(()=>false))) continue;
        await trig.click({timeout:2500}).catch(()=>{});
        await page.waitForTimeout(400);
        // pick the first real option from any popup/listbox now visible
        const opt = page.locator('[role=option], li[role=option], .option, [class*=option]')
          .filter({ hasNotText: /select|choose/i }).first();
        if (await opt.count() && await opt.isVisible().catch(()=>false)) {
          const txt = (await opt.textContent().catch(()=> '')||'').trim().slice(0,40);
          await opt.click({timeout:2500}).catch(()=>{});
          filledLog.push('picker='+txt); filledThisStep++;
          await page.waitForTimeout(300);
        } else {
          await page.keyboard.press('Escape').catch(()=>{});
        }
      }
    } catch(_) {}

    return filledThisStep;
  };

  // Wizard loop: fill this step, then advance via Next/Continue up to 5 steps.
  let advanced = 0;
  for (let step=0; step<6; step++) {
    await dumpStepDom();          // log the real elements of THIS step first
    await fillVisibleStep();
    let movedNext = false;
    for (const re of ['Next','Continue','Proceed']) {
      const loc = page.getByRole('button', {name:new RegExp(re,'i')});
      if (await loc.count() && await loc.first().isEnabled().catch(()=>false)) {
        if (await tryClick(loc)) { movedNext = true; advanced++; await page.waitForTimeout(900); break; }
      }
    }
    if (!movedNext) break;
  }
  if (advanced) log('  Create wizard: advanced through ' + advanced + ' step(s)');
  log('  Create form filled: ' + (filledLog.join(', ').slice(0,200) || '(no fillable fields detected)'));

  // Submit — try Save/Create/Submit/Finish/Publish/Done, then a submit control.
  let submitted = false;
  for (const re of ['Save','Create','Submit','Finish','Publish','Done','Add']) {
    const loc = page.getByRole('button', {name:new RegExp(re,'i')});
    if (await loc.count() && await loc.first().isEnabled().catch(()=>false)) {
      if (await tryClick(loc)) { submitted = true; break; }
    }
  }
  if (!submitted) {
    for (const sel of ['button[type=submit]','form button[type=submit]','input[type=submit]']) {
      const loc = page.locator(sel);
      if (await loc.count()) { if (await tryClick(loc)) { submitted = true; break; } }
    }
  }
  if (!submitted) return {ok:false, detail:'Filled form but could not find a submit/save button. Filled: '+filledLog.join(', '), filledName};
  await page.waitForTimeout(1800);
  return {ok: filledName, detail: (filledName?'Created with tag '+tag:'Submitted but tag was never entered (name field not found)')+'. Filled: '+filledLog.join(', '), filledName};
}

// VALIDATION CHECK: the inverse of create. Opens the create form, deliberately
// LEAVES THE REQUIRED NAME FIELD EMPTY (fills other required fields normally),
// then tries to submit. PASSES only if the app BLOCKS the save — i.e. the
// submit button is disabled, the form stays open, or a validation error appears.
// FAILS if the record saved anyway (the app let a required field through).
async function smartValidationCheck(page, scenario, log) {
  let opened = false;
  const tryClick = async (locator) => {
    try { await locator.first().click({timeout:5000}); return true; } catch(_) { return false; }
  };
  for (const re of ['New','Create','Add']) {
    const loc = page.getByRole('button', {name:new RegExp(re,'i')});
    if (await loc.count() && await tryClick(loc)) { opened = true; break; }
    const link = page.getByRole('link', {name:new RegExp(re,'i')});
    if (await link.count() && await tryClick(link)) { opened = true; break; }
  }
  if (!opened) return {ok:false, detail:'Could not open the create form for validation check'};

  try { await page.waitForSelector('form input:not([type=hidden]), form textarea, [role=dialog] input, .input', {timeout:8000}); }
  catch(_) { await page.waitForTimeout(1500); }
  await page.waitForTimeout(800);

  // Identify the required NAME-like field that we will intentionally leave blank.
  const nameRe = /name|title|label|subject/i;
  const nameInfo = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const isText = (el) => el.tagName==='INPUT' && !['checkbox','radio','file','date','number','email','password','hidden','submit','button'].includes((el.type||'').toLowerCase());
    const all = Array.from(document.querySelectorAll('input,textarea')).filter(vis).filter(isText);
    const labelOf = (el) => {
      let lbl=''; if (el.labels && el.labels[0]) lbl=el.labels[0].textContent||'';
      if (!lbl){let p=el.parentElement,h=0;while(p&&h<3&&!lbl){const l=p.querySelector('label');if(l&&l.textContent)lbl=l.textContent;p=p.parentElement;h++;}}
      return (lbl||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim();
    };
    const nameRe = /name|title|label|subject/i;
    let target = all.find(el => nameRe.test(labelOf(el))) || all[0];
    return target ? { label: labelOf(target).slice(0,60) } : null;
  });
  if (!nameInfo) return {ok:false, detail:'No required text field found to leave blank'};

  // Fill OTHER required fields with valid values, but skip the name field, and
  // explicitly clear it in case the app prefilled it.
  const filled = [];
  try {
    await page.evaluate((skipLabel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
      const labelOf = (el) => {
        let lbl=''; if (el.labels && el.labels[0]) lbl=el.labels[0].textContent||'';
        if (!lbl){let p=el.parentElement,h=0;while(p&&h<3&&!lbl){const l=p.querySelector('label');if(l&&l.textContent)lbl=l.textContent;p=p.parentElement;h++;}}
        return (lbl||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim();
      };
      // Clear the name field specifically.
      const inputs = Array.from(document.querySelectorAll('input,textarea')).filter(vis);
      for (const el of inputs) {
        if (labelOf(el).slice(0,60) === skipLabel) {
          const proto = el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto,'value').set;
          setter.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        }
      }
    }, nameInfo.label);
  } catch(_) {}
  filled.push('left "'+nameInfo.label+'" empty');

  // Attempt to submit. Try Save/Create/Submit; note whether the button is even enabled.
  let submitAttempted = false, submitButtonDisabled = false;
  for (const re of ['Save','Create','Submit','Finish','Add']) {
    const loc = page.getByRole('button', {name:new RegExp('^'+re,'i')});
    if (await loc.count()) {
      const enabled = await loc.first().isEnabled().catch(()=>false);
      if (!enabled) { submitButtonDisabled = true; submitAttempted = true; break; }
      if (await tryClick(loc)) { submitAttempted = true; break; }
    }
  }
  // Also try a Next button — in wizards the required field gates step 1.
  if (!submitAttempted) {
    const nextLoc = page.getByRole('button', {name:/^Next/i});
    if (await nextLoc.count()) {
      const enabled = await nextLoc.first().isEnabled().catch(()=>false);
      if (!enabled) { submitButtonDisabled = true; submitAttempted = true; }
      else { await tryClick(nextLoc); submitAttempted = true; }
    }
  }
  await page.waitForTimeout(1500);

  // Determine if the save was BLOCKED (the correct, passing outcome).
  // Blocked if: the submit/next button was disabled, OR a validation error is
  // visible, OR we are still on the create form (the name field is still present).
  let errorVisible = false, stillOnForm = false;
  try {
    errorVisible = await page.evaluate(() => {
      const sels=['.error','.alert','.alert-danger','.invalid-feedback','[role=alert]','.text-danger','.error-message','[class*=error]'];
      for (const s of sels){const el=document.querySelector(s);const t=el&&el.textContent&&el.textContent.trim();if(t)return true;}
      const body=document.body?document.body.innerText:'';
      return /required|cannot be empty|please (enter|fill|provide)|this field|is mandatory|must (be|not)/i.test(body);
    });
    stillOnForm = await page.evaluate((skipLabel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
      const labelOf = (el) => {
        let lbl=''; if (el.labels && el.labels[0]) lbl=el.labels[0].textContent||'';
        if (!lbl){let p=el.parentElement,h=0;while(p&&h<3&&!lbl){const l=p.querySelector('label');if(l&&l.textContent)lbl=l.textContent;p=p.parentElement;h++;}}
        return (lbl||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim();
      };
      return Array.from(document.querySelectorAll('input,textarea')).filter(vis).some(el => labelOf(el).slice(0,60)===skipLabel);
    }, nameInfo.label);
  } catch(_) {}

  const blocked = submitButtonDisabled || errorVisible || stillOnForm;
  const detail = blocked
    ? `Save correctly BLOCKED with "${nameInfo.label}" empty (`+
      [submitButtonDisabled?'submit disabled':'', errorVisible?'validation error shown':'', stillOnForm?'stayed on form':''].filter(Boolean).join(', ')+')'
    : `App did NOT block submission with "${nameInfo.label}" empty — the required-field validation may be missing`;
  return { ok: blocked, blocked, detail, fieldLeftEmpty: nameInfo.label };
}

// EDIT CHECK (general, safe): edits the record the tool created THIS run (the
// QAVYA_TEST_<tag> row) — never real data. Steps: search the list for the tag,
// open the row (Edit control or row click), change the name field to
// "<tag>_EDITED", save, return to the list and search the new value. PASSES only
// if the edited value now appears in the list (proving the change persisted).
// Returns { ok, detail, newValue }.
async function smartEditVerify(page, listUrl, tag, log) {
  const tryClick = async (locator) => {
    try { await locator.first().click({timeout:5000}); return true; } catch(_) { return false; }
  };
  const newValue = tag + '_EDITED';

  // 1. Go to the list and search for our own record.
  try {
    await page.goto(listUrl, {waitUntil:'domcontentloaded', timeout:20000});
    await page.waitForTimeout(1200);
  } catch(_) {}
  const searchBox = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
  if (await searchBox.count() && await searchBox.isVisible().catch(()=>false)) {
    await reactFill(page, searchBox, tag, log);
    await page.waitForTimeout(1500);
  }

  // 2. Open the record. Try an Edit control in the matching row first, then a
  //    row/link containing the tag text, then a generic Edit button.
  let opened = false;
  // Edit control near a cell that contains the tag
  try {
    const row = page.locator('tr', { hasText: tag }).first();
    if (await row.count()) {
      const editInRow = row.getByRole('button', {name:/edit/i});
      if (await editInRow.count() && await tryClick(editInRow)) opened = true;
      if (!opened) {
        const editLink = row.getByRole('link', {name:/edit/i});
        if (await editLink.count() && await tryClick(editLink)) opened = true;
      }
      if (!opened) {
        // Some lists open the editor by clicking the row/name cell itself.
        const nameCell = row.getByText(tag, {exact:false}).first();
        if (await nameCell.count() && await tryClick(nameCell)) opened = true;
      }
    }
  } catch(_) {}
  // Fallback: any element containing the tag, then a generic Edit button
  if (!opened) {
    try {
      const tagEl = page.getByText(tag, {exact:false}).first();
      if (await tagEl.count() && await tryClick(tagEl)) { opened = true; await page.waitForTimeout(1000); }
    } catch(_) {}
  }
  if (!opened) {
    const editBtn = page.getByRole('button', {name:/^edit/i});
    if (await editBtn.count() && await tryClick(editBtn)) opened = true;
  }
  if (!opened) return { ok:false, detail:'Could not open the created record to edit (no Edit control / row found for '+tag+')' };

  try { await page.waitForSelector('form input:not([type=hidden]), form textarea, [role=dialog] input, .input', {timeout:8000}); }
  catch(_) { await page.waitForTimeout(1500); }
  await page.waitForTimeout(800);

  // 3. Change the name-like field to the new marker value.
  const nameRe = /name|title|label|subject/i;
  const nameField = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const isText = (el) => el.tagName==='INPUT' && !['checkbox','radio','file','date','number','email','password','hidden','submit','button'].includes((el.type||'').toLowerCase());
    const all = Array.from(document.querySelectorAll('input,textarea')).filter(vis).filter(isText);
    const labelOf = (el) => {
      let lbl=''; if (el.labels && el.labels[0]) lbl=el.labels[0].textContent||'';
      if (!lbl){let p=el.parentElement,h=0;while(p&&h<3&&!lbl){const l=p.querySelector('label');if(l&&l.textContent)lbl=l.textContent;p=p.parentElement;h++;}}
      return (lbl||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim();
    };
    const nameRe = /name|title|label|subject/i;
    let target = all.find(el => nameRe.test(labelOf(el))) || all[0];
    if (!target) return null;
    return { label: labelOf(target).slice(0,60) };
  });
  if (!nameField) return { ok:false, detail:'Opened the record but found no editable name field' };

  // Locate that field by label/placeholder and set the new value.
  let setOk = false;
  try {
    let loc = page.getByLabel(nameField.label).first();
    if (!(await loc.count())) loc = page.getByPlaceholder(nameField.label).first();
    if (!(await loc.count())) loc = page.locator('input,textarea').first();
    setOk = await reactFill(page, loc, newValue, log);
  } catch(_) {}
  if (!setOk) return { ok:false, detail:'Could not type the new value into "'+nameField.label+'"' };

  // 4. Save.
  let saved = false;
  for (const re of ['Save','Update','Submit','Done','Finish']) {
    const b = page.getByRole('button', {name:new RegExp('^'+re,'i')});
    if (await b.count() && await b.first().isEnabled().catch(()=>false)) {
      if (await tryClick(b)) { saved = true; break; }
    }
  }
  if (!saved) {
    const sub = page.locator('button[type=submit]');
    if (await sub.count() && await tryClick(sub)) saved = true;
  }
  if (!saved) return { ok:false, detail:'Changed "'+nameField.label+'" but found no Save/Update button' };
  await page.waitForTimeout(1800);

  // 5. Return to list, search the NEW value, confirm it now appears.
  try {
    await page.goto(listUrl, {waitUntil:'domcontentloaded', timeout:20000});
    await page.waitForTimeout(1200);
  } catch(_) {}
  const sb2 = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
  if (await sb2.count() && await sb2.isVisible().catch(()=>false)) {
    await reactFill(page, sb2, newValue, log);
    await page.waitForTimeout(1500);
  }
  let appears = false;
  try {
    appears = await page.evaluate((val) => (document.body?document.body.innerText:'').includes(val), newValue);
  } catch(_) {}
  return {
    ok: appears, newValue,
    detail: appears
      ? `Edit persisted: "${nameField.label}" changed to "${newValue}" and the updated value appears in the list`
      : `Edited "${nameField.label}" to "${newValue}" and saved, but the updated value did NOT appear in the list afterward`
  };
}

// EDIT CHECK (general): opens an existing record's edit form, changes a text
// field to a known marker value, saves, then reloads/reopens and confirms the
// new value persisted. Prefers the record this run created (matchTag) so it
// only touches the tool's own data, but falls back to the first editable row.
// Generic: no app-specific selectors — it finds edit affordances and text
// fields by reading the live page.
async function smartEditVerify(page, scenario, matchTag, listUrl, log) {
  const tryClick = async (locator) => {
    try { await locator.first().click({timeout:5000}); return true; } catch(_) { return false; }
  };
  // Make sure we're on the list, and if our tagged record exists, search for it.
  try {
    if (listUrl) { await page.goto(listUrl, {waitUntil:'domcontentloaded', timeout:20000}); await page.waitForTimeout(1200); }
    if (matchTag) {
      const searchBox = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
      if (await searchBox.count() && await searchBox.isVisible().catch(()=>false)) {
        await reactFill(page, searchBox, matchTag, log);
        await page.waitForTimeout(1500);
      }
    }
  } catch(_) {}

  // Open an edit form. Try, in order: an Edit control in the row containing our
  // tag; any Edit button/link/icon; clicking the row itself.
  let opened = false;
  try {
    if (matchTag) {
      const row = page.locator('tr, [role=row], li').filter({ hasText: matchTag }).first();
      if (await row.count()) {
        const editInRow = row.getByRole('button', {name:/edit/i}).or(row.getByRole('link', {name:/edit/i})).or(row.locator('[aria-label*=edit i], [title*=edit i], a[href*=edit]'));
        if (await editInRow.count() && await tryClick(editInRow)) opened = true;
        if (!opened && await tryClick(row)) opened = true;  // some apps open on row click
      }
    }
  } catch(_) {}
  if (!opened) {
    for (const re of ['Edit','Modify','Update']) {
      const loc = page.getByRole('button', {name:new RegExp(re,'i')}).or(page.getByRole('link', {name:new RegExp(re,'i')}));
      if (await loc.count() && await tryClick(loc)) { opened = true; break; }
    }
  }
  if (!opened) {
    const iconEdit = page.locator('[aria-label*=edit i], [title*=edit i], a[href*=edit], button[class*=edit]').first();
    if (await iconEdit.count() && await tryClick(iconEdit)) opened = true;
  }
  if (!opened) return {ok:false, detail:'Could not find an Edit control to open a record'};

  try { await page.waitForSelector('form input:not([type=hidden]), form textarea, [role=dialog] input, .input', {timeout:8000}); }
  catch(_) { await page.waitForTimeout(1500); }
  await page.waitForTimeout(800);

  // Find a text field to change. Prefer a name/title field; capture its current
  // value, then append a unique marker so we can verify it persisted.
  const marker = '_EDIT' + Math.random().toString(36).slice(2,5).toUpperCase();
  const nameRe = /name|title|label|subject/i;
  const targetInfo = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; };
    const isText = (el) => el.tagName==='INPUT' && !['checkbox','radio','file','date','number','email','password','hidden','submit','button'].includes((el.type||'').toLowerCase());
    const all = Array.from(document.querySelectorAll('input,textarea')).filter(vis).filter(el => isText(el) || el.tagName==='TEXTAREA');
    const labelOf = (el) => {
      let lbl=''; if (el.labels && el.labels[0]) lbl=el.labels[0].textContent||'';
      if (!lbl){let p=el.parentElement,h=0;while(p&&h<3&&!lbl){const l=p.querySelector('label');if(l&&l.textContent)lbl=l.textContent;p=p.parentElement;h++;}}
      return (lbl||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim();
    };
    let target = all.find(el => re.test(labelOf(el)) && el.value && el.value.trim()) || all.find(el => el.value && el.value.trim()) || all[0];
    if (!target) return null;
    return { label: labelOf(target).slice(0,60), current: (target.value||'').slice(0,120) };
  }, nameRe.source);
  if (!targetInfo) return {ok:false, detail:'Opened edit form but found no text field to modify'};

  const newValue = (targetInfo.current || 'QAVYA') + marker;
  // Locate that same field and set the new value.
  let setOk = false;
  try {
    const loc = page.getByLabel(targetInfo.label).first();
    if (await loc.count()) setOk = await reactFill(page, loc, newValue, log);
  } catch(_) {}
  if (!setOk) {
    // Fallback: first visible text input/textarea.
    const loc = page.locator('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]), textarea').first();
    if (await loc.count()) setOk = await reactFill(page, loc, newValue, log);
  }
  if (!setOk) return {ok:false, detail:`Could not type a new value into "${targetInfo.label}"`};

  // Save.
  let saved = false;
  for (const re of ['Save','Update','Submit','Done','Apply']) {
    const loc = page.getByRole('button', {name:new RegExp('^'+re,'i')});
    if (await loc.count() && await loc.first().isEnabled().catch(()=>false)) {
      if (await tryClick(loc)) { saved = true; break; }
    }
  }
  if (!saved) {
    const sub = page.locator('button[type=submit]').first();
    if (await sub.count()) saved = await tryClick(sub);
  }
  if (!saved) return {ok:false, detail:`Changed "${targetInfo.label}" but found no Save button`};
  await page.waitForTimeout(2000);

  // Verify: go back to the list, search for the marker, and confirm it appears.
  let persisted = false;
  try {
    if (listUrl) { await page.goto(listUrl, {waitUntil:'domcontentloaded', timeout:20000}); await page.waitForTimeout(1200); }
    const searchBox = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
    if (await searchBox.count() && await searchBox.isVisible().catch(()=>false)) {
      await reactFill(page, searchBox, marker, log);
      await page.waitForTimeout(1500);
    }
    persisted = await page.evaluate((mk) => (document.body?document.body.innerText:'').includes(mk), marker);
    if (!persisted) {
      // Some apps land on the edit/detail page after save; check there too.
      persisted = await page.evaluate((mk) => {
        return Array.from(document.querySelectorAll('input,textarea')).some(el => (el.value||'').includes(mk));
      }, marker);
    }
  } catch(_) {}

  const detail = persisted
    ? `Edited "${targetInfo.label}" → appended ${marker}; change persisted after reload`
    : `Edited "${targetInfo.label}" and saved, but the change (${marker}) was NOT found after reload — the edit may not have persisted`;
  return { ok: persisted, detail, field: targetInfo.label, marker };
}

async function runScan(scanId, config) {
  const scan = scans.get(scanId);
  // Write each scan's log to disk so failed runs can be debugged after the fact.
  const _fs = require('fs'); const _path = require('path');
  const _logDir = _path.join(__dirname, 'autoscan_logs');
  try { _fs.mkdirSync(_logDir, { recursive: true }); } catch(_) {}
  const _logFile = _path.join(_logDir, `scan_${scanId}.log`);
  const log  = (m) => {
    const ts = new Date().toISOString();
    console.log(`[AutoScan:${scanId}] ${m}`);
    scan.logs.push({t:ts,m});
    try { _fs.appendFileSync(_logFile, `${ts}  ${m}\n`); } catch(_) {}
  };
  log(`=== Auto-scan ${scanId} starting [CODE v13: validation+dbresults] ; config: url=${config.url}, screens=${config.selectedScreenIndices?config.selectedScreenIndices.length:'all'}, dbChecks=${Array.isArray(config.dbChecks)?config.dbChecks.length:0}, enableDelete=${!!config.enableDelete} ===`);

  let browser;
  let dbPool = null;
  const TEST_TAG = 'QAVYA_TEST_' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '_' + Math.random().toString(36).slice(2,6);
  const enableDelete = !!config.enableDelete;
  scan.testTag = TEST_TAG;
  scan.createdRecords = [];
    scan.dbCheckResults = [];  // record every DB cross-check result (pass + mismatch) for the report
  try {
    const { chromium } = require('playwright');
    scan.status='running'; scan.started_at=new Date().toISOString();
    log('Launching browser');
    log(`Create-and-verify tag for this run: ${TEST_TAG}${enableDelete?' (delete flow ENABLED for own records)':''}`);

    if (config.db && config.db.host && Array.isArray(config.dbChecks) && config.dbChecks.length) {
      try {
        dbPool = makePgPool(config.db);
        await dbPool.query('SELECT 1');
        log(`DB cross-check enabled — ${config.dbChecks.length} check(s) configured`);
      } catch(e) {
        log(`DB connection failed — cross-check disabled: ${e.message}`);
        try { await dbPool?.end(); } catch(_) {}
        dbPool = null;
      }
    }

    browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox'] });
    const ctx  = await browser.newContext({ viewport:{width:1280,height:800}, ignoreHTTPSErrors:true });
    const page = await ctx.newPage();

    const apiByPage = {};
    let currentPageUrl = config.url;
    const summariseJson = (data) => {
      const out = { count: null, countFields: {}, sample: null };
      try {
        if (Array.isArray(data)) {
          out.count = data.length;
          out.sample = data[0] ?? null;
        } else if (data && typeof data === 'object') {
          for (const k of ['data','items','results','rows','records','content','surveys','list']) {
            if (Array.isArray(data[k])) { out.count = data[k].length; out.sample = data[k][0] ?? null; break; }
          }
          for (const k of ['total','totalCount','total_count','count','totalElements','totalItems','recordsTotal']) {
            if (typeof data[k] === 'number') out.countFields[k] = data[k];
          }
        }
      } catch(_) {}
      return out;
    };
    page.on('response', async (resp) => {
      try {
        const ct = (resp.headers()['content-type']||'');
        if (!/application\/json/i.test(ct)) return;
        const u = resp.url();
        if (/anthropic\.com/.test(u)) return;
        const req = resp.request();
        if (!['GET','POST'].includes(req.method())) return;
        let data; try { data = await resp.json(); } catch(_) { return; }
        const s = summariseJson(data);
        if (s.count === null && Object.keys(s.countFields).length === 0) return;
        (apiByPage[currentPageUrl] = apiByPage[currentPageUrl] || []).push({
          url: u, status: resp.status(), method: req.method(),
          count: s.count, countFields: s.countFields,
          sampleKeys: s.sample && typeof s.sample==='object' ? Object.keys(s.sample).slice(0,20) : null,
        });
      } catch(_) {}
    });

    scan.phase = 'Logging in';
    await page.goto(config.url, {waitUntil:'domcontentloaded',timeout:30000});
    try {
      await page.waitForSelector('input[type=password],input[type=text],input[type=email]', {timeout:10000});
    } catch(_) {}
    await page.waitForTimeout(1000);
    const loginSS = (await page.screenshot()).toString('base64');
    const hasPwField = await page.$('input[type=password]') !== null;

    log('Asking Claude to identify login form');
    let loginData;
    try {
      const raw = await callClaude([{role:'user',content:[
        {type:'image',source:{type:'base64',media_type:'image/png',data:loginSS}},
        {type:'text',text:'This is a login page screenshot. Respond with JSON only:\n{"usernameSelector":"css selector","passwordSelector":"css selector","submitSelector":"css selector"}\nIf this is NOT a login page respond: {"isNotLoginPage":true}'}
      ]}], 'You are a web automation expert. Respond only with valid JSON, no markdown.', 512);
      loginData = parseJson(raw);
    } catch(e) {
      loginData = {
        usernameSelector: 'input[type=text],input[type=email],input[name=username],input[name=email]',
        passwordSelector: 'input[type=password]',
        submitSelector:   'button[type=submit],input[type=submit]',
      };
    }

    if (hasPwField) {
      if (loginData.isNotLoginPage) {
        log('Claude said not-a-login-page, but a password field exists — forcing login');
      }
      loginData.isNotLoginPage = false;
      if (!loginData.passwordSelector) loginData.passwordSelector = 'input[type=password]';
      if (!loginData.usernameSelector) loginData.usernameSelector = 'input[type=text],input[type=email],input[name=username],input[name=email]';
      if (!loginData.submitSelector)   loginData.submitSelector   = 'button[type=submit],input[type=submit],button';
    }

    if (!loginData.isNotLoginPage) {
      const preLoginUrl = page.url();
      scan._loginUrl = preLoginUrl;
      const onLoginPage = async () =>
        (await page.$(loginData.passwordSelector)) !== null && page.url() === preLoginUrl;
      try {
        const preErr = await page.evaluate(() => (document.body?document.body.innerText:'').slice(0, 1000));
        if (/too many|rate.?limit|try again later/i.test(preErr)) {
          log('Login page already shows a rate-limit message — not submitting. Wait for the lockout to clear, then rerun.');
          throw new Error('rate-limited-before-submit');
        }

        await page.fill(loginData.usernameSelector, config.username);
        await page.fill(loginData.passwordSelector, config.password);

        try {
          await page.click(loginData.submitSelector, {timeout:5000});
        } catch(_) {
          try { await page.press(loginData.passwordSelector, 'Enter'); } catch(_) {}
        }
        try {
          await page.waitForFunction(
            (args) => window.location.href !== args.prev ||
                      !document.querySelector(args.pwSel),
            { prev: preLoginUrl, pwSel: loginData.passwordSelector },
            { timeout: 12000 }
          );
        } catch(_) {}
        const ok = !(await onLoginPage());

        if (ok) {
          await page.waitForTimeout(1500);
          scan._loginSucceeded = true;
          log(`Login done — now at ${page.url()}`);
        } else {
          let errMsg = '';
          try {
            errMsg = await page.evaluate(() => {
              const sels = ['.error','.alert','.alert-danger','.invalid-feedback','[role=alert]','.toast','.text-danger','.error-message'];
              for (const s of sels) {
                const el = document.querySelector(s);
                const t = el && el.textContent && el.textContent.trim();
                if (t) return t.slice(0, 200);
              }
              const body = document.body ? document.body.innerText : '';
              const m = body.match(/.{0,60}(invalid|incorrect|wrong|failed|rate.?limit|too many|locked|unauthor).{0,60}/i);
              return m ? m[0].trim().slice(0, 200) : '';
            });
          } catch(_) {}
          if (errMsg) {
            log(`WARNING: login failed — app says: "${errMsg}"`);
          } else {
            log('WARNING: login may have failed — still on login page after all submit attempts. Check credentials/selector.');
          }
        }
      } catch(e) { log(`Login interaction failed: ${e.message} — continuing`); }
    }
    await page.waitForTimeout(2000);
    const postLoginUrl = page.url();
    log(`Landed at: ${postLoginUrl}`);

    scan.phase = 'Crawling pages';
    const baseOrigin = new URL(config.url).origin;

    if (scan._loginUrl && !scan._loginSucceeded) {
      const stillOnLogin = /login|signin|sign-in/i.test(postLoginUrl) || page.url() === scan._loginUrl;
      if (stillOnLogin) {
        log('Login did not succeed — skipping crawl/testing. Fix credentials or rate limiting, then rerun.');
        scan.status='completed'; scan.phase='Done — login failed';
        scan.completed_at=new Date().toISOString();
        scan.error='Login failed: could not get past the login page. Check credentials or the app\'s login rate limiter.';
        try { await browser?.close(); } catch(_) {}
        return;
      }
    }

    const isLoginUrl = (u) => scan._loginUrl && u === scan._loginUrl;
    const visited=new Set(), queue=[postLoginUrl], pages=[];
    const bugs = [];
    const maxPgs = Math.min(config.maxPages||15, 100);
    // Each DB check runs ONCE per scan (on the first screen where its related
    // count actually appears), so a survey count isn't re-compared on every screen.
    const dbCheckDone = new Set();

    if (scan._loginUrl && !queue.includes(scan._loginUrl)) queue.push(scan._loginUrl);

    while (queue.length && pages.length < maxPgs) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        currentPageUrl = url;
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
        await page.waitForTimeout(1200);
        currentPageUrl = page.url();
        const title = await page.title();
        const ss    = (await page.screenshot()).toString('base64');

        // Initialize domInfo with defaults
        let domInfo = {
          formCount:   0,
          inputCount:  0,
          buttonCount: 0,
          tableCount:  0,
          buttons:     [],
          inputTypes:  [],
        };

        // Try to extract real domInfo
        try {
          domInfo = await page.evaluate(() => {
            const forms  = document.querySelectorAll('form');
            const inputs = document.querySelectorAll('input:not([type=hidden]),select,textarea');
            const btns   = document.querySelectorAll('button,input[type=submit]');
            const tables = document.querySelectorAll('table');
            return {
              formCount:   forms.length,
              inputCount:  inputs.length,
              buttonCount: btns.length,
              tableCount:  tables.length,
              buttons:     [...btns].map(b=>b.textContent?.trim()).filter(Boolean).slice(0,10),
              inputTypes:  [...inputs].map(i=>({type:i.type||i.tagName,name:i.name||i.placeholder||'',id:i.id})).slice(0,15),
            };
          });
        } catch (e) {
          log(`  ⚠️ Could not extract page info: ${e.message}`);
        }

        pages.push({url:page.url(),title,screenshot:ss,domInfo});
        scan.pagesDiscovered = pages.length;

        if (dbPool) {
          // Wait briefly so async API responses for THIS page are captured before
          // we read them (avoids a race where the check runs before /api/... lands).
          await page.waitForTimeout(700);
          // Try each configured check that hasn't already produced a result.
          // De-dupe by query: identical queries are treated as one check.
          const chk = (Array.isArray(config.dbChecks)?config.dbChecks:[])
            .find(c => c && c.query && !dbCheckDone.has(c.query));
          if (chk && chk.query) {
            try {
              const dbCount = await runDbCount(dbPool, chk.query);
              // Look across ALL pages' captured API hits, not just this one — the
              // related count may have been recorded on a sibling navigation.
              const apiHits = [].concat(...Object.values(apiByPage));
              // Derive keywords to find the RELATED API call. Prefer an explicit
              // apiMatch; else pull the table name from the query ("from surveys"
              // -> "surveys"); else fall back to urlMatch path words. Label words
              // are NOT used (they are display text like "Patient Feedback").
              let kw = [];
              if (chk.apiMatch) {
                kw = (chk.apiMatch.toLowerCase().match(/[a-z]{3,}/g) || []);
              } else {
                const fromMatch = (chk.query||'').toLowerCase().match(/from\s+([a-z_][a-z0-9_]*)/);
                if (fromMatch) kw = [fromMatch[1].replace(/_/g,'')];
                if (!kw.length) {
                  const pathWords = (chk.urlMatch||'').toLowerCase().match(/[a-z]{3,}/g) || [];
                  kw = pathWords.filter(w => !['admin','the','and','all','page'].includes(w));
                }
              }
              const isRelated = (apiUrl) => {
                if (!kw.length) return true;
                const u2 = (apiUrl||'').toLowerCase();
                return kw.some(w => u2.includes(w));
              };
              const relatedHits = apiHits.filter(a => isRelated(a.url));
              // Avoid apples-to-oranges: if the query counts a whole table
              // (no WHERE clause), prefer UNFILTERED API calls. An endpoint with
              // a status=/type=/filter query-string returns a SUBSET (e.g.
              // ?status=published = 22) and must not be compared against a full
              // count(*) (= 26). Drop filtered endpoints when the SQL is unfiltered.
              const sqlIsUnfiltered = !/\bwhere\b/i.test(chk.query||'');
              const isFilteredApi = (apiUrl) => /[?&](status|type|state|filter|category|unit|published|active|archived)=/i.test(apiUrl||'');
              let candidateHits = relatedHits;
              let waitingForUnfiltered = false;
              if (sqlIsUnfiltered) {
                const unfiltered = relatedHits.filter(a => !isFilteredApi(a.url));
                if (unfiltered.length) {
                  candidateHits = unfiltered;
                } else if (relatedHits.length) {
                  // Only filtered endpoints seen so far (e.g. ?status=published).
                  // Comparing a SUBSET against a full count(*) gives a false
                  // mismatch, so DON'T compare yet — wait for an unfiltered call
                  // (e.g. /api/surveys?limit=200) on a later page.
                  waitingForUnfiltered = true;
                }
              }
              // Prefer a real total (countFields like total=24) over a page-size
              // array length (count=5 from a limit=5 call), so pagination doesn't
              // produce a false mismatch.
              let apiTotal = null;
              let apiSrc = '';
              for (const a of candidateHits) {
                const tv = Object.values(a.countFields)[0];
                if (typeof tv === 'number') { apiTotal = tv; apiSrc = a.url; break; }
              }
              if (apiTotal == null) {
                for (const a of candidateHits) {
                  if (a.count != null) { apiTotal = a.count; apiSrc = a.url; break; }
                }
              }
              if (waitingForUnfiltered) {
                // Saw only a filtered subset so far; wait for an unfiltered count.
                log(`DB check [${chk.label||chk.urlMatch}] pending on "${title}": DB=${dbCount}, only filtered API counts seen so far — waiting for an unfiltered endpoint`);
              } else if (apiTotal == null) {
                // No related count captured yet — log once so it's visible, and
                // keep trying on later pages (don't mark done).
                log(`DB check [${chk.label||chk.urlMatch}] pending on "${title}": DB=${dbCount}, no related API count seen yet (kw=${JSON.stringify(kw)})`);
              } else if (dbCount != null && apiTotal !== dbCount) {
                dbCheckDone.add(chk.query);
                pages[pages.length-1].dbCheck = { label: chk.label||chk.urlMatch, dbCount, apiTotal };
                bugs.push({
                  id:`bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
                  summary:`Count mismatch on ${chk.label||page.url()}: UI/API shows ${apiTotal}, DB has ${dbCount}`,
                  description:`The page's data count does not match the database.\n\nUI/API total: ${apiTotal}\nDatabase (${chk.label}): ${dbCount}\nQuery: ${chk.query}\n\nPage: ${page.url()}`,
                  severity:'high', type:'data',
                  pageUrl:page.url(), pageTitle:title,
                  screenshot:ss, source:'db_cross_check',
                  jiraPosted:false, jiraKey:null,
                });
                log(`DB MISMATCH [${chk.label}] on "${title}": UI/API=${apiTotal} vs DB=${dbCount} (api=${apiSrc.replace(baseOrigin,'')})`);
                scan.dbCheckResults.push({ label: chk.label||chk.urlMatch, query: chk.query, dbCount, apiTotal, match:false, apiUrl: apiSrc.replace(baseOrigin,''), page: title });
              } else {
                dbCheckDone.add(chk.query);
                pages[pages.length-1].dbCheck = { label: chk.label||chk.urlMatch, dbCount, apiTotal };
                log(`DB check [${chk.label}] on "${title}": DB=${dbCount}, UI/API=${apiTotal} ✓ (match) (api=${apiSrc.replace(baseOrigin,'')})`);
                scan.dbCheckResults.push({ label: chk.label||chk.urlMatch, query: chk.query, dbCount, apiTotal, match:true, apiUrl: apiSrc.replace(baseOrigin,''), page: title });
              }
            } catch(e) {
              log(`DB check failed for ${chk.label||page.url()}: ${e.message}`);
            }
          }
        }

        const apiHits = apiByPage[page.url()] || apiByPage[url] || [];
        if (apiHits.length) {
          const summary = apiHits.map(a => {
            const cf = Object.entries(a.countFields).map(([k,v])=>`${k}=${v}`).join(',');
            return `${a.count!=null?`${a.count} items`:''}${cf?` (${cf})`:''} ← ${a.url.replace(baseOrigin,'')}`;
          }).join(' | ');
          log(`Page ${pages.length}: ${title} (${domInfo.formCount} forms, ${domInfo.inputCount} inputs) | API: ${summary}`);
        } else {
          log(`Page ${pages.length}: ${title} (${domInfo.formCount} forms, ${domInfo.inputCount} inputs)`);
        }

        const links = await page.evaluate((o) =>
          [...document.querySelectorAll('a[href]')]
            .map(a=>a.href)
            .filter(h=>h.startsWith(o)&&!/#$|#\/?$/.test(h)&&!/logout|signout|sign-out/i.test(h))
            .slice(0,20), baseOrigin);
        for (const l of links) if (!visited.has(l)&&!queue.includes(l)) queue.push(l);
      } catch(e) { log(`Crawl failed ${url}: ${e.message}`); }
    }

    if (scan._loginUrl) {
      const loginIdx = pages.findIndex(p => isLoginUrl(p.url));
      if (loginIdx > -1 && loginIdx < pages.length - 1) {
        const [loginPg] = pages.splice(loginIdx, 1);
        pages.push(loginPg);
        log('Login page moved to end — will be tested last');
      }
    }
    log(`Crawl complete — ${pages.length} pages found`);

    if (Array.isArray(config.selectedScreenIndices) && config.selectedScreenIndices.length > 0) {
      const selectedIndices = new Set(config.selectedScreenIndices);
      log(`Filtering to ${selectedIndices.size} selected screens (out of ${pages.length} discovered)`);
      const selectedPages = pages.filter((p, idx) => selectedIndices.has(idx));
      if (scan._loginUrl) {
        const loginIdx = selectedPages.findIndex(p => isLoginUrl(p.url));
        if (loginIdx > -1 && loginIdx < selectedPages.length - 1) {
          const [loginPg] = selectedPages.splice(loginIdx, 1);
          selectedPages.push(loginPg);
          log('Login page kept at end of selected screens');
        }
      }
      pages.length = 0;
      pages.push(...selectedPages);
      log(`Testing ${pages.length} selected screens`);
    }

    scan.phase = 'Planning test scenarios';
    log('Asking Claude to plan test scenarios for each page');

    const pageScenarios = [];

    // The login page is planned by the AI like any other page now, so it can get
    // positive AND negative login scenarios. We keep a fallback positive card to
    // emit only if the login page is not among the tested screens.
    let loginCardEmitted = false;
    const loginPlan = {
      url: scan._loginUrl || config.url,
      title: 'Login',
      scenarios: [{
        name:'Login with provided credentials',
        description:'Verifies that logging in with the real credentials supplied for this scan succeeds.',
        type:'login_positive',
        steps:[],
        verifyAfter:'User is authenticated and lands past the login page.',
        testData:{}
      }]
    };

    for (let i=0; i<pages.length; i++) {
      const pg = pages[i];
      if (pg.domInfo.formCount === 0 && pg.domInfo.inputCount === 0 && !isLoginUrl(pg.url)) {
        pageScenarios.push({url:pg.url,title:pg.title,scenarios:[]});
        continue;
      }
      if (isLoginUrl(pg.url)) {
        loginCardEmitted = true;  // the login page is in scope; AI will plan its scenarios below
        log(`Login page in scope — AI will plan positive + negative login scenarios: ${pg.title}`);
      }
      try {
        const raw = await callClaude([{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:'image/png',data:pg.screenshot}},
          {type:'text',text:`You are a QA engineer planning test scenarios for this page.
Page URL: ${pg.url}
Page Title: ${pg.title}
DOM Info: ${JSON.stringify(pg.domInfo)}

Plan up to 20 test scenarios to verify this page works correctly. Use this QA checklist and plan whichever items apply to THIS page:
- Create with valid data (type "create_verify")
- Edit an existing record and verify the changes persist (type "edit_verify") — only if records exist and are editable
- Publish or activate a record (type "publish_verify") — only if records have draft/published or inactive/active states
- VALIDATION: required-field check (type "validation_check") — see below
- Search by keyword (type "search")
- Filter interactions, one scenario per distinct filter (type "search")
- Navigation flows (type "navigation")

BEFORE planning scenarios, identify what information would make them more appropriate:
- What is the primary business workflow on this page?
- What are the REQUIRED vs OPTIONAL fields?
- What business rules or constraints exist? (e.g., duplicate prevention, validation rules, state transitions)
- What are common failure/error scenarios?
- What data relationships exist? (e.g., cascading selections)
- Are there any special field constraints? (e.g., email format, number ranges, max length)

IF YOU CANNOT DETERMINE THESE FROM THE SCREENSHOT, include them in the response as "uncertainties" in a separate "questions" field.

Respond with:
{
  "questions": [
    "What is the primary business workflow for [records on this page]?",
    "What validation rules apply to the [field name] field?"
  ],
  "uncertainties": ["Field X purpose unclear", "Unclear if records have status/state"],
  "scenarios": [...]
}

VALIDATION CHECK (important):
- If this page has a create/add form with at least one REQUIRED field (marked with * or labelled required), plan ONE scenario of type "validation_check".
- Its purpose is the OPPOSITE of create: deliberately leave a required field empty, attempt to save, and confirm the app BLOCKS the save and shows a validation error. The executor handles the mechanics — you do NOT need to provide steps for it. Leave steps as an empty array.
- verifyAfter must be: "the form blocks submission and shows a validation error for the empty required field".

CREATE-AND-VERIFY (important):
- If this page has a "New"/"Create"/"Add" capability (a button or link that opens a create form), plan ONE scenario of type "create_verify" that: clicks the create button, fills the form, and SUBMITS it.
- For the record's NAME/TITLE field, you MUST use this exact value: "${TEST_TAG}". This unique tag lets us find and verify the record afterwards. Put it in the most name-like text field. Fill other REQUIRED fields with sensible valid values; skip optional fields.
- The verifyAfter for a create_verify scenario must be: "a record named ${TEST_TAG} now appears in the list".
- After create_verify, if the records have a DRAFT/PUBLISHED or INACTIVE/ACTIVE workflow, plan an edit_verify THEN a publish_verify to test the full lifecycle.
  - edit_verify: "Test editing the ${TEST_TAG} record and verify changes persist"
  - publish_verify: "Find ${TEST_TAG} record, click a Publish/Activate button, verify it shows as published/active" (steps empty)
- If you already planned a create_verify scenario, consider planning an edit_verify scenario (type "edit_verify") to test editing that same record. Leave steps empty; the tool handles opening the edit form and modifying a field. verifyAfter: "the edited field's new value persists after reload".
${enableDelete ? `- DELETE is enabled. If this page lists records that can be deleted, plan a "delete_verify" scenario when it makes sense (ideally targeting a record you created this run). When deleting, you MUST target ONLY the row whose name is exactly "${TEST_TAG}". NEVER delete any row that is not named "${TEST_TAG}". verifyAfter: "the ${TEST_TAG} record no longer appears".` : `- DO NOT plan any delete scenarios. Deleting is disabled for this run.`}

LOGIN PAGE: If THIS page is the login/sign-in page (it has username/password fields), plan a good spread of login scenarios as separate items, for example: (1) a POSITIVE login with the real provided credentials, type "login_positive"; (2) NEGATIVE login with a wrong password, type "login_negative"; (3) NEGATIVE login with empty required fields, type "login_negative". For login_positive, leave steps empty (the scan already performed the real login and will report its true result). For login_negative scenarios, provide steps that fill the username/password fields with the bad/empty values and click submit; the expected behavior is that login is REJECTED and the user stays on the login page or sees an error. Only plan login scenarios on the actual login page, not elsewhere.

CRITICAL RULES about expectations and test data:
- You do NOT know what real records exist in this app. NEVER invent specific record names, counts, or "expected" rows (e.g. do not put expectedVisibleSurvey, expectedCount, or a specific survey name in testData or verifyAfter). The ONLY name you may assert is the tag "${TEST_TAG}" that you yourself created.
- For edit_verify scenarios: steps should be empty (you do NOT provide edit steps—the tool handles them). The tool will automatically search for the ${TEST_TAG} record, open the edit form, modify a field, save, reload, and verify the change persisted.
- For publish_verify scenarios: steps should be empty (you do NOT provide publish steps—the tool handles them). The tool will automatically search for the ${TEST_TAG} record, click a Publish/Activate button, and verify the published/active status appears.
- For search/filter scenarios, the correct expectation is about BEHAVIOR, not specific data: e.g. "the filter applies and the list updates to a consistent subset", "applying a status filter shows only rows matching that status (or an empty state if none exist)". An empty result for a status that has no data is CORRECT, not a failure.
- verifyAfter must describe an observable behavior that is true regardless of how much data exists (e.g. "the list re-renders without errors and reflects the selected filter").
- testData should only contain values YOU will type into inputs (e.g. a search term, a status to pick) — never values you expect to read back from the app.

For each scenario, provide exact Playwright actions.
Respond with JSON only:
{
  "scenarios": [
    {
      "name": "Short scenario name",
      "description": "What this scenario tests",
      "type": "form_submit|search|navigation|data_entry|validation|validation_check|create_verify|edit_verify|publish_verify|delete_verify|login_positive|login_negative",
      "steps": [
        { "action": "fill|click|select|check|wait", "selector": "css selector", "value": "value if needed", "description": "what this step does" }
      ],
      "verifyAfter": "What to check after — e.g. success message, data in table, redirect URL",
      "testData": { "key": "value" }
    }
  ]
}
If no meaningful interactions possible on this page: {"scenarios":[]}`}
        ]}], 'Senior QA automation engineer. Respond only with valid JSON, no markdown backticks.', 8192);  // INCREASED from 4096 to 8192

        let result;
        try {
          result = parseJson(raw);
        } catch (parseErr) {
          log(`SCENARIO PARSING ERROR for ${pg.url}: ${parseErr.message}`);
          log(`Response length: ${raw.length} chars`);
          log(`Response preview (first 500 chars): ${raw.substring(0, 500)}`);
          
          // Find error position and show context
          const match = parseErr.message.match(/position (\d+)/);
          if (match) {
            const pos = parseInt(match[1]);
            const start = Math.max(0, pos - 150);
            const end = Math.min(raw.length, pos + 150);
            log(`Error context (position ${pos})`);
            log(`[${start}-${end}]: ...${raw.substring(start, end)}...`);
          }
          
          // Try to find where JSON starts and ends
          const jsonStart = raw.indexOf('{');
          const jsonEnd = raw.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            log(`JSON span: ${jsonStart} to ${jsonEnd} (length: ${jsonEnd - jsonStart})`);
            const last500 = raw.substring(Math.max(0, jsonEnd - 500), jsonEnd);
            log(`Last 500 chars of JSON: ...${last500}`);
          }
          
          throw new Error(`Invalid JSON from Claude: ${parseErr.message}`);
        }
        
        pageScenarios.push({url:pg.url,title:pg.title,scenarios:result.scenarios||[]});
        log(`Planned ${result.scenarios?.length||0} scenarios for: ${pg.title}`);
      } catch(e) {
        log(`Scenario planning failed for ${pg.url}: ${e.message}`);
        pageScenarios.push({url:pg.url,title:pg.title,scenarios:[]});
      }
    }

    // If the login page wasn't among the selected screens, still add the login
    // verification card so it always shows in the report.
    if (!loginCardEmitted) {
      log('Login page not in selected screens — emitting login verification card anyway');
      pageScenarios.unshift(loginPlan);
    }

    const totalScenarios = pageScenarios.reduce((s,p)=>s+p.scenarios.length,0);
    log(`Total scenarios planned: ${totalScenarios}`);

    scan.phase = 'Running scenarios';
    const transactions = [];
    let scenarioDone = 0;

    for (const pgPlan of pageScenarios) {
      try {
        const onlyLoginVerify = pgPlan.scenarios.length>0 && pgPlan.scenarios.every(s=>s.type==='login_positive'||s.type==='login_negative'||s.type==='login_verify');
        if (!onlyLoginVerify) {
          await page.goto(pgPlan.url,{waitUntil:'domcontentloaded',timeout:20000});
          await page.waitForTimeout(1000);
          const ss = (await page.screenshot()).toString('base64');

          const visRaw = await callClaude([{role:'user',content:[
            {type:'image',source:{type:'base64',media_type:'image/png',data:ss}},
            {type:'text',text:`QA visual check. URL: ${pgPlan.url} | Title: ${pgPlan.title}

Report ONLY clear, unambiguous rendering defects that are visible in THIS screenshot. Be conservative — when in doubt, do NOT report.

Report a bug only for: visibly broken/overlapping layout, raw error text or stack traces shown to the user, broken image icons, text overflowing or clipped so it's unreadable, or controls drawn on top of each other.

Do NOT report (these are normal, not bugs):
- Pagination: a paginated list showing only the first page is CORRECT. "Showing 1-10 of 13", page number buttons (1, 2, ...), and next/prev arrows are normal. Never claim the list is "partial" or "missing items" when pagination controls exist.
- A count (e.g. "13 surveys") that is higher than the number of visible rows — this is expected with pagination.
- Content below the fold / not in the screenshot (the screenshot is only the viewport).
- Empty states, "no data" messages, or empty optional sections.
- Loading spinners or skeletons.
- Anything you are not highly confident is an actual defect.

For each genuine bug, set a confidence and only include it if confidence is high.
Respond JSON only: {"bugs":[{"summary":"title","description":"details incl. where on screen","severity":"critical|high|medium|low","type":"ui|functional|content","confidence":"high"}]}
No clear bugs → {"bugs":[]}`}
          ]}], 'Senior QA engineer doing a visual smoke check. Only report defects you are highly confident are real. Normal UI patterns like pagination are NOT bugs. Respond only valid JSON.', 1024);

          const visResult = parseJson(visRaw);
          for (const b of (visResult.bugs||[])) {
            if (b.confidence && String(b.confidence).toLowerCase() !== 'high') {
              log(`Skipped low-confidence visual flag: ${b.summary}`);
              continue;
            }
            bugs.push({
              id:`bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
              summary:b.summary,
              description:`${b.description}\n\nPage: ${pgPlan.url}\nTitle: ${pgPlan.title}`,
              severity:b.severity||'medium', type:b.type||'ui',
              pageUrl:pgPlan.url, pageTitle:pgPlan.title,
              screenshot:ss, source:'visual_check',
              jiraPosted:false, jiraKey:null,
            });
            log(`Visual bug [${b.severity}]: ${b.summary}`);
          }
        }
      } catch(e) { log(`Visual check failed for ${pgPlan.url}: ${e.message}`); }

      for (const scenario of pgPlan.scenarios) {
        if (scenario.type === 'delete_verify') {
          if (!enableDelete) {
            log(`Skipped delete scenario "${scenario.name}" (delete disabled this run)`);
            continue;
          }
          const stepsText = JSON.stringify(scenario.steps||[]) + (scenario.verifyAfter||'');
          if (!stepsText.includes(TEST_TAG)) {
            log(`BLOCKED delete scenario "${scenario.name}" — does not target our tag ${TEST_TAG}; refusing to delete real data`);
            continue;
          }
        }
        scenarioDone++;
        scan.scenarioProgress = `${scenarioDone}/${totalScenarios}`;
        log(`Scenario [${scenarioDone}/${totalScenarios}]: ${scenario.name}`);

        const txn = {
          id:          `txn_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
          name:        scenario.name,
          description: scenario.description,
          type:        scenario.type,
          pageUrl:     pgPlan.url,
          pageTitle:   pgPlan.title,
          testData:    scenario.testData||{},
          steps:       [],
          status:      'running',
          result:      null,
          outcome:     '',
          dataSaved:   null,
          screenshotBefore: null,
          screenshotAfter:  null,
          bugs:        [],
          startedAt:   new Date().toISOString(),
        };

        try {
          // login_positive reflects the REAL login performed at scan start; it
          // does not navigate or re-submit credentials.
          if (scenario.type === 'login_positive' || scenario.type === 'login_verify') {
            const okLogin = !!scan._loginSucceeded;
            txn.steps.push({action:'login_positive', selector:'(login at scan start)', value:'(real credentials)',
                            description: okLogin ? 'Login succeeded with the provided credentials.' : 'Login did not succeed.',
                            status: okLogin ? 'done' : 'failed', error: okLogin ? null : 'Login failed'});
            txn.result  = okLogin ? 'pass' : 'fail';
            txn.outcome = okLogin
              ? 'Login with the provided credentials succeeded; the session reached the app past the login page.'
              : 'Login with the provided credentials did not succeed.';
            txn.status = 'done';
            log(`  Login (positive): ${okLogin ? 'PASS' : 'FAIL'}`);
            txn.completedAt = new Date().toISOString();
            transactions.push(txn);
            scan.transactions = transactions;
            scan.bugs = bugs;
            continue;
          }

          // login_negative ACTUALLY runs: it navigates to the login page, fills
          // the bad/empty credentials from the scenario steps, submits, and PASSES
          // only if login was correctly REJECTED (still on the login page or an
          // error is shown). This catches a broken login that wrongly lets bad
          // credentials through.
          if (scenario.type === 'login_negative') {
            const loginUrl = scan._loginUrl || pgPlan.url;
            await page.goto(loginUrl, {waitUntil:'domcontentloaded', timeout:20000});
            await page.waitForTimeout(800);
            txn.screenshotBefore = (await page.screenshot()).toString('base64');
            const beforeUrl = page.url();
            for (const step of (scenario.steps||[])) {
              const sr = {action:step.action,selector:step.selector,value:step.value,description:step.description,status:'pending',error:null};
              try {
                if (step.action==='fill') {
                  const loc = page.locator(step.selector).first();
                  if (await loc.count()) await reactFill(page, loc, step.value||'', log);
                } else if (step.action==='click') {
                  await page.locator(step.selector).first().click({timeout:6000});
                } else if (step.action==='wait') {
                  await page.waitForTimeout(parseInt(step.value)||800);
                }
                sr.status='done';
              } catch(e) { sr.status='failed'; sr.error=(e.message||'').split('\n')[0].slice(0,160); }
              txn.steps.push(sr);
              await page.waitForTimeout(400);
            }
            await page.waitForTimeout(1200);
            txn.screenshotAfter = (await page.screenshot()).toString('base64');
            // Rejected if a password field is still present, or URL unchanged, or an error is visible.
            const stillHasPw = (await page.$('input[type=password]')) !== null;
            const sameUrl = page.url() === beforeUrl;
            let errVisible = false;
            try {
              errVisible = await page.evaluate(() => {
                const sels=['.error','.alert','.alert-danger','.invalid-feedback','[role=alert]','.toast','.text-danger','.error-message'];
                for (const s of sels){const el=document.querySelector(s);const t=el&&el.textContent&&el.textContent.trim();if(t)return true;}
                const body=document.body?document.body.innerText:''; return /invalid|incorrect|wrong|required|failed|unauthor/i.test(body);
              });
            } catch(_) {}
            const rejected = stillHasPw || sameUrl || errVisible;
            txn.result = rejected ? 'pass' : 'fail';
            txn.status = 'done';
            txn.outcome = rejected
              ? 'Invalid/empty credentials were correctly rejected (stayed on login or showed an error).'
              : 'WARNING: invalid/empty credentials were NOT rejected — the app appeared to log in. This is a security concern.';
            if (!rejected) {
              const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
              bugs.push({ id:bugId, summary:`Login accepted invalid credentials: ${scenario.name}`,
                description:`A negative login test (${scenario.name}) was expected to be rejected, but the app appeared to authenticate.\n\nPage: ${loginUrl}`,
                severity:'high', type:'functional', pageUrl:loginUrl, pageTitle:pgPlan.title,
                screenshot:txn.screenshotAfter, source:'scenario', scenarioName:scenario.name, jiraPosted:false, jiraKey:null });
              txn.bugs.push(bugId);
            }
            // Restore the real logged-in session for subsequent scenarios.
            try {
              await page.goto(loginUrl, {waitUntil:'domcontentloaded', timeout:20000});
              if (await page.$('input[type=password]')) {
                await page.fill('input[type=password]', config.password).catch(()=>{});
                const uSel = 'input[type=text],input[type=email],input[name=username],input[name=email]';
                if (await page.$(uSel)) await page.fill(uSel, config.username).catch(()=>{});
                await page.keyboard.press('Enter').catch(()=>{});
                await page.waitForTimeout(1500);
              }
            } catch(_) {}
            log(`  Login (negative "${scenario.name}"): ${rejected ? 'PASS (rejected)' : 'FAIL (accepted!)'}`);
            txn.completedAt = new Date().toISOString();
            transactions.push(txn);
            scan.transactions = transactions;
            scan.bugs = bugs;
            continue;
          }

          await page.goto(pgPlan.url,{waitUntil:'domcontentloaded',timeout:20000});
          await page.waitForTimeout(800);
          txn.screenshotBefore = (await page.screenshot()).toString('base64');

          // validation_check: deliberately leave a required field empty and try
          // to save; PASS only if the app blocks it. Judged directly (not via the
          // screenshot evaluator) since the pass condition is specific.
          if (scenario.type === 'validation_check') {
            const vr = await smartValidationCheck(page, scenario, log);
            txn.screenshotAfter = (await page.screenshot()).toString('base64');
            txn.steps.push({action:'validation_check', selector:'(smart)', value:vr.fieldLeftEmpty||'',
                            description:vr.detail, status: vr.ok ? 'done' : 'failed',
                            error: vr.ok ? null : vr.detail});
            txn.result  = vr.ok ? 'pass' : 'fail';
            txn.status  = 'done';
            txn.outcome = vr.detail;
            if (!vr.ok && vr.blocked === false) {
              // The app accepted a blank required field — that's a real defect.
              const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
              bugs.push({ id:bugId,
                summary:`Missing required-field validation: "${vr.fieldLeftEmpty}" accepted empty`,
                description:`The create form accepted submission with the required field "${vr.fieldLeftEmpty}" left empty. A required field should block save and show a validation message.\n\nScenario: "${scenario.name}"\nPage: ${pgPlan.url}`,
                severity:'high', type:'functional', pageUrl:pgPlan.url, pageTitle:pgPlan.title,
                screenshot:txn.screenshotAfter, source:'scenario', scenarioName:scenario.name, jiraPosted:false, jiraKey:null });
              txn.bugs.push(bugId);
              log(`Scenario bug [high]: required-field validation missing for "${vr.fieldLeftEmpty}"`);
            }
            log(`  Validation check: ${vr.ok ? 'PASS (save blocked)' : 'FAIL (' + (vr.blocked===false?'save not blocked':'could not run') + ')'}`);
            txn.completedAt = new Date().toISOString();
            transactions.push(txn);
            scan.transactions = transactions;
            scan.bugs = bugs;
            continue;
          }

          // EDIT_VERIFY: edit an existing record and verify the change persists.
          if (scenario.type === 'edit_verify') {
            const er = await smartEditVerify(page, scenario, TEST_TAG, pgPlan.url, log);
            txn.steps.push({action:'edit_verify', selector:'(smart)', value:er.field||'',
                            description:er.detail, status: er.ok ? 'done' : 'failed',
                            error: er.ok ? null : er.detail});
            txn.result  = er.ok ? 'pass' : 'fail';
            txn.status  = 'done';
            txn.outcome = er.detail;
            if (!er.ok) {
              const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
              bugs.push({ id:bugId,
                summary:`Edit verification failed: changes did not persist`,
                description:`Edited the "${er.field}" field and saved, but the change was not found after reload.\n\nScenario: "${scenario.name}"\nPage: ${pgPlan.url}`,
                severity:'high', type:'functional', pageUrl:pgPlan.url, pageTitle:pgPlan.title,
                screenshot:txn.screenshotAfter, source:'scenario', scenarioName:scenario.name, jiraPosted:false, jiraKey:null });
              txn.bugs.push(bugId);
              log(`Scenario bug [high]: edit verification failed for "${er.field}"`);
            }
            log(`  Edit verify: ${er.ok ? 'PASS' : 'FAIL'} — ${er.detail.slice(0,80)}`);
            txn.completedAt = new Date().toISOString();
            transactions.push(txn);
            scan.transactions = transactions;
            scan.bugs = bugs;
            continue;
          }

          // PUBLISH_VERIFY: find and publish the record created this run, verify it's published.
          if (scenario.type === 'publish_verify') {
            const tryClick = async (locator) => {
              try { await locator.first().click({timeout:5000}); return true; } catch(_) { return false; }
            };
            let published = false;
            let detail = '';
            try {
              // Go to list and search for the test record
              await page.goto(pgPlan.url, {waitUntil:'domcontentloaded', timeout:20000});
              await page.waitForTimeout(1000);
              const searchBox = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
              if (await searchBox.count() && await searchBox.isVisible().catch(()=>false)) {
                await reactFill(page, searchBox, TEST_TAG, log);
                await page.waitForTimeout(1500);
              }
              // Find the row with our tag and look for a Publish/Activate button
              let publishClicked = false;
              try {
                const row = page.locator('tr, [role=row], li').filter({ hasText: TEST_TAG }).first();
                if (await row.count()) {
                  // Try to click a Publish button in the row
                  for (const text of ['Publish', 'Activate', 'Enable', 'Approve', 'Go Live']) {
                    const btn = row.getByRole('button', {name: new RegExp(text, 'i')});
                    if (await btn.count() && await tryClick(btn)) {
                      publishClicked = true;
                      log(`  Clicked "${text}" button on ${TEST_TAG} record`);
                      break;
                    }
                  }
                  if (!publishClicked && await tryClick(row)) {
                    // Try clicking the row itself to open it
                    await page.waitForTimeout(1000);
                  }
                }
              } catch(_) {}
              if (!publishClicked) {
                // Try a generic Publish button anywhere on the page
                for (const text of ['Publish', 'Publish Record', 'Publish All', 'Activate']) {
                  const btn = page.getByRole('button', {name: new RegExp(text, 'i')});
                  if (await btn.count() && await btn.first().isEnabled().catch(()=>false)) {
                    if (await tryClick(btn)) { publishClicked = true; break; }
                  }
                }
              }
              await page.waitForTimeout(1500);
              // Verify the record is now published - look for "published", "active", "live", "enabled" status
              try {
                await page.goto(pgPlan.url, {waitUntil:'domcontentloaded', timeout:20000});
                await page.waitForTimeout(1000);
                const sb = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
                if (await sb.count() && await sb.isVisible().catch(()=>false)) {
                  await reactFill(page, sb, TEST_TAG, log);
                  await page.waitForTimeout(1500);
                }
                // Check if published status is visible
                const pageText = await page.evaluate(() => document.body?.innerText || '');
                published = /published|active|live|enabled|draft.*no|status.*published/i.test(pageText);
              } catch(_) {}
              detail = published
                ? `Successfully published ${TEST_TAG} and verified published status is visible`
                : publishClicked
                  ? `Publish action executed but could not verify published status appeared`
                  : `Could not find or click a Publish button for ${TEST_TAG}`;
            } catch(e) {
              detail = `Publish verification error: ${e.message}`;
            }
            txn.steps.push({action:'publish_verify', selector:'(smart)', value:TEST_TAG,
                            description:detail, status: published ? 'done' : 'failed',
                            error: published ? null : detail});
            txn.result = published ? 'pass' : 'partial';
            txn.status = 'done';
            txn.outcome = detail;
            log(`  Publish verify: ${published ? 'PASS' : 'PARTIAL'} — ${detail.slice(0,80)}`);
            txn.completedAt = new Date().toISOString();
            transactions.push(txn);
            scan.transactions = transactions;
            scan.bugs = bugs;
            continue;
          }

          // For create_verify, use the smart filler: it opens the form, reads the
          // REAL fields, and fills them (tag into name, valid values elsewhere).
          if (scenario.type === 'create_verify') {
            const cr = await smartCreateFill(page, scenario, TEST_TAG, log);
            txn.steps.push({action:'create_verify', selector:'(smart)', value:TEST_TAG,
                            description:cr.detail, status: cr.ok ? 'done' : 'failed',
                            error: cr.ok ? null : cr.detail});
            // After submitting, the app often lands on an Edit/detail page rather
            // than the list. Navigate BACK to the list page so the verify step
            // (and any later delete) can actually see the new row. Then search for
            // the tag if a search box exists, so the new record is visible even
            // when the list is paginated.
            try {
              await page.goto(pgPlan.url, {waitUntil:'domcontentloaded', timeout:20000});
              await page.waitForTimeout(1500);
              const searchBox = page.locator('input[type=search], input[placeholder*=earch], input[placeholder*=Search]').first();
              if (await searchBox.count() && await searchBox.isVisible().catch(()=>false)) {
                await reactFill(page, searchBox, TEST_TAG, log);
                await page.waitForTimeout(1500);
                log('  Returned to list and searched for ' + TEST_TAG + ' to verify creation');
              } else {
                log('  Returned to list page to verify creation');
              }
            } catch(e) { log('  Could not return to list after create: ' + e.message); }
          } else {
            for (const step of (scenario.steps||[])) {
              const stepResult = {action:step.action,selector:step.selector,value:step.value,description:step.description,status:'pending',error:null};
              const T = 8000;
              try {
                if (step.action==='fill') {
                  const loc = page.locator(step.selector).first();
                  if (!(await loc.count())) throw new Error('fill target not found: '+step.selector);
                  const okFill = await reactFill(page, loc, step.value||'', log);
                  if (!okFill) throw new Error('fill action failed to set value on '+step.selector);
                }
                else if (step.action==='click') {
                  await page.locator(step.selector).first().click({timeout:T});
                }
                else if (step.action==='select') {
                  const sel = page.locator(step.selector).first();
                  const want = step.value||'';
                  try {
                    await sel.selectOption(want, {timeout:T});
                  } catch(e1) {
                    let done = false;
                    try { await sel.selectOption({label: want}, {timeout:2000}); done = true; } catch(_) {}
                    if (!done) {
                      const opts = await sel.locator('option').evaluateAll(
                        els => els.map(o=>({value:o.value, label:(o.textContent||'').trim()}))
                      );
                      const pick = opts.find(o => o.value && !/^(select|choose|--)/i.test(o.label));
                      if (pick) {
                        await sel.selectOption(pick.value, {timeout:T});
                        stepResult.note = `requested "${want}" not found; selected "${pick.label}" instead`;
                        done = true;
                      }
                    }
                    if (!done) throw e1;
                  }
                }
                else if (step.action==='check')  await page.locator(step.selector).first().check({timeout:T});
                else if (step.action==='wait')   await page.waitForTimeout(parseInt(step.value)||1000);
                else if (step.action==='waitForSelector') await page.waitForSelector(step.selector,{timeout:T});
                else if (step.action==='upload_attachment') {
                  let filePath = step.value||'';
                  if (!filePath) throw new Error('upload_attachment requires a file path in the value field');
                  // Normalize file path: handle escaped backslashes from JSON and Windows paths
                  filePath = filePath.replace(/\\\\\\\\/g, '\\').replace(/\\\\/g, '\\');
                  // If selector is an XPath (starts with /), use CSS selector fallback
                  let selector = step.selector||'';
                  if (selector.startsWith('/')) {
                    // XPath not supported by Playwright locator; use CSS fallback
                    selector = 'input[type=file]';
                    log(`  [upload_attachment] XPath detected, using CSS fallback: ${selector}`);
                  }
                  const loc = page.locator(selector).first();
                  if (!(await loc.count())) throw new Error('file input not found: '+selector);
                  await loc.setInputFiles(filePath, {timeout:T});
                  log(`    Uploaded file: ${filePath} to ${selector}`);
                }
                else if (step.action==='navigate')        await page.goto(step.value,{waitUntil:'domcontentloaded',timeout:20000});
                stepResult.status = 'done';
              } catch(e) {
                stepResult.status = 'failed';
                stepResult.error  = (e.message||'').split('\n')[0].slice(0,160);
                log(`  Step failed: ${step.description} — ${stepResult.error}`);
              }
              txn.steps.push(stepResult);
              await page.waitForTimeout(500);
            }
          }

          await page.waitForTimeout(1500);
          txn.screenshotAfter = (await page.screenshot()).toString('base64');

          const evalRaw = await callClaude([{role:'user',content:[
            {type:'text',text:`BEFORE screenshot:`},
            {type:'image',source:{type:'base64',media_type:'image/png',data:txn.screenshotBefore}},
            {type:'text',text:`AFTER screenshot (after executing scenario):`},
            {type:'image',source:{type:'base64',media_type:'image/png',data:txn.screenshotAfter}},
            {type:'text',text:`Scenario: "${scenario.name}"
Description: ${scenario.description}
Type: ${scenario.type}
Test data used: ${JSON.stringify(scenario.testData||{})}
Expected outcome: ${scenario.verifyAfter}
Steps executed: ${txn.steps.map(s=>`${s.action}(${s.selector||''}) → ${s.status}`).join(', ')}

Evaluate what happened:
1. Did the scenario complete successfully?
2. Was data saved/submitted correctly?
3. Are there any bugs visible in the after screenshot?
4. What exactly changed between before and after?

CRITICAL judging rules — avoid false failures:
- The application's ACTUAL data is the source of truth. Do NOT fail a scenario because the results differ from a number or record named in the scenario/testData — those were guesses made before seeing real data and may be wrong.
- For filter/search scenarios: PASS if the filter applied and the list updated to a consistent subset (or correctly shows an empty state). Showing fewer rows, more rows, or zero rows than expected is CORRECT if it reflects the real data. A status with no records legitimately shows an empty/short list — that is a PASS, not a fail.
- Do NOT report "test data references wrong survey", "unexpected extra row", or "expected N but saw M" as bugs. A mismatch between guessed expectations and real data is NOT a defect.
- Normal UI behavior (a row expanding on click/selection, a panel opening, default sorting) is NOT a bug.
- Only mark fail when the action genuinely did not work: the control didn't respond, an error/stack trace appeared, the page broke, or a save clearly failed. Only report bugs you are highly confident are real defects in the app itself.
- If the action worked and the page behaved sensibly, result is "pass" even if you cannot verify exact data values.

Respond JSON only:
{
  "result": "pass|fail|partial",
  "outcome": "1-2 sentence summary of what actually happened",
  "dataSaved": true/false/null,
  "dataDetails": "what data was saved or why it wasn't",
  "changesObserved": "what visually changed between before and after",
  "bugs": [
    {"summary":"bug title","description":"detailed bug description","severity":"critical|high|medium|low"}
  ]
}`}
          ]}], 'Senior QA engineer evaluating test results. Respond only valid JSON.', 1500);

          const evalResult = parseJson(evalRaw);
          txn.result      = evalResult.result || 'partial';
          txn.outcome     = evalResult.outcome || '';
          txn.dataSaved   = evalResult.dataSaved ?? null;
          txn.dataDetails = evalResult.dataDetails || '';
          txn.changesObserved = evalResult.changesObserved || '';
          txn.status      = 'done';

          if (scenario.type === 'create_verify') {
            const verified = txn.result === 'pass';
            scan.createdRecords.push({ tag:TEST_TAG, page:pgPlan.title, url:pgPlan.url, verify: verified?'PASS':'FAIL', deleted:false });
            log(`Created test record "${TEST_TAG}" on ${pgPlan.title} — verify: ${verified?'PASS':'FAIL'}`);
          } else if (scenario.type === 'delete_verify') {
            const rec = [...scan.createdRecords].reverse().find(r => r.url===pgPlan.url && !r.deleted);
            if (rec) rec.deleted = (txn.result === 'pass');
            log(`Deleted test record "${TEST_TAG}" on ${pgPlan.title} — ${txn.result==='pass'?'PASS':'FAIL'}`);
          }

          for (const b of (evalResult.bugs||[])) {
            const bugId = `bug_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
            const bugObj = {
              id:bugId, summary:b.summary,
              description:`${b.description}\n\nFound during scenario: "${scenario.name}"\nPage: ${pgPlan.url}`,
              severity:b.severity||'medium', type:'functional',
              pageUrl:pgPlan.url, pageTitle:pgPlan.title,
              screenshot:txn.screenshotAfter, source:'scenario',
              scenarioName:scenario.name,
              jiraPosted:false, jiraKey:null,
            };
            bugs.push(bugObj);
            txn.bugs.push(bugId);
            log(`Scenario bug [${b.severity}]: ${b.summary}`);
          }

          log(`  Result: ${txn.result} — ${txn.outcome?.slice(0,80)}`);

        } catch(e) {
          txn.status  = 'error';
          txn.result  = 'fail';
          txn.outcome = `Scenario execution error: ${e.message}`;
          log(`  Scenario error: ${e.message}`);
        }

        txn.completedAt = new Date().toISOString();
        transactions.push(txn);
        scan.transactions = transactions;
        scan.bugs         = bugs;
      }
    }

    scan.transactions    = transactions;
    scan.bugs            = bugs;
    scan.pages           = pages.map(p=>({url:p.url,title:p.title,screenshot:p.screenshot}));
    scan.status          = 'completed';
    scan.phase           = 'Done';
    scan.completed_at    = new Date().toISOString();
    scan.scenarioProgress = `${scenarioDone}/${totalScenarios}`;

    const passed  = transactions.filter(t=>t.result==='pass').length;
    const failed  = transactions.filter(t=>t.result==='fail').length;
    const partial = transactions.filter(t=>t.result==='partial').length;
    log(`Scan complete — ${pages.length} pages, ${transactions.length} scenarios (✅${passed} ❌${failed} ⚠️${partial}), ${bugs.length} bugs`);

  } catch(err) {
    console.error(`[AutoScan:${scanId}] Fatal:`, err.message);
    scan.status='failed'; scan.phase='Failed'; scan.error=err.message;
  } finally {
    try { await browser?.close(); } catch(_) {}
    try { await dbPool?.end(); } catch(_) {}
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

router.post('/start', (req, res) => {
  const { url, username, password, maxPages, jiraUrl, jiraEmail, jiraToken, jiraProjectKey, db, dbChecks, enableDelete } = req.body;
  if (!url||!username||!password) return res.status(400).json({error:'url, username, password required'});
  const scanId = newId();
  scans.set(scanId, {
    id:scanId, url, username, maxPages:maxPages||15,
    jiraUrl, jiraEmail, jiraToken, jiraProjectKey,
    status:'queued', phase:'Starting',
    logs:[], bugs:[], pages:[], transactions:[],
    pagesDiscovered:0, analysisProgress:'0/0', scenarioProgress:'0/0',
    started_at:null, completed_at:null, error:null,
    _rerunConfig:{url,username,password,maxPages:maxPages||15, db, dbChecks, enableDelete:!!enableDelete},
  });
  runScan(scanId, {url,username,password,maxPages:maxPages||15, db, dbChecks, enableDelete:!!enableDelete}).catch(()=>{});
  res.json({scanId, status:'queued'});
});

// One-click rerun: launches a fresh scan with the EXACT same settings (incl.
// credentials) as a previous scan. Returns the new scanId.
router.post('/:scanId/rerun', (req, res) => {
  const prev = scans.get(req.params.scanId);
  if (!prev) return res.status(404).json({error:'Scan not found'});
  const cfg = prev._rerunConfig;
  if (!cfg) return res.status(400).json({error:'This scan has no saved config to rerun (it may predate the rerun feature, or the server was restarted).'});

  const scanId = newId();
  scans.set(scanId, {
    id:scanId, url:cfg.url, username:cfg.username, maxPages:cfg.maxPages,
    jiraUrl:prev.jiraUrl, jiraEmail:prev.jiraEmail, jiraToken:prev.jiraToken, jiraProjectKey:prev.jiraProjectKey,
    status:'queued', phase:'Starting',
    logs:[], bugs:[], pages:[], transactions:[],
    pagesDiscovered:0, analysisProgress:'0/0', scenarioProgress:'0/0',
    started_at:null, completed_at:null, error:null,
    rerunOf: prev.id,
    _rerunConfig: cfg,
  });
  runScan(scanId, cfg).catch(()=>{});
  res.json({scanId, status:'queued', rerunOf:prev.id});
});

router.get('/list', (req, res) => {
  const list = [...scans.values()]
    .sort((a,b)=>(b.started_at||'').localeCompare(a.started_at||''))
    .slice(0,20)
    .map(s=>({id:s.id,url:s.url,status:s.status,phase:s.phase,
              bugCount:s.bugs.length,pageCount:s.pages.length,
              txnCount:s.transactions.length,
              started_at:s.started_at,completed_at:s.completed_at}));
  res.json({scans:list});
});

router.get('/:scanId', (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const {pages, _rerunConfig, _loginUrl, _loginSucceeded, ...rest} = s;
  const txnsLight = s.transactions.map(t=>({
    ...t,
    screenshotBefore: undefined,
    screenshotAfter:  undefined,
  }));
  res.json({...rest, transactions:txnsLight, pageCount:pages.length, dbCheckResults: s.dbCheckResults||[], pages:pages.map(p=>({url:p.url,title:p.title}))});
});

router.get('/:scanId/screenshot/:idx', (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const pg = s.pages[parseInt(req.params.idx)];
  if (!pg) return res.status(404).json({error:'Page not found'});
  res.set('Content-Type','image/png').send(Buffer.from(pg.screenshot,'base64'));
});

router.get('/:scanId/bug-screenshot/:bugId', (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const bug = s.bugs.find(b=>b.id===req.params.bugId);
  if (!bug||!bug.screenshot) return res.status(404).json({error:'Bug screenshot not found'});
  res.set('Content-Type','image/png').send(Buffer.from(bug.screenshot,'base64'));
});

router.get('/:scanId/txn-screenshot/:txnId/:which', (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const txn = s.transactions.find(t=>t.id===req.params.txnId);
  if (!txn) return res.status(404).json({error:'Transaction not found'});
  const ss = req.params.which==='after' ? txn.screenshotAfter : txn.screenshotBefore;
  if (!ss) return res.status(404).json({error:'Screenshot not found'});
  res.set('Content-Type','image/png').send(Buffer.from(ss,'base64'));
});

router.post('/:scanId/post-bug/:bugId', async (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const bug = s.bugs.find(b=>b.id===req.params.bugId);
  if (!bug) return res.status(404).json({error:'Bug not found'});
  const jiraUrl=req.body.jiraUrl||s.jiraUrl, jiraEmail=req.body.jiraEmail||s.jiraEmail,
        jiraToken=req.body.jiraToken||s.jiraToken, projectKey=req.body.jiraProjectKey||s.jiraProjectKey;
  if (!jiraUrl||!jiraEmail||!jiraToken||!projectKey)
    return res.status(400).json({error:'JIRA config required'});
  try {
    const r = await postToJira({jiraUrl,jiraEmail,jiraToken,projectKey,
      summary:`[AutoScan] ${bug.summary}`, description:bug.description,
      priority:SEV_MAP[bug.severity?.toLowerCase()]||'Medium'});
    bug.jiraPosted=true; bug.jiraKey=r.key;
    res.json({success:true,jiraKey:r.key,url:`${jiraUrl}/browse/${r.key}`});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/:scanId/post-all', async (req, res) => {
  const s = scans.get(req.params.scanId);
  if (!s) return res.status(404).json({error:'Scan not found'});
  const jiraUrl=req.body.jiraUrl||s.jiraUrl, jiraEmail=req.body.jiraEmail||s.jiraEmail,
        jiraToken=req.body.jiraToken||s.jiraToken, projectKey=req.body.jiraProjectKey||s.jiraProjectKey;
  if (!jiraUrl||!jiraEmail||!jiraToken||!projectKey)
    return res.status(400).json({error:'JIRA config required'});
  const results=[];
  for (const bug of s.bugs.filter(b=>!b.jiraPosted)) {
    try {
      const r = await postToJira({jiraUrl,jiraEmail,jiraToken,projectKey,
        summary:`[AutoScan] ${bug.summary}`, description:bug.description,
        priority:SEV_MAP[bug.severity?.toLowerCase()]||'Medium'});
      bug.jiraPosted=true; bug.jiraKey=r.key;
      results.push({bugId:bug.id,jiraKey:r.key,success:true});
    } catch(e) { results.push({bugId:bug.id,error:e.message,success:false}); }
  }
  res.json({posted:results.filter(r=>r.success).length,failed:results.filter(r=>!r.success).length,results});
});

const fs   = require('fs');
const path = require('path');
const MAPPING_FILE = path.join(__dirname, 'auto_scan_db_mappings.json');

const discoveries = new Map();
function newDiscoveryId() { return 'disc_' + Date.now() + '_' + Math.random().toString(36).slice(2,6); }

function loadMappings() {
  try { return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8')); }
  catch(_) { return {}; }
}
function saveMappings(all) {
  try { fs.writeFileSync(MAPPING_FILE, JSON.stringify(all, null, 2)); return true; }
  catch(e) { console.error('[AutoScan] saveMappings failed:', e.message); return false; }
}
function getSavedChecks(origin) {
  const all = loadMappings();
  return Array.isArray(all[origin]) ? all[origin] : [];
}
function setSavedChecks(origin, checks) {
  const all = loadMappings();
  all[origin] = checks;
  return saveMappings(all);
}

async function loginAndCrawl(config, log) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox','--disable-setuid-sandbox'] });
  const ctx  = await browser.newContext({ viewport:{width:1280,height:800}, ignoreHTTPSErrors:true });
  const page = await ctx.newPage();

  const apiByPage = {};
  let currentPageUrl = config.url;
  const summariseJson = (data) => {
    const out = { count:null, countFields:{}, sample:null };
    try {
      if (Array.isArray(data)) { out.count = data.length; out.sample = data[0] ?? null; }
      else if (data && typeof data === 'object') {
        for (const k of ['data','items','results','rows','records','content','surveys','list']) {
          if (Array.isArray(data[k])) { out.count = data[k].length; out.sample = data[k][0] ?? null; break; }
        }
        for (const k of ['total','totalCount','total_count','count','totalElements','totalItems','recordsTotal']) {
          if (typeof data[k] === 'number') out.countFields[k] = data[k];
        }
      }
    } catch(_) {}
    return out;
  };
  page.on('response', async (resp) => {
    try {
      const ct = (resp.headers()['content-type']||'');
      if (!/application\/json/i.test(ct)) return;
      const u = resp.url();
      if (/anthropic\.com/.test(u)) return;
      const req = resp.request();
      if (!['GET','POST'].includes(req.method())) return;
      let data; try { data = await resp.json(); } catch(_) { return; }
      const s = summariseJson(data);
      if (s.count === null && Object.keys(s.countFields).length === 0) return;
      (apiByPage[currentPageUrl] = apiByPage[currentPageUrl] || []).push({
        url:u, status:resp.status(), method:req.method(), count:s.count, countFields:s.countFields,
      });
    } catch(_) {}
  });

  const out = { browser, page, pages:[], apiByPage, loginUrl:null, loginSucceeded:false, postLoginUrl:null, error:null };

  await page.goto(config.url, {waitUntil:'domcontentloaded',timeout:30000});
  try { await page.waitForSelector('input[type=password],input[type=text],input[type=email]', {timeout:10000}); } catch(_) {}
  await page.waitForTimeout(1000);
  const loginSS = (await page.screenshot()).toString('base64');
  const hasPwField = await page.$('input[type=password]') !== null;

  log('Asking Claude to identify login form');
  let loginData;
  try {
    const raw = await callClaude([{role:'user',content:[
      {type:'image',source:{type:'base64',media_type:'image/png',data:loginSS}},
      {type:'text',text:'This is a login page screenshot. Respond with JSON only:\n{"usernameSelector":"css selector","passwordSelector":"css selector","submitSelector":"css selector"}\nIf this is NOT a login page respond: {"isNotLoginPage":true}'}
    ]}], 'You are a web automation expert. Respond only with valid JSON, no markdown.', 512);
    loginData = parseJson(raw);
  } catch(e) {
    loginData = { usernameSelector:'input[type=text],input[type=email],input[name=username],input[name=email]',
                  passwordSelector:'input[type=password]', submitSelector:'button[type=submit],input[type=submit]' };
  }
  if (hasPwField) {
    loginData.isNotLoginPage = false;
    if (!loginData.passwordSelector) loginData.passwordSelector = 'input[type=password]';
    if (!loginData.usernameSelector) loginData.usernameSelector = 'input[type=text],input[type=email],input[name=username],input[name=email]';
    if (!loginData.submitSelector)   loginData.submitSelector   = 'button[type=submit],input[type=submit],button';
  }

  if (!loginData.isNotLoginPage) {
    const preLoginUrl = page.url();
    out.loginUrl = preLoginUrl;
    const onLoginPage = async () => (await page.$(loginData.passwordSelector)) !== null && page.url() === preLoginUrl;
    try {
      const preErr = await page.evaluate(() => (document.body?document.body.innerText:'').slice(0,1000));
      if (/too many|rate.?limit|try again later/i.test(preErr)) {
        log('Login page already shows a rate-limit message — not submitting.');
        throw new Error('rate-limited-before-submit');
      }
      await page.fill(loginData.usernameSelector, config.username);
      await page.fill(loginData.passwordSelector, config.password);
      try { await page.click(loginData.submitSelector, {timeout:5000}); }
      catch(_) { try { await page.press(loginData.passwordSelector, 'Enter'); } catch(_) {} }
      try {
        await page.waitForFunction(
          (a)=>window.location.href!==a.prev || !document.querySelector(a.pwSel),
          {prev:preLoginUrl, pwSel:loginData.passwordSelector}, {timeout:12000});
      } catch(_) {}
      if (!(await onLoginPage())) {
        await page.waitForTimeout(1500);
        out.loginSucceeded = true;
        log(`Login done — now at ${page.url()}`);
      } else {
        let errMsg='';
        try {
          errMsg = await page.evaluate(() => {
            const sels=['.error','.alert','.alert-danger','.invalid-feedback','[role=alert]','.toast','.text-danger','.error-message'];
            for (const s of sels){const el=document.querySelector(s);const t=el&&el.textContent&&el.textContent.trim();if(t)return t.slice(0,200);}
            const body=document.body?document.body.innerText:''; const m=body.match(/.{0,60}(invalid|incorrect|wrong|failed|rate.?limit|too many|locked|unauthor).{0,60}/i);
            return m?m[0].trim().slice(0,200):'';
          });
        } catch(_) {}
        log(errMsg ? `WARNING: login failed — app says: "${errMsg}"` : 'WARNING: login may have failed.');
        out.error = errMsg || 'Login failed';
      }
    } catch(e) { log(`Login interaction failed: ${e.message}`); out.error = e.message; }
  }
  await page.waitForTimeout(2000);
  out.postLoginUrl = page.url();
  log(`Landed at: ${out.postLoginUrl}`);

  if (out.loginUrl && !out.loginSucceeded) {
    const stillOnLogin = /login|signin|sign-in/i.test(out.postLoginUrl) || page.url() === out.loginUrl;
    if (stillOnLogin) { log('Login did not succeed — skipping crawl.'); return out; }
  }

  const baseOrigin = new URL(config.url).origin;
  const isLoginUrl = (u)=> out.loginUrl && u === out.loginUrl;
  const visited=new Set(), queue=[out.postLoginUrl], pages=[];
  const maxPgs = Math.min(config.maxPages||15, 100);
  if (out.loginUrl && !queue.includes(out.loginUrl)) queue.push(out.loginUrl);

  while (queue.length && pages.length < maxPgs) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    try {
      currentPageUrl = url;
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});
      await page.waitForTimeout(1200);
      currentPageUrl = page.url();
      const title = await page.title();
      const ss = (await page.screenshot()).toString('base64');
      const domInfo = await page.evaluate(() => {
        const forms=document.querySelectorAll('form');
        const inputs=document.querySelectorAll('input:not([type=hidden]),select,textarea');
        const btns=document.querySelectorAll('button,input[type=submit]');
        const tables=document.querySelectorAll('table');
        return { formCount:forms.length, inputCount:inputs.length, buttonCount:btns.length, tableCount:tables.length,
                 buttons:[...btns].map(b=>b.textContent?.trim()).filter(Boolean).slice(0,10),
                 inputTypes:[...inputs].map(i=>({type:i.type||i.tagName,name:i.name||i.placeholder||'',id:i.id})).slice(0,15) };
      });
      const apiHits = apiByPage[page.url()] || apiByPage[url] || [];
      let apiTotal = null;
      for (const a of apiHits) {
        const tv = Object.values(a.countFields)[0];
        if (typeof tv === 'number') { apiTotal = tv; break; }
        if (a.count != null && apiTotal == null) apiTotal = a.count;
      }
      pages.push({url:page.url(),title,screenshot:ss,domInfo,apiTotal});
      log(`Page ${pages.length}: ${title} (${domInfo.formCount} forms, ${domInfo.inputCount} inputs)${apiTotal!=null?` | count=${apiTotal}`:''}`);
      const links = await page.evaluate((o)=>[...document.querySelectorAll('a[href]')].map(a=>a.href)
        .filter(h=>h.startsWith(o)&&!/#$|#\/?$/.test(h)&&!/logout|signout|sign-out/i.test(h)).slice(0,20), baseOrigin);
      for (const l of links) if (!visited.has(l)&&!queue.includes(l)) queue.push(l);
    } catch(e) { log(`Crawl failed ${url}: ${e.message}`); }
  }
  if (out.loginUrl) {
    const idx = pages.findIndex(p=>isLoginUrl(p.url));
    if (idx>-1 && idx<pages.length-1) { const [lp]=pages.splice(idx,1); pages.push(lp); }
  }
  log(`Crawl complete — ${pages.length} pages found`);
  out.pages = pages;
  return out;
}

async function runDiscovery(discId, config) {
  const disc = discoveries.get(discId);
  const log = (m) => { console.log(`[Discover:${discId}] ${m}`); disc.logs.push({t:new Date().toISOString(),m}); };
  let handles;
  try {
    disc.status='running';
    log('Launching browser');
    if (config.db && config.db.host) {
      let pool;
      try { pool = makePgPool(config.db); await pool.query('SELECT 1'); disc.dbOk = true; log('DB connection OK'); }
      catch(e) { disc.dbOk = false; log(`DB connection failed: ${e.message}`); }
      finally { try { await pool?.end(); } catch(_) {} }
    }
    handles = await loginAndCrawl(config, log);
    if (handles.error && !handles.pages.length) { disc.status='failed'; disc.error=handles.error; return; }
    const origin = new URL(config.url).origin;
    const saved = getSavedChecks(origin);
    disc.origin = origin;
    disc.screens = handles.pages.map((p,i) => {
      const existing = saved.find(s => s.urlMatch && p.url.includes(s.urlMatch));
      return { idx:i, url:p.url, title:p.title, apiTotal:p.apiTotal ?? null,
               hasForm: p.domInfo.formCount>0 || p.domInfo.inputCount>0,
               savedQuery: existing ? existing.query : null,
               savedLabel: existing ? existing.label : null };
    });
    disc.screenshots = handles.pages.map(p=>p.screenshot);
    disc.status='completed';
    log(`Discovery complete — ${disc.screens.length} screens`);
  } catch(e) {
    disc.status='failed'; disc.error=e.message;
    console.error(`[Discover:${discId}] Fatal:`, e.message);
  } finally {
    try { await handles?.browser?.close(); } catch(_) {}
  }
}

router.post('/discover', (req, res) => {
  const { url, username, password, maxPages, db } = req.body;
  if (!url||!username||!password) return res.status(400).json({error:'url, username, password required'});
  const discId = newDiscoveryId();
  discoveries.set(discId, {
    id:discId, url, status:'queued', logs:[], screens:[], screenshots:[],
    origin:null, dbOk:null, error:null,
    _config:{url,username,password,maxPages:maxPages||15},
  });
  runDiscovery(discId, {url,username,password,maxPages:maxPages||15, db}).catch(()=>{});
  res.json({discoveryId:discId, status:'queued'});
});

router.get('/discover/:discId', (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) return res.status(404).json({error:'Discovery not found'});
  const { screenshots, _config, ...rest } = d;
  res.json(rest);
});

router.get('/discover/:discId/screenshot/:idx', (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) return res.status(404).json({error:'Discovery not found'});
  const ss = d.screenshots[parseInt(req.params.idx)];
  if (!ss) return res.status(404).json({error:'Screenshot not found'});
  res.set('Content-Type','image/png').send(Buffer.from(ss,'base64'));
});

router.post('/discover/:discId/queries', async (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) return res.status(404).json({error:'Discovery not found'});
  const { db, checks } = req.body;
  if (!Array.isArray(checks)) return res.status(400).json({error:'checks array required'});
  if (!db || !db.host) return res.status(400).json({error:'db connection required to validate queries'});

  let pool; const results = [];
  try {
    pool = makePgPool(db);
    await pool.query('SELECT 1');
    for (const c of checks) {
      const entry = { urlMatch:c.urlMatch, label:c.label||c.urlMatch, query:c.query, apiMatch:c.apiMatch };
      if (!c.query || !c.urlMatch) { results.push({...entry, ok:false, error:'urlMatch and query required'}); continue; }
      if (!isReadOnlySql(c.query)) { results.push({...entry, ok:false, error:'Only read-only SELECT/WITH queries allowed'}); continue; }
      try { const n = await runDbCount(pool, c.query); results.push({...entry, ok:true, dbCount:n}); }
      catch(e) { results.push({...entry, ok:false, error:e.message}); }
    }
  } catch(e) {
    return res.status(400).json({error:`DB connection failed: ${e.message}`});
  } finally { try { await pool?.end(); } catch(_) {} }

  const valid = results.filter(r=>r.ok).map(r=>({urlMatch:r.urlMatch, label:r.label, query:r.query, apiMatch:r.apiMatch}));
  if (d.origin) setSavedChecks(d.origin, valid);
  res.json({ origin:d.origin, validated:results, savedCount:valid.length });
});

router.get('/mappings', (req, res) => {
  const origin = req.query.origin;
  if (origin) return res.json({origin, checks:getSavedChecks(origin)});
  res.json(loadMappings());
});

// ── PHASE 2.5: REFINE (new!) ────────────────────────────────────────────────
// Generate context questions to make scenarios more appropriate
router.post('/discover/:discId/refine-questions', async (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) return res.status(404).json({error:'Discovery not found'});
  
  const { pageIndices } = req.body; // Array of page indices to get questions for
  if (!Array.isArray(pageIndices)) return res.status(400).json({error:'pageIndices array required'});
  
  const questions = [];
  
  try {
    for (const idx of pageIndices) {
      const pg = d.screens[idx];
      if (!pg) continue;
      
      const prompt = `Analyze this page and suggest 3-5 KEY questions that would help create better test scenarios.

Page: ${pg.title}
URL: ${pg.url}
DOM: ${JSON.stringify(pg.domInfo)}

For each question, suggest what information would improve scenario planning.

Respond with ONLY valid JSON (no markdown):
{
  "pageTitle": "${pg.title}",
  "pageUrl": "${pg.url}",
  "questions": [
    {
      "id": "q1",
      "question": "What is the primary business workflow on this page?",
      "hint": "E.g., Create → Edit → Publish → Delete or Import → Review → Approve",
      "type": "text"
    },
    {
      "id": "q2",
      "question": "What are the required fields?",
      "hint": "List field names separated by commas",
      "type": "text"
    },
    {
      "id": "q3",
      "question": "What validation rules or constraints exist?",
      "hint": "E.g., No duplicate names, email format required, max 100 chars",
      "type": "text"
    },
    {
      "id": "q4",
      "question": "What are common error/failure scenarios?",
      "hint": "E.g., Network timeout, insufficient permissions, invalid data format",
      "type": "text"
    }
  ]
}`;
      
      try {
        const raw = await callClaude([{role:'user', content: prompt}], 'You are a QA expert. Respond only with valid JSON.', 1500);
        const result = parseJson(raw);
        questions.push(result);
      } catch(e) {
        questions.push({ pageTitle: pg.title, pageUrl: pg.url, questions: [], error: e.message });
      }
    }
    
    res.json({ discoveryId: req.params.discId, contextQuestions: questions });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Accept answers and refine scenarios
router.post('/discover/:discId/refine-scenarios', async (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) return res.status(404).json({error:'Discovery not found'});
  
  const { pageIndex, answers } = req.body;
  if (pageIndex === undefined || !answers) return res.status(400).json({error:'pageIndex and answers required'});
  
  const pg = d.screens[pageIndex];
  if (!pg) return res.status(404).json({error:'Page not found'});
  
  try {
    const contextSummary = answers
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n');
    
    // Read screenshot file and convert to base64
    let screenshotBase64 = '';
    if (pg.screenshotPath) {
      try {
        const fs = require('fs');
        const imageBuffer = fs.readFileSync(pg.screenshotPath);
        screenshotBase64 = imageBuffer.toString('base64');
      } catch (e) {
        console.warn(`Could not read screenshot: ${e.message}`);
      }
    }
    
    const refinedPrompt = `You have this context about the page "${pg.title}":

${contextSummary}

Now plan 15-20 test scenarios using this context. Make scenarios:
- More specific to the actual business workflow
- Test realistic field values based on the requirements given
- Include error scenarios that were mentioned
- Test validation rules that were specified

Respond with ONLY valid JSON:
{
  "scenarios": [
    { "name": "...", "description": "...", "type": "create_verify|edit_verify|publish_verify|...", "steps": [], "verifyAfter": "...", "testData": {} }
  ]
}`;
    
    const messageContent = [];
    
    // Add image if available
    if (screenshotBase64) {
      messageContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 }
      });
    }
    
    messageContent.push({
      type: 'text',
      text: refinedPrompt
    });
    
    const raw = await callClaude(
      [{
        role:'user',
        content: messageContent
      }],
      'You are a senior QA engineer. Respond only with valid JSON.',
      4096
    );
    
    const result = parseJson(raw);
    res.json({ pageTitle: pg.title, refinedScenarios: result.scenarios || [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PHASE 3: TEST (with screen selection) ─────────────────────────────────────
router.post('/discover/:discId/test', (req, res) => {
  const d = discoveries.get(req.params.discId);
  if (!d) {
    return res.status(404).json({
      error:'Discovery not found',
      detail:'This can happen if: (1) the backend was restarted, (2) the discovery session expired, (3) or the discovery ID is incorrect. Start a new Discovery phase.',
      discoveryId: req.params.discId
    });
  }
  const cfg = d._config;
  if (!cfg) return res.status(400).json({error:'Discovery has no stored config'});
  const db = req.body.db;
  // Prefer queries sent directly from the Review screen; fall back to saved file.
  let dbChecks = Array.isArray(req.body.dbChecks) ? req.body.dbChecks.filter(c => c && c.urlMatch && c.query) : [];
  if (!dbChecks.length && d.origin) dbChecks = getSavedChecks(d.origin);
  // Persist whatever we got so future runs and the mappings view stay in sync.
  if (dbChecks.length && d.origin) { try { setSavedChecks(d.origin, dbChecks); } catch(_) {} }
  const enableDelete = !!req.body.enableDelete;

  const selectedScreenIndices = req.body.selectedScreenIndices || [];
  if (!Array.isArray(selectedScreenIndices) || selectedScreenIndices.length === 0) {
    return res.status(400).json({error:'No screens selected for testing'});
  }

  const scanId = newId();
  scans.set(scanId, {
    id:scanId, url:cfg.url, username:cfg.username, maxPages:cfg.maxPages,
    jiraUrl:req.body.jiraUrl, jiraEmail:req.body.jiraEmail, jiraToken:req.body.jiraToken, jiraProjectKey:req.body.jiraProjectKey,
    status:'queued', phase:'Starting',
    logs:[], bugs:[], pages:[], transactions:[],
    pagesDiscovered:0, analysisProgress:'0/0', scenarioProgress:'0/0',
    started_at:null, completed_at:null, error:null,
    selectedScreenCount: selectedScreenIndices.length,
    _rerunConfig:{url:cfg.url, username:cfg.username, password:cfg.password, maxPages:cfg.maxPages, db, dbChecks, enableDelete, selectedScreenIndices, discoveredPages: d.screens.length},
  });

  runScan(scanId, {
    url:cfg.url, username:cfg.username, password:cfg.password, maxPages:cfg.maxPages,
    db, dbChecks, enableDelete, selectedScreenIndices, discoveredPages: d.screens.length
  }).catch(()=>{});

  res.json({scanId, status:'queued', appliedChecks:dbChecks.length, selectedScreens: selectedScreenIndices.length});
});

module.exports = router;