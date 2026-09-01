// QAVYA SMTP diagnostic.
//
// RUN THIS ON THE SERVER THAT SENDS THE MAIL — the one whose .env has
// SCHEDULER_ENABLED=true and INSTANCE_ID=10.8.4.57. Running it on a laptop
// tells you about the laptop's network, not the server's.
//
//   cd C:\Automation_Test\backend
//   node test-mail.js you@narayanahealth.org

process.on("uncaughtException",  e => { console.log("\n!! crashed:", e && e.stack || e); process.exit(1); });
process.on("unhandledRejection", e => { console.log("\n!! rejected:", e && e.stack || e); process.exit(1); });

const path = require("path");
const os   = require("os");
try { require("dotenv").config({ path: path.join(__dirname, ".env") }); } catch (e) {
  console.log("could not read .env:", e.message);
}
const nodemailer = require("nodemailer");
const net = require("net");

const TO   = process.argv[2] || process.env.SMTP_USER;
const HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";

console.log("=".repeat(66));
console.log(" running on : " + os.hostname());
console.log(" INSTANCE_ID: " + (process.env.INSTANCE_ID || "(not set)"));
console.log(" SCHEDULER  : " + (process.env.SCHEDULER_ENABLED || "(not set -> true)"));
console.log(" host       : " + HOST);
console.log(" user       : " + (USER || "(none)"));
console.log(" pass       : " + (PASS ? "set, " + PASS.length + " chars" : "(none)"));
console.log(" to         : " + TO);
console.log("=".repeat(66));

if (String(process.env.SCHEDULER_ENABLED) === "false") {
  console.log("\n>>> WARNING: SCHEDULER_ENABLED=false here, so this is NOT the machine");
  console.log(">>> that sends the scheduled mail. Run it on the other server.\n");
}

// ── step 1: can we open a socket and get an SMTP greeting? ────────────────────
function rawProbe(port) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    const finish = r => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(r); } };
    const sock = net.createConnection({ host: HOST, port });
    sock.setTimeout(12000);
    let buf = "";
    sock.on("data",    d => { buf += d.toString(); if (buf.includes("\n")) finish({ ok: true,  ms: Date.now()-t0, greeting: buf.trim().split("\n")[0] }); });
    sock.on("timeout", () => finish({ ok: false, ms: Date.now()-t0, err: "timed out — no greeting (port filtered)" }));
    sock.on("error",   e  => finish({ ok: false, ms: Date.now()-t0, err: (e.code || "") + " " + e.message }));
    sock.on("close",   () => finish({ ok: false, ms: Date.now()-t0, err: "closed before greeting (reset)" }));
  });
}

// ── step 2: a real send, printing the whole SMTP dialogue ─────────────────────
async function trySend(label, opts) {
  console.log("\n" + "-".repeat(66));
  console.log("ATTEMPT: " + label);
  console.log("-".repeat(66));
  const t = nodemailer.createTransport(Object.assign({}, opts, {
    tls: { rejectUnauthorized: false },
    connectionTimeout: 20000,
    greetingTimeout:   10000,
    socketTimeout:     30000,
    logger: true,
    debug:  true,
  }));
  try {
    const info = await t.sendMail({
      from:    process.env.SMTP_FROM || USER,
      to:      TO,
      subject: "QAVYA SMTP test - " + label,
      text:    "If you are reading this, " + label + " works from " + os.hostname() + ".",
    });
    console.log("\nRESULT: SENT via " + label + "  messageId=" + info.messageId);
    return true;
  } catch (e) {
    console.log("\nRESULT: FAILED via " + label);
    console.log("  code    = " + (e.code || "-"));
    console.log("  command = " + (e.command || "-"));
    console.log("  message = " + e.message);
    return false;
  }
}

(async () => {
  console.log("\n--- TCP reachability ---");
  for (const port of [587, 465, 25]) {
    let r;
    try { r = await rawProbe(port); } catch (e) { r = { ok: false, ms: 0, err: e.message }; }
    console.log("  port " + String(port).padEnd(4) + (r.ok
      ? "OPEN  (" + r.ms + "ms)  " + String(r.greeting).slice(0, 60)
      : "BLOCKED (" + r.ms + "ms)  " + r.err));
  }

  const auth = (USER && PASS) ? { user: USER, pass: PASS } : undefined;
  let ok = false;
  if (!TO) { console.log("\nNo recipient. Usage: node test-mail.js you@example.com"); }
  else {
    ok = await trySend("587 STARTTLS", { host: HOST, port: 587, secure: false, requireTLS: true, family: 4, auth: auth });
    if (!ok) ok = await trySend("465 SSL", { host: HOST, port: 465, secure: true, family: 4, auth: auth });
  }

  console.log("\n" + "=".repeat(66));
  console.log(ok
    ? "VERDICT: a send SUCCEEDED. Set SMTP_PORT/SMTP_SECURE to the port that worked."
    : "VERDICT: no send succeeded. Read the transcript:\n" +
      "  - no greeting on any port     -> firewall blocks outbound SMTP\n" +
      "  - greeting, dies at STARTTLS  -> a proxy is inspecting and resetting SMTP\n" +
      "  - reaches AUTH, then fails    -> Gmail app password wrong or revoked\n" +
      "  The internal narayanahealth.org relay avoids all three.");
  console.log("=".repeat(66));
  console.log("DONE");
  process.exit(0);
})();
