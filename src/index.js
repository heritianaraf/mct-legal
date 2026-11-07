require('dotenv').config();

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dns = require('node:dns/promises');
const net = require('node:net');

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');

const { startWeb } = require('./web');
const { resolveSpotify } = require('./spotify');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType
} = require('@discordjs/voice');

// ======================================
// CONFIGURATION
// ======================================

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN manquant dans .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const MUSIC_DIR = path.join(__dirname, '..', 'music');
const UPLOAD_DIR = path.join(MUSIC_DIR, 'uploads');

const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_DRIVE_FOLDER_TRACKS = 100;

const queues = new Map();

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ======================================
// FICHIERS MP3
// ======================================

function getMusicFiles() {
  return fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter(file => file.isFile() && /\.mp3$/i.test(file.name))
    .map(file => file.name)
    .sort((a, b) => a.localeCompare(b));
}

function findMusic(name) {
  const requested = name.toLowerCase().trim();

  return getMusicFiles().find(file =>
    path.parse(file).name.toLowerCase() === requested ||
    file.toLowerCase() === requested
  );
}

// ======================================
// TÉLÉCHARGEMENT DES MP3 DISCORD
// ======================================

async function downloadDiscordMp3(attachment) {
  if (!attachment || !/\.mp3$/i.test(attachment.name)) {
    throw new Error('Le fichier doit être au format MP3.');
  }

  if (attachment.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Le fichier dépasse la limite interne du bot (${MAX_UPLOAD_MB} Mo). La limite d’envoi Discord peut être plus basse selon ton compte.`);
  }

  let url;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new Error('Lien de fichier Discord invalide.');
  }

  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
  ) {
    throw new Error('Lien de fichier Discord invalide.');
  }

  const response = await fetch(attachment.url);

  if (!response.ok || !response.body) {
    throw new Error('Impossible de télécharger le MP3.');
  }

  const safeName = path.parse(attachment.name).name
    .replace(/[^a-zA-Z0-9 _-]/g, '_')
    .slice(0, 70) || 'musique';

  const filePath = path.join(
    UPLOAD_DIR,
    `${Date.now()}-${randomUUID()}-${safeName}.mp3`
  );

  let received = 0;

  const source = Readable.fromWeb(response.body);

  source.on('data', chunk => {
    received += chunk.length;

    if (received > MAX_UPLOAD_BYTES) {
      source.destroy(new Error('Fichier trop volumineux.'));
    }
  });

  try {
    await pipeline(
      source,
      fs.createWriteStream(filePath, { flags: 'wx' })
    );
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    throw error;
  }

  if (received === 0) {
    await fsp.unlink(filePath).catch(() => {});
    throw new Error('Le fichier MP3 est vide.');
  }

  return filePath;
}


// ======================================
// LIENS GOOGLE DRIVE (MP3 PUBLIC)
// ======================================

function extractGoogleDriveFileId(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Lien invalide. Colle un lien Google Drive valide.');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') {
    throw new Error('Seuls les liens HTTPS de drive.google.com sont acceptés.');
  }

  let fileId = null;
  const fileMatch = url.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) fileId = fileMatch[1];

  if (!fileId) {
    fileId = url.searchParams.get('id');
  }

  if (!fileId || !/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) {
    throw new Error('Impossible de reconnaître l’identifiant du fichier Google Drive.');
  }

  return fileId;
}

function extractGoogleDriveFolderId(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com') return null;

  const match = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  return match ? match[1] : null;
}

function decodeHtml(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Lit la liste des fichiers d'un dossier public via sa page « embed » (sans clé API).
async function listDriveFolderMp3(folderId) {
  const response = await fetch(
    `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`,
    {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MCTMusic/1.0)', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(20000)
    }
  );

  if (!response.ok) {
    throw new Error(
      'Impossible de lire ce dossier Google Drive. Vérifie qu’il est partagé en « Toute personne disposant du lien ».'
    );
  }

  const html = await response.text();
  const files = [];
  const seen = new Set();

  for (const match of html.matchAll(/id="entry-([A-Za-z0-9_-]+)"[\s\S]*?class="flip-entry-title">([^<]*)</g)) {
    const id = match[1];
    const name = decodeHtml(match[2]).trim();

    if (seen.has(id) || !/\.mp3$/i.test(name)) continue;
    seen.add(id);
    files.push({ id, name });
  }

  if (!files.length) {
    throw new Error(
      'Aucun MP3 trouvé dans ce dossier. Vérifie qu’il est partagé en « Toute personne disposant du lien » et qu’il contient des .mp3 (sous-dossiers ignorés).'
    );
  }

  return files
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, MAX_DRIVE_FOLDER_TRACKS);
}

// Un lien de dossier ajoute tous les MP3 (téléchargés un par un, au moment de les lire).
// Un lien de fichier garde le comportement habituel.
async function enqueueDrive(state, rawUrl) {
  const folderId = extractGoogleDriveFolderId(rawUrl);

  if (folderId) {
    const files = await listDriveFolderMp3(folderId);
    if (!files.length) throw new Error('Aucun MP3 trouvé dans ce dossier Google Drive.');

    for (const file of files) {
      state.items.push({
        name: path.parse(file.name).name,
        driveId: file.id,
        file: null,
        ffmpeg: null,
        deleteOnFinish: true,
        deleteScheduled: false
      });
    }

    return `📁 ${files.length} MP3 du dossier Google Drive ajoutés à la file.`;
  }

  const filePath = await downloadGoogleDriveMp3(rawUrl);

  state.items.push({
    name: 'Musique Google Drive',
    file: filePath,
    ffmpeg: null,
    deleteOnFinish: true,
    deleteScheduled: false
  });

  return '🎶 Musique Google Drive ajoutée à la file.';
}

async function downloadGoogleDriveMp3(rawUrl) {
  return downloadDriveFileById(extractGoogleDriveFileId(rawUrl));
}

async function downloadDriveFileById(fileId) {
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

  const response = await fetch(downloadUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok || !response.body) {
    throw new Error('Google Drive n’a pas permis de télécharger ce fichier.');
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    await response.body.cancel().catch(() => {});
    throw new Error(
      'Google Drive renvoie une page de confirmation au lieu du MP3. Vérifie que le fichier est partagé en « Toute personne disposant du lien » et utilise un fichier de taille raisonnable.'
    );
  }

  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_UPLOAD_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error(`Le MP3 dépasse la limite interne du bot (${MAX_UPLOAD_MB} Mo).`);
  }

  const filePath = path.join(
    UPLOAD_DIR,
    `${Date.now()}-${randomUUID()}-google-drive.mp3`
  );

  let received = 0;
  const source = Readable.fromWeb(response.body);

  source.on('data', chunk => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      source.destroy(new Error(`Le MP3 dépasse la limite interne du bot (${MAX_UPLOAD_MB} Mo).`));
    }
  });

  try {
    await pipeline(source, fs.createWriteStream(filePath, { flags: 'wx' }));
  } catch (error) {
    await fsp.unlink(filePath).catch(() => {});
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new Error('Le téléchargement Google Drive a expiré. Réessaie avec un fichier plus petit.');
    }
    throw error;
  }

  if (received < 128) {
    await fsp.unlink(filePath).catch(() => {});
    throw new Error('Le fichier téléchargé est vide ou ne semble pas être un MP3.');
  }

  // Vérification simple de la signature MP3/ID3 pour éviter de lire une page HTML renommée.
  const handle = await fsp.open(filePath, 'r');
  const header = Buffer.alloc(3);
  await handle.read(header, 0, 3, 0);
  await handle.close();

  const hasId3 = header.toString('ascii') === 'ID3';
  const hasMpegFrame = header[0] === 0xFF && (header[1] & 0xE0) === 0xE0;
  if (!hasId3 && !hasMpegFrame) {
    await fsp.unlink(filePath).catch(() => {});
    throw new Error('Le lien ne semble pas pointer vers un véritable fichier MP3.');
  }

  return filePath;
}


// ======================================
// NETTOYAGE DES FICHIERS
// ======================================

async function deleteUploadedFile(filePath) {
  if (!filePath || !filePath.startsWith(UPLOAD_DIR + path.sep)) {
    return;
  }

  await fsp.unlink(filePath).catch(error => {
    if (error.code !== 'ENOENT') {
      console.error('Suppression impossible :', error.message);
    }
  });
}

function cleanupTrack(track) {
  if (!track) return;

  const ffmpeg = track.ffmpeg;

  if (ffmpeg && !ffmpeg.killed && ffmpeg.exitCode === null) {
    if (track.deleteOnFinish && !track.deleteScheduled) {
      track.deleteScheduled = true;
      ffmpeg.once('close', () => {
        deleteUploadedFile(track.file);
      });
    }

    ffmpeg.kill();
  } else if (track.deleteOnFinish) {
    deleteUploadedFile(track.file);
  }

  track.ffmpeg = null;
}

// ======================================
// CRÉATION DU LECTEUR
// ======================================

function createMusicState(guildId, textChannel) {
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  const state = {
    player,
    connection: null,
    items: [],
    current: null,
    textChannel,
    station: null,
    loop: false,
    lastRefill: 0,
    looping: false
  };

  player.on(AudioPlayerStatus.Idle, () => {
    if (state.current) {
      cleanupTrack(state.current);
      state.current = null;
    }

    if (queues.get(guildId) === state) {
      startTrack(guildId);
    }
  });

  player.on('error', error => {
    console.error('Erreur audio :', error);

    if (state.current) {
      cleanupTrack(state.current);
      state.current = null;
    }

    if (queues.get(guildId) === state) {
      startTrack(guildId);
    }
  });

  return state;
}

// ======================================
// LECTURE AVEC FFMPEG
// ======================================

function startTrack(guildId) {
  const state = queues.get(guildId);

  if (!state || state.current) return;

  if (state.items.length === 0) {
    if (state.loop && state.station && !state.looping) refillLoop(guildId, state);
    return;
  }

  const track = state.items.shift();

  state.current = track;

  console.log('🎵 Lecture :', track.name);

  if (track.driveId && !track.file) {
    downloadDriveFileById(track.driveId)
      .then(filePath => {
        track.file = filePath;

        if (state.current !== track) {
          deleteUploadedFile(filePath);
          return;
        }

        playTrack(guildId, state, track);
      })
      .catch(error => {
        console.error('Erreur Google Drive :', error.message);

        if (state.current === track) {
          state.current = null;
          state.textChannel?.send(`❌ ${track.name} : ${error.message}`).catch(() => {});
          startTrack(guildId);
        }
      });
    return;
  }

  playTrack(guildId, state, track);
}

// Boucle : quand tout est lu, la playlist est relue depuis sa version enregistrée.
async function refillLoop(guildId, state) {
  const stop = text => {
    state.loop = false;
    state.textChannel?.send(text).catch(() => {});
  };

  // Garde-fou : si un tour dure moins de 10 s (éléments illisibles), on arrête.
  if (Date.now() - state.lastRefill < 10000) {
    return stop('🔁 Boucle arrêtée : la playlist se termine trop vite (éléments illisibles ?).');
  }

  state.looping = true;

  try {
    const station = findStation(guildId, state.station);
    if (!station || !station.items.length) {
      return stop('🔁 Boucle arrêtée : la playlist est introuvable ou vide.');
    }

    state.lastRefill = Date.now();
    await enqueueStation(state, station);
  } catch (error) {
    return stop(`🔁 Boucle arrêtée : ${error.message}`);
  } finally {
    state.looping = false;
  }

  if (queues.get(guildId) !== state || !state.loop) return;

  if (state.items.length === 0) {
    return stop('🔁 Boucle arrêtée : aucun morceau lisible dans la playlist.');
  }

  state.textChannel?.send(`🔁 Playlist **${state.station}** : on recommence.`).catch(() => {});
  startTrack(guildId);
}

function playTrack(guildId, state, track) {
  const input = track.stream
    ? [
        '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', '15000000',
        '-i', track.stream
      ]
    : ['-i', track.file];

  const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    ...input,
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  track.ffmpeg = ffmpeg;

  ffmpeg.stderr.on('data', data => {
    console.error('FFmpeg :', data.toString());
  });

  ffmpeg.on('error', error => {
    console.error('Erreur FFmpeg :', error);

    if (state.current === track) {
      cleanupTrack(track);
      state.current = null;

      state.textChannel?.send(
        '❌ Impossible de lire ce MP3. Vérifie FFmpeg.'
      ).catch(() => {});

      startTrack(guildId);
    }
  });

  ffmpeg.on('close', code => {
    if (track.deleteOnFinish) {
      deleteUploadedFile(track.file);
    }

    if (code !== 0 && state.current === track) {
      console.error('FFmpeg terminé avec le code :', code);
      state.player.stop(true);
    }
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw
  });

  state.player.play(resource);

  state.textChannel?.send(
    `🎵 Lecture en cours : **${track.name}**`
  ).catch(() => {});
}

// ======================================
// CONNEXION AU SALON VOCAL
// ======================================

async function ensureVoice(guild, voiceChannel, state) {
  if (!voiceChannel) {
    throw new Error('Rejoins un salon vocal avant de lancer la musique.');
  }

  if (
    !state.connection ||
    state.connection.state.status === VoiceConnectionStatus.Destroyed
  ) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });

    state.connection.subscribe(state.player);

    await entersState(state.connection, VoiceConnectionStatus.Ready, 20000);
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    throw new Error('MCT MUSIC est déjà connecté à un autre salon vocal.');
  }
}

function connectVoice(interaction, state) {
  return ensureVoice(interaction.guild, interaction.member.voice?.channel, state);
}

// ======================================
// RADIO / FLUX AUDIO EN DIRECT
// ======================================

const RADIO_UA = 'Mozilla/5.0 (compatible; MCTMusic/1.0)';
const BLOCKED_STREAM_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }

  const value = ip.toLowerCase();
  if (value.startsWith('::ffff:')) return isPrivateIp(value.slice(7));
  return value === '::' || value === '::1' ||
    value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80');
}

// Empêche d'utiliser le bot pour atteindre le réseau interne du serveur.
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new Error('Adresse de la radio introuvable.');
      });

  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
    throw new Error('Cette adresse n’est pas autorisée.');
  }
}

async function probeRadio(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Lien de radio invalide.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Le lien doit commencer par http:// ou https://.');
  }

  if (BLOCKED_STREAM_HOSTS.test(url.hostname)) {
    throw new Error(
      'YouTube et Spotify ne sont pas pris en charge. Colle l’adresse directe d’un flux radio (Icecast, Shoutcast, HLS).'
    );
  }

  await assertPublicHost(url.hostname);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': RADIO_UA, 'Icy-MetaData': '0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error('Impossible de joindre cette radio (adresse incorrecte ou hors ligne ?).');
  }

  // On ne lit que les en-têtes : le flux ne doit jamais être téléchargé ici.
  await response.body?.cancel().catch(() => {});

  const finalUrl = new URL(response.url);
  if (finalUrl.hostname !== url.hostname) await assertPublicHost(finalUrl.hostname);

  if (!response.ok) {
    throw new Error(`La radio a répondu avec une erreur (${response.status}).`);
  }

  const type = (response.headers.get('content-type') || '').toLowerCase();
  const isAudio = /^audio\//.test(type) ||
    /^application\/(ogg|octet-stream|vnd\.apple\.mpegurl|x-mpegurl)/.test(type);

  if (!isAudio) {
    throw new Error('Ce lien n’est pas un flux audio direct (c’est probablement une page web).');
  }

  const title = (response.headers.get('icy-name') || '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 80) || finalUrl.hostname;

  return { title, stream: finalUrl.href };
}

async function enqueueRadio(state, rawUrl) {
  const { title, stream } = await probeRadio(rawUrl);

  state.items.push({
    name: `📻 ${title}`,
    stream,
    ffmpeg: null,
    deleteOnFinish: false
  });

  return `📻 ${title} ajoutée à la file. Une radio ne se termine pas : utilise Suivant pour passer à la suite.`;
}

// ======================================
// SPOTIFY : retrouve le titre dans les MP3 locaux
// ======================================

const norm = value => String(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function findMusicBySpotify({ title, artist }) {
  const wanted = norm(title.replace(/\(.*?\)/g, '').replace(/\s[-–].*$/, ''));
  if (!wanted) return null;

  const files = getMusicFiles().map(file => ({ file, name: norm(path.parse(file).name) }));
  const by = artist ? norm(artist) : '';

  const match =
    files.find(f => f.name === wanted) ||
    files.find(f => f.name.includes(wanted) && (!by || f.name.includes(by))) ||
    files.find(f => f.name.includes(wanted));

  return match ? match.file : null;
}

async function enqueueSpotify(state, rawUrl) {
  const { label, tracks } = await resolveSpotify(rawUrl);
  const added = [];
  const missing = [];

  for (const track of tracks) {
    const display = track.artist ? `${track.artist} - ${track.title}` : track.title;
    const file = findMusicBySpotify(track);

    if (!file) {
      missing.push(display);
      continue;
    }

    state.items.push({
      name: path.parse(file).name,
      file: path.join(MUSIC_DIR, file),
      ffmpeg: null,
      deleteOnFinish: false
    });
    added.push(display);
  }

  return { label, added, missing };
}

function spotifyReport({ label, added, missing }) {
  const total = added.length + missing.length;

  if (total === 1) {
    if (added.length) {
      return `🎧 **${label}** trouvé dans ta bibliothèque MP3 et ajouté à la file.`;
    }

    return `🎧 **${missing[0] || label}** : aucun MP3 correspondant dans le dossier music.\n` +
      'Spotify ne fournit pas l’audio : ajoute le MP3 (nommé avec le titre du morceau) puis relance la commande.';
  }

  let text = `🎧 **${label}** : ${added.length}/${total} morceaux trouvés dans ta bibliothèque MP3 et ajoutés à la file.`;

  if (missing.length) {
    text += '\n⚠️ Sans MP3 correspondant :\n' +
      missing.slice(0, 10).map(name => `• ${name}`).join('\n') +
      (missing.length > 10 ? `\n… et ${missing.length - 10} autre(s)` : '');
  }

  return text.slice(0, 1900);
}

// ======================================
// ARRÊT / API POUR L'INTERFACE WEB
// ======================================

function stopGuild(guildId) {
  const state = queues.get(guildId);
  if (!state) return;

  queues.delete(guildId);

  for (const track of state.items) {
    cleanupTrack(track);
  }

  state.items = [];
  cleanupTrack(state.current);
  state.current = null;
  state.player.stop(true);
  state.connection?.destroy();
}

async function webEnqueue(guildId, channelId, add) {
  const guild = client.guilds.cache.get(String(guildId));
  const channel = guild?.channels.cache.get(String(channelId));

  if (!guild || !channel?.isVoiceBased()) {
    throw new Error('Serveur ou salon vocal introuvable.');
  }

  let state = queues.get(guild.id);
  if (!state) {
    state = createMusicState(guild.id, null);
    queues.set(guild.id, state);
  }

  try {
    await ensureVoice(guild, channel, state);
    const message = await add(state);
    startTrack(guild.id);
    return message;
  } finally {
    if (!state.current && state.items.length === 0) {
      stopGuild(guild.id);
    }
  }
}

function assertGuild(guildId) {
  if (!client.guilds.cache.has(String(guildId))) throw new Error('Serveur introuvable.');
}

const botApi = {
  library: getMusicFiles,

  getState() {
    return client.guilds.cache.map(guild => {
      const state = queues.get(guild.id);
      const status = state?.player.state.status;

      return {
        id: guild.id,
        name: guild.name,
        channels: guild.channels.cache
          .filter(channel => channel.isVoiceBased())
          .map(channel => ({ id: channel.id, name: channel.name })),
        channelId: state?.connection?.joinConfig?.channelId || null,
        current: state?.current?.name || null,
        paused: status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused,
        queue: state ? state.items.map(track => track.name) : [],
        station: state?.station || null,
        loop: Boolean(state?.loop),
        stations: guildStations(guild.id).map(s => ({
          name: s.name,
          items: s.items.map(item => ({ type: item.type, label: item.label }))
        }))
      };
    });
  },

  play(guildId, channelId, source, value, loop) {
    return webEnqueue(guildId, channelId, async state => {
      if (source === 'local') {
        const file = findMusic(String(value || ''));
        if (!file) throw new Error('MP3 introuvable.');

        state.items.push({
          name: path.parse(file).name,
          file: path.join(MUSIC_DIR, file),
          ffmpeg: null,
          deleteOnFinish: false
        });
        return `🎶 ${path.parse(file).name} ajouté à la file.`;
      }

      if (source === 'spotify') {
        return spotifyReport(await enqueueSpotify(state, String(value || '')))
          .replace(/\*\*/g, '');
      }

      if (source === 'url') {
        return enqueueDrive(state, String(value || ''));
      }

      if (source === 'radio') {
        return enqueueRadio(state, String(value || ''));
      }

      if (source === 'station') {
        const station = findStation(guildId, String(value || ''));
        if (!station) throw new Error('Playlist introuvable.');

        const message = (await enqueueStation(state, station)).replace(/\*\*/g, '');
        state.station = station.name;
        state.loop = loop !== false;
        state.lastRefill = Date.now();
        return state.loop ? `${message}\n🔁 Boucle activée.` : message;
      }

      throw new Error('Source inconnue.');
    });
  },

  upload(guildId, channelId, name, stream) {
    return webEnqueue(guildId, channelId, async state => {
      if (!/\.mp3$/i.test(name)) throw new Error('Le fichier doit être au format MP3.');

      const safeName = path.parse(name).name.replace(/[^a-zA-Z0-9 _-]/g, '_').slice(0, 70) || 'musique';
      const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${randomUUID()}-${safeName}.mp3`);
      let received = 0;

      stream.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) {
          stream.destroy(Object.assign(new Error(`Fichier trop volumineux (max ${MAX_UPLOAD_MB} Mo).`), { status: 413 }));
        }
      });

      try {
        await pipeline(stream, fs.createWriteStream(filePath, { flags: 'wx' }));
      } catch (error) {
        await fsp.unlink(filePath).catch(() => {});
        throw error;
      }

      if (received === 0) {
        await fsp.unlink(filePath).catch(() => {});
        throw new Error('Le fichier MP3 est vide.');
      }

      state.items.push({ name: safeName, file: filePath, ffmpeg: null, deleteOnFinish: true, deleteScheduled: false });
      return `🎶 ${safeName} ajouté à la file.`;
    });
  },

  async addStation(guildId, source, name) {
    assertGuild(guildId);
    const station = await createStation(String(guildId), source, name);
    return `✅ Playlist ${station.name} créée (${station.info}).`;
  },

  removeStation(guildId, name) {
    assertGuild(guildId);
    const station = deleteStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');
    return `🗑️ Playlist ${station.name} supprimée.`;
  },

  async addStationLink(guildId, name, source) {
    assertGuild(guildId);
    const result = await addLinkToStation(String(guildId), name, source);
    return `✅ ${result.label} ajouté à ${result.station} (${result.info}).`;
  },

  async addStationFile(guildId, name, fileName, stream) {
    assertGuild(guildId);
    const station = findStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');

    const tmpPath = await saveUploadStream(stream, fileName);
    const result = await addFileToStation(String(guildId), station.name, tmpPath, fileName);
    return `✅ ${result.label} ajouté à ${station.name}.`;
  },

  removeStationItem(guildId, name, index) {
    assertGuild(guildId);
    const removed = removeStationItem(String(guildId), name, index);
    return `🗑️ ${removed.label} retiré de la playlist.`;
  },

  async control(guildId, action) {
    const state = queues.get(String(guildId));
    if (!state) throw new Error('Aucune lecture sur ce serveur.');

    if (action === 'pause') state.player.pause();
    else if (action === 'resume') state.player.unpause();
    else if (action === 'skip') state.player.stop(true);
    else if (action === 'stop') stopGuild(String(guildId));
    else if (action === 'loop-on') {
      if (!state.station) throw new Error('Lance d’abord une playlist.');
      state.loop = true;
      startTrack(String(guildId));
    }
    else if (action === 'loop-off') state.loop = false;
    else throw new Error('Action inconnue.');
  }
};

startWeb(botApi);

// ======================================
// COMMANDES DISCORD
// ======================================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;

  try {
    const command = interaction.commandName;

    // PLAY : MP3 envoyé ou musique locale
    if (command === 'play') {
      const attachment = interaction.options.getAttachment('fichier');
      const localName = interaction.options.getString('nom');
      const rawUrl = interaction.options.getString('url');
      const spotifyUrl = interaction.options.getString('spotify');
      const radioUrl = interaction.options.getString('radio');
      const suppliedSources = [attachment, localName, rawUrl, spotifyUrl, radioUrl].filter(Boolean).length;

      if (suppliedSources === 0) {
        return interaction.reply({
          content: '❌ Ajoute un MP3, un nom de fichier local, un lien Google Drive, un lien Spotify ou une radio.',
          ephemeral: true
        });
      }

      if (suppliedSources > 1) {
        return interaction.reply({
          content: '❌ Choisis une seule source : fichier, nom, URL, Spotify ou radio.',
          ephemeral: true
        });
      }

      if (rawUrl) {
        let parsedUrl;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          return interaction.reply({ content: '❌ URL invalide.', ephemeral: true });
        }

        if (parsedUrl.hostname === 'open.spotify.com' || parsedUrl.hostname === 'spotify.com') {
          return interaction.reply({
            content: '🎧 Pour un lien Spotify, utilise l’option **spotify** de /play.',
            ephemeral: true
          });
        }

        if (parsedUrl.hostname !== 'drive.google.com') {
          return interaction.reply({
            content: '❌ Pour la lecture par URL, utilisez un lien Google Drive public vers un fichier MP3.',
            ephemeral: true
          });
        }
      }

      await interaction.deferReply();

      let state = queues.get(guildId);

      if (!state) {
        state = createMusicState(guildId, interaction.channel);
        queues.set(guildId, state);
      } else {
        state.textChannel = interaction.channel;
      }

      let newTrack;

      try {
        await connectVoice(interaction, state);

        if (attachment) {
          const filePath = await downloadDiscordMp3(attachment);

          newTrack = {
            name: path.parse(attachment.name).name,
            file: filePath,
            ffmpeg: null,
            deleteOnFinish: true,
            deleteScheduled: false
          };

        } else if (spotifyUrl) {
          const result = await enqueueSpotify(state, spotifyUrl);

          if (!result.added.length && !state.current) {
            stopGuild(guildId);
          }

          await interaction.editReply(spotifyReport(result));
          startTrack(guildId);
          return;

        } else if (radioUrl) {
          const message = await enqueueRadio(state, radioUrl);
          await interaction.editReply(message);
          startTrack(guildId);
          return;

        } else if (rawUrl) {
          if (extractGoogleDriveFolderId(rawUrl)) {
            const message = await enqueueDrive(state, rawUrl);
            await interaction.editReply(message);
            startTrack(guildId);
            return;
          }

          const filePath = await downloadGoogleDriveMp3(rawUrl);

          newTrack = {
            name: 'Musique Google Drive',
            file: filePath,
            ffmpeg: null,
            deleteOnFinish: true,
            deleteScheduled: false
          };

        } else {
          const fileName = findMusic(localName);

          if (!fileName) {
            throw new Error(
              `MP3 introuvable : ${localName}. Utilise /list.`
            );
          }

          newTrack = {
            name: path.parse(fileName).name,
            file: path.join(MUSIC_DIR, fileName),
            ffmpeg: null,
            deleteOnFinish: false
          };
        }

      } catch (error) {
        if (newTrack?.deleteOnFinish) {
          await deleteUploadedFile(newTrack.file);
        }
        throw error;
      }

      state.items.push(newTrack);

      const position = state.items.length + (state.current ? 1 : 0);

      await interaction.editReply(
        `🎶 **${newTrack.name}** ajouté à la file d'attente. Position : **${position}**`
      );

      startTrack(guildId);
    }

    // LIST
    else if (command === 'list') {
      const files = getMusicFiles();

      if (!files.length) {
        return interaction.reply({
          content: '📂 Aucun MP3 local. Tu peux envoyer ton propre fichier avec /play.',
          ephemeral: true
        });
      }

      const content = files
        .map((file, index) => `${index + 1}. ${path.parse(file).name}`)
        .join('\n');

      return interaction.reply({
        content: `🎵 **Musiques disponibles**\n\n${content}`.slice(0, 1950),
        ephemeral: true
      });
    }

    // NEXT
    else if (command === 'skip') {
      const state = queues.get(guildId);

      if (!state || !state.current) {
        return interaction.reply({
          content: '❌ Aucune musique en cours.',
          ephemeral: true
        });
      }

      const name = state.current.name;

      state.player.stop(true);

      return interaction.reply(
        `⏭️ **${name}** ignorée. Passage au morceau suivant...`
      );
    }

    // PAUSE
    else if (command === 'pause') {
      const state = queues.get(guildId);

      if (!state || !state.player.pause()) {
        return interaction.reply({
          content: '❌ Aucune musique en cours.',
          ephemeral: true
        });
      }

      return interaction.reply('⏸️ Musique mise en pause.');
    }

    // RESUME
    else if (command === 'resume') {
      const state = queues.get(guildId);

      if (!state || !state.player.unpause()) {
        return interaction.reply({
          content: '❌ Aucune musique en pause.',
          ephemeral: true
        });
      }

      return interaction.reply('▶️ Lecture reprise.');
    }

    // QUEUE
    else if (command === 'queue') {
      const state = queues.get(guildId);

      if (!state || (!state.current && state.items.length === 0)) {
        return interaction.reply({
          content: '📭 La file d’attente est vide.',
          ephemeral: true
        });
      }

      const lines = [];

      if (state.current) {
        lines.push(`▶️ En cours : **${state.current.name}**`);
      }

      state.items.slice(0, 15).forEach((track, index) => {
        lines.push(`${index + 1}. ${track.name}`);
      });

      return interaction.reply(
        `🎶 **File d'attente MCT MUSIC**\n\n${lines.join('\n')}`
      );
    }

    // STOP
    else if (command === 'stop') {
      stopGuild(guildId);

      return interaction.reply(
        '⏹️ Lecture arrêtée. File vidée et bot déconnecté.'
      );
    }

  } catch (error) {
    console.error('Erreur commande :', error);

    const message = `❌ ${error.message}`;

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({
        content: message,
        ephemeral: true
      }).catch(() => {});
    }
  }
});

// ======================================
// PLAYLISTS (stations) : liens Spotify, Google Drive, radios et MP3 envoyés
// ======================================

const STATIONS_FILE = path.join(MUSIC_DIR, '..', 'stations.json');
const PLAYLIST_DIR = path.join(MUSIC_DIR, 'playlists');
const MAX_STATIONS = 25;
const MAX_STATION_ITEMS = 50;
const ITEM_ICONS = { radio: '📻', spotify: '🎧', drive: '☁️', file: '🎵' };

fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

const sameName = (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
const cleanName = value => String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 50);

// Anciennes stations (un seul lien) -> playlists (liste d'éléments)
function normalizeStation(station) {
  if (Array.isArray(station.items)) return station;
  return { name: station.name, items: [{ type: station.type, value: station.value, label: station.name }] };
}

function loadStations() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
    return Object.fromEntries(
      Object.entries(raw).map(([id, list]) => [id, list.map(normalizeStation)])
    );
  } catch {
    return {};
  }
}

function saveStations(all) {
  const tmp = `${STATIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, STATIONS_FILE);
}

const guildStations = guildId => loadStations()[guildId] || [];
const findStation = (guildId, name) => guildStations(guildId).find(s => sameName(s.name, name));

async function deleteStoredFile(name) {
  await fsp.unlink(path.join(PLAYLIST_DIR, path.basename(String(name)))).catch(() => {});
}

// Modifie une playlist de façon synchrone (lecture + écriture sans interruption).
function updateStation(guildId, name, change) {
  const all = loadStations();
  const station = (all[guildId] || []).find(s => sameName(s.name, name));
  if (!station) throw new Error('Playlist introuvable.');

  change(station);
  saveStations(all);
  return station;
}

function addStationItem(guildId, name, item) {
  return updateStation(guildId, name, station => {
    if (station.items.length >= MAX_STATION_ITEMS) {
      throw new Error(`Maximum ${MAX_STATION_ITEMS} éléments par playlist.`);
    }
    station.items.push(item);
  });
}

// Vérifie un lien et le transforme en élément de playlist.
async function buildItem(source) {
  let url;
  try {
    url = new URL(String(source || '').trim());
  } catch {
    throw new Error('Colle un lien valide : Spotify, Google Drive ou adresse d’une radio.');
  }

  const host = url.hostname.replace(/^www\./, '');

  if (host === 'open.spotify.com') {
    const { label, tracks } = await resolveSpotify(url.href);
    return {
      type: 'spotify',
      value: url.href,
      label,
      info: `${tracks.length} morceau(x), lus depuis tes MP3 locaux`
    };
  }

  if (host === 'drive.google.com') {
    const folder = extractGoogleDriveFolderId(url.href);
    if (!folder) extractGoogleDriveFileId(url.href); // lève une erreur si le lien est invalide

    return {
      type: 'drive',
      value: url.href,
      label: folder ? 'Dossier Google Drive' : 'Musique Google Drive',
      info: folder ? 'tous les MP3 du dossier' : 'un MP3'
    };
  }

  if (/(^|\.)(music\.apple\.com|soundcloud\.com)$/i.test(host)) {
    throw new Error(
      'Apple Music et SoundCloud ne donnent pas accès à l’audio : le bot ne peut pas les lire. Utilise Spotify (lu depuis tes MP3), Google Drive, un MP3 ou une radio.'
    );
  }

  const radio = await probeRadio(url.href);
  return { type: 'radio', value: url.href, label: radio.title, info: 'radio en direct' };
}

// Crée une playlist ; sans lien, elle est créée vide (un nom est alors obligatoire).
async function createStation(guildId, source, customName) {
  const link = String(source || '').trim();
  const wanted = cleanName(customName);

  if (!link && !wanted) throw new Error('Donne un nom ou un lien pour créer la playlist.');
  if (guildStations(guildId).length >= MAX_STATIONS) {
    throw new Error(`Maximum ${MAX_STATIONS} playlists par serveur. Supprime-en une d’abord.`);
  }

  const built = link ? await buildItem(link) : null;
  const name = wanted || cleanName(built.label) || 'Playlist';

  const all = loadStations();
  const list = all[guildId] || [];

  if (list.some(s => sameName(s.name, name))) {
    throw new Error(`Une playlist s’appelle déjà « ${name} ». Choisis un autre nom.`);
  }

  const { info, ...item } = built || {};
  all[guildId] = [...list, { name, items: built ? [item] : [] }];
  saveStations(all);

  return { name, info: built ? info : 'playlist vide' };
}

function deleteStation(guildId, name) {
  const station = findStation(guildId, name);
  if (!station) return null;

  const all = loadStations();
  all[guildId] = (all[guildId] || []).filter(s => s.name !== station.name);
  saveStations(all);

  for (const item of station.items) {
    if (item.type === 'file') deleteStoredFile(item.value);
  }
  return station;
}

async function addLinkToStation(guildId, name, source) {
  const station = findStation(guildId, name);
  if (!station) throw new Error('Playlist introuvable.');

  const { info, ...item } = await buildItem(source);
  addStationItem(guildId, station.name, item);
  return { station: station.name, label: item.label, info };
}

// Range un MP3 déjà téléchargé (tmpPath) dans le dossier des playlists.
async function addFileToStation(guildId, name, tmpPath, originalName) {
  const label = path.parse(String(originalName)).name
    .replace(/[^a-zA-Z0-9 _-]/g, '_')
    .slice(0, 70) || 'musique';
  const stored = `${Date.now()}-${randomUUID()}-${label}.mp3`;

  try {
    if (!findStation(guildId, name)) throw new Error('Playlist introuvable.');

    await fsp.rename(tmpPath, path.join(PLAYLIST_DIR, stored));

    try {
      addStationItem(guildId, name, { type: 'file', value: stored, label });
    } catch (error) {
      await deleteStoredFile(stored);
      throw error;
    }
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }

  return { label, info: 'fichier MP3' };
}

// Enregistre un MP3 reçu par le navigateur dans un fichier temporaire.
async function saveUploadStream(stream, originalName) {
  if (!/\.mp3$/i.test(String(originalName))) throw new Error('Le fichier doit être au format MP3.');

  const tmpPath = path.join(UPLOAD_DIR, `${Date.now()}-${randomUUID()}-playlist.mp3`);
  let received = 0;

  stream.on('data', chunk => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      stream.destroy(Object.assign(new Error(`Fichier trop volumineux (max ${MAX_UPLOAD_MB} Mo).`), { status: 413 }));
    }
  });

  try {
    await pipeline(stream, fs.createWriteStream(tmpPath, { flags: 'wx' }));
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }

  if (received === 0) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new Error('Le fichier MP3 est vide.');
  }

  return tmpPath;
}

function removeStationItem(guildId, name, index) {
  let removed;

  updateStation(guildId, name, station => {
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= station.items.length) {
      throw new Error(`Numéro invalide (1 à ${station.items.length}).`);
    }
    [removed] = station.items.splice(position, 1);
  });

  if (removed.type === 'file') deleteStoredFile(removed.value);
  return removed;
}

async function enqueueStation(state, station) {
  if (!station.items.length) {
    throw new Error('Cette playlist est vide. Ajoute-lui des éléments.');
  }

  const before = new Set(state.items);
  const notes = [];

  for (const [index, item] of station.items.entries()) {
    const label = item.label || item.type;

    try {
      if (item.type === 'radio') {
        await enqueueRadio(state, item.value);
        if (index < station.items.length - 1) {
          notes.push(`📻 ${label} ne se termine pas : utilise Suivant pour passer à la suite.`);
        }
      } else if (item.type === 'spotify') {
        const { missing } = await enqueueSpotify(state, item.value);
        if (missing.length) notes.push(`🎧 ${label} : ${missing.length} morceau(x) sans MP3 correspondant.`);
      } else if (item.type === 'drive') {
        await enqueueDrive(state, item.value);
      } else if (item.type === 'file') {
        const file = path.join(PLAYLIST_DIR, path.basename(String(item.value)));
        if (!fs.existsSync(file)) throw new Error('fichier introuvable sur le serveur.');
        state.items.push({ name: label, file, ffmpeg: null, deleteOnFinish: false });
      }
    } catch (error) {
      notes.push(`⚠️ ${label} : ${error.message}`);
    }
  }

  const added = state.items.filter(track => !before.has(track)).length;
  return [`🎶 Playlist **${station.name}** : ${added} morceau(x) ajouté(s) à la file.`, ...notes.slice(0, 8)].join('\n');
}

const itemLine = (item, index) => `${index + 1}. ${ITEM_ICONS[item.type] || '•'} ${item.label}`;

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Autocomplétion des noms de playlists
    if (interaction.isAutocomplete() && interaction.commandName === 'station') {
      const typed = interaction.options.getFocused().toLowerCase();
      return interaction.respond(
        guildStations(interaction.guildId)
          .filter(s => s.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(s => ({ name: s.name.slice(0, 100), value: s.name.slice(0, 100) }))
      );
    }

    // Validation du formulaire de création
    if (interaction.isModalSubmit() && interaction.customId === 'station-create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const { name, info } = await createStation(
        interaction.guildId,
        interaction.fields.getTextInputValue('source'),
        interaction.fields.getTextInputValue('name')
      );

      return interaction.editReply(
        `✅ Playlist **${name}** créée (${info}).\nAjoute-lui d’autres éléments avec \`/station ajouter\`, lance-la avec \`/station jouer\`.`
      );
    }

    if (!interaction.isChatInputCommand() || interaction.commandName !== 'station') return;

    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({ content: '❌ Commande réservée aux serveurs.', flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'creer') {
      const modal = new ModalBuilder()
        .setCustomId('station-create')
        .setTitle('Créer une nouvelle station')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('source')
              .setLabel('Playlist ou URL de la station')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Lien Spotify, Google Drive ou URL radio')
              .setRequired(true)
              .setMaxLength(500)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Nom de la station (facultatif)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Nom de la station')
              .setRequired(false)
              .setMaxLength(50)
          )
        );

      return interaction.showModal(modal);
    }

    if (sub === 'liste') {
      const wanted = interaction.options.getString('nom');

      if (wanted) {
        const station = findStation(guildId, wanted);
        if (!station) {
          return interaction.reply({ content: '❌ Playlist introuvable.', flags: MessageFlags.Ephemeral });
        }

        const lines = station.items.map(itemLine);
        return interaction.reply({
          content: `📻 **${station.name}**\n\n${lines.join('\n') || 'Playlist vide.'}`.slice(0, 1950),
          flags: MessageFlags.Ephemeral
        });
      }

      const list = guildStations(guildId);
      if (!list.length) {
        return interaction.reply({
          content: '📻 Aucune playlist. Crée-en une avec `/station creer`.',
          flags: MessageFlags.Ephemeral
        });
      }

      const lines = list.map((s, i) => `${i + 1}. **${s.name}** : ${s.items.length} élément(s)`);
      return interaction.reply({
        content: `📻 **Playlists**\n\n${lines.join('\n')}`.slice(0, 1950),
        flags: MessageFlags.Ephemeral
      });
    }

    if (sub === 'ajouter') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const typed = cleanName(interaction.options.getString('nom'));
      const attachment = interaction.options.getAttachment('fichier');
      const link = interaction.options.getString('lien');

      if (!typed) throw new Error('Donne un nom de playlist.');
      if (Boolean(attachment) === Boolean(link)) {
        throw new Error('Choisis soit un fichier MP3, soit un lien (pas les deux).');
      }

      let station = findStation(guildId, typed);
      const created = !station;

      if (created) {
        await createStation(guildId, '', typed);
        station = findStation(guildId, typed);
      }

      try {
        const result = attachment
          ? await addFileToStation(guildId, station.name, await downloadDiscordMp3(attachment), attachment.name)
          : await addLinkToStation(guildId, station.name, link);

        return interaction.editReply(
          `✅ **${result.label}** ajouté à **${station.name}**${created ? ' (nouvelle playlist)' : ''} : ${result.info}.`
        );
      } catch (error) {
        if (created) deleteStation(guildId, station.name);
        throw error;
      }
    }

    if (sub === 'retirer') {
      const station = findStation(guildId, interaction.options.getString('nom'));
      if (!station) {
        return interaction.reply({ content: '❌ Playlist introuvable.', flags: MessageFlags.Ephemeral });
      }

      const removed = removeStationItem(guildId, station.name, interaction.options.getInteger('numero') - 1);
      return interaction.reply({
        content: `🗑️ **${removed.label}** retiré de **${station.name}**.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (sub === 'boucle') {
      const state = queues.get(guildId);
      if (!state?.station) {
        return interaction.reply({
          content: '❌ Lance d’abord une playlist avec /station jouer.',
          flags: MessageFlags.Ephemeral
        });
      }

      const on = interaction.options.getBoolean('actif');
      state.loop = on;
      if (on) startTrack(guildId);

      return interaction.reply(`🔁 Boucle ${on ? 'activée' : 'désactivée'} pour **${state.station}**.`);
    }

    if (sub === 'supprimer') {
      const station = findStation(guildId, interaction.options.getString('nom'));
      if (!station) {
        return interaction.reply({ content: '❌ Playlist introuvable.', flags: MessageFlags.Ephemeral });
      }

      deleteStation(guildId, station.name);
      return interaction.reply({ content: `🗑️ Playlist **${station.name}** supprimée.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'jouer') {
      const station = findStation(guildId, interaction.options.getString('nom'));
      if (!station) {
        return interaction.reply({ content: '❌ Playlist introuvable. Utilise /station liste.', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply();

      let state = queues.get(guildId);
      if (!state) {
        state = createMusicState(guildId, interaction.channel);
        queues.set(guildId, state);
      } else {
        state.textChannel = interaction.channel;
      }

      try {
        await connectVoice(interaction, state);
        const loop = interaction.options.getBoolean('boucle') ?? true;
        const message = await enqueueStation(state, station);

        state.station = station.name;
        state.loop = loop;
        state.lastRefill = Date.now();

        await interaction.editReply(
          `${message.slice(0, 1800)}\n🔁 Boucle ${loop ? 'activée' : 'désactivée'}.`
        );
        startTrack(guildId);
      } finally {
        if (!state.current && state.items.length === 0) stopGuild(guildId);
      }
    }
  } catch (error) {
    console.error('Erreur station :', error);

    const message = `❌ ${error.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else if (interaction.isRepliable()) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ======================================
// DÉMARRAGE
// ======================================

client.once(Events.ClientReady, readyClient => {
  console.log('================================');
  console.log(`🎵 MCT MUSIC connecté : ${readyClient.user.tag}`);
  console.log('✅ Lecture MP3 locale activée');
  console.log('✅ Lecture des MP3 joints aux commandes /play activée');
  console.log('✅ Lecture des MP3 publics Google Drive activée');
  console.log('✅ Radios / flux audio en direct activés');
  console.log('✅ Playlists (/station) : Spotify, Drive, radios et MP3');
  console.log('✅ Liens Spotify : retrouvés dans les MP3 locaux (titre du morceau)');
  console.log('================================');
});

client.login(process.env.DISCORD_TOKEN);