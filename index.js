/**
 * Opus Plugin Engine (open-source core)
 *
 * A stripped-down, single-file Discord bot core that demonstrates the Opus
 * plugin architecture:
 *
 *  - Plugins live in ./plugins/*.js and are loaded by filename (plugin id).
 *  - plugin-registry.json is the single source of truth for plugin metadata.
 *  - Slash commands route through an O(1) command map straight to the owning plugin.
 *  - Any exported `on<Event>` function (e.g. onMessageDelete) is auto-bound to
 *    the matching Discord.js event.
 *  - onMessageCreate / onInteractionCreate are broadcast to every enabled plugin.
 *  - Each guild gets its own SQLite database (data/dbs/<guildId>.db) holding
 *    per-guild plugin on/off state. No shared state, no billing, no tiers.
 *
 * A plugin is just a module.exports object:
 *
 *   module.exports = {
 *     name: 'My Plugin',
 *     description: 'What it does',
 *     version: '1.0.0',
 *     commands: [ new SlashCommandBuilder()... ],  // optional
 *     init(client, db) {},                          // optional, runs once
 *     onInteractionCreate(interaction, client, db) {}, // optional
 *     onMessageCreate(message, client, db) {},         // optional
 *     onMessageDelete(message, client, db) {},          // optional, any event
 *   };
 *
 * Copy this file, drop plugins into ./plugins, set DISCORD_TOKEN, run it.
 */

const { Client, GatewayIntentBits, Partials, Events, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ==========================================
//   PLUGIN REGISTRY (single source of truth)
// ==========================================
let REGISTRY_META = {}; // pluginId -> { name, description, version, category }
try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'plugin-registry.json'), 'utf8'));
    for (const entry of reg) {
        if (entry && entry.id) {
            REGISTRY_META[entry.id] = {
                name: entry.name,
                description: entry.description,
                version: entry.version,
                category: entry.category
            };
        }
    }
    console.log(`Registry loaded: ${Object.keys(REGISTRY_META).length} plugin(s)`);
} catch (err) {
    console.error('Could not load plugin-registry.json:', err.message);
}

// ==========================================
//   DISCORD CLIENT
// ==========================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// ==========================================
//   PER-GUILD SQLITE FACTORY
// ==========================================
const dataDir = path.join(__dirname, 'data');
const dbDir = path.join(dataDir, 'dbs');
for (const dir of [dataDir, dbDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const dbPool = new Map();          // guildId -> Database
const enabledCache = new Map();    // guildId -> Set<pluginId>
const initializedGuilds = new Set();
const globalInitComplete = new Set();

function ensurePluginStateTable(db) {
    db.prepare(`CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id  TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
    )`).run();
}

function refreshEnabledCache(guildId, db) {
    const rows = db.prepare('SELECT plugin_id FROM plugin_state WHERE enabled = 1').all();
    enabledCache.set(guildId, new Set(rows.map(r => r.plugin_id)));
}

function seedPluginState(guildId, db) {
    ensurePluginStateTable(db);
    // Backfill defaults for plugins added after this guild's DB was created.
    // INSERT OR IGNORE keeps it idempotent; every plugin defaults ON.
    const existing = new Set(db.prepare('SELECT plugin_id FROM plugin_state').all().map(r => r.plugin_id));
    const now = Date.now();
    const ins = db.prepare('INSERT OR IGNORE INTO plugin_state (plugin_id, enabled, updated_at) VALUES (?, ?, ?)');
    let inserted = 0;
    for (const plugin of toggleablePlugins) {
        if (existing.has(plugin.id)) continue;
        ins.run(plugin.id, 1, now);
        inserted++;
    }
    if (inserted > 0) console.log(`Seeded ${inserted} plugin_state default(s) for guild ${guildId}`);
    refreshEnabledCache(guildId, db);
}

function getGuildDb(guildId) {
    if (!guildId) return null;
    if (dbPool.has(guildId)) return dbPool.get(guildId);

    const db = new Database(path.join(dbDir, `${guildId}.db`));
    dbPool.set(guildId, db);
    seedPluginState(guildId, db);

    if (!initializedGuilds.has(guildId)) {
        for (const plugin of plugins) {
            // init() runs ONCE globally for engine registration, never per guild.
            if (typeof plugin.init === 'function' && !globalInitComplete.has(plugin)) {
                try {
                    plugin.init(client, db);
                    globalInitComplete.add(plugin);
                } catch (err) {
                    console.error(`Init error (${plugin.name}) on guild ${guildId}:`, err.message);
                }
            }
        }
        initializedGuilds.add(guildId);
    }
    return db;
}

// ==========================================
//   ENABLEMENT (per-guild on/off)
// ==========================================
function isPluginEnabled(guildId, pluginId) {
    if (!guildId) return true; // DM context: allow
    const set = enabledCache.get(guildId);
    if (!set) return true;
    return set.has(pluginId);
}

function invalidatePluginCache(guildId) {
    enabledCache.delete(guildId);
    const db = dbPool.get(guildId);
    if (db) refreshEnabledCache(guildId, db);
}

/**
 * Single shared write path for toggling a plugin. The built-in `core`
 * plugin is protected because it hosts the /plugins admin command itself.
 */
async function togglePlugin(guildId, pluginId, enabled) {
    const plugin = toggleablePlugins.find(p => p.id === pluginId);
    if (!plugin) {
        const err = new Error(`Unknown plugin id: ${pluginId}`);
        err.code = 'NOT_FOUND';
        throw err;
    }
    if (pluginId === 'core' && !enabled) {
        const err = new Error('The core plugin cannot be disabled: it hosts /plugins itself.');
        err.code = 'PROTECTED';
        throw err;
    }
    const db = getGuildDb(guildId);
    db.prepare(`INSERT INTO plugin_state (plugin_id, enabled, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
        .run(pluginId, enabled ? 1 : 0, Date.now());
    invalidatePluginCache(guildId);
    await pushGuildCommands(guildId);
    return { pluginId, enabled: !!enabled, name: plugin.name };
}

// ==========================================
//   PLUGIN LOADER & O(1) ROUTE MAPPER
// ==========================================
const plugins = [];
const toggleablePlugins = [];
const commandMap = new Map(); // command name -> owning plugin
const pluginsPath = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath);

for (const file of fs.readdirSync(pluginsPath)) {
    if (!file.endsWith('.js')) continue;
    const id = file.slice(0, -3); // plugin id = filename without .js
    try {
        const plugin = require(path.join(pluginsPath, file));
        if (!plugin || typeof plugin !== 'object') {
            console.warn(`Skipping ${file}: no module.exports object`);
            continue;
        }
        plugin.id = plugin.id || id;
        const meta = REGISTRY_META[plugin.id] || {};
        plugin.name = plugin.name || meta.name || plugin.id;
        plugin.description = plugin.description || meta.description || '';
        plugin.version = plugin.version || meta.version || '1.0.0';
        plugins.push(plugin);
        toggleablePlugins.push(plugin);

        if (Array.isArray(plugin.commands)) {
            for (const cmd of plugin.commands) {
                commandMap.set(cmd.toJSON().name, plugin);
            }
        }

        // Dynamic event binding: any exported on<Event> function is wired to
        // the matching discord.js event (onMessageDelete -> messageDelete).
        for (const [key, fn] of Object.entries(plugin)) {
            if (!key.startsWith('on') || typeof fn !== 'function') continue;
            if (['onInteractionCreate', 'onMessageCreate'].includes(key)) continue; // broadcast separately
            const eventName = key.charAt(2).toLowerCase() + key.slice(3);
            client.on(eventName, async (...args) => {
                try {
                    let guildId = null;
                    if (args[0]?.guildId) guildId = args[0].guildId;
                    else if (args[0]?.guild?.id) guildId = args[0].guild.id;
                    if (guildId && !isPluginEnabled(guildId, plugin.id)) return; // disabled = zero cost
                    const db = getGuildDb(guildId);
                    await fn(...args, client, db);
                } catch (err) {
                    console.error(`[Router] Plugin '${plugin.name}' crashed during ${eventName}:`, err.message);
                }
            });
        }

        console.log(`Loaded plugin: ${plugin.name} v${plugin.version}`);
    } catch (err) {
        console.error(`Failed to load plugin ${file}:`, err.message);
    }
}

// ==========================================
//   PER-GUILD COMMAND BUILD + PUSH
// ==========================================
function buildGuildCommands(guildId) {
    const out = [];
    for (const plugin of toggleablePlugins) {
        if (!Array.isArray(plugin.commands)) continue;
        if (!isPluginEnabled(guildId, plugin.id)) continue; // only enabled plugins get commands
        for (const cmd of plugin.commands) {
            const json = cmd.toJSON();
            out.push(json);
            commandMap.set(json.name, plugin); // keep the router map warm
        }
    }
    return out;
}

async function pushGuildCommands(guildId) {
    if (!client.user) return;
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const body = buildGuildCommands(guildId);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
}

// Expose engine helpers to plugins.
client.plugins = plugins;
client.toggleablePlugins = toggleablePlugins;
client.isPluginEnabled = isPluginEnabled;
client.togglePlugin = togglePlugin;
client.getGuildDb = getGuildDb;
client.buildGuildCommands = buildGuildCommands;
client.pushGuildCommands = pushGuildCommands;

// ==========================================
//   CORE EVENT ROUTING
// ==========================================
client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}`);
    for (const [guildId, guild] of client.guilds.cache) {
        try {
            getGuildDb(guildId); // seeds plugin_state defaults + warms cache
            await pushGuildCommands(guildId);
            console.log(`Commands pushed to: ${guild.name}`);
        } catch (err) {
            console.error(`Failed to push commands to ${guild.name}:`, err.message);
        }
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.content === '!opus-ping') {
        return message.reply('Pong! The plugin engine is alive.');
    }
    if (message.author.bot || !message.guild) return;
    const db = getGuildDb(message.guild.id);
    // Broadcast to every enabled plugin; one plugin's crash never kills the rest.
    for (const plugin of plugins) {
        if (!isPluginEnabled(message.guild.id, plugin.id)) continue;
        if (typeof plugin.onMessageCreate === 'function') {
            try {
                await plugin.onMessageCreate(message, client, db);
            } catch (err) {
                console.error(`[Router] Plugin '${plugin.name}' crashed during MessageCreate:`, err.message);
            }
        }
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.guildId) return;
    const db = getGuildDb(interaction.guildId);

    // 1. O(1) TARGETED ROUTING for slash commands, context menus, autocomplete.
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand() || interaction.isAutocomplete()) {
        const targetPlugin = commandMap.get(interaction.commandName);
        if (targetPlugin && typeof targetPlugin.onInteractionCreate === 'function') {
            if (!isPluginEnabled(interaction.guildId, targetPlugin.id)) {
                const msg = `The **${targetPlugin.name}** plugin is disabled on this server. An admin can re-enable it with \`/plugins\`.`;
                try {
                    if (interaction.isAutocomplete()) await interaction.respond([]);
                    else if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, ephemeral: true });
                    else await interaction.reply({ content: msg, ephemeral: true });
                } catch (e) { /* never crash the router */ }
                return;
            }
            try {
                await targetPlugin.onInteractionCreate(interaction, client, db);
            } catch (err) {
                if (err.code === 10062 || err.message === 'Unknown interaction') return; // expired token, ignore
                console.error(`[Router] Plugin '${targetPlugin.name}' crashed:`, err.stack || err.message);
            }
        }
        return; // handled (or unknown command): stop here.
    }

    // 2. COMPONENT CIRCUIT BREAKER: buttons, modals, select menus. The first
    //    plugin that answers the interaction wins; the rest are skipped.
    for (const plugin of plugins) {
        if (!isPluginEnabled(interaction.guildId, plugin.id)) continue;
        if (typeof plugin.onInteractionCreate === 'function') {
            try {
                await plugin.onInteractionCreate(interaction, client, db);
                if (interaction.replied || interaction.deferred) break;
            } catch (err) {
                if (err.code === 10062 || err.message === 'Unknown interaction') continue;
                console.error(`[Router] Plugin '${plugin.name}' crashed:`, err.stack || err.message);
            }
        }
    }
});

client.on(Events.GuildCreate, async (guild) => {
    console.log(`Joined new server: ${guild.name}`);
    getGuildDb(guild.id); // seeds plugin_state defaults
    try {
        await pushGuildCommands(guild.id);
    } catch (err) {
        console.error(`Failed to push commands to ${guild.name}:`, err.message);
    }
});

if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.');
    process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);

module.exports = {
    client,
    plugins,
    toggleablePlugins,
    commandMap,
    isPluginEnabled,
    togglePlugin,
    getGuildDb,
    buildGuildCommands,
    pushGuildCommands
};
