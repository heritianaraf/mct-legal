require('dotenv').config();

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { Client, GatewayIntentBits, Events } = require('discord.js');

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

  const ffmpeg = spawn('ffmpeg', [
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

      state.textChannel.send(
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

  state.textChannel.send(
    `🎵 Lecture en cours : **${track.name}**`
  ).catch(() => {});
}

// ======================================
// CONNEXION AU SALON VOCAL
// ======================================

async function connectVoice(interaction, state) {
  const voiceChannel = interaction.member.voice?.channel;

  if (!voiceChannel) {
    throw new Error('Rejoins un salon vocal avant de lancer la musique.');
  }

  if (
    !state.connection ||
    state.connection.state.status === VoiceConnectionStatus.Destroyed
  ) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    state.connection.subscribe(state.player);

    await entersState(
      state.connection,
      VoiceConnectionStatus.Ready,
      20000
    );

  } else if (
    state.connection.joinConfig.channelId !== voiceChannel.id
  ) {
    throw new Error('MCT MUSIC est déjà connecté à un autre salon vocal.');
  }
}

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

      if (!attachment && !localName) {
        return interaction.reply({
          content: '❌ Ajoute un MP3 avec fichier ou indique un nom.',
          ephemeral: true
        });
      }

      if (attachment && localName) {
        return interaction.reply({
          content: '❌ Choisis soit un fichier, soit un nom.',
          ephemeral: true
        });
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

    // SKIP
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
      const state = queues.get(guildId);

      if (state) {
        queues.delete(guildId);

        for (const track of state.items) {
          cleanupTrack(track);
        }

        state.items = [];

        cleanupTrack(state.current);
        state.current = null;

        state.player.stop(true);

        if (state.connection) {
          state.connection.destroy();
        }
      }

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
  console.log('================================');
});

client.login(process.env.DISCORD_TOKEN);