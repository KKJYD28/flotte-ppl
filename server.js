/**
 * ══════════════════════════════════════════════════════════
 *  FLOTTE PPL — SERVEUR RÉSEAU LOCAL
 *  Synchronisation temps réel · WebSockets · Node.js
 * ══════════════════════════════════════════════════════════
 *
 *  INSTALLATION (1 seule fois sur le PC serveur) :
 *  ------------------------------------------------
 *  1. Installer Node.js depuis : https://nodejs.org
 *  2. Ouvrir un terminal dans ce dossier et taper :
 *       npm install
 *  3. Lancer le serveur :
 *       node server.js
 *
 *  ACCÈS DEPUIS LES AUTRES PC :
 *  ------------------------------------------------
 *  Ouvrir le navigateur et aller sur :
 *       http://[IP-DE-CE-PC]:3000
 *  (trouver l'IP avec la commande : ipconfig sur Windows)
 * ══════════════════════════════════════════════════════════
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');

// ─── CONFIGURATION ───────────────────────────────────────
const PORT    = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'flotte_data.json');
const HTML_FILE = path.join(__dirname, 'flotte-ppl-v6.html');

// ─── SETUP ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 100 * 1024 * 1024   // 100 MB (pour les photos/PDFs)
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ─── BASE DE DONNÉES JSON ────────────────────────────────
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erreur lecture DB:', e.message);
  }
  return {};
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Erreur écriture DB:', e.message);
    return false;
  }
}

// ─── ROUTES HTTP ─────────────────────────────────────────

// Servir le fichier HTML principal
app.get('/', (req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.sendFile(HTML_FILE);
  } else {
    res.status(404).send(`
      <h2>Fichier flotte-ppl-v6.html introuvable</h2>
      <p>Placez le fichier <strong>flotte-ppl-v6.html</strong> dans le même dossier que server.js</p>
    `);
  }
});

// Lire toutes les données
app.get('/api/data', (req, res) => {
  res.json(loadDB());
});

// Sauvegarder une clé
app.post('/api/save', (req, res) => {
  const { key, value, user } = req.body;
  if (!key) return res.status(400).json({ error: 'Clé manquante' });

  const db = loadDB();
  db[key] = value;
  const ok = saveDB(db);

  if (ok) {
    // Notifie TOUS les clients connectés en temps réel
    io.emit('data-changed', {
      key,
      value,
      changedBy: user || 'Inconnu',
      timestamp: new Date().toISOString()
    });
    res.json({ ok: true, savedBy: user, key });
  } else {
    res.status(500).json({ error: 'Erreur de sauvegarde' });
  }
});

// Sauvegarde complète (import/export)
app.post('/api/save-all', (req, res) => {
  const { data, user } = req.body;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Données invalides' });

  const ok = saveDB(data);
  if (ok) {
    io.emit('full-sync', { data, syncedBy: user || 'Inconnu' });
    res.json({ ok: true });
  } else {
    res.status(500).json({ error: 'Erreur de sauvegarde' });
  }
});

// Santé du serveur
app.get('/api/health', (req, res) => {
  const db = loadDB();
  res.json({
    status: 'OK',
    uptime: Math.floor(process.uptime()) + 's',
    connectedUsers: io.sockets.sockets.size,
    dataKeys: Object.keys(db).length,
    dbSize: (JSON.stringify(db).length / 1024).toFixed(1) + ' KB',
    timestamp: new Date().toLocaleString('fr-FR')
  });
});

// ─── WEBSOCKETS ───────────────────────────────────────────
const connectedUsers = new Map();

io.on('connection', (socket) => {
  const clientIP = socket.handshake.address;
  console.log(`[+] Client connecté : ${socket.id} (${clientIP})`);

  // Enregistrement de l'utilisateur
  socket.on('identify', (userData) => {
    connectedUsers.set(socket.id, {
      id: socket.id,
      name: userData.name || 'Anonyme',
      role: userData.role || 'reader',
      ip: clientIP,
      connectedAt: new Date().toISOString()
    });

    const userList = [...connectedUsers.values()];
    io.emit('users-online', userList);

    // Notifie les autres qu'un utilisateur a rejoint
    socket.broadcast.emit('user-joined', {
      name: userData.name,
      role: userData.role
    });

    console.log(`  → Identifié : ${userData.name} (${userData.role})`);
  });

  // Déconnexion
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    connectedUsers.delete(socket.id);

    const userList = [...connectedUsers.values()];
    io.emit('users-online', userList);

    if (user) {
      socket.broadcast.emit('user-left', { name: user.name });
      console.log(`[-] Déconnecté : ${user.name} (${socket.id})`);
    } else {
      console.log(`[-] Déconnecté : ${socket.id}`);
    }
  });

  // Ping / heartbeat
  socket.on('ping', () => socket.emit('pong'));
});

// ─── DÉMARRAGE ────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const os   = require('os');
  const nets = os.networkInterfaces();
  const ips  = [];

  Object.values(nets).forEach(addrs => {
    addrs.forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    });
  });

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║       FLOTTE PPL — SERVEUR RÉSEAU LOCAL          ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Port         : ${PORT}                               ║`);
  console.log('║                                                  ║');
  console.log('║  Accès local  : http://localhost:' + PORT + '            ║');
  ips.forEach(ip => {
    const pad = ' '.repeat(Math.max(0, 18 - ip.length));
    console.log(`║  Réseau       : http://${ip}:${PORT}${pad}║`);
  });
  console.log('║                                                  ║');
  console.log('║  → Partagez l\'adresse réseau avec vos collègues ║');
  console.log('║  → Ctrl+C pour arrêter le serveur               ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});

// Sauvegarde de sécurité toutes les 5 minutes (backup automatique)
setInterval(() => {
  const db = loadDB();
  const backup = path.join(__dirname, `backup_${new Date().toISOString().slice(0,10)}.json`);
  try {
    fs.writeFileSync(backup, JSON.stringify(db, null, 2), 'utf8');
  } catch(e) { /* ignore */ }
}, 5 * 60 * 1000);

// Gestion des erreurs non capturées
process.on('uncaughtException', err => {
  console.error('Erreur non gérée:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Promesse rejetée:', reason);
});
