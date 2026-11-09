require('dotenv').config();

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');


const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InviteTargetType,
  ActivityType
} = require('discord.js');

const { startWeb } = require('./web');
const { Analyzer } = require('./spectrum');

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

// DATA_DIR : dossier persistant (disque de l'hébergeur) qui survit aux déploiements.
// Sans DATA_DIR, on garde l'ancien emplacement (dossier parent du code).
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
fs.mkdirSync(DATA_DIR, { recursive: true });

const MUSIC_DIR = path.join(DATA_DIR, 'music');
const UPLOAD_DIR = path.join(MUSIC_DIR, 'uploads');

const MAX_UPLOAD_MB = Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 100);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_DRIVE_FOLDER_TRACKS = 100;

const queues = new Map();

// Lecteur personnel (accès THIVALIN) : un état de lecture séparé, sans salon vocal,
// écouté uniquement dans le navigateur. Clé : « tv:<id du serveur> ».
const PERSONAL = 'tv:';
const isPersonal = id => String(id).startsWith(PERSONAL);
const realId = id => (isPersonal(id) ? String(id).slice(PERSONAL.length) : String(id));

fs.mkdirSync(MUSIC_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Vidéos temporaires de l'Activité « regarder ensemble » : directement dans le dossier temporaire
// du système (aucun dossier créé), fichiers mctwatch-<id>.mp4, nettoyés automatiquement.
const WATCH_DIR = require('node:os').tmpdir();
const WATCH_MAX_MINUTES = Math.max(1, Number(process.env.WATCH_MAX_MINUTES) || 60);

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
// ======================================
// YOUTUBE (yt-dlp, téléchargé automatiquement)
// ======================================

const YTDLP_PATH = path.join(DATA_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const YTDLP_COOKIES = path.join(DATA_DIR, 'youtube-cookies.txt');
const YTDLP_REFRESH_MS = 7 * 24 * 3600 * 1000;
const YTDLP_TIMEOUT_MS = 5 * 60 * 1000;
const YTDLP_MAX_SECONDS = 2 * 3600;
let ytdlpReady = null;

// Retourne l'identifiant d'une vidéo YouTube (watch, youtu.be, shorts, embed, live) ou null.
function extractYoutubeId(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      id = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1];
    }
  }

  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

const youtubeUrlFor = id => `https://www.youtube.com/watch?v=${id}`;

// Titre de la vidéo (sans yt-dlp) ; vérifie aussi que la vidéo existe et n'est pas privée.
async function fetchYoutubeTitle(id) {
  const fallback = 'Vidéo YouTube';

  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeUrlFor(id))}`,
      { signal: AbortSignal.timeout(10000) }
    );

    if ([401, 403, 404].includes(response.status)) {
      throw Object.assign(new Error('Vidéo introuvable, privée ou intégration désactivée.'), { definitive: true });
    }
    if (!response.ok) return fallback;

    const data = await response.json();
    return String(data.title || fallback).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 70) || fallback;
  } catch (error) {
    if (error.definitive) throw error;
    return fallback;
  }
}

// Télécharge yt-dlp au premier usage (puis une fois par semaine) : aucune installation à faire.
function ensureYtDlp() {
  ytdlpReady ||= (async () => {
    const fresh = fs.existsSync(YTDLP_PATH) && Date.now() - fs.statSync(YTDLP_PATH).mtimeMs < YTDLP_REFRESH_MS;

    if (!fresh) {
      const asset = process.platform === 'win32'
        ? 'yt-dlp.exe'
        : process.platform === 'darwin'
          ? 'yt-dlp_macos'
          : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';

      try {
        const response = await fetch(
          `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`,
          { signal: AbortSignal.timeout(120000) }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const tmp = `${YTDLP_PATH}.tmp`;
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
        await fsp.chmod(tmp, 0o755);
        await fsp.rename(tmp, YTDLP_PATH);
      } catch (error) {
        // Sans ancienne version à réutiliser, on ne peut pas continuer.
        if (!fs.existsSync(YTDLP_PATH)) throw new Error(`yt-dlp indisponible (${error.message}).`);
      }
    }

    setTimeout(() => { ytdlpReady = null; }, YTDLP_REFRESH_MS).unref();
  })().catch(error => {
    ytdlpReady = null;
    throw error;
  });

  return ytdlpReady;
}

function youtubeErrorMessage(output) {
  if (/sign in to confirm|not a bot|confirm you.re not/i.test(output)) {
    return 'YouTube bloque ce serveur (vérification anti-robot). Ajoute des cookies YouTube dans la variable YOUTUBE_COOKIES.';
  }
  if (/age|inappropriate/i.test(output) && /confirm|restrict|sign in/i.test(output)) {
    return 'Vidéo avec restriction d’âge : des cookies YouTube sont nécessaires (variable YOUTUBE_COOKIES).';
  }
  if (/private video|unavailable|removed|terminated|not available|copyright/i.test(output)) {
    return 'Vidéo indisponible, privée ou bloquée.';
  }

  const line = output.split('\n').reverse().find(l => /error/i.test(l)) || output.trim().split('\n').pop() || '';
  return line.replace(/^ERROR:\s*/i, '').slice(0, 200) || 'téléchargement impossible.';
}

// Télécharge l'audio d'une vidéo YouTube dans UPLOAD_DIR et retourne le chemin du fichier.
async function downloadYoutubeAudio(rawUrl) {
  const id = extractYoutubeId(rawUrl);
  if (!id) throw new Error('Lien YouTube invalide.');

  await ensureYtDlp();

  const prefix = `${Date.now()}-${randomUUID()}-yt`;
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress', '--no-part',
    '-f', 'bestaudio/best',
    '--match-filter', `!is_live & duration<=${YTDLP_MAX_SECONDS}`,
    '--max-filesize', '150M',
    '--js-runtimes', 'node',
    '-o', path.join(UPLOAD_DIR, `${prefix}.%(ext)s`)
  ];

  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(YTDLP_COOKIES, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
    args.push('--cookies', YTDLP_COOKIES);
  }

  args.push(youtubeUrlFor(id));

  const { code, output } = await new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, YTDLP_TIMEOUT_MS);

    const collect = chunk => { text = (text + chunk).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp : ${error.message}`));
    });

    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 'timeout' : exitCode, output: text });
    });
  });

  const produced = (await fsp.readdir(UPLOAD_DIR)).filter(name => name.startsWith(`${prefix}.`));
  const file = produced.find(name => !/\.(part|ytdl|tmp)$/i.test(name));

  for (const name of produced) {
    if (name !== file) await fsp.unlink(path.join(UPLOAD_DIR, name)).catch(() => {});
  }

  if (code === 'timeout') {
    if (file) await fsp.unlink(path.join(UPLOAD_DIR, file)).catch(() => {});
    throw new Error('Le téléchargement YouTube a expiré (plus de 5 minutes).');
  }

  if (code !== 0 || !file) {
    if (file) await fsp.unlink(path.join(UPLOAD_DIR, file)).catch(() => {});
    if (code === 0) throw new Error(`vidéo ignorée (en direct, plus de ${YTDLP_MAX_SECONDS / 3600} h ou trop volumineuse).`);
    throw new Error(youtubeErrorMessage(output));
  }

  return path.join(UPLOAD_DIR, file);
}

// Lance yt-dlp et attend sa fin (utilisé pour les vidéos de l'Activité).
function runYtDlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const collect = chunk => { text = (text + chunk).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp : ${error.message}`));
    });

    child.on('close', exitCode => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 'timeout' : exitCode, output: text });
    });
  });
}

// Télécharge une vidéo YouTube en MP4 (H.264 + AAC, 720p max) : dossier temporaire/mctwatch-<id>.mp4
async function downloadYoutubeVideo(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(id || ''))) throw new Error('Lien YouTube invalide.');

  const target = path.join(WATCH_DIR, `mctwatch-${id}.mp4`);
  if (fs.existsSync(target)) return target;

  await ensureYtDlp();

  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '-f', 'bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/b[ext=mp4]',
    '--merge-output-format', 'mp4',
    '--match-filter', `!is_live & duration<=${WATCH_MAX_MINUTES * 60}`,
    '--max-filesize', '400M',
    '--js-runtimes', 'node',
    '-o', path.join(WATCH_DIR, `mctwatch-${id}.%(ext)s`)
  ];

  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);

  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(YTDLP_COOKIES, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
    args.push('--cookies', YTDLP_COOKIES);
  }

  args.push(youtubeUrlFor(id));

  const { code, output } = await runYtDlp(args, 10 * 60 * 1000);

  // Fichiers temporaires laissés par yt-dlp (flux séparés audio/vidéo)
  const leftovers = (await fsp.readdir(WATCH_DIR)).filter(name => name.startsWith(`mctwatch-${id}.`) && name !== `mctwatch-${id}.mp4`);
  for (const name of leftovers) await fsp.unlink(path.join(WATCH_DIR, name)).catch(() => {});

  if (code === 'timeout') {
    await fsp.unlink(target).catch(() => {});
    throw new Error('Le téléchargement de la vidéo a expiré (plus de 10 minutes).');
  }

  if (code !== 0) {
    await fsp.unlink(target).catch(() => {});
    throw new Error(youtubeErrorMessage(output));
  }

  if (!fs.existsSync(target)) {
    throw new Error(`vidéo ignorée (en direct, plus de ${WATCH_MAX_MINUTES} min ou trop volumineuse).`);
  }

  return target;
}

async function enqueueYoutube(state, rawUrl) {
  const id = extractYoutubeId(rawUrl);
  if (!id) throw new Error('Colle le lien d’une vidéo YouTube (youtube.com/watch?v=… ou youtu.be/…).');

  const title = await fetchYoutubeTitle(id);

  state.items.push({
    name: title,
    youtubeUrl: youtubeUrlFor(id),
    file: null,
    ffmpeg: null,
    deleteOnFinish: true,
    deleteScheduled: false
  });

  return `▶️ ${title} (YouTube) ajouté à la file.`;
}

// Lien collé pour jouer tout de suite : YouTube ou Google Drive
const enqueueLink = (state, rawUrl) =>
  extractYoutubeId(rawUrl) ? enqueueYoutube(state, rawUrl) : enqueueDrive(state, rawUrl);

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
// HISTORIQUE (bouton « précédent »)
// ======================================

const HISTORY_MAX = 5;

// Les MP3 envoyés sont supprimés après lecture : on en garde un lien (.keep) pour pouvoir les rejouer.
function keepCopy(track) {
  if (!track.deleteOnFinish || track.driveId || track.youtubeUrl || !track.file || track.keepFile) return;

  const keep = `${track.file}.${Date.now()}.keep`;
  try {
    fs.linkSync(track.file, keep);
    track.keepFile = keep;
  } catch {
    try {
      fs.copyFileSync(track.file, keep);
      track.keepFile = keep;
    } catch {}
  }
}

function dropKeep(track) {
  if (!track?.keepFile) return;
  deleteUploadedFile(track.keepFile);
  track.keepFile = null;
}

function snapshotTrack(track) {
  if (track.driveId) return { name: track.name, driveId: track.driveId };
  if (track.youtubeUrl) return { name: track.name, youtubeUrl: track.youtubeUrl };
  if (!track.file) return null;
  if (!track.deleteOnFinish) return { name: track.name, file: track.file, persistent: true };
  if (!track.keepFile) return null;
  return { name: track.name, file: track.keepFile, persistent: false };
}

function trackFromSnapshot(snap) {
  if (snap.youtubeUrl) {
    return { name: snap.name, youtubeUrl: snap.youtubeUrl, file: null, ffmpeg: null, deleteOnFinish: true, deleteScheduled: false };
  }
  if (snap.driveId) {
    return { name: snap.name, driveId: snap.driveId, file: null, ffmpeg: null, deleteOnFinish: true, deleteScheduled: false };
  }
  return { name: snap.name, file: snap.file, ffmpeg: null, deleteOnFinish: !snap.persistent, deleteScheduled: false };
}

function dropSnapshot(snap) {
  if (snap && !snap.persistent && snap.file) deleteUploadedFile(snap.file);
}

// Appelé quand un morceau se termine : on le range dans l'historique (sauf si on revient en arrière).
function endTrack(state, track, remember) {
  const snap = remember ? snapshotTrack(track) : null;

  if (snap) {
    state.history.push(snap);
    while (state.history.length > HISTORY_MAX) dropSnapshot(state.history.shift());
  } else {
    dropKeep(track);
  }

  cleanupTrack(track);
}

// ======================================
// VOLUME (par serveur, enregistré dans volumes.json)
// ======================================

const VOLUME_FILE = path.join(DATA_DIR, 'volumes.json');
const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 200;

const volumes = (() => {
  try {
    return JSON.parse(fs.readFileSync(VOLUME_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
})();

function getVolume(guildId) {
  const value = Number(volumes[String(guildId)]);
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), MAX_VOLUME) : DEFAULT_VOLUME;
}

// Change le volume (en %) : appliqué tout de suite au morceau en cours et mémorisé.
function setVolume(guildId, level) {
  const value = level === null || level === undefined || level === '' ? NaN : Math.round(Number(level));

  if (!Number.isFinite(value) || value < 0 || value > MAX_VOLUME) {
    throw new Error(`Le volume doit être un nombre entre 0 et ${MAX_VOLUME}.`);
  }

  volumes[String(guildId)] = value;

  try {
    const tmp = `${VOLUME_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(volumes));
    fs.renameSync(tmp, VOLUME_FILE);
  } catch (error) {
    console.error('Impossible d’enregistrer le volume :', error.message);
  }

  queues.get(String(guildId))?.resource?.volume?.setVolume(effectiveVolume(guildId));
  return value;
}

// ======================================
// CRÉATION DU LECTEUR
// ======================================

function createMusicState(guildId, textChannel) {
  const player = createAudioPlayer({
    behaviors: {
      // Lecteur personnel : personne n'est abonné (pas de vocal), la lecture doit quand même avancer.
      noSubscriber: isPersonal(guildId) ? NoSubscriberBehavior.Play : NoSubscriberBehavior.Pause
    }
  });

  const state = {
    player,
    connection: null,
    items: [],
    current: null,
    resource: null,
    textChannel,
    station: null,
    loop: false,
    lastRefill: 0,
    looping: false,
    history: [],
    goingBack: false,
    loopTrack: false,   // répéter le morceau en cours
    forceNext: false    // arrêt volontaire (suivant, précédent…) : pas de répétition
  };

  player.on(AudioPlayerStatus.Idle, () => {
    const forced = state.forceNext;
    state.forceNext = false;

    // Répétition du morceau : on relance le même fichier (sauf si on a demandé de passer au suivant)
    if (state.current && state.loopTrack && !forced && queues.get(guildId) === state) {
      const track = state.current;

      if (track.file && fs.existsSync(track.file) && Date.now() - (track.startedAt || 0) > 1000) {
        playTrack(guildId, state, track, 0, true);
        return;
      }

      state.textChannel?.send('🔂 Répétition arrêtée : ce morceau ne peut pas être relu.').catch(() => {});
    }

    state.loopTrack = false;

    if (state.current) {
      const remember = !state.goingBack;
      state.goingBack = false;
      endTrack(state, state.current, remember);
      state.current = null;
    }

    if (queues.get(guildId) === state) {
      startTrack(guildId);
    }
  });

  player.on('error', error => {
    console.error('Erreur audio :', error);
    state.loopTrack = false;

    if (state.current) {
      dropKeep(state.current);
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

  if ((track.driveId || track.youtubeUrl) && !track.file) {
    (track.driveId ? downloadDriveFileById(track.driveId) : downloadYoutubeAudio(track.youtubeUrl))
      .then(filePath => {
        track.file = filePath;

        if (state.current !== track) {
          deleteUploadedFile(filePath);
          return;
        }

        playTrack(guildId, state, track);
      })
      .catch(error => {
        console.error('Erreur de téléchargement :', error.message);

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

// Durée d'un fichier audio (lue avec ffmpeg, sans ffprobe) : secondes ou null.
function probeDuration(file) {
  return new Promise(resolve => {
    let text = '';
    let child;

    try {
      child = spawn(ffmpegPath || 'ffmpeg', ['-hide_banner', '-i', file], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      });
    } catch {
      return resolve(null);
    }

    const timer = setTimeout(() => child.kill(), 10000);
    child.stderr.on('data', chunk => { if (text.length < 8000) text += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
      resolve(seconds && Number.isFinite(seconds) ? seconds : null);
    });
  });
}

// ======================================
// ÉCOUTE DANS LE NAVIGATEUR (flux MP3 en direct du morceau en cours)
// Le PCM envoyé à Discord est copié vers un encodeur MP3, uniquement si quelqu'un écoute.
// ======================================

const hubs = new Map(); // guildId -> { listeners:Set<res>, encoder, lastPcm, timer }
const MAX_LISTENERS = 10;
const SILENCE = Buffer.alloc(48000 * 2 * 2 / 10); // 100 ms de silence (s16le 48 kHz stéréo)
const PRIME_SECONDS = 3;                                  // coussin de sécurité côté navigateur
const PRIME_BYTES = 48000 * 2 * 2 * PRIME_SECONDS;
const BURST_BYTES = 16000 * PRIME_SECONDS;                // ~3 s de MP3 (128 kbit/s) pour un auditeur qui arrive
const MAX_CLIENT_BACKLOG = 256 * 1024;                    // retard toléré par client (~16 s) avant de sauter du flux
const MAX_PCM_BACKLOG = 1024 * 1024;                      // idem pour l'encodeur (~5 s)

function hubFor(guildId) {
  const id = String(guildId);
  let hub = hubs.get(id);
  if (!hub) {
    hub = { id, listeners: new Set(), encoder: null, lastPcm: 0, timer: null, since: 0, recent: [], recentBytes: 0 };
    hubs.set(id, hub);
  }
  return hub;
}

function startEncoder(hub) {
  if (hub.encoder || !hub.listeners.size) return;

  const encoder = spawn(ffmpegPath || 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', 'nobuffer', '-probesize', '32', '-analyzeduration', '0',
    '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k',
    '-write_xing', '0', '-write_id3v2', '0', '-flush_packets', '1',
    '-f', 'mp3', 'pipe:1'
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });

  encoder.stdin.on('error', () => {});
  encoder.stdout.on('data', chunk => {
    for (const res of hub.listeners) {
      if (res.writableLength < MAX_CLIENT_BACKLOG) res.write(chunk); // client très en retard : on saute du flux
    }

    // les dernières secondes de MP3 : envoyées d'un coup à un nouvel auditeur
    hub.recent.push(chunk);
    hub.recentBytes += chunk.length;
    while (hub.recent.length > 1 && hub.recentBytes - hub.recent[0].length >= BURST_BYTES) {
      hub.recentBytes -= hub.recent.shift().length;
    }
  });
  encoder.on('error', () => { if (hub.encoder === encoder) hub.encoder = null; });
  encoder.on('close', () => { if (hub.encoder === encoder) hub.encoder = null; });

  hub.encoder = encoder;
  hub.lastPcm = Date.now();
  hub.recent = [];
  hub.recentBytes = 0;

  // Quelques secondes de silence envoyées plus vite que le temps réel : le navigateur démarre avec un
  // coussin d'avance et supporte les micro-coupures du réseau (au prix de ~3 s de décalage).
  encoder.stdin.write(Buffer.alloc(PRIME_BYTES));

  // Pendant une pause ou entre deux morceaux, on envoie du silence pour garder le flux ouvert.
  clearInterval(hub.timer);
  hub.timer = setInterval(() => {
    // Silence uniquement en pause / à l'arrêt : jamais quand le son est simplement un peu en retard.
    const status = queues.get(hub.id)?.player.state.status;
    const quiet = !status || status === AudioPlayerStatus.Idle || status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused;

    if (quiet && hub.encoder === encoder && Date.now() - hub.lastPcm > 300 && encoder.stdin.writable && encoder.stdin.writableLength < MAX_PCM_BACKLOG) {
      encoder.stdin.write(SILENCE);
    }
  }, 100);
  hub.timer.unref?.();
}

function stopEncoder(hub) {
  clearInterval(hub.timer);
  hub.timer = null;

  const encoder = hub.encoder;
  hub.encoder = null;
  hub.recent = [];
  hub.recentBytes = 0;
  if (encoder) {
    encoder.stdin.destroy();
    encoder.kill();
  }
}

// Copie chaque bloc de PCM vers l'encodeur (si des auditeurs sont connectés) puis le laisse passer vers Discord.
function makeTap(guildId) {
  const hub = hubFor(guildId);
  const analyzer = new Analyzer();

  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      analyzer.push(chunk);

      if (hub.listeners.size) {
        if (!hub.encoder) startEncoder(hub);
        const encoder = hub.encoder;
        if (encoder && encoder.stdin.writable && encoder.stdin.writableLength < MAX_PCM_BACKLOG) {
          encoder.stdin.write(chunk);
          hub.lastPcm = Date.now();
        }
      }
      callback(null, chunk);
    }
  });

  tap.analyzer = analyzer;
  return tap;
}

// Démarre (ou relance) la lecture d'un morceau. `offset` = position de départ en secondes.
function playTrack(guildId, state, track, offset = 0, silent = false) {
  if (!offset) {
    keepCopy(track);
    track.startedAt = Date.now();
  }

  track.offset = offset;

  if (track.duration === undefined) {
    track.duration = null;
    probeDuration(track.file).then(seconds => { track.duration = seconds; });
  }

  const args = ['-hide_banner', '-loglevel', 'error'];
  if (offset > 0) args.push('-ss', String(offset));
  args.push('-i', track.file, '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

  const previous = track.ffmpeg;

  const ffmpeg = spawn(ffmpegPath || 'ffmpeg', args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  track.ffmpeg = ffmpeg;

  // Déplacement dans le morceau ou répétition : l'ancien processus est arrêté sans toucher au fichier.
  if (previous && previous.exitCode === null) previous.kill();

  ffmpeg.stderr.on('data', data => {
    console.error('FFmpeg :', data.toString());
  });

  ffmpeg.on('error', error => {
    if (track.ffmpeg !== ffmpeg) return;
    console.error('Erreur FFmpeg :', error);

    if (state.current === track) {
      dropKeep(track);
      cleanupTrack(track);
      state.current = null;

      state.textChannel?.send(
        '❌ Impossible de lire ce MP3. Vérifie FFmpeg.'
      ).catch(() => {});

      startTrack(guildId);
    }
  });

  ffmpeg.on('close', code => {
    if (track.ffmpeg !== ffmpeg) return; // remplacé (déplacement) ou nettoyé

    // En répétition, on garde le fichier : il sera supprimé quand le morceau sera vraiment terminé.
    if (track.deleteOnFinish && !state.loopTrack) {
      deleteUploadedFile(track.file);
    }

    if (code !== 0 && state.current === track) {
      console.error('FFmpeg terminé avec le code :', code);
      state.player.stop(true);
    }
  });

  const tap = makeTap(guildId);
  state.tap = tap;

  const resource = createAudioResource(ffmpeg.stdout.pipe(tap), {
    inputType: StreamType.Raw,
    inlineVolume: true
  });

  resource.volume?.setVolume(effectiveVolume(guildId));
  state.resource = resource;

  state.player.play(resource);

  if (!silent) {
    state.textChannel?.send(
      `🎵 Lecture en cours : **${track.name}**`
    ).catch(() => {});
  }
}

// Position actuelle dans le morceau, en secondes (null si rien ne joue).
function trackPosition(state) {
  const track = state?.current;
  if (!track || !state.resource || state.player.state.status === AudioPlayerStatus.Idle) return null;

  const position = (track.offset || 0) + (state.resource.playbackDuration || 0) / 1000;
  return track.duration ? Math.min(position, track.duration) : position;
}

// ======================================
// SORTIES DU SON : Discord et/ou l'appareil qui ouvre le dashboard (les deux peuvent jouer ensemble)
// Couper Discord = volume Discord à 0 (le bot reste connecté, la lecture ne s'interrompt pas).
// L'appareil, lui, reçoit le flux /api/listen dès qu'il l'ouvre, sans toucher à Discord.
// ======================================

const discordMuted = new Set(); // serveurs dont le son Discord est coupé

const effectiveVolume = guildId => (discordMuted.has(String(guildId)) ? 0 : getVolume(guildId) / 100);

function setOutput(guildId, mode) {
  const id = String(guildId);

  if (mode === 'discord-off') {
    discordMuted.add(id);
    hubFor(id).since = Date.now(); // délai de grâce avant le retour automatique sur Discord
  } else if (mode === 'discord-on') {
    discordMuted.delete(id);
  } else {
    throw new Error('Sortie inconnue.');
  }

  queues.get(id)?.resource?.volume?.setVolume(effectiveVolume(id));
}

// Discord coupé et plus aucun appareil n'écoute depuis 15 s (onglet fermé, réseau coupé) : Discord est rétabli.
setInterval(() => {
  for (const id of [...discordMuted]) {
    const hub = hubFor(id);

    if (hub.listeners.size) {
      hub.since = 0;
      continue;
    }

    hub.since ||= Date.now();

    if (Date.now() - hub.since > 15000) {
      hub.since = 0;
      setOutput(id, 'discord-on');
      console.log(`🔊 Aucun appareil n'écoute : le son Discord est rétabli (${id}).`);
    }
  }
}, 5000).unref?.();

// Avance dans le morceau en cours (secondes) : la lecture reprend à cet endroit.
function seekTrack(guildId, seconds) {
  const state = queues.get(guildId);
  const track = state?.current;

  if (!track || state.player.state.status === AudioPlayerStatus.Idle) throw new Error('Aucun morceau en cours de lecture.');
  if (!track.file || !fs.existsSync(track.file)) throw new Error('Le morceau n’est pas encore prêt (téléchargement en cours).');

  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) throw new Error('Position invalide.');

  const target = track.duration ? Math.min(value, Math.max(0, track.duration - 1)) : value;
  const status = state.player.state.status;
  const wasPaused = status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused;

  playTrack(guildId, state, track, target, true);

  // Si c'était en pause, on remet en pause dès que la lecture repart.
  if (wasPaused) {
    const process = track.ffmpeg;
    state.player.once(AudioPlayerStatus.Playing, () => {
      if (state.current === track && track.ffmpeg === process) state.player.pause();
    });
  }
}

// Passe volontairement à un autre morceau (la répétition ne doit pas relancer celui-ci).
function advance(state) {
  state.forceNext = true;
  if (!state.player.stop(true)) state.forceNext = false;
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
      selfDeaf: false // Discord refuse les sons du soundboard à un bot sourd
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
// SOUNDBOARD DU SERVEUR (table de mixage Discord)
// ======================================

const soundCache = new Map(); // guildId -> { at, sounds }

// Permissions nécessaires pour envoyer un son (valeurs officielles de Discord).
const SOUNDBOARD_PERMISSIONS = [
  ['Se connecter', 1n << 20n],
  ['Parler', 1n << 21n],
  ['Utiliser la table de mixage', 1n << 42n]
];

// Liste les sons de la table de mixage du serveur (en cache 60 s).
async function listSounds(guildId, force = false) {
  const id = String(guildId);
  const cached = soundCache.get(id);
  if (!force && cached && Date.now() - cached.at < 60000) return cached.sounds;

  let data;
  try {
    data = await client.rest.get(`/guilds/${id}/soundboard-sounds`);
  } catch (error) {
    throw new Error(`Impossible de lire la table de mixage du serveur (${error.message}).`);
  }

  const sounds = (data?.items || [])
    .filter(sound => sound?.sound_id && sound.available !== false)
    .map(sound => ({
      id: String(sound.sound_id),
      name: String(sound.name || 'Son'),
      emoji: sound.emoji_id ? '' : String(sound.emoji_name || '')
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  soundCache.set(id, { at: Date.now(), sounds });
  return sounds;
}

// Le bot quitte le salon 20 s après un son si rien d'autre n'est en lecture.
function leaveIfIdle(guildId, state) {
  setTimeout(() => {
    if (queues.get(guildId) === state && !state.current && state.items.length === 0) {
      stopGuild(guildId);
    }
  }, 20000).unref?.();
}

// Joue un son de la table de mixage : le bot rejoint le salon si besoin.
// Discord mélange le son avec la musique en cours, les deux s'entendent en même temps.
async function playSound(guild, voiceChannel, soundId) {
  const sound = (await listSounds(guild.id)).find(item => item.id === String(soundId));
  if (!sound) throw new Error('Son introuvable dans la table de mixage de ce serveur.');

  // Permissions réelles du bot dans CE salon (rôles + réglages du salon).
  const mine = voiceChannel?.permissionsFor?.(guild.members?.me)?.bitfield;
  if (typeof mine === 'bigint') {
    const missing = SOUNDBOARD_PERMISSIONS
      .filter(([, bit]) => (mine & bit) !== bit)
      .map(([name]) => name);

    if (missing.length) {
      throw new Error(
        `Il manque au bot dans le salon « ${voiceChannel.name} » : ${missing.join(', ')}. ` +
        'Donne-lui ces permissions (rôle du bot, ou réglages de ce salon).'
      );
    }
  }

  let state = queues.get(guild.id);
  if (!state) {
    state = createMusicState(guild.id, null);
    queues.set(guild.id, state);
  }

  try {
    await ensureVoice(guild, voiceChannel, state);

    try {
      await client.rest.post(`/channels/${voiceChannel.id}/send-soundboard-sound`, {
        body: { sound_id: sound.id }
      });
    } catch (error) {
      // Erreur renvoyée par l'API Discord : on affiche sa vraie raison.
      if (error?.status !== undefined || error?.code !== undefined) {
        console.error('Soundboard refusé par Discord :', error);

        if (error.code === 50167) {
          throw new Error(
            'Discord refuse le son : le bot est muet, sourd ou « supprimé » dans ce salon. ' +
            'Vérifie qu’aucun rôle ne le rend muet ou sourd sur le serveur, et que ce n’est pas un salon de conférence où il n’a pas le droit de parler.'
          );
        }

        throw new Error(
          `Discord a refusé l’envoi du son : ${error.message}${error.code ? ` (code ${error.code})` : ''}.` +
          (error.status === 403 ? ' Vérifie aussi que le bot n’est pas rendu muet ou sourd sur le serveur.' : '')
        );
      }
      throw error;
    }
  } finally {
    if (!state.connection) stopGuild(guild.id);
    else leaveIfIdle(guild.id, state);
  }

  return sound.name;
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

  for (const snap of state.history) dropSnapshot(snap);
  state.history = [];

  dropKeep(state.current);
  cleanupTrack(state.current);
  state.current = null;
  state.player.stop(true);
  state.connection?.destroy();
}

async function webEnqueue(guildId, channelId, add) {
  // Lecteur personnel : pas de salon vocal, le son part uniquement vers le navigateur
  if (isPersonal(guildId)) {
    assertGuild(guildId);
    const id = String(guildId);

    let state = queues.get(id);
    if (!state) {
      state = createMusicState(id, null);
      queues.set(id, state);
    }

    try {
      const message = await add(state);
      startTrack(id);
      return message;
    } finally {
      if (!state.current && state.items.length === 0) stopGuild(id);
    }
  }

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

// Lance tout de suite le morceau placé en tête de file (comme « lire maintenant » dans la file).
function playNow(guildId, state) {
  const current = state.current;

  if (!current) {
    startTrack(guildId);
  } else if (((current.driveId || current.youtubeUrl) && !current.file) || state.player.state.status === AudioPlayerStatus.Idle) {
    // morceau Drive/YouTube encore en téléchargement (ou lecteur au repos) : on l'abandonne
    cleanupTrack(current);
    state.current = null;
    startTrack(guildId);
  } else {
    advance(state);
  }
}

function assertGuild(guildId) {
  if (!client.guilds.cache.has(realId(guildId))) throw new Error('Serveur introuvable.');
}

// Vue d'un lecteur (Discord ou personnel) pour l'interface web.
function playerView(id) {
  const state = queues.get(id);
  const status = state?.player.state.status;

  return {
    channelId: state?.connection?.joinConfig?.channelId || null,
    current: state?.current?.name || null,
    volume: getVolume(id),
    discordMuted: discordMuted.has(id),
    paused: status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused,
    queue: state ? state.items.map(track => track.name) : [],
    station: state?.station || null,
    loop: Boolean(state?.loop),
    loopTrack: Boolean(state?.loopTrack && state.current),
    position: trackPosition(state),
    duration: state?.current?.duration || null,
    seekable: Boolean(state?.current?.file && state.current.duration),
    canPrevious: Boolean(state?.history?.length)
  };
}

const botApi = {
  // --- Activité « regarder ensemble » ---
  videoDir: WATCH_DIR,
  youtubeId: extractYoutubeId,
  youtubeTitle: fetchYoutubeTitle,
  downloadVideo: downloadYoutubeVideo,

  // L'utilisateur est-il bien connecté à ce salon vocal ?
  userInVoice(guildId, channelId, userId) {
    const guild = client.guilds.cache.get(String(guildId));
    return guild?.voiceStates.cache.get(String(userId))?.channelId === String(channelId);
  },

  // YouTube → MP3 : enregistre le lien (youtube.json), télécharge le MP3 puis le lance / l'ajoute à la file
  addYoutube,

  // Dashboard « Play activité » : la vidéo est préparée dans NOTRE Activité (elle démarre toute seule à
  // l'ouverture, sans rien coller), puis on crée une invitation qui ouvre cette Activité dans le salon vocal.
  // Si Discord refuse l'invitation, on poste un bouton « Ouvrir l'Activité » dans le chat du salon.
  async watch(guildId, channelId, rawUrl, activity) {
    assertGuild(guildId);

    const channel = client.guilds.cache.get(String(guildId))?.channels.cache.get(String(channelId));
    if (!channel?.isVoiceBased()) throw new Error('Choisis un salon vocal.');

    const id = extractYoutubeId(rawUrl);
    if (!id) throw new Error('Colle le lien d’une vidéo YouTube (youtube.com/watch?v=… ou youtu.be/…).');

    activity.setVideo(guildId, channel.id, id, 'Dashboard');

    let inviteError = '';

    try {
      const invite = await channel.createInvite({
        targetType: InviteTargetType?.EmbeddedApplication ?? 2,
        targetApplication: client.application.id,
        maxAge: 600,
        maxUses: 0,
        unique: true
      });

      return {
        message: `🎬 Vidéo en préparation pour « ${channel.name} ». Clique sur le lien : l'Activité s'ouvre et la vidéo démarre toute seule.`,
        link: invite.url
      };
    } catch (error) {
      inviteError = `${error.code ? error.code + ' – ' : ''}${error.message}`;
      console.error('Invitation Activité refusée :', error);
    }

    try {
      const title = await fetchYoutubeTitle(id);
      const sent = await channel.send({
        content: `🎬 **${title}** est prête. Clique sur le bouton pour ouvrir l’Activité dans ce salon vocal.`,
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('watch-launch')
              .setLabel('Ouvrir l’Activité')
              .setEmoji('🎬')
              .setStyle(ButtonStyle.Primary)
          )
        ]
      });
      setTimeout(() => sent.delete().catch(() => {}), 15 * 60 * 1000).unref?.();
      return { message: `🎬 « ${title} » en préparation. Clique sur « Ouvrir l’Activité » dans le chat du salon « ${channel.name} » sur Discord. (Invitation refusée : ${inviteError})` };
    } catch (error) {
      console.error('Activité, message impossible :', error.message);
      return { message: `🎬 Vidéo en préparation. Je n'ai pas pu poster le bouton dans « ${channel.name} » (permission « Envoyer des messages » ?) : lance /regarder à la place.` };
    }
  },

  // Spectre audio du morceau en cours : 32 barres (0-255), alignées sur ce que Discord joue.
  spectrum(guildId, delayMs = 0) {
    assertGuild(guildId);

    const state = queues.get(String(guildId));
    const status = state?.player.state.status;

    if (!state?.current || !state.tap || !state.resource || status === AudioPlayerStatus.Idle) {
      return { bands: null };
    }

    const frame = state.tap.analyzer.at(Math.max(0, (state.resource.playbackDuration || 0) - (Number(delayMs) || 0)));
    return { bands: frame ? Array.from(frame) : null };
  },

  // Flux MP3 en direct du morceau en cours, pour l'écouter dans le navigateur.
  listen(guildId, req, res) {
    assertGuild(guildId);

    const hub = hubFor(guildId);
    if (hub.listeners.size >= MAX_LISTENERS) throw new Error('Trop d’auditeurs connectés.');

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);

    if (hub.encoder) for (const chunk of hub.recent) res.write(chunk);

    hub.listeners.add(res);
    startEncoder(hub);

    const done = () => {
      hub.listeners.delete(res);
      if (!hub.listeners.size) stopEncoder(hub);
    };
    req.on('close', done);
    res.on('close', done);
  },

  volume(guildId, level) {
    assertGuild(guildId);
    return `🔊 Volume : ${setVolume(guildId, level)}%`;
  },

  soundList(guildId, force) {
    assertGuild(guildId);
    return listSounds(guildId, force);
  },

  async sound(guildId, channelId, soundId) {
    const guild = client.guilds.cache.get(String(guildId));
    const channel = guild?.channels.cache.get(String(channelId));

    if (!guild || !channel?.isVoiceBased()) throw new Error('Serveur ou salon vocal introuvable.');

    return `🔊 ${await playSound(guild, channel, soundId)} envoyé.`;
  },

  // Salon vocal où le bot joue déjà (pour l'accès visiteur, qui ne choisit pas le salon).
  activeChannel(guildId) {
    return queues.get(String(guildId))?.connection?.joinConfig?.channelId || null;
  },

  getState() {
    return client.guilds.cache.map(guild => ({
      id: guild.id,
      name: guild.name,
      channels: guild.channels.cache
        .filter(channel => channel.isVoiceBased())
        .map(channel => ({ id: channel.id, name: channel.name })),
      ...playerView(guild.id),
      // lecteur personnel (THIVALIN) : jamais envoyé sur Discord, donc « Discord coupé » pour l'interface
      personal: { ...playerView(PERSONAL + guild.id), channelId: null, discordMuted: true },
      stations: guildStations(guild.id).map(s => ({
        name: s.name,
        locked: Boolean(s.password),
        count: s.items.length
      }))
    }));
  },

  play(guildId, channelId, source, value, loop) {
    return webEnqueue(guildId, channelId, async state => {
      if (source === 'url') {
        return enqueueLink(state, String(value || ''));
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
    assertGuild(guildId);
    const station = await createStation(String(guildId), source, name, password);
    return `✅ Playlist ${station.name} créée (${station.info}).`;
  },

  removeStation(guildId, name, password) {
    assertGuild(guildId);
    const station = findStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');

    assertStationPassword(station, password, 'web');
    deleteStation(String(guildId), station.name);
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
    return `✅ ${result.label} ajouté à ${station.name}.${result.info.includes('⚠️') ? ' ' + result.info : ''}`;
  },

  // Lance tout de suite UN morceau d'une playlist (le reste de la file est conservé).
  playStationItem(guildId, channelId, name, index) {
    assertGuild(guildId);
    const id = String(guildId);
    const station = findStation(id, name);
    if (!station) throw new Error('Playlist introuvable.');

    const position = Number(index);
    const item = station.items[position];
    if (!Number.isInteger(position) || !item) throw new Error('Morceau introuvable : la playlist a changé, réessaie.');

    return webEnqueue(id, channelId, async state => {
      const before = new Set(state.items);
      const notes = [];

      await enqueueStationItem(state, item, notes);

      const added = state.items.filter(track => !before.has(track));
      if (!added.length) throw new Error(notes[0] || 'Rien à lire.');

      // les nouveaux morceaux passent en tête de file, dans l'ordre
      for (const track of added) state.items.splice(state.items.indexOf(track), 1);
      state.items.unshift(...added);

      playNow(id, state);
      return [`▶️ ${item.label || added[0].name} : lecture immédiate.`, ...notes.slice(0, 3)].join('\n');
    });
  },
  // La liste d'une playlist est publique : seul le mot de passe protège les modifications.
  stationItems(guildId, name) {
    assertGuild(guildId);
    const station = findStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');
    return station.items.map(item => ({ type: item.type, label: item.label }));
  },
  removeStationItem(guildId, name, index, password) {
    assertGuild(guildId);
    const station = findStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');
    assertStationPassword(station, password, 'web');
    const removed = removeStationItem(String(guildId), station.name, index);
    return `🗑️ ${removed.label} retiré de la playlist.`;
  },
  async saveCurrentToStation(guildId, name, password) {
    assertGuild(guildId);
    const station = findStation(String(guildId), name);
    if (!station) throw new Error('Playlist introuvable.');
    assertStationPassword(station, password, 'web');

    const track = queues.get(String(guildId))?.current;
    if (!track) throw new Error('Aucun morceau en cours de lecture.');

    const { done, notes } = await saveTracksToStations(realId(guildId), [track], [station.name]);
    if (!done) throw new Error(notes.slice(0, 3).join('\n') || 'Rien n’a été ajouté.');
    return [`✅ ${track.name} ajouté à ${station.name}.`, ...notes.slice(0, 3)].join('\n');
  },

  // Enregistre des morceaux de la file dans une ou plusieurs playlists.
  async saveQueueToStations(guildId, items, stationNames, passwords) {
    assertGuild(guildId);

    const state = queues.get(String(guildId));
    if (!state) throw new Error('Aucune lecture sur ce serveur.');
    if (!Array.isArray(items) || !items.length) throw new Error('Sélectionne au moins un morceau.');
    if (!Array.isArray(stationNames) || !stationNames.length) throw new Error('Choisis au moins une playlist.');

    // Mot de passe obligatoire pour chaque playlist choisie (vérifié avant tout ajout)
    for (const stationName of stationNames.slice(0, MAX_STATIONS).map(String)) {
      const station = findStation(String(guildId), stationName);
      if (!station) throw new Error(`Playlist « ${stationName} » introuvable.`);

      const given = passwords && typeof passwords === 'object' ? passwords[stationName] : '';
      try {
        assertStationPassword(station, given, 'web');
      } catch (error) {
        throw new Error(`${station.name} : ${error.message}`);
      }
    }

    const tracks = items.slice(0, MAX_STATION_ITEMS).map(({ index, name }) => {
      const track = state.items[Number(index)];
      if (!track || track.name !== name) throw new Error('La file a changé, réessaie.');
      return track;
    });

    const { done, notes } = await saveTracksToStations(
      realId(guildId),
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

      playNow(id, state);

      return `▶️ ${track.name} : lecture immédiate.`;
    }

    throw new Error('Action inconnue.');
  },

  async control(guildId, action, value) {
    if (action === 'output') {
      assertGuild(guildId);
      return setOutput(guildId, value);
    }

    const state = queues.get(String(guildId));
    if (!state) throw new Error('Aucune lecture sur ce serveur.');

    if (action === 'pause') state.player.pause();
    else if (action === 'resume') state.player.unpause();
    else if (action === 'skip') advance(state);
    else if (action === 'previous') {
      const id = String(guildId);
      const previous = state.history.pop();
      if (!previous) throw new Error('Aucun morceau précédent.');

      // Le morceau en cours est remis en tête de file : « suivant » y revient.
      const current = state.current;
      const snap = current ? snapshotTrack(current) : null;
      if (snap) {
        state.items.unshift(trackFromSnapshot(snap));
        current.keepFile = null; // le fichier conservé passe au morceau remis dans la file
      }
      state.items.unshift(trackFromSnapshot(previous));

      if (!current) {
        startTrack(id);
      } else if (((current.driveId || current.youtubeUrl) && !current.file) || state.player.state.status === AudioPlayerStatus.Idle) {
        cleanupTrack(current);
        state.current = null;
        startTrack(id);
      } else {
        state.goingBack = true;
        advance(state);
      }
    }
    else if (action === 'stop') stopGuild(String(guildId));
    else if (action === 'loop-on') {
      if (!state.station) throw new Error('Lance d’abord une playlist.');
      state.loop = true;
      startTrack(String(guildId));
    }
    else if (action === 'loop-off') state.loop = false;
    else if (action === 'repeat-on') {
      if (!state.current) throw new Error('Aucun morceau en cours de lecture.');
      state.loopTrack = true;
    }
    else if (action === 'repeat-off') state.loopTrack = false;
    else if (action === 'seek') seekTrack(String(guildId), value);
    else throw new Error('Action inconnue.');
  }
};

const web = startWeb(botApi);

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
          content: '❌ Ajoute un MP3, un lien YouTube ou un lien Google Drive (fichier ou dossier).',
          ephemeral: true
        });
      }

      if (suppliedSources > 1) {
        return interaction.reply({
          content: '❌ Choisis une seule source : fichier ou lien (YouTube / Google Drive).',
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

        if (parsedUrl.hostname !== 'drive.google.com' && !extractYoutubeId(rawUrl)) {
          return interaction.reply({
            content: '❌ Pour la lecture par URL, utilise un lien YouTube ou un lien Google Drive public vers un MP3 ou un dossier.',
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
          if (extractYoutubeId(rawUrl)) {
            const message = await enqueueYoutube(state, rawUrl);
            await interaction.editReply(message);
            startTrack(guildId);
            return;
          }

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

    // VOLUME
    else if (command === 'volume') {
      const level = interaction.options.getInteger('niveau');

      if (level === null) {
        return interaction.reply({
          content: `🔊 Volume actuel : **${getVolume(guildId)}%**`,
          ephemeral: true
        });
      }

      return interaction.reply(`🔊 Volume réglé à **${setVolume(guildId, level)}%**.`);
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

      advance(state);

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

const STATIONS_FILE = path.join(DATA_DIR, 'stations.json');
const PLAYLIST_DIR = path.join(MUSIC_DIR, 'playlists');
const MAX_STATIONS = 25;
const MAX_STATION_ITEMS = 500;
const ITEM_ICONS = { drive: '☁️', file: '🎵', youtube: '▶️' };

fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

// ======================================
// MOT DE PASSE DES PLAYLISTS (facultatif, un par playlist, créé avec elle)
// ======================================

const passwordFails = new Map();

const hashPassword = (password, salt) => crypto.scryptSync(String(password), salt, 64);

// Transforme un mot de passe en empreinte (jamais stocké en clair).
// Mot de passe vide = playlist sans mot de passe (retourne null).
function makePasswordRecord(password) {
  const value = String(password ?? '');

  if (!value.trim()) return null;

  if (value.length < 4 || value.length > 100) {
    throw new Error('Le mot de passe de la playlist doit faire entre 4 et 100 caractères.');
  }

  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: hashPassword(value, salt).toString('hex') };
}

// Vérifie le mot de passe d'une playlist (une playlist sans mot de passe n'en demande pas).
function assertStationPassword(station, given, key) {
  const record = station?.password;
  if (!record) return;

  const entry = passwordFails.get(key);
  const active = Boolean(entry && entry.reset > Date.now());

  if (active && entry.count >= 5) {
    throw new Error('Trop d’essais, réessaie dans quelques minutes.');
  }

  const expected = Buffer.from(record.hash, 'hex');
  const actual = hashPassword(given ?? '', Buffer.from(record.salt, 'hex'));

  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
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
  try {
    if (fs.existsSync(STATIONS_FILE)) fs.copyFileSync(STATIONS_FILE, `${STATIONS_FILE}.bak`);
  } catch {}
  fs.renameSync(tmp, STATIONS_FILE);
  scheduleBackup();
}

const guildStations = guildId => loadStations()[realId(guildId)] || [];
const findStation = (guildId, name) => guildStations(guildId).find(s => sameName(s.name, name));

async function deleteStoredFile(name) {
  const base = path.basename(String(name));
  await fsp.unlink(path.join(PLAYLIST_DIR, base)).catch(() => {});
  deleteFileBackup(base);
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
    throw new Error('Colle un lien YouTube ou Google Drive valide.');
  }

  const host = url.hostname.replace(/^www\./, '');

  const youtubeId = extractYoutubeId(url.href);
  if (youtubeId) {
    return {
      type: 'youtube',
      value: youtubeUrlFor(youtubeId),
      label: await fetchYoutubeTitle(youtubeId),
      info: 'une vidéo YouTube'
    };
  }

  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) {
    throw new Error('Colle le lien d’une vidéo YouTube (pas celui d’une playlist ou d’une chaîne).');
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

  throw new Error('Lien non pris en charge : utilise un lien YouTube ou Google Drive (fichier ou dossier).');
}

// Crée une playlist ; sans lien, elle est créée vide (un nom est alors obligatoire).
async function createStation(guildId, source, customName, rawPassword) {
  const link = String(source || '').trim();
  const wanted = cleanName(customName);
  const password = makePasswordRecord(rawPassword);

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
  all[guildId] = [...list, { name, items: built ? [item] : [], password }];
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
  let saved = true;

  try {
    if (!findStation(guildId, name)) throw new Error('Playlist introuvable.');

    await fsp.rename(tmpPath, path.join(PLAYLIST_DIR, stored));

    try {
      addStationItem(guildId, name, { type: 'file', value: stored, label });
    } catch (error) {
      await deleteStoredFile(stored);
      throw error;
    }

    saved = await backupStoredFile(stored);
  } catch (error) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw error;
  }

  return {
    label,
    info: saved ? 'fichier MP3' : 'fichier MP3, ⚠️ non sauvegardé sur Discord (fichier trop gros ?)'
  };
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

function passwordModal(customId, title, stationName) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel(`Mot de passe de « ${stationName.slice(0, 30)} »`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      )
    );
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
        if (track.youtubeUrl) {
          addStationItem(guildId, station.name, { type: 'youtube', value: track.youtubeUrl, label });
        } else if (track.driveId) {
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

          if (!(await backupStoredFile(stored))) {
            notes.push(`⚠️ ${label} : non sauvegardé sur Discord (fichier trop gros ?)`);
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

// Ajoute UN élément de playlist (Drive, YouTube ou fichier) à la file ; les problèmes vont dans `notes`.
async function enqueueStationItem(state, item, notes) {
  const label = item.label || item.type;

  try {
    if (item.type === 'drive') {
      await enqueueDrive(state, item.value);
    } else if (item.type === 'youtube') {
      const id = extractYoutubeId(item.value);
      if (!id) throw new Error('lien YouTube invalide.');
      state.items.push({ name: label, youtubeUrl: youtubeUrlFor(id), file: null, ffmpeg: null, deleteOnFinish: true, deleteScheduled: false });
    } else if (item.type === 'file') {
      const file = path.join(PLAYLIST_DIR, path.basename(String(item.value)));
      if (!fs.existsSync(file)) await restoreStoredFile(item.value);
      if (!fs.existsSync(file)) throw new Error('fichier introuvable sur le serveur.');
      state.items.push({ name: label, file, ffmpeg: null, deleteOnFinish: false });
    } else {
      notes.push(`⚠️ ${label} : ce type d’élément n’est plus pris en charge, retire-le de la playlist.`);
    }
  } catch (error) {
    notes.push(`⚠️ ${label} : ${error.message}`);
  }
}

async function enqueueStation(state, station) {
  if (!station.items.length) {
    throw new Error('Cette playlist est vide. Ajoute-lui des éléments.');
  }

  const before = new Set(state.items);
  const notes = [];

  for (const item of station.items) {
    await enqueueStationItem(state, item, notes);
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

      const password = interaction.fields.getTextInputValue('password');
      if (password !== interaction.fields.getTextInputValue('password2')) {
        throw new Error('Les deux mots de passe ne correspondent pas.');
      }

      const { name, info } = await createStation(
        interaction.guildId,
        interaction.fields.getTextInputValue('source'),
        interaction.fields.getTextInputValue('name'),
        password
      );

      return interaction.editReply(
        `✅ Playlist **${name}** créée (${info}).\nAjoute-lui d’autres éléments avec \`/station ajouter\`, lance-la avec \`/station jouer\`.`
      );
    }

    // Validation du formulaire de suppression
    if (interaction.isModalSubmit() && interaction.customId.startsWith('station-delete:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const station = findStation(interaction.guildId, interaction.customId.slice('station-delete:'.length));
      if (!station) throw new Error('Playlist introuvable.');

      assertStationPassword(station, interaction.fields.getTextInputValue('password'), interaction.user.id);
      deleteStation(interaction.guildId, station.name);

      return interaction.editReply(`🗑️ Playlist **${station.name}** supprimée.`);
    }

    // Validation du formulaire « retirer un morceau »
    if (interaction.isModalSubmit() && interaction.customId.startsWith('station-remove:')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const rest = interaction.customId.slice('station-remove:'.length);
      const cut = rest.indexOf(':');
      const station = findStation(interaction.guildId, rest.slice(cut + 1));
      if (!station) throw new Error('Playlist introuvable.');

      assertStationPassword(station, interaction.fields.getTextInputValue('password'), interaction.user.id);

      const removed = removeStationItem(interaction.guildId, station.name, Number(rest.slice(0, cut)));
      return interaction.editReply(`🗑️ **${removed.label}** retiré de **${station.name}**.`);
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
        .setTitle('Créer une nouvelle playlist')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('source')
              .setLabel('Lien YouTube ou Google Drive (facultatif)')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Lien YouTube ou Google Drive (fichier ou dossier)')
              .setRequired(false)
              .setMaxLength(500)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('name')
              .setLabel('Nom de la playlist (obligatoire sans lien)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Nom de la playlist')
              .setRequired(false)
              .setMaxLength(50)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('password')
              .setLabel('Mot de passe (facultatif)')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('Laisse vide pour une playlist sans mot de passe (4 caractères min.)')
              .setRequired(false)
              .setMaxLength(100)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('password2')
              .setLabel('Confirmer le mot de passe')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
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
        throw new Error('Playlist introuvable. Crée-la d’abord avec /station creer.');
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

      const position = interaction.options.getInteger('numero') - 1;

      if (station.password) {
        return interaction.showModal(
          passwordModal(`station-remove:${position}:${station.name}`, 'Retirer un morceau', station.name)
        );
      }

      const removed = removeStationItem(guildId, station.name, position);
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

      // Playlist sans mot de passe : suppression directe.
      if (!station.password) {
        deleteStation(guildId, station.name);
        return interaction.reply({
          content: `🗑️ Playlist **${station.name}** supprimée.`,
          flags: MessageFlags.Ephemeral
        });
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

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() || interaction.customId !== 'watch-launch') return;

  console.log('Bouton « Ouvrir l’Activité » cliqué par', interaction.user.tag);

  try {
    // Doit être la toute première réponse à l'interaction.
    await interaction.launchActivity();
  } catch (error) {
    console.error('Erreur bouton Activité :', error);
    await interaction.reply({
      content: `❌ Discord a refusé d'ouvrir l'Activité depuis ce bouton (${error.message}). Lance plutôt la commande /regarder.`,
      flags: MessageFlags.Ephemeral
    }).catch(replyError => console.error('Réponse impossible :', replyError.message));
  }
});

// ======================================
// COMMANDE /regarder : ouvre l'Activité « regarder ensemble » dans le salon vocal
// ======================================

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'regarder') return;

  try {
    const voiceChannel = interaction.member?.voice?.channel;

    if (!interaction.guildId || !voiceChannel) {
      return await interaction.reply({
        content: '❌ Rejoins un salon vocal avant de lancer l’Activité.',
        flags: MessageFlags.Ephemeral
      });
    }

    const rawUrl = interaction.options.getString('url');

    if (rawUrl) {
      const id = extractYoutubeId(rawUrl);

      if (!id) {
        return await interaction.reply({
          content: '❌ Colle le lien d’une vidéo YouTube (youtube.com/watch?v=… ou youtu.be/…).',
          flags: MessageFlags.Ephemeral
        });
      }

      // Le téléchargement démarre tout de suite, pendant que l'Activité s'ouvre.
      web.activity.setVideo(interaction.guildId, voiceChannel.id, id, interaction.user.username);
    }

    // Doit être la toute première réponse à la commande (pas de deferReply avant).
    await interaction.launchActivity();
  } catch (error) {
    console.error('Erreur /regarder :', error);

    const message = `❌ ${error.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// ======================================
// COMMANDE /soundboard
// ======================================

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.commandName !== 'soundboard') return;

    // Autocomplétion : sons du serveur
    if (interaction.isAutocomplete()) {
      const typed = interaction.options.getFocused().toLowerCase();
      const sounds = await listSounds(interaction.guildId).catch(() => []);

      return interaction.respond(
        sounds
          .filter(sound => sound.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map(sound => ({ name: `${sound.emoji} ${sound.name}`.trim().slice(0, 100), value: sound.id }))
      );
    }

    if (!interaction.isChatInputCommand()) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const name = await playSound(
      interaction.guild,
      interaction.member?.voice?.channel,
      interaction.options.getString('son')
    );

    return interaction.editReply(`🔊 **${name}** envoyé dans le salon vocal.`);
  } catch (error) {
    console.error('Erreur soundboard :', error);

    const message = `❌ ${error.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else if (interaction.isRepliable?.()) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});


// ======================================
// SAUVEGARDE DES PLAYLISTS DANS UN SALON DISCORD PRIVÉ
// (utile sans disque persistant : le fichier est restauré au démarrage)
// Définis BACKUP_CHANNEL_ID dans .env (salon privé où le bot peut écrire).
// ======================================

const BACKUP_CHANNEL_ID = (process.env.BACKUP_CHANNEL_ID || '').trim();
const BACKUP_NAME = 'stations.json';
let backupTimer = null;

async function backupChannel() {
  if (!BACKUP_CHANNEL_ID) return null;
  const channel = await client.channels.fetch(BACKUP_CHANNEL_ID).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

function scheduleBackup() {
  if (!BACKUP_CHANNEL_ID) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      const channel = await backupChannel();
      if (!channel || !fs.existsSync(STATIONS_FILE)) return;

      const sent = await channel.send({
        content: `💾 Sauvegarde des playlists (${new Date().toISOString()})`,
        files: [{ attachment: Buffer.from(fs.readFileSync(STATIONS_FILE)), name: BACKUP_NAME }]
      });

      for (const message of await botMessages(channel, 10)) {
        if (message.id !== sent.id && message.attachments.some(a => a.name === BACKUP_NAME)) {
          message.delete().catch(() => {});
        }
      }
    } catch (error) {
      console.error('Sauvegarde des playlists impossible :', error.message);
    }
  }, 5000);
}

// Au démarrage : si stations.json est absent, on le récupère dans le salon de sauvegarde.
async function restoreBackup() {
  try {
    if (!BACKUP_CHANNEL_ID || fs.existsSync(STATIONS_FILE)) return;

    const channel = await backupChannel();
    if (!channel) return console.warn('BACKUP_CHANNEL_ID : salon introuvable ou inaccessible.');

    const message = (await botMessages(channel, 30))
      .filter(m => m.attachments.some(a => a.name === BACKUP_NAME))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!message) return console.log('Aucune sauvegarde de playlists trouvée dans le salon.');

    const attachment = message.attachments.find(a => a.name === BACKUP_NAME);
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`téléchargement ${response.status}`);

    const text = await response.text();
    JSON.parse(text); // vérifie que le fichier est valide
    fs.writeFileSync(STATIONS_FILE, text);
    console.log('✅ Playlists restaurées depuis le salon de sauvegarde.');
  } catch (error) {
    console.error('Restauration des playlists impossible :', error.message);
  }
}

// ======================================
// SAUVEGARDE DES MP3 ENVOYÉS DANS LE MÊME SALON
// Chaque MP3 ajouté à une playlist est posté dans le salon de sauvegarde
// (limite d'envoi de Discord : ~10 Mo par fichier sans boost du serveur).
// Au démarrage, les MP3 manquants sont téléchargés de nouveau.
// ======================================

const FILE_TAG = '🎵 MP3 ';
const fileBackups = new Map(); // nom stocké -> { id, url }
let pendingScan = null;

// Messages du bot dans le salon, du plus récent au plus ancien.
async function botMessages(channel, maxPages = 30) {
  const found = [];
  let before;

  for (let i = 0; i < maxPages; i++) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;

    for (const message of page.values()) {
      if (message.author.id === client.user.id) found.push(message);
    }

    before = page.last().id;
    if (page.size < 100) break;
  }

  return found;
}

function scanFileBackups(channel) {
  if (!pendingScan) {
    pendingScan = (async () => {
      for (const message of await botMessages(channel, 60)) {
        if (!message.content.startsWith(FILE_TAG)) continue;
        const stored = message.content.slice(FILE_TAG.length).trim();
        const attachment = message.attachments.first();
        if (stored && attachment) fileBackups.set(stored, { id: message.id, url: attachment.url });
      }
    })().finally(() => {
      pendingScan = null;
    });
  }

  return pendingScan;
}

async function backupStoredFile(stored) {
  if (!BACKUP_CHANNEL_ID) return true;

  try {
    const channel = await backupChannel();
    if (!channel) return false;

    const sent = await channel.send({
      content: FILE_TAG + stored,
      files: [{ attachment: path.join(PLAYLIST_DIR, stored), name: stored }]
    });

    fileBackups.set(stored, { id: sent.id, url: sent.attachments.first()?.url });
    return true;
  } catch (error) {
    console.error(`Sauvegarde du MP3 impossible (${stored}) :`, error.message);
    return false;
  }
}

async function restoreStoredFile(name) {
  const stored = path.basename(String(name));
  const target = path.join(PLAYLIST_DIR, stored);

  if (fs.existsSync(target)) return true;
  if (!BACKUP_CHANNEL_ID) return false;

  try {
    const channel = await backupChannel();
    if (!channel) return false;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 1re tentative : adresse connue ; 2e : on relit le salon (les adresses Discord expirent)
      if (attempt === 1 || !fileBackups.has(stored)) {
        fileBackups.delete(stored);
        await scanFileBackups(channel);
      }

      const entry = fileBackups.get(stored);
      if (!entry?.url) return false;

      const response = await fetch(entry.url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) continue;

      const tmp = `${target}.tmp`;
      await fsp.writeFile(tmp, Buffer.from(await response.arrayBuffer()));
      await fsp.rename(tmp, target);
      return true;
    }
  } catch (error) {
    console.error(`Restauration du MP3 impossible (${stored}) :`, error.message);
  }

  return false;
}

async function restoreMissingFiles() {
  if (!BACKUP_CHANNEL_ID) return;

  const missing = new Set();
  for (const list of Object.values(loadStations())) {
    for (const station of list) {
      for (const item of station.items) {
        if (item.type === 'file' && !fs.existsSync(path.join(PLAYLIST_DIR, path.basename(String(item.value))))) {
          missing.add(String(item.value));
        }
      }
    }
  }

  for (const item of loadYoutubeList()) {
    if (item.file && !fs.existsSync(path.join(PLAYLIST_DIR, path.basename(String(item.file))))) {
      missing.add(String(item.file));
    }
  }

  if (!missing.size) return;

  let restored = 0;
  for (const name of missing) {
    if (await restoreStoredFile(name)) restored++;
  }
  console.log(`✅ MP3 restaurés depuis le salon de sauvegarde : ${restored}/${missing.size}`);
}

async function deleteFileBackup(stored) {
  if (!BACKUP_CHANNEL_ID) return;

  try {
    const channel = await backupChannel();
    if (!channel) return;

    if (!fileBackups.has(stored)) await scanFileBackups(channel);

    const entry = fileBackups.get(stored);
    if (entry) {
      fileBackups.delete(stored);
      await channel.messages.delete(entry.id).catch(() => {});
    }
  } catch {}
}

// ======================================
// YOUTUBE → MP3 : liens ajoutés depuis le dashboard
// - youtube.json (liste des liens) est sauvegardé dans le salon de sauvegarde, comme stations.json
// - chaque vidéo est convertie en MP3 (yt-dlp + ffmpeg, 192 kbit/s, comme le script Python d'origine)
//   puis le MP3 est posté dans ce même salon (limite d'envoi de Discord : ~10 Mo sans boost du serveur)
// ======================================

const YOUTUBE_FILE = path.join(DATA_DIR, 'youtube.json');
const YOUTUBE_BACKUP_NAME = 'youtube.json';
const MAX_YOUTUBE_ITEMS = 500;
let youtubeBackupTimer = null;
let youtubeChain = Promise.resolve();   // un seul téléchargement à la fois
const youtubeJobs = new Map();          // identifiant -> téléchargement en cours / en attente

const youtubeStoredName = id => `yt-${id}.mp3`;

// Accepte aussi les entrées ajoutées à la main : un simple lien (texte) ou { url } sans identifiant.
function normalizeYoutubeEntry(entry) {
  const item = typeof entry === 'string' ? { url: entry } : { ...entry };

  if (!item.id) item.id = extractYoutubeId(String(item.url || '')) || undefined;

  if (item.id) {
    item.url = item.url || youtubeUrlFor(item.id);
    item.title = item.title || '';
    item.file = item.file || null;
    item.status = item.status || 'pending';
    item.error = item.error || '';
  }

  return item;
}

function loadYoutubeList() {
  try {
    const raw = JSON.parse(fs.readFileSync(YOUTUBE_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.items;
    return Array.isArray(list) ? list.map(normalizeYoutubeEntry) : [];
  } catch {
    return [];
  }
}

function saveYoutubeList(items) {
  const tmp = `${YOUTUBE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2));
  fs.renameSync(tmp, YOUTUBE_FILE);
  scheduleYoutubeBackup();
}

function patchYoutubeItem(id, changes) {
  const items = loadYoutubeList();
  const item = items.find(entry => entry.id === id);
  if (!item) return;
  Object.assign(item, changes);
  saveYoutubeList(items);
}

function scheduleYoutubeBackup() {
  if (!BACKUP_CHANNEL_ID) return;
  clearTimeout(youtubeBackupTimer);
  youtubeBackupTimer = setTimeout(async () => {
    try {
      const channel = await backupChannel();
      if (!channel || !fs.existsSync(YOUTUBE_FILE)) return;

      const sent = await channel.send({
        content: `💾 Sauvegarde des liens YouTube (${new Date().toISOString()})`,
        files: [{ attachment: Buffer.from(fs.readFileSync(YOUTUBE_FILE)), name: YOUTUBE_BACKUP_NAME }]
      });

      for (const message of await botMessages(channel, 10)) {
        if (message.id !== sent.id && message.attachments.some(a => a.name === YOUTUBE_BACKUP_NAME)) {
          message.delete().catch(() => {});
        }
      }
    } catch (error) {
      console.error('Sauvegarde de youtube.json impossible :', error.message);
    }
  }, 5000);
}

// Au démarrage : si youtube.json est absent, on le récupère dans le salon de sauvegarde.
async function restoreYoutubeBackup() {
  try {
    if (!BACKUP_CHANNEL_ID || fs.existsSync(YOUTUBE_FILE)) return;

    const channel = await backupChannel();
    if (!channel) return;

    const message = (await botMessages(channel, 30))
      .filter(m => m.attachments.some(a => a.name === YOUTUBE_BACKUP_NAME))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!message) return;

    const attachment = message.attachments.find(a => a.name === YOUTUBE_BACKUP_NAME);
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`téléchargement ${response.status}`);

    const text = await response.text();
    JSON.parse(text); // vérifie que le fichier est valide
    fs.writeFileSync(YOUTUBE_FILE, text);
    console.log('✅ youtube.json restauré depuis le salon de sauvegarde.');
  } catch (error) {
    console.error('Restauration de youtube.json impossible :', error.message);
  }
}

// Télécharge l'audio d'une vidéo YouTube en MP3 (192 kbit/s) dans PLAYLIST_DIR ; retourne le nom du fichier.
async function downloadYoutubeMp3(id) {
  const stored = youtubeStoredName(id);
  const target = path.join(PLAYLIST_DIR, stored);

  if (fs.existsSync(target)) return stored;

  await ensureYtDlp();

  const args = [
    '--no-playlist', '--no-warnings', '--no-progress',
    '-f', 'bestaudio/best',
    '-x', '--audio-format', 'mp3', '--audio-quality', '192K',
    '--match-filter', `!is_live & duration<=${YTDLP_MAX_SECONDS}`,
    '--max-filesize', '150M',
    '--js-runtimes', 'node',
    '-o', path.join(PLAYLIST_DIR, `yt-${id}.%(ext)s`)
  ];

  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);

  if (process.env.YOUTUBE_COOKIES) {
    fs.writeFileSync(YTDLP_COOKIES, process.env.YOUTUBE_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
    args.push('--cookies', YTDLP_COOKIES);
  }

  args.push(youtubeUrlFor(id));

  const { code, output } = await runYtDlp(args, YTDLP_TIMEOUT_MS);

  // fichiers intermédiaires laissés par yt-dlp (le .webm d'origine, etc.)
  const leftovers = (await fsp.readdir(PLAYLIST_DIR)).filter(name => name.startsWith(`yt-${id}.`) && name !== stored);
  for (const name of leftovers) await fsp.unlink(path.join(PLAYLIST_DIR, name)).catch(() => {});

  if (code === 'timeout') {
    await fsp.unlink(target).catch(() => {});
    throw new Error('Le téléchargement YouTube a expiré (plus de 5 minutes).');
  }

  if (code !== 0) {
    await fsp.unlink(target).catch(() => {});
    throw new Error(youtubeErrorMessage(output));
  }

  if (!fs.existsSync(target)) {
    throw new Error(`vidéo ignorée (en direct, plus de ${YTDLP_MAX_SECONDS / 3600} h ou trop volumineuse).`);
  }

  return stored;
}

// Ajoute le MP3 stocké dans la file du serveur : lecture immédiate si rien ne joue, sinon en file d'attente.
async function enqueueStoredMp3(guildId, channelId, stored, title) {
  const file = path.join(PLAYLIST_DIR, path.basename(stored));

  return webEnqueue(guildId, channelId, async state => {
    state.items.push({ name: title, file, ffmpeg: null, deleteOnFinish: false });
    return `🎶 ${title} (MP3 YouTube) ${state.current ? 'ajouté à la file.' : 'lancé.'}`;
  });
}

// Télécharge (ou récupère) le MP3 de la vidéo, le stocke dans le salon de sauvegarde et met à jour youtube.json.
async function prepareYoutubeMp3(id) {
  const known = loadYoutubeList().find(entry => entry.id === id);

  // déjà téléchargé : on le réutilise (restauré depuis le salon de sauvegarde si besoin)
  if (known?.status === 'ok' && known.file && await restoreStoredFile(known.file)) {
    return { stored: known.file, title: known.title || 'Vidéo YouTube' };
  }

  // MP3 déjà déposé dans le salon de sauvegarde (ex. par l'outil Python youtube_sync.py)
  const dropped = youtubeStoredName(id);
  if (!fs.existsSync(path.join(PLAYLIST_DIR, dropped)) && await restoreStoredFile(dropped)) {
    const droppedTitle = known?.title || await fetchYoutubeTitle(id).catch(() => 'Vidéo YouTube');
    patchYoutubeItem(id, { title: droppedTitle, file: dropped, status: 'ok', error: '' });
    console.log(`✅ YouTube → MP3 (repris du salon) : ${droppedTitle}`);
    return { stored: dropped, title: droppedTitle };
  }

  // YOUTUBE_SERVER_DOWNLOAD=0 : le serveur ne télécharge pas lui-même, il attend l'outil Python
  if (process.env.YOUTUBE_SERVER_DOWNLOAD === '0') {
    throw new Error('MP3 en attente de l’outil Python (youtube_sync.py).');
  }

  patchYoutubeItem(id, { status: 'downloading', error: '' });

  const title = await fetchYoutubeTitle(id);
  patchYoutubeItem(id, { title });

  const stored = await downloadYoutubeMp3(id);
  const sent = await backupStoredFile(stored); // poste le MP3 dans le salon de sauvegarde

  patchYoutubeItem(id, {
    file: stored,
    status: 'ok',
    error: sent ? '' : 'MP3 gardé sur le serveur mais non envoyé dans le salon de sauvegarde (fichier trop lourd ou permission manquante).'
  });

  console.log(`✅ YouTube → MP3 : ${title}`);
  return { stored, title };
}

// Un seul téléchargement à la fois ; plusieurs demandes pour la même vidéo partagent le même téléchargement.
// `target` ({ guildId, channelId }) : si fourni, le MP3 est lancé / ajouté à la file une fois prêt.
function runYoutubeJob(id, target = null) {
  let job = youtubeJobs.get(id);

  if (!job) {
    job = {
      targets: [],
      promise: youtubeChain.then(async () => {
        try {
          return { ...(await prepareYoutubeMp3(id)), error: null };
        } catch (error) {
          console.error(`YouTube → MP3 impossible (${id}) :`, error.message);
          patchYoutubeItem(id, { status: 'error', error: error.message });
          return { error };
        }
      })
    };

    youtubeJobs.set(id, job);
    youtubeChain = job.promise.finally(() => youtubeJobs.delete(id)).catch(() => {});
  }

  if (!target) return job.promise;

  job.targets.push(target);

  // chaque demande reçoit son propre résultat (lecture / file d'attente)
  return job.promise.then(async result => {
    if (!job.targets.includes(target)) return null;
    job.targets.splice(job.targets.indexOf(target), 1);

    if (!result.error) {
      return enqueueStoredMp3(target.guildId, target.channelId, result.stored, result.title);
    }

    // MP3 impossible : on lit la vidéo en streaming plutôt que de ne rien jouer
    const message = await webEnqueue(target.guildId, target.channelId, state => enqueueYoutube(state, youtubeUrlFor(id)));
    return `${message}\n⚠️ MP3 non téléchargé (${result.error.message}), lecture en streaming.`;
  });
}

// Dashboard : enregistre le lien dans youtube.json, télécharge le MP3 puis le lance ou l'ajoute à la file.
// Retourne le message à afficher une fois le MP3 prêt.
function addYoutube(guildId, channelId, rawUrl) {
  const id = extractYoutubeId(rawUrl);
  if (!id) throw new Error('Colle le lien d’une vidéo YouTube (youtube.com/watch?v=… ou youtu.be/…).');

  const items = loadYoutubeList();

  if (!items.some(entry => entry.id === id)) {
    items.push({
      id,
      url: youtubeUrlFor(id),
      title: '',
      file: null,
      status: 'pending',
      error: '',
      addedAt: new Date().toISOString()
    });
    saveYoutubeList(items.slice(-MAX_YOUTUBE_ITEMS));
  }

  return runYoutubeJob(id, { guildId, channelId });
}

// Télécharge automatiquement tous les liens de youtube.json dont le MP3 n'est pas sur le serveur
// (nouveaux liens, téléchargements interrompus, MP3 disparus). Les téléchargements se font un par un.
// Au démarrage (retryErrors) on réessaie aussi les liens en erreur ; ensuite, seulement les nouveaux.
async function syncYoutube({ retryErrors = false } = {}) {
  let queued = 0;

  const pending = loadYoutubeList().filter(item => {
    const stored = item.file && path.join(PLAYLIST_DIR, path.basename(String(item.file)));
    return item.id && !(item.status === 'ok' && stored && fs.existsSync(stored));
  });
  if (!pending.length) return;

  // MP3 déposés dans le salon par l'outil Python : on relit le salon (seulement s'il reste des liens à traiter)
  let dropped = new Set();
  try {
    const channel = BACKUP_CHANNEL_ID ? await backupChannel() : null;
    if (channel) {
      await scanFileBackups(channel);
      dropped = new Set(fileBackups.keys());
    }
  } catch (error) {
    console.error('Lecture des MP3 du salon impossible :', error.message);
  }

  for (const item of pending) {
    if (item.status === 'error' && !retryErrors && !dropped.has(youtubeStoredName(item.id))) continue;
    if (youtubeJobs.has(item.id)) continue;

    runYoutubeJob(item.id).catch(() => {});
    queued++;
  }

  if (queued) console.log(`⬇️ youtube.json : ${queued} lien(s) à télécharger.`);
}

// ======================================
// OUTIL PYTHON (youtube_sync.py) lancé par le bot : active-le avec YOUTUBE_PYTHON_SYNC=1
// Il lit youtube.json dans le salon, télécharge les MP3 manquants et les renvoie dans le salon.
// Dépendances Python installées au build dans ./pylibs : pip install --target pylibs yt-dlp requests
// ======================================

let pythonSyncStarted = false;

function startPythonSync() {
  if (process.env.YOUTUBE_PYTHON_SYNC !== '1' || pythonSyncStarted) return;

  // youtube_sync.py à côté de index.js ou à la racine du dépôt
  const script = [__dirname, path.join(__dirname, '..'), process.cwd()]
    .map(folder => path.join(folder, 'youtube_sync.py'))
    .find(file => fs.existsSync(file));
  if (!script) return console.warn('YOUTUBE_PYTHON_SYNC=1 mais youtube_sync.py est introuvable.');

  pythonSyncStarted = true;
  const minutes = Math.max(1, Number(process.env.YOUTUBE_PYTHON_MINUTES) || 10);
  const outDir = path.join(DATA_DIR, 'youtube-python');
  // pylibs : dossier créé au build (à la racine du dépôt ou à côté de index.js)
  const pylibs = [path.join(__dirname, 'pylibs'), path.join(__dirname, '..', 'pylibs'), path.join(process.cwd(), 'pylibs')];

  const launch = python => {
    const child = spawn(python, [script, '--watch', String(minutes), '--out', outDir, '--delete-after'], {
      env: {
        ...process.env,
        PYTHONPATH: [...pylibs, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONUNBUFFERED: '1',
        FFMPEG_LOCATION: process.env.FFMPEG_LOCATION || ffmpegPath || ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const relay = chunk => String(chunk).split('\n').filter(line => line.trim()).forEach(line => console.log(`[python] ${line}`));
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    child.on('error', error => {
      if (error.code === 'ENOENT' && python === 'python3') return launch('python');
      console.error('Outil Python impossible à lancer :', error.message);
    });

    child.on('exit', code => {
      console.error(`Outil Python arrêté (code ${code}), relance dans 60 s.`);
      setTimeout(() => launch(python), 60000).unref?.();
    });
  };

  launch('python3');
}

// ======================================
// STATUT DU BOT : affiche la musique en cours sous son nom
// ======================================

let lastPresence = null;

function updatePresence() {
  if (!client.isReady()) return;

  let name = null;
  for (const [id, state] of queues) {
    if (isPersonal(id)) continue;

    if (state.current?.name) {
      name = String(state.current.name).slice(0, 120);
      break;
    }
  }

  if (name === lastPresence) return;
  lastPresence = name;

  client.user.setPresence({
    activities: name ? [{ name, type: ActivityType.Listening }] : [],
    status: 'online'
  });
}


// ======================================
// DÉMARRAGE
// ======================================

client.once(Events.ClientReady, async readyClient => {
  setInterval(updatePresence, 5000);
  await restoreBackup();
  await restoreYoutubeBackup();
  await restoreMissingFiles();
  syncYoutube({ retryErrors: true }).catch(() => {});
  setInterval(() => syncYoutube().catch(() => {}), 10 * 60 * 1000).unref?.();
  startPythonSync();
  console.log('================================');
  console.log(`🎵 MCT MUSIC connecté : ${readyClient.user.tag}`);
  console.log('✅ Lecture des MP3 joints aux commandes /play activée');
  console.log('✅ Lecture des MP3 et dossiers publics Google Drive activée');
  console.log('✅ Playlists (/station) : YouTube, Google Drive et MP3');
  console.log('✅ Liens YouTube (yt-dlp téléchargé automatiquement)');
  console.log('✅ YouTube → MP3 (youtube.json + salon de sauvegarde)');
  console.log('✅ Soundboard du serveur (/soundboard)');
  console.log('✅ Activité « regarder ensemble » (/regarder)');
  console.log('================================');
});

client.login(process.env.DISCORD_TOKEN);
