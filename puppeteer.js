#!/usr/bin/env node

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const puppeteer = require('puppeteer');

class PuppeteerMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'puppeteer-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.browser = null;
    this.pages = new Map(); // Store multiple pages by ID
    this.currentPageId = null;

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'launch_browser',
            description: 'Launch a new Puppeteer browser instance',
            inputSchema: {
              type: 'object',
              properties: {
                headless: {
                  type: 'boolean',
                  description: 'Run browser in headless mode',
                  default: true
                },
                width: {
                  type: 'number',
                  description: 'Browser window width',
                  default: 1280
                },
                height: {
                  type: 'number',
                  description: 'Browser window height',
                  default: 720
                }
              }
            }
          },
          {
            name: 'new_page',
            description: 'Create a new page/tab',
            inputSchema: {
              type: 'object',
              properties: {
                pageId: {
                  type: 'string',
                  description: 'Unique identifier for the page'
                }
              },
              required: ['pageId']
            }
          },
          {
            name: 'goto',
            description: 'Navigate to a URL',
            inputSchema: {
              type: 'object',
              properties: {
                url: {
                  type: 'string',
                  description: 'URL to navigate to'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional, uses current page if not specified)'
                },
                waitUntil: {
                  type: 'string',
                  description: 'When to consider navigation complete',
                  enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
                  default: 'load'
                }
              },
              required: ['url']
            }
          },
          {
            name: 'click',
            description: 'Click on an element',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the element to click'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                }
              },
              required: ['selector']
            }
          },
          {
            name: 'type_text',
            description: 'Type text into an input field',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the input element'
                },
                text: {
                  type: 'string',
                  description: 'Text to type'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                },
                delay: {
                  type: 'number',
                  description: 'Delay between keystrokes in milliseconds',
                  default: 0
                }
              },
              required: ['selector', 'text']
            }
          },
          {
            name: 'get_text',
            description: 'Get text content from an element',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the element'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                }
              },
              required: ['selector']
            }
          },
          {
            name: 'get_attribute',
            description: 'Get an attribute value from an element',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector for the element'
                },
                attribute: {
                  type: 'string',
                  description: 'Attribute name to get'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                }
              },
              required: ['selector', 'attribute']
            }
          },
          {
            name: 'screenshot',
            description: 'Take a screenshot of the page',
            inputSchema: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                  description: 'File path to save the screenshot'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                },
                fullPage: {
                  type: 'boolean',
                  description: 'Capture full page',
                  default: false
                },
                type: {
                  type: 'string',
                  description: 'Image format',
                  enum: ['png', 'jpeg'],
                  default: 'png'
                }
              }
            }
          },
          {
            name: 'wait_for_selector',
            description: 'Wait for an element to appear',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'string',
                  description: 'CSS selector to wait for'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in milliseconds',
                  default: 30000
                }
              },
              required: ['selector']
            }
          },
          {
            name: 'evaluate',
            description: 'Execute JavaScript in the page context',
            inputSchema: {
              type: 'object',
              properties: {
                script: {
                  type: 'string',
                  description: 'JavaScript code to execute'
                },
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                }
              },
              required: ['script']
            }
          },
          {
            name: 'get_page_info',
            description: 'Get current page information (title, URL, etc.)',
            inputSchema: {
              type: 'object',
              properties: {
                pageId: {
                  type: 'string',
                  description: 'Page ID to use (optional)'
                }
              }
            }
          },
          {
            name: 'close_page',
            description: 'Close a specific page',
            inputSchema: {
              type: 'object',
              properties: {
                pageId: {
                  type: 'string',
                  description: 'Page ID to close'
                }
              },
              required: ['pageId']
            }
          },
          {
            name: 'close_browser',
            description: 'Close the browser and cleanup',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'launch_browser':
            return await this.launchBrowser(args);
          case 'new_page':
            return await this.newPage(args);
          case 'goto':
            return await this.goto(args);
          case 'click':
            return await this.click(args);
          case 'type_text':
            return await this.typeText(args);
          case 'get_text':
            return await this.getText(args);
          case 'get_attribute':
            return await this.getAttribute(args);
          case 'screenshot':
            return await this.screenshot(args);
          case 'wait_for_selector':
            return await this.waitForSelector(args);
          case 'evaluate':
            return await this.evaluate(args);
          case 'get_page_info':
            return await this.getPageInfo(args);
          case 'close_page':
            return await this.closePage(args);
          case 'close_browser':
            return await this.closeBrowser(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async launchBrowser(args = {}) {
    const { headless = true, width = 1280, height = 720 } = args;

    if (this.browser) {
      await this.browser.close();
    }

    this.browser = await puppeteer.launch({
      headless,
      args: [
        `--window-size=${width},${height}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    // Create default page
    const pages = await this.browser.pages();
    const defaultPage = pages[0] || await this.browser.newPage();
    await defaultPage.setViewport({ width, height });

    this.currentPageId = 'default';
    this.pages.set('default', defaultPage);

    return {
      content: [
        {
          type: 'text',
          text: `Browser launched successfully in ${headless ? 'headless' : 'headed'} mode with viewport ${width}x${height}`
        }
      ]
    };
  }

  async newPage(args) {
    const { pageId } = args;

    if (!this.browser) {
      throw new Error('Browser not launched. Call launch_browser first.');
    }

    if (this.pages.has(pageId)) {
      throw new Error(`Page with ID '${pageId}' already exists`);
    }

    const page = await this.browser.newPage();
    this.pages.set(pageId, page);
    this.currentPageId = pageId;

    return {
      content: [
        {
          type: 'text',
          text: `New page created with ID: ${pageId}`
        }
      ]
    };
  }

  getPage(pageId) {
    const id = pageId || this.currentPageId;
    if (!id || !this.pages.has(id)) {
      throw new Error(`Page not found: ${id || 'no current page'}`);
    }
    return this.pages.get(id);
  }

  async goto(args) {
    const { url, pageId, waitUntil = 'load' } = args;
    const page = this.getPage(pageId);

    const response = await page.goto(url, { waitUntil });

    return {
      content: [
        {
          type: 'text',
          text: `Navigated to ${url}. Status: ${response.status()}`
        }
      ]
    };
  }

  async click(args) {
    const { selector, pageId } = args;
    const page = this.getPage(pageId);

    await page.click(selector);

    return {
      content: [
        {
          type: 'text',
          text: `Clicked on element: ${selector}`
        }
      ]
    };
  }

  async typeText(args) {
    const { selector, text, pageId, delay = 0 } = args;
    const page = this.getPage(pageId);

    await page.type(selector, text, { delay });

    return {
      content: [
        {
          type: 'text',
          text: `Typed "${text}" into element: ${selector}`
        }
      ]
    };
  }

  async getText(args) {
    const { selector, pageId } = args;
    const page = this.getPage(pageId);

    const text = await page.$eval(selector, el => el.textContent);

    return {
      content: [
        {
          type: 'text',
          text: `Text from ${selector}: ${text}`
        }
      ]
    };
  }

  async getAttribute(args) {
    const { selector, attribute, pageId } = args;
    const page = this.getPage(pageId);

    const value = await page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);

    return {
      content: [
        {
          type: 'text',
          text: `Attribute '${attribute}' from ${selector}: ${value}`
        }
      ]
    };
  }

  async screenshot(args) {
    const { path, pageId, fullPage = false, type = 'png' } = args;
    const page = this.getPage(pageId);

    const options = { type, fullPage };
    if (path) {
      options.path = path;
    }

    await page.screenshot(options);

    return {
      content: [
        {
          type: 'text',
          text: path ? `Screenshot saved to: ${path}` : 'Screenshot taken'
        }
      ]
    };
  }

  async waitForSelector(args) {
    const { selector, pageId, timeout = 30000 } = args;
    const page = this.getPage(pageId);

    await page.waitForSelector(selector, { timeout });

    return {
      content: [
        {
          type: 'text',
          text: `Element appeared: ${selector}`
        }
      ]
    };
  }

  async evaluate(args) {
    const { script, pageId } = args;
    const page = this.getPage(pageId);

    const result = await page.evaluate(script);

    return {
      content: [
        {
          type: 'text',
          text: `Script result: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getPageInfo(args) {
    const { pageId } = args;
    const page = this.getPage(pageId);

    const title = await page.title();
    const url = page.url();

    return {
      content: [
        {
          type: 'text',
          text: `Page Info:\nTitle: ${title}\nURL: ${url}\nPage ID: ${pageId || this.currentPageId}`
        }
      ]
    };
  }

  async closePage(args) {
    const { pageId } = args;

    if (!this.pages.has(pageId)) {
      throw new Error(`Page not found: ${pageId}`);
    }

    const page = this.pages.get(pageId);
    await page.close();
    this.pages.delete(pageId);

    if (this.currentPageId === pageId) {
      this.currentPageId = this.pages.size > 0 ? this.pages.keys().next().value : null;
    }

    return {
      content: [
        {
          type: 'text',
          text: `Page closed: ${pageId}`
        }
      ]
    };
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.pages.clear();
      this.currentPageId = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Browser closed successfully'
        }
      ]
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Puppeteer MCP server running on stdio');
  }
}

// Run the server
if (require.main === module) {
  const server = new PuppeteerMCPServer();
  server.run().catch(console.error);
}

module.exports = PuppeteerMCPServer;