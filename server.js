const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ — no native compile step
const path = require('path');
const { MONTHS, ENTITIES, INPUT_ACCOUNTS, seedValues } = require('./seed');
const { bcrypt, FRONTEND_URL, signToken, requireAuth, randomToken, sendPasswordResetEmail } = require('./auth');

// DB_PATH lets you point the database at a mounted persistent volume in production
// (e.g. Fly.io volumes are typically mounted at /data). Defaults to a local file
// next to this script for development.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cells (
    workspace_id INTEGER NOT NULL,
    scenario     TEXT NOT NULL,
    entity       TEXT NOT NULL,
    account      TEXT NOT NULL,
    month        TEXT NOT NULL,
    value        REAL NOT NULL,
    PRIMARY KEY (workspace_id, scenario, entity, account, month)
  );
  CREATE TABLE IF NOT EXISTS versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    label        TEXT NOT NULL,
    scenario     TEXT NOT NULL,
    timestamp    TEXT NOT NULL,
    data         TEXT NOT NULL
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

// Seeds a brand-new workspace with the same demo Budget/Forecast/Actual numbers,
// so every new account starts from a populated, explorable model.
function seedWorkspace(workspaceId) {
  const insert = db.prepare('INSERT INTO cells (workspace_id, scenario, entity, account, month, value) VALUES (?,?,?,?,?,?)');
  const scenarioSeeds = { Budget: seedValues(1, false), Forecast: seedValues(1.06, true), Actual: seedValues(0.95, true) };
  let count = 0;
  withTransaction(() => {
    Object.entries(scenarioSeeds).forEach(([scenario, data]) => {
      ENTITIES.forEach((e) => {
        INPUT_ACCOUNTS.forEach((account) => {
          MONTHS.forEach((month) => { insert.run(workspaceId, scenario, e.id, account, month, data[e.id][account][month]); count += 1; });
        });
      });
    });
  });
  console.log(`Seeded workspace ${workspaceId} with ${count} cells.`);
}

function loadValues(workspaceId) {
  const rows = db.prepare('SELECT scenario, entity, account, month, value FROM cells WHERE workspace_id = ?').all(workspaceId);
  const values = {};
  rows.forEach((r) => {
    values[r.scenario] ??= {};
    values[r.scenario][r.entity] ??= {};
    values[r.scenario][r.entity][r.account] ??= {};
    values[r.scenario][r.entity][r.account][r.month] = r.value;
  });
  return values;
}
function loadVersions(workspaceId) {
  return db.prepare('SELECT id, label, scenario, timestamp, data FROM versions WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId)
    .map((v) => ({ ...v, data: JSON.parse(v.data) }));
}

const app = express();
// In production, set CORS_ORIGIN to your deployed frontend's URL to restrict who
// can call this API. Left unset, it allows any origin — fine for local dev only.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : {}));
app.use(express.json());

/* ---------------------------------------------------------------------- *
 *  AUTH
 * ---------------------------------------------------------------------- */

app.post('/api/auth/signup', (req, res) => {
  const { email, password, workspaceName } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
    return res.status(409).json({ error: 'an account with that email already exists' });
  }

  const now = new Date().toISOString();
  const finalWorkspaceName = (workspaceName || '').trim() || `${cleanEmail.split('@')[0]}'s workspace`;
  const passwordHash = bcrypt.hashSync(password, 10);

  const userInfo = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)').run(cleanEmail, passwordHash, now);
  const userId = userInfo.lastInsertRowid;
  const wsInfo = db.prepare('INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?,?,?)').run(finalWorkspaceName, userId, now);
  const workspaceId = wsInfo.lastInsertRowid;
  seedWorkspace(workspaceId);

  const token = signToken({ id: userId, email: cleanEmail }, { id: workspaceId });
  res.json({ token, user: { email: cleanEmail }, workspace: { id: workspaceId, name: finalWorkspaceName } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const workspace = db.prepare('SELECT * FROM workspaces WHERE owner_user_id = ?').get(user.id);
  const token = signToken(user, workspace);
  res.json({ token, user: { email: user.email }, workspace: { id: workspace.id, name: workspace.name } });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const cleanEmail = ((req.body && req.body.email) || '').trim().toLowerCase();
  const user = cleanEmail ? db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail) : null;
  if (user) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expiresAt);
    const resetLink = `${FRONTEND_URL}/?resetToken=${token}`;
    await sendPasswordResetEmail(user.email, resetLink);
  }
  // Always respond the same way whether or not the email is registered, so the
  // response itself can't be used to discover which emails have accounts.
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'a reset token and an 8+ character new password are required' });
  }
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || new Date(row.expires_at) < new Date()) {
    return res.status(400).json({ error: 'this reset link is invalid or has expired' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------- *
 *  WORKSPACE DATA  (all routes below require a valid token)
 * ---------------------------------------------------------------------- */

app.get('/api/workspace', requireAuth, (req, res) => {
  const workspace = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(req.user.workspaceId);
  res.json({ values: loadValues(req.user.workspaceId), versions: loadVersions(req.user.workspaceId), workspace });
});

app.put('/api/cell', requireAuth, (req, res) => {
  const { scenario, entity, account, month, value } = req.body || {};
  if (!scenario || !entity || !account || !month || typeof value !== 'number' || Number.isNaN(value)) {
    return res.status(400).json({ error: 'scenario, entity, account, month, and a numeric value are required' });
  }
  if (!INPUT_ACCOUNTS.includes(account)) {
    return res.status(400).json({ error: `${account} is not an editable input account` });
  }
  db.prepare(`
    INSERT INTO cells (workspace_id, scenario, entity, account, month, value) VALUES (?,?,?,?,?,?)
    ON CONFLICT(workspace_id, scenario, entity, account, month) DO UPDATE SET value = excluded.value
  `).run(req.user.workspaceId, scenario, entity, account, month, value);
  res.json({ ok: true });
});

app.post('/api/versions', requireAuth, (req, res) => {
  const { scenario, label } = req.body || {};
  if (!scenario) return res.status(400).json({ error: 'scenario is required' });

  const rows = db.prepare('SELECT entity, account, month, value FROM cells WHERE workspace_id = ? AND scenario = ?').all(req.user.workspaceId, scenario);
  const snapshot = {};
  rows.forEach((r) => {
    snapshot[r.entity] ??= {};
    snapshot[r.entity][r.account] ??= {};
    snapshot[r.entity][r.account][r.month] = r.value;
  });

  const timestamp = new Date().toISOString();
  const finalLabel = (label && label.trim()) || `${scenario} — ${new Date().toLocaleDateString()}`;
  const info = db.prepare('INSERT INTO versions (workspace_id, label, scenario, timestamp, data) VALUES (?,?,?,?,?)')
    .run(req.user.workspaceId, finalLabel, scenario, timestamp, JSON.stringify(snapshot));

  res.json({ id: info.lastInsertRowid, label: finalLabel, scenario, timestamp, data: snapshot });
});

app.put('/api/versions/:id/restore', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM versions WHERE id = ? AND workspace_id = ?').get(Number(req.params.id), req.user.workspaceId);
  if (!row) return res.status(404).json({ error: 'version not found' });
  const snapshot = JSON.parse(row.data);

  const del = db.prepare('DELETE FROM cells WHERE workspace_id = ? AND scenario = ?');
  const insert = db.prepare('INSERT INTO cells (workspace_id, scenario, entity, account, month, value) VALUES (?,?,?,?,?,?)');
  withTransaction(() => {
    del.run(req.user.workspaceId, row.scenario);
    Object.entries(snapshot).forEach(([entity, accounts]) => {
      Object.entries(accounts).forEach(([account, months]) => {
        Object.entries(months).forEach(([month, value]) => insert.run(req.user.workspaceId, row.scenario, entity, account, month, value));
      });
    });
  });

  res.json({ ok: true, scenario: row.scenario, data: snapshot });
});

app.delete('/api/versions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM versions WHERE id = ? AND workspace_id = ?').run(Number(req.params.id), req.user.workspaceId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Rosebud server listening on http://localhost:${PORT}`));
