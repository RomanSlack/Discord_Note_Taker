# AssemblyAI Real-time Transcription Integration

This document describes the comprehensive AssemblyAI integration for real-time speech-to-text transcription in the Discord Note Taker bot.

## Overview

The AssemblyAI integration provides production-ready real-time transcription capabilities with the following features:

- **Real-time streaming transcription** with 300ms target latency
- **Automatic audio format conversion** from Discord's 48kHz stereo to AssemblyAI's 16kHz mono
- **5-minute segment windows** for efficient storage and processing
- **Comprehensive cost tracking** with $0.15/hour pricing optimization
- **WebSocket reconnection** with exponential backoff for reliability
- **LZ4 compression** for transcript storage
- **Quality monitoring** and performance metrics

## Architecture

### Core Components

1. **AssemblyAI Streaming Client** (`src/transcription/assemblyai-client.ts`)
   - WebSocket connection to `wss://streaming.assemblyai.com/v3/ws`
   - Real-time audio streaming and transcript processing
   - Connection lifecycle management with automatic reconnection
   - Rate limiting and error handling

2. **Audio Converter** (`src/transcription/audio-converter.ts`)
   - Converts Discord audio (48kHz, stereo, PCM16) to AssemblyAI format (16kHz, mono, PCM16)
   - Supports both simple resampling and FFmpeg-based conversion
   - Audio normalization and quality enhancement
   - Real-time processing optimization

3. **Transcript Manager** (`src/transcription/transcript-manager.ts`)
   - Session management with 5-minute segment windows
   - LZ4 compression for storage efficiency
   - Comprehensive metadata tracking
   - Cost calculation and compression statistics

4. **Transcription Pipeline** (`src/transcription/transcription-pipeline.ts`)
   - End-to-end audio processing pipeline
   - Real-time confidence filtering
   - Quality monitoring and performance tracking
   - Integration with Discord audio streams

5. **Integrated Recording Manager** (`src/transcription/integrated-recording-manager.ts`)
   - Unified management of recording and transcription
   - Seamless integration with existing MultiTrackRecorder
   - Event coordination between audio and transcription systems

## Features

### Real-time Transcription
- **Streaming API**: Direct WebSocket connection to AssemblyAI
- **Low Latency**: Target 300ms from speech to transcript
- **Confidence Filtering**: Configurable threshold (default 70%)
- **Multiple Languages**: Support for English, Spanish, French, German, and auto-detection

### Audio Processing
- **Format Conversion**: Automatic conversion from Discord to AssemblyAI formats
- **Quality Enhancement**: Normalization and noise reduction options
- **Efficient Buffering**: Optimized for real-time processing
- **Memory Management**: Intelligent queue management to prevent overflow

### Storage & Compression
- **Segment Windows**: 5-minute chunks for efficient processing
- **LZ4 Compression**: Fast compression with ~3:1 ratios
- **Metadata Tracking**: Comprehensive session and segment metadata
- **Cost Optimization**: Intelligent streaming to minimize API usage

### Monitoring & Analytics
- **Performance Metrics**: Latency, throughput, and error tracking
- **Quality Monitoring**: Audio loss detection and accuracy metrics
- **Cost Tracking**: Real-time cost calculation and budgeting
- **Health Checks**: System status and connection monitoring

## Usage

### Basic Transcription Commands

```bash
# Start transcription for current voice channel
/transcribe start

# Start with custom settings
/transcribe start channel:#voice confidence:0.8 language:en_us

# Check transcription status
/transcribe status detailed:true

# Stop transcription
/transcribe stop

# View statistics
/transcribe stats
```

### Configuration

Add your AssemblyAI API key to your `.env` file:

```env
ASSEMBLY_AI_API_KEY=your_api_key_here
```

### Advanced Configuration

The system supports extensive configuration through the pipeline config:

```typescript
const pipelineConfig: TranscriptionPipelineConfig = {
  assemblyAI: {
    apiKey: 'your-api-key',
    sampleRate: 16000,
    channels: 1,
    confidenceThreshold: 0.7,
    languageCode: 'en_us',
    punctuate: true,
    formatText: true
  },
  audioFormat: {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    encoding: 'pcm_s16le'
  },
  bufferSize: 3200,
  maxLatencyMs: 500,
  enableRealTimeFiltering: true,
  enableQualityMonitoring: true
};
```

## Performance Optimization

### Target Metrics
- **Latency**: <300ms end-to-end
- **Throughput**: >1MB/s audio processing
- **Accuracy**: >90% confidence on clear audio
- **Uptime**: >99.9% with automatic reconnection
- **Cost**: <$0.15/hour actual usage

### Memory Management
- **Queue Limiting**: Maximum 1000 audio chunks in queue
- **Buffer Cleanup**: 30-second interval cleanup
- **Compression**: Real-time LZ4 compression
- **Segment Rotation**: Automatic 5-minute segment rotation

### Network Resilience
- **Reconnection**: Exponential backoff (1s to 30s)
- **Rate Limiting**: 10ms minimum between sends
- **Error Recovery**: Graceful handling of network issues
- **Connection Monitoring**: Ping/pong keepalive

## Cost Management

### Pricing Structure
- **Base Rate**: $0.15 per hour of audio
- **Actual Usage**: Only charged for audio sent to API
- **Compression Savings**: Reduced storage costs
- **Efficient Streaming**: Smart buffering to minimize API calls

### Cost Tracking
The system tracks:
- Real-time cost accumulation
- Audio minutes processed
- Compression savings
- Storage efficiency metrics

### Cost Optimization Features
- **Smart Buffering**: Batch audio chunks for efficiency
- **Silence Detection**: Avoid sending silent audio
- **Quality Filtering**: Skip low-confidence segments
- **Connection Pooling**: Efficient WebSocket usage

## Error Handling & Recovery

### Connection Issues
- **Automatic Reconnection**: Up to 5 attempts with exponential backoff
- **State Recovery**: Resume transcription after reconnection
- **Graceful Degradation**: Continue recording if transcription fails
- **Error Reporting**: Detailed error logging and user notifications

### Audio Processing Errors
- **Format Conversion Fallback**: Multiple conversion strategies
- **Buffer Overflow Protection**: Queue size management
- **Memory Leak Prevention**: Automatic cleanup routines
- **Quality Degradation Alerts**: Real-time quality monitoring

### API Rate Limiting
- **Request Throttling**: Built-in rate limiting
- **Queue Management**: Intelligent buffering
- **Backpressure Handling**: Adaptive streaming rates
- **Error Recovery**: Automatic retry with backoff

## Integration Points

### Discord Audio System
- **MultiTrackRecorder Integration**: Seamless audio segment processing
- **Voice Connection Management**: Shared connection handling
- **Event Coordination**: Synchronized recording and transcription events

### Storage System
- **File Organization**: Structured directory layout
- **Metadata Management**: Comprehensive session tracking
- **Compression Pipeline**: Automatic compression and archival
- **Export Capabilities**: Multiple format support (planned)

### Command System
- **Slash Commands**: Full `/transcribe` command suite
- **Permission Management**: Admin-only controls
- **User Feedback**: Rich embed responses with metrics
- **Error Messages**: Clear, actionable error reporting

## Development & Testing

### Local Development
1. Install dependencies: `npm install`
2. Configure API key in `.env`
3. Build project: `npm run build`
4. Start development: `npm run dev`

### Testing Checklist
- [ ] WebSocket connection establishment
- [ ] Audio format conversion accuracy
- [ ] Transcript quality and confidence
- [ ] Session management (start/stop/pause)
- [ ] Error handling and recovery
- [ ] Performance under load
- [ ] Cost tracking accuracy
- [ ] Memory leak testing

### Monitoring
- **Logs**: Structured logging with correlation IDs
- **Metrics**: Performance and quality metrics
- **Alerts**: Quality degradation and error alerts
- **Dashboards**: Real-time status and statistics

## Security Considerations

### API Key Management
- **Environment Variables**: Secure storage in `.env`
- **Access Control**: Admin-only configuration
- **Logging**: API keys redacted from logs
- **Rotation**: Support for key rotation

### Data Privacy
- **Ephemeral Processing**: Transcripts not permanently stored by default
- **Compression**: Local compression for efficiency
- **Access Control**: Server-specific transcription sessions
- **Data Retention**: Configurable retention policies

### Network Security
- **WSS Encryption**: Encrypted WebSocket connections
- **Authentication**: Bearer token authentication
- **Rate Limiting**: Protection against abuse
- **Error Information**: Minimal error details in responses

## Future Enhancements

### Planned Features
- [ ] **Speaker Diarization**: Post-processing speaker identification
- [ ] **Export Formats**: SRT, VTT, and structured export
- [ ] **Live Dashboard**: Real-time transcription viewing
- [ ] **Search Integration**: Full-text search across transcripts
- [ ] **AI Summarization**: OpenAI integration for summaries
- [ ] **Custom Vocabulary**: Domain-specific term recognition
- [ ] **Multi-language Support**: Expanded language detection
- [ ] **Transcript Editing**: Post-processing correction tools

### Scalability Improvements
- [ ] **Horizontal Scaling**: Multi-instance support
- [ ] **Database Integration**: Persistent transcript storage
- [ ] **Caching Layer**: Redis-based transcript caching
- [ ] **Load Balancing**: Distribution across multiple API keys
- [ ] **Batch Processing**: Offline transcript processing
- [ ] **Archive Management**: Long-term storage solutions

## Troubleshooting

### Common Issues

1. **Connection Failures**
   - Verify API key configuration
   - Check network connectivity
   - Review firewall settings

2. **Audio Quality Issues**
   - Check Discord audio quality
   - Verify voice channel permissions
   - Review confidence threshold settings

3. **Performance Problems**
   - Monitor memory usage
   - Check network latency
   - Review queue sizes

4. **Cost Concerns**
   - Monitor usage statistics
   - Adjust confidence thresholds
   - Review session durations

### Support Resources
- **Logs**: Check application logs for detailed error information
- **Metrics**: Review performance metrics in status commands
- **Documentation**: Refer to AssemblyAI API documentation
- **Community**: Discord server support channels

---

This integration provides a robust, production-ready real-time transcription system that seamlessly integrates with the existing Discord bot infrastructure while maintaining high performance, reliability, and cost efficiency.