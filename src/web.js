const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createActivity } = require('./activity');

function startWeb(bot) {
  const PORT = process.env.PORT || 10000;
  // Le mot de passe saisi donne l'accès : MCT (tout), THIVALIN (lecteur personnel, sans Discord), VISITEUR (lecteur MCT limité)
  const PASSWORDS = [
    ['mct', process.env.WEB_PASSWORD || ''],
    ['thivalin', process.env.WEB_PASSWORD_THIVALIN || ''],
    ['visiteur', process.env.WEB_PASSWORD_VISITEUR || '']
  ].filter(([, password]) => password);
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

  // Retourne la session { role, expires } ou null
  const isAuthed = req => {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)mct=([a-f0-9]{64})/)?.[1];
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return session;
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

      if (!PASSWORDS.length) {
        throw fail('Définis WEB_PASSWORD dans .env pour activer l’interface web.', 503);
      }

      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
        const entry = attempts.get(ip);
        if (entry && entry.reset > Date.now() && entry.count >= 10) {
          throw fail('Trop de tentatives, réessaie dans quelques minutes.', 429);
        }

        const { password } = await readJson(req);
        // on compare toujours aux trois mots de passe (même durée), le premier qui correspond donne le rôle
        let role = null;
        if (typeof password === 'string') {
          for (const [name, expected] of PASSWORDS) {
            if (sameSecret(password, expected) && !role) role = name;
          }
        }

        if (!role) {
          attempts.set(ip, {
            count: (entry && entry.reset > Date.now() ? entry.count : 0) + 1,
            reset: entry && entry.reset > Date.now() ? entry.reset : Date.now() + 600000
          });
          throw fail('Mot de passe incorrect.', 401);
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { role, admin: role === 'thivalin', expires: Date.now() + 12 * 3600 * 1000 }); // THIVALIN = admin : il peut changer d'accès
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, { ok: true, role }, {
          'Set-Cookie': `mct=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}`
        });
      }

      const session = isAuthed(req);
      if (!session) throw fail('Non connecté.', 401);

      // THIVALIN (admin) peut basculer sur un autre accès : toute la suite se comporte alors comme cet accès
      if (url.pathname === '/api/role' && req.method === 'POST') {
        if (!session.admin) throw fail('Réservé à l’administrateur.', 403);
        const { role: next } = await readJson(req);
        if (!['thivalin', 'mct', 'visiteur'].includes(next)) throw fail('Accès inconnu.');
        session.role = next;
        return send(res, 200, { ok: true, role: next });
      }

      const role = session.role;
      const allow = (...roles) => {
        if (!roles.includes(role)) throw fail('Accès non autorisé avec ce mot de passe.', 403);
      };

      // Identifiant de serveur Discord uniquement (jamais un identifiant de lecteur interne)
      const guildOf = value => {
        const id = String(value ?? '');
        if (!/^\d{1,25}$/.test(id)) throw fail('Serveur invalide.');
        return id;
      };

      // Lecteur utilisé : THIVALIN a le sien (navigateur seulement), MCT et visiteur partagent celui de Discord
      const playerOf = id => (role === 'thivalin' ? `tv:${id}` : id);

      // Salon vocal : choisi par MCT ; le visiteur utilise celui où le bot joue déjà ; THIVALIN n'en a pas
      const channelOf = (id, channelId) => {
        if (role === 'thivalin') return '';
        if (role !== 'visiteur') return channelId;
        const active = bot.activeChannel(id);
        if (!active) throw fail('Aucune musique en cours sur Discord : MCT doit d’abord la lancer.', 409);
        return active;
      };

      if (url.pathname === '/api/spectrum' && req.method === 'GET') {
        const id = guildOf(url.searchParams.get('guildId'));
        return send(res, 200, bot.spectrum(playerOf(id), Math.min(Math.max(Number(url.searchParams.get('delay')) || 0, 0), 10000)));
      }

      // Écoute dans le navigateur : flux MP3 en direct (la réponse reste ouverte)
      if (url.pathname === '/api/listen' && req.method === 'GET') {
        return bot.listen(playerOf(guildOf(url.searchParams.get('guildId'))), req, res);
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        const guilds = bot.getState().map(({ personal, ...guild }) => {
          if (role === 'thivalin') return { ...guild, ...personal, channels: [] };
          if (role === 'visiteur') return { ...guild, channels: [], channelId: null, stations: [], discordMuted: false };
          return guild;
        });
        return send(res, 200, { role, admin: Boolean(session.admin), guilds });
      }

      if (url.pathname === '/api/play' && req.method === 'POST') {
        const { guildId, channelId, source, value, loop } = await readJson(req);
        const id = guildOf(guildId);
        if (source === 'station') allow('mct', 'thivalin');

        const player = playerOf(id);
        const channel = channelOf(id, channelId);

        // Lien YouTube : on télécharge le MP3 (enregistré dans youtube.json), puis il est lancé ou ajouté à la file
        if (source === 'url' && bot.youtubeId(value)) {
          const job = bot.addYoutube(player, channel, value);
          job.catch(error => console.error('Ajout YouTube :', error.message)); // évite une erreur « non gérée » si la réponse part avant la fin

          const waited = await Promise.race([
            job,
            new Promise(resolve => setTimeout(() => resolve(null), 45000))
          ]);

          return send(res, 200, {
            message: waited || '⏳ Téléchargement du MP3 en cours : la musique sera lancée ou ajoutée à la file dès qu’elle est prête.'
          });
        }

        return send(res, 200, { message: await bot.play(player, channel, source, value, loop) });
      }

      if (url.pathname === '/api/activity' && req.method === 'POST') {
        allow('mct');
        const { guildId, channelId, url: videoUrl } = await readJson(req);
        return send(res, 200, await bot.watch(guildOf(guildId), channelId, videoUrl, activity));
      }

      if (url.pathname === '/api/soundboard' && req.method === 'GET') {
        allow('mct');
        const sounds = await bot.soundList(guildOf(url.searchParams.get('guildId')), url.searchParams.get('force') === '1');
        return send(res, 200, { sounds });
      }

      if (url.pathname === '/api/soundboard' && req.method === 'POST') {
        allow('mct');
        const { guildId, channelId, soundId } = await readJson(req);
        return send(res, 200, { message: await bot.sound(guildOf(guildId), channelId, soundId) });
      }

      if (url.pathname === '/api/volume' && req.method === 'POST') {
        allow('mct', 'thivalin'); // le visiteur ne règle pas le volume de Discord
        const { guildId, volume } = await readJson(req);
        return send(res, 200, { message: bot.volume(playerOf(guildOf(guildId)), volume) });
      }

      if (url.pathname === '/api/control' && req.method === 'POST') {
        const { guildId, action, value } = await readJson(req);
        if (action === 'output') allow('mct'); // couper / rétablir le son Discord
        await bot.control(playerOf(guildOf(guildId)), action, value);
        return send(res, 200, { ok: true });
      }

      if (url.pathname === '/api/queue/save' && req.method === 'POST') {
        allow('mct', 'thivalin');
        const { guildId, items, playlists, passwords } = await readJson(req);
        return send(res, 200, { message: await bot.saveQueueToStations(playerOf(guildOf(guildId)), items, playlists, passwords) });
      }

      if (url.pathname === '/api/queue' && req.method === 'POST') {
        const { guildId, index, action, name } = await readJson(req);
        return send(res, 200, { message: bot.queueAction(playerOf(guildOf(guildId)), index, action, name) });
      }

      // Playlists : MCT et THIVALIN (les mêmes playlists), jamais le visiteur
      if (url.pathname.startsWith('/api/station')) allow('mct', 'thivalin');

      if (url.pathname === '/api/station' && req.method === 'POST') {
        const { guildId, source, name, password } = await readJson(req);
        return send(res, 200, { message: await bot.addStation(guildOf(guildId), source, name, password) });
      }

      if (url.pathname === '/api/station/delete' && req.method === 'POST') {
        const { guildId, name, password } = await readJson(req);
        return send(res, 200, { message: bot.removeStation(guildOf(guildId), name, password) });
      }

      if (url.pathname === '/api/station/add' && req.method === 'POST') {
        const { guildId, name, source } = await readJson(req);
        return send(res, 200, { message: await bot.addStationLink(guildOf(guildId), name, source) });
      }

      if (url.pathname === '/api/station/remove-item' && req.method === 'POST') {
        const { guildId, name, index, password } = await readJson(req);
        return send(res, 200, { message: bot.removeStationItem(guildOf(guildId), name, index, password) });
      }

      if (url.pathname === '/api/station/items' && req.method === 'POST') {
        const { guildId, name } = await readJson(req);
        return send(res, 200, { items: bot.stationItems(guildOf(guildId), name) });
      }

      if (url.pathname === '/api/station/play-item' && req.method === 'POST') {
        const { guildId, channelId, name, index } = await readJson(req);
        const id = guildOf(guildId);
        return send(res, 200, { message: await bot.playStationItem(playerOf(id), channelOf(id, channelId), name, index) });
      }

      if (url.pathname === '/api/station/add-current' && req.method === 'POST') {
        const { guildId, name, password } = await readJson(req);
        return send(res, 200, { message: await bot.saveCurrentToStation(playerOf(guildOf(guildId)), name, password) });
      }

      if (url.pathname === '/api/station/upload' && req.method === 'PUT') {
        const message = await bot.addStationFile(
          guildOf(url.searchParams.get('guildId')),
          url.searchParams.get('name'),
          url.searchParams.get('file') || 'musique.mp3',
          req
        );
        return send(res, 200, { message });
      }

      if (url.pathname === '/api/upload' && req.method === 'PUT') {
        const id = guildOf(url.searchParams.get('guildId'));
        const message = await bot.upload(
          playerOf(id),
          channelOf(id, url.searchParams.get('channelId')),
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
