import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface BotConfiguration {
  // Discord Configuration
  discordToken: string;
  clientId: string;
  guildId?: string;
  
  // Voice Configuration
  segmentWindowSec: number;
  maxConcurrentConnections: number;
  voiceTimeout: number;
  reconnectAttempts: number;
  
  // API Configuration
  assemblyAiApiKey?: string;
  openAiApiKey?: string;
  openAiModel?: string;
  
  // Logging Configuration
  logLevel: string;
  logToFile: boolean;
  
  // Development Configuration
  isDevelopment: boolean;
  debugMode: boolean;
}

class EnvironmentValidator {
  private static validateRequired(key: string, value: string | undefined): string {
    if (!value) {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
  }

  private static validateOptional(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
  }

  private static validateNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      console.warn(`Invalid number for ${key}, using default: ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
  }

  private static validateBoolean(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    
    return value.toLowerCase() === 'true';
  }

  public static validate(): BotConfiguration {
    try {
      const config: BotConfiguration = {
        // Discord Configuration
        discordToken: this.validateRequired('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
        clientId: this.validateRequired('DISCORD_CLIENT_ID', process.env.DISCORD_CLIENT_ID),
        
        // Voice Configuration
        segmentWindowSec: this.validateNumber('SEGMENT_WINDOW_SEC', 300),
        maxConcurrentConnections: this.validateNumber('MAX_CONCURRENT_CONNECTIONS', 10),
        voiceTimeout: this.validateNumber('VOICE_TIMEOUT', 30000),
        reconnectAttempts: this.validateNumber('RECONNECT_ATTEMPTS', 3),
        
        // Logging Configuration
        logLevel: this.validateOptional('LOG_LEVEL', 'info'),
        logToFile: this.validateBoolean('LOG_TO_FILE', true),
        
        // Development Configuration
        isDevelopment: this.validateBoolean('NODE_ENV', false) || process.env.NODE_ENV === 'development',
        debugMode: this.validateBoolean('DEBUG_MODE', false)
      };

      // Add optional properties only if they exist
      if (process.env.DISCORD_GUILD_ID) {
        config.guildId = process.env.DISCORD_GUILD_ID;
      }
      
      if (process.env.ASSEMBLY_AI_API_KEY) {
        config.assemblyAiApiKey = process.env.ASSEMBLY_AI_API_KEY;
      }
      
      if (process.env.OPENAI_API_KEY) {
        config.openAiApiKey = process.env.OPENAI_API_KEY;
      }
      
      if (process.env.OPENAI_MODEL) {
        config.openAiModel = process.env.OPENAI_MODEL;
      }

      // Validate log level
      const validLogLevels = ['error', 'warn', 'info', 'debug'];
      if (!validLogLevels.includes(config.logLevel)) {
        console.warn(`Invalid log level: ${config.logLevel}, defaulting to 'info'`);
        config.logLevel = 'info';
      }

      // Validate numeric ranges
      if (config.segmentWindowSec < 10 || config.segmentWindowSec > 3600) {
        console.warn(`Invalid segment window: ${config.segmentWindowSec}s, must be between 10-3600s`);
        config.segmentWindowSec = 300;
      }

      if (config.maxConcurrentConnections < 1 || config.maxConcurrentConnections > 100) {
        console.warn(`Invalid max connections: ${config.maxConcurrentConnections}, must be between 1-100`);
        config.maxConcurrentConnections = 10;
      }

      console.info('Environment configuration validated successfully');
      
      if (config.debugMode) {
        console.debug('Configuration loaded:', {
          ...config,
          discordToken: '***REDACTED***',
          assemblyAiApiKey: config.assemblyAiApiKey ? '***REDACTED***' : 'not set',
          openAiApiKey: config.openAiApiKey ? '***REDACTED***' : 'not set'
        });
      }

      return config;
    } catch (error) {
      console.error('Failed to validate environment configuration:', error);
      throw error;
    }
  }
}

export const config = EnvironmentValidator.validate();
export default config;