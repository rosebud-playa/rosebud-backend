const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ — no native compile step
const path = require('path');
const { MONTHS, ENTITIES, INPUT_ACCOUNTS, seedValues } = require('./seed');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS cells (
    scenario TEXT NOT NULL,
    entity   TEXT NOT NULL,
    account  TEXT NOT NULL,
    month    TEXT NOT NULL,
    value    REAL NOT NULL,
    PRIMARY KEY (scenario, entity, account, month)
  );
  CREATE TABLE IF NOT EXISTS versions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    label     TEXT NOT NULL,
    scenario  TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data      TEXT NOT NULL
  );
`);

// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3),
// so batch writes are wrapped manually with BEGIN/COMMIT.
function withTransaction(fn) {
  db.exec('BEGIN TRANSACTION');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Seed once, only if the database is empty (first run).
function seedIfEmpty() {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM cells').get();
  if (c > 0) return;
  const insert = db.prepare('INSERT INTO cells (scenario, entity, account, month, value) VALUES (?,?,?,?,?)');

  const scenarioSeeds = { Budget: seedValues(1, false), Forecast: seedValues(1.06, true), Actual: seedValues(0.95, true) };
  let count = 0;
  withTransaction(() => {
    Object.entries(scenarioSeeds).forEach(([scenario, data]) => {
      ENTITIES.forEach((e) => {
        INPUT_ACCOUNTS.forEach((account) => {
          MONTHS.forEach((month) => { insert.run(scenario, e.id, account, month, data[e.id][account][month]); count += 1; });
        });
      });
    });
  });
  console.log(`Seeded ${count} cells across ${Object.keys(scenarioSeeds).length} scenarios.`);
}
seedIfEmpty();

function loadValues() {
  const rows = db.prepare('SELECT scenario, entity, account, month, value FROM cells').all();
  const values = {};
  rows.forEach((r) => {
    values[r.scenario] ??= {};
    values[r.scenario][r.entity] ??= {};
    values[r.scenario][r.entity][r.account] ??= {};
    values[r.scenario][r.entity][r.account][r.month] = r.value;
  });
  return values;
}
function loadVersions() {
  return db.prepare('SELECT id, label, scenario, timestamp, data FROM versions ORDER BY id')
    .all()
    .map((v) => ({ ...v, data: JSON.parse(v.data) }));
}

const app = express();
app.use(cors());
app.use(express.json());

// Full workspace snapshot — called once on load.
app.get('/api/workspace', (req, res) => {
  res.json({ values: loadValues(), versions: loadVersions() });
});

// Single-cell edit — called on every keystroke commit from the grid.
app.put('/api/cell', (req, res) => {
  const { scenario, entity, account, month, value } = req.body || {};
  if (!scenario || !entity || !account || !month || typeof value !== 'number' || Number.isNaN(value)) {
    return res.status(400).json({ error: 'scenario, entity, account, month, and a numeric value are required' });
  }
  if (!INPUT_ACCOUNTS.includes(account)) {
    return res.status(400).json({ error: `${account} is not an editable input account` });
  }
  db.prepare(`
    INSERT INTO cells (scenario, entity, account, month, value) VALUES (?,?,?,?,?)
    ON CONFLICT(scenario, entity, account, month) DO UPDATE SET value = excluded.value
  `).run(scenario, entity, account, month, value);
  res.json({ ok: true });
});

// Save a version snapshot of a scenario's current stored values.
app.post('/api/versions', (req, res) => {
  const { scenario, label } = req.body || {};
  if (!scenario) return res.status(400).json({ error: 'scenario is required' });

  const rows = db.prepare('SELECT entity, account, month, value FROM cells WHERE scenario = ?').all(scenario);
  const snapshot = {};
  rows.forEach((r) => {
    snapshot[r.entity] ??= {};
    snapshot[r.entity][r.account] ??= {};
    snapshot[r.entity][r.account][r.month] = r.value;
  });

  const timestamp = new Date().toISOString();
  const finalLabel = (label && label.trim()) || `${scenario} — ${new Date().toLocaleDateString()}`;
  const info = db.prepare('INSERT INTO versions (label, scenario, timestamp, data) VALUES (?,?,?,?)')
    .run(finalLabel, scenario, timestamp, JSON.stringify(snapshot));

  res.json({ id: info.lastInsertRowid, label: finalLabel, scenario, timestamp, data: snapshot });
});

// Restore a saved version back into its scenario's live cells.
app.put('/api/versions/:id/restore', (req, res) => {
  const row = db.prepare('SELECT * FROM versions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'version not found' });
  const snapshot = JSON.parse(row.data);

  const del = db.prepare('DELETE FROM cells WHERE scenario = ?');
  const insert = db.prepare('INSERT INTO cells (scenario, entity, account, month, value) VALUES (?,?,?,?,?)');
  withTransaction(() => {
    del.run(row.scenario);
    Object.entries(snapshot).forEach(([entity, accounts]) => {
      Object.entries(accounts).forEach(([account, months]) => {
        Object.entries(months).forEach(([month, value]) => insert.run(row.scenario, entity, account, month, value));
      });
    });
  });

  res.json({ ok: true, scenario: row.scenario, data: snapshot });
});

app.delete('/api/versions/:id', (req, res) => {
  db.prepare('DELETE FROM versions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Budget server listening on http://localhost:${PORT}`));
