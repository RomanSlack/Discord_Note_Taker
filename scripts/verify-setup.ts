import 'dotenv/config';
import { createLogger } from '../src/utils/logger';
import { config } from '../src/config/environment';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('SetupVerification');

interface VerificationResult {
  category: string;
  checks: Array<{
    name: string;
    status: 'pass' | 'fail' | 'warning';
    message: string;
  }>;
}

async function verifySetup(): Promise<void> {
  logger.info('Starting setup verification...');

  const results: VerificationResult[] = [];

  // Environment Configuration Checks
  const envChecks = {
    category: 'Environment Configuration',
    checks: [
      {
        name: 'Discord Token',
        status: config.discordToken ? 'pass' : 'fail',
        message: config.discordToken ? 'Token configured' : 'DISCORD_TOKEN not set in .env'
      },
      {
        name: 'Discord Client ID',
        status: config.clientId ? 'pass' : 'fail',
        message: config.clientId ? 'Client ID configured' : 'DISCORD_CLIENT_ID not set in .env'
      },
      {
        name: 'Guild ID (Optional)',
        status: config.guildId ? 'pass' : 'warning',
        message: config.guildId ? 'Guild ID configured for development' : 'DISCORD_GUILD_ID not set - commands will be deployed globally'
      },
      {
        name: 'Assembly AI Key (Optional)',
        status: config.assemblyAiApiKey ? 'pass' : 'warning',
        message: config.assemblyAiApiKey ? 'AssemblyAI API key configured' : 'ASSEMBLY_AI_API_KEY not set - transcription features will be limited'
      },
      {
        name: 'OpenAI Key (Optional)',
        status: config.openAiApiKey ? 'pass' : 'warning',
        message: config.openAiApiKey ? 'OpenAI API key configured' : 'OPENAI_API_KEY not set - AI features will be limited'
      }
    ]
  };
  results.push(envChecks as VerificationResult);

  // File Structure Checks
  const requiredFiles = [
    'src/bot/index.ts',
    'src/bot/client.ts',
    'src/bot/commands.ts',
    'src/voice/connection.ts',
    'src/voice/receiver.ts',
    'src/config/environment.ts',
    'src/config/settings.ts',
    'src/utils/logger.ts',
    'package.json',
    'tsconfig.json',
    '.env.example'
  ];

  const fileChecks = {
    category: 'Project Structure',
    checks: requiredFiles.map(file => ({
      name: file,
      status: fs.existsSync(path.join(process.cwd(), file)) ? 'pass' : 'fail',
      message: fs.existsSync(path.join(process.cwd(), file)) ? 'File exists' : 'File missing'
    }))
  };
  results.push(fileChecks as VerificationResult);

  // Directory Checks
  const requiredDirs = ['src', 'src/bot', 'src/voice', 'src/config', 'src/utils', 'logs'];
  const dirChecks = {
    category: 'Directory Structure',
    checks: requiredDirs.map(dir => ({
      name: dir,
      status: fs.existsSync(path.join(process.cwd(), dir)) ? 'pass' : 'fail',
      message: fs.existsSync(path.join(process.cwd(), dir)) ? 'Directory exists' : 'Directory missing'
    }))
  };
  results.push(dirChecks as VerificationResult);

  // Configuration Validation
  const configChecks = {
    category: 'Configuration Validation',
    checks: [
      {
        name: 'Segment Window',
        status: (config.segmentWindowSec >= 10 && config.segmentWindowSec <= 3600) ? 'pass' : 'warning',
        message: `Segment window: ${config.segmentWindowSec}s (recommended: 300s)`
      },
      {
        name: 'Max Connections',
        status: (config.maxConcurrentConnections >= 1 && config.maxConcurrentConnections <= 100) ? 'pass' : 'warning',
        message: `Max connections: ${config.maxConcurrentConnections} (recommended: 10)`
      },
      {
        name: 'Log Level',
        status: ['error', 'warn', 'info', 'debug'].includes(config.logLevel) ? 'pass' : 'warning',
        message: `Log level: ${config.logLevel}`
      },
      {
        name: 'Development Mode',
        status: 'pass',
        message: `Development mode: ${config.isDevelopment ? 'enabled' : 'disabled'}`
      }
    ]
  };
  results.push(configChecks as VerificationResult);

  // Dependencies Check
  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const requiredDeps = [
      'discord.js',
      '@discordjs/voice',
      '@discordjs/opus',
      'dotenv',
      'winston',
      'typescript'
    ];

    const depChecks = {
      category: 'Dependencies',
      checks: requiredDeps.map(dep => ({
        name: dep,
        status: (packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]) ? 'pass' : 'fail',
        message: (packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]) 
          ? `Version: ${packageJson.dependencies?.[dep] || packageJson.devDependencies?.[dep]}`
          : 'Not installed'
      }))
    };
    results.push(depChecks as VerificationResult);
  } catch (error) {
    results.push({
      category: 'Dependencies',
      checks: [{
        name: 'package.json',
        status: 'fail',
        message: 'Could not read package.json'
      }]
    });
  }

  // Print Results
  printResults(results);

  // Overall Status
  const totalChecks = results.reduce((total, result) => total + result.checks.length, 0);
  const passedChecks = results.reduce((total, result) => 
    total + result.checks.filter(check => check.status === 'pass').length, 0);
  const failedChecks = results.reduce((total, result) => 
    total + result.checks.filter(check => check.status === 'fail').length, 0);
  const warningChecks = results.reduce((total, result) => 
    total + result.checks.filter(check => check.status === 'warning').length, 0);

  logger.info('Setup verification completed', {
    total: totalChecks,
    passed: passedChecks,
    failed: failedChecks,
    warnings: warningChecks
  });

  if (failedChecks > 0) {
    logger.error(`Setup verification failed: ${failedChecks} critical issues found`);
    process.exit(1);
  } else if (warningChecks > 0) {
    logger.warn(`Setup verification completed with ${warningChecks} warnings`);
  } else {
    logger.info('Setup verification passed: All systems ready!');
  }
}

function printResults(results: VerificationResult[]): void {
  console.log('\n🔍 Setup Verification Results\n');

  for (const result of results) {
    console.log(`📁 ${result.category}`);
    console.log('─'.repeat(50));

    for (const check of result.checks) {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️';
      console.log(`${icon} ${check.name.padEnd(25)} ${check.message}`);
    }
    console.log('');
  }
}

// Run verification if this file is executed directly
if (require.main === module) {
  verifySetup().catch((error) => {
    logger.error('Setup verification failed:', error);
    process.exit(1);
  });
}

export default verifySetup;