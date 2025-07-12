import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from '@utils/logger';
import { MeetingSummaryReport, ActionItem, Decision } from './meeting-summarizer';

const logger = createLogger('PDFGenerator');

export interface PDFGenerationOptions {
  template: 'professional' | 'compact' | 'detailed';
  includeCover: boolean;
  includeActionItems: boolean;
  includeDecisions: boolean;
  includeMetadata: boolean;
  includeAppendices: boolean;
  watermark?: string;
  branding?: BrandingOptions;
}

export interface BrandingOptions {
  companyName?: string;
  logoPath?: string;
  primaryColor?: string;
  secondaryColor?: string;
  font?: string;
}

export interface PDFGenerationResult {
  filePath: string;
  fileName: string;
  fileSize: number;
  pageCount: number;
  generationTime: number;
  metadata: PDFMetadata;
}

export interface PDFMetadata {
  title: string;
  subject: string;
  author: string;
  creator: string;
  keywords: string[];
  creationDate: Date;
  modificationDate: Date;
}

export class PDFGenerator extends EventEmitter {
  private outputDir: string;
  private defaultOptions: PDFGenerationOptions;
  private defaultBranding: BrandingOptions;

  constructor(outputDir: string = './reports') {
    super();
    
    this.outputDir = outputDir;
    this.defaultOptions = {
      template: 'professional',
      includeCover: true,
      includeActionItems: true,
      includeDecisions: true,
      includeMetadata: true,
      includeAppendices: false,
      branding: {
        companyName: 'Discord Voice Companion',
        primaryColor: '#5865F2', // Discord blurple
        secondaryColor: '#57F287', // Discord green
        font: 'Helvetica'
      }
    };

    this.defaultBranding = this.defaultOptions.branding!;
    
    this.ensureOutputDirectory();
    
    logger.info('PDF generator initialized', {
      outputDir: this.outputDir,
      template: this.defaultOptions.template
    });
  }

  public async generateReport(
    report: MeetingSummaryReport,
    options?: Partial<PDFGenerationOptions>
  ): Promise<PDFGenerationResult> {
    const startTime = Date.now();
    const mergedOptions = { ...this.defaultOptions, ...options };
    
    try {
      logger.info('Starting PDF generation', {
        sessionId: report.sessionId,
        template: mergedOptions.template,
        participants: report.participants.length
      });

      // Create PDF document
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Meeting Report - ${report.meetingTitle}`,
          Subject: `Meeting Summary for ${report.sessionId}`,
          Author: mergedOptions.branding?.companyName || 'Discord Voice Companion',
          Creator: 'Discord Voice Companion Bot',
          Keywords: this.generateKeywords(report).join(', ')
        }
      });

      // Generate filename
      const fileName = this.generateFileName(report);
      const filePath = path.join(this.outputDir, fileName);

      // Create write stream
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Generate content based on template
      switch (mergedOptions.template) {
        case 'professional':
          await this.generateProfessionalTemplate(doc, report, mergedOptions);
          break;
        case 'compact':
          await this.generateCompactTemplate(doc, report, mergedOptions);
          break;
        case 'detailed':
          await this.generateDetailedTemplate(doc, report, mergedOptions);
          break;
      }

      // Finalize document
      doc.end();

      // Wait for stream to finish
      await new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      // Get file stats
      const stats = await fs.promises.stat(filePath);
      const generationTime = Date.now() - startTime;

      const result: PDFGenerationResult = {
        filePath,
        fileName,
        fileSize: stats.size,
        pageCount: this.getPageCount(doc),
        generationTime,
        metadata: {
          title: `Meeting Report - ${report.meetingTitle}`,
          subject: `Meeting Summary for ${report.sessionId}`,
          author: mergedOptions.branding?.companyName || 'Discord Voice Companion',
          creator: 'Discord Voice Companion Bot',
          keywords: this.generateKeywords(report),
          creationDate: new Date(),
          modificationDate: new Date()
        }
      };

      logger.info('PDF generation completed', {
        sessionId: report.sessionId,
        fileName,
        fileSize: stats.size,
        pageCount: result.pageCount,
        generationTime
      });

      this.emit('pdf-generated', result);
      return result;

    } catch (error) {
      const generationTime = Date.now() - startTime;
      
      logger.error('PDF generation failed', {
        sessionId: report.sessionId,
        generationTime,
        error: error instanceof Error ? error.message : String(error)
      });

      this.emit('pdf-generation-error', error, report);
      throw error;
    }
  }

  private async generateProfessionalTemplate(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): Promise<void> {
    // Cover page
    if (options.includeCover) {
      this.addCoverPage(doc, report, options);
      doc.addPage();
    }

    // Table of contents
    this.addTableOfContents(doc, report, options);
    doc.addPage();

    // Executive summary
    this.addExecutiveSummary(doc, report);
    doc.addPage();

    // Meeting details
    this.addMeetingDetails(doc, report);

    // Key discussions
    if (report.keyDiscussions.length > 0) {
      doc.addPage();
      this.addKeyDiscussions(doc, report);
    }

    // Decisions
    if (options.includeDecisions && report.decisions.length > 0) {
      doc.addPage();
      this.addDecisions(doc, report);
    }

    // Action items
    if (options.includeActionItems && report.actionItems.length > 0) {
      doc.addPage();
      this.addActionItems(doc, report);
    }

    // Next steps
    if (report.nextSteps.length > 0) {
      doc.addPage();
      this.addNextSteps(doc, report);
    }

    // Metadata and appendices
    if (options.includeMetadata) {
      doc.addPage();
      this.addMetadata(doc, report);
    }

    // Footer on all pages
    this.addPageFooters(doc, report, options);
  }

  private async generateCompactTemplate(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): Promise<void> {
    // Header
    this.addCompactHeader(doc, report, options);
    
    // Meeting overview
    this.addCompactMeetingOverview(doc, report);
    
    // Key highlights
    this.addCompactHighlights(doc, report);
    
    // Action items (if any)
    if (options.includeActionItems && report.actionItems.length > 0) {
      this.addCompactActionItems(doc, report);
    }
    
    // Footer
    this.addCompactFooter(doc, report);
  }

  private async generateDetailedTemplate(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): Promise<void> {
    // Extended professional template with more sections
    await this.generateProfessionalTemplate(doc, report, options);
    
    // Additional detailed sections
    if (report.participants.length > 0) {
      doc.addPage();
      this.addParticipantAnalysis(doc, report);
    }
    
    // Quality metrics
    doc.addPage();
    this.addQualityMetrics(doc, report);
    
    // Detailed appendices
    if (options.includeAppendices) {
      doc.addPage();
      this.addDetailedAppendices(doc, report);
    }
  }

  private addCoverPage(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): void {
    const branding = options.branding || this.defaultBranding;
    
    // Company logo/name
    doc.fontSize(24)
       .fillColor(branding.primaryColor || '#5865F2')
       .text(branding.companyName || 'Discord Voice Companion', 50, 100, { align: 'center' });

    // Title
    doc.fontSize(20)
       .fillColor('#000000')
       .text('MEETING REPORT', 50, 200, { align: 'center' });

    // Meeting title
    doc.fontSize(16)
       .text(report.meetingTitle, 50, 240, { align: 'center' });

    // Date and time
    const dateStr = report.startTime.toLocaleDateString();
    const timeStr = `${report.startTime.toLocaleTimeString()} - ${report.endTime.toLocaleTimeString()}`;
    
    doc.fontSize(12)
       .text(`${dateStr}`, 50, 300, { align: 'center' })
       .text(`${timeStr}`, 50, 320, { align: 'center' });

    // Participants
    doc.text(`Participants: ${report.participants.length}`, 50, 360, { align: 'center' });

    // Duration
    const durationMin = Math.round(report.duration / 60000);
    doc.text(`Duration: ${durationMin} minutes`, 50, 380, { align: 'center' });

    // Watermark
    if (options.watermark) {
      doc.fontSize(72)
         .fillColor('#CCCCCC', 0.3)
         .text(options.watermark, 0, 400, {
           align: 'center',
           angle: -45
         });
    }
  }

  private addTableOfContents(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): void {
    doc.fontSize(18)
       .fillColor('#000000')
       .text('Table of Contents', 50, 100);

    let yPos = 140;
    const lineHeight = 20;

    const sections = [
      'Executive Summary',
      'Meeting Details',
      'Key Discussions'
    ];

    if (options.includeDecisions && report.decisions.length > 0) {
      sections.push('Decisions Made');
    }

    if (options.includeActionItems && report.actionItems.length > 0) {
      sections.push('Action Items');
    }

    if (report.nextSteps.length > 0) {
      sections.push('Next Steps');
    }

    if (options.includeMetadata) {
      sections.push('Meeting Metadata');
    }

    doc.fontSize(12);
    sections.forEach((section, index) => {
      doc.text(`${index + 1}. ${section}`, 70, yPos);
      doc.text(`${index + 3}`, 500, yPos); // Page numbers (approximate)
      yPos += lineHeight;
    });
  }

  private addExecutiveSummary(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Executive Summary', 50, 100);

    doc.fontSize(12)
       .text(report.executiveSummary, 50, 140, {
         width: 500,
         align: 'justify',
         lineGap: 4
       });
  }

  private addMeetingDetails(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    let yPos = 100;

    doc.fontSize(18)
       .text('Meeting Details', 50, yPos);
    yPos += 40;

    // Create details table
    const details = [
      ['Meeting Title:', report.meetingTitle],
      ['Date:', report.startTime.toLocaleDateString()],
      ['Start Time:', report.startTime.toLocaleTimeString()],
      ['End Time:', report.endTime.toLocaleTimeString()],
      ['Duration:', `${Math.round(report.duration / 60000)} minutes`],
      ['Participants:', report.participants.join(', ')],
      ['Session ID:', report.sessionId]
    ];

    doc.fontSize(12);
    details.forEach(([label, value]) => {
      doc.fillColor('#666666').text(label, 50, yPos, { width: 120 });
      doc.fillColor('#000000').text(value, 180, yPos, { width: 370 });
      yPos += 20;
    });
  }

  private addKeyDiscussions(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Key Discussions', 50, 100);

    let yPos = 140;
    doc.fontSize(12);

    report.keyDiscussions.forEach((discussion, index) => {
      if (yPos > 700) { // Check if we need a new page
        doc.addPage();
        yPos = 50;
      }

      doc.circle(60, yPos + 6, 3)
         .fillAndStroke('#5865F2', '#5865F2');

      doc.fillColor('#000000')
         .text(discussion, 80, yPos, {
           width: 470,
           align: 'justify',
           lineGap: 3
         });

      yPos += doc.heightOfString(discussion, { width: 470 }) + 15;
    });
  }

  private addDecisions(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Decisions Made', 50, 100);

    let yPos = 140;
    doc.fontSize(12);

    report.decisions.forEach((decision, index) => {
      if (yPos > 650) {
        doc.addPage();
        yPos = 50;
      }

      // Decision number
      doc.fillColor('#5865F2')
         .text(`Decision ${index + 1}`, 50, yPos);
      yPos += 25;

      // Description
      doc.fillColor('#666666')
         .text('Description:', 70, yPos);
      doc.fillColor('#000000')
         .text(decision.description, 150, yPos, { width: 400 });
      yPos += doc.heightOfString(decision.description, { width: 400 }) + 10;

      // Outcome
      doc.fillColor('#666666')
         .text('Outcome:', 70, yPos);
      doc.fillColor('#000000')
         .text(decision.outcome, 150, yPos, { width: 400 });
      yPos += doc.heightOfString(decision.outcome, { width: 400 }) + 10;

      // Rationale
      if (decision.rationale) {
        doc.fillColor('#666666')
           .text('Rationale:', 70, yPos);
        doc.fillColor('#000000')
           .text(decision.rationale, 150, yPos, { width: 400 });
        yPos += doc.heightOfString(decision.rationale, { width: 400 }) + 10;
      }

      yPos += 20; // Space between decisions
    });
  }

  private addActionItems(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Action Items', 50, 100);

    let yPos = 140;
    doc.fontSize(11);

    // Create table headers
    const headers = ['Priority', 'Description', 'Assignee', 'Due Date'];
    const columnWidths = [80, 280, 100, 90];
    let xPos = 50;

    // Draw header row
    doc.fillColor('#5865F2');
    headers.forEach((header, index) => {
      doc.text(header, xPos, yPos, { width: columnWidths[index] });
      xPos += columnWidths[index];
    });

    yPos += 25;

    // Draw separator line
    doc.moveTo(50, yPos)
       .lineTo(550, yPos)
       .stroke('#CCCCCC');
    yPos += 10;

    // Draw action items
    doc.fillColor('#000000');
    report.actionItems.forEach((item, index) => {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }

      xPos = 50;

      // Priority with color coding
      const priorityColor = this.getPriorityColor(item.priority);
      doc.fillColor(priorityColor)
         .text(item.priority.toUpperCase(), xPos, yPos, { width: columnWidths[0] });
      xPos += columnWidths[0];

      // Description
      doc.fillColor('#000000')
         .text(item.description, xPos, yPos, { width: columnWidths[1] });
      xPos += columnWidths[1];

      // Assignee
      doc.text(item.assignee || 'Unassigned', xPos, yPos, { width: columnWidths[2] });
      xPos += columnWidths[2];

      // Due date
      doc.text(item.dueDate || 'TBD', xPos, yPos, { width: columnWidths[3] });

      yPos += Math.max(20, doc.heightOfString(item.description, { width: columnWidths[1] }) + 5);
    });
  }

  private addNextSteps(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Next Steps', 50, 100);

    let yPos = 140;
    doc.fontSize(12);

    report.nextSteps.forEach((step, index) => {
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }

      doc.fillColor('#57F287')
         .text(`${index + 1}.`, 50, yPos);
      
      doc.fillColor('#000000')
         .text(step, 80, yPos, {
           width: 470,
           align: 'justify',
           lineGap: 3
         });

      yPos += doc.heightOfString(step, { width: 470 }) + 15;
    });
  }

  private addMetadata(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Meeting Metadata', 50, 100);

    let yPos = 140;
    doc.fontSize(11);

    const metadata = [
      ['Segment Count:', report.metadata.segmentCount.toString()],
      ['Total Transcripts:', report.metadata.totalTranscripts.toString()],
      ['Total Words:', report.metadata.totalWords.toString()],
      ['Average Confidence:', `${(report.metadata.averageConfidence * 100).toFixed(1)}%`],
      ['Summarization Cost:', `$${report.metadata.summarizationCost.toFixed(4)}`],
      ['Processing Time:', `${report.metadata.processingTime}ms`],
      ['Quality Score:', `${report.metadata.qualityScore.toFixed(1)}/100`]
    ];

    metadata.forEach(([label, value]) => {
      doc.fillColor('#666666').text(label, 50, yPos, { width: 200 });
      doc.fillColor('#000000').text(value, 260, yPos);
      yPos += 18;
    });
  }

  private addCompactHeader(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): void {
    const branding = options.branding || this.defaultBranding;
    
    doc.fontSize(16)
       .fillColor(branding.primaryColor || '#5865F2')
       .text(branding.companyName || 'Discord Voice Companion', 50, 50);

    doc.fontSize(14)
       .fillColor('#000000')
       .text(`Meeting Report: ${report.meetingTitle}`, 50, 80);

    doc.fontSize(10)
       .fillColor('#666666')
       .text(`${report.startTime.toLocaleDateString()} | ${Math.round(report.duration / 60000)} min | ${report.participants.length} participants`, 50, 105);
  }

  private addCompactMeetingOverview(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(12)
       .fillColor('#000000')
       .text('Summary:', 50, 140);

    doc.fontSize(10)
       .text(report.executiveSummary, 50, 160, {
         width: 500,
         align: 'justify',
         lineGap: 2
       });
  }

  private addCompactHighlights(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    const yStart = 160 + doc.heightOfString(report.executiveSummary, { width: 500 }) + 30;
    
    doc.fontSize(12)
       .text('Key Highlights:', 50, yStart);

    let yPos = yStart + 25;
    doc.fontSize(9);

    report.keyDiscussions.slice(0, 5).forEach((discussion) => {
      doc.text(`• ${discussion}`, 60, yPos, { width: 490 });
      yPos += doc.heightOfString(`• ${discussion}`, { width: 490 }) + 8;
    });
  }

  private addCompactActionItems(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    let yPos = 400; // Approximate position

    doc.fontSize(12)
       .text('Action Items:', 50, yPos);
    yPos += 25;

    doc.fontSize(9);
    report.actionItems.slice(0, 5).forEach((item) => {
      const priorityColor = this.getPriorityColor(item.priority);
      doc.fillColor(priorityColor)
         .text(`[${item.priority.toUpperCase()}]`, 60, yPos);
      
      doc.fillColor('#000000')
         .text(item.description, 120, yPos, { width: 430 });
      
      yPos += Math.max(15, doc.heightOfString(item.description, { width: 430 }) + 5);
    });
  }

  private addCompactFooter(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(8)
       .fillColor('#999999')
       .text(`Generated on ${new Date().toLocaleString()} | Session: ${report.sessionId}`, 
             50, 750, { align: 'center' });
  }

  private addParticipantAnalysis(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Participant Analysis', 50, 100);

    // This would be enhanced with actual speaker analysis
    doc.fontSize(12)
       .text('Participant Engagement:', 50, 140);

    let yPos = 170;
    report.participants.forEach((participant, index) => {
      doc.text(`${participant}: Active participant`, 70, yPos);
      yPos += 20;
    });
  }

  private addQualityMetrics(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Quality Metrics', 50, 100);

    const metrics = [
      ['Overall Quality Score:', `${report.metadata.qualityScore}/100`],
      ['Transcription Confidence:', `${(report.metadata.averageConfidence * 100).toFixed(1)}%`],
      ['Word Count:', report.metadata.totalWords.toString()],
      ['Processing Efficiency:', `${(report.metadata.totalWords / (report.metadata.processingTime / 1000)).toFixed(0)} words/sec`]
    ];

    let yPos = 140;
    doc.fontSize(12);

    metrics.forEach(([label, value]) => {
      doc.text(label, 50, yPos, { width: 300 });
      doc.text(value, 360, yPos);
      yPos += 25;
    });
  }

  private addDetailedAppendices(doc: PDFKit.PDFDocument, report: MeetingSummaryReport): void {
    doc.fontSize(18)
       .text('Appendices', 50, 100);

    doc.fontSize(12)
       .text('Additional technical details and raw data would be included here in a production system.', 50, 140);
  }

  private addPageFooters(
    doc: PDFKit.PDFDocument,
    report: MeetingSummaryReport,
    options: PDFGenerationOptions
  ): void {
    // This would require keeping track of page numbers during generation
    // For now, we'll add a simple footer
  }

  private getPriorityColor(priority: string): string {
    switch (priority.toLowerCase()) {
      case 'high': return '#FF4444';
      case 'medium': return '#FFA500';
      case 'low': return '#44AA44';
      default: return '#666666';
    }
  }

  private generateKeywords(report: MeetingSummaryReport): string[] {
    const keywords = [
      'meeting',
      'summary',
      'report',
      report.meetingTitle.toLowerCase(),
      ...report.participants.map(p => p.toLowerCase())
    ];

    // Add keywords from decisions and action items
    report.decisions.forEach(d => {
      keywords.push(d.description.toLowerCase().split(' ').slice(0, 2).join(' '));
    });

    return [...new Set(keywords)];
  }

  private generateFileName(report: MeetingSummaryReport): string {
    const date = report.startTime.toISOString().split('T')[0];
    const time = report.startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
    const title = report.meetingTitle.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    
    return `meeting_report_${title}_${date}_${time}.pdf`;
  }

  private getPageCount(doc: PDFKit.PDFDocument): number {
    // This is a simplified approach - PDFKit doesn't directly expose page count during generation
    return 1; // Placeholder - would need to track during generation
  }

  private ensureOutputDirectory(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
      logger.info('Created output directory', { path: this.outputDir });
    }
  }

  // Public methods
  public async generateQuickSummary(
    report: MeetingSummaryReport,
    fileName?: string
  ): Promise<PDFGenerationResult> {
    return await this.generateReport(report, {
      template: 'compact',
      includeCover: false,
      includeActionItems: true,
      includeDecisions: true,
      includeMetadata: false,
      includeAppendices: false
    });
  }

  public setDefaultBranding(branding: Partial<BrandingOptions>): void {
    this.defaultBranding = { ...this.defaultBranding, ...branding };
    this.defaultOptions.branding = this.defaultBranding;
  }

  public async cleanup(): Promise<void> {
    logger.info('Cleaning up PDF generator');
    this.removeAllListeners();
    logger.info('PDF generator cleanup completed');
  }
}

export default PDFGenerator;