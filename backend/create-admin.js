// QAVYA — create the first superadmin account.
//
// schema.sql creates the TABLES but no rows, so a brand-new database has an
// empty auto_users and nobody can log in. This creates that first account.
//
//   cd backend
//   node create-admin.js                       -> admin / Welcome@123
//   node create-admin.js myname MyPassw0rd     -> custom username + password
//
// Safe to re-run: it refuses rather than overwriting an existing user.
// The account is created with must_change_password = TRUE, so the password
// below is only ever good for the first login.

require("dotenv").config();
const { Pool } = require("pg");
const bcrypt   = require("bcryptjs");

const USERNAME = process.argv[2] || process.env.INITIAL_ADMIN_USER     || "admin";
const PASSWORD = process.argv[3] || process.env.INITIAL_ADMIN_PASSWORD || "Welcome@123";

for (const v of ["DB_NAME", "DB_USER", "DB_PASSWORD"]) {
  if (!process.env[v]) {
    console.error(`Missing ${v} in backend/.env — set the database settings first.`);
    process.exit(1);
  }
}

const pool = new Pool({
  user:     process.env.DB_USER,
  host:     process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port:     parseInt(process.env.DB_PORT || "5432"),
});

(async () => {
  try {
    const t = await pool.query("SELECT to_regclass('public.auto_users') AS t");
    if (!t.rows[0].t) {
      console.error("Table auto_users does not exist. Start the server once so it");
      console.error("creates the schema from schema.sql, then run this again.");
      process.exit(1);
    }

    const dupe = await pool.query("SELECT id FROM auto_users WHERE username=$1", [USERNAME]);
    if (dupe.rows.length) {
      console.error(`User '${USERNAME}' already exists (id ${dupe.rows[0].id}). Nothing changed.`);
      process.exit(1);
    }

    const { rows: [{ c }] } = await pool.query("SELECT COUNT(*)::int AS c FROM auto_users");
    const hash = await bcrypt.hash(PASSWORD, 12);
    let row;

    if (c === 0) {
      // server.js grants unrestricted access on id === 1 as well as on
      // role === 'superadmin', so the very first account must BE id 1 —
      // otherwise some checks quietly treat it as an ordinary admin.
      row = (await pool.query(
        `INSERT INTO auto_users (id, username, password_hash, full_name, role, active, must_change_password)
         VALUES (1, $1, $2, 'Super Admin', 'superadmin', TRUE, TRUE)
         RETURNING id, username, role`,
        [USERNAME, hash]
      )).rows[0];
      // Keep the sequence in step or the next INSERT collides with id 1.
      await pool.query("SELECT setval('auto_users_id_seq', (SELECT MAX(id) FROM auto_users))");
    } else {
      row = (await pool.query(
        `INSERT INTO auto_users (username, password_hash, full_name, role, active, must_change_password)
         VALUES ($1, $2, 'Super Admin', 'superadmin', TRUE, TRUE)
         RETURNING id, username, role`,
        [USERNAME, hash]
      )).rows[0];
      console.warn(`Note: ${c} user(s) already existed, so this account is id ${row.id}, not 1.`);
    }

    console.log("");
    console.log("  Superadmin created");
    console.log("  ------------------");
    console.log("  username : " + row.username);
    console.log("  password : " + PASSWORD);
    console.log("  id / role: " + row.id + " / " + row.role);
    console.log("");
    console.log("  You will be asked to change the password at first login.");
    console.log("");
  } catch (e) {
    console.error("Failed to create the admin user:", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
