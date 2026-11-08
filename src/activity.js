'use strict';

// ======================================
// ACTIVITÉ DISCORD « REGARDER ENSEMBLE »
// - sert la page de l'Activité (dossier ./activity) quand Discord l'ouvre
// - échange le code OAuth2 contre un token (POST /activity/token)
// - synchronise lecture / pause / position entre les participants (WebSocket /activity/ws)
// - sert les vidéos téléchargées par le bot, avec support des Range (GET /activity/media/<id>.mp4)
// ======================================

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream');
const { WebSocketServer } = require('ws');

const DISCORD_API = 'https://discord.com/api/v10';
const ROOM_IDLE_MS = 30 * 60 * 1000;     // un salon sans personne est oublié après 30 min
const TICK_MS = 10 * 1000;               // resynchronisation douce des participants
const PING_MS = 25 * 1000;               // garde la connexion ouverte derrière le proxy
const MAX_FILES = 8;                     // vidéos gardées sur le disque
const FILE_TTL_MS = 2 * 3600 * 1000;     // ... et pas plus de 2 h
const MAX_POSITION = 24 * 3600;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SNOWFLAKE = /^\d{5,25}$/;

// bot doit fournir : videoDir, youtubeId(url), youtubeTitle(id), downloadVideo(id), userInVoice(guildId, channelId, userId)
// options.getUser(token) : remplaçable (tests) ; par défaut on interroge Discord.
function createActivity(bot, { send, readJson, fail }, options = {}) {
  const rooms = new Map();       // "guildId:channelId" -> salon
  const tokens = new Map();      // access_token -> { userId, name, exp }
  const preparing = new Map();   // videoId -> Promise (téléchargement en cours)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  const now = () => Date.now();
  const sendTo = (ws, message) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(message));
  };

  function broadcast(room, message, except = null) {
    const data = JSON.stringify(message);
    for (const ws of room.clients) {
      if (ws !== except && ws.readyState === 1) ws.send(data);
    }
  }

  // ----- Salons -----

  function getRoom(guildId, channelId) {
    const key = `${guildId}:${channelId}`;
    let room = rooms.get(key);

    if (!room) {
      room = {
        key,
        videoId: null,
        title: '',
        status: 'idle',    // idle | loading | ready | error
        error: '',
        playing: false,
        position: 0,
        at: now(),         // moment où `position` a été relevée
        by: '',
        clients: new Set(),
        touched: now()
      };
      rooms.set(key, room);
    }

    return room;
  }

  const currentPosition = room => room.position + (room.playing ? (now() - room.at) / 1000 : 0);

  const snapshot = room => ({
    t: 'state',
    videoId: room.videoId,
    title: room.title,
    status: room.status,
    error: room.error,
    playing: room.playing,
    position: currentPosition(room),
    by: room.by
  });

  // ----- Vidéos -----

  async function cleanup() {
    try {
      const active = new Set([...rooms.values()].map(room => room.videoId).filter(Boolean));
      const files = [];

      for (const name of await fsp.readdir(bot.videoDir)) {
        const full = path.join(bot.videoDir, name);
        const stat = await fsp.stat(full).catch(() => null);
        if (stat?.isFile()) files.push({ name, full, mtime: stat.mtimeMs });
      }

      files.sort((a, b) => b.mtime - a.mtime);

      for (const [index, file] of files.entries()) {
        const id = file.name.split('.')[0];
        if (active.has(id) || preparing.has(id)) continue;

        if (index >= MAX_FILES || now() - file.mtime > FILE_TTL_MS) {
          await fsp.unlink(file.full).catch(() => {});
        }
      }
    } catch (error) {
      console.error('Nettoyage des vidéos impossible :', error.message);
    }
  }

  // Télécharge la vidéo si elle n'est pas déjà sur le disque (un seul téléchargement par vidéo).
  function prepare(videoId) {
    const file = path.join(bot.videoDir, `${videoId}.mp4`);

    if (fs.existsSync(file)) {
      const date = new Date();
      fsp.utimes(file, date, date).catch(() => {});
      return Promise.resolve();
    }

    let job = preparing.get(videoId);

    if (!job) {
      job = Promise.resolve()
        .then(() => bot.downloadVideo(videoId))
        .then(() => cleanup())
        .finally(() => preparing.delete(videoId));
      preparing.set(videoId, job);
    }

    return job;
  }

  // Lance une vidéo dans le salon vocal (appelé par la commande /regarder ou par un participant).
  function setVideo(guildId, channelId, videoId, by = '') {
    if (!VIDEO_ID.test(String(videoId))) throw new Error('Identifiant YouTube invalide.');

    const room = getRoom(String(guildId), String(channelId));

    room.videoId = videoId;
    room.title = '';
    room.status = 'loading';
    room.error = '';
    room.playing = false;
    room.position = 0;
    room.at = now();
    room.by = by;
    room.touched = now();
    broadcast(room, snapshot(room));

    Promise.resolve(bot.youtubeTitle(videoId))
      .then(title => {
        if (room.videoId !== videoId) return;
        room.title = title;
        broadcast(room, { t: 'title', videoId, title });
      })
      .catch(() => {}); // l'erreur « vidéo introuvable » est remontée par le téléchargement

    prepare(videoId)
      .then(() => {
        if (room.videoId !== videoId) return;
        room.status = 'ready';
        room.playing = true;
        room.position = 0;
        room.at = now();
        broadcast(room, snapshot(room));
      })
      .catch(error => {
        console.error('Activité, vidéo impossible :', error.message);
        if (room.videoId !== videoId) return;
        room.status = 'error';
        room.error = error.message;
        room.playing = false;
        broadcast(room, snapshot(room));
      });
  }

  // ----- Authentification Discord -----

  async function discordUser(token) {
    const cached = tokens.get(token);
    if (cached && cached.exp > now()) return cached;

    const response = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) throw new Error('Connexion Discord refusée.');

    const user = await response.json();
    const entry = {
      userId: String(user.id),
      name: String(user.global_name || user.username || 'Quelqu’un').slice(0, 40),
      exp: now() + 10 * 60 * 1000
    };

    tokens.set(token, entry);
    return entry;
  }

  const getUser = options.getUser || discordUser;

  async function exchangeCode(code) {
    const { CLIENT_ID, DISCORD_CLIENT_SECRET } = process.env;

    if (!CLIENT_ID || !DISCORD_CLIENT_SECRET) {
      throw fail('Définis CLIENT_ID et DISCORD_CLIENT_SECRET dans .env pour activer l’Activité.', 503);
    }

    const response = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code || '')
      }),
      signal: AbortSignal.timeout(10000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.access_token) {
      throw fail('Discord a refusé l’échange du code (vérifie DISCORD_CLIENT_SECRET).', 400);
    }

    return data.access_token;
  }

  // ----- HTTP -----

  function serveMedia(req, res, id) {
    const file = path.join(bot.videoDir, `${id}.mp4`);
    let stat;

    try {
      stat = fs.statSync(file);
    } catch {
      res.writeHead(404);
      return res.end('Not found');
    }

    const size = stat.size;
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=600'
    };

    let start = 0;
    let end = size - 1;
    let status = 200;

    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);

      if (!match || (match[1] === '' && match[2] === '')) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }

      if (match[1] === '') {
        start = Math.max(size - Number(match[2]), 0);
      } else {
        start = Number(match[1]);
        if (match[2] !== '') end = Math.min(Number(match[2]), size - 1);
      }

      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }

      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }

    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);

    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(file, { start, end }), res, () => {});
  }

  // Retourne true si la requête concernait l'Activité (déjà traitée).
  async function handle(req, res, url) {
    const { pathname } = url;

    // Discord charge l'Activité à la racine, avec ?frame_id=... dans l'adresse.
    if (req.method === 'GET' && pathname === '/' && url.searchParams.has('frame_id')) {
      const html = fs.readFileSync(path.join(__dirname, 'activity', 'index.html'), 'utf8')
        .replace('{{CLIENT_ID}}', String(process.env.CLIENT_ID || '').replace(/[^0-9]/g, ''));

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return true;
    }

    if (req.method === 'GET' && pathname === '/activity/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(__dirname, 'activity', 'app.js')).pipe(res);
      return true;
    }

    if (req.method === 'POST' && pathname === '/activity/token') {
      const { code } = await readJson(req);
      send(res, 200, { access_token: await exchangeCode(code) });
      return true;
    }

    const media = pathname.match(/^\/activity\/media\/([A-Za-z0-9_-]{11})\.mp4$/);
    if (media && (req.method === 'GET' || req.method === 'HEAD')) {
      serveMedia(req, res, media[1]);
      return true;
    }

    return false;
  }

  // ----- WebSocket -----

  async function join(ws, msg) {
    if (ws.room || ws.joining) return;
    ws.joining = true;

    try {
      const user = await getUser(String(msg.token || ''));
      const guildId = String(msg.guildId || '');
      const channelId = String(msg.channelId || '');

      if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) {
        throw new Error('Cette Activité fonctionne dans un salon vocal de serveur (pas en message privé).');
      }

      if (!bot.userInVoice(guildId, channelId, user.userId)) {
        throw new Error('MCT MUSIC ne te voit pas dans ce salon vocal. Réessaie dans quelques secondes.');
      }

      if (ws.readyState !== 1) return;

      const room = getRoom(guildId, channelId);
      if (room.clients.size === 0) room.at = now(); // la lecture repart de la position enregistrée

      room.clients.add(ws);
      room.touched = now();
      ws.room = room;
      ws.user = user;

      sendTo(ws, snapshot(room));
      broadcast(room, { t: 'users', count: room.clients.size });
    } finally {
      ws.joining = false;
    }
  }

  function leave(ws) {
    const room = ws.room;
    if (!room) return;

    room.clients.delete(ws);
    ws.room = null;
    room.touched = now();

    if (room.clients.size === 0) {
      // plus personne : on fige la lecture à sa position actuelle
      room.position = currentPosition(room);
      room.at = now();
      room.playing = false;
    } else {
      broadcast(room, { t: 'users', count: room.clients.size });
    }
  }

  async function onMessage(ws, msg) {
    if (msg.t === 'hello') return join(ws, msg);

    const room = ws.room;
    if (!room) throw new Error('Pas encore connecté.');

    switch (msg.t) {
      case 'sync':
        return sendTo(ws, snapshot(room));

      case 'load': {
        const id = bot.youtubeId(String(msg.url || '').slice(0, 300));
        if (!id) throw new Error('Colle le lien d’une vidéo YouTube.');

        const [guildId, channelId] = room.key.split(':');
        return setVideo(guildId, channelId, id, ws.user.name);
      }

      case 'play':
      case 'pause':
      case 'seek': {
        if (room.status !== 'ready' || (msg.videoId && msg.videoId !== room.videoId)) return;

        const position = Number(msg.position);
        if (!Number.isFinite(position) || position < 0 || position > MAX_POSITION) return;

        room.position = position;
        room.at = now();
        room.by = ws.user.name;
        room.touched = now();
        if (msg.t === 'play') room.playing = true;
        if (msg.t === 'pause') room.playing = false;

        // l'auteur du geste ne reçoit pas d'écho
        return broadcast(room, snapshot(room), ws);
      }

      case 'ended':
        if (msg.videoId === room.videoId) room.playing = false;
        return;
    }
  }

  function onConnection(ws) {
    ws.alive = true;
    ws.room = null;
    ws.user = null;
    ws.joining = false;

    let hits = 0;
    const limiter = setInterval(() => { hits = 0; }, 5000);
    const helloTimer = setTimeout(() => {
      if (!ws.room) ws.close(4001, 'hello timeout');
    }, 15000);

    ws.on('pong', () => { ws.alive = true; });

    ws.on('message', async raw => {
      if (++hits > 40) return ws.close(1008, 'Trop de messages');

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      try {
        await onMessage(ws, msg);
      } catch (error) {
        sendTo(ws, { t: 'error', message: error.message });
      }
    });

    ws.on('close', () => {
      clearInterval(limiter);
      clearTimeout(helloTimer);
      leave(ws);
    });

    ws.on('error', () => {});
  }

  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://localhost');

      if (pathname !== '/activity/ws') {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, onConnection);
    });

    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.alive === false) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }, PING_MS).unref();

    setInterval(() => {
      for (const room of rooms.values()) {
        if (room.clients.size === 0 && now() - room.touched > ROOM_IDLE_MS) {
          rooms.delete(room.key);
        } else if (room.status === 'ready' && room.playing && room.clients.size > 1) {
          broadcast(room, { ...snapshot(room), t: 'sync' });
        }
      }

      for (const [token, entry] of tokens) {
        if (entry.exp < now()) tokens.delete(token);
      }
    }, options.tickMs || TICK_MS).unref();
  }

  return { handle, attach, setVideo };
}

module.exports = { createActivity };
