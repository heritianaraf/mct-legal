// Commandes slash d'ADMIN MCT (modération + utilitaires).
// Le bot est enregistré serveur par serveur : les commandes apparaissent tout de suite.

const {
  SlashCommandBuilder,
  PermissionFlagsBits: P,
  EmbedBuilder,
  MessageFlags
} = require('discord.js');
const store = require('./store');

const RED = 0xe10600;
const DARK_RED = 0x8a0400;

const embed = (description, color = RED) => new EmbedBuilder().setColor(color).setDescription(description);
const errorEmbed = description => embed(description, DARK_RED);
const EPHEMERAL = MessageFlags.Ephemeral;

const reasonOption = o => o.setName('raison').setDescription('Raison').setMaxLength(400).setRequired(false);
const userOption = (o, text = 'Membre concerné') => o.setName('membre').setDescription(text).setRequired(true);

// Chaque commande : définition + permission requise (revérifiée au moment de l'exécution) + exécution.
const commands = [
  {
    perm: P.KickMembers,
    data: new SlashCommandBuilder().setName('kick').setDescription('Expulser un membre du serveur')
      .setDefaultMemberPermissions(P.KickMembers).setDMPermission(false)
      .addUserOption(o => userOption(o, 'Membre à expulser')).addStringOption(reasonOption),
    async run(i) {
      const user = i.options.getUser('membre');
      const reason = i.options.getString('raison') || 'Non précisée';
      const member = await guard(i, user);
      if (!member) return;
      if (!member.kickable) return i.reply({ embeds: [errorEmbed('Impossible : mon rôle doit être au-dessus de ce membre.')], flags: EPHEMERAL });
      await member.send(`Tu as été expulsé de **${i.guild.name}** par **${i.user.tag}**.\nRaison : ${reason}`).catch(() => {});
      await member.kick(`${i.user.tag} : ${reason}`);
      return i.reply({ embeds: [embed(`**${user.tag}** a été expulsé par **${i.user.tag}**.`).addFields({ name: 'Raison', value: reason })] });
    }
  },
  {
    perm: P.BanMembers,
    data: new SlashCommandBuilder().setName('ban').setDescription('Bannir un membre du serveur')
      .setDefaultMemberPermissions(P.BanMembers).setDMPermission(false)
      .addUserOption(o => userOption(o, 'Membre à bannir')).addStringOption(reasonOption),
    async run(i) {
      const user = i.options.getUser('membre');
      const reason = i.options.getString('raison') || 'Non précisée';
      const member = await guard(i, user);
      if (!member) return;
      if (!member.bannable) return i.reply({ embeds: [errorEmbed('Impossible : mon rôle doit être au-dessus de ce membre.')], flags: EPHEMERAL });
      await member.send(`Tu as été banni de **${i.guild.name}** par **${i.user.tag}**.\nRaison : ${reason}`).catch(() => {});
      await member.ban({ reason: `${i.user.tag} : ${reason}` });
      return i.reply({ embeds: [embed(`**${user.tag}** a été banni par **${i.user.tag}**.`).addFields({ name: 'Raison', value: reason })] });
    }
  },
  {
    perm: P.BanMembers,
    data: new SlashCommandBuilder().setName('hackban').setDescription('Bannir un utilisateur par son identifiant, même absent du serveur')
      .setDefaultMemberPermissions(P.BanMembers).setDMPermission(false)
      .addStringOption(o => o.setName('identifiant').setDescription('Identifiant Discord de l’utilisateur').setRequired(true))
      .addStringOption(reasonOption),
    async run(i) {
      const id = i.options.getString('identifiant').trim();
      const reason = i.options.getString('raison') || 'Non précisée';
      if (!/^\d{15,25}$/.test(id)) return i.reply({ embeds: [errorEmbed('Identifiant invalide.')], flags: EPHEMERAL });
      if (id === i.user.id || id === i.client.user.id) return i.reply({ embeds: [errorEmbed('Action impossible sur cet utilisateur.')], flags: EPHEMERAL });
      try {
        await i.guild.members.ban(id, { reason: `${i.user.tag} : ${reason}` });
      } catch {
        return i.reply({ embeds: [errorEmbed('Bannissement impossible : vérifie l’identifiant et mes permissions.')], flags: EPHEMERAL });
      }
      return i.reply({ embeds: [embed(`L’utilisateur **${id}** a été banni par **${i.user.tag}**.`).addFields({ name: 'Raison', value: reason })] });
    }
  },
  {
    perm: P.ManageNicknames,
    data: new SlashCommandBuilder().setName('nick').setDescription('Changer le pseudo d’un membre')
      .setDefaultMemberPermissions(P.ManageNicknames).setDMPermission(false)
      .addUserOption(o => userOption(o))
      .addStringOption(o => o.setName('pseudo').setDescription('Nouveau pseudo (vide : le retirer)').setMaxLength(32).setRequired(false)),
    async run(i) {
      const user = i.options.getUser('membre');
      const nick = i.options.getString('pseudo');
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (!member) return i.reply({ embeds: [errorEmbed('Membre introuvable sur ce serveur.')], flags: EPHEMERAL });
      if (!member.manageable) return i.reply({ embeds: [errorEmbed('Impossible : mon rôle doit être au-dessus de ce membre.')], flags: EPHEMERAL });
      await member.setNickname(nick || null, `Par ${i.user.tag}`);
      return i.reply({ embeds: [embed(nick ? `Le pseudo de **${user.tag}** est maintenant **${nick}**.` : `Le pseudo de **${user.tag}** a été réinitialisé.`)] });
    }
  },
  {
    perm: P.ManageMessages,
    data: new SlashCommandBuilder().setName('warning').setDescription('Gérer les avertissements d’un membre')
      .setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
      .addSubcommand(s => s.setName('ajouter').setDescription('Ajouter un avertissement')
        .addUserOption(o => userOption(o)).addStringOption(reasonOption))
      .addSubcommand(s => s.setName('retirer').setDescription('Retirer un avertissement')
        .addUserOption(o => userOption(o))
        .addIntegerOption(o => o.setName('numero').setDescription('Numéro de l’avertissement').setMinValue(1).setRequired(true)))
      .addSubcommand(s => s.setName('liste').setDescription('Afficher les avertissements d’un membre')
        .addUserOption(o => userOption(o))),
    async run(i) {
      const sub = i.options.getSubcommand();
      const user = i.options.getUser('membre');

      if (sub === 'ajouter') {
        const reason = i.options.getString('raison') || 'Non précisée';
        const { id, total } = store.addWarn(i.guild.id, user.id, i.user.id, reason);
        await i.reply({ embeds: [embed(`**${user.tag}** a reçu un avertissement de **${i.user.tag}** (n°${id}).\nTotal : ${total}`).addFields({ name: 'Raison', value: reason })] });
        const sent = await user.send(`Tu as reçu un avertissement de **${i.user.tag}** sur **${i.guild.name}**.\nRaison : ${reason}`).then(() => true, () => false);
        if (!sent) await i.followUp({ content: `${user}, tu as reçu un avertissement de **${i.user.tag}**.\nRaison : ${reason}`, allowedMentions: { users: [user.id] } });
        return;
      }

      if (sub === 'retirer') {
        const number = i.options.getInteger('numero');
        const { removed, total } = store.removeWarn(i.guild.id, user.id, number);
        if (!removed) return i.reply({ embeds: [errorEmbed(`Aucun avertissement n°${number} pour **${user.tag}**.`)], flags: EPHEMERAL });
        return i.reply({ embeds: [embed(`Avertissement **n°${number}** retiré à **${user.tag}**.\nTotal : ${total}`)] });
      }

      const warns = store.listWarns(i.guild.id, user.id);
      const lines = warns.slice(-20).map(w => `• Par <@${w.moderatorId}> : **${w.reason}** (<t:${w.createdAt}>) — n°${w.id}`);
      return i.reply({
        embeds: [new EmbedBuilder().setColor(RED).setTitle(`Avertissements de ${user.tag}`).setDescription(lines.join('\n') || 'Aucun avertissement.')],
        allowedMentions: { parse: [] }
      });
    }
  },
  {
    perm: P.ManageMessages,
    data: new SlashCommandBuilder().setName('purge').setDescription('Supprimer des messages dans ce salon')
      .setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
      .addIntegerOption(o => o.setName('nombre').setDescription('Nombre de messages (1 à 100)').setMinValue(1).setMaxValue(100).setRequired(true)),
    async run(i) {
      await i.deferReply({ flags: EPHEMERAL });
      const deleted = await i.channel.bulkDelete(i.options.getInteger('nombre'), true).catch(() => null);
      if (!deleted) return i.editReply({ embeds: [errorEmbed('Suppression impossible : vérifie mes permissions dans ce salon.')] });
      await i.editReply({ embeds: [embed(`**${deleted.size}** message(s) supprimé(s). Les messages de plus de 14 jours ne peuvent pas l’être.`)] });
      return i.channel.send({ embeds: [embed(`**${i.user.tag}** a supprimé **${deleted.size}** message(s).`)] }).catch(() => {});
    }
  },
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Vérifier que le bot répond'),
    async run(i) {
      return i.reply({ embeds: [embed(`🏓 Pong ! Latence : **${Math.round(i.client.ws.ping)} ms**.`)] });
    }
  },
  {
    data: new SlashCommandBuilder().setName('serverinfo').setDescription('Informations sur le serveur').setDMPermission(false),
    async run(i) {
      const g = i.guild;
      const e = new EmbedBuilder().setColor(RED).setTitle(g.name)
        .addFields(
          { name: 'Identifiant', value: g.id, inline: true },
          { name: 'Membres', value: String(g.memberCount), inline: true },
          { name: 'Salons', value: String(g.channels.cache.size), inline: true },
          { name: 'Rôles', value: String(g.roles.cache.size), inline: true }
        )
        .setFooter({ text: `Créé le ${g.createdAt.toLocaleDateString('fr-FR')}` });
      if (g.iconURL()) e.setThumbnail(g.iconURL());
      return i.reply({ embeds: [e] });
    }
  },
  {
    perm: P.Administrator,
    data: new SlashCommandBuilder().setName('say').setDescription('Faire parler le bot')
      .setDefaultMemberPermissions(P.Administrator).setDMPermission(false)
      .addStringOption(o => o.setName('message').setDescription('Message à envoyer').setMaxLength(2000).setRequired(true))
      .addBooleanOption(o => o.setName('embed').setDescription('Envoyer dans un encadré').setRequired(false)),
    async run(i) {
      const text = i.options.getString('message');
      await i.reply({ content: 'Envoyé.', flags: EPHEMERAL });
      const payload = i.options.getBoolean('embed') ? { embeds: [embed(text)] } : { content: text };
      return i.channel.send({ ...payload, allowedMentions: { parse: [] } });
    }
  }
];

// Le bot doit être au-dessus de la cible, qui ne peut être ni toi, ni lui-même, ni un administrateur.
async function guard(i, user) {
  if (user.id === i.user.id || user.id === i.client.user.id) {
    await i.reply({ embeds: [errorEmbed('Action impossible sur cet utilisateur.')], flags: EPHEMERAL });
    return null;
  }
  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await i.reply({ embeds: [errorEmbed('Membre introuvable sur ce serveur.')], flags: EPHEMERAL });
    return null;
  }
  if (member.permissions.has(P.Administrator)) {
    await i.reply({ embeds: [errorEmbed('Ce membre a la permission Administrateur.')], flags: EPHEMERAL });
    return null;
  }
  return member;
}

const byName = new Map(commands.map(c => [c.data.name, c]));
const definitions = commands.map(c => c.data.toJSON());

async function handle(i) {
  const command = byName.get(i.commandName);
  if (!command) return;

  try {
    if (!i.inGuild() && command.data.name !== 'ping') {
      return await i.reply({ content: 'Cette commande fonctionne uniquement dans un serveur.', flags: EPHEMERAL });
    }
    if (command.perm && !i.memberPermissions?.has(command.perm)) {
      return await i.reply({ embeds: [errorEmbed('Tu n’as pas la permission d’utiliser cette commande.')], flags: EPHEMERAL });
    }
    await command.run(i);
  } catch (error) {
    console.error(`ADMIN MCT /${i.commandName} :`, error.message);
    const body = { embeds: [errorEmbed('Une erreur est survenue. Vérifie mes permissions et réessaie.')], flags: EPHEMERAL };
    if (i.deferred || i.replied) await i.followUp(body).catch(() => {});
    else await i.reply(body).catch(() => {});
  }
}

module.exports = { definitions, handle };
