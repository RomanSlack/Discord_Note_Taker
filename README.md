# Discord Voice Companion Bot

A sophisticated Discord bot that listens to voice channels, captures audio conversations, and provides AI-powered transcription and responses. Built with TypeScript, Discord.js v14, and modern voice processing capabilities.

## Features

- **Voice Channel Monitoring**: Automatically joins voice channels when users are present
- **Real-time Audio Capture**: Records and processes voice conversations with `selfDeaf: false`
- **Multi-user Support**: Handles multiple simultaneous speakers in voice channels
- **Smart Segmentation**: Processes audio in configurable time windows (default: 5 minutes)
- **Automatic Reconnection**: Robust connection management with retry logic
- **Slash Commands**: Modern Discord slash command interface
- **Comprehensive Logging**: Detailed logging with Winston
- **TypeScript**: Full type safety and modern development practices

## Quick Start

### Prerequisites

- Node.js 18.0.0 or higher
- A Discord application with bot token
- Required Discord bot permissions: View Channels, Connect, Speak

### Installation

1. **Clone and install dependencies:**
   ```bash
   git clone <repository>
   cd Discord_Note_Taker
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your Discord bot token and configuration
   ```

3. **Deploy slash commands:**
   ```bash
   npm run deploy-commands
   ```

4. **Start the bot:**
   ```bash
   npm run dev
   ```

## Configuration

### Required Environment Variables

```bash
# Discord Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_client_id_here
```

### Optional Configuration

```bash
# Guild-specific deployment (recommended for development)
DISCORD_GUILD_ID=your_guild_id_here

# Voice processing settings
SEGMENT_WINDOW_SEC=300           # Audio segment window (seconds)
MAX_CONCURRENT_CONNECTIONS=10    # Maximum voice connections
VOICE_TIMEOUT=30000             # Connection timeout (ms)
RECONNECT_ATTEMPTS=3            # Reconnection retries

# API keys for future transcription/AI features
ASSEMBLY_AI_API_KEY=your_assembly_ai_key
OPENAI_API_KEY=your_openai_key

# Logging
LOG_LEVEL=info                  # error, warn, info, debug
LOG_TO_FILE=true               # Write logs to files
DEBUG_MODE=false               # Enable debug logging
```

## Bot Setup

### Discord Application Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token to your `.env` file
5. Copy the application ID to `DISCORD_CLIENT_ID` in `.env`

### Bot Permissions

The bot requires these permissions:
- **View Channels** (1024)
- **Send Messages** (2048)
- **Use Slash Commands** (2147483648)
- **Connect** (1048576)
- **Speak** (2097152)

Bot permission integer: `2149532672`

### Invite URL Template
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2149532672&scope=bot%20applications.commands
```

## Architecture

### Project Structure
```
src/
├── bot/
│   ├── index.ts          # Main bot logic and event handlers
│   ├── client.ts         # Discord client management
│   └── commands.ts       # Slash command definitions
├── voice/
│   ├── connection.ts     # Voice connection management
│   └── receiver.ts       # Audio receiving and processing
├── config/
│   ├── environment.ts    # Environment configuration
│   └── settings.ts       # Bot settings management
└── utils/
    └── logger.ts         # Logging utilities
```

### Key Components

- **VoiceConnectionManager**: Handles joining/leaving voice channels with retry logic
- **VoiceReceiver**: Captures and processes audio streams from multiple users
- **DiscordClientManager**: Manages Discord client lifecycle and events
- **Logger**: Comprehensive logging with contextual information

## Available Commands

- `/join` - Join your current voice channel
- `/leave` - Leave the current voice channel
- `/status` - Show bot status and connection info
- `/health` - Show detailed health information (admin only)

## Development

### Scripts

```bash
npm run dev              # Start development server
npm run build           # Build TypeScript
npm run start           # Start production server
npm run deploy-commands # Deploy slash commands
npm run setup           # Install + deploy commands
npm run lint            # Run ESLint
npm run watch           # Watch mode compilation
```

### Voice Processing Pipeline

1. **Connection Management**: Bot joins voice channels when users are present
2. **Audio Capture**: Real-time audio streams captured with 20ms packets
3. **Stream Processing**: Individual user streams with silence detection
4. **Segmentation**: Audio organized into configurable time windows
5. **Future Integration**: Ready for transcription and AI processing

### Key Technical Features

- **selfDeaf: false**: Enables audio receiving from Discord voice
- **Multi-user Streams**: Simultaneous audio capture from multiple speakers
- **Buffer Management**: Efficient audio data handling and cleanup
- **Connection Stability**: Automatic reconnection and error recovery
- **Horizontal Scaling**: Architecture ready for multi-server deployment

## Logging

The bot provides comprehensive logging:

- **Console Output**: Colored, formatted logs for development
- **File Logging**: Persistent logs in `logs/` directory
- **Contextual Logging**: User, guild, and channel information
- **Performance Tracking**: Operation timing and monitoring
- **Error Handling**: Detailed error tracking and recovery

## Future Enhancements

This foundation is ready for:

- **AssemblyAI Integration**: Real-time transcription services
- **OpenAI Integration**: AI-powered conversation analysis
- **Database Storage**: Conversation history and analytics
- **Web Dashboard**: Real-time monitoring and control
- **Advanced Audio Processing**: Noise reduction, speaker identification

## Production Deployment

### Environment Setup
```bash
NODE_ENV=production
LOG_LEVEL=warn
DEBUG_MODE=false
```

### Docker Support (Future)
The project structure supports containerization for production deployment.

### Monitoring
- Health check endpoints ready for implementation
- Metrics collection prepared for monitoring systems
- Error tracking with detailed context

## Contributing

1. Follow TypeScript strict mode requirements
2. Use the provided logger for all output
3. Add comprehensive error handling
4. Update configuration schema for new features
5. Maintain backward compatibility

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions:
1. Check the logs in `logs/` directory
2. Enable debug mode with `DEBUG_MODE=true`
3. Review Discord permissions and bot setup
4. Verify environment configuration