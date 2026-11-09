// ANIM MCT : bot d'animation (3e bot Discord, son propre token) avec son dashboard sur /anim.
//
// Variables d'environnement :
//   ANIM_MCT_TOKEN        token du bot ANIM MCT (différent de DISCORD_TOKEN et de ADMIN_MCT_TOKEN)
//   ANIM_MCT_PASSWORD     mot de passe du dashboard /anim
//   ANIM_DATA_DIR         (facultatif) dossier des données (config.json, xp.json)
//   ANIM_BACKUP_CHANNEL_ID (facultatif) salon privé de sauvegarde, sinon BACKUP_CHANNEL_ID
//                         (le même salon que les playlists, youtube.json et ADMIN MCT)

const {
  Client,
  GatewayIntentBits,
  ActivityType,
  Events,
  EmbedBuilder
} = require('discord.js');
const store = require('./store');
const commands = require('./commands');
const animation = require('./animation');
const { createDashboard } = require('./dashboard');

const escapeMarkdown = text => String(text).replace(/([\\*_`~|>])/g, '\\$1');

function createAnim(options = {}) {
  const client = options.client || new Client({
    // GuildMembers est un intent privilégié : à activer dans le portail Discord (Bot > Server Members Intent).
    // Message Content n'est plus nécessaire : l'XP compte les messages sans lire leur contenu.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
  });

  const dashboard = createDashboard(() => client);

  async function registerCommands(guild) {
    try {
      await guild.commands.set(commands.definitions);
    } catch (error) {
      console.error(`ANIM MCT : commandes non enregistrées sur ${guild.name} :`, error.message);
    }
  }

  // ---------- animations automatiques ----------
  // Planification enregistrée (lastPostAt) : un redémarrage ne republie pas tout de suite.
  let ticking = false;

  async function tick() {
    if (ticking || !client.isReady()) return;
    ticking = true;

    try {
      const config = store.getConfig();
      const { auto } = config;
      if (!auto.enabled || !auto.channelId) return;
      if (Date.now() < auto.lastPostAt + auto.intervalMinutes * 60 * 1000) return;

      const item = animation.pickNext(config);
      if (!item) return;

      try {
        await animation.publish(client, auto.channelId, item);
        console.log(`ANIM MCT : animation publiée (${item.kind}).`);
      } catch (error) {
        console.error('ANIM MCT : animation non publiée :', error.message);
      }

      // Même en cas d'échec, on attend l'intervalle suivant (évite de réessayer toutes les 30 s)
      store.updateConfig(c => {
        c.auto.lastPostAt = Date.now();
        c.auto.lastMessageId = item.id;
      });
    } finally {
      ticking = false;
    }
  }

  client.once(Events.ClientReady, async ready => {
    console.log(`ANIM MCT connecté : ${ready.user.tag}`);
    ready.user.setPresence({ activities: [{ name: 'animer la communauté', type: ActivityType.Playing }], status: 'online' });
    await store.attachBackup(ready); // restaure config.json / xp.json depuis le salon Discord s'ils sont absents
    for (const guild of ready.guilds.cache.values()) await registerCommands(guild);
    setInterval(tick, 30 * 1000).unref?.();
    tick();
  });

  client.on(Events.GuildCreate, registerCommands);
  client.on(Events.InteractionCreate, interaction => commands.handle(interaction));

  // ---------- bienvenue (réglée dans le dashboard) ----------
  client.on(Events.GuildMemberAdd, async member => {
    const { welcome } = store.getConfig();
    if (!welcome.enabled || !/^\d+$/.test(welcome.channelId)) return;

    const channel = member.guild.channels.cache.get(welcome.channelId);
    if (!channel || !channel.isTextBased()) return;

    const text = welcome.message
      .replaceAll('{mention}', member.toString())
      .replaceAll('{username}', escapeMarkdown(member.user.username))
      .replaceAll('{server}', escapeMarkdown(member.guild.name));

    await channel.send({
      embeds: [new EmbedBuilder().setColor(0xe10600).setTitle('👋 Bienvenue !').setDescription(text).setTimestamp()],
      allowedMentions: { users: [member.id], roles: [], parse: [] }
    }).catch(() => {});
  });

  // ---------- XP et niveaux ----------
  const cooldowns = new Map();

  client.on(Events.MessageCreate, message => {
    if (!message.guild || message.author.bot) return;

    const { xp } = store.getConfig();
    if (!xp.enabled) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (cooldowns.get(key) || 0) < xp.cooldownSeconds * 1000) return;
    cooldowns.set(key, now);
    if (cooldowns.size > 5000) {
      for (const [k, t] of cooldowns) if (now - t > 3600 * 1000) cooldowns.delete(k);
    }

    const { user, levelled } = store.addXp(message.guild.id, message.author.id, xp.perMessage);
    if (levelled) {
      message.channel.send({
        embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('🎉 Nouveau niveau !')
          .setDescription(`Bravo ${message.author} ! Tu passes au **niveau ${user.level}**.`).setTimestamp()],
        allowedMentions: { users: [message.author.id] }
      }).catch(() => {});
    }
  });

  client.on(Events.Error, error => console.error('ANIM MCT :', error.message));

  function start() {
    const token = (process.env.ANIM_MCT_TOKEN || '').trim();
    if (!token) {
      console.warn('ANIM MCT : ANIM_MCT_TOKEN absent, le bot ANIM MCT n’est pas démarré.');
      return;
    }
    if (token === (process.env.DISCORD_TOKEN || '').trim() || token === (process.env.ADMIN_MCT_TOKEN || '').trim()) {
      console.error('ANIM MCT : ANIM_MCT_TOKEN est identique à un autre token (MCT MUSIC ou ADMIN MCT), ANIM MCT n’est pas démarré.');
      return;
    }
    client.login(token).catch(error => console.error('ANIM MCT : connexion impossible :', error.message));
  }

  return { start, handle: dashboard.handle, client };
}

module.exports = { createAnim };
