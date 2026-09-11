import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChannelSelectMenuInteraction,
  type Guild,
  type Message,
  type ModalSubmitInteraction,
  type OverwriteResolvable,
  type TextChannel,
} from "discord.js";
import { logger } from "./lib/logger.js";

const BRAND_NAME = "MM2 Community";
const TICKET_CATEGORY_NAME = "MM2 Community";
const TICKET_TOPIC_PREFIX = "mm2-ticket:";
const BRAND_PURPLE = 0x8b5cf6;
const TICKET_CONFIG_PATH = join(process.cwd(), "data", "ticket-config.json");

const TICKET_COMMAND_GUIDE = [
  ["`$ticketsetup`", "configure claim roles and post the ticket panel (administrators only)"],
  ["`$claim`", "claim the current ticket (configured staff roles or administrators)"],
  ["`$unclaim`", "release the current ticket (configured staff roles or administrators)"],
  ["`$transfer @user`", "transfer the ticket to another configured staff member"],
  ["`$add @user`", "add someone to the current ticket (claim roles, admins, or the ticket owner)"],
  ["`$remove @user`", "remove a previously added member from the current ticket"],
  ["`$close` / `$ticketclose`", "close the current ticket, save its transcript, and delete it immediately (configured staff roles or administrators)"],
  ["`$tickettranscript`", "save and log the ticket conversation (configured staff roles or administrators)"],
  ["`$ticketconfig`", "change the roles that can claim tickets (administrators only)"],
  ["`$tickethelp`", "show ticket commands only"],
] as const;

const TEMP_COMMAND_GUIDE = [
  ["`$tempsetup @Role1 @Role2 ...`", "set the roles members must already have and keep when using `$temp` (administrators only)"],
  ["`$temp`", "toggle temp mode: keep only the configured role, then restore your roles when used again"],
] as const;

const ADMIN_COMMAND_GUIDE = [
  ["`$say`", "compose and send a message (plain or embed) as the bot in the current channel (administrators only)"],
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
  tempRoleIds?: string[];
  tempRoleId?: string;
  tempRoleBackups?: Record<string, string[]>;
  updatedAt: string;
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
  status.state = "starting";
  status.lastError = null;
  status.startedAt = new Date().toISOString();

  const nextClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
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

async function saveTicketConfig(
  guildId: string,
  claimRoleIds: string[],
): Promise<TicketConfig> {
  const existingConfig = ticketConfigs.get(guildId);
  const config: TicketConfig = {
    claimRoleIds: [...new Set(claimRoleIds)],
    ...(existingConfig?.transcriptChannelId
      ? { transcriptChannelId: existingConfig.transcriptChannelId }
      : {}),
    ...(existingConfig?.tempRoleId ? { tempRoleId: existingConfig.tempRoleId } : {}),
    ...(existingConfig?.tempRoleBackups
      ? { tempRoleBackups: existingConfig.tempRoleBackups }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
  return config;
}

async function saveTranscriptChannelConfig(
  guildId: string,
  transcriptChannelId: string,
): Promise<TicketConfig> {
  const existingConfig = ticketConfigs.get(guildId);
  const config: TicketConfig = {
    claimRoleIds: existingConfig?.claimRoleIds ?? [],
    transcriptChannelId,
    ...(existingConfig?.tempRoleIds ? { tempRoleIds: existingConfig.tempRoleIds } : {}),
    ...(existingConfig?.tempRoleId ? { tempRoleId: existingConfig.tempRoleId } : {}),
    ...(existingConfig?.tempRoleBackups
      ? { tempRoleBackups: existingConfig.tempRoleBackups }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
  return config;
}

async function saveTempRoleConfig(
  guildId: string,
  tempRoleIds: string[],
): Promise<TicketConfig> {
  const existingConfig = ticketConfigs.get(guildId);
  const config: TicketConfig = {
    claimRoleIds: existingConfig?.claimRoleIds ?? [],
    tempRoleIds,
    ...(existingConfig?.tempRoleBackups
      ? { tempRoleBackups: existingConfig.tempRoleBackups }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
  return config;
}

async function saveTempRoleBackup(
  guildId: string,
  userId: string,
  roleIds: string[],
): Promise<void> {
  const existingConfig = ticketConfigs.get(guildId);
  const config: TicketConfig = {
    claimRoleIds: existingConfig?.claimRoleIds ?? [],
    ...(existingConfig?.transcriptChannelId
      ? { transcriptChannelId: existingConfig.transcriptChannelId }
      : {}),
    ...(existingConfig?.tempRoleIds ? { tempRoleIds: existingConfig.tempRoleIds } : {}),
    ...(existingConfig?.tempRoleId ? { tempRoleId: existingConfig.tempRoleId } : {}),
    tempRoleBackups: {
      ...(existingConfig?.tempRoleBackups ?? {}),
      [userId]: roleIds,
    },
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
}

async function clearTempRoleBackup(
  guildId: string,
  userId: string,
): Promise<void> {
  const existingConfig = ticketConfigs.get(guildId);
  if (!existingConfig?.tempRoleBackups?.[userId]) {
    return;
  }

  const { [userId]: _removedBackup, ...remainingBackups } =
    existingConfig.tempRoleBackups;
  const config: TicketConfig = {
    ...existingConfig,
    ...(Object.keys(remainingBackups).length > 0
      ? { tempRoleBackups: remainingBackups }
      : { tempRoleBackups: undefined }),
    updatedAt: new Date().toISOString(),
  };
  ticketConfigs.set(guildId, config);
  await persistTicketConfigs();
}

async function persistTicketConfigs(): Promise<void> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(
    TICKET_CONFIG_PATH,
    JSON.stringify(Object.fromEntries(ticketConfigs), null, 2),
  );
}

async function configureTempRole(message: Message): Promise<void> {
  if (!message.member || !isAdministrator(message.member)) {
    await message.reply("Only server administrators can configure the temp roles.");
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
        .setColor(BRAND_PURPLE)
        .setTitle(`${BRAND_NAME} · Temp Roles Updated`)
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
    await message.reply(`You need to have all configured temp roles (${tempRoles.join(" ")}) to use $temp.`);
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
            .setColor(BRAND_PURPLE)
            .setTitle(`${BRAND_NAME} · Temp Mode Removed`)
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
          .setColor(BRAND_PURPLE)
          .setTitle(`${BRAND_NAME} · Temp Mode Applied`)
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
    await message.reply({ embeds: [commandListEmbed()] });
    return;
  }

  if (command === "say") {
    await startSayCommand(message);
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
    await message.reply("Only server administrators can configure ticket claim roles.");
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
    .setColor(BRAND_PURPLE)
    .setTitle(`${BRAND_NAME} · ${mode === "setup" ? "Ticket Setup" : "Ticket Config"}`)
    .setDescription(
      [
        "Please mention the roles that can claim tickets.",
        "",
        `**Current claim roles:** ${currentRoles}`,
        "",
        "You can mention one role or several roles in the next step.",
      ].join("\n"),
    )
    .setFooter({ text: "Only administrators can change this setting." });
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
  const panelEmbed = new EmbedBuilder()
    .setColor(BRAND_PURPLE)
    .setTitle(BRAND_NAME)
    .setDescription(
      [
        "Welcome to our middleman service centre.",
        "",
        "At **MM2 Community**, we provide a safe and secure way to exchange your goods.",
        "",
        "If you have found a trade and want to ensure your safety, you can use our middleman service.",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "**Usage Conditions:**",
        "• Both parties agree to trade before requesting a middleman.",
        "• State the trade and value clearly.",
        "• Fake or troll tickets will result in punishments.",
        "",
        "*Powered by MM2 Community*",
        "",
        "**MM2 Community**",
      ].join("\n"),
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel("Open Ticket")
      .setEmoji("🎟️")
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
    await interaction.reply({
      content: "Only the administrator who started this setup can configure claim roles.",
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket:roles:${mode}:${adminId}`)
    .setTitle(mode === "setup" ? "Ticket Setup" : "Ticket Config");
  const roleInput = new TextInputBuilder()
    .setCustomId("claim_roles")
    .setLabel("Mention roles that can claim tickets")
    .setPlaceholder("<@&role-id> <@&role-id>")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
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
      await interaction.reply({
        content: "Only administrators can save ticket claim roles.",
        ephemeral: true,
      });
      return;
    }

    // Acknowledge immediately: fetching roles and syncing every open
    // ticket's permissions can take longer than Discord's 3-second
    // interaction window, so defer first and edit the reply once done.
    await interaction.deferReply({ ephemeral: true });

    const roleInput = interaction.fields.getTextInputValue("claim_roles");
    const roleIds = parseRoleMentions(roleInput);

    if (roleIds.length === 0) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(BRAND_PURPLE)
            .setTitle(`${BRAND_NAME} · Role Setup`)
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
            .setColor(BRAND_PURPLE)
            .setTitle(`${BRAND_NAME} · Role Setup`)
            .setDescription(
              "One or more of those roles could not be found in this server. Please double-check the role mention or ID and try again.",
            ),
        ],
      });
      return;
    }

    const config = await saveTicketConfig(interaction.guild.id, validRoleIds);
    await syncOpenTicketPermissions(interaction.guild);
    const roleMentions = config.claimRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
    const needsTranscriptChannel = !config.transcriptChannelId;
    const successEmbed = new EmbedBuilder()
      .setColor(BRAND_PURPLE)
      .setTitle(`${BRAND_NAME} · ${mode === "setup" ? "Setup Complete" : "Config Updated"}`)
      .setDescription(
        [
          `Allowed claim roles: ${roleMentions}`,
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
      await interaction.reply({
        content: "Only the administrator who started this setup can pick the transcript channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    const selectedChannelId = interaction.values[0];
    await saveTranscriptChannelConfig(interaction.guild.id, selectedChannelId);

    const confirmEmbed = new EmbedBuilder()
      .setColor(BRAND_PURPLE)
      .setTitle(`${BRAND_NAME} · Transcript Channel Set`)
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
    await message.reply("Only server administrators can use `$say`.");
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
    await interaction.reply({
      content: "Only the administrator who ran `$say` can write this message.",
      ephemeral: true,
    });
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
      await interaction.reply({
        content: "Only the administrator who ran `$say` can write this message.",
        ephemeral: true,
      });
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
        const embed = new EmbedBuilder().setColor(BRAND_PURPLE).setDescription(draft.content);
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
        await channel.permissionOverwrites.set(
          buildUnclaimedTicketOverwrites(guild, ticket),
        );
      }
    }),
  );
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
      .setColor(BRAND_PURPLE)
      .setTitle(`${BRAND_NAME} · Ticket`)
      .setDescription(
        [
          `Welcome <@${interaction.user.id}>. A middleman will be with you shortly.`,
          "",
          `**Other trader**\n${otherTrader}`,
          "",
          `**Trade details**\n${trade}`,
          "",
          "Use `$tickethelp` to see ticket commands.",
        ].join("\n"),
      )
      .setFooter({ text: "MM2 Community" });

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

async function claimTicket(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    await replyToActor(
      actor,
      "You do not have an allowed claim role. An administrator must configure roles with `$ticketsetup` or `$ticketconfig`.",
    );
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
  const nextTicket = { ...ticket, state: "claimed" as const, claimerId };
  await updateTicket(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildClaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send(`Ticket claimed by <@${claimerId}>. Only the ticket owner, assigned staff member, and administrators can view it.`);
  await replyToActor(actor, `You are now handling ${channel}.`);
}

async function unclaimTicket(
  actor: Message | ButtonInteraction,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(actor)) {
    await replyToActor(
      actor,
      "Only an administrator or a member with an allowed claim role can unclaim tickets.",
    );
    return;
  }

  if (ticket.state === "closed") {
    await replyToActor(actor, "This ticket is already closed.");
    return;
  }

  if (ticket.claimerId && ticket.claimerId !== getActorId(actor) && !isAdministrator(actor.member)) {
    await replyToActor(actor, "Only the current claimer or an administrator can unclaim this ticket.");
    return;
  }

  const nextTicket = { ...ticket, state: "open" as const, claimerId: null };
  await updateTicket(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildUnclaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send(`Ticket released by <@${getActorId(actor)}>. It is available for another staff member to claim.`);
  await replyToActor(actor, "The ticket is available again.");
}

async function transferTicket(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(message)) {
    await message.reply(
      "Only an administrator or a member with an allowed claim role can transfer tickets.",
    );
    return;
  }

  if (
    ticket.claimerId &&
    ticket.claimerId !== message.author.id &&
    !isAdministrator(message.member)
  ) {
    await message.reply("Only the current claimer or an administrator can transfer this ticket.");
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

  const nextTicket = { ...ticket, state: "claimed" as const, claimerId: target.id };
  await updateTicket(channel, nextTicket);
  await channel.permissionOverwrites.set(
    buildClaimedTicketOverwrites(channel.guild, nextTicket),
  );
  await channel.send(`Ticket transferred to <@${target.id}> by <@${message.author.id}>.`);
  await message.react("✅");
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
    await replyToActor(actor, "Only an administrator or a member with an allowed claim role can close tickets.");
    return;
  }

  if (ticket.state === "closed" || closingTicketChannelIds.has(channel.id)) {
    await replyToActor(actor, "This ticket is already closing or closed.");
    return;
  }
  closingTicketChannelIds.add(channel.id);

  const nextTicket = { ...ticket, state: "closed" as const };

  await channel.send(`🔒 Ticket is being closed by <@${getActorId(actor)}>...`);

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
      ? `✅ Ticket closed. Transcript saved to ${logChannel}.`
      : "✅ Ticket closed. Transcript could not be saved automatically.",
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
    await replyToActor(
      actor,
      "Only an administrator or a member with an allowed claim role can create transcripts.",
    );
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
    await message.reply("Only the ticket owner, a member with an allowed claim role, or an administrator can add members.");
    return;
  }

  const member = message.mentions.members?.first();
  if (!member) {
    await message.reply("Use `$add @user` to add someone to this ticket.");
    return;
  }

  if (
    member.id === ticket.ownerId ||
    member.id === ticket.claimerId ||
    ticket.additionalMemberIds?.includes(member.id)
  ) {
    await message.reply(`<@${member.id}> already has access to this ticket.`);
    return;
  }

  const nextTicket: TicketMetadata = {
    ...ticket,
    additionalMemberIds: [...(ticket.additionalMemberIds ?? []), member.id],
  };
  await updateTicket(channel, nextTicket);
  await channel.permissionOverwrites.set(buildOverwritesForState(channel.guild, nextTicket));

  await message.reply(`<@${member.id}> was added to the ticket.`);
}

async function removeTicketMember(
  message: Message,
  channel: TextChannel,
  ticket: TicketMetadata,
): Promise<void> {
  if (!canClaimTicket(message) && message.author.id !== ticket.ownerId) {
    await message.reply("Only the ticket owner, a member with an allowed claim role, or an administrator can remove members.");
    return;
  }

  const member = message.mentions.members?.first();
  if (!member) {
    await message.reply("Use `$remove @user` to remove someone from this ticket.");
    return;
  }

  if (member.id === ticket.ownerId) {
    await message.reply("The ticket owner cannot be removed from their own ticket.");
    return;
  }

  if (member.id === ticket.claimerId) {
    await message.reply("The current claimer cannot be removed. Use `$unclaim` or `$transfer` first.");
    return;
  }

  if (!ticket.additionalMemberIds?.includes(member.id)) {
    await message.reply(`<@${member.id}> was not added to this ticket.`);
    return;
  }

  const nextTicket: TicketMetadata = {
    ...ticket,
    additionalMemberIds: ticket.additionalMemberIds.filter((id) => id !== member.id),
  };
  await updateTicket(channel, nextTicket);
  await channel.permissionOverwrites.set(buildOverwritesForState(channel.guild, nextTicket));

  await message.reply(`<@${member.id}> was removed from the ticket.`);
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

async function sendTicketHelp(message: Message): Promise<void> {
  await message.reply({ embeds: [ticketHelpEmbed()] });
}

function ticketHelpText(): string {
  return [
    ...TICKET_COMMAND_GUIDE.map(([command, description]) => `${command} — ${description}`),
  ].join("\n");
}

function commandListText(): string {
  return [
    "`$cmd` — show this full command guide",
    ...TICKET_COMMAND_GUIDE.map(([command, description]) => `${command} — ${description}`),
    ...TEMP_COMMAND_GUIDE.map(([command, description]) => `${command} — ${description}`),
    ...ADMIN_COMMAND_GUIDE.map(([command, description]) => `${command} — ${description}`),
  ].join("\n");
}

function commandListEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND_PURPLE)
    .setTitle(`${BRAND_NAME} · Command Guide`)
    .setDescription(commandListText())
    .setFooter({ text: "New commands will appear here automatically." });
}

function ticketHelpEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(BRAND_PURPLE)
    .setTitle(`${BRAND_NAME} · Ticket Commands`)
    .setDescription("Open tickets with the panel button, then use the commands below in a ticket channel.")
    .addFields(
      {
        name: "Everyone",
        value: "Open a ticket — click **Open Ticket** on the panel.",
      },
      {
        name: "Ticket users",
        value: [
          "`$add @user` — add someone to your ticket",
          "`$close` — close the ticket (configured staff roles/admins)",
        ].join("\n"),
      },
      {
        name: "Configured staff roles and administrators",
        value: [
          "`$claim` — claim the current ticket",
          "`$unclaim` — release the current ticket",
          "`$transfer @user` — transfer it to another configured staff member",
          "`$add @user` — add someone to the ticket",
          "`$remove @user` — remove a previously added member",
          "`$close` — close and lock the ticket",
          "`$tickettranscript` — save and log the conversation",
        ].join("\n"),
      },
      {
        name: "Administrators",
        value: "`$ticketsetup` — configure roles and post the panel\n`$ticketconfig` — change claim roles later",
      },
    )
    .setFooter({ text: "Keep ticket conversations inside the ticket channel." });
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
