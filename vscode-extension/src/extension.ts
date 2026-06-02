import * as vscode from 'vscode';
import { ApprovalClient, setLogger, PendingRequest } from './approvalClient';
import { CommandInterceptor } from './commandInterceptor';
import { SetupPanel, setOutputChannel, stopBotProcess, isBotRunning, isBotStarting, ensureMcpRegistration } from './setupPanel';
import { SidebarViewProvider } from './sidebarWebviewProvider';

let approvalClient: ApprovalClient;
let commandInterceptor: CommandInterceptor;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let healthCheckInterval: NodeJS.Timeout | undefined;
let pendingPollInterval: NodeJS.Timeout | undefined;
let sidebarProvider: SidebarViewProvider;
let shownNotifications: Set<string> = new Set();

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    outputChannel.appendLine(`[${timestamp}] ${prefix} ${message}`);
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('GateKeeper');
    context.subscriptions.push(outputChannel);
    
    log('GateKeeper extension activated');

    // Set logger for approval client and setup panel
    setLogger(log);
    setOutputChannel(outputChannel);

    // Initialize the approval client
    approvalClient = new ApprovalClient();
    
    // Initialize command interceptor
    commandInterceptor = new CommandInterceptor(approvalClient);

    // Initialize sidebar webview provider
    sidebarProvider = new SidebarViewProvider(context);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider)
    );

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.command = 'gatekeeper.setup';
    updateStatusBar();
    statusBarItem.show();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('gatekeeper.setup', () => SetupPanel.createOrShow(context)),
        vscode.commands.registerCommand('gatekeeper.configure', configure),
        vscode.commands.registerCommand('gatekeeper.testConnection', testConnection),
        vscode.commands.registerCommand('gatekeeper.refreshStatus', refreshStatus),
        vscode.commands.registerCommand('gatekeeper.enable', enable),
        vscode.commands.registerCommand('gatekeeper.disable', disable),
        vscode.commands.registerCommand('gatekeeper.showLogs', showLogs),
        vscode.commands.registerCommand('gatekeeper.startBot', startBot),
        vscode.commands.registerCommand('gatekeeper.runWithApproval', runWithApproval),
        vscode.commands.registerCommand('gatekeeper.managePatterns', manageAutoApprovePatterns),
        statusBarItem
    );

    // Start health check polling
    startHealthCheckPolling();

    // Auto-update MCP server path if extension version changed
    ensureMcpRegistration(context);

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('gatekeeper')) {
                updateStatusBar();
                approvalClient.updateConfig();
            }
        })
    );

    // Register terminal profile for approved commands
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('gatekeeper.terminal', {
            provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
                return new vscode.TerminalProfile({
                    name: 'GateKeeper Approved Terminal',
                    shellPath: process.env.SHELL || '/bin/zsh',
                });
            }
        })
    );

    // Hook into task execution for approval
    context.subscriptions.push(
        vscode.tasks.onDidStartTask(async (e) => {
            const config = vscode.workspace.getConfiguration('gatekeeper');
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

    log('GateKeeper ready');
}

async function startHealthCheckPolling() {
    const config = vscode.workspace.getConfiguration('gatekeeper');
    if (!config.get<boolean>('enabled')) {
        return;
    }
    
    // Do an immediate health check to start pending poll if server is running
    const result = await approvalClient.testConnection();
    updateStatusBarHealth(result.success, result.pendingApprovals);
    
    // Then poll every 30 seconds
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

function startPendingPoll() {
    if (pendingPollInterval) {
        return; // Already polling
    }
    
    log('Starting pending request polling');
    
    // Poll every 2 seconds for fast response
    pendingPollInterval = setInterval(async () => {
        try {
            const pending = await approvalClient.getPending();
            
            // Clean up notifications for resolved requests
            const pendingIds = new Set(pending.map(p => p.requestId));
            for (const id of shownNotifications) {
                if (!pendingIds.has(id)) {
                    shownNotifications.delete(id);
                }
            }
            
            // Show notifications for new pending requests
            for (const req of pending) {
                if (!shownNotifications.has(req.requestId)) {
                    showApprovalNotification(req);
                    shownNotifications.add(req.requestId);
                }
            }
        } catch {
            // Server might be down, stop polling
            stopPendingPoll();
        }
    }, 2000);
}

function stopPendingPoll() {
    if (pendingPollInterval) {
        log('Stopping pending request polling');
        clearInterval(pendingPollInterval);
        pendingPollInterval = undefined;
    }
}

async function showApprovalNotification(req: PendingRequest) {
    // Handle questions differently from approvals
    if (req.type === 'question') {
        await showQuestionNotification(req);
        return;
    }
    
    const cmdPreview = (req.command || '').length > 60 
        ? (req.command || '').substring(0, 60) + '...' 
        : (req.command || '');
    
    const message = req.goal 
        ? `🔐 ${req.goal}\n\n${cmdPreview}`
        : `🔐 Command approval:\n\n${cmdPreview}`;
    
    log(`Showing notification for request: ${req.requestId}`);
    
    const action = await vscode.window.showInformationMessage(
        message,
        { modal: false },
        '✅ Approve',
        '❌ Reject',
        '👁 Details'
    );
    
    // Request might already be resolved by Telegram
    if (!shownNotifications.has(req.requestId)) {
        return;
    }
    
    if (action === '✅ Approve') {
        const success = await approvalClient.localApprove(req.requestId);
        if (success) {
            log(`Request ${req.requestId} approved via VS Code`);
            vscode.window.showInformationMessage('✅ Command approved');
        } else {
            vscode.window.showWarningMessage('⚠️ Already resolved (possibly via Telegram)');
        }
        shownNotifications.delete(req.requestId);
    } else if (action === '❌ Reject') {
        const success = await approvalClient.localReject(req.requestId);
        if (success) {
            log(`Request ${req.requestId} rejected via VS Code`);
            vscode.window.showInformationMessage('❌ Command rejected');
        } else {
            vscode.window.showWarningMessage('⚠️ Already resolved (possibly via Telegram)');
        }
        shownNotifications.delete(req.requestId);
    } else if (action === '👁 Details') {
        // Show full command in output channel
        outputChannel.appendLine('\n--- Approval Request Details ---');
        outputChannel.appendLine(`Request ID: ${req.requestId}`);
        outputChannel.appendLine(`Goal: ${req.goal || 'N/A'}`);
        outputChannel.appendLine(`Explanation: ${req.explanation || 'N/A'}`);
        outputChannel.appendLine(`Command:\n${req.command || 'N/A'}`);
        outputChannel.appendLine('---\n');
        outputChannel.show();
        // Re-show the notification
        shownNotifications.delete(req.requestId);
    }
}

async function showQuestionNotification(req: PendingRequest) {
    const question = req.question || 'Question from Copilot';
    const options = req.options || [];
    
    log(`Showing question notification for request: ${req.requestId}`);
    
    // Build quick pick items from options
    const items: vscode.QuickPickItem[] = options.map(opt => ({
        label: opt,
        description: ''
    }));
    
    // Add custom answer option
    items.push({
        label: '✏️ Type custom answer...',
        description: 'Enter your own response'
    });
    
    // Show quick pick with options
    const contextText = req.context ? `\n\n${req.context}` : '';
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: question + contextText,
        title: '💬 Question from Copilot',
        ignoreFocusOut: true
    });
    
    // Request might already be resolved by Telegram
    if (!shownNotifications.has(req.requestId)) {
        return;
    }
    
    if (!selected) {
        // User cancelled - re-show later
        shownNotifications.delete(req.requestId);
        return;
    }
    
    let answer: string;
    
    if (selected.label === '✏️ Type custom answer...') {
        // Show input box for custom answer
        const customAnswer = await vscode.window.showInputBox({
            prompt: question,
            placeHolder: 'Type your answer...',
            ignoreFocusOut: true
        });
        
        if (!customAnswer) {
            shownNotifications.delete(req.requestId);
            return;
        }
        answer = customAnswer;
    } else {
        answer = selected.label;
    }
    
    const success = await approvalClient.localAnswer(req.requestId, answer);
    if (success) {
        log(`Question ${req.requestId} answered via VS Code: ${answer}`);
        vscode.window.showInformationMessage(`✅ Answered: ${answer}`);
    } else {
        vscode.window.showWarningMessage('⚠️ Already answered (possibly via Telegram)');
    }
    shownNotifications.delete(req.requestId);
}

function updateStatusBarHealth(connected: boolean, pendingCount?: number) {
    const config = vscode.workspace.getConfiguration('gatekeeper');
    const enabled = config.get<boolean>('enabled');
    const running = isBotRunning();
    const starting = isBotStarting();
    const hasToken = !!(config.get<string>('chatId')); // If chatId is set, assume token is too
    
    // Update sidebar
    sidebarProvider.updateStatus(connected, pendingCount || 0, running || connected, hasToken || connected, starting);
    
    // Start/stop pending request polling based on connection
    if (connected && enabled) {
        startPendingPoll();
    } else {
        stopPendingPoll();
    }
    
    if (!enabled) {
        statusBarItem.text = '$(shield) GateKeeper';
        statusBarItem.tooltip = 'GateKeeper: Disabled\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (!connected) {
        statusBarItem.text = '$(alert) GateKeeper';
        statusBarItem.tooltip = 'GateKeeper: Disconnected\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
        const pending = pendingCount ? ` (${pendingCount} pending)` : '';
        statusBarItem.text = `$(shield) GateKeeper${pending}`;
        statusBarItem.tooltip = `GateKeeper: Connected${pending}\nClick to configure`;
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
    const config = vscode.workspace.getConfiguration('gatekeeper');
    const enabled = config.get<boolean>('enabled');
    
    if (enabled) {
        statusBarItem.text = '$(shield) GateKeeper';
        statusBarItem.tooltip = 'GateKeeper: Enabled\nClick to configure';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = '$(shield) GateKeeper';
        statusBarItem.tooltip = 'GateKeeper: Disabled\nClick to configure';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

async function configure() {
    const config = vscode.workspace.getConfiguration('gatekeeper');
    
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

/** Silent status refresh - updates sidebar and status bar without showing notifications */
async function refreshStatus() {
    const result = await approvalClient.testConnection();
    updateStatusBarHealth(result.success, result.pendingApprovals);
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
    stopPendingPoll();
    stopBotProcess();
    log('GateKeeper extension deactivated');
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
