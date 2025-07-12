import { EventEmitter } from 'events';
import { Transform, pipeline } from 'stream';
import { promisify } from 'util';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';
import AssemblyAIStreamingClient, { 
  TranscriptionConfig, 
  TranscriptionResult, 
  ConnectionState,
  StreamingError 
} from './assemblyai-client';
import { AudioConverter, createDiscordAudioConverter, AudioFormat } from './audio-converter';
import TranscriptManager, { 
  TranscriptSession, 
  TranscriptSegment,
  TranscriptSessionState 
} from './transcript-manager';
import { AudioSegment } from '../voice/multitrack-recorder';

const logger = createLogger('TranscriptionPipeline');
const asyncPipeline = promisify(pipeline);

export interface TranscriptionPipelineConfig {
  assemblyAI: TranscriptionConfig;
  audioFormat: AudioFormat;
  bufferSize: number;
  maxLatencyMs: number;
  confidenceThreshold: number;
  enableRealTimeFiltering: boolean;
  enableQualityMonitoring: boolean;
}

export interface PipelineStatistics {
  totalAudioProcessed: number;
  totalTranscriptionsReceived: number;
  averageLatency: number;
  averageConfidence: number;
  errorRate: number;
  uptime: number;
  throughputBytesPerSecond: number;
  conversionLatency: number;
  assemblyAILatency: number;
}

export interface QualityMetrics {
  audioLossPercentage: number;
  transcriptionAccuracy: number;
  systemLoad: number;
  memoryUsage: number;
  networkLatency: number;
}

export enum PipelineState {
  IDLE = 'idle',
  STARTING = 'starting',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error'
}

export interface TranscriptionPipelineEvents {
  'pipeline-started': () => void;
  'pipeline-stopped': () => void;
  'pipeline-paused': () => void;
  'pipeline-resumed': () => void;
  'pipeline-error': (error: Error) => void;
  'transcript-received': (transcript: TranscriptionResult) => void;
  'audio-processed': (bytesProcessed: number) => void;
  'quality-alert': (metrics: QualityMetrics) => void;
  'state-change': (state: PipelineState) => void;
}

export class TranscriptionPipeline extends EventEmitter {
  private assemblyAIClient: AssemblyAIStreamingClient;
  private audioConverter: AudioConverter;
  private transcriptManager: TranscriptManager;
  private config: TranscriptionPipelineConfig;
  private state: PipelineState = PipelineState.IDLE;
  private activeSessionId: string | null = null;
  private startTime: number = 0;
  
  // Audio processing
  private audioQueue: Buffer[] = [];
  private isProcessingAudio: boolean = false;
  private audioProcessingTimer: NodeJS.Timeout | null = null;
  private maxQueueSize: number = 1000; // Maximum audio chunks in queue
  
  // Statistics
  private stats: PipelineStatistics = {
    totalAudioProcessed: 0,
    totalTranscriptionsReceived: 0,
    averageLatency: 0,
    averageConfidence: 0,
    errorRate: 0,
    uptime: 0,
    throughputBytesPerSecond: 0,
    conversionLatency: 0,
    assemblyAILatency: 0
  };
  
  // Quality monitoring
  private qualityMonitorTimer: NodeJS.Timeout | null = null;
  private qualityMonitorInterval: number = 10000; // 10 seconds
  private lastTranscriptTime: number = Date.now();
  private transcriptLatencies: number[] = [];
  private errorCount: number = 0;
  private totalRequests: number = 0;

  constructor(
    config: TranscriptionPipelineConfig,
    transcriptManager: TranscriptManager,
    storageDir: string = './transcripts'
  ) {
    super();
    
    this.config = config;
    this.transcriptManager = transcriptManager;
    
    // Initialize AssemblyAI client
    this.assemblyAIClient = new AssemblyAIStreamingClient(config.assemblyAI);
    
    // Initialize audio converter
    this.audioConverter = createDiscordAudioConverter();
    
    // Setup event handlers
    this.setupEventHandlers();
    
    logger.info('Transcription pipeline initialized', {
      confidenceThreshold: config.confidenceThreshold,
      maxLatencyMs: config.maxLatencyMs,
      bufferSize: config.bufferSize
    });
  }

  public async start(
    guildId: string,
    channelId: string,
    channelName: string,
    recordingSessionId?: string
  ): Promise<string> {
    if (this.state === PipelineState.RUNNING) {
      throw new Error('Transcription pipeline is already running');
    }

    try {
      this.setState(PipelineState.STARTING);
      this.startTime = Date.now();
      
      logger.info('Starting transcription pipeline');

      // Start transcript session
      this.activeSessionId = await this.transcriptManager.startSession(
        guildId,
        channelId,
        channelName,
        recordingSessionId
      );

      // Connect to AssemblyAI
      await this.assemblyAIClient.connect();

      // Start audio processing
      this.startAudioProcessing();

      // Start quality monitoring if enabled
      if (this.config.enableQualityMonitoring) {
        this.startQualityMonitoring();
      }

      this.setState(PipelineState.RUNNING);
      
      logger.info('Transcription pipeline started', {
        sessionId: this.activeSessionId,
        channelName
      });

      this.emit('pipeline-started');
      return this.activeSessionId;

    } catch (error) {
      logger.error('Failed to start transcription pipeline:', error);
      this.setState(PipelineState.ERROR);
      this.emit('pipeline-error', error as Error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.state === PipelineState.STOPPED || this.state === PipelineState.IDLE) {
      return;
    }

    try {
      this.setState(PipelineState.STOPPING);
      
      logger.info('Stopping transcription pipeline');

      // Stop audio processing
      this.stopAudioProcessing();

      // Stop quality monitoring
      this.stopQualityMonitoring();

      // Disconnect from AssemblyAI
      await this.assemblyAIClient.disconnect();

      // Stop transcript session
      if (this.activeSessionId) {
        await this.transcriptManager.stopSession();
        this.activeSessionId = null;
      }

      this.setState(PipelineState.STOPPED);
      
      // Calculate final uptime
      this.stats.uptime = Date.now() - this.startTime;
      
      logger.info('Transcription pipeline stopped', {
        finalStats: this.getStatistics()
      });

      this.emit('pipeline-stopped');

    } catch (error) {
      logger.error('Error stopping transcription pipeline:', error);
      this.setState(PipelineState.ERROR);
      throw error;
    }
  }

  public async pause(): Promise<void> {
    if (this.state !== PipelineState.RUNNING) {
      throw new Error('Cannot pause pipeline that is not running');
    }

    this.setState(PipelineState.PAUSED);
    this.stopAudioProcessing();
    
    await this.transcriptManager.pauseSession();
    
    logger.info('Transcription pipeline paused');
    this.emit('pipeline-paused');
  }

  public async resume(): Promise<void> {
    if (this.state !== PipelineState.PAUSED) {
      throw new Error('Cannot resume pipeline that is not paused');
    }

    this.setState(PipelineState.RUNNING);
    this.startAudioProcessing();
    
    await this.transcriptManager.resumeSession();
    
    logger.info('Transcription pipeline resumed');
    this.emit('pipeline-resumed');
  }

  public async processAudioSegment(audioSegment: AudioSegment): Promise<void> {
    if (this.state !== PipelineState.RUNNING) {
      return;
    }

    try {
      // Add to audio queue
      this.audioQueue.push(audioSegment.audioData);
      
      // Prevent queue overflow
      if (this.audioQueue.length > this.maxQueueSize) {
        logger.warn('Audio queue overflow, dropping oldest segment');
        this.audioQueue.shift();
      }

      // Update statistics
      this.stats.totalAudioProcessed += audioSegment.audioData.length;
      
      this.emit('audio-processed', audioSegment.audioData.length);

    } catch (error) {
      logger.error('Error processing audio segment:', error);
      this.errorCount++;
    }
  }

  private setupEventHandlers(): void {
    // AssemblyAI client events
    this.assemblyAIClient.on('transcript', withLogging((transcript: TranscriptionResult) => {
      this.handleTranscript(transcript);
    }, 'Pipeline-Transcript'));

    this.assemblyAIClient.on('error', withLogging((error: StreamingError) => {
      this.handleAssemblyAIError(error);
    }, 'Pipeline-AssemblyAI-Error'));

    this.assemblyAIClient.on('state-change', withLogging((state: ConnectionState) => {
      this.handleAssemblyAIStateChange(state);
    }, 'Pipeline-AssemblyAI-StateChange'));

    // Transcript manager events
    this.transcriptManager.on('session-started', withLogging((session: TranscriptSession) => {
      logger.info('Transcript session started in pipeline', { sessionId: session.sessionId });
    }, 'Pipeline-Session-Started'));

    this.transcriptManager.on('segment-completed', withLogging((session: TranscriptSession, segment: TranscriptSegment) => {
      logger.info('Transcript segment completed', {
        sessionId: session.sessionId,
        segmentId: segment.segmentId,
        transcriptCount: segment.transcripts.length
      });
    }, 'Pipeline-Segment-Completed'));

    this.transcriptManager.on('error', withLogging((error: Error) => {
      logger.error('Transcript manager error:', error);
      this.errorCount++;
    }, 'Pipeline-TranscriptManager-Error'));
  }

  private async handleTranscript(transcript: TranscriptionResult): Promise<void> {
    try {
      // Calculate latency
      const latency = Date.now() - transcript.created.getTime();
      this.transcriptLatencies.push(latency);
      
      // Keep only recent latencies for averaging
      if (this.transcriptLatencies.length > 100) {
        this.transcriptLatencies.shift();
      }

      // Update statistics
      this.stats.totalTranscriptionsReceived++;
      this.updateAverageLatency(latency);
      this.updateAverageConfidence(transcript.confidence);
      this.lastTranscriptTime = Date.now();

      // Apply confidence filtering if enabled
      if (this.config.enableRealTimeFiltering && 
          transcript.confidence < this.config.confidenceThreshold) {
        return;
      }

      // Add to transcript manager
      await this.transcriptManager.addTranscript(transcript);

      if (config.debugMode) {
        logger.debug('Transcript processed in pipeline', {
          type: transcript.messageType,
          confidence: transcript.confidence,
          textLength: transcript.text.length,
          latency
        });
      }

      this.emit('transcript-received', transcript);

    } catch (error) {
      logger.error('Error handling transcript:', error);
      this.errorCount++;
    }
  }

  private handleAssemblyAIError(error: StreamingError): void {
    this.errorCount++;
    this.totalRequests++;
    
    logger.error('AssemblyAI streaming error in pipeline:', error);
    
    // Emit pipeline error for critical errors
    if (error.errorType === 'connection' || error.errorType === 'authentication') {
      this.setState(PipelineState.ERROR);
      this.emit('pipeline-error', new Error(`AssemblyAI ${error.errorType} error: ${error.message}`));
    }
  }

  private handleAssemblyAIStateChange(state: ConnectionState): void {
    logger.debug('AssemblyAI connection state changed', { state });
    
    // Handle connection issues
    if (state === ConnectionState.ERROR && this.state === PipelineState.RUNNING) {
      logger.warn('AssemblyAI connection error, pipeline may be affected');
    }
  }

  private startAudioProcessing(): void {
    this.stopAudioProcessing(); // Clear any existing timer
    
    this.audioProcessingTimer = setInterval(async () => {
      await this.processAudioQueue();
    }, 50); // Process every 50ms for low latency
  }

  private stopAudioProcessing(): void {
    if (this.audioProcessingTimer) {
      clearInterval(this.audioProcessingTimer);
      this.audioProcessingTimer = null;
    }
  }

  private async processAudioQueue(): Promise<void> {
    if (this.isProcessingAudio || this.audioQueue.length === 0) {
      return;
    }

    try {
      this.isProcessingAudio = true;
      
      // Process multiple chunks at once for efficiency
      const batchSize = Math.min(5, this.audioQueue.length);
      const audioBatch = this.audioQueue.splice(0, batchSize);
      
      for (const audioChunk of audioBatch) {
        await this.processAudioChunk(audioChunk);
      }
      
    } catch (error) {
      logger.error('Error processing audio queue:', error);
      this.errorCount++;
    } finally {
      this.isProcessingAudio = false;
    }
  }

  private async processAudioChunk(audioData: Buffer): Promise<void> {
    try {
      const conversionStart = Date.now();
      
      // Convert audio format for AssemblyAI
      const convertedAudio = await this.convertAudio(audioData);
      
      const conversionEnd = Date.now();
      this.stats.conversionLatency = conversionEnd - conversionStart;
      
      // Send to AssemblyAI
      if (convertedAudio && this.assemblyAIClient.getConnectionState() === ConnectionState.CONNECTED) {
        const sendStart = Date.now();
        await this.assemblyAIClient.sendAudio(convertedAudio);
        const sendEnd = Date.now();
        this.stats.assemblyAILatency = sendEnd - sendStart;
        this.totalRequests++;
      }
      
    } catch (error) {
      logger.error('Error processing audio chunk:', error);
      this.errorCount++;
    }
  }

  private async convertAudio(audioData: Buffer): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      
      this.audioConverter.write(audioData);
      this.audioConverter.end();
      
      this.audioConverter.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      
      this.audioConverter.on('end', () => {
        const result = chunks.length > 0 ? Buffer.concat(chunks) : null;
        resolve(result);
      });
      
      this.audioConverter.on('error', (error) => {
        logger.error('Audio conversion error:', error);
        reject(error);
      });
    });
  }

  private startQualityMonitoring(): void {
    this.qualityMonitorTimer = setInterval(() => {
      this.monitorQuality();
    }, this.qualityMonitorInterval);
  }

  private stopQualityMonitoring(): void {
    if (this.qualityMonitorTimer) {
      clearInterval(this.qualityMonitorTimer);
      this.qualityMonitorTimer = null;
    }
  }

  private monitorQuality(): void {
    try {
      const now = Date.now();
      const timeSinceLastTranscript = now - this.lastTranscriptTime;
      
      // Calculate quality metrics
      const metrics: QualityMetrics = {
        audioLossPercentage: this.calculateAudioLossPercentage(),
        transcriptionAccuracy: this.stats.averageConfidence,
        systemLoad: this.calculateSystemLoad(),
        memoryUsage: this.calculateMemoryUsage(),
        networkLatency: this.stats.assemblyAILatency
      };

      // Check for quality issues
      let hasQualityIssues = false;
      
      if (metrics.audioLossPercentage > 5) {
        logger.warn('High audio loss detected', { lossPercentage: metrics.audioLossPercentage });
        hasQualityIssues = true;
      }
      
      if (metrics.transcriptionAccuracy < 0.7) {
        logger.warn('Low transcription accuracy detected', { accuracy: metrics.transcriptionAccuracy });
        hasQualityIssues = true;
      }
      
      if (timeSinceLastTranscript > 30000) { // 30 seconds
        logger.warn('No recent transcripts received', { timeSinceLastMs: timeSinceLastTranscript });
        hasQualityIssues = true;
      }

      if (hasQualityIssues) {
        this.emit('quality-alert', metrics);
      }

      if (config.debugMode) {
        logger.debug('Quality monitoring update', metrics);
      }

    } catch (error) {
      logger.error('Error in quality monitoring:', error);
    }
  }

  private calculateAudioLossPercentage(): number {
    // Calculate based on queue overflow events
    const expectedAudio = this.stats.totalAudioProcessed;
    const actualAudio = this.stats.totalAudioProcessed - (this.audioQueue.length * 1920); // Estimate
    return expectedAudio > 0 ? ((expectedAudio - actualAudio) / expectedAudio) * 100 : 0;
  }

  private calculateSystemLoad(): number {
    // Simple CPU usage estimate based on processing times
    const processingTime = this.stats.conversionLatency + this.stats.assemblyAILatency;
    return Math.min(processingTime / 50, 100); // Normalize to percentage
  }

  private calculateMemoryUsage(): number {
    const memUsage = process.memoryUsage();
    return memUsage.heapUsed / 1024 / 1024; // MB
  }

  private updateAverageLatency(latency: number): void {
    const count = this.stats.totalTranscriptionsReceived;
    this.stats.averageLatency = ((this.stats.averageLatency * (count - 1)) + latency) / count;
  }

  private updateAverageConfidence(confidence: number): void {
    const count = this.stats.totalTranscriptionsReceived;
    this.stats.averageConfidence = ((this.stats.averageConfidence * (count - 1)) + confidence) / count;
  }

  private setState(newState: PipelineState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      logger.debug('Pipeline state changed', { from: oldState, to: newState });
      this.emit('state-change', newState);
    }
  }

  // Public accessors
  public getState(): PipelineState {
    return this.state;
  }

  public getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  public getStatistics(): PipelineStatistics {
    const uptime = this.state === PipelineState.RUNNING ? Date.now() - this.startTime : this.stats.uptime;
    const errorRate = this.totalRequests > 0 ? (this.errorCount / this.totalRequests) * 100 : 0;
    const throughput = uptime > 0 ? (this.stats.totalAudioProcessed / uptime) * 1000 : 0;

    return {
      ...this.stats,
      uptime,
      errorRate,
      throughputBytesPerSecond: throughput
    };
  }

  public getQueueStatus(): { queueSize: number; maxQueueSize: number; isProcessing: boolean } {
    return {
      queueSize: this.audioQueue.length,
      maxQueueSize: this.maxQueueSize,
      isProcessing: this.isProcessingAudio
    };
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up transcription pipeline');

    try {
      await this.stop();
      
      // Cleanup components
      await this.assemblyAIClient.cleanup();
      await this.transcriptManager.cleanup();
      
      // Clear audio queue
      this.audioQueue = [];
      
      // Remove all listeners
      this.removeAllListeners();

      logger.info('Transcription pipeline cleanup completed');

    } catch (error) {
      logger.error('Error during pipeline cleanup:', error);
      throw error;
    }
  }
}

export default TranscriptionPipeline;