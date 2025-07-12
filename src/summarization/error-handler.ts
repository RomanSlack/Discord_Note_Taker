import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';

const logger = createLogger('ErrorHandler');

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterMs: number;
}

export interface ErrorClassification {
  type: 'rate_limit' | 'quota_exceeded' | 'timeout' | 'network' | 'auth' | 'invalid_request' | 'server_error' | 'unknown';
  severity: 'low' | 'medium' | 'high' | 'critical';
  retryable: boolean;
  userMessage: string;
  technicalMessage: string;
}

export interface ErrorReport {
  id: string;
  timestamp: Date;
  error: Error;
  classification: ErrorClassification;
  context: Record<string, any>;
  retryAttempt: number;
  resolved: boolean;
  resolutionTime?: Date;
}

export class SummarizationErrorHandler extends EventEmitter {
  private retryConfig: RetryConfig;
  private errorReports: Map<string, ErrorReport> = new Map();
  private rateLimitState: Map<string, Date> = new Map();
  private circuitBreakerState: Map<string, { failures: number; lastFailure: Date; isOpen: boolean }> = new Map();
  private readonly circuitBreakerThreshold = 5; // failures before opening circuit
  private readonly circuitBreakerResetTime = 60000; // 1 minute

  constructor(retryConfig?: Partial<RetryConfig>) {
    super();

    this.retryConfig = {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffFactor: 2,
      jitterMs: 500,
      ...retryConfig
    };

    logger.info('Error handler initialized', this.retryConfig);
  }

  public async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: Record<string, any> = {},
    operationId: string = 'unknown'
  ): Promise<T> {
    let lastError: Error | null = null;
    let attempt = 0;

    // Check circuit breaker
    if (this.isCircuitOpen(operationId)) {
      throw new Error(`Circuit breaker is open for operation: ${operationId}`);
    }

    while (attempt < this.retryConfig.maxAttempts) {
      attempt++;
      
      try {
        // Check rate limits
        await this.checkRateLimit(operationId);

        const result = await operation();
        
        // Success - reset circuit breaker
        this.resetCircuitBreaker(operationId);
        
        // Mark any previous error as resolved
        if (lastError) {
          this.markErrorResolved(lastError, context);
        }

        return result;

      } catch (error) {
        lastError = error as Error;
        const classification = this.classifyError(lastError);
        
        // Record error
        const errorReport = this.recordError(lastError, classification, context, attempt);
        
        // Update circuit breaker
        this.updateCircuitBreaker(operationId, classification);

        logger.warn('Operation failed', {
          operationId,
          attempt,
          error: lastError.message,
          classification: classification.type,
          retryable: classification.retryable
        });

        // Don't retry if error is not retryable
        if (!classification.retryable) {
          this.emit('non-retryable-error', errorReport);
          throw lastError;
        }

        // Don't retry on final attempt
        if (attempt >= this.retryConfig.maxAttempts) {
          this.emit('max-retries-exceeded', errorReport);
          throw lastError;
        }

        // Handle rate limits
        if (classification.type === 'rate_limit') {
          await this.handleRateLimit(lastError, operationId);
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, classification);
        logger.debug('Retrying operation', { operationId, attempt, delayMs: delay });
        
        await this.delay(delay);
      }
    }

    throw lastError || new Error('Operation failed without specific error');
  }

  public classifyError(error: Error): ErrorClassification {
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || '';

    // Rate limit errors
    if (message.includes('rate limit') || 
        message.includes('too many requests') ||
        message.includes('quota exceeded') ||
        (error as any).status === 429) {
      return {
        type: 'rate_limit',
        severity: 'medium',
        retryable: true,
        userMessage: 'Request rate limit reached. The system will automatically retry.',
        technicalMessage: 'OpenAI API rate limit exceeded'
      };
    }

    // Quota exceeded
    if (message.includes('quota') || 
        message.includes('billing') ||
        message.includes('insufficient credits')) {
      return {
        type: 'quota_exceeded',
        severity: 'critical',
        retryable: false,
        userMessage: 'Service quota exceeded. Please check your API billing.',
        technicalMessage: 'OpenAI API quota or billing issue'
      };
    }

    // Authentication errors
    if (message.includes('unauthorized') || 
        message.includes('api key') ||
        message.includes('authentication') ||
        (error as any).status === 401) {
      return {
        type: 'auth',
        severity: 'critical',
        retryable: false,
        userMessage: 'Authentication failed. Please check API configuration.',
        technicalMessage: 'Invalid or missing API key'
      };
    }

    // Timeout errors
    if (message.includes('timeout') || 
        message.includes('timed out') ||
        message.includes('aborted')) {
      return {
        type: 'timeout',
        severity: 'medium',
        retryable: true,
        userMessage: 'Request timed out. Retrying automatically.',
        technicalMessage: 'Request timeout - possibly due to large content or slow response'
      };
    }

    // Network errors
    if (message.includes('network') || 
        message.includes('connection') ||
        message.includes('dns') ||
        message.includes('enotfound') ||
        message.includes('econnreset')) {
      return {
        type: 'network',
        severity: 'medium',
        retryable: true,
        userMessage: 'Network connection issue. Retrying automatically.',
        technicalMessage: 'Network connectivity problem'
      };
    }

    // Invalid request errors
    if (message.includes('invalid') || 
        message.includes('bad request') ||
        message.includes('validation') ||
        (error as any).status === 400) {
      return {
        type: 'invalid_request',
        severity: 'high',
        retryable: false,
        userMessage: 'Invalid request format. Please check input data.',
        technicalMessage: 'Request validation failed - check input format and parameters'
      };
    }

    // Server errors
    if (message.includes('internal server error') ||
        message.includes('service unavailable') ||
        message.includes('bad gateway') ||
        (error as any).status >= 500) {
      return {
        type: 'server_error',
        severity: 'high',
        retryable: true,
        userMessage: 'Service temporarily unavailable. Retrying automatically.',
        technicalMessage: 'Upstream service error'
      };
    }

    // Unknown errors
    return {
      type: 'unknown',
      severity: 'medium',
      retryable: true,
      userMessage: 'An unexpected error occurred. Retrying automatically.',
      technicalMessage: error.message
    };
  }

  private recordError(
    error: Error, 
    classification: ErrorClassification, 
    context: Record<string, any>,
    retryAttempt: number
  ): ErrorReport {
    const report: ErrorReport = {
      id: this.generateErrorId(),
      timestamp: new Date(),
      error,
      classification,
      context,
      retryAttempt,
      resolved: false
    };

    this.errorReports.set(report.id, report);

    // Emit error event
    this.emit('error-recorded', report);

    // Clean up old error reports (keep last 100)
    if (this.errorReports.size > 100) {
      const oldest = Array.from(this.errorReports.keys())[0];
      this.errorReports.delete(oldest);
    }

    return report;
  }

  private markErrorResolved(error: Error, context: Record<string, any>): void {
    // Find the most recent unresolved error that matches
    for (const [id, report] of this.errorReports.entries()) {
      if (!report.resolved && 
          report.error.message === error.message &&
          JSON.stringify(report.context) === JSON.stringify(context)) {
        report.resolved = true;
        report.resolutionTime = new Date();
        this.emit('error-resolved', report);
        break;
      }
    }
  }

  private async handleRateLimit(error: Error, operationId: string): Promise<void> {
    // Extract rate limit information from error
    const resetTime = this.extractRateLimitResetTime(error);
    
    if (resetTime) {
      this.rateLimitState.set(operationId, resetTime);
      logger.info('Rate limit detected, waiting until reset', {
        operationId,
        resetTime: resetTime.toISOString(),
        waitMs: resetTime.getTime() - Date.now()
      });
    } else {
      // Default wait time if no reset time is provided
      const defaultWait = new Date(Date.now() + 60000); // 1 minute
      this.rateLimitState.set(operationId, defaultWait);
    }
  }

  private extractRateLimitResetTime(error: Error): Date | null {
    // Try to extract rate limit reset time from error
    const errorData = (error as any).response?.headers || (error as any).headers || {};
    
    // Check for standard rate limit headers
    if (errorData['x-ratelimit-reset']) {
      return new Date(parseInt(errorData['x-ratelimit-reset']) * 1000);
    }
    
    if (errorData['retry-after']) {
      const retryAfter = parseInt(errorData['retry-after']);
      return new Date(Date.now() + retryAfter * 1000);
    }

    // Try to parse from error message
    const match = error.message.match(/try again in (\d+) seconds?/i);
    if (match) {
      return new Date(Date.now() + parseInt(match[1]) * 1000);
    }

    return null;
  }

  private async checkRateLimit(operationId: string): Promise<void> {
    const resetTime = this.rateLimitState.get(operationId);
    
    if (resetTime && resetTime > new Date()) {
      const waitMs = resetTime.getTime() - Date.now();
      logger.debug('Waiting for rate limit reset', { operationId, waitMs });
      await this.delay(waitMs);
      this.rateLimitState.delete(operationId);
    }
  }

  private updateCircuitBreaker(operationId: string, classification: ErrorClassification): void {
    const state = this.circuitBreakerState.get(operationId) || {
      failures: 0,
      lastFailure: new Date(),
      isOpen: false
    };

    state.failures++;
    state.lastFailure = new Date();

    if (state.failures >= this.circuitBreakerThreshold) {
      state.isOpen = true;
      logger.warn('Circuit breaker opened', { operationId, failures: state.failures });
      this.emit('circuit-breaker-opened', { operationId, failures: state.failures });
    }

    this.circuitBreakerState.set(operationId, state);
  }

  private resetCircuitBreaker(operationId: string): void {
    const state = this.circuitBreakerState.get(operationId);
    if (state) {
      const wasOpen = state.isOpen;
      state.failures = 0;
      state.isOpen = false;
      
      if (wasOpen) {
        logger.info('Circuit breaker reset', { operationId });
        this.emit('circuit-breaker-reset', { operationId });
      }
    }
  }

  private isCircuitOpen(operationId: string): boolean {
    const state = this.circuitBreakerState.get(operationId);
    
    if (!state || !state.isOpen) {
      return false;
    }

    // Check if circuit should be reset
    const timeSinceLastFailure = Date.now() - state.lastFailure.getTime();
    if (timeSinceLastFailure > this.circuitBreakerResetTime) {
      this.resetCircuitBreaker(operationId);
      return false;
    }

    return true;
  }

  private calculateDelay(attempt: number, classification: ErrorClassification): number {
    let delay = this.retryConfig.baseDelayMs * Math.pow(this.retryConfig.backoffFactor, attempt - 1);
    
    // Cap the delay
    delay = Math.min(delay, this.retryConfig.maxDelayMs);
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * this.retryConfig.jitterMs;
    delay += jitter;

    // Adjust delay based on error type
    switch (classification.type) {
      case 'rate_limit':
        delay *= 2; // Longer delays for rate limits
        break;
      case 'timeout':
        delay *= 1.5; // Moderate increase for timeouts
        break;
      case 'server_error':
        delay *= 1.5; // Moderate increase for server errors
        break;
    }

    return Math.round(delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private generateErrorId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // Public methods for monitoring and reporting
  public getErrorStats(): {
    totalErrors: number;
    errorsByType: Record<string, number>;
    errorsBySeverity: Record<string, number>;
    recentErrors: ErrorReport[];
    circuitBreakerStates: Record<string, any>;
  } {
    const allErrors = Array.from(this.errorReports.values());
    const recentErrors = allErrors
      .filter(report => Date.now() - report.timestamp.getTime() < 24 * 60 * 60 * 1000) // Last 24 hours
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 20);

    const errorsByType: Record<string, number> = {};
    const errorsBySeverity: Record<string, number> = {};

    allErrors.forEach(report => {
      errorsByType[report.classification.type] = (errorsByType[report.classification.type] || 0) + 1;
      errorsBySeverity[report.classification.severity] = (errorsBySeverity[report.classification.severity] || 0) + 1;
    });

    const circuitBreakerStates: Record<string, any> = {};
    this.circuitBreakerState.forEach((state, operationId) => {
      circuitBreakerStates[operationId] = state;
    });

    return {
      totalErrors: allErrors.length,
      errorsByType,
      errorsBySeverity,
      recentErrors,
      circuitBreakerStates
    };
  }

  public getHealthStatus(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    issues: string[];
    metrics: {
      errorRate: number;
      openCircuits: number;
      rateLimitedOperations: number;
    };
  } {
    const recentErrors = Array.from(this.errorReports.values())
      .filter(report => Date.now() - report.timestamp.getTime() < 60 * 60 * 1000); // Last hour

    const openCircuits = Array.from(this.circuitBreakerState.values())
      .filter(state => state.isOpen).length;

    const rateLimitedOperations = this.rateLimitState.size;

    const errorRate = recentErrors.length; // errors per hour
    const issues: string[] = [];

    if (openCircuits > 0) {
      issues.push(`${openCircuits} circuit breaker(s) open`);
    }

    if (rateLimitedOperations > 0) {
      issues.push(`${rateLimitedOperations} operation(s) rate limited`);
    }

    if (errorRate > 10) {
      issues.push(`High error rate: ${errorRate} errors in the last hour`);
    }

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (issues.length > 0) {
      status = openCircuits > 0 || errorRate > 20 ? 'unhealthy' : 'degraded';
    }

    return {
      status,
      issues,
      metrics: {
        errorRate,
        openCircuits,
        rateLimitedOperations
      }
    };
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up error handler');
    
    this.errorReports.clear();
    this.rateLimitState.clear();
    this.circuitBreakerState.clear();
    this.removeAllListeners();
    
    logger.info('Error handler cleanup completed');
  }
}

export default SummarizationErrorHandler;