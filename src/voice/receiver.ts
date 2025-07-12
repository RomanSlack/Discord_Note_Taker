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
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import * as fs from 'fs';

const pipelineAsync = promisify(pipeline);
const logger = createLogger('VoiceReceiver');

export interface AudioStream {
  userId: string;
  username: string;
  stream: AudioReceiveStream;
  startTime: Date;
  endTime?: Date;
  chunks: Buffer[];
  totalDuration: number;
}

export interface AudioSegment {
  userId: string;
  username: string;
  audioData: Buffer;
  startTime: Date;
  endTime: Date;
  duration: number;
  sampleRate: number;
  channels: number;
}

export class VoiceReceiver {
  private connection: VoiceConnection;
  private receiver: DiscordVoiceReceiver;
  private activeStreams: Map<string, AudioStream> = new Map();
  private isInitialized: boolean = false;
  private readonly segmentWindow: number = config.segmentWindowSec * 1000; // Convert to ms
  private segmentTimer: NodeJS.Timeout | null = null;
  private audioSegments: AudioSegment[] = [];

  constructor(connection: VoiceConnection) {
    this.connection = connection;
    this.receiver = connection.receiver;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn('Voice receiver already initialized');
      return;
    }

    try {
      logger.info('Initializing voice receiver');

      // Set up user speaking event handlers
      this.setupSpeakingEventHandlers();

      // Start segment processing timer
      this.startSegmentTimer();

      this.isInitialized = true;
      logger.info('Voice receiver initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize voice receiver:', error);
      throw error;
    }
  }

  private setupSpeakingEventHandlers(): void {
    // Listen for users starting to speak
    this.receiver.speaking.on('start', withLogging((userId: string) => {
      this.handleUserStartSpeaking(userId);
    }, 'UserStartSpeaking'));

    // Listen for users stopping speaking
    this.receiver.speaking.on('end', withLogging((userId: string) => {
      this.handleUserStopSpeaking(userId);
    }, 'UserStopSpeaking'));
  }

  private async handleUserStartSpeaking(userId: string): Promise<void> {
    try {
      // Get user information
      const user = await this.getUserInfo(userId);
      if (!user) {
        logger.warn('Could not get user info for speaking user', { userId });
        return;
      }

      // Skip if bot user
      if (user.bot) {
        return;
      }

      logger.debug('User started speaking', {
        userId,
        username: user.username
      });

      // Create audio receive stream
      const audioStream = this.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: settingsManager.getTranscriptionSettings().endUtteranceSilenceTimeout
        }
      });

      // Create audio stream info
      const streamInfo: AudioStream = {
        userId,
        username: user.username,
        stream: audioStream,
        startTime: new Date(),
        chunks: [],
        totalDuration: 0
      };

      // Set up stream event handlers
      this.setupAudioStreamHandlers(streamInfo);

      // Store active stream
      this.activeStreams.set(userId, streamInfo);

    } catch (error) {
      logger.error('Error handling user start speaking:', error);
    }
  }

  private async handleUserStopSpeaking(userId: string): Promise<void> {
    const streamInfo = this.activeStreams.get(userId);
    if (!streamInfo) {
      return;
    }

    logger.debug('User stopped speaking', {
      userId,
      username: streamInfo.username,
      duration: Date.now() - streamInfo.startTime.getTime()
    });

    // Mark end time
    streamInfo.endTime = new Date();
    streamInfo.totalDuration = streamInfo.endTime.getTime() - streamInfo.startTime.getTime();

    // Process the completed audio stream
    await this.processCompletedStream(streamInfo);

    // Remove from active streams
    this.activeStreams.delete(userId);
  }

  private setupAudioStreamHandlers(streamInfo: AudioStream): void {
    const { stream, userId, username } = streamInfo;

    // Handle audio data chunks
    stream.on('data', (chunk: Buffer) => {
      streamInfo.chunks.push(chunk);
      
      // Log chunk received (debug level to avoid spam)
      if (config.debugMode) {
        logger.debug('Audio chunk received', {
          userId,
          username,
          chunkSize: chunk.length,
          totalChunks: streamInfo.chunks.length
        });
      }
    });

    // Handle stream end
    stream.on('end', withLogging(() => {
      logger.debug('Audio stream ended', {
        userId,
        username,
        totalChunks: streamInfo.chunks.length,
        duration: streamInfo.totalDuration
      });
    }, 'AudioStreamEnd'));

    // Handle stream errors
    stream.on('error', withLogging((error: Error) => {
      logger.error('Audio stream error:', {
        userId,
        username,
        error
      });
      
      // Clean up on error
      this.activeStreams.delete(userId);
    }, 'AudioStreamError'));

    // Handle stream close
    stream.on('close', withLogging(() => {
      logger.debug('Audio stream closed', {
        userId,
        username
      });
    }, 'AudioStreamClose'));
  }

  private async processCompletedStream(streamInfo: AudioStream): Promise<void> {
    try {
      const { userId, username, chunks, startTime, endTime, totalDuration } = streamInfo;

      // Skip if no audio data or too short
      if (chunks.length === 0) {
        logger.debug('Skipping empty audio stream', { userId, username });
        return;
      }

      const minDuration = settingsManager.getTranscriptionSettings().minSpeechDuration;
      if (totalDuration < minDuration) {
        logger.debug('Skipping short audio stream', {
          userId,
          username,
          duration: totalDuration,
          minDuration
        });
        return;
      }

      // Combine audio chunks
      const audioData = Buffer.concat(chunks);

      logger.info('Processing completed audio stream', {
        userId,
        username,
        duration: totalDuration,
        dataSize: audioData.length,
        chunks: chunks.length
      });

      // Create audio segment
      const audioSegment: AudioSegment = {
        userId,
        username,
        audioData,
        startTime,
        endTime: endTime!,
        duration: totalDuration,
        sampleRate: settingsManager.getVoiceSettings().sampleRate,
        channels: settingsManager.getVoiceSettings().channels
      };

      // Store segment for processing
      this.audioSegments.push(audioSegment);

      // Optional: Save audio to file for debugging
      if (config.debugMode) {
        await this.saveAudioSegmentToFile(audioSegment);
      }

      // Emit event for transcription processing
      this.emitAudioSegmentEvent(audioSegment);

    } catch (error) {
      logger.error('Error processing completed stream:', error);
    }
  }

  private async saveAudioSegmentToFile(segment: AudioSegment): Promise<void> {
    try {
      const timestamp = segment.startTime.toISOString().replace(/[:.]/g, '-');
      const filename = `audio_${segment.userId}_${timestamp}.pcm`;
      const filepath = `./logs/audio/${filename}`;

      // Ensure directory exists
      await fs.promises.mkdir('./logs/audio', { recursive: true });

      // Write audio data
      await fs.promises.writeFile(filepath, segment.audioData);

      logger.debug('Audio segment saved to file', {
        userId: segment.userId,
        username: segment.username,
        filepath,
        size: segment.audioData.length
      });

    } catch (error) {
      logger.error('Failed to save audio segment to file:', error);
    }
  }

  private emitAudioSegmentEvent(segment: AudioSegment): void {
    // This will be the interface for the transcription service
    // For now, we'll just log the event
    logger.info('Audio segment ready for transcription', {
      userId: segment.userId,
      username: segment.username,
      duration: segment.duration,
      dataSize: segment.audioData.length,
      startTime: segment.startTime.toISOString(),
      endTime: segment.endTime.toISOString()
    });

    // Emit audio segment to transcription service
    this.emit('audio-segment', segment);
  }

  private startSegmentTimer(): void {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
    }

    this.segmentTimer = setInterval(() => {
      this.processSegmentWindow();
    }, this.segmentWindow);

    logger.debug('Segment timer started', {
      intervalMs: this.segmentWindow
    });
  }

  private processSegmentWindow(): void {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.segmentWindow);

    // Get segments within the current window
    const windowSegments = this.audioSegments.filter(segment =>
      segment.startTime >= windowStart && segment.startTime <= now
    );

    if (windowSegments.length > 0) {
      logger.info('Processing segment window', {
        segmentCount: windowSegments.length,
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString()
      });

      // Process segments for transcription
      this.emit('segment-window-complete', { 
        segments: recentSegments,
        windowStart,
        windowEnd: now 
      });
    }

    // Clean up old segments (keep last hour)
    const cutoffTime = new Date(now.getTime() - 3600000); // 1 hour ago
    const initialCount = this.audioSegments.length;
    this.audioSegments = this.audioSegments.filter(segment => 
      segment.startTime >= cutoffTime
    );

    if (this.audioSegments.length < initialCount) {
      logger.debug('Cleaned up old audio segments', {
        removed: initialCount - this.audioSegments.length,
        remaining: this.audioSegments.length
      });
    }
  }

  private async getUserInfo(userId: string): Promise<User | null> {
    try {
      // Try to get user from cache first
      const client = this.connection.receiver.voiceConnection.manager.client;
      let user = client.users.cache.get(userId);

      if (!user) {
        // Fetch user if not in cache
        user = await client.users.fetch(userId);
      }

      return user;
    } catch (error) {
      logger.error('Failed to get user info:', { userId, error });
      return null;
    }
  }

  // Public methods for external access
  public getActiveStreams(): AudioStream[] {
    return Array.from(this.activeStreams.values());
  }

  public getActiveStreamCount(): number {
    return this.activeStreams.size;
  }

  public getSegmentCount(): number {
    return this.audioSegments.length;
  }

  public isUserSpeaking(userId: string): boolean {
    return this.activeStreams.has(userId);
  }

  public getRecentSegments(minutes: number = 5): AudioSegment[] {
    const cutoffTime = new Date(Date.now() - minutes * 60000);
    return this.audioSegments.filter(segment => 
      segment.startTime >= cutoffTime
    );
  }

  // Health check
  public getHealthStatus(): { healthy: boolean; activeStreams: number; totalSegments: number } {
    return {
      healthy: this.isInitialized,
      activeStreams: this.activeStreams.size,
      totalSegments: this.audioSegments.length
    };
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up voice receiver');

    try {
      // Stop segment timer
      if (this.segmentTimer) {
        clearInterval(this.segmentTimer);
        this.segmentTimer = null;
      }

      // End all active streams
      for (const [userId, streamInfo] of this.activeStreams) {
        try {
          streamInfo.stream.destroy();
        } catch (error) {
          logger.warn('Error destroying audio stream during cleanup:', { userId, error });
        }
      }

      // Clear collections
      this.activeStreams.clear();
      this.audioSegments.length = 0;

      this.isInitialized = false;
      logger.info('Voice receiver cleanup completed');

    } catch (error) {
      logger.error('Error during voice receiver cleanup:', error);
      throw error;
    }
  }
}

export default VoiceReceiver;