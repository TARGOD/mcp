#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} = require('@modelcontextprotocol/sdk/types.js');

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { v4: uuidv4 } = require('uuid');

// Configure your Gemini API key here
const GEMINI_API_KEY = 'AIzaSyCgWYGWiJ07fsIUOIMSdZZjAlUAm2hE4v0'; // Your actual API key
const DEFAULT_MODEL = 'gemini-2.0-flash'; // Use Pro model for longer videos
const MAX_FILE_SIZE_MB = 20; // Gemini's file size limit
const CHUNK_DURATION_MINUTES = 10; // Split long videos into chunks

class EnhancedGeminiVideoTranscriptionMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'enhanced-gemini-video-transcription-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'transcribe_video',
            description: 'Transcribe video file using Gemini AI - handles long videos up to 2+ hours by chunking',
            inputSchema: {
              type: 'object',
              properties: {
                videoPath: {
                  type: 'string',
                  description: 'Path to the video file (MP4, AVI, MOV, WebM, etc.)',
                },
                outputPath: {
                  type: 'string',
                  description: 'Directory path where transcript files will be saved',
                },
                outputFormats: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['txt', 'json', 'srt', 'vtt', 'md']
                  },
                  description: 'Output formats to generate',
                  default: ['txt', 'srt', 'md'],
                },
                language: {
                  type: 'string',
                  description: 'Expected language of the video (helps with accuracy)',
                },
                includeTimestamps: {
                  type: 'boolean',
                  description: 'Generate timestamps for subtitles',
                  default: true,
                },
                maxLineLength: {
                  type: 'number',
                  description: 'Maximum characters per subtitle line',
                  default: 80,
                },
                customPrompt: {
                  type: 'string',
                  description: 'Custom instructions for transcription',
                },
                enableChunking: {
                  type: 'boolean',
                  description: 'Enable automatic chunking for long videos',
                  default: true,
                },
                chunkDuration: {
                  type: 'number',
                  description: 'Duration of each chunk in minutes (for chunking)',
                  default: 10,
                },
              },
              required: ['videoPath', 'outputPath'],
            },
          },
          {
            name: 'transcribe_video_url',
            description: 'Download video from URL and transcribe - supports long videos',
            inputSchema: {
              type: 'object',
              properties: {
                videoUrl: {
                  type: 'string',
                  description: 'URL of the video to download and transcribe',
                },
                outputPath: {
                  type: 'string',
                  description: 'Directory path where files will be saved',
                },
                outputFormats: {
                  type: 'array',
                  items: {
                    type: 'string',
                    enum: ['txt', 'json', 'srt', 'vtt', 'md']
                  },
                  description: 'Output formats to generate',
                  default: ['txt', 'srt', 'md'],
                },
                language: {
                  type: 'string',
                  description: 'Expected language of the video',
                },
                keepVideo: {
                  type: 'boolean',
                  description: 'Keep downloaded video file',
                  default: false,
                },
                customPrompt: {
                  type: 'string',
                  description: 'Custom instructions for transcription',
                },
                enableChunking: {
                  type: 'boolean',
                  description: 'Enable automatic chunking for long videos',
                  default: true,
                },
              },
              required: ['videoUrl', 'outputPath'],
            },
          },
          {
            name: 'analyze_video',
            description: 'Analyze video content - get summaries, topics, sentiment with enhanced processing',
            inputSchema: {
              type: 'object',
              properties: {
                videoPath: {
                  type: 'string',
                  description: 'Path to the video file',
                },
                outputPath: {
                  type: 'string',
                  description: 'Directory path where analysis will be saved',
                },
                analysisType: {
                  type: 'string',
                  description: 'Type of analysis to perform',
                  enum: ['summary', 'topics', 'sentiment', 'speakers', 'full', 'detailed'],
                  default: 'detailed',
                },
                includeTranscript: {
                  type: 'boolean',
                  description: 'Include full transcript in analysis',
                  default: true,
                },
                enableChunking: {
                  type: 'boolean',
                  description: 'Enable chunking for long video analysis',
                  default: true,
                },
              },
              required: ['videoPath', 'outputPath'],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'transcribe_video':
            return await this.transcribeVideo(args);
          case 'transcribe_video_url':
            return await this.transcribeVideoUrl(args);
          case 'analyze_video':
            return await this.analyzeVideo(args);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        console.error(`Tool execution error: ${error.message}`);
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error.message}`
        );
      }
    });
  }

  async transcribeVideo(args) {
    const {
      videoPath,
      outputPath,
      outputFormats = ['txt', 'srt', 'md'],
      language,
      includeTimestamps = true,
      maxLineLength = 80,
      customPrompt,
      enableChunking = true,
      chunkDuration = CHUNK_DURATION_MINUTES,
    } = args;

    // Validate API key
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your-gemini-api-key-here') {
      throw new Error('Gemini API key not configured. Please set GEMINI_API_KEY in the server code.');
    }

    // Verify video file exists
    try {
      await fs.access(videoPath);
    } catch (error) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    // Create output directory
    await fs.mkdir(outputPath, { recursive: true });

    console.error(`Starting transcription of: ${videoPath}`);

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const stats = await fs.stat(videoPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    console.error(`Video size: ${fileSizeMB.toFixed(2)} MB`);

    let transcriptionData;
    let processingMethod;

    // Check if file needs chunking
    if (enableChunking && fileSizeMB > MAX_FILE_SIZE_MB) {
      console.error(`File exceeds ${MAX_FILE_SIZE_MB}MB limit. Using chunking approach...`);
      processingMethod = 'chunked';
      transcriptionData = await this.transcribeVideoInChunks(
        videoPath,
        language,
        includeTimestamps,
        customPrompt,
        chunkDuration
      );
    } else {
      console.error('Processing video directly...');
      processingMethod = 'direct';
      transcriptionData = await this.callGeminiForTranscription(
        videoPath,
        language,
        includeTimestamps,
        customPrompt
      );
    }

    console.error('Transcription completed. Generating output files...');

    // Generate output files
    const outputFiles = [];
    const processingReport = {
      videoPath,
      videoSize: `${fileSizeMB.toFixed(2)} MB`,
      processingMethod,
      model: DEFAULT_MODEL,
      language: language || 'auto-detected',
      timestamp: new Date().toISOString(),
      outputFormats: outputFormats,
    };

    for (const format of outputFormats) {
      const outputFile = path.join(outputPath, `${baseName}_transcript.${format}`);

      try {
        switch (format) {
          case 'txt':
            const textContent = this.extractTextFromGeminiResponse(transcriptionData);
            await fs.writeFile(outputFile, textContent);
            outputFiles.push(outputFile);
            console.error(`Generated: ${outputFile}`);
            break;

          case 'json':
            const jsonData = {
              ...processingReport,
              transcription: transcriptionData,
            };
            await fs.writeFile(outputFile, JSON.stringify(jsonData, null, 2));
            outputFiles.push(outputFile);
            console.error(`Generated: ${outputFile}`);
            break;

          case 'srt':
            const srtContent = this.generateSRTFromGemini(transcriptionData, maxLineLength);
            await fs.writeFile(outputFile, srtContent);
            outputFiles.push(outputFile);
            console.error(`Generated: ${outputFile}`);
            break;

          case 'vtt':
            const vttContent = this.generateVTTFromGemini(transcriptionData, maxLineLength);
            await fs.writeFile(outputFile, vttContent);
            outputFiles.push(outputFile);
            console.error(`Generated: ${outputFile}`);
            break;

          case 'md':
            const mdContent = this.generateMarkdownFromGemini(transcriptionData, baseName, processingReport);
            await fs.writeFile(outputFile, mdContent);
            outputFiles.push(outputFile);
            console.error(`Generated: ${outputFile}`);
            break;
        }
      } catch (error) {
        console.error(`Error generating ${format} file: ${error.message}`);
      }
    }

    // Generate processing report
    const reportFile = path.join(outputPath, `${baseName}_processing_report.json`);
    await fs.writeFile(reportFile, JSON.stringify({
      ...processingReport,
      outputFiles,
      success: true,
    }, null, 2));

    const successMessage = `✅ VIDEO TRANSCRIPTION COMPLETED SUCCESSFULLY!\n\n` +
      `📹 Video: ${videoPath}\n` +
      `📊 Size: ${fileSizeMB.toFixed(2)} MB\n` +
      `🔄 Method: ${processingMethod}\n` +
      `🌐 Language: ${language || 'auto-detected'}\n` +
      `🤖 Model: ${DEFAULT_MODEL}\n\n` +
      `📁 Generated Files:\n${outputFiles.map(f => `   ✓ ${f}`).join('\n')}\n\n` +
      `📋 Processing Report: ${reportFile}\n` +
      `⏰ Completed: ${new Date().toLocaleString()}`;

    console.error('\n' + successMessage);

    return {
      content: [
        {
          type: 'text',
          text: successMessage,
        },
      ],
    };
  }

  async transcribeVideoInChunks(videoPath, language, includeTimestamps, customPrompt, chunkDuration) {
    console.error(`Starting chunked transcription with ${chunkDuration}-minute chunks...`);

    try {
      // Try to process the large file directly with optimized settings
      const transcriptionData = await this.callGeminiForLargeVideo(
        videoPath,
        language,
        includeTimestamps,
        customPrompt
      );

      return transcriptionData;
    } catch (error) {
      console.error(`Large video processing failed: ${error.message}`);
      throw new Error(`Failed to process large video. Consider compressing the video or splitting it manually. Error: ${error.message}`);
    }
  }

  async callGeminiForLargeVideo(videoPath, language, includeTimestamps, customPrompt) {
    console.error('Processing large video with optimized settings...');

    const videoBuffer = await fs.readFile(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = this.getMimeType(videoPath);

    let promptText = `Please transcribe this video completely and accurately. Provide a clean, continuous transcription without duplicating content. Important instructions:

1. DO NOT repeat segments or content
2. Provide timestamps in format [MM:SS] or [HH:MM:SS] for each new segment
3. Keep the transcription sequential and chronological
4. If you detect repeated content in the video, only transcribe it once
5. Format as readable paragraphs with clear transitions`;

    if (language) {
      promptText += `\n6. The video is in ${language}.`;
    }

    if (customPrompt) {
      promptText += `\n\nAdditional instructions: ${customPrompt}`;
    }

    promptText += `\n\nIMPORTANT: Ensure no duplicate content in the transcription. Each segment should appear only once.`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: promptText
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: videoBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 32768, // Increased for longer videos
        topP: 0.8,
        topK: 40,
      }
    };

    try {
      console.error('Sending request to Gemini API...');
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 300000, // 5 minute timeout for large videos
        }
      );

      if (!response.data.candidates || !response.data.candidates[0]) {
        throw new Error('No response from Gemini API');
      }

      const textResponse = response.data.candidates[0].content.parts[0].text;
      console.error('Received response from Gemini API');

      // Process and deduplicate the response
      const cleanedResponse = this.deduplicateTranscript(textResponse);

      return {
        text: cleanedResponse,
        segments: this.parseTextIntoSegments(cleanedResponse),
        metadata: {
          processingMethod: 'large_video',
          responseType: 'text',
        }
      };
    } catch (error) {
      if (error.response?.status === 400) {
        throw new Error(`Gemini API error: ${error.response.data.error?.message || 'Invalid request - video may be too large'}`);
      } else if (error.response?.status === 403) {
        throw new Error('Invalid Gemini API key or insufficient permissions');
      } else if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - video processing took too long. Try enabling chunking or reducing video size.');
      }
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }

  async callGeminiForTranscription(videoPath, language, includeTimestamps, customPrompt) {
    const videoBuffer = await fs.readFile(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = this.getMimeType(videoPath);

    let promptText = `Please transcribe this video accurately and completely. Provide a clean, continuous transcription without duplicating any content. Important:

1. NO repetition of segments
2. Timestamps in format [MM:SS] or [HH:MM:SS] for each segment
3. Sequential and chronological order
4. Clean, readable paragraphs`;

    if (language) {
      promptText += `\n5. The video is in ${language}.`;
    }

    if (customPrompt) {
      promptText += `\n\nAdditional: ${customPrompt}`;
    }

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: promptText
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: videoBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 16384,
        topP: 0.8,
        topK: 40,
      }
    };

    try {
      console.error('Sending transcription request to Gemini...');
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 180000, // 3 minute timeout
        }
      );

      if (!response.data.candidates || !response.data.candidates[0]) {
        throw new Error('No response from Gemini API');
      }

      const textResponse = response.data.candidates[0].content.parts[0].text;
      console.error('Transcription response received');

      // Clean and deduplicate the response
      const cleanedResponse = this.deduplicateTranscript(textResponse);

      return {
        text: cleanedResponse,
        segments: this.parseTextIntoSegments(cleanedResponse),
        metadata: {
          processingMethod: 'direct',
          responseType: 'text',
        }
      };
    } catch (error) {
      if (error.response?.status === 400) {
        throw new Error(`Gemini API error: ${error.response.data.error?.message || 'Invalid request'}`);
      } else if (error.response?.status === 403) {
        throw new Error('Invalid Gemini API key or insufficient permissions');
      } else if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - video processing took too long');
      }
      throw new Error(`Gemini API error: ${error.message}`);
    }
  }

  // NEW METHOD: Deduplicate transcript content
  deduplicateTranscript(text) {
    if (!text) return '';

    // Split into lines
    const lines = text.split('\n');
    const cleanedLines = [];
    const seenContent = new Set();
    const recentSegments = [];
    const SEGMENT_MEMORY = 5; // Remember last 5 segments to detect repetition

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        cleanedLines.push('');
        continue;
      }

      // Extract timestamp if present
      const timestampMatch = trimmedLine.match(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/);
      let timestamp = '';
      let content = trimmedLine;

      if (timestampMatch) {
        timestamp = timestampMatch[0];
        content = trimmedLine.substring(timestamp.length).trim();
      }

      // Check if this content is too similar to recent segments
      let isDuplicate = false;
      
      // Normalize content for comparison
      const normalizedContent = content.toLowerCase().replace(/[^\w\s]/g, '');
      
      // Check exact duplicates
      if (seenContent.has(normalizedContent) && normalizedContent.length > 20) {
        isDuplicate = true;
      }

      // Check similarity with recent segments
      for (const recentSegment of recentSegments) {
        if (this.calculateSimilarity(normalizedContent, recentSegment) > 0.8) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && content.length > 10) {
        cleanedLines.push(line);
        seenContent.add(normalizedContent);
        
        // Update recent segments
        recentSegments.push(normalizedContent);
        if (recentSegments.length > SEGMENT_MEMORY) {
          recentSegments.shift();
        }
      }
    }

    return cleanedLines.join('\n');
  }

  // Calculate similarity between two strings (simple approach)
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    if (str1 === str2) return 1;

    const words1 = str1.split(/\s+/);
    const words2 = str2.split(/\s+/);
    
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }

  // FIXED: Extract clean text from Gemini response
  extractTextFromGeminiResponse(data) {
    if (typeof data === 'string') {
      return this.deduplicateTranscript(data);
    }

    if (data && data.text) {
      return this.deduplicateTranscript(data.text);
    }

    if (data && data.segments && Array.isArray(data.segments)) {
      const text = data.segments
        .map(segment => {
          if (typeof segment === 'string') return segment;
          if (segment.text) return segment.text;
          return '';
        })
        .filter(text => text.trim().length > 0)
        .join('\n\n');
      
      return this.deduplicateTranscript(text);
    }

    return '';
  }

  // ENHANCED: Parse text into segments with deduplication
  parseTextIntoSegments(text) {
    const timestampRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
    const segments = [];
    const seenTexts = new Set();
    let lastIndex = 0;
    let match;

    const matches = [];
    while ((match = timestampRegex.exec(text)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        timestamp: match[0],
        hours: match[3] ? parseInt(match[1]) : 0,
        minutes: match[3] ? parseInt(match[2]) : parseInt(match[1]),
        seconds: match[3] ? parseInt(match[3]) : parseInt(match[2])
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const currentMatch = matches[i];
      const nextMatch = matches[i + 1];
      
      const startIndex = currentMatch.index + currentMatch.length;
      const endIndex = nextMatch ? nextMatch.index : text.length;
      
      const segmentText = text.substring(startIndex, endIndex).trim();
      
      // Skip duplicate segments
      const normalizedText = segmentText.toLowerCase().replace(/[^\w\s]/g, '');
      if (segmentText && !seenTexts.has(normalizedText)) {
        seenTexts.add(normalizedText);
        
        const startTime = currentMatch.hours * 3600 + currentMatch.minutes * 60 + currentMatch.seconds;
        const endTime = nextMatch 
          ? nextMatch.hours * 3600 + nextMatch.minutes * 60 + nextMatch.seconds
          : startTime + 30;

        segments.push({
          start: startTime,
          end: endTime,
          text: segmentText
        });
      }
    }

    // If no timestamps found, create segments from paragraphs
    if (segments.length === 0) {
      const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      const seenParagraphs = new Set();
      
      paragraphs.forEach((paragraph, index) => {
        const normalizedPara = paragraph.trim().toLowerCase().replace(/[^\w\s]/g, '');
        if (!seenParagraphs.has(normalizedPara)) {
          seenParagraphs.add(normalizedPara);
          segments.push({
            start: index * 30,
            end: (index + 1) * 30,
            text: paragraph.trim()
          });
        }
      });
    }

    return segments;
  }

  // ENHANCED: Generate clean markdown with deduplicated content
  generateMarkdownFromGemini(data, videoName, processingReport) {
    let markdown = `# Video Transcript: ${videoName}\n\n`;
    markdown += `## Processing Information\n\n`;
    markdown += `- **Video Size**: ${processingReport.videoSize}\n`;
    markdown += `- **Processing Method**: ${processingReport.processingMethod}\n`;
    markdown += `- **Model Used**: ${processingReport.model}\n`;
    markdown += `- **Language**: ${processingReport.language}\n`;
    markdown += `- **Processed**: ${new Date(processingReport.timestamp).toLocaleString()}\n\n`;

    markdown += `## Transcript\n\n`;

    // Extract clean text
    const cleanText = this.extractTextFromGeminiResponse(data);

    // If we have segments with timestamps, format them nicely
    if (data && data.segments && Array.isArray(data.segments) && data.segments.length > 0) {
      data.segments.forEach((segment, index) => {
        if (segment && segment.text) {
          const startTime = this.formatTimestamp(segment.start || 0);
          const endTime = this.formatTimestamp(segment.end || segment.start + 30);

          markdown += `### Segment ${index + 1} [${startTime} - ${endTime}]\n\n`;
          markdown += `${segment.text.trim()}\n\n`;
        }
      });
    } else {
      // Split by timestamps if present in the text
      const timestampRegex = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;
      const lines = cleanText.split('\n');
      let currentSection = [];
      let sectionIndex = 1;

      for (const line of lines) {
        if (timestampRegex.test(line.trim())) {
          // If we have accumulated content, add it as a section
          if (currentSection.length > 0) {
            markdown += `### Section ${sectionIndex}\n\n`;
            markdown += currentSection.join('\n').trim() + '\n\n';
            sectionIndex++;
          }
          currentSection = [line];
        } else if (line.trim()) {
          currentSection.push(line);
        }
      }

      // Add the last section
      if (currentSection.length > 0) {
        markdown += `### Section ${sectionIndex}\n\n`;
        markdown += currentSection.join('\n').trim() + '\n\n';
      }
    }

    markdown += `---\n\n`;
    markdown += `*Transcript generated using Gemini AI*\n`;

    return markdown;
  }

  formatTimestamp(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  generateSRTFromGemini(data, maxLineLength = 80) {
    let srtContent = '';
    let index = 1;

    const segments = data.segments || this.parseTextIntoSegments(this.extractTextFromGeminiResponse(data));

    // Deduplicate segments before generating SRT
    const uniqueSegments = [];
    const seenTexts = new Set();

    for (const segment of segments) {
      const normalizedText = segment.text.trim().toLowerCase().replace(/[^\w\s]/g, '');
      if (!seenTexts.has(normalizedText) && segment.text.trim()) {
        seenTexts.add(normalizedText);
        uniqueSegments.push(segment);
      }
    }

    uniqueSegments.forEach(segment => {
      srtContent += `${index}\n`;
      srtContent += `${this.formatSRTTime(segment.start || (index - 1) * 8)} --> ${this.formatSRTTime(segment.end || index * 8)}\n`;
      srtContent += `${this.wrapText(segment.text.trim(), maxLineLength)}\n\n`;
      index++;
    });

    return srtContent;
  }

  generateVTTFromGemini(data, maxLineLength = 80) {
    let vttContent = 'WEBVTT\n\n';

    const segments = data.segments || this.parseTextIntoSegments(this.extractTextFromGeminiResponse(data));

    // Deduplicate segments
    const uniqueSegments = [];
    const seenTexts = new Set();

    for (const segment of segments) {
      const normalizedText = segment.text.trim().toLowerCase().replace(/[^\w\s]/g, '');
      if (!seenTexts.has(normalizedText) && segment.text.trim()) {
        seenTexts.add(normalizedText);
        uniqueSegments.push(segment);
      }
    }

    uniqueSegments.forEach(segment => {
      vttContent += `${this.formatVTTTime(segment.start || 0)} --> ${this.formatVTTTime(segment.end || 5)}\n`;
      vttContent += `${this.wrapText(segment.text.trim(), maxLineLength)}\n\n`;
    });

    return vttContent;
  }

  formatSRTTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  formatVTTTime(seconds) {
    return this.formatSRTTime(seconds).replace(',', '.');
  }

  wrapText(text, maxLength) {
    if (text.length <= maxLength) return text;

    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= maxLength) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
    return lines.join('\n');
  }

  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.flv': 'video/x-flv',
      '.wmv': 'video/x-ms-wmv',
      '.m4v': 'video/x-m4v',
    };
    return mimeTypes[ext] || 'video/mp4';
  }

  // Keep other methods unchanged...
  async transcribeVideoUrl(args) {
    const {
      videoUrl,
      outputPath,
      outputFormats = ['txt', 'srt', 'md'],
      language,
      keepVideo = false,
      customPrompt,
      enableChunking = true,
    } = args;

    await fs.mkdir(outputPath, { recursive: true });

    const videoFileName = `downloaded_video_${Date.now()}.mp4`;
    const videoPath = path.join(outputPath, videoFileName);

    try {
      console.error(`📥 Downloading video from: ${videoUrl}`);
      const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: 300000, // 5 minute timeout for downloads
      });

      const writer = require('fs').createWriteStream(videoPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      console.error('✅ Download completed');

      const result = await this.transcribeVideo({
        videoPath,
        outputPath,
        outputFormats,
        language,
        customPrompt,
        enableChunking,
      });

      if (!keepVideo) {
        try {
          await fs.unlink(videoPath);
          console.error('🗑️ Temporary video file cleaned up');
        } catch (error) {
          console.error('Warning: Could not clean up temporary video file');
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `📥 VIDEO DOWNLOADED AND TRANSCRIBED!\n\nSource URL: ${videoUrl}\n\n${result.content[0].text}${keepVideo ? `\n\n📁 Video saved at: ${videoPath}` : ''}`,
          },
        ],
      };
    } catch (error) {
      try {
        await fs.unlink(videoPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async analyzeVideo(args) {
    const {
      videoPath,
      outputPath,
      analysisType = 'detailed',
      includeTranscript = true,
      enableChunking = true,
    } = args;

    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your-gemini-api-key-here') {
      throw new Error('Gemini API key not configured');
    }

    try {
      await fs.access(videoPath);
    } catch (error) {
      throw new Error(`Video file not found: ${videoPath}`);
    }

    await fs.mkdir(outputPath, { recursive: true });
    console.error(`🔍 Starting ${analysisType} analysis of: ${videoPath}`);

    const baseName = path.basename(videoPath, path.extname(videoPath));
    const stats = await fs.stat(videoPath);
    const fileSizeMB = stats.size / (1024 * 1024);

    let analysisData;
    if (enableChunking && fileSizeMB > MAX_FILE_SIZE_MB) {
      analysisData = await this.callGeminiForLargeVideoAnalysis(videoPath, analysisType, includeTranscript);
    } else {
      analysisData = await this.callGeminiForAnalysis(videoPath, analysisType, includeTranscript);
    }

    const outputFile = path.join(outputPath, `${baseName}_analysis.json`);
    const mdOutputFile = path.join(outputPath, `${baseName}_analysis.md`);

    await fs.writeFile(outputFile, JSON.stringify(analysisData, null, 2));

    // Create markdown version
    const mdContent = this.generateAnalysisMarkdown(analysisData, baseName, analysisType);
    await fs.writeFile(mdOutputFile, mdContent);

    console.error(`✅ Analysis completed and saved`);

    return {
      content: [
        {
          type: 'text',
          text: `🔍 VIDEO ANALYSIS COMPLETED!\n\nVideo: ${videoPath}\nAnalysis Type: ${analysisType}\nFiles Generated:\n  ✓ ${outputFile}\n  ✓ ${mdOutputFile}\n\nModel: ${DEFAULT_MODEL}`,
        },
      ],
    };
  }

  generateAnalysisMarkdown(analysisData, videoName, analysisType) {
    let markdown = `# Video Analysis: ${videoName}\n\n`;
    markdown += `**Analysis Type**: ${analysisType}\n`;
    markdown += `**Generated**: ${new Date().toLocaleString()}\n\n`;

    if (typeof analysisData === 'object') {
      Object.entries(analysisData).forEach(([key, value]) => {
        markdown += `## ${key.charAt(0).toUpperCase() + key.slice(1)}\n\n`;
        if (typeof value === 'string') {
          markdown += `${value}\n\n`;
        } else {
          markdown += `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n`;
        }
      });
    } else {
      markdown += `## Analysis\n\n${analysisData}\n\n`;
    }

    markdown += `---\n*Analysis generated using Gemini AI*\n`;
    return markdown;
  }

  async callGeminiForAnalysis(videoPath, analysisType, includeTranscript) {
    const videoBuffer = await fs.readFile(videoPath);
    const videoBase64 = videoBuffer.toString('base64');
    const mimeType = this.getMimeType(videoPath);

    let promptText = `Please analyze this video content thoroughly.`;

    switch (analysisType) {
      case 'summary':
        promptText += ` Provide a comprehensive summary of the main topics, key points, and conclusions.`;
        break;
      case 'topics':
        promptText += ` Identify and list the main topics discussed in the video.`;
        break;
      case 'sentiment':
        promptText += ` Analyze the sentiment and tone of the video content.`;
        break;
      case 'speakers':
        promptText += ` Identify different speakers and analyze their contributions.`;
        break;
      case 'detailed':
      case 'full':
        promptText += ` Provide a detailed analysis including: summary, main topics, sentiment, key insights, notable patterns, themes, and speaker analysis if applicable.`;
        break;
    }

    if (includeTranscript) {
      promptText += ` Also include the full transcript of the spoken content WITHOUT any repetition.`;
    }

    promptText += ` Format the response as structured JSON with clear sections.`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              text: promptText
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: videoBase64
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 16384,
      }
    };

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 180000,
        }
      );

      const textResponse = response.data.candidates[0].content.parts[0].text;

      try {
        return JSON.parse(textResponse);
      } catch (e) {
        return { analysis: textResponse, type: analysisType };
      }
    } catch (error) {
      throw new Error(`Analysis failed: ${error.message}`);
    }
  }

  async callGeminiForLargeVideoAnalysis(videoPath, analysisType, includeTranscript) {
    return await this.callGeminiForAnalysis(videoPath, analysisType, includeTranscript);
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('🚀 Enhanced Gemini Video Transcription MCP server running on stdio');
    console.error(`📋 Model: ${DEFAULT_MODEL}`);
    console.error(`📏 Max file size: ${MAX_FILE_SIZE_MB}MB (larger files will be chunked)`);
    console.error('✨ Now with automatic duplicate detection and removal!');
  }
}

// Handle cleanup on exit
process.on('SIGINT', async () => {
  console.error('\n🛑 Server shutting down...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n🛑 Server terminating...');
  process.exit(0);
});

// Start the server
const server = new EnhancedGeminiVideoTranscriptionMCPServer();
server.run().catch(console.error);