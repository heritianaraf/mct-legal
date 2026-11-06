// Résolution des liens Spotify : on récupère seulement le titre du morceau
// (oEmbed public, sans clé API). L'audio n'est jamais extrait de Spotify.

const TRACK_RE = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/;

async function resolveSpotify(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Lien Spotify invalide.');
  }

  if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') {
    throw new Error('Colle un lien open.spotify.com vers un morceau.');
  }

  const match = url.pathname.match(TRACK_RE);
  if (!match) {
    throw new Error('Lien Spotify non reconnu.');
  }

  if (match[1] !== 'track') {
    throw new Error(
      'Seuls les liens de morceaux (open.spotify.com/track/…) sont gérés : Spotify a fortement restreint son API pour les albums et playlists.'
    );
  }

  const canonical = `https://open.spotify.com/track/${match[2]}`;
  const response = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(canonical)}`,
    { signal: AbortSignal.timeout(15000) }
  );

  if (!response.ok) {
    throw new Error('Impossible de lire ce lien Spotify (morceau introuvable ?).');
  }

  const data = await response.json();
  const title = String(data.title || '').trim();

  if (!title) {
    throw new Error('Spotify n’a renvoyé aucun titre pour ce lien.');
  }

  return { label: title, tracks: [{ title, artist: '' }] };
}

module.exports = { resolveSpotify };
