import 'dotenv/config';
import { createLogger } from '../src/utils/logger';
import { config } from '../src/config/environment';
import OpenAIClient from '../src/summarization/openai-client';
import MeetingSummarizer from '../src/summarization/meeting-summarizer';
import PDFGenerator from '../src/summarization/pdf-generator';
import CostTracker from '../src/summarization/cost-tracker';
import SummarizationErrorHandler from '../src/summarization/error-handler';
import TranscriptManager from '../src/transcription/transcript-manager';
import { MeetingSummaryReport } from '../src/summarization/meeting-summarizer';

const logger = createLogger('SummarizationTest');

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  metadata?: Record<string, any>;
}

class SummarizationTestSuite {
  private results: TestResult[] = [];
  private openAIClient: OpenAIClient | null = null;
  private transcriptManager: TranscriptManager | null = null;
  private meetingSummarizer: MeetingSummarizer | null = null;
  private pdfGenerator: PDFGenerator | null = null;
  private costTracker: CostTracker | null = null;
  private errorHandler: SummarizationErrorHandler | null = null;

  constructor() {
    logger.info('Initializing summarization test suite');
  }

  public async runAllTests(): Promise<{ passed: number; failed: number; results: TestResult[] }> {
    logger.info('Starting comprehensive summarization system tests');

    // Environment tests
    await this.testEnvironmentConfiguration();
    
    // Component initialization tests
    await this.testOpenAIClientInitialization();
    await this.testTranscriptManagerInitialization();
    await this.testPDFGeneratorInitialization();
    await this.testCostTrackerInitialization();
    await this.testErrorHandlerInitialization();
    
    // Integration tests
    await this.testMeetingSummarizerInitialization();
    
    // Functional tests (only if OpenAI key is available)
    if (config.openAiApiKey) {
      await this.testOpenAIConnection();
      await this.testBasicSummarization();
      await this.testPDFGeneration();
      await this.testCostTracking();
      await this.testErrorHandling();
    } else {
      logger.warn('Skipping functional tests - OpenAI API key not configured');
    }

    // Performance tests
    await this.testPerformanceMetrics();
    
    // Cleanup tests
    await this.testCleanup();

    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;

    logger.info('Test suite completed', {
      total: this.results.length,
      passed,
      failed,
      successRate: `${((passed / this.results.length) * 100).toFixed(1)}%`
    });

    return { passed, failed, results: this.results };
  }

  private async runTest(name: string, testFunction: () => Promise<void>): Promise<void> {
    const startTime = Date.now();
    
    try {
      await testFunction();
      const duration = Date.now() - startTime;
      
      this.results.push({
        name,
        passed: true,
        duration
      });
      
      logger.info(`✅ ${name} (${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      this.results.push({
        name,
        passed: false,
        duration,
        error: errorMessage
      });
      
      logger.error(`❌ ${name} (${duration}ms): ${errorMessage}`);
    }
  }

  private async testEnvironmentConfiguration(): Promise<void> {
    await this.runTest('Environment Configuration', async () => {
      // Test required environment variables
      if (!config.discordToken) {
        throw new Error('DISCORD_TOKEN not configured');
      }
      
      if (!config.clientId) {
        throw new Error('DISCORD_CLIENT_ID not configured');
      }

      // Test optional but recommended variables
      if (!config.openAiApiKey) {
        logger.warn('OPENAI_API_KEY not configured - summarization features will be limited');
      }

      if (!config.assemblyAiApiKey) {
        logger.warn('ASSEMBLY_AI_API_KEY not configured - transcription features will be limited');
      }

      logger.debug('Environment configuration validated');
    });
  }

  private async testOpenAIClientInitialization(): Promise<void> {
    await this.runTest('OpenAI Client Initialization', async () => {
      if (!config.openAiApiKey) {
        throw new Error('OpenAI API key required for this test');
      }

      this.openAIClient = new OpenAIClient(config.openAiApiKey);
      
      // Test basic configuration
      const stats = this.openAIClient.getUsageStats();
      if (typeof stats.totalCost !== 'number') {
        throw new Error('Invalid usage stats structure');
      }

      logger.debug('OpenAI client initialized successfully');
    });
  }

  private async testTranscriptManagerInitialization(): Promise<void> {
    await this.runTest('Transcript Manager Initialization', async () => {
      this.transcriptManager = new TranscriptManager('./test-transcripts');
      
      // Test basic functionality
      const sessionCount = this.transcriptManager.getSessionCount();
      if (typeof sessionCount !== 'number') {
        throw new Error('Invalid session count');
      }

      logger.debug('Transcript manager initialized successfully');
    });
  }

  private async testPDFGeneratorInitialization(): Promise<void> {
    await this.runTest('PDF Generator Initialization', async () => {
      this.pdfGenerator = new PDFGenerator('./test-reports');
      
      // Test branding configuration
      this.pdfGenerator.setDefaultBranding({
        companyName: 'Test Company',
        primaryColor: '#FF0000'
      });

      logger.debug('PDF generator initialized successfully');
    });
  }

  private async testCostTrackerInitialization(): Promise<void> {
    await this.runTest('Cost Tracker Initialization', async () => {
      this.costTracker = new CostTracker('./test-costs', {
        dailyLimit: 1.0,
        sessionLimit: 0.5
      });
      
      // Test basic functionality
      const limits = this.costTracker.getLimits();
      if (limits.dailyLimit !== 1.0) {
        throw new Error('Cost limits not set correctly');
      }

      logger.debug('Cost tracker initialized successfully');
    });
  }

  private async testErrorHandlerInitialization(): Promise<void> {
    await this.runTest('Error Handler Initialization', async () => {
      this.errorHandler = new SummarizationErrorHandler({
        maxAttempts: 2,
        baseDelayMs: 500
      });
      
      // Test error classification
      const testError = new Error('Rate limit exceeded');
      const classification = this.errorHandler.classifyError(testError);
      
      if (classification.type !== 'rate_limit') {
        throw new Error('Error classification not working correctly');
      }

      logger.debug('Error handler initialized successfully');
    });
  }

  private async testMeetingSummarizerInitialization(): Promise<void> {
    await this.runTest('Meeting Summarizer Initialization', async () => {
      if (!this.transcriptManager || !this.openAIClient) {
        throw new Error('Dependencies not initialized');
      }

      this.meetingSummarizer = new MeetingSummarizer(
        this.transcriptManager,
        this.openAIClient,
        {
          segmentSummaryInterval: 10000, // 10 seconds for testing
          costLimit: 0.5
        }
      );
      
      // Test basic functionality
      const stats = this.meetingSummarizer.getUsageStats();
      if (typeof stats.sessions !== 'object') {
        throw new Error('Invalid usage stats structure');
      }

      logger.debug('Meeting summarizer initialized successfully');
    });
  }

  private async testOpenAIConnection(): Promise<void> {
    await this.runTest('OpenAI Connection Test', async () => {
      if (!this.openAIClient) {
        throw new Error('OpenAI client not initialized');
      }

      const connectionOk = await this.openAIClient.testConnection();
      if (!connectionOk) {
        throw new Error('OpenAI connection test failed');
      }

      logger.debug('OpenAI connection verified');
    });
  }

  private async testBasicSummarization(): Promise<void> {
    await this.runTest('Basic Summarization', async () => {
      if (!this.openAIClient) {
        throw new Error('OpenAI client not initialized');
      }

      // Create mock transcript data
      const mockTranscripts = [
        {
          text: 'Welcome everyone to today\'s project meeting. Let\'s start by reviewing our progress.',
          confidence: 0.95,
          created: new Date(),
          audioStart: 0,
          audioEnd: 3000
        },
        {
          text: 'The development team has completed the user authentication module.',
          confidence: 0.92,
          created: new Date(),
          audioStart: 3000,
          audioEnd: 6000
        },
        {
          text: 'We need to schedule testing for next week. John, can you coordinate with the QA team?',
          confidence: 0.89,
          created: new Date(),
          audioStart: 6000,
          audioEnd: 9000
        }
      ];

      const result = await this.openAIClient.summarizeTranscripts(
        mockTranscripts,
        { type: 'interim', maxLength: 200 }
      );

      if (!result.summary || result.summary.length === 0) {
        throw new Error('No summary generated');
      }

      if (result.keyPoints.length === 0) {
        throw new Error('No key points extracted');
      }

      if (result.cost <= 0) {
        throw new Error('Invalid cost calculation');
      }

      logger.debug('Basic summarization completed', {
        summaryLength: result.summary.length,
        keyPoints: result.keyPoints.length,
        cost: result.cost
      });
    });
  }

  private async testPDFGeneration(): Promise<void> {
    await this.runTest('PDF Generation', async () => {
      if (!this.pdfGenerator) {
        throw new Error('PDF generator not initialized');
      }

      // Create mock meeting report
      const mockReport: MeetingSummaryReport = {
        sessionId: 'test-session-123',
        meetingTitle: 'Test Meeting',
        startTime: new Date(Date.now() - 3600000), // 1 hour ago
        endTime: new Date(),
        duration: 3600000, // 1 hour
        participants: ['Alice', 'Bob', 'Charlie'],
        executiveSummary: 'This was a productive meeting discussing project milestones and upcoming deliverables.',
        keyDiscussions: [
          'Reviewed current project status',
          'Discussed resource allocation',
          'Planned next sprint activities'
        ],
        decisions: [
          {
            id: 'decision-1',
            description: 'Sprint duration',
            outcome: 'Decided on 2-week sprints',
            rationale: 'Better for team productivity',
            participants: ['Alice', 'Bob'],
            timestamp: new Date().toISOString(),
            confidence: 0.9
          }
        ],
        actionItems: [
          {
            id: 'action-1',
            description: 'Update project timeline',
            assignee: 'Alice',
            priority: 'high',
            context: 'Following sprint planning',
            confidence: 0.95
          }
        ],
        nextSteps: [
          'Begin sprint 1 development',
          'Schedule weekly check-ins'
        ],
        attachments: [],
        metadata: {
          segmentCount: 5,
          totalTranscripts: 25,
          totalWords: 450,
          averageConfidence: 0.92,
          summarizationCost: 0.15,
          processingTime: 2500,
          qualityScore: 87
        }
      };

      const result = await this.pdfGenerator.generateReport(mockReport, {
        template: 'compact',
        includeCover: false
      });

      if (!result.filePath || !result.fileName) {
        throw new Error('PDF file not generated');
      }

      if (result.fileSize <= 0) {
        throw new Error('Invalid PDF file size');
      }

      logger.debug('PDF generation completed', {
        fileName: result.fileName,
        fileSize: result.fileSize,
        generationTime: result.generationTime
      });
    });
  }

  private async testCostTracking(): Promise<void> {
    await this.runTest('Cost Tracking', async () => {
      if (!this.costTracker) {
        throw new Error('Cost tracker not initialized');
      }

      // Track some test costs
      await this.costTracker.trackCost({
        sessionId: 'test-session',
        service: 'openai',
        operation: 'summarization',
        tokens: 1500,
        cost: 0.003,
        model: 'gpt-4o-mini'
      });

      await this.costTracker.trackCost({
        sessionId: 'test-session',
        service: 'openai',
        operation: 'summarization',
        tokens: 2000,
        cost: 0.004,
        model: 'gpt-4o-mini'
      });

      // Test cost summaries
      const dailyCosts = this.costTracker.getDailyCosts();
      if (dailyCosts.totalCost <= 0) {
        throw new Error('Daily costs not tracked correctly');
      }

      const sessionCosts = this.costTracker.getSessionCosts('test-session');
      if (sessionCosts.totalTokens !== 3500) {
        throw new Error('Session costs not calculated correctly');
      }

      // Test optimization recommendations
      const optimization = this.costTracker.optimizeCosts();
      if (!Array.isArray(optimization.recommendations)) {
        throw new Error('Optimization recommendations not generated');
      }

      logger.debug('Cost tracking validated', {
        dailyCost: dailyCosts.totalCost,
        sessionTokens: sessionCosts.totalTokens,
        recommendations: optimization.recommendations.length
      });
    });
  }

  private async testErrorHandling(): Promise<void> {
    await this.runTest('Error Handling', async () => {
      if (!this.errorHandler) {
        throw new Error('Error handler not initialized');
      }

      // Test retry mechanism with a function that fails twice then succeeds
      let attempts = 0;
      const testOperation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await this.errorHandler.executeWithRetry(
        testOperation,
        { testContext: true },
        'test-operation'
      );

      if (result !== 'success') {
        throw new Error('Retry mechanism failed');
      }

      if (attempts !== 3) {
        throw new Error(`Expected 3 attempts, got ${attempts}`);
      }

      // Test error classification
      const rateLimitError = new Error('Rate limit exceeded');
      const classification = this.errorHandler.classifyError(rateLimitError);
      
      if (classification.type !== 'rate_limit' || !classification.retryable) {
        throw new Error('Error classification incorrect');
      }

      // Test health status
      const health = this.errorHandler.getHealthStatus();
      if (!health.status || !health.metrics) {
        throw new Error('Health status not generated correctly');
      }

      logger.debug('Error handling validated', {
        retryAttempts: attempts,
        errorType: classification.type,
        healthStatus: health.status
      });
    });
  }

  private async testPerformanceMetrics(): Promise<void> {
    await this.runTest('Performance Metrics', async () => {
      const metrics = {
        memoryUsage: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        uptime: process.uptime()
      };

      // Check memory usage (should be reasonable for a test environment)
      const memoryMB = metrics.memoryUsage.heapUsed / 1024 / 1024;
      if (memoryMB > 500) { // 500 MB threshold
        logger.warn(`High memory usage: ${memoryMB.toFixed(1)} MB`);
      }

      // Check if all components are responding within reasonable time
      const startTime = Date.now();
      
      if (this.openAIClient) {
        this.openAIClient.getUsageStats();
      }
      
      if (this.costTracker) {
        this.costTracker.getDailyCosts();
      }

      const responseTime = Date.now() - startTime;
      if (responseTime > 1000) { // 1 second threshold
        throw new Error(`Slow component response time: ${responseTime}ms`);
      }

      logger.debug('Performance metrics collected', {
        memoryMB: memoryMB.toFixed(1),
        responseTimeMs: responseTime,
        uptime: metrics.uptime.toFixed(1)
      });
    });
  }

  private async testCleanup(): Promise<void> {
    await this.runTest('Component Cleanup', async () => {
      // Test cleanup of all components
      const cleanupPromises = [];

      if (this.meetingSummarizer) {
        cleanupPromises.push(this.meetingSummarizer.cleanup());
      }

      if (this.openAIClient) {
        cleanupPromises.push(this.openAIClient.cleanup());
      }

      if (this.transcriptManager) {
        cleanupPromises.push(this.transcriptManager.cleanup());
      }

      if (this.pdfGenerator) {
        cleanupPromises.push(this.pdfGenerator.cleanup());
      }

      if (this.costTracker) {
        cleanupPromises.push(this.costTracker.cleanup());
      }

      if (this.errorHandler) {
        cleanupPromises.push(this.errorHandler.cleanup());
      }

      await Promise.all(cleanupPromises);

      logger.debug('All components cleaned up successfully');
    });
  }

  public generateReport(): string {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const total = this.results.length;
    const successRate = ((passed / total) * 100).toFixed(1);

    let report = '\n=== Summarization System Test Report ===\n\n';
    report += `Total Tests: ${total}\n`;
    report += `Passed: ${passed}\n`;
    report += `Failed: ${failed}\n`;
    report += `Success Rate: ${successRate}%\n\n`;

    if (failed > 0) {
      report += 'Failed Tests:\n';
      this.results
        .filter(r => !r.passed)
        .forEach(result => {
          report += `❌ ${result.name}: ${result.error}\n`;
        });
      report += '\n';
    }

    report += 'Test Details:\n';
    this.results.forEach(result => {
      const status = result.passed ? '✅' : '❌';
      report += `${status} ${result.name} (${result.duration}ms)\n`;
    });

    return report;
  }
}

// Run tests if this file is executed directly
async function main() {
  const testSuite = new SummarizationTestSuite();
  
  try {
    const results = await testSuite.runAllTests();
    const report = testSuite.generateReport();
    
    console.log(report);
    
    // Exit with appropriate code
    process.exit(results.failed > 0 ? 1 : 0);
    
  } catch (error) {
    logger.error('Test suite failed to complete:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export default SummarizationTestSuite;