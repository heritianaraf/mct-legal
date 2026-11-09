// Publication des messages d'animation (utilisée par le planificateur et par le dashboard).

const { EmbedBuilder } = require('discord.js');

const SKY = 0x38bdf8;
const KINDS = { question: 'Question du jour', defi: 'Défi', custom: 'Message libre' };
const TITLES = { question: '❓ Question du jour', defi: '🎯 Défi du jour', custom: '✨ Animation communautaire' };

const buildEmbed = item => new EmbedBuilder()
  .setColor(SKY)
  .setTitle((item.kind === 'custom' && item.title) || TITLES[item.kind] || TITLES.custom)
  .setDescription(item.text)
  .setTimestamp();

// Au hasard parmi les messages actifs, sans répéter deux fois de suite le même.
function pickNext(config) {
  const pool = config.messages.filter(m => m.enabled);
  const fresh = pool.length > 1 ? pool.filter(m => m.id !== config.auto.lastMessageId) : pool;
  return fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : null;
}

// Seulement un salon textuel d'un serveur où le bot est présent.
async function resolveChannel(client, id) {
  if (!/^\d{1,25}$/.test(String(id || ''))) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  if (!channel || !channel.guild || !channel.isTextBased() || channel.isThread() || channel.isVoiceBased()
    || !client.guilds.cache.has(channel.guild.id)) return null;
  return channel;
}

async function publish(client, channelId, item) {
  const channel = await resolveChannel(client, channelId);
  if (!channel) throw Object.assign(new Error('Salon introuvable ou inaccessible au bot.'), { status: 400 });
  await channel.send({ embeds: [buildEmbed(item)], allowedMentions: { parse: [] } });
  return channel;
}

module.exports = { KINDS, buildEmbed, pickNext, resolveChannel, publish };
