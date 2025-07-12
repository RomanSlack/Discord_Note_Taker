import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@utils/logger';

const logger = createLogger('CostTracker');

export interface CostEntry {
  id: string;
  timestamp: Date;
  sessionId: string;
  service: 'openai' | 'assemblyai' | 'other';
  operation: string;
  tokens?: number;
  cost: number;
  model?: string;
  metadata?: Record<string, any>;
}

export interface CostSummary {
  totalCost: number;
  totalTokens: number;
  totalRequests: number;
  averageCostPerRequest: number;
  averageTokensPerRequest: number;
  costByService: Record<string, number>;
  costByModel: Record<string, number>;
  costByOperation: Record<string, number>;
  period: {
    start: Date;
    end: Date;
  };
}

export interface CostAlert {
  type: 'threshold' | 'rate' | 'budget';
  level: 'warning' | 'critical';
  message: string;
  currentValue: number;
  thresholdValue: number;
  timestamp: Date;
}

export interface CostLimits {
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  sessionLimit: number;
  requestRateLimit: number; // requests per minute
  warningThreshold: number; // percentage of limit
}

export class CostTracker extends EventEmitter {
  private entries: CostEntry[] = [];
  private storageFile: string;
  private limits: CostLimits;
  private lastSaveTime = Date.now();
  private saveInterval = 30000; // 30 seconds
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(storageDir: string = './costs', limits?: Partial<CostLimits>) {
    super();

    this.storageFile = path.join(storageDir, 'cost-tracking.json');
    this.limits = {
      dailyLimit: 10.0, // $10 per day
      weeklyLimit: 50.0, // $50 per week
      monthlyLimit: 200.0, // $200 per month
      sessionLimit: 5.0, // $5 per session
      requestRateLimit: 60, // 60 requests per minute
      warningThreshold: 80, // 80% of limit
      ...limits
    };

    this.ensureStorageDirectory();
    this.loadEntries();
    this.startPeriodicSave();

    logger.info('Cost tracker initialized', {
      storageFile: this.storageFile,
      limits: this.limits
    });
  }

  public async trackCost(entry: Omit<CostEntry, 'id' | 'timestamp'>): Promise<void> {
    const costEntry: CostEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      ...entry
    };

    this.entries.push(costEntry);

    // Check for alerts
    await this.checkAlerts(costEntry);

    // Emit event
    this.emit('cost-tracked', costEntry);

    logger.debug('Cost tracked', {
      id: costEntry.id,
      service: costEntry.service,
      operation: costEntry.operation,
      cost: costEntry.cost,
      tokens: costEntry.tokens
    });

    // Schedule save
    this.scheduleSave();
  }

  public getDailyCosts(date?: Date): CostSummary {
    const targetDate = date || new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    return this.getSummaryForPeriod(startOfDay, endOfDay);
  }

  public getWeeklyCosts(date?: Date): CostSummary {
    const targetDate = date || new Date();
    const startOfWeek = new Date(targetDate);
    startOfWeek.setDate(targetDate.getDate() - targetDate.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    return this.getSummaryForPeriod(startOfWeek, endOfWeek);
  }

  public getMonthlyCosts(date?: Date): CostSummary {
    const targetDate = date || new Date();
    const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
    const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0, 23, 59, 59, 999);

    return this.getSummaryForPeriod(startOfMonth, endOfMonth);
  }

  public getSessionCosts(sessionId: string): CostSummary {
    const sessionEntries = this.entries.filter(entry => entry.sessionId === sessionId);
    
    if (sessionEntries.length === 0) {
      const now = new Date();
      return {
        totalCost: 0,
        totalTokens: 0,
        totalRequests: 0,
        averageCostPerRequest: 0,
        averageTokensPerRequest: 0,
        costByService: {},
        costByModel: {},
        costByOperation: {},
        period: { start: now, end: now }
      };
    }

    const start = new Date(Math.min(...sessionEntries.map(e => e.timestamp.getTime())));
    const end = new Date(Math.max(...sessionEntries.map(e => e.timestamp.getTime())));

    return this.calculateSummary(sessionEntries, start, end);
  }

  public getSummaryForPeriod(start: Date, end: Date): CostSummary {
    const periodEntries = this.entries.filter(entry => 
      entry.timestamp >= start && entry.timestamp <= end
    );

    return this.calculateSummary(periodEntries, start, end);
  }

  private calculateSummary(entries: CostEntry[], start: Date, end: Date): CostSummary {
    const totalCost = entries.reduce((sum, entry) => sum + entry.cost, 0);
    const totalTokens = entries.reduce((sum, entry) => sum + (entry.tokens || 0), 0);
    const totalRequests = entries.length;

    const costByService: Record<string, number> = {};
    const costByModel: Record<string, number> = {};
    const costByOperation: Record<string, number> = {};

    entries.forEach(entry => {
      costByService[entry.service] = (costByService[entry.service] || 0) + entry.cost;
      
      if (entry.model) {
        costByModel[entry.model] = (costByModel[entry.model] || 0) + entry.cost;
      }
      
      costByOperation[entry.operation] = (costByOperation[entry.operation] || 0) + entry.cost;
    });

    return {
      totalCost,
      totalTokens,
      totalRequests,
      averageCostPerRequest: totalRequests > 0 ? totalCost / totalRequests : 0,
      averageTokensPerRequest: totalRequests > 0 ? totalTokens / totalRequests : 0,
      costByService,
      costByModel,
      costByOperation,
      period: { start, end }
    };
  }

  private async checkAlerts(entry: CostEntry): Promise<void> {
    const alerts: CostAlert[] = [];

    // Check daily limit
    const dailyCosts = this.getDailyCosts();
    if (dailyCosts.totalCost >= this.limits.dailyLimit * (this.limits.warningThreshold / 100)) {
      alerts.push({
        type: 'threshold',
        level: dailyCosts.totalCost >= this.limits.dailyLimit ? 'critical' : 'warning',
        message: `Daily cost limit ${dailyCosts.totalCost >= this.limits.dailyLimit ? 'exceeded' : 'warning threshold reached'}`,
        currentValue: dailyCosts.totalCost,
        thresholdValue: this.limits.dailyLimit,
        timestamp: new Date()
      });
    }

    // Check weekly limit
    const weeklyCosts = this.getWeeklyCosts();
    if (weeklyCosts.totalCost >= this.limits.weeklyLimit * (this.limits.warningThreshold / 100)) {
      alerts.push({
        type: 'threshold',
        level: weeklyCosts.totalCost >= this.limits.weeklyLimit ? 'critical' : 'warning',
        message: `Weekly cost limit ${weeklyCosts.totalCost >= this.limits.weeklyLimit ? 'exceeded' : 'warning threshold reached'}`,
        currentValue: weeklyCosts.totalCost,
        thresholdValue: this.limits.weeklyLimit,
        timestamp: new Date()
      });
    }

    // Check monthly limit
    const monthlyCosts = this.getMonthlyCosts();
    if (monthlyCosts.totalCost >= this.limits.monthlyLimit * (this.limits.warningThreshold / 100)) {
      alerts.push({
        type: 'budget',
        level: monthlyCosts.totalCost >= this.limits.monthlyLimit ? 'critical' : 'warning',
        message: `Monthly budget ${monthlyCosts.totalCost >= this.limits.monthlyLimit ? 'exceeded' : 'warning threshold reached'}`,
        currentValue: monthlyCosts.totalCost,
        thresholdValue: this.limits.monthlyLimit,
        timestamp: new Date()
      });
    }

    // Check session limit
    const sessionCosts = this.getSessionCosts(entry.sessionId);
    if (sessionCosts.totalCost >= this.limits.sessionLimit * (this.limits.warningThreshold / 100)) {
      alerts.push({
        type: 'threshold',
        level: sessionCosts.totalCost >= this.limits.sessionLimit ? 'critical' : 'warning',
        message: `Session cost limit ${sessionCosts.totalCost >= this.limits.sessionLimit ? 'exceeded' : 'warning threshold reached'}`,
        currentValue: sessionCosts.totalCost,
        thresholdValue: this.limits.sessionLimit,
        timestamp: new Date()
      });
    }

    // Check request rate limit (last minute)
    const oneMinuteAgo = new Date(Date.now() - 60000);
    const recentRequests = this.entries.filter(e => e.timestamp >= oneMinuteAgo).length;
    if (recentRequests >= this.limits.requestRateLimit) {
      alerts.push({
        type: 'rate',
        level: 'warning',
        message: 'Request rate limit approaching',
        currentValue: recentRequests,
        thresholdValue: this.limits.requestRateLimit,
        timestamp: new Date()
      });
    }

    // Emit alerts
    alerts.forEach(alert => {
      logger.warn('Cost alert triggered', alert);
      this.emit('cost-alert', alert);
    });
  }

  public optimizeCosts(): {
    recommendations: string[];
    potentialSavings: number;
  } {
    const monthlyCosts = this.getMonthlyCosts();
    const recommendations: string[] = [];
    let potentialSavings = 0;

    // Analyze model usage
    const modelCosts = Object.entries(monthlyCosts.costByModel)
      .sort(([,a], [,b]) => b - a);

    if (modelCosts.length > 0) {
      const mostExpensiveModel = modelCosts[0];
      if (mostExpensiveModel[0].includes('gpt-4') && mostExpensiveModel[1] > 1.0) {
        recommendations.push('Consider switching from GPT-4 to GPT-4o-mini for cost savings');
        potentialSavings += mostExpensiveModel[1] * 0.8; // Estimate 80% savings
      }
    }

    // Analyze operation patterns
    const operationCosts = Object.entries(monthlyCosts.costByOperation)
      .sort(([,a], [,b]) => b - a);

    if (operationCosts.length > 0) {
      const mostExpensiveOperation = operationCosts[0];
      if (mostExpensiveOperation[0] === 'interim' && mostExpensiveOperation[1] > 2.0) {
        recommendations.push('Consider reducing interim summary frequency to save costs');
        potentialSavings += mostExpensiveOperation[1] * 0.3; // Estimate 30% savings
      }
    }

    // Check token efficiency
    if (monthlyCosts.averageTokensPerRequest > 8000) {
      recommendations.push('Optimize prompts to reduce token usage per request');
      potentialSavings += monthlyCosts.totalCost * 0.2; // Estimate 20% savings
    }

    // Check for unnecessary requests
    const totalRequests = monthlyCosts.totalRequests;
    if (totalRequests > 1000) {
      recommendations.push('Implement caching to reduce duplicate API calls');
      potentialSavings += monthlyCosts.totalCost * 0.15; // Estimate 15% savings
    }

    return {
      recommendations,
      potentialSavings
    };
  }

  public getUsageReport(): {
    summary: CostSummary;
    trends: {
      dailyAverage: number;
      weeklyTrend: number;
      monthlyProjection: number;
    };
    alerts: number;
    optimization: ReturnType<typeof this.optimizeCosts>;
  } {
    const monthlyCosts = this.getMonthlyCosts();
    const weeklyCosts = this.getWeeklyCosts();
    const dailyCosts = this.getDailyCosts();

    // Calculate trends
    const daysInMonth = new Date().getDate();
    const dailyAverage = monthlyCosts.totalCost / daysInMonth;
    const weeklyTrend = weeklyCosts.totalCost;
    const monthlyProjection = dailyAverage * 30; // 30-day projection

    // Count recent alerts (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentAlerts = this.entries.filter(entry => 
      entry.timestamp >= yesterday && 
      entry.metadata?.alert
    ).length;

    return {
      summary: monthlyCosts,
      trends: {
        dailyAverage,
        weeklyTrend,
        monthlyProjection
      },
      alerts: recentAlerts,
      optimization: this.optimizeCosts()
    };
  }

  private ensureStorageDirectory(): void {
    const dir = path.dirname(this.storageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private loadEntries(): void {
    try {
      if (fs.existsSync(this.storageFile)) {
        const data = fs.readFileSync(this.storageFile, 'utf-8');
        const parsed = JSON.parse(data);
        
        this.entries = parsed.map((entry: any) => ({
          ...entry,
          timestamp: new Date(entry.timestamp)
        }));

        logger.info('Cost entries loaded', { count: this.entries.length });
      }
    } catch (error) {
      logger.error('Failed to load cost entries:', error);
      this.entries = [];
    }
  }

  private scheduleSave(): void {
    if (Date.now() - this.lastSaveTime > this.saveInterval) {
      this.saveEntries();
    }
  }

  private startPeriodicSave(): void {
    this.saveTimer = setInterval(() => {
      this.saveEntries();
    }, this.saveInterval);
  }

  private saveEntries(): void {
    try {
      const data = JSON.stringify(this.entries, null, 2);
      fs.writeFileSync(this.storageFile, data);
      this.lastSaveTime = Date.now();
      
      logger.debug('Cost entries saved', { count: this.entries.length });
    } catch (error) {
      logger.error('Failed to save cost entries:', error);
    }
  }

  private generateId(): string {
    return `cost_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  public updateLimits(newLimits: Partial<CostLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
    logger.info('Cost limits updated', this.limits);
    this.emit('limits-updated', this.limits);
  }

  public getLimits(): CostLimits {
    return { ...this.limits };
  }

  public clearOldEntries(daysToKeep: number = 90): number {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const initialCount = this.entries.length;
    
    this.entries = this.entries.filter(entry => entry.timestamp >= cutoffDate);
    
    const removedCount = initialCount - this.entries.length;
    if (removedCount > 0) {
      logger.info('Old cost entries cleaned up', { 
        removed: removedCount, 
        remaining: this.entries.length 
      });
      this.saveEntries();
    }

    return removedCount;
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up cost tracker');

    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }

    this.saveEntries();
    this.removeAllListeners();

    logger.info('Cost tracker cleanup completed');
  }
}

export default CostTracker;