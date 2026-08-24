const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ user: process.env.DB_USER, host: process.env.DB_HOST || 'localhost', database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: 5432 });
pool.query("SELECT id, name, type, api_config FROM test_cases WHERE type='api' LIMIT 5")
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
