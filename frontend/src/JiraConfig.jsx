import React, { useState, useEffect } from "react";
import { API, C, s, api } from "./shared.jsx";

export default function JiraConfig({ user }) {
  const [cfg,     setCfg]     = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRes, setTestRes] = useState(null);
  const [fields,  setFields]  = useState([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [msg,     setMsg]     = useState(null);
  const [showToken, setShowToken] = useState(false);

  const [sourceOptions, setSourceOptions] = useState([]);

  useEffect(() => { loadConfig(); }, []);

  async function loadSourceOptions() {
    try {
      const d = await api('/api/jira/field-options/customfield_11022');
      if (d.options?.length) setSourceOptions(d.options);
    } catch(e) {}
  }

  async function loadConfig() {
    try {
      const d = await api('/api/jira/config');
      // Pre-fill standard field IDs if not already set
      setCfg({
        fid_summary:       'summary',
        fid_description:   'description',
        fid_priority:      'priority',
        fid_labels:        'labels',
        fid_worktype:      'issuetype',
        val_worktype:      'Bug',
        val_defecttype:    'Functional',
        val_status:        'Open',
        severity_options:  'Critical,High,Medium,Low',
        default_severity:  'High',
        ...(d || {}),
      });
    } catch(e) { setCfg({}); }
  }

  async function fetchFields() {
    setLoadingFields(true);
    setFields([]);
    try {
      const d = await api('/api/jira/fields');
      // Always include standard JIRA fields at the top
      const standardFields = [
        { id:'summary',     name:'Summary (standard)',     custom:false },
        { id:'description', name:'Description (standard)', custom:false },
        { id:'priority',    name:'Priority (standard)',    custom:false },
        { id:'labels',      name:'Labels (standard)',      custom:false },
        { id:'versions',    name:'Affects Versions (standard)', custom:false },
        { id:'issuetype',   name:'Issue Type (standard)',  custom:false },
      ];
      const allFields = [
        ...standardFields,
        ...(Array.isArray(d) ? d : []),
      ];
      setFields(allFields);
      if (!allFields.length) setMsg({ type:'warn', text:'No fields returned — check JIRA credentials' });
    } catch(e) {
      setMsg({ type:'error', text: e.message });
    } finally { setLoadingFields(false); }
  }

  async function testConnection() {
    setTesting(true); setTestRes(null);
    try {
      const d = await api('/api/jira/test-connection', { method:'POST', body: cfg });
      setTestRes(d.ok
        ? { ok:true,  text:`✅ Connected as: ${d.displayName} (${d.email})` }
        : { ok:false, text:`❌ ${d.error}` });
      if (d.ok) {
        fetchFields();
        loadSourceOptions();
      }
    } catch(e) { setTestRes({ ok:false, text:`❌ ${e.message}` }); }
    finally { setTesting(false); }
  }

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const result = await api('/api/jira/config', { method:'POST', body: cfg });
      setMsg({ type:'success', text:'✅ JIRA configuration saved successfully!' });
      // Reload config from DB to confirm save
      await loadConfig();
    } catch(e) {
      setMsg({ type:'error', text: `❌ Save failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  }

  const upd = (k, v) => setCfg(c => ({ ...c, [k]: v }));

  // All custom fields options for dropdown
  const fieldOptions = [
    { value:'', label:'— Not mapped —' },
    ...fields.map(f => ({ value: f.id, label: `${f.name} (${f.id})` }))
  ];

  if (!cfg) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:300 }}>
      <div style={{ color: C.textDim }}>Loading...</div>
    </div>
  );

  const inp = (label, key, opts = {}) => (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display:'block', fontSize:12, fontWeight:600, color:C.textMid, marginBottom:5 }}>
        {label}
      </label>
      {opts.type === 'select' ? (
        <select
          value={cfg[key] || ''}
          onChange={e => upd(key, e.target.value)}
          style={styles.input}>
          {(opts.options || []).map(o => (
            <option key={o.value || o} value={o.value || o}>{o.label || o}</option>
          ))}
        </select>
      ) : (
        <div style={{ position:'relative' }}>
          <input
            type={opts.password && !showToken ? 'password' : (opts.type || 'text')}
            value={cfg[key] || ''}
            onChange={e => upd(key, e.target.value)}
            placeholder={opts.placeholder || ''}
            style={{ ...styles.input, paddingRight: opts.password ? 50 : 12 }}
          />
          {opts.password && (
            <button
              onClick={() => setShowToken(s => !s)}
              style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)',
                background:'none', border:'none', cursor:'pointer', color:C.textDim, fontSize:13 }}>
              {showToken ? '🙈' : '👁'}
            </button>
          )}
        </div>
      )}
      {opts.hint && <div style={{ fontSize:11, color:C.textDim, marginTop:3 }}>{opts.hint}</div>}
    </div>
  );

  const fieldMap = (label, key, hint) => (
    <div style={{ marginBottom:14 }}>
      <label style={{ display:'block', fontSize:12, fontWeight:600, color:C.textMid, marginBottom:5 }}>
        {label}
      </label>
      <div style={{ display:'flex', gap:8 }}>
        <input
          type="text"
          value={cfg[key] || ''}
          onChange={e => upd(key, e.target.value)}
          placeholder="e.g. customfield_10001"
          style={{ ...styles.input, flex:1 }}
        />
        {fields.length > 0 && (
          <select
            value={cfg[key] || ''}
            onChange={e => upd(key, e.target.value)}
            style={{ ...styles.input, flex:1 }}>
            {fieldOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        )}
      </div>
      {hint && <div style={{ fontSize:11, color:C.textDim, marginTop:3 }}>{hint}</div>}
    </div>
  );

  return (
    <div style={{ maxWidth:860, margin:'0 auto', padding:'24px 16px' }}>

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <div style={{ fontSize:22, fontWeight:800, color:C.text }}>⚙️ JIRA Configuration</div>
          <div style={{ fontSize:13, color:C.textDim, marginTop:3 }}>
            Map ATHMA test failure data to your JIRA custom fields
          </div>
        </div>
        <a href="#jira-bugs" style={{ fontSize:13, color:C.accent, textDecoration:'none', fontWeight:600 }}>
          ← Back to Bug Board
        </a>
      </div>

      {/* Message */}
      {msg && (
        <div style={{
          padding:'10px 16px', borderRadius:8, marginBottom:16,
          background: msg.type==='success' ? '#e6f7f1' : msg.type==='warn' ? '#fff8e6' : '#fdecea',
          color: msg.type==='success' ? '#065f46' : msg.type==='warn' ? '#92400e' : '#b91c1c',
          border: `1px solid ${msg.type==='success' ? '#a7f3d0' : msg.type==='warn' ? '#fde68a' : '#fca5a5'}`,
          fontSize:13,
        }}>
          {msg.text}
        </div>
      )}

      {/* Section 1 — Server Settings */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>🔗 JIRA Server Connection</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 24px' }}>
          {inp('JIRA URL', 'jira_url', { placeholder:'https://yourcompany.atlassian.net' })}
          {inp('Project Key', 'project_key', { placeholder:'e.g. NAT or DAI',
            hint:'The key shown in your JIRA project URL' })}
          {inp('Email / Username', 'jira_email', { placeholder:'user@company.com' })}
          {inp('API Token', 'jira_api_token', { password:true,
            hint:'Generate at: id.atlassian.com/manage-profile/security/api-tokens' })}
        </div>

        {/* Test Connection */}
        <div style={{ display:'flex', gap:12, alignItems:'center', marginTop:4 }}>
          <button
            onClick={testConnection}
            disabled={testing || !cfg.jira_url || !cfg.jira_email || !cfg.jira_api_token}
            style={{ ...s.btn('ghost'), fontSize:13 }}>
            {testing ? '⏳ Testing...' : '🔌 Test Connection'}
          </button>
          {testRes && (
            <span style={{ fontSize:13, color: testRes.ok ? C.green : C.red, fontWeight:600 }}>
              {testRes.text}
            </span>
          )}
          {testRes?.ok && (
            <button
              onClick={fetchFields}
              disabled={loadingFields}
              style={{ ...s.btn('ghost'), fontSize:13 }}>
              {loadingFields ? '⏳ Loading...' : '📋 Fetch Field IDs'}
            </button>
          )}
        </div>

        {fields.length > 0 && (
          <div style={{ marginTop:10, padding:'8px 12px', background:C.card2,
            borderRadius:6, fontSize:12, color:C.textMid }}>
            ✅ {fields.length} fields loaded — select from dropdowns below or type field IDs manually
          </div>
        )}
      </div>

      {/* Section 2 — Fixed Field Values */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>📌 Fixed Field Values</div>
        <div style={{ fontSize:12, color:C.textDim, marginBottom:14 }}>
          These values are always set the same for every bug posted from ATHMA.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:'0 24px' }}>
          {inp('WorkType', 'val_worktype', { placeholder:'Bug' })}
          {inp('DefectType', 'val_defecttype', { placeholder:'Functional' })}
          {inp('Status', 'val_status', { placeholder:'Open' })}
          {inp('Source', 'val_source', { placeholder:'QA',
            hint:'Valid: SUPPORT, QA, FUNCTIONAL, PRODUCT, DEV, UAT' })}
        </div>
      </div>

      {/* Section 3 — Custom Field ID Mapping */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>🗺️ Field ID Mapping</div>
        <div style={{ fontSize:12, color:C.textDim, marginBottom:14 }}>
          Enter the JIRA field ID for each ATHMA field. Custom fields use IDs like{' '}
          <code style={{ background:C.card2, padding:'1px 5px', borderRadius:3 }}>customfield_10001</code>.
          Click "Fetch Field IDs" above to load them from your JIRA instance.
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 24px' }}>
          {fieldMap('Summary Field ID', 'fid_summary',
            'JIRA field for bug title. Usually: summary')}
          {fieldMap('Description Field ID', 'fid_description',
            'JIRA field for steps/details. Usually: description')}
          {fieldMap('Source Field ID', 'fid_source',
            'Maps to: ATHMA Project Name (e.g. Inventory)')}
          {fieldMap('WorkType Field ID', 'fid_worktype',
            'Maps to: Bug (fixed value)')}
          {fieldMap('DefectType Field ID', 'fid_defecttype',
            'Maps to: Functional (fixed value)')}
          {fieldMap('Severity Field ID', 'fid_severity',
            'User selects per bug in Bug Review Board')}
          {fieldMap('Affect Version Field ID', 'fid_affectversion',
            'User enters per bug in Bug Review Board')}
          {fieldMap('Priority Field ID', 'fid_priority',
            'Maps to JIRA priority. Leave blank to use default priority field.')}
        </div>
      </div>

      {/* Section 4 — Severity Options */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>🎯 Severity & Defaults</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 24px' }}>
          {inp('Severity Options', 'severity_options', {
            placeholder:'Critical,High,Medium,Low',
            hint:'Comma-separated list shown in Severity dropdown in Bug Review Board'
          })}
          {inp('Default Severity', 'default_severity', {
            placeholder:'High',
            hint:'Pre-selected severity when a bug is first loaded in the board'
          })}
          {inp('Default Affect Version', 'default_affectver', {
            placeholder:'e.g. v2.1.0',
            hint:'Pre-filled version in Bug Review Board — user can edit per bug'
          })}
        </div>
      </div>

      {/* Preview */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>👁️ Payload Preview</div>
        <div style={{ fontSize:12, color:C.textDim, marginBottom:10 }}>
          This is how a sample bug will be sent to JIRA based on your mapping.
        </div>
        <pre style={{ background:'#1a2332', color:'#a8d8a8', padding:16, borderRadius:8,
          fontSize:11, overflowX:'auto', lineHeight:1.6 }}>
{`{
  "fields": {
    "project":           { "key": "${cfg.project_key || 'NAT'}" },
    "issuetype":         { "name": "${cfg.val_worktype || 'Bug'}" },
    "${cfg.fid_summary || 'summary'}": "[ATHMA] GRN_Receipt — Step 23 search_select failed",
    "${cfg.fid_description || 'description'}": "Steps to Reproduce:\\n1. navigate → https://...\\n23. ❌ search_select → ...",
    ${cfg.fid_source ? `"${cfg.fid_source}": "Inventory",` : '// Source: not mapped'}
    ${cfg.fid_worktype ? `"${cfg.fid_worktype}": "${cfg.val_worktype || 'Bug'}",` : '// WorkType: not mapped'}
    ${cfg.fid_defecttype ? `"${cfg.fid_defecttype}": "${cfg.val_defecttype || 'Functional'}",` : '// DefectType: not mapped'}
    ${cfg.fid_severity ? `"${cfg.fid_severity}": "High",` : '// Severity: not mapped'}
    ${cfg.fid_affectversion ? `"${cfg.fid_affectversion}": "v2.1.0",` : '// AffectVersion: not mapped'}
    "priority":          { "name": "High" },
    "${cfg.fid_labels || 'labels'}": ["automation", "athma", "inventory"]
  }
}`}
        </pre>
      </div>

      {/* Save Button */}
      <div style={{ display:'flex', justifyContent:'flex-end', gap:12 }}>
        <button onClick={loadConfig} style={{ ...s.btn('ghost') }}>
          ↺ Reset
        </button>
        <button
          onClick={save}
          disabled={saving}
          style={{ ...s.btn('primary'), minWidth:140 }}>
          {saving ? '⏳ Saving...' : '💾 Save Configuration'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  card: {
    background:    '#ffffff',
    border:        '1px solid #e2e6ed',
    borderRadius:  10,
    padding:       24,
    marginBottom:  20,
    boxShadow:     '0 1px 4px rgba(0,0,0,0.04)',
  },
  cardTitle: {
    fontSize:    15,
    fontWeight:  700,
    color:       '#1a2332',
    marginBottom:16,
    paddingBottom:10,
    borderBottom:'1px solid #f0f2f5',
  },
  input: {
    width:         '100%',
    padding:       '8px 12px',
    border:        '1px solid #e2e6ed',
    borderRadius:  6,
    fontSize:      13,
    color:         '#1a2332',
    background:    '#fff',
    outline:       'none',
    boxSizing:     'border-box',
  },
};
