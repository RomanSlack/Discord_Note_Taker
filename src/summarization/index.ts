import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';
import OpenAIClient from './openai-client';
import MeetingSummarizer from './meeting-summarizer';
import PDFGenerator from './pdf-generator';
import { summarizationCommands } from './summarization-commands';
import { TranscriptManager } from '@transcription/transcript-manager';

const logger = createLogger('SummarizationSystem');

export interface SummarizationSystemConfig {
  enableAutoSummarization: boolean;
  summaryInterval: number;
  costLimit: number;
  outputDirectory: string;
  enablePDFGeneration: boolean;
  defaultTemplate: 'professional' | 'compact' | 'detailed';
  branding?: {
    companyName?: string;
    primaryColor?: string;
    secondaryColor?: string;
  };
}

export class SummarizationSystem extends EventEmitter {
  private openAIClient: OpenAIClient;
  private meetingSummarizer: MeetingSummarizer;
  private pdfGenerator: PDFGenerator;
  private transcriptManager: TranscriptManager;
  private config: SummarizationSystemConfig;
  private isInitialized = false;

  constructor(
    transcriptManager: TranscriptManager,
    systemConfig?: Partial<SummarizationSystemConfig>
  ) {
    super();

    this.transcriptManager = transcriptManager;
    this.config = {
      enableAutoSummarization: true,
      summaryInterval: 5 * 60 * 1000, // 5 minutes
      costLimit: 5.0, // $5 per session
      outputDirectory: './reports',
      enablePDFGeneration: true,
      defaultTemplate: 'professional',
      branding: {
        companyName: 'Discord Voice Companion',
        primaryColor: '#5865F2',
        secondaryColor: '#57F287'
      },
      ...systemConfig
    };

    logger.info('Summarization system created', {
      autoSummarization: this.config.enableAutoSummarization,
      summaryInterval: this.config.summaryInterval,
      costLimit: this.config.costLimit
    });
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Summarization system already initialized');
      return;
    }

    try {
      logger.info('Initializing summarization system...');

      // Check if OpenAI API key is available
      if (!config.openAiApiKey) {
        logger.warn('OpenAI API key not configured - summarization features disabled');
        this.emit('initialization-skipped', 'OpenAI API key not configured');
        return;
      }

      // Initialize OpenAI client
      this.openAIClient = new OpenAIClient(config.openAiApiKey);
      await this.testOpenAIConnection();

      // Initialize PDF generator
      this.pdfGenerator = new PDFGenerator(this.config.outputDirectory);
      if (this.config.branding) {
        this.pdfGenerator.setDefaultBranding(this.config.branding);
      }

      // Initialize meeting summarizer
      this.meetingSummarizer = new MeetingSummarizer(
        this.transcriptManager,
        this.openAIClient,
        {
          segmentSummaryInterval: this.config.summaryInterval,
          enableInterimSummaries: this.config.enableAutoSummarization,
          costLimit: this.config.costLimit
        }
      );

      // Set up event listeners
      this.setupEventListeners();

      // Enable summarization if auto-summarization is enabled
      if (this.config.enableAutoSummarization) {
        await this.meetingSummarizer.enable();
      }

      this.isInitialized = true;
      logger.info('Summarization system initialized successfully');
      this.emit('initialized');

    } catch (error) {
      logger.error('Failed to initialize summarization system:', error);
      this.emit('initialization-error', error);
      throw error;
    }
  }

  private async testOpenAIConnection(): Promise<void> {
    try {
      const connectionOk = await this.openAIClient.testConnection();
      if (!connectionOk) {
        throw new Error('OpenAI connection test failed');
      }
      logger.info('OpenAI connection verified');
    } catch (error) {
      logger.error('OpenAI connection test failed:', error);
      throw new Error('Failed to connect to OpenAI API');
    }
  }

  private setupEventListeners(): void {
    // Meeting summarizer events
    this.meetingSummarizer.on('session-summarization-started', (sessionId) => {
      logger.info('Summarization started for session', { sessionId });
      this.emit('summarization-started', sessionId);
    });

    this.meetingSummarizer.on('interim-summary-generated', (result) => {
      logger.info('Interim summary generated', { 
        sessionId: result.metadata.sessionId,
        cost: result.cost 
      });
      this.emit('interim-summary', result);
    });

    this.meetingSummarizer.on('final-summary-generated', (report) => {
      logger.info('Final summary generated', { 
        sessionId: report.sessionId,
        cost: report.metadata.summarizationCost 
      });
      this.emit('final-summary', report);
      
      // Auto-generate PDF if enabled
      if (this.config.enablePDFGeneration) {
        this.autoGeneratePDF(report);
      }
    });

    this.meetingSummarizer.on('summarization-error', (error, options) => {
      logger.error('Summarization error:', { error, options });
      this.emit('summarization-error', error, options);
    });

    // PDF generator events
    this.pdfGenerator.on('pdf-generated', (result) => {
      logger.info('PDF report generated', {
        fileName: result.fileName,
        fileSize: result.fileSize,
        generationTime: result.generationTime
      });
      this.emit('pdf-generated', result);
    });

    this.pdfGenerator.on('pdf-generation-error', (error, report) => {
      logger.error('PDF generation error:', { error, sessionId: report.sessionId });
      this.emit('pdf-error', error, report);
    });

    // OpenAI client events
    this.openAIClient.on('usage-updated', (stats) => {
      this.emit('usage-updated', stats);
      
      // Log cost warnings
      if (stats.totalCost > this.config.costLimit * 0.8) {
        logger.warn('Approaching cost limit', {
          currentCost: stats.totalCost,
          limit: this.config.costLimit
        });
      }
    });
  }

  private async autoGeneratePDF(report: any): Promise<void> {
    try {
      logger.info('Auto-generating PDF report', { sessionId: report.sessionId });
      
      const result = await this.pdfGenerator.generateReport(report, {
        template: this.config.defaultTemplate
      });
      
      logger.info('Auto-generated PDF report completed', {
        sessionId: report.sessionId,
        fileName: result.fileName
      });
      
    } catch (error) {
      logger.error('Auto PDF generation failed:', error);
    }
  }

  // Public methods
  public async enableSummarization(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Summarization system not initialized');
    }
    
    await this.meetingSummarizer.enable();
    logger.info('Summarization enabled');
    this.emit('summarization-enabled');
  }

  public async disableSummarization(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }
    
    await this.meetingSummarizer.disable();
    logger.info('Summarization disabled');
    this.emit('summarization-disabled');
  }

  public async generateManualSummary(
    sessionId?: string,
    type: 'interim' | 'action-items' | 'decisions' = 'interim'
  ): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Summarization system not initialized');
    }

    const targetSessionId = sessionId || this.transcriptManager.getActiveSession()?.sessionId;
    if (!targetSessionId) {
      throw new Error('No session ID provided and no active session found');
    }

    return await this.meetingSummarizer.generateManualSummary(targetSessionId, type);
  }

  public async generatePDFReport(
    sessionId?: string,
    options?: any
  ): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Summarization system not initialized');
    }

    // This would need to be implemented to get or generate a meeting summary report
    throw new Error('PDF report generation not yet implemented');
  }

  public getUsageStats(): any {
    if (!this.isInitialized) {
      return null;
    }

    return {
      summarizer: this.meetingSummarizer.getUsageStats(),
      openAI: this.openAIClient.getUsageStats(),
      config: this.config
    };
  }

  public isEnabled(): boolean {
    return this.isInitialized && this.config.enableAutoSummarization;
  }

  public getConfiguration(): SummarizationSystemConfig {
    return { ...this.config };
  }

  public async updateConfiguration(
    newConfig: Partial<SummarizationSystemConfig>
  ): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    
    logger.info('Summarization system configuration updated', newConfig);
    this.emit('configuration-updated', this.config);
  }

  public getCommands(): any[] {
    if (!this.isInitialized) {
      return [];
    }

    return [
      summarizationCommands.createSummaryCommand(this.meetingSummarizer, this.transcriptManager),
      summarizationCommands.createReportCommand(this.meetingSummarizer, this.pdfGenerator, this.transcriptManager),
      summarizationCommands.createAnalyticsCommand(this.meetingSummarizer, this.transcriptManager)
    ];
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up summarization system');

    try {
      if (this.meetingSummarizer) {
        await this.meetingSummarizer.cleanup();
      }

      if (this.openAIClient) {
        await this.openAIClient.cleanup();
      }

      if (this.pdfGenerator) {
        await this.pdfGenerator.cleanup();
      }

      this.removeAllListeners();
      this.isInitialized = false;

      logger.info('Summarization system cleanup completed');
      this.emit('cleanup-completed');

    } catch (error) {
      logger.error('Error during summarization system cleanup:', error);
      throw error;
    }
  }
}

// Export types and classes
export {
  OpenAIClient,
  MeetingSummarizer,
  PDFGenerator,
  summarizationCommands
};

export default SummarizationSystem;