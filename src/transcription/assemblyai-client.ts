import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createLogger, withLogging } from '@utils/logger';
import { config } from '@config/environment';

const logger = createLogger('AssemblyAIClient');

export interface TranscriptionConfig {
  apiKey: string;
  sampleRate: number;
  channels: number;
  confidenceThreshold: number;
  languageCode?: string;
  punctuate?: boolean;
  formatText?: boolean;
  dualChannelTranscription?: boolean;
}

export interface TranscriptionResult {
  messageType: 'PartialTranscript' | 'FinalTranscript';
  audioStart: number;
  audioEnd: number;
  confidence: number;
  text: string;
  words?: WordResult[];
  channel?: string;
  created: Date;
}

export interface WordResult {
  start: number;
  end: number;
  confidence: number;
  text: string;
}

export interface StreamingError {
  errorType: string;
  message: string;
  code?: number;
  timestamp: Date;
}

export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

export interface AssemblyAIEvents {
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: StreamingError) => void;
  'transcript': (result: TranscriptionResult) => void;
  'session-begins': (sessionId: string) => void;
  'session-terminated': () => void;
  'state-change': (state: ConnectionState) => void;
}

export class AssemblyAIStreamingClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: TranscriptionConfig;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private sessionId: string | null = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 1000; // Start with 1 second
  private maxReconnectDelay: number = 30000; // Max 30 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private lastPingTime: number = 0;
  private connectionTimeout: number = 30000; // 30 seconds
  private isIntentionallyDisconnected: boolean = false;
  
  // Rate limiting
  private lastSendTime: number = 0;
  private minSendInterval: number = 10; // 10ms minimum between sends
  
  // Statistics
  private stats = {
    totalTranscripts: 0,
    totalWords: 0,
    sessionStartTime: Date.now(),
    bytesSent: 0,
    averageConfidence: 0,
    errorCount: 0
  };

  constructor(config: TranscriptionConfig) {
    super();
    this.config = config;
    
    if (!config.apiKey) {
      throw new Error('AssemblyAI API key is required');
    }
    
    logger.info('AssemblyAI streaming client initialized', {
      sampleRate: config.sampleRate,
      channels: config.channels,
      confidenceThreshold: config.confidenceThreshold
    });
  }

  public async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
      logger.warn('Already connected or connecting to AssemblyAI');
      return;
    }

    try {
      this.setState(ConnectionState.CONNECTING);
      this.isIntentionallyDisconnected = false;
      
      logger.info('Connecting to AssemblyAI streaming service');
      
      const wsUrl = 'wss://streaming.assemblyai.com/v3/ws';
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'User-Agent': 'Discord-Note-Taker/1.0.0'
        },
        timeout: this.connectionTimeout
      });

      this.setupWebSocketHandlers();
      
      // Set connection timeout
      const connectTimeout = setTimeout(() => {
        if (this.state === ConnectionState.CONNECTING) {
          logger.error('Connection timeout to AssemblyAI');
          this.handleConnectionError(new Error('Connection timeout'));
        }
      }, this.connectionTimeout);

      this.ws.once('open', () => {
        clearTimeout(connectTimeout);
      });

    } catch (error) {
      logger.error('Failed to initiate connection to AssemblyAI:', error);
      this.handleConnectionError(error as Error);
      throw error;
    }
  }

  public async disconnect(): Promise<void> {
    logger.info('Disconnecting from AssemblyAI streaming service');
    
    this.isIntentionallyDisconnected = true;
    this.clearReconnectTimer();
    this.clearPingInterval();
    
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          // Send terminate message
          await this.sendMessage({
            message_type: 'Terminate'
          });
          
          // Give some time for graceful close
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        this.ws.close(1000, 'Client disconnect');
      } catch (error) {
        logger.error('Error during disconnect:', error);
      }
      
      this.ws = null;
    }
    
    this.setState(ConnectionState.DISCONNECTED);
    this.sessionId = null;
    
    logger.info('Disconnected from AssemblyAI streaming service');
  }

  public async sendAudio(audioData: Buffer): Promise<void> {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) {
      throw new Error('Not connected to AssemblyAI streaming service');
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastSend = now - this.lastSendTime;
    if (timeSinceLastSend < this.minSendInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minSendInterval - timeSinceLastSend));
    }

    try {
      // Convert Buffer to base64 for JSON transmission
      const audioBase64 = audioData.toString('base64');
      
      await this.sendMessage({
        message_type: 'AudioData',
        audio_data: audioBase64
      });
      
      this.stats.bytesSent += audioData.length;
      this.lastSendTime = Date.now();
      
      if (config.debugMode) {
        logger.debug('Audio data sent to AssemblyAI', {
          sessionId: this.sessionId,
          audioSize: audioData.length,
          totalBytesSent: this.stats.bytesSent
        });
      }
      
    } catch (error) {
      logger.error('Failed to send audio data:', error);
      throw error;
    }
  }

  public getConnectionState(): ConnectionState {
    return this.state;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getStatistics() {
    return {
      ...this.stats,
      sessionDuration: Date.now() - this.stats.sessionStartTime,
      isConnected: this.state === ConnectionState.CONNECTED,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  private setupWebSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', withLogging(() => {
      logger.info('Connected to AssemblyAI streaming service');
      this.setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000; // Reset delay
      
      // Start session
      this.startSession();
      
      // Start ping interval
      this.setupPingInterval();
      
      this.emit('connected');
    }, 'AssemblyAI-WebSocket-Open'));

    this.ws.on('message', withLogging((data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        logger.error('Failed to parse message from AssemblyAI:', error);
      }
    }, 'AssemblyAI-WebSocket-Message'));

    this.ws.on('close', withLogging((code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      logger.info('AssemblyAI WebSocket connection closed', { code, reason: reasonStr });
      
      this.clearPingInterval();
      this.ws = null;
      
      if (!this.isIntentionallyDisconnected) {
        this.setState(ConnectionState.DISCONNECTED);
        this.emit('disconnected');
        
        // Attempt reconnection if not intentionally disconnected
        if (code !== 1000) { // 1000 = normal closure
          this.attemptReconnect();
        }
      }
    }, 'AssemblyAI-WebSocket-Close'));

    this.ws.on('error', withLogging((error: Error) => {
      logger.error('AssemblyAI WebSocket error:', error);
      this.handleConnectionError(error);
    }, 'AssemblyAI-WebSocket-Error'));
  }

  private async startSession(): Promise<void> {
    try {
      await this.sendMessage({
        message_type: 'StartRealTimeTranscription',
        sample_rate: this.config.sampleRate,
        word_boost: [],
        encoding: 'pcm_s16le',
        punctuate: this.config.punctuate ?? true,
        format_text: this.config.formatText ?? true,
        dual_channel: this.config.dualChannelTranscription ?? false,
        language_code: this.config.languageCode || 'en_us'
      });
      
      logger.info('AssemblyAI transcription session started', {
        sampleRate: this.config.sampleRate,
        encoding: 'pcm_s16le',
        language: this.config.languageCode || 'en_us'
      });
      
    } catch (error) {
      logger.error('Failed to start AssemblyAI session:', error);
      throw error;
    }
  }

  private handleMessage(message: any): void {
    try {
      switch (message.message_type) {
        case 'SessionBegins':
          this.sessionId = message.session_id;
          logger.info('AssemblyAI session began', { sessionId: this.sessionId });
          this.emit('session-begins', this.sessionId);
          break;

        case 'PartialTranscript':
          this.handleTranscriptMessage(message, 'PartialTranscript');
          break;

        case 'FinalTranscript':
          this.handleTranscriptMessage(message, 'FinalTranscript');
          break;

        case 'SessionTerminated':
          logger.info('AssemblyAI session terminated');
          this.sessionId = null;
          this.emit('session-terminated');
          break;

        case 'error':
          this.handleErrorMessage(message);
          break;

        default:
          if (config.debugMode) {
            logger.debug('Unknown message type from AssemblyAI:', message);
          }
      }
    } catch (error) {
      logger.error('Error handling AssemblyAI message:', error);
    }
  }

  private handleTranscriptMessage(message: any, messageType: 'PartialTranscript' | 'FinalTranscript'): void {
    try {
      const confidence = message.confidence || 0;
      
      // Filter by confidence threshold
      if (confidence < this.config.confidenceThreshold) {
        return;
      }

      const result: TranscriptionResult = {
        messageType,
        audioStart: message.audio_start || 0,
        audioEnd: message.audio_end || 0,
        confidence,
        text: message.text || '',
        words: message.words?.map((word: any) => ({
          start: word.start,
          end: word.end,
          confidence: word.confidence,
          text: word.text
        })),
        channel: message.channel,
        created: new Date()
      };

      // Update statistics
      this.stats.totalTranscripts++;
      if (result.words) {
        this.stats.totalWords += result.words.length;
      }
      
      // Update average confidence
      const totalConfidence = this.stats.averageConfidence * (this.stats.totalTranscripts - 1) + confidence;
      this.stats.averageConfidence = totalConfidence / this.stats.totalTranscripts;

      if (config.debugMode) {
        logger.debug('Transcript received', {
          sessionId: this.sessionId,
          messageType,
          confidence,
          textLength: result.text.length,
          wordsCount: result.words?.length || 0
        });
      }

      this.emit('transcript', result);

    } catch (error) {
      logger.error('Error processing transcript message:', error);
    }
  }

  private handleErrorMessage(message: any): void {
    const error: StreamingError = {
      errorType: message.error_type || 'unknown',
      message: message.error || 'Unknown error',
      code: message.code,
      timestamp: new Date()
    };

    this.stats.errorCount++;
    logger.error('AssemblyAI streaming error:', error);
    this.emit('error', error);
  }

  private async sendMessage(message: any): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }

    try {
      const messageStr = JSON.stringify(message);
      this.ws.send(messageStr);
      
      if (config.debugMode && message.message_type !== 'AudioData') {
        logger.debug('Message sent to AssemblyAI', { messageType: message.message_type });
      }
    } catch (error) {
      logger.error('Failed to send message to AssemblyAI:', error);
      throw error;
    }
  }

  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      logger.debug('AssemblyAI connection state changed', { from: oldState, to: newState });
      this.emit('state-change', newState);
    }
  }

  private handleConnectionError(error: Error): void {
    this.stats.errorCount++;
    this.setState(ConnectionState.ERROR);
    
    const streamingError: StreamingError = {
      errorType: 'connection',
      message: error.message,
      timestamp: new Date()
    };
    
    this.emit('error', streamingError);
    
    if (!this.isIntentionallyDisconnected) {
      this.attemptReconnect();
    }
  }

  private attemptReconnect(): void {
    if (this.isIntentionallyDisconnected || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached, giving up');
        this.setState(ConnectionState.ERROR);
      }
      return;
    }

    this.reconnectAttempts++;
    this.setState(ConnectionState.RECONNECTING);
    
    logger.info('Attempting to reconnect to AssemblyAI', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delay: this.reconnectDelay
    });

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (error) {
        logger.error('Reconnection attempt failed:', error);
        
        // Exponential backoff
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.attemptReconnect();
      }
    }, this.reconnectDelay);
  }

  private setupPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingTime = Date.now();
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up AssemblyAI streaming client');
    
    try {
      await this.disconnect();
      this.removeAllListeners();
      
      logger.info('AssemblyAI streaming client cleanup completed', {
        finalStats: this.getStatistics()
      });
    } catch (error) {
      logger.error('Error during AssemblyAI client cleanup:', error);
      throw error;
    }
  }
}

export default AssemblyAIStreamingClient;