import {
  VoiceConnection,
  VoiceReceiver as DiscordVoiceReceiver,
  AudioReceiveStream,
  EndBehaviorType
} from '@discordjs/voice';
import { User } from 'discord.js';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import { settingsManager } from '@config/settings';
import { Transform, PassThrough } from 'stream';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const logger = createLogger('MultiTrackRecorder');

export enum RecordingState {
  IDLE = 'idle',
  STARTING = 'starting',
  RECORDING = 'recording',
  PAUSED = 'paused',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

export interface UserTrack {
  userId: string;
  username: string;
  displayName: string;
  stream: AudioReceiveStream | null;
  audioBuffer: Buffer[];
  startTime: Date;
  lastActivity: Date;
  totalSamples: number;
  audioLevel: number;
  isSpeaking: boolean;
  silenceCount: number;
  speakingDuration: number;
}

export interface RecordingSession {
  sessionId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  startTime: Date;
  endTime?: Date;
  state: RecordingState;
  participants: Map<string, UserTrack>;
  totalDuration: number;
  audioSegments: AudioSegment[];
  metadata: SessionMetadata;
}

export interface SessionMetadata {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  packetDuration: number;
  maxParticipants: number;
  averageParticipants: number;
  totalSpeechTime: number;
  totalSilenceTime: number;
  audioQuality: 'low' | 'medium' | 'high';
}

export interface AudioSegment {
  segmentId: string;
  userId: string;
  username: string;
  audioData: Buffer;
  startTime: Date;
  endTime: Date;
  duration: number;
  sampleRate: number;
  channels: number;
  audioLevel: number;
  isSilent: boolean;
}

export interface RecordingEvents {
  'session-started': (session: RecordingSession) => void;
  'session-stopped': (session: RecordingSession) => void;
  'session-paused': (session: RecordingSession) => void;
  'session-resumed': (session: RecordingSession) => void;
  'user-joined': (session: RecordingSession, userTrack: UserTrack) => void;
  'user-left': (session: RecordingSession, userId: string) => void;
  'user-speaking': (session: RecordingSession, userId: string) => void;
  'user-silent': (session: RecordingSession, userId: string) => void;
  'audio-segment': (session: RecordingSession, segment: AudioSegment) => void;
  'error': (error: Error) => void;
}

export class MultiTrackRecorder extends EventEmitter {
  private connection: VoiceConnection;
  private receiver: DiscordVoiceReceiver;
  private currentSession: RecordingSession | null = null;
  private readonly storageDir: string;
  private readonly maxSessionDuration: number = 8 * 60 * 60 * 1000; // 8 hours
  private readonly packetDuration: number = 20; // 20ms Discord packets
  private readonly sampleRate: number = 48000; // Discord's sample rate
  private readonly channels: number = 2;
  private readonly samplesPerPacket: number;
  
  // Audio processing constants
  private readonly silenceThreshold: number = -50; // dB
  private readonly silenceTimeoutMs: number = 2000; // 2 seconds
  private readonly minSpeechDurationMs: number = 250; // 250ms minimum speech
  
  // Memory management
  private readonly maxBufferSize: number = 1024 * 1024 * 50; // 50MB per user
  private readonly bufferCleanupInterval: number = 30000; // 30 seconds
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(connection: VoiceConnection, storageDir: string = './recordings') {
    super();
    this.connection = connection;
    this.receiver = connection.receiver;
    this.storageDir = storageDir;
    this.samplesPerPacket = (this.sampleRate * this.packetDuration) / 1000;
    
    this.setupCleanupTimer();
  }

  public async startRecording(channelName: string): Promise<string> {
    if (this.currentSession && this.currentSession.state === RecordingState.RECORDING) {
      throw new Error('Recording session already active');
    }

    try {
      logger.info('Starting multi-track recording session');

      // Create session ID and directory
      const sessionId = this.generateSessionId();
      const sessionDir = path.join(this.storageDir, sessionId);
      await fs.promises.mkdir(sessionDir, { recursive: true });

      // Initialize recording session
      this.currentSession = {
        sessionId,
        guildId: this.connection.guildId || '',
        channelId: this.connection.channelId || '',
        channelName,
        startTime: new Date(),
        state: RecordingState.STARTING,
        participants: new Map(),
        totalDuration: 0,
        audioSegments: [],
        metadata: {
          sampleRate: this.sampleRate,
          channels: this.channels,
          bitDepth: 16,
          packetDuration: this.packetDuration,
          maxParticipants: 0,
          averageParticipants: 0,
          totalSpeechTime: 0,
          totalSilenceTime: 0,
          audioQuality: 'high'
        }
      };

      // Set up speaking event handlers
      this.setupSpeakingEventHandlers();

      // Update session state
      this.currentSession.state = RecordingState.RECORDING;

      logger.info('Multi-track recording session started', {
        sessionId,
        channelName,
        sampleRate: this.sampleRate,
        channels: this.channels
      });

      this.emit('session-started', this.currentSession);
      return sessionId;

    } catch (error) {
      logger.error('Failed to start recording session:', error);
      if (this.currentSession) {
        this.currentSession.state = RecordingState.ERROR;
      }
      throw error;
    }
  }

  public async stopRecording(): Promise<RecordingSession | null> {
    if (!this.currentSession || this.currentSession.state !== RecordingState.RECORDING) {
      logger.warn('No active recording session to stop');
      return null;
    }

    try {
      logger.info('Stopping multi-track recording session', {
        sessionId: this.currentSession.sessionId
      });

      this.currentSession.state = RecordingState.STOPPING;

      // Stop all active user streams
      for (const [userId, userTrack] of this.currentSession.participants) {
        await this.stopUserTrack(userId);
      }

      // Finalize session
      this.currentSession.endTime = new Date();
      this.currentSession.totalDuration = 
        this.currentSession.endTime.getTime() - this.currentSession.startTime.getTime();
      this.currentSession.state = RecordingState.STOPPED;

      // Calculate final metadata
      this.calculateSessionMetadata();

      // Save session metadata
      await this.saveSessionMetadata();

      logger.info('Multi-track recording session stopped', {
        sessionId: this.currentSession.sessionId,
        duration: this.currentSession.totalDuration,
        participants: this.currentSession.participants.size,
        segments: this.currentSession.audioSegments.length
      });

      const stoppedSession = this.currentSession;
      this.emit('session-stopped', stoppedSession);
      
      this.currentSession = null;
      return stoppedSession;

    } catch (error) {
      logger.error('Error stopping recording session:', error);
      if (this.currentSession) {
        this.currentSession.state = RecordingState.ERROR;
      }
      throw error;
    }
  }

  public async pauseRecording(): Promise<void> {
    if (!this.currentSession || this.currentSession.state !== RecordingState.RECORDING) {
      throw new Error('No active recording session to pause');
    }

    this.currentSession.state = RecordingState.PAUSED;
    
    // Pause all active streams (don't destroy them)
    for (const [userId, userTrack] of this.currentSession.participants) {
      if (userTrack.stream) {
        userTrack.stream.pause();
      }
    }

    logger.info('Recording session paused', {
      sessionId: this.currentSession.sessionId
    });

    this.emit('session-paused', this.currentSession);
  }

  public async resumeRecording(): Promise<void> {
    if (!this.currentSession || this.currentSession.state !== RecordingState.PAUSED) {
      throw new Error('No paused recording session to resume');
    }

    this.currentSession.state = RecordingState.RECORDING;
    
    // Resume all active streams
    for (const [userId, userTrack] of this.currentSession.participants) {
      if (userTrack.stream) {
        userTrack.stream.resume();
      }
    }

    logger.info('Recording session resumed', {
      sessionId: this.currentSession.sessionId
    });

    this.emit('session-resumed', this.currentSession);
  }

  private setupSpeakingEventHandlers(): void {
    // Listen for users starting to speak
    this.receiver.speaking.on('start', withLogging(async (userId: string) => {
      await this.handleUserStartSpeaking(userId);
    }, 'UserStartSpeaking'));

    // Listen for users stopping speaking
    this.receiver.speaking.on('end', withLogging(async (userId: string) => {
      await this.handleUserStopSpeaking(userId);
    }, 'UserStopSpeaking'));
  }

  private async handleUserStartSpeaking(userId: string): Promise<void> {
    if (!this.currentSession || this.currentSession.state !== RecordingState.RECORDING) {
      return;
    }

    try {
      // Get user information
      const user = await this.getUserInfo(userId);
      if (!user || user.bot) {
        return;
      }

      logger.debug('User started speaking in recording session', {
        sessionId: this.currentSession.sessionId,
        userId,
        username: user.username
      });

      // Get or create user track
      let userTrack = this.currentSession.participants.get(userId);
      if (!userTrack) {
        userTrack = await this.createUserTrack(userId, user);
        this.currentSession.participants.set(userId, userTrack);
        this.emit('user-joined', this.currentSession, userTrack);
      }

      // Create new audio stream for this speaking session
      const audioStream = this.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: settingsManager.getTranscriptionSettings().endUtteranceSilenceTimeout
        }
      });

      userTrack.stream = audioStream;
      userTrack.isSpeaking = true;
      userTrack.lastActivity = new Date();
      userTrack.silenceCount = 0;

      // Set up stream handlers
      this.setupUserStreamHandlers(userTrack, audioStream);

      this.emit('user-speaking', this.currentSession, userId);

    } catch (error) {
      logger.error('Error handling user start speaking:', error);
    }
  }

  private async handleUserStopSpeaking(userId: string): Promise<void> {
    if (!this.currentSession || this.currentSession.state !== RecordingState.RECORDING) {
      return;
    }

    const userTrack = this.currentSession.participants.get(userId);
    if (!userTrack) {
      return;
    }

    logger.debug('User stopped speaking in recording session', {
      sessionId: this.currentSession.sessionId,
      userId,
      username: userTrack.username
    });

    userTrack.isSpeaking = false;
    userTrack.lastActivity = new Date();

    // Process any buffered audio data
    if (userTrack.audioBuffer.length > 0) {
      await this.processUserAudioBuffer(userTrack);
    }

    this.emit('user-silent', this.currentSession, userId);
  }

  private async createUserTrack(userId: string, user: User): Promise<UserTrack> {
    const userTrack: UserTrack = {
      userId,
      username: user.username,
      displayName: user.displayName || user.username,
      stream: null,
      audioBuffer: [],
      startTime: new Date(),
      lastActivity: new Date(),
      totalSamples: 0,
      audioLevel: 0,
      isSpeaking: false,
      silenceCount: 0,
      speakingDuration: 0
    };

    logger.debug('Created user track', {
      sessionId: this.currentSession?.sessionId,
      userId,
      username: user.username,
      displayName: userTrack.displayName
    });

    return userTrack;
  }

  private setupUserStreamHandlers(userTrack: UserTrack, stream: AudioReceiveStream): void {
    const { userId, username } = userTrack;

    // Handle audio data chunks (20ms packets from Discord)
    stream.on('data', (chunk: Buffer) => {
      if (!this.currentSession || this.currentSession.state !== RecordingState.RECORDING) {
        return;
      }

      // Add chunk to user's buffer
      userTrack.audioBuffer.push(chunk);
      userTrack.totalSamples += chunk.length / 2; // 16-bit samples
      userTrack.lastActivity = new Date();

      // Calculate audio level for this chunk
      const audioLevel = this.calculateAudioLevel(chunk);
      userTrack.audioLevel = audioLevel;

      // Check if buffer is getting too large
      const bufferSize = userTrack.audioBuffer.reduce((total, buf) => total + buf.length, 0);
      if (bufferSize > this.maxBufferSize) {
        logger.warn('User audio buffer getting too large, processing early', {
          userId,
          username,
          bufferSize
        });
        
        // Process buffer to prevent memory issues
        this.processUserAudioBuffer(userTrack).catch(error => {
          logger.error('Error processing large audio buffer:', error);
        });
      }

      if (config.debugMode) {
        logger.debug('Audio chunk received', {
          sessionId: this.currentSession.sessionId,
          userId,
          username,
          chunkSize: chunk.length,
          totalChunks: userTrack.audioBuffer.length,
          audioLevel: audioLevel.toFixed(2)
        });
      }
    });

    // Handle stream end
    stream.on('end', withLogging(async () => {
      logger.debug('User audio stream ended', {
        sessionId: this.currentSession?.sessionId,
        userId,
        username,
        totalChunks: userTrack.audioBuffer.length
      });

      // Process final buffer
      if (userTrack.audioBuffer.length > 0) {
        await this.processUserAudioBuffer(userTrack);
      }

      userTrack.stream = null;
    }, 'UserAudioStreamEnd'));

    // Handle stream errors
    stream.on('error', withLogging((error: Error) => {
      logger.error('User audio stream error:', {
        sessionId: this.currentSession?.sessionId,
        userId,
        username,
        error
      });
      
      userTrack.stream = null;
    }, 'UserAudioStreamError'));
  }

  private async processUserAudioBuffer(userTrack: UserTrack): Promise<void> {
    if (!this.currentSession || userTrack.audioBuffer.length === 0) {
      return;
    }

    try {
      // Combine all audio chunks
      const audioData = Buffer.concat(userTrack.audioBuffer);
      const duration = (audioData.length / 2 / this.sampleRate) * 1000; // Duration in ms

      // Skip if too short
      if (duration < this.minSpeechDurationMs) {
        logger.debug('Skipping short audio segment', {
          userId: userTrack.userId,
          duration
        });
        userTrack.audioBuffer = [];
        return;
      }

      // Check if mostly silence
      const avgAudioLevel = this.calculateAudioLevel(audioData);
      const isSilent = avgAudioLevel < this.silenceThreshold;

      // Create audio segment
      const segment: AudioSegment = {
        segmentId: this.generateSegmentId(),
        userId: userTrack.userId,
        username: userTrack.username,
        audioData,
        startTime: new Date(Date.now() - duration),
        endTime: new Date(),
        duration,
        sampleRate: this.sampleRate,
        channels: this.channels,
        audioLevel: avgAudioLevel,
        isSilent
      };

      // Add to session segments
      this.currentSession.audioSegments.push(segment);

      // Update user track stats
      userTrack.speakingDuration += duration;

      logger.debug('Processed audio segment', {
        sessionId: this.currentSession.sessionId,
        userId: userTrack.userId,
        segmentId: segment.segmentId,
        duration,
        audioLevel: avgAudioLevel.toFixed(2),
        isSilent,
        dataSize: audioData.length
      });

      // Emit segment event
      this.emit('audio-segment', this.currentSession, segment);

      // Save segment to file if in debug mode
      if (config.debugMode) {
        await this.saveAudioSegment(segment);
      }

      // Clear processed buffer
      userTrack.audioBuffer = [];

    } catch (error) {
      logger.error('Error processing user audio buffer:', error);
      // Clear buffer to prevent stuck state
      userTrack.audioBuffer = [];
    }
  }

  private calculateAudioLevel(audioData: Buffer): number {
    if (audioData.length === 0) return -Infinity;

    let sum = 0;
    let maxSample = 0;

    // Process 16-bit samples
    for (let i = 0; i < audioData.length; i += 2) {
      const sample = audioData.readInt16LE(i);
      const absSample = Math.abs(sample);
      sum += absSample * absSample;
      maxSample = Math.max(maxSample, absSample);
    }

    const numSamples = audioData.length / 2;
    const rms = Math.sqrt(sum / numSamples);
    
    // Convert to dB (reference: max 16-bit value)
    const dB = 20 * Math.log10(rms / 32767);
    
    return isFinite(dB) ? dB : -Infinity;
  }

  private async stopUserTrack(userId: string): Promise<void> {
    if (!this.currentSession) return;

    const userTrack = this.currentSession.participants.get(userId);
    if (!userTrack) return;

    try {
      // Stop the audio stream
      if (userTrack.stream) {
        userTrack.stream.destroy();
        userTrack.stream = null;
      }

      // Process any remaining audio buffer
      if (userTrack.audioBuffer.length > 0) {
        await this.processUserAudioBuffer(userTrack);
      }

      logger.debug('Stopped user track', {
        sessionId: this.currentSession.sessionId,
        userId,
        username: userTrack.username,
        speakingDuration: userTrack.speakingDuration,
        totalSamples: userTrack.totalSamples
      });

    } catch (error) {
      logger.error('Error stopping user track:', error);
    }
  }

  private async saveAudioSegment(segment: AudioSegment): Promise<void> {
    if (!this.currentSession) return;

    try {
      const sessionDir = path.join(this.storageDir, this.currentSession.sessionId);
      const filename = `${segment.userId}_${segment.segmentId}.pcm`;
      const filepath = path.join(sessionDir, filename);

      await fs.promises.writeFile(filepath, segment.audioData);

      logger.debug('Audio segment saved', {
        segmentId: segment.segmentId,
        userId: segment.userId,
        filepath,
        size: segment.audioData.length
      });

    } catch (error) {
      logger.error('Failed to save audio segment:', error);
    }
  }

  private calculateSessionMetadata(): void {
    if (!this.currentSession) return;

    const session = this.currentSession;
    const participants = Array.from(session.participants.values());

    // Calculate participant stats
    session.metadata.maxParticipants = Math.max(
      session.metadata.maxParticipants,
      participants.length
    );
    
    session.metadata.averageParticipants = participants.length;

    // Calculate speech/silence times
    session.metadata.totalSpeechTime = participants.reduce(
      (total, track) => total + track.speakingDuration, 0
    );
    
    session.metadata.totalSilenceTime = 
      session.totalDuration - session.metadata.totalSpeechTime;

    // Determine audio quality based on sample rate and segments
    if (session.metadata.sampleRate >= 48000 && session.audioSegments.length > 0) {
      session.metadata.audioQuality = 'high';
    } else if (session.metadata.sampleRate >= 24000) {
      session.metadata.audioQuality = 'medium';
    } else {
      session.metadata.audioQuality = 'low';
    }

    logger.debug('Session metadata calculated', {
      sessionId: session.sessionId,
      metadata: session.metadata
    });
  }

  private async saveSessionMetadata(): Promise<void> {
    if (!this.currentSession) return;

    try {
      const sessionDir = path.join(this.storageDir, this.currentSession.sessionId);
      const metadataPath = path.join(sessionDir, 'session.json');

      const metadata = {
        session: {
          sessionId: this.currentSession.sessionId,
          guildId: this.currentSession.guildId,
          channelId: this.currentSession.channelId,
          channelName: this.currentSession.channelName,
          startTime: this.currentSession.startTime.toISOString(),
          endTime: this.currentSession.endTime?.toISOString(),
          totalDuration: this.currentSession.totalDuration,
          state: this.currentSession.state
        },
        participants: Array.from(this.currentSession.participants.entries()).map(([userId, track]) => ({
          userId,
          username: track.username,
          displayName: track.displayName,
          speakingDuration: track.speakingDuration,
          totalSamples: track.totalSamples,
          startTime: track.startTime.toISOString(),
          lastActivity: track.lastActivity.toISOString()
        })),
        segments: this.currentSession.audioSegments.map(segment => ({
          segmentId: segment.segmentId,
          userId: segment.userId,
          username: segment.username,
          startTime: segment.startTime.toISOString(),
          endTime: segment.endTime.toISOString(),
          duration: segment.duration,
          audioLevel: segment.audioLevel,
          isSilent: segment.isSilent,
          dataSize: segment.audioData.length
        })),
        metadata: this.currentSession.metadata
      };

      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

      logger.info('Session metadata saved', {
        sessionId: this.currentSession.sessionId,
        metadataPath
      });

    } catch (error) {
      logger.error('Failed to save session metadata:', error);
    }
  }

  private async getUserInfo(userId: string): Promise<User | null> {
    try {
      const client = this.connection.joinConfig.group;
      // Access the Discord client through the voice connection
      const voiceConnection = this.connection;
      const adapter = voiceConnection.joinConfig.adapterCreator;
      
      // Get client from adapter (this is a bit of a hack but necessary)
      const clientFromAdapter = (adapter as any).client;
      if (!clientFromAdapter) {
        logger.warn('Could not access Discord client from voice connection');
        return null;
      }

      let user = clientFromAdapter.users.cache.get(userId);
      if (!user) {
        user = await clientFromAdapter.users.fetch(userId);
      }

      return user;
    } catch (error) {
      logger.error('Failed to get user info:', { userId, error });
      return null;
    }
  }

  private generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).substring(2, 8);
    return `session_${timestamp}_${random}`;
  }

  private generateSegmentId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `seg_${timestamp}_${random}`;
  }

  private setupCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performMemoryCleanup();
    }, this.bufferCleanupInterval);
  }

  private performMemoryCleanup(): void {
    if (!this.currentSession) return;

    const now = Date.now();
    let cleaned = 0;

    // Clean up old audio segments (keep only last hour)
    const cutoffTime = now - 3600000; // 1 hour
    const initialSegmentCount = this.currentSession.audioSegments.length;
    
    this.currentSession.audioSegments = this.currentSession.audioSegments.filter(
      segment => segment.endTime.getTime() > cutoffTime
    );

    cleaned += initialSegmentCount - this.currentSession.audioSegments.length;

    // Clean up inactive user tracks
    for (const [userId, userTrack] of this.currentSession.participants) {
      const timeSinceActivity = now - userTrack.lastActivity.getTime();
      
      // Remove users inactive for more than 10 minutes
      if (timeSinceActivity > 600000) {
        this.stopUserTrack(userId).then(() => {
          this.currentSession?.participants.delete(userId);
          logger.debug('Cleaned up inactive user track', { userId, username: userTrack.username });
        });
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Memory cleanup completed', {
        sessionId: this.currentSession.sessionId,
        itemsCleaned: cleaned
      });
    }
  }

  // Public accessors
  public getCurrentSession(): RecordingSession | null {
    return this.currentSession;
  }

  public getRecordingState(): RecordingState {
    return this.currentSession?.state || RecordingState.IDLE;
  }

  public getParticipantCount(): number {
    return this.currentSession?.participants.size || 0;
  }

  public getActiveParticipants(): UserTrack[] {
    if (!this.currentSession) return [];
    return Array.from(this.currentSession.participants.values()).filter(
      track => track.isSpeaking
    );
  }

  public getSessionDuration(): number {
    if (!this.currentSession) return 0;
    const endTime = this.currentSession.endTime || new Date();
    return endTime.getTime() - this.currentSession.startTime.getTime();
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up multi-track recorder');

    try {
      // Stop current recording if active
      if (this.currentSession && this.currentSession.state === RecordingState.RECORDING) {
        await this.stopRecording();
      }

      // Clear cleanup timer
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      this.currentSession = null;

      logger.info('Multi-track recorder cleanup completed');

    } catch (error) {
      logger.error('Error during multi-track recorder cleanup:', error);
      throw error;
    }
  }
}

export default MultiTrackRecorder;