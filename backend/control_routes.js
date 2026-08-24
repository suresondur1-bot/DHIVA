// control_routes.js — Qavya custom-control definitions API (ISOLATED, additive).
//
// Stores user-defined control definitions in Qavya's own database. Self-contained,
// mirrors the jira_routes.js pattern: module.exports = (app, pool, requireAuth).
// Registered from server.js with ONE line:
//     require('./control_routes')(app, pool, requireAuth);
//
// Creates its own table (CREATE TABLE IF NOT EXISTS) so a fresh self-hosted
// install sets itself up automatically. Touches no existing table or route.
//
// A control definition is pure data (recognition + per-keyword primitive recipes)
// — see runner/custom_controls.py for the shape and the safe primitive list.

module.exports = (app, pool, requireAuth) => {
  // ── Table (auto-create) ────────────────────────────────────────────────────
  pool.query(`
    CREATE TABLE IF NOT EXISTS custom_controls (
      id          SERIAL PRIMARY KEY,
      project_id  INTEGER,                       -- optional: scope to a project (NULL = global)
      control_id  TEXT NOT NULL,                 -- stable key, e.g. "fancy_dropdown"
      name        TEXT NOT NULL,                 -- human label
      recognition JSONB NOT NULL DEFAULT '{}',   -- { matches?, closest?, role? }
      keywords    JSONB NOT NULL DEFAULT '{}',   -- { keyword: [ {do,...}, ... ] }
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (project_id, control_id)
    );
  `).then(() => console.log("\u2705 custom_controls table ready"))
    .catch(e => console.warn("[migration] custom_controls:", e.message));

  // Allowed primitive verbs — must match runner/custom_controls.py PRIMITIVES.
  const PRIMITIVES = new Set(["click","type","clear","wait","press","click_option","read_text","wait_for"]);

  // Validate a definition's shape + that it only uses safe primitives. No code allowed.
  function validateDefinition(body) {
    if (!body || typeof body !== "object") return "Invalid body";
    if (!body.control_id || !String(body.control_id).trim()) return "control_id is required";
    if (!body.name || !String(body.name).trim()) return "name is required";
    const rec = body.recognition || {};
    if (typeof rec !== "object") return "recognition must be an object";
    if (!rec.matches && !rec.closest && !rec.role) return "recognition needs at least one of: matches, closest, role";
    const kw = body.keywords || {};
    if (typeof kw !== "object") return "keywords must be an object";
    for (const [k, steps] of Object.entries(kw)) {
      if (!Array.isArray(steps)) return `keyword "${k}" must be a list of steps`;
      for (const st of steps) {
        if (!st || typeof st !== "object" || !PRIMITIVES.has(st.do)) {
          return `keyword "${k}" has an invalid step (allowed: ${[...PRIMITIVES].join(", ")})`;
        }
      }
    }
    return null; // ok
  }

  // ── List (optionally by project) ───────────────────────────────────────────
  app.get("/api/controls", requireAuth, async (req, res) => {
    try {
      const projectId = req.query.project_id ? parseInt(req.query.project_id) : null;
      const r = projectId
        ? await pool.query("SELECT * FROM custom_controls WHERE project_id=$1 OR project_id IS NULL ORDER BY name", [projectId])
        : await pool.query("SELECT * FROM custom_controls ORDER BY name");
      res.json({ ok: true, controls: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Get one ────────────────────────────────────────────────────────────────
  app.get("/api/controls/:id", requireAuth, async (req, res) => {
    try {
      const r = await pool.query("SELECT * FROM custom_controls WHERE id=$1", [parseInt(req.params.id)]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: "Not found" });
      res.json({ ok: true, control: r.rows[0] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Create / update (upsert by project_id + control_id) ─────────────────────
  app.post("/api/controls", requireAuth, async (req, res) => {
    try {
      const err = validateDefinition(req.body);
      if (err) return res.status(400).json({ ok: false, error: err });
      const { project_id, control_id, name, recognition, keywords } = req.body;
      const pid = project_id != null ? parseInt(project_id) : null;
      const uid = req.user && req.user.uid;
      const r = await pool.query(
        `INSERT INTO custom_controls (project_id, control_id, name, recognition, keywords, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id, control_id)
         DO UPDATE SET name=$3, recognition=$4, keywords=$5, updated_at=NOW()
         RETURNING *`,
        [pid, String(control_id).trim(), String(name).trim(),
         JSON.stringify(recognition || {}), JSON.stringify(keywords || {}), uid]
      );
      res.json({ ok: true, control: r.rows[0] });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Delete ───────────────────────────────────────────────────────────────--
  app.delete("/api/controls/:id", requireAuth, async (req, res) => {
    try {
      await pool.query("DELETE FROM custom_controls WHERE id=$1", [parseInt(req.params.id)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Export (all, or by project) as a shareable JSON bundle ──────────────────
  app.get("/api/controls-export", requireAuth, async (req, res) => {
    try {
      const projectId = req.query.project_id ? parseInt(req.query.project_id) : null;
      const r = projectId
        ? await pool.query("SELECT control_id, name, recognition, keywords FROM custom_controls WHERE project_id=$1", [projectId])
        : await pool.query("SELECT control_id, name, recognition, keywords FROM custom_controls");
      res.json({ ok: true, version: 1, controls: r.rows });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Import a JSON bundle (array of definitions) ─────────────────────────────
  app.post("/api/controls-import", requireAuth, async (req, res) => {
    try {
      const list = Array.isArray(req.body?.controls) ? req.body.controls : [];
      if (!list.length) return res.status(400).json({ ok: false, error: "No controls in bundle" });
      const pid = req.body.project_id != null ? parseInt(req.body.project_id) : null;
      const uid = req.user && req.user.uid;
      let imported = 0; const errors = [];
      for (const def of list) {
        const err = validateDefinition(def);
        if (err) { errors.push(`${def?.control_id || "?"}: ${err}`); continue; }
        await pool.query(
          `INSERT INTO custom_controls (project_id, control_id, name, recognition, keywords, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (project_id, control_id)
           DO UPDATE SET name=$3, recognition=$4, keywords=$5, updated_at=NOW()`,
          [pid, String(def.control_id).trim(), String(def.name).trim(),
           JSON.stringify(def.recognition || {}), JSON.stringify(def.keywords || {}), uid]
        );
        imported++;
      }
      res.json({ ok: true, imported, errors });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  console.log("[Controls] Routes registered");
};
