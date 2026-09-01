// ============================================================================
//  AGENT TEST CASES — additive routes for server.js
//  Paste this block into server.js (e.g. right AFTER the existing
//  app.post("/api/tests", ...) / app.put("/api/tests/:id", ...) routes).
//  It reuses the SAME helpers already defined in server.js:
//    pool, requireAuth, requireRole, spawnRunner, broadcast, RUNNER_PATH,
//    activeRunPids, getAllowedProjectIds.
//  It does NOT modify any existing route. It only adds /api/agent-tests/*.
//  Prereq: run agent_test_cases.sql once to create the table.
// ============================================================================

// ── LIST agent tests (optionally by project) ────────────────────────────────
app.get("/api/agent-tests", requireAuth, async (req, res) => {
  try {
    const { project_id } = req.query;
    const params = [];
    let where = "";
    if (project_id) { params.push(project_id); where = "WHERE project_id = $1"; }
    const r = await pool.query(
      `SELECT id, project_id, name, goal, base_url, type, browser,
              jsonb_array_length(steps) AS step_count,
              status, approved, promoted_test_case_id, created_at
         FROM agent_test_cases ${where}
        ORDER BY created_at DESC`, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET one agent test (full steps) ─────────────────────────────────────────
app.get("/api/agent-tests/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CREATE an agent test (called by agent/publish.py) ───────────────────────
app.post("/api/agent-tests", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { project_id, name, goal, base_url, type, browser, steps, variables } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  try {
    const r = await pool.query(
      `INSERT INTO agent_test_cases (project_id, name, goal, base_url, type, browser, steps, variables, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [project_id || null, name.trim(), goal || null, base_url || null,
       type || "ui", browser || "chrome",
       JSON.stringify(steps || []), JSON.stringify(variables || []),
       req.user.uid]
    );
    res.json({ id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── UPDATE an agent test's goal / name (edit in place) ──────────────────────
app.put("/api/agent-tests/:id", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { goal, name } = req.body;
  if (goal === undefined && name === undefined)
    return res.status(400).json({ error: "nothing to update" });
  try {
    const r = await pool.query(
      `UPDATE agent_test_cases
          SET goal = COALESCE($1, goal),
              name = COALESCE($2, name),
              updated_at = NOW()
        WHERE id = $3
      RETURNING id, name, goal`,
      [goal ?? null, name?.trim() || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Agent test not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE an agent test ─────────────────────────────────────────────────────
app.delete("/api/agent-tests/:id", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  try {
    await pool.query("DELETE FROM agent_test_cases WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RUN an agent test through the EXISTING runner ───────────────────────────
// Creates a test_runs row (so logs/status/UI work exactly like a normal run)
// then builds the same config shape spawnRunner expects and spawns the runner.
app.post("/api/agent-tests/:id/run", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  try {
    const tc = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!tc.rows.length) return res.status(404).json({ error: "Agent test not found" });
    const a = tc.rows[0];

    // Create a test_runs row so the existing logging/status/abort machinery works.
    // test_case_id is nullable, so we leave it null (agent tests aren't real test
    // cases); the trigger tag identifies it in the runs list. NOTE: test_runs has
    // no `type` column, so it's not inserted here (type lives only in `config`).
    const run = await pool.query(
      `INSERT INTO test_runs (test_case_id, project_id, status, browser, triggered_by, started_at)
       VALUES ($1,$2,'running',$3,$4,NOW()) RETURNING id`,
      [null, a.project_id, a.browser || "chrome", `agent-test:${a.id}`]
    );
    const runId = run.rows[0].id;

    const config = {
      type:         a.type || "ui",
      steps:        a.steps || [],
      browser:      a.browser || "chrome",
      base_url:     a.base_url || "",
      variables:    a.variables || [],
      project_id:   a.project_id,
      test_case_id: null,
      heal_update:  false,
    };

    broadcast(runId, { type: "status", status: "running" });
    broadcast(runId, { type: "log", level: "info",
      message: `▶ Running AGENT test "${a.name}" (id ${a.id}) — no AI, replay only`,
      timestamp: new Date().toISOString() });
    spawnRunner(runId, config);

    res.json({ run_id: runId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PROMOTE a reviewed agent test into the real test_cases table ────────────
app.post("/api/agent-tests/:id/promote", requireAuth, requireRole("admin", "lead"), async (req, res) => {
  try {
    const tc = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!tc.rows.length) return res.status(404).json({ error: "Agent test not found" });
    const a = tc.rows[0];
    const ins = await pool.query(
      `INSERT INTO test_cases (project_id,name,description,type,browser,base_url,steps,variables,priority,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [a.project_id, a.name, `Promoted from agent test #${a.id}. Goal: ${a.goal || ""}`,
       a.type || "ui", a.browser || "chrome", a.base_url || null,
       JSON.stringify(a.steps || []), JSON.stringify(a.variables || []),
       "medium", req.user.uid]
    );
    await pool.query(
      "UPDATE agent_test_cases SET status='promoted', promoted_test_case_id=$1, updated_at=NOW() WHERE id=$2",
      [ins.rows[0].id, a.id]);
    res.json({ test_case_id: ins.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ============================================================================
//  END agent test routes
// ============================================================================
