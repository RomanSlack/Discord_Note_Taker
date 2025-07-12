import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';

const logger = createLogger('OpenAIClient');

export interface OpenAIConfiguration {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  timeout: number;
  maxRetries: number;
  baseURL?: string;
}

export interface SummarizationOptions {
  type: 'interim' | 'final' | 'action-items' | 'decisions';
  maxLength?: number;
  focus?: string[];
  includeTimestamps?: boolean;
  includeConfidence?: boolean;
  contextWindow?: number;
}

export interface SummarizationResult {
  id: string;
  type: SummarizationOptions['type'];
  summary: string;
  keyPoints: string[];
  actionItems?: ActionItem[];
  decisions?: Decision[];
  participants?: string[];
  confidence: number;
  tokenUsage: TokenUsage;
  processingTime: number;
  cost: number;
  metadata: SummarizationMetadata;
}

export interface ActionItem {
  id: string;
  description: string;
  assignee?: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  context: string;
  confidence: number;
}

export interface Decision {
  id: string;
  description: string;
  outcome: string;
  rationale: string;
  participants: string[];
  timestamp: string;
  confidence: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SummarizationMetadata {
  sessionId: string;
  segmentIds: string[];
  startTime: Date;
  endTime: Date;
  inputLength: number;
  outputLength: number;
  model: string;
  temperature: number;
  requestId: string;
}

export interface RateLimitInfo {
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsRemaining: number;
  tokensRemaining: number;
  resetTime: Date;
}

export class OpenAIClient extends EventEmitter {
  private client: OpenAI;
  private config: OpenAIConfiguration;
  private rateLimitInfo: RateLimitInfo | null = null;
  private requestQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue = false;
  private totalCost = 0;
  private totalTokens = 0;
  private requestCount = 0;

  // GPT-4.1 mini pricing (per 1K tokens)
  private readonly PRICING = {
    'gpt-4o-mini': {
      input: 0.000150,  // $0.150 per 1M input tokens
      output: 0.000600  // $0.600 per 1M output tokens
    }
  };

  constructor(apiKey?: string) {
    super();

    if (!apiKey && !config.openAiApiKey) {
      throw new Error('OpenAI API key is required');
    }

    this.config = {
      apiKey: apiKey || config.openAiApiKey!,
      model: 'gpt-4o-mini', // GPT-4.1 mini for cost optimization
      maxTokens: 4096,
      temperature: 0.3, // Lower temperature for consistent summarization
      topP: 0.9,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0,
      timeout: 30000, // 30 seconds
      maxRetries: 3
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries
    });

    logger.info('OpenAI client initialized', {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature
    });
  }

  public async summarizeTranscripts(
    transcripts: any[],
    options: SummarizationOptions,
    contextHistory?: string[]
  ): Promise<SummarizationResult> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    try {
      logger.info('Starting transcript summarization', {
        requestId,
        type: options.type,
        transcriptCount: transcripts.length,
        hasContext: !!contextHistory?.length
      });

      // Prepare the prompt based on summarization type
      const prompt = this.buildPrompt(transcripts, options, contextHistory);
      
      // Execute the summarization request with rate limiting
      const completion = await this.executeWithRateLimit(async () => {
        return await this.client.chat.completions.create({
          model: this.config.model,
          messages: [
            {
              role: 'system',
              content: this.getSystemPrompt(options.type)
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          top_p: this.config.topP,
          frequency_penalty: this.config.frequencyPenalty,
          presence_penalty: this.config.presencePenalty,
          response_format: { type: 'json_object' }
        });
      });

      // Parse the response
      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new Error('Empty response from OpenAI');
      }

      const parsedResponse = this.parseResponse(responseContent, options.type);
      const processingTime = Date.now() - startTime;

      // Calculate cost
      const tokenUsage: TokenUsage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0
      };

      const cost = this.calculateCost(tokenUsage);
      this.updateUsageStats(tokenUsage, cost);

      // Build result
      const result: SummarizationResult = {
        id: requestId,
        type: options.type,
        summary: parsedResponse.summary,
        keyPoints: parsedResponse.keyPoints || [],
        actionItems: parsedResponse.actionItems,
        decisions: parsedResponse.decisions,
        participants: parsedResponse.participants,
        confidence: parsedResponse.confidence || 0.8,
        tokenUsage,
        processingTime,
        cost,
        metadata: {
          sessionId: '', // Will be set by caller
          segmentIds: [], // Will be set by caller
          startTime: new Date(startTime),
          endTime: new Date(),
          inputLength: prompt.length,
          outputLength: responseContent.length,
          model: this.config.model,
          temperature: this.config.temperature,
          requestId
        }
      };

      logger.info('Transcript summarization completed', {
        requestId,
        type: options.type,
        processingTime,
        tokenUsage: tokenUsage.totalTokens,
        cost: cost.toFixed(4),
        keyPointsCount: result.keyPoints.length,
        actionItemsCount: result.actionItems?.length || 0
      });

      this.emit('summarization-completed', result);
      return result;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      logger.error('Transcript summarization failed', {
        requestId,
        type: options.type,
        processingTime,
        error: error instanceof Error ? error.message : String(error)
      });

      this.emit('summarization-error', error, options);
      throw error;
    }
  }

  private getSystemPrompt(type: SummarizationOptions['type']): string {
    const basePrompt = `You are an expert meeting summarization AI assistant. Your role is to analyze meeting transcripts and provide clear, actionable summaries. Always respond in valid JSON format.`;

    switch (type) {
      case 'interim':
        return `${basePrompt}

Focus on creating concise interim summaries for ongoing meetings. Extract:
- Main topics discussed so far
- Key decisions made
- Action items identified
- Next steps or upcoming topics

Keep summaries brief but informative. Response format:
{
  "summary": "Brief overview of discussion",
  "keyPoints": ["point1", "point2", ...],
  "actionItems": [{"description": "task", "assignee": "person", "priority": "medium"}],
  "confidence": 0.8
}`;

      case 'final':
        return `${basePrompt}

Create comprehensive final meeting summaries. Extract:
- Complete meeting overview
- All key decisions made
- All action items with ownership
- Important discussions and outcomes
- Participant insights

Be thorough and detailed. Response format:
{
  "summary": "Comprehensive meeting overview",
  "keyPoints": ["point1", "point2", ...],
  "actionItems": [{"description": "task", "assignee": "person", "priority": "high", "dueDate": "date"}],
  "decisions": [{"description": "decision", "outcome": "result", "rationale": "reasoning"}],
  "participants": ["person1", "person2"],
  "confidence": 0.9
}`;

      case 'action-items':
        return `${basePrompt}

Focus specifically on extracting action items from meeting transcripts. Identify:
- Specific tasks assigned to individuals
- Deadlines and priorities
- Context for each action item
- Clear ownership and accountability

Response format:
{
  "summary": "Action items summary",
  "actionItems": [{"id": "ai1", "description": "task", "assignee": "person", "priority": "high", "context": "discussion context", "confidence": 0.9}],
  "confidence": 0.85
}`;

      case 'decisions':
        return `${basePrompt}

Focus on extracting key decisions made during the meeting. Identify:
- Important decisions and their outcomes
- Rationale behind decisions
- Who was involved in the decision
- Impact and implications

Response format:
{
  "summary": "Decisions summary",
  "decisions": [{"id": "d1", "description": "decision topic", "outcome": "final decision", "rationale": "reasoning", "participants": ["person1"], "confidence": 0.9}],
  "confidence": 0.8
}`;

      default:
        return basePrompt;
    }
  }

  private buildPrompt(
    transcripts: any[],
    options: SummarizationOptions,
    contextHistory?: string[]
  ): string {
    let prompt = '';

    // Add context if provided
    if (contextHistory && contextHistory.length > 0) {
      prompt += 'Previous meeting context:\n';
      prompt += contextHistory.slice(-3).join('\n\n'); // Last 3 context items
      prompt += '\n\n---\n\n';
    }

    // Add current transcripts
    prompt += 'Current meeting transcript to summarize:\n\n';
    
    transcripts.forEach((transcript, index) => {
      const timestamp = transcript.created ? 
        new Date(transcript.created).toLocaleTimeString() : 
        `[${index}]`;
      
      prompt += `[${timestamp}] ${transcript.text}\n`;
      
      if (options.includeConfidence && transcript.confidence) {
        prompt += `  (Confidence: ${(transcript.confidence * 100).toFixed(1)}%)\n`;
      }
    });

    // Add specific instructions based on options
    if (options.focus && options.focus.length > 0) {
      prompt += `\n\nSpecial focus areas: ${options.focus.join(', ')}\n`;
    }

    if (options.maxLength) {
      prompt += `\nKeep summary under ${options.maxLength} words.\n`;
    }

    return prompt;
  }

  private parseResponse(content: string, type: SummarizationOptions['type']): any {
    try {
      const parsed = JSON.parse(content);
      
      // Validate required fields
      if (!parsed.summary) {
        throw new Error('Missing required field: summary');
      }

      // Ensure arrays exist
      parsed.keyPoints = parsed.keyPoints || [];
      
      if (type === 'final' || type === 'interim') {
        parsed.actionItems = parsed.actionItems || [];
      }
      
      if (type === 'final' || type === 'decisions') {
        parsed.decisions = parsed.decisions || [];
      }

      // Add IDs to action items and decisions if missing
      parsed.actionItems?.forEach((item: any, index: number) => {
        if (!item.id) item.id = `ai_${Date.now()}_${index}`;
        if (!item.priority) item.priority = 'medium';
        if (!item.confidence) item.confidence = 0.8;
      });

      parsed.decisions?.forEach((decision: any, index: number) => {
        if (!decision.id) decision.id = `d_${Date.now()}_${index}`;
        if (!decision.confidence) decision.confidence = 0.8;
      });

      return parsed;
    } catch (error) {
      logger.error('Failed to parse OpenAI response', { content, error });
      throw new Error('Invalid JSON response from OpenAI');
    }
  }

  private async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue.shift();
      if (!request) break;

      try {
        await request();
        // Add delay between requests to respect rate limits
        await this.delay(100); // 100ms delay
      } catch (error) {
        if (this.isRateLimitError(error)) {
          // Re-queue the request and wait
          this.requestQueue.unshift(request);
          await this.delay(60000); // Wait 1 minute for rate limit reset
        } else {
          throw error;
        }
      }
    }

    this.isProcessingQueue = false;
  }

  private isRateLimitError(error: any): boolean {
    return error?.status === 429 || 
           error?.code === 'rate_limit_exceeded' ||
           error?.message?.includes('rate limit');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private calculateCost(tokenUsage: TokenUsage): number {
    const pricing = this.PRICING[this.config.model as keyof typeof this.PRICING];
    if (!pricing) return 0;

    const inputCost = (tokenUsage.promptTokens / 1000) * pricing.input;
    const outputCost = (tokenUsage.completionTokens / 1000) * pricing.output;
    
    return inputCost + outputCost;
  }

  private updateUsageStats(tokenUsage: TokenUsage, cost: number): void {
    this.totalCost += cost;
    this.totalTokens += tokenUsage.totalTokens;
    this.requestCount++;

    this.emit('usage-updated', {
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      requestCount: this.requestCount,
      lastCost: cost,
      lastTokens: tokenUsage.totalTokens
    });
  }

  private generateRequestId(): string {
    return `oai_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // Public accessors
  public getUsageStats() {
    return {
      totalCost: this.totalCost,
      totalTokens: this.totalTokens,
      requestCount: this.requestCount,
      averageCostPerRequest: this.requestCount > 0 ? this.totalCost / this.requestCount : 0,
      averageTokensPerRequest: this.requestCount > 0 ? this.totalTokens / this.requestCount : 0
    };
  }

  public getRateLimitInfo(): RateLimitInfo | null {
    return this.rateLimitInfo;
  }

  public resetUsageStats(): void {
    this.totalCost = 0;
    this.totalTokens = 0;
    this.requestCount = 0;
    
    logger.info('OpenAI usage stats reset');
  }

  public async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: 'system', content: 'You are a test assistant.' },
          { role: 'user', content: 'Respond with "OK" if you can hear me.' }
        ],
        max_tokens: 10,
        temperature: 0
      });

      const content = response.choices[0]?.message?.content?.trim().toLowerCase();
      return content === 'ok';
    } catch (error) {
      logger.error('OpenAI connection test failed:', error);
      return false;
    }
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up OpenAI client');
    
    // Wait for queue to finish
    while (this.isProcessingQueue && this.requestQueue.length > 0) {
      await this.delay(100);
    }
    
    this.requestQueue = [];
    this.removeAllListeners();
    
    logger.info('OpenAI client cleanup completed');
  }
}

export default OpenAIClient;