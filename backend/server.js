require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const compression = require("compression");
const crypto   = require("crypto");
const bcrypt   = require("bcryptjs");
const helmet   = require("helmet");
const { Pool } = require("pg");
const cron     = require("node-cron");
const { spawn, exec }= require("child_process");
const path     = require("path");
const fs       = require("fs");
const http     = require("http");
const https    = require("https");
const WebSocket= require("ws");
const os       = require("os");

// ── Load .env file if present (so ANTHROPIC_API_KEY can be set in .env) ──────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").split("\n").forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g,"");
  });
  console.log("[env] Loaded .env file");
}

// ── Claude API helper — works on any Node.js version ─────────────────────────
function callClaude(body) {
  return new Promise((resolve, reject) => {
    const key = process.env.ANTHROPIC_API_KEY || "";
    if (!key) {
      return reject(new Error(
        "ANTHROPIC_API_KEY is not set. " +
        "Create a .env file in your backend/ folder with:\nANTHROPIC_API_KEY=sk-ant-..."
      ));
    }
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "Content-Length":    Buffer.byteLength(payload),
        "x-api-key":         key,
        "anthropic-version": "2023-06-01",
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(parsed.error?.message || `Claude API error ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch(e) { reject(new Error("Invalid JSON from Claude API")); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}


// Warn on startup if API key missing
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("⚠️  ANTHROPIC_API_KEY is not set — AI features will not work.");
  console.warn("   Set it in backend/.env or as an environment variable before starting.");
} else {
  console.log("✅ ANTHROPIC_API_KEY loaded (" + process.env.ANTHROPIC_API_KEY.slice(0,10) + "...)");
}

const app    = express();
app.use(compression()); // gzip — reduces 758KB bundle to ~180KB over network
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(helmet({ contentSecurityPolicy: false })); // security headers

// ✅ CORS MUST COME FIRST - handles preflight requests
const _allowedOrigins = [
  process.env.CORS_ORIGIN,
  'http://localhost:6001',
  'http://localhost:5176',
  'http://127.0.0.1:6001',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    if (/^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(origin)) return callback(null, true);
    if (_allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, true);
  },
  credentials: true,
}));
app.use(express.json({ limit: "20mb" }));



// ─── RATE LIMITING MIDDLEWARE ─────────────────────────────────────────────────
// Configurable via .env: RATE_LIMIT_GENERAL (default 100) and RATE_LIMIT_AI (default 10)
const RATE_LIMIT_GENERAL = parseInt(process.env.RATE_LIMIT_GENERAL) || 100;
const RATE_LIMIT_AI      = parseInt(process.env.RATE_LIMIT_AI)      || 10;

// General API: requests per minute per IP
app.use("/api", (req, res, next) => {
  const key = `api:${req.ip}`;
  if (!checkRateLimit(key, RATE_LIMIT_GENERAL)) {
    return res.status(429).json({ error: `Too many requests. Max ${RATE_LIMIT_GENERAL} per minute.` });
  }
  next();
});

// AI endpoints: stricter limit to protect Anthropic API key
app.use("/api/ai", (req, res, next) => {
  const key = `ai:${req.ip}`;
  if (!checkRateLimit(key, RATE_LIMIT_AI)) {
    return res.status(429).json({ error: `AI rate limit exceeded. Max ${RATE_LIMIT_AI} requests per minute.` });
  }
  next();
});

const ASYNC_RUNNER = path.join(__dirname, "../runner/async_runner.py");
const RUNNER_PATH  = fs.existsSync(ASYNC_RUNNER) ? ASYNC_RUNNER : path.join(__dirname, "../runner/runner.py");
console.log(`🚀 Runner: ${path.basename(RUNNER_PATH)}`);
const SCREENSHOTS_PATH = path.join(__dirname, "../runner/screenshots");
if (!fs.existsSync(SCREENSHOTS_PATH)) fs.mkdirSync(SCREENSHOTS_PATH, { recursive: true });
const LOGS_PATH = path.join(__dirname, "../runner/logs");
if (!fs.existsSync(LOGS_PATH)) fs.mkdirSync(LOGS_PATH, { recursive: true });

// Use full Python path on Windows to avoid Microsoft Store redirect
const PYTHON_CMD = process.env.PYTHON_PATH ||
  (process.platform === "win32" ? "python" : "python3");
console.log(`🐍 Using Python command: ${PYTHON_CMD}`);

// ── Scalability Configuration ─────────────────────────────────────────────────
const MAX_CONCURRENT_RUNS  = parseInt(process.env.MAX_CONCURRENT_RUNS  || "5");   // global
const MAX_RUNS_PER_ORG     = parseInt(process.env.MAX_RUNS_PER_ORG     || "3");   // per org
const MAX_RUNS_PER_SUITE   = parseInt(process.env.MAX_RUNS_PER_SUITE   || "1");   // per suite run (how many tests from same suite run simultaneously)
const SUITE_RETRY_FAILED   = parseInt(process.env.SUITE_RETRY_FAILED   || "1");   // retry failed tests N times after suite completes (0 = no retry)
const LOG_RETENTION_DAYS        = parseInt(process.env.LOG_RETENTION_DAYS        || "90");
const SCREENSHOT_RETENTION_DAYS = parseInt(process.env.SCREENSHOT_RETENTION_DAYS || "90");
const SUITE_RUN_RETENTION_DAYS  = parseInt(process.env.SUITE_RUN_RETENTION_DAYS  || "30");
const TEST_RUN_RETENTION_DAYS   = parseInt(process.env.TEST_RUN_RETENTION_DAYS   || "30");
const CLEANUP_INTERVAL_HOURS    = parseInt(process.env.CLEANUP_INTERVAL_HOURS    || "24");
const PAGE_SIZE            = parseInt(process.env.PAGE_SIZE            || "5");   // default page size
const DASHBOARD_CACHE_TTL  = parseInt(process.env.DASHBOARD_CACHE_TTL  || "30");  // seconds
const STUCK_RUN_TIMEOUT_MIN= parseInt(process.env.STUCK_RUN_TIMEOUT_MIN|| "60");  // minutes before auto-fail

const QUEUE_POLL_INTERVAL = parseInt(process.env.QUEUE_POLL_INTERVAL || "2000"); // ms
const PROJECT_VAR_LIMIT   = parseInt(process.env.PROJECT_VAR_LIMIT       || "50");   // max vars per project

// ── Multi-server deployment: identify THIS server so runs it creates always
// execute on it, never on a sibling server sharing the same database ─────────
const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();
// Only one server in a multi-server deployment should own schedules (cron jobs
// are registered per-process from the shared `schedules` table — if every
// server loaded them, every scheduled run would fire once PER server).
// Defaults to true so a single-server deployment keeps working with no config.
const SCHEDULER_ENABLED = (process.env.SCHEDULER_ENABLED ?? "true") === "true";
console.log(`🖥️  Instance: ${INSTANCE_ID}${SCHEDULER_ENABLED ? " (schedules: ON)" : " (schedules: OFF — another instance owns them)"}`);

// ── Encryption helpers for secret project variables ───────────────────────────
const ENC_KEY = (() => {
  const raw = process.env.VAR_ENCRYPTION_KEY || "athma-default-encryption-key-32b";
  // SHA-256 to always get 32 bytes regardless of key length
  return crypto.createHash("sha256").update(raw).digest();
})();
const ENC_PREFIX = "enc:";

function encryptValue(plaintext) {
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return ENC_PREFIX + iv.toString("hex") + ":" + encrypted.toString("hex");
}

function decryptValue(stored) {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored;
  try {
    const parts  = stored.slice(ENC_PREFIX.length).split(":");
    const iv     = Buffer.from(parts[0], "hex");
    const data   = Buffer.from(parts[1], "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", ENC_KEY, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

function maskValue(v) { return v ? "••••••••" : ""; }
console.log(`⚙️  Config: max_runs=${MAX_CONCURRENT_RUNS} per_org=${MAX_RUNS_PER_ORG} per_suite=${MAX_RUNS_PER_SUITE} suite_retry=${SUITE_RETRY_FAILED} retention=${LOG_RETENTION_DAYS}d page=${PAGE_SIZE} queue_poll=${QUEUE_POLL_INTERVAL}ms`);

const SERVER_START_TIME = new Date(); // used to ignore pre-startup runs in stuck recovery

// ── Dashboard cache ───────────────────────────────────────────────────────────
const dashboardCache = new Map(); // key -> { data, ts }
function getCached(key) {
  const entry = dashboardCache.get(key);
  if (entry && (Date.now() - entry.ts) < DASHBOARD_CACHE_TTL * 1000) return entry.data;
  return null;
}
function setCached(key, data) { dashboardCache.set(key, { data, ts: Date.now() }); }
function clearDashboardCache() { dashboardCache.clear(); }

// ── Rate limiter (per IP / per user) ─────────────────────────────────────────
const rateLimitMap = new Map(); // key -> { count, resetAt }
function checkRateLimit(key, maxPerMinute = 60) {
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60000; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count <= maxPerMinute;
}
// Clean up rate limit map every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) { if (now > v.resetAt) rateLimitMap.delete(k); }
}, 300000);

// ── Database connection ───────────────────────────────────────────────────────
// Set DB_HOST env var if your PostgreSQL is on a different machine or Docker IP.
// Default is localhost — works for local installs and pgAdmin on same machine.
const pool = new Pool({
  user:     process.env.DB_USER     || "appuser",
  host:     process.env.DB_HOST     || "localhost",
  database: process.env.DB_NAME     || "sdadads",
  password: process.env.DB_PASSWORD || "asdasd",
  port:     parseInt(process.env.DB_PORT || "5432"),
  connectionTimeoutMillis: 60000,
  idleTimeoutMillis:       60000,
  max:                     parseInt(process.env.DB_POOL_SIZE || "20"),
  min:                     parseInt(process.env.DB_POOL_MIN  || "2"),
  allowExitOnIdle:         false,
  keepAlive: true,                 // send TCP keepalive packets
  keepAliveInitialDelayMillis: 10000,
});

// Log connection errors clearly instead of crashing
pool.on("error", (err) => {
  console.error("[DB] Unexpected pool error:", err.message);
});

// Test connection on startup and give clear guidance if it fails
pool.connect((err, client, release) => {
  if (err) {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("❌ Database connection FAILED:", err.message);
    console.error("   Host:     ", process.env.DB_HOST || "localhost");
    console.error("   Port:     ", process.env.DB_PORT || 5432);
    console.error("   Database: ", process.env.DB_NAME || "automation_db");
    console.error("   User:     ", process.env.DB_USER || "appuser");
    console.error("");
    console.error("   Fix options:");
    console.error("   1. Make sure PostgreSQL is running (check pgAdmin or Services)");
    console.error("   2. Set DB_HOST env var if DB is on another machine:");
    console.error("      set DB_HOST=192.168.x.x && node server.js");
    console.error("   3. Check firewall allows port 5432");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  } else {
    console.log("✅ Database connected:", process.env.DB_HOST || "localhost", "→", process.env.DB_NAME || "automation_db");
    release();
    // ── One-time startup migrations ──────────────────────────────────────────
    // Fix old suite_runs with NULL started_at
    pool.query(`
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
      UPDATE suite_runs SET started_at = finished_at WHERE started_at IS NULL AND finished_at IS NOT NULL;
      UPDATE suite_runs SET started_at = NOW()        WHERE started_at IS NULL;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS notify_email TEXT;
    `).catch(() => {});  // ignore if column already exists

    // Add run_order column to suite_runs if not exists
    pool.query(`
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS run_order JSONB;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS suite_id INTEGER;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS total INTEGER DEFAULT 0;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS passed INTEGER DEFAULT 0;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS failed INTEGER DEFAULT 0;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS run_by INTEGER;
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS browser TEXT DEFAULT 'chrome';
      ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS name TEXT;
    `)
    .then(() => console.log("\u2705 suite_runs columns ready"))
    .catch(e => console.warn("[migration] suite_runs:", e.message));

    // Add is_callable column if not exists (auto-migration — no manual SQL needed)
    pool.query(`
      ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS is_callable BOOLEAN DEFAULT FALSE;
      ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS heal_update BOOLEAN DEFAULT FALSE;
    `).then(() => console.log("✅ is_callable column ready"))
      .catch(() => {});  // already exists — fine

    // Multi-server deployments: tag which server created each run so the
    // shared queue worker never hands it to a sibling server.
    pool.query(`
      ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS origin_server TEXT;
    `).then(() => console.log("✅ origin_server column ready"))
      .catch(() => {});  // already exists — fine

    pool.query(`
      CREATE TABLE IF NOT EXISTS access_requests (
        id            SERIAL PRIMARY KEY,
        org_name      TEXT NOT NULL,
        description   TEXT,
        admin_name    TEXT NOT NULL,
        email         TEXT NOT NULL,
        contact       TEXT NOT NULL,
        project_name  TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        notes         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_access_requests_status     ON access_requests(status);
      CREATE INDEX IF NOT EXISTS idx_access_requests_created_at ON access_requests(created_at);
    `).then(() => console.log("✅ access_requests table ready"))
      .catch(e  => console.error("⚠️  Migration warning:", e.message));
  }
});

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

// ─── INPUT SIZE VALIDATOR ────────────────────────────────────────────────────
// Limits configurable via .env
const MAX_NAME_LEN        = parseInt(process.env.MAX_NAME_LEN)        || 255;
const MAX_DESC_LEN        = parseInt(process.env.MAX_DESC_LEN)        || 2000;
const MAX_STEPS_COUNT     = parseInt(process.env.MAX_STEPS_COUNT)     || 500;
const MAX_TAGS_COUNT      = parseInt(process.env.MAX_TAGS_COUNT)      || 20;
const MAX_URL_LEN         = parseInt(process.env.MAX_URL_LEN)         || 500;

function validateInputSizes({ name, description, steps, tags, base_url } = {}) {
  if (name        !== undefined && name.length        > MAX_NAME_LEN)    return `Name must be ${MAX_NAME_LEN} characters or less`;
  if (description !== undefined && description.length > MAX_DESC_LEN)    return `Description must be ${MAX_DESC_LEN} characters or less`;
  if (base_url    !== undefined && base_url.length    > MAX_URL_LEN)     return `URL must be ${MAX_URL_LEN} characters or less`;
  if (steps       !== undefined && steps.length       > MAX_STEPS_COUNT) return `Test case cannot have more than ${MAX_STEPS_COUNT} steps`;
  if (tags        !== undefined && tags.length        > MAX_TAGS_COUNT)  return `Cannot have more than ${MAX_TAGS_COUNT} tags`;
  return null; // valid
}

// Password strength validator
function validatePassword(password) {
  if (!password || password.length < 8)         return "Password must be at least 8 characters";
  if (!/[A-Z]/.test(password))                  return "Password must contain at least one uppercase letter";
  if (!/[0-9]/.test(password))                  return "Password must contain at least one number";
  if (!/[^A-Za-z0-9]/.test(password))           return "Password must contain at least one special character";
  return null; // valid
}

// ─── LOGIN RATE LIMITER ───────────────────────────────────────────────────────
// Pure in-memory — no npm package needed.
// Configurable via .env: LOGIN_MAX_ATTEMPTS (default 5), LOGIN_LOCKOUT_MINUTES (default 15)
const _loginAttempts  = new Map(); // ip -> { count, lockedUntil }
const _MAX_FAILS      = parseInt(process.env.LOGIN_MAX_ATTEMPTS)    || 5;
const _LOCKOUT_MS     = (parseInt(process.env.LOGIN_LOCKOUT_MINUTES) || 15) * 60 * 1000;

// Clean old entries every 30 min to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, d] of _loginAttempts.entries())
    if (!d.lockedUntil || d.lockedUntil < now) _loginAttempts.delete(ip);
}, 30 * 60 * 1000).unref();

function _getIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || req.socket?.remoteAddress || "unknown";
}

// Returns true = allowed, false = blocked (429 already sent)
// Key is IP+username so one user's lockout never affects another user on same IP
function _checkLoginLimit(req, res) {
  const ip       = _getIp(req);
  const username = (req.body?.username || "").toLowerCase().trim();
  const key      = `${ip}:${username}`;
  const now      = Date.now();
  const rec      = _loginAttempts.get(key) || { count: 0, lockedUntil: null };
  if (rec.lockedUntil && now < rec.lockedUntil) {
    const secs = Math.ceil((rec.lockedUntil - now) / 1000);
    const mins = Math.ceil(secs / 60);
    console.warn("[RateLimit] Login blocked: key=" + key + " retry_in=" + secs + "s");
    res.status(429).json({
      error: "Too many failed login attempts for this account. Please try again in " + mins + " minute" + (mins !== 1 ? "s" : "") + ".",
      retry_after_seconds: secs,
    });
    return false;
  }
  return true;
}

function _recordFail(req) {
  const ip       = _getIp(req);
  const username = (req.body?.username || "").toLowerCase().trim();
  const key      = `${ip}:${username}`;
  const rec      = _loginAttempts.get(key) || { count: 0, lockedUntil: null };
  rec.count++;
  if (rec.count >= _MAX_FAILS) {
    rec.lockedUntil = Date.now() + _LOCKOUT_MS;
    console.warn("[RateLimit] key=" + key + " locked out after " + rec.count + " failed attempts");
  } else {
    console.warn("[RateLimit] key=" + key + " failed login " + rec.count + "/" + _MAX_FAILS);
  }
  _loginAttempts.set(key, rec);
}

function _recordSuccess(req) {
  const ip       = _getIp(req);
  const username = (req.body?.username || "").toLowerCase().trim();
  const key      = `${ip}:${username}`;
  if (_loginAttempts.has(key)) {
    _loginAttempts.delete(key);
    console.log("[RateLimit] key=" + key + " login success — counter reset");
  }
}

// ─── WEBSOCKET — broadcast live logs ─────────────────────────────────────────
const clients = new Map(); // runId -> Set of ws clients

wss.on("connection", (ws, req) => {
  const runId = new URL(req.url, "http://localhost").searchParams.get("runId");
  if (runId) {
    if (!clients.has(runId)) clients.set(runId, new Set());
    clients.get(runId).add(ws);
    ws.on("close", () => { clients.get(runId)?.delete(ws); });

    // ── Replay current status immediately so late-connecting clients catch up ──
    // Fixes: "Waiting for logs" when WebSocket connects after processQueue broadcasts
    pool.query("SELECT status FROM test_runs WHERE id=$1", [runId])
      .then(r => {
        if (r.rows[0] && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: "status", status: r.rows[0].status }));
          } catch(e) { /* client disconnected before send — ignore */ }
        }
      }).catch(() => {});
  }
});

function broadcast(runId, data) {
  const subs = clients.get(String(runId));
  if (!subs) return;
  const msg = JSON.stringify(data);
  subs.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  // Accept token from Authorization header OR ?token= query param (for file downloads)
  const token = (req.headers.authorization || "").replace("Bearer ", "")
             || (req.query.token || "");
  if (!token) return res.status(401).json({ error: "No token" });
  // Accept internal runner token — allows runner to call /api/tests/:id for call_test
  const runnerSecret = process.env.RUNNER_SECRET || "nat-internal-runner-2024";
  if (token === runnerSecret) {
    req.user = { uid: 0, id: 0, username: "runner", role: "superadmin", org_id: null };
    return next();
  }
  try {
    const r = await pool.query(
      "SELECT s.*, u.id as uid, u.username, u.full_name, u.role, s.org_id FROM auto_sessions s JOIN auto_users u ON s.user_id=u.id WHERE s.token=$1 AND s.expires_at > NOW()",
      [token]
    );
    if (!r.rows[0]) return res.status(401).json({ error: "Session expired" });
    req.user = r.rows[0];
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const requireRole = (...roles) => (req, res, next) => {
  // superadmin (id=1 OR role=superadmin) always passes — no restrictions
  if (req.user.uid === 1 || req.user.id === 1 || req.user.role === "superadmin") return next();
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
  next();
};

// Helper — true for the one superadmin account (id=1)
function isSuperAdmin(user) {
  return user && (user.uid === 1 || user.id === 1 || user.role === "superadmin");
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
// Step 1: Validate credentials — return org list for non-admin
app.post("/api/auth/login", async (req, res) => {
  // ── Rate limit: block IP after 5 failed attempts for 15 minutes ────────────
  if (!_checkLoginLimit(req, res)) return;

  // ── Basic input validation ──────────────────────────────────────────────────
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required." });

  try {
    const r = await pool.query("SELECT * FROM auto_users WHERE username=$1 AND active=TRUE", [username]);
    const user = r.rows[0];
    // Dual verification: bcrypt first, sha256 fallback with silent rehash
    let passwordValid = false;
    if (user) {
      if (user.password_hash.startsWith("$2")) {
        // bcrypt hash
        passwordValid = await bcrypt.compare(password, user.password_hash);
      } else {
        // legacy sha256 — check and silently upgrade to bcrypt
        if (user.password_hash === sha256(password)) {
          passwordValid = true;
          // Rehash to bcrypt in background
          bcrypt.hash(password, 12).then(hash => {
            pool.query("UPDATE auto_users SET password_hash=$1 WHERE id=$2", [hash, user.id])
              .catch(() => {});
          });
        }
      }
    }
    if (!user || !passwordValid) {
      _recordFail(req);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Credentials correct — reset failure counter
    _recordSuccess(req);

    // Only superadmin (id=1) skips org selection — sees everything
    if (isSuperAdmin(user)) {
      const token   = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
      await pool.query("INSERT INTO auto_sessions (user_id,token,expires_at,org_id) VALUES ($1,$2,$3,NULL)", [user.id, token, expires]);
      console.log("[Auth] Superadmin login: " + user.username);
      return res.json({
        token,
        page_size: PAGE_SIZE,
        user: { id: user.id, uid: user.id, username: user.username, full_name: user.full_name, role: user.role, org_id: null, org_name: null, must_change_password: user.must_change_password||false }
      });
    }

    // Non-admin: get their orgs
    const orgsRes = await pool.query(`
      SELECT o.id, o.name FROM organisations o
      JOIN user_orgs uo ON uo.org_id = o.id
      WHERE uo.user_id = $1 AND o.active = TRUE
      ORDER BY o.name
    `, [user.id]);

    if (orgsRes.rows.length === 0) {
      return res.status(403).json({ error: "No organisation assigned to your account. Please contact your administrator." });
    }

    // Return orgs list — frontend will show org picker
    console.log("[Auth] Login: " + user.username + " — org selection needed");
    res.json({ needs_org: true, user_id: user.id, orgs: orgsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 2: Select organisation and get full session token
app.post("/api/auth/select-org", async (req, res) => {
  const { user_id, org_id } = req.body;
  try {
    // Verify user exists and is active
    const ur = await pool.query("SELECT * FROM auto_users WHERE id=$1 AND active=TRUE", [user_id]);
    if (!ur.rows[0]) return res.status(401).json({ error: "User not found" });
    const user = ur.rows[0];

    // Verify user belongs to this org
    const or = await pool.query(
      "SELECT * FROM user_orgs WHERE user_id=$1 AND org_id=$2", [user_id, org_id]
    );
    if (!or.rows[0]) return res.status(403).json({ error: "Not authorised for this organisation" });

    // Verify org is active
    const orgR = await pool.query("SELECT * FROM organisations WHERE id=$1 AND active=TRUE", [org_id]);
    if (!orgR.rows[0]) return res.status(403).json({ error: "Organisation not found or inactive" });

    // Check user has access to this org's projects
    // admin role sees ALL org projects — no user_projects mapping needed
    // lead/tester/viewer need explicit project assignment
    if (user.role !== "admin") {
      const projCheck = await pool.query(`
        SELECT COUNT(*) FROM user_projects up
        JOIN org_projects op ON op.project_id = up.project_id
        WHERE up.user_id=$1 AND op.org_id=$2
      `, [user_id, org_id]);
      if (+projCheck.rows[0].count === 0) {
        return res.status(403).json({ error: "No projects assigned to you in this organisation. Contact your administrator." });
      }
    } else {
      // For admin: verify org has at least one project
      const orgProjCheck = await pool.query(
        "SELECT COUNT(*) FROM org_projects WHERE org_id=$1", [org_id]
      );
      // Even if 0 projects, still allow admin to login — they manage the org
    }

    const token   = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await pool.query("INSERT INTO auto_sessions (user_id,token,expires_at,org_id) VALUES ($1,$2,$3,$4)", [user.id, token, expires, org_id]);
    res.json({
      token,
      page_size: PAGE_SIZE,
      user: { id: user.id, uid: user.id, username: user.username, full_name: user.full_name, role: user.role, org_id, org_name: orgR.rows[0].name, must_change_password: user.must_change_password||false }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  await pool.query("DELETE FROM auto_sessions WHERE token=$1", [token]);
  res.json({ success: true });
});

// Logout from ALL devices
app.post("/api/auth/logout-all", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM auto_sessions WHERE user_id=$1", [req.user.uid]);
  res.json({ success: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ id: req.user.uid, uid: req.user.uid, username: req.user.username, full_name: req.user.full_name, role: req.user.role, org_id: req.user.org_id||null, org_name: req.user.org_name||null });
});


// ─── PROJECT ACCESS HELPER ───────────────────────────────────────────────────
async function getAllowedProjectIds(user) {
  // superadmin sees everything
  if (isSuperAdmin(user)) return null;

  // org-admin sees ALL projects in their org
  if (user?.role === "admin") {
    if (!user.org_id) return [];
    try {
      const r = await pool.query("SELECT project_id FROM org_projects WHERE org_id=$1", [user.org_id]);
      return r.rows.map(r => r.project_id);
    } catch { return []; }
  }

  // lead/tester/viewer: ONLY projects explicitly assigned to them via user_projects
  try {
    const userProj = await pool.query(
      "SELECT project_id FROM user_projects WHERE user_id=$1", [user.uid]
    );
    const userPids = userProj.rows.map(r => r.project_id);

    // If they also have an org, only show the intersection
    // (their assigned projects that actually belong to their org)
    if (user.org_id && userPids.length > 0) {
      const orgProj = await pool.query(
        "SELECT project_id FROM org_projects WHERE org_id=$1", [user.org_id]
      );
      const orgPids = orgProj.rows.map(r => r.project_id);
      return userPids.filter(id => orgPids.includes(id));
    }

    // No org context — just return their assigned projects
    return userPids;
  } catch { return []; }
}

function projectFilter(ids, alias="p") {
  if (ids === null) return "";                    // admin — no filter
  if (!ids.length)  return ` AND 1=0`;           // no projects assigned
  return ` AND ${alias}.id IN (${ids.join(",")})`;
}

function projectFilterCol(ids, col="project_id") {
  if (ids === null) return "";
  if (!ids.length)  return ` AND 1=0`;
  return ` AND ${col} IN (${ids.join(",")})`;
}

// ─── PROJECTS ─────────────────────────────────────────────────────────────────
app.get("/api/projects", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const filter = projectFilter(ids, "p");
    // Admin can see inactive projects to re-enable them
    const includeInactive = isSuperAdmin(req.user) && req.query.include_inactive === "true";
    const activeFilter = includeInactive ? "" : " AND p.active=TRUE";
    const r = await pool.query(`
      SELECT p.*,
        COUNT(DISTINCT tc.id)::int as test_count,
        COUNT(DISTINCT pv.id)::int as var_count,
        COALESCE(ROUND(
          100.0 * COUNT(DISTINCT CASE WHEN tr.status='passed' THEN tr.id END) /
          NULLIF(COUNT(DISTINCT CASE WHEN tr.status IN ('passed','failed') THEN tr.id END),0)
        ),0)::numeric as pass_rate,
        string_agg(DISTINCT o.name, ', ') as org_name
      FROM projects p
      LEFT JOIN test_cases tc ON tc.project_id=p.id AND tc.active=TRUE
      LEFT JOIN project_variables pv ON pv.project_id=p.id
      LEFT JOIN test_runs tr ON tr.project_id=p.id AND tr.created_at > NOW() - INTERVAL '90 days'
      LEFT JOIN org_projects op ON op.project_id=p.id
      LEFT JOIN organisations o ON o.id=op.org_id AND o.active=TRUE
      WHERE 1=1${activeFilter}${filter} GROUP BY p.id, o.name, o.id ORDER BY p.active DESC, p.created_at DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/projects", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { name, description, base_url, org_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:"Project name is required" });
  const sizeErr = validateInputSizes({ name: name.trim(), description: description||"", base_url: base_url||"" });
  if (sizeErr) return res.status(400).json({ error: sizeErr });
  try {
    // Check for duplicate name in same org
    const targetOrgCheck = org_id || req.user.org_id;
    if (targetOrgCheck) {
      const dup = await pool.query(
        `SELECT p.id FROM projects p
         JOIN org_projects op ON op.project_id=p.id
         WHERE op.org_id=$1 AND LOWER(p.name)=LOWER($2) AND p.active=TRUE`,
        [targetOrgCheck, name.trim()]
      );
      if (dup.rows.length) return res.status(400).json({ error:`A project named "${name.trim()}" already exists in this organisation` });
    }
    const targetOrgId = org_id || req.user.org_id;
    // Check for org is required
    if (!targetOrgId && req.user.role !== "admin" && req.user.role !== "superadmin") {
      return res.status(400).json({ error:"Please assign the project to an organisation" });
    }
    // Check duplicate name within same org
    if (targetOrgId) {
      const dup = await pool.query(
        `SELECT p.id FROM projects p
         JOIN org_projects op ON op.project_id=p.id
         WHERE op.org_id=$1 AND LOWER(p.name)=LOWER($2) AND p.active=TRUE`,
        [targetOrgId, name.trim()]
      );
      if (dup.rows.length) return res.status(400).json({ error:`A project named "${name.trim()}" already exists in this organisation` });
    }
    const r = await pool.query("INSERT INTO projects (name,description,base_url,created_by) VALUES ($1,$2,$3,$4) RETURNING *",
      [name.trim(), description||null, base_url||null, req.user.uid]);
    const projectId = r.rows[0].id;
    if (targetOrgId) {
      await pool.query("INSERT INTO org_projects (org_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [targetOrgId, projectId]);
    } else if (req.user.role==="admin" || req.user.role==="superadmin") {
      const orgs = await pool.query("SELECT id FROM organisations WHERE active=TRUE");
      for (const org of orgs.rows)
        await pool.query("INSERT INTO org_projects (org_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [org.id, projectId]);
    }
    await pool.query("INSERT INTO user_projects (user_id,project_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.user.uid, projectId]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/projects/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { description, base_url } = req.body;
  try {
    const existing = await pool.query("SELECT * FROM projects WHERE id=$1 AND active=TRUE", [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error:"Project not found" });
    const name = existing.rows[0].name; // name never changes
    const r = await pool.query(
      "UPDATE projects SET name=$1, description=$2, base_url=$3 WHERE id=$4 RETURNING *",
      [name, description||null, base_url||null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/projects/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try { await pool.query("UPDATE projects SET active=FALSE WHERE id=$1", [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle project active/inactive — admin only
app.patch("/api/projects/:id/toggle-active", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE projects SET active = NOT active WHERE id=$1 RETURNING id, name, active",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error:"Project not found" });
    res.json({ id: r.rows[0].id, name: r.rows[0].name, active: r.rows[0].active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TEST SUITES ──────────────────────────────────────────────────────────────

// ─── PROJECT VARIABLES ────────────────────────────────────────────────────────
app.get("/api/projects/:id/variables", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,name,type,description,created_at,updated_at,value FROM project_variables WHERE project_id=$1 ORDER BY name",
      [req.params.id]
    );
    const isAdmin = req.user.role === "admin" || req.user.role === "superadmin";
    res.json(r.rows.map(v => ({
      ...v,
      value: v.type==="secret" ? (isAdmin ? decryptValue(v.value) : maskValue(v.value)) : (v.value||""),
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/projects/:id/variables", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, value, type, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error:"Variable name required" });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return res.status(400).json({ error:"Name must be letters/numbers/underscores only" });
  try {
    const cnt = await pool.query("SELECT COUNT(*) FROM project_variables WHERE project_id=$1",[req.params.id]);
    if (parseInt(cnt.rows[0].count) >= PROJECT_VAR_LIMIT)
      return res.status(400).json({ error:`Maximum ${PROJECT_VAR_LIMIT} variables per project` });
    const stored = type==="secret" ? encryptValue(value||"") : (value||"");
    const r = await pool.query(
      "INSERT INTO project_variables (project_id,name,value,type,description,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,type,description,created_at,updated_at",
      [req.params.id, name.trim(), stored, type||"fixed", description||null, req.user.uid]
    );
    res.json(r.rows[0]);
  } catch(err) {
    if (err.code==="23505") return res.status(400).json({ error:"Variable name already exists in this project" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/projects/:project_id/variables/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { value, type, description } = req.body;
  try {
    const stored = type==="secret" ? encryptValue(value||"") : (value||"");
    const r = await pool.query(
      "UPDATE project_variables SET value=$1,type=$2,description=$3,updated_at=NOW() WHERE id=$4 AND project_id=$5 RETURNING id,name,type,description,updated_at",
      [stored, type||"fixed", description||null, req.params.id, req.params.project_id]
    );
    if (!r.rows.length) return res.status(404).json({ error:"Variable not found" });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/projects/:project_id/variables/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await pool.query("DELETE FROM project_variables WHERE id=$1 AND project_id=$2",[req.params.id, req.params.project_id]);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Runner calls this to persist runtime variable updates back to DB
app.patch("/api/projects/:id/variables/runtime", async (req, res) => {
  const { updates, runner_token } = req.body;
  if (runner_token !== (process.env.RUNNER_SECRET||"nat-internal-runner-2024")) return res.status(403).json({ error:"Unauthorized" });
  try {
    for (const [name, value] of Object.entries(updates||{})) {
      await pool.query(
        "UPDATE project_variables SET value=$1,updated_at=NOW() WHERE project_id=$2 AND name=$3 AND type='runtime'",
        [String(value), req.params.id, name]
      );
    }
    res.json({ ok:true, updated:Object.keys(updates||{}).length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Runner fetches all project variables (decrypted) before test execution
app.get("/api/projects/:id/variables/runner", async (req, res) => {
  const token = (req.headers.authorization||"").replace("Bearer ","") || req.query.token;
  if (token !== (process.env.RUNNER_SECRET||"nat-internal-runner-2024")) return res.status(403).json({ error:"Unauthorized" });
  try {
    const r = await pool.query("SELECT name,value,type FROM project_variables WHERE project_id=$1 ORDER BY name",[req.params.id]);
    const vars = {};
    r.rows.forEach(v => { vars[v.name] = v.type==="secret" ? decryptValue(v.value) : (v.value||""); });
    res.json(vars);
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ─── MODULES ─────────────────────────────────────────────────────────────────
app.get("/api/modules", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "m.project_id");
    const { project_id } = req.query;
    let q = `SELECT m.*, p.name as project_name, COUNT(tc.id) as test_count
             FROM modules m
             LEFT JOIN projects p ON p.id=m.project_id
             LEFT JOIN test_cases tc ON tc.module_id=m.id AND tc.active=TRUE
             WHERE m.active=TRUE${pf}`;
    const vals = [];
    if (project_id) { q += ` AND m.project_id=$${vals.length+1}`; vals.push(project_id); }
    q += " GROUP BY m.id, p.name ORDER BY p.name, m.name";
    const r = await pool.query(q, vals);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/modules", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { name, description, project_id } = req.body;
  if (!name?.trim()||!project_id) return res.status(400).json({ error:"Name and project required" });
  try {
    const r = await pool.query(
      "INSERT INTO modules (name,description,project_id) VALUES ($1,$2,$3) RETURNING *",
      [name.trim(), description||null, project_id]
    );
    res.json(r.rows[0]);
  } catch(err) {
    if (err.code==="23505") return res.status(400).json({ error:"Module name already exists in this project" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/modules/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { name, description, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE modules SET name=$1,description=$2,active=$3 WHERE id=$4 RETURNING *",
      [name, description||null, active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/modules/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  try {
    await pool.query("UPDATE modules SET active=FALSE WHERE id=$1", [req.params.id]);
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── DYNAMIC SUITE QUERY PREVIEW ─────────────────────────────────────────────
app.post("/api/suites/query-preview", requireAuth, async (req, res) => {
  const { filter_config, project_id } = req.body;
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "tc.project_id");
    let q = `SELECT tc.id, tc.name, tc.type, tc.priority, tc.tags,
               tc.browser, tc.project_id, tc.module_id,
               m.name as module_name, p.name as project_name,
               (SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1) as last_status
             FROM test_cases tc
             LEFT JOIN modules m ON tc.module_id=m.id
             LEFT JOIN projects p ON tc.project_id=p.id
             WHERE tc.active=TRUE${pf}`;
    const vals = [];
    if (project_id) { q += ` AND tc.project_id=$${vals.length+1}`; vals.push(project_id); }
    if (filter_config?.conditions?.length) {
      for (const cond of filter_config.conditions) {
        const { field, value } = cond;
        if (!field||!value) continue;
        if      (field==="module_id")   { q+=` AND tc.module_id=$${vals.length+1}`;  vals.push(value); }
        else if (field==="priority")    { q+=` AND tc.priority=$${vals.length+1}`;   vals.push(value); }
        else if (field==="type")        { q+=` AND tc.type=$${vals.length+1}`;        vals.push(value); }
        else if (field==="name")        { q+=` AND tc.name ILIKE $${vals.length+1}`; vals.push(`%${value}%`); }
        else if (field==="tags")        { q+=` AND $${vals.length+1}=ANY(tc.tags)`;  vals.push(value); }
        else if (field==="last_status") {
          if (value==="never") q+=` AND NOT EXISTS (SELECT 1 FROM test_runs WHERE test_case_id=tc.id)`;
          else { q+=` AND (SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1)=$${vals.length+1}`; vals.push(value); }
        }
      }
    }
    q += " ORDER BY tc.created_at DESC LIMIT 200";
    const r = await pool.query(q, vals);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/suites", requireAuth, async (req, res) => {
  const { project_id } = req.query;
  try {
    const ids = await getAllowedProjectIds(req.user);
    const vals = [];
    let q = `SELECT ts.*, COALESCE(jsonb_array_length(ts.filter_config->'selected_case_ids'), 0) as test_count FROM test_suites ts WHERE ts.active=TRUE`;
    if (project_id) { q += ` AND ts.project_id=${vals.length+1}`; vals.push(project_id); }
    else if (ids !== null) {
      if (!ids.length) return res.json([]);
      q += ` AND ts.project_id IN (${ids.join(",")})`;
    }
    q += " ORDER BY ts.created_at DESC";
    const r = await pool.query(q, vals);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/suites", requireAuth, requireRole("admin","lead","tester"), async (req, res) => {
  const { project_id, name, description, suite_type, filter_config, selected_case_ids, test_order } = req.body;
  try {
    const fc = Object.assign({ conditions:[], logic:'AND' }, filter_config || {});
    if (selected_case_ids && selected_case_ids.length) fc.selected_case_ids = selected_case_ids;
    if (test_order && Object.keys(test_order).length) fc.test_order = test_order;
    const r = await pool.query(
      "INSERT INTO test_suites (project_id,name,description,suite_type,filter_config) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [project_id, name, description||null, suite_type||"static", JSON.stringify(fc)]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/suites/:id", requireAuth, requireRole("admin","lead","tester"), async (req, res) => {
  const { name, description, project_id, suite_type, filter_config, selected_case_ids, test_order } = req.body;
  try {
    // Merge: start from filter_config, then override with top-level fields
    const fc = Object.assign({ conditions:[], logic:'AND' }, filter_config || {});
    // selected_case_ids: use top-level if provided, else what's in filter_config
    const ids = selected_case_ids !== undefined ? selected_case_ids : (fc.selected_case_ids || []);
    fc.selected_case_ids = Array.isArray(ids) && ids.length ? ids : [];
    // test_order: use top-level if provided, else what's in filter_config
    const order = test_order !== undefined ? test_order : (fc.test_order || null);
    fc.test_order = (order && Object.keys(order).length) ? order : null;
    console.log(`[PUT suite ${req.params.id}] saving ${fc.selected_case_ids.length} ids, order keys: ${Object.keys(fc.test_order||{}).length}`);
    const r = await pool.query(
      "UPDATE test_suites SET name=$1,description=$2,project_id=$3,suite_type=$4,filter_config=$5 WHERE id=$6 RETURNING *",
      [name, description||null, project_id, suite_type||"static", JSON.stringify(fc), req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Suite not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/suites/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT ts.*, COALESCE(jsonb_array_length(ts.filter_config->'selected_case_ids'), 0) as test_count FROM test_suites ts WHERE ts.id=$1 AND ts.active=TRUE",
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "Suite not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/suites/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  try {
    await pool.query("UPDATE test_suites SET active=FALSE WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get resolved test cases for a suite
// Static suite: reads from filter_config.selected_case_ids (in saved order)
// Dynamic suite: runs the conditions query live
app.get("/api/suites/:id/tests", requireAuth, async (req, res) => {
  try {
    const sr = await pool.query("SELECT * FROM test_suites WHERE id=$1 AND active=TRUE", [req.params.id]);
    if (!sr.rows[0]) return res.status(404).json({ error: "Suite not found" });
    const suite = sr.rows[0];
    const fc = typeof suite.filter_config === 'string' ? JSON.parse(suite.filter_config || '{}') : (suite.filter_config || {});
    const selectedIds = (fc.selected_case_ids || []).map(Number);

    // Static suite — return tests in saved order
    if (selectedIds.length) {
      const r = await pool.query(
        `SELECT tc.*, m.name as module_name, p.name as project_name
         FROM test_cases tc
         LEFT JOIN modules m ON tc.module_id=m.id
         LEFT JOIN projects p ON tc.project_id=p.id
         WHERE tc.id = ANY($1) AND tc.active=TRUE
         ORDER BY array_position($1, tc.id)`,
        [selectedIds]
      );
      return res.json(r.rows);
    }

    // Dynamic suite — run the query from conditions
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "tc.project_id");
    let q = `SELECT tc.*, m.name as module_name, p.name as project_name
             FROM test_cases tc
             LEFT JOIN modules m ON tc.module_id=m.id
             LEFT JOIN projects p ON tc.project_id=p.id
             WHERE tc.active=TRUE${pf}`;
    const vals = [];
    if (suite.project_id) { q += ` AND tc.project_id=${vals.length+1}`; vals.push(suite.project_id); }
    if (fc.conditions && fc.conditions.length) {
      for (const cond of fc.conditions) {
        const { field, value } = cond;
        if (!field || !value) continue;
        if      (field==="module_id")   { q+=` AND tc.module_id=${vals.length+1}`;  vals.push(value); }
        else if (field==="priority")    { q+=` AND tc.priority=${vals.length+1}`;   vals.push(value); }
        else if (field==="type")        { q+=` AND tc.type=${vals.length+1}`;        vals.push(value); }
        else if (field==="name")        { q+=` AND tc.name ILIKE ${vals.length+1}`; vals.push(`%${value}%`); }
        else if (field==="tags")        { q+=` AND ${vals.length+1}=ANY(tc.tags)`;  vals.push(value); }
        else if (field==="last_status") {
          if (value==="never") q+=` AND NOT EXISTS (SELECT 1 FROM test_runs WHERE test_case_id=tc.id)`;
          else { q+=` AND (SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1)=${vals.length+1}`; vals.push(value); }
        }
      }
    }
    q += " ORDER BY tc.created_at DESC LIMIT 200";
    const r = await pool.query(q, vals);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TEST CASES ───────────────────────────────────────────────────────────────
// ─── INTERNAL RUNNER ENDPOINT — fetch test case by ID using RUNNER_SECRET ────
// Used by call_test action so runner can fetch called test without a session token
app.get("/api/internal/tests/:id", async (req, res) => {
  const secret = (req.headers.authorization||"").replace("Bearer ","");
  if (secret !== (process.env.RUNNER_SECRET||"nat-internal-runner-2024"))
    return res.status(403).json({ error:"Forbidden" });
  try {
    const r = await pool.query(
      "SELECT id, name, steps, variables, type, base_url, project_id, is_callable FROM test_cases WHERE id=$1 AND active=TRUE",
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error:"Test not found" });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/tests", requireAuth, async (req, res) => {
  const { project_id, suite_id, page = 1, limit, search,
    priority, type: tcType, tag, last_status, no_suite } = req.query;
  const pageSize = parseInt(limit || PAGE_SIZE);
  const offset   = (parseInt(page) - 1) * pageSize;
  try {
    const ids = await getAllowedProjectIds(req.user);
    // Non-admins with zero assigned projects see nothing, full stop — short-circuit
    // before even considering an explicit project_id (which would otherwise still
    // run a query, just one that happens to return no rows).
    if (ids !== null && !ids.length) return res.json({ rows: [], total: 0, page: 1, pages: 0 });
    let q = `SELECT tc.*, ts.name as suite_name, p.name as project_name,
             m.name as module_name,
             (SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1) as last_status,
             (SELECT created_at FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1) as last_run
             FROM test_cases tc
             LEFT JOIN test_suites ts ON tc.suite_id=ts.id
             LEFT JOIN projects p ON tc.project_id=p.id
             LEFT JOIN modules m ON tc.module_id=m.id
             WHERE tc.active=TRUE${projectFilterCol(ids, "tc.project_id")}`;
    const vals = [];
    // Applied ON TOP of the allowed-projects filter above (not instead of it) —
    // previously an explicit project_id bypassed the access check entirely, so a
    // non-admin could see another project's test cases just by passing its id.
    if (project_id) { q += ` AND tc.project_id=$${vals.length+1}`; vals.push(project_id); }
    if (suite_id)    { q += ` AND tc.suite_id=$${vals.length+1}`;  vals.push(suite_id); }
    if (search)      { q += ` AND tc.name ILIKE $${vals.length+1}`; vals.push(`%${search}%`); }
    // Helper: builds IN clause for comma-separated values e.g. "high,medium"
    const addIn = (col, param) => {
      if (!param) return;
      const list = param.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
      if (!list.length) return;
      if (list.length === 1) {
        q += ` AND ${col}=$${vals.length+1}`; vals.push(list[0]);
      } else {
        const placeholders = list.map((_,j)=>`$${vals.length+j+1}`).join(",");
        q += ` AND ${col} IN (${placeholders})`; vals.push(...list);
      }
    };
    addIn("tc.priority", priority);
    addIn("tc.type",     tcType);
    if (tag)         { q += ` AND $${vals.length+1}=ANY(tc.tags)`;  vals.push(tag); }
    if (no_suite==="1") { q += ` AND tc.suite_id IS NULL`; }
    if (last_status) {
      const statusList = last_status.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
      const hasNever   = statusList.includes("never");
      const realStatuses = statusList.filter(v=>v!=="never");
      const conditions = [];
      if (hasNever) {
        conditions.push(`NOT EXISTS (SELECT 1 FROM test_runs WHERE test_case_id=tc.id)`);
      }
      if (realStatuses.length === 1) {
        conditions.push(`(SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1)=$${vals.length+1}`);
        vals.push(realStatuses[0]);
      } else if (realStatuses.length > 1) {
        const ph = realStatuses.map((_,j)=>`$${vals.length+j+1}`).join(",");
        conditions.push(`(SELECT status FROM test_runs WHERE test_case_id=tc.id ORDER BY created_at DESC LIMIT 1) IN (${ph})`);
        vals.push(...realStatuses);
      }
      if (conditions.length === 1) q += ` AND ${conditions[0]}`;
      else if (conditions.length > 1) q += ` AND (${conditions.join(" OR ")})`;
    }
    // Count total
    const countQ = q.replace(/SELECT tc\.\*.*FROM test_cases tc/s, "SELECT COUNT(*) FROM test_cases tc");
    const countR = await pool.query(countQ, vals);
    const total  = parseInt(countR.rows[0].count);
    q += ` ORDER BY tc.created_at DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`;
    vals.push(pageSize, offset);
    const r = await pool.query(q, vals);
    // Return array for backward compat if no pagination params, paginated object if page param given
    if (req.query.page || req.query.limit) {
      res.json({ rows: r.rows, total, page: parseInt(page), pages: Math.ceil(total/pageSize) });
    } else {
      res.json(r.rows); // backward compatible
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── Callable test case search (type-to-search, max 10 results, minimal payload) ──
app.get("/api/tests/callable", requireAuth, async (req, res) => {
  const { project_id, search } = req.query;
  if (!search || search.trim().length < 2) return res.json([]);
  try {
    const ids = await getAllowedProjectIds(req.user);
    // ids === null means admin (sees all projects)
    const isAdmin = ids === null;
    let r;
    if (project_id) {
      // Search within a specific project (admin always allowed, others check access)
      if (!isAdmin && !ids.includes(+project_id)) {
        return res.json([]); // no access to this project
      }
      r = await pool.query(
        `SELECT id, name FROM test_cases
         WHERE project_id=$1 AND is_callable=TRUE AND active=TRUE AND name ILIKE $2
         ORDER BY name ASC LIMIT 10`,
        [project_id, `%${search.trim()}%`]
      );
    } else if (isAdmin) {
      // Admin — search across ALL projects
      r = await pool.query(
        `SELECT id, name FROM test_cases
         WHERE is_callable=TRUE AND active=TRUE AND name ILIKE $1
         ORDER BY name ASC LIMIT 10`,
        [`%${search.trim()}%`]
      );
    } else {
      // Non-admin — search across allowed projects only
      const pf = ids.length ? `AND project_id = ANY($2)` : "AND 1=0";
      const params = ids.length
        ? [`%${search.trim()}%`, ids]
        : [`%${search.trim()}%`];
      r = await pool.query(
        `SELECT id, name FROM test_cases
         WHERE is_callable=TRUE AND active=TRUE AND name ILIKE $1 ${pf}
         ORDER BY name ASC LIMIT 10`,
        params
      );
    }
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/tests/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM test_cases WHERE id=$1 AND active=TRUE", [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Test not found" });
    // Skip project check for internal runner token (scheduled/call_test runs)
    const rawToken = (req.headers.authorization||"").replace("Bearer ","");
    const isRunnerToken = rawToken === (process.env.RUNNER_SECRET||"nat-internal-runner-2024");
    if (!isRunnerToken) {
      const ids = await getAllowedProjectIds(req.user);
      if (ids !== null && !ids.includes(r.rows[0].project_id)) {
        return res.status(403).json({ error: "Access denied to this test case" });
      }
    } else {
      // The runner fetches a test case through this exact route when a "Call Test Case"
      // (call_test) step invokes it from inside another script — that's a separate runtime
      // path from the normal spawn flow, and it was never resolving Saved Connection
      // db_validate/db_extract_multi steps, so a DB step only worked when its own test was
      // run directly, not when called from another script. Embed here too, but ONLY for the
      // runner-token path — never for normal frontend/editor requests, which must not receive
      // decrypted passwords in the response.
      try { r.rows[0].steps = await embedDbConnections(r.rows[0].steps || []); }
      catch(e) { console.error(`[GET /api/tests/:id] embedDbConnections failed for call_test:`, e.message); }
    }
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/tests", requireAuth, requireRole("admin","lead","tester"), async (req, res) => {
  const { suite_id, project_id, name, description, type, browser, base_url, steps, variables, tags, priority, api_config, module_id, is_callable } = req.body;
  if (!name?.trim())   return res.status(400).json({ error: "Test case name is required." });
  if (!project_id)     return res.status(400).json({ error: "Project is required." });
  const sizeErr = validateInputSizes({ name: name.trim(), description: description||"", base_url: base_url||"", steps: steps||[], tags: tags||[] });
  if (sizeErr) return res.status(400).json({ error: sizeErr });
  try {
    // Duplicate name check within same project
    const dup = await pool.query(
      "SELECT id FROM test_cases WHERE name ILIKE $1 AND project_id=$2 AND active=TRUE",
      [name.trim(), project_id]
    );
    if (dup.rows.length > 0)
      return res.status(400).json({ error: `A test case named "${name.trim()}" already exists in this project.` });

    const r = await pool.query(
      "INSERT INTO test_cases (suite_id,project_id,name,description,type,browser,base_url,steps,variables,api_config,tags,priority,created_by,module_id,is_callable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *",
      [suite_id||null, project_id||null, name, description||null, type||"ui", browser||"chrome", base_url||null,
       JSON.stringify(steps||[]), JSON.stringify(variables||[]), api_config ? JSON.stringify(api_config) : null,
       tags||[], priority||"medium", req.user.uid, module_id||null, is_callable||false]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/tests/:id", requireAuth, requireRole("admin","lead","tester"), async (req, res) => {
  const { name, description, type, browser, base_url, steps, variables, tags, priority, suite_id, api_config, module_id, project_id, is_callable, heal_update } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Test case name is required." });
  const sizeErr = validateInputSizes({ name: name.trim(), description: description||"", base_url: base_url||"", steps: steps||[], tags: tags||[] });
  if (sizeErr) return res.status(400).json({ error: sizeErr });
  try {
    // Duplicate name check within same project (exclude self)
    if (project_id) {
      const dup = await pool.query(
        "SELECT id FROM test_cases WHERE name ILIKE $1 AND project_id=$2 AND active=TRUE AND id!=$3",
        [name.trim(), project_id, req.params.id]
      );
      if (dup.rows.length > 0)
        return res.status(400).json({ error: `A test case named "${name.trim()}" already exists in this project.` });
    }

    const r = await pool.query(
      "UPDATE test_cases SET name=$1,description=$2,type=$3,browser=$4,base_url=$5,steps=$6,variables=$7,api_config=$8,tags=$9,priority=$10,suite_id=$11,module_id=$12,is_callable=$13,project_id=$14,heal_update=$15,updated_at=NOW() WHERE id=$16 RETURNING *",
      [name, description||null, type||"ui", browser||"chrome", base_url||null,
       JSON.stringify(steps||[]), JSON.stringify(variables||[]),
       api_config ? JSON.stringify(api_config) : null,
       tags||[], priority||"medium", suite_id||null, module_id||null, is_callable||false, project_id||null, heal_update||false, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
//  AGENT TEST CASES — additive routes (agent-authored scripts in their own table)
//  Reuses existing helpers: pool, requireAuth, requireRole, spawnRunner, broadcast.
//  Prereq: agent_test_cases table created. Does not modify any existing route.
// ============================================================================
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

app.get("/api/agent-tests/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Build a self-contained login prelude (replay opens a clean browser, so the
// script must log in + navigate itself). Selectors captured from the real
// Athma login page. NOTE: password is stored in plain text in the steps — fine
// for SQA/dummy; for real envs reference a {{variable}} instead.
function _agentLoginPrelude({ login_url, username, password, target_url }) {
  const SEL_USER = "#username", SEL_PASS = "#password";
  const SEL_SIGNIN = 'div > div > form:nth-of-type(1) > div:nth-of-type(3) > button';
  return [
    { action: "navigate", value: login_url, _note: "open Athma login page" },
    { action: "wait_for_selector", selector: SEL_USER, _note: "wait for login form" },
    { action: "type", selector: SEL_USER, value: username, _note: "enter username" },
    { action: "type", selector: SEL_PASS, value: password, _note: "enter password" },
    { action: "click", selector: SEL_SIGNIN, _note: "click Sign in" },
    { action: "wait", value: "3000", _note: "wait for login" },
    { action: "navigate", value: target_url, _note: "go to target page" },
    { action: "wait", value: "3000", _note: "wait for page load" },
  ];
}

app.post("/api/agent-tests", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { project_id, name, goal, base_url, type, browser, steps, variables,
          add_login, login_username, login_password, login_url, target_url } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  try {
    let finalSteps = Array.isArray(steps) ? steps.slice() : [];
    // Optionally prepend a login prelude so the script replays self-contained.
    if (add_login) {
      if (!login_username || !login_password || !target_url) {
        return res.status(400).json({ error: "add_login requires login_username, login_password, target_url" });
      }
      const prelude = _agentLoginPrelude({
        login_url: login_url || base_url || "",
        username: login_username, password: login_password, target_url,
      });
      finalSteps = prelude.concat(finalSteps);
    }
    const r = await pool.query(
      `INSERT INTO agent_test_cases (project_id, name, goal, base_url, type, browser, steps, variables, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [project_id || null, name.trim(), goal || null, base_url || null,
       type || "ui", browser || "chrome",
       JSON.stringify(finalSteps), JSON.stringify(variables || []),
       req.user.uid]
    );
    res.json({ id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── AUTHOR a new agent test from a natural-language goal (runs the agent) ────
// Spawns headless_author.py on the SERVER. It logs in, drives the form, and
// writes a script; we read that script and insert it into agent_test_cases.
// NOTE: this opens a real browser on the server machine and AUTO-SUBMITS
// (creates a real record). Use on SQA / dummy data only. Takes 1-3 minutes.
app.post("/api/agent-tests/author", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { goal, target_url, project_id, name,
          login_url, login_username, login_password } = req.body;
  if (!goal?.trim())   return res.status(400).json({ error: "goal is required" });
  if (!target_url)     return res.status(400).json({ error: "target_url is required" });

  const authorScript = path.join(__dirname, "../runner/agent/headless_author.py");
  if (!fs.existsSync(authorScript)) {
    return res.status(500).json({ error: "headless_author.py not found on server" });
  }

  const args = [
    authorScript,
    "--goal", goal,
    "--target-url", target_url,
    "--login-url", login_url || "https://sqa.narayanahealth.org/",
    "--user", login_username || "admin",
    "--password", login_password || "admin",
  ];

  let stdout = "", stderr = "";
  const proc = spawn(PYTHON_CMD, args, {
    cwd: path.join(__dirname, "../runner"),
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  proc.stdout.on("data", d => { stdout += d.toString(); });
  proc.stderr.on("data", d => { stderr += d.toString(); });

  // Kill timer: must be longer than WALL_CLOCK_SECONDS in agent/config.py (currently 420s = 7min).
  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 12 * 60 * 1000);

  proc.on("close", async (code) => {
    clearTimeout(killTimer);
    try {
      // The agent prints: SCRIPT_PATH=<abs path>
      const m = stdout.match(/SCRIPT_PATH=(.+\.json)\s*$/m);
      if (!m) {
        return res.status(500).json({
          error: "Agent did not produce a script.",
          detail: (stderr || stdout).slice(-1500),
        });
      }
      const scriptPath = m[1].trim();
      const doc = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
      const steps = (doc.steps || []).map(st => {
        const o = {}; for (const k in st) if (!k.startsWith("_")) o[k] = st[k]; return o;
      });
      if (!steps.length) {
        return res.status(500).json({ error: "Agent produced an empty script.",
          detail: (stderr || stdout).slice(-1500) });
      }
      const r = await pool.query(
        `INSERT INTO agent_test_cases (project_id, name, goal, base_url, type, browser, steps, variables, created_by)
         VALUES ($1,$2,$3,$4,'ui','chrome',$5,'[]',$6) RETURNING id`,
        [project_id || null, (name || doc.meta?.goal || "Agent test").slice(0, 200),
         doc.meta?.goal || goal, target_url, JSON.stringify(steps), req.user.uid]
      );
      res.json({ id: r.rows[0].id, steps: steps.length });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: (stderr || stdout).slice(-1500) });
    }
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: `Failed to start agent: ${err.message}` });
  });
});

// ── RE-AUTHOR an existing agent test from an edited goal (overwrite in place) ─
// Same as /author but reuses the row's target_url/name and UPDATEs the SAME row
// (overwriting goal + steps) instead of inserting a new one. Login password is
// not stored, so it must be supplied in the request. Creates a real SQA record.
app.post("/api/agent-tests/:id/reauthor", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { goal, login_url, login_username, login_password, target_url } = req.body;
  if (!goal?.trim())     return res.status(400).json({ error: "goal is required" });
  if (!login_password)   return res.status(400).json({ error: "login_password is required" });

  let existing;
  try {
    const ex = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!ex.rows.length) return res.status(404).json({ error: "Agent test not found" });
    existing = ex.rows[0];
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const tgt = target_url || existing.base_url;
  if (!tgt) return res.status(400).json({ error: "target_url is required (none stored on this test)" });

  const authorScript = path.join(__dirname, "../runner/agent/headless_author.py");
  if (!fs.existsSync(authorScript)) {
    return res.status(500).json({ error: "headless_author.py not found on server" });
  }

  const args = [
    authorScript,
    "--goal", goal,
    "--target-url", tgt,
    "--login-url", login_url || "https://sqa.narayanahealth.org/",
    "--user", login_username || "admin",
    "--password", login_password,
  ];

  let stdout = "", stderr = "";
  const proc = spawn(PYTHON_CMD, args, {
    cwd: path.join(__dirname, "../runner"),
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  proc.stdout.on("data", d => { stdout += d.toString(); });
  proc.stderr.on("data", d => { stderr += d.toString(); });

  // Kill timer: must be longer than WALL_CLOCK_SECONDS in agent/config.py (currently 420s = 7min).
  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 12 * 60 * 1000);

  proc.on("close", async (code) => {
    clearTimeout(killTimer);
    try {
      const m = stdout.match(/SCRIPT_PATH=(.+\.json)\s*$/m);
      if (!m) {
        return res.status(500).json({ error: "Agent did not produce a script.",
          detail: (stderr || stdout).slice(-1500) });
      }
      const doc = JSON.parse(fs.readFileSync(m[1].trim(), "utf8"));
      const steps = (doc.steps || []).map(st => {
        const o = {}; for (const k in st) if (!k.startsWith("_")) o[k] = st[k]; return o;
      });
      if (!steps.length) {
        return res.status(500).json({ error: "Agent produced an empty script.",
          detail: (stderr || stdout).slice(-1500) });
      }
      const r = await pool.query(
        `UPDATE agent_test_cases
            SET goal = $1, steps = $2, base_url = $3, status = 'draft',
                approved = false, updated_at = NOW()
          WHERE id = $4
        RETURNING id`,
        [goal, JSON.stringify(steps), tgt, req.params.id]
      );
      res.json({ id: r.rows[0].id, steps: steps.length });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: (stderr || stdout).slice(-1500) });
    }
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: `Failed to start agent: ${err.message}` });
  });
});

// ── STUDY a new screen: read its controls and draft a playbook ───────────────
// Spawns study_screen.py on the SERVER. It logs in, navigates to target_url,
// perceives every control (same digest the agent uses), and asks the LLM ONCE
// to write a screen playbook into runner/agent/playbooks/. After this, "Create
// with agent" on that screen uses real, screen-specific guidance instead of
// generic-only rules. Read-only on the app (no records created). ~30-60s.
app.post("/api/agent-tests/study", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  const { target_url, label, match,
          login_url, login_username, login_password } = req.body;
  if (!target_url) return res.status(400).json({ error: "target_url is required" });

  const studyScript = path.join(__dirname, "../runner/agent/study_screen.py");
  if (!fs.existsSync(studyScript)) {
    return res.status(500).json({ error: "study_screen.py not found on server" });
  }

  const args = [
    studyScript,
    "--target-url", target_url,
    "--login-url", login_url || "https://sqa.narayanahealth.org/",
    "--user", login_username || "admin",
    "--password", login_password || "admin",
  ];
  if (label) { args.push("--label", label); }
  if (match) { args.push("--match", match); }

  let stdout = "", stderr = "";
  const proc = spawn(PYTHON_CMD, args, {
    cwd: path.join(__dirname, "../runner"),
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  proc.stdout.on("data", d => { stdout += d.toString(); });
  proc.stderr.on("data", d => { stderr += d.toString(); });

  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 3 * 60 * 1000);

  proc.on("close", () => {
    clearTimeout(killTimer);
    try {
      const errM = stdout.match(/STUDY_ERROR=(.+)$/m);
      if (errM) {
        return res.status(500).json({ error: errM[1].trim(),
          detail: (stderr || stdout).slice(-1500) });
      }
      const m = stdout.match(/PLAYBOOK_PATH=(.+\.md)\s*$/m);
      if (!m) {
        return res.status(500).json({
          error: "Study did not produce a playbook.",
          detail: (stderr || stdout).slice(-1500),
        });
      }
      const playbookPath = m[1].trim();
      let playbook = "";
      try { playbook = fs.readFileSync(playbookPath, "utf8"); } catch {}
      // Count controls from the printed summary line if present.
      const cm = stdout.match(/controls=(\d+)\s+match='([^']*)'/);
      res.json({
        ok: true,
        playbook_path: playbookPath,
        playbook,
        controls: cm ? parseInt(cm[1]) : null,
        match: cm ? cm[2] : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message, detail: (stderr || stdout).slice(-1500) });
    }
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    res.status(500).json({ error: `Failed to start study: ${err.message}` });
  });
});

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
      [goal ?? null, (name && name.trim()) || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Agent test not found" });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/agent-tests/:id", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  try {
    await pool.query("DELETE FROM agent_test_cases WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/agent-tests/:id/run", requireAuth, requireRole("admin", "lead", "tester"), async (req, res) => {
  try {
    const tc = await pool.query("SELECT * FROM agent_test_cases WHERE id=$1", [req.params.id]);
    if (!tc.rows.length) return res.status(404).json({ error: "Agent test not found" });
    const a = tc.rows[0];
    const run = await pool.query(
      `INSERT INTO test_runs (test_case_id, project_id, status, browser, triggered_by, started_at, origin_server)
       VALUES ($1,$2,'running',$3,$4,NOW(),$5) RETURNING id`,
      [null, a.project_id, a.browser || "chrome", `agent-test:${a.id}`, INSTANCE_ID]
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
      message: `\u25b6 Running AGENT test "${a.name}" (id ${a.id}) \u2014 no AI, replay only`,
      timestamp: new Date().toISOString() });
    spawnRunner(runId, config);
    res.json({ run_id: runId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

// ── Copy test case ────────────────────────────────────────────────────────────
app.post("/api/tests/:id/copy", requireAuth, requireRole("admin","lead","tester"), async (req, res) => {
  try {
    const orig = await pool.query("SELECT * FROM test_cases WHERE id=$1 AND active=TRUE", [req.params.id]);
    if (!orig.rows.length) return res.status(404).json({ error: "Test case not found" });
    const t = orig.rows[0];

    // Generate unique name: "Copy of X", then "Copy of X (2)", etc.
    let newName = `Copy of ${t.name}`;
    let suffix = 1;
    while (true) {
      const exists = await pool.query(
        "SELECT id FROM test_cases WHERE name ILIKE $1 AND project_id=$2 AND active=TRUE",
        [newName, t.project_id]
      );
      if (!exists.rows.length) break;
      suffix++;
      newName = `Copy of ${t.name} (${suffix})`;
    }

    const r = await pool.query(
      `INSERT INTO test_cases
        (name, description, type, browser, base_url, steps, variables, api_config,
         tags, priority, project_id, module_id, suite_id, created_by, is_callable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14) RETURNING *`,
      [
        newName, t.description, t.type, t.browser, t.base_url,
        JSON.stringify(t.steps || []),
        JSON.stringify(t.variables || []),
        t.api_config ? JSON.stringify(t.api_config) : null,
        t.tags || [], t.priority,
        t.project_id, t.module_id || null,
        req.user?.uid || null,
        t.is_callable || false  // preserve callable flag on copy
      ]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/tests/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  try {
    const testId = req.params.id;
    // Block deletion if this test case is still referenced by a "Call Test" step
    // in any other active test case — deleting it would silently break those callers.
    const callers = await pool.query(
      `SELECT id, name FROM test_cases
        WHERE active = TRUE
          AND id <> $1
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(steps::jsonb, '[]'::jsonb)) elem
             WHERE elem->>'action' = 'call_test' AND elem->>'value' = $2
          )
        ORDER BY name`,
      [testId, String(testId)]
    );
    if (callers.rows.length) {
      const names = callers.rows.map(r => r.name).join(", ");
      return res.status(409).json({
        error: `Cannot delete — this test case is called by: ${names}. Remove the Call Test step(s) from ${callers.rows.length > 1 ? "those test cases" : "that test case"} first.`,
        callers: callers.rows,
      });
    }
    await pool.query("UPDATE test_cases SET active=FALSE WHERE id=$1", [testId]);
    res.json({ success: true });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RUN TEST ─────────────────────────────────────────────────────────────────
// ─── SPAWN RUNNER (shared helper) ────────────────────────────────────────────
async function spawnRunner(runId, config) {
  // Resolve any "Saved Connection" db_validate/db_extract_multi steps into their
  // real host/port/user/password BEFORE the runner ever sees them — otherwise the
  // runner falls back to its own defaults (localhost, no password) and fails with
  // "fe_sendauth: no password supplied".
  if (config.steps && config.steps.length) {
    try { config.steps = await embedDbConnections(config.steps); }
    catch(e) { console.error(`[spawnRunner] embedDbConnections failed for run ${runId}:`, e.message); }
  }
  // Write config to temp file to avoid ENAMETOOLONG on large test cases
  const configPath = path.join(LOGS_PATH, `config_${runId}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

  const proc = spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(runId), "--config-file", configPath], {
    detached: false,
    stdio:    ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  activeRunPids.set(runId, proc.pid);
  console.log(`[spawnRunner] run ${runId} spawned — pid=${proc.pid}`);

  proc.on("error", (err) => {
    console.error(`❌ Spawn error run ${runId}: ${err.message}`);
    pool.query("UPDATE test_runs SET status='error' WHERE id=$1", [runId]);
    broadcast(runId, { type:"status", status:"error" });
    broadcast(runId, { type:"log", level:"error", message:`❌ ${err.message}`, timestamp:new Date().toISOString() });
    activeRunPids.delete(runId);
  });
  proc.stdout.on("data", d => {
    // Logs sent via API — suppress stdout to avoid server log spam
    // const txt = d.toString().trim();
    // if (txt) console.log(`[run ${runId}] ${txt.slice(0,200)}`);
  });
  proc.stderr.on("data", d => {
    const txt = d.toString().trim();
    if (txt) {
      console.error(`[run ${runId}] stderr: ${txt.slice(0,200)}`);
      // Only broadcast stderr as it won't come through the API
      broadcast(runId, { type:"log", level:"error", message:txt.slice(0,500), timestamp:new Date().toISOString() });
    }
  });
  proc.on("close", (code) => {
    console.log(`[spawnRunner] run ${runId} process closed — exit code=${code}`);
    // Clean up temp config file
    try { fs.unlinkSync(configPath); } catch(e) {}
    pool.query(
      "SELECT status FROM test_runs WHERE id=$1", [runId]
    ).then(r => {
      const currentStatus = r.rows[0]?.status;
      console.log(`[spawnRunner] run ${runId} close-handler — db status at exit: ${currentStatus}`);
      if (currentStatus && !['aborted','error'].includes(currentStatus)) {
        // Runner exited but status not yet set — mark as error
        if (code !== 0 && currentStatus === 'running') {
          console.warn(`[close handler] Setting run ${runId} to error (code=${code})`);
          pool.query("UPDATE test_runs SET status='error', finished_at=NOW() WHERE id=$1 AND status='running'", [runId]).catch(()=>{});
        }
      }
    }).catch(()=>{});
    broadcast(runId, { type:"done", code });
    activeRunPids.delete(runId);
    // Trigger queue worker immediately after a run finishes
    setTimeout(processQueue, 100);
  });
  return proc;
}

// Track active run PIDs
const activeRunPids = new Map(); // runId -> pid

// ─── Find/kill a runner process by run id, even if it isn't tracked in
// activeRunPids ──────────────────────────────────────────────────────────────
// activeRunPids only knows about processes THIS Node instance spawned. If the
// backend was restarted non-gracefully (crash, hard kill, etc.) a runner.py
// process spawned by the *previous* instance can still be alive as an orphan —
// still driving a real browser — with nothing in the new process's memory
// pointing at it. This looks it up directly in the OS process list by matching
// the exact "--run-id <id> --config-file" argument sequence every spawn call
// uses, so it can be found and killed regardless of which backend instance
// started it. Returns a Promise<boolean> (true if a kill was attempted).
function killRunnerProcessByRunId(runId) {
  return new Promise((resolve) => {
    const id = parseInt(runId);
    if (!Number.isInteger(id)) return resolve(false);
    if (process.platform === "win32") {
      const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | ` +
        `Where-Object { $_.CommandLine -like '*--run-id ${id} --config-file*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;
      exec(cmd, { timeout: 8000 }, (err) => resolve(!err));
    } else {
      exec(`pkill -f -- "--run-id ${id} --config-file"`, { timeout: 8000 }, () => resolve(true));
    }
  });
}

// Track aborted suite runs so sequential loop can stop early
const abortedSuiteRuns = new Set(); // suiteRunId

// ─── ABORT SINGLE RUN ────────────────────────────────────────────────────────
app.delete("/api/runs/:id/abort", requireAuth, async (req, res) => {
  const runId = parseInt(req.params.id);
  try {
    const pid = activeRunPids.get(runId);
    console.log(`[abort] run ${runId} — tracked pid: ${pid || 'NONE (not in activeRunPids)'}`);
    if (pid) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { shell: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        console.log(`[abort] run ${runId} — kill signal sent to pid ${pid}`);
      } catch(e) { console.log(`[abort] run ${runId} — kill attempt threw: ${e.message}`); /* process may have already exited */ }
      activeRunPids.delete(runId);
    } else {
      // Not tracked in this process's memory — may be an orphan left behind by a
      // prior (non-graceful) backend restart, still genuinely running a browser
      // session. Best-effort kill it by matching its run id in the OS process list.
      killRunnerProcessByRunId(runId).then(killed => {
        if (killed) console.log(`[abort] run ${runId} — attempted kill of untracked/orphaned process by run-id match`);
      }).catch(()=>{});
    }
    const abortUpd = await pool.query(
      "UPDATE test_runs SET status='aborted', finished_at=NOW() WHERE id=$1 AND status IN ('running','queued') RETURNING id",
      [runId]
    );
    console.log(`[abort] run ${runId} — DB rows set to aborted: ${abortUpd.rows.length}`);
    broadcast(runId, { type: 'aborted' });
    // Immediately trigger queue so next queued run starts
    setTimeout(processQueue, 200);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── ABORT SUITE RUN ─────────────────────────────────────────────────────────
app.delete("/api/suite-runs/:id/abort", requireAuth, async (req, res) => {
  const suiteRunId = parseInt(req.params.id);
  try {
    // Flag so the sequential loop stops after current test
    abortedSuiteRuns.add(suiteRunId);

    // Kill currently running test in this suite if any
    const runningRuns = await pool.query(
      "SELECT id FROM test_runs WHERE suite_run_id=$1 AND status='running'",
      [suiteRunId]
    );
    for (const row of runningRuns.rows) {
      const pid = activeRunPids.get(row.id);
      if (pid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { shell: true });
          } else {
            process.kill(pid, 'SIGKILL');
          }
        } catch(e) {}
        activeRunPids.delete(row.id);
      } else {
        // Orphaned from a prior backend restart — best-effort kill by run-id match.
        killRunnerProcessByRunId(row.id).catch(()=>{});
      }
      await pool.query(
        "UPDATE test_runs SET status='aborted', finished_at=NOW() WHERE id=$1",
        [row.id]
      );
    }
    // Mark queued tests as aborted too
    await pool.query(
      "UPDATE test_runs SET status='aborted', finished_at=NOW() WHERE suite_run_id=$1 AND status='queued'",
      [suiteRunId]
    );
    // Mark suite run as aborted
    await pool.query(
      "UPDATE suite_runs SET status='aborted', finished_at=NOW() WHERE id=$1",
      [suiteRunId]
    );
    broadcast(suiteRunId, { type: 'suite_aborted' });
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ─── QUEUE WORKER ─────────────────────────────────────────────────────────────
let _lastQueueLogState = ''; // track last logged state — only log on change
let _skippedSuiteRuns = new Set(); // track already-logged suite SKIP messages
let _skippedOrgRuns = new Set();   // track already-logged org limit SKIP messages
function queueTimestamp() { return new Date().toLocaleTimeString('en-IN', { hour12: false }); }
async function processQueue() {
  try {
    // Auto-recover stuck runs
    const stuckCutoff = new Date(Date.now() - STUCK_RUN_TIMEOUT_MIN * 60 * 1000);
    const stuck = await pool.query(
      `UPDATE test_runs SET status='failed', finished_at=NOW()
       WHERE status='running'
         AND started_at IS NOT NULL
         AND started_at < $1
         AND started_at > $2
		 AND (triggered_by IS NULL OR triggered_by NOT IN ('debug','parallel','suite','schedule','ci'))
       RETURNING id`,
      [stuckCutoff, SERVER_START_TIME]
    );
    if (stuck.rows.length > 0) {
      console.warn(`⚠️  Auto-failed ${stuck.rows.length} stuck run(s) (>${STUCK_RUN_TIMEOUT_MIN}min): ${stuck.rows.map(r=>r.id).join(',')}`);
      stuck.rows.forEach(r => {
        broadcast(r.id, { type:"status", status:"failed" });
        broadcast(r.id, { type:"log", level:"error", message:`⚠️ Run auto-failed: exceeded ${STUCK_RUN_TIMEOUT_MIN} minute timeout`, timestamp:new Date().toISOString() });
        broadcast(r.id, { type:"done", code:1 });
      });
    }

    // Count ALL running jobs per org (includes suite + manual + all triggered_by)
    // Scoped to THIS server's own runs — in a multi-server deployment sharing
    // one DB, a sibling server's load must not eat into this server's capacity
    // (origin_server IS NULL keeps legacy pre-migration rows counted too).
    const runningRes = await pool.query(`
      SELECT
        COALESCE(uo.org_id::text, 'none') as org_id,
        COALESCE(o.name, 'No Org') as org_name,
        COUNT(*) as total,
        STRING_AGG(COALESCE(u.username, 'unknown'), ', ' ORDER BY COALESCE(u.username, 'unknown')) as users
      FROM test_runs tr
      LEFT JOIN auto_users u ON u.id = tr.run_by
      LEFT JOIN (
        SELECT DISTINCT ON (user_id) user_id, org_id FROM user_orgs ORDER BY user_id, org_id
      ) uo ON uo.user_id = tr.run_by
      LEFT JOIN organisations o ON o.id = uo.org_id
      WHERE tr.status = 'running'
        AND (tr.origin_server = $1 OR tr.origin_server IS NULL)
      GROUP BY COALESCE(uo.org_id::text, 'none'), COALESCE(o.name, 'No Org')
    `, [INSTANCE_ID]);

    const orgCounts = {};
    const orgDetails = {};
    runningRes.rows.forEach(r => {
      orgCounts[r.org_id] = parseInt(r.total);
      orgDetails[r.org_id] = { name: r.org_name, users: r.users, count: parseInt(r.total) };
    });
    const totalRunning = Object.values(orgCounts).reduce((s, v) => s + v, 0);

    if (totalRunning > 0) {
      const orgSummary = Object.values(orgDetails)
        .map(d => `${d.name}: ${d.count}/${MAX_RUNS_PER_ORG} slots (users: ${d.users})`)
        .join(' | ');
      const logState = `${totalRunning}|${orgSummary}`;
      if (logState !== _lastQueueLogState) {
        console.log(`[Queue ${queueTimestamp()}] Running: ${totalRunning}/${MAX_CONCURRENT_RUNS} global | ${orgSummary}`);
        _lastQueueLogState = logState;
      }
    } else {
      if (_lastQueueLogState !== '0') {
        console.log(`[Queue ${queueTimestamp()}] Running: 0/${MAX_CONCURRENT_RUNS} — all slots free`);
        _lastQueueLogState = '0';
      }
    }

    if (totalRunning >= MAX_CONCURRENT_RUNS) return; // global limit reached

    const slotsAvailable = MAX_CONCURRENT_RUNS - totalRunning;

    // Pick queued runs — simple join, no organisations table
    // Scoped to rows THIS server created (origin_server) so a run submitted
    // through one server's URL always executes on that same server, never a
    // sibling server sharing the same database (origin_server IS NULL keeps
    // legacy pre-migration rows from getting stuck forever).
    const queued = await pool.query(`
      SELECT tr.*, tc.type as tc_type, tc.steps, tc.base_url, tc.api_config as tc_api_config,
             tc.variables as test_case_variables,
             tr.variables as test_run_variables,
             uo2.org_id as session_org_id,
             u.role as user_role,
             CASE tr.triggered_by
               WHEN 'manual'   THEN 1
               WHEN 'parallel' THEN 2
               WHEN 'debug'    THEN 1
               ELSE                 3
             END as priority_rank
      FROM test_runs tr
      LEFT JOIN test_cases tc ON tc.id = tr.test_case_id
      LEFT JOIN auto_users u ON u.id = tr.run_by
      LEFT JOIN (
        SELECT DISTINCT ON (user_id) user_id, org_id FROM user_orgs ORDER BY user_id, org_id
      ) uo2 ON uo2.user_id = tr.run_by
      WHERE tr.status = 'queued'
        AND tr.suite_run_id IS NULL
        AND (tr.origin_server = $1 OR tr.origin_server IS NULL)
      ORDER BY priority_rank ASC, tr.created_at ASC
      LIMIT $2
    `, [INSTANCE_ID, slotsAvailable * 2]);

    let spawned = 0;
    for (const run of queued.rows) {
      if (spawned >= slotsAvailable) break;

      // Per-org limit — superadmin only counts against global limit, not org limit
      const isSuperAdmin = run.user_role === 'superadmin';
      const orgKey = run.session_org_id ? String(run.session_org_id) : 'none';
      const orgRunning = orgCounts[orgKey] || 0;
      if (!isSuperAdmin && orgKey !== 'none' && orgRunning >= MAX_RUNS_PER_ORG) {
        if (!_skippedOrgRuns.has(run.id)) {
          console.log(`[Queue ${queueTimestamp()}] SKIP run ${run.id} — org ${orgKey} at limit (${orgRunning}/${MAX_RUNS_PER_ORG})`);
          _skippedOrgRuns.add(run.id);
        }
        continue;
      }
      _skippedOrgRuns.delete(run.id); // clear if it gets picked eventually

      // Per-suite limit — check how many tests from same suite_run are already running
      if (run.triggered_by === 'suite' && run.suite_run_id) {
        const suiteRunning = await pool.query(
          "SELECT COUNT(*) as c FROM test_runs WHERE suite_run_id=$1 AND status='running'",
          [run.suite_run_id]
        );
        if (parseInt(suiteRunning.rows[0].c) >= MAX_RUNS_PER_SUITE) {
          if (!_skippedSuiteRuns.has(run.suite_run_id)) {
            console.log(`[Queue ${queueTimestamp()}] Suite run ${run.suite_run_id} — queued tests waiting (max ${MAX_RUNS_PER_SUITE} slot per suite)`);
            _skippedSuiteRuns.add(run.suite_run_id);
          }
          continue;
        }
      }

      // Mark as running
      const updated = await pool.query(
        "UPDATE test_runs SET status='running', started_at=NOW() WHERE id=$1 AND status='queued' RETURNING *",
        [run.id]
      );
      if (!updated.rows.length) continue; // race condition

      orgCounts[orgKey] = (orgCounts[orgKey] || 0) + 1;
      spawned++;

      try {
      // Build config
      const runnerToken = process.env.RUNNER_SECRET || "nat-internal-runner-2024";
      let projectVars = {};
      if (run.project_id) {
        try {
          const pvRes = await pool.query(
            "SELECT name,value,type FROM project_variables WHERE project_id=$1",
            [run.project_id]
          );
          pvRes.rows.forEach(v => {
            projectVars[v.name] = v.type==="secret" ? decryptValue(v.value) : (v.value||"");
          });
        } catch(e) { console.warn("[Queue] Could not load project vars:", e.message); }
      }

      // PARALLEL VARIABLES FIX: Merge test case variables with test run variables
      const testCaseVars = run.test_case_variables || [];

      console.log(`[DEBUG Run ${run.id}] testCaseVars content (fresh from DB, test_case_id=${run.test_case_id}):`, JSON.stringify(testCaseVars));
      broadcast(run.id, { type:"log", level:"info",
        message:`[DEBUG] Variables loaded from DB for test_case_id=${run.test_case_id}: ${JSON.stringify(testCaseVars)}`,
        timestamp:new Date().toISOString() });

      console.log(`[DEBUG Run ${run.id}] RAW test_run_variables:`, run.test_run_variables);
      console.log(`[DEBUG Run ${run.id}] TYPE:`, typeof run.test_run_variables);
      
      let testRunVars = run.test_run_variables || [];
      if (!Array.isArray(testRunVars)) {
        console.log(`[DEBUG Run ${run.id}] Converting to array, type was:`, typeof testRunVars);
        testRunVars = [];
      }
      
      console.log(`[DEBUG Run ${run.id}] testCaseVars count:`, testCaseVars.length);
      console.log(`[DEBUG Run ${run.id}] testRunVars count:`, testRunVars.length);
      if (testRunVars.length > 0) {
        console.log(`[DEBUG Run ${run.id}] testRunVars content:`, JSON.stringify(testRunVars));
      }
      
      // Merge: test run variables override test case variables
      const mergedVariables = [...testCaseVars];
      testRunVars.forEach(rv => {
        const idx = mergedVariables.findIndex(v => v.name === rv.name);
        if (idx >= 0) mergedVariables[idx] = rv;
        else mergedVariables.push(rv);
      });
      
      console.log(`[DEBUG Run ${run.id}] mergedVariables count:`, mergedVariables.length);

      // Fetch heal_update flag from test case
      let healUpdate = false;
      if (run.test_case_id) {
        try {
          const tcRow = await pool.query('SELECT heal_update FROM test_cases WHERE id=$1', [run.test_case_id]);
          healUpdate = tcRow.rows[0]?.heal_update || false;
        } catch(e) {}
      }

      const config = {
        type:         run.tc_type || run.type,
        steps:        run.steps        || [],
        browser:      run.browser      || "chrome",
        base_url:     run.base_url     || "",
        variables:    mergedVariables,
        project_vars: projectVars,
        project_id:   run.project_id,
        runner_token: runnerToken,
        test_case_id: run.test_case_id,
        api_config:   run.tc_api_config || run.api_config || null,
        heal_update:  healUpdate,
      };

      console.log(`▶ Queue: spawning run ${run.id} (${run.triggered_by}, ${run.browser})`);
      broadcast(run.id, { type:"status", status:"running" });
      broadcast(run.id, { type:"log", level:"info", message:`▶ Starting run (queued position processed)`, timestamp:new Date().toISOString() });
      spawnRunner(run.id, config);
      } catch (spawnErr) {
        // Never leave a run stuck at "running" with nothing behind it — if anything
        // fails between marking it running and actually spawning the process, fail it
        // explicitly instead of silently abandoning it (this was the root cause of runs
        // getting permanently stuck at "running" with no process and no logs).
        console.error(`[Queue] run ${run.id} failed to spawn: ${spawnErr.message}`);
        pool.query("UPDATE test_runs SET status='error', finished_at=NOW() WHERE id=$1 AND status='running'", [run.id]).catch(()=>{});
        broadcast(run.id, { type:"status", status:"error" });
        broadcast(run.id, { type:"log", level:"error", message:`❌ Failed to start: ${spawnErr.message}`, timestamp:new Date().toISOString() });
        broadcast(run.id, { type:"done", code:1 });
      }
    }
  } catch(err) {
    console.error("[Queue] Error:", err.message);
  }
}

// ─── TEST RUN ENDPOINT (queue-based) ─────────────────────────────────────────
app.post("/api/tests/:id/run", requireAuth, async (req, res) => {
  // Rate limit: max 30 run requests per minute per user
  if (!checkRateLimit(`run:${req.user.uid}`, 30)) {
    return res.status(429).json({ error: "Too many run requests. Please wait a moment." });
  }
  const { browser } = req.body;
  try {
    const tc = await pool.query("SELECT id,name,type,browser,base_url,steps,api_config,project_id FROM test_cases WHERE id=$1", [req.params.id]);
    if (!tc.rows[0]) return res.status(404).json({ error: "Test not found" });
    const test = tc.rows[0];

    const run = await pool.query(
      "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,run_by,origin_server) VALUES ($1,$2,'queued',$3,'manual',$4,$5) RETURNING *",
      [test.id, test.project_id, browser||test.browser||"chrome", req.user.uid, INSTANCE_ID]
    );
    const runId = run.rows[0].id;

    // Get queue position
    const posRes = await pool.query(
      "SELECT COUNT(*) as pos FROM test_runs WHERE status='queued' AND created_at <= (SELECT created_at FROM test_runs WHERE id=$1)",
      [runId]
    );
    const queuePos = parseInt(posRes.rows[0].pos);

    res.json({ run_id: runId, status: "queued", queue_position: queuePos });
    broadcast(runId, { type:"log", level:"info", message:`⏳ Queued (position ${queuePos})`, timestamp:new Date().toISOString() });

    // Trigger queue worker
    setTimeout(processQueue, 50);

  } catch (err) {
    console.error(`❌ Run route error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── QUEUE STATUS ─────────────────────────────────────────────────────────────
app.get("/api/queue/status", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT status, COUNT(*) as count FROM test_runs
      WHERE status IN ('queued','running') GROUP BY status
    `);
    const stats = { queued: 0, running: 0 };
    r.rows.forEach(row => { stats[row.status] = parseInt(row.count); });
    res.json({ ...stats, max_concurrent: MAX_CONCURRENT_RUNS, slots_available: Math.max(0, MAX_CONCURRENT_RUNS - stats.running) });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── BATCH LOG ENDPOINT (used by async_runner.py) ────────────────────────
// Broadcast only — no DB write (avoids performance issues with large log volumes)
app.post("/api/runs/:id/logs-batch", async (req, res) => {
  const { logs } = req.body;
  if (!Array.isArray(logs) || logs.length === 0) return res.json({ ok: true });
  for (const l of logs) {
    broadcast(req.params.id, { type: "log", ...l });
  }
  res.json({ ok: true });
});

app.post("/api/runs/:id/log", async (req, res) => {
  const { level, message, step_index, timestamp } = req.body;
  try {
    await pool.query(
      "UPDATE test_runs SET logs = logs || $1::jsonb WHERE id=$2",
      [JSON.stringify([{ level, message, step_index, timestamp }]), req.params.id]
    );
    broadcast(req.params.id, { type: "log", level, message, step_index, timestamp });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SERVE LOG FILES ─────────────────────────────────────────────────────────
// ─── SERVE LOG FILES ──────────────────────────────────────────────────────────
app.get("/api/runs/:id/logs", requireAuth, (req, res) => {
  try {
    const logFile = path.join(LOGS_PATH, `run_${req.params.id}.log`);
    if (!fs.existsSync(logFile)) return res.json([]);
    // .replace strips a trailing \r — the runner writes this file in Python
    // text mode, which on Windows silently turns every \n into \r\n. Splitting
    // on "\n" alone then leaves a stray \r on the end of every line, which broke
    // the regex below (no "s" flag, so "." never matches \r) — every single
    // line fell through to the raw, unparsed fallback below.
    const lines = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean).map(l => l.replace(/\r$/, ""));
    const logs = lines.map(line => {
      // Parse: [HH:MM:SS] [LEVEL] message
      const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[([A-Z]+)\]\s*(.*)$/);
      // The frontend always does timestamp.slice(11,19) to pull "HH:MM:SS" out
      // of what it expects to be a full ISO datetime string. A bare "HH:MM:SS"
      // is only 8 chars, so slice(11,19) on it silently returns "" (index past
      // the end) — wrap it in a dummy date so that slice keeps working.
      if (m) return { timestamp: `1970-01-01T${m[1]}.000Z`, level: m[2].toLowerCase(), message: m[3] };
      return { timestamp: "", level: "info", message: line };
    });
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/runs/:id/screenshot", async (req, res) => {
  const { label, filename, data, timestamp } = req.body;
  try {
    // Save base64 image to disk
    const imgPath = path.join(SCREENSHOTS_PATH, filename);
    fs.writeFileSync(imgPath, Buffer.from(data, "base64"));
    await pool.query(
      "UPDATE test_runs SET screenshots = screenshots || $1::jsonb WHERE id=$2",
      [JSON.stringify([{ label, filename, timestamp }]), req.params.id]
    );
    broadcast(req.params.id, { type: "screenshot", label, filename });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/runs/:id", async (req, res) => {
  const { status, duration_ms, steps_total, steps_passed, steps_failed, started_at, finished_at } = req.body;
  // ── Debug: log ALL status changes ──
  if (status) {
    console.log(`[PATCH run ${req.params.id}] status=${status} IP:${req.ip} steps_passed:${steps_passed} steps_failed:${steps_failed} duration:${duration_ms}`);
  }
  try {
    // Guard: once a run has been force-finalized as 'error' or 'aborted' (e.g. by
    // the startup orphan cleanup after a backend restart, or a user abort), don't
    // let a late callback from that same orphaned/killed runner process silently
    // resurrect or mutate it — the process that's calling this may be a leftover
    // that outlived the run it thinks it still owns.
    const curRes = await pool.query("SELECT status FROM test_runs WHERE id=$1", [req.params.id]);
    const curStatus = curRes.rows[0]?.status;
    if (curStatus && ['error', 'aborted'].includes(curStatus)) {
      console.log(`[PATCH run ${req.params.id}] ignored — already finalized as '${curStatus}'`);
      return res.json({ ok: true, ignored: true });
    }

    await pool.query(
      "UPDATE test_runs SET status=COALESCE($1,status), duration_ms=COALESCE($2,duration_ms), steps_total=COALESCE($3,steps_total), steps_passed=COALESCE($4,steps_passed), steps_failed=COALESCE($5,steps_failed), started_at=COALESCE($6,started_at), finished_at=COALESCE($7,finished_at) WHERE id=$8",
      [status, duration_ms, steps_total, steps_passed, steps_failed, started_at, finished_at, req.params.id]
    );
    broadcast(req.params.id, { type: "status", status });

    // ── Slow run detection ──
    // Only check when test finishes with a result and duration is available
    if (duration_ms && (status === 'passed' || status === 'failed')) {
      try {
        // Get test_case_id for this run
        const runRow = await pool.query(
          "SELECT test_case_id, name FROM test_runs tr LEFT JOIN test_cases tc ON tc.id=tr.test_case_id WHERE tr.id=$1",
          [req.params.id]
        );
        if (runRow.rows[0]?.test_case_id) {
          const tcId = runRow.rows[0].test_case_id;
          const tcName = runRow.rows[0].name || 'Unknown';
          // Get average duration of last 10 passed runs in last 30 days
          const avgRow = await pool.query(
            `SELECT ROUND(AVG(duration_ms)) as avg_ms, COUNT(*) as run_count
             FROM (
               SELECT duration_ms FROM test_runs
               WHERE test_case_id=$1
                 AND status='passed'
                 AND duration_ms IS NOT NULL
                 AND duration_ms > 0
                 AND finished_at > NOW() - INTERVAL '30 days'
                 AND id != $2
               ORDER BY finished_at DESC
               LIMIT 10
             ) recent`,
            [tcId, req.params.id]
          );
          const avgMs  = parseInt(avgRow.rows[0]?.avg_ms  || 0);
          const runCnt = parseInt(avgRow.rows[0]?.run_count || 0);
          const SLOW_THRESHOLD = parseFloat(process.env.SLOW_RUN_THRESHOLD || '2'); // default 2x
          if (avgMs > 0 && runCnt >= 1 && duration_ms > avgMs * SLOW_THRESHOLD) {
            const times  = (duration_ms / 1000).toFixed(1);
            const avgSec = (avgMs / 1000).toFixed(1);
            const factor = (duration_ms / avgMs).toFixed(1);
            const msg = `⚠️ Slow run detected: "${tcName}" took ${times}s (${factor}x slower than avg ${avgSec}s). Possible performance issue.`;
            console.warn(`[SlowRun] ${msg}`);
            broadcast(req.params.id, { type: 'slow_run', message: msg, duration_ms, avg_ms: avgMs, factor: parseFloat(factor) });
          }
        }
      } catch(e) { /* non-critical — don't fail the request */ }
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TEST RUNS ────────────────────────────────────────────────────────────────
app.get("/api/runs", requireAuth, async (req, res) => {
  const { test_case_id, project_id, status, triggered_by, page = 1, limit, search } = req.query;
  const pageSize = parseInt(limit || PAGE_SIZE);
  const offset   = (parseInt(page) - 1) * pageSize;
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "tr.project_id");
    let q = `SELECT tr.id, tr.status, tr.browser, tr.duration_ms, tr.steps_passed, tr.steps_failed,
             COALESCE(tr.steps_total, jsonb_array_length(tc.steps), jsonb_array_length(atc.steps)) as steps_total,
             tr.created_at, tr.started_at, tr.finished_at, tr.triggered_by,
             tr.parallel_run_id, tr.parallel_label,
             COALESCE(tc.name, atc.name) as test_name, tc.type as test_type, p.name as project_name,
             u.username as run_by_username, u.full_name as run_by_name
             FROM test_runs tr
             LEFT JOIN test_cases tc ON tr.test_case_id=tc.id
             LEFT JOIN agent_test_cases atc
               ON tr.test_case_id IS NULL
              AND tr.triggered_by LIKE 'agent-test:%'
              AND atc.id = NULLIF(split_part(tr.triggered_by, ':', 2), '')::int
             LEFT JOIN projects p ON tr.project_id=p.id
             LEFT JOIN auto_users u ON tr.run_by=u.id
             WHERE 1=1${pf}`;
    const vals = [];
    if (test_case_id) { q += ` AND tr.test_case_id=$${vals.length+1}`; vals.push(test_case_id); }
    if (project_id)   { q += ` AND tr.project_id=$${vals.length+1}`;   vals.push(project_id); }
    if (status)       { q += ` AND tr.status=$${vals.length+1}`;        vals.push(status); }
    if (triggered_by) {
      // "agent" groups all AI-agent runs (stored as 'agent-test:<id>')
      if (triggered_by === "agent") q += ` AND tr.triggered_by LIKE 'agent-test:%'`;
      else { q += ` AND tr.triggered_by=$${vals.length+1}`; vals.push(triggered_by); }
    }
    if (search)       { q += ` AND COALESCE(tc.name, atc.name) ILIKE $${vals.length+1}`;    vals.push(`%${search}%`); }
    const countQ = q.replace(/SELECT tr\.id.*FROM test_runs tr/s, "SELECT COUNT(*) FROM test_runs tr");
    const countR = await pool.query(countQ, vals);
    const total  = parseInt(countR.rows[0].count);
    q += ` ORDER BY tr.created_at DESC LIMIT $${vals.length+1} OFFSET $${vals.length+2}`;
    vals.push(pageSize, offset);
    const r = await pool.query(q, vals);
    if (req.query.page || req.query.limit) {
      res.json({ rows: r.rows, total, page: parseInt(page), pages: Math.ceil(total/pageSize) });
    } else {
      res.json(r.rows);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/runs/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT tr.*, tc.name as test_name, tc.type as test_type, tc.steps as test_steps
      FROM test_runs tr LEFT JOIN test_cases tc ON tr.test_case_id=tc.id
      WHERE tr.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: "Run not found" });
    // Was previously unguarded — anyone authenticated could view any run's full
    // detail (including test steps) just by knowing/guessing the numeric id,
    // regardless of project access. Same check as GET /api/tests/:id.
    const ids = await getAllowedProjectIds(req.user);
    if (ids !== null && !ids.includes(r.rows[0].project_id)) {
      return res.status(403).json({ error: "Access denied to this run" });
    }
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SCREENSHOTS ──────────────────────────────────────────────────────────────
app.get("/api/screenshots/:filename", requireAuth, (req, res) => {
  // ── Path traversal protection ─────────────────────────────────────────
  const safeName = path.basename(req.params.filename); // strip any ../../ traversal
  if (!/^[\w\-]+\.(png|jpg|jpeg|webp)$/i.test(safeName)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const fp = path.join(SCREENSHOTS_PATH, safeName);
  // Double-check resolved path stays within screenshots directory
  if (!fp.startsWith(path.resolve(SCREENSHOTS_PATH))) {
    return res.status(403).json({ error: "Access denied" });
  }
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.sendFile(fp);
});

// ─── LIVE VIEW PAGE (opens in new browser tab) ────────────────────────────────
app.get("/live/:runId", (req, res) => {
  const { runId } = req.params;
  const wsUrl = `ws://${req.headers.host}?runId=${runId}`;
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Live View — Run #${runId}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0f172a; color:#e2e8f0; font-family:'IBM Plex Mono','Courier New',monospace;
           display:flex; flex-direction:column; height:100vh; overflow:hidden; }

    #header { background:#1e293b; border-bottom:1px solid #334155; padding:10px 18px;
              display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }
    #header h1 { font-size:15px; font-weight:700; color:#e2e8f0; }
    #header h1 span { color:#60a5fa; }
    #status-dot { width:10px; height:10px; border-radius:50%; background:#64748b;
                  display:inline-block; margin-right:8px; }
    #status-dot.running { background:#ef4444; animation:pulse 1s infinite; }
    #status-dot.passed  { background:#22d3a0; }
    #status-dot.failed  { background:#ef4444; animation:none; }
    #step-label { font-size:12px; color:#94a3b8; margin-top:3px; }

    #main { display:flex; flex:1; overflow:hidden; }

    #screen-panel { flex:1; display:flex; align-items:center; justify-content:center;
                    background:#0f172a; padding:12px; position:relative; }
    #screen-img { max-width:100%; max-height:100%; border-radius:6px;
                  box-shadow:0 8px 40px rgba(0,0,0,0.6); border:1px solid #334155; }
    #no-screen { color:#475569; text-align:center; }
    #no-screen .icon { font-size:48px; margin-bottom:12px; }
    #no-screen p { font-size:14px; }

    #log-panel { width:320px; border-left:1px solid #1e293b; display:flex;
                 flex-direction:column; background:#0a0f1e; flex-shrink:0; }
    #log-header { padding:10px 14px; border-bottom:1px solid #1e293b;
                  font-size:11px; font-weight:700; color:#475569;
                  text-transform:uppercase; letter-spacing:0.08em; }
    #logs { flex:1; overflow-y:auto; padding:10px; font-size:11px; line-height:1.7; }
    #logs::-webkit-scrollbar { width:4px; }
    #logs::-webkit-scrollbar-track { background:#0a0f1e; }
    #logs::-webkit-scrollbar-thumb { background:#1e293b; border-radius:2px; }

    .log-pass  { color:#22d3a0; }
    .log-fail  { color:#ff6b6b; }
    .log-error { color:#f97316; }
    .log-info  { color:#64748b; }
    .log-time  { color:#334155; margin-right:6px; }

    #footer { background:#1e293b; border-top:1px solid #334155; padding:8px 18px;
              display:flex; align-items:center; justify-content:space-between;
              font-size:11px; color:#475569; flex-shrink:0; }
    #stats { display:flex; gap:16px; }
    .stat { display:flex; align-items:center; gap:5px; }
    .stat-val { font-weight:700; font-size:13px; }
    .green { color:#22d3a0; }
    .red   { color:#ff6b6b; }
    .blue  { color:#60a5fa; }

    #done-banner { display:none; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
      background:rgba(15,23,42,0.92); border:1px solid #334155; border-radius:12px;
      padding:32px 48px; text-align:center; z-index:10; }
    #done-banner.show { display:block; }
    #done-banner h2 { font-size:28px; margin-bottom:8px; }
    #done-banner p  { font-size:14px; color:#64748b; }

    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  </style>
</head>
<body>
  <div id="header">
    <div>
      <h1><span id="status-dot"></span>Live View — Run <span>#${runId}</span></h1>
      <div id="step-label">Connecting...</div>
    </div>
    <div id="stats">
      <div class="stat"><span class="stat-val green" id="stat-passed">0</span> Passed</div>
      <div class="stat"><span class="stat-val red"   id="stat-failed">0</span> Failed</div>
      <div class="stat"><span class="stat-val blue"  id="stat-step">—</span> Step</div>
    </div>
  </div>

  <div id="main">
    <div id="screen-panel">
      <div id="no-screen">
        <div class="icon">🖥️</div>
        <p>Waiting for browser to start...</p>
      </div>
      <img id="screen-img" style="display:none" alt="live screen" />
      <div id="done-banner">
        <h2 id="done-icon">✅</h2>
        <h2 id="done-text">Run Complete</h2>
        <p id="done-sub">You can close this window</p>
      </div>
    </div>

    <div id="log-panel">
      <div id="log-header">📄 Execution Logs</div>
      <div id="logs"></div>
    </div>
  </div>

  <div id="footer">
    <div>Narayana Automation Tool — Live View</div>
    <div id="conn-status">⏳ Connecting...</div>
  </div>

  <script>
    const runId = "${runId}";
    const wsUrl = "${wsUrl}";
    let passed = 0, failed = 0, stepNum = 0;

    const img       = document.getElementById("screen-img");
    const noScreen  = document.getElementById("no-screen");
    const stepLabel = document.getElementById("step-label");
    const logsDiv   = document.getElementById("logs");
    const dot       = document.getElementById("status-dot");
    const connStatus= document.getElementById("conn-status");
    const doneBanner= document.getElementById("done-banner");

    function addLog(level, message, time) {
      // time (when present) is a UTC ISO timestamp — convert to this browser's
      // local time instead of slicing the UTC string verbatim.
      const ts = time ? new Date(time).toTimeString().slice(0,8) : new Date().toTimeString().slice(0,8);
      const div = document.createElement("div");
      div.className = "log-" + (level||"info");
      div.innerHTML = '<span class="log-time">['+ts+']</span>' + escHtml(message);
      logsDiv.appendChild(div);
      logsDiv.scrollTop = logsDiv.scrollHeight;
    }

    function escHtml(s) {
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function connect() {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        connStatus.textContent = "🟢 Connected";
        dot.className = "running";
        addLog("info", "Connected to run #" + runId);
      };

      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);

        if (msg.type === "live_screen") {
          noScreen.style.display = "none";
          img.style.display = "block";
          img.src = "data:image/jpeg;base64," + msg.data;
          stepLabel.textContent = msg.label || "";
          // Extract step number
          const m = (msg.label||"").match(/Step (\\d+)/);
          if (m) {
            stepNum = m[1];
            document.getElementById("stat-step").textContent = stepNum;
          }
        }

        if (msg.type === "log") {
          addLog(msg.level, msg.message, msg.timestamp);
          if (msg.level === "pass") {
            passed++;
            document.getElementById("stat-passed").textContent = passed;
          }
          if (msg.level === "fail") {
            failed++;
            document.getElementById("stat-failed").textContent = failed;
            dot.className = "failed";
          }
        }

        if (msg.type === "done" || msg.type === "status") {
          const status = msg.status || (msg.code === 0 ? "passed" : "failed");
          if (status === "passed" || status === "failed" || status === "error") {
            dot.className = status;
            doneBanner.className = "show";
            document.getElementById("done-icon").textContent = status === "passed" ? "✅" : "❌";
            document.getElementById("done-text").textContent = status === "passed" ? "All Tests Passed!" : "Run Failed";
            document.getElementById("done-sub").textContent =
              passed + " passed, " + failed + " failed — you can close this window";
            connStatus.textContent = "🔴 Run Complete";
          }
        }
      };

      ws.onclose = () => {
        connStatus.textContent = "🔴 Disconnected";
        // Retry connection if run not done
        if (!doneBanner.classList.contains("show")) {
          setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => { connStatus.textContent = "⚠️ Connection error"; };
    }

    connect();
  </script>
</body>
</html>`);
});


// ─── ACCESS REQUESTS ──────────────────────────────────────────────────────────
// Public endpoint — no auth required (user not logged in yet)
app.post("/api/access-requests", async (req, res) => {
  const { org_name, description, admin_name, email, contact, project_name } = req.body;
  if (!org_name?.trim())    return res.status(400).json({ error: "Organisation name is required" });
  if (!admin_name?.trim())  return res.status(400).json({ error: "Admin user name is required" });
  if (!email?.trim())       return res.status(400).json({ error: "Official email is required" });
  if (!contact?.trim())     return res.status(400).json({ error: "Contact number is required" });
  if (!project_name?.trim())return res.status(400).json({ error: "Project name is required" });
  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Please enter a valid email address" });
  try {
    const r = await pool.query(
      `INSERT INTO access_requests (org_name,description,admin_name,email,contact,project_name,status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [org_name.trim(), description?.trim()||null, admin_name.trim(),
       email.trim().toLowerCase(), contact.trim(), project_name.trim()]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin only — list with filters
app.get("/api/access-requests", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { status, search, from_date, to_date } = req.query;
  try {
    let q = `SELECT * FROM access_requests WHERE 1=1`;
    const vals = [];
    if (status)    { q += ` AND status=$${vals.length+1}`;          vals.push(status); }
    if (search)    { q += ` AND (org_name ILIKE $${vals.length+1} OR admin_name ILIKE $${vals.length+1} OR email ILIKE $${vals.length+1})`; vals.push(`%${search}%`); }
    if (from_date) { q += ` AND created_at >= $${vals.length+1}`;   vals.push(from_date); }
    if (to_date)   { q += ` AND created_at <= $${vals.length+1}::date + interval '1 day'`; vals.push(to_date); }
    q += ` ORDER BY created_at DESC`;
    const r = await pool.query(q, vals);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin only — update status/notes
app.put("/api/access-requests/:id", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { status, notes } = req.body;
  const allowed = ["pending","inprogress","done","cancelled"];
  if (status && !allowed.includes(status))
    return res.status(400).json({ error: "Invalid status" });
  try {
    const r = await pool.query(
      `UPDATE access_requests SET status=COALESCE($1,status), notes=COALESCE($2,notes),
       updated_at=NOW() WHERE id=$3 RETURNING *`,
      [status||null, notes!==undefined?notes:null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Request not found" });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── CSS SELECTOR INSPECTOR ───────────────────────────────────────────────────
// Search for inspector.py in multiple possible locations
function findInspectorPath() {
  const candidates = [
    path.join(__dirname, "../runner/inspector.py"),
    path.join(__dirname, "inspector.py"),
    path.join(__dirname, "../inspector.py"),
    path.join(process.cwd(), "runner/inspector.py"),
    path.join(process.cwd(), "inspector.py"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[inspector] Found at: ${p}`);
      return p;
    }
  }
  console.log(`[inspector] Checked: ${candidates.join(", ")}`);
  return null;
}
const inspectorSessions = new Map(); // sessionId -> { status, result, proc }

// ── Start inspector ───────────────────────────────────────────────────────────
// Pending inspector session — extension polls this to find active session
app.get("/api/inspector/pending", requireAuth, (req, res) => {
  const uid = String(req.user.uid);
  for (const [sessionId, s] of inspectorSessions) {
    if ((s.status === 'ready' || s.status === 'activating') && s.userId === uid) {
      return res.json({ sessionId });
    }
  }
  res.json({ sessionId: null });
});

//app.post("/api/inspector/start", requireAuth, async (req, res) => {
  //try {
    //const { start_url } = req.body;
    //const sessionId = `insp_${Date.now()}`;
    //const token = (req.headers.authorization||"").replace("Bearer ","");

    //const INSPECTOR_PATH = findInspectorPath();
    //console.log(`[inspector] PYTHON_CMD: ${PYTHON_CMD}`);
    //console.log(`[inspector] INSPECTOR_PATH: ${INSPECTOR_PATH}`);

    //if (!INSPECTOR_PATH) {
    //  return res.status(500).json({
     //   error: "inspector.py not found. Copy it to your runner/ folder (same folder as runner.py)."
     // });
   // }
	 app.post("/api/inspector/start", requireAuth, async (req, res) => {
	  // Using Chrome extension inspector instead - no browser launch needed
	  const sessionId = `insp_${Date.now()}`;
	  inspectorSessions.set(sessionId, { status: 'activating', result: null, userId: String(req.user.uid) });
	  console.log("[inspector] Chrome extension mode - session:", sessionId, "user:", req.user.uid);
	  res.json({ ok: true, session_id: sessionId, sessionId: sessionId, message: "Using Chrome extension inspector" });
	});


// ── Receive pick result from inspector.py ─────────────────────────────────────
app.post("/api/inspector/:sessionId/result", async (req, res) => {
  const s = inspectorSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error:"Session not found" });
  s.result = req.body;
  s.status = req.body.type; // "ready", "picked", "cancelled", "error"
  broadcast(req.params.sessionId, req.body);
  res.json({ ok:true });
});

// ── Status check — called by inspector.py every 2s to detect if NAT closed session ──
// Returns 200 if session alive, 404 if deleted (user picked/cancelled)
app.get("/api/inspector/:sessionId/status", async (req, res) => {
  const s = inspectorSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error:"Session not found" });
  res.json({ status: s.status });
});

// ── Delete / close inspector ───────────────────────────────────────────────────
// Called by NAT when user picks a selector OR cancels
// This kills the browser process
app.delete("/api/inspector/:sessionId", requireAuth, async (req, res) => {
  const s = inspectorSessions.get(req.params.sessionId);
  if (s?.proc?.pid) {
    try {
      if (process.platform === "win32") {
        // taskkill kills the full process tree (Python + Chromium)
        spawn("taskkill", ["/pid", String(s.proc.pid), "/f", "/t"], { shell:true });
      } else {
        s.proc.kill("SIGTERM");
      }
    } catch(e) {
      console.error("[inspector] kill error:", e.message);
    }
  }
  // Delete session BEFORE proc.on("exit") fires so it doesn't broadcast "closed"
  inspectorSessions.delete(req.params.sessionId);
  res.json({ ok:true });
});

// ─── LIVE SCREEN (streamed screenshot during run) ────────────────────────────
app.post("/api/runs/:id/live-screen", async (req, res) => {
  const { data, label, timestamp } = req.body;
  broadcast(req.params.id, { type:"live_screen", data, label, timestamp });
  // Also forward to suite run WS so suite runner shows live browser screenshots
  try {
    const row = await pool.query("SELECT suite_run_id FROM test_runs WHERE id=$1", [req.params.id]);
    const srId = row.rows[0]?.suite_run_id;
    if (srId) {
      broadcast(String(srId), { type:"live_screen", run_id:+req.params.id, data, label, timestamp });
    }
  } catch(e) { /* non-critical */ }
  res.json({ ok:true });
});

// ─── SCHEDULES ────────────────────────────────────────────────────────────────
app.get("/api/schedules", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    // Check if suite columns exist before joining
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name='schedules' AND column_name='suite_id'
    `);
    const hasSuiteCol = colCheck.rows.length > 0;
    // Build project filter via test_case → project_id
    const pf = ids === null ? "" :
      ids.length === 0 ? " AND 1=0" :
      ` AND (tc.project_id IN (${ids.join(",")}) OR ts_p.project_id IN (${ids.join(",")}))`;

    const q = hasSuiteCol
      ? `SELECT s.*,
               tc.name as test_name, tc.type as test_type,
               ts.name as suite_name, ts.id  as suite_id_val
         FROM schedules s
         LEFT JOIN test_cases  tc ON s.test_case_id = tc.id
         LEFT JOIN test_suites ts ON s.suite_id      = ts.id
         LEFT JOIN test_suites ts_p ON s.suite_id    = ts_p.id
         WHERE 1=1${pf}
         ORDER BY s.created_at DESC`
      : `SELECT s.*,
               tc.name as test_name, tc.type as test_type
         FROM schedules s
         LEFT JOIN test_cases tc ON s.test_case_id = tc.id
         ORDER BY s.created_at DESC`;

    const r = await pool.query(q);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/schedules", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { test_case_id, suite_id, schedule_type, cron_expr, label, browser, notify_email } = req.body;
  try {
    if (!cron.validate(cron_expr)) return res.status(400).json({ error: "Invalid cron expression" });

    // Check which columns exist — handles both old schema (no suite cols) and new schema
    const colCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
       WHERE table_name='schedules'
         AND column_name IN ('suite_id','schedule_type','notify_email')
    `);
    const cols = colCheck.rows.map(r => r.column_name);
    const hasSuiteCols = cols.includes('suite_id');

    let r;
    if (hasSuiteCols) {
      const stype = schedule_type || (suite_id ? "suite" : "test");
      r = await pool.query(
        `INSERT INTO schedules
          (test_case_id, suite_id, schedule_type, cron_expr, label, browser, notify_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [test_case_id||null, suite_id||null, stype, cron_expr, label||null, browser||"chrome", notify_email||null]
      );
    } else {
      // Old schema — only basic columns
      r = await pool.query(
        `INSERT INTO schedules (test_case_id, cron_expr, label, browser)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [test_case_id||null, cron_expr, label||null, browser||"chrome"]
      );
    }
    registerSchedule(r.rows[0]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/schedules/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  const { active } = req.body;
  try {
    const r = await pool.query("UPDATE schedules SET active=$1 WHERE id=$2 RETURNING *", [active, req.params.id]);
    const sc = r.rows[0];
    // Stop existing job
    if (scheduledJobs.has(sc.id)) { scheduledJobs.get(sc.id).stop(); scheduledJobs.delete(sc.id); }
    // Re-register if now active
    if (sc.active) registerSchedule(sc);
    res.json(sc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/schedules/:id", requireAuth, requireRole("admin","lead"), async (req, res) => {
  try { await pool.query("DELETE FROM schedules WHERE id=$1", [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── SUITE HTML REPORT GENERATOR ─────────────────────────────────────────────
async function generateSuiteReport(suiteRunId, suite, tests, testRuns) {
  const now       = new Date();
  const hostname  = os.hostname();
  const platform  = os.platform() === "win32" ? "Windows" : os.platform();

  const total  = testRuns.length;
  const passed = testRuns.filter(r => r.status === "passed").length;
  const failed = testRuns.filter(r => r.status === "failed").length;
  const skipped= total - passed - failed;

  // Calculate elapsed
  const start = testRuns.reduce((min, r) => r.started_at && new Date(r.started_at) < min ? new Date(r.started_at) : min, now);
  const end   = testRuns.reduce((max, r) => r.finished_at && new Date(r.finished_at) > max ? new Date(r.finished_at) : max, new Date(0));
  const elapsedMs  = end - start;
  const elapsed    = elapsedMs > 0 ? `${Math.floor(elapsedMs/3600000)}h ${Math.floor((elapsedMs%3600000)/60000)}m ${Math.floor((elapsedMs%60000)/1000)}s` : "—";
  const fmtDate    = (d) => d && d.getTime() > 0 ? d.toISOString().replace("T"," ").slice(0,23) : "—";

  // Build test case rows
  const testRows = testRuns.map((run, idx) => {
    const tc      = tests.find(t => t.id === run.test_case_id) || {};
    const statusC = run.status === "passed" ? "#00a86b" : run.status === "failed" ? "#e53935" : "#f59e0b";
    const dur     = run.duration_ms ? `${(run.duration_ms/1000).toFixed(2)}s` : "—";

    // FIX: read logs from physical log file instead of DB (async_runner writes to file)
    let logs = [];
    try {
      const logFile = path.join(__dirname, '..', 'runner', 'logs', `run_${run.id}.log`);
      if (fs.existsSync(logFile)) {
        // Same fix as GET /api/runs/:id/logs: strip the trailing \r Python's
        // text-mode write adds on Windows (broke the regex below, every line
        // fell through to "unparsed raw line + blank timestamp"), and wrap the
        // bare HH:MM:SS in a dummy UTC date so it can be timezone-converted
        // for display below instead of shown as raw UTC.
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean).map(l => l.replace(/\r$/, ''));
        logs = lines.map(line => {
          const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\[([A-Z]+)\]\s*(.*)$/);
          if (m) return { timestamp: `1970-01-01T${m[1]}.000Z`, level: m[2].toLowerCase(), message: m[3] };
          return { timestamp: '', level: 'info', message: line };
        });
      }
    } catch(e) { /* log file missing or unreadable — show empty */ }

    // Fallback to DB logs if file not found
    if (logs.length === 0 && Array.isArray(run.logs)) logs = run.logs;
    const logRows = logs.map(l => {
      const col = l.level==="pass"?"#00a86b":l.level==="fail"?"#e53935":l.level==="error"?"#f97316":"#555";
      const icon= l.level==="pass"?"✅":l.level==="fail"?"❌":l.level==="error"?"🔴":"ℹ";
      return `<tr>
        <td style="padding:3px 8px;color:#888;font-size:11px;white-space:nowrap">${l.timestamp ? new Date(l.timestamp).toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata', hour12:false }) : ''}</td>
        <td style="padding:3px 8px;color:${col};font-size:11px">${icon}</td>
        <td style="padding:3px 8px;font-size:12px;color:#333">${(l.message||"").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</td>
      </tr>`;
    }).join("");

    return `
    <tr style="border-bottom:1px solid #e8e8e8;cursor:pointer" onclick="toggle(${idx})">
      <td style="padding:10px 12px">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusC};margin-right:8px"></span>
        <strong style="color:#1a6fc4">TEST CASE:</strong>
        <span style="margin-left:6px">${String(tc.name||run.test_name||run.test_case_id||"").replace(/</g,"&lt;")}</span>
        ${run.retried && run.status==='passed' ? '<span style="margin-left:8px;background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700">🔁 Passed on retry</span>' : ''}
        ${run.retried && run.status==='failed' ? '<span style="margin-left:8px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:700">⚠️ Failed on retry</span>' : ''}
      </td>
      <td style="padding:10px 12px;color:${statusC};font-weight:700;text-transform:uppercase">${run.retried ? (run.status==='passed'?'🔁 PASSED (RETRY)':'FAILED (RETRY)') : (run.status||'unknown').toUpperCase()}</td>
      <td style="padding:10px 12px;color:#555">${dur}</td>
      <td style="padding:10px 12px;color:#888;font-size:12px">${run.steps_passed||0}✅ ${run.steps_failed||0}❌</td>
      <td style="padding:10px 12px;color:#1a6fc4;font-size:12px">▶ Expand</td>
    </tr>
    <tr id="detail-${idx}" style="display:none;background:#fafafa">
      <td colspan="5" style="padding:0 16px 12px">
        ${logs.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;margin-top:6px;font-family:monospace">
          <thead><tr style="background:#f0f0f0">
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#666">Time</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#666">Status</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:#666">Message</th>
          </tr></thead>
          <tbody>${logRows}</tbody>
        </table>` : `<p style="color:#888;font-size:12px;margin:8px 0">No logs available</p>`}
      </td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test Suite Report — ${suite.name}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Segoe UI',Arial,sans-serif; background:#f5f5f5; color:#333; }
  .header { background:#1a2332; color:#fff; padding:24px 32px; }
  .header h1 { font-size:22px; margin-bottom:4px; }
  .header .sub { font-size:13px; color:#94a3b8; }
  .section { background:#fff; margin:16px 32px; border-radius:8px;
             box-shadow:0 1px 4px rgba(0,0,0,0.08); overflow:hidden; }
  .section-title { padding:12px 16px; background:#f8f9fc;
                   border-bottom:1px solid #e2e6ed; font-weight:700;
                   font-size:13px; color:#1a2332; }
  .env-grid { display:grid; grid-template-columns:140px 1fr; gap:6px 0;
              padding:14px 16px; font-size:13px; }
  .env-grid .lbl { color:#888; font-weight:600; }
  .summary { display:flex; gap:0; }
  .stat { flex:1; padding:20px; text-align:center; border-right:1px solid #e2e6ed; }
  .stat:last-child { border-right:none; }
  .stat .num { font-size:32px; font-weight:800; }
  .stat .lbl { font-size:12px; color:#888; margin-top:4px; text-transform:uppercase; letter-spacing:0.05em; }
  .total  .num { color:#1a2332; }
  .passed .num { color:#00a86b; }
  .failed .num { color:#e53935; }
  .skipped .num{ color:#f59e0b; }
  table.cases { width:100%; border-collapse:collapse; }
  table.cases thead th { padding:10px 12px; background:#f0f2f5; font-size:12px;
    text-align:left; color:#666; border-bottom:2px solid #e2e6ed; }
  table.cases tbody tr:hover { background:#f8f9fc; }
  .badge { display:inline-block; padding:2px 10px; border-radius:12px;
           font-size:11px; font-weight:700; }
  .badge.passed { background:#e8f8f0; color:#00a86b; }
  .badge.failed { background:#fce8e8; color:#e53935; }
</style>
<script>
function toggle(idx) {
  const el = document.getElementById("detail-"+idx);
  el.style.display = el.style.display==="none" ? "table-row" : "none";
}
function expandAll() { document.querySelectorAll('[id^="detail-"]').forEach(e=>e.style.display="table-row"); }
function collapseAll() { document.querySelectorAll('[id^="detail-"]').forEach(e=>e.style.display="none"); }
</script>
</head>
<body>

<div class="header">
  <h1>📋 Test Suite Execution Report</h1>
  <div class="sub">Generated: ${now.toISOString().replace("T"," ").slice(0,23)} UTC</div>
</div>

<div class="section">
  <div class="section-title">Execution Environment</div>
  <div class="env-grid">
    <span class="lbl">Host name:</span>    <span>${hostname}</span>
    <span class="lbl">Local OS:</span>     <span>${platform}</span>
    <span class="lbl">Suite:</span>        <span>${suite.name}</span>
    <span class="lbl">Browser:</span>      <span>${testRuns[0]?.browser||"chrome"}</span>
    <span class="lbl">Start:</span>        <span>${fmtDate(start)}</span>
    <span class="lbl">End:</span>          <span>${fmtDate(end)}</span>
    <span class="lbl">Elapsed:</span>      <span>${elapsed}</span>
    <span class="lbl">Suite Run #:</span>  <span>${suiteRunId}</span>
  </div>
</div>

<div class="section">
  <div class="section-title">Summary</div>
  <div class="summary">
    <div class="stat total">
      <div class="num">${total}</div>
      <div class="lbl">Total</div>
    </div>
    <div class="stat passed">
      <div class="num">${passed}</div>
      <div class="lbl">Passed</div>
    </div>
    <div class="stat failed">
      <div class="num">${failed}</div>
      <div class="lbl">Failed</div>
    </div>
    <div class="stat skipped">
      <div class="num">${skipped}</div>
      <div class="lbl">Skipped</div>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
    <span>Test Execution Log — <strong>${suite.name}</strong></span>
    <span>
      <button onclick="expandAll()" style="margin-right:8px;padding:4px 12px;cursor:pointer;
        border:1px solid #ccc;border-radius:4px;font-size:12px;background:#fff">Expand All</button>
      <button onclick="collapseAll()" style="padding:4px 12px;cursor:pointer;
        border:1px solid #ccc;border-radius:4px;font-size:12px;background:#fff">Collapse All</button>
    </span>
  </div>
  <table class="cases">
    <thead><tr>
      <th>Test Case</th>
      <th>Status</th>
      <th>Duration</th>
      <th>Steps</th>
      <th>Logs</th>
    </tr></thead>
    <tbody>${testRows}</tbody>
  </table>
</div>

<div style="text-align:center;padding:20px;font-size:11px;color:#aaa">
  Generated by Narayana Automation Tool (NAT) • Suite Run #${suiteRunId}
</div>
</body>
</html>`;

  return html;
}

// ─── SEND SUITE REPORT EMAIL ──────────────────────────────────────────────────
async function sendReportEmail(toEmail, suiteName, passed, failed, total, htmlReport) {
  try {
    const nodemailer = require("nodemailer");

    const smtpHost   = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort   = parseInt(process.env.SMTP_PORT || "587");
    const smtpSecure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
    const smtpUser   = process.env.SMTP_USER || "";
    const smtpPass   = process.env.SMTP_PASS || "";

    if (!smtpUser || !smtpPass) {
      console.error("[Email] SMTP_USER or SMTP_PASS not set in .env — cannot send email");
      return;
    }

    // For Gmail: use port 465 + secure=true (SSL) OR port 587 + secure=false (STARTTLS)
    // "Unexpected socket close" usually means wrong port/secure combo
    const isGmail = smtpHost.includes("gmail.com");

    const transporter = nodemailer.createTransport(
      isGmail
        ? {
            // Gmail — port 587 STARTTLS (works through hospital firewalls that block 465)
            host:    "smtp.gmail.com",
            port:    587,
            secure:  false,
            family:  4,
            requireTLS: true,
            auth: { user: smtpUser, pass: smtpPass },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 30000,
            greetingTimeout:   15000,
            socketTimeout:     60000,
          }
        : {
            host:   smtpHost,
            port:   smtpPort,
            secure: smtpSecure,
            requireTLS: smtpPort === 587,
            auth: { user: smtpUser, pass: smtpPass },
            tls: { rejectUnauthorized: false },
            connectionTimeout: 30000,
            greetingTimeout:   15000,
            socketTimeout:     60000,
          }
    );

    // Verify connection before sending
    try { await transporter.verify(); }
    catch(verifyErr) {
      console.error("[Email] SMTP connection failed:", verifyErr.message);
      console.error("[Email] Check SMTP_HOST/PORT/USER/PASS in .env");
      throw verifyErr;
    }

    const status  = failed === 0 ? "✅ PASSED" : "❌ FAILED";
    const subject = `[Daiva Health] ${failed === 0 ? "✅ Suite Passed" : "❌ Suite Failed"} — ${suiteName} (${passed}/${total} tests passed)`;
    const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;
    const now      = new Date().toLocaleString("en-IN", { dateStyle:"long", timeStyle:"short" });
    const statusColor  = failed === 0 ? "#00a86b" : "#e53935";
    const statusBg     = failed === 0 ? "#e6f7f1" : "#fdecea";
    const statusBorder = failed === 0 ? "#a7f3d0" : "#fca5a5";
    const statusIcon   = failed === 0 ? "✅" : "❌";
    const statusLabel  = failed === 0 ? "ALL TESTS PASSED" : "SOME TESTS FAILED";

    const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ATHMA Suite Run Report</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Segoe UI',Arial,sans-serif;">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f2f5;padding:32px 0;">
    <tr><td align="center">

      <!-- Card -->
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.08);overflow:hidden;">

        <!-- Header banner -->
        <tr>
          <td style="background:#8B0000;padding:24px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:11px;color:#ffcccc;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:4px;">AI-Powered Test Automation</div>
                  <div style="font-size:22px;font-weight:700;color:#ffffff;">Daiva Health — Test Report</div>
                </td>
                <td align="right">
                  <div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:8px 16px;display:inline-block;">
                    <div style="font-size:11px;color:#ffcccc;margin-bottom:2px;">Run Date</div>
                    <div style="font-size:13px;font-weight:600;color:#fff;">${now}</div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Status banner -->
        <tr>
          <td style="background:${statusBg};border-bottom:3px solid ${statusBorder};padding:20px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="font-size:28px;margin-bottom:4px;">${statusIcon}</div>
                  <div style="font-size:20px;font-weight:800;color:${statusColor};">${statusLabel}</div>
                  <div style="font-size:14px;color:#4a5568;margin-top:4px;">Suite: <b>${suiteName}</b></div>
                </td>
                <td align="right">
                  <div style="font-size:42px;font-weight:800;color:${statusColor};line-height:1;">${passRate}%</div>
                  <div style="font-size:12px;color:#8a96a8;margin-top:2px;">Pass Rate</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Body -->
        <td style="padding:32px;">

          <!-- Greeting -->
          <p style="font-size:15px;color:#1a2332;margin:0 0 8px 0;">Dear Sir / Madam,</p>
          <p style="font-size:14px;color:#4a5568;margin:0 0 24px 0;line-height:1.7;">
            This is an <b>auto-generated notification</b> from <b>Daiva Health — AI-Powered Test Automation</b>.
            The following suite run has been completed. Please find the summary below.
          </p>

          <!-- Stats cards -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
            <tr>
              <td width="30%" style="padding-right:8px;">
                <div style="background:#e3f0fb;border:1px solid #bcd6f5;border-radius:8px;padding:16px;text-align:center;">
                  <div style="font-size:32px;font-weight:800;color:#1a6fc4;">${total}</div>
                  <div style="font-size:12px;font-weight:600;color:#1a6fc4;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">Total Tests</div>
                </div>
              </td>
              <td width="35%" style="padding-right:8px;">
                <div style="background:#e6f7f1;border:1px solid #a7f3d0;border-radius:8px;padding:16px;text-align:center;">
                  <div style="font-size:32px;font-weight:800;color:#00a86b;">${passed}</div>
                  <div style="font-size:12px;font-weight:600;color:#00a86b;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">✓ Passed</div>
                </div>
              </td>
              <td width="35%">
                <div style="background:${failed > 0 ? "#fdecea" : "#f8f9fc"};border:1px solid ${failed > 0 ? "#fca5a5" : "#e2e6ed"};border-radius:8px;padding:16px;text-align:center;">
                  <div style="font-size:32px;font-weight:800;color:${failed > 0 ? "#e53935" : "#8a96a8"};">${failed}</div>
                  <div style="font-size:12px;font-weight:600;color:${failed > 0 ? "#e53935" : "#8a96a8"};text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">${failed > 0 ? "✗ Failed" : "✓ None Failed"}</div>
                </div>
              </td>
            </tr>
          </table>

          <!-- Progress bar -->
          <div style="margin-bottom:24px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
              <span style="font-size:12px;color:#4a5568;font-weight:600;">Pass Rate</span>
              <span style="font-size:12px;color:${statusColor};font-weight:700;">${passRate}%</span>
            </div>
            <div style="background:#f0f2f5;border-radius:20px;height:10px;overflow:hidden;">
              <div style="background:${statusColor};width:${passRate}%;height:100%;border-radius:20px;"></div>
            </div>
          </div>

          <!-- Details table -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e6ed;border-radius:8px;overflow:hidden;margin-bottom:24px;">
            <tr style="background:#f8f9fc;">
              <th style="padding:10px 16px;font-size:12px;font-weight:700;color:#4a5568;text-align:left;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #e2e6ed;">Detail</th>
              <th style="padding:10px 16px;font-size:12px;font-weight:700;color:#4a5568;text-align:left;text-transform:uppercase;letter-spacing:0.06em;border-bottom:1px solid #e2e6ed;">Value</th>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;border-bottom:1px solid #f0f2f5;">Suite Name</td>
              <td style="padding:10px 16px;font-size:13px;color:#1a2332;font-weight:600;border-bottom:1px solid #f0f2f5;">${suiteName}</td>
            </tr>
            <tr style="background:#f8f9fc;">
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;border-bottom:1px solid #f0f2f5;">Overall Status</td>
              <td style="padding:10px 16px;border-bottom:1px solid #f0f2f5;">
                <span style="background:${statusBg};color:${statusColor};padding:3px 12px;border-radius:20px;font-size:12px;font-weight:700;">${failed === 0 ? "PASSED" : "FAILED"}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;border-bottom:1px solid #f0f2f5;">Total Tests</td>
              <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#1a6fc4;border-bottom:1px solid #f0f2f5;">${total}</td>
            </tr>
            <tr style="background:#f8f9fc;">
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;border-bottom:1px solid #f0f2f5;">Tests Passed</td>
              <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#00a86b;border-bottom:1px solid #f0f2f5;">${passed} of ${total}</td>
            </tr>
            <tr>
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;border-bottom:1px solid #f0f2f5;">Tests Failed</td>
              <td style="padding:10px 16px;font-size:13px;font-weight:700;color:${failed > 0 ? "#e53935" : "#8a96a8"};border-bottom:1px solid #f0f2f5;">${failed}</td>
            </tr>
            <tr style="background:#f8f9fc;">
              <td style="padding:10px 16px;font-size:13px;color:#8a96a8;">Run Completed At</td>
              <td style="padding:10px 16px;font-size:13px;color:#1a2332;font-weight:600;">${now}</td>
            </tr>
          </table>

          <!-- Attachment note -->
          <div style="background:#f0f7ff;border:1px solid #bcd6f5;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#1a6fc4;font-weight:700;margin-bottom:4px;">📎 Detailed HTML Report Attached</div>
            <div style="font-size:12px;color:#4a5568;line-height:1.6;">
              A detailed HTML report with individual test results, step-by-step logs,
              screenshots and failure reasons is attached to this email.
              Open the <b>.html</b> attachment in any browser to view the full report.
            </div>
          </div>

          <!-- Action note -->
          ${failed > 0 ? `
          <div style="background:#fff8e6;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#92400e;font-weight:700;margin-bottom:4px;">⚠️ Action Required</div>
            <div style="font-size:12px;color:#4a5568;line-height:1.6;">
              <b>${failed} test(s) failed</b> in this suite run. Please review the attached report
              and the ATHMA Suite Runner for failure details and screenshots.
              Kindly investigate the failing tests at the earliest.
            </div>
          </div>` : `
          <div style="background:#e6f7f1;border:1px solid #a7f3d0;border-radius:8px;padding:14px 16px;margin-bottom:24px;">
            <div style="font-size:13px;color:#065f46;font-weight:700;margin-bottom:4px;">✅ All Tests Passed</div>
            <div style="font-size:12px;color:#4a5568;line-height:1.6;">
              All <b>${total} test(s)</b> completed successfully. No action required.
              The full detailed report is attached for your records.
            </div>
          </div>`}

          <!-- Closing -->
          <p style="font-size:13px;color:#4a5568;line-height:1.7;margin:0 0 4px 0;">Thank you for using Daiva Health for your test automation needs.</p>
          <p style="font-size:13px;color:#4a5568;margin:0 0 24px 0;">Regards,<br/><b>Daiva Health Automation System</b><br/><span style="color:#8a96a8;font-size:12px;">Daiva Health — Quality Assurance Team</span></p>

        </td>

        <!-- Footer -->
        <tr>
          <td style="background:#f8f9fc;border-top:1px solid #e2e6ed;padding:16px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="font-size:11px;color:#8a96a8;">
                  This is an auto-generated email from <b>Daiva Health — AI-Powered Test Automation</b>.
                  Please do not reply to this email.
                </td>
                <td align="right" style="font-size:11px;color:#8a96a8;white-space:nowrap;">
                  &copy; ${new Date().getFullYear()} Daiva Health. All rights reserved.
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>
      <!-- End Card -->

    </td></tr>
  </table>
  <!-- End Wrapper -->

</body>
</html>`;

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER || "nat@narayanahealth.org",
      to:      toEmail,
      subject,
      text:    `Dear Sir / Madam,\n\nThis is an auto-generated notification from Daiva Health — AI-Powered Test Automation.\n\nSuite Run Complete: ${suiteName}\n\nStatus  : ${failed === 0 ? "PASSED" : "FAILED"}\nTotal   : ${total}\nPassed  : ${passed}\nFailed  : ${failed}\nPass Rate: ${passRate}%\nDate    : ${now}\n\nA detailed HTML report is attached. Open it in any browser for full results.\n\nRegards,\nDaiva Health Automation System\nDaiva Health — Quality Assurance Team\n\nNote: This is an auto-generated email. Please do not reply.`,
      html:    htmlBody,
      attachments: [{
        filename:    `DaivaHealth-Report-${suiteName.replace(/[^a-z0-9]/gi, "_")}-${Date.now()}.html`,
        content:     htmlReport,
        contentType: "text/html",
      }],
    });

    console.log(`[Email] Report sent to ${toEmail} for suite "${suiteName}"`);
  } catch(err) {
    console.error(`[Email] Failed to send report to ${toEmail}:`, err.message);
  }
}


// ── Embed saved DB connection credentials directly into steps ─────────────────
// This avoids auth issues when runner calls back to the API during scheduled runs
async function embedDbConnections(steps) {
  if (!steps || !steps.length) return steps;
  const result = [];
  for (const step of steps) {
    const isDbStep = step.action === "db_validate" || step.action === "db_extract_multi";
    if (isDbStep) {
      console.log(`[embedDbConnections] db step seen — action=${step.action} conn_name=${step.db_config?.conn_name||"(none)"} conn_mode=${step.db_config?.conn_mode||"(unset)"} mode=${step.db_config?.mode||"(unset)"} host=${step.db_config?.host||"(none)"}`);
    }
    // Treat the step as referring to a saved connection whenever a conn_name is present
    // and the mode wasn't explicitly set to "manual" — the frontend defaults its toggle
    // to "Saved Connection" visually without necessarily persisting conn_mode:"saved" onto
    // the step, so requiring an exact "saved" match here silently skipped real saved-connection
    // steps whose db_config never got an explicit conn_mode key written to it.
    const usesSaved = isDbStep && step.db_config?.conn_name &&
      step.db_config?.conn_mode !== "manual" && step.db_config?.mode !== "manual";
    if (usesSaved) {
      try {
        const r = await pool.query(
          "SELECT * FROM db_connections WHERE lower(name)=lower($1)",
          [step.db_config.conn_name]
        );
        if (r.rows[0]) {
          const c = r.rows[0];
          // password_enc is stored encrypted (see /api/db-connections POST) — must be
          // decrypted the same way the "Test Connection" endpoint does, or the runner
          // gets handed ciphertext instead of the real password.
          const decryptedPassword = typeof decryptValue === 'function' ? decryptValue(c.password_enc) : c.password_enc;
          console.log(`[embedDbConnections] Resolved '${step.db_config.conn_name}' -> ${c.host}:${c.port}/${c.database} (user=${c.username}, password=${decryptedPassword ? "set" : "EMPTY"})`);
          result.push({
            ...step,
            db_config: {
              ...step.db_config,
              conn_mode: "manual",    // switch to manual so runner uses embedded creds
              mode:      "manual",    // keep both keys for compatibility
              db_type:  c.db_type,
              host:     c.host,
              port:     String(c.port),
              database: c.database,
              user:     c.username,
              password: decryptedPassword,
            }
          });
          continue;
        } else {
          console.error(`[embedDbConnections] No saved connection found named '${step.db_config.conn_name}'`);
        }
      } catch(e) {
        console.error(`[embedDbConnections] Could not embed '${step.db_config.conn_name}':`, e.message);
      }
    }
    result.push(step);
  }
  return result;
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
const scheduledJobs = new Map();

function registerSchedule(schedule) {
  if (!schedule.active) return;
  // Multi-server deployments: only the designated scheduler instance actually
  // registers cron jobs. Without this, every server sharing the DB would load
  // and fire the same schedule independently — duplicating every scheduled
  // run once per server. Covers startup load AND live create/reactivate,
  // since both funnel through this same function.
  if (!SCHEDULER_ENABLED) {
    console.log(`⏰ Schedule #${schedule.id} — not registering (schedules disabled on this instance)`);
    return;
  }

  const runnerToken = process.env.RUNNER_SECRET || "nat-internal-runner-2024"; // internal token for scheduled runs

  const job = cron.schedule(schedule.cron_expr, async () => {
    console.log(`⏰ Schedule #${schedule.id} triggered — type: ${schedule.schedule_type||"test"}`);
    await pool.query("UPDATE schedules SET last_run_at=NOW() WHERE id=$1", [schedule.id]);

    try {
      if ((schedule.schedule_type||"test") === "suite") {
        // ── Run entire suite ──────────────────────────────────────────────
        if (!schedule.suite_id) { console.error("Suite schedule missing suite_id"); return; }

        const suiteRes = await pool.query("SELECT * FROM test_suites WHERE id=$1 AND active=TRUE", [schedule.suite_id]);
        if (!suiteRes.rows[0]) { console.error(`Suite ${schedule.suite_id} not found`); return; }
        const suite = suiteRes.rows[0];

        const testsRes = await (async () => {
          const fc = typeof suite.filter_config === 'string' ? JSON.parse(suite.filter_config || '{}') : (suite.filter_config || {});
          const ids = fc.selected_case_ids || [];
          if (!ids.length) return { rows: [] };
          return pool.query(
            "SELECT * FROM test_cases WHERE id = ANY($1) AND active=TRUE ORDER BY array_position($1, id)",
            [ids]
          );
        })();
        if (!testsRes.rows.length) { console.log(`Suite "${suite.name}" has no active tests`); return; }

        // Create suite_run record
        const suiteRun = await pool.query(
          "INSERT INTO suite_runs (suite_id,project_id,status,browser,triggered_by,total_tests) VALUES ($1,$2,'running',$3,'schedule',$4) RETURNING *",
          [suite.id, suite.project_id, schedule.browser||"chrome", testsRes.rows.length]
        );
        const suiteRunId = suiteRun.rows[0].id;

        console.log(`⏰ Running suite "${suite.name}" (${testsRes.rows.length} tests) — suite_run #${suiteRunId}`);

        // Spawn each test sequentially
        for (const test of testsRes.rows) {
          try {
            const run = await pool.query(
              "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,suite_run_id,origin_server) VALUES ($1,$2,'queued',$3,'schedule',$4,$5) RETURNING *",
              [test.id, test.project_id, schedule.browser||test.browser, suiteRunId, INSTANCE_ID]
            );
            const fullTest = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [test.id]);
            const embeddedSteps = await embedDbConnections(test.steps||[]);
            const config = {
              type: test.type, steps: embeddedSteps,
              browser: schedule.browser||test.browser,
              base_url: test.base_url||"",
              variables: fullTest.rows[0]?.variables||[],
              runner_token: runnerToken,
              test_case_id: test.id,
              api_config: test.api_config || null,
            };
            // Use a config FILE (not inline arg) — Windows caps command lines at
            // ~32K chars, which silently breaks tests with many steps.
            const schedSuiteCfg = path.join(LOGS_PATH, `config_${run.rows[0].id}.json`);
            fs.writeFileSync(schedSuiteCfg, JSON.stringify(config), 'utf8');
            await new Promise((resolve) => {
              const proc = spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(run.rows[0].id), "--config-file", schedSuiteCfg], {
                detached: false, stdio: "ignore"
              });
              proc.on("exit", resolve);
            });
          } catch(e) { console.error(`Suite schedule: test ${test.id} error:`, e.message); }
        }

        // Update suite_run final status
        const results = await pool.query("SELECT status FROM test_runs WHERE suite_run_id=$1", [suiteRunId]);
        const passed  = results.rows.filter(r=>r.status==="passed").length;
        const failed  = results.rows.filter(r=>r.status==="failed").length;
        const finalSt = failed===0 ? "passed" : "failed";
        await pool.query("UPDATE suite_runs SET status=$1,passed_tests=$2,failed_tests=$3,completed_at=NOW() WHERE id=$4",
          [finalSt, passed, failed, suiteRunId]);
        console.log(`⏰ Suite "${suite.name}" done: ${passed} passed, ${failed} failed`);

        // ── Retry failed tests (mirrors manual suite runner SUITE_RETRY_FAILED logic) ──
        if (SUITE_RETRY_FAILED > 0 && failed > 0) {
          const failedRuns2 = await pool.query(
            `SELECT tr.id, tr.test_case_id, tc.name, tc.type, tc.browser, tc.base_url, tc.steps, tc.api_config
             FROM test_runs tr
             LEFT JOIN test_cases tc ON tc.id = tr.test_case_id
             WHERE tr.suite_run_id=$1 AND tr.status IN ('failed','error')`,
            [suiteRunId]
          );
          if (failedRuns2.rows.length > 0) {
            console.log(`⏰ [Schedule] Retrying ${failedRuns2.rows.length} failed test(s) in suite "${suite.name}"`);
            for (const failedRun of failedRuns2.rows) {
              try {
                const fullTest2 = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [failedRun.test_case_id]);
                const embeddedSteps2 = await embedDbConnections(failedRun.steps||[]);
                const retryConfig = {
                  type: failedRun.type, steps: embeddedSteps2,
                  browser: schedule.browser||failedRun.browser||"chrome",
                  base_url: failedRun.base_url||"",
                  variables: fullTest2.rows[0]?.variables||[],
                  runner_token: runnerToken,
                  test_case_id: failedRun.test_case_id,
                  api_config: failedRun.api_config || null,
                };
                await pool.query(
                  "UPDATE test_runs SET status='running', retried=true, started_at=NOW(), finished_at=NULL, logs='[]', steps_passed=0, steps_failed=0, duration_ms=NULL WHERE id=$1",
                  [failedRun.id]
                );
                // Config file instead of inline arg (Windows ~32K command-line cap)
                const schedRetryCfg = path.join(LOGS_PATH, `config_${failedRun.id}.json`);
                fs.writeFileSync(schedRetryCfg, JSON.stringify(retryConfig), 'utf8');
                await new Promise((resolve) => {
                  const proc = spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(failedRun.id), "--config-file", schedRetryCfg], {
                    detached: false, stdio: "ignore"
                  });
                  proc.on("exit", resolve);
                  proc.on("error", resolve);
                });
                console.log(`⏰ [Schedule] Retry done: ${failedRun.name}`);
              } catch(retryErr) { console.error(`Suite schedule retry error:`, retryErr.message); }
            }
            // Recalculate final counts after retry
            const results2 = await pool.query("SELECT status FROM test_runs WHERE suite_run_id=$1", [suiteRunId]);
            const passed2  = results2.rows.filter(r=>r.status==="passed").length;
            const failed2  = results2.rows.filter(r=>r.status==="failed").length;
            const finalSt2 = failed2===0 ? "passed" : "failed";
            await pool.query("UPDATE suite_runs SET status=$1,passed_tests=$2,failed_tests=$3 WHERE id=$4",
              [finalSt2, passed2, failed2, suiteRunId]);
            console.log(`⏰ Suite "${suite.name}" after retry: ${passed2} passed, ${failed2} failed`);
          }
        }

        // ── Generate HTML report + email if configured ─────────────────
        try {
          // Fetch full test_runs with logs for report
          const runDetails = await pool.query(
            `SELECT tr.*, tc.name as test_name
               FROM test_runs tr
               LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
              WHERE tr.suite_run_id = $1
              ORDER BY tr.id`,
            [suiteRunId]
          );

          const htmlReport = await generateSuiteReport(
            suiteRunId, suite, testsRes.rows, runDetails.rows
          );

          // Save report to disk
          const reportsDir = path.join(__dirname, "../runner/reports");
          if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
          const reportFile = path.join(reportsDir, `suite-run-${suiteRunId}.html`);
          fs.writeFileSync(reportFile, htmlReport, "utf-8");
          console.log(`[Report] Saved: ${reportFile}`);

          // Send email if notify_email is set on this schedule
          if (schedule.notify_email && schedule.notify_email.trim()) {
            await sendReportEmail(
              schedule.notify_email.trim(),
              suite.name, passed, failed, testsRes.rows.length,
              htmlReport
            );
          }
        } catch(reportErr) {
          console.error("[Report] Error generating/sending report:", reportErr.message);
        }

      } else {
        // ── Run single test case ──────────────────────────────────────────
        const tc = await pool.query("SELECT * FROM test_cases WHERE id=$1 AND active=TRUE", [schedule.test_case_id]);
        if (!tc.rows[0]) { console.error(`Test case ${schedule.test_case_id} not found`); return; }
        const test = tc.rows[0];
        const run  = await pool.query(
          "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,origin_server) VALUES ($1,$2,'queued',$3,'schedule',$4) RETURNING *",
          [test.id, test.project_id, schedule.browser||test.browser, INSTANCE_ID]
        );
        const fullTest = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [test.id]);
        const embeddedSteps = await embedDbConnections(test.steps||[]);
        const config = {
          type: test.type, steps: embeddedSteps,
          browser: schedule.browser||test.browser,
          base_url: test.base_url||"",
          variables: fullTest.rows[0]?.variables||[],
          runner_token: runnerToken,
          test_case_id: test.id,
          api_config: test.api_config || null,
        };
        // Config file instead of inline arg (Windows ~32K command-line cap)
        const schedCfg = path.join(LOGS_PATH, `config_${run.rows[0].id}.json`);
        fs.writeFileSync(schedCfg, JSON.stringify(config), 'utf8');
        spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(run.rows[0].id), "--config-file", schedCfg], {
          detached: false, stdio: "ignore"
        });
        console.log(`⏰ Scheduled run triggered for test: ${test.name}`);
      }
    } catch(e) { console.error("Scheduled run error:", e.message); }
  });

  scheduledJobs.set(schedule.id, job);
}

// Load all active schedules on startup
async function loadSchedules() {
  try {
    const r = await pool.query("SELECT * FROM schedules WHERE active=TRUE");
    r.rows.forEach(registerSchedule);
    console.log(`⏰ Loaded ${r.rows.length} scheduled jobs`);
  } catch (e) { console.error("Failed to load schedules:", e.message); }
}

// ─── REPORTS / DASHBOARD ──────────────────────────────────────────────────────

// ─── DASHBOARD DATA ──────────────────────────────────────────────────────────
app.get("/api/dashboard", requireAuth, async (req, res) => {
  const { from, to } = req.query;
  // Cache dashboard for non-date-range queries
  const cacheKey = `dashboard:${req.user.uid}:${from||""}:${to||""}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);
  const fromDate = from ? `'${from}'::date` : "NOW() - INTERVAL '1 day'";
  const toDate   = to   ? `'${to}'::date + INTERVAL '1 day'` : "NOW()";

  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "project_id");   // for test_cases
    const pfR = projectFilterCol(ids, "tr.project_id"); // for test_runs joins
    const pfP = ids === null ? "" :                     // for projects table
      ids.length === 0 ? " AND p.id IN (-1)" :
      ` AND p.id IN (${ids.join(",")})`;

    const [
      scriptsByType,
      scriptsByProject,
      passRateByProject,
      runsByProject,
      scriptHistory,
      recentRuns,
      liveQ,
      todayStatsQ,
      scriptDetailQ,
    ] = await Promise.all([

      // Total scripts by type (all time) — filtered by allowed projects
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE 'ai-generated' = ANY(tags))  AS ai_generated,
          COUNT(*) FILTER (WHERE 'recorded'      = ANY(tags))  AS recorded,
          COUNT(*) FILTER (WHERE NOT ('ai-generated' = ANY(tags) OR 'recorded' = ANY(tags))) AS manual,
          COUNT(*) AS total
        FROM test_cases WHERE active=TRUE${pf}
      `),

      // Scripts per project by type (all time)
      pool.query(`
        SELECT p.name as project,
          COUNT(tc.id) FILTER (WHERE 'ai-generated' = ANY(tc.tags)) AS ai_generated,
          COUNT(tc.id) FILTER (WHERE 'recorded'      = ANY(tc.tags)) AS recorded,
          COUNT(tc.id) FILTER (WHERE NOT ('ai-generated' = ANY(tc.tags) OR 'recorded' = ANY(tc.tags))) AS manual,
          COUNT(tc.id) AS total
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id=p.id AND tc.active=TRUE
        WHERE p.active=TRUE${pfP}
        GROUP BY p.id, p.name
        ORDER BY total DESC LIMIT 8
      `),

      // Pass rate per project — filtered by date range
      pool.query(`
        SELECT p.name as project,
          COUNT(tr.id) FILTER (WHERE tr.status='passed') AS passed,
          COUNT(tr.id) AS total
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id=p.id
        LEFT JOIN test_runs tr ON tr.test_case_id=tc.id
          AND tr.created_at >= ${fromDate}
          AND tr.created_at <  ${toDate}
        WHERE p.active=TRUE${pfP}
        GROUP BY p.id, p.name
        HAVING COUNT(tr.id) > 0
        ORDER BY total DESC LIMIT 6
      `),

      // Runs per project today (always today)
      pool.query(`
        SELECT p.name as project,
          COUNT(tr.id) FILTER (WHERE tr.status='passed')  AS passed,
          COUNT(tr.id) FILTER (WHERE tr.status='failed')  AS failed,
          COUNT(tr.id) FILTER (WHERE tr.status NOT IN ('passed','failed')) AS other,
          COUNT(tr.id) AS total
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id=p.id
        LEFT JOIN test_runs tr ON tr.test_case_id=tc.id
          AND tr.created_at >= CURRENT_DATE
          AND tr.created_at < CURRENT_DATE + INTERVAL '1 day'
        WHERE p.active=TRUE${pfP}
        GROUP BY p.id, p.name
        HAVING COUNT(tr.id) > 0
        ORDER BY total DESC LIMIT 6
      `),

      // Script history — new & updated per project — filtered
      pool.query(`
        SELECT p.name as project,
          COUNT(tc.id) FILTER (WHERE tc.created_at >= ${fromDate} AND tc.created_at < ${toDate}) AS new_scripts,
          COUNT(tc.id) FILTER (
            WHERE tc.updated_at >= ${fromDate} AND tc.updated_at < ${toDate}
              AND tc.updated_at > tc.created_at + INTERVAL '1 minute'
          ) AS updated_scripts
        FROM projects p
        LEFT JOIN test_cases tc ON tc.project_id=p.id AND tc.active=TRUE
        WHERE p.active=TRUE${pfP}
        GROUP BY p.id, p.name
        HAVING COUNT(tc.id) > 0
        ORDER BY p.name
      `),

      // Recent runs — filtered by date range
      pool.query(`
        SELECT tr.id, tc.name as test_name, u.username as run_by_name,
          tr.browser, tr.status, tr.duration_ms,
          tr.steps_passed, tr.steps_total, tr.created_at,
          p.name as project_name,
          CASE
            WHEN 'ai-generated' = ANY(tc.tags) THEN 'AI'
            WHEN 'recorded'      = ANY(tc.tags) THEN 'Recorded'
            ELSE 'Manual'
          END AS script_type
        FROM test_runs tr
        LEFT JOIN test_cases tc ON tr.test_case_id=tc.id
        LEFT JOIN projects    p  ON tc.project_id=p.id
        LEFT JOIN auto_users  u  ON tr.run_by=u.id
        WHERE tr.created_at >= ${fromDate}
          AND tr.created_at <  ${toDate}
          AND (${ids === null ? "TRUE" : ids.length === 0 ? "FALSE" : "tr.project_id IN (" + ids.join(",") + ")"}) 
            ORDER BY tr.created_at DESC LIMIT 10
            `),

          // Live running count
          pool.query(
          `SELECT COUNT(*) as running FROM test_runs tr WHERE status='running' ${pfR}`
          ),

          // Today stats
          pool.query(`
          SELECT
          COUNT(*) FILTER (WHERE status='passed') AS passed_today,
          COUNT(*) FILTER (WHERE status='failed') AS failed_today,
          COUNT(*) FILTER (WHERE status NOT IN ('passed','failed','queued')) AS other_today,
          COUNT(*) AS total_today
          FROM test_runs
          WHERE created_at >= CURRENT_DATE
          AND created_at < CURRENT_DATE + INTERVAL '1 day'
          ${ids === null ? "" : ids.length === 0 ? "AND 1=0" : `AND project_id IN (${ids.join(",")})`}
          `),

          // Script history detail (UNION)
          pool.query(`
          SELECT * FROM (
          SELECT tc.name as script_name, p.name as project_name,
          tc.created_at, tc.updated_at,
          'Created' as action,
          tc.created_at as sort_date
          FROM test_cases tc
          LEFT JOIN projects p ON tc.project_id=p.id
          WHERE tc.active=TRUE${pf}
          AND tc.created_at >= ${fromDate}
          AND tc.created_at <  ${toDate}
          UNION ALL
          SELECT tc.name as script_name, p.name as project_name,
          tc.created_at, tc.updated_at,
          'Updated' as action,
          tc.updated_at as sort_date
          FROM test_cases tc
          LEFT JOIN projects p ON tc.project_id=p.id
          WHERE tc.active=TRUE${pf}
          AND tc.updated_at >= ${fromDate}
          AND tc.updated_at <  ${toDate}
          AND tc.updated_at > tc.created_at + INTERVAL '1 minute'
          ) combined
          ORDER BY sort_date DESC
          LIMIT 500
          `),
          ]);

    const st         = scriptsByType.rows[0] || { ai_generated:0, recorded:0, manual:0, total:0 };
    const todayStats  = todayStatsQ.rows[0]   || { passed_today:0, failed_today:0, total_today:0 };

    const dashResult = {
      scripts_by_type:    { ai: +st.ai_generated, recorded: +st.recorded, manual: +st.manual, total: +st.total },
      scripts_by_project: scriptsByProject.rows,
      pass_rate_by_project: passRateByProject.rows.map(r=>({
        project: r.project,
        rate: +r.total > 0 ? Math.round((+r.passed/+r.total)*100) : 0,
        passed: +r.passed, total: +r.total
      })),
      runs_by_project:    runsByProject.rows,
      script_history:     scriptHistory.rows,
      script_history_detail: scriptDetailQ.rows,
      recent_runs:        recentRuns.rows,
      today_runs:         +todayStats.total_today || 0,
      runs_passed_today:  +todayStats.passed_today,
      runs_failed_today:  +todayStats.failed_today,
      running_now:        +liveQ.rows[0].running,
    };
    setCached(cacheKey, dashResult);
    res.json(dashResult);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── LIVE RUNNING SESSIONS ────────────────────────────────────────────────────
// Returns all currently running test_runs with test name, user, project, duration
app.get("/api/runs/live", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "tr.project_id");
    const r = await pool.query(`
      SELECT
        tr.id,
        tc.name          AS test_name,
        COALESCE(p.name, 'Unknown') AS project_name,
        u.username       AS run_by,
        u.full_name      AS run_by_name,
        tr.browser,
        tr.triggered_by,
        tr.suite_run_id,
        sr.name          AS suite_name,
        tr.created_at,
        EXTRACT(EPOCH FROM (NOW() - tr.created_at))::int AS elapsed_seconds
      FROM test_runs tr
      JOIN test_cases tc ON tc.id = tr.test_case_id
      LEFT JOIN projects   p  ON p.id  = tr.project_id
      LEFT JOIN auto_users u ON u.id = tr.run_by
      LEFT JOIN suite_runs sr ON sr.id = tr.suite_run_id
      WHERE tr.status = 'running'
      ${pf}
      ORDER BY tr.created_at ASC
    `);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/reports/summary", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "project_id");
    const pfR = projectFilterCol(ids, "tr.project_id");
    const [tests, runs, passRate, recent] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM test_cases WHERE active=TRUE${pf}`),
      pool.query(`SELECT COUNT(*) FROM test_runs tr WHERE created_at > NOW() - INTERVAL '7 days'${pfR}`),
      pool.query(`SELECT COUNT(*) FILTER(WHERE status='passed') as passed, COUNT(*) as total FROM test_runs tr WHERE created_at > NOW() - INTERVAL '7 days'${pfR}`),
      pool.query(`SELECT status, COUNT(*) FROM test_runs tr WHERE created_at > NOW() - INTERVAL '30 days'${pfR} GROUP BY status`),
    ]);
    const pr = passRate.rows[0];
    res.json({
      total_tests:  +tests.rows[0].count,
      runs_7d:      +runs.rows[0].count,
      pass_rate:    pr.total > 0 ? Math.round((pr.passed / pr.total) * 100) : 0,
      status_breakdown: recent.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/reports/trend", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "project_id");
    const r = await pool.query(`
      SELECT DATE(created_at) as date,
        COUNT(*) FILTER(WHERE status='passed') as passed,
        COUNT(*) FILTER(WHERE status='failed') as failed,
        COUNT(*) as total
      FROM test_runs
      WHERE created_at >= NOW() - INTERVAL '14 days'${pf}
      GROUP BY DATE(created_at)
      ORDER BY date
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ─── PLAYWRIGHT CODEGEN RECORDER ─────────────────────────────────────────────
const recorderSessions = new Map(); // sessionId -> { status, script, proc, outputFile }
// WebSocket support for recorder sessions
wss.on("connection", (ws, req) => {
  const recId = new URL(req.url, "http://localhost").searchParams.get("recorderId");
  if (recId) {
    if (!clients.has("rec_"+recId)) clients.set("rec_"+recId, new Set());
    clients.get("rec_"+recId).add(ws);
    ws.on("close", () => { clients.get("rec_"+recId)?.delete(ws); });
  }
});

function broadcastRecorder(sessionId, data) {
  broadcast("rec_" + sessionId, data);
}

// Start playwright codegen using Python playwright
app.post("/api/recorder/start", requireAuth, async (req, res) => {
  const { start_url } = req.body;
  const sessionId  = `rec_${Date.now()}`;

  // Extension handles recording directly — no Playwright codegen needed
  recorderSessions.set(sessionId, { status: "recording", script: "", proc: null });

  console.log(`[recorder] Session started: ${sessionId} (extension mode)`);
  res.json({ session_id: sessionId });
});

// Stop recording — kill codegen process (closing browser also stops it)
app.post("/api/recorder/:sessionId/stop", requireAuth, async (req, res) => {
  const s = recorderSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: "Session not found" });
  if (s.proc && s.proc.pid) {
    try {
      if (process.platform === "win32") {
        // On Windows, kill entire process tree so browser closes too
        spawn("taskkill", ["/pid", String(s.proc.pid), "/f", "/t"], { shell: true });
      } else {
        s.proc.kill("SIGTERM");
      }
    } catch(e) { console.error("Kill error:", e.message); }
  }
  // Wait for exit handler to fire and read the output file
  await new Promise(r => setTimeout(r, 2000));
  // If exit handler didn't fire, try reading file directly
  if (!s.script && s.outputFile) {
    try {
      if (fs.existsSync(s.outputFile)) {
        s.script = fs.readFileSync(s.outputFile, "utf-8");
        console.log(`[codegen] Read script on stop: ${s.script.length} chars`);
      }
    } catch(e) { console.error("[codegen] Read error:", e.message); }
  }
  s.status = "stopped";
  res.json({ ok: true, script: s.script || "" });
});

// Get script after recording stops
app.get("/api/recorder/:sessionId/script", requireAuth, async (req, res) => {
  const s = recorderSessions.get(req.params.sessionId);
  if (!s) return res.status(404).json({ error: "Not found" });
  res.json({ status: s.status, script: s.script || "" });
});

// Cleanup session
app.delete("/api/recorder/:sessionId", requireAuth, async (req, res) => {
  const s = recorderSessions.get(req.params.sessionId);
  if (s?.proc) { try { s.proc.kill(); } catch {} }
  if (s?.outputFile) { try { fs.unlinkSync(s.outputFile); } catch {} }
  recorderSessions.delete(req.params.sessionId);
  res.json({ ok: true });
});



// ─── CHROME EXTENSION RECORDER API ───────────────────────────────────────────
// Separate from Playwright codegen recorder above
// Extension streams steps here live as user records in Chrome
const extRecorderSessions = new Map();

// Health check endpoint (used by extension popup to verify server is running)
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Extension calls this to create a session
app.post('/api/recorder/ext/start', (req, res) => {
  const { label } = req.body || {};
  const session_id = 'ext_rec_' + Date.now();
  extRecorderSessions.set(session_id, {
    session_id,
    label: label || ('Recording ' + new Date().toLocaleTimeString()),
    steps: [],
    created_at: new Date().toISOString(),
    finished_at: null,
  });
  broadcastAll({ type: 'recorder_started', session_id, label: label || session_id });
  console.log(`[ExtRecorder] Session started: ${session_id}`);
  res.json({ ok: true, session_id });
});

// Extension streams steps one-by-one
app.post('/api/recorder/ext/:session_id/steps', (req, res) => {
  res.json({ ok: true });
  const { session_id } = req.params;
  const { steps } = req.body || {};
  const session = extRecorderSessions.get(session_id);
  if (!session || !steps) return;
  session.steps.push(...steps);
  steps.forEach(step => {
    broadcastAll({ type: 'recorder_step', session_id, step, total: session.steps.length });
  });
});

// Extension calls this when user stops recording
app.post('/api/recorder/ext/:session_id/stop', (req, res) => {
  res.json({ ok: true });
  const { session_id } = req.params;
  const { steps } = req.body || {};
  const session = extRecorderSessions.get(session_id);
  if (!session) return;
  if (steps && steps.length > session.steps.length) session.steps = steps;
  session.finished_at = new Date().toISOString();
  broadcastAll({ type: 'recorder_stopped', session_id, steps: session.steps, total: session.steps.length });
  console.log(`[ExtRecorder] Stopped: ${session_id} — ${session.steps.length} steps`);
});

// Get session data
app.get('/api/recorder/ext/:session_id', (req, res) => {
  const session = extRecorderSessions.get(req.params.session_id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Helper: broadcast to ALL connected WebSocket clients
function broadcastAll(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch(e) {}
    }
  });
}

// ─── SUITE RUNS ───────────────────────────────────────────────────────────────

// Start a suite run — accepts suite_id + optional run_order (user override) + browser
app.post("/api/suite-runs", requireAuth, async (req, res) => {
  const { suite_id, run_order, test_ids, browser, name, notify_email } = req.body;
  if (!suite_id) return res.status(400).json({ error: "suite_id is required" });

  try {
    // Fetch suite info
    const suiteRes = await pool.query(
      "SELECT s.*, p.id as proj_id FROM test_suites s LEFT JOIN projects p ON s.project_id=p.id WHERE s.id=$1",
      [suite_id]
    );
    const suite = suiteRes.rows[0];
    if (!suite) return res.status(404).json({ error: "Suite not found" });

    const fc = typeof suite.filter_config === 'string'
      ? JSON.parse(suite.filter_config || '{}')
      : (suite.filter_config || {});

    // Get test IDs in priority order:
    // 1. run_order from frontend (user changed order for this run)
    // 2. selected_case_ids from suite filter_config (static suite with saved order)
    // 3. test_ids sent from frontend (backward compat / old suites)
    // 4. dynamic query from filter_config conditions
    let finalTestIds = [];

    const suiteTestIds = (fc.selected_case_ids || []).map(Number);

    if (run_order && run_order.length) {
      // User overrode the order in runner UI
      const suiteIdSet = new Set(suiteTestIds);
      finalTestIds = run_order.map(Number).filter(id => suiteIdSet.size === 0 || suiteIdSet.has(id));
    } else if (suiteTestIds.length) {
      // Use suite's stored sorted order
      finalTestIds = suiteTestIds;
    } else if (test_ids && test_ids.length) {
      // Backward compat: frontend sent test_ids directly
      finalTestIds = test_ids.map(Number);
    } else if (fc.conditions && fc.conditions.length) {
      // Dynamic suite — run the query to get test IDs
      const ids = await getAllowedProjectIds(req.user);
      const pf  = projectFilterCol(ids, "tc.project_id");
      let q = `SELECT tc.id FROM test_cases tc WHERE tc.active=TRUE${pf}`;
      const vals = [];
      if (suite.project_id) { q += ` AND tc.project_id=${vals.length+1}`; vals.push(suite.project_id); }
      for (const cond of fc.conditions) {
        const { field, value } = cond;
        if (!field||!value) continue;
        if      (field==="module_id")   { q+=` AND tc.module_id=${vals.length+1}`;  vals.push(value); }
        else if (field==="priority")    { q+=` AND tc.priority=${vals.length+1}`;   vals.push(value); }
        else if (field==="type")        { q+=` AND tc.type=${vals.length+1}`;        vals.push(value); }
        else if (field==="name")        { q+=` AND tc.name ILIKE ${vals.length+1}`; vals.push(`%${value}%`); }
        else if (field==="tags")        { q+=` AND ${vals.length+1}=ANY(tc.tags)`;  vals.push(value); }
      }
      q += " ORDER BY tc.created_at DESC LIMIT 200";
      const dynRes = await pool.query(q, vals);
      finalTestIds = dynRes.rows.map(r => r.id);
    }

    if (!finalTestIds.length) return res.status(400).json({ error: "Suite has no test cases" });

    // Create suite_run record — store run_order only if user changed it from default
    const orderChanged = run_order && run_order.length &&
      JSON.stringify(run_order.map(Number)) !== JSON.stringify(suiteTestIds);

    // Try with run_order column first, fall back if column doesn't exist yet
    let suiteRunId;
    try {
      const srRes = await pool.query(
        `INSERT INTO suite_runs (suite_id, project_id, name, status, browser, total, run_by, started_at, run_order, notify_email)
         VALUES ($1,$2,$3,'running',$4,$5,$6,NOW(),$7,$8) RETURNING id`,
        [suite_id, suite?.proj_id||null, name||suite?.name||"Suite Run",
         browser||"chrome", finalTestIds.length, req.user.uid,
         orderChanged ? JSON.stringify(run_order.map(Number)) : null,
         notify_email||null]
      );
      suiteRunId = srRes.rows[0].id;
    } catch(colErr) {
      // run_order column might not exist yet — insert without it and add column
      console.warn("[suite-runs] run_order column missing, falling back:", colErr.message);
      await pool.query(`ALTER TABLE suite_runs ADD COLUMN IF NOT EXISTS run_order JSONB`).catch(()=>{});
      const srRes2 = await pool.query(
        `INSERT INTO suite_runs (suite_id, project_id, name, status, browser, total, run_by, started_at)
         VALUES ($1,$2,$3,'running',$4,$5,$6,NOW()) RETURNING id`,
        [suite_id, suite?.proj_id||null, name||suite?.name||"Suite Run",
         browser||"chrome", finalTestIds.length, req.user.uid]
      );
      suiteRunId = srRes2.rows[0].id;
    }

    // Create all test_run records immediately (queued)
    const runIds = [];
    for (const testId of finalTestIds) {
      const tc = await pool.query(
        "SELECT id,name,type,browser,base_url,steps,api_config,project_id FROM test_cases WHERE id=$1 AND active=true",
        [testId]
      );
      if (!tc.rows[0]) continue;
      const test = tc.rows[0];
      const run = await pool.query(
        `INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,run_by,suite_run_id,origin_server)
         VALUES ($1,$2,'queued',$3,'suite',$4,$5,$6) RETURNING id`,
        [test.id, test.project_id, browser||test.browser, req.user.uid, suiteRunId, INSTANCE_ID]
      );
      runIds.push({ runId: run.rows[0].id, test });
    }

    res.json({ suite_run_id: suiteRunId, run_ids: runIds.map(r=>r.runId), total: runIds.length });

    // Spawn all runners sequentially (to avoid overloading the machine)
    const runnerToken = process.env.RUNNER_SECRET || "nat-internal-runner-2024"; // always use secret so call_test works
    for (const { runId, test } of runIds) {
      // Check if suite was aborted before starting next test
      if (abortedSuiteRuns.has(suiteRunId)) {
        abortedSuiteRuns.delete(suiteRunId);
        break;
      }
      const fullTest = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [test.id]);
      const isLastTest = runIds[runIds.length - 1].runId === runId;
      const config = {
        type: test.type, steps: await embedDbConnections(test.steps||[]), browser: browser||test.browser||"chrome",
        base_url: test.base_url||"", variables: fullTest.rows[0]?.variables||[],
        runner_token: runnerToken, test_case_id: test.id,
        api_config: test.api_config || null,
        keep_browser: !isLastTest,  // keep browser alive between suite tests, close after last
      };

      // Broadcast test_start so UI can show which test is running
      broadcast(suiteRunId, {
        type: "test_start",
        run_id: runId,
        test_name: test.name,
        test_id: test.id,
        test_type: test.type,
      });

      // Check if suite was aborted before starting this test
      if (abortedSuiteRuns.has(suiteRunId)) {
        console.log(`[Suite ${suiteRunId}] Aborted before test ${runId}`);
        break;
      }

      // Move queued -> running just before spawning (only 1 counts as running at a time)
      await pool.query("UPDATE test_runs SET status='running', started_at=NOW() WHERE id=$1", [runId]);

      // Use a config FILE (not inline arg) — Windows caps command lines at ~32K
      // chars; large tests in a suite silently failed to spawn with inline JSON.
      const suiteCfgPath = path.join(LOGS_PATH, `config_${runId}.json`);
      fs.writeFileSync(suiteCfgPath, JSON.stringify(config), 'utf8');
      await new Promise((resolve) => {
        const proc = spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(runId), "--config-file", suiteCfgPath], {
          detached: false, stdio: ["ignore","pipe","pipe"], windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
        activeRunPids.set(runId, proc.pid);
        proc.on("error", (err) => {
          pool.query("UPDATE test_runs SET status='error' WHERE id=$1", [runId]);
          broadcast(suiteRunId, { type:"test_error", run_id:runId, message:err.message });
          resolve();
        });
        proc.stdout.on("data", d => {
          const msg = d.toString().trim();
          if (msg) broadcast(suiteRunId, { type:"log", run_id:runId, message:msg });
        });
        proc.on("close", async () => {
          activeRunPids.delete(runId);
          // Wrapped in try/catch — a DB hiccup here must never freeze the whole
          // suite forever. resolve() always runs (in finally) so the loop always
          // advances to the next test, even if this bookkeeping fails.
          try {
            // Get final status of this test
            const runRow = await pool.query("SELECT status,steps_passed,steps_total FROM test_runs WHERE id=$1", [runId]);
            const runStatus = runRow.rows[0]?.status || "unknown";
            // Broadcast test_done with status so UI can update the test row
            broadcast(suiteRunId, {
              type: "test_done",
              run_id: runId,
              test_name: test.name,
              status: runStatus,
              steps_passed: runRow.rows[0]?.steps_passed || 0,
              steps_total:  runRow.rows[0]?.steps_total  || 0,
            });
            // Update suite_run totals
            const totals = await pool.query(
              `SELECT COUNT(*) FILTER(WHERE status='passed') as passed,
                      COUNT(*) FILTER(WHERE status='failed' OR status='error') as failed,
                      COUNT(*) FILTER(WHERE status IN ('queued','running')) as pending
               FROM test_runs WHERE suite_run_id=$1`, [suiteRunId]
            );
            const t = totals.rows[0];
            broadcast(suiteRunId, { type:"progress", passed:+t.passed, failed:+t.failed, pending:+t.pending, run_id:runId });
          } catch (closeErr) {
            console.error(`[Suite ${suiteRunId}] close-handler error for run ${runId}: ${closeErr.message}`);
            try {
              await pool.query("UPDATE test_runs SET status='error', finished_at=NOW() WHERE id=$1 AND status='running'", [runId]);
            } catch(e) {}
            broadcast(suiteRunId, { type:"test_done", run_id:runId, test_name:test.name, status:"error", steps_passed:0, steps_total:0 });
          } finally {
            resolve();
          }
        });
      });
    }

    // ── Retry failed tests once ──────────────────────────────────────────────
    if (SUITE_RETRY_FAILED > 0 && !abortedSuiteRuns.has(suiteRunId)) {
      const failedRuns = await pool.query(
        `SELECT tr.id, tr.test_case_id, tc.name, tc.type, tc.browser, tc.base_url, tc.steps, tc.api_config, tc.project_id
         FROM test_runs tr
         LEFT JOIN test_cases tc ON tc.id = tr.test_case_id
         WHERE tr.suite_run_id=$1 AND tr.status IN ('failed','error')`,
        [suiteRunId]
      );
      if (failedRuns.rows.length > 0) {
        broadcast(suiteRunId, {
          type: "log", run_id: null,
          message: `\n↻ Retrying ${failedRuns.rows.length} failed test(s)...\n`
        });
        console.log(`[Suite ${suiteRunId}] Retrying ${failedRuns.rows.length} failed test(s)`);
        for (const failedRun of failedRuns.rows) {
          if (abortedSuiteRuns.has(suiteRunId)) break;
          const fullTest = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [failedRun.test_case_id]);
          const config = {
            type: failedRun.type, steps: await embedDbConnections(failedRun.steps||[]), browser: browser||failedRun.browser||"chrome",
            base_url: failedRun.base_url||"", variables: fullTest.rows[0]?.variables||[],
            runner_token: runnerToken, test_case_id: failedRun.test_case_id,
          };
          // Reset the existing run record for retry
          await pool.query(
            "UPDATE test_runs SET status='running', retried=true, started_at=NOW(), finished_at=NULL, logs='[]', steps_passed=0, steps_failed=0, duration_ms=NULL WHERE id=$1",
            [failedRun.id]
          );
          broadcast(suiteRunId, {
            type: "test_start", run_id: failedRun.id,
            test_name: `[RETRY] ${failedRun.name}`, test_id: failedRun.test_case_id, test_type: failedRun.type
          });
          // Config file instead of inline arg (Windows ~32K command-line cap)
          const retryCfgPath = path.join(LOGS_PATH, `config_${failedRun.id}.json`);
          fs.writeFileSync(retryCfgPath, JSON.stringify(config), 'utf8');
          await new Promise((resolve) => {
            const proc = spawn(PYTHON_CMD, [RUNNER_PATH, "--run-id", String(failedRun.id), "--config-file", retryCfgPath], {
              detached: false, stdio: ["ignore","pipe","pipe"], windowsHide: true,
              env: { ...process.env, PYTHONUNBUFFERED: "1" },
            });
            activeRunPids.set(failedRun.id, proc.pid);
            proc.on("error", (err) => {
              pool.query("UPDATE test_runs SET status='error' WHERE id=$1", [failedRun.id]);
              resolve();
            });
            proc.stdout.on("data", d => {
              const msg = d.toString().trim();
              if (msg) broadcast(suiteRunId, { type:"log", run_id:failedRun.id, message:msg });
            });
            proc.on("close", async () => {
              activeRunPids.delete(failedRun.id);
              try {
                const retryRow = await pool.query("SELECT status,steps_passed,steps_total FROM test_runs WHERE id=$1", [failedRun.id]);
                const retryStatus = retryRow.rows[0]?.status || "unknown";
                broadcast(suiteRunId, {
                  type: "test_done", run_id: failedRun.id,
                  test_name: `[RETRY] ${failedRun.name}`, status: retryStatus,
                  steps_passed: retryRow.rows[0]?.steps_passed || 0,
                  steps_total:  retryRow.rows[0]?.steps_total  || 0,
                });
                const totals = await pool.query(
                  `SELECT COUNT(*) FILTER(WHERE status='passed') as passed,
                          COUNT(*) FILTER(WHERE status='failed' OR status='error') as failed,
                          COUNT(*) FILTER(WHERE status IN ('queued','running')) as pending
                   FROM test_runs WHERE suite_run_id=$1`, [suiteRunId]
                );
                const t = totals.rows[0];
                broadcast(suiteRunId, { type:"progress", passed:+t.passed, failed:+t.failed, pending:+t.pending });
              } catch (closeErr) {
                console.error(`[Suite ${suiteRunId}] retry close-handler error for run ${failedRun.id}: ${closeErr.message}`);
                try {
                  await pool.query("UPDATE test_runs SET status='error', finished_at=NOW() WHERE id=$1 AND status='running'", [failedRun.id]);
                } catch(e) {}
                broadcast(suiteRunId, { type:"test_done", run_id:failedRun.id, test_name:`[RETRY] ${failedRun.name}`, status:"error", steps_passed:0, steps_total:0 });
              } finally {
                resolve();
              }
            });
          });
        }
      }
    }

    // Finalize suite_run status
    const final = await pool.query(
      `SELECT COUNT(*) FILTER(WHERE status='passed') as passed,
              COUNT(*) FILTER(WHERE status='failed' OR status='error') as failed
       FROM test_runs WHERE suite_run_id=$1`, [suiteRunId]
    );
    const f = final.rows[0];
    // If aborted, keep status='aborted' (already set by abort endpoint), else compute
    if (!abortedSuiteRuns.has(suiteRunId)) {
      const finalStatus = +f.failed === 0 ? "passed" : +f.passed === 0 ? "failed" : "partial";
      await pool.query(
        "UPDATE suite_runs SET status=$1, passed=$2, failed=$3, finished_at=NOW() WHERE id=$4",
        [finalStatus, +f.passed, +f.failed, suiteRunId]
      );
      broadcast(suiteRunId, { type:"suite_done", status:finalStatus, passed:+f.passed, failed:+f.failed });
      _skippedSuiteRuns.delete(suiteRunId); // clear so logs reset for next suite run
      _skippedOrgRuns.clear();               // clear org skips so new runs log correctly

      // ── Send notification email if suite has notify_email set ────────────
      try {
        const suiteInfo = await pool.query(
          `SELECT sr.notify_email, s.name as suite_name
           FROM suite_runs sr
           LEFT JOIN test_suites s ON s.id = sr.suite_id
           WHERE sr.id = $1`, [suiteRunId]
        );
        const nr = suiteInfo.rows[0];
        if (nr?.notify_email && nr.notify_email.trim()) {
          const total = +f.passed + +f.failed;
          // Fetch full run details to generate proper HTML report (same as scheduler)
          const runDetails = await pool.query(
            `SELECT tr.*, tc.name as test_name
             FROM test_runs tr
             LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
             WHERE tr.suite_run_id = $1
             ORDER BY tr.id`,
            [suiteRunId]
          );
          const suiteRow = await pool.query(
            `SELECT * FROM test_suites WHERE id = (SELECT suite_id FROM suite_runs WHERE id=$1)`,
            [suiteRunId]
          );
          const htmlReport = await generateSuiteReport(
            suiteRunId,
            suiteRow.rows[0] || { name: nr.suite_name || "Suite" },
            runDetails.rows,
            runDetails.rows
          );
          await sendReportEmail(
            nr.notify_email.trim(),
            nr.suite_name || "Suite",
            +f.passed, +f.failed, total,
            htmlReport
          );
        }
      } catch(emailErr) {
        console.error("[Suite Notify] Email error:", emailErr.message);
      }
    }
    abortedSuiteRuns.delete(suiteRunId); // cleanup

  } catch(err) {
    console.error("Suite run error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Get all suite runs
app.get("/api/suite-runs", requireAuth, async (req, res) => {
  try {
    const ids = await getAllowedProjectIds(req.user);
    const pf  = projectFilterCol(ids, "sr.project_id");
    console.log(`[DEBUG /api/suite-runs] uid=${req.user.uid} id=${req.user.id} role="${req.user.role}" isSuperAdmin=${isSuperAdmin(req.user)} allowedProjectIds=${ids===null ? "null (no filter)" : JSON.stringify(ids)} filterClause="${pf}"`);
    const r = await pool.query(`
      SELECT sr.*,
             s.name as suite_name,
             p.name as project_name,
             COALESCE(sr.total, COUNT(tr.id))                     AS total,
             COUNT(tr.id) FILTER (WHERE tr.status='passed')       AS passed,
             COUNT(tr.id) FILTER (WHERE tr.status IN ('failed','error')) AS failed,
             COUNT(tr.id) FILTER (WHERE tr.status NOT IN ('passed','failed','running','queued')) AS skipped
      FROM suite_runs sr
      LEFT JOIN test_suites s  ON sr.suite_id   = s.id
      LEFT JOIN projects    p  ON sr.project_id = p.id
      LEFT JOIN test_runs   tr ON tr.suite_run_id= sr.id
      WHERE 1=1${pf}
      GROUP BY sr.id, s.name, p.name
      ORDER BY COALESCE(sr.started_at, sr.finished_at) DESC NULLS LAST, sr.id DESC LIMIT 100
    `);
    console.log(`[DEBUG /api/suite-runs] query returned ${r.rows.length} row(s)`);
    // Derive the displayed status LIVE from the same passed/failed counts shown in this
    // row, instead of trusting the stored `status` column. Two reasons: (1) the scheduled-run
    // path only ever wrote "passed"/"failed" and never computed "partial", unlike the manual
    // Suite Runner and CI-CD paths, so a scheduled suite with some passing and some failing
    // tests was always mislabeled "failed"; (2) `status` is written once and can drift out of
    // sync with the passed/failed counts (which are always freshly recomputed here from the
    // current test_runs rows), so two rows with identical counts could show different badges.
    // Deriving both from the same live counts guarantees they can never disagree.
    const LIVE_DERIVABLE = new Set(["passed","failed","partial"]);
    r.rows.forEach(row => {
      if (!LIVE_DERIVABLE.has(row.status)) return; // leave running/queued/aborted/error alone
      const total = parseInt(row.total) || 0;
      if (total === 0) return; // nothing to derive from — keep stored status
      const failed = parseInt(row.failed) || 0;
      const passed = parseInt(row.passed) || 0;
      row.status = failed === 0 ? "passed" : (passed === 0 ? "failed" : "partial");
    });
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get suite run detail with all test runs
app.get("/api/suite-runs/:id", requireAuth, async (req, res) => {
  try {
    const sr = await pool.query(`
      SELECT sr.*, s.name as suite_name, p.name as project_name
      FROM suite_runs sr
      LEFT JOIN test_suites s ON sr.suite_id=s.id
      LEFT JOIN projects p ON sr.project_id=p.id
      WHERE sr.id=$1
    `, [req.params.id]);
    if (!sr.rows[0]) return res.status(404).json({ error: "Not found" });

    const runs = await pool.query(`
      SELECT tr.*, tc.name as test_name, tc.type as test_type
      FROM test_runs tr
      LEFT JOIN test_cases tc ON tr.test_case_id=tc.id
      WHERE tr.suite_run_id=$1
      ORDER BY tr.id
    `, [req.params.id]);

    // Compute accurate counts from actual test_runs
    const counts = runs.rows.reduce((acc, r) => {
      if (r.status === "passed") acc.passed++;
      else if (r.status === "failed") acc.failed++;
      else acc.skipped++;
      acc.total++;
      return acc;
    }, { total:0, passed:0, failed:0, skipped:0 });

    res.json({ ...sr.rows[0], runs: runs.rows, ...counts });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── DB CONNECTIONS ────────────────────────────────────────────────────────────
// ─── ORGANISATION MASTER ─────────────────────────────────────────────────────

app.get("/api/organisations", requireAuth, async (req, res) => {
  try {
    const includeInactive = isSuperAdmin(req.user) && req.query.include_inactive === "true";
    const activeFilter = includeInactive ? "" : " AND o.active=TRUE";

    // superadmin sees all orgs; org-admin sees only their own org
    let orgFilter = "";
    const vals = [];
    if (!isSuperAdmin(req.user) && req.user.org_id) {
      orgFilter = ` AND o.id=$1`;
      vals.push(req.user.org_id);
    }

    const r = await pool.query(`
      SELECT o.*,
        COUNT(DISTINCT CASE WHEN p.active=TRUE THEN op.project_id END) AS project_count,
        COUNT(DISTINCT CASE WHEN u.role != 'superadmin' AND u.id != 1 THEN uo.user_id END) AS user_count
      FROM organisations o
      LEFT JOIN org_projects op ON op.org_id = o.id
      LEFT JOIN projects     p  ON p.id = op.project_id
      LEFT JOIN user_orgs    uo ON uo.org_id = o.id
      LEFT JOIN auto_users   u  ON u.id = uo.user_id
      WHERE 1=1${activeFilter}${orgFilter}
      GROUP BY o.id ORDER BY o.active DESC, o.name
    `, vals);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/organisations", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
  try {
    const r = await pool.query(
      "INSERT INTO organisations (name,description) VALUES ($1,$2) RETURNING *",
      [name.trim(), description||null]
    );
    res.json(r.rows[0]);
  } catch(err) {
    if (err.code === "23505") return res.status(400).json({ error: "Organisation name already exists" });
    res.status(500).json({ error: err.message });
  }
});

// ── Static routes MUST come before :id routes ──
// Get all project->org mappings (for conflict detection in UI)
app.get("/api/organisations/all-project-mappings", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT op.project_id, op.org_id, o.name as org_name
      FROM org_projects op
      JOIN organisations o ON o.id = op.org_id
    `);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get all user->org mappings (for conflict detection in UI)
app.get("/api/organisations/all-user-mappings", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT uo.user_id, uo.org_id, o.name as org_name
      FROM user_orgs uo
      JOIN organisations o ON o.id = uo.org_id
    `);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/organisations/:id", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { name, description, active } = req.body;
  try {
    const r = await pool.query(
      "UPDATE organisations SET name=$1,description=$2,active=$3 WHERE id=$4 RETURNING *",
      [name, description||null, active!==undefined?active:true, req.params.id]
    );
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Toggle org active/inactive
app.patch("/api/organisations/:id/toggle-active", requireAuth, requireRole("superadmin"), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE organisations SET active = NOT active WHERE id=$1 RETURNING id, name, active",
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error:"Organisation not found" });
    res.json(r.rows[0]);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get projects assigned to org
app.get("/api/organisations/:id/projects", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query("SELECT project_id FROM org_projects WHERE org_id=$1", [req.params.id]);
    res.json(r.rows.map(r => r.project_id));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Set projects for org — enforces 1 project : 1 org rule
app.put("/api/organisations/:id/projects", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { project_ids } = req.body;
  const orgId = req.params.id;
  try {
    // Check if any of the selected projects are already mapped to a DIFFERENT org
    if (project_ids?.length) {
      const conflicts = await pool.query(`
        SELECT p.name as project_name, o.name as org_name
        FROM org_projects op
        JOIN projects p ON p.id = op.project_id
        JOIN organisations o ON o.id = op.org_id
        WHERE op.project_id = ANY($1::int[])
          AND op.org_id != $2
      `, [project_ids, orgId]);
      if (conflicts.rows.length > 0) {
        const list = conflicts.rows.map(r => `"${r.project_name}" → ${r.org_name}`).join(", ");
        return res.status(400).json({
          error: `These projects are already assigned to another organisation: ${list}`
        });
      }
    }
    await pool.query("DELETE FROM org_projects WHERE org_id=$1", [orgId]);
    if (project_ids?.length) {
      const vals = project_ids.map((pid,i) => `($1,$${i+2})`).join(",");
      await pool.query(
        `INSERT INTO org_projects (org_id,project_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [orgId, ...project_ids]
      );
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get users assigned to org
app.get("/api/organisations/:id/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT u.id, u.username, u.full_name, u.email, u.role, u.active
      FROM user_orgs uo JOIN auto_users u ON u.id = uo.user_id
      WHERE uo.org_id=$1 AND u.active=TRUE AND u.role != 'superadmin' AND u.id != 1
      ORDER BY u.username
    `, [req.params.id]);
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Set users for org — enforces 1 user : 1 org rule
app.put("/api/organisations/:id/users", requireAuth, requireRole("superadmin"), async (req, res) => {
  const { user_ids } = req.body;
  const orgId = req.params.id;
  try {
    // Check if any of the selected users are already mapped to a DIFFERENT org
    if (user_ids?.length) {
      const conflicts = await pool.query(`
        SELECT u.username, u.full_name, o.name as org_name
        FROM user_orgs uo
        JOIN auto_users u ON u.id = uo.user_id
        JOIN organisations o ON o.id = uo.org_id
        WHERE uo.user_id = ANY($1::int[])
          AND uo.org_id != $2
      `, [user_ids, orgId]);
      if (conflicts.rows.length > 0) {
        const list = conflicts.rows.map(r => `"${r.full_name||r.username}" → ${r.org_name}`).join(", ");
        return res.status(400).json({
          error: `These users are already assigned to another organisation: ${list}`
        });
      }
    }
    await pool.query("DELETE FROM user_orgs WHERE org_id=$1", [orgId]);
    if (user_ids?.length) {
      const vals = user_ids.map((uid,i) => `($1,$${i+2})`).join(",");
      await pool.query(
        `INSERT INTO user_orgs (org_id,user_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [orgId, ...user_ids]
      );
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get orgs for a user (used in UserMaster)
app.get("/api/users/:id/orgs", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const r = await pool.query("SELECT org_id FROM user_orgs WHERE user_id=$1", [req.params.id]);
    res.json(r.rows.map(r => r.org_id));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Set orgs for a user
app.put("/api/users/:id/orgs", requireAuth, requireRole("admin"), async (req, res) => {
  const { org_ids } = req.body;
  try {
    await pool.query("DELETE FROM user_orgs WHERE user_id=$1", [req.params.id]);
    if (org_ids?.length) {
      const vals = org_ids.map((oid,i) => `($1,$${i+2})`).join(",");
      await pool.query(
        `INSERT INTO user_orgs (user_id,org_id) VALUES ${vals} ON CONFLICT DO NOTHING`,
        [req.params.id, ...org_ids]
      );
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DB CONNECTIONS API - WITH COMPLETE ORGANISATION LINKING
// Updated to add proper org_id support with user org restrictions
// ═══════════════════════════════════════════════════════════════════════════

// ─── GET USER'S ORGANISATIONS (for dropdown in frontend) ────────────────────
app.get("/api/user/organisations", requireAuth, async (req, res) => {
  try {
    let query, params;
    
    if (isSuperAdmin(req.user)) {
      // Superadmin sees all active organisations
      query = `
        SELECT id, name, description 
        FROM organisations 
        WHERE active = TRUE 
        ORDER BY name
      `;
      params = [];
    } else {
      // Regular users see only their assigned organisations
      query = `
        SELECT o.id, o.name, o.description 
        FROM organisations o
        JOIN user_orgs uo ON uo.org_id = o.id
        WHERE uo.user_id = $1 AND o.active = TRUE
        ORDER BY o.name
      `;
      params = [req.user.uid];
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("[API] GET /user/organisations error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET ALL DB CONNECTIONS (filtered by user's org) ────────────────────────
app.get("/api/db-connections", requireAuth, async (req, res) => {
  try {
    let query, params;
    
    if (isSuperAdmin(req.user)) {
      // Superadmin sees all connections across all orgs
      query = `
        SELECT 
          dc.*,
          o.name as org_name,
          u.username as created_by_name
        FROM db_connections dc
        LEFT JOIN organisations o ON dc.org_id = o.id
        LEFT JOIN auto_users u ON dc.created_by = u.id
        ORDER BY dc.created_at DESC
      `;
      params = [];
    } else {
      // Regular users see only connections from their organisation
      query = `
        SELECT 
          dc.*,
          o.name as org_name,
          u.username as created_by_name
        FROM db_connections dc
        LEFT JOIN organisations o ON dc.org_id = o.id
        LEFT JOIN auto_users u ON dc.created_by = u.id
        WHERE dc.org_id = $1
        ORDER BY dc.created_at DESC
      `;
      params = [req.user.org_id];
    }
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("[API] GET /db-connections error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE DB CONNECTION (with org assignment) ─────────────────────────────
app.post("/api/db-connections", requireAuth, requireRole("admin","lead","superadmin"), async (req, res) => {
  const { name, db_type, host, port, database, username, password, description, org_id } = req.body;
  
  // Validation
  if (!name || !host || !database || !username) {
    return res.status(400).json({ error: "Missing required fields: name, host, database, username" });
  }
  
  // Validate org_id is provided
  if (!org_id) {
    return res.status(400).json({ error: "Organisation must be selected" });
  }
  
  try {
    // For non-superadmins, verify they're creating connection for their own org
    if (!isSuperAdmin(req.user)) {
      const userOrgCheck = await pool.query(
        "SELECT 1 FROM user_orgs WHERE user_id = $1 AND org_id = $2",
        [req.user.uid, org_id]
      );
      
      if (userOrgCheck.rows.length === 0) {
        return res.status(403).json({ 
          error: "You can only create DB connections for organisations you belong to" 
        });
      }
    }
    
    // Verify the organisation exists and is active
    const orgCheck = await pool.query(
      "SELECT id, name FROM organisations WHERE id = $1 AND active = TRUE",
      [org_id]
    );
    
    if (orgCheck.rows.length === 0) {
      return res.status(400).json({ error: "Invalid or inactive organisation" });
    }
    
    // Use password encryption if encryptValue function exists, otherwise store as-is
    const storedPassword = typeof encryptValue === 'function' ? encryptValue(password || "") : (password || "");
    
    // Insert connection with org_id
    const result = await pool.query(`
      INSERT INTO db_connections 
        (name, db_type, host, port, database, username, password_enc, description, org_id, created_by, created_at)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, name, db_type, host, port, database, username, description, org_id, created_at
    `, [
      name, 
      db_type || "postgresql", 
      host, 
      port || 5432, 
      database, 
      username, 
      storedPassword, 
      description || "", 
      org_id, 
      req.user.uid
    ]);
    
    console.log(`[DB Connection] Created: ${name} for org_id=${org_id} by user_id=${req.user.uid}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[API] POST /db-connections error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── UPDATE DB CONNECTION (with org check) ──────────────────────────────────
app.put("/api/db-connections/:id", requireAuth, requireRole("admin","lead","superadmin"), async (req, res) => {
  const { name, db_type, host, port, database, username, password, description, org_id } = req.body;
  const { id } = req.params;
  
  try {
    // First, verify the connection exists and user has access
    let existingConn;
    if (isSuperAdmin(req.user)) {
      const result = await pool.query("SELECT * FROM db_connections WHERE id = $1", [id]);
      existingConn = result.rows[0];
    } else {
      // Regular admins can only edit connections in their org
      const result = await pool.query(
        "SELECT * FROM db_connections WHERE id = $1 AND org_id = $2",
        [id, req.user.org_id]
      );
      existingConn = result.rows[0];
    }
    
    if (!existingConn) {
      return res.status(404).json({ error: "DB connection not found or access denied" });
    }
    
    // If org_id is being changed, verify the new org exists and user has access
    if (org_id && String(org_id) !== String(existingConn.org_id)) {
      if (!isSuperAdmin(req.user)) {
        return res.status(403).json({ 
          error: "You cannot move DB connections to a different organisation" 
        });
      }
      
      const orgCheck = await pool.query(
        "SELECT id FROM organisations WHERE id = $1 AND active = TRUE",
        [org_id]
      );
      
      if (orgCheck.rows.length === 0) {
        return res.status(400).json({ error: "Invalid or inactive organisation" });
      }
    }
    
    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (db_type !== undefined) {
      updates.push(`db_type = $${paramIndex++}`);
      values.push(db_type);
    }
    if (host !== undefined) {
      updates.push(`host = $${paramIndex++}`);
      values.push(host);
    }
    if (port !== undefined) {
      updates.push(`port = $${paramIndex++}`);
      values.push(port);
    }
    if (database !== undefined) {
      updates.push(`database = $${paramIndex++}`);
      values.push(database);
    }
    if (username !== undefined) {
      updates.push(`username = $${paramIndex++}`);
      values.push(username);
    }
    if (password !== undefined && password !== "") {
      updates.push(`password_enc = $${paramIndex++}`);
      const storedPassword = typeof encryptValue === 'function' ? encryptValue(password) : password;
      values.push(storedPassword);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(description);
    }
    if (org_id !== undefined && isSuperAdmin(req.user)) {
      updates.push(`org_id = $${paramIndex++}`);
      values.push(org_id);
    }
    
    // updates.push(`updated_at = NOW()`); // Column doesn't exist
    values.push(id);
    
    const query = `
      UPDATE db_connections 
      SET ${updates.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING id, name, db_type, host, port, database, username, description, org_id, created_at
    `;
    
    const result = await pool.query(query, values);
    
    console.log(`[DB Connection] Updated: id=${id} by user_id=${req.user.uid}`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("[API] PUT /db-connections/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE DB CONNECTION (with org check) ──────────────────────────────────
app.delete("/api/db-connections/:id", requireAuth, requireRole("admin","lead","superadmin"), async (req, res) => {
  const { id } = req.params;
  
  try {
    let query, params;
    
    if (isSuperAdmin(req.user)) {
      // Superadmin can delete any connection
      query = "DELETE FROM db_connections WHERE id = $1 RETURNING *";
      params = [id];
    } else {
      // Regular admins can only delete connections from their org
      query = "DELETE FROM db_connections WHERE id = $1 AND org_id = $2 RETURNING *";
      params = [id, req.user.org_id];
    }
    
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "DB connection not found or access denied" });
    }
    
    console.log(`[DB Connection] Deleted: id=${id} by user_id=${req.user.uid}`);
    res.json({ ok: true, message: "DB connection deleted successfully" });
  } catch (err) {
    console.error("[API] DELETE /db-connections/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── TEST DB CONNECTION (with org check) ────────────────────────────────────
app.post("/api/db-connections/:id/test", requireAuth, async (req, res) => {
  const { id } = req.params;
  
  try {
    // Get connection details with org check
    let query, params;
    if (isSuperAdmin(req.user)) {
      query = "SELECT * FROM db_connections WHERE id = $1";
      params = [id];
    } else {
      query = "SELECT * FROM db_connections WHERE id = $1 AND org_id = $2";
      params = [id, req.user.org_id];
    }
    
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "DB connection not found or access denied" });
    }
    
    const conn = result.rows[0];
    
    // Decrypt password if encryptValue/decryptValue functions exist
    const decryptedPassword = typeof decryptValue === 'function' 
      ? decryptValue(conn.password_enc) 
      : conn.password_enc;
    
    // Create test connection pool
    const { Pool: TestPool } = require("pg");
    const testPool = new TestPool({
      user: conn.username,
      host: conn.host,
      database: conn.database,
      password: decryptedPassword,
      port: conn.port,
      connectionTimeoutMillis: 5000,
    });
    
    // Try to connect
    const client = await testPool.connect();
    await client.query("SELECT 1");
    client.release();
    await testPool.end();
    
    console.log(`[DB Connection] Test successful: id=${id}`);
    res.json({ ok: true, message: "Connection successful" });
  } catch (err) {
    console.error("[API] POST /db-connections/:id/test error:", err);
    res.json({ ok: false, message: err.message });
  }
});

// ─── GET DB CONNECTION CONFIG (for runner - with org check) ─────────────────
// This endpoint is called by the runner process
app.get("/api/db-connections/:name/config", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM db_connections WHERE lower(name)=lower($1)",
      [decodeURIComponent(req.params.name)]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: `DB connection '${req.params.name}' not found` });
    }
    const c = r.rows[0];
    
    // Decrypt password if function exists
    const password = typeof decryptValue === 'function' 
      ? decryptValue(c.password_enc) 
      : c.password_enc;
    
    res.json({ 
      db_type: c.db_type, 
      host: c.host, 
      port: +c.port, 
      database: c.database, 
      user: c.username, 
      password: password 
    });
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// END OF DB CONNECTIONS API
// ═══════════════════════════════════════════════════════════════════════════

// ─── USERS ────────────────────────────────────────────────────────────────────
// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────

// GET all users — admin only
app.get("/api/users", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    let rows;
    if (isSuperAdmin(req.user)) {
      // superadmin sees ALL users
      const r = await pool.query(
        "SELECT id,username,full_name,email,role,active,created_at FROM auto_users ORDER BY created_at DESC"
      );
      rows = r.rows;
    } else {
      // org-admin sees only users in their org, excluding superadmin
      const r = await pool.query(`
        SELECT DISTINCT u.id, u.username, u.full_name, u.email, u.role, u.active, u.created_at
        FROM auto_users u
        JOIN user_orgs uo ON uo.user_id = u.id
        WHERE uo.org_id = $1
          AND u.id != 1
          AND u.role != 'superadmin'
        ORDER BY u.created_at DESC
      `, [req.user.org_id]);
      rows = r.rows;
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CREATE user — admin only
app.post("/api/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { username, full_name, email, role } = req.body;
  if (!username) return res.status(400).json({ error: "Username is required" });
  const sizeErr = validateInputSizes({ name: username.trim() });
  if (sizeErr) return res.status(400).json({ error: sizeErr });
  // org-admin cannot assign superadmin or admin role — only superadmin can
  const assignedRole = role || "tester";
  if (!isSuperAdmin(req.user) && (assignedRole === "superadmin" || assignedRole === "admin")) {
    return res.status(403).json({ error: "Only the superadmin can assign the admin role." });
  }
  const DEFAULT_PASSWORD = "Welcome@123";
  try {
    const exists = await pool.query("SELECT id FROM auto_users WHERE username=$1", [username]);
    if (exists.rows.length) return res.status(400).json({ error: "Username already exists" });
    const r = await pool.query(
      "INSERT INTO auto_users (username,password_hash,full_name,email,role,must_change_password) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id,username,full_name,email,role,active",
      [username, sha256(DEFAULT_PASSWORD), full_name||null, email||null, assignedRole]
    );
    const newUser = r.rows[0];
    // Auto-assign new user to org-admin's organisation
    if (!isSuperAdmin(req.user) && req.user.org_id) {
      await pool.query(
        "INSERT INTO user_orgs (user_id, org_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [newUser.id, req.user.org_id]
      );
    }
    res.json(newUser);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPDATE user — admin only (name, email, role, active)
app.put("/api/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { full_name, email, role, active } = req.body;
  const targetId = parseInt(req.params.id);
  try {
    const existing = await pool.query("SELECT * FROM auto_users WHERE id=$1", [targetId]);
    if (!existing.rows.length) return res.status(404).json({ error: "User not found" });
    const target = existing.rows[0];

    // Guard 1: cannot change your own role
    if (targetId === req.user.uid && role && role !== target.role) {
      return res.status(403).json({ error: "You cannot change your own role." });
    }
    // Guard 2: cannot deactivate yourself
    if (targetId === req.user.uid && active === false) {
      return res.status(403).json({ error: "You cannot deactivate your own account." });
    }
    // Guard 3: only superadmin can assign admin/superadmin role
    if (!isSuperAdmin(req.user) && role && (role === "admin" || role === "superadmin")) {
      return res.status(403).json({ error: "Only the superadmin can assign the admin role." });
    }
    // Guard 4: cannot modify superadmin account
    if (targetId === 1 && !isSuperAdmin(req.user)) {
      return res.status(403).json({ error: "The superadmin account cannot be modified." });
    }
    // Guard 5: org-admin can only edit users in their own org
    if (!isSuperAdmin(req.user) && req.user.org_id) {
      const inOrg = await pool.query(
        "SELECT 1 FROM user_orgs WHERE user_id=$1 AND org_id=$2", [targetId, req.user.org_id]
      );
      if (!inOrg.rows.length) {
        return res.status(403).json({ error: "You can only edit users in your organisation." });
      }
    }

    const r = await pool.query(
      "UPDATE auto_users SET full_name=$1, email=$2, role=$3, active=$4 WHERE id=$5 RETURNING id,username,full_name,email,role,active",
      [full_name||null, email||null, role||target.role, active!==undefined?active:true, targetId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SET password — admin can set for anyone, user can set for themselves only
app.patch("/api/users/:id/password", requireAuth, async (req, res) => {
  const { password, current_password } = req.body;
  const targetId = parseInt(req.params.id);
  const isAdmin  = req.user?.role === "admin" || req.user?.role === "superadmin";
  const isSelf   = parseInt(req.user?.uid) === targetId;

  if (!isAdmin && !isSelf) return res.status(403).json({ error: "Not allowed" });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  try {
    // Non-admin must verify current password
    if (!isAdmin && isSelf) {
      if (!current_password) return res.status(400).json({ error: "Current password is required" });
      const checkUser = await pool.query(
        "SELECT id, password_hash FROM auto_users WHERE id=$1", [targetId]
      );
      if (!checkUser.rows.length) return res.status(400).json({ error: "User not found" });
      const currentHash = checkUser.rows[0].password_hash;
      let currentValid = false;
      if (currentHash.startsWith("$2")) {
        currentValid = await bcrypt.compare(current_password, currentHash);
      } else {
        currentValid = currentHash === sha256(current_password);
      }
      if (!currentValid) return res.status(400).json({ error: "Current password is incorrect" });
    }

    await pool.query(
      "UPDATE auto_users SET password_hash=$1, must_change_password=FALSE WHERE id=$2",
      [await bcrypt.hash(password, 12), targetId]
    );
    // Invalidate ALL sessions for this user — forces re-login on all devices
    await pool.query("DELETE FROM auto_sessions WHERE user_id=$1", [targetId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TOGGLE active status — admin only
app.patch("/api/users/:id/active", requireAuth, requireRole("admin"), async (req, res) => {
  const { active } = req.body;
  const targetId = parseInt(req.params.id);
  // Guard: org-admin can only toggle users in their org, not superadmin
  if (!isSuperAdmin(req.user)) {
    if (targetId === 1) return res.status(403).json({ error: "Cannot modify the superadmin account." });
    if (req.user.org_id) {
      const inOrg = await pool.query(
        "SELECT 1 FROM user_orgs WHERE user_id=$1 AND org_id=$2", [targetId, req.user.org_id]
      );
      if (!inOrg.rows.length) return res.status(403).json({ error: "User is not in your organisation." });
    }
  }
  try {
    const r = await pool.query(
      "UPDATE auto_users SET active=$1 WHERE id=$2 RETURNING id,username,active",
      [active, targetId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── Detect image media type from base64 string ────────────────────────────────
function detectMediaType(base64) {
  // Check first few bytes of the decoded data (magic bytes)
  const head = base64.slice(0, 12);
  const bytes = Buffer.from(head, "base64");
  if (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4E && bytes[3]===0x47) return "image/png";
  if (bytes[0]===0xFF && bytes[1]===0xD8) return "image/jpeg";
  if (bytes[0]===0x47 && bytes[1]===0x49 && bytes[2]===0x46) return "image/gif";
  if (bytes[0]===0x52 && bytes[1]===0x49 && bytes[2]===0x46 && bytes[3]===0x46) return "image/webp";
  return "image/jpeg"; // fallback
}

// ─── AI FEATURES ──────────────────────────────────────────────────────────────

// ── AI Auto-Heal: called by runner.py when a step fails ──────────────────────
// Takes a screenshot + failed selector, asks Claude to find the element
app.post("/api/ai/heal", async (req, res) => {
  const { screenshot_base64, selector, action, step_description, run_id } = req.body;
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to backend/.env or set it as an environment variable before starting the server." });
    }

    const healData = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: detectMediaType(screenshot_base64), data: screenshot_base64 }
            },
            {
              type: "text",
              text: `You are a Playwright test automation expert helping auto-heal a broken test step.

The following step FAILED because the element could not be found:
- Action: ${action}
- Failed selector: ${selector}
- Step description: ${step_description}

Look at the screenshot carefully. Find the element that the test was trying to interact with.
Generate up to 5 alternative Playwright selectors for that element, ordered from most reliable to least.

Use only these selector formats:
- get_by_role("button", name="...") 
- get_by_role("link", name="...")
- get_by_placeholder("...")
- get_by_text("...")
- get_by_label("...")
- #id-value
- .class-name
- [data-testid="..."]
- text="exact text"

Respond ONLY with a JSON array, no explanation, no markdown, just raw JSON like:
[
  {"selector": "get_by_role(\"button\", name=\"Submit\")", "confidence": "high", "reason": "Button with exact text"},
  {"selector": "#submit-btn", "confidence": "medium", "reason": "ID selector"}
]`
            }
          ]
        }]
    });

    const text = healData.content?.[0]?.text || "[]";
    let suggestions;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      suggestions = JSON.parse(clean);
    } catch {
      suggestions = [];
    }

    // Log the heal attempt
    console.log(`[AI Heal] Run ${run_id} — trying ${suggestions.length} alternatives for: ${selector}`);
    res.json({ suggestions });

  } catch (err) {
    console.error("[AI Heal] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Step: called by async_runner.py to execute ONE natural-language test step ────
// Takes a screenshot + a plain-English instruction, asks Claude to resolve it into a
// concrete Playwright action + selector (+ value for typing), which the runner executes.
app.post("/api/ai/step", async (req, res) => {
  const { screenshot_base64, instruction, run_id } = req.body;
  try {
    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to backend/.env or set it as an environment variable before starting the server." });
    }
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ error: "instruction is empty" });
    }

    const stepData = await callClaude({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: detectMediaType(screenshot_base64), data: screenshot_base64 }
            },
            {
              type: "text",
              text: `You are a Playwright test automation expert executing ONE natural-language test step on a live web page.

Instruction: "${instruction}"

Look at the screenshot and decide the single best Playwright action to carry out this instruction right now.

Respond ONLY with raw JSON, no markdown, no explanation, in this exact shape:
{"action": "click", "selector": "get_by_role(\\"button\\", name=\\"Submit\\")", "value": "", "confidence": "high", "reason": "..."}

Rules:
- "action" must be one of: click, type, clear, select, check, uncheck, hover, press
- "selector" must use one of these formats:
  - get_by_role("button", name="...")
  - get_by_role("link", name="...")
  - get_by_placeholder("...")
  - get_by_text("...")
  - get_by_label("...")
  - #id-value
  - .class-name
  - [data-testid="..."]
  - text="exact text"
- "value" is the text to type / option to select / key to press. Leave "" for click/hover/check/uncheck.
- If the instruction implies typing (e.g. "enter", "type", "fill"), use action "type" directly and put the text to type in "value" -- NEVER resolve a text-entry instruction to "click" as a preliminary/warm-up step. The "type" action already focuses and clicks the field for you before filling it, so there is never a need to click a text field first. Only use "click" when the instruction is actually about clicking something (a button, link, tab, checkbox, menu item) -- never as a prerequisite before typing.
- If the instruction implies selecting a dropdown option, use action "select" and put the option text in "value".
- Pick the ONE element that best matches the instruction. Do not invent elements that aren't visible in the screenshot.
- Text selectors: get_by_text("...") is a CONTAINS match -- prefer it, with a SHORT distinctive substring (one word or short phrase you can see verbatim), whenever the target's visible text is long, spans multiple lines, or includes dynamic details (counts, durations, timestamps, status text). Reserve the exact-match form text="..." for short, single-line, fully-visible labels only (e.g. a button or tab caption).
- NEVER abbreviate, summarize, or truncate text inside a selector -- do not write "...", "(...)", or similar inside "selector". Every character inside get_by_text(...) or text="..." must be copied verbatim from what is actually visible on screen. If you can't read the full text exactly, use a shorter verbatim substring instead of guessing or shortening it.
- If the visible name/text you are matching is purely numeric or very short (e.g. a calendar day number, a count, a single digit or short code), ALWAYS add exact=True -- e.g. get_by_role("button", name="5", exact=True) or get_by_text("5", exact=True). Without it, a short numeric name matches as a substring against every other element that merely contains those digits (e.g. "5" would also match "15" and "25"), which causes ambiguous/failed clicks.`
            }
          ]
        }]
    });

    const text = stepData.content?.[0]?.text || "{}";
    let resolved;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      resolved = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }

    console.log(`[AI Step] Run ${run_id} — "${instruction}" → ${resolved.action} ${resolved.selector}`);
    res.json(resolved);

  } catch (err) {
    console.error("[AI Step] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI Script Generator: upload screenshots → get test steps ─────────────────
app.post("/api/ai/generate-steps", requireAuth, async (req, res) => {
  const { screenshots, context_description } = req.body;
  // screenshots: array of { base64, label }

  if (!screenshots || !screenshots.length) {
    return res.status(400).json({ error: "No screenshots provided" });
  }

  try {
    // Build content array — text instructions + all screenshots
    const content = [
      {
        type: "text",
        text: `You are a Playwright test automation expert. I will show you ${screenshots.length} screenshot(s) of a web application workflow.
${context_description ? `Context: ${context_description}` : ""}

Analyze the screenshots in order and generate a complete Playwright test script as a sequence of steps.

For each visible user action or assertion you can infer, create a step with:
- action: one of: navigate, click, type, select, check, uncheck, hover, press, wait, wait_for_selector, wait_for_url, assert_text, assert_visible, assert_url, screenshot
- selector: Playwright selector for the element (use get_by_role, get_by_placeholder, get_by_text, get_by_label, or CSS selectors)
- value: the text to type, URL to navigate to, key to press, or text to assert

Rules:
- Look for form fields, buttons, links, navigation elements
- Infer the logical flow: navigate → fill form → click submit → assert success
- Use descriptive selectors based on visible text and roles
- For text inputs, use get_by_placeholder("...") or get_by_label("...")
- For buttons, use get_by_role("button", name="...")
- For links, use get_by_role("link", name="...")
- Add assert_text or assert_visible steps to verify key states

Respond ONLY with a valid JSON array of steps, no markdown, no explanation:
[
  {"action": "navigate", "selector": "", "value": "https://..."},
  {"action": "type", "selector": "get_by_placeholder(\"Username\")", "value": "testuser"},
  {"action": "click", "selector": "get_by_role(\"button\", name=\"Login\")", "value": ""}
]`
      }
    ];

    // Add each screenshot
    screenshots.forEach((ss, i) => {
      content.push({
        type: "text",
        text: `Screenshot ${i + 1}${ss.label ? ": " + ss.label : ""}:`
      });
      content.push({
        type: "image",
        source: { type: "base64", media_type: detectMediaType(ss.base64), data: ss.base64 }
      });
    });

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to backend/.env or set it as an environment variable before starting the server." });
    }

    const genData = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content }]
    });

    const text = genData.content?.[0]?.text || "[]";
    let steps;
    try {
      const clean = text.replace(/```json|```/g, "").trim();
      steps = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response", raw: text });
    }

    console.log(`[AI Generate] Generated ${steps.length} steps from ${screenshots.length} screenshot(s)`);
    res.json({ steps });

  } catch (err) {
    console.error("[AI Generate] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Save healed selector back to DB ──────────────────────────────────────────
app.patch("/api/tests/:test_case_id/heal/:step_index", requireAuth, async (req, res) => {
  const { test_case_id, step_index } = req.params;
  const { new_selector } = req.body;
  try {
    const r = await pool.query("SELECT steps FROM test_cases WHERE id=$1", [test_case_id]);
    if (!r.rows.length) return res.status(404).json({ error: "Test case not found" });
    const steps = r.rows[0].steps || [];
    const idx = parseInt(step_index);
    if (idx < 0 || idx >= steps.length) return res.status(400).json({ error: "Invalid step index" });
    steps[idx] = { ...steps[idx], selector: new_selector, _healed: true };
    await pool.query("UPDATE test_cases SET steps=$1 WHERE id=$2", [JSON.stringify(steps), test_case_id]);
    console.log(`[AI Heal] Saved healed selector for test ${test_case_id} step ${idx}: ${new_selector}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler — always return JSON, never HTML ────────────────────
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});


// ─── DEBUG ENDPOINTS ──────────────────────────────────────────────────────────
const debugSessions = new Map(); // runId -> { paused, stepIndex, variables, command }

// Runner calls this when paused at a breakpoint
// Runner sends debug events (line_start, line_done, line_error, etc.)
app.post("/api/runs/:id/debug-event", async (req, res) => {
  const runId = req.params.id;
  const { type, ...payload } = req.body;
  // Forward directly to connected WebSocket clients
  broadcast(runId, { type, ...payload });
  res.json({ ok:true });
});

app.post("/api/runs/:id/debug-paused", async (req, res) => {
  const { step_index, variables, reason } = req.body;
  const runId = req.params.id;
  const session = debugSessions.get(String(runId)) || {};
  session.paused = true; session.stepIndex = step_index;
  session.variables = variables; session.command = null;
  debugSessions.set(String(runId), session);
  broadcast(runId, { type:"debug_paused", step_index, variables, reason });
  res.json({ ok:true });
});

// Runner polls this to get the next command
app.get("/api/runs/:id/debug-command", async (req, res) => {
  const session = debugSessions.get(req.params.id);
  if (!session || !session.command) return res.json({ command:null });
  const cmd = session.command;
  session.command = null; // consume
  session.paused  = false;
  res.json({ command: cmd });
});

// Frontend sends a command: continue | step | skip | stop
app.post("/api/runs/:id/debug-command", requireAuth, async (req, res) => {
  const { command } = req.body;
  const runId = req.params.id;
  const session = debugSessions.get(runId);
  if (!session) return res.status(404).json({ error:"No debug session" });
  session.command = command;
  broadcast(runId, { type:"debug_command_sent", command });
  res.json({ ok:true });
});

// Debug a raw script — Phase 1: create run record, return run_id
// Runner is NOT started yet — frontend connects WS first, then calls /start
app.post("/api/debug/script", requireAuth, async (req, res) => {
  const { steps=[], variables=[], browser="chrome", slow_mo=500,
          breakpoints=[], base_url="", test_case_id=null } = req.body;
  try {
    const uid = req.user?.uid || null;
    const pid = req.user?.project_id || null;
    const [runResult] = (await pool.query(
      "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,run_by,started_at,origin_server) VALUES ($1,$2,'running',$3,'debug',$4,NOW(),$5) RETURNING *",
      [test_case_id||null, pid, browser, uid, INSTANCE_ID]
    )).rows;
    const runId = runResult.id;
    const runnerToken = process.env.RUNNER_SECRET || "nat-internal-runner-2024"; // always use secret so call_test works

    // Store config for when /start is called
    debugSessions.set(String(runId), {
      paused:false, stepIndex:null, variables:{}, command:null,
      pendingConfig: { steps, browser, base_url, variables, slow_mo,
                       breakpoints, runnerToken, test_case_id }
    });

    res.json({ run_id: runId });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug — Phase 2: frontend WS connected, now spawn the runner
app.post("/api/debug/:id/start", requireAuth, async (req, res) => {
  const runId = req.params.id;
  const session = debugSessions.get(String(runId));
  if (!session?.pendingConfig) return res.status(404).json({ error:"No pending debug config" });

  const { steps, browser, base_url, variables, slow_mo,
          breakpoints, runnerToken, test_case_id } = session.pendingConfig;
  delete session.pendingConfig;

  const embeddedSteps = await embedDbConnections(steps || []);
  const config = { type:"ui", steps: embeddedSteps, browser, base_url, variables,
                   runner_token: runnerToken, test_case_id };

  const args = [
    RUNNER_PATH,
    "--run-id",      String(runId),
    "--config",      JSON.stringify(config),
    "--debug",
    "--slow-mo",     String(slow_mo),
    "--breakpoints", (breakpoints||[]).join(","),
  ];

  const proc = spawn(PYTHON_CMD, args, {
    detached:false, stdio:["ignore","pipe","pipe"], windowsHide:false
  });
  activeRunPids.set(parseInt(runId), proc.pid);

  proc.stdout.on("data", d => {
    const txt = d.toString().trim();
    if (txt) broadcast(runId, { type:"log", level:"info", message:txt, timestamp:new Date().toISOString() });
  });
  proc.stderr.on("data", d => {
    const txt = d.toString().trim();
    if (txt) broadcast(runId, { type:"log", level:"error", message:txt, timestamp:new Date().toISOString() });
  });
  proc.on("exit", (code) => {
    broadcast(runId, { type:"done", code });
    debugSessions.delete(String(runId));
    activeRunPids.delete(parseInt(runId));
  });

  res.json({ ok:true });
});

// Frontend launches a debug run — adds --debug flag and breakpoints
app.post("/api/tests/:id/debug", requireAuth, async (req, res) => {
  const { browser="chrome", slow_mo=500, breakpoints=[] } = req.body;
  try {
    const r = await pool.query("SELECT * FROM test_cases WHERE id=$1 AND active=TRUE", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error:"Test not found" });
    const test = r.rows[0];

    const [runResult] = (await pool.query(
      "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,run_by,started_at,origin_server) VALUES ($1,$2,'running',$3,'debug',$4,NOW(),$5) RETURNING *",
      [test.id, test.project_id, browser, req.user?.uid||null, INSTANCE_ID]
    )).rows;
    const runId = runResult.id;

    const fullTest    = await pool.query("SELECT variables FROM test_cases WHERE id=$1", [test.id]);
    const variables   = fullTest.rows[0]?.variables || [];
    const runnerToken = process.env.RUNNER_SECRET || "nat-internal-runner-2024"; // always use secret so call_test works

    const config = {
      type: test.type, steps: await embedDbConnections(test.steps||[]), browser,
      base_url: test.base_url||"", variables,
      runner_token: runnerToken, test_case_id: test.id,
      api_config: test.api_config || null,
    };

    const args = [
      RUNNER_PATH,
      "--run-id",      String(runId),
      "--config",      JSON.stringify(config),
      "--debug",
      "--slow-mo",     String(slow_mo),
      "--breakpoints", breakpoints.join(","),
    ];

    const proc = spawn(PYTHON_CMD, args, {
      detached:false, stdio:["ignore","pipe","pipe"], windowsHide:false
    });

    proc.stdout.on("data", d => console.log(`[debug-run ${runId}] ${d.toString().trim()}`));
    proc.stderr.on("data", d => console.error(`[debug-run ${runId}] ERR: ${d.toString().trim()}`));
    proc.on("exit", (code) => {
      debugSessions.delete(String(runId));
      broadcast(runId, { type:"done" });
    });

    res.json({ run_id: runId });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});


// Runner calls this when debug session finishes
app.patch("/api/runs/:id/finish-debug", async (req, res) => {
  const { status="passed" } = req.body;
  try {
    await pool.query(
      "UPDATE test_runs SET status=$1, finished_at=NOW() WHERE id=$2 AND triggered_by='debug'",
      [status, req.params.id]
    );
    res.json({ ok:true });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Download suite run HTML report ───────────────────────────────────────────
app.get("/api/suite-runs/:id/report", async (req, res) => {
  // Accept token from header OR query param for direct browser downloads
  const token = (req.headers.authorization||"").replace("Bearer ","") || (req.query.token||"");
  if (!token) return res.status(401).send("<h2>Not authorised — please log in to Daiva Health first</h2>");
  // Validate token exists in sessions
  try {
    const sess = await pool.query(
      "SELECT s.token FROM auto_sessions s WHERE s.token=$1 AND s.expires_at > NOW()",
      [token]
    );
    if (!sess.rows[0]) return res.status(401).send("<h2>Session expired — please log in again</h2>");
  } catch(e) { return res.status(500).json({ error: e.message }); }
  // Always regenerate fresh from DB — never serve stale cached file
  try {
    const sr = await pool.query(
      "SELECT sr.*, ts.name as suite_name FROM suite_runs sr LEFT JOIN test_suites ts ON sr.suite_id=ts.id WHERE sr.id=$1",
      [req.params.id]
    );
    if (!sr.rows[0]) return res.status(404).json({ error: "Suite run not found" });
    const suiteRun = sr.rows[0];
    const suite    = { id: suiteRun.suite_id, name: suiteRun.suite_name };

    const testsRes   = await pool.query("SELECT * FROM test_cases WHERE suite_id=$1", [suite.id]);
    const runDetails = await pool.query(
      `SELECT tr.*, tc.name as test_name
         FROM test_runs tr
         LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
        WHERE tr.suite_run_id = $1
        ORDER BY tr.id`,
      [req.params.id]
    );

    const html = await generateSuiteReport(req.params.id, suite, testsRes.rows, runDetails.rows);

    // Save to disk as well (for email attachment reuse)
    const reportsDir = path.join(__dirname, "../runner/reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, `suite-run-${req.params.id}.html`), html, "utf-8");

    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Disposition", `attachment; filename="suite-report-${req.params.id}.html"`);
    return res.send(html);
  } catch(e) { return res.status(500).json({ error: e.message }); }

  // (legacy fallback — never reached)
  const reportFile = path.join(__dirname, "../runner/reports", `suite-run-${req.params.id}.html`);
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Disposition", `attachment; filename="suite-report-${req.params.id}.html"`);
  res.sendFile(path.resolve(reportFile));
});


// ─── USER-PROJECT ASSIGNMENTS ─────────────────────────────────────────────────

// Get projects assigned to a user
app.get("/api/users/:id/projects", requireAuth, requireRole("admin"), async (req, res) => {
  // org-admin cannot view projects of users outside their org
  if (!isSuperAdmin(req.user) && req.user.org_id) {
    const inOrg = await pool.query(
      "SELECT 1 FROM user_orgs WHERE user_id=$1 AND org_id=$2", [req.params.id, req.user.org_id]
    );
    if (!inOrg.rows.length && parseInt(req.params.id) !== req.user.uid)
      return res.status(403).json({ error: "User is not in your organisation." });
  }
  try {
    const r = await pool.query(
      "SELECT project_id FROM user_projects WHERE user_id=$1",
      [req.params.id]
    );
    res.json(r.rows.map(r => r.project_id));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Set projects for a user (replace all)
app.put("/api/users/:id/projects", requireAuth, requireRole("admin"), async (req, res) => {
  const { project_ids } = req.body; // array of project IDs
  try {
    await pool.query("DELETE FROM user_projects WHERE user_id=$1", [req.params.id]);
    if (project_ids?.length) {
      const values = project_ids.map((pid, i) => `($1,$${i+2})`).join(",");
      await pool.query(
        `INSERT INTO user_projects (user_id, project_id) VALUES ${values} ON CONFLICT DO NOTHING`,
        [req.params.id, ...project_ids]
      );
    }
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// ── Python script syntax validation ──────────────────────────────────────────
app.post("/api/validate-script", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ valid: true, errors: [] });
  const { spawn } = require("child_process");
  const os = require("os");
  const fs = require("fs");
  const tmp = os.tmpdir() + "/athma_validate_" + Date.now() + ".py";
  fs.writeFileSync(tmp, code);

  // Use the same resolved Python command (PYTHON_PATH from .env) as the rest of the server,
  // instead of a bare "python"/"python3" which hits the Windows Store alias stub.
  const proc = spawn(PYTHON_CMD, ["-m", "py_compile", tmp]);
  let stderr = "";
  proc.stderr.on("data", d => stderr += d.toString());
  proc.on("close", exitCode => {
    try { fs.unlinkSync(tmp); } catch {}
    if (exitCode === 0) return res.json({ valid: true, errors: [] });
    const match = stderr.match(/line (\d+)/);
    const line  = match ? parseInt(match[1]) : null;
    const msg   = stderr.replace(/File ".*?",\s*/g, "").trim();
    res.json({ valid: false, errors: [{ line, message: msg }] });
  });
  proc.on("error", () => {
    // python command not found — skip server validation, let client-side parse handle it
    try { fs.unlinkSync(tmp); } catch {}
    res.json({ valid: true, errors: [] });
  });
});


// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const r = await pool.query("SELECT COUNT(*) as queued FROM test_runs WHERE status='queued'");
    const r2 = await pool.query("SELECT COUNT(*) as running FROM test_runs WHERE status='running'");
    res.json({
      status:   "ok",
      db:       "connected",
      queued:   parseInt(r.rows[0].queued),
      running:  parseInt(r2.rows[0].running),
      max_concurrent: MAX_CONCURRENT_RUNS,
      uptime:   Math.floor(process.uptime()),
      memory:   process.memoryUsage().heapUsed,
      page_size: PAGE_SIZE,
    });
  } catch(err) {
    res.status(503).json({ status:"error", db:"disconnected", error: err.message });
  }
});

// ─── MAINTENANCE JOBS ─────────────────────────────────────────────────────────
// Start queue worker polling
const queueInterval = setInterval(processQueue, QUEUE_POLL_INTERVAL);
console.log(`⏱ Queue worker polling every ${QUEUE_POLL_INTERVAL}ms`);

// Stuck run recovery — runs every 10 minutes (backup to processQueue's recovery)
// Uses the same STUCK_RUN_TIMEOUT_MIN as processQueue to be consistent
setInterval(async () => {
  try {
    const stuckCutoff = new Date(Date.now() - STUCK_RUN_TIMEOUT_MIN * 60 * 1000);
    const stuck = await pool.query(
      `UPDATE test_runs SET status='failed', finished_at=NOW()
       WHERE status='running'
         AND started_at IS NOT NULL
         AND started_at < $1
		 AND (triggered_by IS NULL OR triggered_by NOT IN ('debug','parallel','suite','schedule','ci'))
       RETURNING id`,
      [stuckCutoff]
    );
    if (stuck.rows.length) {
      console.warn(`⚠ Recovered ${stuck.rows.length} stuck run(s) via backup recovery: ${stuck.rows.map(r=>r.id).join(',')}`);
      stuck.rows.forEach(r => {
        broadcast(r.id, { type:"status", status:"failed" });
        broadcast(r.id, { type:"log", level:"error", message:`❌ Run auto-recovered: exceeded ${STUCK_RUN_TIMEOUT_MIN} minute timeout`, timestamp:new Date().toISOString() });
        broadcast(r.id, { type:"done", code: 1 });
        activeRunPids.delete(r.id);
      });
    }
  } catch(err) { console.error("[Stuck recovery]", err.message); }
}, 10 * 60 * 1000);

// Screenshot cleanup — runs daily at 2am
function scheduleScreenshotCleanup() {
  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  setTimeout(async function runCleanup() {
    try {
      const cutoffDate = new Date(Date.now() - SCREENSHOT_RETENTION_DAYS * 86400000);
      // Get old runs with screenshots
      const old = await pool.query(
        "SELECT id, screenshots FROM test_runs WHERE created_at < $1 AND screenshots IS NOT NULL AND screenshots != '[]'::jsonb",
        [cutoffDate.toISOString()]
      );
      let deleted = 0;
      for (const run of old.rows) {
        const screenshots = Array.isArray(run.screenshots) ? run.screenshots : [];
        for (const ss of screenshots) {
          if (ss.filename) {
            const fpath = path.join(SCREENSHOTS_PATH, ss.filename);
            if (fs.existsSync(fpath)) { fs.unlinkSync(fpath); deleted++; }
          }
        }
        await pool.query("UPDATE test_runs SET screenshots='[]'::jsonb WHERE id=$1", [run.id]);
      }
      console.log(`🧹 Screenshot cleanup: deleted ${deleted} files from ${old.rows.length} runs (older than ${SCREENSHOT_RETENTION_DAYS} days)`);
    } catch(err) { console.error("[Cleanup]", err.message); }
    setTimeout(runCleanup, 24 * 60 * 60 * 1000); // next day
  }, next2am - now);
}
scheduleScreenshotCleanup();

// Log cleanup — runs daily at 3am (clears DB logs + deletes log files older than LOG_RETENTION_DAYS)
function scheduleLogCleanup() {
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  setTimeout(async function runLogCleanup() {
    try {
      const cutoffDate = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000);

      // 1. Clear DB logs column for old runs
      const result = await pool.query(
        "UPDATE test_runs SET logs='[]'::jsonb WHERE created_at < $1 AND logs IS NOT NULL AND logs != '[]'::jsonb RETURNING id",
        [cutoffDate.toISOString()]
      );

      // 2. Delete old log FILES from runner/logs/
      let deletedFiles = 0;
      if (fs.existsSync(LOGS_PATH)) {
        const files = fs.readdirSync(LOGS_PATH).filter(f => f.endsWith('.log'));
        for (const file of files) {
          const fpath = path.join(LOGS_PATH, file);
          try {
            const stat = fs.statSync(fpath);
            if (stat.mtimeMs < cutoffDate.getTime()) {
              fs.unlinkSync(fpath);
              deletedFiles++;
            }
          } catch (e) { /* skip locked/missing files */ }
        }
      }

      console.log(`🧹 Log cleanup: cleared DB logs from ${result.rows.length} runs, deleted ${deletedFiles} log files older than ${LOG_RETENTION_DAYS} days`);
    } catch(err) { console.error("[Log cleanup]", err.message); }
    setTimeout(runLogCleanup, 24 * 60 * 60 * 1000);
  }, next3am - now);
}
scheduleLogCleanup();

// Expired session cleanup — runs every hour
setInterval(async () => {
  try {
    const r = await pool.query("DELETE FROM auto_sessions WHERE expires_at < NOW() RETURNING id");
    if (r.rows.length) console.log(`🧹 Cleaned ${r.rows.length} expired sessions`);
  } catch(err) { console.error("[Session cleanup]", err.message); }
}, 60 * 60 * 1000);



// ─── SERVE FRONTEND (built React app) ──────────────────────────────────────
const FRONTEND_DIST = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST, {
    maxAge: '7d',        // cache static assets for 7 days
    etag: true,
    lastModified: true
  }));
  // ── Auto-Scan routes (isolated, no impact on existing routes) ───────────────
  app.use('/api/auto-scan', require('./auto_scan_routes'));

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
  console.log('✅ Serving frontend from:', FRONTEND_DIST);
} else {
  console.warn('⚠️  Frontend dist not found at:', FRONTEND_DIST, '— run npm run build in frontend/');
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    const queueRes = await pool.query("SELECT COUNT(*) FROM test_runs WHERE status='queued'");
    const runRes   = await pool.query("SELECT COUNT(*) FROM test_runs WHERE status='running'");
    res.json({
      status:   "ok",
      db:       "connected",
      queued:   parseInt(queueRes.rows[0].count),
      running:  parseInt(runRes.rows[0].count),
      max_concurrent: MAX_CONCURRENT_RUNS,
      uptime:   Math.floor(process.uptime()),
      memory:   Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
      timestamp: new Date().toISOString(),
    });
  } catch(err) {
    res.status(503).json({ status:"error", db:"disconnected", error: err.message });
  }
});


// Note: the single gracefulShutdown() used for real (kills tracked runner
// processes, marks in-flight rows 'error', then exits) lives further down —
// see "GRACEFUL SHUTDOWN — kill all runner processes on Ctrl+C or SIGTERM".

// ─── PARALLEL RUN REPORT GENERATOR ───────────────────────────────────────────
async function generateParallelReport(parallelRunId, runs, testName) {
  const now=new Date(), total=runs.length;
  const passed=runs.filter(r=>r.status==="passed").length;
  const failed=runs.filter(r=>r.status==="failed").length;
  const stepMatrix={};
  runs.forEach(run=>{
    const logs=Array.isArray(run.logs)?run.logs:[];
    logs.forEach(l=>{
      if(l.step_index!=null){
        const si=l.step_index;
        if(!stepMatrix[si]) stepMatrix[si]={label:`Step ${si+1}`,results:{}};
        if(!stepMatrix[si].results[run.id]) stepMatrix[si].results[run.id]={status:"info",messages:[]};
        if(l.level==="pass"){stepMatrix[si].results[run.id].status="pass";stepMatrix[si].label=(l.message||"").replace(/^PASSED — /,"").slice(0,80);}
        if(l.level==="fail"||l.level==="error") stepMatrix[si].results[run.id].status="fail";
        stepMatrix[si].results[run.id].messages.push(l);
      }
    });
  });
  const sortedSteps=Object.keys(stepMatrix).map(Number).sort((a,b)=>a-b);
  const bhdrs=runs.map(r=>`<th style="padding:8px 12px;text-align:center;background:#f0f9ff;border:1px solid #e5e7eb;font-size:12px">${r.parallel_label||r.browser}<br><span style="font-size:10px;color:#9ca3af">${r.browser}</span></th>`).join("");
  const rows=sortedSteps.map((si,ri)=>{
    const step=stepMatrix[si];
    const cells=runs.map(run=>{
      const res=step.results[run.id]||{status:"—",messages:[]};
      const bg=res.status==="pass"?"#f0fff4":res.status==="fail"?"#fff5f5":"#f9fafb";
      const icon=res.status==="pass"?"✅":res.status==="fail"?"❌":"—";
      const msg=((res.messages.find(m=>m.level==="fail"||m.level==="error")||{}).message||"");
      return `<td style="padding:8px;background:${bg};border:1px solid #e5e7eb;text-align:center;cursor:pointer" title="${msg.slice(0,120).replace(/"/g,"&quot;")}" onclick="toggleDetail(${ri},${run.id})">${icon}</td>`;
    }).join("");
    const details=runs.map(run=>{
      const msgs=(step.results[run.id]||{messages:[]}).messages.filter(m=>m.level==="fail"||m.level==="error");
      if(!msgs.length) return "";
      return `<tr id="detail-${ri}-${run.id}" style="display:none"><td style="padding:6px 12px;background:#f8fafc;border:1px solid #e5e7eb;font-size:11px">↳ ${run.parallel_label||run.browser}</td><td colspan="${runs.length}" style="padding:6px 12px;background:#fff5f5;border:1px solid #e5e7eb;font-family:monospace;font-size:11px;color:#dc2626">${msgs.map(m=>(m.message||"").replace(/</g,"&lt;")).join("<br>")}</td></tr>`;
    }).join("");
    return `<tr><td style="padding:8px 10px;border:1px solid #e5e7eb;font-size:12px;font-family:monospace"><span style="color:#9ca3af;margin-right:6px">${si+1}.</span>${(step.label||"").replace(/</g,"&lt;").slice(0,70)}</td>${cells}</tr>${details}`;
  }).join("");
  const cards=runs.map(r=>{
    const sc=r.status==="passed"?"#16a34a":r.status==="failed"?"#dc2626":"#f59e0b";
    const bg=r.status==="passed"?"#f0fff4":r.status==="failed"?"#fff5f5":"#fffbeb";
    return `<div style="background:${bg};border:2px solid ${sc}33;border-radius:8px;padding:14px;text-align:center"><div style="font-weight:700">${r.parallel_label||r.browser}</div><div style="font-size:11px;color:#9ca3af">${r.browser}</div><div style="font-size:20px;font-weight:800;color:${sc};margin:8px 0">${(r.status||"—").toUpperCase()}</div><div style="font-size:12px">${r.steps_passed||0}✅ ${r.steps_failed||0}❌</div><div style="font-size:11px;color:#9ca3af">${r.duration_ms?(r.duration_ms/1000).toFixed(1)+"s":"—"}</div></div>`;
  }).join("");
  const bsecs=runs.map((run,bi)=>{
    const logs=Array.isArray(run.logs)?run.logs:[];
    const sc=run.status==="passed"?"#16a34a":run.status==="failed"?"#dc2626":"#f59e0b";
    const logRows=logs.map(l=>{const col=l.level==="pass"?"#16a34a":l.level==="fail"?"#dc2626":l.level==="error"?"#ea580c":"#6b7280";const icon=l.level==="pass"?"✅":l.level==="fail"?"❌":l.level==="error"?"🔴":"ℹ";const t=l.timestamp?new Date(l.timestamp).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour12:false}):"";return `<tr><td style="padding:2px 8px;color:#9ca3af;font-size:10px;white-space:nowrap">${t}</td><td style="padding:2px 8px;font-size:11px">${icon}</td><td style="padding:2px 8px;font-size:11px;color:${col}">${(l.message||"").replace(/</g,"&lt;")}</td></tr>`;}).join("");
    return `<div style="border:1px solid #e5e7eb;border-radius:8px;margin-bottom:10px;overflow:hidden"><div style="padding:10px 16px;background:#f9fafb;display:flex;justify-content:space-between;cursor:pointer" onclick="toggleBrowser(${bi})"><div><span style="font-weight:700">${run.parallel_label||run.browser}</span></div><div style="display:flex;gap:12px;align-items:center"><span style="color:${sc};font-weight:700">${(run.status||"—").toUpperCase()}</span><span style="color:#6b7280">▼</span></div></div><div id="browser-${bi}" style="display:none;padding:10px 16px"><table style="width:100%;border-collapse:collapse;font-family:monospace"><tbody>${logRows||"<tr><td colspan=3 style='color:#9ca3af;padding:8px'>No logs</td></tr>"}</tbody></table></div></div>`;
  }).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>Parallel Report — ${(testName||"Test").replace(/</g,"&lt;")}</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:#f8fafc;color:#1e293b}.header{background:linear-gradient(135deg,#5c0000,#8B0000);color:#fff;padding:24px 32px}.card{background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:20px 24px;margin:16px 24px}table{border-collapse:collapse;width:100%}</style></head><body>
<div class="header"><div style="font-size:11px;opacity:0.7;margin-bottom:4px">Daiva Health — Parallel Run Report</div><div style="font-size:22px;font-weight:800;margin-bottom:6px">${(testName||"Test").replace(/</g,"&lt;")}</div><div style="font-size:13px;opacity:0.85">🕒 ${now.toLocaleString()} &nbsp;·&nbsp; ⚡ ${total} runs &nbsp;·&nbsp; ✅ ${passed} passed &nbsp;·&nbsp; ❌ ${failed} failed</div></div>
<div style="display:grid;grid-template-columns:repeat(${Math.min(runs.length,4)},1fr);gap:12px;margin:16px 24px">${cards}</div>
<div class="card"><div style="font-size:15px;font-weight:700;margin-bottom:12px">📊 Step Comparison Matrix</div>${sortedSteps.length>0?`<div style="overflow-x:auto"><table><thead><tr><th style="padding:8px 12px;text-align:left;background:#f9fafb;border:1px solid #e5e7eb;min-width:250px;font-size:12px">Step</th>${bhdrs}</tr></thead><tbody>${rows}</tbody></table></div>`:"<p style='color:#9ca3af;font-size:13px'>No step data available.</p>"}</div>
<div class="card"><div style="font-size:15px;font-weight:700;margin-bottom:12px">📋 Detailed Logs per Browser</div>${bsecs}</div>
<div style="text-align:center;padding:16px;font-size:11px;color:#9ca3af">Generated by Daiva Health · ${now.toISOString()}</div>
<script>function toggleDetail(r,id){const el=document.getElementById("detail-"+r+"-"+id);if(el)el.style.display=el.style.display==="none"?"table-row":"none";}function toggleBrowser(i){const el=document.getElementById("browser-"+i);if(el)el.style.display=el.style.display==="none"?"block":"none";}</script></body></html>`;
}

// ─── PARALLEL RUN ENDPOINT ────────────────────────────────────────────────────
app.post("/api/tests/:id/parallel-run", requireAuth, async (req, res) => {
  const { parallel_configs } = req.body;
  if (!parallel_configs?.length) return res.status(400).json({ error:"parallel_configs required" });
  try {
    const test = await pool.query("SELECT * FROM test_cases WHERE id=$1", [req.params.id]);
    if (!test.rows.length) return res.status(404).json({ error:"Test not found" });
    const t = test.rows[0];
    const parallelRunId = crypto.randomUUID();
    const runIds = [];
    for (let i=0; i<parallel_configs.length; i++) {
      const cfg = parallel_configs[i];
      const vars = [...(t.variables||[])];
      if (cfg.variable_overrides) {
        Object.entries(cfg.variable_overrides).forEach(([k,v])=>{
          const idx = vars.findIndex(x=>x.name===k);
          if(idx>=0) vars[idx]={...vars[idx],value:v};
          else vars.push({name:k,value:v,type:"fixed"});
        });
      }
      const r = await pool.query(
        "INSERT INTO test_runs (test_case_id,project_id,status,browser,triggered_by,run_by,parallel_run_id,parallel_label,variables,origin_server) VALUES ($1,$2,'queued',$3,'parallel',$4,$5,$6,$7,$8) RETURNING *",
        [t.id, t.project_id, cfg.browser||t.browser||"chrome", req.user.uid, parallelRunId, cfg.label||`Run ${i+1}`, JSON.stringify(vars), INSTANCE_ID]
      );
      runIds.push(r.rows[0].id);
    }
    res.json({ parallel_run_id:parallelRunId, run_ids:runIds });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/parallel-runs/:parallelRunId", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,status,browser,parallel_label,steps_passed,steps_failed,steps_total,duration_ms,created_at FROM test_runs WHERE parallel_run_id=$1 ORDER BY id ASC",
      [req.params.parallelRunId]
    );
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

app.get("/api/parallel-runs/:parallelRunId/report", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tr.*, tc.name as test_name FROM test_runs tr
       LEFT JOIN test_cases tc ON tr.test_case_id=tc.id
       WHERE tr.parallel_run_id=$1 ORDER BY tr.id ASC`,
      [req.params.parallelRunId]
    );
    if (!r.rows.length) return res.status(404).json({ error:"Parallel run not found" });
    const html = await generateParallelReport(req.params.parallelRunId, r.rows, r.rows[0].test_name||"Test");
    res.setHeader("Content-Type","text/html");
    res.send(html);
  } catch(err) { res.status(500).json({ error:err.message }); }
});


// ─── AI ROOT CAUSE ANALYSER ──────────────────────────────────────────────────
app.post("/api/runs/:id/analyse", requireAuth, async (req, res) => {
  try {
    const runId = req.params.id;

    // 1. Fetch run details + test case
    const runRes = await pool.query(`
      SELECT tr.*, tc.name as test_name, tc.type as test_type,
             tc.steps as test_steps, tc.base_url, tc.browser as tc_browser,
             p.name as project_name
      FROM test_runs tr
      LEFT JOIN test_cases tc ON tr.test_case_id = tc.id
      LEFT JOIN projects p ON tc.project_id = p.id
      WHERE tr.id = $1
    `, [runId]);
    if (!runRes.rows.length) return res.status(404).json({ error: "Run not found" });
    const run = runRes.rows[0];

    if (run.status !== "failed" && run.status !== "error")
      return res.status(400).json({ error: "Can only analyse failed or errored runs" });

    // 2. Fetch last 5 runs for same test (history context)
    const histRes = await pool.query(`
      SELECT id, status, created_at, duration_ms
      FROM test_runs
      WHERE test_case_id = $1 AND id != $2
      ORDER BY created_at DESC LIMIT 5
    `, [run.test_case_id, runId]);
    const history = histRes.rows;

    // 3. Extract key info from logs
    const logs = Array.isArray(run.logs) ? run.logs : [];
    const failedLogs  = logs.filter(l => l.level === "fail" || l.level === "error");
    const recentLogs  = logs.slice(-25);
    const steps       = Array.isArray(run.test_steps) ? run.test_steps : [];

    // 4. Find failed step index from logs
    let failedStepIdx = null;
    let failedStepMsg = "";
    for (const l of failedLogs) {
      if (l.step_index != null) { failedStepIdx = l.step_index; failedStepMsg = l.message; break; }
      if (!failedStepMsg) failedStepMsg = l.message || "";
    }

    // Context window: failed step + 1 before + 1 after
    const contextSteps = [];
    if (failedStepIdx != null) {
      if (failedStepIdx > 0) contextSteps.push({ pos: "before", ...steps[failedStepIdx - 1] });
      contextSteps.push({ pos: "FAILED", ...steps[failedStepIdx] });
      if (failedStepIdx < steps.length - 1) contextSteps.push({ pos: "after", ...steps[failedStepIdx + 1] });
    }

    // 5. Check for screenshot
    const screenshots = Array.isArray(run.screenshots) ? run.screenshots : [];
    let screenshotBase64 = null;
    let screenshotMediaType = "image/png";
    if (screenshots.length > 0) {
      const lastShot = screenshots[screenshots.length - 1];
      const shotPath = path.join(SCREENSHOTS_PATH, lastShot.filename || "");
      if (fs.existsSync(shotPath)) {
        const ext = path.extname(lastShot.filename || "").toLowerCase();
        if (ext === ".jpg" || ext === ".jpeg") screenshotMediaType = "image/jpeg";
        else if (ext === ".webp") screenshotMediaType = "image/webp";
        else screenshotMediaType = "image/png";
        // Verify file is valid image (not empty/corrupt)
        const stat = fs.statSync(shotPath);
        if (stat.size > 1000) {
          screenshotBase64 = fs.readFileSync(shotPath).toString("base64");
        } else {
          console.warn(`[analyse] Screenshot too small (${stat.size} bytes) — skipping`);
        }
      } else {
        console.warn(`[analyse] Screenshot file not found: ${shotPath} — skipping`);
      }
    }

    // 6. Build history summary
    const histSummary = history.length === 0 ? "No previous runs"
      : history.map(h => `Run #${h.id}: ${h.status} on ${new Date(h.created_at).toLocaleDateString()}`).join(", ");
    const wasPassingBefore = history.some(h => h.status === "passed");
    const flakeCount = history.filter(h => h.status !== run.status).length;

    // 7. Build prompt
    const prompt = `You are an expert test automation engineer. Analyse this failed automated test run and provide a detailed root cause analysis.

TEST INFORMATION:
- Test Name: ${run.test_name || "Unknown"}
- Test Type: ${run.test_type || "ui"}
- Browser: ${run.browser || "chrome"}
- Base URL: ${run.base_url || "not set"}
- Project: ${run.project_name || "Unknown"}
- Run Duration: ${run.duration_ms ? (run.duration_ms/1000).toFixed(2)+"s" : "unknown"}

RUN HISTORY (last 5):
${histSummary}
- Was passing before this failure: ${wasPassingBefore ? "YES" : "NO (never passed or no history)"}
- Flakiness indicator: ${flakeCount} of last 5 runs had different status

FAILED STEP DETAILS:
${failedStepIdx != null ? `Step index: ${failedStepIdx + 1} of ${steps.length}` : "Step index unknown"}
Error message: ${failedStepMsg || "No error message captured"}

STEP CONTEXT (steps around failure):
${contextSteps.length > 0 ? JSON.stringify(contextSteps, null, 2) : "Not available"}

RECENT EXECUTION LOGS (last 25 lines):
${recentLogs.map(l => "["+( l.level||"info").toUpperCase()+"] "+ (l.message||"")).join("\n")}

ALL FAILURE/ERROR LOGS:
${failedLogs.slice(0, 10).map(l => "["+(l.level||"error").toUpperCase()+"] "+(l.message||"")).join("\n")}

${screenshotBase64 ? "A screenshot was captured at the point of failure (attached)." : "No screenshot available."}

Please respond with ONLY valid JSON in this exact format:
{
  "summary": "One sentence summary of what went wrong",
  "category": "one of: selector_changed | timing_issue | data_mismatch | navigation_error | environment_issue | test_data_stale | regression | flaky | assertion_failure | configuration_error | unknown",
  "confidence": "one of: high | medium | low",
  "likely_cause": "2-4 sentences explaining the root cause in plain English",
  "evidence": ["evidence point 1", "evidence point 2", "evidence point 3"],
  "suggested_fix": "Specific actionable fix the developer should apply",
  "selector_suggestion": "If category is selector_changed, suggest a better selector. Otherwise null.",
  "is_regression": true or false,
  "is_flaky": true or false
}`;

    // 8. Call Claude API
    const messages = [{ role: "user", content: [] }];

    if (screenshotBase64) {
      messages[0].content.push({
        type: "image",
        source: { type: "base64", media_type: screenshotMediaType, data: screenshotBase64 }
      });
    }
    messages[0].content.push({ type: "text", text: prompt });

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ error: "AI analysis failed: " + err.slice(0, 200) });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.find(b => b.type === "text")?.text || "{}";

    // Parse JSON from response
    let analysis;
    try {
      const clean = rawText.replace(/```json|```/g, "").trim();
      analysis = JSON.parse(clean);
    } catch {
      analysis = {
        summary: "AI analysis completed but response could not be parsed",
        category: "unknown", confidence: "low",
        likely_cause: rawText.slice(0, 500),
        evidence: [], suggested_fix: "Review the logs manually",
        selector_suggestion: null, is_regression: false, is_flaky: false
      };
    }

    // Add run context to response
    res.json({
      ...analysis,
      run_id: runId,
      test_name: run.test_name,
      analysed_at: new Date().toISOString(),
      history_count: history.length,
      was_passing_before: wasPassingBefore,
    });

  } catch(err) {
    console.error("[Analyse]", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── AI TEST DATA GENERATOR ───────────────────────────────────────────────────
app.post("/api/ai/generate-test-data", requireAuth, async (req, res) => {
  try {
    const { form_description, profile, count, screenshot_base64 } = req.body;
    if (!form_description?.trim() && !screenshot_base64)
      return res.status(400).json({ error:"form_description or screenshot required" });

    const safeCount = Math.min(Math.max(parseInt(count)||5, 1), 20);

    const profileInstructions = {
      realistic:   "Generate realistic, production-like data that looks genuine. Use realistic Indian names, phone numbers, dates etc. where appropriate.",
      edge_cases:  "Generate edge case data: empty strings, maximum length values, special characters, unicode, leading/trailing spaces, very long strings.",
      boundary:    "Generate boundary values: minimum and maximum valid values, dates at boundaries (today, far future, far past), zero values, single characters.",
      invalid:     "Generate INVALID data to test validation: wrong formats, wrong types, out-of-range values, invalid emails, malformed dates, negative where positive expected.",
      mixed:       "Generate a mix: some realistic rows, some edge cases, some boundary values, and some invalid data. Label the type in a '_profile' field.",
    };

    const instruction = profileInstructions[profile] || profileInstructions.realistic;

    const prompt = `You are a test data generation expert. Generate exactly ${safeCount} rows of test data for the following form/feature.

FORM DESCRIPTION:
${form_description || "Form shown in the attached screenshot"}

DATA PROFILE INSTRUCTION:
${instruction}

RULES:
1. Return ONLY valid JSON — no markdown, no explanation, no backticks
2. Each row must have the SAME fields
3. Field names must be valid variable names (letters, numbers, underscores only, start with letter)
4. Keep values realistic for the described context
5. For Indian healthcare context: use Indian names, Indian mobile format (10 digits), DD/MM/YYYY dates
6. Include a "notes" string field at the top level explaining any important observations about the data
7. Respond with this exact structure:
{
  "notes": "Brief note about the generated data",
  "fields": ["field1", "field2", ...],
  "data": [
    { "field1": "value1", "field2": "value2", ... },
    ...
  ]
}`;

    const messages = [{ role:"user", content:[] }];
    if (screenshot_base64) {
      messages[0].content.push({
        type:"image",
        source:{ type:"base64", media_type:"image/png", data:screenshot_base64 }
      });
    }
    messages[0].content.push({ type:"text", text:prompt });

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version":"2023-06-01"
      },
      body: JSON.stringify({
        model:"claude-sonnet-4-6",
        max_tokens:4096,
        messages
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      return res.status(500).json({ error:"AI generation failed: " + err.slice(0,200) });
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content?.find(b=>b.type==="text")?.text || "{}";

    let parsed;
    try {
      const clean = rawText.replace(/```json|```/g,"").trim();
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error:"AI returned invalid JSON. Please try again." });
    }

    if (!parsed.data || !Array.isArray(parsed.data))
      return res.status(500).json({ error:"AI returned unexpected format. Please try again." });

    // Sanitize field names — replace spaces/special chars with underscores
    const sanitizeKey = k => k.replace(/[^a-zA-Z0-9_]/g,"_").replace(/^([0-9])/, "_$1");
    const rawFields = parsed.fields || (parsed.data[0] ? Object.keys(parsed.data[0]) : []);
    const fieldMap  = {}; // original → sanitized
    rawFields.forEach(f => { fieldMap[f] = sanitizeKey(f); });

    // Remap data rows to use sanitized keys
    const cleanData = parsed.data.slice(0, safeCount).map(row => {
      const clean = {};
      Object.entries(row).forEach(([k,v]) => { clean[fieldMap[k]||sanitizeKey(k)] = v; });
      return clean;
    });
    const cleanFields = rawFields.map(f => fieldMap[f]||sanitizeKey(f));

    res.json({
      data:   cleanData,
      fields: cleanFields,
      notes:  parsed.notes || "",
      profile,
      count:  cleanData.length,
      generated_at: new Date().toISOString(),
    });

  } catch(err) {
    console.error("[TestDataGen]", err.message);
    res.status(500).json({ error:err.message });
  }
});



// ─── EXTENSION CONFIG (public - no auth) ─────────────────────────────────────

// ─── SMART PAGE STUDY ────────────────────────────────────────────────────────
// ── Quick Scan Q&A — AI generates smart questions from page map ─────────────
// Visual Prompts — fetch/update user-editable prompts
app.get("/api/visual-prompts", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`SELECT match_level, prompt_text, updated_at FROM visual_prompts ORDER BY match_level`);
    res.json({ ok: true, prompts: r.rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.put("/api/visual-prompts/:matchLevel", requireAuth, async (req, res) => {
  const { matchLevel } = req.params;
  const { prompt_text } = req.body;
  try {
    await pool.query(
      `INSERT INTO visual_prompts (match_level, prompt_text, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (match_level) DO UPDATE SET prompt_text=$2, updated_at=NOW()`,
      [matchLevel, prompt_text]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/ai/quick-scan-questions", requireAuth, async (req, res) => {
  try {
    const { pageMap } = req.body;
    if (!pageMap) return res.status(400).json({ error: "pageMap required" });

    const fieldSummary = (pageMap.fields||[]).slice(0,20).map(f =>
      `"${f.label}" (${f.type}${f.required?' required':''}${f.options?.length?' opts:['+f.options.slice(0,3).join(',')+']':''})`
    ).join(', ');

    const prompt = `You are a test automation expert analysing a web form to generate a test script.

PAGE: ${pageMap.title} (${pageMap.pageType})
URL: ${pageMap.url}
FIELDS: ${fieldSummary}
BUTTONS: ${(pageMap.buttons||[]).map(b=>b.text).join(', ')}
TABS: ${(pageMap.tabs||[]).map(t=>t.label).join(', ')||'none'}
RADIO GROUPS: ${(pageMap.radioGroups||[]).map(g=>g.label+': ['+g.options.join('/')+']').join(', ')||'none'}

Generate 4-6 smart questions to ask the user BEFORE generating the test script.
Return ONLY a JSON array:
[{
"question": "clear question text",
"hint": "optional hint",
"multi": true,
"options": ["option1","option2"],
  "placeholder": "placeholder for free text"
}]
    Set multi:true when user should be able to select multiple options (e.g. which scenarios to cover).
    RESPOND ONLY WITH JSON ARRAY.`;

    const result = await callClaude({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });

    const raw = result.content?.map(c => c.text || '').join('') || '[]';
    const clean = raw.replace(/```json\n?|```\n?/g, '').trim();
    const questions = JSON.parse(clean);
    res.json({ ok: true, questions });
  } catch(e) {
    console.error('[QuickScanQ] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Text-only AI endpoint — no screenshots needed
app.post("/api/ai/generate-scripts", requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: "prompt required" });
    const result = await callClaude({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
    const text = result.content?.map(c => c.text || "").join("") || "";
    try {
      const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const start = clean.indexOf("[");
      const end = clean.lastIndexOf("]");
      if (start !== -1 && end !== -1) {
        const scripts = JSON.parse(clean.slice(start, end + 1));
        return res.json({ ok: true, scripts, raw: text });
      }
    } catch(e) {}
    res.json({ ok: true, scripts: [], raw: text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// WS-based page scanner — sends scan command to extension via existing WS connection
const pendingScans = new Map();

// ─── SMART STUDY 2.0 ──────────────────────────────────────────────────────────────────
// In-memory session store — no DB during recording, max 10 sessions, 30min TTL
const smartStudySessions = new Map();

function saveSessions() {} // no-op — sessions stored in memory only
const SS_MAX    = 10;
const SS_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Cleanup expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of smartStudySessions) {
    if (now - sess.lastActivity > SS_TTL_MS) {
      smartStudySessions.delete(id);
      console.log(`[SmartStudy] Session ${id} expired and cleaned up`);
    }
  }
}, 5 * 60 * 1000);

// 1. Start session — generate ID, tell extension to begin recording
app.post('/api/smart-study/session/start', requireAuth, (req, res) => {
  // Enforce max concurrent sessions.
  // Only sessions still actively 'recording' should count against the limit.
  // 'stopped' / 'processing' / 'done' sessions are finished and must NOT block
  // a new recording (otherwise every past recording eats a slot for 30 min and
  // you eventually get "Max concurrent smart study sessions reached").
  // Also opportunistically prune anything stale/finished so the Map can't fill
  // up with leftovers from MV3 service-worker restarts re-pushing old sessions.
  const now = Date.now();
  let activeRecording = 0;
  for (const [id, s] of smartStudySessions) {
    const finished = s.status && s.status !== 'recording';
    const stale    = now - (s.lastActivity || 0) > SS_TTL_MS;
    if (finished || stale) { smartStudySessions.delete(id); continue; }
    activeRecording++;
  }
  if (activeRecording >= SS_MAX) {
    return res.status(429).json({ error: 'Max concurrent smart study sessions reached. Try again shortly.' });
  }
  const sessionId = `ss_${Date.now()}_${req.user.id}`;
  smartStudySessions.set(sessionId, {
    userId:       req.user.id,
    createdAt:    Date.now(),
    lastActivity: Date.now(),
    events:       [],
    status:       'recording', // recording | stopped | processing | done
  });
  // The frontend messages the extension DIRECTLY via chrome.runtime.sendMessage
  // (per-user, targeted). Do NOT broadcast over the shared 'ext_runner' WS
  // channel — every user's extension subscribes to that same channel, so a
  // broadcast would start recording in EVERY connected user's browser under
  // this one user's session id, causing cross-talk and "No events captured".
  // broadcast('ext_runner', { type: 'smart_study_start', sessionId });
  console.log(`[SmartStudy] Session started: ${sessionId}`);
  res.json({ ok: true, sessionId });
});

// 1b. Push events — extension pushes captured events to server
app.post('/api/smart-study/session/:id/push-events', async (req, res) => {
  const sessionId = req.params.id;
  const { events } = req.body;
  // Find session by ID without auth check (extension doesn't have user token)
  const sess = smartStudySessions.get(sessionId);
  if (!sess) {
    // Session may have expired — create a temporary one to hold events.
    // Mark it 'stopped' (not 'recording') so it does NOT count against the
    // concurrent-session limit and gets pruned on the next start. A late push
    // from a restarted service worker should never consume a live slot.
    smartStudySessions.set(sessionId, {
      sessionId, userId: null, status: 'stopped',
      events: events || [], lastActivity: Date.now(), createdAt: Date.now()
    });
    return res.json({ ok: true, count: (events||[]).length });
  }
  if (events && events.length) {
    // Merge events, deduplicate by ts+action+selector
    const existing = new Set(sess.events.map(e => `${Math.round((e.ts||0)/100)}_${e.action}_${e.selector}`));
    const newEvs = events.filter(e => !existing.has(`${Math.round((e.ts||0)/100)}_${e.action}_${e.selector}`));
    sess.events.push(...newEvs);
    sess.lastActivity = Date.now();
    saveSessions();
  }
  res.json({ ok: true, count: sess.events.length });
});

// 1c. Get events — frontend fetches events after stop
app.get('/api/smart-study/session/:id/events', requireAuth, (req, res) => {
  const sess = smartStudySessions.get(req.params.id);
  if (!sess) return res.json({ ok: true, events: [] });
  res.json({ ok: true, events: sess.events || [] });
});

// 2. Stop session — tell extension to stop, trigger AI generation
app.post('/api/smart-study/session/:id/stop', requireAuth, async (req, res) => {
  const sessionId = req.params.id;
  const sess = smartStudySessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  // Allow if session has no userId (created by extension push) or matches user
  if (sess.userId && sess.userId !== req.user.id) return res.status(403).json({ error: 'Not your session' });

  // Extension is stopped directly by frontend — no need to broadcast via WS
  // broadcast('ext_runner', { type: 'smart_study_stop_ext', sessionId });
  sess.status = 'stopped';
  sess.lastActivity = Date.now();

  // Return all events collected so far to the frontend for client-side processing
  const events = sess.events;
  res.json({ ok: true, events, sessionId });

  // Free the concurrency slot now that recording has stopped. Keep the session
  // around briefly so a follow-up /generate (or a late event push) can still
  // find it, then remove it so it never counts toward SS_MAX again.
  setTimeout(() => {
    const s = smartStudySessions.get(sessionId);
    // Only delete if it didn't move on to processing/done in the meantime.
    if (s && (s.status === 'stopped')) smartStudySessions.delete(sessionId);
  }, 90000);
});

// 3. Generate — receive processed data from browser, call Claude, return script
app.post('/api/smart-study/session/:id/generate', requireAuth, async (req, res) => {
  const sessionId = req.params.id;
  const sess = smartStudySessions.get(sessionId);
  if (!sess) return res.status(404).json({ error: 'Session not found or expired' });
  if (sess.userId !== req.user.id) return res.status(403).json({ error: 'Not your session' });

  const { processedRecording } = req.body;
  if (!processedRecording) return res.status(400).json({ error: 'processedRecording is required' });

  sess.status = 'processing';
  sess.lastActivity = Date.now();

  try {
    // Build concise prompt from pre-processed data (browser did the heavy lifting)
    const prompt = buildSmartStudyPrompt(processedRecording);
    const result = await callClaude({
      model: 'claude-haiku-4-5-20251001', // fast + cheap for script gen
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = result?.content?.[0]?.text || '';
    // Parse JSON from response
    let scripts = [];
    try {
      const clean = raw.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      const si = clean.indexOf('['), ei = clean.lastIndexOf(']');
      if (si !== -1 && ei !== -1) scripts = JSON.parse(clean.slice(si, ei+1));
    } catch(e) {
      return res.status(500).json({ error: 'AI returned invalid JSON. Please try again.' });
    }
    sess.status = 'done';
    sess.lastActivity = Date.now();
    // Clean up session after successful generation (free memory)
    setTimeout(() => smartStudySessions.delete(sessionId), 60000); // keep 1 min for retry
    res.json({ ok: true, scripts });
  } catch(e) {
    sess.status = 'stopped'; // allow retry
    res.status(500).json({ error: e.message });
  }
});

function buildSmartStudyPrompt(rec) {
  const pages = rec.pages || [];
  const vars  = (rec.variables || []).filter(v => v.dynamic);
  const successCond = rec.successCondition;

  const pagesText = pages.map((p, pi) => {
    const steps = (p.steps || []).map((s, si) => {
      const varName = s.variable ? ` → {{${s.variable}}}` : '';
      const val     = s.dynamic ? `{{${s.variable}}} (example: "${s.example || s.value}")` : `"${s.value}"` ;
      const skip    = s.autoFilled ? ' [SKIP — auto-populated]' : '';
      return `  ${si+1}. ${s.action} | ${s.selector} | label:"${s.label}"${skip} | value:${val}`;
    }).join('\n');
    return `Page ${pi+1}: ${p.title} (${p.url})\n${steps}`;
  }).join('\n\n');

  const varsText = vars.map(v => `  {{${v.name}}}: ${v.type || 'string'} (example: "${v.example}")`).join('\n');

  const successText = successCond
    ? `SUCCESS: assert_text | ${successCond.selector} | contains "${successCond.text}"`
    : 'SUCCESS: verify URL changed or page loaded';

  return `You are generating an ATHMA test script for a Daiva Health Angular application (uses ng-select, formcontrolname attributes).

RECORDED FLOW:
${pagesText}

VARIABLES (dynamic values that change per run):
${varsText || '  (none — all values are static)'}

CRITICAL RULES:
1. Generate ONLY the steps in RECORDED FLOW above - do NOT invent extra steps
2. Do NOT add Register, Save, Submit or any button unless it is in the recorded steps
3. Do NOT add assert/verify steps unless recorded
4. Use search_select action for ng-select dropdowns
5. Add wait_for_selector before every click, type, search_select
6. Skip steps marked [SKIP - auto-populated]
7. Use {{variable_name}} syntax for dynamic values
8. First step must be navigate to first page URL

Return ONLY a valid JSON array with ONE test script:
[{
  "name": "<PageType>_HappyPath",
  "description": "<one line description>",
  "steps": [
    {"action":"navigate","selector":"","value":"<url>","timeout":30000},
    {"action":"wait_for_selector","selector":"<selector>","value":"","timeout":15000},
    {"action":"type","selector":"<selector>","value":"<value>","timeout":15000}
  ]
}]`;
}

// WebSocket: receive events from extension and relay to frontend
// Added to the existing wss connection handler
wss.on('connection', (ws, req) => {
  const ssId = new URL(req.url, 'http://localhost').searchParams.get('smartStudyId');
  if (ssId) {
    const key = 'ss_' + ssId;
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(ws);
    ws.on('close', () => clients.get(key)?.delete(ws));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'smart_study_event' && msg.sessionId) {
          // Store events in session
          const sess = smartStudySessions.get(msg.sessionId);
          if (sess) {
            sess.events.push(...(msg.events || []));
            sess.lastActivity = Date.now();
            // Cap at 500 events per session
            if (sess.events.length > 500) sess.events = sess.events.slice(-500);
          }
          // Relay to frontend subscribers for live display
          broadcast('ss_' + msg.sessionId, { type: 'smart_study_event', events: msg.events });
        }
      } catch(e) {}
    });
  }
});

// ─── END SMART STUDY 2.0 ──────────────────────────────────────────────────────────────────

app.post("/api/smart-study/scan", requireAuth, async (req, res) => {
  try {
    const scanId = "scan_" + Date.now();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingScans.delete(scanId);
        reject(new Error("Scan timeout — make sure the extension is active and the target page is open in Chrome."));
      }, 20000);
      pendingScans.set(scanId, { resolve, reject, timer });
    });
    res.json({ ok: true, result });
  } catch(e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

// Extension polls this endpoint to get pending scan requests
app.get("/api/smart-study/poll", async (req, res) => {
  // Find first pending scan that isn't already being processed
  for (const [scanId, entry] of pendingScans.entries()) {
    if (!entry.processing) {
      entry.processing = true; // mark so it won't be returned again
      return res.json({ pending: true, scanId });
    }
  }
  res.json({ pending: false });
});

// Handle scan result from extension
app.post("/api/smart-study/scan-result", async (req, res) => {
  const { scanId, result, error } = req.body;
  const pending = pendingScans.get(scanId);
  if (!pending) return res.json({ ok: false });
  clearTimeout(pending.timer);
  pendingScans.delete(scanId);
  if (error) pending.reject(new Error(error));
  else pending.resolve(result);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// VISUAL SCAN  (NEW, ISOLATED — direct-message model, no poll queue)
// The UI sends the screenshot (captured directly from the user's own browser)
// plus the Figma frame URL + token. We write the PNG to a temp file, run the
// standalone compare script, and return its JSON report. Touches nothing else.
// ═══════════════════════════════════════════════════════════════════════════
const VISUAL_SCAN_SCRIPT = path.join(__dirname, "../runner/visual_quick_scan.py");
app.post("/api/visual/compare", requireAuth, async (req, res) => {
  const { screenshot, figmaUrl, figmaToken, matchLevel, threshold } = req.body || {};
  if (!screenshot) return res.status(400).json({ ok: false, error: "screenshot required" });
  if (!figmaUrl || !figmaToken) return res.status(400).json({ ok: false, error: "figmaUrl and figmaToken are required" });

  let shotPath = null;
  try {
    const b64 = String(screenshot).replace(/^data:image\/\w+;base64,/, "");
    shotPath = path.join(LOGS_PATH, `vscan_${Date.now()}_${Math.floor(Math.random()*1e6)}.png`);
    fs.writeFileSync(shotPath, Buffer.from(b64, "base64"));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Failed to save screenshot: " + e.message });
  }

  const argv = [
    VISUAL_SCAN_SCRIPT,
    "--screenshot", shotPath,
    "--figma-url", figmaUrl,
    "--figma-token", figmaToken,
    "--match-level", String(matchLevel || "ai"),
    "--threshold", String(threshold != null ? threshold : 5),
  ];
  const proc = spawn(PYTHON_CMD, argv, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  let out = "", errOut = "", done = false;
  const finish = (code, body) => {
    if (done) return; done = true;
    try { fs.unlinkSync(shotPath); } catch (e) {}
    res.status(code).json(body);
  };
  proc.stdout.on("data", d => { out += d.toString(); });
  proc.stderr.on("data", d => { errOut += d.toString(); });
  proc.on("error", (err) => finish(503, { ok: false, error: "Compare process failed to start: " + err.message }));
  proc.on("close", () => {
    let report = null;
    try {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      report = JSON.parse(line);
    } catch (e) {
      return finish(503, { ok: false, error: "Could not parse compare output. " + (errOut.slice(0, 300) || "") });
    }
    if (report && report.ok === false) return finish(200, { ok: false, error: report.error || "compare failed" });
    finish(200, { ok: true, report });
  });
  // Safety timeout
  setTimeout(() => { if (!done) { try { proc.kill(); } catch(e){} finish(504, { ok: false, error: "Compare timed out" }); } }, 90000);
});

// ─── KEYWORD ADVISOR ────────────────────────────────────────────────
app.post("/api/keyword-advisor", requireAuth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: "Query required" });
    const KEYWORDS_SUMMARY = [
      { action: "navigate",           desc: "Open a URL",                                                  when: "open a page, go to a URL" },
      { action: "click",              desc: "Click any element",                                           when: "click a button, link, tab" },
      { action: "type",               desc: "Type text into an input field",                               when: "enter text, fill a field" },
      { action: "select",             desc: "Select from a native dropdown",                               when: "choose from a select/dropdown" },
      { action: "search_select",      desc: "Type in search box and pick from autocomplete",               when: "ng-select, autocomplete, typeahead" },
      { action: "press",              desc: "Press a keyboard key",                                        when: "press Enter, Tab, Escape" },
      { action: "press_sequentially", desc: "Type letter by letter for debounced inputs",                  when: "Angular input, search triggers on keystroke" },
      { action: "wait",               desc: "Wait for N milliseconds",                                     when: "pause, delay, sleep" },
      { action: "wait_for_selector",  desc: "Wait until element appears",                                  when: "wait for element to load" },
      { action: "assert_text",        desc: "Verify element contains text",                                when: "check text on page, verify message" },
      { action: "assert_visible",     desc: "Verify element is visible",                                   when: "check if element is shown" },
      { action: "assert_not_visible", desc: "Verify element is hidden",                                    when: "check if element disappeared" },
      { action: "assert_url",         desc: "Verify current URL contains string",                          when: "check page URL" },
      { action: "assert_equals",      desc: "Check variable equals expected value",                        when: "compare two values" },
      { action: "store_text",         desc: "Read element text and save to variable",                      when: "get text of element" },
      { action: "store_value",        desc: "Read input field value and save to variable",                 when: "get value from input" },
      { action: "store_attr",         desc: "Read HTML attribute and save to variable",                    when: "get href, data-id, class" },
      { action: "db_validate",        desc: "Run SQL query, assert or store result",                       when: "query database, check DB value" },
      { action: "db_extract_multi",   desc: "SQL query storing multiple columns into variables",           when: "get multiple DB values at once" },
      { action: "json_extract",       desc: "Extract value from JSON using dot-path",                      when: "get field from JSON, API response" },
      { action: "json_multi_extract", desc: "Extract multiple values from JSON at once",                   when: "get multiple JSON fields" },
      { action: "json_array_get",     desc: "Get array item by index",                                     when: "get first or last item from array" },
      { action: "json_array_length",  desc: "Count items in JSON array",                                   when: "how many items in array" },
      { action: "json_array_filter",  desc: "Find array item where key equals value",                      when: "search within JSON array" },
      { action: "json_contains",      desc: "Assert JSON path exists or equals value",                     when: "verify JSON field value" },
      { action: "json_build",         desc: "Build JSON object from key-value pairs",                      when: "create request body" },
      { action: "if_start",           desc: "Conditional steps based on variable value",                   when: "only if condition is true" },
      { action: "loop_start",         desc: "Repeat steps N times",                                        when: "repeat, loop, iterate" },
      { action: "foreach_start",      desc: "Repeat steps for each item in a list",                        when: "for each value in list" },
      { action: "str_concat",         desc: "Combine two strings",                                         when: "join text, combine values" },
      { action: "str_replace",        desc: "Replace part of a string",                                    when: "modify string" },
      { action: "math_add",           desc: "Add two numbers",                                             when: "add, increment, calculate" },
    ];
    const prompt = `You are an expert on ATHMA automation tool. User wants to know which keyword to use.\n\nKeywords:\n${KEYWORDS_SUMMARY.map(k=>`- ${k.action}: ${k.desc}. Use when: ${k.when}`).join('\n')}\n\nUser question: "${query.trim()}"\n\nRespond ONLY with compact JSON (keep all strings under 80 chars):\n{"summary":"one sentence","keywords":[{"action":"name","reason":"why (short)","fields":[{"name":"Field","what_to_pass":"what to enter","example":"short example"}],"full_example":"short full example"}]}`;
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY||"", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: prompt }] })
    });
    if (!claudeRes.ok) { const err = await claudeRes.text(); return res.status(500).json({ error: "AI failed: "+err.slice(0,200) }); }
    const data = await claudeRes.json();
    const raw = data.content?.find(b=>b.type==="text")?.text || "{}";
    // Robustly extract JSON — find first { to last }
    const cleaned = raw.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
    const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error("No JSON in AI response");
    res.json(JSON.parse(cleaned.slice(s, e+1)));
  } catch(err) {
    console.error("[KeywordAdvisor]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── KEYWORD ADVISOR SMART (knowledge base first, then enrich with real test examples) ─────
app.post("/api/keyword-advisor-smart", requireAuth, async (req, res) => {
  try {
    const { query, project_id } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: "Query required" });

    // Full knowledge base — source of truth for all field definitions
    const KB = {
      navigate:           { label: "Navigate to URL",           group: "UI Actions",    fields: [{n:"URL",           h:"Full URL e.g. https://example.com or {{base_url}}/login"}] },
      click:              { label: "Click element",             group: "UI Actions",    fields: [{n:"Selector",      h:"CSS selector or Playwright locator for the element"}] },
      type:               { label: "Type text",                 group: "UI Actions",    fields: [{n:"Selector",      h:"The input field"},{n:"Value",h:"Text to type — supports {{variables}}"}] },
      clear:              { label: "Clear field",               group: "UI Actions",    fields: [{n:"Selector",      h:"The input field to clear"}] },
      select:             { label: "Select option",             group: "UI Actions",    fields: [{n:"Selector",      h:"The select element"},{n:"Value",h:"Option value or label"}] },
      search_select:      { label: "Search & Select",           group: "UI Actions",    fields: [{n:"Selector",      h:"The search input or ng-select"},{n:"Search text",h:"Text to filter"},{n:"Value",h:"Option to click"}] },
      check:              { label: "Check checkbox",            group: "UI Actions",    fields: [{n:"Selector",      h:"The checkbox element"}] },
      uncheck:            { label: "Uncheck checkbox",          group: "UI Actions",    fields: [{n:"Selector",      h:"The checkbox element"}] },
      hover:              { label: "Hover element",             group: "UI Actions",    fields: [{n:"Selector",      h:"Element to hover over"}] },
      press:              { label: "Press key",                 group: "UI Actions",    fields: [{n:"Selector",      h:"Element to focus (optional)"},{n:"Value",h:"Key e.g. Enter, Tab, Escape"}] },
      press_sequentially: { label: "Type letter by letter",    group: "UI Actions",    fields: [{n:"Selector",      h:"The input field"},{n:"Value",h:"Text to type letter by letter"}] },
      execute_script:     { label: "Execute JS",               group: "UI Actions",    fields: [{n:"Value",          h:"JavaScript to run e.g. window.scrollTo(0,500)"},{n:"Store as",h:"Variable name for return value (optional)"}] },
      scroll:             { label: "Scroll to Y",              group: "UI Actions",    fields: [{n:"Value",          h:"Y position in pixels e.g. 1000"}] },
      download:           { label: "Download",                  group: "UI Actions",    fields: [{n:"Selector",      h:"Download button or link"}] },
      drag_and_drop:      { label: "Drag and Drop",             group: "UI Actions",    fields: [{n:"Selector",      h:"Element to drag"},{n:"Value",h:"Drop target selector"}] },
      focus:              { label: "Focus element",             group: "UI Actions",    fields: [{n:"Selector",      h:"Element to focus"}] },
      blur:               { label: "Blur element",              group: "UI Actions",    fields: [{n:"Selector",      h:"Element to blur"}] },
      double_click:       { label: "Double Click",              group: "UI Actions",    fields: [{n:"Selector",      h:"Element to double-click"}] },
      right_click:        { label: "Right Click",               group: "UI Actions",    fields: [{n:"Selector",      h:"Element to right-click"}] },
      upload_attachment:  { label: "Upload File",               group: "UI Actions",    fields: [{n:"Selector",      h:"File input element"},{n:"Value",h:"Full file path"}] },
      wait:               { label: "Wait (ms)",                 group: "Waits",         fields: [{n:"Value",          h:"Milliseconds e.g. 2000"}] },
      wait_for_selector:  { label: "Wait for element",         group: "Waits",         fields: [{n:"Selector",      h:"Element to wait for"}] },
      wait_for_url:       { label: "Wait for URL",             group: "Waits",         fields: [{n:"Value",          h:"URL substring e.g. /dashboard"}] },
      wait_until:         { label: "Wait Until condition",     group: "Waits",         fields: [{n:"Variable",      h:"Variable to check e.g. {{status}}"},{n:"Operator",h:"equals/contains/not_equals"},{n:"Value",h:"Expected value"}] },
      assert_text:        { label: "Assert text contains",     group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"},{n:"Value",h:"Expected text (partial match)"}] },
      assert_not_text:    { label: "Assert text NOT contains", group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"},{n:"Value",h:"Text that should NOT be present"}] },
      assert_visible:     { label: "Assert element visible",   group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"}] },
      assert_not_visible: { label: "Assert element hidden",    group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"}] },
      assert_enabled:     { label: "Assert element enabled",   group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"}] },
      assert_disabled:    { label: "Assert element disabled",  group: "Assertions",    fields: [{n:"Selector",      h:"Element to check"}] },
      assert_checked:     { label: "Assert checkbox checked",  group: "Assertions",    fields: [{n:"Selector",      h:"Checkbox element"}] },
      assert_not_checked: { label: "Assert checkbox unchecked",group: "Assertions",    fields: [{n:"Selector",      h:"Checkbox element"}] },
      assert_selected:    { label: "Assert option selected",   group: "Assertions",    fields: [{n:"Selector",      h:"Select element"},{n:"Value",h:"Expected selected option"}] },
      assert_attribute:   { label: "Assert attribute value",   group: "Assertions",    fields: [{n:"Selector",      h:"Element"},{n:"Attribute",h:"Attribute name e.g. class, href"},{n:"Value",h:"Expected value"}] },
      assert_css:         { label: "Assert CSS property",      group: "Assertions",    fields: [{n:"Selector",      h:"Element"},{n:"Property",h:"CSS property e.g. color"},{n:"Value",h:"Expected value"}] },
      assert_cookie:      { label: "Assert cookie",            group: "Assertions",    fields: [{n:"Value",          h:"Cookie name"},{n:"Value 2",h:"Expected cookie value"}] },
      assert_url:         { label: "Assert URL contains",      group: "Assertions",    fields: [{n:"Value",          h:"URL substring to check"}] },
      assert_title:       { label: "Assert page title",        group: "Assertions",    fields: [{n:"Value",          h:"Expected title text"}] },
      assert_value:       { label: "Assert input value",       group: "Assertions",    fields: [{n:"Selector",      h:"Input field"},{n:"Value",h:"Expected value"}] },
      assert_count:       { label: "Assert element count",     group: "Assertions",    fields: [{n:"Selector",      h:"Elements to count"},{n:"Value",h:"Expected count e.g. 3"}] },
      assert_equals:      { label: "Assert equals",            group: "Assert Vars",   fields: [{n:"Value",          h:"Variable e.g. {{status}}"},{n:"Value 2",h:"Expected value"}] },
      assert_not_equals:  { label: "Assert not equals",        group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Value it should NOT equal"}] },
      assert_contains:    { label: "Assert contains",          group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Substring to find"}] },
      assert_not_contains:{ label: "Assert not contains",      group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Text that should NOT be present"}] },
      assert_starts_with: { label: "Assert starts with",       group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Expected prefix"}] },
      assert_ends_with:   { label: "Assert ends with",         group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Expected suffix"}] },
      assert_greater:     { label: "Assert greater than",      group: "Assert Vars",   fields: [{n:"Value",          h:"Variable with number"},{n:"Value 2",h:"Threshold"}] },
      assert_less:        { label: "Assert less than",          group: "Assert Vars",   fields: [{n:"Value",          h:"Variable with number"},{n:"Value 2",h:"Threshold"}] },
      assert_between:     { label: "Assert between",           group: "Assert Vars",   fields: [{n:"Value",          h:"Variable"},{n:"Value 2",h:"Min"},{n:"Value 3",h:"Max"}] },
      assert_soft:        { label: "Soft Assert",              group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Operator",h:"equals/contains"},{n:"Value 2",h:"Expected"}] },
      assert_matches:     { label: "Assert matches regex",     group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"},{n:"Value 2",h:"Regex pattern e.g. ^APT-\\d+"}] },
      assert_empty:       { label: "Assert is empty",          group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"}] },
      assert_not_empty:   { label: "Assert not empty",         group: "Assert Vars",   fields: [{n:"Value",          h:"Variable to check"}] },
      store_text:         { label: "Store element text",       group: "Store",         fields: [{n:"Selector",      h:"Element whose text you want"},{n:"Store as",h:"Variable name e.g. patient_name"}] },
      store_value:        { label: "Store input value",        group: "Store",         fields: [{n:"Selector",      h:"Input field"},{n:"Store as",h:"Variable name"}] },
      store_attr:         { label: "Store attribute",          group: "Store",         fields: [{n:"Selector",      h:"Element"},{n:"Value",h:"Attribute name e.g. href, data-id"},{n:"Store as",h:"Variable name"}] },
      store_url:          { label: "Store current URL",        group: "Store",         fields: [{n:"Store as",       h:"Variable name e.g. current_url"}] },
      store_title:        { label: "Store page title",         group: "Store",         fields: [{n:"Store as",       h:"Variable name"}] },
      store_count:        { label: "Store element count",      group: "Store",         fields: [{n:"Selector",      h:"Elements to count"},{n:"Store as",h:"Variable name"}] },
      store_js:           { label: "Store JS result",          group: "Store",         fields: [{n:"Value",          h:"JavaScript returning a value e.g. return document.title"},{n:"Store as",h:"Variable name"}] },
      get_table_value:    { label: "Get table value by label", group: "Store",         fields: [{n:"Selector",      h:"Table element"},{n:"Value",h:"Row label to look up"},{n:"Store as",h:"Variable name"}] },
      db_validate:        { label: "DB Validate Query",        group: "Database",      fields: [{n:"Connection",    h:"Saved connection name"},{n:"Query",h:"SQL query — use {{variables}}"},{n:"Validation type",h:"equals/contains/store/row_count/not_empty"},{n:"Store as",h:"Variable name (for store type)"}] },
      db_extract_multi:   { label: "DB Extract Multi Columns", group: "Database",      fields: [{n:"Connection",    h:"Saved connection name"},{n:"Query",h:"SELECT col1, col2 FROM table LIMIT 1"},{n:"Mappings",h:"column name → variable name pairs"}] },
      json_extract:       { label: "JSON Extract (dot-path)",  group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON e.g. JSON_OBJ"},{n:"Dot-path",h:"Path to value e.g. patient.mrn or hsc.id"},{n:"Store as",h:"Variable name for result"}] },
      json_multi_extract: { label: "JSON Extract Multiple",    group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Mappings",h:"dot-path → variable name pairs"}] },
      json_array_get:     { label: "JSON Array Get (by index)",group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Array path",h:"Path to array e.g. activityTimings"},{n:"Index",h:"0=first, 1=second, -1=last"},{n:"Store as",h:"Variable name"}] },
      json_array_length:  { label: "JSON Array Length",        group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Array path",h:"Path to array e.g. invoiceItems"},{n:"Store as",h:"Variable name for count"}] },
      json_array_filter:  { label: "JSON Array Filter",        group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Array path",h:"Path to array"},{n:"Where key",h:"Key to match e.g. status"},{n:"Where value",h:"Value to find e.g. IN_PROGRESS"},{n:"Store as",h:"Variable for matched item"}] },
      json_contains:      { label: "JSON Contains (assert)",   group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Path",h:"Dot-path e.g. consultationStatus"},{n:"Expected value",h:"Leave blank to just check existence"}] },
      json_build:         { label: "JSON Build object",        group: "JSON",          fields: [{n:"Store as",       h:"Variable for built JSON"},{n:"Key-value pairs",h:"key=value using {{variables}}"}] },
      json_set:           { label: "JSON Set value at path",   group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Dot-path",h:"Path to set e.g. patient.status"},{n:"New value",h:"Value to set"},{n:"Store as",h:"Variable for updated JSON"}] },
      json_stringify:     { label: "JSON Stringify",           group: "JSON",          fields: [{n:"Source variable",h:"Variable to stringify"},{n:"Store as",h:"Variable name"}] },
      json_keys:          { label: "JSON Get keys",            group: "JSON",          fields: [{n:"Source variable",h:"Variable holding the JSON"},{n:"Store as",h:"Variable for comma-separated keys"}] },
      if_start:           { label: "IF condition",             group: "Control Flow",  fields: [{n:"Variable",      h:"Variable to check e.g. {{status}}"},{n:"Operator",h:"equals/contains/not_equals/greater/less"},{n:"Value",h:"Value to compare"}] },
      else:               { label: "ELSE",                     group: "Control Flow",  fields: [] },
      if_end:             { label: "END IF",                   group: "Control Flow",  fields: [] },
      loop_start:         { label: "Loop Start",               group: "Control Flow",  fields: [{n:"Count",          h:"Number of times to repeat"}] },
      loop_end:           { label: "Loop End",                  group: "Control Flow",  fields: [] },
      foreach_start:      { label: "For Each (list)",          group: "Control Flow",  fields: [{n:"List variable",  h:"Variable with comma-separated values"},{n:"Item variable",h:"Variable for current item"}] },
      foreach_end:        { label: "For Each End",             group: "Control Flow",  fields: [] },
      switch_start:       { label: "SWITCH (variable)",        group: "Control Flow",  fields: [{n:"Variable",      h:"Variable whose value determines the case"}] },
      case:               { label: "CASE value",               group: "Control Flow",  fields: [{n:"Value",          h:"The case value to match"}] },
      switch_end:         { label: "END SWITCH",               group: "Control Flow",  fields: [] },
      break:              { label: "Break loop",               group: "Control Flow",  fields: [] },
      continue:           { label: "Continue",                 group: "Control Flow",  fields: [] },
      repeat_until:       { label: "Repeat Until condition",   group: "Control Flow",  fields: [{n:"Variable",      h:"Variable to check"},{n:"Operator",h:"equals/contains"},{n:"Value",h:"Target value"}] },
      try_start:          { label: "Try block",                group: "Control Flow",  fields: [] },
      catch_start:        { label: "Catch (on error)",         group: "Control Flow",  fields: [] },
      try_end:            { label: "End Try/Catch",            group: "Control Flow",  fields: [] },
      str_upper:          { label: "String UPPER",             group: "String Ops",    fields: [{n:"Value",          h:"Variable to convert"},{n:"Store as",h:"Variable name"}] },
      str_lower:          { label: "String lower",             group: "String Ops",    fields: [{n:"Value",          h:"Variable to convert"},{n:"Store as",h:"Variable name"}] },
      str_trim:           { label: "String trim",              group: "String Ops",    fields: [{n:"Value",          h:"Variable to trim"},{n:"Store as",h:"Variable name"}] },
      str_replace:        { label: "String replace",           group: "String Ops",    fields: [{n:"Value",          h:"Source variable"},{n:"Value 2",h:"Text to find"},{n:"Value 3",h:"Replace with"},{n:"Store as",h:"Variable name"}] },
      str_substring:      { label: "String substring",         group: "String Ops",    fields: [{n:"Value",          h:"Source variable"},{n:"Value 2",h:"Start index (0-based)"},{n:"Value 3",h:"End index"},{n:"Store as",h:"Variable name"}] },
      str_concat:         { label: "String concat",            group: "String Ops",    fields: [{n:"Value",          h:"First string or {{var}}"},{n:"Value 2",h:"Second string"},{n:"Store as",h:"Variable name"}] },
      str_length:         { label: "String length",            group: "String Ops",    fields: [{n:"Value",          h:"Variable to measure"},{n:"Store as",h:"Variable name"}] },
      str_split:          { label: "String split",             group: "String Ops",    fields: [{n:"Value",          h:"Source variable"},{n:"Value 2",h:"Separator e.g. ,"},{n:"Value 3",h:"Part index 0=first"},{n:"Store as",h:"Variable name"}] },
      math_add:           { label: "Math add",                 group: "Math Ops",      fields: [{n:"Value",          h:"First number or {{var}}"},{n:"Value 2",h:"Second number"},{n:"Store as",h:"Variable name"}] },
      math_subtract:      { label: "Math subtract",            group: "Math Ops",      fields: [{n:"Value",          h:"First number"},{n:"Value 2",h:"Subtract this"},{n:"Store as",h:"Variable name"}] },
      math_multiply:      { label: "Math multiply",            group: "Math Ops",      fields: [{n:"Value",          h:"First number"},{n:"Value 2",h:"Multiplier"},{n:"Store as",h:"Variable name"}] },
      math_divide:        { label: "Math divide",              group: "Math Ops",      fields: [{n:"Value",          h:"Dividend"},{n:"Value 2",h:"Divisor"},{n:"Store as",h:"Variable name"}] },
      math_round:         { label: "Math round",               group: "Math Ops",      fields: [{n:"Value",          h:"Number to round"},{n:"Value 2",h:"Decimal places"},{n:"Store as",h:"Variable name"}] },
      math_abs:           { label: "Math absolute value",      group: "Math Ops",      fields: [{n:"Value",          h:"Number"},{n:"Store as",h:"Variable name"}] },
      math_random:        { label: "Random number in range",   group: "Math Ops",      fields: [{n:"Value",          h:"Min"},{n:"Value 2",h:"Max"},{n:"Store as",h:"Variable name"}] },
      date_today:         { label: "Store today's date",       group: "Date Ops",      fields: [{n:"Value",          h:"Format e.g. DD-MM-YYYY"},{n:"Store as",h:"Variable name"}] },
      date_now:           { label: "Store current datetime",   group: "Date Ops",      fields: [{n:"Value",          h:"Format e.g. DD-MM-YYYY HH:mm"},{n:"Store as",h:"Variable name"}] },
      date_add:           { label: "Date add days",            group: "Date Ops",      fields: [{n:"Value",          h:"Source date variable"},{n:"Value 2",h:"Format"},{n:"Value 3",h:"Days to add"},{n:"Store as",h:"Variable name"}] },
      date_subtract:      { label: "Date subtract days",       group: "Date Ops",      fields: [{n:"Value",          h:"Source date variable"},{n:"Value 2",h:"Format"},{n:"Value 3",h:"Days to subtract"},{n:"Store as",h:"Variable name"}] },
      date_format:        { label: "Date format",              group: "Date Ops",      fields: [{n:"Value",          h:"Source date variable"},{n:"Value 2",h:"Input format"},{n:"Value 3",h:"Output format"},{n:"Store as",h:"Variable name"}] },
      date_diff:          { label: "Date difference (days)",   group: "Date Ops",      fields: [{n:"Value",          h:"First date"},{n:"Value 2",h:"Format"},{n:"Value 3",h:"Second date"},{n:"Store as",h:"Variable name"}] },
      encode_base64:      { label: "Encode base64",            group: "Encode/Parse",  fields: [{n:"Value",          h:"String to encode"},{n:"Store as",h:"Variable name"}] },
      decode_base64:      { label: "Decode base64",            group: "Encode/Parse",  fields: [{n:"Value",          h:"Base64 string"},{n:"Store as",h:"Variable name"}] },
      url_encode:         { label: "URL encode",               group: "Encode/Parse",  fields: [{n:"Value",          h:"String to encode"},{n:"Store as",h:"Variable name"}] },
      json_parse:         { label: "JSON parse string",        group: "Encode/Parse",  fields: [{n:"Value",          h:"Variable with JSON string"},{n:"Store as",h:"Variable name"}] },
      refresh:            { label: "Refresh page",             group: "Browser",       fields: [] },
      back:               { label: "Go Back",                  group: "Browser",       fields: [] },
      forward:            { label: "Go Forward",               group: "Browser",       fields: [] },
      switch_frame:       { label: "Switch to Frame",          group: "Browser",       fields: [{n:"Selector",      h:"The iframe element"}] },
      switch_window:      { label: "Switch Window",            group: "Browser",       fields: [{n:"Value",          h:"Window index or title substring"}] },
      close_window:       { label: "Close Window",             group: "Browser",       fields: [] },
      set_cookie:         { label: "Set Cookie",               group: "Browser",       fields: [{n:"Value",          h:"Cookie name"},{n:"Value 2",h:"Cookie value"}] },
      clear_cookie:       { label: "Clear Cookie",             group: "Browser",       fields: [{n:"Value",          h:"Cookie name to remove"}] },
      group:              { label: "Group / Comment",          group: "Misc",          fields: [{n:"Value",          h:"Group label or comment text"}] },
      call_test:          { label: "Call Test Case",           group: "Misc",          fields: [{n:"Value",          h:"Test case name to call"}] },
      screenshot:         { label: "Take screenshot",          group: "Misc",          fields: [] },
    };

    // ── Step 1: Ask Claude ONLY for action names (tiny response, never truncated)
    const actionList = Object.keys(KB).join(', ');
    const prompt = `You are an ATHMA automation expert. Given the available actions, pick the 1-3 best matching ones for the user's question.

Available actions: ${actionList}

User question: "${query.trim()}"

Respond with ONLY a JSON object like this (no other text):
{"actions":["action1","action2"],"summary":"one sentence answer","why":{"action1":"why it fits","action2":"why it fits"}}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY||"", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, messages: [{ role: "user", content: prompt }] })
    });

    if (!aiRes.ok) throw new Error(`AI failed: ${aiRes.status}`);
    const aiData = await aiRes.json();
    const raw = aiData.content?.find(b => b.type === "text")?.text || "{}";

    let aiParsed = { actions: [], summary: "", why: {} };
    try {
      const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
      aiParsed = JSON.parse(cleaned.slice(s, e + 1));
    } catch(err) {
      console.error("[smart] parse error:", err.message);
    }

    // ── Step 2: Build full answers from KB (no AI needed for fields) ────────────
    const answers = (aiParsed.actions || []).map(action => {
      const kbEntry = KB[action];
      if (!kbEntry) return null;
      return {
        action,
        headline: aiParsed.why?.[action] || kbEntry.label,
        from_test: null,
        fields: kbEntry.fields.map(f => ({
          name:           f.n,
          what_to_select: f.h,
          proven_value:   "",
          why:            ""
        })),
        real_examples: [],
      };
    }).filter(Boolean);

    // ── Step 3: Fetch passed test steps and attach real examples ────────────
    try {
      const runsQ = await pool.query(`
        SELECT DISTINCT ON (tc.id) tc.name as test_name, tc.steps
        FROM test_runs tr
        JOIN test_cases tc ON tc.id = tr.test_case_id
        WHERE tr.status = 'passed'
          AND ($1::int IS NULL OR tr.project_id = $1)
          AND tr.created_at > NOW() - INTERVAL '90 days'
          AND tc.steps IS NOT NULL
        ORDER BY tc.id, tr.created_at DESC
        LIMIT 150
      `, [project_id || null]);

      const byAction = {};
      for (const row of runsQ.rows) {
        const steps = Array.isArray(row.steps) ? row.steps : [];
        for (const step of steps) {
          if (!step.action) continue;
          if (!byAction[step.action]) byAction[step.action] = [];
          byAction[step.action].push({ test_name: row.test_name, step });
        }
      }

      const MAX_EXAMPLES_PER_ACTION = 8;
      for (const answer of answers) {
        const matches = byAction[answer.action] || [];
        const built = matches.map(({ test_name, step }) => {
          const ex = { test_name, fields: {} };
          if (step.selector)  ex.fields['Selector']  = step.selector;
          if (step.value && !String(step.value).startsWith('http')) ex.fields['Value'] = step.value;
          if (step.value2)    ex.fields['Path']       = step.value2;
          if (step.value3)    ex.fields['Value 3']    = step.value3;
          if (step.store_as)  ex.fields['Store as']   = step.store_as;
          if (step.db_config?.query) ex.fields['Query'] = step.db_config.query.slice(0, 120);
          if (Array.isArray(step.json_mappings) && step.json_mappings.length)
            ex.fields['Mappings'] = step.json_mappings.map(m => `${m.path}→${m.variable}`).join(', ');
          return ex;
        });
        // De-dupe identical examples (same field values across different steps/tests)
        // so the list isn't padded with near-identical repeats — keeps variety.
        const seen = new Set();
        const deduped = built.filter(ex => {
          const key = JSON.stringify(ex.fields);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        answer.real_examples = deduped.slice(0, MAX_EXAMPLES_PER_ACTION);
        answer.example_total = deduped.length;
        if (matches.length > 0) answer.from_test = matches[0].test_name;
      }

      res.json({ summary: aiParsed.summary || "", answers, test_count: runsQ.rows.length });
    } catch(dbErr) {
      console.error("[smart] DB error:", dbErr.message);
      res.json({ summary: aiParsed.summary || "", answers, test_count: 0 });
    }

  } catch(err) {
    console.error("[smart] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEAL CACHE ──────────────────────────────────────────────────────────────────
// Table created manually once:
// CREATE TABLE heal_cache (
//   id           SERIAL PRIMARY KEY,
//   original     TEXT NOT NULL UNIQUE,
//   healed       TEXT NOT NULL,
//   hit_count    INT DEFAULT 0,
//   created_at   TIMESTAMPTZ DEFAULT NOW(),
//   last_used_at TIMESTAMPTZ DEFAULT NOW()
// );

// GET /api/heal-cache?original=<selector> — used by runner at startup to bulk-load all entries
app.get('/api/heal-cache', requireAuth, async (req, res) => {
  try {
    const { original } = req.query;
    if (original) {
      // Single lookup (kept for compatibility)
      const r = await pool.query('SELECT healed FROM heal_cache WHERE original=$1', [original]);
      if (!r.rows.length) return res.status(404).json({ healed: null });
      res.json({ healed: r.rows[0].healed });
    } else {
      // Bulk load — return all entries as {original: healed} map
      const r = await pool.query('SELECT original, healed FROM heal_cache');
      const map = {};
      r.rows.forEach(row => { map[row.original] = row.healed; });
      res.json(map);
    }
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/heal-cache — store a new healed selector
app.post('/api/heal-cache', requireAuth, async (req, res) => {
  try {
    const { original, healed } = req.body;
    if (!original || !healed) return res.status(400).json({ error: 'original and healed required' });
    await pool.query(`
      INSERT INTO heal_cache (original, healed)
      VALUES ($1, $2)
      ON CONFLICT (original) DO UPDATE SET healed=$2, last_used_at=NOW()
    `, [original, healed]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/extension/config", (req, res) => {
  const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:5176";
  const apiBase = process.env.API_BASE_URL || `http://localhost:${PORT || 6001}`;
  
  // Extract base URL from CORS_ORIGIN for NAT
  const natUrl = corsOrigin.replace(/\/$/, '');
  
  res.json({
    api: apiBase,
    nat: natUrl,
    version: "1.0"
  });
});

// ─── ORG/PROJECT DEBUG (admin can call this to check their data) ──────────────
app.get("/api/debug/org-check", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const orgProjects = user.org_id ? (await pool.query(
      "SELECT op.project_id, p.name FROM org_projects op JOIN projects p ON p.id=op.project_id WHERE op.org_id=$1",
      [user.org_id]
    )).rows : [];
    const userProjects = (await pool.query(
      "SELECT up.project_id, p.name FROM user_projects up JOIN projects p ON p.id=up.project_id WHERE up.user_id=$1",
      [user.uid]
    )).rows;
    const allowed = await getAllowedProjectIds(user);
    res.json({
      user: { id: user.uid, username: user.username, role: user.role, org_id: user.org_id },
      org_projects: orgProjects,
      user_projects: userProjects,
      allowed_project_ids: allowed,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});




// ─── GRACEFUL SHUTDOWN — kill all runner processes on Ctrl+C or SIGTERM ──────
function killAllRunners() {
  if (activeRunPids.size === 0) return;
  console.log(`\n🛑 Killing ${activeRunPids.size} active runner process(es)...`);
  activeRunPids.forEach((pid, runId) => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { shell: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.log(`  ✓ Killed run ${runId} (pid ${pid})`);
    } catch(e) {
      console.log(`  ✗ Could not kill run ${runId} (pid ${pid}): ${e.message}`);
    }
  });
  activeRunPids.clear();
}

async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal} — shutting down gracefully...`);
  killAllRunners();
  // Mark all running/queued runs as error in DB
  try {
    await pool.query(
      `UPDATE test_runs SET status='error', finished_at=NOW() WHERE status IN ('queued','running')`
    );
  } catch(e) {}
  process.exit(0);
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('exit',    () => killAllRunners());

// ─── EXTENSION DOWNLOAD ───────────────────────────────────────────────────────
// Logged-in users can download the ATHMA Chrome extension as a ZIP
app.get("/api/extension/download", requireAuth, (req, res) => {
  try {
    const AdmZip = require("adm-zip");
    const extDir = path.join(__dirname, "../chrome-test-runner");
    // Package the WHOLE extension folder rather than a hardcoded list, so newly
    // added files (e.g. smart_study_recorder.js, declared in the manifest's
    // web_accessible_resources) are never accidentally left out of the ZIP.
    // A hardcoded list previously omitted smart_study_recorder.js, which broke
    // Smart Recording for everyone who installed via "Get Extension".
    // Exclude files that are NOT part of the shipped extension:
    //   - inspector.py        : old Python inspector, not used by the MV3 extension
    //   - "... - Copy.js"     : editor backup copies
    //   - syntax_check_stub.js: dev-only helper
    const EXCLUDE = new Set(["inspector.py", "syntax_check_stub.js"]);
    const isExcluded = (name) =>
      EXCLUDE.has(name) ||
      / - Copy\.[a-z]+$/i.test(name) ||   // "inspector - Copy.js" etc.
      name.startsWith(".");               // dotfiles
    const zip = new AdmZip();
    let added = 0;
    for (const file of fs.readdirSync(extDir)) {
      const fullPath = path.join(extDir, file);
      try {
        if (!fs.statSync(fullPath).isFile()) continue; // skip any subdirectories
      } catch { continue; }
      if (isExcluded(file)) continue;
      zip.addLocalFile(fullPath);
      added++;
    }
    // Safety net: guarantee the manifest is present (extension is invalid without it)
    if (!fs.existsSync(path.join(extDir, "manifest.json"))) {
      return res.status(500).json({ error: "Extension manifest.json not found on server" });
    }
    console.log(`[Extension download] Packaged ${added} file(s) from ${extDir}`);
    const buffer = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="ATHMA-Extension.zip"');
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } catch(e) {
    console.error("[Extension download] Error:", e.message);
    res.status(500).json({ error: "Failed to package extension: " + e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── CI/CD PLUGIN ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// ── MULTILINGUAL IGNORE LIST ─────────────────────────────────────────────────
// Rows a reviewer has judged to be correct-as-is (medical acronyms, proper names).
// They stay VISIBLE in the report but are excluded from the score, so the number
// tracks real translation defects instead of the same known-good strings forever.
// A row matches when every non-null field matches, so a NULL means "any":
//   base_text set, selector NULL -> ignore this string everywhere
//   selector set,  base_text NULL -> ignore this one element only
pool.query(`
  CREATE TABLE IF NOT EXISTS multilingual_ignores (
    id              SERIAL PRIMARY KEY,
    project_id      INTEGER,
    test_case_id    INTEGER NOT NULL,
    language        TEXT,
    selector        TEXT,
    base_text       TEXT,
    reason          TEXT NOT NULL,
    approval_status TEXT DEFAULT 'approved',
    created_by      INTEGER,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => pool.query(
  `CREATE INDEX IF NOT EXISTS idx_ml_ignores_tc ON multilingual_ignores(test_case_id)`
)).catch(e => console.error('[Multilingual] ignore table init failed:', e.message));

app.get('/api/multilingual/ignores/:test_case_id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM multilingual_ignores WHERE test_case_id=$1 ORDER BY created_at DESC`,
      [req.params.test_case_id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/multilingual/ignores/:test_case_id', requireAuth, async (req, res) => {
  try {
    const { selector, base_text, language, reason } = req.body;
    if (!reason || !String(reason).trim())
      return res.status(400).json({ error: 'A reason is required' });
    if (!selector && !base_text)
      return res.status(400).json({ error: 'Need selector or base_text' });
    const tc = await pool.query('SELECT project_id FROM test_cases WHERE id=$1', [req.params.test_case_id]);
    const r = await pool.query(`
      INSERT INTO multilingual_ignores
        (project_id, test_case_id, language, selector, base_text, reason, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [tc.rows[0]?.project_id || null, req.params.test_case_id, language || null,
       selector || null, base_text || null, String(reason).trim(),
       req.user?.uid || null, req.user?.full_name || req.user?.username || null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/multilingual/ignore/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM multilingual_ignores WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Auto-create ci_api_keys table on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS ci_api_keys (
    id          SERIAL PRIMARY KEY,
    label       TEXT NOT NULL,
    api_key     TEXT NOT NULL UNIQUE,
    org_id      INTEGER,
    created_by  INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    active      BOOLEAN DEFAULT TRUE
  );
  CREATE INDEX IF NOT EXISTS idx_ci_api_keys_key ON ci_api_keys(api_key);
`).then(() => console.log('✅ ci_api_keys table ready'))
  .catch(e => console.warn('[migration] ci_api_keys:', e.message));

// Middleware — validate CI API key from x-ci-key header
const requireCiKey = async (req, res, next) => {
  const key = req.headers['x-ci-key'] || req.query.ci_key || '';
  if (!key) return res.status(401).json({ error: 'Missing x-ci-key header' });
  try {
    const r = await pool.query(
      `SELECT * FROM ci_api_keys WHERE api_key=$1 AND active=TRUE`, [key]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid or inactive CI API key' });
    // Update last_used_at in background
    pool.query(`UPDATE ci_api_keys SET last_used_at=NOW() WHERE api_key=$1`, [key]).catch(() => {});
    req.ciKey = r.rows[0];
    next();
  } catch(err) { res.status(500).json({ error: err.message }); }
};

// POST /api/ci/keys — generate a new CI API key (admin only)
app.post('/api/ci/keys', requireAuth, requireRole('admin', 'superadmin', 'lead'), async (req, res) => {
  try {
    const { label } = req.body;
    if (!label?.trim()) return res.status(400).json({ error: 'label is required' });
    const key = 'ci-' + crypto.randomBytes(24).toString('hex');
    const r = await pool.query(
      `INSERT INTO ci_api_keys (label, api_key, org_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [label.trim(), key, req.user.org_id || null, req.user.uid]
    );
    console.log(`[CI] API key created: ${label} by ${req.user.username}`);
    res.json({ id: r.rows[0].id, label: r.rows[0].label, api_key: key, created_at: r.rows[0].created_at });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ci/keys — list all CI keys (admin only, keys are masked)
app.get('/api/ci/keys', requireAuth, requireRole('admin', 'superadmin', 'lead'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, label, LEFT(api_key,10)||'...' as api_key_preview,
              org_id, created_by, created_at, last_used_at, active
       FROM ci_api_keys ORDER BY created_at DESC`
    );
    res.json(r.rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/ci/keys/:id — revoke a CI key (admin only)
app.delete('/api/ci/keys/:id', requireAuth, requireRole('admin', 'superadmin', 'lead'), async (req, res) => {
  try {
    await pool.query(`UPDATE ci_api_keys SET active=FALSE WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, message: 'CI key revoked' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ci/trigger — trigger a test or suite run via CI key
// Body: { type: 'test'|'suite', id: <number>, browser: 'chrome'|'firefox'|'edge'|'safari' }
app.post('/api/ci/trigger', requireCiKey, async (req, res) => {
  try {
    const { type, id, browser = 'chrome' } = req.body;
    if (!type || !id) return res.status(400).json({ error: 'type and id are required' });
    if (!['test', 'suite'].includes(type)) return res.status(400).json({ error: 'type must be test or suite' });

    if (type === 'test') {
      // Trigger a single test
      const t = await pool.query(`SELECT * FROM test_cases WHERE id=$1`, [+id]);
      if (!t.rows[0]) return res.status(404).json({ error: `Test case ${id} not found` });
      const test = t.rows[0];
      // Create run record — run_by=1 (superadmin) so queue worker org check passes
      const run = await pool.query(
        `INSERT INTO test_runs (test_case_id, status, browser, triggered_by, run_by, project_id, origin_server)
         VALUES ($1, 'queued', $2, 'ci', 1, $3, $4) RETURNING id`,
        [test.id, browser, test.project_id, INSTANCE_ID]
      );
      const runId = run.rows[0].id;
      console.log(`[CI] Triggered test run #${runId} for test ${id} (${test.name})`);
      res.json({ run_id: runId, type: 'test', name: test.name, status: 'queued', browser });

    } else {
      // Trigger a suite — delegate entirely to the existing suite runner
      // This ensures tests run sequentially exactly like a manual UI run
      const s = await pool.query(`SELECT * FROM test_suites WHERE id=$1`, [+id]);
      if (!s.rows[0]) return res.status(404).json({ error: `Suite ${id} not found` });
      const suite = s.rows[0];

      // Resolve the test IDs using the same logic as POST /api/suite-runs
      const fc = typeof suite.filter_config === 'string'
        ? JSON.parse(suite.filter_config || '{}')
        : (suite.filter_config || {});
      const selectedIds = (fc.selected_case_ids || []).map(Number);

      let finalTestIds = [];
      if (selectedIds.length > 0) {
        finalTestIds = selectedIds;
      } else {
        // Dynamic suite with no specific IDs — fetch all active from project
        const r = await pool.query(
          `SELECT id FROM test_cases WHERE project_id=$1 AND active=TRUE ORDER BY id ASC`,
          [suite.project_id]
        );
        finalTestIds = r.rows.map(r => r.id);
      }

      if (!finalTestIds.length) return res.status(400).json({ error: 'Suite has no active test cases' });

      // Create suite_run record (same as UI does)
      const sr = await pool.query(
        `INSERT INTO suite_runs (suite_id, project_id, name, status, browser, total, run_by, started_at)
         VALUES ($1, $2, $3, 'running', $4, $5, 1, NOW()) RETURNING id`,
        [suite.id, suite.project_id, suite.name, browser, finalTestIds.length]
      );
      const suiteRunId = sr.rows[0].id;

      // Create queued test_run records for each test case
      const runIds = [];
      for (const testId of finalTestIds) {
        const tc = await pool.query(
          `SELECT id, type, browser, base_url, steps, api_config, project_id
           FROM test_cases WHERE id=$1 AND active=TRUE`,
          [testId]
        );
        if (!tc.rows[0]) continue;
        const test = tc.rows[0];
        const run = await pool.query(
          `INSERT INTO test_runs (test_case_id, project_id, status, browser, triggered_by, run_by, suite_run_id, origin_server)
           VALUES ($1, $2, 'queued', $3, 'suite', 1, $4, $5) RETURNING id`,
          [test.id, test.project_id, browser, suiteRunId, INSTANCE_ID]
        );
        runIds.push({ runId: run.rows[0].id, test });
      }

      console.log(`[CI] Triggered suite run #${suiteRunId} for suite ${id} (${suite.name}) — ${runIds.length} tests`);

      // Respond immediately so CI client gets the suite_run_id for polling
      res.json({
        suite_run_id: suiteRunId,
        run_ids: runIds.map(r => r.runId),
        type: 'suite',
        name: suite.name,
        status: 'running',
        total: runIds.length,
        browser
      });

      // Spawn all runners sequentially in background — same as POST /api/suite-runs
      const runnerToken = process.env.RUNNER_SECRET || 'nat-internal-runner-2024';
      (async () => {
        for (const { runId, test } of runIds) {
          // Stop if suite was aborted
          if (abortedSuiteRuns.has(suiteRunId)) {
            abortedSuiteRuns.delete(suiteRunId);
            break;
          }
          const fullTest = await pool.query('SELECT variables FROM test_cases WHERE id=$1', [test.id]);
          const isLastTest = runIds[runIds.length - 1].runId === runId;
          const config = {
            type: test.type,
            steps: await embedDbConnections(test.steps || []),
            browser: browser || test.browser || 'chrome',
            base_url: test.base_url || '',
            variables: fullTest.rows[0]?.variables || [],
            runner_token: runnerToken,
            test_case_id: test.id,
            api_config: test.api_config || null,
            keep_browser: !isLastTest,  // keep browser alive between suite tests
          };

          broadcast(suiteRunId, {
            type: 'test_start', run_id: runId,
            test_name: test.name, test_id: test.id, test_type: test.type,
          });

          // Move to running
          await pool.query("UPDATE test_runs SET status='running', started_at=NOW() WHERE id=$1", [runId]);

          await new Promise((resolve) => {
            // Config FILE (not inline arg) — Windows caps command lines at ~32K
            // chars; large tests silently failed to spawn with inline JSON.
            const ciCfgPath = path.join(LOGS_PATH, `config_${runId}.json`);
            fs.writeFileSync(ciCfgPath, JSON.stringify(config), 'utf8');
            const proc = spawn(PYTHON_CMD, [RUNNER_PATH, '--run-id', String(runId), '--config-file', ciCfgPath], {
              detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
              env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });
            activeRunPids.set(runId, proc.pid);
            proc.stdout.on('data', d => {
              // Suppress stdout — logs sent via API
              // const msg = d.toString().trim();
              // if (msg) console.log(`[ci-run ${runId}] ${msg.slice(0,200)}`);
            });
            proc.on('error', (err) => {
              pool.query("UPDATE test_runs SET status='error' WHERE id=$1", [runId]);
              broadcast(suiteRunId, { type: 'test_error', run_id: runId, message: err.message });
              resolve();
            });
            proc.on('close', async () => {
              activeRunPids.delete(runId);
              // Wrapped in try/catch/finally — a DB hiccup here must never freeze
              // this CI suite loop forever; resolve() always runs so it advances.
              try {
                const runRow = await pool.query('SELECT status,steps_passed,steps_total FROM test_runs WHERE id=$1', [runId]);
                const runStatus = runRow.rows[0]?.status || 'unknown';
                broadcast(suiteRunId, {
                  type: 'test_done', run_id: runId,
                  status: runStatus,
                  steps_passed: runRow.rows[0]?.steps_passed || 0,
                  steps_total: runRow.rows[0]?.steps_total || 0,
                });
                const totals = await pool.query(
                  `SELECT COUNT(*) FILTER(WHERE status='passed') as passed,
                          COUNT(*) FILTER(WHERE status IN ('failed','error')) as failed,
                          COUNT(*) FILTER(WHERE status IN ('queued','running')) as pending
                   FROM test_runs WHERE suite_run_id=$1`, [suiteRunId]
                );
                const t = totals.rows[0];
                broadcast(suiteRunId, { type: 'progress', passed: +t.passed, failed: +t.failed, pending: +t.pending, run_id: runId });
              } catch (closeErr) {
                console.error(`[CI Suite ${suiteRunId}] close-handler error for run ${runId}: ${closeErr.message}`);
                try {
                  await pool.query("UPDATE test_runs SET status='error', finished_at=NOW() WHERE id=$1 AND status='running'", [runId]);
                } catch(e) {}
                broadcast(suiteRunId, { type:"test_done", run_id:runId, status:"error", steps_passed:0, steps_total:0 });
              } finally {
                resolve();
              }
            });
          });
        }

        // Finalize suite_run
        if (!abortedSuiteRuns.has(suiteRunId)) {
          const final = await pool.query(
            `SELECT COUNT(*) FILTER(WHERE status='passed') as passed,
                    COUNT(*) FILTER(WHERE status IN ('failed','error')) as failed
             FROM test_runs WHERE suite_run_id=$1`, [suiteRunId]
          );
          const f = final.rows[0];
          const finalStatus = +f.failed === 0 ? 'passed' : +f.passed === 0 ? 'failed' : 'partial';
          await pool.query(
            "UPDATE suite_runs SET status=$1, passed=$2, failed=$3, finished_at=NOW() WHERE id=$4",
            [finalStatus, +f.passed, +f.failed, suiteRunId]
          );
          broadcast(suiteRunId, { type: 'suite_done', status: finalStatus, passed: +f.passed, failed: +f.failed });
          console.log(`[CI] Suite run #${suiteRunId} complete — ${finalStatus} (${f.passed} passed, ${f.failed} failed)`);
        }
        abortedSuiteRuns.delete(suiteRunId);
      })().catch(err => console.error('[CI] Suite runner error:', err.message));
    }
  } catch(err) {
    console.error('[CI] trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ci/status/:runId — poll a single test run status
app.get('/api/ci/status/:runId', requireCiKey, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, status, steps_total, steps_passed, steps_failed, duration_ms,
              started_at, finished_at, browser
       FROM test_runs WHERE id=$1`,
      [+req.params.runId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Run not found' });
    const run = r.rows[0];
    res.json({
      run_id:      run.id,
      status:      run.status,       // queued | running | passed | failed | error
      passed:      run.steps_passed  || 0,
      failed:      run.steps_failed  || 0,
      total:       run.steps_total   || 0,
      duration_ms: run.duration_ms   || 0,
      started_at:  run.started_at,
      finished_at: run.finished_at,
      browser:     run.browser,
      done: ['passed','failed','error'].includes(run.status)
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/ci/suite-status/:suiteRunId — poll a suite run status
app.get('/api/ci/suite-status/:suiteRunId', requireCiKey, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, status, total, passed, failed, browser, started_at, finished_at
       FROM suite_runs WHERE id=$1`,
      [+req.params.suiteRunId]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Suite run not found' });
    const sr = r.rows[0];

    // Calculate live counts directly from test_runs — more accurate than suite_runs columns
    const counts = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='passed') as passed,
         COUNT(*) FILTER (WHERE status='failed') as failed,
         COUNT(*) FILTER (WHERE status='error')  as errored,
         COUNT(*) FILTER (WHERE status IN ('queued','running')) as pending,
         COUNT(*) as total
       FROM test_runs WHERE suite_run_id=$1`,
      [+req.params.suiteRunId]
    );
    const c = counts.rows[0];
    const passed  = parseInt(c.passed)  || 0;
    const failed  = parseInt(c.failed)  + parseInt(c.errored) || 0;
    const pending = parseInt(c.pending) || 0;
    const total   = parseInt(c.total)   || sr.total || 0;

    // Determine done — all tests finished
    const allDone = pending === 0 && total > 0;
    const status  = allDone ? (failed > 0 ? 'failed' : 'passed') : 'running';

    res.json({
      suite_run_id: sr.id,
      status,
      total,
      passed,
      failed,
      pending,
      browser:      sr.browser,
      started_at:   sr.started_at,
      finished_at:  sr.finished_at,
      done: allDone
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

console.log('✅ CI/CD plugin endpoints ready: /api/ci/keys, /api/ci/trigger, /api/ci/status/:id');

// ─── AUTO-CLEANUP EXPIRED SESSIONS ─────────────────────────────────────────────────
// Runs every hour — deletes sessions that have passed their expires_at
// ─── DATA RETENTION CLEANUP (runs daily at 2am + on server start) ────────────
async function runDataRetentionCleanup() {
  console.log(`🧹 [Retention] Starting cleanup — test_runs>${TEST_RUN_RETENTION_DAYS}d, suite_runs>${SUITE_RUN_RETENTION_DAYS}d`);
  try {
    // Delete old test runs + their logs + screenshots
    const oldRuns = await pool.query(
      `SELECT id FROM test_runs WHERE created_at < NOW() - INTERVAL '${TEST_RUN_RETENTION_DAYS} days'`
    );
    if (oldRuns.rows.length > 0) {
      const ids = oldRuns.rows.map(r => r.id);
      // Delete child records first (ignore errors if tables don't exist)
      for (const tbl of ['run_logs','run_screenshots','run_log','run_screenshot','test_run_logs','test_run_screenshots']) {
        try { await pool.query(`DELETE FROM ${tbl} WHERE run_id = ANY($1)`, [ids]); } catch(e) {}
      }
      await pool.query(`DELETE FROM test_runs WHERE id = ANY($1)`, [ids]);
      console.log(`🧹 [Retention] Deleted ${ids.length} test_run(s) older than ${TEST_RUN_RETENTION_DAYS} day(s)`);
    } else {
      console.log(`🧹 [Retention] No test_runs older than ${TEST_RUN_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] test_runs cleanup error:', e.message); }

  try {
    // Delete old suite runs + their items
    const oldSuiteRuns = await pool.query(
      `SELECT id FROM suite_runs WHERE started_at < NOW() - INTERVAL '${SUITE_RUN_RETENTION_DAYS} days'`
    );
    if (oldSuiteRuns.rows.length > 0) {
      const ids = oldSuiteRuns.rows.map(r => r.id);
      for (const tbl of ['suite_run_items','suite_run_item']) {
        try { await pool.query(`DELETE FROM ${tbl} WHERE suite_run_id = ANY($1)`, [ids]); } catch(e) {}
      }
      await pool.query(`DELETE FROM suite_runs WHERE id = ANY($1)`, [ids]);
      console.log(`🧹 [Retention] Deleted ${ids.length} suite_run(s) older than ${SUITE_RUN_RETENTION_DAYS} day(s)`);
    } else {
      console.log(`🧹 [Retention] No suite_runs older than ${SUITE_RUN_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] suite_runs cleanup error:', e.message); }

  try {
    // Delete old screenshot files from disk
    const SCREENSHOTS_DIR = path.join(__dirname, '..', 'runner', 'screenshots');
    const cutoff = Date.now() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (fs.existsSync(SCREENSHOTS_DIR)) {
      const files = fs.readdirSync(SCREENSHOTS_DIR);
      let deleted = 0;
      for (const file of files) {
        const filePath = path.join(SCREENSHOTS_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch(e) { /* skip */ }
      }
      console.log(`🧹 [Retention] Deleted ${deleted} screenshot file(s) older than ${SCREENSHOT_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] Screenshot cleanup error:', e.message); }

  try {
    // Delete old log files from disk
    const LOGS_DIR = path.join(__dirname, '..', 'runner', 'logs');
    const logCutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (fs.existsSync(LOGS_DIR)) {
      const files = fs.readdirSync(LOGS_DIR);
      let deletedLogs = 0;
      for (const file of files) {
        if (!file.startsWith('run_') || !file.endsWith('.log')) continue;
        const filePath = path.join(LOGS_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < logCutoff) {
            fs.unlinkSync(filePath);
            deletedLogs++;
          }
        } catch(e) { /* skip */ }
      }
      console.log(`🧹 [Retention] Deleted ${deletedLogs} log file(s) older than ${LOG_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] Log file cleanup error:', e.message); }
}

// Run on server start
setTimeout(() => runDataRetentionCleanup(), 5000);

cron.schedule('0 2 * * *', async () => {
  await runDataRetentionCleanup();

  try {
    // 2. Delete old screenshot files from disk
    const SCREENSHOTS_DIR = path.join(__dirname, '..', 'runner', 'screenshots');
    const cutoff = Date.now() - SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (fs.existsSync(SCREENSHOTS_DIR)) {
      const files = fs.readdirSync(SCREENSHOTS_DIR);
      let deleted = 0;
      for (const file of files) {
        const filePath = path.join(SCREENSHOTS_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch(e) { /* skip locked/missing files */ }
      }
      console.log(`🧹 [Retention] Deleted ${deleted} screenshot file(s) older than ${SCREENSHOT_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] Screenshot file cleanup error:', e.message); }

  try {
    // 3. Delete old physical log files from disk (runner/logs/run_*.log)
    const LOGS_DIR = path.join(__dirname, '..', 'runner', 'logs');
    const logCutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    if (fs.existsSync(LOGS_DIR)) {
      const files = fs.readdirSync(LOGS_DIR);
      let deletedLogs = 0;
      for (const file of files) {
        if (!file.startsWith('run_') || !file.endsWith('.log')) continue;
        const filePath = path.join(LOGS_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile() && stat.mtimeMs < logCutoff) {
            fs.unlinkSync(filePath);
            deletedLogs++;
          }
        } catch(e) { /* skip locked/missing files */ }
      }
      console.log(`🧹 [Retention] Deleted ${deletedLogs} log file(s) older than ${LOG_RETENTION_DAYS} day(s)`);
    }
  } catch(e) { console.error('[Retention] Log file cleanup error:', e.message); }
});

cron.schedule('0 * * * *', async () => {
  try {
    const r = await pool.query("DELETE FROM auto_sessions WHERE expires_at < NOW()");
    if (r.rowCount > 0) console.log(`🧹 Cleaned up ${r.rowCount} expired session(s)`);
  } catch(e) { console.error('[Session cleanup] Error:', e.message); }
});


// ─── MULTILINGUAL TESTING ROUTES ─────────────────────────────────────────────

// Save baseline snapshot (called from runner after capture_page_text)
// Tracks which run_id last wrote each (test_case, language, url) baseline. A NEW run
// replaces the baseline outright; every further capture_page_text within the SAME run
// merges into it. Without this, "merge" would accumulate elements across every run
// forever and stale strings from old app states would never age out.
const _mlBaselineRun = new Map();

app.post('/api/multilingual/baseline', async (req, res) => {
  try {
    const { run_id, language, url: rawUrl, page_title, elements } = req.body;

    // Normalize URL - strip dynamic IDs and query params so same page always maps to same baseline
    const url = rawUrl
      .replace(/\?.*$/, '')           // remove query params
      .replace(/#.*$/, '')            // remove hash
      .replace(/\/\d{5,}/g, '/:id')  // replace long numeric IDs (5+ digits)
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid') // remove UUIDs
      .replace(/\/$/, '') || '/';     // remove trailing slash
    // Accept runner secret OR user JWT
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    const runnerSecret = process.env.RUNNER_SECRET || 'nat-internal-runner-2024';
    let userId = null;
    if (token === runnerSecret) {
      userId = null; // runner call — no user
    } else {
      // Try JWT auth
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        userId = decoded.id;
      } catch(e) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    // Get test_case_id and project_id from run
    const run = await pool.query('SELECT test_case_id FROM test_runs WHERE id=$1', [run_id]);
    if (!run.rows.length) {
      // Silent until now: returned a bare {ok:true} that the runner logged as
      // "action=None", indistinguishable from a crash. Say so.
      console.warn(`[Multilingual] baseline SKIPPED: run_id=${run_id} not found in test_runs`);
      return res.json({ ok: true, action: 'skipped', reason: `run_id ${run_id} not found in test_runs` });
    }
    const tc = await pool.query('SELECT project_id FROM test_cases WHERE id=$1', [run.rows[0].test_case_id]);
    const project_id   = tc.rows[0]?.project_id;
    const test_case_id = run.rows[0].test_case_id;

    // Upsert baseline - replace if same test+language+url.
    // Each capture_page_text call OVERWRITES the baseline for this URL+language with
    // exactly what it just found — no merging with older captures. This avoids stale
    // elements from a different screen/tab (same URL, different app state) lingering
    // forever in the baseline (previously this merged and never dropped anything).
    const existing = await pool.query(`
      SELECT id, elements FROM multilingual_baselines
      WHERE test_case_id=$1 AND language=$2 AND url=$3
      ORDER BY captured_at DESC LIMIT 1
    `, [test_case_id, language, url]);

    // First capture of this run resets the baseline; later ones merge into it, so a
    // script that captures several times on one URL (modal open, tooltip hovers, tab
    // switches) keeps ALL of them instead of only the last.
    const mergeKey  = `${test_case_id}|${language}|${url}`;
    const sameRun   = _mlBaselineRun.get(mergeKey) === run_id;
    _mlBaselineRun.set(mergeKey, run_id);

    if (existing.rows.length > 0) {
      let finalEls = elements;
      let collided = [];
      let repeats = 0;
      if (sameRun) {
        // Merge on selector — /compare pairs base vs target by selector, so that is the
        // identity that has to stay unique. Newer capture wins for the same selector.
        // Key on el.key (section-namespaced) when present. Keying on selector alone made
        // 'span._1' from one screen overwrite 'span._1' from another — 15 strings lost in a
        // single run. Older baselines have no key, so fall back to selector for those.
        const idOf = el => el.key || el.selector;
        const bySel = new Map();
        // Shared page furniture (nav links, header, breadcrumb) is present on EVERY screen, so
        // once identity is namespaced by section it would be stored once per capture — 13 nav
        // links x 3 screens = 39 rows of the same strings, tripling their weight in the score.
        // Same selector AND same text = the same string seen again; keep the first sighting.
        const seenContent = new Set();
        for (const el of (existing.rows[0].elements || [])) {
          bySel.set(idOf(el), el);
          seenContent.add(el.selector + '||' + (el.text || ''));
        }
        for (const el of elements) {
          const content = el.selector + '||' + (el.text || '');
          const prev = bySel.get(idOf(el));
          if (!prev && seenContent.has(content)) { repeats++; continue; }
          seenContent.add(content);
          // Same selector, DIFFERENT text => the incoming capture reused a selector that
          // already meant something else, and the older string is about to be lost. This
          // is the failure mode where an earlier screen's strings "disappear" after a
          // later capture. Logged so it is visible instead of silent.
          if (prev && (prev.text || '') !== (el.text || '') && collided.length < 15) {
            collided.push(`${idOf(el)}: "${prev.text}" -> "${el.text}"`);
          }
          // Page-level strings are re-captured by every step, so the LAST step note would
          // otherwise win. Keep the note from where the string was FIRST seen.
          if (prev && prev.section && !el.section) el.section = prev.section;
          else if (prev && prev.section) el.section = prev.section;
          bySel.set(idOf(el), el);
        }
        finalEls = Array.from(bySel.values());
      }
      await pool.query(`
        UPDATE multilingual_baselines
        SET elements=$1, page_title=$2, captured_at=NOW()
        WHERE id=$3
      `, [JSON.stringify(finalEls), page_title, existing.rows[0].id]);

      const prevCount = (existing.rows[0].elements || []).length;
      console.log(`[Multilingual] Baseline ${sameRun ? 'merged' : 'RESET'} run=${run_id} url=${url} prev=${prevCount} incoming=${elements.length} final=${finalEls.length} clobbered=${collided.length} repeats=${repeats}`);
      if (collided.length) console.log(`[Multilingual]   selector collisions: ${collided.join(' | ')}`);
      return res.json({ ok: true, action: sameRun ? 'merged' : 'reset', incoming: elements.length,
                        previous: prevCount, total: finalEls.length, clobbered: collided.length });
    } else {
      // No existing row — insert fresh
      await pool.query(`
        INSERT INTO multilingual_baselines
          (project_id, test_case_id, language, url, page_title, elements, captured_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [project_id, test_case_id, language, url, page_title, JSON.stringify(elements), userId]);

      console.log(`[Multilingual] New baseline saved: ${elements.length} elements`);
      return res.json({ ok: true, action: 'created', incoming: elements.length,
                        previous: 0, total: elements.length, clobbered: 0 });
    }

    res.json({ ok: true });
  } catch(e) {
    // e.message is frequently empty on pg errors — the useful part is code/detail/constraint.
    console.error('[Multilingual] baseline save error:', {
      message: e?.message || '(empty)', code: e?.code, detail: e?.detail,
      constraint: e?.constraint, table: e?.table, column: e?.column, where: e?.where,
      routine: e?.routine, name: e?.name
    });
    if (e?.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    // Surface it to the runner log too, so it shows up next to the capture it belongs to.
    res.json({ ok: false, action: 'error',
               error: e?.message || e?.detail || e?.code || String(e) || 'unknown' });
  }
});

// Get all baselines for a test case
app.get('/api/multilingual/baselines/:test_case_id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, language, url, page_title, captured_at,
             jsonb_array_length(elements) as element_count
      FROM multilingual_baselines
      WHERE test_case_id = $1
      ORDER BY language, captured_at DESC
    `, [req.params.test_case_id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get baseline elements for specific test+language
app.get('/api/multilingual/baseline/:test_case_id/:language', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT url, page_title, elements, captured_at
      FROM multilingual_baselines
      WHERE test_case_id=$1 AND language=$2
      ORDER BY captured_at DESC
    `, [req.params.test_case_id, req.params.language]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Run comparison between two language baselines
app.post('/api/multilingual/compare', requireAuth, async (req, res) => {
  try {
    const { test_case_id, base_language, target_language, score_grid_data } = req.body;

    // Reviewer-approved ignores, and whether grid RECORD data counts toward the score.
    // Both only affect the SCORE — every row still appears in the report.
    const scoreGrid = score_grid_data === true;
    let ignores = [];
    try {
      const ig = await pool.query(
        `SELECT * FROM multilingual_ignores
          WHERE test_case_id=$1 AND approval_status='approved'
            AND (language IS NULL OR language=$2)`, [test_case_id, target_language]);
      ignores = ig.rows;
    } catch (e) { console.warn('[Multilingual] ignore load failed:', e.message); }
    const isIgnored = (sel, txt) => ignores.find(g =>
      (g.selector  == null || g.selector  === sel) &&
      (g.base_text == null || g.base_text === txt));

    // Get base (English) snapshots - latest per URL only
    const base = await pool.query(`
      SELECT DISTINCT ON (url) url, page_title, elements 
      FROM multilingual_baselines
      WHERE test_case_id=$1 AND language=$2
      ORDER BY url, captured_at DESC
    `, [test_case_id, base_language]);

    // Get target (Greek/Arabic) snapshots - latest per URL only
    const target = await pool.query(`
      SELECT DISTINCT ON (url) url, page_title, elements
      FROM multilingual_baselines
      WHERE test_case_id=$1 AND language=$2
      ORDER BY url, captured_at DESC
    `, [test_case_id, target_language]);

    if (!base.rows.length)   return res.status(400).json({ error: `No ${base_language} baseline found` });
    if (!target.rows.length) return res.status(400).json({ error: `No ${target_language} baseline found` });

    // Compare page by page
    const pages = [];
    let totalElements = 0, totalTranslated = 0, totalNotTranslated = 0, totalOverflow = 0;
    let totalIgnored = 0, totalDataRows = 0, rawElements = 0, rawTranslated = 0;

    for (const basePage of base.rows) {
      // Find matching target page by URL (strip lang params)
      const baseUrl   = basePage.url.replace(/[?&]lang=[^&]*/g, '');
      const targetPage = target.rows.find(t => t.url.replace(/[?&]lang=[^&]*/g, '') === baseUrl);
      if (!targetPage) continue;

      const targetEls = targetPage.elements || [];

      // Report order used to follow the capture script's sweep order (all labels, then
      // all buttons, then all th...), which jumps around the screen and is painful to
      // review. Sort by capture section, then reading order: top to bottom, left to
      // right. Y is bucketed to 8px so one visual row doesn't jitter out of sequence.
      // Sorting uses the BASE snapshot only, so both languages stay aligned.
      const sectionOrder = new Map();
      for (const e of (basePage.elements || []))
        if (!sectionOrder.has(e.section || '')) sectionOrder.set(e.section || '', sectionOrder.size);
      const baseEls = [...(basePage.elements || [])].sort((a, b) => {
        const sa = sectionOrder.get(a.section || '') ?? 0, sb = sectionOrder.get(b.section || '') ?? 0;
        if (sa !== sb) return sa - sb;
        const ya = Math.round((a.rect?.top ?? 0) / 8), yb = Math.round((b.rect?.top ?? 0) / 8);
        if (ya !== yb) return ya - yb;
        return (a.rect?.left ?? 0) - (b.rect?.left ?? 0);
      });

      // Match elements by selector
      const pageResults = [];
      for (const baseEl of baseEls) {
        // Pair on the section-namespaced key when both sides have one; selector otherwise.
        const baseId = baseEl.key || baseEl.selector;
        const targetEl = targetEls.find(t => (t.key || t.selector) === baseId);
        if (!targetEl) continue;

        const baseText   = baseEl.text   || baseEl.placeholder || '';
        const targetText  = targetEl.text  || targetEl.placeholder || '';

        const isTranslated = baseText !== targetText && targetText.length > 0;
        const isOverflow   = targetEl.rect?.width > 0 &&
                             targetText.length > baseText.length * 1.5 &&
                             targetEl.rect?.width >= (targetEl.rect?.width || 999);

        // Shown either way; only 'scored' rows move the percentage.
        const ignoreHit = isIgnored(baseEl.selector, baseText);
        const isDataRow = baseEl.type === 'grid_data' && !scoreGrid;
        const scored    = !ignoreHit && !isDataRow;

        if (scored) {
          totalElements++;
          if (isTranslated)  totalTranslated++;
          else               totalNotTranslated++;
          if (isOverflow)    totalOverflow++;
        } else if (ignoreHit) { totalIgnored++; }
        else                  { totalDataRows++; }

        rawElements++;
        if (isTranslated) rawTranslated++;

        pageResults.push({
          selector:    baseEl.selector,
          type:        baseEl.type,
          section:     baseEl.section || targetEl.section || null,
          scored:      scored,
          ignored:     !!ignoreHit,
          ignore_id:     ignoreHit ? ignoreHit.id : null,
          ignore_reason: ignoreHit ? ignoreHit.reason : null,
          ignored_by:    ignoreHit ? ignoreHit.created_by_name : null,
          base_text:   baseText,
          target_text: targetText,
          status:        ignoreHit ? 'ignored' : (isDataRow ? 'data' : (isTranslated ? 'translated' : 'not_translated')),
          overflow:      isOverflow,
          base_rect:     baseEl.rect,
          target_rect:   targetEl.rect
        });
      }

      const pageScored = pageResults.filter(r => r.scored);
      const pageScore = pageScored.length > 0
        ? Math.round((pageScored.filter(r => r.status === 'translated').length / pageScored.length) * 100)
        : 0;

      pages.push({
        url:        basePage.url,
        page_title: basePage.page_title,
        score:      pageScore,
        elements:   pageResults,
        translated:     pageScored.filter(r => r.status === 'translated').length,
        not_translated: pageScored.filter(r => r.status === 'not_translated').length,
        overflow:       pageScored.filter(r => r.overflow).length,
        ignored:        pageResults.filter(r => r.status === 'ignored').length,
        data_rows:      pageResults.filter(r => r.status === 'data').length
      });
    }

    // 'overallScore' is ADJUSTED — ignored rows and unscored data rows excluded.
    // 'rawScore' is what it would be counting everything, always returned alongside so
    // an ignore list can never quietly inflate the headline number.
    let overallScore = totalElements > 0
      ? Math.round((totalTranslated / totalElements) * 100) : 0;
    const rawScore = rawElements > 0
      ? Math.round((rawTranslated / rawElements) * 100) : 0;

    // Get project_id
    const tc = await pool.query('SELECT project_id FROM test_cases WHERE id=$1', [test_case_id]);

    // ── AI VERIFICATION ── Check if translations are correct using Claude
    try {
      const toVerify = [];
      for (const page of pages) {
        for (const el of page.elements || []) {
          // Verify any element that has base text. Previously this also required
          // target_text to be truthy, which silently skipped not_translated
          // elements whose target was EMPTY ("") — so they got no AI reason or
          // suggestion. base_text alone is enough to ask for the translation.
          // Ignored and unscored data rows can't fail, so verifying them is wasted
          // Claude spend — and it produced the "proper name, no translation needed"
          // noise that filled the report.
          if (el.base_text && el.scored) {
            toVerify.push({ base: el.base_text, target: el.target_text || '', status: el.status, selector: el.selector });
          }
        }
      }

      if (toVerify.length > 0) {
        const langName = { el: 'Greek', ar: 'Arabic', hi: 'Hindi', fr: 'French', de: 'German', es: 'Spanish' }[target_language] || target_language;

        // Process in batches of 30
        const batchSize = 30;
        const allVerifications = [];
        for (let b = 0; b < toVerify.length; b += batchSize) {
          const batch = toVerify.slice(b, b + batchSize);
          const prompt = `You are a ${langName} translator for medical software UI.
For EACH item provide the correct ${langName} translation in "suggested" field.
- status "not_translated": suggest correct ${langName} translation of base text
- status "translated": verify if target is correct ${langName}, set correct true/false
"suggested" must ALWAYS be correct ${langName} translation, never return English text as suggestion.
Return ONLY a JSON array:
[{"base":"...","target":"...","correct":true/false,"reason":"brief reason","suggested":"correct ${langName} translation"}]

Items:
${batch.map(v => `base:"${v.base}" | target:"${v.target}" | status:${v.status}`).join('\n')}`;

          try {
            const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 4000,
                messages: [{ role: 'user', content: prompt }]
              })
            });
            const aiData  = await aiResp.json();
            if (!aiResp.ok || !aiData.content) {
              console.error(`[Multilingual AI] Batch ${Math.floor(b/batchSize)+1} API error:`,
                JSON.stringify(aiData).slice(0, 300));
            }
            const aiText  = aiData.content?.[0]?.text || '[]';
            console.log(`[Multilingual AI] Batch ${Math.floor(b/batchSize)+1}/${Math.ceil(toVerify.length/batchSize)}: ${aiText.slice(0,100)}`);
            const cleaned = aiText.replace(/```json\n?|```/g, '').trim();
            const batchResults = JSON.parse(cleaned);
            allVerifications.push(...batchResults);
          } catch(e) {
            console.error(`[Multilingual AI] Batch ${Math.floor(b/batchSize)+1} error:`, e.message);
          }
        }

        // Map AI results back to page elements. Index by base+target AND by
        // base alone, so not_translated rows (empty or echoed target) still map.
        const verMap = {};
        for (const v of allVerifications) {
          verMap[v.base + '||' + (v.target || '')] = v;
          verMap[v.base + '||' + v.base] = v;
          if (verMap['B::' + v.base] === undefined) verMap['B::' + v.base] = v; // base-only fallback
        }

        let wrongTranslation = 0;
        for (const page of pages) {
          for (const el of page.elements || []) {
            const ver = verMap[el.base_text + '||' + (el.target_text || '')]
                     || verMap[el.base_text + '||' + el.base_text]
                     || verMap['B::' + el.base_text];
            if (ver) {
              el.ai_correct = ver.correct;
              el.ai_reason  = ver.reason || null;
              // Keep the suggestion whenever it differs from the CURRENT target
              // (what's on screen). For not_translated the target is the English
              // leftover/empty, so a Greek suggestion is meaningful even if it
              // equals base only when base is genuinely non-translatable.
              el.suggested  = (ver.suggested && ver.suggested !== el.target_text) ? ver.suggested : null;
              if (el.status === 'translated') {
                el.status = ver.correct ? 'translated' : 'wrong_translation';
                if (!ver.correct) wrongTranslation++;
              }
            }
          }
          // Update page score
          const correct = (page.elements||[]).filter(e => e.status === 'translated').length;
          const total   = (page.elements||[]).length;
          page.score    = total > 0 ? Math.round((correct / total) * 100) : 0;
          page.wrong_translation = (page.elements||[]).filter(e => e.status === 'wrong_translation').length;
        }

        // Recalculate overall score
        totalTranslated  -= wrongTranslation;
        overallScore      = totalElements > 0 ? Math.round((totalTranslated / totalElements) * 100) : 0;

        console.log(`[Multilingual] AI verified ${allVerifications.length} translations, ${wrongTranslation} wrong`);
      }
    } catch(e) {
      console.error('[Multilingual] AI verification error:', e.message);
      // Continue without AI verification - not critical
    }

    // Delete previous result for same test+language combo before inserting new one
    await pool.query(`
      DELETE FROM multilingual_results
      WHERE test_case_id=$1 AND base_language=$2 AND target_language=$3
    `, [test_case_id, base_language, target_language]);

    // Save result
    const saved = await pool.query(`
      INSERT INTO multilingual_results
        (project_id, test_case_id, base_language, target_language,
         pages, total_elements, translated, not_translated, overflow, overall_score, run_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `, [tc.rows[0]?.project_id, test_case_id, base_language, target_language,
        JSON.stringify(pages), totalElements, totalTranslated,
        totalNotTranslated, totalOverflow, overallScore, req.user?.id || null]);

    res.json({
      ok: true,
      result_id:     saved.rows[0].id,
      overall_score: overallScore,     // adjusted — ignored + unscored data excluded
      raw_score:     rawScore,         // what it would be counting everything
      total:         totalElements,
      raw_total:     rawElements,
      translated:    totalTranslated,
      not_translated:totalNotTranslated,
      overflow:      totalOverflow,
      ignored:       totalIgnored,
      data_rows:     totalDataRows,
      score_grid_data: scoreGrid,
      pages
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get all multilingual results for a test case
app.get('/api/multilingual/results/:test_case_id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, base_language, target_language, overall_score,
             total_elements, translated, not_translated, overflow, run_at
      FROM multilingual_results
      WHERE test_case_id=$1
      ORDER BY run_at DESC
      LIMIT 20
    `, [req.params.test_case_id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get specific result details
app.get('/api/multilingual/result/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM multilingual_results WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete baseline for a test case + language
app.delete('/api/multilingual/baseline/:test_case_id/:language', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM multilingual_baselines WHERE test_case_id=$1 AND language=$2',
      [req.params.test_case_id, req.params.language]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── FILE LIBRARY ROUTES ─────────────────────────────────────────────────────
// Allows users to upload local files to the server so they can be used in
// upload_attachment test steps without needing server-side paths.
const multer = (() => { try { return require('multer'); } catch(e) { return null; } })();
const UPLOADS_DIR = path.join(__dirname, '../runner/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

if (multer) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
      // Preserve original name but sanitise it — strip path separators and dangerous chars
      const safe = file.originalname.replace(/[/\\:*?"<>|]/g, '_');
      // If a file with the same name already exists, keep the existing one (idempotent)
      const dest = path.join(UPLOADS_DIR, safe);
      cb(null, safe);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB max

  // POST /api/file-library — upload a file
  app.post('/api/file-library', requireAuth, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const serverPath = path.join(UPLOADS_DIR, req.file.filename);
    res.json({
      filename:    req.file.filename,
      originalname:req.file.originalname,
      size:        req.file.size,
      server_path: serverPath,
      uploaded_at: new Date().toISOString(),
    });
    console.log(`[file-library] uploaded: ${req.file.filename} (${req.file.size} bytes)`);
  });

  // GET /api/file-library — list all uploaded files
  app.get('/api/file-library', requireAuth, (req, res) => {
    try {
      const files = fs.readdirSync(UPLOADS_DIR)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          const fp   = path.join(UPLOADS_DIR, f);
          const stat = fs.statSync(fp);
          return {
            filename:    f,
            size:        stat.size,
            server_path: fp,
            uploaded_at: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
      res.json({ files });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/file-library/:filename — remove a file
  app.delete('/api/file-library/:filename', requireAuth, (req, res) => {
    try {
      const safe = req.params.filename.replace(/[/\\:*?"<>|]/g, '_');
      const fp   = path.join(UPLOADS_DIR, safe);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
      fs.unlinkSync(fp);
      res.json({ ok: true });
      console.log(`[file-library] deleted: ${safe}`);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  console.log('✅ File library routes ready (uploads → ', UPLOADS_DIR, ')');
} else {
  // multer not installed yet — routes return helpful error
  const _noMulter = (req, res) => res.status(503).json({
    error: 'multer package not installed. Run: cd backend && npm install multer'
  });
  app.post('/api/file-library', requireAuth, _noMulter);
  app.get('/api/file-library',  requireAuth, _noMulter);
  app.delete('/api/file-library/:filename', requireAuth, _noMulter);
  console.warn('⚠️  multer not found — run: cd backend && npm install multer');
}

// ─── SMART AUTHOR ROUTE ──────────────────────────────────────────────────────
// Three-layer Smart Author:
//   Layer 1: Knowledge base (study screen output + widget patterns)
//   Layer 2: One Claude call: plain English goal → field-value list
//   Layer 3: Deterministic execution using widget patterns
// The user just types plain English. No selectors. No keywords.
app.post('/api/agent-tests/smart-author', requireAuth, async (req, res) => {
  const { goal, base_url, project_id, name, login_user, login_password } = req.body;
  if (!goal || !base_url) return res.status(400).json({ error: 'goal and base_url required' });

  // Fixed: was reading a nonexistent PYTHON_CMD env var and defaulting to bare 'python',
  // which hits the Windows Store alias stub. Now reuses the module-level PYTHON_CMD
  // (from PYTHON_PATH in .env) that every other runner invocation already uses.
  const scriptPath = path.join(__dirname, '../runner/agent/smart_author.py');

  const args = [
    scriptPath,
    '--url',      base_url,
    '--goal',     goal,
    '--user',     login_user     || 'admin',
    '--password', login_password || 'admin',
  ];

  let stdout = '', stderr = '';
  const proc = require('child_process').spawn(PYTHON_CMD, args, {
    cwd: path.join(__dirname, '../runner/agent'),
    env: { ...process.env },
  });
  proc.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
  proc.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });

  // Kill timer: 10 min max (layer 2 is one fast AI call, layer 3 is deterministic)
  const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 10 * 60 * 1000);

  proc.on('close', async (code) => {
    clearTimeout(killTimer);
    try {
      const m = stdout.match(/SCRIPT_PATH=(.+\.json)\s*$/m);
      if (!m) {
        console.error('[smart-author] stdout:', stdout.slice(-3000));
        console.error('[smart-author] stderr:', stderr.slice(-1000));
        return res.status(500).json({
          error: 'Smart author did not produce a script.',
          detail: (stderr || stdout).slice(-3000)
        });
      }
      const doc   = JSON.parse(fs.readFileSync(m[1].trim(), 'utf8'));
      const steps = (doc.steps || []).map(st => {
        const o = {}; for (const k in st) if (!k.startsWith('_')) o[k] = st[k]; return o;
      });
      if (!steps.length) {
        return res.status(500).json({ error: 'Smart author produced an empty script.' });
      }
      // Save to agent_test_cases
      const r = await pool.query(
        `INSERT INTO agent_test_cases
           (project_id, name, goal, base_url, steps, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'draft',NOW(),NOW()) RETURNING id`,
        [project_id || null, name || goal.slice(0, 80), goal, base_url,
         JSON.stringify(steps)]
      );
      res.json({ ok: true, id: r.rows[0].id, step_count: steps.length, steps });
    } catch(e) { res.status(500).json({ error: e.message, detail: stderr.slice(-1000) }); }
  });
});

// ─── JIRA ROUTES ─────────────────────────────────────────────────────────────
require('./jira_routes')(app, pool, requireAuth);
require('./control_routes')(app, pool, requireAuth);
//app.use('/api/auto-scan', require('./auto_scan_routes'));

const PORT = process.env.PORT || 6001;
server.listen(PORT,'0.0.0.0',async () => {
  const _accessBase = process.env.API_BASE_URL || `http://localhost:${PORT}`;
  console.log(`✅ Automation Backend running on http://localhost:${PORT}`);
  console.log(`🌐 Access via: ${_accessBase}`);
  console.log(`🔌 WebSocket ready on ws://localhost:${PORT}`);

  // On startup: reset orphaned runs from previous server session
  // Mark as 'error' (not 'failed') so users know these were interrupted by restart
  try {
    // If the previous instance died non-gracefully (crash, hard kill, etc.) any
    // runner.py process it spawned can still be alive right now as an orphan —
    // this Node instance's activeRunPids map starts empty, so it has no idea
    // those PIDs exist. Kill them BEFORE marking their rows 'error', so they
    // can't keep running in the background and later post a stale/confusing
    // result back for a run the UI already shows as finished.
    const stillMidFlight = await pool.query(
      `SELECT id FROM test_runs WHERE status IN ('queued','running')`
    );
    if (stillMidFlight.rows.length > 0) {
      console.log(`🔪 Attempting to kill ${stillMidFlight.rows.length} leftover runner process(es) from previous session...`);
      await Promise.all(stillMidFlight.rows.map(r => killRunnerProcessByRunId(r.id).catch(()=>{})));
    }

    const orphaned = await pool.query(
      `UPDATE test_runs SET status='error', finished_at=NOW()
       WHERE status IN ('queued','running')
       RETURNING id`
    );
    if (orphaned.rows.length > 0) {
      console.log(`🔄 Reset ${orphaned.rows.length} orphaned run(s) from previous session to 'error'`);
      orphaned.rows.forEach(r => {
        broadcast(r.id, { type:"status", status:"error" });
        broadcast(r.id, { type:"log", level:"warn", message:"⚠️ Run interrupted — server was restarted", timestamp:new Date().toISOString() });
        broadcast(r.id, { type:"done", code:1 });
      });
    }
    // Also clean up orphaned suite_runs
    const orphanedSuites = await pool.query(
      `UPDATE suite_runs SET status='error', finished_at=NOW()
       WHERE status = 'running'
       RETURNING id`
    );
    if (orphanedSuites.rows.length > 0) {
      console.log(`🔄 Reset ${orphanedSuites.rows.length} orphaned suite run(s) to 'error'`);
    }
  } catch(e) { console.error("[startup] orphan cleanup error:", e.message); }

  await loadSchedules();
  // Start queue worker
  processQueue();
});