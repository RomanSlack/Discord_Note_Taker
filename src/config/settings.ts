export interface VoiceSettings {
  // Audio Configuration
  bitrate: number;
  channels: number;
  sampleRate: number;
  frameSize: number;
  packetDuration: number;
  
  // Buffer Configuration
  bufferSize: number;
  maxBufferDuration: number;
  silenceThreshold: number;
  
  // Connection Settings
  connectionTimeout: number;
  heartbeatInterval: number;
  keepAliveInterval: number;
}

export interface TranscriptionSettings {
  // AssemblyAI Configuration
  language: string;
  punctuate: boolean;
  formatText: boolean;
  dualChannel: boolean;
  
  // Processing Configuration
  confidenceThreshold: number;
  minSpeechDuration: number;
  maxSilenceDuration: number;
  
  // Real-time Configuration
  enableRealTime: boolean;
  partialResults: boolean;
  endUtteranceSilenceTimeout: number;
}

export interface BotSettings {
  // Command Configuration
  commandPrefix: string;
  allowDirectMessages: boolean;
  requirePermissions: boolean;
  
  // Response Configuration
  maxResponseLength: number;
  responseDelay: number;
  mentionResponse: boolean;
  
  // Activity Configuration
  presenceStatus: 'online' | 'idle' | 'dnd' | 'invisible';
  activityType: 'PLAYING' | 'STREAMING' | 'LISTENING' | 'WATCHING' | 'CUSTOM' | 'COMPETING';
  activityName: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  // Audio Configuration
  bitrate: 96,
  channels: 2,
  sampleRate: 48000,
  frameSize: 960,
  packetDuration: 20,
  
  // Buffer Configuration
  bufferSize: 1024 * 32, // 32KB
  maxBufferDuration: 5000, // 5 seconds
  silenceThreshold: -50, // dB
  
  // Connection Settings
  connectionTimeout: 15000, // 15 seconds
  heartbeatInterval: 30000, // 30 seconds
  keepAliveInterval: 60000 // 1 minute
};

export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  // AssemblyAI Configuration
  language: 'en',
  punctuate: true,
  formatText: true,
  dualChannel: false,
  
  // Processing Configuration
  confidenceThreshold: 0.7,
  minSpeechDuration: 250, // ms
  maxSilenceDuration: 2000, // ms
  
  // Real-time Configuration
  enableRealTime: true,
  partialResults: true,
  endUtteranceSilenceTimeout: 700 // ms
};

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  // Command Configuration
  commandPrefix: '!',
  allowDirectMessages: false,
  requirePermissions: true,
  
  // Response Configuration
  maxResponseLength: 2000,
  responseDelay: 1000, // ms
  mentionResponse: true,
  
  // Activity Configuration
  presenceStatus: 'online',
  activityType: 'LISTENING',
  activityName: 'voice conversations'
};

export class SettingsManager {
  private voiceSettings: VoiceSettings;
  private transcriptionSettings: TranscriptionSettings;
  private botSettings: BotSettings;

  constructor() {
    this.voiceSettings = { ...DEFAULT_VOICE_SETTINGS };
    this.transcriptionSettings = { ...DEFAULT_TRANSCRIPTION_SETTINGS };
    this.botSettings = { ...DEFAULT_BOT_SETTINGS };
  }

  // Voice Settings
  public getVoiceSettings(): VoiceSettings {
    return { ...this.voiceSettings };
  }

  public updateVoiceSettings(settings: Partial<VoiceSettings>): void {
    this.voiceSettings = { ...this.voiceSettings, ...settings };
  }

  // Transcription Settings
  public getTranscriptionSettings(): TranscriptionSettings {
    return { ...this.transcriptionSettings };
  }

  public updateTranscriptionSettings(settings: Partial<TranscriptionSettings>): void {
    this.transcriptionSettings = { ...this.transcriptionSettings, ...settings };
  }

  // Bot Settings
  public getBotSettings(): BotSettings {
    return { ...this.botSettings };
  }

  public updateBotSettings(settings: Partial<BotSettings>): void {
    this.botSettings = { ...this.botSettings, ...settings };
  }

  // Reset to defaults
  public resetToDefaults(): void {
    this.voiceSettings = { ...DEFAULT_VOICE_SETTINGS };
    this.transcriptionSettings = { ...DEFAULT_TRANSCRIPTION_SETTINGS };
    this.botSettings = { ...DEFAULT_BOT_SETTINGS };
  }

  // Validation methods
  public validateVoiceSettings(settings: Partial<VoiceSettings>): boolean {
    if (settings.bitrate && (settings.bitrate < 8 || settings.bitrate > 320)) {
      return false;
    }
    if (settings.channels && (settings.channels < 1 || settings.channels > 2)) {
      return false;
    }
    if (settings.sampleRate && ![8000, 12000, 16000, 24000, 48000].includes(settings.sampleRate)) {
      return false;
    }
    return true;
  }

  public validateTranscriptionSettings(settings: Partial<TranscriptionSettings>): boolean {
    if (settings.confidenceThreshold && (settings.confidenceThreshold < 0 || settings.confidenceThreshold > 1)) {
      return false;
    }
    if (settings.minSpeechDuration && settings.minSpeechDuration < 0) {
      return false;
    }
    if (settings.maxSilenceDuration && settings.maxSilenceDuration < 0) {
      return false;
    }
    return true;
  }

  public validateBotSettings(settings: Partial<BotSettings>): boolean {
    if (settings.maxResponseLength && (settings.maxResponseLength < 1 || settings.maxResponseLength > 4000)) {
      return false;
    }
    if (settings.responseDelay && settings.responseDelay < 0) {
      return false;
    }
    return true;
  }
}

export const settingsManager = new SettingsManager();