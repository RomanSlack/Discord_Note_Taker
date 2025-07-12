import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';
import OpenAIClient, { 
  SummarizationOptions, 
  SummarizationResult, 
  ActionItem, 
  Decision 
} from './openai-client';
import { 
  TranscriptSession, 
  TranscriptSegment, 
  TranscriptManager 
} from '@transcription/transcript-manager';
import { TranscriptionResult } from '@transcription/assemblyai-client';

const logger = createLogger('MeetingSummarizer');

export interface SummarizationConfig {
  segmentSummaryInterval: number; // 5 minutes default
  maxContextSegments: number; // Rolling window size
  enableInterimSummaries: boolean;
  enableFinalSummary: boolean;
  enableActionItemExtraction: boolean;
  enableDecisionTracking: boolean;
  costLimit: number; // Maximum cost per session
  qualityThreshold: number; // Minimum confidence threshold
}

export interface MeetingContext {
  sessionId: string;
  summaries: SummarizationResult[];
  actionItems: ActionItem[];
  decisions: Decision[];
  participants: Set<string>;
  keyTopics: string[];
  startTime: Date;
  lastSummaryTime: Date;
  totalCost: number;
  totalTokens: number;
}

export interface MeetingSummaryReport {
  sessionId: string;
  meetingTitle: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  participants: string[];
  executiveSummary: string;
  keyDiscussions: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  nextSteps: string[];
  attachments: string[];
  metadata: ReportMetadata;
}

export interface ReportMetadata {
  segmentCount: number;
  totalTranscripts: number;
  totalWords: number;
  averageConfidence: number;
  summarizationCost: number;
  processingTime: number;
  qualityScore: number;
}

export class MeetingSummarizer extends EventEmitter {
  private openAIClient: OpenAIClient;
  private transcriptManager: TranscriptManager;
  private config: SummarizationConfig;
  private activeSessions: Map<string, MeetingContext> = new Map();
  private summaryTimers: Map<string, NodeJS.Timeout> = new Map();
  private isEnabled = false;

  constructor(
    transcriptManager: TranscriptManager,
    openAIClient?: OpenAIClient,
    customConfig?: Partial<SummarizationConfig>
  ) {
    super();

    this.transcriptManager = transcriptManager;
    this.openAIClient = openAIClient || new OpenAIClient();
    
    this.config = {
      segmentSummaryInterval: 5 * 60 * 1000, // 5 minutes
      maxContextSegments: 6, // 30 minutes of context (6 * 5min)
      enableInterimSummaries: true,
      enableFinalSummary: true,
      enableActionItemExtraction: true,
      enableDecisionTracking: true,
      costLimit: 5.0, // $5 per session limit
      qualityThreshold: 0.7,
      ...customConfig
    };

    this.setupEventListeners();
    
    logger.info('Meeting summarizer initialized', {
      segmentInterval: this.config.segmentSummaryInterval,
      maxContextSegments: this.config.maxContextSegments,
      costLimit: this.config.costLimit
    });
  }

  public async enable(): Promise<void> {
    if (!config.openAiApiKey) {
      throw new Error('OpenAI API key not configured');
    }

    // Test OpenAI connection
    const connectionOk = await this.openAIClient.testConnection();
    if (!connectionOk) {
      throw new Error('Failed to connect to OpenAI API');
    }

    this.isEnabled = true;
    logger.info('Meeting summarization enabled');
    this.emit('summarization-enabled');
  }

  public async disable(): Promise<void> {
    this.isEnabled = false;
    
    // Clear all timers
    for (const timer of this.summaryTimers.values()) {
      clearTimeout(timer);
    }
    this.summaryTimers.clear();

    logger.info('Meeting summarization disabled');
    this.emit('summarization-disabled');
  }

  private setupEventListeners(): void {
    // Listen to transcript manager events
    this.transcriptManager.on('session-started', (session) => {
      if (this.isEnabled) {
        this.handleSessionStarted(session);
      }
    });

    this.transcriptManager.on('session-stopped', (session) => {
      if (this.isEnabled) {
        this.handleSessionStopped(session);
      }
    });

    this.transcriptManager.on('segment-completed', (session, segment) => {
      if (this.isEnabled) {
        this.handleSegmentCompleted(session, segment);
      }
    });

    this.transcriptManager.on('transcript-added', (session, transcript) => {
      if (this.isEnabled) {
        this.handleTranscriptAdded(session, transcript);
      }
    });

    // Listen to OpenAI client events
    this.openAIClient.on('summarization-completed', (result) => {
      this.handleSummarizationCompleted(result);
    });

    this.openAIClient.on('summarization-error', (error, options) => {
      this.handleSummarizationError(error, options);
    });
  }

  private async handleSessionStarted(session: TranscriptSession): Promise<void> {
    logger.info('Starting summarization for session', { sessionId: session.sessionId });

    const context: MeetingContext = {
      sessionId: session.sessionId,
      summaries: [],
      actionItems: [],
      decisions: [],
      participants: new Set(),
      keyTopics: [],
      startTime: session.startTime,
      lastSummaryTime: session.startTime,
      totalCost: 0,
      totalTokens: 0
    };

    this.activeSessions.set(session.sessionId, context);

    // Start periodic summarization timer if enabled
    if (this.config.enableInterimSummaries) {
      this.startSummaryTimer(session.sessionId);
    }

    this.emit('session-summarization-started', session.sessionId);
  }

  private async handleSessionStopped(session: TranscriptSession): Promise<void> {
    logger.info('Finalizing summarization for session', { sessionId: session.sessionId });

    const context = this.activeSessions.get(session.sessionId);
    if (!context) return;

    // Clear timer
    const timer = this.summaryTimers.get(session.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.summaryTimers.delete(session.sessionId);
    }

    // Generate final summary if enabled
    if (this.config.enableFinalSummary) {
      try {
        const finalReport = await this.generateFinalSummary(session);
        this.emit('final-summary-generated', finalReport);
      } catch (error) {
        logger.error('Failed to generate final summary', { 
          sessionId: session.sessionId, 
          error 
        });
      }
    }

    // Clean up context
    this.activeSessions.delete(session.sessionId);
    this.emit('session-summarization-stopped', session.sessionId);
  }

  private async handleSegmentCompleted(
    session: TranscriptSession, 
    segment: TranscriptSegment
  ): Promise<void> {
    const context = this.activeSessions.get(session.sessionId);
    if (!context) return;

    // Check if it's time for an interim summary
    const timeSinceLastSummary = Date.now() - context.lastSummaryTime.getTime();
    if (timeSinceLastSummary >= this.config.segmentSummaryInterval) {
      await this.generateInterimSummary(session, segment);
    }
  }

  private handleTranscriptAdded(
    session: TranscriptSession, 
    transcript: TranscriptionResult
  ): void {
    const context = this.activeSessions.get(session.sessionId);
    if (!context) return;

    // Extract participant information (if available)
    // Note: This would be enhanced with actual speaker identification
    if (transcript.text.length > 10) { // Only count substantial contributions
      // This is a placeholder - real speaker identification would be needed
      const estimatedSpeaker = `Speaker_${Math.floor(Math.random() * 4) + 1}`;
      context.participants.add(estimatedSpeaker);
    }

    // Update context with key topics (simple keyword extraction)
    const keywords = this.extractKeywords(transcript.text);
    context.keyTopics.push(...keywords);
    
    // Keep only unique topics and limit to recent ones
    context.keyTopics = [...new Set(context.keyTopics)].slice(-20);
  }

  private async generateInterimSummary(
    session: TranscriptSession,
    segment: TranscriptSegment
  ): Promise<SummarizationResult | null> {
    const context = this.activeSessions.get(session.sessionId);
    if (!context) return null;

    try {
      logger.info('Generating interim summary', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId
      });

      // Check cost limit
      if (context.totalCost >= this.config.costLimit) {
        logger.warn('Cost limit reached, skipping summarization', {
          sessionId: session.sessionId,
          currentCost: context.totalCost,
          limit: this.config.costLimit
        });
        return null;
      }

      // Get recent transcripts for summarization
      const recentTranscripts = this.getRecentTranscripts(session, segment);
      if (recentTranscripts.length === 0) return null;

      // Build context from previous summaries
      const contextHistory = this.buildContextHistory(context);

      // Generate summary
      const options: SummarizationOptions = {
        type: 'interim',
        maxLength: 300,
        includeTimestamps: true,
        includeConfidence: false,
        contextWindow: this.config.maxContextSegments
      };

      const result = await this.openAIClient.summarizeTranscripts(
        recentTranscripts,
        options,
        contextHistory
      );

      // Update metadata
      result.metadata.sessionId = session.sessionId;
      result.metadata.segmentIds = [segment.segmentId];

      // Update context
      context.summaries.push(result);
      context.lastSummaryTime = new Date();
      context.totalCost += result.cost;
      context.totalTokens += result.tokenUsage.totalTokens;

      // Extract action items and decisions if enabled
      if (this.config.enableActionItemExtraction && result.actionItems) {
        context.actionItems.push(...result.actionItems);
      }

      if (this.config.enableDecisionTracking && result.decisions) {
        context.decisions.push(...result.decisions);
      }

      // Keep only recent summaries to manage memory
      if (context.summaries.length > this.config.maxContextSegments) {
        context.summaries = context.summaries.slice(-this.config.maxContextSegments);
      }

      logger.info('Interim summary generated', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId,
        cost: result.cost,
        tokens: result.tokenUsage.totalTokens,
        keyPointsCount: result.keyPoints.length
      });

      this.emit('interim-summary-generated', result);
      return result;

    } catch (error) {
      logger.error('Failed to generate interim summary', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId,
        error
      });
      return null;
    }
  }

  private async generateFinalSummary(session: TranscriptSession): Promise<MeetingSummaryReport> {
    const context = this.activeSessions.get(session.sessionId);
    if (!context) {
      throw new Error('No context found for session');
    }

    try {
      logger.info('Generating final summary report', { sessionId: session.sessionId });

      // Get all transcripts from the session
      const allTranscripts = this.getAllSessionTranscripts(session);
      
      // Generate comprehensive final summary
      const options: SummarizationOptions = {
        type: 'final',
        maxLength: 1000,
        includeTimestamps: true,
        focus: context.keyTopics.slice(0, 5) // Top 5 topics
      };

      const contextHistory = context.summaries.map(s => s.summary);

      const finalSummary = await this.openAIClient.summarizeTranscripts(
        allTranscripts,
        options,
        contextHistory
      );

      // Update context costs
      context.totalCost += finalSummary.cost;
      context.totalTokens += finalSummary.tokenUsage.totalTokens;

      // Build comprehensive report
      const report: MeetingSummaryReport = {
        sessionId: session.sessionId,
        meetingTitle: `Meeting in ${session.channelName}`,
        startTime: session.startTime,
        endTime: session.endTime || new Date(),
        duration: session.totalDuration,
        participants: Array.from(context.participants),
        executiveSummary: finalSummary.summary,
        keyDiscussions: finalSummary.keyPoints,
        decisions: [...context.decisions, ...(finalSummary.decisions || [])],
        actionItems: [...context.actionItems, ...(finalSummary.actionItems || [])],
        nextSteps: this.extractNextSteps(finalSummary, context),
        attachments: [],
        metadata: {
          segmentCount: session.segments.length,
          totalTranscripts: session.totalTranscripts,
          totalWords: session.totalWords,
          averageConfidence: session.averageConfidence,
          summarizationCost: context.totalCost,
          processingTime: finalSummary.processingTime,
          qualityScore: this.calculateQualityScore(session, context)
        }
      };

      logger.info('Final summary report generated', {
        sessionId: session.sessionId,
        totalCost: context.totalCost,
        totalTokens: context.totalTokens,
        actionItemsCount: report.actionItems.length,
        decisionsCount: report.decisions.length,
        qualityScore: report.metadata.qualityScore
      });

      return report;

    } catch (error) {
      logger.error('Failed to generate final summary report', {
        sessionId: session.sessionId,
        error
      });
      throw error;
    }
  }

  private getRecentTranscripts(
    session: TranscriptSession,
    currentSegment: TranscriptSegment
  ): any[] {
    const segments = session.segments
      .slice(-this.config.maxContextSegments)
      .filter(s => s.segmentId === currentSegment.segmentId || s.transcripts.length > 0);

    const transcripts: any[] = [];
    for (const segment of segments) {
      transcripts.push(...segment.transcripts);
    }

    return transcripts;
  }

  private getAllSessionTranscripts(session: TranscriptSession): any[] {
    const allTranscripts: any[] = [];
    for (const segment of session.segments) {
      allTranscripts.push(...segment.transcripts);
    }
    return allTranscripts;
  }

  private buildContextHistory(context: MeetingContext): string[] {
    return context.summaries
      .slice(-3) // Last 3 summaries for context
      .map(summary => `Previous summary: ${summary.summary}`);
  }

  private extractKeywords(text: string): string[] {
    // Simple keyword extraction - could be enhanced with NLP
    const words = text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 4);

    // Filter out common stop words
    const stopWords = new Set(['about', 'above', 'after', 'again', 'against', 'should', 'would', 'could']);
    return words.filter(word => !stopWords.has(word));
  }

  private extractNextSteps(
    finalSummary: SummarizationResult,
    context: MeetingContext
  ): string[] {
    const nextSteps: string[] = [];

    // Extract from action items
    context.actionItems.forEach(item => {
      if (item.priority === 'high') {
        nextSteps.push(`High priority: ${item.description}`);
      }
    });

    // Extract from key points that suggest follow-up
    finalSummary.keyPoints.forEach(point => {
      if (point.toLowerCase().includes('next') || 
          point.toLowerCase().includes('follow') ||
          point.toLowerCase().includes('schedule')) {
        nextSteps.push(point);
      }
    });

    return nextSteps.slice(0, 5); // Limit to 5 next steps
  }

  private calculateQualityScore(
    session: TranscriptSession,
    context: MeetingContext
  ): number {
    let score = 0;

    // Base score from transcript confidence
    score += session.averageConfidence * 40;

    // Bonus for having action items
    if (context.actionItems.length > 0) score += 20;

    // Bonus for having decisions
    if (context.decisions.length > 0) score += 20;

    // Bonus for participant engagement
    if (context.participants.size > 1) score += 10;

    // Penalty for low word count (likely poor audio)
    if (session.totalWords < 100) score -= 20;

    // Bonus for good duration (not too short, not too long)
    const durationMinutes = session.totalDuration / 60000;
    if (durationMinutes >= 5 && durationMinutes <= 120) score += 10;

    return Math.max(0, Math.min(100, score));
  }

  private startSummaryTimer(sessionId: string): void {
    const timer = setTimeout(async () => {
      const session = this.transcriptManager.getActiveSession();
      if (session && session.sessionId === sessionId && session.currentSegment) {
        await this.generateInterimSummary(session, session.currentSegment);
        this.startSummaryTimer(sessionId); // Restart timer
      }
    }, this.config.segmentSummaryInterval);

    this.summaryTimers.set(sessionId, timer);
  }

  private handleSummarizationCompleted(result: SummarizationResult): void {
    logger.debug('Summarization completed', {
      id: result.id,
      type: result.type,
      cost: result.cost,
      tokens: result.tokenUsage.totalTokens
    });
  }

  private handleSummarizationError(error: any, options: SummarizationOptions): void {
    logger.error('Summarization error', {
      type: options.type,
      error: error instanceof Error ? error.message : String(error)
    });
    
    this.emit('summarization-error', error, options);
  }

  // Public methods
  public async generateManualSummary(
    sessionId: string,
    type: SummarizationOptions['type'] = 'interim'
  ): Promise<SummarizationResult | null> {
    const session = this.transcriptManager.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const currentSegment = session.currentSegment || session.segments[session.segments.length - 1];
    if (!currentSegment) {
      throw new Error('No segments available for summarization');
    }

    return await this.generateInterimSummary(session, currentSegment);
  }

  public getSessionContext(sessionId: string): MeetingContext | null {
    return this.activeSessions.get(sessionId) || null;
  }

  public getUsageStats(): any {
    const openAiStats = this.openAIClient.getUsageStats();
    const sessionStats = Array.from(this.activeSessions.values());
    
    return {
      openAI: openAiStats,
      sessions: {
        active: sessionStats.length,
        totalCost: sessionStats.reduce((sum, ctx) => sum + ctx.totalCost, 0),
        totalTokens: sessionStats.reduce((sum, ctx) => sum + ctx.totalTokens, 0)
      }
    };
  }

  public isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up meeting summarizer');

    await this.disable();
    await this.openAIClient.cleanup();
    this.activeSessions.clear();
    this.removeAllListeners();

    logger.info('Meeting summarizer cleanup completed');
  }
}

export default MeetingSummarizer;