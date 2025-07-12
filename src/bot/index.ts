import 'dotenv/config';
import { 
  VoiceState, 
  Interaction, 
  Message,
  ChannelType,
  VoiceChannel,
  StageChannel 
} from 'discord.js';
import { discordClient } from './client';
import { voiceConnectionManager } from '@voice/connection';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import { settingsManager } from '@config/settings';
import { commands, getAllCommands } from './commands';
import SummarizationSystem from '@summarization/index';
import TranscriptManager from '@transcription/transcript-manager';

const logger = createLogger('BotMain');

class DiscordVoiceBot {
  private isInitialized: boolean = false;
  private transcriptManager: TranscriptManager;
  private summarizationSystem: SummarizationSystem | null = null;
  private availableCommands: any[] = [];

  constructor() {
    // Initialize transcript manager
    this.transcriptManager = new TranscriptManager('./transcripts');
    
    // Initialize summarization system if OpenAI key is available
    if (config.openAiApiKey) {
      this.summarizationSystem = new SummarizationSystem(this.transcriptManager);
    } else {
      logger.warn('OpenAI API key not configured - summarization features will be disabled');
    }

    this.setupEventHandlers();
    this.setupGracefulShutdown();
  }

  private setupEventHandlers(): void {
    // Bot ready handler
    discordClient.once('ready', withLogging(this.onReady.bind(this), 'BotReady'));

    // Voice state update handler - core functionality for voice monitoring
    discordClient.on('voiceStateUpdate', withLogging(this.onVoiceStateUpdate.bind(this), 'VoiceStateUpdate'));

    // Interaction handler for slash commands
    discordClient.on('interactionCreate', withLogging(this.onInteractionCreate.bind(this), 'InteractionCreate'));

    // Message handler for text commands (optional)
    discordClient.on('messageCreate', withLogging(this.onMessageCreate.bind(this), 'MessageCreate'));

    // Guild events for monitoring server changes
    discordClient.on('guildCreate', withLogging(this.onGuildCreate.bind(this), 'GuildCreate'));
    discordClient.on('guildDelete', withLogging(this.onGuildDelete.bind(this), 'GuildDelete'));

    // Channel events for voice channel monitoring
    discordClient.on('channelCreate', withLogging(this.onChannelCreate.bind(this), 'ChannelCreate'));
    discordClient.on('channelDelete', withLogging(this.onChannelDelete.bind(this), 'ChannelDelete'));
  }

  private async onReady(): Promise<void> {
    if (!discordClient.isClientReady()) {
      logger.error('Client ready event fired but client is not ready');
      return;
    }

    const client = discordClient.getClient();
    
    logger.info('Discord Voice Companion Bot is ready!', {
      username: client.user?.username,
      id: client.user?.id,
      guilds: discordClient.getGuildCount(),
      users: discordClient.getUserCount(),
      latency: discordClient.getLatency()
    });

    // Initialize voice connection manager
    await voiceConnectionManager.initialize(client);
    
    // Initialize summarization system if available
    if (this.summarizationSystem) {
      try {
        await this.summarizationSystem.initialize();
        logger.info('Summarization system initialized successfully');
      } catch (error) {
        logger.error('Failed to initialize summarization system:', error);
        this.summarizationSystem = null;
      }
    }

    // Set up available commands (including summarization commands if available)
    this.availableCommands = getAllCommands(this.summarizationSystem);
    logger.info('Commands initialized', { commandCount: this.availableCommands.length });
    
    this.isInitialized = true;

    // Auto-join configured channels if specified
    await this.autoJoinChannels();

    logger.info('Bot initialization completed successfully');
  }

  private async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    try {
      const userId = newState.id;
      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      logger.debug('Voice state update', {
        userId,
        oldChannelId: oldChannel?.id,
        newChannelId: newChannel?.id,
        oldChannelName: oldChannel?.name,
        newChannelName: newChannel?.name,
        selfDeaf: newState.selfDeaf,
        selfMute: newState.selfMute,
        serverDeaf: newState.deaf,
        serverMute: newState.mute
      });

      // Handle user joining a voice channel
      if (!oldChannel && newChannel) {
        await this.handleUserJoinedVoice(newState, newChannel);
      }
      
      // Handle user leaving a voice channel
      else if (oldChannel && !newChannel) {
        await this.handleUserLeftVoice(oldState, oldChannel);
      }
      
      // Handle user switching voice channels
      else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        await this.handleUserSwitchedVoice(oldState, newState, oldChannel, newChannel);
      }
      
      // Handle voice state changes (mute/deaf) in same channel
      else if (oldChannel && newChannel && oldChannel.id === newChannel.id) {
        await this.handleVoiceStateChange(oldState, newState);
      }

    } catch (error) {
      logger.error('Error handling voice state update:', error);
    }
  }

  private async handleUserJoinedVoice(
    voiceState: VoiceState, 
    channel: VoiceChannel | StageChannel
  ): Promise<void> {
    logger.info('User joined voice channel', {
      userId: voiceState.id,
      username: voiceState.member?.user.username,
      channelId: channel.id,
      channelName: channel.name,
      guildId: channel.guild.id
    });

    // Check if bot should join this channel
    const shouldJoin = await this.shouldJoinChannel(channel);
    if (shouldJoin) {
      await voiceConnectionManager.joinChannel(channel);
    }
  }

  private async handleUserLeftVoice(
    voiceState: VoiceState, 
    channel: VoiceChannel | StageChannel
  ): Promise<void> {
    logger.info('User left voice channel', {
      userId: voiceState.id,
      username: voiceState.member?.user.username,
      channelId: channel.id,
      channelName: channel.name,
      guildId: channel.guild.id
    });

    // Check if bot should leave this channel (e.g., if no other users remain)
    const shouldLeave = await this.shouldLeaveChannel(channel);
    if (shouldLeave) {
      await voiceConnectionManager.leaveChannel(channel.guild.id);
    }
  }

  private async handleUserSwitchedVoice(
    oldState: VoiceState,
    newState: VoiceState,
    oldChannel: VoiceChannel | StageChannel,
    newChannel: VoiceChannel | StageChannel
  ): Promise<void> {
    logger.info('User switched voice channels', {
      userId: newState.id,
      username: newState.member?.user.username,
      oldChannelId: oldChannel.id,
      newChannelId: newChannel.id,
      oldChannelName: oldChannel.name,
      newChannelName: newChannel.name
    });

    // Handle leaving old channel
    const shouldLeaveOld = await this.shouldLeaveChannel(oldChannel);
    if (shouldLeaveOld) {
      await voiceConnectionManager.leaveChannel(oldChannel.guild.id);
    }

    // Handle joining new channel
    const shouldJoinNew = await this.shouldJoinChannel(newChannel);
    if (shouldJoinNew) {
      await voiceConnectionManager.joinChannel(newChannel);
    }
  }

  private async handleVoiceStateChange(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const changes: string[] = [];
    
    if (oldState.selfMute !== newState.selfMute) {
      changes.push(`selfMute: ${oldState.selfMute} -> ${newState.selfMute}`);
    }
    
    if (oldState.selfDeaf !== newState.selfDeaf) {
      changes.push(`selfDeaf: ${oldState.selfDeaf} -> ${newState.selfDeaf}`);
    }
    
    if (oldState.mute !== newState.mute) {
      changes.push(`serverMute: ${oldState.mute} -> ${newState.mute}`);
    }
    
    if (oldState.deaf !== newState.deaf) {
      changes.push(`serverDeaf: ${oldState.deaf} -> ${newState.deaf}`);
    }

    if (changes.length > 0) {
      logger.debug('Voice state changed', {
        userId: newState.id,
        username: newState.member?.user.username,
        channelId: newState.channel?.id,
        changes: changes.join(', ')
      });
    }
  }

  private async shouldJoinChannel(channel: VoiceChannel | StageChannel): Promise<boolean> {
    // Don't join if already connected to this channel
    if (voiceConnectionManager.isConnectedToChannel(channel.id)) {
      return false;
    }

    // Count non-bot members in the channel
    const humanMembers = channel.members.filter(member => !member.user.bot);
    
    // Join if there are human members present
    return humanMembers.size > 0;
  }

  private async shouldLeaveChannel(channel: VoiceChannel | StageChannel): Promise<boolean> {
    // Don't leave if not connected to this channel
    if (!voiceConnectionManager.isConnectedToChannel(channel.id)) {
      return false;
    }

    // Count non-bot members in the channel
    const humanMembers = channel.members.filter(member => !member.user.bot);
    
    // Leave if no human members remain
    return humanMembers.size === 0;
  }

  private async onInteractionCreate(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    logger.info('Slash command received', {
      commandName: interaction.commandName,
      userId: interaction.user.id,
      username: interaction.user.username,
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });

    try {
      // Find and execute the command from available commands
      const command = this.availableCommands.find(cmd => cmd.data.name === interaction.commandName);
      
      if (!command) {
        await interaction.reply({
          content: 'Unknown command.',
          ephemeral: true
        });
        return;
      }

      await command.execute(interaction);
      
    } catch (error) {
      logger.error('Error handling interaction:', error);
      
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'An error occurred while processing your command.',
          ephemeral: true
        }).catch(() => {});
      }
    }
  }


  private async onMessageCreate(message: Message): Promise<void> {
    // Ignore bot messages
    if (message.author.bot) return;

    const botSettings = settingsManager.getBotSettings();
    
    // Handle prefix commands (optional)
    if (message.content.startsWith(botSettings.commandPrefix)) {
      await this.handlePrefixCommand(message);
    }
  }

  private async handlePrefixCommand(message: Message): Promise<void> {
    const botSettings = settingsManager.getBotSettings();
    const args = message.content.slice(botSettings.commandPrefix.length).trim().split(/ +/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    logger.debug('Prefix command received', {
      commandName,
      userId: message.author.id,
      username: message.author.username,
      guildId: message.guildId,
      channelId: message.channelId
    });

    // Basic prefix commands can be implemented here
    // For now, we'll focus on slash commands
  }

  private onGuildCreate(guild: any): void {
    logger.info('Bot added to new guild', {
      guildId: guild.id,
      guildName: guild.name,
      memberCount: guild.memberCount
    });
  }

  private onGuildDelete(guild: any): void {
    logger.info('Bot removed from guild', {
      guildId: guild.id,
      guildName: guild.name
    });

    // Clean up any voice connections for this guild
    voiceConnectionManager.leaveChannel(guild.id).catch((error) => {
      logger.error('Failed to clean up voice connection on guild leave:', error);
    });
  }

  private onChannelCreate(channel: any): void {
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
      logger.debug('Voice channel created', {
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guildId
      });
    }
  }

  private onChannelDelete(channel: any): void {
    if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
      logger.debug('Voice channel deleted', {
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guildId
      });

      // Clean up any connections to this channel
      if (voiceConnectionManager.isConnectedToChannel(channel.id)) {
        voiceConnectionManager.leaveChannel(channel.guildId).catch((error) => {
          logger.error('Failed to clean up voice connection on channel delete:', error);
        });
      }
    }
  }

  private async autoJoinChannels(): Promise<void> {
    // Auto-join functionality can be implemented here
    // For now, we'll rely on voice state updates to trigger joins
    logger.debug('Auto-join channels feature ready');
  }

  private formatUptime(uptime: number): string {
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private setupGracefulShutdown(): void {
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      try {
        // Cleanup summarization system
        if (this.summarizationSystem) {
          await this.summarizationSystem.cleanup();
          logger.info('Summarization system cleaned up');
        }

        // Cleanup transcript manager
        await this.transcriptManager.cleanup();
        logger.info('Transcript manager cleaned up');
        
        // Disconnect from all voice channels
        await voiceConnectionManager.cleanup();
        
        // Shutdown Discord client
        await discordClient.shutdown();
        
        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // nodemon restart
  }

  public async start(): Promise<void> {
    try {
      logger.info('Starting Discord Voice Companion Bot...');
      
      // Validate configuration
      if (!config.discordToken || !config.clientId) {
        throw new Error('Missing required Discord configuration');
      }

      // Create logs directory if it doesn't exist
      if (config.logToFile) {
        await import('fs').then(fs => {
          if (!fs.existsSync('logs')) {
            fs.mkdirSync('logs', { recursive: true });
          }
        });
      }

      // Login to Discord
      await discordClient.login();
      
      logger.info('Bot startup initiated successfully');
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  public isReady(): boolean {
    return this.isInitialized && discordClient.isClientReady();
  }
}

// Create and start the bot
const bot = new DiscordVoiceBot();

// Start the bot if this file is run directly
if (require.main === module) {
  bot.start().catch((error) => {
    logger.error('Fatal error starting bot:', error);
    process.exit(1);
  });
}

export default bot;