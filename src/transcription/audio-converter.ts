import { Transform, Readable } from 'stream';
import { createLogger } from '@utils/logger';
import ffmpegPath from 'ffmpeg-static';
import { spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const logger = createLogger('AudioConverter');

export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  encoding: 'pcm_s16le' | 'pcm_f32le' | 'pcm_s24le';
}

export interface ConversionOptions {
  inputFormat: AudioFormat;
  outputFormat: AudioFormat;
  bufferSize?: number;
  quality?: 'low' | 'medium' | 'high';
  enableNormalization?: boolean;
  enableNoiseReduction?: boolean;
}

export class AudioConverter extends Transform {
  private options: ConversionOptions;
  private ffmpegProcess: ChildProcess | null = null;
  private inputBuffer: Buffer[] = [];
  private totalInputBytes: number = 0;
  private totalOutputBytes: number = 0;
  private conversionStartTime: number = Date.now();
  private isProcessing: boolean = false;

  constructor(options: ConversionOptions) {
    super({ objectMode: false });
    this.options = {
      bufferSize: 8192, // 8KB buffer by default
      quality: 'high',
      enableNormalization: true,
      enableNoiseReduction: false,
      ...options
    };

    logger.info('Audio converter initialized', {
      inputFormat: this.options.inputFormat,
      outputFormat: this.options.outputFormat,
      bufferSize: this.options.bufferSize,
      quality: this.options.quality
    });
  }

  public override _transform(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error, data?: Buffer) => void): void {
    try {
      this.inputBuffer.push(chunk);
      this.totalInputBytes += chunk.length;

      // Process when we have enough data or when stream ends
      const totalBufferSize = this.inputBuffer.reduce((sum, buf) => sum + buf.length, 0);
      
      if (totalBufferSize >= (this.options.bufferSize || 8192)) {
        this.processBuffer().then(result => {
          if (result) {
            this.totalOutputBytes += result.length;
            callback(null, result);
          } else {
            callback();
          }
        }).catch(error => {
          logger.error('Error processing audio buffer:', error);
          callback(error);
        });
      } else {
        callback();
      }
    } catch (error) {
      logger.error('Error in audio converter transform:', error);
      callback(error);
    }
  }

  public override _flush(callback: (error?: Error, data?: Buffer) => void): void {
    // Process any remaining buffer
    if (this.inputBuffer.length > 0) {
      this.processBuffer().then(result => {
        if (result) {
          this.totalOutputBytes += result.length;
          callback(null, result);
        } else {
          callback();
        }
      }).catch(error => {
        logger.error('Error flushing audio converter:', error);
        callback(error);
      });
    } else {
      callback();
    }
  }

  private async processBuffer(): Promise<Buffer | null> {
    if (this.inputBuffer.length === 0 || this.isProcessing) {
      return null;
    }

    try {
      this.isProcessing = true;
      const inputData = Buffer.concat(this.inputBuffer);
      this.inputBuffer = [];

      // Use simple resampling for real-time performance
      if (this.canUseSimpleResampling()) {
        return this.simpleResample(inputData);
      } else {
        // Use FFmpeg for complex conversions
        return await this.ffmpegConvert(inputData);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private canUseSimpleResampling(): boolean {
    const { inputFormat, outputFormat } = this.options;
    
    // Simple resampling works for:
    // 1. Same encoding (PCM16)
    // 2. Simple sample rate conversions (integer ratios)
    // 3. Channel mixing (stereo to mono)
    
    return (
      inputFormat.encoding === 'pcm_s16le' &&
      outputFormat.encoding === 'pcm_s16le' &&
      inputFormat.bitDepth === 16 &&
      outputFormat.bitDepth === 16 &&
      (inputFormat.sampleRate % outputFormat.sampleRate === 0 || 
       outputFormat.sampleRate % inputFormat.sampleRate === 0)
    );
  }

  private simpleResample(inputData: Buffer): Buffer {
    const { inputFormat, outputFormat } = this.options;
    
    try {
      // Step 1: Convert stereo to mono if needed
      let monoData = inputData;
      if (inputFormat.channels === 2 && outputFormat.channels === 1) {
        monoData = this.stereoToMono(inputData);
      } else if (inputFormat.channels === 1 && outputFormat.channels === 2) {
        monoData = this.monoToStereo(inputData);
      }

      // Step 2: Resample if needed
      let resampledData = monoData;
      if (inputFormat.sampleRate !== outputFormat.sampleRate) {
        resampledData = this.linearResample(
          monoData,
          inputFormat.sampleRate,
          outputFormat.sampleRate,
          outputFormat.channels
        );
      }

      // Step 3: Apply normalization if enabled
      if (this.options.enableNormalization) {
        resampledData = this.normalizeAudio(resampledData);
      }

      return resampledData;

    } catch (error) {
      logger.error('Error in simple resampling:', error);
      throw error;
    }
  }

  private stereoToMono(stereoData: Buffer): Buffer {
    const monoData = Buffer.alloc(stereoData.length / 2);
    
    for (let i = 0; i < stereoData.length; i += 4) {
      const left = stereoData.readInt16LE(i);
      const right = stereoData.readInt16LE(i + 2);
      
      // Average the two channels
      const mono = Math.round((left + right) / 2);
      monoData.writeInt16LE(mono, i / 2);
    }
    
    return monoData;
  }

  private monoToStereo(monoData: Buffer): Buffer {
    const stereoData = Buffer.alloc(monoData.length * 2);
    
    for (let i = 0; i < monoData.length; i += 2) {
      const sample = monoData.readInt16LE(i);
      
      // Duplicate mono sample to both channels
      stereoData.writeInt16LE(sample, i * 2);
      stereoData.writeInt16LE(sample, i * 2 + 2);
    }
    
    return stereoData;
  }

  private linearResample(data: Buffer, inputRate: number, outputRate: number, channels: number): Buffer {
    const ratio = outputRate / inputRate;
    const inputSamples = data.length / (2 * channels); // 16-bit samples
    const outputSamples = Math.floor(inputSamples * ratio);
    const outputData = Buffer.alloc(outputSamples * 2 * channels);

    for (let outputIndex = 0; outputIndex < outputSamples; outputIndex++) {
      const inputIndex = outputIndex / ratio;
      const inputIndexFloor = Math.floor(inputIndex);
      const inputIndexCeil = Math.min(inputIndexFloor + 1, inputSamples - 1);
      const fraction = inputIndex - inputIndexFloor;

      for (let channel = 0; channel < channels; channel++) {
        const sample1 = data.readInt16LE((inputIndexFloor * channels + channel) * 2);
        const sample2 = data.readInt16LE((inputIndexCeil * channels + channel) * 2);
        
        // Linear interpolation
        const interpolated = Math.round(sample1 + (sample2 - sample1) * fraction);
        outputData.writeInt16LE(interpolated, (outputIndex * channels + channel) * 2);
      }
    }

    return outputData;
  }

  private normalizeAudio(data: Buffer): Buffer {
    // Find peak amplitude
    let maxAmplitude = 0;
    for (let i = 0; i < data.length; i += 2) {
      const sample = Math.abs(data.readInt16LE(i));
      maxAmplitude = Math.max(maxAmplitude, sample);
    }

    if (maxAmplitude === 0) {
      return data; // Silent audio
    }

    // Calculate normalization factor (leave some headroom)
    const targetPeak = 28000; // ~85% of max 16-bit value
    const normalizationFactor = Math.min(targetPeak / maxAmplitude, 1.0);

    if (normalizationFactor >= 0.95) {
      return data; // Already normalized
    }

    // Apply normalization
    const normalizedData = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 2) {
      const sample = data.readInt16LE(i);
      const normalizedSample = Math.round(sample * normalizationFactor);
      normalizedData.writeInt16LE(normalizedSample, i);
    }

    return normalizedData;
  }

  private async ffmpegConvert(inputData: Buffer): Promise<Buffer> {
    const { inputFormat, outputFormat } = this.options;

    return new Promise((resolve, reject) => {
      if (!ffmpegPath) {
        reject(new Error('FFmpeg binary not found'));
        return;
      }

      const chunks: Buffer[] = [];
      
      // Build FFmpeg arguments
      const args = [
        '-f', 's16le',
        '-ar', inputFormat.sampleRate.toString(),
        '-ac', inputFormat.channels.toString(),
        '-i', 'pipe:0', // Read from stdin
        '-f', 's16le',
        '-ar', outputFormat.sampleRate.toString(),
        '-ac', outputFormat.channels.toString()
      ];

      // Add filters if needed
      const filters: string[] = [];
      
      if (this.options.quality === 'high') {
        filters.push('aresample=resampler=soxr:precision=28');
      }
      
      if (this.options.enableNoiseReduction) {
        filters.push('afftdn=nf=-25');
      }
      
      if (this.options.enableNormalization) {
        filters.push('dynaudnorm=f=75:g=25:p=0.95');
      }

      if (filters.length > 0) {
        args.push('-af', filters.join(','));
      }

      args.push('pipe:1'); // Write to stdout

      const ffmpegProcess = spawn(ffmpegPath, args);

      // Handle output
      ffmpegProcess.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      // Handle errors
      ffmpegProcess.stderr.on('data', (data) => {
        logger.debug('FFmpeg stderr:', data.toString());
      });

      ffmpegProcess.on('error', (error) => {
        logger.error('FFmpeg process error:', error);
        reject(error);
      });

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          const result = Buffer.concat(chunks);
          resolve(result);
        } else {
          reject(new Error(`FFmpeg process exited with code ${code}`));
        }
      });

      // Write input data to stdin
      ffmpegProcess.stdin.write(inputData);
      ffmpegProcess.stdin.end();
    });
  }

  public getStatistics() {
    const conversionTime = Date.now() - this.conversionStartTime;
    const compressionRatio = this.totalInputBytes > 0 ? this.totalOutputBytes / this.totalInputBytes : 0;

    return {
      totalInputBytes: this.totalInputBytes,
      totalOutputBytes: this.totalOutputBytes,
      compressionRatio,
      conversionTimeMs: conversionTime,
      throughputBytesPerSecond: conversionTime > 0 ? (this.totalInputBytes / conversionTime) * 1000 : 0,
      inputFormat: this.options.inputFormat,
      outputFormat: this.options.outputFormat
    };
  }
}

// Utility function to create optimized converter for AssemblyAI
export function createAssemblyAIConverter(inputFormat: AudioFormat): AudioConverter {
  const assemblyAIFormat: AudioFormat = {
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16,
    encoding: 'pcm_s16le'
  };

  return new AudioConverter({
    inputFormat,
    outputFormat: assemblyAIFormat,
    bufferSize: 3200, // 200ms at 16kHz mono (3200 bytes)
    quality: 'high',
    enableNormalization: true,
    enableNoiseReduction: false // Disable for real-time performance
  });
}

// Utility function to create converter for Discord audio
export function createDiscordAudioConverter(): AudioConverter {
  const discordFormat: AudioFormat = {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    encoding: 'pcm_s16le'
  };

  return createAssemblyAIConverter(discordFormat);
}

export default AudioConverter;