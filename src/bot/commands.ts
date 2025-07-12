import { SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '@utils/logger';
import { voiceConnectionManager } from '@voice/connection';
import { recordCommand } from '@voice/recording-commands';
// import { transcribeCommand } from '@transcription/transcription-commands';
// import SummarizationSystem from '@summarization/index';

const logger = createLogger('Commands');

export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Join command
export const joinCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join your current voice channel'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as any;
    
    if (!member?.voice?.channel) {
      await interaction.reply({
        content: 'You need to be in a voice channel for me to join!',
        ephemeral: true
      });
      return;
    }

    try {
      await voiceConnectionManager.joinChannel(member.voice.channel);
      await interaction.reply({
        content: `Successfully joined ${member.voice.channel.name}!`,
        ephemeral: true
      });
    } catch (error) {
      logger.error('Failed to join channel:', error);
      await interaction.reply({
        content: 'Failed to join the voice channel. Please try again.',
        ephemeral: true
      });
    }
  }
};

// Leave command
export const leaveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the current voice channel'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    try {
      await voiceConnectionManager.leaveChannel(interaction.guildId);
      await interaction.reply({
        content: 'Left the voice channel!',
        ephemeral: true
      });
    } catch (error) {
      logger.error('Failed to leave channel:', error);
      await interaction.reply({
        content: 'Failed to leave the voice channel.',
        ephemeral: true
      });
    }
  }
};

// Status command
export const statusCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot status and connection information'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    const connections = voiceConnectionManager.getActiveConnections();
    const uptime = interaction.client.uptime;
    const latency = interaction.client.ws.ping;

    const embed = {
      title: '🤖 Bot Status',
      fields: [
        {
          name: '📊 General',
          value: [
            `Uptime: ${uptime ? formatUptime(uptime) : 'Unknown'}`,
            `Latency: ${latency}ms`,
            `Guilds: ${interaction.client.guilds.cache.size}`
          ].join('\n'),
          inline: true
        },
        {
          name: '🔊 Voice Connections',
          value: connections.length > 0 
            ? connections.map(conn => 
                `${conn.channelName} (${conn.connection.state.status})`
              ).join('\n')
            : 'No active connections',
          inline: true
        },
        {
          name: '🎙️ Audio Monitoring',
          value: connections.reduce((total, conn) => {
            const receiver = conn.receiver;
            return total + (receiver ? receiver.getActiveStreamCount() : 0);
          }, 0) + ' active streams',
          inline: true
        }
      ],
      color: 0x00ff00,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Discord Voice Companion Bot'
      }
    };

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
};

// Health command (admin only)
export const healthCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('health')
    .setDescription('Show detailed health information (admin only)'),
  
  async execute(interaction: ChatInputCommandInteraction) {
    // Check if user has admin permissions
    const member = interaction.member as any;
    if (!member?.permissions?.has('Administrator')) {
      await interaction.reply({
        content: 'You need administrator permissions to use this command.',
        ephemeral: true
      });
      return;
    }

    const healthCheck = await voiceConnectionManager.healthCheck();
    const connections = voiceConnectionManager.getActiveConnections();

    const embed = {
      title: '🏥 Health Check',
      fields: [
        {
          name: '🟢 Overall Status',
          value: healthCheck.healthy ? 'Healthy' : 'Issues Detected',
          inline: true
        },
        {
          name: '🔗 Active Connections',
          value: connections.length.toString(),
          inline: true
        },
        {
          name: '⚠️ Issues',
          value: healthCheck.issues.length > 0 
            ? healthCheck.issues.join('\n')
            : 'None detected',
          inline: false
        }
      ],
      color: healthCheck.healthy ? 0x00ff00 : 0xff0000,
      timestamp: new Date().toISOString()
    };

    // Add connection details
    if (connections.length > 0) {
      connections.forEach((conn, index) => {
        const receiver = conn.receiver;
        embed.fields.push({
          name: `🔊 Connection ${index + 1}: ${conn.channelName}`,
          value: [
            `Status: ${conn.connection.state.status}`,
            `Active Streams: ${receiver ? receiver.getActiveStreamCount() : 0}`,
            `Segments: ${receiver ? receiver.getSegmentCount() : 0}`,
            `Joined: ${conn.joinedAt.toLocaleString()}`,
            `Last Activity: ${conn.lastActivity.toLocaleString()}`
          ].join('\n'),
          inline: true
        });
      });
    }

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  }
};

function formatUptime(uptime: number): string {
  const seconds = Math.floor(uptime / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Function to get all commands including dynamic summarization commands
export function getAllCommands(summarizationSystem?: any): Command[] {
  const baseCommands = [
    joinCommand,
    leaveCommand,
    statusCommand,
    healthCommand,
    recordCommand
    // transcribeCommand
  ];

  // Add summarization commands if system is available and initialized
  if (summarizationSystem && summarizationSystem.isEnabled()) {
    const summaryCommands = summarizationSystem.getCommands();
    baseCommands.push(...summaryCommands);
  }

  return baseCommands;
}

// Export base commands for backward compatibility
export const commands: Command[] = [
  joinCommand,
  leaveCommand,
  statusCommand,
  healthCommand,
  recordCommand
  // transcribeCommand
];

export default commands;