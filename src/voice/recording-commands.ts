import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '@utils/logger';
import { voiceConnectionManager } from '@voice/connection';
import RecordingManager from '@voice/recording-manager';
import AudioStorage from '@voice/audio-storage';
import AudioAnalyzer from '@voice/audio-analyzer';
import { RecordingState } from '@voice/multitrack-recorder';

const logger = createLogger('RecordingCommands');

// Global instances (in a real app, these would be managed by a DI container)
const recordingManager = new RecordingManager();
const audioStorage = new AudioStorage();
const audioAnalyzer = new AudioAnalyzer();

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Record Start Command
export const recordStartCommand: Command = {
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
        .addStringOption(option =>
          option
            .setName('format')
            .setDescription('Audio format for output')
            .addChoices(
              { name: 'PCM (Raw Audio)', value: 'pcm' },
              { name: 'WAV (with headers)', value: 'wav' }
            )
            .setRequired(false)
        )
        .addBooleanOption(option =>
          option
            .setName('processing')
            .setDescription('Enable audio processing (noise reduction, normalization)')
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
        .setName('pause')
        .setDescription('Pause current recording session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('resume')
        .setDescription('Resume paused recording session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show recording session status')
        .addBooleanOption(option =>
          option
            .setName('detailed')
            .setDescription('Show detailed information including audio quality metrics')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show recording statistics and storage usage')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'start':
        await handleRecordStart(interaction);
        break;
      case 'stop':
        await handleRecordStop(interaction);
        break;
      case 'pause':
        await handleRecordPause(interaction);
        break;
      case 'resume':
        await handleRecordResume(interaction);
        break;
      case 'status':
        await handleRecordStatus(interaction);
        break;
      case 'stats':
        await handleRecordStats(interaction);
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
    const currentState = recordingManager.getRecordingState(interaction.guildId);
    if (currentState === RecordingState.RECORDING) {
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

    // Get options
    const format = interaction.options.getString('format') || 'pcm';
    const enableProcessing = interaction.options.getBoolean('processing') ?? true;

    await interaction.deferReply();

    try {
      // Get or create voice connection
      let connection = voiceConnectionManager.getConnection(interaction.guildId);
      if (!connection) {
        connection = await voiceConnectionManager.joinChannel(voiceChannel);
      }

      // Start recording
      const sessionId = await recordingManager.startRecording(
        interaction.guildId,
        connection,
        voiceChannel.name,
        {
          enableAudioProcessing: enableProcessing,
          outputFormat: {
            sampleRate: 16000,
            channels: 1,
            bitDepth: 16,
            encoding: format as 'pcm' | 'wav'
          }
        }
      );

      const embed = {
        title: '🔴 Recording Started',
        fields: [
          {
            name: '📍 Channel',
            value: voiceChannel.name,
            inline: true
          },
          {
            name: '🆔 Session ID',
            value: sessionId.substring(0, 8) + '...',
            inline: true
          },
          {
            name: '⚙️ Settings',
            value: [
              `Format: ${format.toUpperCase()}`,
              `Processing: ${enableProcessing ? 'Enabled' : 'Disabled'}`,
              `Sample Rate: 16kHz`,
              `Channels: Mono`
            ].join('\n'),
            inline: false
          }
        ],
        color: 0xff0000,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Recording session is now active'
        }
      };

      await interaction.editReply({ embeds: [embed] });

      logger.info('Recording started via command', {
        guildId: interaction.guildId,
        sessionId,
        channelName: voiceChannel.name,
        userId: interaction.user.id,
        format,
        enableProcessing
      });

    } catch (error) {
      logger.error('Failed to start recording:', error);
      await interaction.editReply({
        content: `❌ Failed to start recording: ${error.message}`
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

    const currentState = recordingManager.getRecordingState(interaction.guildId);
    if (currentState === RecordingState.IDLE) {
      await interaction.reply({
        content: '⚠️ No active recording session found.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      const session = await recordingManager.stopRecording(interaction.guildId);
      
      if (session) {
        const duration = session.totalDuration;
        const participants = session.participants.size;
        const segments = session.audioSegments.length;

        const embed = {
          title: '⏹️ Recording Stopped',
          fields: [
            {
              name: '📊 Session Summary',
              value: [
                `Duration: ${formatDuration(duration)}`,
                `Participants: ${participants}`,
                `Audio Segments: ${segments}`,
                `Channel: ${session.channelName}`
              ].join('\n'),
              inline: false
            },
            {
              name: '🆔 Session ID',
              value: session.sessionId.substring(0, 16) + '...',
              inline: true
            },
            {
              name: '📅 Recorded',
              value: `${session.startTime.toLocaleDateString()} ${session.startTime.toLocaleTimeString()}`,
              inline: true
            }
          ],
          color: 0x00ff00,
          timestamp: new Date().toISOString(),
          footer: {
            text: 'Recording has been saved and processed'
          }
        };

        await interaction.editReply({ embeds: [embed] });

        logger.info('Recording stopped via command', {
          guildId: interaction.guildId,
          sessionId: session.sessionId,
          duration,
          participants,
          segments,
          userId: interaction.user.id
        });

      } else {
        await interaction.editReply({
          content: '⚠️ Recording was stopped but no session data was returned.'
        });
      }

    } catch (error) {
      logger.error('Failed to stop recording:', error);
      await interaction.editReply({
        content: `❌ Failed to stop recording: ${error.message}`
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

async function handleRecordPause(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const currentState = recordingManager.getRecordingState(interaction.guildId);
    if (currentState !== RecordingState.RECORDING) {
      await interaction.reply({
        content: '⚠️ No active recording session to pause.',
        ephemeral: true
      });
      return;
    }

    try {
      await recordingManager.pauseRecording(interaction.guildId);

      await interaction.reply({
        content: '⏸️ Recording has been paused. Use `/record resume` to continue.',
        ephemeral: true
      });

      logger.info('Recording paused via command', {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to pause recording:', error);
      await interaction.reply({
        content: `❌ Failed to pause recording: ${error.message}`,
        ephemeral: true
      });
    }

  } catch (error) {
    logger.error('Error in record pause command:', error);
    await interaction.reply({
      content: '❌ An error occurred while pausing the recording.',
      ephemeral: true
    });
  }
}

async function handleRecordResume(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const currentState = recordingManager.getRecordingState(interaction.guildId);
    if (currentState !== RecordingState.PAUSED) {
      await interaction.reply({
        content: '⚠️ No paused recording session to resume.',
        ephemeral: true
      });
      return;
    }

    try {
      await recordingManager.resumeRecording(interaction.guildId);

      await interaction.reply({
        content: '▶️ Recording has been resumed.',
        ephemeral: true
      });

      logger.info('Recording resumed via command', {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to resume recording:', error);
      await interaction.reply({
        content: `❌ Failed to resume recording: ${error.message}`,
        ephemeral: true
      });
    }

  } catch (error) {
    logger.error('Error in record resume command:', error);
    await interaction.reply({
      content: '❌ An error occurred while resuming the recording.',
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

    const detailed = interaction.options.getBoolean('detailed') ?? false;
    const session = recordingManager.getRecordingSession(interaction.guildId);

    if (!session) {
      await interaction.reply({
        content: '📴 No active recording session in this server.',
        ephemeral: true
      });
      return;
    }

    const currentDuration = Date.now() - session.startTime.getTime();
    const participants = Array.from(session.participants.values());
    const activeParticipants = participants.filter(p => p.isSpeaking);

    const embed = {
      title: '📊 Recording Status',
      fields: [
        {
          name: '🎙️ Session Info',
          value: [
            `State: ${getStateEmoji(session.state)} ${session.state.toUpperCase()}`,
            `Duration: ${formatDuration(currentDuration)}`,
            `Channel: ${session.channelName}`,
            `Started: ${session.startTime.toLocaleTimeString()}`
          ].join('\n'),
          inline: false
        },
        {
          name: '👥 Participants',
          value: participants.length > 0 
            ? participants.map(p => 
                `${p.isSpeaking ? '🔊' : '🔇'} ${p.username} ${p.isSpeaking ? '(speaking)' : ''}`
              ).join('\n')
            : 'No participants',
          inline: true
        },
        {
          name: '📈 Statistics',
          value: [
            `Total Segments: ${session.audioSegments.length}`,
            `Active Speakers: ${activeParticipants.length}`,
            `Session ID: ${session.sessionId.substring(0, 12)}...`
          ].join('\n'),
          inline: true
        }
      ],
      color: getStateColor(session.state),
      timestamp: new Date().toISOString()
    };

    // Add detailed audio quality information if requested
    if (detailed && participants.length > 0) {
      const qualityInfo = participants.map(participant => {
        const quality = audioAnalyzer.getAudioQuality(participant.userId);
        const activity = audioAnalyzer.getSpeakerActivity(participant.userId);
        
        return [
          `**${participant.username}**`,
          `Speaking: ${formatDuration(participant.speakingDuration)}`,
          quality ? `Quality: ${quality.quality}` : 'Quality: Unknown',
          activity ? `Audio Level: ${activity.audioLevel.toFixed(1)} dB` : '',
          quality ? `Clarity: ${(quality.clarity * 100).toFixed(0)}%` : ''
        ].filter(line => line).join('\n');
      }).join('\n\n');

      embed.fields.push({
        name: '🎵 Audio Quality Details',
        value: qualityInfo || 'No quality data available',
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });

  } catch (error) {
    logger.error('Error in record status command:', error);
    await interaction.reply({
      content: '❌ An error occurred while retrieving recording status.',
      ephemeral: true
    });
  }
}

async function handleRecordStats(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.deferReply({ ephemeral: true });

    const recordingStats = recordingManager.getRecordingStats();
    const storageStats = await audioStorage.getStorageStats();

    const embed = {
      title: '📊 Recording Statistics',
      fields: [
        {
          name: '🗂️ Session Statistics',
          value: [
            `Total Sessions: ${recordingStats.totalSessions}`,
            `Active Sessions: ${recordingStats.activeSessions}`,
            `Average Duration: ${formatDuration(recordingStats.averageSessionDuration)}`,
            `Total Participants: ${recordingStats.totalParticipants}`
          ].join('\n'),
          inline: true
        },
        {
          name: '💾 Storage Statistics',
          value: [
            `Total Files: ${storageStats.totalFiles}`,
            `Storage Used: ${formatBytes(storageStats.totalSize)}`,
            `Average File Size: ${formatBytes(storageStats.averageFileSize)}`,
            `Compression Ratio: ${(storageStats.compressionRatio * 100).toFixed(1)}%`
          ].join('\n'),
          inline: true
        }
      ],
      color: 0x0099ff,
      timestamp: new Date().toISOString()
    };

    // Add top users if available
    if (recordingStats.topUsers.length > 0) {
      const topUsersText = recordingStats.topUsers
        .slice(0, 5)
        .map((user, index) => 
          `${index + 1}. ${user.username}: ${formatDuration(user.totalTime)}`
        )
        .join('\n');

      embed.fields.push({
        name: '🏆 Top Speakers',
        value: topUsersText,
        inline: false
      });
    }

    // Add storage breakdown by session if available
    if (storageStats.storageBySession.size > 0) {
      const topSessions = Array.from(storageStats.storageBySession.entries())
        .sort(([,a], [,b]) => b.size - a.size)
        .slice(0, 3)
        .map(([sessionId, stats]) => 
          `${sessionId.substring(0, 8)}...: ${stats.files} files, ${formatBytes(stats.size)}`
        )
        .join('\n');

      embed.fields.push({
        name: '📁 Largest Sessions',
        value: topSessions,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('Error in record stats command:', error);
    await interaction.editReply({
      content: '❌ An error occurred while retrieving statistics.'
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getStateEmoji(state: RecordingState): string {
  switch (state) {
    case RecordingState.RECORDING: return '🔴';
    case RecordingState.PAUSED: return '⏸️';
    case RecordingState.STOPPED: return '⏹️';
    case RecordingState.STARTING: return '🟡';
    case RecordingState.STOPPING: return '🟠';
    case RecordingState.ERROR: return '❌';
    default: return '⚪';
  }
}

function getStateColor(state: RecordingState): number {
  switch (state) {
    case RecordingState.RECORDING: return 0xff0000; // Red
    case RecordingState.PAUSED: return 0xffff00; // Yellow
    case RecordingState.STOPPED: return 0x808080; // Gray
    case RecordingState.STARTING: return 0xffa500; // Orange
    case RecordingState.STOPPING: return 0xffa500; // Orange
    case RecordingState.ERROR: return 0xff0000; // Red
    default: return 0x808080; // Gray
  }
}

// Export the command
export const recordCommand = recordStartCommand;

export default recordCommand;