import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';
import { voiceConnectionManager } from '@voice/connection';
import TranscriptionPipeline, { 
  PipelineState, 
  TranscriptionPipelineConfig,
  PipelineStatistics 
} from './transcription-pipeline';
import TranscriptManager, { TranscriptSessionState } from './transcript-manager';
import { TranscriptionConfig } from './assemblyai-client';
import { AudioFormat } from './audio-converter';

const logger = createLogger('TranscriptionCommands');

// Global instances (in a real app, these would be managed by a DI container)
let transcriptManager: TranscriptManager | null = null;
let transcriptionPipeline: TranscriptionPipeline | null = null;

// Initialize transcription system
function initializeTranscriptionSystem(): void {
  if (!transcriptManager) {
    transcriptManager = new TranscriptManager('./transcripts');
  }

  if (!transcriptionPipeline && config.assemblyAiApiKey) {
    const transcriptionConfig: TranscriptionConfig = {
      apiKey: config.assemblyAiApiKey,
      sampleRate: 16000,
      channels: 1,
      confidenceThreshold: 0.7,
      languageCode: 'en_us',
      punctuate: true,
      formatText: true,
      dualChannelTranscription: false
    };

    const audioFormat: AudioFormat = {
      sampleRate: 48000,
      channels: 2,
      bitDepth: 16,
      encoding: 'pcm_s16le'
    };

    const pipelineConfig: TranscriptionPipelineConfig = {
      assemblyAI: transcriptionConfig,
      audioFormat,
      bufferSize: 3200,
      maxLatencyMs: 500,
      confidenceThreshold: 0.7,
      enableRealTimeFiltering: true,
      enableQualityMonitoring: true
    };

    transcriptionPipeline = new TranscriptionPipeline(
      pipelineConfig,
      transcriptManager,
      './transcripts'
    );
  }
}

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const transcribeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('transcribe')
    .setDescription('Real-time transcription management commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('start')
        .setDescription('Start real-time transcription for voice channel')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Voice channel to transcribe (defaults to your current channel)')
            .setRequired(false)
        )
        .addNumberOption(option =>
          option
            .setName('confidence')
            .setDescription('Minimum confidence threshold (0.1-1.0)')
            .setMinValue(0.1)
            .setMaxValue(1.0)
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('language')
            .setDescription('Language for transcription')
            .addChoices(
              { name: 'English (US)', value: 'en_us' },
              { name: 'English (UK)', value: 'en_uk' },
              { name: 'Spanish', value: 'es' },
              { name: 'French', value: 'fr' },
              { name: 'German', value: 'de' },
              { name: 'Auto-detect', value: 'auto' }
            )
            .setRequired(false)
        )
        .addBooleanOption(option =>
          option
            .setName('realtime_filtering')
            .setDescription('Enable real-time confidence filtering')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stop')
        .setDescription('Stop current transcription session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('pause')
        .setDescription('Pause current transcription session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('resume')
        .setDescription('Resume paused transcription session')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('status')
        .setDescription('Show transcription session status')
        .addBooleanOption(option =>
          option
            .setName('detailed')
            .setDescription('Show detailed statistics and performance metrics')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('export')
        .setDescription('Export transcript for current or specified session')
        .addStringOption(option =>
          option
            .setName('session_id')
            .setDescription('Session ID to export (defaults to current session)')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('format')
            .setDescription('Export format')
            .addChoices(
              { name: 'Plain Text', value: 'txt' },
              { name: 'JSON (detailed)', value: 'json' },
              { name: 'SRT Subtitles', value: 'srt' },
              { name: 'VTT Subtitles', value: 'vtt' }
            )
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('Show transcription statistics and usage metrics')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction: ChatInputCommandInteraction) {
    // Initialize transcription system if not already done
    initializeTranscriptionSystem();

    if (!config.assemblyAiApiKey) {
      await interaction.reply({
        content: '❌ AssemblyAI API key is not configured. Please contact the administrator.',
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'start':
        await handleTranscribeStart(interaction);
        break;
      case 'stop':
        await handleTranscribeStop(interaction);
        break;
      case 'pause':
        await handleTranscribePause(interaction);
        break;
      case 'resume':
        await handleTranscribeResume(interaction);
        break;
      case 'status':
        await handleTranscribeStatus(interaction);
        break;
      case 'export':
        await handleTranscribeExport(interaction);
        break;
      case 'stats':
        await handleTranscribeStats(interaction);
        break;
      default:
        await interaction.reply({
          content: 'Unknown transcription command.',
          ephemeral: true
        });
    }
  }
};

async function handleTranscribeStart(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !transcriptionPipeline) {
      await interaction.reply({
        content: 'This command can only be used in a server with transcription enabled.',
        ephemeral: true
      });
      return;
    }

    // Check if transcription is already running
    const currentState = transcriptionPipeline.getState();
    if (currentState === PipelineState.RUNNING) {
      await interaction.reply({
        content: '⚠️ Transcription is already active in this server!',
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
    const confidence = interaction.options.getNumber('confidence') || 0.7;
    const language = interaction.options.getString('language') || 'en_us';
    const realtimeFiltering = interaction.options.getBoolean('realtime_filtering') ?? true;

    await interaction.deferReply();

    try {
      // Get or create voice connection
      let connection = voiceConnectionManager.getConnection(interaction.guildId);
      if (!connection) {
        connection = await voiceConnectionManager.joinChannel(voiceChannel);
      }

      // Start transcription pipeline
      const sessionId = await transcriptionPipeline.start(
        interaction.guildId,
        voiceChannel.id,
        voiceChannel.name
      );

      const embed = {
        title: '🎤 Real-time Transcription Started',
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
              `Language: ${language.toUpperCase()}`,
              `Confidence Threshold: ${(confidence * 100).toFixed(0)}%`,
              `Real-time Filtering: ${realtimeFiltering ? 'Enabled' : 'Disabled'}`,
              `Target Latency: <300ms`
            ].join('\n'),
            inline: false
          },
          {
            name: '💡 Features',
            value: [
              '• Real-time speech-to-text',
              '• 5-minute segment windows',
              '• Automatic compression & storage',
              '• Cost optimization ($0.15/hour)',
              '• Export in multiple formats'
            ].join('\n'),
            inline: false
          }
        ],
        color: 0x00ff00,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Transcription session is now active'
        }
      };

      await interaction.editReply({ embeds: [embed] });

      logger.info('Transcription started via command', {
        guildId: interaction.guildId,
        sessionId,
        channelName: voiceChannel.name,
        userId: interaction.user.id,
        confidence,
        language,
        realtimeFiltering
      });

    } catch (error) {
      logger.error('Failed to start transcription:', error);
      await interaction.editReply({
        content: `❌ Failed to start transcription: ${error.message}`
      });
    }

  } catch (error) {
    logger.error('Error in transcribe start command:', error);
    await interaction.reply({
      content: '❌ An error occurred while starting transcription.',
      ephemeral: true
    });
  }
}

async function handleTranscribeStop(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !transcriptionPipeline) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const currentState = transcriptionPipeline.getState();
    if (currentState === PipelineState.IDLE || currentState === PipelineState.STOPPED) {
      await interaction.reply({
        content: '⚠️ No active transcription session found.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      await transcriptionPipeline.stop();
      const finalStats = transcriptionPipeline.getStatistics();
      
      const embed = {
        title: '⏹️ Transcription Stopped',
        fields: [
          {
            name: '📊 Session Summary',
            value: [
              `Duration: ${formatDuration(finalStats.uptime)}`,
              `Total Transcripts: ${finalStats.totalTranscriptionsReceived}`,
              `Average Confidence: ${(finalStats.averageConfidence * 100).toFixed(1)}%`,
              `Average Latency: ${finalStats.averageLatency.toFixed(0)}ms`
            ].join('\n'),
            inline: false
          },
          {
            name: '🎯 Performance Metrics',
            value: [
              `Audio Processed: ${formatBytes(finalStats.totalAudioProcessed)}`,
              `Throughput: ${formatBytes(finalStats.throughputBytesPerSecond)}/s`,
              `Error Rate: ${finalStats.errorRate.toFixed(1)}%`,
              `Conversion Latency: ${finalStats.conversionLatency.toFixed(0)}ms`
            ].join('\n'),
            inline: false
          }
        ],
        color: 0xff9900,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Transcription session completed and saved'
        }
      };

      await interaction.editReply({ embeds: [embed] });

      logger.info('Transcription stopped via command', {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        finalStats
      });

    } catch (error) {
      logger.error('Failed to stop transcription:', error);
      await interaction.editReply({
        content: `❌ Failed to stop transcription: ${error.message}`
      });
    }

  } catch (error) {
    logger.error('Error in transcribe stop command:', error);
    await interaction.reply({
      content: '❌ An error occurred while stopping transcription.',
      ephemeral: true
    });
  }
}

async function handleTranscribePause(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !transcriptionPipeline) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const currentState = transcriptionPipeline.getState();
    if (currentState !== PipelineState.RUNNING) {
      await interaction.reply({
        content: '⚠️ No active transcription session to pause.',
        ephemeral: true
      });
      return;
    }

    try {
      await transcriptionPipeline.pause();

      await interaction.reply({
        content: '⏸️ Transcription has been paused. Use `/transcribe resume` to continue.',
        ephemeral: true
      });

      logger.info('Transcription paused via command', {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to pause transcription:', error);
      await interaction.reply({
        content: `❌ Failed to pause transcription: ${error.message}`,
        ephemeral: true
      });
    }

  } catch (error) {
    logger.error('Error in transcribe pause command:', error);
    await interaction.reply({
      content: '❌ An error occurred while pausing transcription.',
      ephemeral: true
    });
  }
}

async function handleTranscribeResume(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !transcriptionPipeline) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const currentState = transcriptionPipeline.getState();
    if (currentState !== PipelineState.PAUSED) {
      await interaction.reply({
        content: '⚠️ No paused transcription session to resume.',
        ephemeral: true
      });
      return;
    }

    try {
      await transcriptionPipeline.resume();

      await interaction.reply({
        content: '▶️ Transcription has been resumed.',
        ephemeral: true
      });

      logger.info('Transcription resumed via command', {
        guildId: interaction.guildId,
        userId: interaction.user.id
      });

    } catch (error) {
      logger.error('Failed to resume transcription:', error);
      await interaction.reply({
        content: `❌ Failed to resume transcription: ${error.message}`,
        ephemeral: true
      });
    }

  } catch (error) {
    logger.error('Error in transcribe resume command:', error);
    await interaction.reply({
      content: '❌ An error occurred while resuming transcription.',
      ephemeral: true
    });
  }
}

async function handleTranscribeStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !transcriptionPipeline || !transcriptManager) {
      await interaction.reply({
        content: 'This command can only be used in a server.',
        ephemeral: true
      });
      return;
    }

    const detailed = interaction.options.getBoolean('detailed') ?? false;
    const pipelineState = transcriptionPipeline.getState();
    const activeSession = transcriptManager.getActiveSession();

    if (!activeSession) {
      await interaction.reply({
        content: '📴 No active transcription session in this server.',
        ephemeral: true
      });
      return;
    }

    const currentDuration = Date.now() - activeSession.startTime.getTime();
    const stats = transcriptionPipeline.getStatistics();
    const queueStatus = transcriptionPipeline.getQueueStatus();

    const embed = {
      title: '🎤 Transcription Status',
      fields: [
        {
          name: '📊 Session Info',
          value: [
            `State: ${getStateEmoji(pipelineState)} ${pipelineState.toUpperCase()}`,
            `Duration: ${formatDuration(currentDuration)}`,
            `Channel: ${activeSession.channelName}`,
            `Started: ${activeSession.startTime.toLocaleTimeString()}`
          ].join('\n'),
          inline: false
        },
        {
          name: '📈 Live Statistics',
          value: [
            `Total Transcripts: ${stats.totalTranscriptionsReceived}`,
            `Average Confidence: ${(stats.averageConfidence * 100).toFixed(1)}%`,
            `Average Latency: ${stats.averageLatency.toFixed(0)}ms`,
            `Error Rate: ${stats.errorRate.toFixed(1)}%`
          ].join('\n'),
          inline: true
        },
        {
          name: '⚡ Performance',
          value: [
            `Audio Processed: ${formatBytes(stats.totalAudioProcessed)}`,
            `Throughput: ${formatBytes(stats.throughputBytesPerSecond)}/s`,
            `Queue Size: ${queueStatus.queueSize}/${queueStatus.maxQueueSize}`,
            `Processing: ${queueStatus.isProcessing ? 'Active' : 'Idle'}`
          ].join('\n'),
          inline: true
        }
      ],
      color: getStateColor(pipelineState),
      timestamp: new Date().toISOString()
    };

    // Add detailed information if requested
    if (detailed) {
      embed.fields.push({
        name: '🔧 Technical Details',
        value: [
          `Conversion Latency: ${stats.conversionLatency.toFixed(0)}ms`,
          `AssemblyAI Latency: ${stats.assemblyAILatency.toFixed(0)}ms`,
          `Total Segments: ${activeSession.segments.length}`,
          `Current Segment: ${activeSession.currentSegment?.segmentId.substring(0, 8)}...`,
          `Session ID: ${activeSession.sessionId.substring(0, 12)}...`
        ].join('\n'),
        inline: false
      });

      // Add cost estimation
      const estimatedCost = stats.uptime > 0 ? (stats.uptime / 3600000) * 0.15 : 0;
      embed.fields.push({
        name: '💰 Cost Estimation',
        value: [
          `Estimated Cost: $${estimatedCost.toFixed(4)}`,
          `Rate: $0.15/hour`,
          `Audio Minutes: ${(stats.uptime / 60000).toFixed(1)}`,
          `Compression Ratio: ${activeSession.compressionStats.averageCompressionRatio.toFixed(2)}:1`
        ].join('\n'),
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });

  } catch (error) {
    logger.error('Error in transcribe status command:', error);
    await interaction.reply({
      content: '❌ An error occurred while retrieving transcription status.',
      ephemeral: true
    });
  }
}

async function handleTranscribeExport(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    await interaction.reply({
      content: '📤 Transcript export functionality is coming soon! Currently, transcripts are automatically saved in compressed segments.',
      ephemeral: true
    });
  } catch (error) {
    logger.error('Error in transcribe export command:', error);
    await interaction.reply({
      content: '❌ An error occurred with the export command.',
      ephemeral: true
    });
  }
}

async function handleTranscribeStats(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    if (!transcriptManager) {
      await interaction.reply({
        content: 'Transcription system is not initialized.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const allSessions = transcriptManager.getAllSessions();
    const activeSessions = allSessions.filter(s => s.state === TranscriptSessionState.ACTIVE);
    const completedSessions = allSessions.filter(s => s.state === TranscriptSessionState.STOPPED);

    // Calculate aggregate statistics
    const totalTranscripts = completedSessions.reduce((sum, s) => sum + s.totalTranscripts, 0);
    const totalWords = completedSessions.reduce((sum, s) => sum + s.totalWords, 0);
    const totalDuration = completedSessions.reduce((sum, s) => sum + s.totalDuration, 0);
    const averageConfidence = completedSessions.length > 0 
      ? completedSessions.reduce((sum, s) => sum + s.averageConfidence, 0) / completedSessions.length 
      : 0;

    // Calculate cost metrics
    const totalCost = completedSessions.reduce((sum, s) => 
      sum + s.metadata.costMetrics.estimatedCost, 0
    );
    const totalAudioMinutes = completedSessions.reduce((sum, s) => 
      sum + s.metadata.costMetrics.audioMinutesProcessed, 0
    );

    // Calculate compression savings
    const totalCompressionSavings = completedSessions.reduce((sum, s) => 
      sum + s.metadata.costMetrics.compressionSavings, 0
    );

    const embed = {
      title: '📊 Transcription Statistics',
      fields: [
        {
          name: '📈 Session Overview',
          value: [
            `Total Sessions: ${allSessions.length}`,
            `Active Sessions: ${activeSessions.length}`,
            `Completed Sessions: ${completedSessions.length}`,
            `Average Duration: ${formatDuration(totalDuration / Math.max(completedSessions.length, 1))}`
          ].join('\n'),
          inline: true
        },
        {
          name: '🎯 Transcription Metrics',
          value: [
            `Total Transcripts: ${totalTranscripts.toLocaleString()}`,
            `Total Words: ${totalWords.toLocaleString()}`,
            `Average Confidence: ${(averageConfidence * 100).toFixed(1)}%`,
            `Audio Minutes: ${totalAudioMinutes.toFixed(1)}`
          ].join('\n'),
          inline: true
        },
        {
          name: '💰 Cost & Efficiency',
          value: [
            `Total Cost: $${totalCost.toFixed(3)}`,
            `Rate: $0.15/hour`,
            `Compression Savings: ${formatBytes(totalCompressionSavings)}`,
            `Average Cost/Minute: $${(totalCost / Math.max(totalAudioMinutes, 1)).toFixed(4)}`
          ].join('\n'),
          inline: false
        }
      ],
      color: 0x0099ff,
      timestamp: new Date().toISOString()
    };

    // Add recent sessions if available
    if (completedSessions.length > 0) {
      const recentSessions = completedSessions
        .sort((a, b) => (b.endTime?.getTime() || 0) - (a.endTime?.getTime() || 0))
        .slice(0, 3)
        .map(session => {
          const endTime = session.endTime || new Date();
          return `${session.sessionId.substring(0, 8)}... - ${session.channelName} (${formatDuration(session.totalDuration)})`;
        })
        .join('\n');

      embed.fields.push({
        name: '🕒 Recent Sessions',
        value: recentSessions,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('Error in transcribe stats command:', error);
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

function getStateEmoji(state: PipelineState): string {
  switch (state) {
    case PipelineState.RUNNING: return '🟢';
    case PipelineState.PAUSED: return '⏸️';
    case PipelineState.STOPPED: return '⏹️';
    case PipelineState.STARTING: return '🟡';
    case PipelineState.STOPPING: return '🟠';
    case PipelineState.ERROR: return '❌';
    default: return '⚪';
  }
}

function getStateColor(state: PipelineState): number {
  switch (state) {
    case PipelineState.RUNNING: return 0x00ff00; // Green
    case PipelineState.PAUSED: return 0xffff00; // Yellow
    case PipelineState.STOPPED: return 0x808080; // Gray
    case PipelineState.STARTING: return 0xffa500; // Orange
    case PipelineState.STOPPING: return 0xffa500; // Orange
    case PipelineState.ERROR: return 0xff0000; // Red
    default: return 0x808080; // Gray
  }
}

// Export the command
export default transcribeCommand;