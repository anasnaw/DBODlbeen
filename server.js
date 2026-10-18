/* DBO · Dlbeen Brand Management OS — online server
 * Node.js + Express + SQLite. One process serves the app, the API, the database and file attachments.
 * Roles:  user    → view, add and edit. Cannot delete, cannot approve.
 *         manager → everything a user can + approvals + delete + company settings.
 *         super   → everything + users & passwords + backup / restore / reset + activity log.
 * Permissions are enforced here on the server; the UI only mirrors them.
 */
"use strict";
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const FILE_DIR = path.join(DATA_DIR, "files");
const SESSION_IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES || 120);
const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS || 24);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 100);
fs.mkdirSync(FILE_DIR, { recursive: true });

// ---------------------------------------------------------------- database
const db = new Database(path.join(DATA_DIR, "dbo.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','manager','super')), pass TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_login INTEGER);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, agent TEXT);
CREATE TABLE IF NOT EXISTS records(
  collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT, version INTEGER NOT NULL, seq INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT, updated_by_name TEXT,
  PRIMARY KEY(collection, id));
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE TABLE IF NOT EXISTS files(
  key TEXT PRIMARY KEY, name TEXT, type TEXT, size INTEGER, owner_type TEXT, owner_id TEXT, category TEXT,
  created_by TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, user_name TEXT, action TEXT NOT NULL,
  collection TEXT, record_id TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`);
const kvGet = (k, d) => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? r.v : d; };
const kvSet = (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v));
const nextSeq = () => { const s = Number(kvGet("seq", "0")) + 1; kvSet("seq", s); return s; };

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const newId = () => crypto.randomBytes(9).toString("base64url");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const h = crypto.scryptSync(pw, Buffer.from(salt, "base64"), 64, { N: Number(N), r: 8, p: 1 });
    const expected = Buffer.from(hash, "base64");
    return h.length === expected.length && crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}
const ROLES = ["user", "manager", "super"];
const RANK = { user: 1, manager: 2, super: 3 };
const can = {
  delete: (u) => RANK[u.role] >= 2,
  approve: (u) => RANK[u.role] >= 2,
  settings: (u) => RANK[u.role] >= 2,
  admin: (u) => u.role === "super",
};
const COLLECTIONS = new Set(["contents", "tasks", "scripts", "assets", "influencers", "influencerAgreements", "influencerDeliverables", "events", "reports", "marketingRequests", "claims", "utmLinks", "_settings"]);
const SETTINGS_IDS = new Set(["profile", "influencerReportNotes", "meta"]);
const APPROVAL_STATUSES = new Set(["Approved", "Rejected", "Changes Requested"]);
const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active, createdAt: u.created_at, updatedAt: u.updated_at, lastLogin: u.last_login });
function audit(user, action, collection = null, recordId = null, detail = null) {
  db.prepare("INSERT INTO audit(at,user_id,user_name,action,collection,record_id,detail) VALUES(?,?,?,?,?,?,?)")
    .run(now(), user ? user.id : null, user ? user.name : null, action, collection, recordId, detail == null ? null : String(detail).slice(0, 500));
}
function recordTitle(collection, d) {
  if (!d) return "";
  if (collection === "_settings") return "";
  return String(d.title || d.name || d.campaign || d.month || "").slice(0, 120);
}

// ---------------------------------------------------------------- first super user
if (!db.prepare("SELECT COUNT(*) n FROM users").get().n) {
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  let password = process.env.ADMIN_PASSWORD || "";
  let generated = false;
  if (password.length < 8) { password = crypto.randomBytes(9).toString("base64url"); generated = true; }
  db.prepare("INSERT INTO users(id,username,name,role,pass,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)")
    .run(newId(), username, process.env.ADMIN_NAME || "Super Admin", "super", hashPassword(password), now(), now());
  const msg = `\n=== DBO first start ===\nSuper user created → username: ${username}  password: ${generated ? password : "(from ADMIN_PASSWORD)"}\nChange this password after the first login.\n`;
  console.log(msg);
  if (generated) fs.writeFileSync(path.join(DATA_DIR, "initial-admin-password.txt"), msg, { mode: 0o600 });
}

// ---------------------------------------------------------------- app
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000");
  next();
});

// ---- auth middleware
function auth(req, res, next) {
  const h = req.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Login required" });
  const s = db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(sha256(token));
  const t = now();
  if (!s || s.expires_at < t || s.last_seen + SESSION_IDLE_MIN * 60000 < t) {
    if (s) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(s.token_hash);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  if (!u || !u.active) { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(s.token_hash); return res.status(401).json({ error: "Account disabled" }); }
  if (t - s.last_seen > 30000) db.prepare("UPDATE sessions SET last_seen=? WHERE token_hash=?").run(t, s.token_hash);
  req.user = u; req.tokenHash = s.token_hash;
  next();
}
const requireRole = (check, msg) => (req, res, next) => (check(req.user) ? next() : res.status(403).json({ error: msg || "You don't have permission for this action." }));

// ---- login rate limiting (in memory)
const attempts = new Map();
function limited(key) { const a = attempts.get(key); return a && a.count >= 8 && now() - a.first < 15 * 60000; }
function failed(key) { const a = attempts.get(key); if (!a || now() - a.first > 15 * 60000) attempts.set(key, { count: 1, first: now() }); else a.count++; }

const json = express.json({ limit: "25mb" });

app.get("/api/health", (req, res) => res.json({ ok: true, time: now() }));

app.post("/api/login", json, (req, res) => {
  const username = String(req.body?.username || "").trim(), password = String(req.body?.password || "");
  const key = (req.ip || "") + "|" + username.toLowerCase();
  if (limited(key)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!u || !verifyPassword(password, u.pass)) { failed(key); audit(u || { id: null, name: username }, "login_failed"); return res.status(401).json({ error: "Wrong username or password" }); }
  if (!u.active) return res.status(403).json({ error: "This account is disabled. Contact the super user." });
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString("base64url"), t = now();
  db.prepare("DELETE FROM sessions WHERE expires_at<?").run(t);
  db.prepare("INSERT INTO sessions(token_hash,user_id,created_at,last_seen,expires_at,ip,agent) VALUES(?,?,?,?,?,?,?)")
    .run(sha256(token), u.id, t, t, t + SESSION_MAX_HOURS * 3600000, req.ip || "", String(req.get("user-agent") || "").slice(0, 200));
  db.prepare("UPDATE users SET last_login=? WHERE id=?").run(t, u.id);
  audit(u, "login");
  res.json({ token, user: publicUser({ ...u, last_login: t }), idleMinutes: SESSION_IDLE_MIN });
});
app.post("/api/logout", auth, (req, res) => { db.prepare("DELETE FROM sessions WHERE token_hash=?").run(req.tokenHash); audit(req.user, "logout"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.post("/api/me/password", auth, json, (req, res) => {
  const { current, password } = req.body || {};
  if (!verifyPassword(String(current || ""), req.user.pass)) return res.status(400).json({ error: "Current password is wrong" });
  if (String(password || "").length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });
  db.prepare("UPDATE users SET pass=?,updated_at=? WHERE id=?").run(hashPassword(String(password)), now(), req.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(req.user.id, req.tokenHash);
  audit(req.user, "password_changed_self");
  res.json({ ok: true });
});

// ---- data
const rowOut = (r) => ({ c: r.collection, id: r.id, data: r.deleted ? null : JSON.parse(r.data), version: r.version, seq: r.seq, deleted: !!r.deleted, updatedAt: r.updated_at, updatedBy: r.updated_by_name });
const userNames = () => db.prepare("SELECT id,name,role,active FROM users").all().map((u) => ({ id: u.id, name: u.name, role: u.role, active: !!u.active }));
app.get("/api/bootstrap", auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM records WHERE deleted=0").all();
  res.json({ seq: Number(kvGet("seq", "0")), records: rows.map(rowOut), user: publicUser(req.user), users: userNames(), serverTime: now() });
});
app.get("/api/changes", auth, (req, res) => {
  const since = Number(req.query.since || 0);
  const rows = db.prepare("SELECT * FROM records WHERE seq>? ORDER BY seq LIMIT 1000").all(since);
  const seq = rows.length ? rows[rows.length - 1].seq : Math.max(since, Number(kvGet("seq", "0")));
  res.json({ seq, more: rows.length === 1000, records: rows.map(rowOut) });
});

function checkChange(user, c, id, oldData, newData) {
  if (!COLLECTIONS.has(c)) return "Unknown collection";
  if (!ID_RE.test(id)) return "Invalid record id";
  if (c === "_settings" && !SETTINGS_IDS.has(id)) return "Unknown setting";
  if (newData === null) {
    if (c === "_settings") return "Settings cannot be deleted";
    return can.delete(user) ? null : "Only managers can delete records.";
  }
  if (typeof newData !== "object" || Array.isArray(newData)) return "Invalid data";
  if (c === "_settings" && id === "profile" && !can.settings(user)) return "Only managers can change company settings.";
  if (c === "contents" && !can.approve(user)) {
    const oldStatus = oldData ? oldData.status : undefined;
    if (APPROVAL_STATUSES.has(newData.status) && newData.status !== oldStatus) return "Only managers can approve, reject or request changes.";
    if (JSON.stringify(oldData?.approvals || []) !== JSON.stringify(newData.approvals || [])) return "Only managers can record approval decisions.";
    if (["Scheduled", "Published"].includes(newData.status) && newData.status !== oldStatus && !["Approved", "Scheduled", "Published"].includes(oldStatus)) return "Content must be approved by a manager before it can be scheduled or published.";
  }
  return null;
}
app.post("/api/sync", auth, json, (req, res) => {
  const changes = Array.isArray(req.body?.changes) ? req.body.changes.slice(0, 500) : [];
  const user = req.user, results = [];
  const get = db.prepare("SELECT * FROM records WHERE collection=? AND id=?");
  const upsert = db.prepare(`INSERT INTO records(collection,id,data,version,seq,deleted,updated_at,updated_by,updated_by_name) VALUES(@c,@id,@data,@version,@seq,@deleted,@at,@by,@byName)
    ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,version=excluded.version,seq=excluded.seq,deleted=excluded.deleted,updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name`);
  const tx = db.transaction(() => {
    for (const ch of changes) {
      const c = String(ch?.c || ""), id = String(ch?.id || ""), base = Number(ch?.base || 0);
      const data = ch?.data === null ? null : ch?.data;
      const cur = COLLECTIONS.has(c) && ID_RE.test(id) ? get.get(c, id) : null;
      const curVersion = cur ? cur.version : 0, curData = cur && !cur.deleted ? JSON.parse(cur.data) : null;
      const err = checkChange(user, c, id, curData, data);
      if (err) { results.push({ c, id, ok: false, reason: "forbidden", error: err, record: cur ? rowOut(cur) : null }); continue; }
      if (data !== null) { const s = JSON.stringify(data); if (s.length > 8 * 1024 * 1024) { results.push({ c, id, ok: false, reason: "invalid", error: "Record too large" }); continue; } }
      if (curVersion !== base && !(cur && cur.deleted && data === null)) {
        // Someone else changed it since this browser last saw it.
        if (cur && !cur.deleted && data !== null && cur.data === JSON.stringify({ ...data, id })) { results.push({ c, id, ok: true, version: cur.version, seq: cur.seq }); continue; }
        results.push({ c, id, ok: false, reason: "conflict", error: `Changed by ${cur?.updated_by_name || "another user"} while you were editing.`, record: cur ? rowOut(cur) : null }); continue;
      }
      if (data === null && (!cur || cur.deleted)) { results.push({ c, id, ok: true, version: curVersion, seq: cur ? cur.seq : 0 }); continue; }
      const seq = nextSeq(), version = curVersion + 1, at = now();
      upsert.run({ c, id, data: data === null ? null : JSON.stringify({ ...data, id }), version, seq, deleted: data === null ? 1 : 0, at, by: user.id, byName: user.name });
      const title = recordTitle(c, data || curData);
      if (data === null) audit(user, "delete", c, id, title);
      else if (c === "contents" && curData && curData.status !== data.status) audit(user, APPROVAL_STATUSES.has(data.status) ? "approval:" + data.status : "status:" + data.status, c, id, title);
      else if (c !== "_settings" || id === "profile") audit(user, cur && !cur.deleted ? "update" : "create", c, id, title);
      results.push({ c, id, ok: true, version, seq });
    }
  });
  tx();
  res.json({ results, seq: Number(kvGet("seq", "0")) });
});

// ---- files (attachments)
const fileRow = (f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, category: f.category });
const filePath = (key) => path.join(FILE_DIR, key.replace(/[^A-Za-z0-9_-]/g, ""));
app.post("/api/files", auth, express.raw({ type: () => true, limit: MAX_FILE_MB + "mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Empty file" });
  const key = newId() + newId(), q = req.query;
  fs.writeFileSync(filePath(key), req.body);
  db.prepare("INSERT INTO files(key,name,type,size,owner_type,owner_id,category,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(key, String(q.name || "file").slice(0, 200), String(q.type || "application/octet-stream").slice(0, 120), req.body.length, String(q.ownerType || "").slice(0, 40), String(q.ownerId || "").slice(0, 120), String(q.category || "").slice(0, 40), req.user.id, now());
  res.json(fileRow(db.prepare("SELECT * FROM files WHERE key=?").get(key)));
});
app.get("/api/files/:key", auth, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE key=?").get(req.params.key);
  if (!f || !fs.existsSync(filePath(f.key))) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", f.type || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name || "file")}`);
  res.setHeader("Cache-Control", "private, max-age=3600");
  fs.createReadStream(filePath(f.key)).pipe(res);
});
app.delete("/api/files/:key", auth, (req, res) => {
  const f = db.prepare("SELECT * FROM files WHERE key=?").get(req.params.key);
  if (!f) return res.json({ ok: true });
  if (!can.delete(req.user) && f.created_by !== req.user.id) return res.status(403).json({ error: "Only managers can delete files uploaded by others." });
  db.prepare("DELETE FROM files WHERE key=?").run(f.key);
  fs.rmSync(filePath(f.key), { force: true });
  audit(req.user, "file_delete", f.owner_type, f.owner_id, f.name);
  res.json({ ok: true });
});

// ---- users (super user only)
const admin = [auth, requireRole(can.admin, "Only the super user can manage users.")];
const activeSupers = (excludeId) => db.prepare("SELECT COUNT(*) n FROM users WHERE role='super' AND active=1 AND id<>?").get(excludeId || "").n;
app.get("/api/users", ...admin, (req, res) => res.json({ users: db.prepare("SELECT * FROM users ORDER BY created_at").all().map(publicUser) }));
app.post("/api/users", ...admin, json, (req, res) => {
  const b = req.body || {}, username = String(b.username || "").trim(), name = String(b.name || "").trim(), role = String(b.role || "user"), password = String(b.password || "");
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(username)) return res.status(400).json({ error: "Username: 3–40 letters, numbers, . _ @ -" });
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!ROLES.includes(role)) return res.status(400).json({ error: "Invalid role" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
  if (db.prepare("SELECT 1 FROM users WHERE username=?").get(username)) return res.status(409).json({ error: "This username already exists" });
  const id = newId(), t = now();
  db.prepare("INSERT INTO users(id,username,name,role,pass,active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)").run(id, username, name, role, hashPassword(password), t, t);
  audit(req.user, "user_create", "users", id, `${name} (${username}) · ${role}`);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id)) });
});
app.patch("/api/users/:id", ...admin, json, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const b = req.body || {}, upd = {}, notes = [];
  if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ error: "Name is required" }); upd.name = n; }
  if (b.username !== undefined) { const n = String(b.username).trim(); if (!/^[A-Za-z0-9._@-]{3,40}$/.test(n)) return res.status(400).json({ error: "Username: 3–40 letters, numbers, . _ @ -" }); const ex = db.prepare("SELECT id FROM users WHERE username=?").get(n); if (ex && ex.id !== u.id) return res.status(409).json({ error: "This username already exists" }); upd.username = n; }
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) return res.status(400).json({ error: "Invalid role" }); upd.role = b.role; }
  if (b.active !== undefined) upd.active = b.active ? 1 : 0;
  const losingSuper = u.role === "super" && u.active && ((upd.role && upd.role !== "super") || upd.active === 0);
  if (losingSuper && activeSupers(u.id) === 0) return res.status(400).json({ error: "There must always be at least one active super user." });
  if (b.password !== undefined) { if (String(b.password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" }); upd.pass = hashPassword(String(b.password)); notes.push("password reset"); }
  if (!Object.keys(upd).length) return res.json({ user: publicUser(u) });
  upd.updated_at = now();
  db.prepare(`UPDATE users SET ${Object.keys(upd).map((k) => k + "=@" + k).join(",")} WHERE id=@id`).run({ ...upd, id: u.id });
  if (upd.pass || upd.active === 0 || upd.role) db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(u.id, req.tokenHash);
  ["name", "username", "role", "active"].forEach((k) => { if (upd[k] !== undefined && upd[k] !== u[k]) notes.push(`${k}: ${u[k]} → ${upd[k]}`); });
  audit(req.user, "user_update", "users", u.id, `${u.name}: ${notes.join(", ")}`);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)) });
});
app.delete("/api/users/:id", ...admin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.json({ ok: true });
  if (u.id === req.user.id) return res.status(400).json({ error: "You cannot delete your own account." });
  if (u.role === "super" && u.active && activeSupers(u.id) === 0) return res.status(400).json({ error: "There must always be at least one active super user." });
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  audit(req.user, "user_delete", "users", u.id, `${u.name} (${u.username})`);
  res.json({ ok: true });
});
app.get("/api/audit", ...admin, (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit || 300));
  res.json({ entries: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) });
});

// ---- backup / restore / reset (super user only)
const ARRAY_COLLECTIONS = [...COLLECTIONS].filter((c) => c !== "_settings");
app.get("/api/backup", ...admin, (req, res) => {
  const out = { __dboBackup: { version: 3, exportedAt: new Date().toISOString(), exportedBy: req.user.name, source: "DBO online server" } };
  ARRAY_COLLECTIONS.forEach((c) => (out[c] = []));
  for (const r of db.prepare("SELECT collection,id,data FROM records WHERE deleted=0").all()) {
    const d = JSON.parse(r.data);
    if (r.collection === "_settings") out[r.id] = d.value !== undefined ? d.value : d; else out[r.collection].push(d);
  }
  const includeFiles = req.query.files !== "0";
  out.__files = includeFiles ? db.prepare("SELECT * FROM files").all().filter((f) => fs.existsSync(filePath(f.key))).map((f) => ({ key: f.key, name: f.name, type: f.type, size: f.size, ownerType: f.owner_type, ownerId: f.owner_id, category: f.category, createdAt: f.created_at, data: `data:${f.type || "application/octet-stream"};base64,${fs.readFileSync(filePath(f.key)).toString("base64")}` })) : [];
  out.__dboBackup.fileCount = out.__files.length;
  audit(req.user, "backup_export", null, null, `${out.__files.length} files`);
  res.setHeader("Content-Disposition", `attachment; filename="DBO_online_backup_${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(out);
});
function tombstoneAll(user) {
  const at = now();
  for (const r of db.prepare("SELECT collection,id,version FROM records WHERE deleted=0").all())
    db.prepare("UPDATE records SET deleted=1,data=NULL,version=?,seq=?,updated_at=?,updated_by=?,updated_by_name=? WHERE collection=? AND id=?").run(r.version + 1, nextSeq(), at, user.id, user.name, r.collection, r.id);
}
function wipeFiles() { for (const f of db.prepare("SELECT key FROM files").all()) fs.rmSync(filePath(f.key), { force: true }); db.prepare("DELETE FROM files").run(); }
app.post("/api/restore", ...admin, express.json({ limit: "500mb" }), (req, res) => {
  const d = req.body || {};
  if (!Array.isArray(d.contents) || !Array.isArray(d.tasks)) return res.status(400).json({ error: "This is not a DBO backup file." });
  const user = req.user; let count = 0, files = 0;
  const tx = db.transaction(() => {
    tombstoneAll(user); wipeFiles();
    const put = (c, id, data) => {
      const cur = db.prepare("SELECT version FROM records WHERE collection=? AND id=?").get(c, id);
      db.prepare(`INSERT INTO records(collection,id,data,version,seq,deleted,updated_at,updated_by,updated_by_name) VALUES(?,?,?,?,?,0,?,?,?)
        ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,version=excluded.version,seq=excluded.seq,deleted=0,updated_at=excluded.updated_at,updated_by=excluded.updated_by,updated_by_name=excluded.updated_by_name`)
        .run(c, id, JSON.stringify({ ...data, id }), (cur ? cur.version : 0) + 1, nextSeq(), now(), user.id, user.name);
      count++;
    };
    for (const c of ARRAY_COLLECTIONS) for (const r of Array.isArray(d[c]) ? d[c] : []) {
      if (!r || typeof r !== "object") continue;
      let id = String(r.id || ""); if (!ID_RE.test(id)) id = newId();
      put(c, id, r);
    }
    if (d.profile && typeof d.profile === "object") put("_settings", "profile", d.profile);
    if (d.influencerReportNotes && typeof d.influencerReportNotes === "object") put("_settings", "influencerReportNotes", { value: d.influencerReportNotes });
    if (d.meta && typeof d.meta === "object") put("_settings", "meta", { value: d.meta });
    for (const f of Array.isArray(d.__files) ? d.__files : []) {
      if (!f || !f.key || !f.data || !/^[A-Za-z0-9_-]{1,120}$/.test(f.key)) continue;
      const b64 = String(f.data).split(",")[1] || "";
      fs.writeFileSync(filePath(f.key), Buffer.from(b64, "base64"));
      db.prepare("INSERT OR REPLACE INTO files(key,name,type,size,owner_type,owner_id,category,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(f.key, String(f.name || "file"), String(f.type || "application/octet-stream"), Number(f.size) || Buffer.byteLength(b64, "base64"), f.ownerType || "", f.ownerId || "", f.category || "", user.id, Number(f.createdAt) || now());
      files++;
    }
  });
  tx();
  audit(user, "backup_restore", null, null, `${count} records, ${files} files`);
  res.json({ ok: true, records: count, files, seq: Number(kvGet("seq", "0")) });
});
app.post("/api/reset", ...admin, json, (req, res) => {
  if (req.body?.confirm !== "RESET") return res.status(400).json({ error: "Confirmation required" });
  db.transaction(() => { tombstoneAll(req.user); wipeFiles(); })();
  audit(req.user, "reset_all");
  res.json({ ok: true, seq: Number(kvGet("seq", "0")) });
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
// ---- static app
app.use(express.static(path.join(__dirname, "public"), {
  index: "index.html",
  setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); },
}));
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "File or data is too large" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log(`DBO server running on http://localhost:${PORT}  (data: ${DATA_DIR})`));
