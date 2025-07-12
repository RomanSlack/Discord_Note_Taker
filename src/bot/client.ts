import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ActivityType,
  PresenceUpdateStatus,
  ClientEvents,
  Collection
} from 'discord.js';
import { config } from '@config/environment';
import { settingsManager } from '@config/settings';
import { createLogger, withLogging } from '@utils/logger';

const logger = createLogger('DiscordClient');

export interface BotClient extends Client {
  commands?: Collection<string, any>;
  cooldowns?: Collection<string, Collection<string, number>>;
}

class DiscordClientManager {
  private client: BotClient;
  private isReady: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = config.reconnectAttempts;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ],
      partials: [
        Partials.Message,
        Partials.Channel,
        Partials.User,
        Partials.GuildMember
      ],
      presence: {
        status: settingsManager.getBotSettings().presenceStatus as PresenceUpdateStatus,
        activities: [{
          name: settingsManager.getBotSettings().activityName,
          type: ActivityType.Listening
        }]
      }
    });

    // Initialize collections
    this.client.commands = new Collection();
    this.client.cooldowns = new Collection();

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Ready event
    this.client.once('ready', withLogging(this.onReady.bind(this), 'ClientReady'));
    
    // Error handling
    this.client.on('error', withLogging(this.onError.bind(this), 'ClientError'));
    this.client.on('warn', withLogging(this.onWarn.bind(this), 'ClientWarn'));
    
    // Connection events
    this.client.on('disconnect', withLogging(this.onDisconnect.bind(this), 'ClientDisconnect'));
    this.client.on('reconnecting', withLogging(this.onReconnecting.bind(this), 'ClientReconnecting'));
    this.client.on('resumed', withLogging(this.onResumed.bind(this), 'ClientResumed'));
    
    // Shard events for scalability
    this.client.on('shardReady', withLogging(this.onShardReady.bind(this), 'ShardReady'));
    this.client.on('shardError', withLogging(this.onShardError.bind(this), 'ShardError'));
    this.client.on('shardDisconnect', withLogging(this.onShardDisconnect.bind(this), 'ShardDisconnect'));
    this.client.on('shardReconnecting', withLogging(this.onShardReconnecting.bind(this), 'ShardReconnecting'));
    this.client.on('shardResume', withLogging(this.onShardResume.bind(this), 'ShardResume'));

    // Rate limit handling
    this.client.rest.on('rateLimited', withLogging(this.onRateLimit.bind(this), 'RateLimit'));
  }

  private async onReady(client: Client<true>): Promise<void> {
    this.isReady = true;
    this.reconnectAttempts = 0;

    logger.info('Discord client ready', {
      tag: client.user.tag,
      id: client.user.id,
      guilds: client.guilds.cache.size,
      users: client.users.cache.size,
      channels: client.channels.cache.size
    });

    // Update presence based on configuration
    await this.updatePresence();

    // Log shard information if sharded
    if (client.shard) {
      logger.info('Shard information', {
        shardId: client.shard.ids,
        totalShards: client.shard.count
      });
    }

    // Validate guild access if specific guild configured
    if (config.guildId) {
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild) {
        logger.warn('Configured guild not found or bot not invited', {
          guildId: config.guildId
        });
      } else {
        logger.info('Connected to configured guild', {
          guildId: guild.id,
          guildName: guild.name,
          memberCount: guild.memberCount
        });
      }
    }
  }

  private onError(error: Error): void {
    logger.error('Discord client error:', error);
    
    // Handle specific error types
    if (error.message.includes('TOKEN_INVALID')) {
      logger.error('Invalid Discord token provided. Please check your DISCORD_TOKEN environment variable.');
      process.exit(1);
    }
    
    if (error.message.includes('DISALLOWED_INTENTS')) {
      logger.error('Missing required Discord intents. Please enable them in the Discord Developer Portal.');
      process.exit(1);
    }
  }

  private onWarn(warning: string): void {
    logger.warn('Discord client warning:', { warning });
  }

  private onDisconnect(): void {
    this.isReady = false;
    logger.warn('Discord client disconnected');
  }

  private onReconnecting(): void {
    this.reconnectAttempts++;
    logger.info('Discord client reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts
    });

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max reconnection attempts reached, shutting down');
      process.exit(1);
    }
  }

  private onResumed(): void {
    this.isReady = true;
    this.reconnectAttempts = 0;
    logger.info('Discord client resumed connection');
  }

  private onShardReady(shardId: number): void {
    logger.info('Shard ready', { shardId });
  }

  private onShardError(error: Error, shardId: number): void {
    logger.error('Shard error', { error, shardId });
  }

  private onShardDisconnect(event: any, shardId: number): void {
    logger.warn('Shard disconnected', { event, shardId });
  }

  private onShardReconnecting(shardId: number): void {
    logger.info('Shard reconnecting', { shardId });
  }

  private onShardResume(replayed: number, shardId: number): void {
    logger.info('Shard resumed', { replayed, shardId });
  }

  private onRateLimit(rateLimitData: any): void {
    logger.warn('Rate limit hit', {
      timeout: rateLimitData.timeout,
      limit: rateLimitData.limit,
      method: rateLimitData.method,
      path: rateLimitData.path,
      route: rateLimitData.route
    });
  }

  public async updatePresence(): Promise<void> {
    if (!this.client.user || !this.isReady) return;

    try {
      const botSettings = settingsManager.getBotSettings();
      
      await this.client.user.setPresence({
        status: botSettings.presenceStatus as PresenceUpdateStatus,
        activities: [{
          name: botSettings.activityName,
          type: ActivityType[botSettings.activityType]
        }]
      });

      logger.debug('Updated bot presence', {
        status: botSettings.presenceStatus,
        activity: botSettings.activityName,
        type: botSettings.activityType
      });
    } catch (error) {
      logger.error('Failed to update presence:', error);
    }
  }

  public async login(): Promise<void> {
    try {
      logger.info('Logging in to Discord...');
      await this.client.login(config.discordToken);
    } catch (error) {
      logger.error('Failed to login to Discord:', error);
      throw error;
    }
  }

  public async logout(): Promise<void> {
    try {
      if (this.isReady) {
        logger.info('Logging out from Discord...');
        await this.client.destroy();
        this.isReady = false;
      }
    } catch (error) {
      logger.error('Failed to logout from Discord:', error);
      throw error;
    }
  }

  public getClient(): BotClient {
    return this.client;
  }

  public isClientReady(): boolean {
    return this.isReady && this.client.isReady();
  }

  public getUptime(): number | null {
    return this.client.uptime;
  }

  public getLatency(): number {
    return this.client.ws.ping;
  }

  public getGuildCount(): number {
    return this.client.guilds.cache.size;
  }

  public getUserCount(): number {
    return this.client.users.cache.size;
  }

  // Event listener registration helpers
  public on<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): void {
    this.client.on(event, listener);
  }

  public once<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): void {
    this.client.once(event, listener);
  }

  public off<K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void): void {
    this.client.off(event, listener);
  }

  // Graceful shutdown
  public async shutdown(): Promise<void> {
    logger.info('Initiating graceful shutdown...');
    
    try {
      // Update presence to offline
      if (this.client.user && this.isReady) {
        await this.client.user.setPresence({
          status: 'invisible',
          activities: []
        });
      }

      // Destroy client connection
      await this.logout();
      
      logger.info('Graceful shutdown completed');
    } catch (error) {
      logger.error('Error during shutdown:', error);
      throw error;
    }
  }
}

// Create singleton instance
export const discordClient = new DiscordClientManager();

// Export for external access
export default discordClient;