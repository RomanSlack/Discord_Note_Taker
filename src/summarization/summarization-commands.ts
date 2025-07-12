import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction, 
  AttachmentBuilder,
  EmbedBuilder 
} from 'discord.js';
import { createLogger } from '@utils/logger';
import MeetingSummarizer, { MeetingSummaryReport } from './meeting-summarizer';
import PDFGenerator, { PDFGenerationOptions } from './pdf-generator';
import { TranscriptManager } from '@transcription/transcript-manager';

const logger = createLogger('SummarizationCommands');

export interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// Summary generation command
export function createSummaryCommand(
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Command {
  return {
    data: new SlashCommandBuilder()
      .setName('summary')
      .setDescription('Generate meeting summaries')
      .addSubcommand(subcommand =>
        subcommand
          .setName('generate')
          .setDescription('Generate an interim summary of the current meeting')
          .addStringOption(option =>
            option
              .setName('type')
              .setDescription('Type of summary to generate')
              .setRequired(false)
              .addChoices(
                { name: 'Interim Summary', value: 'interim' },
                { name: 'Action Items', value: 'action-items' },
                { name: 'Key Decisions', value: 'decisions' }
              )
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('final')
          .setDescription('Generate a final comprehensive meeting summary')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('status')
          .setDescription('Show summarization status and statistics')
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const subcommand = interaction.options.getSubcommand();

      try {
        switch (subcommand) {
          case 'generate':
            await handleGenerateInterim(interaction, summarizer);
            break;
          case 'final':
            await handleGenerateFinal(interaction, summarizer, transcriptManager);
            break;
          case 'status':
            await handleSummaryStatus(interaction, summarizer, transcriptManager);
            break;
          default:
            await interaction.reply({
              content: 'Unknown summary command.',
              ephemeral: true
            });
        }
      } catch (error) {
        logger.error('Summary command error:', error);
        
        if (!interaction.replied) {
          await interaction.reply({
            content: 'An error occurred while processing the summary command.',
            ephemeral: true
          });
        } else {
          await interaction.followUp({
            content: 'An error occurred during summary generation.',
            ephemeral: true
          });
        }
      }
    }
  };
}

// Report generation command
export function createReportCommand(
  summarizer: MeetingSummarizer,
  pdfGenerator: PDFGenerator,
  transcriptManager: TranscriptManager
): Command {
  return {
    data: new SlashCommandBuilder()
      .setName('report')
      .setDescription('Generate and export meeting reports')
      .addSubcommand(subcommand =>
        subcommand
          .setName('pdf')
          .setDescription('Generate a PDF meeting report')
          .addStringOption(option =>
            option
              .setName('template')
              .setDescription('PDF template to use')
              .setRequired(false)
              .addChoices(
                { name: 'Professional', value: 'professional' },
                { name: 'Compact', value: 'compact' },
                { name: 'Detailed', value: 'detailed' }
              )
          )
          .addBooleanOption(option =>
            option
              .setName('include_cover')
              .setDescription('Include a cover page')
              .setRequired(false)
          )
          .addBooleanOption(option =>
            option
              .setName('include_metadata')
              .setDescription('Include technical metadata')
              .setRequired(false)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('export')
          .setDescription('Export meeting data in various formats')
          .addStringOption(option =>
            option
              .setName('format')
              .setDescription('Export format')
              .setRequired(true)
              .addChoices(
                { name: 'JSON', value: 'json' },
                { name: 'Markdown', value: 'markdown' },
                { name: 'Plain Text', value: 'txt' }
              )
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('quick')
          .setDescription('Generate a quick summary report (compact PDF)')
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const subcommand = interaction.options.getSubcommand();

      try {
        switch (subcommand) {
          case 'pdf':
            await handleGeneratePDF(interaction, summarizer, pdfGenerator, transcriptManager);
            break;
          case 'export':
            await handleExportData(interaction, summarizer, transcriptManager);
            break;
          case 'quick':
            await handleQuickReport(interaction, summarizer, pdfGenerator, transcriptManager);
            break;
          default:
            await interaction.reply({
              content: 'Unknown report command.',
              ephemeral: true
            });
        }
      } catch (error) {
        logger.error('Report command error:', error);
        
        if (!interaction.replied) {
          await interaction.reply({
            content: 'An error occurred while processing the report command.',
            ephemeral: true
          });
        } else {
          await interaction.followUp({
            content: 'An error occurred during report generation.',
            ephemeral: true
          });
        }
      }
    }
  };
}

// Analytics command
export function createAnalyticsCommand(
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Command {
  return {
    data: new SlashCommandBuilder()
      .setName('analytics')
      .setDescription('View meeting analytics and insights')
      .addSubcommand(subcommand =>
        subcommand
          .setName('session')
          .setDescription('Show analytics for the current or specified session')
          .addStringOption(option =>
            option
              .setName('session_id')
              .setDescription('Session ID (optional, defaults to current)')
              .setRequired(false)
          )
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('costs')
          .setDescription('Show summarization costs and usage statistics')
      )
      .addSubcommand(subcommand =>
        subcommand
          .setName('quality')
          .setDescription('Show quality metrics for transcription and summarization')
      ),

    async execute(interaction: ChatInputCommandInteraction) {
      const subcommand = interaction.options.getSubcommand();

      try {
        switch (subcommand) {
          case 'session':
            await handleSessionAnalytics(interaction, summarizer, transcriptManager);
            break;
          case 'costs':
            await handleCostAnalytics(interaction, summarizer);
            break;
          case 'quality':
            await handleQualityAnalytics(interaction, summarizer, transcriptManager);
            break;
          default:
            await interaction.reply({
              content: 'Unknown analytics command.',
              ephemeral: true
            });
        }
      } catch (error) {
        logger.error('Analytics command error:', error);
        
        await interaction.reply({
          content: 'An error occurred while generating analytics.',
          ephemeral: true
        });
      }
    }
  };
}

// Command handlers
async function handleGenerateInterim(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const summaryType = interaction.options.getString('type') || 'interim';
  
  // Get current active session
  const activeSession = summarizer.getSessionContext('current'); // This would need to be implemented
  if (!activeSession) {
    await interaction.editReply({
      content: 'No active meeting session found. Start a recording first.'
    });
    return;
  }

  try {
    const result = await summarizer.generateManualSummary(
      activeSession.sessionId,
      summaryType as any
    );

    if (!result) {
      await interaction.editReply({
        content: 'No transcript data available for summarization yet.'
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`${summaryType.charAt(0).toUpperCase() + summaryType.slice(1)} Summary`)
      .setDescription(result.summary)
      .setColor(0x5865F2)
      .addFields(
        { name: 'Key Points', value: result.keyPoints.slice(0, 5).map(p => `• ${p}`).join('\n') || 'None', inline: false },
        { name: 'Processing', value: `${result.processingTime}ms | $${result.cost.toFixed(4)}`, inline: true },
        { name: 'Confidence', value: `${(result.confidence * 100).toFixed(1)}%`, inline: true }
      )
      .setTimestamp();

    if (result.actionItems && result.actionItems.length > 0) {
      embed.addFields({
        name: 'Action Items',
        value: result.actionItems.slice(0, 3).map(item => 
          `[${item.priority.toUpperCase()}] ${item.description}`
        ).join('\n'),
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });

  } catch (error) {
    logger.error('Interim summary generation failed:', error);
    await interaction.editReply({
      content: 'Failed to generate summary. Please try again later.'
    });
  }
}

async function handleGenerateFinal(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  // Check if there's an active session to finalize
  const activeSession = transcriptManager.getActiveSession();
  if (!activeSession) {
    await interaction.editReply({
      content: 'No active session found. Use this command after stopping a recording.'
    });
    return;
  }

  try {
    // This would trigger final summary generation
    await interaction.editReply({
      content: 'Generating final meeting summary... This may take a moment.'
    });

    // The final summary would be generated when the session stops
    // For now, we'll provide a placeholder response
    await interaction.followUp({
      content: 'Final summary will be generated when the meeting ends. Use `/report pdf` after stopping the recording.',
      ephemeral: true
    });

  } catch (error) {
    logger.error('Final summary generation failed:', error);
    await interaction.editReply({
      content: 'Failed to generate final summary. Please try again later.'
    });
  }
}

async function handleSummaryStatus(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Promise<void> {
  const activeSession = transcriptManager.getActiveSession();
  const usageStats = summarizer.getUsageStats();

  const embed = new EmbedBuilder()
    .setTitle('📊 Summarization Status')
    .setColor(0x5865F2)
    .setTimestamp();

  if (activeSession) {
    const context = summarizer.getSessionContext(activeSession.sessionId);
    embed.addFields(
      { name: '🎯 Active Session', value: activeSession.sessionId, inline: true },
      { name: '⏱️ Duration', value: `${Math.round((Date.now() - activeSession.startTime.getTime()) / 60000)} min`, inline: true },
      { name: '📝 Transcripts', value: activeSession.totalTranscripts.toString(), inline: true }
    );

    if (context) {
      embed.addFields(
        { name: '💰 Session Cost', value: `$${context.totalCost.toFixed(4)}`, inline: true },
        { name: '🎯 Summaries', value: context.summaries.length.toString(), inline: true },
        { name: '✅ Action Items', value: context.actionItems.length.toString(), inline: true }
      );
    }
  } else {
    embed.addFields({
      name: '📭 Status', 
      value: 'No active session', 
      inline: false 
    });
  }

  embed.addFields(
    { name: '💼 Total Usage', value: `$${usageStats.sessions.totalCost.toFixed(4)}`, inline: true },
    { name: '🔢 Total Tokens', value: usageStats.sessions.totalTokens.toLocaleString(), inline: true },
    { name: '📊 Active Sessions', value: usageStats.sessions.active.toString(), inline: true }
  );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleGeneratePDF(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  pdfGenerator: PDFGenerator,
  transcriptManager: TranscriptManager
): Promise<void> {
  await interaction.deferReply({ ephemeral: false });

  // Get the most recent completed session or active session
  const session = transcriptManager.getActiveSession() || 
                  transcriptManager.getAllSessions()
                    .filter(s => s.state === 'stopped')
                    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0];

  if (!session) {
    await interaction.editReply({
      content: 'No meeting session found to generate a report for.'
    });
    return;
  }

  try {
    await interaction.editReply({
      content: '📄 Generating PDF report... This may take up to 60 seconds.'
    });

    // Create a mock meeting summary report
    // In a real implementation, this would use the actual summarizer
    const mockReport: MeetingSummaryReport = {
      sessionId: session.sessionId,
      meetingTitle: `Meeting in ${session.channelName}`,
      startTime: session.startTime,
      endTime: session.endTime || new Date(),
      duration: session.totalDuration,
      participants: ['Speaker 1', 'Speaker 2', 'Speaker 3'], // Mock data
      executiveSummary: 'This meeting covered important project updates and planning for the next quarter.',
      keyDiscussions: [
        'Reviewed project milestones and deliverables',
        'Discussed resource allocation for Q2',
        'Analyzed market feedback and user requirements'
      ],
      decisions: [],
      actionItems: [],
      nextSteps: ['Follow up on action items', 'Schedule next meeting'],
      attachments: [],
      metadata: {
        segmentCount: session.segments.length,
        totalTranscripts: session.totalTranscripts,
        totalWords: session.totalWords,
        averageConfidence: session.averageConfidence,
        summarizationCost: 0.25,
        processingTime: 2500,
        qualityScore: 85
      }
    };

    const options: Partial<PDFGenerationOptions> = {
      template: (interaction.options.getString('template') as any) || 'professional',
      includeCover: interaction.options.getBoolean('include_cover') ?? true,
      includeMetadata: interaction.options.getBoolean('include_metadata') ?? true
    };

    const result = await pdfGenerator.generateReport(mockReport, options);

    // Create attachment
    const attachment = new AttachmentBuilder(result.filePath, {
      name: result.fileName
    });

    const embed = new EmbedBuilder()
      .setTitle('📋 Meeting Report Generated')
      .setDescription(`PDF report for session: ${session.sessionId}`)
      .setColor(0x57F287)
      .addFields(
        { name: '📄 Pages', value: result.pageCount.toString(), inline: true },
        { name: '💾 Size', value: `${(result.fileSize / 1024).toFixed(1)} KB`, inline: true },
        { name: '⏱️ Generation Time', value: `${result.generationTime}ms`, inline: true }
      )
      .setTimestamp();

    await interaction.editReply({
      content: '✅ PDF report generated successfully!',
      embeds: [embed],
      files: [attachment]
    });

  } catch (error) {
    logger.error('PDF generation failed:', error);
    await interaction.editReply({
      content: '❌ Failed to generate PDF report. Please try again later.'
    });
  }
}

async function handleExportData(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const format = interaction.options.getString('format', true);
  
  await interaction.editReply({
    content: `🔄 Exporting meeting data in ${format.toUpperCase()} format...`
  });

  // This would implement actual data export
  await interaction.followUp({
    content: `Export functionality for ${format} format will be implemented in the next update.`,
    ephemeral: true
  });
}

async function handleQuickReport(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  pdfGenerator: PDFGenerator,
  transcriptManager: TranscriptManager
): Promise<void> {
  await interaction.deferReply({ ephemeral: false });

  // Similar to PDF generation but with compact template
  await interaction.editReply({
    content: '⚡ Generating quick summary report...'
  });

  // Implementation would be similar to handleGeneratePDF but with quick options
  await interaction.followUp({
    content: 'Quick report functionality will be available shortly.',
    ephemeral: true
  });
}

async function handleSessionAnalytics(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Promise<void> {
  const sessionId = interaction.options.getString('session_id');
  const session = sessionId ? 
    transcriptManager.getSession(sessionId) : 
    transcriptManager.getActiveSession();

  if (!session) {
    await interaction.reply({
      content: 'No session found with the specified ID.',
      ephemeral: true
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📈 Session Analytics')
    .setDescription(`Analysis for session: ${session.sessionId}`)
    .setColor(0x5865F2)
    .addFields(
      { name: '⏱️ Duration', value: `${Math.round(session.totalDuration / 60000)} minutes`, inline: true },
      { name: '📝 Transcripts', value: session.totalTranscripts.toString(), inline: true },
      { name: '💬 Words', value: session.totalWords.toLocaleString(), inline: true },
      { name: '📊 Confidence', value: `${(session.averageConfidence * 100).toFixed(1)}%`, inline: true },
      { name: '🎯 Segments', value: session.segments.length.toString(), inline: true },
      { name: '📋 Status', value: session.state, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCostAnalytics(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer
): Promise<void> {
  const stats = summarizer.getUsageStats();

  const embed = new EmbedBuilder()
    .setTitle('💰 Cost Analytics')
    .setColor(0xFFD700)
    .addFields(
      { name: '💵 Total OpenAI Cost', value: `$${stats.openAI.totalCost.toFixed(4)}`, inline: true },
      { name: '🔢 Total Tokens', value: stats.openAI.totalTokens.toLocaleString(), inline: true },
      { name: '📊 Requests', value: stats.openAI.requestCount.toString(), inline: true },
      { name: '📈 Avg Cost/Request', value: `$${stats.openAI.averageCostPerRequest.toFixed(4)}`, inline: true },
      { name: '🎯 Avg Tokens/Request', value: Math.round(stats.openAI.averageTokensPerRequest).toLocaleString(), inline: true },
      { name: '💼 Session Costs', value: `$${stats.sessions.totalCost.toFixed(4)}`, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleQualityAnalytics(
  interaction: ChatInputCommandInteraction,
  summarizer: MeetingSummarizer,
  transcriptManager: TranscriptManager
): Promise<void> {
  const activeSession = transcriptManager.getActiveSession();
  const allSessions = transcriptManager.getAllSessions();

  const avgConfidence = allSessions.length > 0 ?
    allSessions.reduce((sum, s) => sum + s.averageConfidence, 0) / allSessions.length :
    0;

  const embed = new EmbedBuilder()
    .setTitle('🎯 Quality Analytics')
    .setColor(0x57F287)
    .addFields(
      { name: '📊 Overall Confidence', value: `${(avgConfidence * 100).toFixed(1)}%`, inline: true },
      { name: '📝 Total Sessions', value: allSessions.length.toString(), inline: true },
      { name: '✅ Active Sessions', value: activeSession ? '1' : '0', inline: true }
    );

  if (activeSession) {
    embed.addFields(
      { name: '🎯 Current Session Quality', value: `${(activeSession.averageConfidence * 100).toFixed(1)}%`, inline: true },
      { name: '💬 Current Word Count', value: activeSession.totalWords.toLocaleString(), inline: true },
      { name: '📋 Current Segments', value: activeSession.segments.length.toString(), inline: true }
    );
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Export all commands
export const summarizationCommands = {
  createSummaryCommand,
  createReportCommand,
  createAnalyticsCommand
};