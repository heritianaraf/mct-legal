import { DiscordSDK } from '@discord/embedded-app-sdk';

const $ = id => document.getElementById(id);

const video = $('video');
const overlay = $('overlay');
const overlayText = $('overlay-text');
const spinner = $('spinner');
const playButton = $('play');

let ws = null;
let state = null;          // dernier état reçu du serveur (+ receivedAt)
let loadedId = null;       // vidéo actuellement chargée dans <video>
let suppressUntil = 0;     // ignore les événements <video> déclenchés par la synchronisation
let statusTimer = null;

// ----- Affichage -----

function showOverlay(text, { error = false, loading = false, button = false } = {}) {
  overlayText.textContent = text;
  overlayText.classList.toggle('error', error);
  spinner.hidden = !loading;
  playButton.hidden = !button;
  overlay.hidden = false;
}

const hideOverlay = () => { overlay.hidden = true; };

function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}

const renderTitle = () => { $('title').textContent = state?.title || ''; };

// ----- Synchronisation -----

const suppress = (ms = 900) => { suppressUntil = Date.now() + ms; };
const isSuppressed = () => Date.now() < suppressUntil;

// Position estimée maintenant, d'après le dernier état reçu.
const estimatedPosition = () => state
  ? state.position + (state.playing ? (Date.now() - state.receivedAt) / 1000 : 0)
  : 0;

function syncPlayer(target, playing, tolerance) {
  suppress();

  if (Math.abs(video.currentTime - target) > tolerance) video.currentTime = target;

  if (playing && video.paused) {
    video.play().catch(() => {
      showOverlay('Le navigateur bloque la lecture automatique.', { button: true });
    });
  } else if (!playing && !video.paused) {
    video.pause();
  }
}

function applyState(msg) {
  const isTick = msg.t === 'sync';
  state = { ...msg, receivedAt: Date.now() };
  renderTitle();

  if (!msg.videoId) {
    video.pause();
    showOverlay('Colle un lien YouTube ci-dessus, ou utilise /regarder dans le salon.');
    return;
  }

  if (msg.status === 'loading') {
    video.pause();
    loadedId = null;
    showOverlay('Préparation de la vidéo… (la première fois, ça peut prendre une minute)', { loading: true });
    return;
  }

  if (msg.status === 'error') {
    video.pause();
    loadedId = null;
    showOverlay(msg.error || 'Impossible de charger cette vidéo.', { error: true });
    return;
  }

  // status === 'ready'
  if (loadedId !== msg.videoId) {
    loadedId = msg.videoId;
    suppress(3000);
    video.src = `/activity/media/${msg.videoId}.mp4`;

    const start = () => {
      if (state?.videoId === msg.videoId) {
        hideOverlay();
        syncPlayer(estimatedPosition(), state.playing, 0.6);
      }
    };

    video.addEventListener('loadedmetadata', start, { once: true });
    video.load();
    showOverlay('Chargement de la vidéo…', { loading: true });
    return;
  }

  // Resynchronisation douce (toutes les 10 s) : on n'intervient que si le décalage est net.
  if (isTick && video.readyState < 3) return;

  hideOverlay();
  syncPlayer(msg.position, msg.playing, isTick ? 1.5 : 0.6);
}

function send(message) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
}

// Geste de l'utilisateur sur le lecteur -> prévenir les autres.
function sendPlayer(type) {
  if (!state || state.status !== 'ready' || loadedId !== state.videoId) return;

  const position = video.currentTime;
  state = { ...state, position, receivedAt: Date.now(), playing: type === 'pause' ? false : (type === 'play' ? true : state.playing) };
  send({ t: type, videoId: state.videoId, position });
}

video.addEventListener('play', () => { if (!isSuppressed()) sendPlayer('play'); });
video.addEventListener('pause', () => { if (!isSuppressed() && !video.ended) sendPlayer('pause'); });
video.addEventListener('seeked', () => { if (!isSuppressed()) sendPlayer('seek'); });
video.addEventListener('ended', () => { if (state?.videoId) send({ t: 'ended', videoId: state.videoId }); });
video.addEventListener('error', () => {
  if (loadedId) showOverlay('La vidéo n’a pas pu être lue (fichier supprimé ou format non géré ?). Relance-la avec « Lire ».', { error: true });
});

// ----- Barre de lien et boutons -----

$('form').addEventListener('submit', event => {
  event.preventDefault();

  const input = $('url');
  const url = input.value.trim();
  if (!url) return;

  send({ t: 'load', url });
  input.value = '';
});

$('resync').addEventListener('click', () => send({ t: 'sync' }));

// Un clic = geste utilisateur : le navigateur accepte alors de lancer la lecture.
playButton.addEventListener('click', () => {
  hideOverlay();
  if (!state) return;

  suppress(1500);
  video.currentTime = estimatedPosition();
  video.play().catch(() => {});
  send({ t: 'sync' });
});

// ----- Connexion au serveur -----

function connect(token, guildId, channelId) {
  const socket = new WebSocket(`wss://${location.host}/.proxy/activity/ws`);
  ws = socket;

  socket.onopen = () => send({ t: 'hello', token, guildId, channelId });

  socket.onmessage = event => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.t === 'state' || msg.t === 'sync') applyState(msg);
    else if (msg.t === 'title') {
      if (state && state.videoId === msg.videoId) {
        state.title = msg.title;
        renderTitle();
      }
    } else if (msg.t === 'users') {
      $('users').textContent = `👥 ${msg.count}`;
    } else if (msg.t === 'error') {
      setStatus(msg.message, true);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    setStatus('Connexion perdue, reconnexion…', true);
    setTimeout(() => connect(token, guildId, channelId), 2000);
  };
}

async function boot() {
  if (!new URLSearchParams(location.search).has('frame_id')) {
    showOverlay('Ouvre cette page depuis Discord : salon vocal → Activités → MCT MUSIC.');
    return;
  }

  const clientId = window.MCT?.clientId;
  if (!clientId) {
    showOverlay('CLIENT_ID manquant dans le .env du serveur.', { error: true });
    return;
  }

  showOverlay('Connexion à Discord…', { loading: true });

  const sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify']
  });

  const response = await fetch('/.proxy/activity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) throw new Error(data.error || 'Connexion impossible.');

  await sdk.commands.authenticate({ access_token: data.access_token });

  if (!sdk.guildId || !sdk.channelId) {
    showOverlay('Cette Activité fonctionne dans un salon vocal de serveur (pas en message privé).', { error: true });
    return;
  }

  showOverlay('Colle un lien YouTube ci-dessus, ou utilise /regarder dans le salon.');
  connect(data.access_token, sdk.guildId, sdk.channelId);
}

boot().catch(error => {
  console.error(error);
  showOverlay(error.message || 'Erreur de démarrage.', { error: true });
});
