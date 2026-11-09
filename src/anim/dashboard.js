// Dashboard ANIM MCT (rouge / blanc / noir), servi par le serveur web de MCT MUSIC sous /anim.
// Accès : un seul mot de passe (ANIM_MCT_PASSWORD).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const store = require('./store');
const animation = require('./animation');

// Logo Discord (pastille officielle bleu Discord, logo blanc)
const DISCORD_BADGE = '<span class="discord-badge" title="Discord"><svg viewBox="0 0 24 24" role="img" aria-label="Discord"><rect width="24" height="24" rx="12" fill="#5865F2"/><g transform="translate(4 4) scale(.67)"><path fill="#fff" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></g></svg></span>';
const BASE = '/anim';
const MAX_IMAGE = 8 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const LOGO = 'https://raw.githubusercontent.com/heritianaraf/mct-legal/main/src/assets/logo-music-player.png';
const ICON = `<link rel="icon" type="image/png" href="${LOGO}"><link rel="apple-touch-icon" href="${LOGO}">`;
// Thème d'ADMIN MCT + compléments propres à ANIM MCT
const CSS = Buffer.concat(['../admin/style.css', './style.css'].map(file => {
  try {
    return fs.readFileSync(path.join(__dirname, file));
  } catch {
    return Buffer.alloc(0);
  }
}));

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameSecret = (a, b) => {
  const hash = v => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
};
const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function createDashboard(getClient) {
  const sessions = new Map();
  const attempts = new Map();
  const password = () => (process.env.ANIM_MCT_PASSWORD || '').trim();

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

  const cookieOf = req => (req.headers.cookie || '').match(/(?:^|;\s*)anm=([a-f0-9]{64})/)?.[1];
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

  // Lit un formulaire classique avec une taille maximale.
  async function readForm(req, limit) {
    if (Number(req.headers['content-length'] || 0) > limit) throw fail('Requête trop grande.', 413);
    let size = 0;
    const source = Readable.toWeb(req.pipe(new (require('node:stream').Transform)({
      transform(chunk, _enc, done) {
        size += chunk.length;
        done(size > limit ? fail('Requête trop grande.', 413) : null, chunk);
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

  const sendableChannels = guild => {
    const me = guild.members.me;
    return [...guild.channels.cache.values()]
      .filter(c => (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        && c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))
      .sort((a, b) => a.rawPosition - b.rawPosition);
  };

  // Liste de salons de tous les serveurs, groupés par serveur
  const channelOptions = (selected, withNone) => (withNone ? '<option value="">— Aucun —</option>' : '')
    + guildsOf().map(g => {
      const channels = sendableChannels(g);
      return channels.length
        ? `<optgroup label="${esc(g.name)}">${channels.map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}># ${esc(c.name)}</option>`).join('')}</optgroup>`
        : '';
    }).join('');

  const knownChannel = id => guildsOf().some(g => g.channels.cache.has(id));

  // ---------- pages ----------
  const nav = (active, key, label, icon) =>
    `<a class="nav-item${active === key ? ' active' : ''}" href="${BASE}${key === 'home' ? '/' : `/${key}`}">${icon} <span>${label}</span></a>`;

  const layout = ({ title, heading, sub, active, content, flash, backLink }) => `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ANIM MCT</title>${ICON}<link rel="stylesheet" href="${BASE}/static/style.css?v=3"></head>
<body><div class="app-shell">
<aside class="sidebar">
  <a class="brand" href="${BASE}/"><img class="brand-logo small" width="42" height="42" src="${LOGO}" alt="MCT"><span><b>ANIM MCT</b><small>Animation de la communauté</small></span></a>
  <div class="nav-label">MENU PRINCIPAL</div>
  ${nav(active, 'home', 'Vue d\'ensemble', '▦')}
  ${nav(active, 'messages', 'Messages d\'animation', '✎')}
  ${nav(active, 'quiz', 'Quiz', '?')}
  <div class="sidebar-bottom"><span class="status-dot"></span> Accès sécurisé</div>
</aside>
<main class="main-content">
  <header class="topbar"><div><p class="eyebrow">ESPACE ANIMATION</p><h1>${esc(heading)}</h1><p class="muted">${esc(sub)}</p></div>
  <form action="${BASE}/logout" method="post"><button class="button secondary" type="submit">Déconnexion</button></form></header>
  ${flash}
  ${content}
  <footer>ANIM MCT <span>•</span> Données sauvegardées dans le salon Discord de sauvegarde</footer>
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
<title>Connexion · ANIM MCT</title>${ICON}<link rel="stylesheet" href="${BASE}/static/style.css?v=3"></head>
<body class="login-body"><main class="login-card">
  <img class="brand-logo" width="96" height="96" src="${LOGO}" alt="MCT"><p class="eyebrow">MADAGASCAR COMMUNITY TEAM</p>
  <h1>ANIM MCT</h1><p class="muted">Accès réservé à l'équipe d'animation.</p>
  ${message ? `<div class="flash error">${esc(message)}</div>` : ''}
  <form method="post" action="${BASE}/login">
    <label for="password">Mot de passe</label>
    <input id="password" type="password" name="password" required autocomplete="current-password">
    <button class="button primary full" type="submit">Se connecter</button>
  </form>
  <p class="footnote">Ne partage jamais ton token Discord.</p>
</main></body></html>`;

  const KIND_LABEL = animation.KINDS;
  const kindOptions = selected => Object.entries(KIND_LABEL)
    .map(([key, label]) => `<option value="${key}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const short = (text, n = 70) => (text.length > n ? `${text.slice(0, n)}…` : text);

  function homePage(url) {
    const client = getClient();
    const config = store.getConfig();
    const { auto, welcome, xp } = config;
    const guilds = guildsOf();
    const active = config.messages.filter(m => m.enabled).length;

    let next = 'Désactivées';
    if (auto.enabled && auto.channelId) {
      const minutes = Math.round((auto.lastPostAt + auto.intervalMinutes * 60000 - Date.now()) / 60000);
      next = !active ? 'Aucun message actif' : minutes <= 1 ? 'Imminente' : minutes >= 120 ? `Dans ${Math.round(minutes / 60)} h` : `Dans ${minutes} min`;
    }

    const announcePanel = `<article class="panel">
        <div class="panel-heading"><div><h2>📢 Envoyer un message</h2><p class="muted">Publie un message, avec ou sans photo, dans un salon textuel.</p></div>${DISCORD_BADGE}</div>
        <form method="post" action="${BASE}/announce" class="form-stack" enctype="multipart/form-data">
          <label for="ann_channel">Salon de destination</label>
          <select id="ann_channel" name="channel_id" required>${channelOptions(auto.channelId, false)}</select>
          <label for="ann_content">Contenu du message</label>
          <textarea id="ann_content" name="content" rows="5" maxlength="2000" placeholder="📢 Écrivez votre message ici..."></textarea>
          <div class="form-hint">Maximum 2 000 caractères. Les mentions automatiques sont désactivées.</div>
          <label for="ann_image">📷 Ajouter une photo (facultatif)</label>
          <input type="file" id="ann_image" name="image" accept="image/png,image/jpeg,image/gif,image/webp">
          <div class="form-hint">Formats acceptés : PNG, JPG, JPEG, GIF et WEBP. Taille maximale : 8 Mo.</div>
          <button class="button primary" type="submit">➤ Envoyer le message</button>
        </form>
      </article>`;

    const content = `
    <section class="stats-grid">
      <article class="stat-card"><span class="stat-icon purple">◉</span><div><p class="muted">État du bot</p><h2>${client.isReady() ? 'En ligne' : 'Connexion...'}</h2><small>${guilds.length} serveur(s) connecté(s)</small></div></article>
      <article class="stat-card"><span class="stat-icon blue">✎</span><div><p class="muted">Messages actifs</p><h2>${active} / ${config.messages.length}</h2><small>${config.quiz.length} question(s) de quiz</small></div></article>
      <article class="stat-card"><span class="stat-icon green">⏱</span><div><p class="muted">Prochaine animation</p><h2>${esc(next)}</h2><small>Toutes les ${auto.intervalMinutes} min</small></div></article>
    </section>
    <section class="content-grid">
      ${announcePanel}
      <article class="panel">
        <div class="panel-heading"><div><h2>🚀 Publier maintenant</h2><p class="muted">Envoie tout de suite un message d'animation dans un salon.</p></div>${DISCORD_BADGE}</div>
        <form method="post" action="${BASE}/publish" class="form-stack">
          <label for="pub_channel">Salon de destination</label>
          <select id="pub_channel" name="channel_id" required>${channelOptions(auto.channelId, false)}</select>
          <label for="pub_message">Message</label>
          <select id="pub_message" name="message_id">
            <option value="">🎲 Au hasard parmi les messages actifs</option>
            ${config.messages.map(m => `<option value="${esc(m.id)}">[${esc(KIND_LABEL[m.kind] || m.kind)}] ${esc(short(m.text))}</option>`).join('')}
          </select>
          <button class="button primary full" type="submit">➤ Publier</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>⏱ Animations automatiques</h2><p class="muted">Un message actif, au hasard, à intervalle régulier.</p></div></div>
        <form method="post" action="${BASE}/save/auto" class="form-stack">
          <label class="toggle-row"><span><b>Activer</b><small>Publication automatique dans le salon choisi</small></span><input type="checkbox" name="enabled"${auto.enabled ? ' checked' : ''}></label>
          <label for="auto_channel">Salon</label>
          <select id="auto_channel" name="channel_id">${channelOptions(auto.channelId, true)}</select>
          <label for="auto_interval">Intervalle (minutes)</label>
          <input id="auto_interval" type="number" name="interval" min="5" max="10080" value="${auto.intervalMinutes}" required>
          <div class="form-hint">Entre 5 minutes et 7 jours. Un redémarrage du bot ne republie pas tout de suite.</div>
          <button class="button primary full" type="submit">Enregistrer</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>👋 Bienvenue</h2><p class="muted">Message envoyé aux nouveaux membres par ANIM MCT.</p></div></div>
        <form method="post" action="${BASE}/save/welcome" class="form-stack">
          <label class="toggle-row"><span><b>Activer</b><small>ADMIN MCT a aussi un message de bienvenue : évite les doublons</small></span><input type="checkbox" name="enabled"${welcome.enabled ? ' checked' : ''}></label>
          <label for="welcome_channel">Salon</label>
          <select id="welcome_channel" name="channel_id">${channelOptions(welcome.channelId, true)}</select>
          <label for="welcome_message">Message</label>
          <textarea id="welcome_message" name="message" rows="4" maxlength="1800" required>${esc(welcome.message)}</textarea>
          <div class="form-hint">Variables : <code>{mention}</code>, <code>{username}</code>, <code>{server}</code>.</div>
          <button class="button primary full" type="submit">Enregistrer</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>🏅 XP et niveaux</h2><p class="muted">Points gagnés en discutant (un gain par membre et par délai).</p></div></div>
        <form method="post" action="${BASE}/save/xp" class="form-stack">
          <label class="toggle-row"><span><b>Activer l'XP</b><small>/profil et /classement</small></span><input type="checkbox" name="enabled"${xp.enabled ? ' checked' : ''}></label>
          <div class="form-grid">
            <div><label for="xp_amount">XP par message</label><input id="xp_amount" type="number" name="per_message" min="1" max="100" value="${xp.perMessage}" required></div>
            <div><label for="xp_cooldown">Délai (secondes)</label><input id="xp_cooldown" type="number" name="cooldown" min="10" max="3600" value="${xp.cooldownSeconds}" required></div>
          </div>
          <button class="button primary full" type="submit">Enregistrer</button>
        </form>
      </article>
    </section>`;

    return layout({ title: 'Dashboard', heading: 'Vue d\'ensemble', sub: 'Pilote les animations de la communauté MCT.', active: 'home', content, flash: flashOf(url) });
  }

  function messagesPage(url) {
    const { messages } = store.getConfig();

    const rows = messages.map(m => `<tr>
      <td><span class="pill">${esc(KIND_LABEL[m.kind] || m.kind)}</span><br><span class="pill ${m.enabled ? 'ok' : 'off'}" style="margin-top:6px">${m.enabled ? 'Actif' : 'Désactivé'}</span></td>
      <td>${m.kind === 'custom' && m.title ? `<div class="msg-title">${esc(m.title)}</div>` : ''}<div class="msg-text">${esc(m.text)}</div>
        <details class="edit"><summary>Modifier</summary>
          <form method="post" action="${BASE}/messages/update" class="form-stack">
            <input type="hidden" name="id" value="${esc(m.id)}">
            <label>Type</label><select name="kind">${kindOptions(m.kind)}</select>
            <label>Titre (type « Message libre » seulement)</label><input name="title" maxlength="100" value="${esc(m.title)}">
            <label>Texte</label><textarea name="text" rows="3" maxlength="1500" required>${esc(m.text)}</textarea>
            <button class="button primary small" type="submit">Enregistrer</button>
          </form>
        </details></td>
      <td><div class="row-actions">
        <form method="post" action="${BASE}/messages/toggle" class="inline-form"><input type="hidden" name="id" value="${esc(m.id)}"><button class="button ghost small" type="submit">${m.enabled ? 'Désactiver' : 'Activer'}</button></form>
        <form method="post" action="${BASE}/messages/delete" class="inline-form" onsubmit="return confirm('Supprimer ce message ?')"><input type="hidden" name="id" value="${esc(m.id)}"><button class="button danger small" type="submit">Supprimer</button></form>
      </div></td></tr>`).join('');

    const content = `
    <section class="content-grid single">
      <article class="panel">
        <div class="panel-heading"><div><h2>➕ Nouveau message d'animation</h2><p class="muted">Il rejoint la rotation des animations automatiques.</p></div></div>
        <form method="post" action="${BASE}/messages/add" class="form-stack">
          <div class="form-grid">
            <div><label for="new_kind">Type</label><select id="new_kind" name="kind">${kindOptions('question')}</select></div>
            <div><label for="new_title">Titre (type « Message libre » seulement)</label><input id="new_title" name="title" maxlength="100" placeholder="✨ Animation communautaire"></div>
          </div>
          <label for="new_text">Texte</label>
          <textarea id="new_text" name="text" rows="3" maxlength="1500" placeholder="Quel jeu pourrais-tu rejouer pendant des années ?" required></textarea>
          <button class="button primary" type="submit">Ajouter</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>Messages (${messages.length})</h2><p class="muted">Seuls les messages actifs sont publiés.</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Type</th><th>Message</th><th>Actions</th></tr></thead><tbody>
          ${rows || '<tr><td colspan="3" class="empty">Aucun message. Ajoute-en un ci-dessus.</td></tr>'}
        </tbody></table></div>
      </article>
    </section>`;

    return layout({ title: 'Messages', heading: 'Messages d\'animation', sub: 'Questions du jour, défis et messages libres publiés automatiquement.', active: 'messages', content, flash: flashOf(url) });
  }

  function quizPage(url) {
    const { quiz } = store.getConfig();

    const rows = quiz.map(item => `<tr>
      <td><div class="msg-text">${esc(item.q)}</div></td>
      <td><ol class="choices">${item.choices.map((c, n) => `<li${n === item.answer ? ' class="good"' : ''}>${esc(c)}${n === item.answer ? ' ✓' : ''}</li>`).join('')}</ol></td>
      <td><form method="post" action="${BASE}/quiz/delete" class="inline-form" onsubmit="return confirm('Supprimer cette question ?')"><input type="hidden" name="id" value="${esc(item.id)}"><button class="button danger small" type="submit">Supprimer</button></form></td></tr>`).join('');

    const content = `
    <section class="content-grid single">
      <article class="panel">
        <div class="panel-heading"><div><h2>➕ Nouvelle question de quiz</h2><p class="muted">Utilisée par la commande /quiz (+25 XP pour une bonne réponse).</p></div></div>
        <form method="post" action="${BASE}/quiz/add" class="form-stack">
          <label for="quiz_q">Question</label>
          <input id="quiz_q" name="q" maxlength="300" required>
          <label for="quiz_choices">Réponses possibles (une par ligne, 2 à 4)</label>
          <textarea id="quiz_choices" name="choices" rows="4" placeholder="Minecraft&#10;Fortnite&#10;ETS2" required></textarea>
          <label for="quiz_answer">Numéro de la bonne réponse</label>
          <input id="quiz_answer" type="number" name="answer" min="1" max="4" value="1" required>
          <button class="button primary" type="submit">Ajouter</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-heading"><div><h2>Questions (${quiz.length})</h2></div></div>
        <div class="table-wrap"><table><thead><tr><th>Question</th><th>Réponses</th><th>Action</th></tr></thead><tbody>
          ${rows || '<tr><td colspan="3" class="empty">Aucune question : /quiz ne fonctionnera pas tant qu\'il n\'y en a pas.</td></tr>'}
        </tbody></table></div>
      </article>
    </section>`;

    return layout({ title: 'Quiz', heading: 'Quiz', sub: 'Questions proposées par la commande /quiz.', active: 'quiz', content, flash: flashOf(url) });
  }

  // ---------- actions ----------
  const field = (form, name) => String(form.get(name) || '').trim();
  const channelField = (form, name) => {
    const id = field(form, name);
    if (id && (!/^\d{1,25}$/.test(id) || !knownChannel(id))) throw fail('Salon introuvable ou inaccessible au bot.');
    return id;
  };

  async function savePanel(req, res, kind) {
    const form = await readForm(req, 100000);
    const target = `${BASE}/`;

    try {
      if (kind === 'auto') {
        const channelId = channelField(form, 'channel_id');
        const enabled = form.get('enabled') === 'on';
        if (enabled && !channelId) return back(res, target, 'err', 'Choisis un salon pour activer les animations automatiques.');
        const interval = clampInt(form.get('interval'), 5, 10080, 180);
        store.updateConfig(c => Object.assign(c.auto, { enabled, channelId, intervalMinutes: interval }));
        return back(res, target, 'ok', 'Animations automatiques enregistrées.');
      }

      if (kind === 'welcome') {
        const channelId = channelField(form, 'channel_id');
        const enabled = form.get('enabled') === 'on';
        const message = field(form, 'message');
        if (enabled && !channelId) return back(res, target, 'err', 'Choisis un salon pour activer le message de bienvenue.');
        if (message.length > 1800) return back(res, target, 'err', 'Le message de bienvenue doit faire moins de 1 800 caractères.');
        store.updateConfig(c => Object.assign(c.welcome, { enabled, channelId, message: message || c.welcome.message }));
        return back(res, target, 'ok', 'Bienvenue enregistrée.');
      }

      const enabled = form.get('enabled') === 'on';
      const perMessage = clampInt(form.get('per_message'), 1, 100, 10);
      const cooldownSeconds = clampInt(form.get('cooldown'), 10, 3600, 60);
      store.updateConfig(c => Object.assign(c.xp, { enabled, perMessage, cooldownSeconds }));
      return back(res, target, 'ok', 'Réglages XP enregistrés.');
    } catch (error) {
      if (error.status) return back(res, target, 'err', error.message);
      throw error;
    }
  }

  async function publishNow(req, res) {
    const form = await readForm(req, 10000);
    const channelId = field(form, 'channel_id');
    const config = store.getConfig();
    const item = field(form, 'message_id') ? config.messages.find(m => m.id === field(form, 'message_id')) : animation.pickNext(config);

    if (!item) return back(res, `${BASE}/`, 'err', 'Aucun message actif à publier.');

    try {
      const channel = await animation.publish(getClient(), channelId, item);
      return back(res, `${BASE}/`, 'ok', `Message publié dans #${channel.name}.`);
    } catch (error) {
      console.error('ANIM MCT publication :', error.message);
      return back(res, `${BASE}/`, 'err', error.status ? error.message : 'Envoi impossible. Vérifie les permissions du bot dans ce salon.');
    }
  }

  // Message libre avec ou sans photo (comme ADMIN MCT)
  async function announce(req, res) {
    const form = await readForm(req, MAX_IMAGE + 1024 * 1024);
    const target = `${BASE}/`;
    const channelId = field(form, 'channel_id');
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

    const channel = await animation.resolveChannel(getClient(), channelId);
    if (!channel) return back(res, target, 'err', 'Salon introuvable ou inaccessible au bot.');

    try {
      await channel.send(payload);
    } catch (error) {
      console.error('ANIM MCT message :', error.message);
      return back(res, target, 'err', 'Envoi impossible. Vérifie les permissions du bot dans ce salon.');
    }
    return back(res, target, 'ok', `Message envoyé dans #${channel.name}.`);
  }

  async function messageAction(req, res, action) {
    const form = await readForm(req, 20000);
    const target = `${BASE}/messages`;
    const id = field(form, 'id');

    if (action === 'add' || action === 'update') {
      const kind = Object.hasOwn(KIND_LABEL, field(form, 'kind')) ? field(form, 'kind') : 'custom';
      const text = field(form, 'text');
      const title = kind === 'custom' ? field(form, 'title').slice(0, 100) : '';
      if (!text) return back(res, target, 'err', 'Le texte est obligatoire.');
      if (text.length > 1500) return back(res, target, 'err', 'Le texte dépasse 1 500 caractères.');

      if (action === 'add') {
        store.updateConfig(c => c.messages.push({ id: store.newId(), kind, title, text, enabled: true }));
        return back(res, target, 'ok', 'Message ajouté.');
      }

      let found = false;
      store.updateConfig(c => {
        const item = c.messages.find(m => m.id === id);
        if (item) { found = true; Object.assign(item, { kind, title, text }); }
      });
      return back(res, target, found ? 'ok' : 'err', found ? 'Message modifié.' : 'Message introuvable.');
    }

    let found = false;
    store.updateConfig(c => {
      if (action === 'toggle') {
        const item = c.messages.find(m => m.id === id);
        if (item) { found = true; item.enabled = !item.enabled; }
      } else {
        const before = c.messages.length;
        c.messages = c.messages.filter(m => m.id !== id);
        found = c.messages.length !== before;
      }
    });
    return back(res, target, found ? 'ok' : 'err', found ? (action === 'toggle' ? 'État modifié.' : 'Message supprimé.') : 'Message introuvable.');
  }

  async function quizAction(req, res, action) {
    const form = await readForm(req, 20000);
    const target = `${BASE}/quiz`;

    if (action === 'delete') {
      let found = false;
      store.updateConfig(c => {
        const before = c.quiz.length;
        c.quiz = c.quiz.filter(item => item.id !== field(form, 'id'));
        found = c.quiz.length !== before;
      });
      return back(res, target, found ? 'ok' : 'err', found ? 'Question supprimée.' : 'Question introuvable.');
    }

    const q = field(form, 'q');
    const choices = String(form.get('choices') || '').split('\n').map(s => s.trim()).filter(Boolean);
    const answer = clampInt(form.get('answer'), 1, 4, 1) - 1;

    if (!q) return back(res, target, 'err', 'La question est obligatoire.');
    if (choices.length < 2 || choices.length > 4) return back(res, target, 'err', 'Indique entre 2 et 4 réponses, une par ligne.');
    if (choices.some(c => c.length > 80)) return back(res, target, 'err', 'Chaque réponse doit faire 80 caractères au maximum.');
    if (answer >= choices.length) return back(res, target, 'err', 'Le numéro de la bonne réponse dépasse le nombre de réponses.');

    store.updateConfig(c => c.quiz.push({ id: store.newId(), q, choices, answer }));
    return back(res, target, 'ok', 'Question ajoutée.');
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
      return redirect(res, `${BASE}/`, { 'Set-Cookie': `anm=${token}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=43200${secure}` });
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

      if (!password()) throw fail('Définis ANIM_MCT_PASSWORD pour activer ANIM MCT.', 503);

      if (route === '/login') {
        if (req.method === 'POST') { checkOrigin(req); return await login(req, res); }
        return html(res, 200, loginPage());
      }

      const token = sessionOf(req);
      if (!token) return redirect(res, `${BASE}/login`);

      if (req.method === 'GET') {
        if (route === '/') return html(res, 200, homePage(url));
        if (route === '/messages') return html(res, 200, messagesPage(url));
        if (route === '/quiz') return html(res, 200, quizPage(url));
      }

      if (req.method === 'POST') {
        checkOrigin(req);
        if (route === '/logout') {
          sessions.delete(token);
          return redirect(res, `${BASE}/login`, { 'Set-Cookie': `anm=; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=0` });
        }
        if (route === '/announce') return await announce(req, res);
        if (route === '/publish') return await publishNow(req, res);
        if (route === '/save/auto') return await savePanel(req, res, 'auto');
        if (route === '/save/welcome') return await savePanel(req, res, 'welcome');
        if (route === '/save/xp') return await savePanel(req, res, 'xp');

        const message = route.match(/^\/messages\/(add|update|toggle|delete)$/);
        if (message) return await messageAction(req, res, message[1]);

        const quiz = route.match(/^\/quiz\/(add|delete)$/);
        if (quiz) return await quizAction(req, res, quiz[1]);
      }

      throw fail('Page introuvable.', 404);
    } catch (error) {
      console.error('ANIM MCT dashboard :', error.message);
      if (!res.headersSent) {
        const status = error.status || 500;
        html(res, status, layout({ title: 'Erreur', heading: `Erreur ${status}`, sub: status === 500 ? 'Une erreur est survenue.' : error.message, active: '', content: '', flash: '' }));
      } else {
        res.end();
      }
    }
  }

  return { handle };
}

module.exports = { createDashboard };
