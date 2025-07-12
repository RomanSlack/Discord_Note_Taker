import { VoiceConnection, EndBehaviorType } from '@discordjs/voice';
import { Client } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '@utils/logger';
import { spawn, ChildProcess } from 'child_process';
import { AssemblyAIStreamingClient } from '@transcription/assemblyai-client';
import OpenAIClient from '@summarization/openai-client';
import { config } from '@config/environment';

const logger = createLogger('SimpleRecorder');

interface RecordingSession {
  sessionId: string;
  guildId: string;
  channelId: string;
  startTime: Date;
  recordingDir: string;
  audioFiles: string[];
  transcriptions: any[];
  isActive: boolean;
  saveTimer?: NodeJS.Timeout;
}

export class SimpleRecorder {
  private activeSessions = new Map<string, RecordingSession>();
  private assemblyClient: AssemblyAIStreamingClient | null = null;
  private openaiClient: OpenAIClient | null = null;

  constructor(private client: Client) {
    // Initialize AI clients if API keys are available
    if (config.assemblyAiApiKey) {
      this.assemblyClient = new AssemblyAIStreamingClient({
        apiKey: config.assemblyAiApiKey,
        sampleRate: 48000,
        channels: 2,
        confidenceThreshold: 0.7
      });
    }
    if (config.openAiApiKey) {
      this.openaiClient = new OpenAIClient();
    }

    logger.info('Simple recorder initialized', {
      transcriptionEnabled: !!this.assemblyClient,
      summarizationEnabled: !!this.openaiClient
    });
  }

  public async startRecording(connection: VoiceConnection, guildId: string, channelId: string): Promise<string> {
    const sessionId = `session_${new Date().toISOString().replace(/[:.]/g, '-')}_${Math.random().toString(36).substring(2, 8)}`;
    const recordingDir = path.join(process.cwd(), 'recordings', sessionId);

    // Create recording directory
    await fs.promises.mkdir(recordingDir, { recursive: true });

    const session: RecordingSession = {
      sessionId,
      guildId,
      channelId,
      startTime: new Date(),
      recordingDir,
      audioFiles: [],
      transcriptions: [],
      isActive: true
    };

    this.activeSessions.set(guildId, session);

    // Start capturing audio
    await this.setupAudioCapture(connection, session);

    // Set up periodic saves every 5 minutes
    session.saveTimer = setInterval(async () => {
      if (session.isActive) {
        await this.saveCurrentAudio(session);
      }
    }, 5 * 60 * 1000); // 5 minutes

    logger.info('Recording started', {
      sessionId,
      guildId,
      channelId,
      recordingDir
    });

    return sessionId;
  }

  public async stopRecording(guildId: string): Promise<void> {
    const session = this.activeSessions.get(guildId);
    if (!session) {
      throw new Error('No active recording session found');
    }

    session.isActive = false;

    // Clear the save timer
    if (session.saveTimer) {
      clearInterval(session.saveTimer);
    }

    // Save final audio segment
    await this.saveCurrentAudio(session);

    // Process all audio files
    await this.processRecording(session);

    this.activeSessions.delete(guildId);

    logger.info('Recording stopped and processed', {
      sessionId: session.sessionId,
      totalAudioFiles: session.audioFiles.length
    });
  }

  public getActiveSession(guildId: string): RecordingSession | null {
    return this.activeSessions.get(guildId) || null;
  }

  public getAllActiveSessions(): RecordingSession[] {
    return Array.from(this.activeSessions.values());
  }

  private async setupAudioCapture(connection: VoiceConnection, session: RecordingSession): Promise<void> {
    const receiver = connection.receiver;

    // Listen for users speaking
    receiver.speaking.on('start', (userId) => {
      // Create audio stream for this user
      const audioStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000, // 1 second of silence
        },
      });

      // Save audio to a temporary file
      const tempAudioFile = path.join(session.recordingDir, `temp_${userId}_${Date.now()}.pcm`);
      const writeStream = fs.createWriteStream(tempAudioFile);
      
      audioStream.pipe(writeStream);

      audioStream.on('end', () => {
        writeStream.end();
        logger.debug('Audio chunk saved', { userId, file: tempAudioFile });
      });
    });
  }

  private async saveCurrentAudio(session: RecordingSession): Promise<void> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFile = path.join(session.recordingDir, `audio_${timestamp}.wav`);

      // Combine all PCM files into a single WAV file
      await this.combineAudioFiles(session.recordingDir, outputFile);

      if (fs.existsSync(outputFile)) {
        session.audioFiles.push(outputFile);
        
        // Transcribe this audio file if transcription is enabled
        if (this.assemblyClient) {
          await this.transcribeAudioFile(outputFile, session);
        }

        // Clean up temporary PCM files
        await this.cleanupTempFiles(session.recordingDir);

        logger.info('Audio segment saved and processed', {
          sessionId: session.sessionId,
          file: outputFile,
          totalSegments: session.audioFiles.length
        });
      }
    } catch (error) {
      logger.error('Failed to save audio segment', {
        sessionId: session.sessionId,
        error
      });
    }
  }

  private async combineAudioFiles(recordingDir: string, outputFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Find all PCM files
      const pcmFiles = fs.readdirSync(recordingDir)
        .filter(file => file.endsWith('.pcm'))
        .map(file => path.join(recordingDir, file));

      if (pcmFiles.length === 0) {
        resolve();
        return;
      }

      // Use FFmpeg to combine PCM files into WAV
      const ffmpeg = spawn('ffmpeg', [
        '-f', 's16le',           // Input format: signed 16-bit little endian
        '-ar', '48000',          // Sample rate: 48kHz (Discord's sample rate)
        '-ac', '2',              // Channels: stereo
        '-i', 'concat:' + pcmFiles.join('|'), // Concatenate input files
        '-acodec', 'pcm_s16le',  // Output codec
        '-y',                    // Overwrite output file
        outputFile
      ]);

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', reject);
    });
  }

  private async transcribeAudioFile(audioFile: string, session: RecordingSession): Promise<void> {
    if (!config.assemblyAiApiKey) return;

    try {
      logger.info('Transcribing audio file', {
        sessionId: session.sessionId,
        file: audioFile
      });

      // Use AssemblyAI HTTP API for file transcription
      const result = await this.transcribeWithAssemblyAI(audioFile);
      
      if (result && result.text) {
        session.transcriptions.push({
          file: audioFile,
          text: result.text,
          confidence: result.confidence || 0.8,
          timestamp: new Date(),
          words: result.words || []
        });

        // Save transcription to file
        const transcriptionsFile = path.join(session.recordingDir, 'transcriptions.json');
        await fs.promises.writeFile(
          transcriptionsFile, 
          JSON.stringify(session.transcriptions, null, 2)
        );

        logger.info('Audio transcribed successfully', {
          sessionId: session.sessionId,
          textLength: result.text.length,
          confidence: result.confidence
        });
      }
    } catch (error) {
      logger.error('Failed to transcribe audio file', {
        sessionId: session.sessionId,
        file: audioFile,
        error
      });
    }
  }

  private async transcribeWithAssemblyAI(audioFile: string): Promise<any> {
    // Simple file-based transcription using AssemblyAI HTTP API
    // For production, you'd want to upload the file and poll for results
    // For now, we'll simulate a transcription response
    logger.info('Simulating transcription for demo purposes', { audioFile });
    
    // Read file stats to simulate processing
    const stats = await fs.promises.stat(audioFile);
    const fileSizeKB = Math.round(stats.size / 1024);
    
    // Simulate processing time based on file size
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, fileSizeKB * 10)));
    
    // Return simulated transcription result
    return {
      text: `[Transcribed audio from ${path.basename(audioFile)} - ${fileSizeKB}KB file]`,
      confidence: 0.85,
      words: []
    };
  }

  private async processRecording(session: RecordingSession): Promise<void> {
    try {
      // Generate final summary if we have transcriptions and OpenAI is available
      if (session.transcriptions.length > 0 && this.openaiClient) {
        await this.generateSummary(session);
      }

      // Save session metadata
      const metadata = {
        sessionId: session.sessionId,
        guildId: session.guildId,
        channelId: session.channelId,
        startTime: session.startTime,
        endTime: new Date(),
        duration: Date.now() - session.startTime.getTime(),
        audioFiles: session.audioFiles.map(f => path.basename(f)),
        transcriptionCount: session.transcriptions.length,
        totalText: session.transcriptions.map(t => t.text).join(' ').length
      };

      await fs.promises.writeFile(
        path.join(session.recordingDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );

      logger.info('Recording processing completed', {
        sessionId: session.sessionId,
        audioFiles: session.audioFiles.length,
        transcriptions: session.transcriptions.length
      });

    } catch (error) {
      logger.error('Failed to process recording', {
        sessionId: session.sessionId,
        error
      });
    }
  }

  private async generateSummary(session: RecordingSession): Promise<void> {
    if (!this.openaiClient || session.transcriptions.length === 0) return;

    try {
      logger.info('Generating summary', {
        sessionId: session.sessionId,
        transcriptionCount: session.transcriptions.length
      });

      // Combine all transcriptions
      const fullText = session.transcriptions.map(t => t.text).join('\n\n');

      // Use the OpenAI client to summarize
      const result = await this.openaiClient.summarizeTranscripts(
        session.transcriptions,
        {
          type: 'final',
          maxLength: 1000,
          includeTimestamps: true
        }
      );

      if (result) {
        // Save summary
        const summaryData = {
          sessionId: session.sessionId,
          summary: result.summary,
          keyPoints: result.keyPoints,
          actionItems: result.actionItems || [],
          decisions: result.decisions || [],
          confidence: result.confidence,
          cost: result.cost,
          generatedAt: new Date()
        };

        await fs.promises.writeFile(
          path.join(session.recordingDir, 'summary.json'),
          JSON.stringify(summaryData, null, 2)
        );

        logger.info('Summary generated successfully', {
          sessionId: session.sessionId,
          cost: result.cost,
          keyPointsCount: result.keyPoints.length
        });
      }

    } catch (error) {
      logger.error('Failed to generate summary', {
        sessionId: session.sessionId,
        error
      });
    }
  }

  private async cleanupTempFiles(recordingDir: string): Promise<void> {
    try {
      const files = await fs.promises.readdir(recordingDir);
      const pcmFiles = files.filter(file => file.endsWith('.pcm'));
      
      for (const file of pcmFiles) {
        await fs.promises.unlink(path.join(recordingDir, file));
      }
    } catch (error) {
      logger.error('Failed to cleanup temp files', { recordingDir, error });
    }
  }
}