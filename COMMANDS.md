# Discord Voice Companion Bot - Commands Reference

This document lists all available commands for the Discord Voice Companion Bot, your production-grade voice recording and note-taking assistant.

## 🎤 Basic Voice Commands

### `/join`
**Description:** Join your current voice channel  
**Usage:** `/join`  
**Requirements:** You must be in a voice channel  
**Example:** Type `/join` while in a voice channel and the bot will join you

### `/leave`
**Description:** Leave the current voice channel  
**Usage:** `/leave`  
**Requirements:** Bot must be in a voice channel  
**Example:** Type `/leave` to disconnect the bot from voice

### `/status`
**Description:** Show bot status and connection information  
**Usage:** `/status`  
**Requirements:** None  
**Shows:**
- Bot uptime and latency
- Active voice connections
- Audio stream information
- Guild count

### `/health`
**Description:** Show detailed health information (admin only)  
**Usage:** `/health`  
**Requirements:** Administrator permissions  
**Shows:**
- Overall system health
- Connection diagnostics
- Active sessions details
- Performance metrics

## 🎙️ Recording Commands

All recording commands use the `/record` base command with subcommands:

### `/record start`
**Description:** Start recording voice channel  
**Usage:** `/record start [channel] [format] [processing]`  
**Parameters:**
- `channel` (optional): Voice channel to record (defaults to your current channel)
- `format` (optional): Audio format - `pcm` (Raw Audio) or `wav` (with headers)
- `processing` (optional): Enable audio processing (noise reduction, normalization)

**Example:** `/record start format:wav processing:true`

### `/record stop`
**Description:** Stop current recording session  
**Usage:** `/record stop`  
**Requirements:** Active recording session  
**Result:** Saves and processes all recorded audio

### `/record pause`
**Description:** Pause current recording session  
**Usage:** `/record pause`  
**Requirements:** Active recording session  
**Note:** Recording can be resumed later with `/record resume`

### `/record resume`
**Description:** Resume paused recording session  
**Usage:** `/record resume`  
**Requirements:** Paused recording session  

### `/record status`
**Description:** Show recording session status  
**Usage:** `/record status [detailed]`  
**Parameters:**
- `detailed` (optional): Show detailed information including audio quality metrics

**Shows:**
- Current recording state
- Session duration
- Active participants
- Audio segments count
- Quality metrics (if detailed)

### `/record stats`
**Description:** Show recording statistics and storage usage  
**Usage:** `/record stats`  
**Shows:**
- Total sessions recorded
- Storage usage statistics
- Top speakers by duration
- Average session length
- File compression ratios

## 🤖 Bot Features

### Automatic Voice Management
- **Auto-join:** Bot automatically joins voice channels when users are present
- **Auto-leave:** Bot leaves empty voice channels after 5 minutes
- **Smart reconnection:** Automatic reconnection with retry logic

### Recording Features
- **Multi-user support:** Records each participant separately
- **Real-time processing:** 20ms audio packets with noise reduction
- **Smart segmentation:** 5-minute default segments (configurable)
- **Audio quality monitoring:** Tracks clarity, noise levels, and speaking patterns
- **Storage management:** Automatic cleanup and compression

### Audio Processing
- **Noise reduction:** Removes background noise
- **Normalization:** Equalizes audio levels
- **Silence detection:** Automatically trims silent periods
- **Format conversion:** Supports PCM and WAV formats
- **Quality analysis:** Real-time audio quality metrics

## 📁 File Organization

Recordings are saved in the following structure:
```
./recordings/
├── [session-id]/
│   ├── metadata.json          # Session information
│   ├── [user-id]-[username]/   # Individual user recordings
│   │   ├── segment-001.wav
│   │   ├── segment-002.wav
│   │   └── ...
│   └── combined/               # Mixed audio (if enabled)
│       └── session-mix.wav
```

## 🔧 Configuration Options

### Environment Variables
- `SEGMENT_WINDOW_SEC`: Audio segment duration (default: 300 seconds)
- `MAX_CONCURRENT_CONNECTIONS`: Maximum voice connections (default: 10)
- `VOICE_TIMEOUT`: Connection timeout (default: 30000ms)
- `LOG_LEVEL`: Logging verbosity (error, warn, info, debug)

### Audio Settings
- **Sample Rate:** 48kHz (Discord standard)
- **Bit Depth:** 16-bit
- **Channels:** Mono (1 channel per user)
- **Format:** PCM or WAV with headers

## 🛡️ Permissions Required

### Bot Permissions
- **View Channels** (1024)
- **Send Messages** (2048) 
- **Use Slash Commands** (2147483648)
- **Connect** (1048576)
- **Speak** (2097152)

### User Permissions
- **Basic commands:** No special permissions required
- **Recording commands:** Manage Channels permission
- **Health command:** Administrator permission

## 📊 Monitoring & Analytics

### Session Analytics
- Total recording time per user
- Audio quality metrics
- Speaking patterns and activity
- Session participation statistics

### Storage Analytics
- Total storage usage
- Compression effectiveness
- File organization metrics
- Cleanup and maintenance logs

## 🚨 Important Notes

### Privacy & Legal
- **Recording Disclosure:** Ensure all participants consent to recording
- **Data Retention:** Configure appropriate retention policies
- **Privacy Compliance:** Follow local privacy laws and regulations

### Performance
- **Resource Usage:** Monitor CPU and memory usage during long sessions
- **Storage Space:** Regularly monitor available disk space
- **Network Bandwidth:** Consider bandwidth usage for voice data

### Troubleshooting
- **Audio Issues:** Check `/record status detailed` for quality metrics
- **Connection Problems:** Use `/health` command to diagnose issues
- **Storage Issues:** Use `/record stats` to monitor usage

## 🔄 Future Features

The bot architecture supports future integration with:
- **AssemblyAI:** Real-time transcription services
- **OpenAI:** AI-powered conversation analysis and summarization
- **Database Storage:** Persistent conversation history
- **Web Dashboard:** Real-time monitoring interface
- **Advanced Audio Processing:** Speaker identification and audio enhancement

---

**Support:** For issues or questions, check the logs in the `logs/` directory or enable debug mode with `DEBUG_MODE=true` in your environment configuration.