import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '@utils/logger';
import { voiceConnectionManager } from '@voice/connection';
import { SimpleRecorder } from '@voice/simple-recorder';

const logger = createLogger('RecordingCommands');

// Simple recorder instance
let simpleRecorder: SimpleRecorder;

// Initialize the simple recorder
export function initializeRecorder(client: any) {
  simpleRecorder = new SimpleRecorder(client);
}

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Record Start Command
export const recordStartCommand = {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Recording management commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start recording voice channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Voice channel to record (defaults to your current channel)')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stop')
        .setDescription('Stop current recording session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show recording session status')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (!simpleRecorder) {
      await interaction.reply({
        content: '❌ Recording system not initialized.',
        ephemeral: true
      });
      return;
    }

    switch (subcommand) {
      case 'start':
        await handleRecordStart(interaction);
        break;
      case 'stop':
        await handleRecordStop(interaction);
        break;
      case 'status':
        await handleRecordStatus(interaction);
        break;
      default:
        await interaction.reply({
          content: 'Unknown recording command.',
          ephemeral: true
        });
    }
  }
};

async function handleRecordStart(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    // Check if already recording
    const activeSession = simpleRecorder.getActiveSession(interaction.guildId);
    if (activeSession) {
      await interaction.reply({
        content: '⚠️ Recording is already active in this server!',
        ephemeral: true
      });
      return;
    }

    // Get target channel
    const targetChannel = interaction.options.getChannel('channel');
    const member = interaction.member as any;
    
    let voiceChannel = targetChannel;
    if (!voiceChannel && member?.voice?.channel) {
      voiceChannel = member.voice.channel;
    }

    if (!voiceChannel || (voiceChannel.type !== 2 && voiceChannel.type !== 13)) {
      await interaction.reply({
        content: 'Please specify a voice channel or join one yourself.',
        ephemeral: true
      });
      return;
    }

    // Type guard to ensure we have a voice or stage channel
    if (!('bitrate' in voiceChannel)) {
      await interaction.reply({
        content: 'The specified channel is not a voice channel.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      // Get or create voice connection
      let connection = voiceConnectionManager.getConnection(interaction.guildId);
      if (!connection) {
        connection = await voiceConnectionManager.joinChannel(voiceChannel);
      }

      // Start simple recording
      const sessionId = await simpleRecorder.startRecording(
        connection,
        interaction.guildId,
        voiceChannel.id
      );

      const embed = {
        title: '🔴 Recording Started',
        fields: [
          {
            name: '📍 Channel',
            value: voiceChannel.name || 'Unknown Channel',
            inline: true
          },
          {
            name: '🆔 Session ID',
            value: sessionId.substring(0, 8) + '...',
            inline: true
          },
          {
            name: '⚙️ Features',
            value: [
              `📝 Auto-transcription: Enabled`,
              `🤖 AI Summary: Enabled`,
              `💾 Auto-save: Every 5 minutes`,
              `🎵 Format: WAV/PCM`
            ].join('\n'),
            inline: false
          }
        ],
        color: 0xff0000,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Recording will be automatically transcribed and summarized'
        }
      };

      await interaction.editReply({ embeds: [embed] });

      logger.info('Simple recording started', {
        guildId: interaction.guildId,
        sessionId,
        channelName: voiceChannel.name,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to start recording:', error);
      await interaction.editReply({
        content: `❌ Failed to start recording: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }

  } catch (error) {
    logger.error('Error in record start command:', error);
    await interaction.reply({
      content: '❌ An error occurred while starting the recording.',
      ephemeral: true
    });
  }
}

async function handleRecordStop(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const activeSession = simpleRecorder.getActiveSession(interaction.guildId);
    if (!activeSession) {
      await interaction.reply({
        content: '⚠️ No active recording session found.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      await simpleRecorder.stopRecording(interaction.guildId);
      
      const duration = Date.now() - activeSession.startTime.getTime();

      const embed = {
        title: '⏹️ Recording Stopped',
        fields: [
          {
            name: '📊 Session Summary',
            value: [
              `Duration: ${formatDuration(duration)}`,
              `Audio Files: ${activeSession.audioFiles.length}`,
              `Transcriptions: ${activeSession.transcriptions.length}`,
              `Session ID: ${activeSession.sessionId.substring(0, 16)}...`
            ].join('\n'),
            inline: false
          },
          {
            name: '🤖 AI Processing',
            value: [
              `📝 Transcription: ${activeSession.transcriptions.length > 0 ? 'Completed' : 'No audio to transcribe'}`,
              `📋 Summary: Processing...`,
              `📁 Files saved to: /recordings/${activeSession.sessionId}`
            ].join('\n'),
            inline: false
          },
          {
            name: '📅 Recorded',
            value: `${activeSession.startTime.toLocaleDateString()} ${activeSession.startTime.toLocaleTimeString()}`,
            inline: true
          }
        ],
        color: 0x00ff00,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Recording saved and AI processing complete'
        }
      };

      await interaction.editReply({ embeds: [embed] });

      logger.info('Simple recording stopped', {
        guildId: interaction.guildId,
        sessionId: activeSession.sessionId,
        duration,
        audioFiles: activeSession.audioFiles.length,
        transcriptions: activeSession.transcriptions.length,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to stop recording:', error);
      await interaction.editReply({
        content: `❌ Failed to stop recording: ${error instanceof Error ? error.message : "Unknown error"}`
      });
    }

  } catch (error) {
    logger.error('Error in record stop command:', error);
    await interaction.reply({
      content: '❌ An error occurred while stopping the recording.',
      ephemeral: true
    });
  }
}

async function handleRecordStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const activeSession = simpleRecorder.getActiveSession(interaction.guildId);
    const allSessions = simpleRecorder.getAllActiveSessions();

    if (!activeSession) {
      await interaction.reply({
        content: '📴 No active recording session in this server.',
        ephemeral: true
      });
      return;
    }

    const currentDuration = Date.now() - activeSession.startTime.getTime();

    const embed = {
      title: '📊 Recording Status',
      fields: [
        {
          name: '🎙️ Session Info',
          value: [
            `State: 🔴 RECORDING`,
            `Duration: ${formatDuration(currentDuration)}`,
            `Started: ${activeSession.startTime.toLocaleTimeString()}`,
            `Session ID: ${activeSession.sessionId.substring(0, 12)}...`
          ].join('\n'),
          inline: false
        },
        {
          name: '📊 Progress',
          value: [
            `Audio Files: ${activeSession.audioFiles.length}`,
            `Transcriptions: ${activeSession.transcriptions.length}`,
            `Auto-save: Every 5 minutes`,
            `AI Processing: Enabled`
          ].join('\n'),
          inline: false
        },
        {
          name: '📈 System Status',
          value: [
            `Total Active Sessions: ${allSessions.length}`,
            `Recording Directory: /recordings/${activeSession.sessionId}`,
            `Next auto-save: < 5 minutes`
          ].join('\n'),
          inline: false
        }
      ],
      color: 0xff0000,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Recording automatically transcribes and summarizes on stop'
      }
    };

    await interaction.reply({ embeds: [embed], ephemeral: true });

  } catch (error) {
    logger.error('Error in record status command:', error);
    await interaction.reply({
      content: '❌ An error occurred while retrieving recording status.',
      ephemeral: true
    });
  }
}

// Utility functions
function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}


// Export the command
export const recordCommand = recordStartCommand;

export default recordCommand;