require('dotenv').config();

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');

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

async function downloadGoogleDriveMp3(rawUrl) {
  const fileId = extractGoogleDriveFileId(rawUrl);
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
    textChannel
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

  if (!state || state.current || state.items.length === 0) {
    return;
  }

  const track = state.items.shift();

  state.current = track;

  console.log('🎵 Lecture :', track.name);

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
        queue: state ? state.items.map(track => track.name) : []
      };
    });
  },

  play(guildId, channelId, source, value) {
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

  async control(guildId, action) {
    const state = queues.get(String(guildId));
    if (!state) throw new Error('Aucune lecture sur ce serveur.');

    if (action === 'pause') state.player.pause();
    else if (action === 'resume') state.player.unpause();
    else if (action === 'skip') state.player.stop(true);
    else if (action === 'stop') stopGuild(String(guildId));
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
      const suppliedSources = [attachment, localName, rawUrl, spotifyUrl].filter(Boolean).length;

      if (suppliedSources === 0) {
        return interaction.reply({
          content: '❌ Ajoute un MP3, un nom de fichier local, un lien Google Drive ou un lien Spotify.',
          ephemeral: true
        });
      }

      if (suppliedSources > 1) {
        return interaction.reply({
          content: '❌ Choisis une seule source : fichier, nom, URL ou Spotify.',
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

        } else if (rawUrl) {
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
// DÉMARRAGE
// ======================================

client.once(Events.ClientReady, readyClient => {
  console.log('================================');
  console.log(`🎵 MCT MUSIC connecté : ${readyClient.user.tag}`);
  console.log('✅ Lecture MP3 locale activée');
  console.log('✅ Lecture des MP3 joints aux commandes /play activée');
  console.log('✅ Lecture des MP3 publics Google Drive activée');
  console.log('✅ Liens Spotify : retrouvés dans les MP3 locaux (titre du morceau)');
  console.log('================================');
});

client.login(process.env.DISCORD_TOKEN);