import winston from 'winston';
import { config } from '@config/environment';

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug'
}

export interface LoggerContext {
  userId?: string;
  guildId?: string;
  channelId?: string;
  connectionId?: string;
  timestamp?: number;
  [key: string]: any;
}

class LoggerService {
  private winston: winston.Logger;
  private context: LoggerContext = {};

  constructor(label?: string) {
    const formats = [
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ];

    if (label) {
      formats.push(winston.format.label({ label }));
    }

    // Console format for development
    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
      winston.format.printf(({ timestamp, level, message, label, ...meta }) => {
        const labelStr = label ? `[${label}] ` : '';
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} ${level}: ${labelStr}${message}${metaStr}`;
      })
    );

    // File format for production
    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );

    const transports: winston.transport[] = [
      new winston.transports.Console({
        level: config.isDevelopment ? LogLevel.DEBUG : config.logLevel,
        format: consoleFormat,
        handleExceptions: true,
        handleRejections: true
      })
    ];

    // Add file transport if enabled
    if (config.logToFile) {
      transports.push(
        new winston.transports.File({
          filename: 'logs/error.log',
          level: LogLevel.ERROR,
          format: fileFormat,
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 5,
          handleExceptions: true,
          handleRejections: true
        }),
        new winston.transports.File({
          filename: 'logs/combined.log',
          level: config.logLevel,
          format: fileFormat,
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 10
        })
      );
    }

    this.winston = winston.createLogger({
      level: config.logLevel,
      format: winston.format.combine(...formats),
      transports,
      exitOnError: false,
      silent: process.env.NODE_ENV === 'test'
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.error('Unhandled Promise Rejection:', { reason, promise });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.error('Uncaught Exception:', error);
      process.exit(1);
    });
  }

  public setContext(context: LoggerContext): void {
    this.context = { ...this.context, ...context };
  }

  public clearContext(): void {
    this.context = {};
  }

  public getContext(): LoggerContext {
    return { ...this.context };
  }

  private formatMessage(message: string, meta?: any): { message: string; meta: any } {
    const timestamp = Date.now();
    const combinedMeta = {
      ...this.context,
      ...meta,
      timestamp
    };

    return {
      message,
      meta: Object.keys(combinedMeta).length > 0 ? combinedMeta : undefined
    };
  }

  public error(message: string, meta?: any): void {
    const { message: formattedMessage, meta: formattedMeta } = this.formatMessage(message, meta);
    this.winston.error(formattedMessage, formattedMeta);
  }

  public warn(message: string, meta?: any): void {
    const { message: formattedMessage, meta: formattedMeta } = this.formatMessage(message, meta);
    this.winston.warn(formattedMessage, formattedMeta);
  }

  public info(message: string, meta?: any): void {
    const { message: formattedMessage, meta: formattedMeta } = this.formatMessage(message, meta);
    this.winston.info(formattedMessage, formattedMeta);
  }

  public debug(message: string, meta?: any): void {
    const { message: formattedMessage, meta: formattedMeta } = this.formatMessage(message, meta);
    this.winston.debug(formattedMessage, formattedMeta);
  }

  // Voice-specific logging methods
  public voiceConnection(action: string, meta?: any): void {
    this.info(`Voice Connection: ${action}`, { category: 'voice', ...meta });
  }

  public voiceError(message: string, error?: any): void {
    this.error(`Voice Error: ${message}`, { category: 'voice', error });
  }

  public transcription(action: string, meta?: any): void {
    this.info(`Transcription: ${action}`, { category: 'transcription', ...meta });
  }

  public botEvent(event: string, meta?: any): void {
    this.info(`Bot Event: ${event}`, { category: 'bot', ...meta });
  }

  // Performance logging
  public performance(operation: string, duration: number, meta?: any): void {
    const level = duration > 1000 ? LogLevel.WARN : LogLevel.DEBUG;
    this.winston.log(level, `Performance: ${operation} took ${duration}ms`, {
      category: 'performance',
      operation,
      duration,
      ...meta
    });
  }

  // Create child logger with additional context
  public child(context: LoggerContext): Logger {
    const childLogger = new Logger();
    childLogger.setContext({ ...this.context, ...context });
    return childLogger;
  }

  // Profiling support
  public startTimer(label: string): () => void {
    const start = Date.now();
    return () => {
      const duration = Date.now() - start;
      this.performance(label, duration);
    };
  }
}

export class Logger extends LoggerService {
  constructor(label?: string) {
    super(label);
  }
}

// Create default logger instance
export const logger = new Logger('Bot');

// Export logger creator for specific modules
export const createLogger = (label: string): Logger => new Logger(label);

// Export logging utilities
export const withLogging = <T extends (...args: any[]) => any>(
  fn: T,
  label?: string
): T => {
  return ((...args: any[]) => {
    const moduleLogger = label ? createLogger(label) : logger;
    const timer = moduleLogger.startTimer(`${fn.name || 'anonymous'}`);
    
    try {
      const result = fn(...args);
      
      // Handle promises
      if (result && typeof result.then === 'function') {
        return result
          .then((res: any) => {
            timer();
            return res;
          })
          .catch((error: any) => {
            timer();
            moduleLogger.error(`Function ${fn.name || 'anonymous'} failed:`, error);
            throw error;
          });
      }
      
      timer();
      return result;
    } catch (error) {
      timer();
      moduleLogger.error(`Function ${fn.name || 'anonymous'} failed:`, error);
      throw error;
    }
  }) as T;
};

export default Logger;