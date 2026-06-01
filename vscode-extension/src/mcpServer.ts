#!/usr/bin/env node
/**
 * MCP Server for GateKeeper - Remote Command Approval (TypeScript version)
 * 
 * This is bundled with the VS Code extension and auto-registered.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Configuration
const APPROVAL_SERVER_URL = process.env.GATEKEEPER_URL || 'http://localhost:8765';
const DEFAULT_TIMEOUT = parseInt(process.env.GATEKEEPER_TIMEOUT || '300', 10);
const DEFAULT_LOCAL_DELAY = parseInt(process.env.GATEKEEPER_LOCAL_DELAY || '10', 10);

/**
 * Make an HTTP request (simple wrapper)
 */
function httpRequest(
    url: string,
    options: { method: string; body?: string; timeout?: number }
): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const req = http.request(
            {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: options.method,
                headers: options.body ? { 'Content-Type': 'application/json' } : {},
                timeout: options.timeout || 5000,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode || 500, data: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode || 500, data });
                    }
                });
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

/**
 * Request approval from Telegram bot
 */
async function requestApproval(
    command: string,
    explanation: string = '',
    goal: string = '',
    timeout: number = DEFAULT_TIMEOUT,
    localApprovalDelay: number = DEFAULT_LOCAL_DELAY
): Promise<boolean> {
    const requestId = `${Date.now()}-${process.pid}`;

    try {
        const response = await httpRequest(`${APPROVAL_SERVER_URL}/approve`, {
            method: 'POST',
            body: JSON.stringify({
                requestId,
                command,
                explanation,
                goal,
                localApprovalDelay,
            }),
            timeout: timeout * 1000,
        });

        return response.status === 200 && response.data?.approved === true;
    } catch (error) {
        console.error('Approval request failed:', error);
        return false;
    }
}

/**
 * Ask user a question via GateKeeper
 */
async function askUser(
    question: string,
    context: string = '',
    options: string[] = [],
    timeout: number = DEFAULT_TIMEOUT,
    localApprovalDelay: number = DEFAULT_LOCAL_DELAY
): Promise<string> {
    const requestId = `${Date.now()}-${process.pid}`;

    try {
        const response = await httpRequest(`${APPROVAL_SERVER_URL}/api/ask`, {
            method: 'POST',
            body: JSON.stringify({
                requestId,
                question,
                context,
                options,
                localApprovalDelay,
            }),
            timeout: timeout * 1000,
        });

        if (response.status === 200 && response.data?.answer) {
            return response.data.answer;
        }
        return '';
    } catch (error) {
        console.error('Ask request failed:', error);
        return '';
    }
}

/**
 * Run a shell command
 */
async function runCommand(
    command: string,
    cwd?: string,
    timeout: number = 60
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: timeout * 1000,
            maxBuffer: 10 * 1024 * 1024, // 10MB
        });
        return { exitCode: 0, stdout, stderr };
    } catch (error: any) {
        return {
            exitCode: error.code || 1,
            stdout: error.stdout || '',
            stderr: error.stderr || error.message,
        };
    }
}

// Create server
const server = new Server(
    {
        name: 'gatekeeper',
        version: '0.8.0',
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'run_approved_command',
            description:
                'Run a shell command with optional approval via GateKeeper. ' +
                'If the approval server is running, waits for user approval (VS Code first, then Telegram). ' +
                'If the server is not running, executes the command directly. ' +
                'Use this as your default terminal command tool - it automatically adapts based on server availability.',
            inputSchema: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to run',
                    },
                    explanation: {
                        type: 'string',
                        description: 'Brief explanation of what this command does',
                    },
                    goal: {
                        type: 'string',
                        description: 'The goal this command achieves',
                    },
                    cwd: {
                        type: 'string',
                        description: 'Working directory for the command',
                    },
                    approval_timeout: {
                        type: 'integer',
                        description: 'Timeout in seconds for approval (default: 300)',
                        default: 300,
                    },
                    command_timeout: {
                        type: 'integer',
                        description: 'Timeout in seconds for command execution (default: 60)',
                        default: 60,
                    },
                    local_approval_delay: {
                        type: 'integer',
                        description: 'Seconds to wait for local VS Code approval before escalating to Telegram (default: 10)',
                        default: 10,
                    },
                },
                required: ['command'],
            },
        },
        {
            name: 'check_approval_server',
            description: 'Check if the Telegram approval server is running and healthy',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
        {
            name: 'ask_user',
            description:
                'Ask the user a question and get their response. ' +
                'Use this when you need clarification, want the user to choose between options, ' +
                'or need additional context to proceed. The question will appear in VS Code first, ' +
                'then escalate to Telegram if not answered locally.',
            inputSchema: {
                type: 'object',
                properties: {
                    question: {
                        type: 'string',
                        description: 'The question to ask the user',
                    },
                    context: {
                        type: 'string',
                        description: 'Additional context or background for the question',
                    },
                    options: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of suggested answers (user can also type a custom response)',
                    },
                    local_approval_delay: {
                        type: 'integer',
                        description: 'Seconds to wait for local VS Code response before escalating to Telegram (default: 10)',
                        default: 10,
                    },
                },
                required: ['question'],
            },
        },
    ],
}));

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'check_approval_server') {
        try {
            const response = await httpRequest(`${APPROVAL_SERVER_URL}/health`, {
                method: 'GET',
                timeout: 5000,
            });

            if (response.status === 200) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `✅ Server is healthy\nPending approvals: ${response.data?.pending_approvals || 0}`,
                        },
                    ],
                };
            } else {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `❌ Server returned status ${response.status}`,
                        },
                    ],
                };
            }
        } catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ Cannot connect to approval server: ${error}\n\nMake sure the bot is running from the VS Code extension sidebar.`,
                    },
                ],
            };
        }
    }

    if (name === 'run_approved_command') {
        const command = (args?.command as string) || '';
        const explanation = (args?.explanation as string) || '';
        const goal = (args?.goal as string) || '';
        const cwd = args?.cwd as string | undefined;
        const approvalTimeout = (args?.approval_timeout as number) || DEFAULT_TIMEOUT;
        const commandTimeout = (args?.command_timeout as number) || 60;
        const localDelay = (args?.local_approval_delay as number) || DEFAULT_LOCAL_DELAY;

        if (!command) {
            return {
                content: [{ type: 'text', text: 'Error: command is required' }],
            };
        }

        // Check if approval server is running
        let serverHealthy = false;
        try {
            const healthResponse = await httpRequest(`${APPROVAL_SERVER_URL}/health`, {
                method: 'GET',
                timeout: 2000,
            });
            serverHealthy = healthResponse.status === 200;
        } catch {
            serverHealthy = false;
        }

        // If server is not running, execute command directly without approval
        if (!serverHealthy) {
            const result = await runCommand(command, cwd, commandTimeout);
            const outputParts = [`⚡ Command executed directly (approval server not running, exit code: ${result.exitCode})`];
            if (result.stdout.trim()) {
                outputParts.push(`\n**stdout:**\n\`\`\`\n${result.stdout.trim()}\n\`\`\``);
            }
            if (result.stderr.trim()) {
                outputParts.push(`\n**stderr:**\n\`\`\`\n${result.stderr.trim()}\n\`\`\``);
            }
            return {
                content: [{ type: 'text', text: outputParts.join('\n') }],
            };
        }

        // Server is running - request approval
        const approved = await requestApproval(command, explanation, goal, approvalTimeout, localDelay);

        if (!approved) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ Command rejected or approval timed out.\n\nCommand was:\n\`\`\`\n${command}\n\`\`\``,
                    },
                ],
            };
        }

        // Run the command
        const result = await runCommand(command, cwd, commandTimeout);

        // Format output
        const outputParts = [`✅ Command approved and executed (exit code: ${result.exitCode})`];

        if (result.stdout.trim()) {
            outputParts.push(`\n**stdout:**\n\`\`\`\n${result.stdout.trim()}\n\`\`\``);
        }

        if (result.stderr.trim()) {
            outputParts.push(`\n**stderr:**\n\`\`\`\n${result.stderr.trim()}\n\`\`\``);
        }

        return {
            content: [{ type: 'text', text: outputParts.join('\n') }],
        };
    }

    if (name === 'ask_user') {
        const question = (args?.question as string) || '';
        const context = (args?.context as string) || '';
        const options = (args?.options as string[]) || [];
        const localDelay = (args?.local_approval_delay as number) || DEFAULT_LOCAL_DELAY;

        if (!question) {
            return {
                content: [{ type: 'text', text: 'Error: question is required' }],
            };
        }

        const answer = await askUser(question, context, options, DEFAULT_TIMEOUT, localDelay);

        if (!answer) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `⚠️ No response received for question: "${question}"\n\nThe user may have timed out or the server is not running.`,
                    },
                ],
            };
        }

        return {
            content: [
                {
                    type: 'text',
                    text: `💬 User responded: **${answer}**`,
                },
            ],
        };
    }

    return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
});

// Run server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Telegram Approval MCP Server running on stdio');
}

main().catch(console.error);
