// Persistence for CapTrack's state document.
// - DATABASE_URL set: one JSONB row in Postgres (Neon, Supabase, Render Postgres...).
// - Otherwise: a JSON file in DATA_DIR, written atomically.
'use strict';

const fs = require('fs');
const path = require('path');

function fileStore(dir) {
  const file = path.join(dir, 'db.json');
  return {
    describe: `file ${file}`,
    async load() {
      fs.mkdirSync(dir, { recursive: true });
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    },
    async write(json) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, json);
      fs.renameSync(tmp, file);
    },
  };
}

function postgresStore(url, pg = require('pg')) {
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  return {
    describe: 'Postgres (DATABASE_URL)',
    async load() {
      await pool.query(`CREATE TABLE IF NOT EXISTS captrack_state (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await pool.query('SELECT data FROM captrack_state WHERE id = 1');
      return rows.length ? rows[0].data : null;
    },
    async write(json) {
      await pool.query(
        `INSERT INTO captrack_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [json]
      );
    },
  };
}

function createStore({ databaseUrl, dataDir, pg } = {}) {
  const backend = databaseUrl ? postgresStore(databaseUrl, pg) : fileStore(dataDir);
  let queue = Promise.resolve();
  return {
    describe: backend.describe,
    load: () => backend.load(),
    // Writes run one at a time, in order. The snapshot is taken at call time,
    // so a later save can never be overwritten by an earlier one.
    save(state) {
      const json = JSON.stringify(state);
      const run = queue.then(() => backend.write(json));
      queue = run.catch(() => {});
      return run;
    },
  };
}

module.exports = { createStore };
