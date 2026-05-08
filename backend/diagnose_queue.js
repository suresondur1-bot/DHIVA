const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const MAX_RUNS_PER_ORG = parseInt(process.env.MAX_RUNS_PER_ORG || '2');
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || '5');

async function diagnose() {
  try {
    console.log(`\nSettings: MAX_CONCURRENT=${MAX_CONCURRENT_RUNS} MAX_PER_ORG=${MAX_RUNS_PER_ORG}`);

    console.log('\n=== RUNNING/QUEUED RUNS ===');
    const runs = await pool.query(`
      SELECT tr.id, tr.status, tr.run_by,
             u.username, u.org_id, tc.name as test_name
      FROM test_runs tr
      LEFT JOIN auto_users u ON u.id = tr.run_by
      LEFT JOIN test_cases tc ON tc.id = tr.test_case_id
      WHERE tr.status IN ('running','queued')
      ORDER BY tr.created_at ASC
    `);
    console.table(runs.rows);

    console.log('\n=== RUNNING COUNT PER ORG ===');
    const countRes = await pool.query(`
      SELECT COALESCE(u.org_id::text,'none') as org_id, COUNT(*) as running
      FROM test_runs tr
      LEFT JOIN auto_users u ON u.id = tr.run_by
      WHERE tr.status = 'running'
      GROUP BY COALESCE(u.org_id::text,'none')
    `);
    console.table(countRes.rows);

    const totalRunning = countRes.rows.reduce((s,r)=>s+parseInt(r.running),0);
    const slots = MAX_CONCURRENT_RUNS - totalRunning;
    console.log(`Total running: ${totalRunning} | Slots available: ${slots}`);

    console.log('\n=== WOULD QUEUE START QUEUED RUNS? ===');
    const orgCounts = {};
    countRes.rows.forEach(r => { orgCounts[r.org_id] = parseInt(r.running); });

    for (const r of runs.rows.filter(r=>r.status==='queued')) {
      const orgKey = r.org_id ? String(r.org_id) : 'none';
      const orgRunning = orgCounts[orgKey] || 0;
      const wouldSkip = orgKey !== 'none' && orgRunning >= MAX_RUNS_PER_ORG;
      const slotsOk = slots > 0;
      console.log(`  Run ${r.id} [${r.test_name}] user=${r.username} org=${orgKey} orgRunning=${orgRunning}/${MAX_RUNS_PER_ORG} slots=${slots} => ${!slotsOk ? 'BLOCKED (global limit)' : wouldSkip ? 'BLOCKED (org limit)' : 'WOULD START ✓'}`);
    }

    console.log('\n=== ALL USERS & ORGS ===');
    const users = await pool.query(`SELECT id, username, org_id, role FROM auto_users WHERE active=true`);
    console.table(users.rows);

  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    pool.end();
  }
}
diagnose();
