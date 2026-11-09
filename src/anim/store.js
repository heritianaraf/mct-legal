// Stockage ANIM MCT : deux fichiers JSON (aucune dépendance native).
//   config.json : réglages (animations automatiques, bienvenue, XP) + messages d'animation + quiz
//   xp.json     : XP, niveaux et messages comptés, par serveur puis par membre
// Dossier : ANIM_DATA_DIR, sinon anim/data/.
//
// Sauvegarde Discord, dans le MÊME salon que les playlists, youtube.json et ADMIN MCT :
// chaque modification est envoyée en pièce jointe (anim-config.json, anim-xp.json), puis l'ancienne
// sauvegarde est supprimée. Au démarrage, un fichier absent est restauré depuis ce salon.
// Salon : ANIM_BACKUP_CHANNEL_ID, sinon BACKUP_CHANNEL_ID. Le bot ANIM MCT (token différent) doit
// pouvoir voir ce salon, y écrire, joindre des fichiers et lire l'historique.

const fs = require('node:fs');
const path = require('node:path');

const dir = () => process.env.ANIM_DATA_DIR || path.join(__dirname, 'data');

// delay : une sauvegarde au plus tous les N ms par fichier (l'XP change à chaque message, donc plus lent)
const FILES = {
  'config.json': { label: '💾 Sauvegarde ANIM MCT : messages et réglages', delay: 5000 },
  'xp.json': { label: '💾 Sauvegarde ANIM MCT : XP et niveaux', delay: 60000 }
};
const backupName = file => `anim-${file}`;
const backupChannelId = () => (process.env.ANIM_BACKUP_CHANNEL_ID || process.env.BACKUP_CHANNEL_ID || '').trim();

let discordClient = null;
const timers = new Map();
let configCache = null;
let xpCache = null;

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

// Messages du bot ANIM MCT dans le salon, du plus récent au plus ancien.
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
  if (!discordClient || !backupChannelId() || !FILES[file] || timers.has(file)) return;

  timers.set(file, setTimeout(async () => {
    timers.delete(file); // le fichier est lu au moment de l'envoi : c'est toujours la dernière version
    try {
      const channel = await backupChannel();
      const source = path.join(dir(), file);
      if (!channel || !fs.existsSync(source)) return;

      const name = backupName(file);
      const sent = await channel.send({
        content: `${FILES[file].label} (${new Date().toISOString()})`,
        files: [{ attachment: Buffer.from(fs.readFileSync(source)), name }],
        allowedMentions: { parse: [] }
      });

      for (const message of await botMessages(channel, 10)) {
        if (message.id !== sent.id && message.attachments.some(a => a.name === name)) {
          message.delete().catch(() => {});
        }
      }
    } catch (error) {
      console.error(`ANIM MCT : sauvegarde de ${file} impossible :`, error.message);
    }
  }, FILES[file].delay));
}

// Au démarrage : un fichier absent est récupéré dans le salon ; un fichier présent mais jamais
// sauvegardé (par exemple l'xp.json de l'ancien bot) est envoyé une première fois.
async function restore() {
  try {
    if (!backupChannelId()) return;

    const channel = await backupChannel();
    if (!channel) return console.warn('ANIM MCT : salon de sauvegarde introuvable ou inaccessible.');

    const messages = (await botMessages(channel, 30)).sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    for (const file of Object.keys(FILES)) {
      const name = backupName(file);
      const local = path.join(dir(), file);
      const message = messages.find(m => m.attachments.some(a => a.name === name));

      if (fs.existsSync(local)) {
        if (!message) scheduleBackup(file);
        continue;
      }
      if (!message) continue;

      try {
        const attachment = message.attachments.find(a => a.name === name);
        const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`téléchargement ${response.status}`);

        const text = await response.text();
        JSON.parse(text); // vérifie que le fichier est valide
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(local, text);
        console.log(`✅ ANIM MCT : ${file} restauré depuis le salon de sauvegarde.`);
      } catch (error) {
        console.error(`ANIM MCT : restauration de ${file} impossible :`, error.message);
      }
    }
  } catch (error) {
    console.error('ANIM MCT : restauration impossible :', error.message);
  }
}

// À appeler une fois le bot connecté (ClientReady), avant de lire les données.
async function attachBackup(client) {
  discordClient = client;
  await restore();
  configCache = null;
  xpCache = null;
}

// ---------- réglages, messages d'animation et quiz ----------

const DEFAULTS = {
  auto: { enabled: false, channelId: '', intervalMinutes: 180, lastPostAt: 0, lastMessageId: '' },
  welcome: {
    enabled: false, // ADMIN MCT a déjà un message de bienvenue : à activer ici seulement si tu le souhaites
    channelId: '',
    message: '👋 Bienvenue {mention} sur **{server}** ! Présente-toi et participe aux animations.'
  },
  xp: { enabled: true, perMessage: 10, cooldownSeconds: 60 }
};

// Messages de départ (repris de l'ancien bot). kind : question | defi | custom
const SEED_MESSAGES = [
  ['question', 'Quel jeu pourrais-tu rejouer pendant des années ?'],
  ['question', 'PC, PlayStation ou Xbox ? Pourquoi ?'],
  ['question', 'Quel est ton jeu préféré avec tes amis ?'],
  ['question', 'Quel événement aimerais-tu voir sur ce serveur ?'],
  ['defi', 'Partage ton jeu préféré et explique pourquoi !'],
  ['defi', 'Poste une capture de ton meilleur moment gaming.'],
  ['defi', 'Accueille un nouveau membre.'],
  ['defi', 'Partage un morceau qui met l’ambiance.'],
  ['defi', 'Pose une devinette aux autres membres.']
].map(([kind, text], i) => ({ id: `s${i + 1}`, kind, title: '', text, enabled: true }));

const SEED_QUIZ = [
  { q: 'Quel jeu est connu pour son mode Battle Royale ?', choices: ['Minecraft', 'Fortnite', 'ETS2'], answer: 1 },
  { q: 'Que signifie MP sur Discord ?', choices: ['Message privé', 'Mode public', 'Mise à jour'], answer: 0 },
  { q: 'Quel raccourci copie du texte sur Windows ?', choices: ['Ctrl + V', 'Ctrl + C', 'Ctrl + X'], answer: 1 },
  { q: 'Combien font 7 × 8 ?', choices: ['54', '56', '64'], answer: 1 }
].map((item, i) => ({ id: `z${i + 1}`, ...item }));

function getConfig() {
  if (!configCache) {
    const raw = readJson('config.json', {});
    configCache = {
      auto: { ...DEFAULTS.auto, ...raw.auto },
      welcome: { ...DEFAULTS.welcome, ...raw.welcome },
      xp: { ...DEFAULTS.xp, ...raw.xp },
      messages: Array.isArray(raw.messages) ? raw.messages : SEED_MESSAGES,
      quiz: Array.isArray(raw.quiz) ? raw.quiz : SEED_QUIZ
    };
  }
  return structuredClone(configCache);
}

// mutator(config) modifie la copie ; le résultat est enregistré puis sauvegardé sur Discord.
function updateConfig(mutator) {
  const config = getConfig();
  mutator(config);
  writeJson('config.json', config);
  configCache = config;
  return structuredClone(config);
}

const newId = () => Math.random().toString(36).slice(2, 10);

// ---------- XP ----------

const need = level => 100 + level * 50;
const loadXp = () => (xpCache ??= readJson('xp.json', {}));

// count : compte le message (XP de discussion) ; sinon simple bonus (quiz)
function addXp(guildId, userId, amount, count = true) {
  const data = loadXp();
  const user = ((data[guildId] ??= {})[userId] ??= { xp: 0, level: 0, messages: 0 });
  user.xp += amount;
  if (count) user.messages++;

  let levelled = false;
  while (user.xp >= need(user.level)) {
    user.xp -= need(user.level);
    user.level++;
    levelled = true;
  }

  writeJson('xp.json', data);
  return { user: { ...user }, levelled };
}

const getUser = (guildId, userId) => ({ xp: 0, level: 0, messages: 0, ...loadXp()[guildId]?.[userId] });

const topUsers = (guildId, limit = 10) => Object.entries(loadXp()[guildId] || {})
  .sort((a, b) => (b[1].level * 1000 + b[1].xp) - (a[1].level * 1000 + a[1].xp))
  .slice(0, limit);

module.exports = { attachBackup, getConfig, updateConfig, newId, need, addXp, getUser, topUsers };
