import { Transform, PassThrough } from 'stream';
import { createLogger } from '@utils/logger';
import { settingsManager } from '@config/settings';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('AudioProcessor');

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  encoding: 'pcm' | 'opus' | 'mp3' | 'wav';
}

export interface ProcessingOptions {
  normalize: boolean;
  silenceThreshold: number;
  silenceTimeout: number;
  highPassFilter: boolean;
  lowPassFilter: boolean;
  noiseReduction: boolean;
  compressionRatio: number;
}

export interface AudioBuffer {
  userId: string;
  data: Buffer;
  timestamp: Date;
  sampleRate: number;
  channels: number;
  sequenceNumber: number;
  packetLoss: boolean;
}

export interface AudioStatistics {
  totalPackets: number;
  lostPackets: number;
  duplicatePackets: number;
  outOfOrderPackets: number;
  averageLatency: number;
  jitterBuffer: number;
  audioLevel: number;
  silenceRatio: number;
}

export class AudioProcessor {
  private readonly discordSampleRate = 48000;
  private readonly discordChannels = 2;
  private readonly discordBitDepth = 16;
  private readonly packetDuration = 20; // 20ms Discord packets
  private readonly samplesPerPacket: number;
  
  // Buffer management
  private readonly maxBufferTime = 5000; // 5 seconds max buffer
  private readonly minBufferTime = 100; // 100ms min buffer
  private buffers: Map<string, AudioBuffer[]> = new Map();
  private statistics: Map<string, AudioStatistics> = new Map();
  
  // Audio processing constants
  private readonly silenceThreshold = -50; // dB
  private readonly compressionThreshold = -20; // dB for compression
  private readonly noiseFloor = -60; // dB noise floor

  constructor() {
    this.samplesPerPacket = (this.discordSampleRate * this.packetDuration) / 1000;
    logger.info('Audio processor initialized', {
      sampleRate: this.discordSampleRate,
      channels: this.discordChannels,
      samplesPerPacket: this.samplesPerPacket
    });
  }

  /**
   * Process raw Discord Opus packets into PCM data
   */
  public async processDiscordPacket(
    userId: string,
    opusData: Buffer,
    sequenceNumber: number,
    timestamp: Date
  ): Promise<AudioBuffer | null> {
    try {
      // Convert Opus to PCM
      const pcmData = await this.opusToPcm(opusData);
      
      if (!pcmData || pcmData.length === 0) {
        logger.debug('Empty PCM data from Opus conversion', { userId });
        return null;
      }

      // Create audio buffer
      const audioBuffer: AudioBuffer = {
        userId,
        data: pcmData,
        timestamp,
        sampleRate: this.discordSampleRate,
        channels: this.discordChannels,
        sequenceNumber,
        packetLoss: false
      };

      // Update statistics
      this.updatePacketStatistics(userId, sequenceNumber, timestamp);

      // Detect packet loss
      audioBuffer.packetLoss = this.detectPacketLoss(userId, sequenceNumber);

      // Add to buffer
      this.addToBuffer(userId, audioBuffer);

      logger.debug('Processed Discord packet', {
        userId,
        sequenceNumber,
        dataSize: pcmData.length,
        packetLoss: audioBuffer.packetLoss
      });

      return audioBuffer;

    } catch (error) {
      logger.error('Error processing Discord packet:', { userId, error });
      return null;
    }
  }

  /**
   * Convert Opus data to PCM
   */
  private async opusToPcm(opusData: Buffer): Promise<Buffer> {
    try {
      // Import Opus decoder (using prism-media which handles Discord's Opus format)
      const prism = await import('prism-media');
      
      return new Promise((resolve, reject) => {
        const decoder = new prism.opus.Decoder({
          rate: this.discordSampleRate,
          channels: this.discordChannels,
          frameSize: this.samplesPerPacket
        });

        const chunks: Buffer[] = [];

        decoder.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        decoder.on('end', () => {
          resolve(Buffer.concat(chunks));
        });

        decoder.on('error', (error: Error) => {
          logger.error('Opus decoder error:', error);
          reject(error);
        });

        // Write Opus data to decoder
        decoder.write(opusData);
        decoder.end();
      });

    } catch (error) {
      logger.error('Error in Opus to PCM conversion:', error);
      throw error;
    }
  }

  /**
   * Convert PCM to different formats for AssemblyAI or other services
   */
  public async convertFormat(
    pcmData: Buffer,
    targetFormat: AudioFormat
  ): Promise<Buffer> {
    try {
      let processedData = pcmData;

      // Resample if necessary
      if (targetFormat.sampleRate !== this.discordSampleRate) {
        processedData = this.resampleAudio(
          processedData, 
          this.discordSampleRate, 
          targetFormat.sampleRate
        );
      }

      // Convert channels if necessary
      if (targetFormat.channels !== this.discordChannels) {
        processedData = this.convertChannels(
          processedData, 
          this.discordChannels, 
          targetFormat.channels
        );
      }

      // Convert bit depth if necessary
      if (targetFormat.bitDepth !== this.discordBitDepth) {
        processedData = this.convertBitDepth(
          processedData, 
          this.discordBitDepth, 
          targetFormat.bitDepth
        );
      }

      // Add format-specific headers if needed
      if (targetFormat.encoding === 'wav') {
        processedData = this.addWavHeader(
          processedData, 
          targetFormat.sampleRate, 
          targetFormat.channels, 
          targetFormat.bitDepth
        );
      }

      logger.debug('Audio format conversion completed', {
        originalSize: pcmData.length,
        convertedSize: processedData.length,
        targetFormat
      });

      return processedData;

    } catch (error) {
      logger.error('Error converting audio format:', error);
      throw error;
    }
  }

  /**
   * Apply audio processing and normalization
   */
  public processAudio(
    audioData: Buffer,
    options: Partial<ProcessingOptions> = {}
  ): Buffer {
    try {
      let processedData = audioData;
      
      const opts: ProcessingOptions = {
        normalize: true,
        silenceThreshold: this.silenceThreshold,
        silenceTimeout: 2000,
        highPassFilter: true,
        lowPassFilter: false,
        noiseReduction: true,
        compressionRatio: 2.0,
        ...options
      };

      // Apply noise reduction
      if (opts.noiseReduction) {
        processedData = this.applyNoiseReduction(processedData);
      }

      // Apply high-pass filter to remove low-frequency noise
      if (opts.highPassFilter) {
        processedData = this.applyHighPassFilter(processedData, 100); // 100Hz cutoff
      }

      // Apply dynamic range compression
      if (opts.compressionRatio > 1.0) {
        processedData = this.applyCompression(processedData, opts.compressionRatio);
      }

      // Normalize audio levels
      if (opts.normalize) {
        processedData = this.normalizeAudio(processedData);
      }

      logger.debug('Audio processing completed', {
        originalSize: audioData.length,
        processedSize: processedData.length,
        options: opts
      });

      return processedData;

    } catch (error) {
      logger.error('Error processing audio:', error);
      return audioData; // Return original data on error
    }
  }

  /**
   * Resample audio to different sample rate
   */
  private resampleAudio(data: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return data;

    const ratio = toRate / fromRate;
    const inputSamples = data.length / 2; // 16-bit samples
    const outputSamples = Math.floor(inputSamples * ratio);
    const output = Buffer.alloc(outputSamples * 2);

    // Simple linear interpolation resampling
    for (let i = 0; i < outputSamples; i++) {
      const sourceIndex = i / ratio;
      const sourceIndexFloor = Math.floor(sourceIndex);
      const sourceIndexCeil = Math.min(sourceIndexFloor + 1, inputSamples - 1);
      const fraction = sourceIndex - sourceIndexFloor;

      const sample1 = data.readInt16LE(sourceIndexFloor * 2);
      const sample2 = data.readInt16LE(sourceIndexCeil * 2);
      
      const interpolated = sample1 + (sample2 - sample1) * fraction;
      output.writeInt16LE(Math.round(interpolated), i * 2);
    }

    logger.debug('Audio resampled', {
      fromRate,
      toRate,
      inputSamples,
      outputSamples,
      ratio
    });

    return output;
  }

  /**
   * Convert between different channel configurations
   */
  private convertChannels(data: Buffer, fromChannels: number, toChannels: number): Buffer {
    if (fromChannels === toChannels) return data;

    const samplesPerChannel = data.length / (2 * fromChannels); // 16-bit samples
    const output = Buffer.alloc(samplesPerChannel * 2 * toChannels);

    if (fromChannels === 2 && toChannels === 1) {
      // Stereo to mono - average channels
      for (let i = 0; i < samplesPerChannel; i++) {
        const left = data.readInt16LE(i * 4);
        const right = data.readInt16LE(i * 4 + 2);
        const mono = Math.round((left + right) / 2);
        output.writeInt16LE(mono, i * 2);
      }
    } else if (fromChannels === 1 && toChannels === 2) {
      // Mono to stereo - duplicate channel
      for (let i = 0; i < samplesPerChannel; i++) {
        const sample = data.readInt16LE(i * 2);
        output.writeInt16LE(sample, i * 4);
        output.writeInt16LE(sample, i * 4 + 2);
      }
    }

    logger.debug('Audio channels converted', {
      fromChannels,
      toChannels,
      samplesPerChannel
    });

    return output;
  }

  /**
   * Convert bit depth
   */
  private convertBitDepth(data: Buffer, fromBits: number, toBits: number): Buffer {
    if (fromBits === toBits) return data;

    // Currently only supports 16-bit, so return as-is
    logger.warn('Bit depth conversion not implemented', { fromBits, toBits });
    return data;
  }

  /**
   * Add WAV header to PCM data
   */
  private addWavHeader(pcmData: Buffer, sampleRate: number, channels: number, bitDepth: number): Buffer {
    const header = Buffer.alloc(44);
    const dataSize = pcmData.length;
    const fileSize = dataSize + 36;

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // Format chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Chunk size
    header.writeUInt16LE(1, 20); // Audio format (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28); // Byte rate
    header.writeUInt16LE(channels * (bitDepth / 8), 32); // Block align
    header.writeUInt16LE(bitDepth, 34);

    // Data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  /**
   * Apply noise reduction using spectral gating
   */
  private applyNoiseReduction(data: Buffer): Buffer {
    // Simple noise reduction: reduce samples below noise floor
    const output = Buffer.alloc(data.length);
    const noiseThreshold = this.dbToLinear(this.noiseFloor) * 32767;

    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i);
      const absSample = Math.abs(sample);
      
      if (absSample < noiseThreshold) {
        // Reduce noise by 50%
        output.writeInt16LE(Math.round(sample * 0.5), i);
      } else {
        output.writeInt16LE(sample, i);
      }
    }

    return output;
  }

  /**
   * Apply high-pass filter
   */
  private applyHighPassFilter(data: Buffer, cutoffFreq: number): Buffer {
    // Simple first-order high-pass filter
    const rc = 1.0 / (cutoffFreq * 2 * Math.PI);
    const dt = 1.0 / this.discordSampleRate;
    const alpha = rc / (rc + dt);

    const output = Buffer.alloc(data.length);
    let prevInput = 0;
    let prevOutput = 0;

    for (let i = 0; i < data.length; i += 2) {
      const input = data.readInt16LE(i);
      const output_sample = alpha * (prevOutput + input - prevInput);
      
      output.writeInt16LE(Math.round(output_sample), i);
      
      prevInput = input;
      prevOutput = output_sample;
    }

    return output;
  }

  /**
   * Apply dynamic range compression
   */
  private applyCompression(data: Buffer, ratio: number): Buffer {
    const threshold = this.dbToLinear(this.compressionThreshold) * 32767;
    const output = Buffer.alloc(data.length);

    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i);
      const absSample = Math.abs(sample);
      
      if (absSample > threshold) {
        // Apply compression above threshold
        const excess = absSample - threshold;
        const compressedExcess = excess / ratio;
        const compressedSample = threshold + compressedExcess;
        
        const sign = sample >= 0 ? 1 : -1;
        output.writeInt16LE(Math.round(sign * compressedSample), i);
      } else {
        output.writeInt16LE(sample, i);
      }
    }

    return output;
  }

  /**
   * Normalize audio levels
   */
  private normalizeAudio(data: Buffer): Buffer {
    // Find peak amplitude
    let peak = 0;
    for (let i = 0; i < data.length; i += 2) {
      const sample = Math.abs(data.readInt16LE(i));
      peak = Math.max(peak, sample);
    }

    if (peak === 0) return data;

    // Calculate normalization factor (target 90% of max amplitude)
    const targetPeak = 32767 * 0.9;
    const factor = targetPeak / peak;

    // Apply normalization if needed (don't amplify too much)
    if (factor > 0.1 && factor < 10.0) {
      const output = Buffer.alloc(data.length);
      
      for (let i = 0; i < data.length; i += 2) {
        const sample = data.readInt16LE(i);
        const normalized = Math.round(sample * factor);
        output.writeInt16LE(Math.max(-32767, Math.min(32767, normalized)), i);
      }
      
      return output;
    }

    return data;
  }

  /**
   * Calculate audio level in dB
   */
  public calculateAudioLevel(data: Buffer): number {
    if (data.length === 0) return -Infinity;

    let sum = 0;
    const numSamples = data.length / 2;

    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / numSamples);
    const dB = 20 * Math.log10(rms / 32767);
    
    return isFinite(dB) ? dB : -Infinity;
  }

  /**
   * Detect silence in audio data
   */
  public detectSilence(data: Buffer, threshold: number = this.silenceThreshold): boolean {
    const audioLevel = this.calculateAudioLevel(data);
    return audioLevel < threshold;
  }

  /**
   * Trim silence from beginning and end of audio
   */
  public trimSilence(data: Buffer, threshold: number = this.silenceThreshold): Buffer {
    const chunkSize = this.samplesPerPacket * 2; // One packet worth of samples
    let start = 0;
    let end = data.length;

    // Find start of audio (skip initial silence)
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, Math.min(i + chunkSize, data.length));
      if (!this.detectSilence(chunk, threshold)) {
        start = i;
        break;
      }
    }

    // Find end of audio (skip trailing silence)
    for (let i = data.length - chunkSize; i >= 0; i -= chunkSize) {
      const chunk = data.slice(Math.max(0, i), i + chunkSize);
      if (!this.detectSilence(chunk, threshold)) {
        end = i + chunkSize;
        break;
      }
    }

    if (start >= end) {
      // All silence
      return Buffer.alloc(0);
    }

    return data.slice(start, end);
  }

  // Buffer management methods
  private addToBuffer(userId: string, audioBuffer: AudioBuffer): void {
    if (!this.buffers.has(userId)) {
      this.buffers.set(userId, []);
    }

    const userBuffer = this.buffers.get(userId)!;
    userBuffer.push(audioBuffer);

    // Remove old buffers
    const now = Date.now();
    const cutoffTime = now - this.maxBufferTime;
    
    while (userBuffer.length > 0 && userBuffer[0].timestamp.getTime() < cutoffTime) {
      userBuffer.shift();
    }
  }

  private updatePacketStatistics(userId: string, sequenceNumber: number, timestamp: Date): void {
    if (!this.statistics.has(userId)) {
      this.statistics.set(userId, {
        totalPackets: 0,
        lostPackets: 0,
        duplicatePackets: 0,
        outOfOrderPackets: 0,
        averageLatency: 0,
        jitterBuffer: 0,
        audioLevel: 0,
        silenceRatio: 0
      });
    }

    const stats = this.statistics.get(userId)!;
    stats.totalPackets++;
  }

  private detectPacketLoss(userId: string, sequenceNumber: number): boolean {
    // Simple packet loss detection based on sequence numbers
    // In a real implementation, this would be more sophisticated
    return false;
  }

  private dbToLinear(db: number): number {
    return Math.pow(10, db / 20);
  }

  // Public accessors
  public getBufferedData(userId: string): AudioBuffer[] {
    return this.buffers.get(userId) || [];
  }

  public getStatistics(userId: string): AudioStatistics | null {
    return this.statistics.get(userId) || null;
  }

  public clearBuffers(userId?: string): void {
    if (userId) {
      this.buffers.delete(userId);
      this.statistics.delete(userId);
    } else {
      this.buffers.clear();
      this.statistics.clear();
    }
  }

  public getAssemblyAIFormat(): AudioFormat {
    // AssemblyAI prefers 16kHz, mono, 16-bit PCM
    return {
      sampleRate: 16000,
      channels: 1,
      bitDepth: 16,
      encoding: 'pcm'
    };
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up audio processor');
    this.buffers.clear();
    this.statistics.clear();
    logger.info('Audio processor cleanup completed');
  }
}

export default AudioProcessor;