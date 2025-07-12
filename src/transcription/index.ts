// Main exports for the transcription module
export { default as AssemblyAIStreamingClient } from './assemblyai-client';
export type { 
  TranscriptionConfig, 
  TranscriptionResult, 
  WordResult,
  StreamingError,
  ConnectionState,
  AssemblyAIEvents 
} from './assemblyai-client';

export { default as AudioConverter } from './audio-converter';
export type { 
  AudioFormat, 
  ConversionOptions 
} from './audio-converter';
export { 
  createAssemblyAIConverter, 
  createDiscordAudioConverter 
} from './audio-converter';

export { default as TranscriptManager } from './transcript-manager';
export type { 
  TranscriptSegment,
  SegmentMetadata,
  TranscriptSession,
  SessionMetadata,
  QualityMetrics,
  CostMetrics,
  CompressionStats,
  TranscriptSessionState,
  TranscriptManagerEvents 
} from './transcript-manager';

export { default as TranscriptionPipeline } from './transcription-pipeline';
export type { 
  TranscriptionPipelineConfig,
  PipelineStatistics,
  QualityMetrics as PipelineQualityMetrics,
  PipelineState,
  TranscriptionPipelineEvents 
} from './transcription-pipeline';

export { default as IntegratedRecordingManager } from './integrated-recording-manager';
export type { 
  IntegratedRecordingOptions,
  IntegratedSession,
  IntegratedRecordingManagerEvents 
} from './integrated-recording-manager';

export { default as transcribeCommand } from './transcription-commands';

// Convenience re-exports from voice module
export { 
  RecordingState,
  AudioSegment,
  RecordingSession 
} from '../voice/multitrack-recorder';

// Version information
export const TRANSCRIPTION_MODULE_VERSION = '1.0.0';

// Feature flags
export const FEATURES = {
  REAL_TIME_TRANSCRIPTION: true,
  AUDIO_CONVERSION: true,
  COMPRESSION: true,
  COST_TRACKING: true,
  QUALITY_MONITORING: true,
  WEBSOCKET_RECONNECTION: true,
  SEGMENT_WINDOWS: true,
  MULTIPLE_LANGUAGES: true
} as const;

// Configuration defaults
export const DEFAULT_CONFIG = {
  TRANSCRIPTION: {
    CONFIDENCE_THRESHOLD: 0.7,
    SAMPLE_RATE: 16000,
    CHANNELS: 1,
    LANGUAGE: 'en_us',
    PUNCTUATE: true,
    FORMAT_TEXT: true
  },
  PIPELINE: {
    BUFFER_SIZE: 3200,
    MAX_LATENCY_MS: 500,
    ENABLE_REAL_TIME_FILTERING: true,
    ENABLE_QUALITY_MONITORING: true
  },
  SEGMENTS: {
    DURATION_MS: 5 * 60 * 1000, // 5 minutes
    COMPRESSION_LEVEL: 4,
    MAX_SESSION_DURATION_MS: 8 * 60 * 60 * 1000 // 8 hours
  },
  COST: {
    ASSEMBLYAI_RATE_PER_HOUR: 0.15,
    CURRENCY: 'USD'
  }
} as const;