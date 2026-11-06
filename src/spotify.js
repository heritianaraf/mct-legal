// Résolution des liens Spotify : on récupère seulement les titres/artistes
// (oEmbed et page embed publiques, sans clé API). L'audio n'est jamais extrait.

const URL_RE = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/;
const UA = 'Mozilla/5.0 (compatible; MCTMusic/1.0)';
const MAX_TRACKS = 100;

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
      artist: String(item.subtitle || '').split(/[,\u00a0]/)[0].trim()
    }));

  return {
    label: entity?.name || entity?.title || (type === 'album' ? 'Album Spotify' : 'Playlist Spotify'),
    tracks
  };
}

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

  return match[1] === 'track'
    ? fetchTrack(match[2])
    : fetchCollection(match[1], match[2]);
}

module.exports = { resolveSpotify };
