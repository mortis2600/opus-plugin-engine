/**
 * core - built-in plugin.
 *
 * Hosts the /plugins admin command: list every loaded plugin and toggle it
 * on or off for this server. Protected from being disabled (it is the only
 * in-Discord way to re-enable things).
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'Core',
    description: 'Built-in plugin manager: list and toggle plugins per server.',
    version: '1.0.0',

    commands: [
        new SlashCommandBuilder()
            .setName('plugins')
            .setDescription('List plugins or toggle one on/off (Manage Server required)')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addSubcommand(sc => sc
                .setName('list')
                .setDescription('Show every loaded plugin and whether it is on'))
            .addSubcommand(sc => sc
                .setName('toggle')
                .setDescription('Turn a plugin on or off for this server')
                .addStringOption(o => o
                    .setName('plugin')
                    .setDescription('Plugin id (see /plugins list)')
                    .setRequired(true))
                .addBooleanOption(o => o
                    .setName('on')
                    .setDescription('true to enable, false to disable')
                    .setRequired(true)))
    ],

    async onInteractionCreate(interaction, client) {
        if (!interaction.isChatInputCommand() || interaction.commandName !== 'plugins') return;
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
            const lines = client.toggleablePlugins.map(p => {
                const on = client.isPluginEnabled(interaction.guildId, p.id);
                return `${on ? '🟢' : '🔴'} \`${p.id}\` — ${p.name} v${p.version}`;
            });
            const embed = new EmbedBuilder()
                .setTitle('Plugins on this server')
                .setDescription(lines.join('\n') || 'No plugins loaded.')
                .setFooter({ text: 'Toggle with /plugins toggle' });
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (sub === 'toggle') {
            const pluginId = interaction.options.getString('plugin');
            const on = interaction.options.getBoolean('on');
            try {
                const result = await client.togglePlugin(interaction.guildId, pluginId, on);
                return interaction.reply({
                    content: `✅ **${result.name}** is now ${result.enabled ? 'ON' : 'OFF'} on this server.`,
                    ephemeral: true
                });
            } catch (err) {
                const msg = err.code === 'NOT_FOUND'
                    ? `Unknown plugin id \`${pluginId}\`. See /plugins list.`
                    : err.code === 'PROTECTED'
                        ? `⛔ ${err.message}`
                        : `Could not toggle \`${pluginId}\`: ${err.message}`;
                return interaction.reply({ content: msg, ephemeral: true });
            }
        }
    }
};
