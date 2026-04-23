/**
 * FlottePPL v27 — Serveur Cloud + Local
 * Prestige Poultry Limited — Yamoussoukro, Côte d'Ivoire
 *
 * Mode automatique:
 *   - Si MONGODB_URI défini (Railway/cloud) → MongoDB Atlas
 *   - Sinon → fichier data.json local
 *
 * Socket.IO pour synchronisation temps réel entre tous les postes
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});
const PORT = process.env.PORT || 3000;

// ── Chemins (auto-détection: Railway flat OU local structuré) ────────
const ROOT = (() => {
  // Mode structuré local: server.js est dans server/, fichiers dans public/
  const structured = path.join(__dirname, '..', 'public');
  if (fs.existsSync(structured)) return { 
    PUBLIC: structured,
    DATA_FILE: path.join(__dirname, '..', 'config', 'data.json'),
    LOG_FILE:  path.join(__dirname, '..', 'config', 'server.log')
  };
  // Mode flat Railway: server.js et index.html sont au même niveau
  return {
    PUBLIC: __dirname,
    DATA_FILE: path.join(__dirname, 'data.json'),
    LOG_FILE:  path.join(__dirname, 'server.log')
  };
})();
const PUBLIC    = ROOT.PUBLIC;
const DATA_FILE = ROOT.DATA_FILE;
const LOG_FILE  = ROOT.LOG_FILE;

// ── Logger ────────────────────────────────────────────────────────────
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try {
    if (!process.env.MONGODB_URI) fs.appendFileSync(LOG_FILE, line + '\n');
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════════════
// COUCHE DONNÉES — MongoDB (cloud) OU JSON local (automatique)
// ══════════════════════════════════════════════════════════════════════

let db = null; // client MongoDB si disponible

const DEFAULT_DATA = {
  _meta: { created: new Date().toISOString(), version: '27.0' },
  p5_accounts: [], p5_inscriptions_pending: [],
  p5_demandes_course: [], p5_approbateurs_course: [],
  p5_course_config: {}, p5_vehicles: [], p5_drivers: [],
  p5_trips: [], p5_missions: [], p5_maint: [],
  p5_fuel: [], p5_docs: [], p5_logs: []
};

// ── Initialiser MongoDB si URI disponible ─────────────────────────────
async function initDB() {
  if (process.env.MONGODB_URI) {
    try {
      const { MongoClient } = require('mongodb');
      const client = await MongoClient.connect(process.env.MONGODB_URI);
      db = client.db('flotteppl');
      log('INFO', 'MongoDB Atlas connecte');

      // Initialiser les collections si vides
      const existing = await db.collection('data').findOne({ _id: 'main' });
      if (!existing) {
        await db.collection('data').insertOne({ _id: 'main', ...DEFAULT_DATA });
        log('INFO', 'Base MongoDB initialisee');
      }
    } catch(e) {
      log('ERROR', 'MongoDB connexion echouee: ' + e.message);
      db = null;
    }
  } else {
    // Mode local: initialiser data.json
    const configDir = path.dirname(DATA_FILE);
    try { if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true }); } catch(e) {}
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
      log('INFO', 'data.json initialise');
    }
  }
}

// ── Lire toutes les données ───────────────────────────────────────────
async function readData() {
  if (db) {
    try {
      const doc = await db.collection('data').findOne({ _id: 'main' });
      if (doc) { delete doc._id; return doc; }
      return { ...DEFAULT_DATA };
    } catch(e) {
      log('ERROR', 'readData MongoDB: ' + e.message);
      return { ...DEFAULT_DATA };
    }
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { ...DEFAULT_DATA }; }
}

// ── Lire une seule clé ────────────────────────────────────────────────
async function readKey(key) {
  if (db) {
    try {
      const doc = await db.collection('data').findOne(
        { _id: 'main' },
        { projection: { [key]: 1 } }
      );
      return doc ? doc[key] ?? null : null;
    } catch(e) { return null; }
  }
  const data = await readData();
  return data[key] ?? null;
}

// ── Écrire une seule clé ──────────────────────────────────────────────
async function writeKey(key, value) {
  if (db) {
    try {
      await db.collection('data').updateOne(
        { _id: 'main' },
        { $set: { [key]: value, '_meta.updated': new Date().toISOString() } },
        { upsert: true }
      );
      return true;
    } catch(e) {
      log('ERROR', 'writeKey MongoDB: ' + e.message);
      return false;
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data[key] = value;
    data._meta = data._meta || {};
    data._meta.updated = new Date().toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch(e) { return false; }
}

// ── Écrire plusieurs clés ─────────────────────────────────────────────
async function writeKeys(updates) {
  const keys = Object.keys(updates).filter(k => k !== '_meta');
  if (db) {
    try {
      const setObj = { '_meta.updated': new Date().toISOString() };
      keys.forEach(k => setObj[k] = updates[k]);
      await db.collection('data').updateOne(
        { _id: 'main' },
        { $set: setObj },
        { upsert: true }
      );
      return keys;
    } catch(e) {
      log('ERROR', 'writeKeys MongoDB: ' + e.message);
      return [];
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    keys.forEach(k => data[k] = updates[k]);
    data._meta = data._meta || {};
    data._meta.updated = new Date().toISOString();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return keys;
  } catch(e) { return []; }
}

// ── Version fichier (cache-busting) ──────────────────────────────────
function getFileVersion() {
  try {
    return crypto.createHash('md5')
      .update(fs.readFileSync(path.join(PUBLIC, 'index.html')))
      .digest('hex').slice(0, 8);
  } catch(e) { return Date.now().toString(36); }
}

// ── IP locale ─────────────────────────────────────────────────────────
function getLocalIP() {
  try {
    const { networkInterfaces } = require('os');
    for (const nets of Object.values(networkInterfaces())) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
  } catch(e) {}
  return 'localhost';
}

// ══════════════════════════════════════════════════════════════════════
// MIDDLEWARES
// ══════════════════════════════════════════════════════════════════════
app.use(express.json({ limit: '10mb' }));

// Anti-cache pour les pages HTML
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') ||
      req.path === '/inscription' || req.path === '/logiciel') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '-1');
  }
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════════════════════════════
// ROUTES HTML
// ══════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  const v = getFileVersion();
  if (!req.query.v || req.query.v !== v) return res.redirect(302, '/?v=' + v);
  res.sendFile(path.join(PUBLIC, 'index.html'));
});

app.get('/logiciel', (req, res) => res.redirect('/'));

app.get('/inscription', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'FlottePPL_Inscription.html'));
});

app.use(express.static(PUBLIC));

// ══════════════════════════════════════════════════════════════════════
// API DONNÉES
// ══════════════════════════════════════════════════════════════════════
app.get('/api/data', async (req, res) => {
  const data = await readData();
  res.json({ ok: true, data });
});

app.get('/api/data/:key', async (req, res) => {
  const value = await readKey(req.params.key);
  res.json({ ok: true, key: req.params.key, value });
});

app.post('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  await writeKey(key, value);
  io.emit('data-update', { key, value, changedBy: 'api' });
  log('SYNC', 'Cle: ' + key);
  res.json({ ok: true });
});

app.post('/api/data', async (req, res) => {
  const changed = await writeKeys(req.body);
  const data = await readData();
  changed.forEach(k => io.emit('data-update', { key: k, value: data[k], changedBy: 'api' }));
  res.json({ ok: true, updated: changed.length });
});

// ══════════════════════════════════════════════════════════════════════
// API INSCRIPTION
// ══════════════════════════════════════════════════════════════════════
app.post('/api/inscription', async (req, res) => {
  const { nom, prenom, service, poste, email, username, password, motif } = req.body;
  if (!nom || !username || !password || !email)
    return res.status(400).json({ ok: false, error: 'Champs obligatoires manquants' });

  const accounts = (await readKey('p5_accounts')) || [];
  const pending  = (await readKey('p5_inscriptions_pending')) || [];

  if (accounts.find(a => a.username === username))
    return res.status(409).json({ ok: false, error: 'Identifiant deja utilise' });
  if (pending.find(p => p.username === username && p.status === 'pending'))
    return res.status(409).json({ ok: false, error: 'Demande deja en attente' });

  const newReq = {
    id: Date.now(), nom, prenom, service, poste, email,
    username, password, motif, role: 'demandeur',
    status: 'pending', createdAt: new Date().toISOString()
  };
  pending.push(newReq);
  await writeKey('p5_inscriptions_pending', pending);

  io.emit('data-update', { key: 'p5_inscriptions_pending', value: pending, changedBy: 'inscription' });
  io.emit('notification', { type: 'inscription', username, nom, service });

  log('INSCRIPTION', 'Nouvelle demande: @' + username + ' (' + nom + ')');
  res.json({ ok: true, message: 'Demande enregistree' });
});

// ══════════════════════════════════════════════════════════════════════
// API AUTH
// ══════════════════════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const accounts = (await readKey('p5_accounts')) || [];
  const acc = accounts.find(
    a => a.username === username && a.password === password && a.active !== false
  );
  if (acc) {
    log('AUTH', 'Connexion: @' + username + ' (' + acc.role + ')');
    res.json({ ok: true, user: acc });
  } else {
    res.status(401).json({ ok: false, error: 'Identifiants incorrects' });
  }
});

app.get('/api/auth/verify', (req, res) => res.json({ ok: true }));

// ══════════════════════════════════════════════════════════════════════
// STATUT & QR
// ══════════════════════════════════════════════════════════════════════
app.get('/status', async (req, res) => {
  const localIP = getLocalIP();
  const accounts = (await readKey('p5_accounts')) || [];
  const pending  = ((await readKey('p5_inscriptions_pending')) || []).filter(p => p.status === 'pending');
  const demandes = (await readKey('p5_demandes_course')) || [];
  res.json({
    status: 'ok', version: '27.0',
    mode: db ? 'MongoDB Atlas (cloud)' : 'JSON local',
    server: process.env.RAILWAY_PUBLIC_DOMAIN
      ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
      : `http://${localIP}:${PORT}`,
    clients_connectes: io.engine.clientsCount,
    stats: {
      comptes: accounts.length,
      inscriptions_en_attente: pending.length,
      demandes_de_course: demandes.length
    },
    uptime_minutes: Math.round(process.uptime() / 60)
  });
});

app.get('/qr', (req, res) => {
  const localIP = getLocalIP();
  const base    = process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : `http://${localIP}:${PORT}`;
  const inscUrl = base + '/inscription';

  res.send(`<!DOCTYPE html><html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlottePPL - Acces</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,sans-serif;background:#8B1A1A;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:28px;max-width:500px;width:100%;text-align:center}
h1{color:#8B1A1A;font-size:20px;margin:8px 0 4px}p.sub{color:#6B7280;font-size:12px;margin-bottom:20px}
.url{background:#F9F5EE;border:2px solid #C8A84B;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;font-weight:700;color:#8B1A1A;margin:10px 0;word-break:break-all}
.label{font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;margin:14px 0 4px}
img.qr{margin:10px auto;display:block;width:180px;height:180px}
.btn{display:inline-block;margin:6px;padding:10px 20px;background:linear-gradient(135deg,#8B1A1A,#C8A84B);color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;text-decoration:none}
.insc{background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:14px;margin-top:16px}
.info{background:#F0FDF4;border:1px solid #86EFAC;border-radius:8px;padding:8px 14px;font-size:12px;color:#059669;margin:10px 0;font-weight:700}
</style></head><body><div class="card">
<div style="font-size:36px">&#x1F697;</div>
<h1>Flotte PPL v27</h1>
<p class="sub">Prestige Poultry Limited &mdash; Yamoussoukro</p>
<div class="info" id="info">Chargement...</div>
<div class="label">Logiciel</div>
<div class="url">${base}</div>
<img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(base)}&color=8B1A1A" alt="QR Logiciel">
<a class="btn" href="${base}" target="_blank">Ouvrir le logiciel</a>
<div class="insc">
  <div class="label" style="color:#DC2626">Inscription nouveaux utilisateurs</div>
  <div class="url" style="border-color:#DC2626;color:#DC2626">${inscUrl}</div>
  <img class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(inscUrl)}&color=DC2626" alt="QR Inscription">
</div>
<script>
fetch('/status').then(r=>r.json()).then(d=>{
  document.getElementById('info').textContent =
    d.clients_connectes+' connecte(s) | '+
    d.stats.comptes+' comptes | '+
    d.stats.demandes_de_course+' demandes | Mode: '+d.mode;
});
</script>
</div></body></html>`);
});

// ══════════════════════════════════════════════════════════════════════
// SOCKET.IO — Synchronisation temps réel
// ══════════════════════════════════════════════════════════════════════
io.on('connection', async (socket) => {
  const clientIP = socket.handshake.address;
  log('SOCKET', 'Client connecte: ' + clientIP);

  // Envoyer toutes les données au nouveau client
  const data = await readData();
  socket.emit('initial-data', data);

  // Recevoir une mise à jour d'un client
  socket.on('set-key', async (payload) => {
    const { key, value } = payload;
    if (!key || key === '_ppl_jwt') return;
    await writeKey(key, value);
    socket.broadcast.emit('data-update', {
      key, value,
      changedBy: payload.user || 'utilisateur'
    });
  });

  // Mise à jour bulk
  socket.on('push-bulk', async (updates) => {
    const changed = await writeKeys(updates);
    const data = await readData();
    changed.forEach(k => socket.broadcast.emit('data-update', {
      key: k, value: data[k],
      changedBy: updates._user || 'utilisateur'
    }));
  });

  socket.on('disconnect', () => {
    log('SOCKET', 'Client deconnecte: ' + clientIP);
  });
});

// ══════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ══════════════════════════════════════════════════════════════════════
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    const isCloud = !!process.env.RAILWAY_PUBLIC_DOMAIN;
    const base    = isCloud
      ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
      : `http://${localIP}:${PORT}`;

    console.log('\n' + '='.repeat(60));
    console.log('  FLOTTE PPL v27 - Serveur ' + (isCloud ? 'CLOUD' : 'Local') + ' Demarre');
    console.log('='.repeat(60));
    console.log(`  Mode        : ${db ? 'MongoDB Atlas' : 'JSON local'}`);
    console.log(`  Logiciel    : ${base}`);
    console.log(`  Inscription : ${base}/inscription`);
    console.log(`  QR Codes    : ${base}/qr`);
    console.log(`  Statut      : ${base}/status`);
    console.log('  Sync temps reel : Socket.IO actif');
    console.log('='.repeat(60) + '\n');
    log('INFO', 'Serveur demarre - ' + (db ? 'MongoDB' : 'JSON local'));
  });
});
