import * as vscode from 'vscode';
import { ApprovalClient, setLogger } from './approvalClient';
import { CommandInterceptor } from './commandInterceptor';

let approvalClient: ApprovalClient;
let commandInterceptor: CommandInterceptor;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let healthCheckInterval: NodeJS.Timeout | undefined;

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    outputChannel.appendLine(`[${timestamp}] ${prefix} ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('Telegram Approval');
    context.subscriptions.push(outputChannel);
    
    log('Telegram Command Approval extension activated');

    // Set logger for approval client
    setLogger(log);

    // Initialize the approval client
    approvalClient = new ApprovalClient();
    
    // Initialize command interceptor
    commandInterceptor = new CommandInterceptor(approvalClient);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'telegramApproval.configure';
    updateStatusBar();
    statusBarItem.show();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('telegramApproval.configure', configure),
        vscode.commands.registerCommand('telegramApproval.testConnection', testConnection),
        vscode.commands.registerCommand('telegramApproval.enable', enable),
        vscode.commands.registerCommand('telegramApproval.disable', disable),
        vscode.commands.registerCommand('telegramApproval.showLogs', showLogs),
        vscode.commands.registerCommand('telegramApproval.startBot', startBot),
        vscode.commands.registerCommand('telegramApproval.runWithApproval', runWithApproval),
        vscode.commands.registerCommand('telegramApproval.managePatterns', manageAutoApprovePatterns),
        statusBarItem
    );

    // Start health check polling
    startHealthCheckPolling();

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('telegramApproval')) {
                updateStatusBar();
                approvalClient.updateConfig();
            }
        })
    );

    // Register terminal profile for Telegram-approved commands
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('telegramApproval.terminal', {
            provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
                return new vscode.TerminalProfile({
                    name: 'Telegram Approved Terminal',
                    shellPath: process.env.SHELL || '/bin/zsh',
                });
            }
        })
    );

    // Hook into task execution for approval
    context.subscriptions.push(
        vscode.tasks.onDidStartTask(async (e) => {
            const config = vscode.workspace.getConfiguration('telegramApproval');
            if (!config.get<boolean>('enabled')) {
                return;
            }
            
            // Log task starts - we can't block them but we can notify
            if (e.execution.task.execution instanceof vscode.ShellExecution) {
                const command = getCommandString(e.execution.task.execution);
                if (command) {
                    vscode.window.showInformationMessage(
                        `Task started: ${command.substring(0, 50)}...`
                    );
                }
            }
        })
    );

    log('Telegram Command Approval ready');
}

function startHealthCheckPolling() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    if (!config.get<boolean>('enabled')) {
        return;
    }
    
    // Poll every 30 seconds
    healthCheckInterval = setInterval(async () => {
        const result = await approvalClient.testConnection();
        updateStatusBarHealth(result.success, result.pendingApprovals);
    }, 30000);
}

function stopHealthCheckPolling() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = undefined;
    }
}

function updateStatusBarHealth(connected: boolean, pendingCount?: number) {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    const enabled = config.get<boolean>('enabled');
    
    if (!enabled) {
        statusBarItem.text = '$(bell-slash) TG Approval';
        statusBarItem.tooltip = 'Telegram Command Approval: Disabled\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (!connected) {
        statusBarItem.text = '$(alert) TG Approval';
        statusBarItem.tooltip = 'Telegram Command Approval: Disconnected\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        const pending = pendingCount ? ` (${pendingCount} pending)` : '';
        statusBarItem.text = `$(bell) TG Approval${pending}`;
        statusBarItem.tooltip = `Telegram Command Approval: Connected${pending}\nClick to configure`;
        statusBarItem.backgroundColor = undefined;
    }
}

function getCommandString(execution: vscode.ShellExecution): string | undefined {
    if (typeof execution.commandLine === 'string') {
        return execution.commandLine;
    }
    if (execution.command) {
        const cmd = typeof execution.command === 'string' 
            ? execution.command 
            : execution.command.value;
        const args = execution.args?.map(a => 
            typeof a === 'string' ? a : a.value
        ).join(' ') || '';
        return `${cmd} ${args}`.trim();
    }
    return undefined;
}

function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    const enabled = config.get<boolean>('enabled');
    
    if (enabled) {
        statusBarItem.text = '$(bell) TG Approval';
        statusBarItem.tooltip = 'Telegram Command Approval: Enabled\nClick to configure';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(bell-slash) TG Approval';
        statusBarItem.tooltip = 'Telegram Command Approval: Disabled\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

async function configure() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    
    const options = [
        {
            label: config.get<boolean>('enabled') ? '$(check) Disable' : '$(circle-outline) Enable',
            description: 'Toggle Telegram approval',
            action: 'toggle'
        },
        {
            label: '$(server) Configure Server URL',
            description: config.get<string>('serverUrl'),
            action: 'serverUrl'
        },
        {
            label: '$(clock) Configure Timeout',
            description: `${config.get<number>('timeoutSeconds')} seconds`,
            action: 'timeout'
        },
        {
            label: '$(beaker) Test Connection',
            description: 'Test connection to approval server',
            action: 'test'
        }
    ];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Telegram Command Approval Settings'
    });

    if (!selected) {
        return;
    }

    switch (selected.action) {
        case 'toggle':
            await config.update('enabled', !config.get<boolean>('enabled'), true);
            break;
        case 'serverUrl':
            const url = await vscode.window.showInputBox({
                prompt: 'Enter the Telegram approval bot server URL',
                value: config.get<string>('serverUrl'),
                placeHolder: 'http://localhost:8765'
            });
            if (url) {
                await config.update('serverUrl', url, true);
            }
            break;
        case 'timeout':
            const timeout = await vscode.window.showInputBox({
                prompt: 'Enter timeout in seconds',
                value: String(config.get<number>('timeoutSeconds')),
                validateInput: (v) => isNaN(Number(v)) ? 'Enter a number' : undefined
            });
            if (timeout) {
                await config.update('timeoutSeconds', Number(timeout), true);
            }
            break;
        case 'test':
            await testConnection();
            break;
    }
}

async function testConnection() {
    log('Testing connection to approval server...');
    const result = await approvalClient.testConnection();
    
    if (result.success) {
        log(`Connection successful. ${result.pendingApprovals} pending approval(s)`);
        updateStatusBarHealth(true, result.pendingApprovals);
        vscode.window.showInformationMessage(
            `✅ Connected! ${result.pendingApprovals} pending approval(s)`
        );
    } else {
        log(`Connection failed: ${result.error}`, 'error');
        updateStatusBarHealth(false);
        vscode.window.showErrorMessage(
            `❌ Connection failed: ${result.error}`
        );
    }
}

async function showLogs() {
    outputChannel.show();
}

async function startBot() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    const botPath = config.get<string>('botPath');
    
    if (!botPath) {
        const result = await vscode.window.showInputBox({
            prompt: 'Enter the path to the telegram-approval bot directory',
            placeHolder: '/path/to/telegram-approval'
        });
        
        if (result) {
            await config.update('botPath', result, true);
        } else {
            return;
        }
    }
    
    const finalPath = config.get<string>('botPath');
    
    const terminal = vscode.window.createTerminal({
        name: 'Telegram Approval Bot',
        cwd: finalPath,
    });
    
    terminal.show();
    terminal.sendText('source .venv/bin/activate && python bot.py');
    
    log(`Started bot from: ${finalPath}`);
    vscode.window.showInformationMessage('Starting Telegram Approval Bot...');
}

async function runWithApproval() {
    const command = await vscode.window.showInputBox({
        prompt: 'Enter command to run with Telegram approval',
        placeHolder: 'npm install'
    });
    
    if (!command) {
        return;
    }
    
    log(`Running command with approval: ${command}`);
    
    const terminal = await commandInterceptor.executeWithApproval(command, {
        explanation: 'User-initiated command via extension',
        goal: 'Run approved command'
    });
    
    if (!terminal) {
        log('Command was rejected', 'warn');
    }
}

async function manageAutoApprovePatterns() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    const patterns = config.get<string[]>('autoApprovePatterns') || [];
    
    const options = [
        { label: '$(add) Add new pattern', action: 'add' },
        { label: '$(list-unordered) View all patterns', action: 'view' },
        { label: '$(trash) Remove a pattern', action: 'remove' },
        ...patterns.map((p, i) => ({ label: `  ${p}`, action: 'none', pattern: p }))
    ];
    
    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Manage auto-approve patterns (regex)'
    });
    
    if (!selected) return;
    
    switch (selected.action) {
        case 'add':
            const newPattern = await vscode.window.showInputBox({
                prompt: 'Enter regex pattern for commands to auto-approve',
                placeHolder: '^(ls|pwd|cat)\\b',
                validateInput: (v) => {
                    try {
                        new RegExp(v);
                        return undefined;
                    } catch {
                        return 'Invalid regex pattern';
                    }
                }
            });
            if (newPattern) {
                await config.update('autoApprovePatterns', [...patterns, newPattern], true);
                log(`Added auto-approve pattern: ${newPattern}`);
                vscode.window.showInformationMessage(`Added pattern: ${newPattern}`);
            }
            break;
        case 'view':
            if (patterns.length === 0) {
                vscode.window.showInformationMessage('No auto-approve patterns configured');
            } else {
                vscode.window.showInformationMessage(`Patterns: ${patterns.join(', ')}`);
            }
            break;
        case 'remove':
            const toRemove = await vscode.window.showQuickPick(
                patterns.map(p => ({ label: p, pattern: p })),
                { placeHolder: 'Select pattern to remove' }
            );
            if (toRemove) {
                const updated = patterns.filter(p => p !== toRemove.pattern);
                await config.update('autoApprovePatterns', updated, true);
                log(`Removed auto-approve pattern: ${toRemove.pattern}`);
                vscode.window.showInformationMessage(`Removed pattern: ${toRemove.pattern}`);
            }
            break;
    }
}

async function enable() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    await config.update('enabled', true, true);
    vscode.window.showInformationMessage('Telegram Command Approval enabled');
}

async function disable() {
    const config = vscode.workspace.getConfiguration('telegramApproval');
    await config.update('enabled', false, true);
    vscode.window.showInformationMessage('Telegram Command Approval disabled');
}

export function deactivate() {
    stopHealthCheckPolling();
    log('Telegram Command Approval extension deactivated');
}

// Export for use by other extensions or Copilot integration
export async function requestApproval(
    command: string,
    options?: {
        explanation?: string;
        goal?: string;
        timeout?: number;
    }
): Promise<boolean> {
    return approvalClient.requestApproval(command, options);
}
