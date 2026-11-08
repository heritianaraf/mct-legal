const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createActivity } = require('./activity');

function startWeb(bot) {
  const PORT = process.env.PORT || 10000;
  const PASSWORD = process.env.WEB_PASSWORD || '';
  const sessions = new Map();
  const attempts = new Map();

  const fail = (message, status = 400) => Object.assign(new Error(message), { status });

  const send = (res, code, data, headers = {}) => {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    });
    res.end(JSON.stringify(data));
  };

  const sameSecret = (a, b) => {
    const hash = value => crypto.createHash('sha256').update(value).digest();
    return crypto.timingSafeEqual(hash(a), hash(b));
  };

  const isAuthed = req => {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)mct=([a-f0-9]{64})/)?.[1];
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const readJson = req => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 200000) {
        reject(fail('Requête trop grande.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(fail('JSON invalide.'));
      }
    });
    req.on('error', reject);
  });

  // Activité Discord « regarder ensemble » (sans mot de passe : Discord l'ouvre dans son iframe)
  const activity = createActivity(bot, { send, readJson, fail });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (await activity.handle(req, res, url)) return;

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
      }

      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404);
        return res.end('Not found');
      }

      if (!PASSWORD) {
        throw fail('Définis WEB_PASSWORD dans .env pour activer l’interface web.', 503);
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
        const entry = attempts.get(ip);
        if (entry && entry.reset > Date.now() && entry.count >= 10) {
          throw fail('Trop de tentatives, réessaie dans quelques minutes.', 429);
        }

        const { password } = await readJson(req);
        if (typeof password !== 'string' || !sameSecret(password, PASSWORD)) {
          attempts.set(ip, {
            count: (entry && entry.reset > Date.now() ? entry.count : 0) + 1,
            reset: entry && entry.reset > Date.now() ? entry.reset : Date.now() + 600000
          });
          throw fail('Mot de passe incorrect.', 401);
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 12 * 3600 * 1000);
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `mct=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`
        });
      }

      if (!isAuthed(req)) throw fail('Non connecté.', 401);

      if (url.pathname === '/api/state' && req.method === 'GET') {
        return send(res, 200, { guilds: bot.getState() });
      }

      if (url.pathname === '/api/play' && req.method === 'POST') {
        const { guildId, channelId, source, value, loop } = await readJson(req);
        return send(res, 200, { message: await bot.play(guildId, channelId, source, value, loop) });
      }

      if (url.pathname === '/api/activity' && req.method === 'POST') {
        const { guildId, channelId, url: videoUrl } = await readJson(req);
        return send(res, 200, { message: bot.watch(guildId, channelId, videoUrl, activity) });
      }

      if (url.pathname === '/api/soundboard' && req.method === 'GET') {
        const sounds = await bot.soundList(url.searchParams.get('guildId'), url.searchParams.get('force') === '1');
        return send(res, 200, { sounds });
      }

      if (url.pathname === '/api/soundboard' && req.method === 'POST') {
        const { guildId, channelId, soundId } = await readJson(req);
        return send(res, 200, { message: await bot.sound(guildId, channelId, soundId) });
      }

      if (url.pathname === '/api/volume' && req.method === 'POST') {
        const { guildId, volume } = await readJson(req);
        return send(res, 200, { message: bot.volume(guildId, volume) });
      }

      if (url.pathname === '/api/control' && req.method === 'POST') {
        const { guildId, action } = await readJson(req);
        await bot.control(guildId, action);
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/api/queue/save' && req.method === 'POST') {
        const { guildId, items, playlists, passwords } = await readJson(req);
        return send(res, 200, { message: await bot.saveQueueToStations(guildId, items, playlists, passwords) });
      }

      if (url.pathname === '/api/queue' && req.method === 'POST') {
        const { guildId, index, action, name } = await readJson(req);
        return send(res, 200, { message: bot.queueAction(guildId, index, action, name) });
      }

      if (url.pathname === '/api/station' && req.method === 'POST') {
        const { guildId, source, name, password } = await readJson(req);
        return send(res, 200, { message: await bot.addStation(guildId, source, name, password) });
      }

      if (url.pathname === '/api/station/delete' && req.method === 'POST') {
        const { guildId, name, password } = await readJson(req);
        return send(res, 200, { message: bot.removeStation(guildId, name, password) });
      }

      if (url.pathname === '/api/station/add' && req.method === 'POST') {
        const { guildId, name, source } = await readJson(req);
        return send(res, 200, { message: await bot.addStationLink(guildId, name, source) });
      }

      if (url.pathname === '/api/station/remove-item' && req.method === 'POST') {
        const { guildId, name, index, password } = await readJson(req);
        return send(res, 200, { message: bot.removeStationItem(guildId, name, index, password) });
      }

      if (url.pathname === '/api/station/items' && req.method === 'POST') {
        const { guildId, name, password } = await readJson(req);
        return send(res, 200, { items: bot.stationItems(guildId, name, password) });
      }

      if (url.pathname === '/api/station/add-current' && req.method === 'POST') {
        const { guildId, name, password } = await readJson(req);
        return send(res, 200, { message: await bot.saveCurrentToStation(guildId, name, password) });
      }

      if (url.pathname === '/api/station/upload' && req.method === 'PUT') {
        const message = await bot.addStationFile(
          url.searchParams.get('guildId'),
          url.searchParams.get('name'),
          url.searchParams.get('file') || 'musique.mp3',
          req
        );
        return send(res, 200, { message });
      }

      if (url.pathname === '/api/upload' && req.method === 'PUT') {
        const message = await bot.upload(
          url.searchParams.get('guildId'),
          url.searchParams.get('channelId'),
          url.searchParams.get('name') || 'musique.mp3',
          req
        );
        return send(res, 200, { message });
      }

      throw fail('Route inconnue.', 404);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 400, { error: error.message });
    }
  });

  activity.attach(server);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MCT MUSIC interface web sur le port ${PORT}`);
  });

  return { activity };
}

module.exports = { startWeb };
