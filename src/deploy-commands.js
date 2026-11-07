
require('dotenv').config();

const {
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const commands = [
  // PLAY
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Lire une musique')
    .addAttachmentOption(option =>
      option
        .setName('fichier')
        .setDescription('MP3 depuis votre ordinateur')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('nom')
        .setDescription('Nom du MP3 dans le dossier music')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('Lien Google Drive vers un MP3 ou un dossier de MP3')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('spotify')
        .setDescription('Lien Spotify (morceau, album ou playlist) retrouvé dans tes MP3')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('radio')
        .setDescription('Adresse directe d’une radio / flux audio (Icecast, Shoutcast, HLS)')
        .setRequired(false)
    ),

  // PAUSE
  new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Mettre la musique en pause'),

  // RESUME
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Reprendre la musique'),

  // STOP
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Arrêter la musique et vider la file'),

  // NEXT
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Passer à la musique suivante'),

  // QUEUE
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Afficher la file d’attente'),

  // LIST
  new SlashCommandBuilder()
    .setName('list')
    .setDescription('Afficher les MP3 disponibles'),

  // STATION (playlists)
  new SlashCommandBuilder()
    .setName('station')
    .setDescription('Créer et gérer tes playlists')
    .addSubcommand(sub =>
      sub
        .setName('creer')
        .setDescription('Créer une playlist (Spotify, Google Drive ou radio)')
    )
    .addSubcommand(sub =>
      sub
        .setName('ajouter')
        .setDescription('Ajouter un MP3 ou un lien à une playlist')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Playlist existante (ou un nouveau nom pour la créer)')
            .setAutocomplete(true)
            .setRequired(true)
        )
        .addAttachmentOption(option =>
          option
            .setName('fichier')
            .setDescription('MP3 depuis ton ordinateur ou ton téléphone')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('lien')
            .setDescription('Lien Spotify, Google Drive ou radio')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('retirer')
        .setDescription('Retirer un élément d’une playlist')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Nom de la playlist')
            .setAutocomplete(true)
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('numero')
            .setDescription('Numéro de l’élément (voir /station liste)')
            .setMinValue(1)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('jouer')
        .setDescription('Lancer une playlist')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Nom de la playlist')
            .setAutocomplete(true)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('liste')
        .setDescription('Afficher les playlists (ou le contenu de l’une d’elles)')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Playlist à détailler')
            .setAutocomplete(true)
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('supprimer')
        .setDescription('Supprimer une playlist')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Nom de la playlist')
            .setAutocomplete(true)
            .setRequired(true)
        )
    )

].map(command => command.toJSON());

// ======================================
// ENREGISTREMENT DES COMMANDES
// ======================================

async function main() {
  const {
    DISCORD_TOKEN,
    CLIENT_ID,
    GUILD_ID
  } = process.env;

  if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
    throw new Error(
      'Vérifie DISCORD_TOKEN, CLIENT_ID et GUILD_ID dans .env'
    );
  }

  const rest = new REST({ version: '10' })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('================================');
  console.log('MCT MUSIC : commandes enregistrées');
  console.log('/play fichier');
  console.log('/play nom');
  console.log('/play url');
  console.log('/play spotify');
  console.log('/play radio');
  console.log('/station creer /ajouter /retirer /jouer /liste /supprimer');
  console.log('/pause /resume /stop');
  console.log('/skip /queue /list');
  console.log('================================');
}

main().catch(console.error);
