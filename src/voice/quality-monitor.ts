import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import AudioAnalyzer, { AudioQualityMetrics, SpeakerActivity } from './audio-analyzer';
import { RecordingSession } from './multitrack-recorder';

const logger = createLogger('QualityMonitor');

export interface QualityAlert {
  id: string;
  userId: string;
  username: string;
  sessionId: string;
  alertType: QualityAlertType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  timestamp: Date;
  metrics: Partial<AudioQualityMetrics>;
  suggestions: string[];
}

export enum QualityAlertType {
  LOW_AUDIO_LEVEL = 'low_audio_level',
  HIGH_AUDIO_LEVEL = 'high_audio_level',
  POOR_SIGNAL_QUALITY = 'poor_signal_quality',
  EXCESSIVE_CLIPPING = 'excessive_clipping',
  HIGH_NOISE_LEVEL = 'high_noise_level',
  POOR_CLARITY = 'poor_clarity',
  MICROPHONE_ISSUE = 'microphone_issue',
  CONNECTION_ISSUE = 'connection_issue',
  SILENCE_DETECTED = 'silence_detected'
}

export interface QualityThresholds {
  minAudioLevel: number; // dB
  maxAudioLevel: number; // dB
  minSignalToNoise: number; // dB
  maxClipCount: number;
  minClarity: number; // 0-1
  maxSilenceRatio: number; // 0-1
  alertCooldown: number; // ms between same-type alerts
}

export interface QualityReport {
  sessionId: string;
  guildId: string;
  reportTimestamp: Date;
  overallQuality: 'excellent' | 'good' | 'fair' | 'poor';
  participantCount: number;
  averageQuality: AudioQualityMetrics;
  participantQualities: Map<string, AudioQualityMetrics>;
  alerts: QualityAlert[];
  recommendations: string[];
  qualityTrend: 'improving' | 'stable' | 'declining';
}

export interface MonitoringConfiguration {
  enabled: boolean;
  monitoringInterval: number; // ms
  alertThresholds: QualityThresholds;
  reportingInterval: number; // ms
  maxAlertsPerUser: number;
  maxHistorySize: number;
  enablePredictiveAlerts: boolean;
}

export class QualityMonitor extends EventEmitter {
  private configuration: MonitoringConfiguration;
  private audioAnalyzer: AudioAnalyzer;
  private monitoringTimer: NodeJS.Timeout | null = null;
  private reportingTimer: NodeJS.Timeout | null = null;
  
  // Alert management
  private activeAlerts: Map<string, QualityAlert> = new Map();
  private alertHistory: QualityAlert[] = [];
  private lastAlertTime: Map<string, Map<QualityAlertType, number>> = new Map(); // userId -> alertType -> timestamp
  
  // Quality tracking
  private qualityHistory: Map<string, AudioQualityMetrics[]> = new Map(); // userId -> metrics history
  private sessionReports: QualityReport[] = [];
  
  // Trend analysis
  private readonly historyWindow = 10; // Number of measurements for trend analysis

  constructor(audioAnalyzer: AudioAnalyzer, configuration?: Partial<MonitoringConfiguration>) {
    super();
    
    this.audioAnalyzer = audioAnalyzer;
    this.configuration = {
      enabled: true,
      monitoringInterval: 10000, // 10 seconds
      alertThresholds: {
        minAudioLevel: -40, // dB
        maxAudioLevel: -6, // dB
        minSignalToNoise: 15, // dB
        maxClipCount: 50,
        minClarity: 0.6, // 60%
        maxSilenceRatio: 0.8, // 80%
        alertCooldown: 30000 // 30 seconds
      },
      reportingInterval: 60000, // 1 minute
      maxAlertsPerUser: 5,
      maxHistorySize: 100,
      enablePredictiveAlerts: true,
      ...configuration
    };

    this.startMonitoring();
  }

  /**
   * Start quality monitoring
   */
  public startMonitoring(): void {
    if (!this.configuration.enabled) {
      logger.info('Quality monitoring is disabled');
      return;
    }

    // Start monitoring timer
    this.monitoringTimer = setInterval(() => {
      this.performQualityCheck();
    }, this.configuration.monitoringInterval);

    // Start reporting timer
    this.reportingTimer = setInterval(() => {
      this.generateQualityReport();
    }, this.configuration.reportingInterval);

    logger.info('Quality monitoring started', {
      monitoringInterval: this.configuration.monitoringInterval,
      reportingInterval: this.configuration.reportingInterval
    });
  }

  /**
   * Stop quality monitoring
   */
  public stopMonitoring(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
    }

    if (this.reportingTimer) {
      clearInterval(this.reportingTimer);
      this.reportingTimer = null;
    }

    logger.info('Quality monitoring stopped');
  }

  /**
   * Monitor a recording session
   */
  public monitorSession(session: RecordingSession): void {
    logger.info('Starting session monitoring', {
      sessionId: session.sessionId,
      participants: session.participants.size
    });

    // Initialize quality tracking for all participants
    for (const [userId, userTrack] of session.participants) {
      if (!this.qualityHistory.has(userId)) {
        this.qualityHistory.set(userId, []);
      }

      if (!this.lastAlertTime.has(userId)) {
        this.lastAlertTime.set(userId, new Map());
      }
    }

    this.emit('session-monitoring-started', session.sessionId);
  }

  /**
   * Update audio quality metrics for a user
   */
  public updateUserQuality(userId: string, audioData: Buffer): void {
    try {
      const quality = this.audioAnalyzer.analyzeAudioQuality(userId, audioData);
      
      // Add to history
      if (!this.qualityHistory.has(userId)) {
        this.qualityHistory.set(userId, []);
      }
      
      const history = this.qualityHistory.get(userId)!;
      history.push(quality);
      
      // Limit history size
      if (history.length > this.configuration.maxHistorySize) {
        history.shift();
      }

      // Check for quality issues
      this.checkQualityThresholds(quality);

      // Predictive alerts if enabled
      if (this.configuration.enablePredictiveAlerts) {
        this.checkPredictiveAlerts(userId, history);
      }

    } catch (error) {
      logger.error('Error updating user quality:', error);
    }
  }

  /**
   * Get current quality status for all users
   */
  public getQualityStatus(): Map<string, AudioQualityMetrics> {
    const status = new Map<string, AudioQualityMetrics>();
    
    for (const [userId, history] of this.qualityHistory) {
      if (history.length > 0) {
        status.set(userId, history[history.length - 1]);
      }
    }
    
    return status;
  }

  /**
   * Get active alerts
   */
  public getActiveAlerts(): QualityAlert[] {
    return Array.from(this.activeAlerts.values());
  }

  /**
   * Get alert history
   */
  public getAlertHistory(userId?: string): QualityAlert[] {
    if (userId) {
      return this.alertHistory.filter(alert => alert.userId === userId);
    }
    return [...this.alertHistory];
  }

  /**
   * Get quality report for a session
   */
  public getSessionReport(sessionId: string): QualityReport | null {
    return this.sessionReports.find(report => report.sessionId === sessionId) || null;
  }

  /**
   * Get quality trends for a user
   */
  public getQualityTrend(userId: string): 'improving' | 'stable' | 'declining' | 'unknown' {
    const history = this.qualityHistory.get(userId);
    if (!history || history.length < 3) {
      return 'unknown';
    }

    const recent = history.slice(-this.historyWindow);
    const scores = recent.map(this.calculateQualityScore);
    
    if (scores.length < 3) return 'unknown';

    // Calculate trend using linear regression
    const trend = this.calculateTrend(scores);
    
    if (trend > 0.05) return 'improving';
    if (trend < -0.05) return 'declining';
    return 'stable';
  }

  // Private methods

  private performQualityCheck(): void {
    const qualities = this.audioAnalyzer.getAllAudioQualities();
    const activities = this.audioAnalyzer.getAllSpeakerActivities();

    for (const quality of qualities) {
      this.checkQualityThresholds(quality);
    }

    for (const activity of activities) {
      this.checkActivityIssues(activity);
    }

    logger.debug('Quality check performed', {
      qualitiesChecked: qualities.length,
      activitiesChecked: activities.length,
      activeAlerts: this.activeAlerts.size
    });
  }

  private checkQualityThresholds(quality: AudioQualityMetrics): void {
    const { alertThresholds } = this.configuration;
    const userId = quality.userId;

    // Check audio level
    if (quality.audioLevel < alertThresholds.minAudioLevel) {
      this.createAlert(userId, QualityAlertType.LOW_AUDIO_LEVEL, 'medium', {
        message: `Audio level too low: ${quality.audioLevel.toFixed(1)} dB`,
        metrics: { audioLevel: quality.audioLevel },
        suggestions: [
          'Move closer to your microphone',
          'Increase microphone sensitivity',
          'Check microphone connections'
        ]
      });
    } else if (quality.audioLevel > alertThresholds.maxAudioLevel) {
      this.createAlert(userId, QualityAlertType.HIGH_AUDIO_LEVEL, 'medium', {
        message: `Audio level too high: ${quality.audioLevel.toFixed(1)} dB`,
        metrics: { audioLevel: quality.audioLevel },
        suggestions: [
          'Move away from your microphone',
          'Reduce microphone gain',
          'Lower your speaking volume'
        ]
      });
    }

    // Check signal-to-noise ratio
    if (quality.signalToNoiseRatio < alertThresholds.minSignalToNoise) {
      this.createAlert(userId, QualityAlertType.HIGH_NOISE_LEVEL, 'high', {
        message: `High noise level detected: ${quality.signalToNoiseRatio.toFixed(1)} dB SNR`,
        metrics: { signalToNoiseRatio: quality.signalToNoiseRatio },
        suggestions: [
          'Use noise cancellation if available',
          'Move to a quieter environment',
          'Check for electrical interference',
          'Use a directional microphone'
        ]
      });
    }

    // Check clipping
    if (quality.clipCount > alertThresholds.maxClipCount) {
      this.createAlert(userId, QualityAlertType.EXCESSIVE_CLIPPING, 'high', {
        message: `Audio clipping detected: ${quality.clipCount} samples`,
        metrics: { clipCount: quality.clipCount },
        suggestions: [
          'Reduce microphone gain',
          'Lower your speaking volume',
          'Move away from microphone',
          'Check audio drivers'
        ]
      });
    }

    // Check clarity
    if (quality.clarity < alertThresholds.minClarity) {
      this.createAlert(userId, QualityAlertType.POOR_CLARITY, 'medium', {
        message: `Poor audio clarity: ${(quality.clarity * 100).toFixed(0)}%`,
        metrics: { clarity: quality.clarity },
        suggestions: [
          'Speak more clearly',
          'Reduce background noise',
          'Check microphone quality',
          'Improve internet connection'
        ]
      });
    }

    // Check silence ratio
    if (quality.silenceRatio > alertThresholds.maxSilenceRatio) {
      this.createAlert(userId, QualityAlertType.SILENCE_DETECTED, 'low', {
        message: `Excessive silence detected: ${(quality.silenceRatio * 100).toFixed(0)}%`,
        metrics: { silenceRatio: quality.silenceRatio },
        suggestions: [
          'Check microphone mute status',
          'Verify microphone is working',
          'Speak louder or closer to microphone'
        ]
      });
    }

    // Overall quality check
    if (quality.quality === 'poor') {
      this.createAlert(userId, QualityAlertType.POOR_SIGNAL_QUALITY, 'high', {
        message: 'Overall audio quality is poor',
        metrics: quality,
        suggestions: [
          'Check all audio settings',
          'Restart audio drivers',
          'Test microphone in other applications',
          'Contact technical support if issues persist'
        ]
      });
    }
  }

  private checkActivityIssues(activity: SpeakerActivity): void {
    const userId = activity.userId;

    // Check for microphone issues based on activity patterns
    if (activity.isSpeaking && activity.audioLevel < -50) {
      this.createAlert(userId, QualityAlertType.MICROPHONE_ISSUE, 'high', {
        message: 'Possible microphone malfunction detected',
        metrics: { audioLevel: activity.audioLevel },
        suggestions: [
          'Check microphone connection',
          'Test microphone in system settings',
          'Try a different microphone',
          'Restart audio services'
        ]
      });
    }

    // Check for connection issues based on confidence
    if (activity.confidence < 0.3) {
      this.createAlert(userId, QualityAlertType.CONNECTION_ISSUE, 'medium', {
        message: 'Possible connection issues affecting audio quality',
        metrics: { confidence: activity.confidence },
        suggestions: [
          'Check internet connection stability',
          'Close bandwidth-heavy applications',
          'Switch to a wired connection if possible',
          'Contact your ISP if issues persist'
        ]
      });
    }
  }

  private checkPredictiveAlerts(userId: string, history: AudioQualityMetrics[]): void {
    if (history.length < 5) return;

    const recent = history.slice(-5);
    const scores = recent.map(this.calculateQualityScore);
    
    // Predict quality degradation
    const trend = this.calculateTrend(scores);
    if (trend < -0.1) { // Significant downward trend
      this.createAlert(userId, QualityAlertType.POOR_SIGNAL_QUALITY, 'low', {
        message: 'Audio quality appears to be declining',
        metrics: recent[recent.length - 1],
        suggestions: [
          'Check your setup for any recent changes',
          'Monitor your connection stability',
          'Consider adjusting audio settings'
        ]
      });
    }
  }

  private createAlert(
    userId: string,
    alertType: QualityAlertType,
    severity: 'low' | 'medium' | 'high' | 'critical',
    options: {
      message: string;
      metrics: Partial<AudioQualityMetrics>;
      suggestions: string[];
    }
  ): void {
    // Check cooldown
    const userAlerts = this.lastAlertTime.get(userId) || new Map();
    const lastAlert = userAlerts.get(alertType) || 0;
    const now = Date.now();
    
    if (now - lastAlert < this.configuration.alertThresholds.alertCooldown) {
      return; // Still in cooldown
    }

    // Check max alerts per user
    const userActiveAlerts = Array.from(this.activeAlerts.values()).filter(
      alert => alert.userId === userId
    );
    
    if (userActiveAlerts.length >= this.configuration.maxAlertsPerUser) {
      return; // Too many active alerts for this user
    }

    // Get username from analyzer
    const activity = this.audioAnalyzer.getSpeakerActivity(userId);
    const username = activity?.username || 'Unknown User';

    const alert: QualityAlert = {
      id: this.generateAlertId(),
      userId,
      username,
      sessionId: '', // Will be set by session monitor
      alertType,
      severity,
      message: options.message,
      timestamp: new Date(),
      metrics: options.metrics,
      suggestions: options.suggestions
    };

    // Add to active alerts
    this.activeAlerts.set(alert.id, alert);
    
    // Add to history
    this.alertHistory.push(alert);
    if (this.alertHistory.length > this.configuration.maxHistorySize) {
      this.alertHistory.shift();
    }

    // Update last alert time
    userAlerts.set(alertType, now);
    this.lastAlertTime.set(userId, userAlerts);

    logger.info('Quality alert created', {
      alertId: alert.id,
      userId,
      username,
      alertType,
      severity,
      message: options.message
    });

    this.emit('quality-alert', alert);
  }

  private generateQualityReport(): void {
    const qualities = this.getQualityStatus();
    if (qualities.size === 0) return;

    const qualityArray = Array.from(qualities.values());
    const averageQuality = this.calculateAverageQuality(qualityArray);
    const overallQuality = this.determineOverallQuality(qualityArray);

    const report: QualityReport = {
      sessionId: '', // Will be set by session monitor
      guildId: '', // Will be set by session monitor
      reportTimestamp: new Date(),
      overallQuality,
      participantCount: qualities.size,
      averageQuality,
      participantQualities: qualities,
      alerts: this.getActiveAlerts(),
      recommendations: this.generateRecommendations(qualityArray),
      qualityTrend: this.calculateOverallTrend()
    };

    this.sessionReports.push(report);
    if (this.sessionReports.length > this.configuration.maxHistorySize) {
      this.sessionReports.shift();
    }

    logger.debug('Quality report generated', {
      participantCount: report.participantCount,
      overallQuality: report.overallQuality,
      activeAlerts: report.alerts.length
    });

    this.emit('quality-report', report);
  }

  private calculateQualityScore(quality: AudioQualityMetrics): number {
    // Convert quality metrics to a 0-1 score
    const levelScore = this.normalizeAudioLevel(quality.audioLevel);
    const snrScore = Math.min(quality.signalToNoiseRatio / 40, 1);
    const clarityScore = quality.clarity;
    const silenceScore = 1 - quality.silenceRatio;
    
    return (levelScore + snrScore + clarityScore + silenceScore) / 4;
  }

  private normalizeAudioLevel(level: number): number {
    // Normalize audio level to 0-1 score (optimal range: -30 to -10 dB)
    if (level >= -10) return 0.8; // Too loud
    if (level <= -50) return 0.2; // Too quiet
    if (level >= -30 && level <= -10) return 1.0; // Optimal
    if (level < -30) return 0.2 + 0.8 * ((level + 50) / 20); // Quiet but acceptable
    return 0.8; // Fallback
  }

  private calculateTrend(scores: number[]): number {
    if (scores.length < 2) return 0;

    const n = scores.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += scores[i];
      sumXY += i * scores[i];
      sumXX += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope;
  }

  private calculateAverageQuality(qualities: AudioQualityMetrics[]): AudioQualityMetrics {
    if (qualities.length === 0) {
      return {
        userId: 'average',
        audioLevel: -Infinity,
        signalToNoiseRatio: 0,
        dynamicRange: 0,
        clipCount: 0,
        silenceRatio: 1,
        frequencyResponse: new Array(8).fill(0),
        clarity: 0,
        quality: 'poor'
      };
    }

    const avg = qualities.reduce((acc, quality) => ({
      userId: 'average',
      audioLevel: acc.audioLevel + quality.audioLevel / qualities.length,
      signalToNoiseRatio: acc.signalToNoiseRatio + quality.signalToNoiseRatio / qualities.length,
      dynamicRange: acc.dynamicRange + quality.dynamicRange / qualities.length,
      clipCount: acc.clipCount + quality.clipCount / qualities.length,
      silenceRatio: acc.silenceRatio + quality.silenceRatio / qualities.length,
      frequencyResponse: acc.frequencyResponse.map((val, i) => 
        val + quality.frequencyResponse[i] / qualities.length
      ),
      clarity: acc.clarity + quality.clarity / qualities.length,
      quality: 'good' as 'poor' | 'fair' | 'good' | 'excellent'
    }), {
      userId: 'average',
      audioLevel: 0,
      signalToNoiseRatio: 0,
      dynamicRange: 0,
      clipCount: 0,
      silenceRatio: 0,
      frequencyResponse: new Array(8).fill(0),
      clarity: 0,
      quality: 'good' as 'poor' | 'fair' | 'good' | 'excellent'
    });

    // Determine overall quality
    const score = this.calculateQualityScore(avg);
    if (score > 0.8) avg.quality = 'excellent';
    else if (score > 0.6) avg.quality = 'good';
    else if (score > 0.4) avg.quality = 'fair';
    else avg.quality = 'poor';

    return avg;
  }

  private determineOverallQuality(qualities: AudioQualityMetrics[]): 'excellent' | 'good' | 'fair' | 'poor' {
    if (qualities.length === 0) return 'poor';

    const scores = qualities.map(this.calculateQualityScore.bind(this));
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    if (avgScore > 0.8) return 'excellent';
    if (avgScore > 0.6) return 'good';
    if (avgScore > 0.4) return 'fair';
    return 'poor';
  }

  private calculateOverallTrend(): 'improving' | 'stable' | 'declining' {
    if (this.sessionReports.length < 3) return 'stable';

    const recent = this.sessionReports.slice(-5);
    const scores = recent.map(report => this.calculateQualityScore(report.averageQuality));
    const trend = this.calculateTrend(scores);

    if (trend > 0.05) return 'improving';
    if (trend < -0.05) return 'declining';
    return 'stable';
  }

  private generateRecommendations(qualities: AudioQualityMetrics[]): string[] {
    const recommendations: string[] = [];
    const issues = new Set<string>();

    for (const quality of qualities) {
      if (quality.audioLevel < -40) issues.add('low_audio');
      if (quality.audioLevel > -6) issues.add('high_audio');
      if (quality.signalToNoiseRatio < 15) issues.add('noise');
      if (quality.clipCount > 50) issues.add('clipping');
      if (quality.clarity < 0.6) issues.add('clarity');
      if (quality.silenceRatio > 0.8) issues.add('silence');
    }

    if (issues.has('low_audio')) {
      recommendations.push('Some participants have low audio levels - encourage them to move closer to their microphones');
    }

    if (issues.has('high_audio')) {
      recommendations.push('Some participants have audio levels that are too high - suggest reducing microphone gain');
    }

    if (issues.has('noise')) {
      recommendations.push('Background noise is affecting call quality - recommend using noise cancellation or quieter environments');
    }

    if (issues.has('clipping')) {
      recommendations.push('Audio clipping detected - participants should reduce their microphone gain or speaking volume');
    }

    if (issues.has('clarity')) {
      recommendations.push('Poor audio clarity detected - check microphone quality and connection stability');
    }

    if (issues.has('silence')) {
      recommendations.push('High silence ratios detected - verify all participants\' microphones are working properly');
    }

    if (recommendations.length === 0) {
      recommendations.push('Audio quality is good across all participants');
    }

    return recommendations;
  }

  private generateAlertId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  public cleanup(): void {
    logger.info('Cleaning up quality monitor');

    this.stopMonitoring();
    this.activeAlerts.clear();
    this.alertHistory.length = 0;
    this.lastAlertTime.clear();
    this.qualityHistory.clear();
    this.sessionReports.length = 0;

    logger.info('Quality monitor cleanup completed');
  }
}

export default QualityMonitor;