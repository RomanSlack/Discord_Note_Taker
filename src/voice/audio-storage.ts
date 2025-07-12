import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createLogger } from '@utils/logger';
import { config } from '@config/environment';

const logger = createLogger('AudioStorage');

export interface StorageConfiguration {
  baseDirectory: string;
  maxFileSize: number; // bytes
  maxTotalSize: number; // bytes
  maxAge: number; // milliseconds
  compressionEnabled: boolean;
  encryptionEnabled: boolean;
  cleanupInterval: number; // milliseconds
  autoCleanup: boolean;
}

export interface StoredAudioFile {
  fileId: string;
  userId: string;
  sessionId: string;
  filename: string;
  filepath: string;
  size: number;
  created: Date;
  lastAccessed: Date;
  compressed: boolean;
  encrypted: boolean;
  metadata: AudioFileMetadata;
}

export interface AudioFileMetadata {
  duration: number; // milliseconds
  sampleRate: number;
  channels: number;
  bitDepth: number;
  format: string;
  audioLevel: number;
  quality: string;
  segmentCount: number;
  originalSize: number;
}

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  averageFileSize: number;
  oldestFile: Date | null;
  newestFile: Date | null;
  compressionRatio: number;
  storageByUser: Map<string, { files: number; size: number }>;
  storageBySession: Map<string, { files: number; size: number }>;
}

export interface CleanupPolicy {
  maxAge: number; // milliseconds
  maxTotalSize: number; // bytes
  maxFilesPerUser: number;
  maxFilesPerSession: number;
  preserveRecent: number; // always keep N most recent files
  filePatterns: string[]; // patterns to always preserve
}

export class AudioStorage extends EventEmitter {
  private configuration: StorageConfiguration;
  private storedFiles: Map<string, StoredAudioFile> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly encryptionKey: Buffer;

  constructor(configuration?: Partial<StorageConfiguration>) {
    super();
    
    this.configuration = {
      baseDirectory: './recordings',
      maxFileSize: 100 * 1024 * 1024, // 100MB
      maxTotalSize: 10 * 1024 * 1024 * 1024, // 10GB
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      compressionEnabled: false,
      encryptionEnabled: false,
      cleanupInterval: 60 * 60 * 1000, // 1 hour
      autoCleanup: true,
      ...configuration
    };

    // Generate encryption key (in production, this should be from secure storage)
    this.encryptionKey = crypto.randomBytes(32);

    this.initializeStorage();
  }

  private async initializeStorage(): Promise<void> {
    try {
      // Create base directory structure
      await this.createDirectoryStructure();

      // Load existing files
      await this.loadExistingFiles();

      // Start cleanup timer if enabled
      if (this.configuration.autoCleanup) {
        this.startCleanupTimer();
      }

      logger.info('Audio storage initialized', {
        baseDirectory: this.configuration.baseDirectory,
        maxTotalSize: (this.configuration.maxTotalSize / 1024 / 1024).toFixed(0) + 'MB',
        compressionEnabled: this.configuration.compressionEnabled,
        encryptionEnabled: this.configuration.encryptionEnabled,
        existingFiles: this.storedFiles.size
      });

    } catch (error) {
      logger.error('Failed to initialize audio storage:', error);
      throw error;
    }
  }

  /**
   * Store audio data to file system
   */
  public async storeAudio(
    userId: string,
    sessionId: string,
    audioData: Buffer,
    metadata: AudioFileMetadata,
    filename?: string
  ): Promise<StoredAudioFile> {
    try {
      // Validate file size
      if (audioData.length > this.configuration.maxFileSize) {
        throw new Error(`Audio file too large: ${audioData.length} bytes (max: ${this.configuration.maxFileSize})`);
      }

      // Check total storage limit
      const currentSize = await this.getTotalStorageSize();
      if (currentSize + audioData.length > this.configuration.maxTotalSize) {
        // Try cleanup first
        await this.performCleanup();
        
        const newCurrentSize = await this.getTotalStorageSize();
        if (newCurrentSize + audioData.length > this.configuration.maxTotalSize) {
          throw new Error('Storage limit exceeded and cleanup did not free enough space');
        }
      }

      // Generate file ID and path
      const fileId = this.generateFileId();
      const sessionDir = path.join(this.configuration.baseDirectory, 'sessions', sessionId);
      const userDir = path.join(sessionDir, 'users', userId);
      
      // Ensure directories exist
      await fs.promises.mkdir(userDir, { recursive: true });

      // Generate filename if not provided
      if (!filename) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const extension = metadata.format === 'wav' ? 'wav' : 'pcm';
        filename = `audio_${timestamp}_${fileId.substring(0, 8)}.${extension}`;
      }

      const filepath = path.join(userDir, filename);

      // Process audio data
      let processedData = audioData;
      let compressed = false;
      let encrypted = false;

      // Apply compression if enabled
      if (this.configuration.compressionEnabled && metadata.format === 'pcm') {
        processedData = await this.compressAudio(processedData);
        compressed = true;
      }

      // Apply encryption if enabled
      if (this.configuration.encryptionEnabled) {
        processedData = this.encryptData(processedData);
        encrypted = true;
      }

      // Write file
      await fs.promises.writeFile(filepath, processedData);

      // Create stored file record
      const storedFile: StoredAudioFile = {
        fileId,
        userId,
        sessionId,
        filename,
        filepath,
        size: processedData.length,
        created: new Date(),
        lastAccessed: new Date(),
        compressed,
        encrypted,
        metadata: {
          ...metadata,
          originalSize: audioData.length
        }
      };

      this.storedFiles.set(fileId, storedFile);

      // Save metadata file
      await this.saveFileMetadata(storedFile);

      logger.debug('Audio file stored', {
        fileId,
        userId,
        sessionId,
        filename,
        size: processedData.length,
        originalSize: audioData.length,
        compressed,
        encrypted
      });

      this.emit('file-stored', storedFile);

      return storedFile;

    } catch (error) {
      logger.error('Failed to store audio file:', error);
      throw error;
    }
  }

  /**
   * Retrieve audio data from storage
   */
  public async retrieveAudio(fileId: string): Promise<Buffer> {
    const storedFile = this.storedFiles.get(fileId);
    if (!storedFile) {
      throw new Error(`Audio file not found: ${fileId}`);
    }

    try {
      // Check if file still exists
      if (!await this.fileExists(storedFile.filepath)) {
        // Remove from memory and throw error
        this.storedFiles.delete(fileId);
        throw new Error(`Audio file missing from disk: ${storedFile.filepath}`);
      }

      // Read file data
      let data = await fs.promises.readFile(storedFile.filepath);

      // Decrypt if necessary
      if (storedFile.encrypted) {
        data = this.decryptData(data);
      }

      // Decompress if necessary
      if (storedFile.compressed) {
        data = await this.decompressAudio(data);
      }

      // Update last accessed time
      storedFile.lastAccessed = new Date();

      logger.debug('Audio file retrieved', {
        fileId,
        userId: storedFile.userId,
        size: data.length
      });

      return data;

    } catch (error) {
      logger.error('Failed to retrieve audio file:', error);
      throw error;
    }
  }

  /**
   * Delete audio file from storage
   */
  public async deleteAudio(fileId: string): Promise<void> {
    const storedFile = this.storedFiles.get(fileId);
    if (!storedFile) {
      throw new Error(`Audio file not found: ${fileId}`);
    }

    try {
      // Delete physical file
      if (await this.fileExists(storedFile.filepath)) {
        await fs.promises.unlink(storedFile.filepath);
      }

      // Delete metadata file
      const metadataPath = storedFile.filepath + '.meta';
      if (await this.fileExists(metadataPath)) {
        await fs.promises.unlink(metadataPath);
      }

      // Remove from memory
      this.storedFiles.delete(fileId);

      logger.debug('Audio file deleted', {
        fileId,
        userId: storedFile.userId,
        filepath: storedFile.filepath
      });

      this.emit('file-deleted', fileId, storedFile);

    } catch (error) {
      logger.error('Failed to delete audio file:', error);
      throw error;
    }
  }

  /**
   * Get storage statistics
   */
  public async getStorageStats(): Promise<StorageStats> {
    const files = Array.from(this.storedFiles.values());
    
    const totalFiles = files.length;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    const averageFileSize = totalFiles > 0 ? totalSize / totalFiles : 0;
    
    const dates = files.map(f => f.created.getTime());
    const oldestFile = dates.length > 0 ? new Date(Math.min(...dates)) : null;
    const newestFile = dates.length > 0 ? new Date(Math.max(...dates)) : null;
    
    // Calculate compression ratio
    const originalSize = files.reduce((sum, file) => sum + file.metadata.originalSize, 0);
    const compressionRatio = originalSize > 0 ? totalSize / originalSize : 1;
    
    // Group by user
    const storageByUser = new Map<string, { files: number; size: number }>();
    for (const file of files) {
      const existing = storageByUser.get(file.userId) || { files: 0, size: 0 };
      existing.files++;
      existing.size += file.size;
      storageByUser.set(file.userId, existing);
    }
    
    // Group by session
    const storageBySession = new Map<string, { files: number; size: number }>();
    for (const file of files) {
      const existing = storageBySession.get(file.sessionId) || { files: 0, size: 0 };
      existing.files++;
      existing.size += file.size;
      storageBySession.set(file.sessionId, existing);
    }

    return {
      totalFiles,
      totalSize,
      averageFileSize,
      oldestFile,
      newestFile,
      compressionRatio,
      storageByUser,
      storageBySession
    };
  }

  /**
   * Perform cleanup based on policies
   */
  public async performCleanup(policy?: Partial<CleanupPolicy>): Promise<number> {
    const cleanupPolicy: CleanupPolicy = {
      maxAge: this.configuration.maxAge,
      maxTotalSize: this.configuration.maxTotalSize,
      maxFilesPerUser: 1000,
      maxFilesPerSession: 5000,
      preserveRecent: 10,
      filePatterns: [],
      ...policy
    };

    logger.info('Starting storage cleanup', cleanupPolicy);

    let deletedCount = 0;

    try {
      const files = Array.from(this.storedFiles.values());
      const now = Date.now();
      const filesToDelete: string[] = [];

      // 1. Delete files older than maxAge
      for (const file of files) {
        const age = now - file.created.getTime();
        if (age > cleanupPolicy.maxAge) {
          filesToDelete.push(file.fileId);
        }
      }

      // 2. If still over size limit, delete oldest files
      const currentSize = files.reduce((sum, file) => sum + file.size, 0);
      if (currentSize > cleanupPolicy.maxTotalSize) {
        const sortedByAge = files
          .filter(file => !filesToDelete.includes(file.fileId))
          .sort((a, b) => a.created.getTime() - b.created.getTime());

        let sizeSaved = 0;
        const targetReduction = currentSize - cleanupPolicy.maxTotalSize;

        for (const file of sortedByAge) {
          if (sizeSaved >= targetReduction) break;
          
          // Preserve recent files
          if (sortedByAge.length - filesToDelete.length <= cleanupPolicy.preserveRecent) {
            break;
          }

          filesToDelete.push(file.fileId);
          sizeSaved += file.size;
        }
      }

      // 3. Enforce per-user limits
      const userFileCounts = new Map<string, StoredAudioFile[]>();
      for (const file of files) {
        if (!filesToDelete.includes(file.fileId)) {
          if (!userFileCounts.has(file.userId)) {
            userFileCounts.set(file.userId, []);
          }
          userFileCounts.get(file.userId)!.push(file);
        }
      }

      for (const [userId, userFiles] of userFileCounts) {
        if (userFiles.length > cleanupPolicy.maxFilesPerUser) {
          const sortedUserFiles = userFiles.sort((a, b) => a.created.getTime() - b.created.getTime());
          const toRemove = sortedUserFiles.slice(0, userFiles.length - cleanupPolicy.maxFilesPerUser);
          
          for (const file of toRemove) {
            filesToDelete.push(file.fileId);
          }
        }
      }

      // 4. Enforce per-session limits
      const sessionFileCounts = new Map<string, StoredAudioFile[]>();
      for (const file of files) {
        if (!filesToDelete.includes(file.fileId)) {
          if (!sessionFileCounts.has(file.sessionId)) {
            sessionFileCounts.set(file.sessionId, []);
          }
          sessionFileCounts.get(file.sessionId)!.push(file);
        }
      }

      for (const [sessionId, sessionFiles] of sessionFileCounts) {
        if (sessionFiles.length > cleanupPolicy.maxFilesPerSession) {
          const sortedSessionFiles = sessionFiles.sort((a, b) => a.created.getTime() - b.created.getTime());
          const toRemove = sortedSessionFiles.slice(0, sessionFiles.length - cleanupPolicy.maxFilesPerSession);
          
          for (const file of toRemove) {
            filesToDelete.push(file.fileId);
          }
        }
      }

      // Remove duplicates and delete files
      const uniqueFilesToDelete = [...new Set(filesToDelete)];
      
      for (const fileId of uniqueFilesToDelete) {
        try {
          await this.deleteAudio(fileId);
          deletedCount++;
        } catch (error) {
          logger.warn('Failed to delete file during cleanup:', { fileId, error });
        }
      }

      // Clean up empty directories
      await this.cleanupEmptyDirectories();

      logger.info('Storage cleanup completed', {
        deletedFiles: deletedCount,
        remainingFiles: this.storedFiles.size
      });

      this.emit('cleanup-completed', deletedCount);

      return deletedCount;

    } catch (error) {
      logger.error('Error during storage cleanup:', error);
      throw error;
    }
  }

  /**
   * Get files by user
   */
  public getFilesByUser(userId: string): StoredAudioFile[] {
    return Array.from(this.storedFiles.values()).filter(file => file.userId === userId);
  }

  /**
   * Get files by session
   */
  public getFilesBySession(sessionId: string): StoredAudioFile[] {
    return Array.from(this.storedFiles.values()).filter(file => file.sessionId === sessionId);
  }

  /**
   * Get file information
   */
  public getFileInfo(fileId: string): StoredAudioFile | null {
    return this.storedFiles.get(fileId) || null;
  }

  // Private helper methods

  private async createDirectoryStructure(): Promise<void> {
    const dirs = [
      this.configuration.baseDirectory,
      path.join(this.configuration.baseDirectory, 'sessions'),
      path.join(this.configuration.baseDirectory, 'temp'),
      path.join(this.configuration.baseDirectory, 'metadata')
    ];

    for (const dir of dirs) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private async loadExistingFiles(): Promise<void> {
    try {
      const sessionsDir = path.join(this.configuration.baseDirectory, 'sessions');
      
      if (!await this.fileExists(sessionsDir)) {
        return;
      }

      const sessionDirs = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
      
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        
        const sessionPath = path.join(sessionsDir, sessionDir.name);
        const usersDir = path.join(sessionPath, 'users');
        
        if (!await this.fileExists(usersDir)) continue;
        
        const userDirs = await fs.promises.readdir(usersDir, { withFileTypes: true });
        
        for (const userDir of userDirs) {
          if (!userDir.isDirectory()) continue;
          
          const userPath = path.join(usersDir, userDir.name);
          const files = await fs.promises.readdir(userPath);
          
          for (const filename of files) {
            if (filename.endsWith('.meta')) continue; // Skip metadata files
            
            const filepath = path.join(userPath, filename);
            const metadataPath = filepath + '.meta';
            
            try {
              // Load metadata
              if (await this.fileExists(metadataPath)) {
                const metadataContent = await fs.promises.readFile(metadataPath, 'utf8');
                const storedFile: StoredAudioFile = JSON.parse(metadataContent);
                
                // Update the filepath in case directory structure changed
                storedFile.filepath = filepath;
                
                this.storedFiles.set(storedFile.fileId, storedFile);
              } else {
                // Create basic metadata for files without metadata
                const stats = await fs.promises.stat(filepath);
                const fileId = this.generateFileId();
                
                const storedFile: StoredAudioFile = {
                  fileId,
                  userId: userDir.name,
                  sessionId: sessionDir.name,
                  filename,
                  filepath,
                  size: stats.size,
                  created: stats.birthtime,
                  lastAccessed: stats.atime,
                  compressed: false,
                  encrypted: false,
                  metadata: {
                    duration: 0,
                    sampleRate: 48000,
                    channels: 2,
                    bitDepth: 16,
                    format: 'unknown',
                    audioLevel: 0,
                    quality: 'unknown',
                    segmentCount: 1,
                    originalSize: stats.size
                  }
                };
                
                this.storedFiles.set(fileId, storedFile);
                await this.saveFileMetadata(storedFile);
              }
              
            } catch (error) {
              logger.warn('Failed to load existing file:', { filepath, error });
            }
          }
        }
      }

      logger.debug('Loaded existing files', { count: this.storedFiles.size });

    } catch (error) {
      logger.error('Error loading existing files:', error);
    }
  }

  private async saveFileMetadata(storedFile: StoredAudioFile): Promise<void> {
    const metadataPath = storedFile.filepath + '.meta';
    const metadata = JSON.stringify(storedFile, null, 2);
    await fs.promises.writeFile(metadataPath, metadata);
  }

  private async fileExists(filepath: string): Promise<boolean> {
    try {
      await fs.promises.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  private generateFileId(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  private async getTotalStorageSize(): Promise<number> {
    return Array.from(this.storedFiles.values()).reduce((sum, file) => sum + file.size, 0);
  }

  private async compressAudio(data: Buffer): Promise<Buffer> {
    // Simple compression using gzip
    const zlib = await import('zlib');
    return new Promise((resolve, reject) => {
      zlib.gzip(data, (err, compressed) => {
        if (err) reject(err);
        else resolve(compressed);
      });
    });
  }

  private async decompressAudio(data: Buffer): Promise<Buffer> {
    // Decompress using gzip
    const zlib = await import('zlib');
    return new Promise((resolve, reject) => {
      zlib.gunzip(data, (err, decompressed) => {
        if (err) reject(err);
        else resolve(decompressed);
      });
    });
  }

  private encryptData(data: Buffer): Buffer {
    const algorithm = 'aes-256-gcm';
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipher(algorithm, this.encryptionKey);
    
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = (cipher as any).getAuthTag();
    
    // Combine IV + authTag + encrypted data
    return Buffer.concat([iv, authTag, encrypted]);
  }

  private decryptData(data: Buffer): Buffer {
    const algorithm = 'aes-256-gcm';
    const iv = data.slice(0, 16);
    const authTag = data.slice(16, 32);
    const encrypted = data.slice(32);
    
    const decipher = crypto.createDecipher(algorithm, this.encryptionKey);
    (decipher as any).setAuthTag(authTag);
    
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup().catch(error => {
        logger.error('Error during scheduled cleanup:', error);
      });
    }, this.configuration.cleanupInterval);

    logger.debug('Cleanup timer started', {
      interval: this.configuration.cleanupInterval
    });
  }

  private async cleanupEmptyDirectories(): Promise<void> {
    try {
      const sessionsDir = path.join(this.configuration.baseDirectory, 'sessions');
      const sessionDirs = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
      
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.isDirectory()) continue;
        
        const sessionPath = path.join(sessionsDir, sessionDir.name);
        const usersDir = path.join(sessionPath, 'users');
        
        if (await this.fileExists(usersDir)) {
          const userDirs = await fs.promises.readdir(usersDir, { withFileTypes: true });
          
          // Remove empty user directories
          for (const userDir of userDirs) {
            if (!userDir.isDirectory()) continue;
            
            const userPath = path.join(usersDir, userDir.name);
            const files = await fs.promises.readdir(userPath);
            
            if (files.length === 0) {
              await fs.promises.rmdir(userPath);
              logger.debug('Removed empty user directory', { path: userPath });
            }
          }
          
          // Remove empty users directory
          const remainingUserDirs = await fs.promises.readdir(usersDir);
          if (remainingUserDirs.length === 0) {
            await fs.promises.rmdir(usersDir);
            logger.debug('Removed empty users directory', { path: usersDir });
          }
        }
        
        // Remove empty session directory
        const sessionFiles = await fs.promises.readdir(sessionPath);
        if (sessionFiles.length === 0) {
          await fs.promises.rmdir(sessionPath);
          logger.debug('Removed empty session directory', { path: sessionPath });
        }
      }

    } catch (error) {
      logger.warn('Error cleaning up empty directories:', error);
    }
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up audio storage');

    try {
      // Stop cleanup timer
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }

      // Clear memory
      this.storedFiles.clear();

      logger.info('Audio storage cleanup completed');

    } catch (error) {
      logger.error('Error during audio storage cleanup:', error);
      throw error;
    }
  }
}

export default AudioStorage;