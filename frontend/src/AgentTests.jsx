import React, { useState, useEffect, useCallback } from "react";
import { C, s, api, Spinner, Badge, Empty } from "./shared.jsx";

// ── Agent Tests page ────────────────────────────────────────────────────────
// Lists agent-authored scripts from the agent_test_cases table and lets the
// user View / Run / Promote / Delete them. Runs go through the existing runner
// via POST /api/agent-tests/:id/run (no AI at replay time).
export default function AgentTests({ projects = [], user }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [viewing, setViewing] = useState(null);   // full agent test (with steps)
  const [busyId, setBusyId]   = useState(null);
  const [msg, setMsg]         = useState(null);
  const [importing, setImporting] = useState(false);  // import modal open
  const [smartAuthoring, setSmartAuthoring] = useState(false); // "smart author" panel
  const [authoring, setAuthoring] = useState(false);  // "create with agent" panel open
  const [studying, setStudying]   = useState(false);  // "study screen" panel open

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api("/api/agent-tests");
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { setMsg({ type: "err", text: e.message }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const projectName = (id) => projects.find(p => p.id === id)?.name || (id ? `#${id}` : "—");

  const run = async (id) => {
    setBusyId(id); setMsg(null);
    try {
      const r = await api(`/api/agent-tests/${id}/run`, { method: "POST" });
      setMsg({ type: "ok", text: `Run started (run #${r.run_id}). Watch it in Run History.` });
    } catch (e) { setMsg({ type: "err", text: e.message }); }
    finally { setBusyId(null); }
  };

  const del = async (id) => {
    if (!confirm("Delete this agent test? This cannot be undone.")) return;
    setBusyId(id);
    try { await api(`/api/agent-tests/${id}`, { method: "DELETE" }); await load(); }
    catch (e) { setMsg({ type: "err", text: e.message }); }
    finally { setBusyId(null); }
  };

  const promote = async (id) => {
    if (!confirm("Promote this agent test into your real Test Cases?")) return;
    setBusyId(id);
    try {
      const r = await api(`/api/agent-tests/${id}/promote`, { method: "POST" });
      setMsg({ type: "ok", text: `Promoted to Test Case #${r.test_case_id}.` });
      await load();
    } catch (e) { setMsg({ type: "err", text: e.message }); }
    finally { setBusyId(null); }
  };

  const view = async (id) => {
    try { setViewing(await api(`/api/agent-tests/${id}`)); }
    catch (e) { setMsg({ type: "err", text: e.message }); }
  };

  const isAdmin = user?.role === "admin" || user?.role === "superadmin" || user?.id === 1 || user?.uid === 1;

  return (
    <div style={{ animation: "fadeIn 0.3s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: C.text }}>🤖 Agent Tests</h2>
          <div style={{ fontSize: 12, color: C.textDim, marginTop: 4 }}>
            Study a screen once, then use Smart Author to create test scripts in plain English. No selectors, no coding.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={() => setStudying(true)}>🔍 Study screen</button>
          <button style={{ ...s.btn("secondary"), fontSize: 12, background: "#7c3aed", color: "#fff" }} onClick={() => setSmartAuthoring(true)}>🧠 Smart Author</button>
          <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={() => setImporting(true)}>⬆ Import agent script</button>
          <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={load}>↻ Refresh</button>
        </div>
      </div>

      {msg && (
        <div style={{ marginBottom: 14, padding: "10px 14px", borderRadius: 8, fontSize: 13,
          background: msg.type === "ok" ? C.statusBg?.passed || "#e6f7f1" : "#fdecea",
          color: msg.type === "ok" ? "#00794f" : "#c62828",
          border: `1px solid ${msg.type === "ok" ? "#b6e8d4" : "#f5c6cb"}` }}>
          {msg.text}
        </div>
      )}

      {loading ? <Spinner /> : rows.length === 0 ? (
        <Empty msg="No agent tests yet. Author one with the agent, then publish it." />
      ) : (
        <div style={{ background: C.card, borderRadius: 12, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: C.card2, borderBottom: `1px solid ${C.border}` }}>
                {["Name", "Project", "Steps", "Status", "Created", "Actions"].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "11px 14px", fontWeight: 700, color: C.textMid, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "11px 14px", maxWidth: 360 }}>
                    <div style={{ fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    {r.goal && <div style={{ fontSize: 11, color: C.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.goal}</div>}
                  </td>
                  <td style={{ padding: "11px 14px", color: C.textMid }}>{projectName(r.project_id)}</td>
                  <td style={{ padding: "11px 14px", color: C.textMid }}>{r.step_count}</td>
                  <td style={{ padding: "11px 14px" }}>
                    <Badge text={r.status} color={r.status === "promoted" ? C.green : C.textDim} />
                  </td>
                  <td style={{ padding: "11px 14px", color: C.textDim, fontSize: 12 }}>
                    {r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—"}
                  </td>
                  <td style={{ padding: "11px 14px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={{ ...s.btn("ghost"), fontSize: 11, padding: "4px 10px" }} onClick={() => view(r.id)}>View</button>
                      <button style={{ ...s.btn("primary"), fontSize: 11, padding: "4px 10px" }} disabled={busyId === r.id} onClick={() => run(r.id)}>
                        {busyId === r.id ? "…" : "▶ Run"}
                      </button>
                      {isAdmin && <button style={{ ...s.btn("ghost"), fontSize: 11, padding: "4px 10px" }} disabled={busyId === r.id} onClick={() => promote(r.id)}>Promote</button>}
                      <button style={{ ...s.btn("ghost"), fontSize: 11, padding: "4px 10px", color: C.red }} disabled={busyId === r.id} onClick={() => del(r.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* View steps modal */}
      {viewing && (
        <ViewModal
          viewing={viewing}
          onClose={() => setViewing(null)}
          onSaved={(g, m) => { setViewing(v => ({ ...v, goal: g })); setMsg({ type: "ok", text: m || "Saved." }); load(); }}
          onError={(text) => setMsg({ type: "err", text })}
        />
      )}
      {importing && (
        <ImportModal
          projects={projects}
          onClose={() => setImporting(false)}
          onDone={(text) => { setImporting(false); setMsg({ type: "ok", text }); load(); }}
          onError={(text) => setMsg({ type: "err", text })}
        />
      )}
      {smartAuthoring && (
        <SmartAuthorModal
          projects={projects}
          onClose={() => setSmartAuthoring(false)}
          onDone={(text) => { setSmartAuthoring(false); setMsg({ type: "ok", text }); load(); }}
          onError={(text) => { setMsg({ type: "err", text }); }}
        />
      )}
      {authoring && (
        <AuthorModal
          projects={projects}
          onClose={() => setAuthoring(false)}
          onDone={(text) => { setAuthoring(false); setMsg({ type: "ok", text }); load(); }}
          onError={(text) => { setMsg({ type: "err", text }); }}
        />
      )}
      {studying && (
        <StudyModal
          onClose={() => setStudying(false)}
          onDone={(text) => { setMsg({ type: "ok", text }); }}
          onError={(text) => { setMsg({ type: "err", text }); }}
        />
      )}
    </div>
  );
}

// ── View modal: shows steps + lets you edit and save the goal in place ────
function ViewModal({ viewing, onClose, onSaved, onError }) {
  const [goal, setGoal] = useState(viewing.goal || "");
  const [pass, setPass] = useState("");
  const [user, setUser] = useState("admin");
  const [busy, setBusy] = useState(false);
  const dirty = goal !== (viewing.goal || "");

  // Re-author: regenerate the steps from the edited goal and overwrite this
  // script in place. Logs in + creates a real SQA record, so it needs the
  // password (not stored) and a confirm. Takes 1-3 minutes.
  const saveAndReauthor = async () => {
    if (!goal.trim()) { onError("Goal can't be empty."); return; }
    if (!pass)        { onError("Login password is required to re-author."); return; }
    if (!confirm("Re-author will drive the form again and CREATE A REAL SQA RECORD, " +
                 "then overwrite this script's steps. Continue?")) return;
    setBusy(true);
    try {
      const r = await api(`/api/agent-tests/${viewing.id}/reauthor`, {
        method: "POST",
        body: {
          goal: goal.trim(),
          login_username: user,
          login_password: pass,
          target_url: viewing.base_url || undefined,
        },
      });
      onSaved(goal.trim(), `Re-authored — ${r.steps} steps regenerated. Reopen to see them.`);
    } catch (e) { onError("Re-author failed: " + e.message); }
    finally { setBusy(false); }
  };

  const fld = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border2}`, fontSize: 13, marginTop: 4 };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={busy ? undefined : onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: 700, maxWidth: "92vw", maxHeight: "85vh", overflow: "auto", padding: 22 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>{viewing.name}</h3>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={onClose}>✕ Close</button>}
        </div>

        <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid, display: "block", marginBottom: 4 }}>Goal</label>
        <textarea
          style={{ ...fld, minHeight: 70, marginTop: 0, fontFamily: "inherit" }}
          value={goal} onChange={e => setGoal(e.target.value)} />

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>Username</label>
            <input style={fld} value={user} onChange={e => setUser(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: C.textMid }}>Password</label>
            <input style={fld} type="password" value={pass} onChange={e => setPass(e.target.value)}
              placeholder="needed to re-author" />
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.yellow, marginTop: 8 }}>
          ⚠ Changing the goal alone does nothing until you re-author. Re-author drives the form
          again, creates a real SQA record, and overwrites the steps below. SQA / dummy only.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, margin: "10px 0 14px" }}>
          <button style={{ ...s.btn("primary"), fontSize: 12 }} disabled={busy || !dirty} onClick={saveAndReauthor}>
            {busy ? "Re-authoring… (1–3 min)" : "Save & re-author"}
          </button>
        </div>
        {busy && (
          <div style={{ fontSize: 12, color: C.textMid, display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <Spinner /> The agent is driving the form on the server. Don't close this.
          </div>
        )}

        <div style={{ fontSize: 12, color: C.textMid, marginBottom: 8 }}>
          Base URL: {viewing.base_url || "—"} · {(viewing.steps || []).length} steps
        </div>
        <ol style={{ margin: 0, paddingLeft: 22, fontFamily: C.mono, fontSize: 12, color: C.text, lineHeight: 1.7 }}>
          {(viewing.steps || []).map((st, i) => (
            <li key={i}>
              <b>{st.action}</b>{st.selector ? ` → ${st.selector}` : ""}{st.value ? ` = "${st.value}"` : ""}
              {st._note ? <span style={{ color: C.textDim }}>  // {st._note}</span> : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ── Import modal: upload an agent script JSON, optionally add a login prelude ──
function ImportModal({ projects, onClose, onDone, onError }) {
  const [doc, setDoc]         = useState(null);   // parsed JSON {meta, steps}
  const [fileName, setFileName] = useState("");
  const [name, setName]       = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [baseUrl, setBaseUrl] = useState("");
  const [addLogin, setAddLogin] = useState(true);
  const [loginUrl, setLoginUrl] = useState("https://sqa.narayanahealth.org/");
  const [targetUrl, setTargetUrl] = useState("https://sqa.narayanahealth.org/ambweb/patient-registration-new");
  const [loginUser, setLoginUser] = useState("admin");
  const [loginPass, setLoginPass] = useState("");
  const [busy, setBusy]       = useState(false);

  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        setDoc(parsed);
        const meta = parsed.meta || {};
        setName(meta.goal ? meta.goal.slice(0, 120) : f.name.replace(/\.json$/, ""));
        if (meta.start_url) setBaseUrl(meta.start_url);
      } catch (err) {
        onError("Could not parse JSON: " + err.message);
        setDoc(null);
      }
    };
    reader.readAsText(f);
  };

  const submit = async () => {
    if (!doc) { onError("Pick a script file first."); return; }
    if (!name.trim()) { onError("Name is required."); return; }
    if (!projectId) { onError("Pick a project."); return; }
    if (addLogin && !loginPass) { onError("Login password is required when adding a login prelude."); return; }
    // strip agent-only annotation keys
    const steps = (doc.steps || []).map(st => {
      const o = {}; for (const k in st) if (!k.startsWith("_")) o[k] = st[k]; return o;
    });
    setBusy(true);
    try {
      const payload = {
        project_id: projectId,
        name: name.trim(),
        goal: doc.meta?.goal || "",
        base_url: baseUrl,
        type: "ui",
        browser: "chrome",
        steps,
        add_login: addLogin,
        login_username: loginUser,
        login_password: loginPass,
        login_url: loginUrl,
        target_url: targetUrl,
      };
      const r = await api("/api/agent-tests", { method: "POST", body: payload });
      onDone(`Imported as agent test #${r.id}` + (addLogin ? " (with login prelude)." : "."));
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  };

  const fld = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border2}`, fontSize: 13, marginTop: 4 };
  const lbl = { fontSize: 12, fontWeight: 600, color: C.textMid, marginTop: 12, display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: 560, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto", padding: 22 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>Import agent script</h3>
          <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>
          Pick a script the agent wrote (agent/output/*.json). It will be stored as a runnable agent test.
        </div>

        <input type="file" accept="application/json,.json" onChange={onFile} style={{ fontSize: 13 }} />
        {fileName && <div style={{ fontSize: 12, color: C.textMid, marginTop: 6 }}>Loaded: {fileName} · {(doc?.steps || []).length} steps</div>}

        <label style={lbl}>Name</label>
        <input style={fld} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Register patient (agent)" />

        <label style={lbl}>Project</label>
        <select style={fld} value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">Select project…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label style={lbl}>Base URL</label>
        <input style={fld} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://sqa.narayanahealth.org/" />

        <label style={{ ...lbl, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={addLogin} onChange={e => setAddLogin(e.target.checked)} />
          Add login prelude (so it replays without manual login)
        </label>

        {addLogin && (
          <div style={{ marginTop: 8, padding: 12, background: C.card2, borderRadius: 8, border: `1px solid ${C.border}` }}>
            <label style={{ ...lbl, marginTop: 0 }}>Login URL</label>
            <input style={fld} value={loginUrl} onChange={e => setLoginUrl(e.target.value)} />
            <label style={lbl}>Target URL (page to land on after login)</label>
            <input style={fld} value={targetUrl} onChange={e => setTargetUrl(e.target.value)} />
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Username</label>
                <input style={fld} value={loginUser} onChange={e => setLoginUser(e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Password</label>
                <input style={fld} type="password" value={loginPass} onChange={e => setLoginPass(e.target.value)} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: C.yellow, marginTop: 8 }}>
              ⚠ The password is stored in the script in plain text. Use only for SQA / dummy accounts.
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button style={{ ...s.btn("ghost"), fontSize: 13 }} onClick={onClose}>Cancel</button>
          <button style={{ ...s.btn("primary"), fontSize: 13 }} disabled={busy || !doc} onClick={submit}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Author modal: type a goal, the agent drives the form and saves a script ──
function AuthorModal({ projects, onClose, onDone, onError }) {
  const [goal, setGoal]       = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [targetUrl, setTargetUrl] = useState("https://sqa.narayanahealth.org/ambweb/patient-registration-new");
  const [loginUrl, setLoginUrl] = useState("https://sqa.narayanahealth.org/");
  const [loginUser, setLoginUser] = useState("admin");
  const [loginPass, setLoginPass] = useState("");
  const [busy, setBusy]       = useState(false);
  const [copied, setCopied]   = useState(false);

  // Build the exact CLI the runner prompt expects (run from the Automation/ root).
  // Flags match runner/agent/headless_author.py: --goal --target-url --login-url
  // --user --password [--headful]. --headful is included so you can watch the
  // browser navigate before deciding to Generate + Run.
  const buildCommand = () => {
    const g = (goal || "").trim().replace(/"/g, '\\"');
    return [
      "python runner/agent/headless_author.py",
      `--goal "${g}"`,
      `--target-url ${targetUrl}`,
      `--login-url ${loginUrl}`,
      `--user ${loginUser}`,
      `--password ${loginPass}`,
      "--headful",
    ].join(" ");
  };

  const copyCommand = async () => {
    if (!goal.trim())  { onError("Describe what the agent should do."); return; }
    if (!targetUrl)    { onError("Target URL is required."); return; }
    if (!loginPass)    { onError("Login password is required."); return; }
    const cmd = buildCommand();
    // navigator.clipboard only works on https/localhost. Over plain http (office
    // IP) it's blocked, so fall back to a hidden textarea + execCommand('copy').
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(cmd);
      } else {
        const ta = document.createElement("textarea");
        ta.value = cmd;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("execCommand failed");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Could not copy — select the command box and copy manually.");
    }
  };

  const submit = async () => {
    if (!goal.trim())  { onError("Describe what the agent should do."); return; }
    if (!projectId)    { onError("Pick a project."); return; }
    if (!targetUrl)    { onError("Target URL is required."); return; }
    if (!loginPass)    { onError("Login password is required."); return; }
    setBusy(true);
    try {
      const r = await api("/api/agent-tests/author", {
        method: "POST",
        body: {
          goal: goal.trim(),
          target_url: targetUrl,
          project_id: projectId,
          login_url: loginUrl,
          login_username: loginUser,
          login_password: loginPass,
        },
      });
      onDone(`Agent created test #${r.id} (${r.steps} steps). Review it below, then Run.`);
    } catch (e) {
      onError("Agent authoring failed: " + e.message);
    } finally { setBusy(false); }
  };

  const fld = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border2}`, fontSize: 13, marginTop: 4 };
  const lbl = { fontSize: 12, fontWeight: 600, color: C.textMid, marginTop: 12, display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={busy ? undefined : onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: 600, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto", padding: 22 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>✨ Create with agent</h3>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={onClose}>✕</button>}
        </div>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>
          Describe the test in plain English. The agent opens the page, logs in, drives the form,
          and saves a replayable script. This takes 1–3 minutes and registers a real record on the
          target environment — use SQA / dummy data only.
        </div>

        <label style={lbl}>Goal</label>
        <textarea style={{ ...fld, minHeight: 80, fontFamily: "inherit" }} value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder='e.g. Register a new patient: First Name Test{{random}}, Last Name Patient, Sex Male, Age 30 years, Consultant Sunil, Correspondence Pincode 560001 City Bangalore, Permanent Pincode 560001 City Bangalore' />
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
          Tip: include the real values the agent should use (consultant name, pincode, city). Add
          {" "}<code>{"{{random}}"}</code> to a name to keep each patient unique.
        </div>

        <label style={lbl}>Project</label>
        <select style={fld} value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">Select project…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label style={lbl}>Target URL (page the agent should drive)</label>
        <input style={fld} value={targetUrl} onChange={e => setTargetUrl(e.target.value)} />

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 2 }}>
            <label style={lbl}>Login URL</label>
            <input style={fld} value={loginUrl} onChange={e => setLoginUrl(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Username</label>
            <input style={fld} value={loginUser} onChange={e => setLoginUser(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Password</label>
            <input style={fld} type="password" value={loginPass} onChange={e => setLoginPass(e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.yellow, marginTop: 8 }}>
          ⚠ The agent submits the form (creates a real record) and the password is sent to the
          server for this run. SQA / dummy accounts only.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 13 }} onClick={onClose}>Cancel</button>}
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 13 }} onClick={copyCommand}>
            {copied ? "✓ Copied" : "⧉ Copy run command"}
          </button>}
          <button style={{ ...s.btn("primary"), fontSize: 13 }} disabled={busy} onClick={submit}>
            {busy ? "Agent working… (1–3 min)" : "Generate"}
          </button>
        </div>
        {busy && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.textMid, display: "flex", alignItems: "center", gap: 8 }}>
            <Spinner /> The agent is driving the form on the server. Please wait — don't close this.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Smart Author modal: plain English goal → three-layer authoring ─────────────────
function SmartAuthorModal({ projects, onClose, onDone, onError }) {
  const [goal, setGoal]           = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [name, setName]           = useState("");
  const [baseUrl, setBaseUrl]     = useState("https://sqa.narayanahealth.org/spmweb/service-purchase-requisition-new");
  const [loginUser, setLoginUser] = useState("admin");
  const [loginPass, setLoginPass] = useState("");
  const [busy, setBusy]           = useState(false);
  const [phase, setPhase]         = useState(""); // current phase description

  const submit = async () => {
    if (!goal.trim())  { onError("Describe what to do in plain English."); return; }
    if (!projectId)    { onError("Pick a project."); return; }
    if (!baseUrl)      { onError("Target URL is required."); return; }
    if (!loginPass)    { onError("Login password is required."); return; }
    setBusy(true);
    setPhase("Layer 1: Loading screen knowledge...");
    try {
      setTimeout(() => setPhase("Layer 2: Mapping goal to fields (one AI call)..."), 2000);
      setTimeout(() => setPhase("Layer 3: Executing on live browser (deterministic)..."), 6000);
      const r = await api("/api/agent-tests/smart-author", {
        method: "POST",
        body: {
          goal: goal.trim(),
          base_url: baseUrl,
          project_id: projectId,
          name: name.trim() || goal.trim().slice(0, 80),
          login_user: loginUser,
          login_password: loginPass,
        },
      });
      onDone(`Smart Author created test #${r.id} (${r.step_count} steps). Review and run it below.`);
    } catch (e) {
      onError("Smart Author failed: " + e.message);
    } finally { setBusy(false); setPhase(""); }
  };

  const fld = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border2}`, fontSize: 13, marginTop: 4 };
  const lbl = { fontSize: 12, fontWeight: 600, color: C.textMid, marginTop: 12, display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={busy ? undefined : onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: 620, maxWidth: "92vw",
        maxHeight: "88vh", overflow: "auto", padding: 22 }}
        onClick={e => e.stopPropagation()}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>🧠 Smart Author</h3>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={onClose}>✕</button>}
        </div>

        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 12,
          padding: "10px 14px", background: "#f3f0ff", borderRadius: 8, border: "1px solid #ddd6fe" }}>
          <b>🧠 Three-layer Smart Author</b><br/>
          <b>Layer 1</b> — Loads screen knowledge (controls + widget patterns from Study Screen)<br/>
          <b>Layer 2</b> — One AI call: maps your plain English goal to field-value pairs<br/>
          <b>Layer 3</b> — Deterministic execution: fills each field using the correct widget pattern<br/>
          <span style={{ color: "#7c3aed" }}>No AI per step. No guessing. Study the screen once — works forever.</span>
        </div>

        <label style={lbl}>Goal (plain English)</label>
        <textarea style={{ ...fld, minHeight: 90, fontFamily: "inherit" }}
          value={goal} onChange={e => setGoal(e.target.value)}
          placeholder="e.g. Create a Service Purchase Requisition with supplier GREENCITY, currency INR, service category Digi Workbook, description Agent test, item S-D-AE02-MARKETING-00001, rate contract SRC175426000006, qty 2, start and end date today, budget ref Digital marketing" />
        <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
          Just describe what you want. No selectors, no keywords, no structure needed.
          The screen must have been studied first (🔍 Study screen).
        </div>

        <label style={lbl}>Name (optional)</label>
        <input style={fld} value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Create SPR - Digi Workbook" />

        <label style={lbl}>Project</label>
        <select style={fld} value={projectId} onChange={e => setProjectId(e.target.value)}>
          <option value="">Select project…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label style={lbl}>Target screen URL</label>
        <input style={fld} value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
          placeholder="https://sqa.narayanahealth.org/spmweb/service-purchase-requisition-new" />

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Username</label>
            <input style={fld} value={loginUser} onChange={e => setLoginUser(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Password</label>
            <input style={fld} type="password" value={loginPass}
              onChange={e => setLoginPass(e.target.value)} />
          </div>
        </div>

        {busy && (
          <div style={{ marginTop: 14, padding: "12px 16px", background: "#f3f0ff",
            borderRadius: 8, border: "1px solid #ddd6fe" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#7c3aed" }}>
              <Spinner /> <span>{phase || "Working..."}</span>
            </div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
              Layer 2 (AI call) takes ~5s. Layer 3 (browser execution) takes ~30-60s.
            </div>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 13 }} onClick={onClose}>Cancel</button>}
          <button style={{ ...s.btn("primary"), fontSize: 13,
            background: busy ? undefined : "#7c3aed", borderColor: busy ? undefined : "#7c3aed" }}
            disabled={busy} onClick={submit}>
            {busy ? "Working..." : "🧠 Generate with Smart Author"}
          </button>
        </div>
      </div>
    </div>
  );
}
// drafts a playbook so "Create with agent" works on that screen. Read-only:
// it logs in, navigates, perceives the controls, and writes a playbook. It
// does NOT submit or create any record.
function StudyModal({ onClose, onDone, onError }) {
  const [targetUrl, setTargetUrl] = useState("");
  const [label, setLabel]         = useState("");
  const [loginUrl, setLoginUrl]   = useState("https://sqa.narayanahealth.org/");
  const [loginUser, setLoginUser] = useState("admin");
  const [loginPass, setLoginPass] = useState("");
  const [busy, setBusy]           = useState(false);
  const [result, setResult]       = useState(null);  // { playbook, controls, match }

  const submit = async () => {
    if (!targetUrl) { onError("Target URL of the screen is required."); return; }
    if (!loginPass) { onError("Login password is required."); return; }
    setBusy(true); setResult(null);
    try {
      const r = await api("/api/agent-tests/study", {
        method: "POST",
        body: {
          target_url: targetUrl,
          label: label.trim(),
          login_url: loginUrl,
          login_username: loginUser,
          login_password: loginPass,
        },
      });
      setResult(r);
      onDone(`Screen studied — playbook drafted (${r.controls ?? "?"} controls). ` +
             `The agent can now author on this screen.`);
    } catch (e) {
      onError("Study failed: " + e.message);
    } finally { setBusy(false); }
  };

  const fld = { width: "100%", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border2}`, fontSize: 13, marginTop: 4 };
  const lbl = { fontSize: 12, fontWeight: 600, color: C.textMid, marginTop: 12, display: "block" };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}
         onClick={busy ? undefined : onClose}>
      <div style={{ background: "#fff", borderRadius: 12, width: 620, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto", padding: 22 }}
           onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: C.text }}>🔍 Study a new screen</h3>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 12 }} onClick={onClose}>✕</button>}
        </div>
        <div style={{ fontSize: 12, color: C.textDim, marginBottom: 8 }}>
          Point the agent at a screen it hasn't seen before. It logs in, opens the page, reads every
          control (fields, dropdowns, buttons, tables), and drafts a playbook that teaches the agent
          how to fill that screen. This is <b>read-only</b> — nothing is submitted. ~30–60 seconds.
          Run this once per new screen, then use “Create with agent” on it.
        </div>

        <label style={lbl}>Screen URL (the page to study)</label>
        <input style={fld} value={targetUrl} onChange={e => setTargetUrl(e.target.value)}
          placeholder="https://sqa.narayanahealth.org/phrweb/some-new-screen" />

        <label style={lbl}>Label (optional — a friendly name for this screen)</label>
        <input style={fld} value={label} onChange={e => setLabel(e.target.value)}
          placeholder="e.g. Goods Receipt Note" />

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 2 }}>
            <label style={lbl}>Login URL</label>
            <input style={fld} value={loginUrl} onChange={e => setLoginUrl(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Username</label>
            <input style={fld} value={loginUser} onChange={e => setLoginUser(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={lbl}>Password</label>
            <input style={fld} type="password" value={loginPass} onChange={e => setLoginPass(e.target.value)} />
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.yellow, marginTop: 8 }}>
          ⚠ The password is sent to the server for this login. SQA / dummy accounts only.
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          {!busy && <button style={{ ...s.btn("ghost"), fontSize: 13 }} onClick={onClose}>Close</button>}
          <button style={{ ...s.btn("primary"), fontSize: 13 }} disabled={busy} onClick={submit}>
            {busy ? "Studying… (30–60s)" : "Study screen"}
          </button>
        </div>
        {busy && (
          <div style={{ marginTop: 12, fontSize: 12, color: C.textMid, display: "flex", alignItems: "center", gap: 8 }}>
            <Spinner /> Reading the screen's controls and drafting a playbook…
          </div>
        )}

        {result && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>
              Drafted playbook{result.controls != null ? ` · ${result.controls} controls read` : ""}
              {result.match ? ` · matches URL containing “${result.match}”` : ""}
            </div>
            <pre style={{ background: C.card2, border: `1px solid ${C.border}`, borderRadius: 8,
              padding: 12, fontSize: 11, lineHeight: 1.6, color: C.text, maxHeight: 280,
              overflow: "auto", whiteSpace: "pre-wrap", fontFamily: C.mono }}>
              {result.playbook || "(playbook saved on server)"}
            </pre>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
              Saved on the server. You can refine it later. The agent will use it automatically when
              authoring on this screen.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
