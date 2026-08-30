# DBO Cloud — Dlbeen Brand Management OS

This package converts the current DBO V2 into a shared online system **without redesigning the interface**.

## Architecture

Cloudflare Pages (`*.pages.dev`)
→ `/api` Cloudflare Pages Function
→ Google Apps Script
→ Google Sheets (shared DBO data)
→ Google Drive (uploaded files)

The browser still keeps a local copy as an offline fallback, but Google Sheets becomes the shared source for the team.

---

## Package contents

- `public/index.html` — the current DBO design with cloud synchronization added.
- `functions/api.js` — same-origin Cloudflare proxy. It keeps the Google Apps Script secret out of the browser.
- `google-apps-script/Code.gs` — creates and manages the Google Sheets database and Drive folders.
- `google-apps-script/appsscript.json` — Apps Script project manifest.
- `DBO_Cloud_Database_Template.xlsx` — optional reference/template. `setupDBO()` creates the real Google Sheet automatically.

---

# PART 1 — Prepare Google

## 1. Create an Apps Script project

1. Go to `script.google.com`.
2. Create a **New project**.
3. Name it: `DBO Cloud Backend`.
4. Replace the default code with the content of:
   `google-apps-script/Code.gs`
5. In Project Settings, enable showing the `appsscript.json` manifest if needed, and use the included manifest.

## 2. Run setupDBO()

1. Select the function `setupDBO`.
2. Click **Run**.
3. Google will ask you to authorize access to Sheets and Drive.
4. Allow it.
5. Open the execution log.

The function creates:

- `DBO - Dlbeen Brand Management OS` Google Drive folder
- `DBO Cloud Database` Google Sheet
- Content, Tasks, Scripts, Influencers, Events, Reports and Brand Assets folders
- A private API secret

Copy these two values from the returned/logged result:

- `apiSecret`
- `spreadsheetUrl` (keep for your reference)

## 3. Share the Drive folder

Open the newly created `DBO - Dlbeen Brand Management OS` folder in Google Drive.

Share it with the Google accounts of the Dlbeen team members who must open/download DBO attachments.

**Recommended:** keep the folder Restricted and add only team members.  
Do not use “Anyone with the link” for confidential contracts/reports unless you intentionally want that.

## 4. Deploy Apps Script as a Web App

1. Click **Deploy → New deployment**.
2. Type: **Web app**
3. Execute as: **Me**
4. Who has access: **Anyone**
5. Deploy.
6. Copy the URL ending in `/exec`.

Keep this URL. It will be entered into Cloudflare as `DBO_APPS_SCRIPT_URL`.

The Apps Script endpoint is protected by the secret created by `setupDBO()`.

---

# PART 2 — Put DBO on a free Cloudflare address

Your final address can be similar to:

`https://dlbeen-dbo.pages.dev`

## Recommended deployment: GitHub + Cloudflare Pages

1. Create a free GitHub repository, for example `dlbeen-dbo`.
2. Upload the contents of this package to the repository. Keep these folders:
   - `public`
   - `functions`
3. Create a Cloudflare account.
4. Go to **Workers & Pages → Create → Pages → Connect to Git**.
5. Select the repository.
6. Build settings:
   - Framework preset: `None`
   - Build command: leave empty or use `exit 0`
   - Build output directory: `public`
7. Deploy.

Cloudflare will give you a free `*.pages.dev` URL.

## Add the two secret environment variables

Inside the Cloudflare Pages project:

**Settings → Variables and Secrets**

Add:

`DBO_APPS_SCRIPT_URL`
= the Google Apps Script `/exec` URL

`DBO_API_SECRET`
= the secret printed by `setupDBO()`

Set both for **Production**.

Redeploy the project.

---

# PART 3 — First online launch

Open your new `*.pages.dev` address.

DBO will:

1. Connect to the Cloudflare `/api` endpoint.
2. Connect to Google Apps Script.
3. Load the shared Google Sheets data.
4. Keep the existing DBO UI and responsive layout.
5. Poll for team changes approximately every 45 seconds and refresh when the browser becomes active.

If the Google database is empty, the first browser initializes it from the DBO state currently loaded in that browser.

---

# PART 4 — Move your current DBO information into DBO Cloud

Before switching fully online:

1. Open your current local DBO V2.
2. Go to **Company & Backup**.
3. Export the JSON backup.
4. Open the new online DBO Cloud.
5. Import that JSON backup.

The import uses the existing DBO import feature and then syncs the records to Google Sheets.

## Important about old attachments

The previous DBO stored contracts/report/event/task files in the browser's IndexedDB. Those binary files are not contained in the normal JSON backup.

Therefore, existing old attachments should be re-uploaded in DBO Cloud so they are moved into Google Drive.

Thumbnails/script visuals that were stored inside the DBO state can sync through Google Sheets.

---

# File upload behavior

New DBO files up to **8 MB** are uploaded automatically to Google Drive.

This is ideal for:

- influencer contracts
- PDFs
- Word/Excel documents
- images
- small report files
- task attachments

For large event videos/raw footage, upload the video directly into the DBO Google Drive folder and use the existing event/folder link fields in DBO. This avoids Apps Script upload limits.

---

# Login / PIN security

User profiles remain in the DBO Team & Access module.

When a PIN is entered for a user:

- DBO sends it through the Cloudflare proxy.
- Google Apps Script salts and hashes it with SHA-256.
- The plain PIN is not stored in the Google Sheet.
- The browser validates login through the cloud API.

Users without a PIN remain able to sign in without a PIN, matching the current DBO behavior. For production, set a PIN for every team member.

---

# Google Sheet structure

The live database has:

### DBO_RECORDS
Stores each DBO entity as JSON. Large JSON records are split into chunks so thumbnails and long content are not limited by one Google Sheets cell.

### DBO_AUTH
Stores only:
- user ID
- random salt
- PIN hash
- update timestamp

### DBO_META
Stores sync/schema information.

Do not manually change `DBO_RECORDS` while staff are actively using DBO.

---

# Free-service notes

This setup is intended for a small/medium internal marketing team. Google Apps Script, Google Drive and Cloudflare all have quotas. The architecture is suitable for ordinary DBO usage, but it is not designed for large public traffic or uploading large raw video files through the browser.

---

# Quick test checklist

After deployment, test from two devices:

1. Login on PC.
2. Add a task.
3. Open DBO on phone.
4. Confirm the task appears.
5. Change the task to In Progress.
6. Confirm PC receives the change after refresh/poll.
7. Add a comment.
8. Upload a small PDF attachment.
9. Confirm the file appears in Google Drive.
10. Test Content Calendar and Script Studio.
11. Export a script as PPT/PDF.
12. Test Super Admin / Manager / User permissions.

When all tests pass, use the Cloud version as the team's main DBO.
