import {
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  joinVoiceChannel,
  AudioPlayer
} from '@discordjs/voice';
import { 
  VoiceChannel, 
  StageChannel, 
  Client,
  PermissionsBitField 
} from 'discord.js';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import { settingsManager } from '@config/settings';
import { VoiceReceiver } from './receiver';
import { recordingManager } from './recording-manager';

const logger = createLogger('VoiceConnection');

export interface ConnectionInfo {
  guildId: string;
  channelId: string;
  channelName: string;
  connection: VoiceConnection;
  receiver: VoiceReceiver;
  player: AudioPlayer;
  joinedAt: Date;
  lastActivity: Date;
  reconnectAttempts: number;
}

export class VoiceConnectionManager {
  private connections: Map<string, ConnectionInfo> = new Map();
  private client: Client | null = null;
  private isInitialized: boolean = false;
  private readonly maxConnections: number = config.maxConcurrentConnections;

  public async initialize(client: Client): Promise<void> {
    this.client = client;
    this.isInitialized = true;
    
    logger.info('Voice connection manager initialized', {
      maxConnections: this.maxConnections
    });
  }

  public async joinChannel(channel: VoiceChannel | StageChannel): Promise<VoiceConnection> {
    if (!this.isInitialized || !this.client) {
      throw new Error('Voice connection manager not initialized');
    }

    const guildId = channel.guild.id;
    const channelId = channel.id;

    // Check if already connected to this channel
    const existingConnection = this.connections.get(guildId);
    if (existingConnection && existingConnection.channelId === channelId) {
      logger.debug('Already connected to this channel', { guildId, channelId });
      return existingConnection.connection;
    }

    // Check connection limits
    if (this.connections.size >= this.maxConnections) {
      throw new Error(`Maximum number of voice connections reached (${this.maxConnections})`);
    }

    // Validate permissions
    await this.validateChannelPermissions(channel);

    try {
      logger.info('Joining voice channel', {
        guildId,
        channelId,
        channelName: channel.name,
        memberCount: channel.members.size
      });

      // Leave existing connection in this guild if any
      if (existingConnection) {
        await this.leaveChannel(guildId);
      }

      // Create voice connection with proper configuration
      const connection = joinVoiceChannel({
        channelId: channelId,
        guildId: guildId,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false, // Critical: allows receiving audio
        selfMute: true,  // We don't need to transmit audio initially
      });

      // Create audio player
      const player = createAudioPlayer();

      // Create voice receiver for audio capture
      const receiver = new VoiceReceiver(connection, this.client!, guildId);

      // Set up connection event handlers
      this.setupConnectionEventHandlers(connection, guildId);

      // Create connection info
      const connectionInfo: ConnectionInfo = {
        guildId,
        channelId,
        channelName: channel.name,
        connection,
        receiver,
        player,
        joinedAt: new Date(),
        lastActivity: new Date(),
        reconnectAttempts: 0
      };

      // Subscribe player to connection
      connection.subscribe(player);

      // Store connection
      this.connections.set(guildId, connectionInfo);

      // Wait for connection to be ready
      await this.waitForConnectionReady(connection, guildId);

      // Initialize receiver
      await receiver.initialize();

      logger.info('Successfully joined voice channel', {
        guildId,
        channelId,
        channelName: channel.name,
        status: connection.state.status
      });

      return connection;

    } catch (error) {
      logger.error('Failed to join voice channel:', error);
      
      // Clean up failed connection
      const failedConnection = this.connections.get(guildId);
      if (failedConnection) {
        await this.cleanupConnection(guildId);
      }

      throw error;
    }
  }

  public async leaveChannel(guildId: string): Promise<void> {
    const connectionInfo = this.connections.get(guildId);
    if (!connectionInfo) {
      logger.debug('No connection found for guild', { guildId });
      return;
    }

    logger.info('Leaving voice channel', {
      guildId,
      channelId: connectionInfo.channelId,
      channelName: connectionInfo.channelName
    });

    await this.cleanupConnection(guildId);
  }

  private async cleanupConnection(guildId: string): Promise<void> {
    const connectionInfo = this.connections.get(guildId);
    if (!connectionInfo) return;

    try {
      // Stop audio receiver
      if (connectionInfo.receiver) {
        await connectionInfo.receiver.cleanup();
      }

      // Stop audio player
      if (connectionInfo.player) {
        connectionInfo.player.stop();
      }

      // Destroy voice connection
      if (connectionInfo.connection) {
        connectionInfo.connection.destroy();
      }

      // Remove from connections map
      this.connections.delete(guildId);

      logger.info('Connection cleaned up successfully', {
        guildId,
        channelId: connectionInfo.channelId
      });

    } catch (error) {
      logger.error('Error during connection cleanup:', error);
      // Force remove from map even if cleanup failed
      this.connections.delete(guildId);
    }
  }

  private setupConnectionEventHandlers(connection: VoiceConnection, guildId: string): void {
    // Ready state
    connection.on(VoiceConnectionStatus.Ready, withLogging(() => {
      logger.info('Voice connection ready', { guildId });
      this.updateLastActivity(guildId);
    }, 'ConnectionReady'));

    // Disconnected state
    connection.on(VoiceConnectionStatus.Disconnected, withLogging(async () => {
      logger.warn('Voice connection disconnected', { guildId });

      // Attempt to reconnect
      await this.handleDisconnection(guildId);
    }, 'ConnectionDisconnected'));

    // Destroyed state
    connection.on(VoiceConnectionStatus.Destroyed, withLogging(() => {
      logger.info('Voice connection destroyed', { guildId });
      this.connections.delete(guildId);
    }, 'ConnectionDestroyed'));

    // Signalling state
    connection.on(VoiceConnectionStatus.Signalling, withLogging(() => {
      logger.debug('Voice connection signalling', { guildId });
    }, 'ConnectionSignalling'));

    // Connecting state
    connection.on(VoiceConnectionStatus.Connecting, withLogging(() => {
      logger.debug('Voice connection connecting', { guildId });
    }, 'ConnectionConnecting'));

    // Error handling
    connection.on('error', withLogging((error) => {
      logger.error('Voice connection error:', { guildId, error });
    }, 'ConnectionError'));

    // State change logging
    connection.on('stateChange', withLogging((oldState, newState) => {
      logger.debug('Voice connection state change', {
        guildId,
        oldStatus: oldState.status,
        newStatus: newState.status
      });
    }, 'ConnectionStateChange'));
  }

  private async handleDisconnection(guildId: string): Promise<void> {
    const connectionInfo = this.connections.get(guildId);
    if (!connectionInfo) return;

    connectionInfo.reconnectAttempts++;
    
    if (connectionInfo.reconnectAttempts >= config.reconnectAttempts) {
      logger.error('Max reconnection attempts reached, cleaning up connection', {
        guildId,
        attempts: connectionInfo.reconnectAttempts
      });
      
      await this.cleanupConnection(guildId);
      return;
    }

    logger.info('Attempting to reconnect voice connection', {
      guildId,
      attempt: connectionInfo.reconnectAttempts,
      maxAttempts: config.reconnectAttempts
    });

    try {
      // Wait a bit before reconnecting
      await new Promise(resolve => setTimeout(resolve, 2000 * connectionInfo.reconnectAttempts));

      // Try to rejoin the channel
      if (this.client) {
        const guild = this.client.guilds.cache.get(guildId);
        if (guild) {
          const channel = guild.channels.cache.get(connectionInfo.channelId);
          if (channel && (channel.type === 2 || channel.type === 13)) { // Voice or Stage channel
            await this.joinChannel(channel as VoiceChannel | StageChannel);
            return;
          }
        }
      }

      throw new Error('Could not find channel for reconnection');
      
    } catch (error) {
      logger.error('Reconnection attempt failed:', { guildId, error });
      // Will retry on next disconnection event if under max attempts
    }
  }

  private async waitForConnectionReady(connection: VoiceConnection, guildId: string): Promise<void> {
    const timeout = settingsManager.getVoiceSettings().connectionTimeout;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout after ${timeout}ms for guild ${guildId}`));
      }, timeout);

      const onReady = () => {
        clearTimeout(timer);
        connection.off(VoiceConnectionStatus.Ready, onReady);
        connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
        resolve();
      };

      const onDestroyed = () => {
        clearTimeout(timer);
        connection.off(VoiceConnectionStatus.Ready, onReady);
        connection.off(VoiceConnectionStatus.Destroyed, onDestroyed);
        reject(new Error('Connection was destroyed before becoming ready'));
      };

      connection.on(VoiceConnectionStatus.Ready, onReady);
      connection.on(VoiceConnectionStatus.Destroyed, onDestroyed);

      // If already ready, resolve immediately
      if (connection.state.status === VoiceConnectionStatus.Ready) {
        onReady();
      }
    });
  }

  private async validateChannelPermissions(channel: VoiceChannel | StageChannel): Promise<void> {
    if (!this.client?.user) {
      throw new Error('Client not ready');
    }

    const botMember = channel.guild.members.cache.get(this.client.user.id);
    if (!botMember) {
      throw new Error('Bot is not a member of this guild');
    }

    const permissions = channel.permissionsFor(botMember);
    if (!permissions) {
      throw new Error('Could not determine bot permissions for channel');
    }

    const requiredPermissions = [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak
    ];

    const missingPermissions = requiredPermissions.filter(permission => 
      !permissions.has(permission)
    );

    if (missingPermissions.length > 0) {
      const missingNames = missingPermissions.map(p => 
        Object.keys(PermissionsBitField.Flags).find(key => 
          PermissionsBitField.Flags[key as keyof typeof PermissionsBitField.Flags] === p
        )
      );
      
      throw new Error(`Missing required permissions: ${missingNames.join(', ')}`);
    }

    logger.debug('Channel permissions validated', {
      channelId: channel.id,
      channelName: channel.name,
      guildId: channel.guild.id
    });
  }

  private updateLastActivity(guildId: string): void {
    const connectionInfo = this.connections.get(guildId);
    if (connectionInfo) {
      connectionInfo.lastActivity = new Date();
    }
  }

  // Public methods for external access
  public getConnection(guildId: string): VoiceConnection | null {
    const connectionInfo = this.connections.get(guildId);
    return connectionInfo?.connection || null;
  }

  public getReceiver(guildId: string): VoiceReceiver | null {
    const connectionInfo = this.connections.get(guildId);
    return connectionInfo?.receiver || null;
  }

  public isConnectedToChannel(channelId: string): boolean {
    return Array.from(this.connections.values()).some(
      conn => conn.channelId === channelId
    );
  }

  public getActiveConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values());
  }

  public getConnectionInfo(guildId: string): ConnectionInfo | null {
    return this.connections.get(guildId) || null;
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up all voice connections');
    
    const cleanupPromises = Array.from(this.connections.keys()).map(guildId =>
      this.cleanupConnection(guildId)
    );

    await Promise.allSettled(cleanupPromises);
    
    this.connections.clear();
    logger.info('All voice connections cleaned up');
  }

  // Health check methods
  public async healthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];
    
    if (!this.isInitialized) {
      issues.push('Voice connection manager not initialized');
    }

    if (!this.client) {
      issues.push('Discord client not available');
    }

    // Check each connection
    for (const [guildId, connectionInfo] of this.connections) {
      const connection = connectionInfo.connection;
      
      if (connection.state.status === VoiceConnectionStatus.Destroyed) {
        issues.push(`Connection for guild ${guildId} is destroyed`);
      }
      
      if (connection.state.status === VoiceConnectionStatus.Disconnected) {
        issues.push(`Connection for guild ${guildId} is disconnected`);
      }
      
      // Check if connection is stale
      const timeSinceLastActivity = Date.now() - connectionInfo.lastActivity.getTime();
      if (timeSinceLastActivity > 300000) { // 5 minutes
        issues.push(`Connection for guild ${guildId} has been inactive for ${Math.round(timeSinceLastActivity / 1000)}s`);
      }
    }

    return {
      healthy: issues.length === 0,
      issues
    };
  }
}

// Create singleton instance
export const voiceConnectionManager = new VoiceConnectionManager();

export default voiceConnectionManager;