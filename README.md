# DBO · Dlbeen Brand Management OS — Online Edition (v5)

One small Node.js server runs everything: the DBO app, the login system, the shared database (SQLite) and all file attachments. Everyone opens the same web address and works on the same live data.

## Roles

| | User | Manager | Super User |
|---|:-:|:-:|:-:|
| View every section | ✓ | ✓ | ✓ |
| Add and edit content, tasks, scripts, influencers, events, reports, assets | ✓ | ✓ | ✓ |
| Approve / reject / request changes (Approvals) | – | ✓ | ✓ |
| Schedule or publish content that is not approved yet | – | ✓ | ✓ |
| Delete records and attached files | – | ✓ | ✓ |
| Edit company settings | – | ✓ | ✓ |
| Add / edit / disable / delete users, change any password | – | – | ✓ |
| Backup, restore, reset, activity log | – | – | ✓ |

The rules are enforced **on the server**, not only hidden in the screen, so they cannot be bypassed from the browser.
If a normal user edits content that is already approved, it automatically goes back to **Review**.

## Security behaviour

- Sign-in is required **every time the page is opened** (the session lives only in that open tab).
- The app locks itself after **30 minutes** without activity.
- **Switch user** is in the account menu (click your initials, top right).
- Passwords are hashed with scrypt. Changing a password or disabling an account signs that person out everywhere.
- 8 wrong passwords in 15 minutes temporarily block that username from that address.
- There must always be at least one active Super User (the server refuses to remove the last one).
- Every login, change, approval, deletion and user change is recorded in **Users & Access → Activity Log**.

## First start

1. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` (see `.env.example`). If you don't set a password, the server creates one and prints it in the logs and in `DATA_DIR/initial-admin-password.txt`.
2. Start the server and open its address. Sign in as the super user.
3. Change your password: initials (top right) → **Change my password**.
4. **Users & Access → Add User** for each team member and choose their role.

## Move your existing data in (from the single-file version)

1. In the old DBO file: **Company & Backup → Export JSON** (includes attachments).
2. In the online DBO, as super user: **Company & Backup → Import JSON**, choose that file.

Everything comes across: content, tasks, scripts, influencers, agreements, deliverables, events, reports, assets and their files.

## Deploying (pick one)

The only hard requirement: **`DATA_DIR` must be on a persistent disk / volume**, or the database is lost when the server restarts. Always use HTTPS (all options below provide it).

### A. Railway (simplest)
1. Push this `server` folder to a GitHub repository.
2. Railway → New Project → Deploy from GitHub repo (it detects the Dockerfile).
3. Add a **Volume** mounted at `/data`.
4. Variables: `ADMIN_USERNAME`, `ADMIN_PASSWORD` (the Dockerfile already sets `DATA_DIR=/data`).
5. Settings → Networking → Generate Domain (or add your own domain, e.g. `dbo.dlbeen.com`).

### B. Render
New → Web Service from your GitHub repo (Docker). Add a **Persistent Disk** mounted at `/data` (requires a paid instance type), set the same variables.

### C. Your own server / VPS (Docker)
```bash
cd server
# edit ADMIN_PASSWORD in docker-compose.yml first
docker compose up -d --build
```
Put it behind a reverse proxy with HTTPS (Caddy, Nginx + Let's Encrypt, or Cloudflare Tunnel).

### D. Without Docker (any machine with Node.js 18+)
```bash
cd server
npm ci --omit=dev
ADMIN_PASSWORD='choose-a-strong-one' DATA_DIR=/var/lib/dbo node server.js
```
Use a process manager (pm2 or systemd) so it restarts automatically.

## Backups

- Super user: **Company & Backup → Export JSON** downloads everything including attachments.
- Server level: back up the `DATA_DIR` folder (`dbo.sqlite` + `files/`). Copy it while the server is stopped, or use `sqlite3 dbo.sqlite ".backup backup.sqlite"`.

## Settings (environment variables)

| Name | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Web port |
| `DATA_DIR` | `./data` | Database + uploaded files (persistent!) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | admin / generated / Super Admin | First super user (only when the database is empty) |
| `SESSION_IDLE_MINUTES` | 120 | Server-side idle sign-out |
| `SESSION_MAX_HOURS` | 24 | Longest a session can live |
| `MAX_FILE_MB` | 100 | Largest single upload |

## How live sync works (for developers)

Each record (content item, task, agreement…) is stored separately with a version number. The browser sends only the records that changed; other browsers pick up changes every few seconds. If two people edit the same record at the same moment, the second save is refused, that person sees the newer version, and a message tells them who changed it — nothing is silently overwritten.

API: `POST /api/login`, `GET /api/bootstrap`, `GET /api/changes?since=`, `POST /api/sync`, `POST|GET|DELETE /api/files`, `/api/users` (super), `/api/audit` (super), `/api/backup` · `/api/restore` · `/api/reset` (super).
