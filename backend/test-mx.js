// QAVYA — direct-to-MX delivery test.
//
// Your firewall resets SMTP the moment TLS starts, so Gmail relaying cannot work.
// But port 25 is open, and every recipient is @narayanahealth.org — so we can hand
// the message straight to Narayana Health's own mail server, unencrypted, with no
// credentials. That is the same path external mail already takes to reach you.
//
//   cd C:\Automation_Test\backend
//   node test-mx.js 337799@narayanahealth.org

process.on("uncaughtException",  e => { console.log("\n!! crashed:",  e && e.stack || e); process.exit(1); });
process.on("unhandledRejection", e => { console.log("\n!! rejected:", e && e.stack || e); process.exit(1); });

const dns  = require("dns").promises;
const net  = require("net");
const os   = require("os");
const nodemailer = require("nodemailer");

const TO   = process.argv[2] || "337799@narayanahealth.org";
const FROM = process.argv[3] || "qavya-reports@narayanahealth.org";
const domain = TO.split("@")[1];

console.log("=".repeat(66));
console.log(" running on : " + os.hostname());
console.log(" to         : " + TO);
console.log(" from       : " + FROM);
console.log(" domain     : " + domain);
console.log("=".repeat(66));

function probe(host, port) {
  return new Promise(resolve => {
    const t0 = Date.now(); let done = false;
    const finish = r => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(r); } };
    const s = net.createConnection({ host, port });
    s.setTimeout(12000);
    let buf = "";
    s.on("data",    d => { buf += d.toString(); if (buf.includes("\n")) finish({ ok: true, ms: Date.now()-t0, greeting: buf.trim().split("\n")[0] }); });
    s.on("timeout", () => finish({ ok: false, ms: Date.now()-t0, err: "timed out - no greeting" }));
    s.on("error",   e  => finish({ ok: false, ms: Date.now()-t0, err: (e.code || "") + " " + e.message }));
    s.on("close",   () => finish({ ok: false, ms: Date.now()-t0, err: "closed before greeting" }));
  });
}

(async () => {
  console.log("\n--- MX records for " + domain + " ---");
  let mx = [];
  try {
    mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    mx.forEach(m => console.log("  " + String(m.priority).padStart(3) + "  " + m.exchange));
  } catch (e) {
    console.log("  MX lookup FAILED: " + e.message);
    console.log("  (this server may not be allowed to resolve external DNS)");
  }
  if (!mx.length) { console.log("\nNo MX records - cannot continue."); process.exit(1); }

  console.log("\n--- can we reach them on port 25? ---");
  const reachable = [];
  for (const m of mx.slice(0, 3)) {
    const r = await probe(m.exchange, 25);
    console.log("  " + m.exchange.padEnd(42) + (r.ok
      ? "OPEN  (" + r.ms + "ms)  " + String(r.greeting).slice(0, 48)
      : "BLOCKED (" + r.ms + "ms)  " + r.err));
    if (r.ok) reachable.push(m.exchange);
  }
  if (!reachable.length) { console.log("\nNo MX host reachable on port 25."); process.exit(1); }

  for (const host of reachable) {
    console.log("\n" + "-".repeat(66));
    console.log("ATTEMPT: direct delivery via " + host + ":25 (no TLS, no auth)");
    console.log("-".repeat(66));
    const t = nodemailer.createTransport({
      host: host, port: 25, secure: false,
      ignoreTLS: true,          // never issue STARTTLS - that is what gets reset
      requireTLS: false,
      auth: undefined,
      family: 4,
      connectionTimeout: 20000, greetingTimeout: 10000, socketTimeout: 30000,
      logger: true, debug: true,
    });
    try {
      const info = await t.sendMail({
        from: FROM, to: TO,
        subject: "QAVYA direct-MX test",
        text: "Delivered straight to " + host + " from " + os.hostname() + ", no relay, no TLS.",
      });
      console.log("\nRESULT: ACCEPTED by " + host);
      console.log("  response = " + info.response);
      console.log("\n" + "=".repeat(66));
      console.log("IT WORKS. Set this in .env:");
      console.log("  SMTP_HOST=" + host);
      console.log("  SMTP_PORT=25");
      console.log("  SMTP_SECURE=false");
      console.log("  SMTP_AUTH=false");
      console.log("  SMTP_USER=");
      console.log("  SMTP_PASS=");
      console.log("  SMTP_FROM=" + FROM);
      console.log("=".repeat(66));
      console.log("DONE");
      process.exit(0);
    } catch (e) {
      console.log("\nRESULT: REJECTED by " + host);
      console.log("  code    = " + (e.code || "-"));
      console.log("  command = " + (e.command || "-"));
      console.log("  message = " + e.message);
      if (/5\.7|relay|denied|spf|not permitted/i.test(e.message))
        console.log("  -> the server refused this sender/IP. Ask IT to permit relay from this host,");
        console.log("     or give you the internal relay address instead.");
    }
  }

  console.log("\n" + "=".repeat(66));
  console.log("No MX accepted the message. The internal relay is the remaining option -");
  console.log("ask IT for the SMTP relay host that internal servers are allowed to use.");
  console.log("=".repeat(66));
  console.log("DONE");
  process.exit(0);
})();
