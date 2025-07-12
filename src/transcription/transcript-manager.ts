import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import { TranscriptionResult } from './assemblyai-client';
import * as lz4 from 'lz4';

const logger = createLogger('TranscriptManager');

export interface TranscriptSegment {
  segmentId: string;
  sessionId: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  windowIndex: number;
  transcripts: TranscriptionResult[];
  participantCount: number;
  averageConfidence: number;
  wordCount: number;
  compressionRatio: number;
  metadata: SegmentMetadata;
}

export interface SegmentMetadata {
  totalSpeechTime: number;
  totalSilenceTime: number;
  speakerChanges: number;
  averageWordsPerMinute: number;
  dominantLanguage: string;
  audioQuality: 'low' | 'medium' | 'high';
  compressionLevel: number;
}

export interface TranscriptSession {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  startTime: Date;
  endTime?: Date;
  state: TranscriptSessionState;
  segments: TranscriptSegment[];
  currentSegment: TranscriptSegment | null;
  totalDuration: number;
  totalTranscripts: number;
  totalWords: number;
  averageConfidence: number;
  compressionStats: CompressionStats;
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  recordingSessionId?: string;
  participants: string[];
  maxConcurrentSpeakers: number;
  totalSpeechDuration: number;
  totalSilenceDuration: number;
  languageDistribution: Record<string, number>;
  qualityMetrics: QualityMetrics;
  costMetrics: CostMetrics;
}

export interface QualityMetrics {
  averageLatency: number;
  transcriptionAccuracy: number;
  audioLossRate: number;
  errorRate: number;
}

export interface CostMetrics {
  totalApiCalls: number;
  estimatedCost: number;
  audioMinutesProcessed: number;
  compressionSavings: number;
}

export interface CompressionStats {
  totalUncompressedSize: number;
  totalCompressedSize: number;
  averageCompressionRatio: number;
  compressionTimeMs: number;
}

export enum TranscriptSessionState {
  IDLE = 'idle',
  STARTING = 'starting',
  ACTIVE = 'active',
  PAUSED = 'paused',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

export interface TranscriptManagerEvents {
  'session-started': (session: TranscriptSession) => void;
  'session-stopped': (session: TranscriptSession) => void;
  'session-paused': (session: TranscriptSession) => void;
  'session-resumed': (session: TranscriptSession) => void;
  'segment-completed': (session: TranscriptSession, segment: TranscriptSegment) => void;
  'transcript-added': (session: TranscriptSession, transcript: TranscriptionResult) => void;
  'error': (error: Error) => void;
}

export class TranscriptManager extends EventEmitter {
  private sessions: Map<string, TranscriptSession> = new Map();
  private activeSession: TranscriptSession | null = null;
  private storageDir: string;
  private segmentDurationMs: number = 5 * 60 * 1000; // 5 minutes
  private currentSegmentTimer: NodeJS.Timeout | null = null;
  private compressionLevel: number = 4; // LZ4 compression level
  private maxSessionDuration: number = 8 * 60 * 60 * 1000; // 8 hours
  private cleanupInterval: number = 30 * 60 * 1000; // 30 minutes
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(storageDir: string = './transcripts') {
    super();
    this.storageDir = storageDir;
    this.setupCleanupTimer();
    
    logger.info('Transcript manager initialized', {
      storageDir: this.storageDir,
      segmentDurationMs: this.segmentDurationMs,
      compressionLevel: this.compressionLevel
    });
  }

  public async startSession(
    guildId: string,
    channelId: string,
    channelName: string,
    recordingSessionId?: string
  ): Promise<string> {
    if (this.activeSession && this.activeSession.state === TranscriptSessionState.ACTIVE) {
      throw new Error('A transcript session is already active');
    }

    try {
      logger.info('Starting new transcript session');

      // Create session directory
      const sessionId = this.generateSessionId();
      const sessionDir = path.join(this.storageDir, sessionId);
      await fs.promises.mkdir(sessionDir, { recursive: true });

      // Initialize transcript session
      const session: TranscriptSession = {
        sessionId,
        guildId,
        channelId,
        channelName,
        startTime: new Date(),
        state: TranscriptSessionState.STARTING,
        segments: [],
        currentSegment: null,
        totalDuration: 0,
        totalTranscripts: 0,
        totalWords: 0,
        averageConfidence: 0,
        compressionStats: {
          totalUncompressedSize: 0,
          totalCompressedSize: 0,
          averageCompressionRatio: 1.0,
          compressionTimeMs: 0
        },
        metadata: {
          recordingSessionId,
          participants: [],
          maxConcurrentSpeakers: 0,
          totalSpeechDuration: 0,
          totalSilenceDuration: 0,
          languageDistribution: {},
          qualityMetrics: {
            averageLatency: 0,
            transcriptionAccuracy: 0,
            audioLossRate: 0,
            errorRate: 0
          },
          costMetrics: {
            totalApiCalls: 0,
            estimatedCost: 0,
            audioMinutesProcessed: 0,
            compressionSavings: 0
          }
        }
      };

      // Create first segment
      session.currentSegment = await this.createNewSegment(session, 0);
      session.segments.push(session.currentSegment);

      // Store session
      this.sessions.set(sessionId, session);
      this.activeSession = session;

      // Start segment timer
      this.startSegmentTimer();

      // Update session state
      session.state = TranscriptSessionState.ACTIVE;

      logger.info('Transcript session started', {
        sessionId,
        channelName,
        recordingSessionId,
        segmentDurationMs: this.segmentDurationMs
      });

      this.emit('session-started', session);
      return sessionId;

    } catch (error) {
      logger.error('Failed to start transcript session:', error);
      if (this.activeSession) {
        this.activeSession.state = TranscriptSessionState.ERROR;
      }
      throw error;
    }
  }

  public async stopSession(): Promise<TranscriptSession | null> {
    if (!this.activeSession || this.activeSession.state === TranscriptSessionState.STOPPED) {
      logger.warn('No active transcript session to stop');
      return null;
    }

    try {
      logger.info('Stopping transcript session', {
        sessionId: this.activeSession.sessionId
      });

      this.activeSession.state = TranscriptSessionState.STOPPING;

      // Stop segment timer
      this.stopSegmentTimer();

      // Finalize current segment
      if (this.activeSession.currentSegment) {
        await this.finalizeSegment(this.activeSession, this.activeSession.currentSegment);
      }

      // Finalize session
      this.activeSession.endTime = new Date();
      this.activeSession.totalDuration = 
        this.activeSession.endTime.getTime() - this.activeSession.startTime.getTime();
      this.activeSession.state = TranscriptSessionState.STOPPED;

      // Calculate final metadata
      this.calculateSessionMetadata(this.activeSession);

      // Save session metadata
      await this.saveSessionMetadata(this.activeSession);

      logger.info('Transcript session stopped', {
        sessionId: this.activeSession.sessionId,
        duration: this.activeSession.totalDuration,
        totalTranscripts: this.activeSession.totalTranscripts,
        totalWords: this.activeSession.totalWords,
        segmentCount: this.activeSession.segments.length
      });

      const stoppedSession = this.activeSession;
      this.emit('session-stopped', stoppedSession);
      
      this.activeSession = null;
      return stoppedSession;

    } catch (error) {
      logger.error('Error stopping transcript session:', error);
      if (this.activeSession) {
        this.activeSession.state = TranscriptSessionState.ERROR;
      }
      throw error;
    }
  }

  public async pauseSession(): Promise<void> {
    if (!this.activeSession || this.activeSession.state !== TranscriptSessionState.ACTIVE) {
      throw new Error('No active transcript session to pause');
    }

    this.activeSession.state = TranscriptSessionState.PAUSED;
    this.stopSegmentTimer();

    logger.info('Transcript session paused', {
      sessionId: this.activeSession.sessionId
    });

    this.emit('session-paused', this.activeSession);
  }

  public async resumeSession(): Promise<void> {
    if (!this.activeSession || this.activeSession.state !== TranscriptSessionState.PAUSED) {
      throw new Error('No paused transcript session to resume');
    }

    this.activeSession.state = TranscriptSessionState.ACTIVE;
    this.startSegmentTimer();

    logger.info('Transcript session resumed', {
      sessionId: this.activeSession.sessionId
    });

    this.emit('session-resumed', this.activeSession);
  }

  public async addTranscript(transcript: TranscriptionResult): Promise<void> {
    if (!this.activeSession || this.activeSession.state !== TranscriptSessionState.ACTIVE) {
      return;
    }

    if (!this.activeSession.currentSegment) {
      logger.warn('No current segment available for transcript');
      return;
    }

    try {
      // Add transcript to current segment
      this.activeSession.currentSegment.transcripts.push(transcript);

      // Update segment statistics
      this.updateSegmentStats(this.activeSession.currentSegment, transcript);

      // Update session statistics
      this.updateSessionStats(this.activeSession, transcript);

      // Update cost metrics
      this.updateCostMetrics(this.activeSession, transcript);

      if (config.debugMode) {
        logger.debug('Transcript added to session', {
          sessionId: this.activeSession.sessionId,
          segmentId: this.activeSession.currentSegment.segmentId,
          transcriptType: transcript.messageType,
          confidence: transcript.confidence,
          textLength: transcript.text.length
        });
      }

      this.emit('transcript-added', this.activeSession, transcript);

    } catch (error) {
      logger.error('Error adding transcript to session:', error);
    }
  }

  private async createNewSegment(session: TranscriptSession, windowIndex: number): Promise<TranscriptSegment> {
    const segmentId = this.generateSegmentId();
    const now = new Date();

    const segment: TranscriptSegment = {
      segmentId,
      sessionId: session.sessionId,
      startTime: now,
      endTime: new Date(now.getTime() + this.segmentDurationMs),
      duration: this.segmentDurationMs,
      windowIndex,
      transcripts: [],
      participantCount: 0,
      averageConfidence: 0,
      wordCount: 0,
      compressionRatio: 1.0,
      metadata: {
        totalSpeechTime: 0,
        totalSilenceTime: 0,
        speakerChanges: 0,
        averageWordsPerMinute: 0,
        dominantLanguage: 'en',
        audioQuality: 'high',
        compressionLevel: this.compressionLevel
      }
    };

    logger.debug('Created new transcript segment', {
      sessionId: session.sessionId,
      segmentId,
      windowIndex,
      duration: this.segmentDurationMs
    });

    return segment;
  }

  private async finalizeSegment(session: TranscriptSession, segment: TranscriptSegment): Promise<void> {
    try {
      segment.endTime = new Date();
      segment.duration = segment.endTime.getTime() - segment.startTime.getTime();

      // Calculate final segment metadata
      this.calculateSegmentMetadata(segment);

      // Compress and save segment
      await this.saveSegment(session, segment);

      logger.info('Transcript segment finalized', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId,
        duration: segment.duration,
        transcriptCount: segment.transcripts.length,
        wordCount: segment.wordCount,
        averageConfidence: segment.averageConfidence
      });

      this.emit('segment-completed', session, segment);

    } catch (error) {
      logger.error('Error finalizing segment:', error);
      throw error;
    }
  }

  private updateSegmentStats(segment: TranscriptSegment, transcript: TranscriptionResult): void {
    // Update word count
    if (transcript.words) {
      segment.wordCount += transcript.words.length;
    }

    // Update average confidence
    const totalConfidence = segment.averageConfidence * segment.transcripts.length + transcript.confidence;
    segment.averageConfidence = totalConfidence / (segment.transcripts.length);

    // Update participant tracking
    // Note: We don't have speaker identification from AssemblyAI streaming
    // This would need to be enhanced with post-processing diarization
  }

  private updateSessionStats(session: TranscriptSession, transcript: TranscriptionResult): void {
    session.totalTranscripts++;
    
    if (transcript.words) {
      session.totalWords += transcript.words.length;
    }

    // Update average confidence
    const totalConfidence = session.averageConfidence * (session.totalTranscripts - 1) + transcript.confidence;
    session.averageConfidence = totalConfidence / session.totalTranscripts;

    // Update API call count
    session.metadata.costMetrics.totalApiCalls++;
  }

  private updateCostMetrics(session: TranscriptSession, transcript: TranscriptionResult): void {
    const costMetrics = session.metadata.costMetrics;
    
    // AssemblyAI streaming pricing: $0.15 per hour
    const audioDurationHours = (transcript.audioEnd - transcript.audioStart) / 3600000; // Convert ms to hours
    costMetrics.audioMinutesProcessed += audioDurationHours * 60;
    costMetrics.estimatedCost += audioDurationHours * 0.15;
  }

  private calculateSegmentMetadata(segment: TranscriptSegment): void {
    if (segment.transcripts.length === 0) return;

    const metadata = segment.metadata;
    
    // Calculate speech and silence times
    let totalSpeechTime = 0;
    for (const transcript of segment.transcripts) {
      totalSpeechTime += transcript.audioEnd - transcript.audioStart;
    }
    
    metadata.totalSpeechTime = totalSpeechTime;
    metadata.totalSilenceTime = segment.duration - totalSpeechTime;

    // Calculate words per minute
    const durationMinutes = segment.duration / 60000;
    metadata.averageWordsPerMinute = durationMinutes > 0 ? segment.wordCount / durationMinutes : 0;

    // Determine audio quality based on confidence
    if (segment.averageConfidence >= 0.9) {
      metadata.audioQuality = 'high';
    } else if (segment.averageConfidence >= 0.7) {
      metadata.audioQuality = 'medium';
    } else {
      metadata.audioQuality = 'low';
    }
  }

  private calculateSessionMetadata(session: TranscriptSession): void {
    const metadata = session.metadata;
    
    // Calculate total speech and silence times
    metadata.totalSpeechDuration = session.segments.reduce(
      (total, segment) => total + segment.metadata.totalSpeechTime, 0
    );
    metadata.totalSilenceDuration = session.totalDuration - metadata.totalSpeechDuration;

    // Calculate quality metrics
    metadata.qualityMetrics.transcriptionAccuracy = session.averageConfidence;

    // Calculate compression savings
    const compressionSavings = session.compressionStats.totalUncompressedSize - 
                              session.compressionStats.totalCompressedSize;
    metadata.costMetrics.compressionSavings = compressionSavings;
  }

  private async saveSegment(session: TranscriptSession, segment: TranscriptSegment): Promise<void> {
    try {
      const sessionDir = path.join(this.storageDir, session.sessionId);
      const segmentFile = path.join(sessionDir, `segment_${segment.windowIndex}.json.lz4`);

      // Prepare segment data for compression
      const segmentData = {
        ...segment,
        transcripts: segment.transcripts.map(t => ({
          ...t,
          created: t.created.toISOString()
        }))
      };

      const jsonData = JSON.stringify(segmentData, null, 2);
      const uncompressedBuffer = Buffer.from(jsonData, 'utf-8');

      // Compress using LZ4
      const compressionStart = Date.now();
      const compressedBuffer = lz4.encode(uncompressedBuffer);
      const compressionTime = Date.now() - compressionStart;

      // Calculate compression ratio
      segment.compressionRatio = uncompressedBuffer.length / compressedBuffer.length;

      // Update session compression stats
      session.compressionStats.totalUncompressedSize += uncompressedBuffer.length;
      session.compressionStats.totalCompressedSize += compressedBuffer.length;
      session.compressionStats.compressionTimeMs += compressionTime;
      session.compressionStats.averageCompressionRatio = 
        session.compressionStats.totalUncompressedSize / session.compressionStats.totalCompressedSize;

      // Save compressed segment
      await fs.promises.writeFile(segmentFile, compressedBuffer);

      logger.debug('Segment saved and compressed', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId,
        uncompressedSize: uncompressedBuffer.length,
        compressedSize: compressedBuffer.length,
        compressionRatio: segment.compressionRatio.toFixed(2),
        compressionTimeMs: compressionTime
      });

    } catch (error) {
      logger.error('Failed to save segment:', error);
      throw error;
    }
  }

  private async saveSessionMetadata(session: TranscriptSession): Promise<void> {
    try {
      const sessionDir = path.join(this.storageDir, session.sessionId);
      const metadataFile = path.join(sessionDir, 'session.json');

      const metadata = {
        session: {
          sessionId: session.sessionId,
          guildId: session.guildId,
          channelId: session.channelId,
          channelName: session.channelName,
          startTime: session.startTime.toISOString(),
          endTime: session.endTime?.toISOString(),
          totalDuration: session.totalDuration,
          state: session.state,
          totalTranscripts: session.totalTranscripts,
          totalWords: session.totalWords,
          averageConfidence: session.averageConfidence,
          segmentCount: session.segments.length
        },
        segments: session.segments.map(segment => ({
          segmentId: segment.segmentId,
          windowIndex: segment.windowIndex,
          startTime: segment.startTime.toISOString(),
          endTime: segment.endTime.toISOString(),
          duration: segment.duration,
          transcriptCount: segment.transcripts.length,
          wordCount: segment.wordCount,
          averageConfidence: segment.averageConfidence,
          compressionRatio: segment.compressionRatio,
          metadata: segment.metadata
        })),
        compressionStats: session.compressionStats,
        metadata: session.metadata
      };

      await fs.promises.writeFile(metadataFile, JSON.stringify(metadata, null, 2));

      logger.info('Session metadata saved', {
        sessionId: session.sessionId,
        metadataFile
      });

    } catch (error) {
      logger.error('Failed to save session metadata:', error);
      throw error;
    }
  }

  private startSegmentTimer(): void {
    this.stopSegmentTimer(); // Clear any existing timer
    
    this.currentSegmentTimer = setTimeout(async () => {
      if (this.activeSession && this.activeSession.currentSegment) {
        await this.rotateSegment();
      }
    }, this.segmentDurationMs);
  }

  private stopSegmentTimer(): void {
    if (this.currentSegmentTimer) {
      clearTimeout(this.currentSegmentTimer);
      this.currentSegmentTimer = null;
    }
  }

  private async rotateSegment(): Promise<void> {
    if (!this.activeSession || !this.activeSession.currentSegment) {
      return;
    }

    try {
      // Finalize current segment
      await this.finalizeSegment(this.activeSession, this.activeSession.currentSegment);

      // Create new segment
      const nextWindowIndex = this.activeSession.currentSegment.windowIndex + 1;
      this.activeSession.currentSegment = await this.createNewSegment(this.activeSession, nextWindowIndex);
      this.activeSession.segments.push(this.activeSession.currentSegment);

      // Restart timer for next segment
      this.startSegmentTimer();

      logger.info('Transcript segment rotated', {
        sessionId: this.activeSession.sessionId,
        newSegmentId: this.activeSession.currentSegment.segmentId,
        windowIndex: nextWindowIndex
      });

    } catch (error) {
      logger.error('Error rotating transcript segment:', error);
    }
  }

  private setupCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.cleanupInterval);
  }

  private performCleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean up old completed sessions (older than 24 hours)
    const cutoffTime = now - 24 * 60 * 60 * 1000;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.state === TranscriptSessionState.STOPPED && 
          session.endTime && 
          session.endTime.getTime() < cutoffTime) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Transcript manager cleanup completed', { sessionsCleaned: cleaned });
    }
  }

  private generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).substring(2, 8);
    return `transcript_${timestamp}_${random}`;
  }

  private generateSegmentId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `seg_${timestamp}_${random}`;
  }

  // Public accessors
  public getActiveSession(): TranscriptSession | null {
    return this.activeSession;
  }

  public getSession(sessionId: string): TranscriptSession | null {
    return this.sessions.get(sessionId) || null;
  }

  public getAllSessions(): TranscriptSession[] {
    return Array.from(this.sessions.values());
  }

  public getSessionCount(): number {
    return this.sessions.size;
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up transcript manager');

    try {
      // Stop active session
      if (this.activeSession && this.activeSession.state === TranscriptSessionState.ACTIVE) {
        await this.stopSession();
      }

      // Clear timers
      this.stopSegmentTimer();
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      // Clear sessions
      this.sessions.clear();
      this.activeSession = null;

      logger.info('Transcript manager cleanup completed');

    } catch (error) {
      logger.error('Error during transcript manager cleanup:', error);
      throw error;
    }
  }
}

export default TranscriptManager;