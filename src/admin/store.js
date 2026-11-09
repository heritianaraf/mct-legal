// Stockage ADMIN MCT : deux petits fichiers JSON (aucune dépendance native).
//   welcome.json : message de bienvenue configuré depuis le dashboard
//   warns.json   : avertissements de modération
// Dossier : ADMIN_DATA_DIR, sinon admin/data/ (à placer sur un disque persistant chez l'hébergeur).

const fs = require('node:fs');
const path = require('node:path');

const dir = () => process.env.ADMIN_DATA_DIR || path.join(__dirname, 'data');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(dir(), { recursive: true });
  const target = path.join(dir(), file);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, target);
}

const DEFAULT_WELCOME = {
  enabled: false,
  channelId: '',
  message: '👋 Bienvenue {mention} sur le serveur **MCT — Madagascar Community Team** ! 🚛🎮'
};

const getWelcome = () => ({ ...DEFAULT_WELCOME, ...readJson('welcome.json', {}) });
const setWelcome = config => writeJson('welcome.json', config);

// --- Avertissements (numérotés par membre et par serveur, comme avant) ---

const allWarns = () => readJson('warns.json', []);

function addWarn(guildId, userId, moderatorId, reason) {
  const warns = allWarns();
  const mine = warns.filter(w => w.guildId === guildId && w.userId === userId);
  const id = mine.reduce((max, w) => Math.max(max, w.id), 0) + 1;
  warns.push({ id, guildId, userId, moderatorId, reason, createdAt: Math.floor(Date.now() / 1000) });
  writeJson('warns.json', warns);
  return { id, total: mine.length + 1 };
}

function removeWarn(guildId, userId, id) {
  const warns = allWarns();
  const kept = warns.filter(w => !(w.guildId === guildId && w.userId === userId && w.id === id));
  const removed = kept.length !== warns.length;
  if (removed) writeJson('warns.json', kept);
  return { removed, total: kept.filter(w => w.guildId === guildId && w.userId === userId).length };
}

const listWarns = (guildId, userId) => allWarns().filter(w => w.guildId === guildId && w.userId === userId);

module.exports = { getWelcome, setWelcome, addWarn, removeWarn, listWarns };
