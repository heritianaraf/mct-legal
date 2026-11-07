require('dotenv').config();

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

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
  const ffmpeg = spawn(ffmpegPath || 'ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', track.file,
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
      if (source === 'url') {
        return enqueueDrive(state, String(value || ''));
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

  async addStation(guildId, source, name, password) {
    assertPlaylistPassword(password, 'web');
    assertGuild(guildId);
    const station = await createStation(String(guildId), source, name);
    return `✅ Playlist ${station.name} créée (${station.info}).`;
  },

  removeStation(guildId, name, password) {
    assertPlaylistPassword(password, 'web');
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

  // Enregistre des morceaux de la file dans une ou plusieurs playlists.
  async saveQueueToStations(guildId, items, stationNames) {
    assertGuild(guildId);

    const state = queues.get(String(guildId));
    if (!state) throw new Error('Aucune lecture sur ce serveur.');
    if (!Array.isArray(items) || !items.length) throw new Error('Sélectionne au moins un morceau.');
    if (!Array.isArray(stationNames) || !stationNames.length) throw new Error('Choisis au moins une playlist.');

    const tracks = items.slice(0, MAX_STATION_ITEMS).map(({ index, name }) => {
      const track = state.items[Number(index)];
      if (!track || track.name !== name) throw new Error('La file a changé, réessaie.');
      return track;
    });

    const { done, notes } = await saveTracksToStations(
      String(guildId),
      tracks,
      stationNames.slice(0, MAX_STATIONS).map(String)
    );

    if (!done) throw new Error(notes.slice(0, 5).join('\n') || 'Rien n’a été ajouté.');
    return [`✅ ${done} ajout(s) dans les playlists.`, ...notes.slice(0, 5)].join('\n');
  },

  // Réorganise la file : 'up' remonte d'un cran, 'play' lance le morceau tout de suite.
  queueAction(guildId, index, action, name) {
    const id = String(guildId);
    const state = queues.get(id);
    if (!state) throw new Error('Aucune lecture sur ce serveur.');

    const position = Number(index);
    const track = state.items[position];

    if (!Number.isInteger(position) || !track || (name && track.name !== name)) {
      throw new Error('La file a changé, réessaie.');
    }

    if (action === 'up') {
      if (position === 0) throw new Error('Ce morceau est déjà le prochain.');
      [state.items[position - 1], state.items[position]] = [state.items[position], state.items[position - 1]];
      return `⬆️ ${track.name} remonté dans la file.`;
    }

    if (action === 'play') {
      state.items.splice(position, 1);
      state.items.unshift(track);

      const current = state.current;

      if (!current) {
        startTrack(id);
      } else if (current.driveId && !current.file) {
        // morceau Drive encore en téléchargement : on l'abandonne
        cleanupTrack(current);
        state.current = null;
        startTrack(id);
      } else {
        state.player.stop(true);
      }

      return `▶️ ${track.name} : lecture immédiate.`;
    }

    throw new Error('Action inconnue.');
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

    // PLAY : MP3 envoyé ou lien Google Drive
    if (command === 'play') {
      const attachment = interaction.options.getAttachment('fichier');
      const rawUrl = interaction.options.getString('url');
      const suppliedSources = [attachment, rawUrl].filter(Boolean).length;

      if (suppliedSources === 0) {
        return interaction.reply({
          content: '❌ Ajoute un MP3 ou un lien Google Drive (fichier ou dossier).',
          ephemeral: true
        });
      }

      if (suppliedSources > 1) {
        return interaction.reply({
          content: '❌ Choisis une seule source : fichier ou lien Google Drive.',
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

        if (parsedUrl.hostname !== 'drive.google.com') {
          return interaction.reply({
            content: '❌ Pour la lecture par URL, utilise un lien Google Drive public vers un MP3 ou un dossier.',
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
// PLAYLISTS (stations) : liens Google Drive et MP3 envoyés
// ======================================

const STATIONS_FILE = path.join(MUSIC_DIR, '..', 'stations.json');
const PLAYLIST_DIR = path.join(MUSIC_DIR, 'playlists');
const MAX_STATIONS = 25;
const MAX_STATION_ITEMS = 50;
const ITEM_ICONS = { drive: '☁️', file: '🎵' };

fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

// ======================================
// MOT DE PASSE (créer / supprimer une playlist)
// ======================================

const PLAYLIST_PASSWORD = (process.env.PLAYLIST_PASSWORD || '').trim();
const passwordFails = new Map();

function assertPlaylistPassword(given, key) {
  if (!PLAYLIST_PASSWORD) {
    throw new Error('Définis PLAYLIST_PASSWORD dans .env pour créer ou supprimer une playlist.');
  }

  const entry = passwordFails.get(key);
  const active = Boolean(entry && entry.reset > Date.now());

  if (active && entry.count >= 5) {
    throw new Error('Trop d’essais, réessaie dans quelques minutes.');
  }

  const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest();

  if (!crypto.timingSafeEqual(hash(given), hash(PLAYLIST_PASSWORD))) {
    passwordFails.set(key, {
      count: (active ? entry.count : 0) + 1,
      reset: active ? entry.reset : Date.now() + 10 * 60 * 1000
    });
    throw new Error('Mot de passe incorrect.');
  }

  passwordFails.delete(key);
}

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
    throw new Error('Colle un lien Google Drive valide (fichier ou dossier).');
  }

  const host = url.hostname.replace(/^www\./, '');

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

  throw new Error('Lien non pris en charge : utilise un lien Google Drive (fichier ou dossier).');
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

// Ajoute des morceaux de la file à une ou plusieurs playlists.
// - morceau Google Drive : on garde seulement le lien (rien à copier)
// - MP3 envoyé : le fichier est copié dans le dossier des playlists (une copie par playlist)
async function saveTracksToStations(guildId, tracks, stationNames) {
  let done = 0;
  const notes = [];

  for (const stationName of stationNames) {
    const station = findStation(guildId, stationName);

    if (!station) {
      notes.push(`⚠️ Playlist « ${stationName} » introuvable.`);
      continue;
    }

    for (const track of tracks) {
      const label = String(track.name).slice(0, 70);

      try {
        if (track.driveId) {
          addStationItem(guildId, station.name, {
            type: 'drive',
            value: `https://drive.google.com/file/d/${track.driveId}/view`,
            label
          });
        } else if (track.file && fs.existsSync(track.file)) {
          const stored = `${Date.now()}-${randomUUID()}-${label.replace(/[^a-zA-Z0-9 _-]/g, '_') || 'musique'}.mp3`;
          await fsp.copyFile(track.file, path.join(PLAYLIST_DIR, stored));

          try {
            addStationItem(guildId, station.name, { type: 'file', value: stored, label });
          } catch (error) {
            await deleteStoredFile(stored);
            throw error;
          }
        } else {
          throw new Error('fichier indisponible');
        }

        done++;
      } catch (error) {
        notes.push(`⚠️ ${label} → ${station.name} : ${error.message}`);
      }
    }
  }

  return { done, notes };
}

async function enqueueStation(state, station) {
  if (!station.items.length) {
    throw new Error('Cette playlist est vide. Ajoute-lui des éléments.');
  }

  const before = new Set(state.items);
  const notes = [];

  for (const item of station.items) {
    const label = item.label || item.type;

    try {
      if (item.type === 'drive') {
        await enqueueDrive(state, item.value);
      } else if (item.type === 'file') {
        const file = path.join(PLAYLIST_DIR, path.basename(String(item.value)));
        if (!fs.existsSync(file)) throw new Error('fichier introuvable sur le serveur.');
        state.items.push({ name: label, file, ffmpeg: null, deleteOnFinish: false });
      } else {
        notes.push(`⚠️ ${label} : ce type d’élément n’est plus pris en charge, retire-le de la playlist.`);
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

      assertPlaylistPassword(interaction.fields.getTextInputValue('password'), interaction.user.id);

      const { name, info } = await createStation(
        interaction.guildId,
        interaction.fields.getTextInputValue('source'),
        interaction.fields.getTextInputValue('name')
      );

      return interaction.editReply(
        `✅ Playlist **${name}** créée (${info}).\nAjoute-lui d’autres éléments avec \`/station ajouter\`, lance-la avec \`/station jouer\`.`
      );
    }

    // Validation du formulaire de suppression
    if (interaction.isModalSubmit() && interaction.customId.startsWith('station-delete:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      assertPlaylistPassword(interaction.fields.getTextInputValue('password'), interaction.user.id);

      const station = deleteStation(interaction.guildId, interaction.customId.slice('station-delete:'.length));
      if (!station) throw new Error('Playlist introuvable.');

      return interaction.editReply(`🗑️ Playlist **${station.name}** supprimée.`);
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
              .setLabel('Lien Google Drive')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Lien Google Drive (fichier ou dossier)')
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
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('password')
              .setLabel('Mot de passe')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Mot de passe pour créer une playlist')
              .setRequired(true)
              .setMaxLength(100)
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

      const station = findStation(guildId, typed);
      if (!station) {
        throw new Error('Playlist introuvable. Crée-la d’abord avec /station creer (mot de passe requis).');
      }

      const result = attachment
        ? await addFileToStation(guildId, station.name, await downloadDiscordMp3(attachment), attachment.name)
        : await addLinkToStation(guildId, station.name, link);

      return interaction.editReply(
        `✅ **${result.label}** ajouté à **${station.name}** : ${result.info}.`
      );
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

      const modal = new ModalBuilder()
        .setCustomId(`station-delete:${station.name}`)
        .setTitle('Supprimer la playlist')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('password')
              .setLabel(`Mot de passe pour supprimer « ${station.name.slice(0, 30)} »`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(100)
          )
        );

      return interaction.showModal(modal);
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
  console.log('✅ Lecture des MP3 joints aux commandes /play activée');
  console.log('✅ Lecture des MP3 et dossiers publics Google Drive activée');
  console.log('✅ Playlists (/station) : Google Drive et MP3');
  console.log('================================');
});

client.login(process.env.DISCORD_TOKEN);