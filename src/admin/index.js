// ADMIN MCT : second bot Discord (autre token que MCT MUSIC), avec son dashboard sur /admin.
//
// Variables d'environnement :
//   ADMIN_MCT_TOKEN     token du bot ADMIN MCT (différent de DISCORD_TOKEN)
//   ADMIN_MCT_PASSWORD  mot de passe du dashboard (accès THIVALIN)
//   ADMIN_DATA_DIR      (facultatif) dossier des données (avertissements, message de bienvenue)
//   ADMIN_BACKUP_CHANNEL_ID (facultatif) salon Discord privé où welcome.json et warns.json sont sauvegardés
//                       (sinon BACKUP_CHANNEL_ID, le même salon que les playlists et youtube.json)

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
  EmbedBuilder
} = require('discord.js');
const store = require('./store');
const commands = require('./commands');
const { createDashboard } = require('./dashboard');

const escapeMarkdown = text => String(text).replace(/([\\*_`~|>])/g, '\\$1');

function createAdmin(options = {}) {
  const client = options.client || new Client({
    // GuildMembers est un intent privilégié : à activer dans le portail Discord (Bot > Server Members Intent).
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
  });

  const dashboard = createDashboard(() => client);

  async function registerCommands(guild) {
    try {
      await guild.commands.set(commands.definitions);
    } catch (error) {
      console.error(`ADMIN MCT : commandes non enregistrées sur ${guild.name} :`, error.message);
    }
  }

  client.once(Events.ClientReady, async ready => {
    console.log(`ADMIN MCT connecté : ${ready.user.tag}`);
    ready.user.setPresence({ activities: [{ name: '🛡️ ADMIN MCT', type: ActivityType.Playing }], status: 'online' });
    await store.attachBackup(ready); // restaure welcome.json / warns.json depuis le salon Discord s'ils sont absents
    for (const guild of ready.guilds.cache.values()) await registerCommands(guild);
  });

  client.on(Events.GuildCreate, registerCommands);
  client.on(Events.InteractionCreate, interaction => {
    if (interaction.isChatInputCommand()) commands.handle(interaction);
  });

  // Message de bienvenue configuré depuis le dashboard
  client.on(Events.GuildMemberAdd, async member => {
    const config = store.getWelcome();
    if (!config.enabled || !/^\d+$/.test(config.channelId)) return;

    const channel = member.guild.channels.cache.get(config.channelId);
    if (!channel || !channel.isTextBased()) return;

    const message = config.message
      .replaceAll('{mention}', member.toString())
      .replaceAll('{username}', escapeMarkdown(member.user.username))
      .replaceAll('{server}', escapeMarkdown(member.guild.name));

    await channel.send({ content: message, allowedMentions: { users: [member.id], roles: [], parse: [] } }).catch(() => {});
  });

  client.on(Events.Error, error => console.error('ADMIN MCT :', error.message));

  function start() {
    const token = (process.env.ADMIN_MCT_TOKEN || '').trim();
    if (!token) {
      console.warn('ADMIN MCT : ADMIN_MCT_TOKEN absent, le bot ADMIN MCT n’est pas démarré.');
      return;
    }
    if (token === (process.env.DISCORD_TOKEN || '').trim()) {
      console.error('ADMIN MCT : ADMIN_MCT_TOKEN est identique au token de MCT MUSIC, ADMIN MCT n’est pas démarré.');
      return;
    }
    client.login(token).catch(error => console.error('ADMIN MCT : connexion impossible :', error.message));
  }

  return { start, handle: dashboard.handle, client };
}

module.exports = { createAdmin };
