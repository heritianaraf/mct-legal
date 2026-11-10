
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
        .setName('url')
        .setDescription('Lien Google Drive vers un MP3 ou un dossier de MP3')
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

  // VOLUME
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Régler le volume de la musique')
    .addIntegerOption(option =>
      option
        .setName('niveau')
        .setDescription('Volume en % (100 = normal, max 200). Vide : affiche le volume actuel')
        .setMinValue(0)
        .setMaxValue(200)
        .setRequired(false)
    ),

  // SOUNDBOARD
  new SlashCommandBuilder()
    .setName('soundboard')
    .setDescription('Jouer un son de la table de mixage du serveur')
    .addStringOption(option =>
      option
        .setName('son')
        .setDescription('Son à jouer')
        .setAutocomplete(true)
        .setRequired(true)
    ),

  // STATION (playlists)
  new SlashCommandBuilder()
    .setName('station')
    .setDescription('Créer et gérer tes playlists')
    .addSubcommand(sub =>
      sub
        .setName('creer')
        .setDescription('Créer une playlist avec son mot de passe')
    )
    .addSubcommand(sub =>
      sub
        .setName('ajouter')
        .setDescription('Ajouter un MP3 ou un lien à une playlist')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Playlist existante')
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
            .setDescription('Lien YouTube, Google Drive (fichier ou dossier) ou Spotify (morceau, album, playlist)')
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
        .addBooleanOption(option =>
          option
            .setName('boucle')
            .setDescription('Relancer la playlist quand elle est finie (activé par défaut)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('boucle')
        .setDescription('Activer ou désactiver la boucle de la playlist en cours')
        .addBooleanOption(option =>
          option
            .setName('actif')
            .setDescription('Activer la boucle ?')
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
        .setDescription('Supprimer une playlist (mot de passe de la playlist)')
        .addStringOption(option =>
          option
            .setName('nom')
            .setDescription('Nom de la playlist')
            .setAutocomplete(true)
            .setRequired(true)
        )
    ),

  // REGARDER (Activité Discord)
  new SlashCommandBuilder()
    .setName('regarder')
    .setDescription('Regarder une vidéo YouTube ensemble dans le salon vocal (Activité)')
    .addStringOption(option =>
      option
        .setName('url')
        .setDescription('Lien YouTube (facultatif : tu peux aussi le coller dans l’Activité)')
        .setRequired(false)
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
  console.log('/play url');
  console.log('/station creer /ajouter /retirer /jouer /boucle /liste /supprimer');
  console.log('/pause /resume /stop');
  console.log('/skip /queue /volume /soundboard');
  console.log('/regarder');
  console.log('================================');
}

main().catch(console.error);
