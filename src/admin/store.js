// Stockage ADMIN MCT : deux petits fichiers JSON (aucune dépendance native).
//   welcome.json : message de bienvenue configuré depuis le dashboard
//   warns.json   : avertissements de modération
// Dossier : ADMIN_DATA_DIR, sinon admin/data/.
//
// Sauvegarde Discord (comme stations.json et youtube.json de MCT MUSIC) :
// chaque modification est envoyée, après 5 s, dans un salon privé ; au démarrage, un fichier
// absent est restauré depuis ce salon. Salon : ADMIN_BACKUP_CHANNEL_ID, sinon BACKUP_CHANNEL_ID
// (le bot ADMIN MCT doit pouvoir voir ce salon et y écrire, envoyer des fichiers et lire l'historique).

const fs = require('node:fs');
const path = require('node:path');

const dir = () => process.env.ADMIN_DATA_DIR || path.join(__dirname, 'data');

const FILES = {
  'welcome.json': '💾 Sauvegarde ADMIN MCT : message de bienvenue',
  'warns.json': '💾 Sauvegarde ADMIN MCT : avertissements'
};
const BACKUP_PREFIX = 'admin-'; // admin-welcome.json, admin-warns.json : ne se mélange pas avec stations.json / youtube.json
const backupName = file => `${BACKUP_PREFIX}${file}`;
const backupChannelId = () => (process.env.ADMIN_BACKUP_CHANNEL_ID || process.env.BACKUP_CHANNEL_ID || '').trim();

let discordClient = null;
const timers = new Map();

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
  scheduleBackup(file);
}

// ---------- sauvegarde dans un salon Discord ----------

async function backupChannel() {
  const id = backupChannelId();
  if (!discordClient || !id) return null;
  const channel = await discordClient.channels.fetch(id).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

// Messages du bot ADMIN MCT dans le salon, du plus récent au plus ancien.
async function botMessages(channel, maxPages = 30) {
  const found = [];
  let before;

  for (let i = 0; i < maxPages; i++) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;

    for (const message of page.values()) {
      if (message.author.id === discordClient.user.id) found.push(message);
    }

    before = page.last().id;
    if (page.size < 100) break;
  }

  return found;
}

function scheduleBackup(file) {
  if (!discordClient || !backupChannelId() || !FILES[file]) return;
  clearTimeout(timers.get(file));

  timers.set(file, setTimeout(async () => {
    try {
      const channel = await backupChannel();
      const source = path.join(dir(), file);
      if (!channel || !fs.existsSync(source)) return;

      const name = backupName(file);
      const sent = await channel.send({
        content: `${FILES[file]} (${new Date().toISOString()})`,
        files: [{ attachment: Buffer.from(fs.readFileSync(source)), name }],
        allowedMentions: { parse: [] }
      });

      for (const message of await botMessages(channel, 10)) {
        if (message.id !== sent.id && message.attachments.some(a => a.name === name)) {
          message.delete().catch(() => {});
        }
      }
    } catch (error) {
      console.error(`ADMIN MCT : sauvegarde de ${file} impossible :`, error.message);
    }
  }, 5000));
}

// Au démarrage : chaque fichier absent est récupéré dans le salon de sauvegarde.
async function restore() {
  try {
    const missing = Object.keys(FILES).filter(file => !fs.existsSync(path.join(dir(), file)));
    if (!missing.length || !backupChannelId()) return;

    const channel = await backupChannel();
    if (!channel) return console.warn('ADMIN MCT : salon de sauvegarde introuvable ou inaccessible.');

    const messages = (await botMessages(channel, 30)).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    for (const file of missing) {
      const name = backupName(file);
      const message = messages.find(m => m.attachments.some(a => a.name === name));
      if (!message) continue;

      try {
        const attachment = message.attachments.find(a => a.name === name);
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`téléchargement ${response.status}`);

        const text = await response.text();
        JSON.parse(text); // vérifie que le fichier est valide
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(path.join(dir(), file), text);
        console.log(`✅ ADMIN MCT : ${file} restauré depuis le salon de sauvegarde.`);
      } catch (error) {
        console.error(`ADMIN MCT : restauration de ${file} impossible :`, error.message);
      }
    }
  } catch (error) {
    console.error('ADMIN MCT : restauration impossible :', error.message);
  }
}

// À appeler une fois le bot connecté (ClientReady), avant de lire les données.
async function attachBackup(client) {
  discordClient = client;
  await restore();
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

module.exports = { attachBackup, getWelcome, setWelcome, addWarn, removeWarn, listWarns };
