import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type GuildAuditLogsEntry,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
} from "discord.js";
import { logger } from "./lib/logger.js";

const BRAND_NAME = "Ro Value Assistant";
const TICKET_CATEGORY_NAME = "Ro Value Assistant";
const TICKET_TOPIC_PREFIX = "mm2-ticket:";
const BRAND_PURPLE = 0x8b5cf6;
const UI_PRIMARY = 0x6366f1;
const UI_SUCCESS = 0x22c55e;
const UI_DANGER = 0xef4444;
const UI_WARNING = 0xf59e0b;

function noticeEmbed(color: number, title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor(brandAuthor())
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function brandAuthor(): { name: string; iconURL?: string } {
  const iconURL = client?.user?.displayAvatarURL();
  return iconURL ? { name: BRAND_NAME, iconURL } : { name: BRAND_NAME };
}
const TICKET_CONFIG_PATH = join(process.cwd(), "data", "ticket-config.json");

const TICKET_COMMAND_GUIDE = [
  ["`$ticketsetup`", "configure claim roles and post the ticket panel (administrators only)"],
  ["`$claim`", "claim the current ticket (configured staff roles or administrators)"],
  ["`$unclaim`", "release the current ticket (configured staff roles or administrators)"],
  ["`$transfer @user`", "transfer the ticket to another configured staff member"],
  ["`$add @user`", "add one or more people to the current ticket, e.g. `$add @a @b @c` (claim roles, admins, or the ticket owner)"],
  ["`$remove @user`", "remove one or more previously added members from the current ticket"],
  ["`$close` / `$ticketclose`", "close the current ticket, save its transcript, and delete it after 30 seconds (configured staff roles or administrators)"],
  ["`$tickettranscript`", "save and log the ticket conversation (configured staff roles or administrators)"],
  ["`$mmhow`", "post the Middleman info panel with I Understand / I Don't Understand buttons (configured staff roles or administrators)"],
  ["`$conf`", "post a trade confirmation panel with Confirm / Decline buttons (configured staff roles or administrators)"],
  ["`$fee`", "post the middleman fee panel with Pay 50% / Pay 100% buttons (configured staff roles or administrators)"],
  ["`$join @user`", "post the Member Accept / Decline panel for the mentioned user; only they can press the buttons (configured ticket claimer roles or administrators)"],
  ["`$ticketconfig`", "change the ticket claim role and Accepted Member role (administrators only)"],
  ["`$joinsetup`", "configure the channel and message the bot posts when a member accepts a `$join` offer (administrators only)"],
  ["`$tickethelp`", "show ticket commands only"],
] as const;

const TEMP_COMMAND_GUIDE = [
  ["`$tempsetup @Role1 @Role2 ...`", "set the roles members must already have and keep when using `$temp` (administrators only)"],
  ["`$temp`", "toggle temp mode: keep only the configured role, then restore your roles when used again"],
] as const;

const ADMIN_COMMAND_GUIDE = [
  ["`$say`", "compose and send a message (plain or embed) as the bot in the current channel (administrators only)"],
  ["`$addrole @user @role`", "add a role to a member (administrators only)"],
  ["`$disablerole` / `$enablerole`", "block or allow manual role changes; while blocked, anyone who adds a role by hand is kicked (administrators only)"],
] as const;

const VOUCH_COMMAND_GUIDE = [
  ["`$addvouch <amount> [@user]`", "add vouches to yourself or a mentioned user (configured staff roles or administrators, usable anywhere)"],
  ["`$vouches [@user]`", "show a vouch count for yourself or a mentioned user (configured staff roles or administrators, usable anywhere)"],
  ["`$removevouch [@user]`", "reset all vouches for yourself or a mentioned user (configured staff roles or administrators, usable anywhere)"],
] as const;

type TicketState = "open" | "claimed" | "closed";

type TicketMetadata = {
  version: 1;
  state: TicketState;
  ownerId: string;
  claimerId: string | null;
  otherTrader: string;
  trade: string;
  createdAt: string;
  additionalMemberIds: string[];
};

type TicketConfig = {
  claimRoleIds: string[];
  transcriptChannelId?: string;
  joinRoleId?: string;
  tempRoleIds?: string[];
  tempRoleId?: string;
  tempRoleBackups?: Record<string, string[]>;
  joinAnnouncement?: JoinAnnouncement;
  // When true, roles added by hand (not through $addrole) are reverted and the person who added them is kicked.
  manualRolesDisabled?: boolean;
  updatedAt: string;
};

type JoinAnnouncement = {
  channelId: string;
  title: string;
  message: string;
};

const commandDefinitions: never[] = [];

export type DiscordBotStatus = {
  configured: boolean;
  state: "starting" | "online" | "offline" | "error";
  username: string | null;
  userId: string | null;
  guildCount: number;
  commandScope: "guild" | "global";
  lastError: string | null;
  startedAt: string | null;
};

const status: DiscordBotStatus = {
  configured: Boolean(process.env.DISCORD_BOT_TOKEN),
  state: "offline",
  username: null,
  userId: null,
  guildCount: 0,
  commandScope: process.env.DISCORD_GUILD_ID ? "guild" : "global",
  lastError: null,
  startedAt: null,
};

let client: Client | null = null;
let startPromise: Promise<void> | null = null;
const ticketConfigs = new Map<string, TicketConfig>();
type SayDraft = { channelId: string; content: string; title: string | null };
const sayDrafts = new Map<string, SayDraft>();
const vouchCounts = new Map<string, number>();
const VOUCH_STORE_PATH = join(process.cwd(), "data", "vouch-counts.json");

export function getDiscordBotStatus(): DiscordBotStatus {
  return {
    ...status,
    guildCount: client?.guilds.cache.size ?? status.guildCount,
  };
}

export async function startDiscordBot(): Promise<void> {
  if (startPromise) {
    return startPromise;
  }

  startPromise = connectDiscordBot();
  return startPromise;
}

async function connectDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    status.state = "error";
    status.lastError = "DISCORD_BOT_TOKEN is not configured";
    logger.error("Discord bot cannot start: DISCORD_BOT_TOKEN is missing");
    return;
  }

  await loadTicketConfigs();
  await loadVouchCounts();
  status.state = "starting";
  status.lastError = null;
  status.startedAt = new Date().toISOString();

  const nextClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Non-privileged intent that delivers audit log entries in real time.
      GatewayIntentBits.GuildModeration,
    ],
  });

  nextClient.once(Events.ClientReady, (readyClient) => {
    status.state = "online";
    status.username = readyClient.user.tag;
    status.userId = readyClient.user.id;
    status.guildCount = readyClient.guilds.cache.size;
    logger.info(
      { username: readyClient.user.tag, guildCount: status.guildCount },
      "Discord bot is online",
    );

    void registerCommands(readyClient.user.id, token);
  });

  nextClient.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isButton()) {
      void handleTicketButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      void handleTicketModal(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu()) {
      void handleTranscriptChannelSelect(interaction);
    }
  });

  nextClient.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    void handleRoleAuditEntry(entry, guild);
  });

  nextClient.on(Events.MessageCreate, (message) => {
    void handlePrefixCommand(message);
  });

  nextClient.on(Events.Error, (error) => {
    status.state = "error";
    status.lastError = error.message;
    logger.error({ err: error }, "Discord client error");
  });

  try {
    await nextClient.login(token);
    client = nextClient;
  } catch (error) {
    status.state = "error";
    status.lastError = error instanceof Error ? error.message : "Unknown login error";
    logger.error({ err: error }, "Discord bot failed to log in");
  }
}

async function loadTicketConfigs(): Promise<void> {
  try {
    const rawConfig = await readFile(TICKET_CONFIG_PATH, "utf8");
    const savedConfigs = JSON.parse(rawConfig) as Record<string, TicketConfig>;
    for (const [guildId, config] of Object.entries(savedConfigs)) {
      if (isValidTicketConfig(config)) {
        ticketConfigs.set(guildId, config);
      }
    }
    logger.info({ guildCount: ticketConfigs.size }, "Ticket role configuration loaded");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    logger.error({ err: error }, "Ticket role configuration could not be loaded");
  }
}

async function updateTicketConfig(
  guildId: string,
  patch: Partial<Omit<TicketConfig, "updatedAt">>,
): Promise<TicketConfig> {
  const existingConfig = ticketConfigs.get(guildId);
  const config: TicketConfig = {
    claimRoleIds: existingConfig?.claimRoleIds ?? [],
    ...existingConfig,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
  return config;
}

async function saveTicketConfig(
  guildId: string,
  claimRoleIds: string[],
  joinRoleId?: string,
): Promise<TicketConfig> {
  return updateTicketConfig(guildId, {
    claimRoleIds: [...new Set(claimRoleIds)],
    ...(joinRoleId ? { joinRoleId } : {}),
  });
}

async function saveTranscriptChannelConfig(
  guildId: string,
  transcriptChannelId: string,
): Promise<TicketConfig> {
  return updateTicketConfig(guildId, { transcriptChannelId });
}

async function saveTempRoleConfig(
  guildId: string,
  tempRoleIds: string[],
): Promise<TicketConfig> {
  return updateTicketConfig(guildId, { tempRoleIds, tempRoleId: undefined });
}

async function saveTempRoleBackup(
  guildId: string,
  userId: string,
  roleIds: string[],
): Promise<void> {
  const existingConfig = ticketConfigs.get(guildId);
  await updateTicketConfig(guildId, {
    tempRoleBackups: { ...(existingConfig?.tempRoleBackups ?? {}), [userId]: roleIds },
  });
}

async function clearTempRoleBackup(
  guildId: string,
  userId: string,
): Promise<void> {
  const existingConfig = ticketConfigs.get(guildId);
  if (!existingConfig?.tempRoleBackups?.[userId]) {
    return;
  }

  const { [userId]: _removedBackup, ...remainingBackups } = existingConfig.tempRoleBackups;
  await updateTicketConfig(guildId, {
    tempRoleBackups: Object.keys(remainingBackups).length > 0 ? remainingBackups : undefined,
  });
}

async function persistTicketConfigs(): Promise<void> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(
    TICKET_CONFIG_PATH,
    JSON.stringify(Object.fromEntries(ticketConfigs), null, 2),
  );
}

function vouchKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

async function loadVouchCounts(): Promise<void> {
  try {
    const raw = await readFile(VOUCH_STORE_PATH, "utf8");
    const saved = JSON.parse(raw) as Record<string, number>;
    for (const [key, value] of Object.entries(saved)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        vouchCounts.set(key, value);
      }
    }
    logger.info({ count: vouchCounts.size }, "Vouch counts loaded");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    logger.error({ err: error }, "Vouch counts could not be loaded");
  }
}

async function persistVouchCounts(): Promise<void> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(VOUCH_STORE_PATH, JSON.stringify(Object.fromEntries(vouchCounts), null, 2));
}

function getVouchCount(guildId: string, userId: string): number {
  return vouchCounts.get(vouchKey(guildId, userId)) ?? 0;
}

async function addVouches(guildId: string, userId: string, amount: number): Promise<number> {
  const key = vouchKey(guildId, userId);
  const nextTotal = Math.max(0, (vouchCounts.get(key) ?? 0) + amount);
  vouchCounts.set(key, nextTotal);
  await persistVouchCounts();
  return nextTotal;
}

async function resetVouches(guildId: string, userId: string): Promise<void> {
  vouchCounts.delete(vouchKey(guildId, userId));
  await persistVouchCounts();
}

async function configureTempRole(message: Message): Promise<void> {
  if (!message.member || !isAdministrator(message.member)) {
    return;
  }

  if (message.mentions.roles.size < 1) {
    await message.reply("Use `$tempsetup @Role1 @Role2 ...` and mention at least one role to keep.");
    return;
  }

  const roles = [...message.mentions.roles.values()];
  const botMember = message.guild?.members.me;
  if (!message.guild || !botMember) {
    await message.reply("I could not verify those roles in this server. Please try again.");
    return;
  }

  for (const role of roles) {
    if (role.id === message.guild.roles.everyone.id || role.managed) {
      await message.reply("Choose regular server roles, not @everyone or managed integration roles.");
      return;
    }
    if (!role.editable || role.position >= botMember.roles.highest.position) {
      await message.reply(`I cannot manage ${role}. Move the bot's highest role above it, then run $tempsetup again.`);
      return;
    }
  }

  await saveTempRoleConfig(message.guild.id, roles.map((role) => role.id));
  await message.reply({
    allowedMentions: { parse: [] },
    embeds: [
      new EmbedBuilder()
        .setColor(UI_SUCCESS)
        .setAuthor(brandAuthor())
        .setTitle("Temp Roles Updated")
        .setTimestamp()
        .setDescription(`Members who use \`$temp\` must already have all of these roles and will keep them while their other removable roles are removed: ${roles.join(" ")}.`)
        .setFooter({ text: "Run $tempsetup again anytime to replace the configured roles." }),
    ],
  });
}

async function applyTempRole(message: Message): Promise<void> {
  if (!message.member || !message.guild) return;

  const config = ticketConfigs.get(message.guild.id);
  const configuredTempRoleIds = config?.tempRoleIds?.length
    ? config.tempRoleIds
    : config?.tempRoleId
      ? [config.tempRoleId]
      : [];

  if (configuredTempRoleIds.length === 0) {
    await message.reply("An administrator must run `$tempsetup @Role1 @Role2 ...` before `$temp` can be used.");
    return;
  }

  const tempRoles = configuredTempRoleIds
    .map((roleId) => message.guild!.roles.cache.get(roleId))
    .filter((role): role is NonNullable<typeof role> => Boolean(role));
  const botMember = message.guild.members.me;
  if (tempRoles.length !== configuredTempRoleIds.length || !botMember || tempRoles.some((role) => role.managed || !role.editable)) {
    await message.reply("One or more configured temp roles are no longer available to manage. Ask an administrator to run `$tempsetup` again.");
    return;
  }

  if (message.member.id === message.guild.ownerId) {
    await message.reply("I cannot change the server owner's roles.");
    return;
  }

  if (tempRoles.some((role) => !message.member!.roles.cache.has(role.id))) {
    return;
  }

  const savedRoleIds = config?.tempRoleBackups?.[message.member.id];
  const tempRoleIdSet = new Set(configuredTempRoleIds);

  try {
    if (savedRoleIds !== undefined) {
      const rolesToRestore = savedRoleIds.filter((roleId) => {
        const role = message.guild!.roles.cache.get(roleId);
        return Boolean(role && role.id !== message.guild!.roles.everyone.id && !role.managed && role.editable && !tempRoleIdSet.has(role.id));
      });
      const rolesToRestoreSet = new Set(rolesToRestore);
      const rolesToRemove = message.member.roles.cache
        .filter((role) => role.id !== message.guild!.roles.everyone.id && !role.managed && role.editable && !tempRoleIdSet.has(role.id) && !rolesToRestoreSet.has(role.id))
        .map((role) => role.id);

      if (rolesToRemove.length > 0) await message.member.roles.remove(rolesToRemove, "Restored roles from temp mode");
      if (rolesToRestore.length > 0) await message.member.roles.add(rolesToRestore, "Restored roles from temp mode");
      // Configured temp roles are permanent requirements/kept roles.
      // Do NOT remove them when leaving temp mode. Only restore the roles
      // that were temporarily removed when temp mode was first enabled.
      await clearTempRoleBackup(message.guild.id, message.member.id);

      const missingRoleCount = savedRoleIds.length - rolesToRestore.length;
      await message.reply({
        allowedMentions: { parse: [] },
        embeds: [
          new EmbedBuilder()
            .setColor(UI_PRIMARY)
            .setAuthor(brandAuthor())
            .setTitle("Temp Mode Removed")
            .setTimestamp()
            .setDescription("Your saved roles have been restored. Your configured temp roles are still kept.")
            .setFooter({ text: missingRoleCount > 0 ? `${missingRoleCount} saved role(s) no longer exist or could not be managed.` : "Use $temp again to apply temp mode." }),
        ],
      });
      return;
    }

    const removableRoleIds = message.member.roles.cache
      .filter((role) => !tempRoleIdSet.has(role.id) && !role.managed && role.editable)
      .map((role) => role.id);
    const skippedRoleCount = message.member.roles.cache.filter((role) => !tempRoleIdSet.has(role.id) && role.id !== message.guild!.roles.everyone.id && (role.managed || !role.editable)).size;

    await saveTempRoleBackup(message.guild.id, message.member.id, removableRoleIds);
    if (removableRoleIds.length > 0) await message.member.roles.remove(removableRoleIds, "Applied configured temp roles");

    await message.reply({
      allowedMentions: { parse: [] },
      embeds: [
        new EmbedBuilder()
          .setColor(UI_SUCCESS)
          .setAuthor(brandAuthor())
          .setTitle("Temp Mode Applied")
          .setTimestamp()
          .setDescription(`Your configured temp roles are being kept: ${tempRoles.join(" ")}.`)
          .setFooter({ text: skippedRoleCount > 0 ? `${skippedRoleCount} Discord-managed or higher roles could not be changed.` : "Use $temp again to restore your previous roles." }),
      ],
    });
  } catch (error) {
    logger.error({ err: error, guildId: message.guild.id, userId: message.author.id }, "Temp role application failed");
    await message.reply("I could not update all of your roles. Make sure my highest role is above the roles you want me to remove.");
  }
}

function isValidTicketConfig(config: unknown): config is TicketConfig {
  return Boolean(
    config &&
      typeof config === "object" &&
      "claimRoleIds" in config &&
      Array.isArray(config.claimRoleIds) &&
      config.claimRoleIds.every((roleId) => typeof roleId === "string") &&
      (!("transcriptChannelId" in config) ||
        config.transcriptChannelId === undefined ||
        typeof config.transcriptChannelId === "string") &&
      (!("joinRoleId" in config) ||
        config.joinRoleId === undefined ||
        typeof config.joinRoleId === "string") &&
      (!("tempRoleIds" in config) ||
        config.tempRoleIds === undefined ||
        (Array.isArray(config.tempRoleIds) &&
          config.tempRoleIds.every((roleId) => typeof roleId === "string"))) &&
      (!("tempRoleId" in config) ||
        config.tempRoleId === undefined ||
        typeof config.tempRoleId === "string"),
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

async function registerCommands(applicationId: string, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  try {
    await rest.put(route, { body: commandDefinitions });
    logger.info(
      { scope: guildId ? "guild" : "global" },
      "Discord slash commands registered",
    );
  } catch (error) {
    status.state = "error";
    status.lastError =
      error instanceof Error ? error.message : "Command registration failed";
    logger.error({ err: error }, "Discord slash command registration failed");
  }
}

async function handlePrefixCommand(message: Message): Promise<void> {
  if (
    message.author.bot ||
    !message.guild ||
    !message.content.startsWith("$")
  ) {
    return;
  }

  const [rawCommand, ...args] = message.content.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase();

  if (!command) {
    return;
  }

  if (command === "ticketsetup") {
    await startTicketSetup(message, "setup");
    return;
  }

  if (command === "ticketconfig") {
    await startTicketSetup(message, "config");
    return;
  }

  if (command === "tempsetup") {
    await configureTempRole(message);
    return;
  }

  if (command === "temp") {
    await applyTempRole(message);
    return;
  }

  if (command === "tickethelp") {
    await sendTicketHelp(message);
    return;
  }

  if (command === "cmd" || command === "commands") {
    if (!canUseCommandGuide(message)) {
      return;
    }
    await message.reply({ embeds: [commandListEmbed(message)] });
    return;
  }

  if (command === "say") {
    await startSayCommand(message);
    return;
  }

  if (command === "addvouch") {
    await handleAddVouch(message, args);
    return;
  }

  if (command === "vouches") {
    await handleVouchesCommand(message);
    return;
  }

  if (command === "removevouch") {
    await handleRemoveVouch(message);
    return;
  }

  if (command === "addrole") {
    await addRoleCommand(message);
    return;
  }

  if (command === "enablerole") {
    await setManualRolePolicy(message, true);
    return;
  }

  if (command === "disablerole") {
    await setManualRolePolicy(message, false);
    return;
  }

  if (command === "joinsetup") {
    await startJoinSetup(message);
    return;
  }

  if (command === "join") {
    // `$join @user`: only the mentioned user can press Accept / Decline.
    // With no mention at all, the command does nothing (no reply, no panel).
    const targetId = message.content.match(/<@!?(\d+)>/)?.[1];
    if (!targetId) {
      return;
    }

    const ticketContext = getTicketContext(message);
    if (!ticketContext) {
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(DANGER_RED)
            .setTitle(`${BRAND_NAME} · Ticket Only`)
            .setDescription("`$join` can only be used inside an active ticket."),
        ],
      });
      return;
    }
    await sendJoinPanel(message, ticketContext.channel, ticketContext.ticket, targetId);
    return;
  }

  const ticketContext = getTicketContext(message);
  if (!ticketContext) {
    return;
  }

  switch (command) {
    case "claim":
      await claimTicket(message, ticketContext.channel, ticketContext.ticket);
      return;
    case "unclaim":
      await unclaimTicket(message, ticketContext.channel, ticketContext.ticket);
      return;
    case "transfer":
      await transferTicket(
        message,
        ticketContext.channel,
        ticketContext.ticket,
      );
      return;
    case "ticketclose":
    case "close":
      await closeTicket(message, ticketContext.channel, ticketContext.ticket);
      return;
    case "tickettranscript":
      await createTicketTranscript(
        message,
        ticketContext.channel,
        ticketContext.ticket,
      );
      return;
    case "add":
      await addTicketMember(
        message,
        ticketContext.channel,
        ticketContext.ticket,
      );
      return;
    case "remove":
      await removeTicketMember(
        message,
        ticketContext.channel,
        ticketContext.ticket,
      );
      return;
    case "mmhow":
      await sendMiddlemanHowTo(message, ticketContext.channel);
      return;
    case "conf":
      await sendTradeConfirmationPanel(message, ticketContext.channel);
      return;
    case "fee":
      await sendMiddlemanFeePanel(message, ticketContext.channel);
      return;
    default:
      if (args.length > 0) {
        return;
      }
  }
}

async function startTicketSetup(
  message: Message,
  mode: "setup" | "config",
): Promise<void> {
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) {
    return;
  }

  if (!message.guild || !isTextChannel(message.channel)) {
    await message.reply("This command can only be used in a server text channel.");
    return;
  }

  const existingConfig = ticketConfigs.get(message.guild.id);
  const currentRoles = existingConfig?.claimRoleIds.length
    ? existingConfig.claimRoleIds.map((roleId) => `<@&${roleId}>`).join(" ")
    : "No claim roles saved yet.";
  const promptEmbed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle(`${mode === "setup" ? "Ticket Setup" : "Ticket Config"}`)
    .setDescription("Choose which roles are allowed to claim and manage tickets.")
    .addFields(
      { name: "Current claim roles", value: currentRoles },
      { name: "Next step", value: "Press the button below, then mention one role or several roles." },
    )
    .setFooter({ text: "Only administrators can change this setting." })
    .setTimestamp();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket:roles:${mode}:${message.author.id}`)
      .setLabel(mode === "setup" ? "Set Claim Roles" : "Change Claim Roles")
      
      .setStyle(ButtonStyle.Primary),
  );

  await message.channel.send({ embeds: [promptEmbed], components: [row] });
  await message.reply(
    mode === "setup"
      ? "Role setup prompt sent. Complete it to publish the ticket panel."
      : "Role configuration prompt sent.",
  );
}

async function sendTicketPanel(channel: TextChannel): Promise<void> {
  const avatar = client?.user?.displayAvatarURL();
  const panelEmbed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Middleman Service")
    .setDescription(
      [
        "Welcome to our middleman service centre.",
        "",
        `**${BRAND_NAME}** provides a safe and secure way to exchange your goods.`,
        "If you have found a trade and want to ensure your safety, you can use our middleman service.",
      ].join("\n"),
    )
    .addFields(
      {
        name: "Usage Conditions",
        value: [
          "> Both parties agree to trade before requesting a middleman.",
          "> State the trade and value clearly.",
          "> Fake or troll tickets will result in punishments.",
        ].join("\n"),
      },
      {
        name: "Getting Started",
        value: "1. Press **Open Ticket** below\n2. Fill in the trade details\n3. A middleman will claim your ticket",
      },
    )
    .setFooter({ text: `Powered by ${BRAND_NAME}`, ...(avatar ? { iconURL: avatar } : {}) })
    .setTimestamp();
  if (avatar) {
    panelEmbed.setThumbnail(avatar);
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel("Open Ticket")
      
      .setStyle(ButtonStyle.Primary),
  );

  await channel.send({ embeds: [panelEmbed], components: [row] });
}

async function showRoleConfigModal(interaction: ButtonInteraction): Promise<void> {
  const [, , mode, adminId] = interaction.customId.split(":");
  if (
    !interaction.guild ||
    !adminId ||
    interaction.user.id !== adminId ||
    !isAdministrator(interaction.member)
  ) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket:roles:${mode}:${adminId}`)
    .setTitle(mode === "setup" ? "Ticket Setup" : "Ticket Config");
  const roleInput = new TextInputBuilder()
    .setCustomId("claim_roles")
    .setLabel("Ticket claim roles")
    .setPlaceholder("<@&role-id> <@&role-id>")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  const joinRoleInput = new TextInputBuilder()
    .setCustomId("join_role")
    .setLabel("Accepted Member role")
    .setPlaceholder("Mention the role given after Accept")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(joinRoleInput),
  );
  await interaction.showModal(modal);
}

async function saveRoleConfigFromModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  try {
    const [, , mode, adminId] = interaction.customId.split(":");
    if (
      !interaction.guild ||
      !adminId ||
      interaction.user.id !== adminId ||
      !isAdministrator(interaction.member)
    ) {
      return;
    }

    // Acknowledge immediately: fetching roles and syncing every open
    // ticket's permissions can take longer than Discord's 3-second
    // interaction window, so defer first and edit the reply once done.
    await interaction.deferReply({ ephemeral: true });

    const roleInput = interaction.fields.getTextInputValue("claim_roles");
    const roleIds = parseRoleMentions(roleInput);
    const joinRoleInput = interaction.fields.getTextInputValue("join_role");
    const joinRoleIds = parseRoleMentions(joinRoleInput);

    if (roleIds.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(UI_WARNING)
            .setAuthor(brandAuthor())
            .setTitle("Role Setup")
            .setTimestamp()
            .setDescription(
              "Please mention one or more valid server roles, for example `<@&123456789012345678>`, or paste the plain role ID.",
            ),
        ],
      });
      return;
    }

    // Roles the bot hasn't seen recently may be missing from the cache,
    // so fetch the full role list from Discord before validating instead
    // of relying on the cache alone.
    const guildRoles = await interaction.guild.roles.fetch();
    const validRoleIds = roleIds.filter(
      (roleId) => roleId !== interaction.guild?.roles.everyone.id && guildRoles.has(roleId),
    );

    if (validRoleIds.length !== roleIds.length) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(UI_WARNING)
            .setAuthor(brandAuthor())
            .setTitle("Role Setup")
            .setTimestamp()
            .setDescription(
              "One or more claim roles could not be found in this server. Please double-check the role mention or ID and try again.",
            ),
        ],
      });
      return;
    }

    if (joinRoleIds.length !== 1) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(UI_WARNING)
            .setAuthor(brandAuthor())
            .setTitle("Role Setup")
            .setTimestamp()
            .setDescription("Please mention exactly one valid Accepted Member role."),
        ],
      });
      return;
    }

    const joinRole = guildRoles.get(joinRoleIds[0]);
    if (
      !joinRole ||
      joinRole.id === interaction.guild.roles.everyone.id ||
      joinRole.managed ||
      !joinRole.editable
    ) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(UI_WARNING)
            .setAuthor(brandAuthor())
            .setTitle("Role Setup")
            .setTimestamp()
            .setDescription(
              "The Accepted Member role must be a normal role that I can manage. Move my highest role above it and try again.",
            ),
        ],
      });
      return;
    }

    const config = await saveTicketConfig(interaction.guild.id, validRoleIds, joinRole.id);
    await syncOpenTicketPermissions(interaction.guild);
    const roleMentions = config.claimRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
    const needsTranscriptChannel = !config.transcriptChannelId;
    const successEmbed = new EmbedBuilder()
      .setColor(UI_SUCCESS)
      .setAuthor(brandAuthor())
      .setTitle(`${mode === "setup" ? "Setup Complete" : "Config Updated"}`)
      .setTimestamp()
      .setDescription(
        [
          `Allowed claim roles: ${roleMentions}`,
          `Accepted Member role: <@&${config.joinRoleId}>`,
          "",
          needsTranscriptChannel
            ? "One more step: pick a channel below to log ticket transcripts."
            : mode === "setup"
              ? "Your ticket panel is ready below."
              : "New and unclaimed tickets will now use these roles.",
        ].join("\n"),
      );
    const channel = getModalTextChannel(interaction);

    if (needsTranscriptChannel) {
      const selectRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`ticket:transcript-channel:${mode}:${adminId}`)
          .setPlaceholder("Select a channel for ticket transcripts")
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1),
      );
      await interaction.editReply({ embeds: [successEmbed], components: [selectRow] });
      return;
    }

    if (mode === "setup" && channel) {
      await sendTicketPanel(channel);
    }
    await interaction.editReply({ embeds: [successEmbed], components: [] });
  } catch (error) {
    await reportInteractionError(interaction, error, "Ticket role config save failed");
  }
}

async function handleTranscriptChannelSelect(
  interaction: ChannelSelectMenuInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith("ticket:transcript-channel:")) {
    return;
  }

  try {
    const [, , mode, adminId] = interaction.customId.split(":");
    if (
      !interaction.guild ||
      !adminId ||
      interaction.user.id !== adminId ||
      !isAdministrator(interaction.member)
    ) {
      return;
    }

    await interaction.deferUpdate();

    const selectedChannelId = interaction.values[0];
    await saveTranscriptChannelConfig(interaction.guild.id, selectedChannelId);

    const confirmEmbed = new EmbedBuilder()
      .setColor(UI_SUCCESS)
      .setAuthor(brandAuthor())
      .setTitle("Transcript Channel Set")
      .setTimestamp()
      .setDescription(
        [
          `Ticket transcripts will be logged to <#${selectedChannelId}>.`,
          "",
          mode === "setup" ? "Your ticket panel is ready below." : "Setup complete.",
        ].join("\n"),
      );
    await interaction.editReply({ embeds: [confirmEmbed], components: [] });

    if (mode === "setup") {
      const panelChannel = interaction.channel;
      if (panelChannel && isTextChannel(panelChannel)) {
        await sendTicketPanel(panelChannel);
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Transcript channel selection failed");
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: "I couldn't save that channel.", ephemeral: true });
    } else {
      await interaction.reply({ content: "I couldn't save that channel.", ephemeral: true });
    }
  }
}

async function startSayCommand(message: Message): Promise<void> {
  if (!message.member || !isAdministrator(message.member)) {
    return;
  }

  if (!isTextChannel(message.channel)) {
    await message.reply("This command can only be used in a server text channel.");
    return;
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`say:open:${message.author.id}:${message.channel.id}`)
      .setLabel("Write Message")
      .setStyle(ButtonStyle.Primary),
  );
  await message.reply({
    content: "Click below to write the message you want to send in this channel.",
    components: [row],
  });
}

async function openSayModal(interaction: ButtonInteraction): Promise<void> {
  const [, , authorId, channelId] = interaction.customId.split(":");
  if (
    !authorId ||
    !channelId ||
    interaction.user.id !== authorId ||
    !isAdministrator(interaction.member)
  ) {
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`say:modal:${authorId}:${channelId}`)
    .setTitle("Say Something");

  const contentInput = new TextInputBuilder()
    .setCustomId("content")
    .setLabel("Message")
    .setPlaceholder("Write anything — supports **bold**, # headings, mentions, etc.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  const titleInput = new TextInputBuilder()
    .setCustomId("embed_title")
    .setLabel("Embed Title (optional)")
    .setPlaceholder("Only used if you choose \"Send as Embed\"")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(256);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(contentInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
  );
  await interaction.showModal(modal);
}

async function saveSayDraftFromModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    const [, , authorId, channelId] = interaction.customId.split(":");
    if (
      !authorId ||
      !channelId ||
      interaction.user.id !== authorId ||
      !isAdministrator(interaction.member)
    ) {
      return;
    }

    const content = interaction.fields.getTextInputValue("content");
    const titleRaw = interaction.fields.getTextInputValue("embed_title");
    sayDrafts.set(authorId, { channelId, content, title: titleRaw.trim() || null });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`say:send:embed:${authorId}`)
        .setLabel("Send as Embed")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`say:send:plain:${authorId}`)
        .setLabel("Send as Plain Text")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`say:cancel:${authorId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({
      content: "Choose how to send this message:",
      components: [row],
      ephemeral: true,
    });
  } catch (error) {
    await reportInteractionError(interaction, error, "Say draft save failed");
  }
}

async function handleSayButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith("say:open:")) {
    await openSayModal(interaction);
    return;
  }

  if (interaction.customId.startsWith("say:cancel:")) {
    const [, , authorId] = interaction.customId.split(":");
    if (interaction.user.id !== authorId) {
      await interaction.reply({ content: "This isn't your draft to cancel.", ephemeral: true });
      return;
    }
    sayDrafts.delete(authorId);
    await interaction.update({ content: "Cancelled. Nothing was sent.", components: [] });
    return;
  }

  if (interaction.customId.startsWith("say:send:")) {
    const [, , style, authorId] = interaction.customId.split(":");
    if (interaction.user.id !== authorId || !isAdministrator(interaction.member)) {
      await interaction.reply({ content: "This isn't your draft to send.", ephemeral: true });
      return;
    }

    // Acknowledge immediately because channel fetching/sending can take longer
    // than Discord's 3-second interaction window.
    await interaction.deferUpdate();

    const draft = sayDrafts.get(authorId);
    if (!draft) {
      await interaction.editReply({
        content: "This draft has expired. Run `$say` again.",
        components: [],
      });
      return;
    }

    try {
      const targetChannel = await interaction.guild?.channels.fetch(draft.channelId);
      if (!targetChannel || !isTextChannel(targetChannel)) {
        await interaction.editReply({
          content: "I couldn't find the channel this message was meant for.",
          components: [],
        });
        return;
      }

      if (style === "embed") {
        const embed = new EmbedBuilder().setColor(UI_PRIMARY).setDescription(draft.content);
        if (draft.title) {
          embed.setTitle(draft.title);
        }
        await targetChannel.send({ embeds: [embed] });
      } else {
        await targetChannel.send({ content: draft.content });
      }

      sayDrafts.delete(authorId);
      await interaction.editReply({ content: `Message sent to ${targetChannel}.`, components: [] });
    } catch (error) {
      logger.error({ err: error }, "Say send failed");
      await interaction.editReply({ content: "I couldn't send that message.", components: [] });
    }
  }
}

async function addRoleCommand(message: Message): Promise<void> {
  if (!message.guild || !message.member || !isAdministrator(message.member)) {
    return;
  }

  const guild = message.guild;
  const roles = await guild.roles.fetch();
  const bareIds = [
    ...message.content.replace(/<[@#][!&]?\d+>/g, "").matchAll(/\b\d{15,25}\b/g),
  ].map((match) => match[0]);
  const roleId = message.content.match(/<@&(\d+)>/)?.[1] ?? bareIds.find((id) => roles.has(id));
  const userId =
    message.content.match(/<@!?(\d+)>/)?.[1] ??
    bareIds.find((id) => id !== roleId && !roles.has(id));

  const reply = (color: number, title: string, description: string) =>
    message.reply({
      allowedMentions: { parse: [], repliedUser: false },
      embeds: [noticeEmbed(color, title, description)],
    });

  if (!userId || !roleId) {
    await reply(UI_WARNING, "Add Role", "Use `$addrole @user @role` or `$addrole @user role_id`.");
    return;
  }

  const role = roles.get(roleId);
  if (!role) {
    await reply(UI_WARNING, "Add Role", "That role could not be found in this server.");
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await reply(UI_WARNING, "Add Role", "That member could not be found in this server.");
    return;
  }

  if (role.id === guild.roles.everyone.id || role.managed) {
    await reply(UI_WARNING, "Add Role", "Choose a regular server role, not @everyone or an integration-managed role.");
    return;
  }

  if (!role.editable) {
    await reply(UI_WARNING, "Add Role", `I cannot manage ${role}. Move my highest role above it and try again.`);
    return;
  }

  if (
    message.author.id !== guild.ownerId &&
    role.position >= message.member.roles.highest.position
  ) {
    await reply(UI_WARNING, "Add Role", `You cannot assign ${role} because it is at or above your highest role.`);
    return;
  }

  if (member.roles.cache.has(role.id)) {
    await reply(UI_WARNING, "Add Role", `<@${member.id}> already has ${role}.`);
    return;
  }

  try {
    await member.roles.add(role, `$addrole used by ${message.author.tag}`);
    await reply(UI_SUCCESS, "Role Added", `${role} was added to <@${member.id}> by <@${message.author.id}>.`);
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, userId }, "$addrole failed");
    await reply(UI_DANGER, "Add Role Failed", "I could not add that role. Please check my permissions and role position.");
  }
}

async function setManualRolePolicy(message: Message, manualAllowed: boolean): Promise<void> {
  if (!message.guild || !message.member || !isAdministrator(message.member)) {
    return;
  }

  await updateTicketConfig(message.guild.id, { manualRolesDisabled: !manualAllowed });

  if (manualAllowed) {
    await message.reply({
      allowedMentions: { parse: [], repliedUser: false },
      embeds: [
        noticeEmbed(
          UI_PRIMARY,
          "Manual Role Changes Enabled",
          "Members with the right permissions may add roles manually. `$addrole` also continues to work.",
        ),
      ],
    });
    return;
  }

  const me = await message.guild.members.fetchMe().catch(() => null);
  const missing = [
    [PermissionFlagsBits.ViewAuditLog, "View Audit Log"],
    [PermissionFlagsBits.KickMembers, "Kick Members"],
    [PermissionFlagsBits.ManageRoles, "Manage Roles"],
  ]
    .filter(([permission]) => !me?.permissions.has(permission as bigint))
    .map(([, label]) => label as string);

  const embed = noticeEmbed(
    UI_DANGER,
    "Manual Role Changes Disabled",
    "Roles must now be added with `$addrole`. If anyone adds a role manually, the role is removed again and the person who added it is kicked. The server owner and bots are exempt.",
  );
  if (missing.length > 0) {
    embed.addFields({
      name: "Missing bot permissions",
      value: `${missing.join(", ")}. Grant these or the protection will not work fully.`,
    });
  }
  await message.reply({ allowedMentions: { parse: [], repliedUser: false }, embeds: [embed] });
}

async function handleRoleAuditEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
  try {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate) {
      return;
    }
    if (!ticketConfigs.get(guild.id)?.manualRolesDisabled) {
      return;
    }

    const executorId = entry.executorId;
    const botId = guild.client.user?.id;
    if (!executorId || executorId === botId || executorId === guild.ownerId) {
      return;
    }

    const addedRoleIds = entry.changes
      .filter((change) => change.key === "$add")
      .flatMap((change) => ((change.new ?? []) as unknown as Array<{ id: string }>).map((role) => role.id));
    if (addedRoleIds.length === 0) {
      return;
    }

    const executor = await guild.members.fetch(executorId).catch(() => null);
    if (!executor || executor.user.bot) {
      return;
    }

    // Undo the manual change first, then remove the person who made it.
    let reverted = false;
    if (entry.targetId) {
      const target = await guild.members.fetch(entry.targetId).catch(() => null);
      const revertable = addedRoleIds.filter((roleId) => guild.roles.cache.get(roleId)?.editable);
      if (target && revertable.length > 0) {
        reverted = await target.roles
          .remove(revertable, "Manual role change reverted (use $addrole)")
          .then(() => true)
          .catch((error) => {
            logger.error({ err: error, guildId: guild.id }, "Could not revert manual role change");
            return false;
          });
      }
    }

    let kicked = false;
    let kickError = "";
    if (executor.kickable) {
      kicked = await executor
        .kick("Added a role manually while manual role changes are disabled")
        .then(() => true)
        .catch((error) => {
          kickError = error instanceof Error ? error.message : "Unknown error";
          return false;
        });
    } else {
      kickError = "Their highest role is at or above mine.";
    }

    const logChannel = await getTranscriptLogChannel(guild).catch(() => null);
    if (logChannel) {
      const embed = noticeEmbed(
        kicked ? UI_DANGER : UI_WARNING,
        "Manual Role Change Detected",
        `<@${executorId}> added ${addedRoleIds.map((id) => `<@&${id}>`).join(" ")} to ${entry.targetId ? `<@${entry.targetId}>` : "a member"} without using \`$addrole\`.`,
      ).addFields(
        { name: "Role change reverted", value: reverted ? "Yes" : "No", inline: true },
        { name: "Member kicked", value: kicked ? "Yes" : `No${kickError ? ` (${kickError})` : ""}`, inline: true },
      );
      await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
    }
    logger.warn({ guildId: guild.id, executorId, addedRoleIds, reverted, kicked, kickError }, "Manual role change handled");
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, "Role audit entry handling failed");
  }
}

function parseRoleMentions(value: string): string[] {
  const mentionIds = [...value.matchAll(/<@&(\d+)>/g)].map((match) => match[1]);
  const bareIds = [...value.matchAll(/\b(\d{15,25})\b/g)].map((match) => match[1]);
  return [...new Set([...mentionIds, ...bareIds])];
}

async function syncOpenTicketPermissions(guild: Guild): Promise<void> {
  await Promise.all(
    guild.channels.cache.map(async (channel) => {
      if (!isTextChannel(channel)) {
        return;
      }
      const ticket = decodeTicketTopic(channel.topic);
      if (ticket?.state === "open") {
        const synced = withLiveExtras(channel, ticket, [ticket.ownerId]);
        await channel.permissionOverwrites.set(
          buildUnclaimedTicketOverwrites(guild, synced),
        );
      }
    }),
  );
}

async function sendJoinPanel(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
  targetId: string,
): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  if (ticket.state === "closed" || closingTicketChannelIds.has(channel.id)) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(DANGER_RED)
          .setTitle(`${BRAND_NAME} · Ticket Closed`)
          .setDescription("This ticket is already closed."),
      ],
    });
    return;
  }

  const guild = message.guild!;

  // The mentioned user must be a real (non-bot) member of this server.
  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (!targetMember || targetMember.user.bot) {
    return;
  }

  // The buttons are useless if the target can't even see the ticket.
  if (!channel.permissionsFor(targetMember)?.has(PermissionFlagsBits.ViewChannel)) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(DANGER_RED)
          .setTitle(`${BRAND_NAME} · User Not In Ticket`)
          .setDescription("That user can't see this ticket yet. Add them with `$add @user` first."),
      ],
    });
    return;
  }

  const joinRoleId = ticketConfigs.get(guild.id)?.joinRoleId;
  const joinRole = joinRoleId ? guild.roles.cache.get(joinRoleId) : null;
  if (!joinRoleId || !joinRole) {
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(DANGER_RED)
          .setTitle(`${BRAND_NAME} · Member Role Not Configured`)
          .setDescription("An administrator must run `$ticketsetup` and choose the Accepted Member role first."),
      ],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(BRAND_PURPLE)
    .setTitle("Become a Member")
    .setDescription(
      [
        `<@${targetId}>, you have been invited to become a member.`,
        "",
        "**Accept** to receive your Member role. This ticket will close 30 seconds later.",
        "**Decline** and you will be kicked and this ticket will be closed.",
        "",
        "Only you can press these buttons.",
      ].join("\n"),
    )
    .setFooter({ text: BRAND_NAME });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`join:accept:${targetId}:${channel.id}`)
      .setLabel("Accept")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`join:reject:${targetId}:${channel.id}`)
      .setLabel("Decline")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${targetId}>`,
    embeds: [embed],
    components: [row],
    allowedMentions: { users: [targetId] },
  });
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(SUCCESS_GREEN)
        .setTitle(`${BRAND_NAME} · Member Panel Sent`)
        .setDescription(`The Accept / Decline panel has been posted for <@${targetId}>.`),
    ],
  });
}

function buildDisabledJoinRow(
  targetId: string,
  channelId: string,
  chosen: "accept" | "decline",
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`join:accept:${targetId}:${channelId}`)
      .setLabel(chosen === "accept" ? "Accepted" : "Accept")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`join:reject:${targetId}:${channelId}`)
      .setLabel(chosen === "decline" ? "Declined" : "Decline")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true),
  );
}

async function handleJoinButton(interaction: ButtonInteraction): Promise<void> {
  // customId = join:<accept|reject>:<id of the user who was mentioned>:<ticket channel id>
  const [, action, targetId, channelId] = interaction.customId.split(":");
  const guild = interaction.guild;
  if (!guild || !action || !targetId || !channelId) {
    return;
  }

  // Only the user who was mentioned in `$join @user` may press these buttons.
  if (interaction.user.id !== targetId) {
    await interaction.reply({
      content: `Only <@${targetId}> can use these buttons.`,
      ephemeral: true,
    });
    return;
  }

  const channel = getInteractionTextChannel(interaction);
  const ticket = channel ? decodeTicketTopic(channel.topic) : null;
  if (!channel || !ticket || channel.id !== channelId) {
    await interaction.reply({
      content: "This Member panel is no longer connected to an active ticket.",
      ephemeral: true,
    });
    return;
  }

  if (ticket.state === "closed" || closingTicketChannelIds.has(channel.id)) {
    await interaction.reply({
      content: "This ticket is already closed or closing.",
      ephemeral: true,
    });
    return;
  }

  if (action !== "accept" && action !== "reject") {
    return;
  }

  // The Member role is only needed when accepting. Declining must always work.
  const joinRoleId = ticketConfigs.get(guild.id)?.joinRoleId;
  const joinRole = joinRoleId ? guild.roles.cache.get(joinRoleId) : undefined;
  if (action === "accept" && (!joinRole || joinRole.managed || !joinRole.editable)) {
    await interaction.reply({
      content: "The Accepted Member role is no longer available for me to manage.",
      ephemeral: true,
    });
    return;
  }

  // Lock the ticket first so a double click can't run this twice.
  closingTicketChannelIds.add(channel.id);
  await interaction.deferUpdate();

  const nextTicket = withLiveExtras(
    channel,
    { ...ticket, state: "closed" as const },
    [ticket.ownerId, ticket.claimerId],
  );

  if (action === "accept" && joinRole) {
    let member: GuildMember;
    try {
      member = await guild.members.fetch(targetId);
      if (!member.roles.cache.has(joinRole.id)) {
        await member.roles.add(joinRole, "Accepted member offer");
      }
    } catch (error) {
      // Role could not be given, so keep the ticket open and let them retry.
      closingTicketChannelIds.delete(channel.id);
      logger.error({ err: error, guildId: guild.id, userId: targetId }, "Join role assignment failed");
      await interaction.followUp({
        content: "I couldn't give you the Member role. Please ask an administrator to check my role hierarchy.",
        ephemeral: true,
      });
      return;
    }

    await interaction
      .editReply({ components: [buildDisabledJoinRow(targetId, channelId, "accept")] })
      .catch(() => undefined);

    await channel
      .send({
        embeds: [
          noticeEmbed(
            UI_SUCCESS,
            "Offer Accepted",
            `<@${targetId}> accepted the offer and received ${joinRole}. This ticket will close in **30 seconds**.`,
          ),
        ],
      })
      .catch((error) => logger.error({ err: error }, "Could not send acceptance notice"));

    await Promise.allSettled([
      channel.permissionOverwrites.set(buildClosedTicketOverwrites(guild, nextTicket)),
      sendJoinAnnouncement(guild, member, joinRole, channel),
    ]);

    scheduleJoinTicketCleanup(guild, channel, nextTicket, 30_000, {
      reason: "Member accepted - ticket closed",
    });
    return;
  }

  // Decline path
  await interaction
    .editReply({ components: [buildDisabledJoinRow(targetId, channelId, "decline")] })
    .catch(() => undefined);

  await channel
    .send({
      embeds: [
        noticeEmbed(
          UI_DANGER,
          "Offer Declined",
          `<@${targetId}> declined the offer. They will be removed from the server and this ticket will close in a few seconds.`,
        ),
      ],
    })
    .catch((error) => logger.error({ err: error }, "Could not send decline notice"));

  await channel.permissionOverwrites
    .set(buildClosedTicketOverwrites(guild, nextTicket))
    .catch((error) => {
      logger.error({ err: error, channelId: channel.id }, "Could not lock declined ticket");
    });

  scheduleJoinTicketCleanup(guild, channel, nextTicket, 5_000, {
    kickUserId: targetId,
    reason: "Declined member offer",
  });
}

function renderJoinTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(user|username|server|role|ticket)\}/gi, (_match, key: string) => {
    return values[key.toLowerCase()] ?? "";
  });
}

async function sendJoinAnnouncement(
  guild: Guild,
  member: GuildMember,
  role: Role,
  ticketChannel: TextChannel,
): Promise<void> {
  const announcement = ticketConfigs.get(guild.id)?.joinAnnouncement;
  if (!announcement) {
    return;
  }

  try {
    const target = await guild.channels.fetch(announcement.channelId);
    if (!target || !isTextChannel(target)) {
      logger.warn({ guildId: guild.id, channelId: announcement.channelId }, "Join announcement channel unavailable");
      return;
    }

    const values = {
      user: `<@${member.id}>`,
      username: member.user.username,
      server: guild.name,
      role: `<@&${role.id}>`,
      ticket: ticketChannel.name,
    };
    const embed = new EmbedBuilder()
      .setColor(UI_SUCCESS)
      .setAuthor(brandAuthor())
      .setDescription(renderJoinTemplate(announcement.message, values))
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: BRAND_NAME })
      .setTimestamp();
    if (announcement.title) {
      embed.setTitle(renderJoinTemplate(announcement.title, values).slice(0, 256));
    }

    await target.send({
      content: `<@${member.id}>`,
      embeds: [embed],
      allowedMentions: { users: [member.id] },
    });
  } catch (error) {
    logger.error({ err: error, guildId: guild.id }, "Join announcement failed");
  }
}

async function startJoinSetup(message: Message): Promise<void> {
  if (!message.member || !isAdministrator(message.member)) {
    return;
  }

  if (!message.guild || !isTextChannel(message.channel)) {
    await message.reply("This command can only be used in a server text channel.");
    return;
  }

  const existing = ticketConfigs.get(message.guild.id)?.joinAnnouncement;
  const embed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Join Announcement Setup")
    .setDescription(
      "Configure the message the bot posts when a member presses Accept on a `$join` offer. The accepted member is mentioned automatically.",
    )
    .addFields(
      {
        name: "Current channel",
        value: existing ? `<#${existing.channelId}>` : "Not configured",
        inline: true,
      },
      {
        name: "Current title",
        value: existing?.title ? existing.title.slice(0, 256) : "None",
        inline: true,
      },
      {
        name: "Current message",
        value: existing ? existing.message.slice(0, 1000) : "Not configured",
      },
      {
        name: "Available placeholders",
        value: "`{user}` mention · `{username}` name · `{server}` server name · `{role}` accepted role · `{ticket}` ticket name",
      },
    )
    .setFooter({ text: "Only administrators can change this setting." })
    .setTimestamp();
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`joinsetup:open:${message.author.id}`)
      .setLabel(existing ? "Edit Announcement" : "Configure Announcement")
      .setStyle(ButtonStyle.Primary),
  );

  await message.reply({ embeds: [embed], components: [row], allowedMentions: { repliedUser: false } });
}

async function showJoinSetupModal(interaction: ButtonInteraction): Promise<void> {
  const [, , adminId] = interaction.customId.split(":");
  if (
    !interaction.guild ||
    !adminId ||
    interaction.user.id !== adminId ||
    !isAdministrator(interaction.member)
  ) {
    return;
  }

  const existing = ticketConfigs.get(interaction.guild.id)?.joinAnnouncement;

  const channelInput = new TextInputBuilder()
    .setCustomId("announce_channel")
    .setLabel("Announcement channel")
    .setPlaceholder("#channel mention or channel ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);
  const titleInput = new TextInputBuilder()
    .setCustomId("announce_title")
    .setLabel("Title (optional)")
    .setPlaceholder("Welcome to {server}")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(200);
  const messageInput = new TextInputBuilder()
    .setCustomId("announce_message")
    .setLabel("Message")
    .setPlaceholder("{user} has joined as {role}. Welcome to {server}.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  if (existing) {
    channelInput.setValue(existing.channelId);
    if (existing.title) {
      titleInput.setValue(existing.title.slice(0, 200));
    }
    messageInput.setValue(existing.message.slice(0, 1500));
  }

  const modal = new ModalBuilder()
    .setCustomId(`joinsetup:modal:${adminId}`)
    .setTitle("Join Announcement")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(channelInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
    );
  await interaction.showModal(modal);
}

async function saveJoinSetupFromModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    const [, , adminId] = interaction.customId.split(":");
    if (
      !interaction.guild ||
      !adminId ||
      interaction.user.id !== adminId ||
      !isAdministrator(interaction.member)
    ) {
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const channelRaw = interaction.fields.getTextInputValue("announce_channel");
    const title = interaction.fields.getTextInputValue("announce_title").trim();
    const messageText = interaction.fields.getTextInputValue("announce_message").trim();
    const channelId =
      channelRaw.match(/<#(\d+)>/)?.[1] ?? channelRaw.match(/\b(\d{15,25})\b/)?.[1];

    const fail = async (description: string) => {
      await interaction.editReply({
        embeds: [noticeEmbed(UI_WARNING, "Join Announcement Setup", description)],
      });
    };

    if (!channelId || !messageText) {
      await fail("Please provide a valid channel (mention or ID) and a message.");
      return;
    }

    const target = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!target || !isTextChannel(target)) {
      await fail("That channel could not be found, or it is not a text channel.");
      return;
    }

    const me = await interaction.guild.members.fetchMe().catch(() => null);
    const canSend = me
      ? target
          .permissionsFor(me)
          ?.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
          ])
      : false;
    if (!canSend) {
      await fail(`I need View Channel, Send Messages and Embed Links in ${target} before it can be used.`);
      return;
    }

    await updateTicketConfig(interaction.guild.id, {
      joinAnnouncement: { channelId: target.id, title, message: messageText },
    });

    await interaction.editReply({
      embeds: [
        noticeEmbed(UI_SUCCESS, "Join Announcement Saved", "This is now used whenever a member accepts a `$join` offer.").addFields(
          { name: "Channel", value: `${target}`, inline: true },
          { name: "Title", value: title || "None", inline: true },
          { name: "Message", value: messageText.slice(0, 1000) },
        ),
      ],
    });
  } catch (error) {
    await reportInteractionError(interaction, error, "Join announcement save failed");
  }
}

async function kickDeclinedMember(
  guild: Guild,
  channel: TextChannel,
  userId: string,
  reason: string,
): Promise<void> {
  try {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.KickMembers)) {
      throw new Error("I do not have the Kick Members permission.");
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return; // Already left the server.
    }
    if (!member.kickable) {
      throw new Error("The member's highest role is at or above my highest role, or they are the server owner.");
    }

    await member.kick(reason);
    await channel
      .send({
        embeds: [noticeEmbed(UI_DANGER, "Member Removed", `<@${userId}> has been removed from the server.`)],
      })
      .catch(() => undefined);
  } catch (error) {
    logger.error({ err: error, guildId: guild.id, userId }, "Declined user kick failed");
    const detail = error instanceof Error ? error.message : "Unknown error";
    await channel
      .send({
        embeds: [
          noticeEmbed(
            UI_WARNING,
            "Removal Failed",
            `I could not remove <@${userId}> from the server.\n${detail}`,
          ),
        ],
      })
      .catch(() => undefined);
  }
}

// Waits, then saves the transcript (so it includes every message), optionally
// kicks a user, and finally deletes the ticket channel.
function scheduleJoinTicketCleanup(
  guild: Guild,
  channel: TextChannel,
  ticket: TicketMetadata,
  delayMs: number,
  options: { kickUserId?: string; reason: string },
): void {
  setTimeout(() => {
    void runJoinTicketCleanup(guild, channel, ticket, options);
  }, delayMs);
}

async function runJoinTicketCleanup(
  guild: Guild,
  channel: TextChannel,
  ticket: TicketMetadata,
  options: { kickUserId?: string; reason: string },
): Promise<void> {
  try {
    if (options.kickUserId) {
      await kickDeclinedMember(guild, channel, options.kickUserId, options.reason);
    }

    try {
      await saveTicketTranscript(channel, ticket);
    } catch (error) {
      logger.error({ err: error, channelId: channel.id }, "Join ticket transcript save failed");
    }
  } finally {
    // The ticket is always deleted, even if the steps above failed.
    await channel.delete(options.reason).catch((error) => {
      logger.error({ err: error, channelId: channel.id }, "Failed to delete join ticket");
    });
    closingTicketChannelIds.delete(channel.id);
  }
}

async function handleTicketButton(interaction: ButtonInteraction): Promise<void> {
  try {
    // These buttons must open a modal, so they are acknowledged by
    // showModal() itself. Do NOT defer them first.
    if (interaction.customId === "ticket:open") {
      const modal = new ModalBuilder()
        .setCustomId("ticket:create")
        .setTitle("Request Middleman");

      const traderInput = new TextInputBuilder()
        .setCustomId("other_trader")
        .setLabel("Other trader's username")
        .setPlaceholder("Enter their Discord username")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);

      const tradeInput = new TextInputBuilder()
        .setCustomId("trade")
        .setLabel("What are you trading?")
        .setPlaceholder("Describe the trade and value")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(traderInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(tradeInput),
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId.startsWith("ticket:roles:")) {
      await showRoleConfigModal(interaction);
      return;
    }

    if (interaction.customId.startsWith("join:")) {
      await handleJoinButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("joinsetup:open:")) {
      // showModal() is the acknowledgement for this button.
      await showJoinSetupModal(interaction);
      return;
    }

    if (interaction.customId.startsWith("say:open:")) {
      // showModal() is the acknowledgement for this button.
      await handleSayButton(interaction);
      return;
    }

    // All remaining $say buttons are safe to acknowledge immediately.
    // This prevents Discord's 3-second timeout while channel API work runs.
    if (
      interaction.customId.startsWith("say:send:") ||
      interaction.customId.startsWith("say:cancel:")
    ) {
      await handleSayButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("mm:")) {
      await handleMiddlemanWorkflowButton(interaction);
      return;
    }

    const channel = getInteractionTextChannel(interaction);
    const ticket = channel ? decodeTicketTopic(channel.topic) : null;
    if (!channel || !ticket) {
      await interaction.reply({
        content: "This button can only be used inside an active ticket.",
        ephemeral: true,
      });
      return;
    }

    // Acknowledge every ticket action immediately so Discord never waits for
    // channel/permission/transcript API calls to finish before acknowledging.
    const ticketAction = [
      "ticket:claim",
      "ticket:unclaim",
      "ticket:close",
      "ticket:transcript",
    ].includes(interaction.customId);
    if (ticketAction) {
      await interaction.deferUpdate();
    }

    switch (interaction.customId) {
      case "ticket:claim":
        await claimTicket(interaction, channel, ticket);
        return;
      case "ticket:unclaim":
        await unclaimTicket(interaction, channel, ticket);
        return;
      case "ticket:close":
        await closeTicket(interaction, channel, ticket);
        return;
      case "ticket:transcript":
        await createTicketTranscript(interaction, channel, ticket);
        return;
      case "ticket:help":
        await interaction.reply({
          embeds: [ticketHelpEmbed()],
          ephemeral: true,
        });
        return;
      default:
        // Unknown buttons are also acknowledged instead of silently timing out.
        if (!interaction.replied && !interaction.deferred) {
          await interaction.deferUpdate();
        }
        return;
    }
  } catch (error) {
    await reportInteractionError(interaction, error, "Button interaction failed");
  }
}

async function handleTicketModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (interaction.customId.startsWith("ticket:roles:")) {
    await saveRoleConfigFromModal(interaction);
    return;
  }

  if (interaction.customId.startsWith("say:modal:")) {
    await saveSayDraftFromModal(interaction);
    return;
  }

  if (interaction.customId.startsWith("joinsetup:modal:")) {
    await saveJoinSetupFromModal(interaction);
    return;
  }

  if (interaction.customId !== "ticket:create" || !interaction.guild) {
    return;
  }

  try {
    const existingTicket = findUserTicket(interaction.guild, interaction.user.id);
    if (existingTicket) {
      await interaction.reply({
        content: `You already have an open ticket: ${existingTicket}`,
        ephemeral: true,
      });
      return;
    }

    const otherTrader = interaction.fields.getTextInputValue("other_trader");
    const trade = interaction.fields.getTextInputValue("trade");
    const category = await findOrCreateTicketCategory(interaction.guild);
    const ticket: TicketMetadata = {
      version: 1,
      state: "open",
      ownerId: interaction.user.id,
      claimerId: null,
      otherTrader,
      trade,
      createdAt: new Date().toISOString(),
      additionalMemberIds: [],
    };
    const channelName = `ticket-${slugify(interaction.user.username)}`;
    const ticketChannel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: encodeTicketTopic(ticket),
      permissionOverwrites: buildTicketOverwrites(interaction.guild, ticket),
    });

    const ticketEmbed = new EmbedBuilder()
      .setColor(UI_PRIMARY)
      .setAuthor(brandAuthor())
      .setTitle("New Middleman Ticket")
      .setDescription(
        `Welcome <@${interaction.user.id}>! A middleman will be with you shortly.\nPlease stay in this channel until your trade is complete.`,
      )
      .addFields(
        { name: "Opened by", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Other trader", value: otherTrader.slice(0, 1024) || "—", inline: true },
        { name: "Trade details", value: trade.slice(0, 1024) || "—" },
        { name: "Need help?", value: "Use `$tickethelp` to see ticket commands." },
      )
      .setFooter({ text: BRAND_NAME })
      .setTimestamp();

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:claim")
        .setLabel("Claim")
        
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("ticket:unclaim")
        .setLabel("Unclaim")
        
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ticket:transcript")
        .setLabel("Transcript")
        
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("ticket:close")
        .setLabel("Close")
        
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("ticket:help")
        .setLabel("Help")
        
        .setStyle(ButtonStyle.Primary),
    );

    const claimRoleIds = ticketConfigs.get(interaction.guild.id)?.claimRoleIds ?? [];
    if (claimRoleIds.length > 0) {
      await ticketChannel.send({
        content: claimRoleIds.map((roleId) => `<@&${roleId}>`).join(" "),
        allowedMentions: { roles: claimRoleIds },
      });
    }

    await ticketChannel.send({ embeds: [ticketEmbed], components: [controls] });
    await interaction.reply({
      content: `Your ticket is ready: ${ticketChannel}`,
      ephemeral: true,
    });
  } catch (error) {
    await reportInteractionError(interaction, error, "Ticket creation failed");
  }
}

// Added members live in the channel's permission overwrites, which can be
// changed instantly. The ticket topic (rate limited by Discord) is only used
// for claim state, so it is updated in the background.
function liveExtraMemberIds(
  channel: TextChannel,
  exclude: Array<string | null | undefined>,
): string[] {
  const skip = new Set(exclude.filter((id): id is string => Boolean(id)));
  const botId = channel.client.user?.id;
  if (botId) {
    skip.add(botId);
  }
  return [...channel.permissionOverwrites.cache.values()]
    .filter((overwrite) => overwrite.type === OverwriteType.Member && !skip.has(overwrite.id))
    .map((overwrite) => overwrite.id);
}

function withLiveExtras(
  channel: TextChannel,
  ticket: TicketMetadata,
  exclude: Array<string | null | undefined>,
): TicketMetadata {
  return { ...ticket, additionalMemberIds: liveExtraMemberIds(channel, exclude) };
}

function persistTicketState(channel: TextChannel, ticket: TicketMetadata): Promise<void> {
  return updateTicket(channel, ticket).catch((error) => {
    logger.error({ err: error, channelId: channel.id }, "Ticket state could not be saved to the topic");
  });
}

function collectTargetIds(message: Message): string[] {
  const ids = new Set<string>();
  for (const match of message.content.matchAll(/<@!?(\d+)>/g)) {
    ids.add(match[1]);
  }
  const stripped = message.content
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/<@!?\d+>/g, "");
  for (const match of stripped.matchAll(/\b\d{15,25}\b/g)) {
    ids.add(match[0]);
  }
  return [...ids].slice(0, 25);
}

async function claimTicket(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    return;
  }

  if (ticket.state === "closed") {
    await replyToActor(actor, "This ticket is already closed.");
    return;
  }

  if (ticket.claimerId) {
    await replyToActor(actor, `This ticket is already claimed by <@${ticket.claimerId}>.`);
    return;
  }

  const claimerId = getActorId(actor);
  const nextTicket = withLiveExtras(
    channel,
    { ...ticket, state: "claimed" as const, claimerId },
    [ticket.ownerId, claimerId],
  );
  const topicUpdate = persistTicketState(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildClaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send({
    embeds: [
      noticeEmbed(
        UI_SUCCESS,
        "Ticket Claimed",
        `Ticket claimed by <@${claimerId}>. Only the ticket owner, assigned staff member, added members, and administrators can view it.`,
      ),
    ],
  });
  await replyToActor(actor, `You are now handling ${channel}.`);
  await topicUpdate;
}

async function unclaimTicket(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    return;
  }

  if (ticket.state === "closed") {
    await replyToActor(actor, "This ticket is already closed.");
    return;
  }

  if (ticket.claimerId && ticket.claimerId !== getActorId(actor) && !isAdministrator(actor.member)) {
    return;
  }

  const nextTicket = withLiveExtras(
    channel,
    { ...ticket, state: "open" as const, claimerId: null },
    [ticket.ownerId, ticket.claimerId],
  );
  const topicUpdate = persistTicketState(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildUnclaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send({
    embeds: [
      noticeEmbed(
        UI_WARNING,
        "Ticket Released",
        `Ticket released by <@${getActorId(actor)}>. It is available for another staff member to claim.`,
      ),
    ],
  });
  await replyToActor(actor, "The ticket is available again.");
  await topicUpdate;
}

async function transferTicket(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  if (
    ticket.claimerId &&
    ticket.claimerId !== message.author.id &&
    !isAdministrator(message.member)
  ) {
    return;
  }

  const target = message.mentions.members?.first();
  if (!target || !canClaimMember(message.guild, target)) {
    await message.reply(
      "Use `$transfer @staff-member` and mention someone with an allowed claim role.",
    );
    return;
  }

  if (ticket.state === "closed") {
    await message.reply("This ticket is already closed.");
    return;
  }

  const nextTicket = withLiveExtras(
    channel,
    { ...ticket, state: "claimed" as const, claimerId: target.id },
    [ticket.ownerId, ticket.claimerId, target.id],
  );
  const topicUpdate = persistTicketState(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildClaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send({
    content: `<@${target.id}>`,
    embeds: [
      noticeEmbed(
        UI_PRIMARY,
        "Ticket Transferred",
        `Ticket transferred to <@${target.id}> by <@${message.author.id}>.`,
      ),
    ],
  });
  await message.react("✅");
  await topicUpdate;
}

// Ticket state is persisted in the channel topic, which shares Discord's
// strict rate limit for channel name/topic edits (2 per 10 minutes per
// channel). Claim/unclaim/transfer already spend that budget, so closing
// must NOT also rewrite the topic or rename the channel — either one can
// get rate-limited and silently stall for minutes. Guard against a double
// close with this in-memory set instead.
const closingTicketChannelIds = new Set<string>();

async function closeTicket(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    return;
  }

  if (ticket.state === "closed" || closingTicketChannelIds.has(channel.id)) {
    await replyToActor(actor, "This ticket is already closing or closed.");
    return;
  }
  closingTicketChannelIds.add(channel.id);

  const nextTicket = withLiveExtras(
    channel,
    { ...ticket, state: "closed" as const },
    [ticket.ownerId, ticket.claimerId],
  );

  await channel.send({
    embeds: [noticeEmbed(UI_DANGER, "Ticket Closing", `Ticket is being closed by <@${getActorId(actor)}>...`)],
  });

  // permissionOverwrites uses a separate, much more generous rate limit
  // bucket than name/topic edits, so this is safe to do immediately.
  await channel.permissionOverwrites.set(
    buildClosedTicketOverwrites(channel.guild, nextTicket),
  );

  let logChannel: TextChannel | null = null;
  try {
    logChannel = await saveTicketTranscript(channel, nextTicket);
  } catch (error) {
    logger.error({ err: error, channelId: channel.id }, "Automatic transcript save on close failed");
  }

  await replyToActor(
    actor,
    logChannel
      ? `Ticket closed. Transcript saved to ${logChannel}.`
      : "Ticket closed. Transcript could not be saved automatically.",
  );

  await channel.delete("Ticket closed - automatic cleanup").catch((error) => {
    logger.error({ err: error, channelId: channel.id }, "Failed to auto-delete closed ticket channel");
  });
}

async function saveTicketTranscript(
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<TextChannel | null> {
  const fetchedMessages = await channel.messages.fetch({ limit: 100 });
  const transcript = [...fetchedMessages.values()]
    .sort((first, second) => first.createdTimestamp - second.createdTimestamp)
    .map((item) => {
      const timestamp = new Date(item.createdTimestamp).toISOString();
      const attachments = [...item.attachments.values()]
        .map((attachment) => attachment.url)
        .join(" ");
      return `[${timestamp}] ${item.author.tag}: ${item.content}${attachments ? ` ${attachments}` : ""}`;
    })
    .join("\n");

  const safeName = channel.name.replace(/[^a-z0-9-]/gi, "-");
  const filename = `${safeName}-${Date.now()}.txt`;
  const transcriptDirectory = join(process.cwd(), "data", "transcripts");
  await mkdir(transcriptDirectory, { recursive: true });
  await writeFile(join(transcriptDirectory, filename), transcript || "No messages found.");

  const attachment = new AttachmentBuilder(Buffer.from(transcript || "No messages found."), {
    name: filename,
  });
  const logChannel = await getTranscriptLogChannel(channel.guild);
  const destination = logChannel ?? channel;
  await destination.send({
    content: `Transcript for **${channel.name}** · opened by <@${ticket.ownerId}>${ticket.claimerId ? ` · handled by <@${ticket.claimerId}>` : ""}`,
    files: [attachment],
  });
  return logChannel;
}

async function createTicketTranscript(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    return;
  }

  const logChannel = await saveTicketTranscript(channel, ticket);
  await replyToActor(actor, `Transcript saved${logChannel ? ` to ${logChannel}` : " in this ticket"}.`);
}

async function addTicketMember(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(message) && message.author.id !== ticket.ownerId) {
    return;
  }

  if (ticket.state === "closed" || closingTicketChannelIds.has(channel.id)) {
    await message.reply("This ticket is already closed or closing.");
    return;
  }

  const targetIds = collectTargetIds(message);
  if (targetIds.length === 0) {
    await message.reply("Use `$add @user @user ...` to add one or more people to this ticket.");
    return;
  }

  const addedIds: string[] = [];
  const alreadyIds: string[] = [];
  const failedIds: string[] = [];

  // One permission overwrite per user, all sent in parallel. This does not
  // touch the rate-limited channel topic, so it applies instantly.
  await Promise.all(
    targetIds.map(async (userId) => {
      if (
        userId === ticket.ownerId ||
        userId === ticket.claimerId ||
        channel.permissionOverwrites.cache.has(userId)
      ) {
        alreadyIds.push(userId);
        return;
      }
      try {
        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
        addedIds.push(userId);
      } catch (error) {
        logger.warn({ err: error, userId, channelId: channel.id }, "Could not add user to ticket");
        failedIds.push(userId);
      }
    }),
  );

  const mention = (ids: string[]) => ids.map((id) => `<@${id}>`).join(" ");
  const lines: string[] = [];
  if (addedIds.length > 0) lines.push(`**Added:** ${mention(addedIds)}`);
  if (alreadyIds.length > 0) lines.push(`**Already in ticket:** ${mention(alreadyIds)}`);
  if (failedIds.length > 0) lines.push(`**Could not add:** ${mention(failedIds)}`);

  await message.reply({
    ...(addedIds.length > 0 ? { content: mention(addedIds) } : {}),
    allowedMentions: { users: addedIds, repliedUser: false },
    embeds: [
      noticeEmbed(
        addedIds.length > 0 ? UI_SUCCESS : UI_WARNING,
        addedIds.length > 0 ? "Members Added" : "No Members Added",
        lines.join("\n"),
      ),
    ],
  });
}

async function removeTicketMember(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(message) && message.author.id !== ticket.ownerId) {
    return;
  }

  const targetIds = collectTargetIds(message);
  if (targetIds.length === 0) {
    await message.reply("Use `$remove @user @user ...` to remove one or more people from this ticket.");
    return;
  }

  const removedIds: string[] = [];
  const protectedIds: string[] = [];
  const notAddedIds: string[] = [];
  const failedIds: string[] = [];

  await Promise.all(
    targetIds.map(async (userId) => {
      if (userId === ticket.ownerId || userId === ticket.claimerId) {
        protectedIds.push(userId);
        return;
      }
      const overwrite = channel.permissionOverwrites.cache.get(userId);
      if (!overwrite || overwrite.type !== OverwriteType.Member) {
        notAddedIds.push(userId);
        return;
      }
      try {
        await channel.permissionOverwrites.delete(userId);
        removedIds.push(userId);
      } catch (error) {
        logger.warn({ err: error, userId, channelId: channel.id }, "Could not remove user from ticket");
        failedIds.push(userId);
      }
    }),
  );

  const mention = (ids: string[]) => ids.map((id) => `<@${id}>`).join(" ");
  const lines: string[] = [];
  if (removedIds.length > 0) lines.push(`**Removed:** ${mention(removedIds)}`);
  if (protectedIds.length > 0) lines.push(`**Cannot be removed (owner or claimer):** ${mention(protectedIds)}`);
  if (notAddedIds.length > 0) lines.push(`**Not added to this ticket:** ${mention(notAddedIds)}`);
  if (failedIds.length > 0) lines.push(`**Could not remove:** ${mention(failedIds)}`);

  await message.reply({
    allowedMentions: { parse: [], repliedUser: false },
    embeds: [
      noticeEmbed(
        removedIds.length > 0 ? UI_DANGER : UI_WARNING,
        removedIds.length > 0 ? "Members Removed" : "No Members Removed",
        lines.join("\n"),
      ),
    ],
  });
}

function buildOverwritesForState(guild: Guild, ticket: TicketMetadata): OverwriteResolvable[] {
  if (ticket.state === "closed") {
    return buildClosedTicketOverwrites(guild, ticket);
  }
  if (ticket.state === "claimed") {
    return buildClaimedTicketOverwrites(guild, ticket);
  }
  return buildUnclaimedTicketOverwrites(guild, ticket);
}

const SUCCESS_GREEN = 0x57f287;
const DANGER_RED = 0xed4245;

const MM_DIAGRAM_PATH = join(process.cwd(), "assets", "mm-diagram.png");

async function sendMiddlemanHowTo(message: Message, channel: TextChannel): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("How the Middleman Process Works")
    .setDescription("A Middleman (MM) secures high-value trades so that neither party is put at risk.")
    .addFields(
      { name: "1. Trade Agreement", value: "Both parties agree on the exact terms of the deal in a private channel or group." },
      { name: "2. Handing Over the Asset", value: "The seller hands over the item/account credentials to the official Middleman." },
      { name: "3. Securing the Goods", value: "The Middleman verifies that the item or account is valid and holds it safely." },
      { name: "4. Sending Payment", value: "The buyer sends the agreed-upon payment directly to the seller." },
      { name: "5. Releasing the Asset", value: "Once the seller confirms the payment is received, the Middleman transfers the item/account to the buyer." },
    )
    .setFooter({ text: BRAND_NAME })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mm:understand:yes").setLabel("I Understand").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mm:understand:no").setLabel("I Don't Understand").setStyle(ButtonStyle.Danger),
  );

  try {
    const diagram = new AttachmentBuilder(MM_DIAGRAM_PATH, { name: "mm-diagram.png" });
    embed.setImage("attachment://mm-diagram.png");
    await channel.send({ embeds: [embed], components: [row], files: [diagram] });
  } catch (error) {
    logger.error({ err: error }, "Could not attach mm-diagram.png, sending $mmhow without the image");
    await channel.send({ embeds: [embed], components: [row] });
  }
}

async function sendTradeConfirmationPanel(message: Message, channel: TextChannel): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Confirmations")
    .setDescription("**Do both users confirm the trade?**")
    .addFields(
      { name: "Confirm", value: "Press **Confirm** if you confirm.", inline: true },
      { name: "Decline", value: "Press **Decline** if you do not confirm.", inline: true },
    )
    .setFooter({ text: BRAND_NAME })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mm:confirm:yes").setLabel("Confirm").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mm:confirm:no").setLabel("Decline").setEmoji("❌").setStyle(ButtonStyle.Danger),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function sendMiddlemanFeePanel(message: Message, channel: TextChannel): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Assets Secured")
    .setDescription(
      "Your items are being held securely in escrow by the middleman. Please send the agreed fee so it can be verified and your items released.",
    )
    .addFields({
      name: "Why Fees Apply",
      value:
        "Fees support server operations, cover the cost of our custom tooling, and compensate our trusted middlemen for securing your trade.",
    })
    .setFooter({ text: BRAND_NAME })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("mm:fee:50").setLabel("Pay 50%").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("mm:fee:100").setLabel("Pay 100%").setStyle(ButtonStyle.Success),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function handleMiddlemanWorkflowButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith("mm:understand:")) {
    const understood = interaction.customId.endsWith(":yes");
    const embed = new EmbedBuilder()
      .setColor(understood ? UI_SUCCESS : UI_DANGER)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp()
      .setTitle(understood ? "User Confirmed Understanding" : "User Does NOT Understand")
      .setDescription(
        understood
          ? `<@${interaction.user.id}> understands how the Middleman works.`
          : `<@${interaction.user.id}> does **not** understand how the Middleman works.`,
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.customId.startsWith("mm:confirm:")) {
    const confirmed = interaction.customId.endsWith(":yes");
    const embed = new EmbedBuilder()
      .setColor(confirmed ? UI_SUCCESS : UI_DANGER)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp()
      .setTitle(confirmed ? "Trade Confirmed" : "Trade Declined")
      .setDescription(
        confirmed
          ? `<@${interaction.user.id}> confirmed the trade.`
          : `<@${interaction.user.id}> declined the trade.`,
      );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.customId.startsWith("mm:fee:")) {
    const isFullFee = interaction.customId.endsWith(":100");
    const embed = new EmbedBuilder()
      .setColor(isFullFee ? UI_SUCCESS : UI_PRIMARY)
      .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp()
      .setTitle(isFullFee ? "100% Fee Chosen" : "50% Fee Chosen")
      .setDescription(
        isFullFee
          ? `<@${interaction.user.id}> has chosen to pay the full fee.`
          : `<@${interaction.user.id}> has chosen to split the fee **50/50**.`,
      );
    await interaction.reply({ embeds: [embed] });
  }
}

async function handleAddVouch(message: Message, args: string[]): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const amountToken = args.find((token) => /^\d+$/.test(token));
  const amount = amountToken ? Number.parseInt(amountToken, 10) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    await message.reply("Use `$addvouch <amount> [@user]` — for example `$addvouch 5`.");
    return;
  }

  const target = message.mentions.members?.first() ?? message.member;
  if (!target || !message.guild) {
    await message.reply("I couldn't determine who to add vouches for.");
    return;
  }

  const newTotal = await addVouches(message.guild.id, target.id, amount);
  const isSelf = target.id === message.author.id;
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(UI_SUCCESS)
        .setAuthor(brandAuthor())
        .setTitle("Vouches Added")
        .setDescription(
          `Added **${amount}** vouches. ${isSelf ? "You now have" : `<@${target.id}> now has`} **${newTotal}** vouches.`,
        )
        .setThumbnail(target.user.displayAvatarURL())
        .setTimestamp(),
    ],
  });
}

async function handleVouchesCommand(message: Message): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const target = message.mentions.members?.first() ?? message.member;
  if (!target || !message.guild) {
    await message.reply("I couldn't determine whose vouches to show.");
    return;
  }

  const count = getVouchCount(message.guild.id, target.id);
  const embed = new EmbedBuilder()
    .setColor(UI_SUCCESS)
    .setAuthor(brandAuthor())
    .setTitle("Vouch Count")
    .setDescription(`**${target.displayName}** currently has **${count}** vouches.`)
    .addFields({ name: "Total vouches", value: `${count}`, inline: true })
    .setThumbnail(target.user.displayAvatarURL())
    .setFooter({ text: `Vouch Count • ${BRAND_NAME}` })
    .setTimestamp();
  await message.reply({ embeds: [embed] });
}

async function handleRemoveVouch(message: Message): Promise<void> {
  if (!canClaimTicket(message)) {
    return;
  }

  const target = message.mentions.members?.first() ?? message.member;
  if (!target || !message.guild) {
    await message.reply("I couldn't determine whose vouches to remove.");
    return;
  }

  await resetVouches(message.guild.id, target.id);
  const isSelf = target.id === message.author.id;
  await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(UI_DANGER)
        .setAuthor(brandAuthor())
        .setTitle("Vouches Removed")
        .setDescription(`Removed all ${isSelf ? "your" : `<@${target.id}>'s`} vouches.`)
        .setThumbnail(target.user.displayAvatarURL())
        .setTimestamp(),
    ],
  });
}

async function sendTicketHelp(message: Message): Promise<void> {
  await message.reply({ embeds: [ticketHelpEmbed()] });
}

function ticketHelpText(): string {
  return [
    ...TICKET_COMMAND_GUIDE.map(([command, description]) => `${command} — ${description}`),
  ].join("\n");
}

function hasJoinRole(guildId: string, member: unknown): boolean {
  const joinRoleId = ticketConfigs.get(guildId)?.joinRoleId;
  if (!joinRoleId || !member || typeof member !== "object" || !("roles" in member)) {
    return false;
  }

  const roles = member.roles;
  if (!roles || typeof roles !== "object" || !("cache" in roles)) {
    return false;
  }

  const roleCache = roles.cache;
  return Boolean(
    roleCache &&
      typeof roleCache === "object" &&
      "has" in roleCache &&
      typeof roleCache.has === "function" &&
      roleCache.has(joinRoleId),
  );
}

function canUseCommandGuide(message: Message): boolean {
  if (!message.guild || !message.member) {
    return false;
  }

  return hasJoinRole(message.guild.id, message.member);
}

function commandListEmbed(message: Message): EmbedBuilder {
  const joinRoleId = message.guild ? ticketConfigs.get(message.guild.id)?.joinRoleId : undefined;
  const joinRole = joinRoleId ? `<@&${joinRoleId}>` : "Accepted Member role not configured";

  return new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Command Guide")
    .setDescription("Commands are grouped by permission. Individual commands still enforce their own ticket/staff/admin requirements.")
    .addFields(
      {
        name: "Accepted Members",
        value: [
          `Required role: ${joinRole}`,
          "`$cmd` / `$commands` — show this guide",
          "`$temp` — toggle your configured temp mode",
        ].join("\n"),
      },
      {
        name: "Ticket Staff",
        value: [
          "`$claim` — claim a ticket",
          "`$unclaim` — release a ticket",
          "`$transfer @user` — transfer a ticket",
          "`$add @user @user ...` — add one or more people to a ticket",
          "`$remove @user @user ...` — remove one or more people from a ticket",
          "`$close` / `$ticketclose` — close a ticket",
          "`$tickettranscript` — save the transcript",
          "`$mmhow` — post the middleman guide",
          "`$conf` — post trade confirmation",
          "`$fee` — post the fee panel",
          "`$join @user` — post the Member Accept / Decline panel for that user (ticket claimer role or admin)",
        ].join("\n"),
      },
      {
        name: "Administrators",
        value: [
          "`$ticketsetup` — configure claim + Accepted Member roles and publish the panel",
          "`$ticketconfig` — update claim + Accepted Member roles",
          "`$joinsetup` — configure the announcement posted when a member accepts `$join`",
          "`$tempsetup @Role1 @Role2 ...` — configure temp roles",
          "`$say` — send a plain or embed message as the bot",
          "`$addrole @user @role` — add a role to a member",
          "`$disablerole` — block manual role changes (kicks whoever adds roles by hand)",
          "`$enablerole` — allow manual role changes again",
        ].join("\n"),
      },
      {
        name: "Vouches",
        value: [
          "`$addvouch <amount> [@user]` — add vouches",
          "`$vouches [@user]` — view vouches",
          "`$removevouch [@user]` — reset vouches",
        ].join("\n"),
      },
    )
    .setFooter({ text: `${BRAND_NAME} · Organized command guide` })
    .setTimestamp();
}

function ticketHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(UI_PRIMARY)
    .setAuthor(brandAuthor())
    .setTitle("Ticket Commands")
    .setDescription("Open tickets with the panel button, then use the commands below in a ticket channel.")
    .addFields(
      {
        name: "Everyone",
        value: "Open a ticket — click **Open Ticket** on the panel.",
      },
      {
        name: "Ticket users",
        value: [
          "`$add @user @user ...` — add one or more people to your ticket",
          "`$close` — close the ticket (configured staff roles/admins)",
        ].join("\n"),
      },
      {
        name: "Configured staff roles and administrators",
        value: [
          "`$claim` — claim the current ticket",
          "`$unclaim` — release the current ticket",
          "`$transfer @user` — transfer it to another configured staff member",
          "`$add @user @user ...` — add one or more people to the ticket",
          "`$remove @user @user ...` — remove previously added members",
          "`$close` — close and lock the ticket",
          "`$tickettranscript` — save and log the conversation",
        ].join("\n"),
      },
      {
        name: "Administrators",
        value: "`$ticketsetup` — configure roles and post the panel\n`$ticketconfig` — change claim roles later\n`$joinsetup` — configure the member-accepted announcement",
      },
    )
    .setFooter({ text: "Keep ticket conversations inside the ticket channel." })
    .setTimestamp();
}

function getTicketContext(
  message: Message,
): { channel: TextChannel; ticket: TicketMetadata } | null {
  if (!message.channel.isTextBased() || !("topic" in message.channel)) {
    return null;
  }

  const ticket = decodeTicketTopic(message.channel.topic);
  if (!ticket || !isTextChannel(message.channel)) {
    return null;
  }

  return { channel: message.channel, ticket };
}

function getInteractionTextChannel(
  interaction: ButtonInteraction,
): TextChannel | null {
  return interaction.channel && isTextChannel(interaction.channel)
    ? interaction.channel
    : null;
}

function getModalTextChannel(
  interaction: ModalSubmitInteraction,
): TextChannel | null {
  return interaction.channel && isTextChannel(interaction.channel)
    ? interaction.channel
    : null;
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return (
    channel !== null &&
    typeof channel === "object" &&
    "type" in channel &&
    channel.type === ChannelType.GuildText &&
    "topic" in channel
  );
}

function encodeTicketTopic(ticket: TicketMetadata): string {
  return `${TICKET_TOPIC_PREFIX}${Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url")}`;
}

function decodeTicketTopic(topic: string | null): TicketMetadata | null {
  if (!topic?.startsWith(TICKET_TOPIC_PREFIX)) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(topic.slice(TICKET_TOPIC_PREFIX.length), "base64url").toString("utf8"),
    ) as TicketMetadata;
    if (
      decoded.version !== 1 ||
      !decoded.ownerId ||
      !decoded.otherTrader ||
      !decoded.trade ||
      !["open", "claimed", "closed"].includes(decoded.state)
    ) {
      return null;
    }
    // Tickets created before this field existed won't have it in their
    // stored topic, so default to an empty list rather than rejecting them.
    if (!Array.isArray(decoded.additionalMemberIds)) {
      decoded.additionalMemberIds = [];
    }
    return decoded;
  } catch {
    return null;
  }
}

async function updateTicket(
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  await channel.setTopic(encodeTicketTopic(ticket));
}

async function findOrCreateTicketCategory(guild: Guild) {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name === TICKET_CATEGORY_NAME,
  );
  if (existing && existing.type === ChannelType.GuildCategory) {
    return existing;
  }

  return guild.channels.create({
    name: TICKET_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
  });
}

function findUserTicket(guild: Guild, userId: string): string | null {
  const existing = guild.channels.cache.find((channel) => {
    if (!isTextChannel(channel)) {
      return false;
    }
    const ticket = decodeTicketTopic(channel.topic);
    return ticket?.ownerId === userId && ticket.state !== "closed";
  });
  return existing ? `<#${existing.id}>` : null;
}

function buildTicketOverwrites(
  guild: Guild,
  ticket: TicketMetadata,
): OverwriteResolvable[] {
  const claimRoleIds = ticketConfigs.get(guild.id)?.claimRoleIds ?? [];
  const overwrites: OverwriteResolvable[] = [
    claimRoleIds.length > 0
      ? {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        }
      : {
          id: guild.roles.everyone.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
    {
      id: ticket.ownerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  for (const roleId of claimRoleIds) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  for (const memberId of ticket.additionalMemberIds ?? []) {
    if (memberId === ticket.ownerId) {
      continue;
    }
    overwrites.push({
      id: memberId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }
  return overwrites;
}

function buildUnclaimedTicketOverwrites(
  guild: Guild,
  ticket: TicketMetadata,
): OverwriteResolvable[] {
  return buildTicketOverwrites(guild, ticket);
}

function buildClaimedTicketOverwrites(
  guild: Guild,
  ticket: TicketMetadata,
): OverwriteResolvable[] {
  const overwrites: OverwriteResolvable[] = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: ticket.ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
  ];

  if (ticket.claimerId) {
    overwrites.push({
      id: ticket.claimerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  for (const roleId of ticketConfigs.get(guild.id)?.claimRoleIds ?? []) {
    overwrites.push({
      id: roleId,
      deny: [PermissionFlagsBits.ViewChannel],
    });
  }

  for (const memberId of ticket.additionalMemberIds ?? []) {
    if (memberId === ticket.ownerId || memberId === ticket.claimerId) {
      continue;
    }
    overwrites.push({
      id: memberId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }
  return overwrites;
}

function buildClosedTicketOverwrites(
  guild: Guild,
  ticket: TicketMetadata,
): OverwriteResolvable[] {
  const overwrites: OverwriteResolvable[] = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: ticket.ownerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    },
  ];
  if (ticket.claimerId) {
    overwrites.push({
      id: ticket.claimerId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }
  for (const roleId of ticketConfigs.get(guild.id)?.claimRoleIds ?? []) {
    overwrites.push({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }
  for (const memberId of ticket.additionalMemberIds ?? []) {
    if (memberId === ticket.ownerId || memberId === ticket.claimerId) {
      continue;
    }
    overwrites.push({
      id: memberId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    });
  }
  return overwrites;
}

function canClaimTicket(actor: Message | ButtonInteraction): boolean {
  return Boolean(
    actor.guild &&
      (isAdministrator(actor.member) ||
        hasConfiguredClaimRole(actor.guild.id, actor.member)),
  );
}

function canClaimMember(
  guild: Guild | null,
  member: unknown,
): boolean {
  return Boolean(
    guild &&
      (isAdministrator(member) ||
        hasConfiguredClaimRole(guild.id, member)),
  );
}

function hasConfiguredClaimRole(guildId: string, member: unknown): boolean {
  const claimRoleIds = ticketConfigs.get(guildId)?.claimRoleIds ?? [];
  if (claimRoleIds.length === 0 || !member || typeof member !== "object") {
    return false;
  }

  if (!("roles" in member) || !member.roles) {
    return false;
  }

  const roles = member.roles;
  if (Array.isArray(roles)) {
    return roles.some((roleId) => claimRoleIds.includes(roleId));
  }

  if (
    typeof roles === "object" &&
    "cache" in roles
  ) {
    const roleCache = roles.cache;
    if (
      roleCache &&
      typeof roleCache === "object" &&
      "has" in roleCache &&
      typeof roleCache.has === "function"
    ) {
      const hasRole = roleCache.has as (roleId: string) => boolean;
      return claimRoleIds.some((roleId) => hasRole.call(roleCache, roleId));
    }
  }

  return false;
}

function isStaff(member: unknown): boolean {
  return Boolean(
    hasPermission(member, PermissionFlagsBits.ManageChannels) ||
      hasPermission(member, PermissionFlagsBits.Administrator),
  );
}

function isAdministrator(member: unknown): boolean {
  return hasPermission(member, PermissionFlagsBits.Administrator);
}

function hasPermission(member: unknown, permission: bigint): boolean {
  if (
    !member ||
    typeof member !== "object" ||
    !("permissions" in member) ||
    !member.permissions
  ) {
    return false;
  }

  const permissions = member.permissions;
  if (typeof permissions === "string") {
    return new PermissionsBitField(BigInt(permissions)).has(permission);
  }

  if (
    typeof permissions === "object" &&
    "has" in permissions &&
    typeof permissions.has === "function"
  ) {
    return permissions.has(permission);
  }

  return false;
}

function getActorId(actor: Message | ButtonInteraction): string {
  return actor instanceof Object && "author" in actor
    ? actor.author.id
    : actor.user.id;
}

async function replyToActor(
  actor: Message | ButtonInteraction,
  content: string,
): Promise<void> {
  if ("author" in actor) {
    await actor.reply(content);
    return;
  }
  if (actor.deferred || actor.replied) {
    await actor.followUp({ content, ephemeral: true });
    return;
  }
  await actor.reply({ content, ephemeral: true });
}

async function reportInteractionError(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  error: unknown,
  context: string,
): Promise<void> {
  status.lastError = error instanceof Error ? error.message : context;
  logger.error({ err: error }, context);
  const content = "I couldn't complete that request.";
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, ephemeral: true });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

async function getTranscriptLogChannel(
  guild: Guild,
): Promise<TextChannel | null> {
  const channelId =
    ticketConfigs.get(guild.id)?.transcriptChannelId ?? process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;
  if (!channelId) {
    return null;
  }

  const channel = await guild.channels.fetch(channelId);
  return channel && isTextChannel(channel) ? channel : null;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 45) || "user"
  );
}
