import { VoiceConnection } from '@discordjs/voice';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';
import { settingsManager } from '@config/settings';
import MultiTrackRecorder, { RecordingSession, RecordingState } from './multitrack-recorder';
import AudioProcessor, { AudioFormat } from './audio-processor';
import AudioAnalyzer from './audio-analyzer';
import AudioStorage from './audio-storage';
import QualityMonitor from './quality-monitor';
import RecordingAnalytics from './analytics';
import { recordingManager } from './recording-manager';
import { EventEmitter } from 'events';

const logger = createLogger('EnhancedVoiceReceiver');

export interface EnhancedReceiverConfiguration {
  enableMultiTrackRecording: boolean;
  enableAudioProcessing: boolean;
  enableQualityMonitoring: boolean;
  enableAnalytics: boolean;
  autoStartRecording: boolean;
  storageLocation: string;
  outputFormat: AudioFormat;
  processingOptions: {
    normalize: boolean;
    noiseReduction: boolean;
    compressionRatio: number;
  };
}

export interface ReceiverEvents {
  'recording-started': (sessionId: string) => void;
  'recording-stopped': (session: RecordingSession) => void;
  'user-speaking': (userId: string, username: string) => void;
  'user-silent': (userId: string, username: string) => void;
  'quality-alert': (alert: any) => void;
  'audio-segment': (segment: any) => void;
  'error': (error: Error) => void;
}

/**
 * Enhanced Voice Receiver that integrates all advanced audio features
 */
export class EnhancedVoiceReceiver extends EventEmitter {
  private connection: VoiceConnection;
  private configuration: EnhancedReceiverConfiguration;
  
  // Core components
  private multiTrackRecorder: MultiTrackRecorder;
  private audioProcessor: AudioProcessor;
  private audioAnalyzer: AudioAnalyzer;
  private audioStorage: AudioStorage;
  private qualityMonitor: QualityMonitor;
  private recordingAnalytics: RecordingAnalytics;
  // Using singleton recordingManager instead of private instance

  // State
  private isInitialized: boolean = false;
  private currentSession: RecordingSession | null = null;

  constructor(connection: VoiceConnection, configuration?: Partial<EnhancedReceiverConfiguration>) {
    super();
    
    this.connection = connection;
    this.configuration = {
      enableMultiTrackRecording: true,
      enableAudioProcessing: true,
      enableQualityMonitoring: true,
      enableAnalytics: true,
      autoStartRecording: false,
      storageLocation: './recordings',
      outputFormat: {
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        encoding: 'pcm'
      },
      processingOptions: {
        normalize: true,
        noiseReduction: true,
        compressionRatio: 2.0
      },
      ...configuration
    };

    this.initializeComponents();
  }

  private initializeComponents(): void {
    try {
      // Initialize core components
      this.audioProcessor = new AudioProcessor();
      this.audioAnalyzer = new AudioAnalyzer();
      this.audioStorage = new AudioStorage({
        baseDirectory: this.configuration.storageLocation
      });

      // Initialize multi-track recorder
      this.multiTrackRecorder = new MultiTrackRecorder(
        this.connection,
        this.configuration.storageLocation
      );

      // Initialize quality monitor
      this.qualityMonitor = new QualityMonitor(this.audioAnalyzer, {
        enabled: this.configuration.enableQualityMonitoring
      });

      // Initialize analytics
      this.recordingAnalytics = new RecordingAnalytics({
        enabled: this.configuration.enableAnalytics,
        exportDirectory: `${this.configuration.storageLocation}/analytics`
      });

      // Recording manager is singleton - no initialization needed

      this.setupEventHandlers();

      logger.info('Enhanced voice receiver components initialized', {
        multiTrackRecording: this.configuration.enableMultiTrackRecording,
        audioProcessing: this.configuration.enableAudioProcessing,
        qualityMonitoring: this.configuration.enableQualityMonitoring,
        analytics: this.configuration.enableAnalytics
      });

    } catch (error) {
      logger.error('Failed to initialize enhanced voice receiver components:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    // Multi-track recorder events
    this.multiTrackRecorder.on('session-started', (session: RecordingSession) => {
      this.currentSession = session;
      
      if (this.configuration.enableQualityMonitoring) {
        this.qualityMonitor.monitorSession(session);
      }
      
      this.emit('recording-started', session.sessionId);
      
      logger.info('Enhanced recording session started', {
        sessionId: session.sessionId,
        channelName: session.channelName
      });
    });

    this.multiTrackRecorder.on('session-stopped', async (session: RecordingSession) => {
      this.currentSession = null;
      
      if (this.configuration.enableAnalytics) {
        await this.recordingAnalytics.processSession(session);
      }
      
      this.emit('recording-stopped', session);
      
      logger.info('Enhanced recording session stopped', {
        sessionId: session.sessionId,
        duration: session.totalDuration,
        participants: session.participants.size
      });
    });

    this.multiTrackRecorder.on('user-speaking', (session: RecordingSession, userId: string) => {
      const participant = session.participants.get(userId);
      if (participant) {
        this.emit('user-speaking', userId, participant.username);
      }
    });

    this.multiTrackRecorder.on('user-silent', (session: RecordingSession, userId: string) => {
      const participant = session.participants.get(userId);
      if (participant) {
        this.emit('user-silent', userId, participant.username);
      }
    });

    this.multiTrackRecorder.on('audio-segment', async (session: RecordingSession, segment: any) => {
      try {
        // Process audio segment
        if (this.configuration.enableAudioProcessing) {
          segment.audioData = this.audioProcessor.processAudio(
            segment.audioData,
            this.configuration.processingOptions
          );
        }

        // Analyze audio quality
        if (this.configuration.enableQualityMonitoring) {
          this.qualityMonitor.updateUserQuality(segment.userId, segment.audioData);
          
          const quality = this.audioAnalyzer.analyzeAudioQuality(segment.userId, segment.audioData);
          if (this.configuration.enableAnalytics) {
            this.recordingAnalytics.addQualityData(segment.userId, quality);
          }
        }

        // Analyze speaker activity
        const activity = this.audioAnalyzer.analyzeSpeakerActivity(
          segment.userId,
          segment.username,
          segment.audioData,
          segment.startTime
        );

        // Store audio segment
        const metadata = {
          duration: segment.duration,
          sampleRate: segment.sampleRate,
          channels: segment.channels,
          bitDepth: 16,
          format: this.configuration.outputFormat.encoding,
          audioLevel: segment.audioLevel,
          quality: quality?.quality || 'unknown',
          segmentCount: 1,
          originalSize: segment.audioData.length
        };

        await this.audioStorage.storeAudio(
          segment.userId,
          session.sessionId,
          segment.audioData,
          metadata
        );

        this.emit('audio-segment', segment);

        logger.debug('Audio segment processed and stored', {
          sessionId: session.sessionId,
          userId: segment.userId,
          duration: segment.duration,
          quality: quality?.quality
        });

      } catch (error) {
        logger.error('Error processing audio segment:', error);
      }
    });

    // Quality monitor events
    if (this.configuration.enableQualityMonitoring) {
      this.qualityMonitor.on('quality-alert', (alert: any) => {
        if (this.configuration.enableAnalytics) {
          this.recordingAnalytics.addQualityAlert(alert);
        }
        
        this.emit('quality-alert', alert);
        
        logger.warn('Audio quality alert', {
          userId: alert.userId,
          alertType: alert.alertType,
          severity: alert.severity,
          message: alert.message
        });
      });
    }

    // Audio analyzer events
    this.audioAnalyzer.on('speaking-started', (userId: string, activity: any) => {
      logger.debug('Speaking activity detected', {
        userId,
        username: activity.username,
        confidence: activity.confidence
      });
    });

    this.audioAnalyzer.on('speaking-stopped', (userId: string, activity: any) => {
      logger.debug('Speaking activity ended', {
        userId,
        username: activity.username,
        duration: activity.speakingDuration
      });
    });

    // Error handling
    const components = [
      this.multiTrackRecorder,
      this.audioProcessor,
      this.audioAnalyzer,
      this.audioStorage,
      this.qualityMonitor,
      this.recordingAnalytics,
      this.recordingManager
    ];

    components.forEach(component => {
      if (component && typeof component.on === 'function') {
        component.on('error', (error: Error) => {
          logger.error('Component error:', { component: component.constructor.name, error });
          this.emit('error', error);
        });
      }
    });
  }

  /**
   * Initialize the enhanced voice receiver
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Enhanced voice receiver already initialized');
      return;
    }

    try {
      logger.info('Initializing enhanced voice receiver');

      // Auto-start recording if enabled
      if (this.configuration.autoStartRecording) {
        // We need the channel name, which should be available from the connection
        const channelName = 'Voice Channel'; // In real implementation, get from connection
        await this.startRecording(channelName);
      }

      this.isInitialized = true;
      logger.info('Enhanced voice receiver initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize enhanced voice receiver:', error);
      throw error;
    }
  }

  /**
   * Start recording with all enhanced features
   */
  public async startRecording(channelName: string): Promise<string> {
    if (!this.configuration.enableMultiTrackRecording) {
      throw new Error('Multi-track recording is disabled');
    }

    try {
      const sessionId = await this.multiTrackRecorder.startRecording(channelName);
      
      logger.info('Enhanced recording started', {
        sessionId,
        channelName,
        features: {
          multiTrack: this.configuration.enableMultiTrackRecording,
          processing: this.configuration.enableAudioProcessing,
          monitoring: this.configuration.enableQualityMonitoring,
          analytics: this.configuration.enableAnalytics
        }
      });

      return sessionId;

    } catch (error) {
      logger.error('Failed to start enhanced recording:', error);
      throw error;
    }
  }

  /**
   * Stop recording
   */
  public async stopRecording(): Promise<RecordingSession | null> {
    try {
      const session = await this.multiTrackRecorder.stopRecording();
      
      if (session) {
        logger.info('Enhanced recording stopped', {
          sessionId: session.sessionId,
          duration: session.totalDuration,
          participants: session.participants.size,
          segments: session.audioSegments.length
        });
      }

      return session;

    } catch (error) {
      logger.error('Failed to stop enhanced recording:', error);
      throw error;
    }
  }

  /**
   * Pause recording
   */
  public async pauseRecording(): Promise<void> {
    await this.multiTrackRecorder.pauseRecording();
  }

  /**
   * Resume recording
   */
  public async resumeRecording(): Promise<void> {
    await this.multiTrackRecorder.resumeRecording();
  }

  /**
   * Get current recording state
   */
  public getRecordingState(): RecordingState {
    return this.multiTrackRecorder.getRecordingState();
  }

  /**
   * Get current session
   */
  public getCurrentSession(): RecordingSession | null {
    return this.multiTrackRecorder.getCurrentSession();
  }

  /**
   * Get active participants
   */
  public getActiveParticipants(): any[] {
    return this.multiTrackRecorder.getActiveParticipants();
  }

  /**
   * Get audio quality status for all users
   */
  public getQualityStatus(): Map<string, any> {
    return this.qualityMonitor.getQualityStatus();
  }

  /**
   * Get active quality alerts
   */
  public getActiveAlerts(): any[] {
    return this.qualityMonitor.getActiveAlerts();
  }

  /**
   * Get user analytics
   */
  public getUserAnalytics(userId: string): any {
    return this.recordingAnalytics.getUserAnalytics(userId);
  }

  /**
   * Generate analytics report
   */
  public async generateAnalyticsReport(type: 'user' | 'session' | 'guild' | 'summary' = 'summary'): Promise<any> {
    return await this.recordingAnalytics.generateReport(type);
  }

  /**
   * Get recording statistics
   */
  public getRecordingStats(): any {
    return {
      currentSession: this.currentSession,
      recordingState: this.getRecordingState(),
      activeParticipants: this.getActiveParticipants(),
      qualityStatus: this.getQualityStatus(),
      activeAlerts: this.getActiveAlerts(),
      storageStats: {}, // Would get from audioStorage.getStorageStats()
      sessionDuration: this.multiTrackRecorder.getSessionDuration(),
      participantCount: this.multiTrackRecorder.getParticipantCount()
    };
  }

  /**
   * Health check for all components
   */
  public async healthCheck(): Promise<{ healthy: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      // Check if components are properly initialized
      if (!this.isInitialized) {
        issues.push('Enhanced voice receiver not initialized');
      }

      // Check recording state
      const recordingState = this.getRecordingState();
      if (recordingState === RecordingState.ERROR) {
        issues.push('Multi-track recorder in error state');
      }

      // Check quality monitoring
      if (this.configuration.enableQualityMonitoring) {
        const alerts = this.getActiveAlerts();
        const criticalAlerts = alerts.filter(alert => alert.severity === 'critical');
        if (criticalAlerts.length > 0) {
          issues.push(`${criticalAlerts.length} critical audio quality alerts active`);
        }
      }

      // Check storage
      const storageStats = await this.audioStorage.getStorageStats();
      if (storageStats.totalSize > 10 * 1024 * 1024 * 1024) { // 10GB
        issues.push('Storage usage is very high');
      }

      return {
        healthy: issues.length === 0,
        issues
      };

    } catch (error) {
      issues.push(`Health check error: ${error.message}`);
      return { healthy: false, issues };
    }
  }

  /**
   * Update configuration
   */
  public updateConfiguration(newConfig: Partial<EnhancedReceiverConfiguration>): void {
    this.configuration = { ...this.configuration, ...newConfig };
    
    logger.info('Enhanced receiver configuration updated', newConfig);
  }

  /**
   * Cleanup all components
   */
  public async cleanup(): Promise<void> {
    logger.info('Cleaning up enhanced voice receiver');

    try {
      // Stop recording if active
      if (this.getRecordingState() === RecordingState.RECORDING) {
        await this.stopRecording();
      }

      // Cleanup all components
      const cleanupPromises = [
        this.multiTrackRecorder.cleanup(),
        this.audioProcessor.cleanup(),
        this.audioAnalyzer.cleanup(),
        this.audioStorage.cleanup(),
        this.qualityMonitor.cleanup(),
        this.recordingAnalytics.cleanup(),
        recordingManager.cleanup()
      ];

      await Promise.allSettled(cleanupPromises);

      this.isInitialized = false;
      this.currentSession = null;

      logger.info('Enhanced voice receiver cleanup completed');

    } catch (error) {
      logger.error('Error during enhanced voice receiver cleanup:', error);
      throw error;
    }
  }
}

export default EnhancedVoiceReceiver;