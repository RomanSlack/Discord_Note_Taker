import { EventEmitter } from 'events';
import { VoiceConnection } from '@discordjs/voice';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import MultiTrackRecorder, { 
  RecordingSession, 
  AudioSegment, 
  RecordingState,
  RecordingEvents 
} from '../voice/multitrack-recorder';
import TranscriptionPipeline, { 
  PipelineState,
  TranscriptionPipelineConfig 
} from './transcription-pipeline';
import TranscriptManager, { 
  TranscriptSession,
  TranscriptSessionState 
} from './transcript-manager';
import { TranscriptionConfig } from './assemblyai-client';
import { AudioFormat } from './audio-converter';

const logger = createLogger('IntegratedRecordingManager');

export interface IntegratedRecordingOptions {
  enableRecording: boolean;
  enableTranscription: boolean;
  recordingOptions?: {
    enableAudioProcessing: boolean;
    outputFormat: {
      sampleRate: number;
      channels: number;
      bitDepth: number;
      encoding: 'pcm' | 'wav';
    };
  };
  transcriptionOptions?: {
    confidenceThreshold: number;
    language: string;
    enableRealTimeFiltering: boolean;
    enableQualityMonitoring: boolean;
  };
}

export interface IntegratedSession {
  guildId: string;
  recordingSession: RecordingSession | null;
  transcriptSession: TranscriptSession | null;
  isRecording: boolean;
  isTranscribing: boolean;
  startTime: Date;
  options: IntegratedRecordingOptions;
}

export interface IntegratedRecordingManagerEvents extends RecordingEvents {
  'integrated-session-started': (session: IntegratedSession) => void;
  'integrated-session-stopped': (session: IntegratedSession) => void;
  'transcription-ready': (session: IntegratedSession, transcript: any) => void;
}

export class IntegratedRecordingManager extends EventEmitter {
  private activeSessions: Map<string, IntegratedSession> = new Map();
  private recordingManager: Map<string, MultiTrackRecorder> = new Map();
  private transcriptionPipeline: TranscriptionPipeline | null = null;
  private transcriptManager: TranscriptManager;
  private storageDir: string;

  constructor(storageDir: string = './recordings') {
    super();
    this.storageDir = storageDir;
    this.transcriptManager = new TranscriptManager(storageDir + '/transcripts');
    
    this.initializeTranscriptionSystem();
    
    logger.info('Integrated recording manager initialized', {
      storageDir: this.storageDir,
      transcriptionEnabled: !!this.transcriptionPipeline
    });
  }

  private initializeTranscriptionSystem(): void {
    if (!config.assemblyAiApiKey) {
      logger.warn('AssemblyAI API key not configured, transcription will be disabled');
      return;
    }

    try {
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

      this.transcriptionPipeline = new TranscriptionPipeline(
        pipelineConfig,
        this.transcriptManager,
        this.storageDir + '/transcripts'
      );

      // Set up transcription event handlers
      this.setupTranscriptionEventHandlers();

      logger.info('Transcription system initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize transcription system:', error);
      this.transcriptionPipeline = null;
    }
  }

  public async startIntegratedSession(
    guildId: string,
    connection: VoiceConnection,
    channelName: string,
    options: IntegratedRecordingOptions
  ): Promise<string> {
    if (this.activeSessions.has(guildId)) {
      throw new Error('An integrated session is already active for this guild');
    }

    try {
      logger.info('Starting integrated recording session', {
        guildId,
        channelName,
        enableRecording: options.enableRecording,
        enableTranscription: options.enableTranscription
      });

      // Initialize integrated session
      const integratedSession: IntegratedSession = {
        guildId,
        recordingSession: null,
        transcriptSession: null,
        isRecording: false,
        isTranscribing: false,
        startTime: new Date(),
        options
      };

      this.activeSessions.set(guildId, integratedSession);

      // Start recording if enabled
      if (options.enableRecording) {
        await this.startRecording(guildId, connection, channelName, options);
      }

      // Start transcription if enabled
      if (options.enableTranscription && this.transcriptionPipeline) {
        await this.startTranscription(guildId, channelName, options);
      }

      const sessionId = integratedSession.recordingSession?.sessionId || 
                       integratedSession.transcriptSession?.sessionId || 
                       `integrated_${Date.now()}`;

      logger.info('Integrated session started', {
        guildId,
        sessionId,
        isRecording: integratedSession.isRecording,
        isTranscribing: integratedSession.isTranscribing
      });

      this.emit('integrated-session-started', integratedSession);
      return sessionId;

    } catch (error) {
      logger.error('Failed to start integrated session:', error);
      this.activeSessions.delete(guildId);
      throw error;
    }
  }

  public async stopIntegratedSession(guildId: string): Promise<IntegratedSession | null> {
    const session = this.activeSessions.get(guildId);
    if (!session) {
      logger.warn('No active integrated session found for guild', { guildId });
      return null;
    }

    try {
      logger.info('Stopping integrated recording session', { guildId });

      // Stop transcription first
      if (session.isTranscribing && this.transcriptionPipeline) {
        await this.transcriptionPipeline.stop();
        session.isTranscribing = false;
      }

      // Stop recording
      if (session.isRecording) {
        const recorder = this.recordingManager.get(guildId);
        if (recorder) {
          session.recordingSession = await recorder.stopRecording();
          await recorder.cleanup();
          this.recordingManager.delete(guildId);
          session.isRecording = false;
        }
      }

      // Clean up session
      this.activeSessions.delete(guildId);

      logger.info('Integrated session stopped', {
        guildId,
        sessionId: session.recordingSession?.sessionId || session.transcriptSession?.sessionId
      });

      this.emit('integrated-session-stopped', session);
      return session;

    } catch (error) {
      logger.error('Error stopping integrated session:', error);
      throw error;
    }
  }

  public async pauseIntegratedSession(guildId: string): Promise<void> {
    const session = this.activeSessions.get(guildId);
    if (!session) {
      throw new Error('No active integrated session found');
    }

    // Pause transcription
    if (session.isTranscribing && this.transcriptionPipeline) {
      await this.transcriptionPipeline.pause();
    }

    // Pause recording
    if (session.isRecording) {
      const recorder = this.recordingManager.get(guildId);
      if (recorder) {
        await recorder.pauseRecording();
      }
    }

    logger.info('Integrated session paused', { guildId });
  }

  public async resumeIntegratedSession(guildId: string): Promise<void> {
    const session = this.activeSessions.get(guildId);
    if (!session) {
      throw new Error('No active integrated session found');
    }

    // Resume recording
    if (session.isRecording) {
      const recorder = this.recordingManager.get(guildId);
      if (recorder) {
        await recorder.resumeRecording();
      }
    }

    // Resume transcription
    if (session.isTranscribing && this.transcriptionPipeline) {
      await this.transcriptionPipeline.resume();
    }

    logger.info('Integrated session resumed', { guildId });
  }

  private async startRecording(
    guildId: string,
    connection: VoiceConnection,
    channelName: string,
    options: IntegratedRecordingOptions
  ): Promise<void> {
    try {
      const recorder = new MultiTrackRecorder(connection, this.storageDir);
      this.recordingManager.set(guildId, recorder);

      // Set up recording event handlers
      this.setupRecordingEventHandlers(guildId, recorder);

      // Start recording
      const sessionId = await recorder.startRecording(channelName);
      
      const session = this.activeSessions.get(guildId);
      if (session) {
        session.recordingSession = recorder.getCurrentSession();
        session.isRecording = true;
      }

      logger.info('Recording started for integrated session', {
        guildId,
        sessionId,
        channelName
      });

    } catch (error) {
      logger.error('Failed to start recording in integrated session:', error);
      throw error;
    }
  }

  private async startTranscription(
    guildId: string,
    channelName: string,
    options: IntegratedRecordingOptions
  ): Promise<void> {
    if (!this.transcriptionPipeline) {
      throw new Error('Transcription system is not initialized');
    }

    try {
      // Start transcription pipeline
      const sessionId = await this.transcriptionPipeline.start(
        guildId,
        guildId, // Using guildId as channelId for now
        channelName
      );

      const session = this.activeSessions.get(guildId);
      if (session) {
        session.transcriptSession = this.transcriptManager.getActiveSession();
        session.isTranscribing = true;
      }

      logger.info('Transcription started for integrated session', {
        guildId,
        sessionId,
        channelName
      });

    } catch (error) {
      logger.error('Failed to start transcription in integrated session:', error);
      throw error;
    }
  }

  private setupRecordingEventHandlers(guildId: string, recorder: MultiTrackRecorder): void {
    // Forward recording events
    recorder.on('session-started', withLogging((session: RecordingSession) => {
      this.emit('session-started', session);
    }, 'IntegratedManager-Recording-SessionStarted'));

    recorder.on('session-stopped', withLogging((session: RecordingSession) => {
      this.emit('session-stopped', session);
    }, 'IntegratedManager-Recording-SessionStopped'));

    recorder.on('audio-segment', withLogging(async (session: RecordingSession, segment: AudioSegment) => {
      // Process audio segment for transcription
      await this.processAudioSegmentForTranscription(guildId, segment);
      this.emit('audio-segment', session, segment);
    }, 'IntegratedManager-Recording-AudioSegment'));

    recorder.on('user-speaking', withLogging((session: RecordingSession, userId: string) => {
      this.emit('user-speaking', session, userId);
    }, 'IntegratedManager-Recording-UserSpeaking'));

    recorder.on('user-silent', withLogging((session: RecordingSession, userId: string) => {
      this.emit('user-silent', session, userId);
    }, 'IntegratedManager-Recording-UserSilent'));

    recorder.on('error', withLogging((error: Error) => {
      logger.error('Recording error in integrated session:', error);
      this.emit('error', error);
    }, 'IntegratedManager-Recording-Error'));
  }

  private setupTranscriptionEventHandlers(): void {
    if (!this.transcriptionPipeline) return;

    this.transcriptionPipeline.on('transcript-received', withLogging((transcript: any) => {
      // Find the session that corresponds to this transcript
      for (const [guildId, session] of this.activeSessions) {
        if (session.isTranscribing) {
          this.emit('transcription-ready', session, transcript);
          break;
        }
      }
    }, 'IntegratedManager-Transcription-Received'));

    this.transcriptionPipeline.on('pipeline-error', withLogging((error: Error) => {
      logger.error('Transcription pipeline error:', error);
      this.emit('error', error);
    }, 'IntegratedManager-Transcription-Error'));
  }

  private async processAudioSegmentForTranscription(guildId: string, segment: AudioSegment): Promise<void> {
    const session = this.activeSessions.get(guildId);
    if (!session || !session.isTranscribing || !this.transcriptionPipeline) {
      return;
    }

    try {
      // Send audio segment to transcription pipeline
      await this.transcriptionPipeline.processAudioSegment(segment);

      if (config.debugMode) {
        logger.debug('Audio segment sent to transcription pipeline', {
          guildId,
          segmentId: segment.segmentId,
          audioSize: segment.audioData.length,
          duration: segment.duration
        });
      }

    } catch (error) {
      logger.error('Error processing audio segment for transcription:', error);
    }
  }

  // Public accessors
  public getIntegratedSession(guildId: string): IntegratedSession | null {
    return this.activeSessions.get(guildId) || null;
  }

  public getRecordingState(guildId: string): RecordingState {
    const recorder = this.recordingManager.get(guildId);
    return recorder?.getRecordingState() || RecordingState.IDLE;
  }

  public getTranscriptionState(guildId: string): PipelineState {
    const session = this.activeSessions.get(guildId);
    if (!session || !session.isTranscribing) {
      return PipelineState.IDLE;
    }
    return this.transcriptionPipeline?.getState() || PipelineState.IDLE;
  }

  public getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  public getAllIntegratedSessions(): IntegratedSession[] {
    return Array.from(this.activeSessions.values());
  }

  public getRecordingStats() {
    const sessions = Array.from(this.activeSessions.values());
    const recordingSessions = sessions.filter(s => s.isRecording);
    const transcribingSessions = sessions.filter(s => s.isTranscribing);

    return {
      totalSessions: sessions.length,
      recordingSessions: recordingSessions.length,
      transcribingSessions: transcribingSessions.length,
      averageSessionDuration: sessions.length > 0 
        ? sessions.reduce((sum, s) => sum + (Date.now() - s.startTime.getTime()), 0) / sessions.length 
        : 0,
      transcriptionStats: this.transcriptionPipeline?.getStatistics() || null
    };
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up integrated recording manager');

    try {
      // Stop all active sessions
      const sessionPromises = Array.from(this.activeSessions.keys()).map(guildId =>
        this.stopIntegratedSession(guildId)
      );
      await Promise.all(sessionPromises);

      // Cleanup components
      const recorderCleanupPromises = Array.from(this.recordingManager.values()).map(recorder =>
        recorder.cleanup()
      );
      await Promise.all(recorderCleanupPromises);

      if (this.transcriptionPipeline) {
        await this.transcriptionPipeline.cleanup();
      }

      await this.transcriptManager.cleanup();

      // Clear maps
      this.activeSessions.clear();
      this.recordingManager.clear();

      // Remove all listeners
      this.removeAllListeners();

      logger.info('Integrated recording manager cleanup completed');

    } catch (error) {
      logger.error('Error during integrated recording manager cleanup:', error);
      throw error;
    }
  }
}

export default IntegratedRecordingManager;