// Commandes slash d'ANIM MCT : profil, classement, quiz, sondage, défi, annonce, tirage…
// Les messages, défis et questions de quiz viennent du dashboard (/anim), donc de store.js.

const {
  SlashCommandBuilder,
  PermissionFlagsBits: P,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require('discord.js');
const store = require('./store');

const SKY = 0x38bdf8;
const GREEN = 0x57f287;
const EPHEMERAL = MessageFlags.Ephemeral;
const pick = list => list[Math.floor(Math.random() * list.length)];
const embed = (title, description, color = SKY) => new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();

const activeQuizzes = new Map(); // identifiant -> { quiz, answered: Set }

const commands = [
  {
    data: new SlashCommandBuilder().setName('aide').setDescription('Affiche les commandes du bot'),
    async run(i) {
      return i.reply({
        embeds: [embed('📚 Commandes', [
          '`/profil` niveau et XP', '`/classement` top 10', '`/quiz` quiz + XP', '`/sondage` sondage',
          '`/defi` défi', '`/bienvenue` test staff', '`/annonce` annonce staff', '`/tirage` tirage parmi une liste'
        ].join('\n'))],
        flags: EPHEMERAL
      });
    }
  },
  {
    data: new SlashCommandBuilder().setName('profil').setDescription('Affiche ton niveau et ton XP').setDMPermission(false)
      .addUserOption(o => o.setName('membre').setDescription('Membre à consulter').setRequired(false)),
    async run(i) {
      const target = i.options.getUser('membre') || i.user;
      const u = store.getUser(i.guildId, target.id);
      return i.reply({
        embeds: [embed(`👤 Profil de ${target.username}`, `**Niveau :** ${u.level}\n**XP :** ${u.xp}/${store.need(u.level)}\n**Messages comptés :** ${u.messages}`)]
      });
    }
  },
  {
    data: new SlashCommandBuilder().setName('classement').setDescription('Affiche le classement XP du serveur').setDMPermission(false),
    async run(i) {
      await i.deferReply();
      const lines = await Promise.all(store.topUsers(i.guildId, 10).map(async ([id, u], n) => {
        let name = `<@${id}>`;
        try { name = (await i.guild.members.fetch(id)).user.username; } catch {}
        return `**${n + 1}.** ${name} — niveau ${u.level}, ${u.xp} XP`;
      }));
      return i.editReply({
        embeds: [embed('🏆 Classement', lines.length ? lines.join('\n') : 'Pas encore de classement. Discute pour gagner de l’XP !')],
        allowedMentions: { parse: [] }
      });
    }
  },
  {
    data: new SlashCommandBuilder().setName('quiz').setDescription('Lance une question quiz').setDMPermission(false),
    async run(i) {
      const quiz = pick(store.getConfig().quiz.length ? store.getConfig().quiz : [null]);
      if (!quiz) return i.reply({ content: 'Aucune question de quiz n’est configurée.', flags: EPHEMERAL });

      activeQuizzes.set(i.id, { quiz, answered: new Set() });
      setTimeout(() => activeQuizzes.delete(i.id), 10 * 60 * 1000).unref?.();

      const row = new ActionRowBuilder().addComponents(...quiz.choices.map((label, n) =>
        new ButtonBuilder().setCustomId(`quiz:${i.id}:${n}`).setLabel(label.slice(0, 80)).setStyle(ButtonStyle.Primary)));
      return i.reply({ embeds: [embed('🧠 Quiz communautaire', quiz.q)], components: [row] });
    }
  },
  {
    data: new SlashCommandBuilder().setName('sondage').setDescription('Crée un sondage').setDMPermission(false)
      .addStringOption(o => o.setName('question').setDescription('Question').setMaxLength(300).setRequired(true))
      .addStringOption(o => o.setName('choix1').setDescription('Premier choix').setMaxLength(100).setRequired(true))
      .addStringOption(o => o.setName('choix2').setDescription('Deuxième choix').setMaxLength(100).setRequired(true))
      .addStringOption(o => o.setName('choix3').setDescription('Troisième choix').setMaxLength(100).setRequired(false)),
    async run(i) {
      const choices = ['choix1', 'choix2', 'choix3'].map(n => i.options.getString(n)).filter(Boolean);
      const emojis = ['1️⃣', '2️⃣', '3️⃣'];
      await i.reply({
        embeds: [embed('📊 Sondage', `${i.options.getString('question', true)}\n\n${choices.map((c, n) => `${emojis[n]} ${c}`).join('\n')}`)],
        allowedMentions: { parse: [] }
      });
      const message = await i.fetchReply();
      for (let n = 0; n < choices.length; n++) await message.react(emojis[n]).catch(() => {});
    }
  },
  {
    data: new SlashCommandBuilder().setName('defi').setDescription('Publie un défi communautaire'),
    async run(i) {
      const pool = store.getConfig().messages.filter(m => m.enabled && m.kind === 'defi');
      if (!pool.length) return i.reply({ content: 'Aucun défi actif dans le dashboard.', flags: EPHEMERAL });
      return i.reply({ embeds: [embed('🔥 Défi communautaire', pick(pool).text)] });
    }
  },
  {
    perm: P.ManageGuild,
    data: new SlashCommandBuilder().setName('bienvenue').setDescription('Publie un message de bienvenue de test')
      .setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false),
    async run(i) {
      return i.reply({ embeds: [embed('👋 Bienvenue !', `Bienvenue sur **${i.guild.name}** ! Présente-toi et participe aux animations.`)] });
    }
  },
  {
    perm: P.ManageMessages,
    data: new SlashCommandBuilder().setName('annonce').setDescription('Publie une annonce')
      .setDefaultMemberPermissions(P.ManageMessages).setDMPermission(false)
      .addStringOption(o => o.setName('message').setDescription('Texte de l’annonce').setMaxLength(2000).setRequired(true)),
    async run(i) {
      return i.reply({ embeds: [embed('📢 Annonce', i.options.getString('message', true), 0xfee75c)], allowedMentions: { parse: [] } });
    }
  },
  {
    perm: P.ManageGuild,
    data: new SlashCommandBuilder().setName('tirage').setDescription('Choisit au hasard dans une liste')
      .setDefaultMemberPermissions(P.ManageGuild).setDMPermission(false)
      .addStringOption(o => o.setName('participants').setDescription('Noms séparés par des virgules').setMaxLength(1500).setRequired(true)),
    async run(i) {
      const names = i.options.getString('participants', true).split(',').map(s => s.trim()).filter(Boolean);
      if (names.length < 2) return i.reply({ content: 'Indique au moins deux participants séparés par des virgules.', flags: EPHEMERAL });
      return i.reply({ embeds: [embed('🎁 Résultat du tirage', `Le gagnant est **${pick(names)}** !`, GREEN)], allowedMentions: { parse: [] } });
    }
  }
];

const byName = new Map(commands.map(c => [c.data.name, c]));
const definitions = commands.map(c => c.data.toJSON());

// Boutons du quiz : une seule récompense (+25 XP) par membre et par question.
async function handleButton(i) {
  const [, id, index] = i.customId.split(':');
  const entry = activeQuizzes.get(id);
  if (!entry) return i.reply({ content: 'Quiz expiré.', flags: EPHEMERAL });
  if (entry.answered.has(i.user.id)) return i.reply({ content: 'Tu as déjà répondu à ce quiz.', flags: EPHEMERAL });

  entry.answered.add(i.user.id);
  if (Number(index) !== entry.quiz.answer) return i.reply({ content: '❌ Pas cette fois ! Réessaie au prochain quiz.', flags: EPHEMERAL });

  store.addXp(i.guildId, i.user.id, 25, false);
  return i.reply({ content: '✅ Bonne réponse ! +25 XP.', flags: EPHEMERAL });
}

async function handle(i) {
  try {
    if (i.isButton() && i.customId.startsWith('quiz:')) return await handleButton(i);
    if (!i.isChatInputCommand()) return;

    const command = byName.get(i.commandName);
    if (!command) return;
    if (!i.inGuild() && command.data.name !== 'aide') {
      return await i.reply({ content: 'Cette commande fonctionne uniquement dans un serveur.', flags: EPHEMERAL });
    }
    if (command.perm && !i.memberPermissions?.has(command.perm)) {
      return await i.reply({ content: 'Tu n’as pas la permission d’utiliser cette commande.', flags: EPHEMERAL });
    }
    await command.run(i);
  } catch (error) {
    console.error(`ANIM MCT ${i.commandName || i.customId} :`, error.message);
    const body = { content: 'Une erreur est survenue. Vérifie mes permissions et réessaie.', flags: EPHEMERAL };
    if (i.deferred || i.replied) await i.followUp(body).catch(() => {});
    else await i.reply(body).catch(() => {});
  }
}

module.exports = { definitions, handle };
