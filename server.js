const express = require('express');
const cors = require('cors');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ — no native compile step
const path = require('path');
const { MONTHS, ENTITIES, INPUT_ACCOUNTS, PRODUCTS, PRODUCT_DIMENSIONED_ACCOUNTS, seedValues } = require('./seed');
const {
  bcrypt, FRONTEND_URL, ROLES, ROLE_RANK, signToken, requireAuth, randomToken,
  sendPasswordResetEmail, sendInviteEmail,
} = require('./auth');

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
  CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id INTEGER NOT NULL,
    user_id      INTEGER NOT NULL,
    role         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    token        TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    email        TEXT NOT NULL,
    role         TEXT NOT NULL,
    invited_by   INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    accepted_at  TEXT
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    label        TEXT NOT NULL,
    scenario     TEXT NOT NULL,
    timestamp    TEXT NOT NULL,
    data         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS backups (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    label        TEXT NOT NULL,
    created_by   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    data         TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dimension_nodes (
    workspace_id INTEGER NOT NULL,
    dimension    TEXT NOT NULL,
    id           TEXT NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    parent_id    TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    attrs        TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (workspace_id, dimension, id)
  );
  CREATE TABLE IF NOT EXISTS dimension_attribute_defs (
    workspace_id INTEGER NOT NULL,
    dimension    TEXT NOT NULL,
    name         TEXT NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, dimension, name)
  );
`);

// The real Products/Accounts/Entities structure — same IDs the budgeting
// engine itself uses (revenue, product_revenue, core_widget, sales, etc.) —
// so this hierarchy metadata genuinely describes your actual workspace, not
// placeholder data. Driver-only account rows (units_sold, headcount, etc.)
// are intentionally excluded: they're formula inputs, not structural members.
const HIERARCHY_SEED = {
  Products: [
    { id: 'products_root', name: 'All Products', type: 'cat', parentId: null },
    { id: 'hardware', name: 'Hardware', type: 'cat', parentId: 'products_root' },
    { id: 'core_widget', name: 'Core Widget', type: 'leaf', parentId: 'hardware' },
    { id: 'widget_mini', name: 'Widget Mini', type: 'leaf', parentId: 'hardware' },
    { id: 'software', name: 'Software', type: 'cat', parentId: 'products_root' },
    { id: 'platform_license', name: 'Platform License', type: 'leaf', parentId: 'software' },
    { id: 'addon_modules', name: 'Add-on Modules', type: 'leaf', parentId: 'software' },
  ],
  Accounts: [
    { id: 'accounts_root', name: 'All Accounts', type: 'cat', parentId: null },
    { id: 'revenue', name: 'Revenue', type: 'cat', parentId: 'accounts_root' },
    { id: 'product_revenue', name: 'Product Revenue', type: 'leaf', parentId: 'revenue' },
    { id: 'service_revenue', name: 'Service Revenue', type: 'leaf', parentId: 'revenue' },
    { id: 'expenses', name: 'Expenses', type: 'cat', parentId: 'accounts_root' },
    { id: 'personnel', name: 'Personnel Costs', type: 'leaf', parentId: 'expenses' },
    { id: 'marketing_spend', name: 'Marketing Spend', type: 'leaf', parentId: 'expenses' },
    { id: 'software_acct', name: 'Software & Tools', type: 'leaf', parentId: 'expenses' },
    { id: 'travel', name: 'Travel & Entertainment', type: 'leaf', parentId: 'expenses' },
  ],
  Entities: [
    { id: 'entities_root', name: 'Company', type: 'cat', parentId: null },
    { id: 'sales', name: 'Sales', type: 'leaf', parentId: 'entities_root' },
    { id: 'marketing', name: 'Marketing', type: 'leaf', parentId: 'entities_root' },
    { id: 'engineering', name: 'Engineering', type: 'leaf', parentId: 'entities_root' },
    { id: 'ga', name: 'G&A', type: 'leaf', parentId: 'entities_root' },
  ],
};
// The real 'account' column value for the Software & Tools expense line is
// literally 'software' — but that collides with the Products category
// 'software' (Hardware/Software). They're safe (different `dimension`
// values keep the primary key unique), but the usage-count lookup joins
// against the real `account` column by this node's id, so this one node
// needs to map back to the true account id used in `cells`.
const HIERARCHY_ID_TO_CELL_VALUE = { software_acct: 'software' };

function seedRealHierarchy(workspaceId) {
  const insertNode = db.prepare('INSERT INTO dimension_nodes (workspace_id, dimension, id, name, type, parent_id, sort_order, attrs) VALUES (?,?,?,?,?,?,?,?)');
  withTransaction(() => {
    Object.entries(HIERARCHY_SEED).forEach(([dimension, nodes]) => {
      nodes.forEach((n, i) => insertNode.run(workspaceId, dimension, n.id, n.name, n.type, n.parentId, i, '{}'));
    });
  });
}
function backfillHierarchyForExistingWorkspaces() {
  const workspaces = db.prepare('SELECT id FROM workspaces').all();
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM dimension_nodes WHERE workspace_id = ?');
  workspaces.forEach((w) => { if (countStmt.get(w.id).c === 0) seedRealHierarchy(w.id); });
}

// Every existing workspace's owner becomes an admin member — cheap, idempotent,
// and lets accounts created before roles existed keep working with no data loss.
function backfillOwnerMemberships() {
  const workspaces = db.prepare('SELECT id, owner_user_id, created_at FROM workspaces').all();
  const insert = db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)');
  workspaces.forEach((w) => insert.run(w.id, w.owner_user_id, 'admin', w.created_at));
}
backfillOwnerMemberships();
backfillHierarchyForExistingWorkspaces();

// --- cells table: migrate in a Product column if this is an existing database
// from before the Product hierarchy existed. SQLite can't ALTER a PRIMARY KEY,
// so this rebuilds the table and backfills old rows with product='none' rather
// than losing any existing users' data.
function ensureCellsTable() {
  const cols = db.prepare("PRAGMA table_info(cells)").all();
  const exists = cols.length > 0;
  const hasProduct = cols.some((c) => c.name === 'product');

  if (exists && !hasProduct) {
    console.log('Migrating cells table to add the product dimension...');
    db.exec('ALTER TABLE cells RENAME TO cells_old');
    db.exec(`
      CREATE TABLE cells (
        workspace_id INTEGER NOT NULL, scenario TEXT NOT NULL, entity TEXT NOT NULL, account TEXT NOT NULL,
        product TEXT NOT NULL DEFAULT 'none', month TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (workspace_id, scenario, entity, account, product, month)
      );
    `);
    db.exec(`
      INSERT INTO cells (workspace_id, scenario, entity, account, product, month, value)
      SELECT workspace_id, scenario, entity, account, 'none', month, value FROM cells_old
    `);
    db.exec('DROP TABLE cells_old');
    console.log('Migration complete — existing cells preserved under product=none.');
  } else if (!exists) {
    db.exec(`
      CREATE TABLE cells (
        workspace_id INTEGER NOT NULL, scenario TEXT NOT NULL, entity TEXT NOT NULL, account TEXT NOT NULL,
        product TEXT NOT NULL DEFAULT 'none', month TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (workspace_id, scenario, entity, account, product, month)
      );
    `);
  }
}
ensureCellsTable();

function withTransaction(fn) {
  db.exec('BEGIN TRANSACTION');
  try { fn(); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
}

function seedWorkspace(workspaceId) {
  const insert = db.prepare('INSERT INTO cells (workspace_id, scenario, entity, account, product, month, value) VALUES (?,?,?,?,?,?,?)');
  const scenarioSeeds = { Budget: seedValues(1, false), Forecast: seedValues(1.06, true), Actual: seedValues(0.95, true) };
  let count = 0;
  withTransaction(() => {
    Object.entries(scenarioSeeds).forEach(([scenario, data]) => {
      ENTITIES.forEach((e) => {
        INPUT_ACCOUNTS.forEach((account) => {
          if (PRODUCT_DIMENSIONED_ACCOUNTS.includes(account)) {
            PRODUCTS.forEach((p) => {
              MONTHS.forEach((month) => { insert.run(workspaceId, scenario, e.id, account, p.id, month, data[e.id][account][p.id][month]); count += 1; });
            });
          } else {
            MONTHS.forEach((month) => { insert.run(workspaceId, scenario, e.id, account, 'none', month, data[e.id][account][month]); count += 1; });
          }
        });
      });
    });
  });
  console.log(`Seeded workspace ${workspaceId} with ${count} cells.`);
}

function loadValues(workspaceId) {
  const rows = db.prepare('SELECT scenario, entity, account, product, month, value FROM cells WHERE workspace_id = ?').all(workspaceId);
  const values = {};
  rows.forEach((r) => {
    values[r.scenario] ??= {};
    values[r.scenario][r.entity] ??= {};
    values[r.scenario][r.entity][r.account] ??= {};
    values[r.scenario][r.entity][r.account][r.product] ??= {};
    values[r.scenario][r.entity][r.account][r.product][r.month] = r.value;
  });
  return values;
}
function loadVersions(workspaceId) {
  return db.prepare('SELECT id, label, scenario, timestamp, data FROM versions WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId).map((v) => ({ ...v, data: JSON.parse(v.data) }));
}
function countAdmins(workspaceId) {
  return db.prepare("SELECT COUNT(*) AS c FROM workspace_members WHERE workspace_id = ? AND role = 'admin'").get(workspaceId).c;
}

// Re-checks the caller's role from the database on every request — a JWT's
// embedded role is a UI convenience only, never the security boundary, since a
// token can outlive a role change or removal from the workspace.
function requireRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  return (req, res, next) => {
    const row = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.user.workspaceId, req.user.userId);
    if (!row) return res.status(403).json({ error: 'not a member of this workspace' });
    if (ROLE_RANK[row.role] < minRank) return res.status(403).json({ error: `requires ${minRole} role or higher` });
    req.membershipRole = row.role;
    next();
  };
}

const app = express();
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : {}));
app.use(express.json());

/* ---------------------------------------------------------------------- *
 *  AUTH
 * ---------------------------------------------------------------------- */

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, workspaceName, inviteToken } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'a valid email is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) return res.status(409).json({ error: 'an account with that email already exists' });

  let invite = null;
  if (inviteToken) {
    invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(inviteToken);
    if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'this invite link is invalid or has expired' });
    }
    if (invite.email !== cleanEmail) {
      return res.status(400).json({ error: `this invite was sent to ${invite.email} — sign up with that email to accept it` });
    }
  }

  const now = new Date().toISOString();
  const passwordHash = bcrypt.hashSync(password, 10);
  const userInfo = db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?)').run(cleanEmail, passwordHash, now);
  const userId = userInfo.lastInsertRowid;

  let workspaceId, finalWorkspaceName, role;
  if (invite) {
    workspaceId = invite.workspace_id;
    role = invite.role;
    finalWorkspaceName = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId).name;
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)').run(workspaceId, userId, role, now);
    db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(now, inviteToken);
  } else {
    finalWorkspaceName = (workspaceName || '').trim() || `${cleanEmail.split('@')[0]}'s workspace`;
    workspaceId = db.prepare('INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?,?,?)').run(finalWorkspaceName, userId, now).lastInsertRowid;
    role = 'admin';
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)').run(workspaceId, userId, role, now);
    seedWorkspace(workspaceId);
    seedRealHierarchy(workspaceId);
  }

  const token = signToken({ id: userId, email: cleanEmail }, { id: workspaceId }, role);
  res.json({ token, user: { email: cleanEmail }, workspace: { id: workspaceId, name: finalWorkspaceName, role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !password) return res.status(400).json({ error: 'email and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'invalid email or password' });

  const memberships = db.prepare(`
    SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ? ORDER BY wm.created_at ASC
  `).all(user.id);
  if (memberships.length === 0) return res.status(500).json({ error: 'account has no workspace — contact support' });

  const primary = memberships[0];
  const token = signToken(user, { id: primary.id }, primary.role);
  res.json({ token, user: { email: user.email }, workspace: { id: primary.id, name: primary.name, role: primary.role }, workspaces: memberships });
});

app.post('/api/auth/switch-workspace', requireAuth, (req, res) => {
  const { workspaceId } = req.body || {};
  const membership = db.prepare(`
    SELECT wm.role, w.name FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.workspace_id = ? AND wm.user_id = ?
  `).get(workspaceId, req.user.userId);
  if (!membership) return res.status(403).json({ error: 'you are not a member of that workspace' });
  const token = signToken({ id: req.user.userId, email: req.user.email }, { id: workspaceId }, membership.role);
  res.json({ token, workspace: { id: workspaceId, name: membership.name, role: membership.role } });
});

app.get('/api/auth/my-workspaces', requireAuth, (req, res) => {
  const memberships = db.prepare(`
    SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ? ORDER BY wm.created_at ASC
  `).all(req.user.userId);
  res.json({ workspaces: memberships });
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const cleanEmail = ((req.body && req.body.email) || '').trim().toLowerCase();
  const user = cleanEmail ? db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail) : null;
  if (user) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?,?,?)').run(token, user.id, expiresAt);
    await sendPasswordResetEmail(user.email, `${FRONTEND_URL}/?resetToken=${token}`);
  }
  res.json({ ok: true });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'a reset token and an 8+ character new password are required' });
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token);
  if (!row || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'this reset link is invalid or has expired' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), row.user_id);
  db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------- *
 *  INVITES
 * ---------------------------------------------------------------------- */

app.post('/api/workspace/invite', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, role } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'a valid email is required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });

  const existingMember = db.prepare(`
    SELECT wm.workspace_id FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND u.email = ?
  `).get(req.user.workspaceId, cleanEmail);
  if (existingMember) return res.status(409).json({ error: 'this person is already a member of this workspace' });

  const token = randomToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.user.workspaceId);
  db.prepare('INSERT INTO invites (token, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(token, req.user.workspaceId, cleanEmail, role, req.user.userId, now, expiresAt);

  const inviteLink = `${FRONTEND_URL}/?inviteToken=${token}`;
  await sendInviteEmail(cleanEmail, inviteLink, workspace.name, role);
  res.json({ ok: true, email: cleanEmail, role, inviteLink });
});

app.get('/api/invites/:token', (req, res) => {
  const invite = db.prepare(`
    SELECT i.email, i.role, i.expires_at, i.accepted_at, w.name AS workspaceName
    FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token = ?
  `).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.accepted_at) return res.status(400).json({ error: 'this invite has already been used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'this invite has expired' });
  res.json({ email: invite.email, role: invite.role, workspaceName: invite.workspaceName });
});

app.post('/api/invites/:token/accept', requireAuth, (req, res) => {
  const invite = db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.accepted_at) return res.status(400).json({ error: 'this invite has already been used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'this invite has expired' });
  if (invite.email !== req.user.email) return res.status(403).json({ error: `this invite was sent to ${invite.email}, not ${req.user.email}` });

  const now = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?,?,?,?)').run(invite.workspace_id, req.user.userId, invite.role, now);
  db.prepare('UPDATE invites SET accepted_at = ? WHERE token = ?').run(now, req.params.token);

  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(invite.workspace_id);
  const token = signToken({ id: req.user.userId, email: req.user.email }, { id: invite.workspace_id }, invite.role);
  res.json({ token, workspace: { id: invite.workspace_id, name: workspace.name, role: invite.role } });
});

/* ---------------------------------------------------------------------- *
 *  MEMBERS
 * ---------------------------------------------------------------------- */

app.get('/api/workspace/members', requireAuth, requireRole('viewer'), (req, res) => {
  const members = db.prepare(`
    SELECT u.id AS userId, u.email, wm.role, wm.created_at AS joinedAt
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? ORDER BY wm.created_at ASC
  `).all(req.user.workspaceId);
  res.json({ members });
});

app.put('/api/workspace/members/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const targetUserId = Number(req.params.userId);
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  if (targetUserId === req.user.userId) {
    return res.status(400).json({ error: "you can't change your own role — ask another admin to do it" });
  }
  const current = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.user.workspaceId, targetUserId);
  if (!current) return res.status(404).json({ error: 'that person is not a member of this workspace' });
  if (current.role === 'admin' && role !== 'admin' && countAdmins(req.user.workspaceId) <= 1) {
    return res.status(400).json({ error: 'a workspace needs at least one admin — promote someone else first' });
  }
  db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, req.user.workspaceId, targetUserId);
  res.json({ ok: true });
});

app.delete('/api/workspace/members/:userId', requireAuth, requireRole('admin'), (req, res) => {
  const targetUserId = Number(req.params.userId);
  if (targetUserId === req.user.userId) {
    return res.status(400).json({ error: "you can't remove yourself from a workspace — ask another admin to do it" });
  }
  const current = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.user.workspaceId, targetUserId);
  if (!current) return res.status(404).json({ error: 'that person is not a member of this workspace' });
  if (current.role === 'admin' && countAdmins(req.user.workspaceId) <= 1) {
    return res.status(400).json({ error: 'a workspace needs at least one admin — promote someone else before removing them' });
  }
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(req.user.workspaceId, targetUserId);
  res.json({ ok: true });
});



/* ---------------------------------------------------------------------- *
 *  WORKSPACE DATA
 * ---------------------------------------------------------------------- */

app.get('/api/workspace', requireAuth, requireRole('viewer'), (req, res) => {
  const workspace = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(req.user.workspaceId);
  res.json({ values: loadValues(req.user.workspaceId), versions: loadVersions(req.user.workspaceId), workspace: { ...workspace, role: req.membershipRole } });
});

// Full-fidelity payload shared by the instant "Download Backup" button and the
// persisted Backups list — everything needed to fully reconstruct the workspace
// (all scenarios, all products/entities/months, every saved version, and the
// member list) in one file.
function buildBackupPayload(workspaceId) {
  const workspace = db.prepare('SELECT id, name, created_at FROM workspaces WHERE id = ?').get(workspaceId);
  const members = db.prepare(`
    SELECT u.email, wm.role, wm.created_at AS joinedAt FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY wm.created_at ASC
  `).all(workspaceId);
  return {
    exportedAt: new Date().toISOString(),
    app: 'Rosebud',
    backupVersion: 1,
    workspace,
    members,
    values: loadValues(workspaceId),
    versions: loadVersions(workspaceId),
  };
}

app.get('/api/workspace/backup', requireAuth, requireRole('power'), (req, res) => {
  res.json(buildBackupPayload(req.user.workspaceId));
});

// Persisted backups — created on demand, stored server-side, browsable and
// downloadable later. Power users and Admins only.
app.post('/api/workspace/backups', requireAuth, requireRole('power'), (req, res) => {
  const { label } = req.body || {};
  const now = new Date().toISOString();
  const finalLabel = (label && label.trim()) || `Backup — ${new Date().toLocaleString()}`;
  const payload = buildBackupPayload(req.user.workspaceId);
  const info = db.prepare('INSERT INTO backups (workspace_id, label, created_by, created_at, data) VALUES (?,?,?,?,?)')
    .run(req.user.workspaceId, finalLabel, req.user.email, now, JSON.stringify(payload));
  res.json({ id: info.lastInsertRowid, label: finalLabel, createdBy: req.user.email, createdAt: now });
});

app.get('/api/workspace/backups', requireAuth, requireRole('power'), (req, res) => {
  const backups = db.prepare(`
    SELECT id, label, created_by AS createdBy, created_at AS createdAt
    FROM backups WHERE workspace_id = ? ORDER BY created_at DESC
  `).all(req.user.workspaceId);
  res.json({ backups });
});

app.get('/api/workspace/backups/:id', requireAuth, requireRole('power'), (req, res) => {
  const row = db.prepare('SELECT data FROM backups WHERE id = ? AND workspace_id = ?').get(Number(req.params.id), req.user.workspaceId);
  if (!row) return res.status(404).json({ error: 'backup not found' });
  res.json(JSON.parse(row.data));
});

app.delete('/api/workspace/backups/:id', requireAuth, requireRole('power'), (req, res) => {
  db.prepare('DELETE FROM backups WHERE id = ? AND workspace_id = ?').run(Number(req.params.id), req.user.workspaceId);
  res.json({ ok: true });
});

// Restores live scenario data from a stored backup. Deliberately touches only
// cell values (every scenario the backup contains) — never the member list or
// the saved-versions history, so restoring can't accidentally change who has
// access or erase separate version snapshots someone else was relying on.
app.put('/api/workspace/backups/:id/restore', requireAuth, requireRole('power'), (req, res) => {
  const row = db.prepare('SELECT data FROM backups WHERE id = ? AND workspace_id = ?').get(Number(req.params.id), req.user.workspaceId);
  if (!row) return res.status(404).json({ error: 'backup not found' });
  const backup = JSON.parse(row.data);

  const del = db.prepare('DELETE FROM cells WHERE workspace_id = ? AND scenario = ?');
  const insert = db.prepare('INSERT INTO cells (workspace_id, scenario, entity, account, product, month, value) VALUES (?,?,?,?,?,?,?)');
  withTransaction(() => {
    Object.entries(backup.values || {}).forEach(([scenario, entities]) => {
      del.run(req.user.workspaceId, scenario);
      Object.entries(entities).forEach(([entity, accounts]) => {
        Object.entries(accounts).forEach(([account, products]) => {
          Object.entries(products).forEach(([product, months]) => {
            Object.entries(months).forEach(([month, value]) => insert.run(req.user.workspaceId, scenario, entity, account, product, month, value));
          });
        });
      });
    });
  });

  res.json({ ok: true, values: loadValues(req.user.workspaceId) });
});

/* ---------------------------------------------------------------------- *
 *  HIERARCHY EDITOR — Power/Admin only. Structural metadata for Products/
 *  Accounts/Entities, seeded from the real dimensions. Editing this does
 *  NOT yet change how the P&L grid itself calculates — see the app's
 *  in-UI note. Deleting a node never touches `cells` data, only this
 *  table, so it's always safe to re-add something later.
 * ---------------------------------------------------------------------- */
const DIMENSION_CELL_COLUMN = { Products: 'product', Accounts: 'account', Entities: 'entity' };

function buildHierarchyTree(rows) {
  const byId = {};
  rows.forEach((r) => { byId[r.id] = { id: r.id, name: r.name, type: r.type, attrs: JSON.parse(r.attrs || '{}'), children: r.type === 'cat' ? [] : undefined }; });
  let root = null;
  rows.slice().sort((a, b) => a.sort_order - b.sort_order).forEach((r) => {
    const node = byId[r.id];
    if (r.parent_id === null) root = node;
    else if (byId[r.parent_id]) byId[r.parent_id].children.push(node);
  });
  return root;
}
function collectDescendantIds(allRows, startId) {
  const ids = new Set([startId]);
  let changed = true;
  while (changed) {
    changed = false;
    allRows.forEach((r) => { if (r.parent_id && ids.has(r.parent_id) && !ids.has(r.id)) { ids.add(r.id); changed = true; } });
  }
  return ids;
}

app.get('/api/workspace/hierarchy/:dimension', requireAuth, requireRole('power'), (req, res) => {
  const { dimension } = req.params;
  if (!DIMENSION_CELL_COLUMN[dimension]) return res.status(400).json({ error: 'unknown dimension' });
  const rows = db.prepare('SELECT id, name, type, parent_id, sort_order, attrs FROM dimension_nodes WHERE workspace_id = ? AND dimension = ?').all(req.user.workspaceId, dimension);
  if (rows.length === 0) return res.status(404).json({ error: 'dimension not found for this workspace' });
  const attributeDefs = db.prepare('SELECT name FROM dimension_attribute_defs WHERE workspace_id = ? AND dimension = ? ORDER BY sort_order').all(req.user.workspaceId, dimension).map((r) => r.name);
  res.json({ tree: buildHierarchyTree(rows), attributeDefs });
});

app.post('/api/workspace/hierarchy/:dimension/nodes', requireAuth, requireRole('power'), (req, res) => {
  const { dimension } = req.params;
  const { parentId, name, type } = req.body || {};
  if (!DIMENSION_CELL_COLUMN[dimension]) return res.status(400).json({ error: 'unknown dimension' });
  if (!parentId || !name || !['cat', 'leaf'].includes(type)) return res.status(400).json({ error: 'parentId, name, and a valid type are required' });
  const parent = db.prepare('SELECT id, type FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?').get(req.user.workspaceId, dimension, parentId);
  if (!parent) return res.status(404).json({ error: 'parent not found' });
  if (parent.type !== 'cat') return res.status(400).json({ error: 'can only add items under a category' });
  const nid = `${dimension.toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM dimension_nodes WHERE workspace_id=? AND dimension=?').get(req.user.workspaceId, dimension).m;
  db.prepare('INSERT INTO dimension_nodes (workspace_id, dimension, id, name, type, parent_id, sort_order, attrs) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.user.workspaceId, dimension, nid, name, type, parentId, maxOrder + 1, '{}');
  res.json({ id: nid, name, type, attrs: {} });
});

app.put('/api/workspace/hierarchy/:dimension/nodes/:id', requireAuth, requireRole('power'), (req, res) => {
  const { dimension, id } = req.params;
  const row = db.prepare('SELECT * FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?').get(req.user.workspaceId, dimension, id);
  if (!row) return res.status(404).json({ error: 'node not found' });
  const { name, attrs } = req.body || {};
  const newName = name !== undefined ? name : row.name;
  const newAttrs = attrs !== undefined ? JSON.stringify(attrs) : row.attrs;
  db.prepare('UPDATE dimension_nodes SET name=?, attrs=? WHERE workspace_id=? AND dimension=? AND id=?').run(newName, newAttrs, req.user.workspaceId, dimension, id);
  res.json({ ok: true });
});

app.put('/api/workspace/hierarchy/:dimension/nodes/:id/move', requireAuth, requireRole('power'), (req, res) => {
  const { dimension, id } = req.params;
  const { newParentId } = req.body || {};
  const node = db.prepare('SELECT * FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?').get(req.user.workspaceId, dimension, id);
  const newParent = db.prepare('SELECT * FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?').get(req.user.workspaceId, dimension, newParentId);
  if (!node || !newParent) return res.status(404).json({ error: 'node not found' });
  if (node.parent_id === null) return res.status(400).json({ error: 'the dimension root cannot be moved' });
  if (node.type === 'cat') return res.status(400).json({ error: 'categories cannot be moved — only items' });
  if (newParent.type !== 'cat') return res.status(400).json({ error: 'items can only be moved into a category' });
  db.prepare('UPDATE dimension_nodes SET parent_id=? WHERE workspace_id=? AND dimension=? AND id=?').run(newParentId, req.user.workspaceId, dimension, id);
  res.json({ ok: true });
});

app.delete('/api/workspace/hierarchy/:dimension/nodes/:id', requireAuth, requireRole('power'), (req, res) => {
  const { dimension, id } = req.params;
  const row = db.prepare('SELECT parent_id FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?').get(req.user.workspaceId, dimension, id);
  if (!row) return res.status(404).json({ error: 'node not found' });
  if (row.parent_id === null) return res.status(400).json({ error: 'the dimension root cannot be deleted' });
  const allRows = db.prepare('SELECT id, parent_id FROM dimension_nodes WHERE workspace_id=? AND dimension=?').all(req.user.workspaceId, dimension);
  const toDelete = collectDescendantIds(allRows, id);
  const del = db.prepare('DELETE FROM dimension_nodes WHERE workspace_id=? AND dimension=? AND id=?');
  withTransaction(() => { toDelete.forEach((did) => del.run(req.user.workspaceId, dimension, did)); });
  res.json({ ok: true, deletedIds: [...toDelete] });
});

app.put('/api/workspace/hierarchy/:dimension/attributes', requireAuth, requireRole('power'), (req, res) => {
  const { dimension } = req.params;
  const { action, name } = req.body || {};
  if (!name || !['add', 'remove'].includes(action)) return res.status(400).json({ error: 'action ("add"/"remove") and name are required' });
  if (action === 'add') {
    const exists = db.prepare('SELECT 1 FROM dimension_attribute_defs WHERE workspace_id=? AND dimension=? AND name=?').get(req.user.workspaceId, dimension, name);
    if (!exists) {
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM dimension_attribute_defs WHERE workspace_id=? AND dimension=?').get(req.user.workspaceId, dimension).m;
      db.prepare('INSERT INTO dimension_attribute_defs (workspace_id, dimension, name, sort_order) VALUES (?,?,?,?)').run(req.user.workspaceId, dimension, name, maxOrder + 1);
    }
  } else {
    db.prepare('DELETE FROM dimension_attribute_defs WHERE workspace_id=? AND dimension=? AND name=?').run(req.user.workspaceId, dimension, name);
  }
  res.json({ ok: true });
});

// Real usage count — sums matching rows in the actual `cells` table across
// every scenario/month, following category nodes down to their leaves.
app.get('/api/workspace/hierarchy/:dimension/usage/:id', requireAuth, requireRole('power'), (req, res) => {
  const { dimension, id } = req.params;
  const col = DIMENSION_CELL_COLUMN[dimension];
  if (!col) return res.status(400).json({ error: 'unknown dimension' });
  const allRows = db.prepare('SELECT id, parent_id, type FROM dimension_nodes WHERE workspace_id=? AND dimension=?').all(req.user.workspaceId, dimension);
  const descendantIds = collectDescendantIds(allRows, id);
  const leafIds = allRows.filter((r) => descendantIds.has(r.id) && r.type === 'leaf').map((r) => HIERARCHY_ID_TO_CELL_VALUE[r.id] || r.id);
  if (leafIds.length === 0) return res.json({ count: 0 });
  const placeholders = leafIds.map(() => '?').join(',');
  const count = db.prepare(`SELECT COUNT(*) AS c FROM cells WHERE workspace_id = ? AND ${col} IN (${placeholders})`).get(req.user.workspaceId, ...leafIds).c;
  res.json({ count });
});

app.put('/api/cell', requireAuth, requireRole('editor'), (req, res) => {
  const { scenario, entity, account, month, value, product } = req.body || {};
  const prod = product || 'none';
  if (!scenario || !entity || !account || !month || typeof value !== 'number' || Number.isNaN(value)) {
    return res.status(400).json({ error: 'scenario, entity, account, month, and a numeric value are required' });
  }
  if (!INPUT_ACCOUNTS.includes(account)) return res.status(400).json({ error: `${account} is not an editable input account` });
  const isProductAccount = PRODUCT_DIMENSIONED_ACCOUNTS.includes(account);
  if (isProductAccount && !PRODUCTS.some((p) => p.id === prod)) return res.status(400).json({ error: `${prod} is not a recognized product` });
  if (!isProductAccount && prod !== 'none') return res.status(400).json({ error: `${account} does not carry a product dimension` });

  db.prepare(`
    INSERT INTO cells (workspace_id, scenario, entity, account, product, month, value) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id, scenario, entity, account, product, month) DO UPDATE SET value = excluded.value
  `).run(req.user.workspaceId, scenario, entity, account, prod, month, value);
  res.json({ ok: true });
});

app.post('/api/versions', requireAuth, requireRole('editor'), (req, res) => {
  const { scenario, label } = req.body || {};
  if (!scenario) return res.status(400).json({ error: 'scenario is required' });
  const rows = db.prepare('SELECT entity, account, product, month, value FROM cells WHERE workspace_id = ? AND scenario = ?').all(req.user.workspaceId, scenario);
  const snapshot = {};
  rows.forEach((r) => {
    snapshot[r.entity] ??= {};
    snapshot[r.entity][r.account] ??= {};
    snapshot[r.entity][r.account][r.product] ??= {};
    snapshot[r.entity][r.account][r.product][r.month] = r.value;
  });
  const timestamp = new Date().toISOString();
  const finalLabel = (label && label.trim()) || `${scenario} — ${new Date().toLocaleDateString()}`;
  const info = db.prepare('INSERT INTO versions (workspace_id, label, scenario, timestamp, data) VALUES (?,?,?,?,?)')
    .run(req.user.workspaceId, finalLabel, scenario, timestamp, JSON.stringify(snapshot));
  res.json({ id: info.lastInsertRowid, label: finalLabel, scenario, timestamp, data: snapshot });
});

app.put('/api/versions/:id/restore', requireAuth, requireRole('editor'), (req, res) => {
  const row = db.prepare('SELECT * FROM versions WHERE id = ? AND workspace_id = ?').get(Number(req.params.id), req.user.workspaceId);
  if (!row) return res.status(404).json({ error: 'version not found' });
  const snapshot = JSON.parse(row.data);
  const del = db.prepare('DELETE FROM cells WHERE workspace_id = ? AND scenario = ?');
  const insert = db.prepare('INSERT INTO cells (workspace_id, scenario, entity, account, product, month, value) VALUES (?,?,?,?,?,?,?)');
  withTransaction(() => {
    del.run(req.user.workspaceId, row.scenario);
    Object.entries(snapshot).forEach(([entity, accounts]) => {
      Object.entries(accounts).forEach(([account, products]) => {
        Object.entries(products).forEach(([product, months]) => {
          Object.entries(months).forEach(([month, value]) => insert.run(req.user.workspaceId, row.scenario, entity, account, product, month, value));
        });
      });
    });
  });
  res.json({ ok: true, scenario: row.scenario, data: snapshot });
});

app.delete('/api/versions/:id', requireAuth, requireRole('editor'), (req, res) => {
  db.prepare('DELETE FROM versions WHERE id = ? AND workspace_id = ?').run(Number(req.params.id), req.user.workspaceId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Rosebud server listening on http://localhost:${PORT}`));
