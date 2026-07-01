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

console.log('TOKEN exists:', !!process.env.TOKEN);
console.log('CLIENT_ID exists:', !!process.env.CLIENT_ID);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DYNO_ID = '155149108183695360';
const DEFAULT_REQUIRED_MEMBER_TIME_MS = 1209600000;

let db;
const verificationTimers = new Map();

process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

function getTimerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function scheduleVerification(guildId, userId) {
  if (!db || !guildId || !userId) return;

  try {
    const key = getTimerKey(guildId, userId);

    // Cancel existing timer if any
    cancelVerification(guildId, userId);

    const record = await getMemberRecord(guildId, userId);
    if (!record) return;

    const config = await getGuildConfig(guildId);
    const joinedAtValue = Number(record.joinedAt || Date.now());
    const requiredTimeMs = Number(config.requiredMemberTimeMs ?? DEFAULT_REQUIRED_MEMBER_TIME_MS);
    const verificationTime = joinedAtValue + requiredTimeMs;
    const timeUntilVerification = verificationTime - Date.now();

    const resolveGuild = async () => {
      return await client.guilds.fetch(guildId).catch(() => null);
    };

    if (timeUntilVerification <= 0) {
      // Member should already be verified, run immediately
      const guild = await resolveGuild();
      if (guild) {
        await verifyMember(guild, userId);
      }
    } else {
      // Schedule verification for future time
      const timerId = setTimeout(async () => {
        try {
          console.log('Timer fired for', guildId, userId);
          const guild = await resolveGuild();
          if (guild) {
            console.log('Calling verifyMember for', guildId, userId);
            const result = await verifyMember(guild, userId);
            console.log('verifyMember returned for', guildId, userId, result);
          }
        } catch (err) {
          console.error('Scheduled verification error:', err);
        }
        verificationTimers.delete(key);
      }, timeUntilVerification);

      verificationTimers.set(key, timerId);
      console.log(`Scheduled verification for ${userId} in ${guildId} at ${new Date(verificationTime).toISOString()}`);
    }
  } catch (err) {
    console.error('Schedule verification error:', err);
  }
}

function cancelVerification(guildId, userId) {
  const key = getTimerKey(guildId, userId);
  const timerId = verificationTimers.get(key);
  
  if (timerId) {
    clearTimeout(timerId);
    verificationTimers.delete(key);
    console.log(`Cancelled verification timer for ${userId} in ${guildId}`);
  }
}

async function restoreVerificationTimers() {
  if (!db) return;

  try {
    // Get all members who haven't been processed yet
    const unprocessedMembers = await db.all(
      `SELECT guildId, userId FROM members WHERE processed = 0`
    );

    for (const member of unprocessedMembers) {
      await scheduleVerification(member.guildId, member.userId);
    }

    console.log(`Restored ${unprocessedMembers.length} verification timers`);

    // Also immediately verify any processed members who should have qualified while offline
    const allMembers = await db.all(`SELECT guildId, userId FROM members`);
    for (const member of allMembers) {
      const record = await getMemberRecord(member.guildId, member.userId);
      if (!record) continue;

      const config = await getGuildConfig(member.guildId);
      const joinedAtValue = Number(record.joinedAt || Date.now());
      const requiredTimeMs = Number(config.requiredMemberTimeMs ?? DEFAULT_REQUIRED_MEMBER_TIME_MS);
      
      if (!record.processed && (Date.now() - joinedAtValue) >= requiredTimeMs) {
        const guild = client.guilds.cache.get(member.guildId);
        if (guild) {
          await verifyMember(guild, member.userId);
        }
      }
    }
  } catch (err) {
    console.error('Restore verification timers error:', err);
  }
}


async function initDB() {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS guilds (
      guildId TEXT PRIMARY KEY,
      memberRoleId TEXT,
      warnTriggerRoleId TEXT,
      requiredMemberTimeMs INTEGER DEFAULT 1209600000,
      embedColor INTEGER DEFAULT 65280,
      logChannelId TEXT,
      warningLimit INTEGER,
      lastProcessedMessageId TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      guildId TEXT,
      userId TEXT,
      joinedAt INTEGER,
      processed INTEGER DEFAULT 0,
      blacklisted INTEGER DEFAULT 0,
      warnings INTEGER DEFAULT 0,
      PRIMARY KEY (guildId, userId)
    );
  `);

  await ensureColumn('guilds', 'logChannelId', 'TEXT');
  await ensureColumn('guilds', 'warningLimit', 'INTEGER');
  await ensureColumn('guilds', 'lastProcessedMessageId', 'TEXT');
  await ensureColumn('members', 'processed', 'INTEGER DEFAULT 0');
  await ensureColumn('members', 'blacklisted', 'INTEGER DEFAULT 0');
  await ensureColumn('members', 'warnings', 'INTEGER DEFAULT 0');

  console.log('Database ready');
}

async function ensureColumn(table, column, definition) {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  const exists = columns.some(col => col.name === column);

  if (!exists) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  if (table === 'members' && column === 'warnings') {
    await db.run(`UPDATE members SET warnings = 0 WHERE warnings IS NULL`);
  }
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

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
  }
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'Unknown';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

async function getGuildConfig(guildId) {
  if (!db) return {};

  const config = await db.get(
    `SELECT * FROM guilds WHERE guildId = ?`,
    [guildId]
  );

  console.log('getGuildConfig read', { guildId, config });
  return config || {};
}

async function getMemberRecord(guildId, userId) {
  if (!db) return null;

  return await db.get(
    `SELECT * FROM members WHERE guildId = ? AND userId = ?`,
    [guildId, userId]
  );
}

async function ensureMemberRecord(guildId, userId, joinedAt = Date.now()) {
  if (!db) return null;

  await db.run(
    `INSERT OR IGNORE INTO members
     (guildId, userId, joinedAt, processed, blacklisted, warnings)
     VALUES (?, ?, ?, 0, 0, 0)`,
    [guildId, userId, joinedAt]
  );

  return getMemberRecord(guildId, userId);
}

async function verifyMember(guild, userId) {
  if (!db || !guild || !userId) return { qualified: false, changed: false };

  try {
    const config = await getGuildConfig(guild.id);
    const member = await guild.members.fetch(userId).catch(() => null);
    const record = await ensureMemberRecord(guild.id, userId, member?.joinedAt?.getTime() || Date.now());

    console.log('verifyMember member diagnostics', {
      guildId: guild.id,
      memberId: member?.id,
      guildName: guild.name,
      memberJoinedAt: member?.joinedAt,
      memberJoinedTimestamp: member?.joinedTimestamp,
      recordJoinedAt: record?.joinedAt,
      communicationDisabledUntil: member?.communicationDisabledUntil,
      pending: member?.pending
    });

    const joinedAtValue = Number(member?.joinedAt?.getTime() || record?.joinedAt || Date.now());
    const warnings = Number(record?.warnings || 0);
    const requiredTimeMs = Number(config.requiredMemberTimeMs ?? DEFAULT_REQUIRED_MEMBER_TIME_MS);
    const warningLimit = config.warningLimit === null || config.warningLimit === undefined ? null : Number(config.warningLimit);

    console.log('verifyMember diagnostics', {
      guildId: guild.id,
      userId,
      joinedAtValue,
      joinedAtIso: new Date(joinedAtValue).toISOString(),
      requiredTimeMs,
      requiredTimeDays: requiredTimeMs / (1000 * 60 * 60 * 24),
      config,
      record,
      now: Date.now(),
      elapsedMs: Date.now() - joinedAtValue
    });

    const timeMet = (Date.now() - joinedAtValue) >= requiredTimeMs;
    const warningMet = warningLimit === null || warnings < warningLimit;
    const qualified = timeMet && warningMet;

    const roleId = config.memberRoleId;
    let changed = false;

    if (member && roleId) {
      const role = await guild.roles.fetch(roleId).catch(() => null);

      if (role) {
        if (qualified && !member.roles.cache.has(role.id)) {
          await member.roles.add(role).catch(() => {});
          changed = true;
          console.log('Verification granted', guild.id, userId);
        } else if (!qualified && member.roles.cache.has(role.id)) {
          await member.roles.remove(role).catch(() => {});
          changed = true;
          console.log('Verification removed', guild.id, userId);
        }
      }
    } else if (qualified) {
      console.log('Verification granted', guild.id, userId);
    } else {
      console.log('Verification removed', guild.id, userId);
    }

    await db.run(
      `UPDATE members
       SET joinedAt = ?, processed = 1, warnings = ?
       WHERE guildId = ? AND userId = ?`,
      [joinedAtValue, warnings, guild.id, userId]
    );

    return {
      qualified,
      changed,
      warnings,
      timeMet,
      warningMet,
      joinedAtValue
    };
  } catch (err) {
    console.error('Verification error:', err);
    return { qualified: false, changed: false };
  }
}

function extractUserIdFromMessage(message) {
  const mention = message.mentions?.users?.first();
  if (mention) return mention.id;

  const match = `${message.content || ''} ${message.embeds?.map(embedInfo => `${embedInfo.description || ''} ${embedInfo.title || ''}`).join(' ') || ''}`.match(/<@!?([0-9]+)/);
  if (match) return match[1];

  const idMatch = `${message.content || ''} ${message.embeds?.map(embedInfo => `${embedInfo.description || ''} ${embedInfo.title || ''}`).join(' ') || ''}`.match(/\b([0-9]{17,20})\b/);
  if (idMatch) return idMatch[1];

  return null;
}

function parseDynoAction(message) {
  const text = `${message.content || ''} ${message.embeds?.map(embedInfo => `${embedInfo.description || ''} ${embedInfo.title || ''}`).join(' ') || ''}`.toLowerCase();

  if (/warnings? cleared/.test(text)) {
    return { action: 'clear' };
  }

  if (/warning removed|warnings? removed/.test(text)) {
    const amountMatch = text.match(/(\d+)\s+warning(s)?/i) || text.match(/(\d+)\s+warn(s)?/i);
    return { action: 'remove', amount: amountMatch ? Number(amountMatch[1]) : 1 };
  }

  if (/warn|warning/.test(text)) {
    const amountMatch = text.match(/(\d+)\s+warning(s)?/i) || text.match(/(\d+)\s+warn(s)?/i);
    return { action: 'add', amount: amountMatch ? Number(amountMatch[1]) : 1 };
  }

  return null;
}

async function processDynoMessage(message) {
  if (!db || !message?.guild || !message.author || message.author.id !== DYNO_ID) return;

  const config = await getGuildConfig(message.guild.id);
  if (!config.logChannelId || message.channel.id !== config.logChannelId) return;

  const action = parseDynoAction(message);
  if (!action) return;

  const userId = extractUserIdFromMessage(message);
  if (!userId) return;

  const record = await ensureMemberRecord(message.guild.id, userId, Date.now());
  const currentWarnings = Number(record?.warnings || 0);
  let nextWarnings = currentWarnings;

  if (action.action === 'clear') {
    nextWarnings = 0;
  } else if (action.action === 'remove') {
    nextWarnings = Math.max(0, currentWarnings - action.amount);
  } else if (action.action === 'add') {
    nextWarnings = currentWarnings + action.amount;
  }

  await db.run(
    `UPDATE members
     SET warnings = ?, processed = 1
     WHERE guildId = ? AND userId = ?`,
    [nextWarnings, message.guild.id, userId]
  );

  await verifyMember(message.guild, userId);

  if (!config.lastProcessedMessageId || BigInt(message.id) > BigInt(config.lastProcessedMessageId)) {
    await db.run(
      `INSERT INTO guilds (guildId, lastProcessedMessageId)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET lastProcessedMessageId=excluded.lastProcessedMessageId`,
      [message.guild.id, message.id]
    );
  }

  console.log('Dyno event processed', action.action, userId);
}

async function replayDynoEvents(guild) {
  if (!db || !guild) return;

  const config = await getGuildConfig(guild.id);
  if (!config.logChannelId) return;

  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) return;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => new Map());
  const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  for (const message of sortedMessages) {
    if (!message || message.author?.id !== DYNO_ID) continue;
    if (config.lastProcessedMessageId && BigInt(message.id) <= BigInt(config.lastProcessedMessageId)) continue;

    await processDynoMessage(message);
  }
}

async function replayDynoEventsForAllGuilds() {
  if (!client.guilds?.cache?.size) {
    console.log('Replay finished');
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await replayDynoEvents(guild);
    } catch (err) {
      console.error('Replay error:', err);
    }
  }

  console.log('Replay finished');
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
    .setDescription('Show stats'),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('Show warning status')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to inspect')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('addwarnings')
    .setDescription('Add warnings to a user')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to update')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('amount')
        .setDescription('Amount to add')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removewarnings')
    .setDescription('Remove warnings from a user')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to update')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('amount')
        .setDescription('Amount to remove')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('verifycheck')
    .setDescription('Check one member')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to check')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('scanmember')
    .setDescription('Check a single member')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to scan')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setlogchannel')
    .setDescription('Set Dyno log channel')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel for Dyno logs')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('setwarninglimit')
    .setDescription('Set warning limit')
    .addIntegerOption(o =>
      o.setName('amount')
        .setDescription('Maximum warnings allowed')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('disablewarninglimit')
    .setDescription('Disable warning limit checks')
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
  if (!db || member.user.bot) return;

  await db.run(
    `INSERT OR IGNORE INTO members
     (guildId, userId, joinedAt, processed, blacklisted, warnings)
     VALUES (?, ?, ?, 0, 0, 0)`,
    [member.guild.id, member.id, member.joinedAt?.getTime() || Date.now()]
  );

  await scheduleVerification(member.guild.id, member.id);
});

client.on('guildMemberRemove', async member => {
  if (!db || member.user.bot) return;

  cancelVerification(member.guild.id, member.id);
});

client.on('messageCreate', async message => {
  if (!db || !message.guild) return;

  try {
    await processDynoMessage(message);
  } catch (err) {
    console.error('Dyno message error:', err);
  }
});

client.on('interactionCreate', async interaction => {
  if (!db || !interaction.isChatInputCommand()) return;

  const guildId = interaction.guild?.id;
  if (!guildId) return;

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

    console.log('setmembertime parsed duration', { ms, guildId, input: interaction.options.getString('time') });
    console.log('setmembertime guildId', guildId);

    const sql = `INSERT INTO guilds (guildId, requiredMemberTimeMs)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET requiredMemberTimeMs=excluded.requiredMemberTimeMs`;
    const params = [guildId, ms];
    console.log('setmembertime SQL', { sql, params });

    const result = await db.run(sql, params);
    console.log('setmembertime write result', result);

    const verifyRow = await db.get(
      `SELECT guildId, requiredMemberTimeMs FROM guilds WHERE guildId = ?`,
      [guildId]
    );
    console.log('setmembertime verify row after write', verifyRow);

    return interaction.reply({
      embeds: [embed('Updated', 'Time set', color)]
    });
  }

  if (interaction.commandName === 'scanmembers') {
    await interaction.deferReply();

    try {
      const members = await interaction.guild.members.fetch();
      let added = 0;

      for (const member of members.values()) {
        if (member.user.bot) continue;

        try {
          const res = await db.run(
            `INSERT OR IGNORE INTO members
             (guildId, userId, joinedAt, processed, blacklisted, warnings)
             VALUES (?, ?, ?, 0, 0, 0)`,
            [guildId, member.id, member.joinedAt?.getTime() || Date.now()]
          );

          if (res.changes > 0) added++;
          await verifyMember(interaction.guild, member.id);
        } catch (err) {
          console.error('Error processing member:', member.id, err);
        }
      }

      return await interaction.editReply({
        embeds: [embed('Scan Complete', `Added ${added} members and ran verification`, color)]
      });
    } catch (err) {
      console.error('Scan members error:', err);
      return await interaction.editReply({
        embeds: [embed('Scan Failed', 'The scan could not be completed.', color)]
      });
    }
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

  if (interaction.commandName === 'warnings') {
    const user = interaction.options.getUser('user');
    const record = await ensureMemberRecord(guildId, user.id, Date.now());
    const result = await verifyMember(interaction.guild, user.id);

    return interaction.reply({
      embeds: [
        embed(
          'Warning Status',
          `User: ${user.tag}\nWarnings: ${record?.warnings || 0}\nVerified: ${result.qualified ? 'Yes' : 'No'}`,
          color
        )
      ]
    });
  }

  if (interaction.commandName === 'addwarnings') {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const record = await ensureMemberRecord(guildId, user.id, Date.now());
    const nextWarnings = (Number(record?.warnings || 0)) + amount;

    await db.run(
      `UPDATE members
       SET warnings = ?, processed = 1
       WHERE guildId = ? AND userId = ?`,
      [nextWarnings, guildId, user.id]
    );

    await verifyMember(interaction.guild, user.id);

    return interaction.reply({
      embeds: [embed('Updated', `${user.tag} now has ${nextWarnings} warnings`, color)]
    });
  }

  if (interaction.commandName === 'removewarnings') {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    const record = await ensureMemberRecord(guildId, user.id, Date.now());
    const currentWarnings = Number(record?.warnings || 0);
    const nextWarnings = Math.max(0, currentWarnings - amount);

    await db.run(
      `UPDATE members
       SET warnings = ?, processed = 1
       WHERE guildId = ? AND userId = ?`,
      [nextWarnings, guildId, user.id]
    );

    await verifyMember(interaction.guild, user.id);

    return interaction.reply({
      embeds: [embed('Updated', `${user.tag} now has ${nextWarnings} warnings`, color)]
    });
  }

  if (interaction.commandName === 'verifycheck') {
    const user = interaction.options.getUser('user');
    const result = await verifyMember(interaction.guild, user.id);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const record = await getMemberRecord(guildId, user.id);
    const config = await getGuildConfig(guildId);
    const roleId = config.memberRoleId;
    const role = roleId ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
    const warnings = Number(record?.warnings || 0);
    const warningLimit = config.warningLimit === null || config.warningLimit === undefined ? null : Number(config.warningLimit);
    const requiredTimeMs = Number(config.requiredMemberTimeMs ?? DEFAULT_REQUIRED_MEMBER_TIME_MS);
    const joinedAtValue = Number(result.joinedAtValue || record?.joinedAt || Date.now());
    const joinDate = new Date(joinedAtValue).toISOString();
    const timeRemainingMs = Math.max(0, (joinedAtValue + requiredTimeMs) - Date.now());
    const timeRequirementMet = Boolean(result.timeMet);
    const warningsRequirementMet = Boolean(result.warningMet);
    const roleAssigned = Boolean(member?.roles?.cache?.has(role?.id || ''));
    const shouldAssignRole = Boolean(result.qualified && roleId);
    const reasons = [];

    if (!timeRequirementMet) reasons.push('time requirement');
    if (!warningsRequirementMet) reasons.push('warning limit');

    const description = result.qualified
      ? 'The member is qualified.'
      : `The member is not qualified because ${reasons.join(' and ')}.`;

    return interaction.reply({
      embeds: [
        embed('Verification Check', description, color)
          .addFields(
            { name: 'Qualified', value: result.qualified ? 'Yes' : 'No', inline: true },
            { name: 'Time requirement met', value: timeRequirementMet ? 'Yes' : 'No', inline: true },
            { name: 'Warnings requirement met', value: warningsRequirementMet ? 'Yes' : 'No', inline: true },
            { name: 'Current warnings', value: `${warnings}`, inline: true },
            { name: 'Warning limit', value: warningLimit === null ? 'No limit' : `${warningLimit}`, inline: true },
            { name: 'Join date', value: joinDate, inline: false },
            { name: 'Required member time', value: formatDuration(requiredTimeMs), inline: true },
            { name: 'Time remaining until qualification', value: result.qualified ? 'Already qualified' : formatDuration(timeRemainingMs), inline: true },
            { name: 'Member role currently assigned', value: roleAssigned ? 'Yes' : 'No', inline: true },
            { name: 'Bot believes role should be assigned', value: shouldAssignRole ? 'Yes' : 'No', inline: true }
          )
      ]
    });
  }

  if (interaction.commandName === 'scanmember') {
    await interaction.deferReply();
    const user = interaction.options.getUser('user');

    try {
      await ensureMemberRecord(guildId, user.id, Date.now());
      await verifyMember(interaction.guild, user.id);

      return await interaction.editReply({
        embeds: [embed('Scan Complete', `Checked ${user.tag}`, color)]
      });
    } catch (err) {
      console.error('Scan member error:', err);
      return await interaction.editReply({
        embeds: [embed('Scan Failed', `Scan failed: ${err.message}`, color)]
      });
    }
  }

  if (interaction.commandName === 'setlogchannel') {
    const channel = interaction.options.getChannel('channel');

    await db.run(
      `INSERT INTO guilds (guildId, logChannelId)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET logChannelId=excluded.logChannelId`,
      [guildId, channel.id]
    );

    return interaction.reply({
      embeds: [embed('Updated', 'Log channel set', color)]
    });
  }

  if (interaction.commandName === 'setwarninglimit') {
    const amount = interaction.options.getInteger('amount');

    if (amount < 0) {
      return interaction.reply({ content: 'Warning limit cannot be negative', ephemeral: true });
    }

    await db.run(
      `INSERT INTO guilds (guildId, warningLimit)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET warningLimit=excluded.warningLimit`,
      [guildId, amount]
    );

    return interaction.reply({
      embeds: [embed('Updated', `Warning limit set to ${amount}`, color)]
    });
  }

  if (interaction.commandName === 'disablewarninglimit') {
    await db.run(
      `INSERT INTO guilds (guildId, warningLimit)
       VALUES (?, ?)
       ON CONFLICT(guildId)
       DO UPDATE SET warningLimit=excluded.warningLimit`,
      [guildId, null]
    );

    return interaction.reply({
      embeds: [embed('Updated', 'Warning limit disabled', color)]
    });
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('process.cwd():', process.cwd());
  console.log('resolved database path:', require('path').resolve('./database.db'));
  await replayDynoEventsForAllGuilds();
  await restoreVerificationTimers();
});

(async () => {
  await initDB();
  await deployCommands();
  await client.login(process.env.TOKEN);
})();