const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

console.log("TOKEN exists:", !!process.env.TOKEN);
console.log("CLIENT_ID exists:", !!process.env.CLIENT_ID);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

let db;

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

async function initDB() {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  });

  await db.run(`
    CREATE TABLE IF NOT EXISTS guilds (
      guildId TEXT PRIMARY KEY,
      memberRoleId TEXT,
      warnTriggerRoleId TEXT,
      requiredMemberTimeMs INTEGER DEFAULT 1209600000,
      embedColor INTEGER DEFAULT 65280
    )
  `);

  await db.run(`
    CREATE TABLE IF NOT EXISTS members (
      guildId TEXT,
      userId TEXT,
      joinedAt INTEGER,
      processed INTEGER DEFAULT 0,
      blacklisted INTEGER DEFAULT 0,
      PRIMARY KEY (guildId, userId)
    )
  `);

  console.log('Database ready');
}

function embed(title, description, color = 0x00ff00) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description);
}

function parseTime(input) {
  const match = input.toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
  }
}

async function getGuildConfig(guildId) {
  if (!db) return {};

  const config = await db.get(
    `SELECT * FROM guilds WHERE guildId = ?`,
    [guildId]
  );

  return config || {};
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),

  new SlashCommandBuilder()
    .setName('setembedcolor')
    .setDescription('Set embed color')
    .addStringOption(o =>
      o.setName('color')
        .setDescription('#ff0000 hex color')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setmemberrole')
    .setDescription('Set member role')
    .addRoleOption(o =>
      o.setName('role')
        .setDescription('Role')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setmembertime')
    .setDescription('Set required time')
    .addStringOption(o =>
      o.setName('time')
        .setDescription('10m, 2h, 3d')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('scanmembers')
    .setDescription('Scan all members'),

  new SlashCommandBuilder()
    .setName('memberstats')
    .setDescription('Show stats')
].map(c => c.toJSON());

async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log('Deploying slash commands...');

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log('Slash commands deployed');
  } catch (err) {
    console.error(err);
  }
}

client.on('guildMemberAdd', async member => {
  if (!db) return;
  if (member.user.bot) return;

  await db.run(
    `INSERT OR IGNORE INTO members
     (guildId, userId, joinedAt, processed, blacklisted)
     VALUES (?, ?, ?, 0, 0)`,
    [member.guild.id, member.id, member.joinedAt?.getTime() || Date.now()]
  );
});

client.on('interactionCreate', async interaction => {
  if (!db) return;
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guild.id;
  const config = await getGuildConfig(guildId);
  const color = config.embedColor || 0x00ff00;

  if (interaction.commandName === 'ping') {
    return interaction.reply({
      embeds: [embed('Pong', `Latency: ${Date.now() - interaction.createdTimestamp}ms`, color)]
    });
  }

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: 'No permission', ephemeral: true });
  }

  if (interaction.commandName === 'setembedcolor') {
    const input = interaction.options.getString('color');
    const hex = input.replace('#', '');
    const parsed = parseInt(hex, 16);

    if (isNaN(parsed)) {
      return interaction.reply({ content: 'Invalid hex color', ephemeral: true });
    }

    await db.run(
      `INSERT INTO guilds (guildId, embedColor)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET embedColor=excluded.embedColor`,
      [guildId, parsed]
    );

    return interaction.reply({
      embeds: [embed('Updated', `Embed color set to #${hex}`, parsed)]
    });
  }

  if (interaction.commandName === 'setmemberrole') {
    const role = interaction.options.getRole('role');

    await db.run(
      `INSERT INTO guilds (guildId, memberRoleId)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET memberRoleId=excluded.memberRoleId`,
      [guildId, role.id]
    );

    return interaction.reply({
      embeds: [embed('Updated', 'Member role set', color)]
    });
  }

  if (interaction.commandName === 'setmembertime') {
    const ms = parseTime(interaction.options.getString('time'));

    if (!ms) {
      return interaction.reply({ content: 'Invalid time format', ephemeral: true });
    }

    await db.run(
      `INSERT INTO guilds (guildId, requiredMemberTimeMs)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET requiredMemberTimeMs=excluded.requiredMemberTimeMs`,
      [guildId, ms]
    );

    return interaction.reply({
      embeds: [embed('Updated', 'Time set', color)]
    });
  }

  if (interaction.commandName === 'scanmembers') {
    await interaction.deferReply();

    const members = await interaction.guild.members.fetch();
    let added = 0;

    for (const m of members.values()) {
      if (m.user.bot) continue;

      const res = await db.run(
        `INSERT OR IGNORE INTO members
         (guildId, userId, joinedAt, processed, blacklisted)
         VALUES (?, ?, ?, 0, 0)`,
        [guildId, m.id, m.joinedAt?.getTime() || Date.now()]
      );

      if (res.changes > 0) added++;
    }

    return interaction.editReply({
      embeds: [embed('Scan Complete', `Added ${added} members`, color)]
    });
  }

  if (interaction.commandName === 'memberstats') {
    const total = await db.get(`SELECT COUNT(*) c FROM members WHERE guildId=?`, [guildId]);
    const processed = await db.get(`SELECT COUNT(*) c FROM members WHERE guildId=? AND processed=1`, [guildId]);
    const pending = await db.get(`SELECT COUNT(*) c FROM members WHERE guildId=? AND processed=0`, [guildId]);

    return interaction.reply({
      embeds: [
        embed(
          'Stats',
          `Total: ${total.c}\nProcessed: ${processed.c}\nPending: ${pending.c}`,
          color
        )
      ]
    });
  }
});

(async () => {
  await initDB();
  await deployCommands();
  await client.login(process.env.TOKEN);
})();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});