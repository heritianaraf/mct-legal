// Résolution des liens Spotify : on récupère seulement les titres/artistes.
// L'audio n'est jamais extrait.
//
// 1. Si SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET sont définis dans .env, on
//    interroge l'API officielle (identifiants d'application, sans connexion).
// 2. Si l'API est absente ou refuse la requête (playlist qui n'est pas la tienne,
//    quota, panne…), on retombe sur oEmbed et la page embed publiques, sans clé.

const URL_RE = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/;
const UA = 'Mozilla/5.0 (compatible; MCTMusic/1.0)';
const MAX_TRACKS = 200;
const MAX_PAGES = 15;
const API = 'https://api.spotify.com/v1';

// ======================================
// API OFFICIELLE (identifiants d'application)
// ======================================

const credentials = () => {
  const id = (process.env.SPOTIFY_CLIENT_ID || '').trim();
  const secret = (process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  return id && secret ? { id, secret } : null;
};

const spotifyApiEnabled = () => Boolean(credentials());

let cachedToken = null;
let pendingToken = null;

async function getToken(force = false) {
  if (!force && cachedToken && cachedToken.expires > Date.now() + 30000) return cachedToken.value;
  if (pendingToken) return pendingToken;

  const creds = credentials();
  if (!creds) throw new Error('identifiants Spotify absents');

  pendingToken = (async () => {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      throw Object.assign(
        new Error(`identifiants Spotify refusés (${response.status}), vérifie SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET`),
        { status: response.status }
      );
    }

    const data = await response.json();
    cachedToken = {
      value: data.access_token,
      expires: Date.now() + (Number(data.expires_in) || 3600) * 1000
    };
    return cachedToken.value;
  })().finally(() => {
    pendingToken = null;
  });

  return pendingToken;
}

// Les liens « next » renvoyés par Spotify ne sont suivis que s'ils restent sur l'API.
function apiUrl(url) {
  if (!String(url).startsWith(`${API}/`)) throw new Error('lien de page inattendu');
  return url;
}

async function apiGet(url, retry = true) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(15000)
  });

  if (response.status === 401 && retry) {
    await getToken(true);
    return apiGet(url, false);
  }

  if (!response.ok) {
    throw Object.assign(new Error(`API Spotify ${response.status}`), { status: response.status });
  }

  return response.json();
}

const toTrack = item => ({
  title: String(item.name).trim(),
  artist: String(item.artists?.[0]?.name || '').trim(),
  duration: item.duration_ms ? Math.round(item.duration_ms / 1000) : null // secondes, aide à choisir la bonne vidéo
});

async function apiTrack(id) {
  const data = await apiGet(`${API}/tracks/${id}`);
  if (!data?.name) throw new Error('morceau sans titre');
  return { label: String(data.name).trim(), tracks: [toTrack(data)] };
}

async function apiAlbum(id) {
  const album = await apiGet(`${API}/albums/${id}`);
  const tracks = [];
  let page = album?.tracks;

  for (let i = 0; page && i < MAX_PAGES; i++) {
    for (const item of page.items || []) {
      if (item?.name) tracks.push(toTrack(item));
    }
    if (tracks.length >= MAX_TRACKS || !page.next) break;
    page = await apiGet(apiUrl(page.next));
  }

  if (!tracks.length) throw new Error('album vide');
  return { label: album.name || 'Album Spotify', tracks: tracks.slice(0, MAX_TRACKS) };
}

async function apiPlaylist(id) {
  const tracks = [];
  const base = `${API}/playlists/${id}/items`;
  let url = `${base}?limit=50`;

  for (let i = 0; url && i < MAX_PAGES; i++) {
    let page;
    try {
      page = await apiGet(url);
    } catch (error) {
      if (i === 0 && error.status === 400) {
        url = base; // limite refusée : on réessaie avec la taille de page par défaut
        page = await apiGet(url);
      } else {
        throw error;
      }
    }

    // Format 2026 : { items: [{ item }] } ; ancien format : { items: [{ track }] }
    for (const entry of page?.items || []) {
      const item = entry?.item || entry?.track;
      if (item?.type === 'track' && item.name) tracks.push(toTrack(item));
    }

    if (tracks.length >= MAX_TRACKS) break;
    url = page?.next ? apiUrl(page.next) : null;
  }

  if (!tracks.length) throw new Error('playlist vide ou inaccessible');

  const meta = await apiGet(`${API}/playlists/${id}?fields=name`).catch(() => null);
  return { label: meta?.name || 'Playlist Spotify', tracks: tracks.slice(0, MAX_TRACKS) };
}

function resolveWithApi(type, id) {
  if (type === 'track') return apiTrack(id);
  return type === 'album' ? apiAlbum(id) : apiPlaylist(id);
}

// ======================================
// REPLI : oEmbed et page embed publiques (sans clé)
// ======================================

async function fetchTrack(id) {
  const response = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${id}`)}`,
    { signal: AbortSignal.timeout(15000) }
  );

  if (!response.ok) {
    throw new Error('Impossible de lire ce lien Spotify (morceau introuvable ?).');
  }

  const title = String((await response.json()).title || '').trim();
  if (!title) throw new Error('Spotify n’a renvoyé aucun titre pour ce lien.');

  return { label: title, tracks: [{ title, artist: '' }] };
}

function findTrackList(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (Array.isArray(node.trackList)) return node.trackList;

  for (const value of Object.values(node)) {
    const found = findTrackList(value, depth + 1);
    if (found) return found;
  }
  return null;
}

async function fetchCollection(type, id) {
  const response = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error('Impossible de lire cet album ou cette playlist Spotify (privé ?).');
  }

  const html = await response.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!match) {
    throw new Error('Spotify a modifié sa page : impossible de lire la liste des morceaux.');
  }

  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error('Spotify a modifié sa page : impossible de lire la liste des morceaux.');
  }

  const entity = data?.props?.pageProps?.state?.data?.entity;
  const list = entity?.trackList || findTrackList(data);

  if (!list?.length) {
    throw new Error('Aucun morceau trouvé (playlist privée ou générée par Spotify ?).');
  }

  const tracks = list
    .filter(item => item?.title)
    .slice(0, MAX_TRACKS)
    .map(item => ({
      title: String(item.title),
      artist: String(item.subtitle || '').split(/[,\u00a0]/)[0].trim(),
      duration: Number(item.duration) > 1000 ? Math.round(Number(item.duration) / 1000) : null
    }));

  return {
    label: entity?.name || entity?.title || (type === 'album' ? 'Album Spotify' : 'Playlist Spotify'),
    tracks
  };
}

// ======================================
// POINT D'ENTRÉE
// ======================================

async function resolveSpotify(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Lien Spotify invalide.');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
    throw new Error('Colle un lien open.spotify.com (morceau, album ou playlist).');
  }

  const match = url.pathname.match(URL_RE);
  if (!match) throw new Error('Lien Spotify non reconnu.');

  const [, type, id] = match;

  if (spotifyApiEnabled()) {
    try {
      return await resolveWithApi(type, id);
    } catch (error) {
      console.warn(`Spotify API : ${error.message} → repli sur la page publique.`);
    }
  }

  return type === 'track' ? fetchTrack(id) : fetchCollection(type, id);
}

module.exports = { resolveSpotify, spotifyApiEnabled };
