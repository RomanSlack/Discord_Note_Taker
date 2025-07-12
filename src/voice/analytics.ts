import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import { RecordingSession, UserTrack, AudioSegment } from './multitrack-recorder';
import { AudioQualityMetrics, SpeakerActivity } from './audio-analyzer';
import { QualityAlert, QualityReport } from './quality-monitor';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('RecordingAnalytics');

export interface UserAnalytics {
  userId: string;
  username: string;
  totalSessions: number;
  totalSpeakingTime: number; // milliseconds
  averageSpeakingTime: number;
  totalSilenceTime: number;
  averageAudioLevel: number;
  averageQuality: 'poor' | 'fair' | 'good' | 'excellent';
  mostActiveHours: number[]; // hours of day (0-23)
  qualityTrend: 'improving' | 'stable' | 'declining';
  commonIssues: Array<{ issue: string; count: number }>;
  lastSeen: Date;
}

export interface SessionAnalytics {
  sessionId: string;
  guildId: string;
  channelName: string;
  startTime: Date;
  endTime: Date;
  duration: number;
  participantCount: number;
  totalSpeechTime: number;
  speechToSilenceRatio: number;
  averageQuality: 'poor' | 'fair' | 'good' | 'excellent';
  dominantSpeaker: { userId: string; username: string; percentage: number } | null;
  quietestParticipant: { userId: string; username: string; percentage: number } | null;
  qualityIssues: Array<{ type: string; count: number; affectedUsers: string[] }>;
  peakConcurrentSpeakers: number;
  audioLevelDistribution: { low: number; medium: number; high: number };
  segmentAnalysis: {
    totalSegments: number;
    averageSegmentDuration: number;
    longestSegment: number;
    shortestSegment: number;
  };
}

export interface GuildAnalytics {
  guildId: string;
  totalSessions: number;
  totalDuration: number;
  totalParticipants: number;
  uniqueUsers: number;
  averageSessionDuration: number;
  averageParticipantsPerSession: number;
  mostActiveChannel: { channelId: string; channelName: string; sessionCount: number } | null;
  mostActiveUser: { userId: string; username: string; totalTime: number } | null;
  qualityTrends: {
    excellent: number;
    good: number;
    fair: number;
    poor: number;
  };
  peakUsageHours: number[]; // hours with most recording activity
  storageUsed: number;
  averageAudioQuality: number;
}

export interface AnalyticsReport {
  reportId: string;
  generatedAt: Date;
  reportType: 'user' | 'session' | 'guild' | 'summary';
  timeRange: {
    start: Date;
    end: Date;
  };
  summary: {
    totalSessions: number;
    totalDuration: number;
    totalUsers: number;
    averageQuality: number;
  };
  userAnalytics: UserAnalytics[];
  sessionAnalytics: SessionAnalytics[];
  guildAnalytics: GuildAnalytics;
  insights: string[];
  recommendations: string[];
}

export interface AnalyticsConfiguration {
  enabled: boolean;
  retentionDays: number;
  reportGenerationInterval: number; // milliseconds
  maxReportsStored: number;
  enablePredictiveAnalytics: boolean;
  exportFormat: 'json' | 'csv' | 'both';
  exportDirectory: string;
}

export class RecordingAnalytics extends EventEmitter {
  private configuration: AnalyticsConfiguration;
  private sessionData: Map<string, SessionAnalytics> = new Map();
  private userData: Map<string, UserAnalytics> = new Map();
  private guildData: Map<string, GuildAnalytics> = new Map();
  private qualityData: Map<string, AudioQualityMetrics[]> = new Map();
  private alertData: Map<string, QualityAlert[]> = new Map();
  
  private reportHistory: AnalyticsReport[] = [];
  private analyticsTimer: NodeJS.Timeout | null = null;

  constructor(configuration?: Partial<AnalyticsConfiguration>) {
    super();
    
    this.configuration = {
      enabled: true,
      retentionDays: 30,
      reportGenerationInterval: 24 * 60 * 60 * 1000, // 24 hours
      maxReportsStored: 100,
      enablePredictiveAnalytics: true,
      exportFormat: 'json',
      exportDirectory: './analytics',
      ...configuration
    };

    this.initializeAnalytics();
  }

  private async initializeAnalytics(): Promise<void> {
    try {
      // Create analytics directory
      await fs.promises.mkdir(this.configuration.exportDirectory, { recursive: true });

      // Load existing data if available
      await this.loadAnalyticsData();

      // Start periodic report generation
      if (this.configuration.enabled) {
        this.startPeriodicReporting();
      }

      logger.info('Recording analytics initialized', {
        enabled: this.configuration.enabled,
        retentionDays: this.configuration.retentionDays,
        reportInterval: this.configuration.reportGenerationInterval
      });

    } catch (error) {
      logger.error('Failed to initialize analytics:', error);
      throw error;
    }
  }

  /**
   * Process a completed recording session
   */
  public async processSession(session: RecordingSession): Promise<void> {
    try {
      const sessionAnalytics = this.analyzeSession(session);
      this.sessionData.set(session.sessionId, sessionAnalytics);

      // Update user analytics
      for (const [userId, userTrack] of session.participants) {
        await this.updateUserAnalytics(userId, userTrack, sessionAnalytics);
      }

      // Update guild analytics
      await this.updateGuildAnalytics(session.guildId, sessionAnalytics);

      logger.debug('Session processed for analytics', {
        sessionId: session.sessionId,
        duration: sessionAnalytics.duration,
        participants: sessionAnalytics.participantCount
      });

      this.emit('session-processed', sessionAnalytics);

    } catch (error) {
      logger.error('Error processing session for analytics:', error);
    }
  }

  /**
   * Add quality data for analysis
   */
  public addQualityData(userId: string, quality: AudioQualityMetrics): void {
    if (!this.qualityData.has(userId)) {
      this.qualityData.set(userId, []);
    }

    const userQualityData = this.qualityData.get(userId)!;
    userQualityData.push(quality);

    // Limit quality data history
    if (userQualityData.length > 1000) {
      userQualityData.splice(0, userQualityData.length - 1000);
    }
  }

  /**
   * Add quality alert for analysis
   */
  public addQualityAlert(alert: QualityAlert): void {
    if (!this.alertData.has(alert.userId)) {
      this.alertData.set(alert.userId, []);
    }

    const userAlerts = this.alertData.get(alert.userId)!;
    userAlerts.push(alert);

    // Limit alert history
    if (userAlerts.length > 500) {
      userAlerts.splice(0, userAlerts.length - 500);
    }
  }

  /**
   * Generate comprehensive analytics report
   */
  public async generateReport(
    type: 'user' | 'session' | 'guild' | 'summary' = 'summary',
    timeRange?: { start: Date; end: Date }
  ): Promise<AnalyticsReport> {
    try {
      const reportId = this.generateReportId();
      const now = new Date();
      const defaultTimeRange = {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        end: now
      };
      
      const range = timeRange || defaultTimeRange;
      
      // Filter data by time range
      const filteredSessions = this.getSessionsInRange(range);
      const filteredUsers = this.getUsersInRange(range);
      
      // Generate summary statistics
      const summary = this.generateSummaryStats(filteredSessions);
      
      // Generate user analytics
      const userAnalytics = await this.generateUserAnalytics(filteredUsers, range);
      
      // Generate session analytics
      const sessionAnalytics = this.generateSessionAnalytics(filteredSessions);
      
      // Generate guild analytics (using first guild ID found)
      const guildIds = [...new Set(filteredSessions.map(s => s.guildId))];
      const guildAnalytics = guildIds.length > 0 
        ? await this.generateGuildAnalytics(guildIds[0], range)
        : this.getEmptyGuildAnalytics();
      
      // Generate insights and recommendations
      const insights = this.generateInsights(summary, userAnalytics, sessionAnalytics);
      const recommendations = this.generateRecommendations(summary, userAnalytics, sessionAnalytics);

      const report: AnalyticsReport = {
        reportId,
        generatedAt: now,
        reportType: type,
        timeRange: range,
        summary,
        userAnalytics,
        sessionAnalytics,
        guildAnalytics,
        insights,
        recommendations
      };

      // Store report
      this.reportHistory.push(report);
      if (this.reportHistory.length > this.configuration.maxReportsStored) {
        this.reportHistory.shift();
      }

      // Export report
      await this.exportReport(report);

      logger.info('Analytics report generated', {
        reportId,
        type,
        sessions: sessionAnalytics.length,
        users: userAnalytics.length,
        timeRange: range
      });

      this.emit('report-generated', report);

      return report;

    } catch (error) {
      logger.error('Error generating analytics report:', error);
      throw error;
    }
  }

  /**
   * Get user analytics
   */
  public getUserAnalytics(userId: string): UserAnalytics | null {
    return this.userData.get(userId) || null;
  }

  /**
   * Get session analytics
   */
  public getSessionAnalytics(sessionId: string): SessionAnalytics | null {
    return this.sessionData.get(sessionId) || null;
  }

  /**
   * Get guild analytics
   */
  public getGuildAnalytics(guildId: string): GuildAnalytics | null {
    return this.guildData.get(guildId) || null;
  }

  /**
   * Get top users by speaking time
   */
  public getTopUsers(limit: number = 10): UserAnalytics[] {
    return Array.from(this.userData.values())
      .sort((a, b) => b.totalSpeakingTime - a.totalSpeakingTime)
      .slice(0, limit);
  }

  /**
   * Get quality trends
   */
  public getQualityTrends(userId?: string): Array<{ date: Date; quality: number }> {
    const trends: Array<{ date: Date; quality: number }> = [];
    
    if (userId) {
      const qualityData = this.qualityData.get(userId) || [];
      for (const quality of qualityData) {
        trends.push({
          date: new Date(), // In real implementation, this would come from the quality data
          quality: this.qualityToNumber(quality.quality)
        });
      }
    } else {
      // Aggregate all users
      for (const qualityData of this.qualityData.values()) {
        for (const quality of qualityData) {
          trends.push({
            date: new Date(),
            quality: this.qualityToNumber(quality.quality)
          });
        }
      }
    }
    
    return trends.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Private methods

  private analyzeSession(session: RecordingSession): SessionAnalytics {
    const participants = Array.from(session.participants.values());
    const duration = session.endTime 
      ? session.endTime.getTime() - session.startTime.getTime()
      : Date.now() - session.startTime.getTime();

    // Calculate total speech time
    const totalSpeechTime = participants.reduce((sum, p) => sum + p.speakingDuration, 0);
    const speechToSilenceRatio = duration > 0 ? totalSpeechTime / duration : 0;

    // Find dominant speaker
    const dominantSpeaker = participants.length > 0 
      ? participants.reduce((max, p) => p.speakingDuration > max.speakingDuration ? p : max)
      : null;

    // Find quietest participant
    const quietestParticipant = participants.length > 0 
      ? participants.reduce((min, p) => p.speakingDuration < min.speakingDuration ? p : min)
      : null;

    // Analyze audio segments
    const segments = session.audioSegments;
    const segmentDurations = segments.map(s => s.duration);
    const segmentAnalysis = {
      totalSegments: segments.length,
      averageSegmentDuration: segmentDurations.length > 0 
        ? segmentDurations.reduce((a, b) => a + b, 0) / segmentDurations.length 
        : 0,
      longestSegment: segmentDurations.length > 0 ? Math.max(...segmentDurations) : 0,
      shortestSegment: segmentDurations.length > 0 ? Math.min(...segmentDurations) : 0
    };

    // Analyze audio levels
    const audioLevels = segments.map(s => s.audioLevel);
    const audioLevelDistribution = {
      low: audioLevels.filter(l => l < -40).length,
      medium: audioLevels.filter(l => l >= -40 && l <= -20).length,
      high: audioLevels.filter(l => l > -20).length
    };

    return {
      sessionId: session.sessionId,
      guildId: session.guildId,
      channelName: session.channelName,
      startTime: session.startTime,
      endTime: session.endTime || new Date(),
      duration,
      participantCount: participants.length,
      totalSpeechTime,
      speechToSilenceRatio,
      averageQuality: this.calculateSessionQuality(session),
      dominantSpeaker: dominantSpeaker ? {
        userId: dominantSpeaker.userId,
        username: dominantSpeaker.username,
        percentage: duration > 0 ? (dominantSpeaker.speakingDuration / duration) * 100 : 0
      } : null,
      quietestParticipant: quietestParticipant ? {
        userId: quietestParticipant.userId,
        username: quietestParticipant.username,
        percentage: duration > 0 ? (quietestParticipant.speakingDuration / duration) * 100 : 0
      } : null,
      qualityIssues: [], // Would be populated from quality alerts
      peakConcurrentSpeakers: this.calculatePeakConcurrentSpeakers(session),
      audioLevelDistribution,
      segmentAnalysis
    };
  }

  private async updateUserAnalytics(
    userId: string, 
    userTrack: UserTrack, 
    sessionAnalytics: SessionAnalytics
  ): Promise<void> {
    let userAnalytics = this.userData.get(userId);
    
    if (!userAnalytics) {
      userAnalytics = {
        userId,
        username: userTrack.username,
        totalSessions: 0,
        totalSpeakingTime: 0,
        averageSpeakingTime: 0,
        totalSilenceTime: 0,
        averageAudioLevel: 0,
        averageQuality: 'fair',
        mostActiveHours: new Array(24).fill(0),
        qualityTrend: 'stable',
        commonIssues: [],
        lastSeen: new Date()
      };
    }

    // Update statistics
    userAnalytics.totalSessions++;
    userAnalytics.totalSpeakingTime += userTrack.speakingDuration;
    userAnalytics.averageSpeakingTime = userAnalytics.totalSpeakingTime / userAnalytics.totalSessions;
    userAnalytics.lastSeen = new Date();

    // Update most active hours
    const sessionHour = sessionAnalytics.startTime.getHours();
    userAnalytics.mostActiveHours[sessionHour]++;

    // Update quality data
    const userQualityData = this.qualityData.get(userId) || [];
    if (userQualityData.length > 0) {
      const avgLevel = userQualityData.reduce((sum, q) => sum + q.audioLevel, 0) / userQualityData.length;
      userAnalytics.averageAudioLevel = avgLevel;
      
      const qualityScores = userQualityData.map(q => this.qualityToNumber(q.quality));
      const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
      userAnalytics.averageQuality = this.numberToQuality(avgQuality);
      
      userAnalytics.qualityTrend = this.calculateUserQualityTrend(userId);
    }

    // Update common issues
    const userAlerts = this.alertData.get(userId) || [];
    const issueMap = new Map<string, number>();
    
    for (const alert of userAlerts) {
      const count = issueMap.get(alert.alertType) || 0;
      issueMap.set(alert.alertType, count + 1);
    }
    
    userAnalytics.commonIssues = Array.from(issueMap.entries())
      .map(([issue, count]) => ({ issue, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    this.userData.set(userId, userAnalytics);
  }

  private async updateGuildAnalytics(guildId: string, sessionAnalytics: SessionAnalytics): Promise<void> {
    let guildAnalytics = this.guildData.get(guildId);
    
    if (!guildAnalytics) {
      guildAnalytics = {
        guildId,
        totalSessions: 0,
        totalDuration: 0,
        totalParticipants: 0,
        uniqueUsers: 0,
        averageSessionDuration: 0,
        averageParticipantsPerSession: 0,
        mostActiveChannel: null,
        mostActiveUser: null,
        qualityTrends: { excellent: 0, good: 0, fair: 0, poor: 0 },
        peakUsageHours: new Array(24).fill(0),
        storageUsed: 0,
        averageAudioQuality: 0
      };
    }

    // Update basic statistics
    guildAnalytics.totalSessions++;
    guildAnalytics.totalDuration += sessionAnalytics.duration;
    guildAnalytics.totalParticipants += sessionAnalytics.participantCount;
    guildAnalytics.averageSessionDuration = guildAnalytics.totalDuration / guildAnalytics.totalSessions;
    guildAnalytics.averageParticipantsPerSession = guildAnalytics.totalParticipants / guildAnalytics.totalSessions;

    // Update peak usage hours
    const sessionHour = sessionAnalytics.startTime.getHours();
    guildAnalytics.peakUsageHours[sessionHour]++;

    // Update quality trends
    guildAnalytics.qualityTrends[sessionAnalytics.averageQuality]++;

    // Calculate unique users (this would need to be tracked across sessions)
    const allUserIds = new Set<string>();
    for (const userData of this.userData.values()) {
      allUserIds.add(userData.userId);
    }
    guildAnalytics.uniqueUsers = allUserIds.size;

    this.guildData.set(guildId, guildAnalytics);
  }

  private calculateSessionQuality(session: RecordingSession): 'poor' | 'fair' | 'good' | 'excellent' {
    const segments = session.audioSegments;
    if (segments.length === 0) return 'poor';

    const avgAudioLevel = segments.reduce((sum, s) => sum + s.audioLevel, 0) / segments.length;
    
    // Simple quality calculation based on audio level
    if (avgAudioLevel > -15) return 'excellent';
    if (avgAudioLevel > -25) return 'good';
    if (avgAudioLevel > -40) return 'fair';
    return 'poor';
  }

  private calculatePeakConcurrentSpeakers(session: RecordingSession): number {
    // This would require tracking speaking overlaps in real implementation
    return Math.min(session.participants.size, 5); // Reasonable assumption
  }

  private qualityToNumber(quality: 'poor' | 'fair' | 'good' | 'excellent'): number {
    switch (quality) {
      case 'poor': return 1;
      case 'fair': return 2;
      case 'good': return 3;
      case 'excellent': return 4;
      default: return 2;
    }
  }

  private numberToQuality(num: number): 'poor' | 'fair' | 'good' | 'excellent' {
    if (num >= 3.5) return 'excellent';
    if (num >= 2.5) return 'good';
    if (num >= 1.5) return 'fair';
    return 'poor';
  }

  private calculateUserQualityTrend(userId: string): 'improving' | 'stable' | 'declining' {
    const qualityData = this.qualityData.get(userId) || [];
    if (qualityData.length < 5) return 'stable';

    const recent = qualityData.slice(-10);
    const scores = recent.map(q => this.qualityToNumber(q.quality));
    
    const firstHalf = scores.slice(0, Math.floor(scores.length / 2));
    const secondHalf = scores.slice(Math.floor(scores.length / 2));
    
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    const difference = secondAvg - firstAvg;
    
    if (difference > 0.3) return 'improving';
    if (difference < -0.3) return 'declining';
    return 'stable';
  }

  private getSessionsInRange(range: { start: Date; end: Date }): SessionAnalytics[] {
    return Array.from(this.sessionData.values()).filter(session =>
      session.startTime >= range.start && session.startTime <= range.end
    );
  }

  private getUsersInRange(range: { start: Date; end: Date }): UserAnalytics[] {
    return Array.from(this.userData.values()).filter(user =>
      user.lastSeen >= range.start && user.lastSeen <= range.end
    );
  }

  private generateSummaryStats(sessions: SessionAnalytics[]): {
    totalSessions: number;
    totalDuration: number;
    totalUsers: number;
    averageQuality: number;
  } {
    const totalSessions = sessions.length;
    const totalDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
    const uniqueUsers = new Set(sessions.flatMap(s => [
      s.dominantSpeaker?.userId,
      s.quietestParticipant?.userId
    ].filter(Boolean))).size;
    
    const qualityScores = sessions.map(s => this.qualityToNumber(s.averageQuality));
    const averageQuality = qualityScores.length > 0 
      ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
      : 0;

    return {
      totalSessions,
      totalDuration,
      totalUsers: uniqueUsers,
      averageQuality
    };
  }

  private async generateUserAnalytics(
    users: UserAnalytics[], 
    range: { start: Date; end: Date }
  ): Promise<UserAnalytics[]> {
    return users;
  }

  private generateSessionAnalytics(sessions: SessionAnalytics[]): SessionAnalytics[] {
    return sessions;
  }

  private async generateGuildAnalytics(
    guildId: string, 
    range: { start: Date; end: Date }
  ): Promise<GuildAnalytics> {
    return this.guildData.get(guildId) || this.getEmptyGuildAnalytics();
  }

  private getEmptyGuildAnalytics(): GuildAnalytics {
    return {
      guildId: '',
      totalSessions: 0,
      totalDuration: 0,
      totalParticipants: 0,
      uniqueUsers: 0,
      averageSessionDuration: 0,
      averageParticipantsPerSession: 0,
      mostActiveChannel: null,
      mostActiveUser: null,
      qualityTrends: { excellent: 0, good: 0, fair: 0, poor: 0 },
      peakUsageHours: new Array(24).fill(0),
      storageUsed: 0,
      averageAudioQuality: 0
    };
  }

  private generateInsights(
    summary: any,
    userAnalytics: UserAnalytics[],
    sessionAnalytics: SessionAnalytics[]
  ): string[] {
    const insights: string[] = [];

    // Session insights
    if (summary.totalSessions > 0) {
      const avgDuration = summary.totalDuration / summary.totalSessions;
      insights.push(`Average session duration: ${this.formatDuration(avgDuration)}`);
      
      if (avgDuration < 5 * 60 * 1000) {
        insights.push('Sessions are relatively short - consider longer format discussions');
      } else if (avgDuration > 60 * 60 * 1000) {
        insights.push('Sessions are quite long - consider regular breaks for participant comfort');
      }
    }

    // Quality insights
    if (summary.averageQuality < 2.5) {
      insights.push('Audio quality across sessions needs improvement');
    } else if (summary.averageQuality > 3.5) {
      insights.push('Excellent audio quality maintained across sessions');
    }

    // User participation insights
    if (userAnalytics.length > 0) {
      const activeUsers = userAnalytics.filter(u => u.totalSessions >= 5);
      const casualUsers = userAnalytics.filter(u => u.totalSessions < 5);
      
      insights.push(`${activeUsers.length} regular participants, ${casualUsers.length} occasional participants`);
      
      const improvingUsers = userAnalytics.filter(u => u.qualityTrend === 'improving').length;
      const decliningUsers = userAnalytics.filter(u => u.qualityTrend === 'declining').length;
      
      if (improvingUsers > decliningUsers) {
        insights.push('Overall participant audio quality is improving over time');
      } else if (decliningUsers > improvingUsers) {
        insights.push('Some participants are experiencing declining audio quality');
      }
    }

    return insights;
  }

  private generateRecommendations(
    summary: any,
    userAnalytics: UserAnalytics[],
    sessionAnalytics: SessionAnalytics[]
  ): string[] {
    const recommendations: string[] = [];

    // Quality recommendations
    if (summary.averageQuality < 2.5) {
      recommendations.push('Consider providing audio setup guides to participants');
      recommendations.push('Enable audio processing features to improve quality automatically');
    }

    // Participation recommendations
    const quietUsers = userAnalytics.filter(u => 
      u.averageSpeakingTime < 30000 && u.totalSessions >= 3
    );
    
    if (quietUsers.length > 0) {
      recommendations.push(`${quietUsers.length} users may benefit from encouragement to participate more actively`);
    }

    // Technical recommendations
    const usersWithIssues = userAnalytics.filter(u => 
      u.commonIssues.length > 0 && u.commonIssues[0].count >= 3
    );
    
    if (usersWithIssues.length > 0) {
      recommendations.push('Provide technical support to users experiencing recurring audio issues');
    }

    // Session structure recommendations
    const longSessions = sessionAnalytics.filter(s => s.duration > 90 * 60 * 1000);
    if (longSessions.length > sessionAnalytics.length * 0.3) {
      recommendations.push('Consider shorter session formats or scheduled breaks for sessions over 90 minutes');
    }

    return recommendations;
  }

  private async exportReport(report: AnalyticsReport): Promise<void> {
    try {
      const timestamp = report.generatedAt.toISOString().split('T')[0];
      const filename = `analytics_report_${timestamp}_${report.reportId}`;
      
      if (this.configuration.exportFormat === 'json' || this.configuration.exportFormat === 'both') {
        const jsonPath = path.join(this.configuration.exportDirectory, `${filename}.json`);
        await fs.promises.writeFile(jsonPath, JSON.stringify(report, null, 2));
      }

      if (this.configuration.exportFormat === 'csv' || this.configuration.exportFormat === 'both') {
        const csvPath = path.join(this.configuration.exportDirectory, `${filename}.csv`);
        const csvData = this.convertReportToCSV(report);
        await fs.promises.writeFile(csvPath, csvData);
      }

      logger.debug('Analytics report exported', {
        reportId: report.reportId,
        format: this.configuration.exportFormat,
        directory: this.configuration.exportDirectory
      });

    } catch (error) {
      logger.error('Failed to export analytics report:', error);
    }
  }

  private convertReportToCSV(report: AnalyticsReport): string {
    // Simple CSV conversion for user analytics
    const headers = [
      'User ID', 'Username', 'Total Sessions', 'Total Speaking Time (ms)',
      'Average Speaking Time (ms)', 'Average Quality', 'Quality Trend', 'Last Seen'
    ];
    
    const rows = report.userAnalytics.map(user => [
      user.userId,
      user.username,
      user.totalSessions.toString(),
      user.totalSpeakingTime.toString(),
      user.averageSpeakingTime.toString(),
      user.averageQuality,
      user.qualityTrend,
      user.lastSeen.toISOString()
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }

  private formatDuration(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else {
      return `${minutes}m ${seconds % 60}s`;
    }
  }

  private generateReportId(): string {
    return `rpt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private startPeriodicReporting(): void {
    this.analyticsTimer = setInterval(async () => {
      try {
        await this.generateReport();
      } catch (error) {
        logger.error('Error in periodic report generation:', error);
      }
    }, this.configuration.reportGenerationInterval);

    logger.debug('Periodic analytics reporting started', {
      interval: this.configuration.reportGenerationInterval
    });
  }

  private async loadAnalyticsData(): Promise<void> {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = await import('path');
      
      const dataPath = path.join(this.storageLocation, 'analytics.json');
      try {
        await fs.access(dataPath);
        const data = await fs.readFile(dataPath, 'utf8');
        const parsedData = JSON.parse(data);
        
        // Restore analytics data from file
        this.analytics.sessionMetrics = parsedData.sessionMetrics || {};
        this.analytics.userMetrics = parsedData.userMetrics || {};
        this.analytics.qualityMetrics = parsedData.qualityMetrics || {};
        this.analytics.performanceMetrics = parsedData.performanceMetrics || {};
        
        logger.debug('Analytics data loaded successfully', { 
          sessions: Object.keys(this.analytics.sessionMetrics).length,
          users: Object.keys(this.analytics.userMetrics).length 
        });
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        logger.debug('No existing analytics data found, starting fresh');
      }
    } catch (error) {
      logger.error('Failed to load analytics data:', error);
    }
  }

  private async saveAnalyticsData(): Promise<void> {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = await import('path');
      
      // Ensure storage directory exists
      await fs.mkdir(this.storageLocation, { recursive: true });
      
      const dataPath = path.join(this.storageLocation, 'analytics.json');
      const dataToSave = {
        sessionMetrics: this.analytics.sessionMetrics,
        userMetrics: this.analytics.userMetrics,
        qualityMetrics: this.analytics.qualityMetrics,
        performanceMetrics: this.analytics.performanceMetrics,
        lastSaved: new Date().toISOString()
      };
      
      await fs.writeFile(dataPath, JSON.stringify(dataToSave, null, 2), 'utf8');
      
      logger.debug('Analytics data saved successfully', {
        path: dataPath,
        size: JSON.stringify(dataToSave).length
      });
    } catch (error) {
      logger.error('Failed to save analytics data:', error);
    }
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up recording analytics');

    try {
      // Stop periodic reporting
      if (this.analyticsTimer) {
        clearInterval(this.analyticsTimer);
        this.analyticsTimer = null;
      }

      // Save current data
      await this.saveAnalyticsData();

      // Clear memory
      this.sessionData.clear();
      this.userData.clear();
      this.guildData.clear();
      this.qualityData.clear();
      this.alertData.clear();
      this.reportHistory.length = 0;

      logger.info('Recording analytics cleanup completed');

    } catch (error) {
      logger.error('Error during analytics cleanup:', error);
      throw error;
    }
  }
}

export default RecordingAnalytics;