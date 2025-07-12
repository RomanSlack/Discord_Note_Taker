import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';

const logger = createLogger('AudioAnalyzer');

export interface SpeakerActivity {
  userId: string;
  username: string;
  isSpeaking: boolean;
  speakingStartTime?: Date;
  speakingDuration: number;
  silenceDuration: number;
  lastActivity: Date;
  audioLevel: number;
  confidence: number;
}

export interface AudioQualityMetrics {
  userId: string;
  audioLevel: number; // dB
  signalToNoiseRatio: number; // dB
  dynamicRange: number; // dB
  clipCount: number;
  silenceRatio: number; // 0-1
  frequencyResponse: number[]; // Simplified frequency analysis
  clarity: number; // 0-1
  quality: 'poor' | 'fair' | 'good' | 'excellent';
}

export interface VoiceActivityDetection {
  isSpeech: boolean;
  confidence: number;
  energyLevel: number;
  spectralCentroid: number;
  zeroCrossingRate: number;
  hasVoicedSegments: boolean;
}

export interface SilenceDetection {
  isSilent: boolean;
  silenceDuration: number;
  leadingSilence: number;
  trailingSilence: number;
  speechSegments: Array<{
    start: number;
    end: number;
    duration: number;
    audioLevel: number;
  }>;
}

export class AudioAnalyzer extends EventEmitter {
  private readonly sampleRate: number = 48000;
  private readonly frameSize: number = 960; // 20ms at 48kHz
  private readonly silenceThreshold: number = -50; // dB
  private readonly speechThreshold: number = -35; // dB
  private readonly minSpeechDuration: number = 250; // ms
  
  // Activity tracking
  private speakerActivities: Map<string, SpeakerActivity> = new Map();
  private audioQualities: Map<string, AudioQualityMetrics> = new Map();
  
  // Analysis buffers
  private analysisBuffers: Map<string, Buffer[]> = new Map();
  private readonly maxBufferFrames = 50; // ~1 second of audio
  
  // Frequency analysis
  private fftSize = 1024;
  private windowFunction: number[] = [];

  constructor() {
    super();
    this.initializeWindowFunction();
    
    logger.info('Audio analyzer initialized', {
      sampleRate: this.sampleRate,
      frameSize: this.frameSize,
      silenceThreshold: this.silenceThreshold,
      speechThreshold: this.speechThreshold
    });
  }

  /**
   * Analyze audio frame for speaker activity detection
   */
  public analyzeSpeakerActivity(
    userId: string,
    username: string,
    audioData: Buffer,
    timestamp: Date = new Date()
  ): SpeakerActivity {
    try {
      // Get or create speaker activity tracking
      let activity = this.speakerActivities.get(userId);
      if (!activity) {
        activity = {
          userId,
          username,
          isSpeaking: false,
          speakingDuration: 0,
          silenceDuration: 0,
          lastActivity: timestamp,
          audioLevel: -Infinity,
          confidence: 0
        };
        this.speakerActivities.set(userId, activity);
      }

      // Calculate audio level
      const audioLevel = this.calculateAudioLevel(audioData);
      activity.audioLevel = audioLevel;

      // Perform voice activity detection
      const vad = this.detectVoiceActivity(audioData);
      
      // Update activity state
      const wasSpeaking = activity.isSpeaking;
      activity.isSpeaking = vad.isSpeech && audioLevel > this.speechThreshold;
      activity.confidence = vad.confidence;
      
      const timeDiff = timestamp.getTime() - activity.lastActivity.getTime();
      
      if (activity.isSpeaking) {
        if (!wasSpeaking) {
          // Started speaking
          activity.speakingStartTime = timestamp;
          this.emit('speaking-started', userId, activity);
          
          logger.debug('User started speaking', {
            userId,
            username,
            audioLevel: audioLevel.toFixed(2),
            confidence: vad.confidence.toFixed(2)
          });
        }
        
        activity.speakingDuration += timeDiff;
        activity.silenceDuration = 0;
      } else {
        if (wasSpeaking) {
          // Stopped speaking
          this.emit('speaking-stopped', userId, activity);
          
          logger.debug('User stopped speaking', {
            userId,
            username,
            speakingDuration: activity.speakingDuration
          });
        }
        
        activity.silenceDuration += timeDiff;
      }
      
      activity.lastActivity = timestamp;
      
      return activity;

    } catch (error) {
      logger.error('Error analyzing speaker activity:', error);
      return this.speakerActivities.get(userId) || {
        userId,
        username,
        isSpeaking: false,
        speakingDuration: 0,
        silenceDuration: 0,
        lastActivity: timestamp,
        audioLevel: -Infinity,
        confidence: 0
      };
    }
  }

  /**
   * Detect voice activity in audio data
   */
  public detectVoiceActivity(audioData: Buffer): VoiceActivityDetection {
    try {
      const samples = this.bufferToSamples(audioData);
      
      // Calculate energy level
      const energyLevel = this.calculateEnergy(samples);
      
      // Calculate zero crossing rate
      const zeroCrossingRate = this.calculateZeroCrossingRate(samples);
      
      // Calculate spectral centroid
      const spectralCentroid = this.calculateSpectralCentroid(samples);
      
      // Determine if this contains speech
      const isSpeech = this.classifyAsSpeech(energyLevel, zeroCrossingRate, spectralCentroid);
      
      // Calculate confidence
      const confidence = this.calculateVADConfidence(energyLevel, zeroCrossingRate, spectralCentroid);
      
      // Check for voiced segments
      const hasVoicedSegments = this.detectVoicedSegments(samples);

      return {
        isSpeech,
        confidence,
        energyLevel,
        spectralCentroid,
        zeroCrossingRate,
        hasVoicedSegments
      };

    } catch (error) {
      logger.error('Error in voice activity detection:', error);
      return {
        isSpeech: false,
        confidence: 0,
        energyLevel: 0,
        spectralCentroid: 0,
        zeroCrossingRate: 0,
        hasVoicedSegments: false
      };
    }
  }

  /**
   * Analyze audio quality metrics
   */
  public analyzeAudioQuality(userId: string, audioData: Buffer): AudioQualityMetrics {
    try {
      // Add to analysis buffer
      this.addToAnalysisBuffer(userId, audioData);
      
      // Get combined buffer for analysis
      const combinedBuffer = this.getCombinedBuffer(userId);
      if (combinedBuffer.length === 0) {
        return this.getDefaultQualityMetrics(userId);
      }

      const samples = this.bufferToSamples(combinedBuffer);
      
      // Calculate basic metrics
      const audioLevel = this.calculateAudioLevel(combinedBuffer);
      const signalToNoiseRatio = this.calculateSNR(samples);
      const dynamicRange = this.calculateDynamicRange(samples);
      const clipCount = this.countClipping(samples);
      const silenceRatio = this.calculateSilenceRatio(samples);
      
      // Perform frequency analysis
      const frequencyResponse = this.analyzeFrequencyResponse(samples);
      
      // Calculate clarity metric
      const clarity = this.calculateClarity(samples, frequencyResponse);
      
      // Determine overall quality
      const quality = this.determineOverallQuality(
        audioLevel,
        signalToNoiseRatio,
        dynamicRange,
        clipCount,
        silenceRatio,
        clarity
      );

      const metrics: AudioQualityMetrics = {
        userId,
        audioLevel,
        signalToNoiseRatio,
        dynamicRange,
        clipCount,
        silenceRatio,
        frequencyResponse,
        clarity,
        quality
      };

      this.audioQualities.set(userId, metrics);
      
      logger.debug('Audio quality analyzed', {
        userId,
        audioLevel: audioLevel.toFixed(2),
        snr: signalToNoiseRatio.toFixed(2),
        quality,
        clarity: clarity.toFixed(2)
      });

      return metrics;

    } catch (error) {
      logger.error('Error analyzing audio quality:', error);
      return this.getDefaultQualityMetrics(userId);
    }
  }

  /**
   * Detect and trim silence from audio
   */
  public detectSilence(audioData: Buffer): SilenceDetection {
    try {
      const samples = this.bufferToSamples(audioData);
      const frameLength = this.frameSize;
      const frames: number[][] = [];
      
      // Split into frames
      for (let i = 0; i < samples.length; i += frameLength) {
        const frame = samples.slice(i, Math.min(i + frameLength, samples.length));
        if (frame.length === frameLength) {
          frames.push(frame);
        }
      }

      // Analyze each frame
      const frameAnalysis = frames.map((frame, index) => {
        const audioLevel = this.calculateFrameAudioLevel(frame);
        const isSilent = audioLevel < this.silenceThreshold;
        
        return {
          index,
          audioLevel,
          isSilent,
          timestamp: (index * frameLength) / this.sampleRate * 1000 // ms
        };
      });

      // Find speech segments
      const speechSegments: Array<{
        start: number;
        end: number;
        duration: number;
        audioLevel: number;
      }> = [];

      let currentSegmentStart: number | null = null;
      let segmentAudioLevels: number[] = [];

      for (const frame of frameAnalysis) {
        if (!frame.isSilent) {
          if (currentSegmentStart === null) {
            currentSegmentStart = frame.timestamp;
            segmentAudioLevels = [frame.audioLevel];
          } else {
            segmentAudioLevels.push(frame.audioLevel);
          }
        } else {
          if (currentSegmentStart !== null) {
            // End of speech segment
            const avgAudioLevel = segmentAudioLevels.reduce((a, b) => a + b, 0) / segmentAudioLevels.length;
            const duration = frame.timestamp - currentSegmentStart;
            
            if (duration >= this.minSpeechDuration) {
              speechSegments.push({
                start: currentSegmentStart,
                end: frame.timestamp,
                duration,
                audioLevel: avgAudioLevel
              });
            }
            
            currentSegmentStart = null;
            segmentAudioLevels = [];
          }
        }
      }

      // Handle final segment
      if (currentSegmentStart !== null && frameAnalysis.length > 0) {
        const lastFrame = frameAnalysis[frameAnalysis.length - 1];
        const avgAudioLevel = segmentAudioLevels.reduce((a, b) => a + b, 0) / segmentAudioLevels.length;
        const duration = lastFrame.timestamp - currentSegmentStart;
        
        if (duration >= this.minSpeechDuration) {
          speechSegments.push({
            start: currentSegmentStart,
            end: lastFrame.timestamp,
            duration,
            audioLevel: avgAudioLevel
          });
        }
      }

      // Calculate silence metrics
      const totalDuration = (samples.length / this.sampleRate) * 1000; // ms
      const speechDuration = speechSegments.reduce((sum, seg) => sum + seg.duration, 0);
      const silenceDuration = totalDuration - speechDuration;
      const isSilent = speechSegments.length === 0;
      
      // Find leading and trailing silence
      const leadingSilence = speechSegments.length > 0 ? speechSegments[0].start : totalDuration;
      const trailingSilence = speechSegments.length > 0 
        ? totalDuration - speechSegments[speechSegments.length - 1].end
        : totalDuration;

      return {
        isSilent,
        silenceDuration,
        leadingSilence,
        trailingSilence,
        speechSegments
      };

    } catch (error) {
      logger.error('Error detecting silence:', error);
      return {
        isSilent: true,
        silenceDuration: 0,
        leadingSilence: 0,
        trailingSilence: 0,
        speechSegments: []
      };
    }
  }

  /**
   * Trim silence from audio data
   */
  public trimSilence(audioData: Buffer, aggressiveness: number = 0.5): Buffer {
    try {
      const silenceDetection = this.detectSilence(audioData);
      
      if (silenceDetection.isSilent || silenceDetection.speechSegments.length === 0) {
        return Buffer.alloc(0);
      }

      const samples = this.bufferToSamples(audioData);
      const sampleRate = this.sampleRate;
      
      // Calculate trim points based on aggressiveness
      const firstSegment = silenceDetection.speechSegments[0];
      const lastSegment = silenceDetection.speechSegments[silenceDetection.speechSegments.length - 1];
      
      // Keep some silence padding based on aggressiveness
      const paddingMs = (1 - aggressiveness) * 100; // 0-100ms padding
      
      const startTime = Math.max(0, firstSegment.start - paddingMs);
      const endTime = Math.min(
        (samples.length / sampleRate) * 1000,
        lastSegment.end + paddingMs
      );
      
      // Convert times to sample indices
      const startSample = Math.floor((startTime / 1000) * sampleRate);
      const endSample = Math.floor((endTime / 1000) * sampleRate);
      
      // Extract trimmed samples
      const trimmedSamples = samples.slice(startSample, endSample);
      
      // Convert back to buffer
      const trimmedBuffer = Buffer.alloc(trimmedSamples.length * 2);
      for (let i = 0; i < trimmedSamples.length; i++) {
        trimmedBuffer.writeInt16LE(Math.round(trimmedSamples[i]), i * 2);
      }

      logger.debug('Audio trimmed', {
        originalDuration: (samples.length / sampleRate * 1000).toFixed(0) + 'ms',
        trimmedDuration: (trimmedSamples.length / sampleRate * 1000).toFixed(0) + 'ms',
        speechSegments: silenceDetection.speechSegments.length,
        aggressiveness
      });

      return trimmedBuffer;

    } catch (error) {
      logger.error('Error trimming silence:', error);
      return audioData;
    }
  }

  // Private helper methods

  private bufferToSamples(buffer: Buffer): number[] {
    const samples: number[] = [];
    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i) / 32767; // Normalize to [-1, 1]
      samples.push(sample);
    }
    return samples;
  }

  private calculateAudioLevel(buffer: Buffer): number {
    if (buffer.length === 0) return -Infinity;

    let sum = 0;
    const numSamples = buffer.length / 2;

    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / numSamples);
    const dB = 20 * Math.log10(rms / 32767);
    
    return isFinite(dB) ? dB : -Infinity;
  }

  private calculateFrameAudioLevel(samples: number[]): number {
    if (samples.length === 0) return -Infinity;

    let sum = 0;
    for (const sample of samples) {
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / samples.length);
    const dB = 20 * Math.log10(rms);
    
    return isFinite(dB) ? dB : -Infinity;
  }

  private calculateEnergy(samples: number[]): number {
    let energy = 0;
    for (const sample of samples) {
      energy += sample * sample;
    }
    return energy / samples.length;
  }

  private calculateZeroCrossingRate(samples: number[]): number {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / (samples.length - 1);
  }

  private calculateSpectralCentroid(samples: number[]): number {
    // Simple approximation using zero-crossing rate
    // A more accurate implementation would use FFT
    const zcr = this.calculateZeroCrossingRate(samples);
    return zcr * this.sampleRate / 2; // Rough estimate
  }

  private classifyAsSpeech(energy: number, zcr: number, spectralCentroid: number): boolean {
    // Simple heuristic for speech detection
    const energyThreshold = 0.01;
    const zcrThreshold = 0.1;
    const spectralThreshold = 1000;
    
    return energy > energyThreshold && 
           zcr > zcrThreshold && 
           spectralCentroid > spectralThreshold;
  }

  private calculateVADConfidence(energy: number, zcr: number, spectralCentroid: number): number {
    // Normalize features and calculate confidence
    const energyScore = Math.min(energy * 100, 1);
    const zcrScore = Math.min(zcr * 10, 1);
    const spectralScore = Math.min(spectralCentroid / 5000, 1);
    
    return (energyScore + zcrScore + spectralScore) / 3;
  }

  private detectVoicedSegments(samples: number[]): boolean {
    // Look for periodic patterns characteristic of voiced speech
    const correlations = this.autocorrelation(samples.slice(0, Math.min(1024, samples.length)));
    
    // Find peaks in autocorrelation (indicating periodicity)
    let maxCorrelation = 0;
    for (let i = 20; i < correlations.length / 2; i++) { // Skip very short periods
      if (correlations[i] > maxCorrelation) {
        maxCorrelation = correlations[i];
      }
    }
    
    return maxCorrelation > 0.3; // Threshold for voiced speech
  }

  private autocorrelation(samples: number[]): number[] {
    const result: number[] = [];
    for (let lag = 0; lag < samples.length; lag++) {
      let correlation = 0;
      for (let i = 0; i < samples.length - lag; i++) {
        correlation += samples[i] * samples[i + lag];
      }
      result.push(correlation / (samples.length - lag));
    }
    return result;
  }

  private calculateSNR(samples: number[]): number {
    // Estimate SNR by comparing signal power in different frequency bands
    // This is a simplified approach
    const energy = this.calculateEnergy(samples);
    const highFreqEnergy = this.calculateHighFrequencyEnergy(samples);
    
    if (highFreqEnergy === 0) return 60; // Very clean signal
    
    const snr = 10 * Math.log10(energy / highFreqEnergy);
    return Math.max(0, Math.min(60, snr)); // Clamp to reasonable range
  }

  private calculateHighFrequencyEnergy(samples: number[]): number {
    // Simple high-pass filter to estimate noise
    let energy = 0;
    let prev = 0;
    
    for (const sample of samples) {
      const highPassed = sample - prev;
      energy += highPassed * highPassed;
      prev = sample;
    }
    
    return energy / samples.length;
  }

  private calculateDynamicRange(samples: number[]): number {
    let min = Infinity;
    let max = -Infinity;
    
    for (const sample of samples) {
      min = Math.min(min, Math.abs(sample));
      max = Math.max(max, Math.abs(sample));
    }
    
    if (min === 0) return 60; // Avoid log(0)
    
    return 20 * Math.log10(max / min);
  }

  private countClipping(samples: number[]): number {
    const threshold = 0.95; // 95% of full scale
    let clips = 0;
    
    for (const sample of samples) {
      if (Math.abs(sample) > threshold) {
        clips++;
      }
    }
    
    return clips;
  }

  private calculateSilenceRatio(samples: number[]): number {
    const threshold = 0.01; // Silence threshold
    let silentSamples = 0;
    
    for (const sample of samples) {
      if (Math.abs(sample) < threshold) {
        silentSamples++;
      }
    }
    
    return silentSamples / samples.length;
  }

  private analyzeFrequencyResponse(samples: number[]): number[] {
    // Simplified frequency analysis using overlapping windows
    const windowSize = 256;
    const overlap = 128;
    const numBins = 8; // Simplified to 8 frequency bands
    const bands: number[] = new Array(numBins).fill(0);
    
    for (let i = 0; i <= samples.length - windowSize; i += overlap) {
      const window = samples.slice(i, i + windowSize);
      const spectrum = this.simpleFFT(window);
      
      // Bin the spectrum into frequency bands
      const binSize = spectrum.length / numBins;
      for (let bin = 0; bin < numBins; bin++) {
        let energy = 0;
        const start = Math.floor(bin * binSize);
        const end = Math.floor((bin + 1) * binSize);
        
        for (let j = start; j < end; j++) {
          energy += spectrum[j] * spectrum[j];
        }
        
        bands[bin] += energy;
      }
    }
    
    // Normalize
    const maxEnergy = Math.max(...bands);
    if (maxEnergy > 0) {
      for (let i = 0; i < bands.length; i++) {
        bands[i] /= maxEnergy;
      }
    }
    
    return bands;
  }

  private simpleFFT(samples: number[]): number[] {
    // Very simplified FFT-like transform for demonstration
    // In a real implementation, you'd use a proper FFT library
    const result: number[] = [];
    const n = samples.length;
    
    for (let k = 0; k < n / 2; k++) {
      let real = 0;
      let imag = 0;
      
      for (let t = 0; t < n; t++) {
        const angle = 2 * Math.PI * k * t / n;
        real += samples[t] * Math.cos(angle);
        imag -= samples[t] * Math.sin(angle);
      }
      
      result.push(Math.sqrt(real * real + imag * imag));
    }
    
    return result;
  }

  private calculateClarity(samples: number[], frequencyResponse: number[]): number {
    // Combine multiple factors for clarity metric
    const snr = this.calculateSNR(samples);
    const dynamicRange = this.calculateDynamicRange(samples);
    const silenceRatio = this.calculateSilenceRatio(samples);
    
    // Frequency response balance (prefer mid-frequencies for speech)
    const midFreqWeight = (frequencyResponse[2] + frequencyResponse[3] + frequencyResponse[4]) / 3;
    
    // Combine factors
    const snrScore = Math.min(snr / 40, 1); // Normalize SNR
    const dynamicScore = Math.min(dynamicRange / 40, 1);
    const silenceScore = 1 - silenceRatio; // Less silence = better clarity
    const freqScore = midFreqWeight;
    
    return (snrScore + dynamicScore + silenceScore + freqScore) / 4;
  }

  private determineOverallQuality(
    audioLevel: number,
    snr: number,
    dynamicRange: number,
    clipCount: number,
    silenceRatio: number,
    clarity: number
  ): 'poor' | 'fair' | 'good' | 'excellent' {
    // Score each factor
    const levelScore = audioLevel > -30 && audioLevel < -10 ? 1 : 0.5;
    const snrScore = snr > 20 ? 1 : snr > 10 ? 0.7 : 0.3;
    const dynamicScore = dynamicRange > 20 ? 1 : dynamicRange > 10 ? 0.7 : 0.3;
    const clipScore = clipCount === 0 ? 1 : clipCount < 10 ? 0.7 : 0.3;
    const silenceScore = silenceRatio < 0.7 ? 1 : 0.5;
    const clarityScore = clarity;
    
    const totalScore = (levelScore + snrScore + dynamicScore + clipScore + silenceScore + clarityScore) / 6;
    
    if (totalScore > 0.8) return 'excellent';
    if (totalScore > 0.6) return 'good';
    if (totalScore > 0.4) return 'fair';
    return 'poor';
  }

  private addToAnalysisBuffer(userId: string, audioData: Buffer): void {
    if (!this.analysisBuffers.has(userId)) {
      this.analysisBuffers.set(userId, []);
    }
    
    const buffer = this.analysisBuffers.get(userId)!;
    buffer.push(audioData);
    
    // Keep only recent frames
    if (buffer.length > this.maxBufferFrames) {
      buffer.shift();
    }
  }

  private getCombinedBuffer(userId: string): Buffer {
    const buffers = this.analysisBuffers.get(userId);
    if (!buffers || buffers.length === 0) {
      return Buffer.alloc(0);
    }
    
    return Buffer.concat(buffers);
  }

  private getDefaultQualityMetrics(userId: string): AudioQualityMetrics {
    return {
      userId,
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

  private initializeWindowFunction(): void {
    // Initialize Hanning window for frequency analysis
    for (let i = 0; i < this.fftSize; i++) {
      this.windowFunction[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.fftSize - 1)));
    }
  }

  // Public accessors
  public getSpeakerActivity(userId: string): SpeakerActivity | null {
    return this.speakerActivities.get(userId) || null;
  }

  public getAllSpeakerActivities(): SpeakerActivity[] {
    return Array.from(this.speakerActivities.values());
  }

  public getAudioQuality(userId: string): AudioQualityMetrics | null {
    return this.audioQualities.get(userId) || null;
  }

  public getAllAudioQualities(): AudioQualityMetrics[] {
    return Array.from(this.audioQualities.values());
  }

  public getActiveSpeakers(): SpeakerActivity[] {
    return Array.from(this.speakerActivities.values()).filter(activity => activity.isSpeaking);
  }

  public cleanup(): void {
    logger.info('Cleaning up audio analyzer');
    
    this.speakerActivities.clear();
    this.audioQualities.clear();
    this.analysisBuffers.clear();
    
    logger.info('Audio analyzer cleanup completed');
  }
}

export default AudioAnalyzer;