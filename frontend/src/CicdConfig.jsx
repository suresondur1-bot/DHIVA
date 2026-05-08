import React, { useState, useEffect } from "react";
import { api, s, C, API } from "./shared.jsx";

// ── File Generators ────────────────────────────────────────────────────────
function generateGithubActions({ serverUrl, ciKey, suiteId, browser, timeout, branch }) {
  return [
    "name: ATHMA Automated Tests",
    "",
    "on:",
    "  push:",
    `    branches: [ "${branch || "main"}" ]`,
    "  pull_request:",
    `    branches: [ "${branch || "main"}" ]`,
    "  workflow_dispatch:",
    "",
    "jobs:",
    "  athma-tests:",
    "    runs-on: ubuntu-latest",
    `    timeout-minutes: ${timeout || 60}`,
    "",
    "    steps:",
    "      - name: Checkout code",
    "        uses: actions/checkout@v4",
    "",
    "      - name: Trigger ATHMA Suite Run",
    "        id: trigger",
    "        run: |",
    "          RESPONSE=$(curl -s -X POST \\",
    `            "${serverUrl}/api/ci/trigger" \\`,
    '            -H "x-ci-key: ${{ secrets.ATHMA_CI_KEY }}" \\',
    '            -H "Content-Type: application/json" \\',
    `            -d '{"type":"suite","id":${suiteId},"browser":"${browser}"}')`,
    "          echo \"Response: $RESPONSE\"",
    "          SUITE_RUN_ID=$(echo $RESPONSE | python3 -c \"import sys,json; print(json.load(sys.stdin)['suite_run_id'])\")",
    "          echo \"suite_run_id=$SUITE_RUN_ID\" >> $GITHUB_OUTPUT",
    "",
    "      - name: Poll Until Complete",
    "        run: |",
    "          SUITE_RUN_ID=${{ steps.trigger.outputs.suite_run_id }}",
    "          ELAPSED=0",
    "          while true; do",
    `            RESULT=$(curl -s "${serverUrl}/api/ci/suite-status/$SUITE_RUN_ID" \\`,
    '              -H "x-ci-key: ${{ secrets.ATHMA_CI_KEY }}")',
    "            STATUS=$(echo $RESULT | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d['status'])\")",
    "            PASSED=$(echo $RESULT | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d['passed'])\")",
    "            FAILED=$(echo $RESULT | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d['failed'])\")",
    "            DONE=$(echo $RESULT   | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d['done'])\")",
    '            echo "[$ELAPSED s] Status: $STATUS | Passed: $PASSED | Failed: $FAILED"',
    '            if [ "$DONE" = "True" ]; then',
    '              [ "$FAILED" -gt "0" ] && exit 1',
    "              exit 0",
    "            fi",
    `            [ "$ELAPSED" -ge "${(timeout || 60) * 60}" ] && exit 1`,
    "            sleep 30; ELAPSED=$((ELAPSED+30))",
    "          done",
    "",
    "# SETUP:",
    "# 1. Place at: .github/workflows/athma-tests.yml",
    "# 2. GitHub repo > Settings > Secrets > Actions > New secret",
    `#    Name: ATHMA_CI_KEY   Value: ${ciKey}`,
    `# 3. Push to ${branch || "main"} - pipeline runs automatically`,
  ].join("\n");
}

function generateJenkinsfile({ serverUrl, ciKey, suiteId, browser, timeout }) {
  return [
    "pipeline {",
    "    agent any",
    "    environment {",
    `        ATHMA_URL    = '${serverUrl}'`,
    "        ATHMA_CI_KEY = credentials('ATHMA_CI_KEY')",
    `        SUITE_ID     = '${suiteId}'`,
    `        BROWSER      = '${browser}'`,
    "    }",
    `    options { timeout(time: ${timeout || 60}, unit: 'MINUTES') }`,
    "    stages {",
    "        stage('Trigger ATHMA Suite') {",
    "            steps {",
    "                script {",
    "                    def response = sh(script: \"\"\"",
    "                        curl -s -X POST \"${ATHMA_URL}/api/ci/trigger\" \\",
    "                          -H \"x-ci-key: ${ATHMA_CI_KEY}\" \\",
    "                          -H \"Content-Type: application/json\" \\",
    "                          -d '{\"type\":\"suite\",\"id\":${SUITE_ID},\"browser\":\"${BROWSER\"}'",
    "                    \"\"\", returnStdout: true).trim()",
    "                    def json = readJSON text: response",
    "                    env.SUITE_RUN_ID = json.suite_run_id.toString()",
    "                    echo \"Suite Run ID: ${env.SUITE_RUN_ID}\"",
    "                }",
    "            }",
    "        }",
    "        stage('Wait for Results') {",
    "            steps {",
    "                script {",
    "                    def elapsed = 0",
    "                    while (true) {",
    "                        def result = sh(script: \"\"\"",
    "                            curl -s \"${ATHMA_URL}/api/ci/suite-status/${env.SUITE_RUN_ID}\" \\",
    "                              -H \"x-ci-key: ${ATHMA_CI_KEY}\"",
    "                        \"\"\", returnStdout: true).trim()",
    "                        def json = readJSON text: result",
    "                        echo \"[${elapsed}s] ${json.status} | Passed: ${json.passed} | Failed: ${json.failed}\"",
    "                        if (json.done) {",
    "                            if (json.failed > 0) error(\"${json.failed} test(s) failed!\")",
    "                            echo \"All ${json.passed} tests passed!\"",
    "                            break",
    "                        }",
    `                        if (elapsed >= ${(timeout || 60) * 60}) error("Timeout!")`,
    "                        sleep(30); elapsed += 30",
    "                    }",
    "                }",
    "            }",
    "        }",
    "    }",
    "    post {",
    "        success { echo 'ATHMA tests passed!' }",
    "        failure { echo 'ATHMA tests FAILED!' }",
    "    }",
    "}",
    "// SETUP:",
    "// 1. Place at root of repo as: Jenkinsfile",
    "// 2. Manage Jenkins > Credentials > Add Credential",
    `//    Kind: Secret text   ID: ATHMA_CI_KEY   Value: ${ciKey}`,
    "// 3. New Item > Pipeline > point to repo",
  ].join("\n");
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: "text/plain" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Build PowerShell command using array join (avoids backslash issues) ───────
function buildPs(serverUrl, ciKey, suiteId, browser, timeout, suiteName, mode) {
  const bt   = "`"; // PowerShell line continuation = backtick
  const tout = parseInt(timeout) || 60;

  if (mode === "trigger") {
    return [
      `$response = Invoke-RestMethod ${bt}`,
      `    -Uri "${serverUrl}/api/ci/trigger" ${bt}`,
      `    -Method POST ${bt}`,
      `    -Headers @{"x-ci-key"="${ciKey}"; "Content-Type"="application/json"} ${bt}`,
      `    -Body '{"type":"suite","id":${suiteId},"browser":"${browser}"}'`,
      ``,
      `$sid   = $response.suite_run_id`,
      `$cnt   = $response.total`,
      `Write-Host "Suite Run ID: $sid"`,
      `Write-Host "Total Tests : $cnt"`,
    ].join("\n");
  }

  if (mode === "poll") {
    return [
      `$key = "${ciKey}"`,
      `$id  = 0  # <-- Replace with your suite_run_id`,
      ``,
      `while ($true) {`,
      `    $r = Invoke-RestMethod ${bt}`,
      `        -Uri "${serverUrl}/api/ci/suite-status/$id" ${bt}`,
      `        -Headers @{"x-ci-key"=$key}`,
      `    Write-Host "$(Get-Date -f HH:mm:ss) | $($r.status) | Passed: $($r.passed) | Failed: $($r.failed) | Pending: $($r.pending)"`,
      `    if ($r.done) {`,
      `        if ($r.status -eq "passed") { Write-Host "ALL PASSED!" -ForegroundColor Green }`,
      `        else { Write-Host "FAILED - $($r.failed) tests failed" -ForegroundColor Red }`,
      `        break`,
      `    }`,
      `    Start-Sleep 10`,
      `}`,
    ].join("\n");
  }

  // full
  return [
    `# Step 1 - Trigger Suite: ${suiteName}`,
    `$key = "${ciKey}"`,
    `$response = Invoke-RestMethod ${bt}`,
    `    -Uri "${serverUrl}/api/ci/trigger" ${bt}`,
    `    -Method POST ${bt}`,
    `    -Headers @{"x-ci-key"=$key; "Content-Type"="application/json"} ${bt}`,
    `    -Body '{"type":"suite","id":${suiteId},"browser":"${browser}"}'`,
    `$id    = $response.suite_run_id`,
    `$cnt   = $response.total`,
    `Write-Host "Suite Run ID: $id | Total: $cnt tests" -ForegroundColor Cyan`,
    ``,
    `# Step 2 - Poll until complete (timeout: ${tout} min)`,
    `$maxWait = ${tout * 60}`,
    `$elapsed = 0`,
    `while ($true) {`,
    `    $r = Invoke-RestMethod ${bt}`,
    `        -Uri "${serverUrl}/api/ci/suite-status/$id" ${bt}`,
    `        -Headers @{"x-ci-key"=$key}`,
    `    Write-Host "$(Get-Date -f HH:mm:ss) | $($r.status) | Passed: $($r.passed) | Failed: $($r.failed) | Pending: $($r.pending)"`,
    `    if ($r.done) {`,
    `        if ($r.status -eq "passed") { Write-Host "ALL PASSED!" -ForegroundColor Green; exit 0 }`,
    `        else { Write-Host "FAILED - $($r.failed) tests failed" -ForegroundColor Red; exit 1 }`,
    `    }`,
    `    if ($elapsed -ge $maxWait) { Write-Host "Timeout after ${tout} min" -ForegroundColor Yellow; exit 1 }`,
    `    Start-Sleep 10`,
    `    $elapsed += 10`,
    `}`,
  ].join("\n");
}

// ── New Key Modal ─────────────────────────────────────────────────────────────
function NewKeyModal({ keyData, onClose, onUse }) {
  const [copied, setCopied] = useState(false);
  function copyKey() {
    navigator.clipboard?.writeText(keyData.key).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    });
  }
  return (
    <div style={s.modal} onClick={onClose}>
      <div style={{ ...s.modalBox, maxWidth: 520 }} onClick={e => e.stopPropagation()}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🔑</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>CI Key Generated!</div>
          <div style={{ fontSize: 12, color: C.textDim, marginTop: 4 }}>
            <b style={{ color: C.red }}>Save this key now</b> — the full key is only shown once.
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Label</label>
          <div style={{ ...s.input, background: "#f8f9fc", color: C.textMid }}>{keyData.label}</div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={s.label}>Full CI Key — click to select all, then copy</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              readOnly value={keyData.key}
              onFocus={e => e.target.select()}
              onClick={e => e.target.select()}
              style={{ ...s.input, flex: 1, fontFamily: C.mono, fontSize: 12,
                background: "#f0f7ff", border: `2px solid ${C.accent}`, fontWeight: 600 }}
            />
            <button style={{ ...s.btn(copied ? "success" : "primary"), whiteSpace: "nowrap" }} onClick={copyKey}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
        <div style={{ background: "#e6f7f1", border: `1px solid #a7f3d0`, borderRadius: 6,
          padding: "10px 14px", fontSize: 12, color: "#065f46", marginBottom: 20 }}>
          This key is saved automatically in the dropdown — no need to copy every time.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={s.btn("ghost")} onClick={onClose}>Close</button>
          <button style={s.btn("primary")} onClick={() => { onUse(keyData.key); onClose(); }}>
            Use This Key
          </button>
        </div>
      </div>
    </div>
  );
}

// ── PowerShell Command Box ────────────────────────────────────────────────────
function PsCommandBox({ serverUrl, ciKey, suiteId, browser, timeout, suiteName }) {
  const [copied, setCopied] = useState(false);
  const [mode,   setMode]   = useState("full");

  const current = buildPs(serverUrl, ciKey, suiteId, browser, timeout, suiteName, mode);

  function copy() {
    navigator.clipboard?.writeText(current).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2500);
    });
  }

  return (
    <div style={{ border: `2px solid #dde8ff`, borderRadius: 8,
      background: "#f7f9ff", padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 2 }}>
            💻 PowerShell Command
          </div>
          <div style={{ fontSize: 11, color: C.textDim }}>
            Copy and run in PowerShell to trigger <b>{suiteName}</b> manually
          </div>
        </div>
        <button style={{ ...s.btn(copied ? "success" : "primary", true), minWidth: 90 }} onClick={copy}>
          {copied ? "✅ Copied!" : "📋 Copy"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {[
          { key: "full",    label: "Full (Trigger + Poll)" },
          { key: "trigger", label: "Trigger Only" },
          { key: "poll",    label: "Poll Only" },
        ].map(m => (
          <button key={m.key} onClick={() => setMode(m.key)}
            style={{ ...s.btn(mode === m.key ? "primary" : "ghost", true), fontSize: 11, padding: "4px 10px" }}>
            {m.label}
          </button>
        ))}
      </div>

      <textarea
        readOnly value={current}
        onFocus={e => e.target.select()}
        style={{ width: "100%", minHeight: 180, fontFamily: C.mono, fontSize: 11,
          background: "#0f172a", color: "#a5f3fc", border: "none", borderRadius: 6,
          padding: 14, lineHeight: 1.7, resize: "vertical", outline: "none",
          boxSizing: "border-box", cursor: "text" }}
      />
      <div style={{ fontSize: 11, color: C.textDim, marginTop: 6 }}>
        💡 <b>Full</b> = triggers and waits for results &nbsp;|&nbsp;
        <b>Trigger Only</b> = starts run then exits &nbsp;|&nbsp;
        <b>Poll Only</b> = monitors an existing run (replace $id = 0 with your suite_run_id)
      </div>
    </div>
  );
}

// ── Preview Modal ─────────────────────────────────────────────────────────────
function PreviewModal({ title, content, onClose }) {
  return (
    <div style={s.modal} onClick={onClose}>
      <div style={{ ...s.modalBox, maxWidth: 860, maxHeight: "88vh" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontWeight: 700, fontSize: 15, color: C.text }}>📄 {title}</span>
          <button onClick={onClose} style={{ ...s.btn("ghost", true), fontSize: 18, padding: "2px 8px" }}>✕</button>
        </div>
        <pre style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderRadius: 6,
          padding: 16, fontSize: 12, lineHeight: 1.7, fontFamily: C.mono, color: C.text,
          whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "70vh", overflowY: "auto", margin: 0 }}>
          {content}
        </pre>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function CicdConfig() {
  const TABS = [
    { key: "server",   label: "1. Server Settings",    icon: "🌐" },
    { key: "pipeline", label: "2. Pipeline Settings",   icon: "🔧" },
    { key: "download", label: "3. Download Files",      icon: "📥" },
    { key: "devops",   label: "4. DevOps Instructions", icon: "📋" },
  ];

  const [activeTab,   setActiveTab]   = useState("server");
  const [suites,      setSuites]      = useState([]);
  const [savedKeys,   setSavedKeys]   = useState(() => {
    try { return JSON.parse(localStorage.getItem("athma_saved_ci_keys") || "[]"); }
    catch { return []; }
  });
  const [loading,     setLoading]     = useState(true);
  const [fileSaved,   setFileSaved]   = useState(false);
  const [preview,     setPreview]     = useState(null);
  const [newKeyModal, setNewKeyModal] = useState(null);

  const [serverUrl, setServerUrl] = useState(API);
  const [ciKey,     setCiKey]     = useState(localStorage.getItem("athma_ci_key") || "");
  const [suiteId,   setSuiteId]   = useState("");
  const [browser,   setBrowser]   = useState("chrome");
  const [timeout,   setTimeout_]  = useState("60");
  const [branch,    setBranch]    = useState("main");
  const [platform,  setPlatform]  = useState("both");

  useEffect(() => { if (ciKey) localStorage.setItem("athma_ci_key", ciKey); }, [ciKey]);

  useEffect(() => {
    (async () => {
      try {
        const sv = await api("/api/suites").catch(() => []);
        const sl = Array.isArray(sv) ? sv : [];
        setSuites(sl);
        if (sl.length) setSuiteId(String(sl[0].id));
      } finally { setLoading(false); }
    })();
  }, []);

  const params = { serverUrl, ciKey, suiteId, browser, timeout: parseInt(timeout) || 60, branch };
  const isValid = !!(serverUrl && ciKey && ciKey.startsWith("ci-") && suiteId);
  const selectedSuite = suites.find(su => String(su.id) === String(suiteId));

  function handleDownload(type) {
    if (!isValid) return;
    if (type === "github" || type === "both") downloadFile(generateGithubActions(params), "athma-tests.yml");
    if (type === "jenkins"|| type === "both") downloadFile(generateJenkinsfile(params), "Jenkinsfile");
    setFileSaved(true); setTimeout(() => setFileSaved(false), 3000);
  }

  function tabDone(key) {
    if (key === "server")   return !!(serverUrl && ciKey && ciKey.startsWith("ci-") && suiteId);
    if (key === "pipeline") return !!(timeout && branch && platform);
    return false;
  }

  async function generateNewKey() {
    const label = prompt("Enter a label for this CI key (e.g. GitHub Actions Key):");
    if (!label) return;
    try {
      const res = await api("/api/ci/keys", { method: "POST", body: { label } });
      const fullKey = res.key || res.api_key || "";
      if (!fullKey) { alert("Key not returned from server"); return; }
      const newEntry = { id: res.id, label, key: fullKey, created_at: new Date().toISOString() };
      const updated  = [newEntry, ...savedKeys.filter(k => k.key !== fullKey)];
      setSavedKeys(updated);
      localStorage.setItem("athma_saved_ci_keys", JSON.stringify(updated));
      setCiKey(fullKey);
      setNewKeyModal({ key: fullKey, label });
    } catch(e) { alert("Failed to generate key: " + e.message); }
  }

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
      <div style={{ width: 28, height: 28, border: `2px solid ${C.border}`,
        borderTop: `2px solid ${C.accent}`, borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{ animation: "fadeIn 0.2s ease" }}>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Page Header */}
      <div style={{ marginBottom: 20, display: "flex", alignItems: "flex-start",
        justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={s.pageTitle}>⚙️ CI/CD Configuration</div>
          <div style={{ fontSize: 13, color: C.textDim, marginTop: 4 }}>
            Configure and download CI/CD pipeline files. Hand them to your DevOps team to place in the application repo.
          </div>
        </div>
        {isValid && selectedSuite && (
          <div style={{ background: "#e3f0fb", border: `1px solid #bcd6f5`,
            borderRadius: 7, padding: "8px 14px", fontSize: 12 }}>
            <span style={{ color: C.accent, fontWeight: 700 }}>Suite: </span>
            <span style={{ color: C.text, fontWeight: 600 }}>{selectedSuite.name}</span>
            <span style={{ color: C.textDim }}> · {selectedSuite.test_count || "?"} tests · {browser}</span>
          </div>
        )}
      </div>

      {/* Tab Bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "#fff",
        border: `1px solid ${C.border}`, borderRadius: 8, padding: 6,
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        {TABS.map(tab => {
          const active = activeTab === tab.key;
          const done   = tabDone(tab.key);
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
              flex: 1, padding: "10px 8px", border: "none", borderRadius: 6, cursor: "pointer",
              fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: "'Inter','Segoe UI',sans-serif",
              background: active ? C.accent : "transparent",
              color: active ? "#fff" : done ? C.green : C.textMid,
              display: "flex", alignItems: "center", justifyContent: "center",
              gap: 6, transition: "all 0.15s",
            }}>
              <span>{tab.icon}</span>
              <span style={{ whiteSpace: "nowrap" }}>{tab.label}</span>
              {done && !active && (
                <span style={{ fontSize: 10, background: C.green, color: "#fff", borderRadius: "50%",
                  width: 16, height: 16, display: "inline-flex", alignItems: "center",
                  justifyContent: "center", flexShrink: 0 }}>✓</span>
              )}
            </button>
          );
        })}
      </div>

      {/* TAB 1: SERVER SETTINGS */}
      {activeTab === "server" && (
        <div style={s.card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🌐 Server Settings</div>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>
            Enter your ATHMA server details, select the CI key and suite to run.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
            <div>
              <label style={s.label}>ATHMA Server URL <span style={{ color: C.red }}>*</span></label>
              <input style={s.input} value={serverUrl} onChange={e => setServerUrl(e.target.value)}
                placeholder="http://172.19.2.x:6001" />
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
                Use LAN IP for production (e.g. http://172.19.2.x:6001)
              </div>
            </div>
            <div>
              <label style={s.label}>CI API Key <span style={{ color: C.red }}>*</span></label>
              <div style={{ display: "flex", gap: 8 }}>
                {savedKeys.length > 0 ? (
                  <select style={{ ...s.input, flex: 1, fontFamily: C.mono, fontSize: 12 }}
                    value={ciKey} onChange={e => setCiKey(e.target.value)}>
                    <option value="">-- Select a key --</option>
                    {savedKeys.map(k => (
                      <option key={k.id || k.key} value={k.key}>
                        {k.label} — {k.key.slice(0, 20)}...
                      </option>
                    ))}
                    <option value="__paste__">Paste a key manually...</option>
                  </select>
                ) : (
                  <input style={{ ...s.input, flex: 1, fontFamily: C.mono, fontSize: 12 }}
                    value={ciKey} onChange={e => setCiKey(e.target.value)}
                    placeholder="ci-xxxxxxxxxxxx" />
                )}
                <button style={s.btn("success", true)} onClick={generateNewKey}>+ New Key</button>
              </div>
              {ciKey === "__paste__" && (
                <input style={{ ...s.input, marginTop: 6, fontFamily: C.mono, fontSize: 12 }}
                  onChange={e => setCiKey(e.target.value)}
                  placeholder="Paste full CI key: ci-xxxxxxxx..." autoFocus />
              )}
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>
                {savedKeys.length > 0
                  ? `${savedKeys.length} saved key(s) available`
                  : "Click + New Key to generate your first CI key"}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
            <div>
              <label style={s.label}>Test Suite <span style={{ color: C.red }}>*</span></label>
              {suites.length > 0 ? (
                <select style={s.input} value={suiteId} onChange={e => setSuiteId(e.target.value)}>
                  {suites.map(su => (
                    <option key={su.id} value={String(su.id)}>
                      {su.name} ({su.test_count || 0} tests)
                    </option>
                  ))}
                </select>
              ) : (
                <input style={s.input} value={suiteId} onChange={e => setSuiteId(e.target.value)}
                  placeholder="Enter Suite ID e.g. 18" />
              )}
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Suite to run in CI pipeline</div>
            </div>
            <div>
              <label style={s.label}>Browser <span style={{ color: C.red }}>*</span></label>
              <select style={s.input} value={browser} onChange={e => setBrowser(e.target.value)}>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Microsoft Edge</option>
                <option value="safari">Safari (WebKit)</option>
              </select>
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Browser to use for tests</div>
            </div>
          </div>

          {!isValid && (
            <div style={{ background: "#fff8e6", border: `1px solid #fde68a`, borderRadius: 6,
              padding: "10px 14px", fontSize: 12, color: "#92400e", marginBottom: 16 }}>
              Please fill all required fields. CI Key must start with <code style={{ fontFamily: C.mono }}>ci-</code>
            </div>
          )}
          {isValid && (
            <div style={{ background: "#e6f7f1", border: `1px solid #a7f3d0`, borderRadius: 6,
              padding: "10px 14px", fontSize: 12, color: "#065f46", marginBottom: 16 }}>
              ✅ Settings complete — proceed to Pipeline Settings
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button style={s.btn("primary")} onClick={() => setActiveTab("pipeline")}>
              Next: Pipeline Settings →
            </button>
          </div>
        </div>
      )}

      {/* TAB 2: PIPELINE SETTINGS */}
      {activeTab === "pipeline" && (
        <div style={s.card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🔧 Pipeline Settings</div>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>
            Configure how the CI pipeline should behave.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
            <div>
              <label style={s.label}>Timeout (minutes)</label>
              <input style={s.input} type="number" value={timeout} onChange={e => setTimeout_(e.target.value)}
                placeholder="60" min="5" max="300" />
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Max time before pipeline auto-fails</div>
            </div>
            <div>
              <label style={s.label}>Trigger Branch</label>
              <input style={s.input} value={branch} onChange={e => setBranch(e.target.value)} placeholder="main" />
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Git branch that triggers pipeline on push</div>
            </div>
            <div>
              <label style={s.label}>CI/CD Platform <span style={{ color: C.red }}>*</span></label>
              <select style={s.input} value={platform} onChange={e => setPlatform(e.target.value)}>
                <option value="both">Both (GitHub Actions + Jenkins)</option>
                <option value="github">GitHub Actions only</option>
                <option value="jenkins">Jenkins only</option>
              </select>
              <div style={{ fontSize: 11, color: C.textDim, marginTop: 4 }}>Which CI files to generate</div>
            </div>
          </div>
          <div style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderRadius: 7, padding: 14, marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, marginBottom: 8 }}>How it works</div>
            <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.7 }}>
              When code is pushed to <b>{branch || "main"}</b>:<br />
              1. Pipeline calls ATHMA API to trigger suite <b>{selectedSuite?.name || `ID: ${suiteId}`}</b><br />
              2. Polls every 30 seconds (max {timeout || 60} minutes)<br />
              3. Pass ✅ if all tests pass — Fail ❌ if any test fails
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button style={s.btn("ghost")} onClick={() => setActiveTab("server")}>← Back</button>
            <button style={s.btn("primary")} onClick={() => setActiveTab("download")}>Next: Download Files →</button>
          </div>
        </div>
      )}

      {/* TAB 3: DOWNLOAD FILES */}
      {activeTab === "download" && (
        <div style={s.card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>📥 Generate & Download Files</div>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>
            Review summary, download files, and copy the PowerShell command for manual testing.
          </div>

          {isValid && (
            <div style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderRadius: 7, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMid, marginBottom: 12 }}>Configuration Summary</div>
              <table style={{ ...s.table, fontSize: 13 }}>
                <tbody>
                  {[
                    ["Server URL",  serverUrl],
                    ["Suite",       `${selectedSuite?.name || "—"} (ID: ${suiteId})`],
                    ["Test Cases",  `${selectedSuite?.test_count || "?"} tests`],
                    ["Browser",     browser.charAt(0).toUpperCase() + browser.slice(1)],
                    ["Branch",      branch || "main"],
                    ["Timeout",     `${timeout || 60} minutes`],
                    ["Platform",    platform === "both" ? "GitHub Actions + Jenkins" : platform === "github" ? "GitHub Actions" : "Jenkins"],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ ...s.td, fontWeight: 600, color: C.textMid, width: 140, borderBottom: `1px solid ${C.border}` }}>{k}</td>
                      <td style={{ ...s.td, fontFamily: k === "Server URL" ? C.mono : "inherit",
                        fontSize: k === "Server URL" ? 12 : 13, borderBottom: `1px solid ${C.border}` }}>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!isValid && (
            <div style={{ background: "#fdecea", border: `1px solid #fca5a5`, borderRadius: 6,
              padding: "12px 16px", fontSize: 13, color: C.red, marginBottom: 20 }}>
              Please complete Server Settings (Tab 1) first.
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
            {(platform === "github" || platform === "both") && (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 16,
                display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>GitHub Actions</div>
                  <div style={{ fontSize: 12, color: C.textDim }}>
                    File: <code style={{ fontFamily: C.mono, background: "#f0f2f5", padding: "1px 6px", borderRadius: 3 }}>athma-tests.yml</code>
                    &nbsp;→&nbsp;place in <code style={{ fontFamily: C.mono, background: "#f0f2f5", padding: "1px 6px", borderRadius: 3 }}>.github/workflows/</code>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={s.btn("ghost", true)} disabled={!isValid}
                    onClick={() => setPreview({ title: "athma-tests.yml", content: generateGithubActions(params) })}>
                    👁 Preview
                  </button>
                  <button style={s.btn("primary", true)} disabled={!isValid}
                    onClick={() => handleDownload("github")}>⬇ Download</button>
                </div>
              </div>
            )}
            {(platform === "jenkins" || platform === "both") && (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 16,
                display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>Jenkins Pipeline</div>
                  <div style={{ fontSize: 12, color: C.textDim }}>
                    File: <code style={{ fontFamily: C.mono, background: "#f0f2f5", padding: "1px 6px", borderRadius: 3 }}>Jenkinsfile</code>
                    &nbsp;→&nbsp;place at repo root
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={s.btn("ghost", true)} disabled={!isValid}
                    onClick={() => setPreview({ title: "Jenkinsfile", content: generateJenkinsfile(params) })}>
                    👁 Preview
                  </button>
                  <button style={{ ...s.btn("ghost", true), background: "#6c5ce7", color: "#fff", border: "none" }}
                    disabled={!isValid} onClick={() => handleDownload("jenkins")}>⬇ Download</button>
                </div>
              </div>
            )}
            {platform === "both" && (
              <button style={{ ...s.btn("success"), width: "100%", justifyContent: "center",
                padding: "12px 20px", fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}
                disabled={!isValid} onClick={() => handleDownload("both")}>
                ⬇ Download Both Files
              </button>
            )}
          </div>

          {fileSaved && (
            <div style={{ background: "#e6f7f1", border: `1px solid #a7f3d0`, borderRadius: 6,
              padding: "10px 14px", fontSize: 13, color: "#065f46", fontWeight: 600, marginBottom: 16 }}>
              ✅ File(s) downloaded! See Tab 4 for DevOps setup instructions.
            </div>
          )}

          {isValid && (
            <PsCommandBox
              serverUrl={serverUrl} ciKey={ciKey} suiteId={suiteId}
              browser={browser} timeout={timeout} suiteName={selectedSuite?.name || "Suite"}
            />
          )}

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <button style={s.btn("ghost")} onClick={() => setActiveTab("pipeline")}>← Back</button>
            <button style={s.btn("primary")} onClick={() => setActiveTab("devops")}>Next: DevOps Instructions →</button>
          </div>
        </div>
      )}

      {/* TAB 4: DEVOPS INSTRUCTIONS */}
      {activeTab === "devops" && (
        <div style={s.card}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>📋 DevOps Team Instructions</div>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 20 }}>
            Share these steps with your DevOps team. They only need to do this once.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            {(platform === "github" || platform === "both") && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: C.accent, marginBottom: 12,
                  paddingBottom: 8, borderBottom: `2px solid ${C.accent}` }}>GitHub Actions Setup</div>
                <table style={s.table}>
                  <tbody>
                    {[
                      ["Step 1", "Add file to repo",            ".github/workflows/athma-tests.yml"],
                      ["Step 2", "Open repo Settings",          "Settings > Secrets > Actions"],
                      ["Step 3", "New repository secret",       ""],
                      ["Step 4", "Secret Name",                 "ATHMA_CI_KEY"],
                      ["Step 5", "Secret Value",                ciKey || "ci-xxxxxxxxxxxxx"],
                      ["Step 6", "Push to " + (branch||"main"),"Pipeline runs automatically"],
                    ].map(([step, label, val]) => (
                      <tr key={step}>
                        <td style={{ ...s.td, width: 64, borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ background: C.accent, color: "#fff", fontWeight: 700,
                            fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>{step}</span>
                        </td>
                        <td style={{ ...s.td, borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{label}</div>
                          {val && <div style={{ fontSize: 11, color: C.textDim, fontFamily: C.mono, marginTop: 2, wordBreak: "break-all" }}>{val}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(platform === "jenkins" || platform === "both") && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#6c5ce7", marginBottom: 12,
                  paddingBottom: 8, borderBottom: "2px solid #6c5ce7" }}>Jenkins Setup</div>
                <table style={s.table}>
                  <tbody>
                    {[
                      ["Step 1", "Add file to repo root",   "Jenkinsfile (no extension)"],
                      ["Step 2", "Open Jenkins",            "Manage Jenkins > Credentials"],
                      ["Step 3", "Add Credential",          "Kind: Secret text"],
                      ["Step 4", "Credential ID",           "ATHMA_CI_KEY"],
                      ["Step 5", "Credential Value",        ciKey || "ci-xxxxxxxxxxxxx"],
                      ["Step 6", "Create Pipeline job",     "New Item > Pipeline > point to repo"],
                    ].map(([step, label, val]) => (
                      <tr key={step}>
                        <td style={{ ...s.td, width: 64, borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ background: "#6c5ce7", color: "#fff", fontWeight: 700,
                            fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>{step}</span>
                        </td>
                        <td style={{ ...s.td, borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{label}</div>
                          {val && <div style={{ fontSize: 11, color: C.textDim, fontFamily: C.mono, marginTop: 2, wordBreak: "break-all" }}>{val}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderRadius: 7,
            padding: 16, marginTop: 20 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 10, fontSize: 13 }}>End-to-End Flow</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
              {["Developer pushes code", "→", "CI pipeline triggers", "→",
                `ATHMA runs ${selectedSuite?.name || "suite"}`, "→",
                `${selectedSuite?.test_count || "?"} tests execute`, "→",
                "Pass / Fail"].map((item, i) => (
                <span key={i} style={{ fontWeight: item === "→" ? 400 : 600,
                  color: item === "→" ? C.textDim : C.text }}>{item}</span>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
            <button style={s.btn("ghost")} onClick={() => setActiveTab("download")}>← Back</button>
            <button style={s.btn("success")} disabled={!isValid} onClick={() => handleDownload("both")}>
              ⬇ Download All Files
            </button>
          </div>
        </div>
      )}

      {newKeyModal && (
        <NewKeyModal keyData={newKeyModal} onClose={() => setNewKeyModal(null)} onUse={key => setCiKey(key)} />
      )}
      {preview && <PreviewModal title={preview.title} content={preview.content} onClose={() => setPreview(null)} />}
    </div>
  );
}
