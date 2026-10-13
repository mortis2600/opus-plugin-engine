/**
 * hello-world - example plugin.
 *
 * Demonstrates the three ways a plugin talks to the engine:
 *   1. commands[] + onInteractionCreate -> slash command routing
 *   2. onMessageCreate                 -> message broadcast
 *   3. buttons via onInteractionCreate  -> component circuit breaker
 *
 * Copy this file as the starting point for your own plugin.
 */
const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const BTN_ID = 'hello-world:wave-back';

module.exports = {
    name: 'Hello World',
    description: 'Example plugin: says hello three different ways.',
    version: '1.0.0',

    commands: [
        new SlashCommandBuilder()
            .setName('hello')
            .setDescription('Say hello, with an optional name and a button demo')
            .addStringOption(o => o
                .setName('name')
                .setDescription('Who should the bot greet?')
                .setRequired(false))
            .addBooleanOption(o => o
                .setName('button')
                .setDescription('Attach a wave-back button?')
                .setRequired(false))
    ],

    // 1. SLASH COMMAND: the router hands us only interactions for our commands.
    async onInteractionCreate(interaction, client, db) {
        if (interaction.isChatInputCommand() && interaction.commandName === 'hello') {
            const name = interaction.options.getString('name') || interaction.user.displayName;
            const withButton = interaction.options.getBoolean('button') || false;
            const reply = { content: `👋 Hello, **${name}**! This greeting came from the \`hello-world\` plugin.` };
            if (withButton) {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(BTN_ID)
                        .setLabel('Wave back')
                        .setStyle(ButtonStyle.Primary)
                        .setEmoji('👋')
                );
                reply.components = [row];
            }
            return interaction.reply(reply);
        }

        // 3. COMPONENT: the circuit breaker broadcasts button clicks to every
        //    enabled plugin until one answers. We only answer our own button.
        if (interaction.isButton() && interaction.customId === BTN_ID) {
            return interaction.reply({
                content: `👋 *waves back at ${interaction.user.displayName}*`,
                ephemeral: true
            });
        }
    },

    // 2. MESSAGE BROADCAST: the engine calls this for every non-bot message.
    //    Keep it cheap and never throw; the router already wraps it, but a
    //    quiet plugin is a polite plugin.
    async onMessageCreate(message, client, db) {
        if (message.content.trim().toLowerCase() === 'hello opus') {
            await message.reply('👋 Hello! I am running on the Opus plugin engine. Try `/hello` too.');
        }
    }
};
