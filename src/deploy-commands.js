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
    .setDescription('Lire une musique MP3')
    .addAttachmentOption(option =>
      option
        .setName('fichier')
        .setDescription('Choisir un MP3 depuis votre ordinateur (limite Discord)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName('nom')
        .setDescription('Nom du MP3 présent dans le dossier music')
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

  // SKIP
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
    .setDescription('Afficher les MP3 disponibles')

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
      '❌ Vérifie DISCORD_TOKEN, CLIENT_ID et GUILD_ID dans .env'
    );
  }

  const rest = new REST({ version: '10' })
    .setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log('================================');
  console.log('✅ Commandes MCT MUSIC enregistrées');
  console.log('🎵 /play fichier');
  console.log('🎵 /play nom');
  console.log('⏭️ /skip');
  console.log('📋 /queue');
  console.log('================================');
}

main().catch(error => {
  console.error('❌ Erreur enregistrement :', error);
});