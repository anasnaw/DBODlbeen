/**
 * DBO Cloud Backend
 * Google Apps Script -> Google Sheets database + Google Drive files
 *
 * 1) Run setupDBO() once.
 * 2) Deploy this script as a Web App:
 *      Execute as: Me
 *      Who has access: Anyone
 * 3) Copy the /exec URL.
 * 4) In Cloudflare Pages add:
 *      DBO_APPS_SCRIPT_URL = the /exec URL
 *      DBO_API_SECRET      = the secret printed by setupDBO()
 */

const DBO = {
  recordsSheet: "DBO_RECORDS",
  authSheet: "DBO_AUTH",
  metaSheet: "DBO_META",
  chunkSize: 35000,
  arrayEntities: ["contents","tasks","scripts","assets","marketingRequests","claims","influencers","events","reports","utmLinks","users"],
  mapEntities: ["activityThreads","taskExtras"],
  singletonEntities: ["profile"],
  folderNames: {
    content: "01 Content",
    task: "02 Tasks",
    script: "03 Scripts",
    influencer: "04 Influencers",
    event: "05 Events",
    report: "06 Reports",
    asset: "07 Brand Assets"
  }
};

function setupDBO() {
  const props = PropertiesService.getScriptProperties();

  let rootId = props.getProperty("DBO_ROOT_FOLDER_ID");
  let root;
  if (rootId) {
    try { root = DriveApp.getFolderById(rootId); } catch (e) {}
  }
  if (!root) {
    root = DriveApp.createFolder("DBO - Dlbeen Brand Management OS");
    rootId = root.getId();
    props.setProperty("DBO_ROOT_FOLDER_ID", rootId);
  }

  Object.keys(DBO.folderNames).forEach(function(key) {
    const propKey = "DBO_FOLDER_" + key.toUpperCase();
    let id = props.getProperty(propKey);
    let folder = null;
    if (id) {
      try { folder = DriveApp.getFolderById(id); } catch (e) {}
    }
    if (!folder) {
      folder = root.createFolder(DBO.folderNames[key]);
      props.setProperty(propKey, folder.getId());
    }
  });

  let ssId = props.getProperty("DBO_SPREADSHEET_ID");
  let ss;
  if (ssId) {
    try { ss = SpreadsheetApp.openById(ssId); } catch (e) {}
  }
  if (!ss) {
    ss = SpreadsheetApp.create("DBO Cloud Database");
    ssId = ss.getId();
    props.setProperty("DBO_SPREADSHEET_ID", ssId);
    try {
      const file = DriveApp.getFileById(ssId);
      file.moveTo(root);
    } catch (e) {}
  }

  ensureSheet_(ss, DBO.recordsSheet, ["Entity","RecordID","ChunkIndex","ChunkCount","JSONChunk","UpdatedAt","UpdatedBy"]);
  ensureSheet_(ss, DBO.authSheet, ["UserID","Salt","PinHash","UpdatedAt"]);
  ensureSheet_(ss, DBO.metaSheet, ["Key","Value"]);

  let secret = props.getProperty("DBO_API_SECRET");
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g,"") + Utilities.getUuid().replace(/-/g,"");
    props.setProperty("DBO_API_SECRET", secret);
  }

  setMeta_("schema_version", "1");
  setMeta_("created_or_checked_at", new Date().toISOString());

  const result = {
    ok: true,
    spreadsheetUrl: ss.getUrl(),
    rootFolderUrl: root.getUrl(),
    apiSecret: secret
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function doGet() {
  return json_({ok:true, service:"DBO Cloud API", version:1});
}

function doPost(e) {
  try {
    const request = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    verifySecret_(request.secret);
    const action = String(request.action || "");
    const payload = request.payload || {};

    if (action === "ping") return json_({ok:true, time:new Date().toISOString()});
    if (action === "load") return json_(loadState_());
    if (action === "sync") return json_(sync_(payload));
    if (action === "login") return json_(login_(payload));
    if (action === "uploadFile") return json_(uploadFile_(payload));
    if (action === "downloadFile") return json_(downloadFile_(payload));
    if (action === "deleteFile") return json_(deleteFile_(payload));

    return json_({ok:false,error:"Unknown action"});
  } catch (err) {
    console.error(err);
    return json_({ok:false,error:String(err && err.message ? err.message : err)});
  }
}

function loadState_() {
  const ss = db_();
  const records = readRecords_(ss);
  const keys = Object.keys(records);
  const state = {};

  DBO.arrayEntities.forEach(function(k){ state[k] = []; });
  DBO.mapEntities.forEach(function(k){ state[k] = {}; });
  DBO.singletonEntities.forEach(function(k){ state[k] = {}; });

  const auth = readAuth_(ss);

  keys.forEach(function(key) {
    const rec = records[key];
    let data;
    try { data = JSON.parse(rec.json); } catch (e) { return; }

    if (DBO.arrayEntities.indexOf(rec.entity) >= 0) {
      if (rec.entity === "users") {
        delete data.pin;
        data.hasPin = !!auth[rec.id];
      }
      state[rec.entity].push(data);
    } else if (DBO.mapEntities.indexOf(rec.entity) >= 0) {
      state[rec.entity][rec.id] = data;
    } else if (DBO.singletonEntities.indexOf(rec.entity) >= 0) {
      state[rec.entity] = data;
    }
  });

  return {
    ok: true,
    empty: keys.length === 0,
    state: state,
    updatedAt: getMeta_("last_sync_at") || ""
  };
}

function sync_(payload) {
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  const actor = payload.actor || {};
  if (!changes.length) return {ok:true,changed:0};

  const ss = db_();
  const records = readRecords_(ss);
  const auth = readAuth_(ss);
  const allowed = DBO.arrayEntities.concat(DBO.mapEntities, DBO.singletonEntities);
  let authChanged = false;
  let changed = 0;
  const now = new Date().toISOString();

  changes.forEach(function(change) {
    const entity = String(change.entity || "");
    const id = String(change.id || "");
    const op = String(change.op || "");
    if (!entity || !id || allowed.indexOf(entity) < 0) return;

    const key = entity + "\u0001" + id;

    if (op === "delete") {
      delete records[key];
      if (entity === "users" && auth[id]) {
        delete auth[id];
        authChanged = true;
      }
      changed++;
      return;
    }

    if (op !== "upsert") return;

    let data = change.data == null ? {} : JSON.parse(JSON.stringify(change.data));

    if (entity === "users") {
      const clearPin = String(data.pin || "");
      delete data.pin;
      if (clearPin) {
        const salt = Utilities.getUuid().replace(/-/g,"");
        auth[id] = {
          userId: id,
          salt: salt,
          hash: hashPin_(salt, clearPin),
          updatedAt: now
        };
        authChanged = true;
      }
      data.hasPin = !!auth[id];
    }

    records[key] = {
      entity: entity,
      id: id,
      json: JSON.stringify(data),
      updatedAt: now,
      updatedBy: String(actor.name || actor.id || "")
    };
    changed++;
  });

  writeRecords_(ss, records);
  if (authChanged) writeAuth_(ss, auth);
  setMeta_("last_sync_at", now);
  setMeta_("last_sync_by", String(actor.name || actor.id || ""));

  return {ok:true,changed:changed,updatedAt:now};
}

function login_(payload) {
  const userId = String(payload.userId || "");
  const pin = String(payload.pin || "");
  if (!userId) return {ok:true,authenticated:false};

  const auth = readAuth_(db_());
  const row = auth[userId];
  if (!row) return {ok:true,authenticated:true,hasPin:false};

  const actual = hashPin_(row.salt, pin);
  return {ok:true,authenticated:constantTimeEqual_(actual,row.hash),hasPin:true};
}

function uploadFile_(payload) {
  const name = safeFileName_(String(payload.name || "DBO-file"));
  const type = String(payload.type || "application/octet-stream");
  const base64 = String(payload.base64 || "");
  const ownerType = String(payload.ownerType || "");
  const ownerId = String(payload.ownerId || "");
  const category = String(payload.category || "");

  if (!base64) throw new Error("No file data received.");
  if (base64.length > 12 * 1024 * 1024) {
    throw new Error("This upload is too large for the DBO web uploader. Upload large files directly to the DBO Google Drive folder and paste the Drive link in DBO.");
  }

  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, type, name);
  const folder = folderFor_(ownerType);
  const file = folder.createFile(blob);

  try {
    file.setDescription("DBO | " + ownerType + " | " + ownerId + " | " + category);
  } catch (e) {}

  return {
    ok: true,
    file: {
      key: "gdrive:" + file.getId(),
      driveId: file.getId(),
      name: name,
      type: type,
      size: Number(payload.size || bytes.length || 0),
      category: category,
      url: file.getUrl()
    }
  };
}

function downloadFile_(payload) {
  const id = String(payload.driveId || "");
  if (!id) throw new Error("No Google Drive file was selected.");

  try {
    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    const bytes = blob.getBytes();
    return {
      ok: true,
      file: {
        name: file.getName() || blob.getName() || "DBO-file",
        type: file.getMimeType() || blob.getContentType() || "application/octet-stream",
        size: bytes.length,
        base64: Utilities.base64Encode(bytes)
      }
    };
  } catch (e) {
    throw new Error("Could not download the original Google Drive file.");
  }
}

function deleteFile_(payload) {
  const id = String(payload.driveId || "");
  if (!id) return {ok:true};
  try {
    DriveApp.getFileById(id).setTrashed(true);
  } catch (e) {
    throw new Error("Could not delete the Google Drive file.");
  }
  return {ok:true};
}

function db_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("DBO_SPREADSHEET_ID");
  if (!id) throw new Error("DBO is not initialized. Run setupDBO() first.");
  return SpreadsheetApp.openById(id);
}

function verifySecret_(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty("DBO_API_SECRET");
  if (!expected) throw new Error("DBO API secret is not configured. Run setupDBO().");
  if (!constantTimeEqual_(String(secret || ""), expected)) throw new Error("Unauthorized DBO request.");
}

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else {
    sheet.getRange(1,1,1,headers.length).setValues([headers]);
  }
  return sheet;
}

function readRecords_(ss) {
  const sheet = ensureSheet_(ss, DBO.recordsSheet, ["Entity","RecordID","ChunkIndex","ChunkCount","JSONChunk","UpdatedAt","UpdatedBy"]);
  const last = sheet.getLastRow();
  const out = {};
  if (last < 2) return out;

  const rows = sheet.getRange(2,1,last-1,7).getValues();
  const groups = {};
  rows.forEach(function(r) {
    const entity = String(r[0] || "");
    const id = String(r[1] || "");
    const index = Number(r[2] || 0);
    const count = Number(r[3] || 0);
    const chunk = String(r[4] || "");
    if (!entity || !id || index < 1) return;
    const key = entity + "\u0001" + id;
    if (!groups[key]) groups[key] = {entity:entity,id:id,count:count,chunks:[],updatedAt:String(r[5]||""),updatedBy:String(r[6]||"")};
    groups[key].chunks[index-1] = chunk;
  });

  Object.keys(groups).forEach(function(key) {
    const g = groups[key];
    if (g.chunks.filter(function(x){return typeof x === "string";}).length !== g.count) return;
    out[key] = {
      entity:g.entity,
      id:g.id,
      json:g.chunks.join(""),
      updatedAt:g.updatedAt,
      updatedBy:g.updatedBy
    };
  });
  return out;
}

function writeRecords_(ss, records) {
  const sheet = ensureSheet_(ss, DBO.recordsSheet, ["Entity","RecordID","ChunkIndex","ChunkCount","JSONChunk","UpdatedAt","UpdatedBy"]);
  const rows = [];
  Object.keys(records).sort().forEach(function(key) {
    const r = records[key];
    const chunks = chunk_(String(r.json || ""), DBO.chunkSize);
    chunks.forEach(function(c, i) {
      rows.push([r.entity,r.id,i+1,chunks.length,c,r.updatedAt||"",r.updatedBy||""]);
    });
  });

  if (sheet.getLastRow() > 1) sheet.getRange(2,1,sheet.getLastRow()-1,7).clearContent();
  if (rows.length) sheet.getRange(2,1,rows.length,7).setValues(rows);
  const extra = sheet.getLastRow() - (rows.length + 1);
  if (extra > 0) sheet.getRange(rows.length+2,1,extra,7).clearContent();
}

function readAuth_(ss) {
  const sheet = ensureSheet_(ss, DBO.authSheet, ["UserID","Salt","PinHash","UpdatedAt"]);
  const out = {};
  const last = sheet.getLastRow();
  if (last < 2) return out;
  sheet.getRange(2,1,last-1,4).getValues().forEach(function(r) {
    const id = String(r[0] || "");
    if (!id) return;
    out[id] = {userId:id,salt:String(r[1]||""),hash:String(r[2]||""),updatedAt:String(r[3]||"")};
  });
  return out;
}

function writeAuth_(ss, auth) {
  const sheet = ensureSheet_(ss, DBO.authSheet, ["UserID","Salt","PinHash","UpdatedAt"]);
  const rows = Object.keys(auth).sort().map(function(id) {
    const a = auth[id];
    return [id,a.salt||"",a.hash||"",a.updatedAt||""];
  });
  if (sheet.getLastRow() > 1) sheet.getRange(2,1,sheet.getLastRow()-1,4).clearContent();
  if (rows.length) sheet.getRange(2,1,rows.length,4).setValues(rows);
}

function setMeta_(key, value) {
  const ss = db_();
  const sheet = ensureSheet_(ss, DBO.metaSheet, ["Key","Value"]);
  const last = sheet.getLastRow();
  if (last >= 2) {
    const values = sheet.getRange(2,1,last-1,1).getValues();
    for (let i=0;i<values.length;i++) {
      if (String(values[i][0]) === String(key)) {
        sheet.getRange(i+2,2).setValue(String(value));
        return;
      }
    }
  }
  sheet.appendRow([String(key),String(value)]);
}

function getMeta_(key) {
  const ss = db_();
  const sheet = ensureSheet_(ss, DBO.metaSheet, ["Key","Value"]);
  const last = sheet.getLastRow();
  if (last < 2) return "";
  const values = sheet.getRange(2,1,last-1,2).getValues();
  for (let i=0;i<values.length;i++) if (String(values[i][0]) === String(key)) return String(values[i][1]||"");
  return "";
}

function folderFor_(ownerType) {
  const props = PropertiesService.getScriptProperties();
  const k = String(ownerType || "").toLowerCase();
  const id = props.getProperty("DBO_FOLDER_" + k.toUpperCase());
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) {}
  }
  const rootId = props.getProperty("DBO_ROOT_FOLDER_ID");
  if (!rootId) throw new Error("DBO Drive folder is not initialized. Run setupDBO().");
  return DriveApp.getFolderById(rootId);
}

function hashPin_(salt, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + ":" + String(pin), Utilities.Charset.UTF_8);
  return bytes.map(function(b){const n=(b<0?b+256:b);return ("0"+n.toString(16)).slice(-2);}).join("");
}

function constantTimeEqual_(a,b) {
  a=String(a||""); b=String(b||"");
  let diff=a.length^b.length;
  const len=Math.max(a.length,b.length);
  for(let i=0;i<len;i++) diff |= (a.charCodeAt(i%Math.max(a.length,1))||0) ^ (b.charCodeAt(i%Math.max(b.length,1))||0);
  return diff===0;
}

function chunk_(text, size) {
  if (!text) return [""];
  const out=[];
  for(let i=0;i<text.length;i+=size) out.push(text.slice(i,i+size));
  return out;
}

function safeFileName_(name) {
  return String(name||"DBO-file").replace(/[\\/:*?"<>|]+/g,"_").slice(0,180);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
