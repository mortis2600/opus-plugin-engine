# Opus Plugin Engine

The open-source core of the [Opus](https://github.com/mortis2600) Discord bot: a minimal plugin engine in a single `index.js`, plus a hello-world example plugin. Everything the paid, multi-tenant Opus service adds on top (per-guild billing tiers, entitlements, the web control panel, 40+ production plugins) stays closed source; this repo is the architecture, stripped to its bones.

## How it works

- **Plugin loading** — every `plugins/*.js` file is one plugin; the plugin id is the filename. `plugin-registry.json` is the single source of truth for plugin metadata (name, description, version).
- **O(1) slash-command routing** — commands are mapped by name straight to their owning plugin. No broadcast, no guessing.
- **Event broadcasting** — `onMessageCreate` and `onInteractionCreate` go to every enabled plugin (buttons/modals use a circuit breaker: the first plugin that answers wins). Any other exported `on<Event>` function (e.g. `onMessageDelete`) is auto-bound to the matching Discord.js event.
- **Per-guild isolation** — each server gets its own SQLite database (`data/dbs/<guildId>.db`) holding that server's plugin on/off state. Slash commands are pushed per guild, only for enabled plugins.
- **Zero-cost disabled plugins** — a disabled plugin is skipped before it ever sees an event.
- **Crash isolation** — one plugin throwing never takes down the router or the other plugins.

## Quick start

```bash
npm install
cp .env.example .env   # then paste your bot token
node index.js
```

Invite the bot to a server (needs the `bot` and `applications.commands` scopes). It pushes its commands on join.

Try it:

- `/hello` — slash command from the hello-world plugin
- `/hello button:True` — attaches a "Wave back" button (component routing demo)
- `hello opus` — plain message, answered by the message broadcast
- `/plugins list` — every loaded plugin and its on/off state (Manage Server only)
- `/plugins toggle plugin:hello-world on:False` — turn a plugin off; its commands vanish from Discord
- `!opus-ping` — engine heartbeat

## Writing a plugin

Create `plugins/my-plugin.js`:

```js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    name: 'My Plugin',
    description: 'What it does',
    version: '1.0.0',

    // Slash commands (optional). The router calls onInteractionCreate only
    // for interactions belonging to these commands.
    commands: [
        new SlashCommandBuilder()
            .setName('mycommand')
            .setDescription('Does the thing')
    ],

    // Runs once when the engine boots, for engine-level registration.
    // Per-guild tables go in a lazy ensureTables() you call yourself.
    init(client, db) {},

    // Slash commands, buttons, modals, select menus, autocomplete.
    async onInteractionCreate(interaction, client, db) {
        if (interaction.isChatInputCommand() && interaction.commandName === 'mycommand') {
            return interaction.reply('It works.');
        }
    },

    // Every non-bot message in every guild where the plugin is enabled.
    async onMessageCreate(message, client, db) {},

    // Any other discord.js event: export on<EventName>.
    async onMessageDelete(message, client, db) {},
};
```

Then add it to `plugin-registry.json` and restart. The engine seeds it ON for every guild.

`client` exposes the engine to plugins: `client.isPluginEnabled(guildId, pluginId)`, `client.togglePlugin(guildId, pluginId, enabled)`, `client.getGuildDb(guildId)`, `client.plugins`, `client.toggleablePlugins`.

## Project layout

```
index.js              # the engine: loader, router, event binding, per-guild DBs
plugins/
  core.js             # built-in /plugins admin command (protected, cannot be disabled)
  hello-world.js      # example plugin: slash command + button + message listener
plugin-registry.json  # plugin metadata registry
```

## License

MIT. See [LICENSE](LICENSE).
