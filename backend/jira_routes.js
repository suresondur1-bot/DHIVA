// ─── JIRA Integration Routes ───────────────────────────────────────────────
// Load into server.js with ONE line:
//   require('./jira_routes')(app, pool, requireAuth);

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

function nodeFetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const bodyBuf = opts.body ? (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)) : null;
    const headers = { ...(opts.headers || {}) };
    if (bodyBuf) headers['Content-Length'] = bodyBuf.length;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   opts.method || 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok:     res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text:   () => Promise.resolve(text),
          json:   () => { try { return Promise.resolve(JSON.parse(text)); } catch(e) { return Promise.reject(e); } },
        });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = function registerJiraRoutes(app, pool, requireAuth) {

  pool.query(`
    CREATE TABLE IF NOT EXISTS jira_config (
      id SERIAL PRIMARY KEY,
      jira_url TEXT NOT NULL DEFAULT \'\',
      jira_email TEXT NOT NULL DEFAULT \'\',
      jira_api_token TEXT NOT NULL DEFAULT \'\',
      project_key TEXT NOT NULL DEFAULT \'\',
      val_worktype TEXT NOT NULL DEFAULT \'Bug\',
      val_defecttype TEXT NOT NULL DEFAULT \'Functional\',
      val_status TEXT NOT NULL DEFAULT \'Open\',
      fid_summary TEXT DEFAULT \'summary\',
      fid_description TEXT DEFAULT \'description\',
      fid_priority TEXT DEFAULT \'priority\',
      fid_source TEXT DEFAULT \'\',
      fid_worktype TEXT DEFAULT \'\',
      fid_defecttype TEXT DEFAULT \'\',
      fid_severity TEXT DEFAULT \'\',
      fid_affectversion TEXT DEFAULT \'\',
      fid_labels TEXT DEFAULT \'labels\',
      severity_options TEXT DEFAULT \'Critical,High,Medium,Low\',
      default_severity TEXT DEFAULT \'High\',
      default_affectver TEXT DEFAULT \'\',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_ticket TEXT;
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_posted_at TIMESTAMPTZ;
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_severity TEXT;
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_affect_ver TEXT;
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_summary TEXT;
    ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS jira_skipped BOOLEAN DEFAULT FALSE;
    INSERT INTO jira_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `).catch(e => console.error('[JIRA] Table init error:', e.message));

  // ── Direct DB fix endpoint (temporary) ─────────────────────────────────────
  app.get('/api/jira/fix-config', async (req, res) => {
    try {
      await pool.query(`
        UPDATE jira_config SET
          fid_defecttype   = 'customfield_11038',
          fid_severity     = 'customfield_11037',
          fid_affectversion= 'versions',
          fid_source       = 'customfield_11022',
          fid_worktype     = '',
          fid_summary      = 'summary',
          fid_description  = 'description',
          fid_priority     = 'priority',
          fid_labels       = 'labels',
          val_worktype     = 'Bug',
          val_defecttype   = 'Functional',
          val_status       = 'Open',
          default_severity = 'High',
          default_affectver= '4.55.0-RC3',
          severity_options = 'Critical,High,Medium,Low'
        WHERE id=1
      `);
      const r = await pool.query('SELECT * FROM jira_config WHERE id=1');
      res.json({ ok: true, saved: true, config: r.rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/jira/config', requireAuth, async (req, res) => {
    try { res.json((await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0] || {}); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/jira/config', requireAuth, async (req, res) => {
    try {
      const b = req.body;
      await pool.query(`UPDATE jira_config SET
        jira_url=$1,jira_email=$2,jira_api_token=$3,project_key=$4,
        val_worktype=$5,val_defecttype=$6,val_status=$7,
        fid_summary=$8,fid_description=$9,fid_priority=$10,
        fid_source=$11,fid_worktype=$12,fid_defecttype=$13,
        fid_severity=$14,fid_affectversion=$15,fid_labels=$16,
        severity_options=$17,default_severity=$18,default_affectver=$19,updated_at=NOW()
        WHERE id=1`,
        [b.jira_url,b.jira_email,b.jira_api_token,b.project_key,
         b.val_worktype||'Bug',b.val_defecttype||'Functional',b.val_status||'Open',
         b.fid_summary||'summary',b.fid_description||'description',b.fid_priority||'priority',
         b.fid_source||'',b.fid_worktype||'',b.fid_defecttype||'',
         b.fid_severity||'',b.fid_affectversion||'',b.fid_labels||'labels',
         b.severity_options||'Critical,High,Medium,Low',b.default_severity||'High',b.default_affectver||'']);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/jira/test-connection', requireAuth, async (req, res) => {
    try {
      const { jira_url, jira_email, jira_api_token } = req.body;
      const auth = Buffer.from(`${jira_email}:${jira_api_token}`).toString('base64');
      const resp = await nodeFetch(`${jira_url}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      });
      if (!resp.ok) { const t = await resp.text(); return res.status(400).json({ ok:false, error:`JIRA ${resp.status}: ${t.slice(0,200)}` }); }
      const user = await resp.json();
      res.json({ ok: true, displayName: user.displayName, email: user.emailAddress });
    } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // ── GET /api/jira/debug-options (no auth — for testing) ─────────────────
  app.get('/api/jira/debug-options', async (req, res) => {
    try {
      const cfg = (await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0];
      if (!cfg?.jira_url) return res.json({ error: 'JIRA not configured' });
      const auth = Buffer.from(`${cfg.jira_email}:${cfg.jira_api_token}`).toString('base64');
      const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
      const results = { config: { fid_defecttype: cfg.fid_defecttype, val_defecttype: cfg.val_defecttype, fid_affectversion: cfg.fid_affectversion, default_affectver: cfg.default_affectver } };

      // Fetch Defect Type options directly from field
      try {
        const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/customField/11038/option`, { headers });
        const d = await r.json();
        results.defectType_options = (d.values||[]).map(v => v.value||v.name).filter(Boolean);
        results.defectType_raw = d.values?.slice(0,5);
      } catch(e) { results.defectType_error = e.message; }

      // Get actual value from existing ticket ACT-18873
      try {
        const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/issue/ACT-18873?fields=customfield_11038,customfield_11037,versions,fixVersions`, { headers });
        const d = await r.json();
        results.from_ticket_ACT18873 = {
          defectType:    d.fields?.customfield_11038,
          severity:      d.fields?.customfield_11037,
          versions:      d.fields?.versions,
          fixVersions:   d.fields?.fixVersions,
        };
      } catch(e) { results.ticket_error = e.message; }

      // Fetch Severity options
      try {
        const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/customField/11037/option`, { headers });
        const d = await r.json();
        results.severity_options = (d.values||[]).map(v => v.value||v.name).filter(Boolean);
      } catch(e) { results.severity_error = e.message; }

      // Fetch fixVersions for ACT project
      try {
        const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/project/ACT/versions`, { headers });
        const d = await r.json();
        results.fixVersions = Array.isArray(d) ? d.map(v=>v.name).slice(0,10) : d;
      } catch(e) { results.fixVersions_error = e.message; }

      // Get EXACT field format from existing ticket ACT-18873
      try {
        const r = await nodeFetch(
          `${cfg.jira_url}/rest/api/3/issue/ACT-84168?fields=customfield_11038,customfield_11037,customfield_11022,versions,fixVersions,issuetype`,
          { headers }
        );
        const d = await r.json();
        results.from_ticket_ACT84168 = {
          defectType:  d.fields?.customfield_11038,
          severity:    d.fields?.customfield_11037,
          source:      d.fields?.customfield_11022,
          versions:    d.fields?.versions,
          fixVersions: d.fields?.fixVersions,
          issuetype:   d.fields?.issuetype?.name,
        };
      } catch(e) { results.ticket_error = e.message; }
      res.json(results);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/jira/field-options/:fieldId ───────────────────────────────────────
  app.get('/api/jira/field-options/:fieldId', requireAuth, async (req, res) => {
    try {
      const cfg = (await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0];
      if (!cfg?.jira_url) return res.status(400).json({ error: 'JIRA not configured' });
      const auth = Buffer.from(`${cfg.jira_email}:${cfg.jira_api_token}`).toString('base64');
      // Method 1: Direct customField options API
      const resp = await nodeFetch(
        `${cfg.jira_url}/rest/api/3/customField/${req.params.fieldId}/option`,
        { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
      );
      if (resp.ok) {
        const data = await resp.json();
        const options = (data.values || []).map(v => v.value || v.name || v.id).filter(Boolean);
        if (options.length > 0) return res.json({ options, source: 'customField API' });
      }
      // Method 2: createmeta API
      const resp2 = await nodeFetch(
        `${cfg.jira_url}/rest/api/3/issue/createmeta/${cfg.project_key}/issuetypes`,
        { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
      );
      if (resp2.ok) {
        const data2 = await resp2.json();
        const issueTypes = data2.issueTypes || [];
        const bug = issueTypes.find(it => it.name === 'Bug') || issueTypes[0];
        if (bug) {
          const resp3 = await nodeFetch(
            `${cfg.jira_url}/rest/api/3/issue/createmeta/${cfg.project_key}/issuetypes/${bug.id}`,
            { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } }
          );
          if (resp3.ok) {
            const data3 = await resp3.json();
            const field = (data3.fields || []).find(f => f.fieldId === req.params.fieldId);
            if (field?.allowedValues?.length) {
              const options = field.allowedValues.map(v => v.value || v.name || v.id).filter(Boolean);
              return res.json({ options, source: 'createmeta API' });
            }
          }
        }
      }
      res.json({ options: [], message: 'Could not fetch options — check field ID' });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/jira/fields', requireAuth, async (req, res) => {
    try {
      const cfg = (await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0];
      const auth = Buffer.from(`${cfg.jira_email}:${cfg.jira_api_token}`).toString('base64');
      const resp = await nodeFetch(`${cfg.jira_url}/rest/api/3/field`, { headers:{ Authorization:`Basic ${auth}`,Accept:'application/json' } });
      const f = await resp.json();
      res.json(Array.isArray(f) ? f.map(x=>({id:x.id,name:x.name,custom:x.custom})) : []);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.get('/api/jira/bugs/:suiteRunId', requireAuth, async (req, res) => {
    try {
      const rows = (await pool.query(`
        SELECT tr.id,tr.test_case_id,tr.status,tr.duration_ms,tr.logs,tr.screenshots,
               tr.created_at,tr.browser,tr.jira_ticket,tr.jira_posted_at,
               tr.jira_severity,tr.jira_affect_ver,tr.jira_summary,tr.jira_skipped,
               tc.name AS test_name,tc.steps AS test_steps,tc.base_url,tc.priority AS test_priority,
               p.name AS project_name,sr.name AS suite_run_name
        FROM test_runs tr
        LEFT JOIN test_cases tc ON tc.id=tr.test_case_id
        LEFT JOIN projects p ON p.id=tc.project_id
        LEFT JOIN suite_runs sr ON sr.id=tr.suite_run_id
        WHERE tr.suite_run_id=$1 AND tr.status IN ('failed','error')
        ORDER BY tr.id`, [req.params.suiteRunId])).rows;

      const bugs = rows.map(run => {
        const logs  = Array.isArray(run.logs) ? run.logs : [];
        const steps = Array.isArray(run.test_steps) ? run.test_steps : [];
        let fi=null,fm='',fa='',fs2='';
        for (const l of logs) {
          if ((l.level==='fail'||l.level==='error') && l.step_index!=null) { fi=l.step_index;fm=l.message||'';break; }
          if (!fm && (l.level==='fail'||l.level==='error')) fm=l.message||'';
        }
        if (fi!=null&&steps[fi]) { fa=steps[fi].action||'';fs2=steps[fi].selector||''; }
        const stepsText = steps.map((st,i) => {
          const p=[i===fi?'\u274c':`${i+1}.`,st.action||'',st.selector||'',st.value||''].filter(Boolean).join(' -> ');
          return i===fi ? `${p}\n    ERROR: ${fm}` : p;
        }).join('\n');
        const shots=Array.isArray(run.screenshots)?run.screenshots:[];
        const tn=(run.test_name||'').toLowerCase();
        const sev=run.jira_severity||(fi===0?'Critical':tn.includes('login')?'Critical':'High');
        return {
          run_id:run.id,test_case_id:run.test_case_id,test_name:run.test_name||'',
          project_name:run.project_name||'',suite_run_name:run.suite_run_name||'',
          browser:run.browser||'chrome',base_url:run.base_url||'',status:run.status,
          duration_ms:run.duration_ms,created_at:run.created_at,
          failed_step_idx:fi,failed_step_action:fa,failed_step_selector:fs2,failed_step_error:fm,
          steps_text:stepsText,steps_count:steps.length,
          screenshot:shots.length>0?shots[shots.length-1]:null,
          summary:run.jira_summary||`[ATHMA] ${run.test_name||'Test'} - Step ${(fi||0)+1} ${fa} failed`,
          severity:sev,affect_version:run.jira_affect_ver||'',
          jira_ticket:run.jira_ticket||null,jira_posted_at:run.jira_posted_at||null,jira_skipped:run.jira_skipped||false,
        };
      });
      res.json({ bugs, total:bugs.length });
    } catch(e) { res.status(500).json({ error:e.message }); }
  });

  app.post('/api/jira/post-bug', requireAuth, async (req, res) => {
    try {
      const { run_id, summary, severity, affect_version, extra_notes, steps_text, error_msg } = req.body;
      const cfg = (await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0];
      if (!cfg?.jira_url||!cfg?.jira_email||!cfg?.jira_api_token||!cfg?.project_key)
        return res.status(400).json({ error:'JIRA not configured' });

      const run = (await pool.query(`
        SELECT tr.*,tc.name as test_name,tc.steps as test_steps,tc.base_url,
               p.name as project_name,sr.name as suite_run_name
        FROM test_runs tr
        LEFT JOIN test_cases tc ON tc.id=tr.test_case_id
        LEFT JOIN projects p ON p.id=tc.project_id
        LEFT JOIN suite_runs sr ON sr.id=tr.suite_run_id
        WHERE tr.id=$1`, [run_id])).rows[0];
      if (!run) return res.status(404).json({ error:'Run not found' });

      const steps=Array.isArray(run.test_steps)?run.test_steps:[];
      const logs=Array.isArray(run.logs)?run.logs:[];
      let fi=null,fm='';
      for (const l of logs) {
        if ((l.level==='fail'||l.level==='error')&&l.step_index!=null){fi=l.step_index;fm=l.message||'';break;}
        if (!fm&&(l.level==='fail'||l.level==='error'))fm=l.message||'';
      }

      const stepsText=steps.map((st,i)=>{
        const p=[st.action,st.selector,st.value].filter(Boolean).join(' -> ');
        return i===fi?`${i+1}. FAILED: ${p}\n   ERROR: ${fm}`:`${i+1}. ${p}`;
      }).join('\n');

      // Use user-edited steps/error if provided, fallback to auto-generated
      const finalStepsText = (steps_text || '').trim() || stepsText;
      const finalErrorMsg  = (error_msg  || '').trim() || fm;

      const runDate=run.created_at?new Date(run.created_at).toLocaleString('en-IN'):'';
      const desc=`Test Case: ${run.test_name||''}
Source: ${run.project_name||''}
Browser: ${run.browser||'chrome'}
Run Date: ${runDate}
Run ID: #${run.id}
Duration: ${run.duration_ms?(run.duration_ms/1000).toFixed(1)+'s':'-'}

Failed Step: Step ${(fi||0)+1} of ${steps.length}
Error: ${finalErrorMsg}

Steps to Reproduce:
${finalStepsText}

Environment:
URL: ${run.base_url||''}
Browser: ${run.browser||'Chrome'}
Tool: Daiva Health ATHMA
${extra_notes?'\nNotes: '+extra_notes:''}
ATHMA Run: #${run.id}`;

      const bugSummary = summary || `[ATHMA] ${run.test_name} - Step ${(fi||0)+1} failed`;
      const priorityMap = { Critical:'Highest', High:'High', Medium:'Medium', Low:'Low' };

      console.log('[JIRA] Posting:', bugSummary);

      // Build payload
      const fields = {
        project:     { key: cfg.project_key },
        summary:     bugSummary,
        description: { type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:desc}]}] },
      };

      // issuetype — try 'Bug' first
      fields.issuetype = { name: (cfg.val_worktype||'Bug').trim() };

      // priority
      fields.priority = { name: priorityMap[severity]||'High' };

      // labels
      fields.labels = ['automation','athma',(run.project_name||'').toLowerCase().replace(/\s+/g,'_')].filter(Boolean);

      // Source (customfield_11022) — QA, id:10315
      fields['customfield_11022'] = { id: '10315', value: 'QA' };

      // Defect Type — REQUIRED (hardcoded for ACT project)
      // customfield_11038 = Defect Type, option id 10376 = Functional
      fields['customfield_11038'] = { id: '10376', value: 'Functional' };
      const defectFid = 'customfield_11038';
      const defectVal = 'Functional';

      // Versions — REQUIRED (hardcoded for ACT project)
      // version id 26754 = 4.55.0-RC3
      const affVer = (affect_version || '').trim() ||
                     (cfg.default_affectver || '').trim() ||
                     '4.55.0-RC3';
      const versionFid = (cfg.fid_affectversion || 'versions').trim();
      fields[versionFid] = [{ id: '26754', name: affVer }];

      // Severity — optional (id:10374=Low, 10375=Medium, 10373=High, 10372=Critical)
      const severityIds = { 'Low':'10374', 'Medium':'10375', 'High':'10373', 'Critical':'10372' };
      const sevVal = (severity || cfg.default_severity || 'High').trim();
      const sevId = severityIds[sevVal];
      fields['customfield_11037'] = sevId ? { id: sevId, value: sevVal } : { value: sevVal };

      console.log('[JIRA] Attempt 1 - Fields:', Object.keys(fields).join(', '));
      const postToJira = async (payload) => {
        const auth=Buffer.from(`${cfg.jira_email}:${cfg.jira_api_token}`).toString('base64');
        const r=await nodeFetch(`${cfg.jira_url}/rest/api/3/issue`,{
          method:'POST',
          headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json',Accept:'application/json'},
          body:JSON.stringify(payload),
        });
        return { resp:r, data:await r.json(), auth };
      };

      console.log('[JIRA] Attempt 1 - All fields:', Object.keys(fields));
      let { resp: jiraResp, data: jiraData, auth } = await postToJira({ fields });
      console.log('[JIRA] Status:', jiraResp.status, JSON.stringify(jiraData).slice(0,500));

      // Attempt 2: Remove ONLY the specific bad fields JIRA complained about
      if (!jiraResp.ok && jiraResp.status === 400 && jiraData?.errors) {
        const badFields = Object.keys(jiraData.errors);
        console.log('[JIRA] Bad fields:', badFields);
        const cleanFields = { ...fields };
        for (const bf of badFields) { delete cleanFields[bf]; }
        // Always keep these mandatory fields
        cleanFields.project   = fields.project;
        cleanFields.issuetype = fields.issuetype;
        cleanFields.summary   = fields.summary;
        cleanFields.description = fields.description;
        console.log('[JIRA] Attempt 2 - Without bad fields:', Object.keys(cleanFields));
        const retry = await postToJira({ fields: cleanFields });
        jiraResp = retry.resp;
        jiraData  = retry.data;
        auth      = retry.auth;
        console.log('[JIRA] Attempt 2 status:', jiraResp.status, JSON.stringify(jiraData).slice(0,500));
      }

      // Attempt 3: Only truly mandatory fields + required custom fields
      if (!jiraResp.ok && jiraResp.status === 400) {
        console.log('[JIRA] Attempt 3 - bare minimum');
        const bareFields = {
          project:           { key: cfg.project_key },
          issuetype:         { name: 'Bug' },
          summary:           fields.summary,
          description:       fields.description,
          versions:          [{ id: '26754', name: affVer }],
          customfield_11038: { id: '10376', value: 'Functional' },
        };
        const retry2 = await postToJira({ fields: bareFields });
        jiraResp = retry2.resp;
        jiraData  = retry2.data;
        auth      = retry2.auth;
        console.log('[JIRA] Attempt 3 status:', jiraResp.status, JSON.stringify(jiraData).slice(0,500));
      }

      if (!jiraResp.ok) {
        const err=jiraData?.errors?JSON.stringify(jiraData.errors):(jiraData?.errorMessages?.join(', ')||JSON.stringify(jiraData));
        return res.status(400).json({ error:`JIRA error: ${err}` });
      }

      const ticketKey=jiraData.key;
      console.log('[JIRA] Created:',ticketKey);

      // Attach screenshot
      const shots=Array.isArray(run.screenshots)?run.screenshots:[];
      if (shots.length>0) {
        const shot=shots[shots.length-1];
        const shotPath=path.join(process.cwd(),'..','runner','screenshots',shot.filename||'');
        if (fs.existsSync(shotPath)) {
          try {
            const fc=fs.readFileSync(shotPath);
            const bd='----ATHMA'+Date.now().toString(36);
            const body=Buffer.concat([
              Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="${shot.filename}"\r\nContent-Type: image/jpeg\r\n\r\n`),
              fc, Buffer.from(`\r\n--${bd}--\r\n`),
            ]);
            await nodeFetch(`${cfg.jira_url}/rest/api/3/issue/${ticketKey}/attachments`,{
              method:'POST',
              headers:{Authorization:`Basic ${auth}`,'X-Atlassian-Token':'no-check','Content-Type':`multipart/form-data; boundary=${bd}`,'Content-Length':body.length},
              body,
            });
          } catch(e){console.warn('[JIRA] Screenshot failed:',e.message);}
        }
      }

      await pool.query(
        'UPDATE test_runs SET jira_ticket=$1,jira_posted_at=NOW(),jira_severity=$2,jira_affect_ver=$3,jira_summary=$4 WHERE id=$5',
        [ticketKey,severity,affect_version,bugSummary,run_id]
      );
      res.json({ ok:true, ticket_key:ticketKey, ticket_url:`${cfg.jira_url}/browse/${ticketKey}` });
    } catch(e) { console.error('[JIRA] Error:',e.message); res.status(500).json({ error:e.message }); }
  });

  app.post('/api/jira/skip-bug', requireAuth, async (req, res) => {
    try { await pool.query('UPDATE test_runs SET jira_skipped=TRUE WHERE id=$1',[req.body.run_id]); res.json({ok:true}); }
    catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/jira/unskip-bug', requireAuth, async (req, res) => {
    try { await pool.query('UPDATE test_runs SET jira_skipped=FALSE WHERE id=$1',[req.body.run_id]); res.json({ok:true}); }
    catch(e) { res.status(500).json({error:e.message}); }
  });

  app.post('/api/jira/save-edit', requireAuth, async (req, res) => {
    try {
      const {run_id,summary,severity,affect_version}=req.body;
      await pool.query('UPDATE test_runs SET jira_summary=$1,jira_severity=$2,jira_affect_ver=$3 WHERE id=$4',[summary,severity,affect_version,run_id]);
      res.json({ok:true});
    } catch(e) { res.status(500).json({error:e.message}); }
  });

  // ── Post Visual Scan difference(s) to JIRA (NEW, ISOLATED) ─────────────────
  // Unlike /post-bug this is NOT tied to a test_run. The UI sends the issue
  // summary + description text (one difference, or several combined). We build
  // the SAME JIRA payload that /post-bug uses (same required custom fields), so
  // it posts exactly the way that already works. Optionally attaches a screenshot.
  app.post('/api/jira/post-visual', requireAuth, async (req, res) => {
    try {
      const { summary, description, severity, affect_version, screenshot } = req.body || {};
      if (!summary || !description) return res.status(400).json({ error: 'summary and description are required' });
      const cfg = (await pool.query('SELECT * FROM jira_config WHERE id=1')).rows[0];
      if (!cfg?.jira_url||!cfg?.jira_email||!cfg?.jira_api_token||!cfg?.project_key)
        return res.status(400).json({ error:'JIRA not configured' });

      const priorityMap = { Critical:'Highest', High:'High', Medium:'Medium', Low:'Low' };
      const sevVal = (severity || cfg.default_severity || 'High').trim();
      const affVer = (affect_version||'').trim() || (cfg.default_affectver||'').trim() || '4.55.0-RC3';

      const auth = Buffer.from(`${cfg.jira_email}:${cfg.jira_api_token}`).toString('base64');

      // Fetch the project's CURRENT non-archived, non-released versions so we never
      // try to assign an archived version (the hardcoded id can go stale over time).
      // Returns { id, name } of the best version to use, or null if none usable.
      async function pickVersion() {
        try {
          const vr = await nodeFetch(`${cfg.jira_url}/rest/api/3/project/${cfg.project_key}/versions`, {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          });
          if (!vr.ok) return null;
          const all = await vr.json();
          if (!Array.isArray(all) || !all.length) return null;
          const usable = all.filter(v => !v.archived);
          if (!usable.length) return null;
          // Prefer the configured/default version name if it's still usable.
          const wanted = (affect_version||'').trim() || (cfg.default_affectver||'').trim();
          const match = wanted && usable.find(v => v.name === wanted);
          const chosen = match || usable.filter(v => !v.released).pop() || usable[usable.length-1];
          return { id: String(chosen.id), name: chosen.name };
        } catch (e) { return null; }
      }
      const goodVersion = await pickVersion();
      const versionFid = (cfg.fid_affectversion || 'versions').trim();

      // Resolve a custom-field option id by its display value. Primary source is
      // the createmeta API (the allowedValues it returns are exactly what the
      // create endpoint accepts for THIS project + issue type). Falls back to the
      // customField option API, then to a value-only object. Returns { id } when
      // an id is found (JIRA prefers id for option fields), else { value }.
      let _createMetaFields = null;
      async function loadCreateMetaFields() {
        if (_createMetaFields) return _createMetaFields;
        try {
          const itResp = await nodeFetch(`${cfg.jira_url}/rest/api/3/issue/createmeta/${cfg.project_key}/issuetypes`, {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          });
          if (!itResp.ok) return null;
          const itData = await itResp.json();
          const types = itData.issueTypes || itData.values || [];
          const want = (cfg.val_worktype||'Bug').trim();
          const it = types.find(t => t.name === want) || types.find(t => t.name === 'Bug') || types[0];
          if (!it) return null;
          const fResp = await nodeFetch(`${cfg.jira_url}/rest/api/3/issue/createmeta/${cfg.project_key}/issuetypes/${it.id}`, {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          });
          if (!fResp.ok) return null;
          const fData = await fResp.json();
          _createMetaFields = fData.fields || fData.values || [];
          return _createMetaFields;
        } catch (e) { return null; }
      }

      async function resolveOption(fieldId, wantValue) {
        const want = (wantValue || '').trim();
        if (!fieldId || !want) return null;
        const fid = String(fieldId).trim();
        // 1) createmeta allowedValues (most reliable for create).
        try {
          const metaFields = await loadCreateMetaFields();
          if (Array.isArray(metaFields)) {
            const f = metaFields.find(x => x.fieldId === fid || x.key === fid);
            const av = f && (f.allowedValues || []);
            if (av && av.length) {
              const opt = av.find(o => String(o.value || o.name || '').trim() === want);
              if (opt && opt.id != null) return { id: String(opt.id) };
            }
          }
        } catch (e) {}
        // 2) customField option API.
        try {
          const numId = fid.replace(/\D/g, '');
          const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/customField/${numId}/option`, {
            headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          });
          if (r.ok) {
            const d = await r.json();
            const opt = (d.values || []).find(o => String(o.value || o.name || '').trim() === want);
            if (opt && opt.id != null) return { id: String(opt.id) };
          }
        } catch (e) {}
        // 3) Last resort: send the value (JIRA may accept it).
        return { value: want };
      }

      const fields = {
        project:     { key: cfg.project_key },
        summary:     summary,
        description: { type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text:String(description)}]}] },
        issuetype:   { name: (cfg.val_worktype||'Bug').trim() },
        priority:    { name: priorityMap[sevVal]||'High' },
        labels:      ['automation','athma','visual_scan'],
      };

      // Source — skipped on purpose: this field is not on the project's create
      // screen (JIRA rejects it), and Visual Scan tickets don't need it. Leaving
      // it out lets the issue create on the FIRST attempt.
      // Defect Type — only if configured (fid_defecttype + val_defecttype).
      if ((cfg.fid_defecttype||'').trim()) {
        const dt = await resolveOption(cfg.fid_defecttype, cfg.val_defecttype || 'Functional');
        if (dt) fields[cfg.fid_defecttype.trim()] = dt;
      }
      // Affect version — only if we found a valid non-archived one.
      if (goodVersion) fields[versionFid] = [{ id: goodVersion.id, name: goodVersion.name }];
      // Severity — only if configured (fid_severity).
      if ((cfg.fid_severity||'').trim()) {
        const sv = await resolveOption(cfg.fid_severity, sevVal);
        if (sv) fields[cfg.fid_severity.trim()] = sv;
      }

      const postToJira = async (payload) => {
        const r = await nodeFetch(`${cfg.jira_url}/rest/api/3/issue`, {
          method:'POST',
          headers:{Authorization:`Basic ${auth}`,'Content-Type':'application/json',Accept:'application/json'},
          body:JSON.stringify(payload),
        });
        return { resp:r, data:await r.json() };
      };

      let { resp: jiraResp, data: jiraData } = await postToJira({ fields });
      console.log('[JIRA] post-visual attempt 1:', jiraResp.status, JSON.stringify(jiraData).slice(0,400));

      // Attempt 2: remove ONLY the fields JIRA complained about, keep mandatory.
      if (!jiraResp.ok && jiraResp.status === 400 && jiraData?.errors) {
        const clean = { ...fields };
        for (const bf of Object.keys(jiraData.errors)) delete clean[bf];
        clean.project = fields.project; clean.issuetype = fields.issuetype;
        clean.summary = fields.summary; clean.description = fields.description;
        // Keep the configured defect type + version if they weren't the rejected ones.
        if ((cfg.fid_defecttype||'').trim() && fields[cfg.fid_defecttype.trim()] && !jiraData.errors[cfg.fid_defecttype.trim()])
          clean[cfg.fid_defecttype.trim()] = fields[cfg.fid_defecttype.trim()];
        if (goodVersion && !jiraData.errors[versionFid]) clean[versionFid] = [{ id: goodVersion.id, name: goodVersion.name }];
        const retry = await postToJira({ fields: clean });
        jiraResp = retry.resp; jiraData = retry.data;
        console.log('[JIRA] post-visual attempt 2:', jiraResp.status, JSON.stringify(jiraData).slice(0,400));
      }

      // Attempt 3: bare minimum — project, issuetype, summary, description, plus
      // the configured required fields (defect type + version) if present.
      if (!jiraResp.ok && jiraResp.status === 400) {
        const bareFields = {
          project:     { key: cfg.project_key },
          issuetype:   { name: (cfg.val_worktype||'Bug').trim() },
          summary:     fields.summary,
          description: fields.description,
        };
        if ((cfg.fid_defecttype||'').trim() && fields[cfg.fid_defecttype.trim()])
          bareFields[cfg.fid_defecttype.trim()] = fields[cfg.fid_defecttype.trim()];
        if (goodVersion) bareFields[versionFid] = [{ id: goodVersion.id, name: goodVersion.name }];
        const retry2 = await postToJira({ fields: bareFields });
        jiraResp = retry2.resp; jiraData = retry2.data;
        console.log('[JIRA] post-visual attempt 3:', jiraResp.status, JSON.stringify(jiraData).slice(0,400));
      }

      if (!jiraResp.ok) {
        const err = jiraData?.errors ? JSON.stringify(jiraData.errors) : (jiraData?.errorMessages?.join(', ')||JSON.stringify(jiraData));
        return res.status(400).json({ error:`JIRA error: ${err}` });
      }

      const ticketKey = jiraData.key;

      // Optional: attach the captured screenshot (base64 data URL from the UI).
      if (screenshot) {
        try {
          const b64 = String(screenshot).replace(/^data:image\/\w+;base64,/, '');
          const fc = Buffer.from(b64, 'base64');
          const bd = '----ATHMA'+Date.now().toString(36);
          const body = Buffer.concat([
            Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="file"; filename="visual_scan.png"\r\nContent-Type: image/png\r\n\r\n`),
            fc, Buffer.from(`\r\n--${bd}--\r\n`),
          ]);
          await nodeFetch(`${cfg.jira_url}/rest/api/3/issue/${ticketKey}/attachments`, {
            method:'POST',
            headers:{Authorization:`Basic ${auth}`,'X-Atlassian-Token':'no-check','Content-Type':`multipart/form-data; boundary=${bd}`,'Content-Length':body.length},
            body,
          });
        } catch(e){ console.warn('[JIRA] Visual screenshot attach failed:', e.message); }
      }

      res.json({ ok:true, ticket_key:ticketKey, ticket_url:`${cfg.jira_url}/browse/${ticketKey}` });
    } catch(e) { console.error('[JIRA] post-visual error:', e.message); res.status(500).json({ error:e.message }); }
  });

  console.log('[JIRA] Routes registered \u2705');
};
