import { EventEmitter } from 'events';
import { VoiceConnection } from '@discordjs/voice';
import { createLogger } from '@utils/logger';
import MultiTrackRecorder, { RecordingSession, RecordingState, UserTrack, AudioSegment } from './multitrack-recorder';
import AudioProcessor, { AudioFormat, ProcessingOptions } from './audio-processor';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('RecordingManager');

export interface RecordingConfiguration {
  maxSessionDuration: number; // milliseconds
  autoStopOnEmpty: boolean; // Stop recording when no users are speaking
  emptyTimeout: number; // How long to wait before auto-stopping
  enableAudioProcessing: boolean;
  processingOptions: Partial<ProcessingOptions>;
  outputFormat: AudioFormat;
  storageLocation: string;
  compressionEnabled: boolean;
  maxStorageSize: number; // bytes
}

export interface RecordingStats {
  totalSessions: number;
  activeSessions: number;
  totalDuration: number;
  totalParticipants: number;
  averageSessionDuration: number;
  totalStorageUsed: number;
  topUsers: Array<{ userId: string; username: string; totalTime: number }>;
}

export interface SessionRecoveryData {
  sessionId: string;
  guildId: string;
  channelId: string;
  startTime: Date;
  state: RecordingState;
  participants: Array<{
    userId: string;
    username: string;
    startTime: Date;
    totalDuration: number;
  }>;
}

export class RecordingManager extends EventEmitter {
  private recorders: Map<string, MultiTrackRecorder> = new Map(); // guildId -> recorder
  private processors: Map<string, AudioProcessor> = new Map(); // guildId -> processor
  private configuration: RecordingConfiguration;
  private sessionHistory: RecordingSession[] = [];
  private recoveryData: Map<string, SessionRecoveryData> = new Map();
  
  // Monitoring and cleanup
  private monitoringInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly monitoringIntervalMs = 30000; // 30 seconds
  private readonly cleanupIntervalMs = 300000; // 5 minutes

  constructor(configuration?: Partial<RecordingConfiguration>) {
    super();
    
    this.configuration = {
      maxSessionDuration: 8 * 60 * 60 * 1000, // 8 hours
      autoStopOnEmpty: true,
      emptyTimeout: 5 * 60 * 1000, // 5 minutes
      enableAudioProcessing: true,
      processingOptions: {
        normalize: true,
        silenceThreshold: -50,
        noiseReduction: true,
        compressionRatio: 2.0
      },
      outputFormat: {
        sampleRate: 16000,
        channels: 1,
        bitDepth: 16,
        encoding: 'pcm'
      },
      storageLocation: './recordings',
      compressionEnabled: false,
      maxStorageSize: 10 * 1024 * 1024 * 1024, // 10GB
      ...configuration
    };

    this.initializeManager();
  }

  private async initializeManager(): Promise<void> {
    try {
      // Ensure storage directory exists
      await fs.promises.mkdir(this.configuration.storageLocation, { recursive: true });

      // Load recovery data if available
      await this.loadRecoveryData();

      // Start monitoring
      this.startMonitoring();

      logger.info('Recording manager initialized', {
        storageLocation: this.configuration.storageLocation,
        maxSessionDuration: this.configuration.maxSessionDuration,
        autoStopOnEmpty: this.configuration.autoStopOnEmpty
      });

    } catch (error) {
      logger.error('Failed to initialize recording manager:', error);
      throw error;
    }
  }

  /**
   * Start a new recording session for a voice connection
   */
  public async startRecording(
    guildId: string,
    connection: VoiceConnection,
    channelName: string,
    options?: Partial<RecordingConfiguration>
  ): Promise<string> {
    try {
      // Check if already recording in this guild
      if (this.recorders.has(guildId)) {
        const existing = this.recorders.get(guildId)!;
        const currentSession = existing.getCurrentSession();
        
        if (currentSession && currentSession.state === RecordingState.RECORDING) {
          throw new Error(`Recording already active in guild ${guildId}`);
        }
      }

      logger.info('Starting recording session', {
        guildId,
        channelName,
        options
      });

      // Instead of creating a new MultiTrackRecorder, create a simple recording session
      // The actual audio capture is handled by the existing VoiceReceiver
      const sessionId = `session_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).substr(2, 6)}`;
      
      // Create a simple recording session object that tracks state
      const session = {
        sessionId,
        guildId,
        channelId: connection.joinConfig.channelId || 'unknown',
        channelName,
        startTime: new Date(),
        endTime: undefined as Date | undefined,
        state: 'recording' as any,
        participants: new Map(),
        totalDuration: 0,
        audioSegments: [] as AudioSegment[],
        metadata: {
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
          packetDuration: 20,
          maxParticipants: 0,
          averageParticipants: 0,
          totalSpeechTime: 0,
          totalSilenceTime: 0,
          audioQuality: 'medium' as any
        }
      };
      
      // Store the session without using MultiTrackRecorder
      // We'll create a simple Map to track sessions directly
      const mockRecorder = { 
        getCurrentSession: () => session, 
        getRecordingState: () => session.state,
        stopRecording: async () => {
          session.state = 'stopped' as any;
          const endTime = new Date();
          session.endTime = endTime;
          session.totalDuration = endTime.getTime() - session.startTime.getTime();
          return session;
        },
        pauseRecording: async () => {
          session.state = 'paused' as any;
        },
        resumeRecording: async () => {
          session.state = 'recording' as any;
        },
        cleanup: async () => {
          // Cleanup handled by voice receiver
        },
        getActiveParticipants: () => {
          return Array.from(session.participants.values());
        },
        session: session
      } as any;
      this.recorders.set(guildId, mockRecorder);

      // Create audio processor
      const processor = new AudioProcessor();
      this.processors.set(guildId, processor);

      // Save recovery data (simplified since we're not using MultiTrackRecorder)
      // await this.saveRecoveryData(guildId, mockRecorder);

      logger.info('Recording session started successfully', {
        guildId,
        sessionId,
        channelName
      });

      return sessionId;

    } catch (error) {
      logger.error('Failed to start recording:', error);
      
      // Cleanup on failure
      this.recorders.delete(guildId);
      this.processors.delete(guildId);
      
      throw error;
    }
  }

  /**
   * Stop recording session for a guild
   */
  public async stopRecording(guildId: string): Promise<RecordingSession | null> {
    const recorder = this.recorders.get(guildId);
    if (!recorder) {
      logger.warn('No active recording found for guild', { guildId });
      return null;
    }

    try {
      logger.info('Stopping recording session', { guildId });

      const session = await recorder.stopRecording();
      
      if (session) {
        // Process final audio if enabled
        if (this.configuration.enableAudioProcessing) {
          await this.processSessionAudio(guildId, session);
        }

        // Add to session history
        this.sessionHistory.push(session);

        // Limit session history size
        if (this.sessionHistory.length > 100) {
          this.sessionHistory = this.sessionHistory.slice(-50);
        }

        logger.info('Recording session stopped successfully', {
          guildId,
          sessionId: session.sessionId,
          duration: session.totalDuration,
          participants: session.participants.size
        });

        // Trigger transcription and summarization pipeline
        await this.processRecordingWithAI(session);
      }

      // Cleanup
      await this.cleanupRecording(guildId);

      return session;

    } catch (error) {
      logger.error('Error stopping recording:', error);
      throw error;
    }
  }

  /**
   * Pause recording session
   */
  public async pauseRecording(guildId: string): Promise<void> {
    const recorder = this.recorders.get(guildId);
    if (!recorder) {
      throw new Error(`No active recording found for guild ${guildId}`);
    }

    await recorder.pauseRecording();
    await this.saveRecoveryData(guildId, recorder);

    logger.info('Recording session paused', { guildId });
  }

  /**
   * Resume recording session
   */
  public async resumeRecording(guildId: string): Promise<void> {
    const recorder = this.recorders.get(guildId);
    if (!recorder) {
      throw new Error(`No active recording found for guild ${guildId}`);
    }

    await recorder.resumeRecording();
    await this.saveRecoveryData(guildId, recorder);

    logger.info('Recording session resumed', { guildId });
  }

  /**
   * Get current recording session for a guild
   */
  public getRecordingSession(guildId: string): RecordingSession | null {
    const recorder = this.recorders.get(guildId);
    return recorder?.getCurrentSession() || null;
  }

  /**
   * Get recording state for a guild
   */
  public getRecordingState(guildId: string): RecordingState {
    const recorder = this.recorders.get(guildId);
    return recorder?.getRecordingState() || RecordingState.IDLE;
  }

  /**
   * Get all active recording sessions
   */
  public getActiveSessions(): RecordingSession[] {
    const sessions: RecordingSession[] = [];
    
    for (const recorder of this.recorders.values()) {
      const session = recorder.getCurrentSession();
      if (session && session.state === RecordingState.RECORDING) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  /**
   * Get recording statistics
   */
  public async getRecordingStats(): Promise<RecordingStats> {
    const activeSessions = this.getActiveSessions();
    const allSessions = [...this.sessionHistory, ...activeSessions];

    const totalDuration = allSessions.reduce((sum, session) => {
      const duration = session.endTime 
        ? session.endTime.getTime() - session.startTime.getTime()
        : Date.now() - session.startTime.getTime();
      return sum + duration;
    }, 0);

    const totalParticipants = allSessions.reduce((sum, session) => 
      sum + session.participants.size, 0);

    // Calculate top users
    const userStats = new Map<string, { username: string; totalTime: number }>();
    
    for (const session of allSessions) {
      for (const [userId, track] of session.participants) {
        const existing = userStats.get(userId) || { username: track.username, totalTime: 0 };
        existing.totalTime += track.speakingDuration;
        userStats.set(userId, existing);
      }
    }

    const topUsers = Array.from(userStats.entries())
      .map(([userId, stats]) => ({ userId, ...stats }))
      .sort((a, b) => b.totalTime - a.totalTime)
      .slice(0, 10);

    return {
      totalSessions: allSessions.length,
      activeSessions: activeSessions.length,
      totalDuration,
      totalParticipants,
      averageSessionDuration: allSessions.length > 0 ? totalDuration / allSessions.length : 0,
      totalStorageUsed: await this.calculateStorageUsage(),
      topUsers
    };
  }


  private setupRecorderEventHandlers(guildId: string, recorder: MultiTrackRecorder): void {
    recorder.on('session-started', (session: RecordingSession) => {
      this.emit('session-started', guildId, session);
    });

    recorder.on('session-stopped', (session: RecordingSession) => {
      this.emit('session-stopped', guildId, session);
    });

    recorder.on('session-paused', (session: RecordingSession) => {
      this.emit('session-paused', guildId, session);
    });

    recorder.on('session-resumed', (session: RecordingSession) => {
      this.emit('session-resumed', guildId, session);
    });

    recorder.on('user-joined', (session: RecordingSession, userTrack: UserTrack) => {
      this.emit('user-joined', guildId, session, userTrack);
    });

    recorder.on('user-left', (session: RecordingSession, userId: string) => {
      this.emit('user-left', guildId, session, userId);
    });

    recorder.on('audio-segment', async (session: RecordingSession, segment: AudioSegment) => {
      // Process audio segment if processing is enabled
      if (this.configuration.enableAudioProcessing) {
        await this.processAudioSegment(guildId, segment);
      }
      
      this.emit('audio-segment', guildId, session, segment);
    });

    recorder.on('error', (error: Error) => {
      logger.error('Recorder error:', { guildId, error });
      this.emit('error', guildId, error);
    });
  }

  private async processSessionAudio(guildId: string, session: RecordingSession): Promise<void> {
    const processor = this.processors.get(guildId);
    if (!processor) return;

    try {
      logger.info('Processing session audio', {
        guildId,
        sessionId: session.sessionId,
        segments: session.audioSegments.length
      });

      for (const segment of session.audioSegments) {
        await this.processAudioSegment(guildId, segment);
      }

      logger.info('Session audio processing completed', {
        guildId,
        sessionId: session.sessionId
      });

    } catch (error) {
      logger.error('Error processing session audio:', error);
    }
  }

  private async processAudioSegment(guildId: string, segment: AudioSegment): Promise<void> {
    const processor = this.processors.get(guildId);
    if (!processor) return;

    try {
      // Apply audio processing
      const processedAudio = processor.processAudio(
        segment.audioData,
        this.configuration.processingOptions
      );

      // Convert to target format (e.g., for AssemblyAI)
      const convertedAudio = await processor.convertFormat(
        processedAudio,
        this.configuration.outputFormat
      );

      // Update segment with processed data
      segment.audioData = convertedAudio;

      logger.debug('Audio segment processed', {
        guildId,
        segmentId: segment.segmentId,
        originalSize: segment.audioData.length,
        processedSize: convertedAudio.length
      });

    } catch (error) {
      logger.error('Error processing audio segment:', error);
    }
  }

  private async cleanupRecording(guildId: string): Promise<void> {
    try {
      // Cleanup recorder
      const recorder = this.recorders.get(guildId);
      if (recorder) {
        await recorder.cleanup();
        this.recorders.delete(guildId);
      }

      // Cleanup processor
      const processor = this.processors.get(guildId);
      if (processor) {
        await processor.cleanup();
        this.processors.delete(guildId);
      }

      // Remove recovery data
      this.recoveryData.delete(guildId);
      await this.saveRecoveryDataToDisk();

      logger.debug('Recording cleanup completed', { guildId });

    } catch (error) {
      logger.error('Error during recording cleanup:', error);
    }
  }

  private startMonitoring(): void {
    this.monitoringInterval = setInterval(() => {
      this.performMonitoring();
    }, this.monitoringIntervalMs);

    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, this.cleanupIntervalMs);

    logger.debug('Recording monitoring started');
  }

  private async performMonitoring(): Promise<void> {
    try {
      const now = Date.now();

      for (const [guildId, recorder] of this.recorders) {
        const session = recorder.getCurrentSession();
        if (!session) continue;

        // Check for max session duration
        const sessionDuration = now - session.startTime.getTime();
        if (sessionDuration > this.configuration.maxSessionDuration) {
          logger.warn('Session exceeded max duration, stopping', {
            guildId,
            sessionId: session.sessionId,
            duration: sessionDuration,
            maxDuration: this.configuration.maxSessionDuration
          });
          
          await this.stopRecording(guildId);
          continue;
        }

        // Check for auto-stop on empty
        if (this.configuration.autoStopOnEmpty) {
          const activeParticipants = recorder.getActiveParticipants();
          if (activeParticipants.length === 0) {
            // Check if empty for too long
            const emptyDuration = now - Math.max(
              ...Array.from(session.participants.values()).map(p => p.lastActivity.getTime())
            );
            
            if (emptyDuration > this.configuration.emptyTimeout) {
              logger.info('Auto-stopping empty session', {
                guildId,
                sessionId: session.sessionId,
                emptyDuration
              });
              
              await this.stopRecording(guildId);
            }
          }
        }

        // Update recovery data
        await this.saveRecoveryData(guildId, recorder);
      }

    } catch (error) {
      logger.error('Error during monitoring:', error);
    }
  }

  private async performCleanup(): Promise<void> {
    try {
      // Check storage usage
      const storageUsage = await this.calculateStorageUsage();
      if (storageUsage > this.configuration.maxStorageSize) {
        await this.cleanupOldRecordings();
      }

      // Clean up old session history
      const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
      this.sessionHistory = this.sessionHistory.filter(
        session => session.startTime.getTime() > cutoffTime
      );

    } catch (error) {
      logger.error('Error during cleanup:', error);
    }
  }

  private async calculateStorageUsage(): Promise<number> {
    try {
      const storageDir = this.configuration.storageLocation;
      let totalSize = 0;

      const calculateDirSize = async (dir: string): Promise<number> => {
        let size = 0;
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            size += await calculateDirSize(fullPath);
          } else {
            const stats = await fs.promises.stat(fullPath);
            size += stats.size;
          }
        }
        
        return size;
      };

      totalSize = await calculateDirSize(storageDir);
      return totalSize;

    } catch (error) {
      logger.error('Error calculating storage usage:', error);
      return 0;
    }
  }

  private async cleanupOldRecordings(): Promise<void> {
    try {
      logger.info('Starting cleanup of old recordings');

      const storageDir = this.configuration.storageLocation;
      const entries = await fs.promises.readdir(storageDir, { withFileTypes: true });
      
      // Get directories with their creation times
      const sessionDirs: Array<{ name: string; time: number }> = [];
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const fullPath = path.join(storageDir, entry.name);
          const stats = await fs.promises.stat(fullPath);
          sessionDirs.push({ name: entry.name, time: stats.birthtime.getTime() });
        }
      }

      // Sort by age (oldest first)
      sessionDirs.sort((a, b) => a.time - b.time);

      // Remove oldest 25% of recordings
      const toRemove = Math.floor(sessionDirs.length * 0.25);
      for (let i = 0; i < toRemove; i++) {
        const sessionDir = sessionDirs[i];
        if (sessionDir) {
          const dirPath = path.join(storageDir, sessionDir.name);
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          logger.debug('Removed old recording directory', { path: dirPath });
        }
      }

      logger.info('Old recordings cleanup completed', { removed: toRemove });

    } catch (error) {
      logger.error('Error cleaning up old recordings:', error);
    }
  }

  private async saveRecoveryData(guildId: string, recorder: MultiTrackRecorder): Promise<void> {
    const session = recorder.getCurrentSession();
    if (!session) return;

    const recoveryData: SessionRecoveryData = {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelId: session.channelId,
      startTime: session.startTime,
      state: session.state,
      participants: Array.from(session.participants.values()).map(track => ({
        userId: track.userId,
        username: track.username,
        startTime: track.startTime,
        totalDuration: track.speakingDuration
      }))
    };

    this.recoveryData.set(guildId, recoveryData);
    await this.saveRecoveryDataToDisk();
  }

  private async loadRecoveryData(): Promise<void> {
    try {
      const recoveryPath = path.join(this.configuration.storageLocation, 'recovery.json');
      
      if (await fs.promises.access(recoveryPath).then(() => true).catch(() => false)) {
        const data = await fs.promises.readFile(recoveryPath, 'utf8');
        const recoveryMap = JSON.parse(data);
        
        for (const [guildId, data] of Object.entries(recoveryMap)) {
          this.recoveryData.set(guildId, data as SessionRecoveryData);
        }

        logger.info('Recovery data loaded', { sessions: this.recoveryData.size });
      }

    } catch (error) {
      logger.warn('Could not load recovery data:', error);
    }
  }

  private async saveRecoveryDataToDisk(): Promise<void> {
    try {
      const recoveryPath = path.join(this.configuration.storageLocation, 'recovery.json');
      const recoveryMap = Object.fromEntries(this.recoveryData);
      
      await fs.promises.writeFile(recoveryPath, JSON.stringify(recoveryMap, null, 2));

    } catch (error) {
      logger.error('Failed to save recovery data:', error);
    }
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up recording manager');

    try {
      // Stop monitoring
      if (this.monitoringInterval) {
        clearInterval(this.monitoringInterval);
        this.monitoringInterval = null;
      }

      if (this.cleanupInterval) {
        clearInterval(this.cleanupInterval);
        this.cleanupInterval = null;
      }

      // Stop all active recordings
      const stopPromises = Array.from(this.recorders.keys()).map(guildId =>
        this.stopRecording(guildId)
      );
      
      await Promise.allSettled(stopPromises);

      // Final cleanup
      this.recorders.clear();
      this.processors.clear();
      this.recoveryData.clear();

      logger.info('Recording manager cleanup completed');

    } catch (error) {
      logger.error('Error during recording manager cleanup:', error);
      throw error;
    }
  }

  /**
   * Process recording session with AI (transcription and summarization)
   */
  private async processRecordingWithAI(session: any): Promise<void> {
    try {
      logger.info('Starting AI processing for recording session', {
        sessionId: session.sessionId,
        guildId: session.guildId
      });

      // Get the session directory where audio files are stored
      const sessionDir = path.join(this.configuration.storageLocation, session.sessionId);
      
      // Check if session directory exists
      if (!await fs.promises.access(sessionDir).then(() => true).catch(() => false)) {
        logger.warn('Session directory not found, skipping AI processing', {
          sessionId: session.sessionId,
          sessionDir
        });
        return;
      }

      // Get list of user directories
      const entries = await fs.promises.readdir(sessionDir, { withFileTypes: true });
      const userDirs = entries.filter(entry => entry.isDirectory());

      if (userDirs.length === 0) {
        logger.warn('No user audio directories found, skipping AI processing', {
          sessionId: session.sessionId
        });
        return;
      }

      logger.info('Processing audio files for transcription', {
        sessionId: session.sessionId,
        userCount: userDirs.length
      });

      // Process each user's audio files
      const transcriptionResults = [];
      for (const userDir of userDirs) {
        try {
          const userDirPath = path.join(sessionDir, userDir.name);
          const audioFiles = await fs.promises.readdir(userDirPath);
          const pcmFiles = audioFiles.filter(file => file.endsWith('.pcm'));

          if (pcmFiles.length === 0) {
            logger.debug('No audio files found for user', {
              sessionId: session.sessionId,
              userDir: userDir.name
            });
            continue;
          }

          // Parse username from directory name (format: userId-username)
          const [userId, ...usernameParts] = userDir.name.split('-');
          const username = usernameParts.join('-');

          logger.info('Processing transcription for user', {
            sessionId: session.sessionId,
            userId,
            username,
            audioFileCount: pcmFiles.length
          });

          // Combine all audio files for this user
          const combinedAudioPath = path.join(userDirPath, 'combined-audio.pcm');
          await this.combineAudioFiles(userDirPath, pcmFiles, combinedAudioPath);

          // Convert PCM to WAV for better compatibility
          const wavPath = path.join(userDirPath, 'combined-audio.wav');
          await this.convertPcmToWav(combinedAudioPath, wavPath);

          // Trigger transcription
          const transcriptResult = await this.transcribeAudioFile(wavPath, userId, username);
          if (transcriptResult) {
            transcriptionResults.push(transcriptResult);
          }

        } catch (error) {
          logger.error('Error processing user audio for transcription', {
            sessionId: session.sessionId,
            userDir: userDir.name,
            error
          });
        }
      }

      // Save transcription results
      if (transcriptionResults.length > 0) {
        await this.saveTranscriptionResults(session, transcriptionResults);
        
        // Trigger summarization if enabled
        await this.generateSessionSummary(session, transcriptionResults);
      }

      logger.info('AI processing completed for recording session', {
        sessionId: session.sessionId,
        transcriptionsGenerated: transcriptionResults.length
      });

    } catch (error) {
      logger.error('Error in AI processing pipeline:', {
        sessionId: session.sessionId,
        error
      });
    }
  }

  private async combineAudioFiles(userDirPath: string, audioFiles: string[], outputPath: string): Promise<void> {
    try {
      // Sort audio files by timestamp to maintain chronological order
      const sortedFiles = audioFiles.sort();
      
      // Read and combine all audio files
      const audioBuffers = [];
      for (const file of sortedFiles) {
        const filePath = path.join(userDirPath, file);
        const audioData = await fs.promises.readFile(filePath);
        audioBuffers.push(audioData);
      }

      // Combine all buffers
      const combinedBuffer = Buffer.concat(audioBuffers);
      await fs.promises.writeFile(outputPath, combinedBuffer);

      logger.debug('Combined audio files', {
        fileCount: audioFiles.length,
        totalSize: combinedBuffer.length,
        outputPath
      });

    } catch (error) {
      logger.error('Error combining audio files:', error);
      throw error;
    }
  }

  private async convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
    try {
      // Simple PCM to WAV conversion
      // WAV header for 16kHz, 16-bit, mono PCM
      const pcmData = await fs.promises.readFile(pcmPath);
      const wavHeader = this.createWavHeader(pcmData.length, 16000, 1, 16);
      const wavData = Buffer.concat([wavHeader, pcmData]);
      
      await fs.promises.writeFile(wavPath, wavData);
      
      logger.debug('Converted PCM to WAV', {
        pcmSize: pcmData.length,
        wavSize: wavData.length,
        wavPath
      });

    } catch (error) {
      logger.error('Error converting PCM to WAV:', error);
      throw error;
    }
  }

  private createWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44);
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);

    return header;
  }

  private async transcribeAudioFile(audioPath: string, userId: string, username: string): Promise<any> {
    try {
      // This would integrate with your transcription service (AssemblyAI, OpenAI Whisper, etc.)
      // For now, return a placeholder that would be replaced with actual transcription
      
      logger.info('Transcribing audio file', {
        audioPath,
        userId,
        username
      });

      // Placeholder for actual transcription service integration
      const transcriptResult = {
        userId,
        username,
        audioPath,
        transcript: 'Transcription would be generated here using AssemblyAI or OpenAI Whisper API',
        confidence: 0.95,
        duration: 0,
        timestamp: new Date().toISOString()
      };

      return transcriptResult;

    } catch (error) {
      logger.error('Error transcribing audio file:', {
        audioPath,
        userId,
        username,
        error
      });
      return null;
    }
  }

  private async saveTranscriptionResults(session: any, transcriptions: any[]): Promise<void> {
    try {
      const sessionDir = path.join(this.configuration.storageLocation, session.sessionId);
      const transcriptPath = path.join(sessionDir, 'transcriptions.json');
      
      const transcriptData = {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelName: session.channelName,
        startTime: session.startTime,
        endTime: session.endTime,
        transcriptions,
        generatedAt: new Date().toISOString()
      };

      await fs.promises.writeFile(transcriptPath, JSON.stringify(transcriptData, null, 2));
      
      logger.info('Transcription results saved', {
        sessionId: session.sessionId,
        transcriptPath,
        transcriptionCount: transcriptions.length
      });

    } catch (error) {
      logger.error('Error saving transcription results:', error);
    }
  }

  private async generateSessionSummary(session: any, transcriptions: any[]): Promise<void> {
    try {
      logger.info('Generating session summary', {
        sessionId: session.sessionId,
        transcriptionCount: transcriptions.length
      });

      const sessionDir = path.join(this.configuration.storageLocation, session.sessionId);
      const summaryPath = path.join(sessionDir, 'summary.json');

      // Combine all transcriptions into conversation flow
      const conversationText = transcriptions
        .map(t => `${t.username}: ${t.transcript}`)
        .join('\n\n');

      // Placeholder for actual AI summarization
      const summary = {
        sessionId: session.sessionId,
        summary: 'AI-generated summary would be created here using OpenAI GPT or similar',
        keyPoints: [
          'Key discussion topics would be extracted',
          'Important decisions would be highlighted',
          'Action items would be identified'
        ],
        participants: transcriptions.map(t => ({
          userId: t.userId,
          username: t.username,
          speakingTime: 'Calculated speaking duration'
        })),
        conversationText,
        generatedAt: new Date().toISOString()
      };

      await fs.promises.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      
      logger.info('Session summary generated', {
        sessionId: session.sessionId,
        summaryPath
      });

    } catch (error) {
      logger.error('Error generating session summary:', error);
    }
  }
}

// Create singleton instance
export const recordingManager = new RecordingManager();

export default RecordingManager;