import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { config } from '../src/config/environment';
import { getAllCommands } from '../src/bot/commands';
import { createLogger } from '../src/utils/logger';
// import SummarizationSystem from '../src/summarization/index';
// import TranscriptManager from '../src/transcription/transcript-manager';

const logger = createLogger('CommandDeploy');

async function deployCommands() {
  try {
    logger.info('Starting command deployment...');

    // Initialize summarization system if OpenAI key is available
    let summarizationSystem: any = undefined;
    // if (config.openAiApiKey) {
    //   try {
    //     const transcriptManager = new TranscriptManager('./transcripts');
    //     summarizationSystem = new SummarizationSystem(transcriptManager);
    //     await summarizationSystem.initialize();
    //     logger.info('Summarization system initialized for command deployment');
    //   } catch (error) {
    //     logger.warn('Failed to initialize summarization system for command deployment:', error);
    //     summarizationSystem = undefined;
    //   }
    // }

    // Get all available commands (including summarization commands if available)
    const allCommands = getAllCommands(summarizationSystem);
    
    // Prepare command data
    const commandData = allCommands.map(command => command.data.toJSON());
    
    logger.info(`Deploying ${commandData.length} commands:`, {
      commands: commandData.map(cmd => cmd.name)
    });

    // Create REST client
    const rest = new REST({ version: '10' }).setToken(config.discordToken);

    if (config.guildId) {
      // Deploy to specific guild (faster for development)
      logger.info('Deploying commands to specific guild', { guildId: config.guildId });
      
      await rest.put(
        Routes.applicationGuildCommands(config.clientId, config.guildId),
        { body: commandData }
      );
      
      logger.info('Successfully deployed guild commands');
    } else {
      // Deploy globally (takes up to 1 hour to propagate)
      logger.info('Deploying commands globally');
      
      await rest.put(
        Routes.applicationCommands(config.clientId),
        { body: commandData }
      );
      
      logger.info('Successfully deployed global commands (may take up to 1 hour to propagate)');
    }

    // Cleanup summarization system if it was initialized
    if (summarizationSystem) {
      await summarizationSystem.cleanup();
    }

  } catch (error) {
    logger.error('Failed to deploy commands:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  deployCommands();
}

export default deployCommands;