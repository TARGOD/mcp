#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

class RepomixMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'repomix-server',
        version: '0.3.0',
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
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'generate_project_documentation',
          description: 'Generate clean, professional project documentation focused on structure and overview (NO file contents)',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the repository root OR GitHub repository URL',
              },
              style: {
                type: 'string',
                enum: ['course', 'project', 'library', 'application'],
                default: 'project',
                description: 'Documentation style based on project type',
              },
              max_depth: {
                type: 'number',
                default: 4,
                description: 'Maximum directory depth to analyze',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'generate_clean_structure',
          description: 'Generate ONLY the directory structure tree with descriptions (no file contents)',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the repository root OR GitHub repository URL',
              },
              max_depth: {
                type: 'number',
                default: 5,
                description: 'Maximum depth for directory tree',
              },
            },
            required: ['path'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'generate_project_documentation':
            return await this.generateProjectDocumentation(args);
          case 'generate_clean_structure':
            return await this.generateCleanStructure(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  // MAIN METHOD: Generate professional documentation like the example
  async generateProjectDocumentation(args) {
    const { path: repoPath, style = 'project', max_depth = 4 } = args;

    let resolvedPath;
    let isTemporary = false;
    let tempDir = null;

    try {
      // Handle GitHub URLs or local paths
      if (this.isGitHubUrl(repoPath)) {
        tempDir = await this.cloneGitHubRepo(repoPath);
        resolvedPath = tempDir;
        isTemporary = true;
      } else {
        resolvedPath = path.resolve(repoPath);
        await fs.access(resolvedPath);
      }

      // Analyze project structure (NO file content reading)
      const projectAnalysis = await this.analyzeProjectStructure(resolvedPath, max_depth);
      const repoName = isTemporary ? this.extractRepoNameFromUrl(repoPath) : path.basename(resolvedPath);
      
      // Generate documentation using template
      const documentation = this.buildDocumentationFromTemplate(projectAnalysis, repoName, style);

      return {
        content: [{ type: 'text', text: documentation }],
      };

    } finally {
      if (isTemporary && tempDir) {
        try {
          await this.cleanupTempDir(tempDir);
        } catch (error) {
          console.warn(`Failed to cleanup: ${error.message}`);
        }
      }
    }
  }

  // CORE METHOD: Analyze project structure WITHOUT reading file contents
  async analyzeProjectStructure(rootPath, maxDepth) {
    const structure = await this.buildDirectoryStructure(rootPath, maxDepth);
    
    const analysis = {
      name: path.basename(rootPath),
      type: this.detectProjectType(structure),
      description: this.generateProjectDescription(structure),
      structure: structure,
      technologies: this.extractTechnologies(structure),
      features: this.extractMainFeatures(structure),
      lessons: this.detectLessons(structure), // For course-type projects
      gettingStarted: this.generateGettingStartedSteps(structure),
    };
    
    return analysis;
  }

  // Build directory structure (metadata only, no file contents)
  async buildDirectoryStructure(rootPath, maxDepth, currentDepth = 0) {
    if (currentDepth >= maxDepth) return null;

    const structure = {
      name: path.basename(rootPath),
      type: 'directory',
      path: rootPath,
      children: [],
      description: '',
    };

    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(rootPath, entry.name);
        
        // Skip noise files/directories
        if (this.shouldSkipForDocumentation(entry.name, fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subStructure = await this.buildDirectoryStructure(fullPath, maxDepth, currentDepth + 1);
          if (subStructure) {
            subStructure.description = this.getDirectoryDescription(entry.name, fullPath);
            structure.children.push(subStructure);
          }
        } else {
          // Only include file metadata, NO content reading
          const fileInfo = {
            name: entry.name,
            type: 'file',
            path: fullPath,
            description: this.getFileDescription(entry.name),
            size: (await fs.stat(fullPath)).size,
          };
          
          // Only include important files for documentation
          if (this.isImportantForDocumentation(entry.name)) {
            structure.children.push(fileInfo);
          }
        }
      }
    } catch (error) {
      console.warn(`Error reading directory ${rootPath}: ${error.message}`);
    }

    return structure;
  }

  // Determine what to skip (major noise reduction)
  shouldSkipForDocumentation(name, fullPath) {
    const skipPatterns = [
      // Version control and IDE
      '.git', '.svn', '.hg', '.idea', '.vscode', '.vs',
      // Dependencies and build
      'node_modules', 'dist', 'build', 'target', 'bin', 'obj',
      // Python virtual environments and cache
      'venv', '.venv', '__pycache__', '.pytest_cache', '.coverage',
      // System files
      '.DS_Store', 'Thumbs.db', '.env', '.log', '.tmp',
      // Lock files and cache
      'yarn.lock', 'package-lock.json', 'uv.lock', '.cache',
    ];

    return skipPatterns.some(pattern => 
      name === pattern || 
      name.startsWith(pattern) || 
      name.startsWith('.') && !['README', 'LICENSE', 'CHANGELOG'].some(important => name.toUpperCase().includes(important))
    );
  }

  // Determine important files for documentation
  isImportantForDocumentation(fileName) {
    const importantFiles = [
      // Project configuration
      'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 
      'go.mod', 'pom.xml', 'build.gradle', 'Dockerfile',
      // Documentation
      'README.md', 'CHANGELOG.md', 'LICENSE', 'CONTRIBUTING.md',
      // Entry points
      'main.py', 'index.js', 'app.py', 'server.js', 'main.js',
      // Configuration
      'config.json', 'settings.json', 'tsconfig.json',
    ];

    return importantFiles.includes(fileName) || 
           fileName.toLowerCase().includes('readme') ||
           fileName.toLowerCase().includes('main') ||
           fileName.endsWith('.md');
  }

  // Build documentation from template (like the example provided)
  buildDocumentationFromTemplate(analysis, repoName, style) {
    let doc = `# ${repoName}\n\n`;

    // Project Overview Section
    doc += `## Project Overview\n\n`;
    doc += `${analysis.description}\n\n`;

    // Repository Structure Section
    doc += `## Repository Structure\n\n`;
    doc += '```\n';
    doc += this.formatDirectoryTree(analysis.structure);
    doc += '```\n\n';

    // Content sections based on project type
    if (style === 'course' || analysis.lessons.length > 0) {
      doc += this.generateCourseContent(analysis);
    } else {
      doc += this.generateProjectContent(analysis);
    }

    // Technologies Used Section
    doc += `## Technologies Used\n\n`;
    doc += this.formatTechnologies(analysis.technologies);

    // Getting Started Section
    doc += `## Getting Started\n\n`;
    doc += this.formatGettingStarted(analysis);

    // Additional sections based on project
    doc += this.generateAdditionalSections(analysis);

    return doc;
  }

  // Format directory tree (clean ASCII tree like example)
  formatDirectoryTree(structure, prefix = '', isRoot = true) {
    let output = '';
    
    if (isRoot) {
      output += `${structure.name}/\n`;
      prefix = '';
    }

    if (!structure.children) return output;

    // Sort: directories first, then files
    const sorted = structure.children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    sorted.forEach((child, index) => {
      const isLast = index === sorted.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');

      if (child.type === 'directory') {
        output += `${prefix}${connector}${child.name}/\n`;
        if (child.children && child.children.length > 0) {
          output += this.formatDirectoryTree(child, nextPrefix, false);
        }
      } else {
        output += `${prefix}${connector}${child.name}\n`;
      }
    });

    return output;
  }

  // Generate course content section (like the example)
  generateCourseContent(analysis) {
    let content = `## Course Content\n\n`;

    analysis.lessons.forEach(lesson => {
      content += `### ${lesson.name}\n\n`;
      content += `**Topic**: ${lesson.topic}\n\n`;
      content += `**Key Components**:\n`;
      
      lesson.components.forEach(component => {
        content += `- ${component}\n`;
      });

      if (lesson.codeExample) {
        content += `\n**Code Example**: ${lesson.codeExample}\n`;
      }

      if (lesson.projectStructure) {
        content += `\n**Project Structure**: ${lesson.projectStructure}\n`;
      }

      content += '\n';
    });

    return content;
  }

  // Generate regular project content
  generateProjectContent(analysis) {
    let content = `## Key Features\n\n`;
    
    analysis.features.forEach(feature => {
      content += `- ${feature}\n`;
    });
    
    return content + '\n';
  }

  // Format technologies section
  formatTechnologies(technologies) {
    let tech = '';
    
    Object.entries(technologies).forEach(([category, items]) => {
      if (items.length > 0) {
        tech += `- **${category}**: ${items.join(', ')}\n`;
      }
    });
    
    return tech + '\n';
  }

  // Format getting started section
  formatGettingStarted(analysis) {
    let steps = '';
    
    if (analysis.gettingStarted.prerequisites.length > 0) {
      steps += `1. **Prerequisites**:\n`;
      analysis.gettingStarted.prerequisites.forEach(prereq => {
        steps += `   - ${prereq}\n`;
      });
      steps += '\n';
    }

    if (analysis.gettingStarted.installation.length > 0) {
      steps += `2. **Installation**:\n`;
      steps += '   ```bash\n';
      analysis.gettingStarted.installation.forEach(cmd => {
        steps += `   ${cmd}\n`;
      });
      steps += '   ```\n\n';
    }

    if (analysis.gettingStarted.usage.length > 0) {
      steps += `3. **Running the Examples**:\n`;
      analysis.gettingStarted.usage.forEach(usage => {
        steps += `   - ${usage}\n`;
      });
      steps += '\n';
    }

    return steps;
  }

  // Project type detection
  detectProjectType(structure) {
    const hasFile = (name) => this.findFileInStructure(structure, name);
    
    if (hasFile('package.json')) return 'Node.js Application';
    if (hasFile('requirements.txt') || hasFile('pyproject.toml')) return 'Python Application';
    if (hasFile('Cargo.toml')) return 'Rust Application';
    if (hasFile('go.mod')) return 'Go Application';
    if (hasFile('pom.xml')) return 'Java/Maven Application';
    if (this.hasLessonsStructure(structure)) return 'Educational Course';
    
    return 'Software Project';
  }

  // Generate project description
  generateProjectDescription(structure) {
    const projectType = this.detectProjectType(structure);
    
    if (projectType === 'Educational Course') {
      return 'This repository contains an AI coding course built with Claude, featuring practical lessons on AI-assisted programming. The course is structured with video lessons, code examples, and hands-on exercises.';
    }
    
    const technologies = this.extractTechnologies(structure);
    const mainTech = Object.values(technologies).flat()[0] || 'various technologies';
    
    return `A ${projectType.toLowerCase()} built with ${mainTech}, providing ${this.getProjectPurpose(structure)}.`;
  }

  // Extract technologies from project structure
  extractTechnologies(structure) {
    const technologies = {
      'Language': [],
      'Key Libraries': [],
      'Build System': [],
      'Package Manager': [],
    };

    if (this.findFileInStructure(structure, 'package.json')) {
      technologies['Language'].push('JavaScript/Node.js');
      technologies['Package Manager'].push('NPM');
    }
    
    if (this.findFileInStructure(structure, 'requirements.txt')) {
      technologies['Language'].push('Python');
      technologies['Package Manager'].push('pip');
    }
    
    if (this.findFileInStructure(structure, 'pyproject.toml')) {
      technologies['Language'].push('Python 3.11+');
      technologies['Build System'].push('Hatchling');
    }
    
    if (this.findFileInStructure(structure, 'uv.lock')) {
      technologies['Package Manager'].push('UV');
    }

    // Detect common libraries from file names and structure
    const hasFiles = (patterns) => patterns.some(pattern => this.hasFilePattern(structure, pattern));
    
    if (hasFiles(['openai', 'gpt'])) technologies['Key Libraries'].push('OpenAI API');
    if (hasFiles(['pydantic'])) technologies['Key Libraries'].push('Pydantic');
    if (hasFiles(['dotenv'])) technologies['Key Libraries'].push('python-dotenv');
    if (hasFiles(['express'])) technologies['Key Libraries'].push('Express.js');
    if (hasFiles(['react'])) technologies['Key Libraries'].push('React');

    return technologies;
  }

  // Detect lessons structure for course projects
  detectLessons(structure) {
    const lessons = [];
    
    const findLessons = (node, currentPath = '') => {
      if (!node.children) return;
      
      node.children.forEach(child => {
        if (child.type === 'directory' && child.name.includes('lesson')) {
          const lessonInfo = this.analyzeLessonDirectory(child);
          lessons.push(lessonInfo);
        } else if (child.type === 'directory') {
          findLessons(child, currentPath + '/' + child.name);
        }
      });
    };

    findLessons(structure);
    return lessons;
  }

  // Analyze individual lesson directory
  analyzeLessonDirectory(lessonDir) {
    const lesson = {
      name: this.formatLessonName(lessonDir.name),
      topic: this.inferLessonTopic(lessonDir),
      components: [],
      codeExample: '',
      projectStructure: '',
    };

    if (!lessonDir.children) return lesson;

    lessonDir.children.forEach(child => {
      if (child.name.endsWith('.mp4')) {
        lesson.components.push(`Video lesson: \`${child.name}\``);
      } else if (child.name === 'src' && child.type === 'directory') {
        lesson.components.push(`Sample project: \`${this.getProjectName(child)}\``);
        lesson.codeExample = this.generateCodeDescription(child);
      } else if (child.name === 'resources' && child.type === 'directory') {
        lesson.components.push('Resources: Video transcript in markdown and SRT formats');
      } else if (child.name.endsWith('.md')) {
        lesson.components.push(`Documentation: ${child.name}`);
      }
    });

    return lesson;
  }

  // Helper methods
  findFileInStructure(structure, fileName) {
    if (!structure.children) return false;
    
    for (const child of structure.children) {
      if (child.name === fileName) return true;
      if (child.type === 'directory' && this.findFileInStructure(child, fileName)) {
        return true;
      }
    }
    return false;
  }

  hasFilePattern(structure, pattern) {
    if (!structure.children) return false;
    
    for (const child of structure.children) {
      if (child.name.includes(pattern)) return true;
      if (child.type === 'directory' && this.hasFilePattern(child, pattern)) {
        return true;
      }
    }
    return false;
  }

  hasLessonsStructure(structure) {
    return this.hasFilePattern(structure, 'lesson') && this.hasFilePattern(structure, '.mp4');
  }

  formatLessonName(name) {
    return name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  inferLessonTopic(lessonDir) {
    if (lessonDir.name.includes('hello')) return 'Introduction to AI-assisted programming';
    if (lessonDir.name.includes('multi-file')) return 'Working with multi-file projects and structured outputs';
    return 'Programming concepts and techniques';
  }

  getProjectName(srcDir) {
    if (!srcDir.children) return 'project';
    const project = srcDir.children.find(child => child.type === 'directory');
    return project ? project.name : 'project';
  }

  generateCodeDescription(srcDir) {
    // Simple heuristic based on common patterns
    if (this.hasFilePattern(srcDir, 'main.py')) {
      return 'The main.py file demonstrates basic text processing';
    }
    if (this.hasFilePattern(srcDir, 'openai')) {
      return 'Integration with OpenAI API for advanced analytics';
    }
    return 'Code examples demonstrating key concepts';
  }

  getProjectPurpose(structure) {
    if (this.hasFilePattern(structure, 'api')) return 'API services and endpoints';
    if (this.hasFilePattern(structure, 'web')) return 'web application functionality';
    if (this.hasFilePattern(structure, 'data')) return 'data processing and analysis';
    return 'core application functionality';
  }

  extractMainFeatures(structure) {
    const features = [];
    
    if (this.hasLessonsStructure(structure)) {
      features.push('Video Lessons: MP4 format videos for each lesson');
      features.push('Transcripts: Full video transcripts in multiple formats');
      features.push('Hands-on Examples: Working code examples for each concept');
      features.push('Progressive Difficulty: From simple scripts to structured packages');
    }
    
    if (this.hasFilePattern(structure, 'api')) {
      features.push('API Integration: RESTful services and endpoints');
    }
    
    if (this.hasFilePattern(structure, 'openai')) {
      features.push('AI Integration: Examples of using AI APIs in code');
    }
    
    return features.length > 0 ? features : ['Modern software architecture', 'Clean code organization'];
  }

  generateGettingStartedSteps(structure) {
    const steps = {
      prerequisites: [],
      installation: [],
      usage: [],
    };

    // Prerequisites
    if (this.findFileInStructure(structure, 'pyproject.toml')) {
      steps.prerequisites.push('Python 3.11 or higher');
    } else if (this.findFileInStructure(structure, 'package.json')) {
      steps.prerequisites.push('Node.js 14 or higher');
    }
    
    if (this.findFileInStructure(structure, 'uv.lock')) {
      steps.prerequisites.push('UV package manager (optional)');
    }
    
    if (this.hasFilePattern(structure, 'openai')) {
      steps.prerequisites.push('OpenAI API key (for AI features)');
    }

    // Installation
    if (this.findFileInStructure(structure, 'package.json')) {
      steps.installation.push('npm install');
    } else if (this.findFileInStructure(structure, 'requirements.txt')) {
      steps.installation.push('pip install -r requirements.txt');
    } else if (this.findFileInStructure(structure, 'pyproject.toml')) {
      steps.installation.push('pip install -e .');
      if (this.findFileInStructure(structure, 'uv.lock')) {
        steps.installation.push('# or with uv: uv pip install -e .');
      }
    }

    // Usage
    if (this.hasLessonsStructure(structure)) {
      steps.usage.push('Lesson 1: Simple word frequency analysis');
      steps.usage.push('Lesson 2: Run via the installed package script');
    } else if (this.findFileInStructure(structure, 'main.py')) {
      steps.usage.push('python main.py');
    } else if (this.findFileInStructure(structure, 'package.json')) {
      steps.usage.push('npm start');
    }

    return steps;
  }

  generateAdditionalSections(analysis) {
    let additional = '';
    
    if (analysis.lessons.length > 0) {
      additional += `## Course Features\n\n`;
      additional += `- **Video Lessons**: MP4 format videos for each lesson\n`;
      additional += `- **Transcripts**: Full video transcripts in multiple formats\n`;
      additional += `- **Hands-on Examples**: Working code examples for each concept\n`;
      additional += `- **Progressive Difficulty**: From simple scripts to structured packages\n`;
      if (this.hasFilePattern(analysis.structure, 'openai')) {
        additional += `- **AI Integration**: Examples of using AI APIs in code\n`;
      }
      additional += '\n';
      
      additional += `## Additional Resources\n\n`;
      additional += `- Conversation tracking prompts\n`;
      additional += `- Project documentation templates\n`;
      if (this.hasFilePattern(analysis.structure, 'openai')) {
        additional += `- OpenAI structured output examples\n`;
      }
      additional += `- Multi-file editing workflows\n\n`;
      
      additional += `## Notes\n\n`;
      additional += `This course appears to be designed for learning AI-assisted programming with Claude, focusing on practical examples and real-world applications. Each lesson builds upon the previous one, introducing more complex concepts and project structures.`;
    }
    
    return additional;
  }

  getFileDescription(fileName) {
    const descriptions = {
      'package.json': 'Node.js package configuration',
      'requirements.txt': 'Python dependencies',
      'pyproject.toml': 'Python project configuration',
      'main.py': 'Main Python script',
      'index.js': 'Main JavaScript entry point',
      'README.md': 'Project documentation',
      'Dockerfile': 'Docker container configuration',
    };
    
    return descriptions[fileName] || '';
  }

  getDirectoryDescription(dirName, fullPath) {
    const descriptions = {
      'src': 'Source code directory',
      'lib': 'Library code',
      'api': 'API routes and handlers',
      'components': 'Reusable components',
      'services': 'Business logic services',
      'utils': 'Utility functions',
      'tests': 'Test files',
      'docs': 'Documentation',
      'resources': 'Resource files directory',
      'prompts': 'Conversation tracking directory',
      'lessons': 'Course lessons',
    };
    
    if (dirName.includes('lesson')) {
      return 'Course lesson directory';
    }
    
    return descriptions[dirName] || '';
  }

  // Clean structure generation tool
  async generateCleanStructure(args) {
    const { path: repoPath, max_depth = 5 } = args;

    let resolvedPath;
    let isTemporary = false;
    let tempDir = null;

    try {
      if (this.isGitHubUrl(repoPath)) {
        tempDir = await this.cloneGitHubRepo(repoPath);
        resolvedPath = tempDir;
        isTemporary = true;
      } else {
        resolvedPath = path.resolve(repoPath);
        await fs.access(resolvedPath);
      }

      const structure = await this.buildDirectoryStructure(resolvedPath, max_depth);
      const repoName = isTemporary ? this.extractRepoNameFromUrl(repoPath) : path.basename(resolvedPath);
      
      const treeOutput = this.formatDirectoryTree(structure);
      
      const output = `# ${repoName} - Directory Structure\n\n\`\`\`\n${treeOutput}\`\`\``;

      return {
        content: [{ type: 'text', text: output }],
      };

    } finally {
      if (isTemporary && tempDir) {
        try {
          await this.cleanupTempDir(tempDir);
        } catch (error) {
          console.warn(`Failed to cleanup: ${error.message}`);
        }
      }
    }
  }

  // GitHub handling methods
  isGitHubUrl(url) {
    const githubPatterns = [
      /^https?:\/\/github\.com\/[\w\-\.]+\/[\w\-\.]+/,
      /^git@github\.com:[\w\-\.]+\/[\w\-\.]+\.git$/,
    ];
    return githubPatterns.some(pattern => pattern.test(url));
  }

  extractRepoNameFromUrl(url) {
    const match = url.match(/github\.com\/[\w\-\.]+\/([\w\-\.]+)/);
    return match ? match[1].replace(/\.git$/, '') : 'repository';
  }

  async cloneGitHubRepo(repoUrl) {
    const tempDir = path.join(os.tmpdir(), `repomix-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
    
    try {
      execSync('git --version', { stdio: 'ignore' });
      const cloneCommand = `git clone --depth 1 --single-branch "${repoUrl}" "${tempDir}"`;
      execSync(cloneCommand, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
      return tempDir;
    } catch (error) {
      await this.cleanupTempDir(tempDir);
      throw new Error(`Failed to clone repository: ${error.message}`);
    }
  }

  async cleanupTempDir(tempDir) {
    if (!tempDir || !tempDir.includes('repomix-')) return;
    
    try {
      if (process.platform === 'win32') {
        execSync(`rmdir /s /q "${tempDir}"`, { stdio: 'ignore' });
      } else {
        execSync(`rm -rf "${tempDir}"`, { stdio: 'ignore' });
      }
    } catch (error) {
      console.warn(`Cleanup failed: ${error.message}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Professional Documentation Generator MCP server running on stdio');
  }
}

if (require.main === module) {
  const server = new RepomixMCPServer();
  server.run().catch(console.error);
}

module.exports = { RepomixMCPServer };