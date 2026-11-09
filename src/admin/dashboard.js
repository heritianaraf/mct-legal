// Dashboard ADMIN MCT (rouge / blanc / noir), servi par le serveur web de MCT MUSIC sous /admin.
// Accès THIVALIN : un seul mot de passe (ADMIN_MCT_PASSWORD).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const store = require('./store');

// Logo Discord (pastille officielle bleu Discord, logo blanc)
const DISCORD_BADGE = '<span class="discord-badge" title="Discord"><svg viewBox="0 0 24 24" role="img" aria-label="Discord"><rect width="24" height="24" rx="12" fill="#5865F2"/><g transform="translate(4 4) scale(.67)"><path fill="#fff" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></g></svg></span>';
const BASE = '/admin';
const MAX_IMAGE = 8 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const CSS = fs.readFileSync(path.join(__dirname, 'style.css'));
const TICKET_WORDS = ['ticket', 'recrut', 'candidature', 'support', 'entretien'];
const RECRUIT_WORDS = ['recrut', 'candidature', 'entretien'];

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameSecret = (a, b) => {
  const hash = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};

function createDashboard(getClient) {
  const sessions = new Map();
  const attempts = new Map();
  const password = () => (process.env.ADMIN_MCT_PASSWORD || '').trim();

  // ---------- réponses ----------
  const baseHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  };

  const html = (res, status, body) => {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };

  const redirect = (res, location, headers = {}) => {
    res.writeHead(303, { ...baseHeaders, Location: location, ...headers });
    res.end();
  };

  const back = (res, target, kind, message) => redirect(res, `${target}${target.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(message)}`);

  const cookieOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)adm=([a-f0-9]{64})/)?.[1];
  const sessionOf = req => {
    const token = cookieOf(req);
    const session = token && sessions.get(token);
    if (!session) return null;
    if (session.expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return token;
  };

  // Les formulaires POST doivent venir de cette même adresse.
  const checkOrigin = req => {
    const origin = req.headers.origin;
    if (!origin) return;
    let host;
    try { host = new URL(origin).host; } catch { throw fail('Origine invalide.', 403); }
    const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    if (!allowed.includes(host)) throw fail('Origine non autorisée.', 403);
  };

  // Lit un formulaire (multipart ou classique) avec une taille maximale.
  async function readForm(req, limit) {
    if (Number(req.headers['content-length'] || 0) > limit) throw fail('Requête trop grande (8 Mo maximum).', 413);
    let size = 0;
    const source = Readable.toWeb(req.pipe(new (require('node:stream').Transform)({
      transform(chunk, _enc, done) {
        size += chunk.length;
        done(size > limit ? fail('Requête trop grande (8 Mo maximum).', 413) : null, chunk);
      }
    })));
    try {
      return await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] || '' },
        body: source,
        duplex: 'half'
      }).formData();
    } catch (error) {
      throw error.status ? error : fail('Formulaire invalide.');
    }
  }

  // ---------- données Discord ----------
  const guildsOf = () => [...getClient().guilds.cache.values()];
  const pickGuild = id => {
    const guilds = guildsOf();
    return guilds.find(g => g.id === id) || guilds[0] || null;
  };

  const sendableChannels = guild => {
    const me = guild.members.me;
    return [...guild.channels.cache.values()]
      .filter(c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
      .sort((a, b) => a.rawPosition - b.rawPosition);
  };

  // ---------- pages ----------
  const layout = ({ title, heading, sub, active, content, flash, backLink }) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ADMIN MCT</title><link rel="icon" type="image/png" href="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png"><link rel="apple-touch-icon" href="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png"><link rel="stylesheet" href="${BASE}/static/style.css?v=3"></head>
<body><div class="app-shell">
<aside class="sidebar">
  <a class="brand" href="${BASE}/"><img class="brand-logo small" width="42" height="42" src="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png" alt="MCT"><span><b>ADMIN MCT</b><small>Espace THIVALIN</small></span></a>
  <div class="nav-label">MENU PRINCIPAL</div>
  <a class="nav-item${active === 'home' ? ' active' : ''}" href="${BASE}/">▦ <span>Vue d'ensemble</span></a>
  <a class="nav-item${active === 'tickets' ? ' active' : ''}" href="${BASE}/tickets">▣ <span>Tickets &amp; recrutement</span></a>
  <div class="sidebar-bottom"><span class="status-dot"></span> Accès THIVALIN · sécurisé</div>
</aside>
<main class="main-content">
  <header class="topbar"><div><p class="eyebrow">ESPACE ADMINISTRATION</p><h1>${esc(heading)}</h1><p class="muted">${esc(sub)}</p></div>
  ${backLink ? `<a class="button secondary" href="${BASE}/">← Retour</a>` : `<form action="${BASE}/logout" method="post"><button class="button secondary" type="submit">Déconnexion</button></form>`}</header>
  ${flash}
  ${content}
  <footer>ADMIN MCT <span>•</span> Interface d'administration privée</footer>
</main></div></body></html>`;

  const flashOf = url => {
    const ok = url.searchParams.get('ok');
    const err = url.searchParams.get('err');
    if (err) return `<div class="flash error">${esc(err.slice(0, 300))}</div>`;
    if (ok) return `<div class="flash success">${esc(ok.slice(0, 300))}</div>`;
    return '';
  };

  const loginPage = (message = '') => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion · ADMIN MCT</title><link rel="icon" type="image/png" href="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png"><link rel="apple-touch-icon" href="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png"><link rel="stylesheet" href="${BASE}/static/style.css?v=3"></head>
<body class="login-body"><main class="login-card">
  <img class="brand-logo" width="96" height="96" src="https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png" alt="MCT"><p class="eyebrow">MADAGASCAR COMMUNITY TEAM</p>
  <h1>ADMIN MCT</h1><p class="muted">Accès réservé à THIVALIN.</p>
  ${message ? `<div class="flash error">${esc(message)}</div>` : ''}
  <form method="post" action="${BASE}/login">
    <label for="password">Mot de passe THIVALIN</label>
    <input id="password" type="password" name="password" required autocomplete="current-password">
    <button class="button primary full" type="submit">Se connecter</button>
  </form>
  <p class="footnote">Ne partage jamais ton token Discord.</p>
</main></body></html>`;

  function homePage(url) {
    const client = getClient();
    const guilds = guildsOf();
    const guild = pickGuild(url.searchParams.get('guild'));
    const channels = guild ? sendableChannels(guild) : [];
    const welcome = store.getWelcome();
    const ready = client.isReady();
    const members = guilds.reduce((sum, g) => sum + (g.memberCount || 0), 0);

    const announce = !guilds.length
      ? '<p class="empty">Le bot n\'est pas encore connecté à un serveur.</p>'
      : `<form method="post" action="${BASE}/announce" class="form-stack" enctype="multipart/form-data">
          <label for="guild-select">Serveur Discord</label>
          <select id="guild-select" name="guild" onchange="window.location='${BASE}/?guild='+this.value">
            ${guilds.map(g => `<option value="${esc(g.id)}"${guild && guild.id === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}
          </select>
          <label for="channel_id">Salon de destination</label>
          <select id="channel_id" name="channel_id" required>${channels.map(c => `<option value="${esc(c.id)}"># ${esc(c.name)}</option>`).join('')}</select>
          <label for="content">Contenu du message</label>
          <textarea id="content" name="content" rows="6" maxlength="2000" placeholder="📢 Écrivez votre annonce MCT ici..."></textarea>
          <div class="form-hint">Maximum 2 000 caractères. Les mentions automatiques sont désactivées.</div>
          <label for="image">📷 Ajouter une photo</label>
          <input type="file" id="image" name="image" accept="image/png,image/jpeg,image/gif,image/webp">
          <div class="form-hint">Formats acceptés : PNG, JPG, JPEG, GIF et WEBP. Taille maximale : 8 Mo.</div>
          <button class="button primary" type="submit">➤ Envoyer l'annonce</button>
        </form>`;

    const content = `
    <section class="stats-grid">
      <article class="stat-card"><span class="stat-icon purple">◉</span><div><p class="muted">État du bot</p><h2>${ready ? 'En ligne' : 'Connexion...'}</h2><small>${ready ? 'Bot prêt à recevoir des actions' : 'Attendez que Discord soit connecté'}</small></div></article>
      <article class="stat-card"><span class="stat-icon blue">♧</span><div><p class="muted">Serveurs connectés</p><h2>${guilds.length}</h2><small>Serveurs auxquels le bot a accès</small></div></article>
      <article class="stat-card"><span class="stat-icon green">↗</span><div><p class="muted">Membres cumulés</p><h2>${members}</h2><small>Total approximatif des serveurs</small></div></article>
    </section>
    <section class="content-grid">
      <article class="panel">
        <div class="panel-heading"><div><h2>📢 Envoyer une annonce</h2><p class="muted">Publiez un message ou une photo dans un salon textuel.</p></div>${DISCORD_BADGE}</div>
        ${announce}
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>👋 Message de bienvenue</h2><p class="muted">Configurez le message envoyé aux nouveaux membres.</p></div></div>
        <form method="post" action="${BASE}/welcome" class="form-stack">
          <input type="hidden" name="guild" value="${esc(guild ? guild.id : '')}">
          <label class="toggle-row"><span><b>Activer le message</b><small>Envoi à chaque nouvel arrivant</small></span><input type="checkbox" name="enabled"${welcome.enabled ? ' checked' : ''}></label>
          <label for="welcome_channel_id">Salon de bienvenue (ID)</label>
          <input id="welcome_channel_id" name="welcome_channel_id" value="${esc(welcome.channelId)}" placeholder="Ex. 123456789012345678" inputmode="numeric">
          <p class="form-hint">Active le mode développeur Discord, puis clic droit sur le salon → Copier l'identifiant.</p>
          <label for="welcome_message">Message</label>
          <textarea id="welcome_message" name="welcome_message" rows="5" maxlength="1800" required>${esc(welcome.message)}</textarea>
          <div class="form-hint">Variables disponibles : <code>{mention}</code>, <code>{username}</code>, <code>{server}</code>.</div>
          <button class="button primary" type="submit">Enregistrer la configuration</button>
        </form>
      </article>
    </section>`;

    return layout({ title: 'Dashboard', heading: 'Vue d\'ensemble', sub: 'Gérez la communauté MCT depuis un seul endroit.', active: 'home', content, flash: flashOf(url) });
  }

  function ticketsPage(url) {
    const guilds = guildsOf();
    const guild = pickGuild(url.searchParams.get('guild'));
    const rows = guild ? [...guild.channels.cache.values()]
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ c, hay: `${c.name} ${c.parent ? c.parent.name : ''}`.toLowerCase() }))
      .filter(({ hay }) => TICKET_WORDS.some(w => hay.includes(w)))
      .map(({ c, hay }) => ({
        name: c.name, id: c.id, url: `https://discord.com/channels/${guild.id}/${c.id}`,
        category: RECRUIT_WORDS.some(w => hay.includes(w)) ? 'Recrutement ETS2' : 'Ticket / Support'
      })) : [];

    const content = `<section class="panel">
      <form method="get" action="${BASE}/tickets" class="filter-row"><label for="guild">Serveur</label>
        <select id="guild" name="guild">${guilds.map(g => `<option value="${esc(g.id)}"${guild && guild.id === g.id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        <button class="button primary" type="submit">Actualiser</button></form>
      <div class="table-wrap"><table><thead><tr><th>Type</th><th>Salon</th><th>Identifiant</th><th>Action</th></tr></thead><tbody>
      ${rows.length ? rows.map(r => `<tr><td><span class="pill">${esc(r.category)}</span></td><td># ${esc(r.name)}</td><td class="mono">${esc(r.id)}</td><td><a class="table-link" href="${esc(r.url)}" target="_blank" rel="noopener">Ouvrir sur Discord ↗</a></td></tr>`).join('')
        : '<tr><td colspan="4" class="empty">Aucun salon correspondant. Les tickets doivent être des salons textuels dont le nom ou la catégorie contient ticket, support, recrutement, candidature ou entretien.</td></tr>'}
      </tbody></table></div>
      <p class="form-hint">Cette page liste les salons détectés. La fermeture et la création de tickets ne sont pas gérées ici.</p>
    </section>`;

    return layout({ title: 'Tickets', heading: 'Tickets & recrutement ETS2', sub: 'Liste les salons dont le nom ou la catégorie évoque un ticket ou un recrutement.', active: 'tickets', content, flash: flashOf(url), backLink: true });
  }

  // ---------- actions ----------
  async function announce(req, res) {
    const form = await readForm(req, MAX_IMAGE + 1024 * 1024);
    const guildId = String(form.get('guild') || '');
    const target = `${BASE}/?guild=${encodeURIComponent(guildId)}`;
    const channelId = String(form.get('channel_id') || '');
    const content = String(form.get('content') || '').trim();
    const image = form.get('image');
    const hasImage = image && typeof image === 'object' && image.size > 0;

    if (!/^\d{1,25}$/.test(channelId)) return back(res, target, 'err', 'Choisis un salon Discord.');
    if (!content && !hasImage) return back(res, target, 'err', 'Ajoute un message ou une image.');
    if (content.length > 2000) return back(res, target, 'err', 'Le message dépasse la limite Discord de 2 000 caractères.');

    const payload = { allowedMentions: { parse: [] } };
    if (content) payload.content = content;

    if (hasImage) {
      const ext = path.extname(image.name || '').toLowerCase();
      if (!IMAGE_EXT.has(ext)) return back(res, target, 'err', 'Format d\'image non autorisé. Utilise PNG, JPG, GIF ou WEBP.');
      if (image.size > MAX_IMAGE) return back(res, target, 'err', 'L\'image ne doit pas dépasser 8 Mo.');
      const name = path.basename(image.name).replace(/[^\w.-]/g, '_') || `image${ext}`;
      payload.files = [{ attachment: Buffer.from(await image.arrayBuffer()), name }];
    }

    const client = getClient();
    const channel = await client.channels.fetch(channelId).catch(() => null);
    // Seulement un salon textuel d'un serveur où le bot est présent
    if (!channel || !channel.guild || !channel.isTextBased() || channel.isThread() || channel.isVoiceBased() || !client.guilds.cache.has(channel.guild.id)) {
      return back(res, target, 'err', 'Salon introuvable ou inaccessible au bot.');
    }

    try {
      await channel.send(payload);
    } catch (error) {
      console.error('ADMIN MCT annonce :', error.message);
      return back(res, target, 'err', 'Envoi impossible. Vérifie les permissions du bot dans ce salon.');
    }
    return back(res, target, 'ok', `Annonce envoyée dans #${channel.name}.`);
  }

  async function welcome(req, res) {
    const form = await readForm(req, 100000);
    const target = `${BASE}/?guild=${encodeURIComponent(String(form.get('guild') || ''))}`;
    const channelId = String(form.get('welcome_channel_id') || '').trim();
    const message = String(form.get('welcome_message') || '').trim();

    if (message.length > 1800) return back(res, target, 'err', 'Le message de bienvenue doit faire moins de 1 800 caractères.');
    if (channelId && !/^\d{1,25}$/.test(channelId)) return back(res, target, 'err', 'L\'identifiant du salon doit contenir uniquement des chiffres.');

    store.setWelcome({
      enabled: form.get('enabled') === 'on',
      channelId,
      message: message || '👋 Bienvenue {mention} sur le serveur MCT !'
    });
    return back(res, target, 'ok', 'Configuration de bienvenue enregistrée.');
  }

  function login(req, res) {
    return readForm(req, 10000).then(form => {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
      const entry = attempts.get(ip);
      const active = entry && entry.reset > Date.now();
      if (active && entry.count >= 10) return html(res, 429, loginPage('Trop de tentatives, réessaie dans quelques minutes.'));

      const given = String(form.get('password') || '');
      if (!given || !sameSecret(given, password())) {
        attempts.set(ip, { count: (active ? entry.count : 0) + 1, reset: active ? entry.reset : Date.now() + 600000 });
        return html(res, 401, loginPage('Mot de passe incorrect.'));
      }

      attempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { expires: Date.now() + 12 * 3600 * 1000 });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return redirect(res, `${BASE}/`, { 'Set-Cookie': `adm=${token}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=43200${secure}` });
    });
  }

  // ---------- routeur ----------
  async function handle(req, res, url) {
    const route = url.pathname.slice(BASE.length) || '/';

    try {
      if (route === '/static/style.css' && req.method === 'GET') {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        return res.end(CSS);
      }
      if (route === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }

      if (!password()) throw fail('Définis ADMIN_MCT_PASSWORD pour activer ADMIN MCT.', 503);

      if (route === '/login') {
        if (req.method === 'POST') { checkOrigin(req); return await login(req, res); }
        return html(res, 200, loginPage());
      }

      const token = sessionOf(req);
      if (!token) return redirect(res, `${BASE}/login`);

      if (route === '/logout' && req.method === 'POST') {
        checkOrigin(req);
        sessions.delete(token);
        return redirect(res, `${BASE}/login`, { 'Set-Cookie': `adm=; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=0` });
      }
      if (route === '/' && req.method === 'GET') return html(res, 200, homePage(url));
      if (route === '/tickets' && req.method === 'GET') return html(res, 200, ticketsPage(url));
      if (route === '/announce' && req.method === 'POST') { checkOrigin(req); return await announce(req, res); }
      if (route === '/welcome' && req.method === 'POST') { checkOrigin(req); return await welcome(req, res); }

      throw fail('Page introuvable.', 404);
    } catch (error) {
      console.error('ADMIN MCT dashboard :', error.message);
      if (!res.headersSent) {
        const status = error.status || 500;
        html(res, status, layout({ title: 'Erreur', heading: `Erreur ${status}`, sub: status === 500 ? 'Une erreur est survenue.' : error.message, active: '', content: '', flash: '', backLink: true }));
      } else {
        res.end();
      }
    }
  }

  return { handle };
}

module.exports = { createDashboard };
