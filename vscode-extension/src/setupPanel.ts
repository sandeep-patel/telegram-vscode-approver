import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

let botProcess: ChildProcess | undefined;
let botStarting: boolean = false;
let outputChannel: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

function log(message: string) {
    outputChannel?.appendLine(`[Setup] ${message}`);
}

export class SetupPanel {
    public static currentPanel: SetupPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _statusInterval: NodeJS.Timeout | undefined;

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SetupPanel.currentPanel) {
            SetupPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'gatekeeperSetup',
            'GateKeeper Setup',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            }
        );

        SetupPanel.currentPanel = new SetupPanel(panel, context);
    }

    private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
        this._panel = panel;
        this._extensionUri = context.extensionUri;
        this._context = context;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'saveAndStart':
                        await this._saveAndStart(message.token, message.chatId, message.port, message.localApprovalDelay, message.useExistingToken);
                        break;
                    case 'stop':
                        await this._stopBot();
                        break;
                    case 'testConnection':
                        await this._testCommand(message.port);
                        break;
                    case 'getStatus':
                        await this._sendStatus();
                        break;
                    case 'openBotFather':
                        vscode.env.openExternal(vscode.Uri.parse('https://t.me/BotFather'));
                        break;
                }
            },
            null,
            this._disposables
        );

        // Periodically refresh status to catch external changes
        this._statusInterval = setInterval(() => this._sendStatus(), 3000);
    }

    private async _sendStatus() {
        const config = vscode.workspace.getConfiguration('gatekeeper');
        const token = await this._context.secrets.get('gatekeeper.botToken') || '';
        const chatId = config.get<string>('chatId') || '';
        const port = config.get<number>('httpPort') || 8765;
        const localApprovalDelay = config.get<number>('localApprovalDelay') || 10;
        
        // Check if we started the bot process
        const processRunning = botProcess !== undefined && !botProcess.killed;
        
        // Also check health endpoint to see if server is responding
        const serverResponding = await this._checkServerHealth(port);
        
        // Server is running if either we started it or something is responding
        const isRunning = processRunning || serverResponding;

        this._panel.webview.postMessage({
            command: 'status',
            token: token ? '••••••••' + token.slice(-8) : '',
            hasToken: !!token,
            chatId,
            port,
            localApprovalDelay,
            isRunning,
            processRunning, // We started it
            serverResponding, // Something is responding
            isStarting: botStarting, // In the process of starting
        });
    }

    private async _checkServerHealth(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const http = require('http');
            const req = http.request(
                { hostname: 'localhost', port, path: '/health', method: 'GET', timeout: 2000 },
                (res: any) => {
                    resolve(res.statusCode === 200);
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
        });
    }

    private async _saveAndStart(token: string, chatId: string, port: number, localApprovalDelay: number, useExistingToken: boolean = false) {
        try {
            // Get existing token if using existing
            let finalToken = token;
            if (useExistingToken || !token) {
                const existingToken = await this._context.secrets.get('gatekeeper.botToken');
                if (existingToken) {
                    finalToken = existingToken;
                    log('Using existing saved token');
                } else {
                    this._showError('No saved token found. Please enter your bot token.');
                    return;
                }
            }
            
            // Validate inputs
            if (!finalToken || !finalToken.includes(':')) {
                this._showError('Invalid bot token. Get one from @BotFather on Telegram.');
                return;
            }

            if (!chatId || isNaN(Number(chatId))) {
                this._showError('Invalid Chat ID. Send /start to your bot to get it.');
                return;
            }

            // Save token securely (only if new token provided)
            if (token && token.includes(':')) {
                await this._context.secrets.store('gatekeeper.botToken', token);
            }
            
            // Save other settings
            const config = vscode.workspace.getConfiguration('gatekeeper');
            await config.update('chatId', chatId, vscode.ConfigurationTarget.Global);
            await config.update('httpPort', port, vscode.ConfigurationTarget.Global);
            await config.update('localApprovalDelay', localApprovalDelay, vscode.ConfigurationTarget.Global);
            await config.update('serverUrl', `http://localhost:${port}`, vscode.ConfigurationTarget.Global);
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);

            log(`Saved configuration - ChatID: ${chatId}, Port: ${port}, Local Delay: ${localApprovalDelay}s`);

            // Start the bot
            await this._startBot(finalToken, chatId, port);

        } catch (error) {
            this._showError(`Failed to save settings: ${error}`);
        }
    }

    private async _startBot(token: string, chatId: string, port: number) {
        // Set starting state
        botStarting = true;
        this._sendStatus();

        // Stop existing bot if running
        if (botProcess && !botProcess.killed) {
            botProcess.kill();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Find the bot script
        const botScriptPath = await this._findBotScript();
        if (!botScriptPath) {
            botStarting = false;
            this._sendStatus();
            this._showError('Bot script not found. Clone the repo: git clone https://github.com/sandeep-patel/gatekeeper and open it in VS Code.');
            return;
        }

        // Find Python
        const pythonPath = await this._findPython();
        if (!pythonPath) {
            botStarting = false;
            this._sendStatus();
            this._showError('Python not found. Install Python 3.8+ and create a venv: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt');
            return;
        }

        log(`Starting bot with Python: ${pythonPath}`);
        log(`Bot script: ${botScriptPath}`);

        // Start the bot process
        botProcess = spawn(pythonPath, [botScriptPath], {
            env: {
                ...process.env,
                TELEGRAM_BOT_TOKEN: token,
                TELEGRAM_CHAT_ID: chatId,
                APPROVAL_HTTP_PORT: String(port),
            },
            cwd: path.dirname(botScriptPath),
        });

        botProcess.stdout?.on('data', (data) => {
            const output = data.toString().trim();
            log(`[Bot] ${output}`);
        });

        botProcess.stderr?.on('data', (data) => {
            const output = data.toString().trim();
            log(`[Bot Error] ${output}`);
        });

        botProcess.on('error', (error) => {
            log(`[Bot] Failed to start: ${error.message}`);
            botStarting = false;
            this._panel.webview.postMessage({ command: 'error', message: `Failed to start bot: ${error.message}` });
            this._sendStatus();
        });

        botProcess.on('exit', (code) => {
            log(`[Bot] Exited with code ${code}`);
            botProcess = undefined;
            botStarting = false;
            this._sendStatus();
        });

        // Poll health endpoint until server responds (up to 10 seconds)
        let serverReady = false;
        
        for (let i = 0; i < 20; i++) { // 20 attempts x 500ms = 10 seconds max
            await new Promise(resolve => setTimeout(resolve, 500));
            if (await this._checkServerHealth(port)) {
                serverReady = true;
                break;
            }
            // Check if process died while waiting
            if (!botProcess || botProcess.killed) {
                break;
            }
        }

        // Clear starting state
        botStarting = false;

        if (serverReady && botProcess && !botProcess.killed) {
            this._panel.webview.postMessage({ command: 'started' });
            vscode.window.showInformationMessage('✅ GateKeeper server started successfully!');
            log('Bot started successfully');
            
            // Trigger immediate sidebar/status bar update (silent, no notification)
            vscode.commands.executeCommand('gatekeeper.refreshStatus');
            
            // Auto-register MCP server
            await this._registerMcpServer(pythonPath, botScriptPath, port);
        } else if (botProcess && !botProcess.killed) {
            // Process is running but server not responding
            log('Bot process running but server not responding to health checks');
            this._panel.webview.postMessage({ command: 'error', message: 'Server started but not responding. Check logs.' });
        }

        await this._sendStatus();
    }

    private async _registerMcpServer(_pythonPath: string, _botScriptPath: string, port: number) {
        try {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            
            // Use bundled Node.js MCP server from extension
            const extensionPath = this._context.extensionPath;
            const mcpServerPath = path.join(extensionPath, 'out', 'mcpServer.js');
            
            // Check if MCP server exists
            if (!fs.existsSync(mcpServerPath)) {
                log(`Bundled MCP server not found at ${mcpServerPath}`);
                return;
            }
            
            // Path to VS Code's mcp.json (cross-platform)
            let mcpConfigPath: string;
            const platform = os.platform();
            if (platform === 'darwin') {
                mcpConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
            } else if (platform === 'win32') {
                mcpConfigPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
            } else {
                // Linux
                mcpConfigPath = path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
            }
            
            // Read existing config or create new
            let mcpConfig: { servers: Record<string, any>; inputs?: any[] } = { servers: {}, inputs: [] };
            if (fs.existsSync(mcpConfigPath)) {
                try {
                    const content = fs.readFileSync(mcpConfigPath, 'utf8');
                    mcpConfig = JSON.parse(content);
                } catch {
                    log('Failed to parse existing mcp.json, will overwrite');
                }
            }
            
            // Check if already configured with correct path
            const existingServer = mcpConfig.servers?.['gatekeeper'];
            if (existingServer?.args?.[0] === mcpServerPath) {
                log('MCP server already registered with correct path');
                return;
            }
            
            // Add/update gatekeeper server using Node.js (no Python needed!)
            mcpConfig.servers = mcpConfig.servers || {};
            mcpConfig.servers['gatekeeper'] = {
                type: 'stdio',
                command: 'node',
                args: [mcpServerPath],
                env: {
                    GATEKEEPER_URL: `http://localhost:${port}`
                }
            };
            
            // Ensure directory exists
            const configDir = path.dirname(mcpConfigPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            // Write config
            fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, '\t'));
            log(`Registered bundled MCP server in ${mcpConfigPath}`);
            
            vscode.window.showInformationMessage(
                '🔧 MCP server auto-registered! Reload VS Code to enable run_approved_command.',
                'Reload Window'
            ).then(selection => {
                if (selection === 'Reload Window') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
            
        } catch (error) {
            log(`Failed to register MCP server: ${error}`);
            // Don't show error to user - this is optional functionality
        }
    }

    private async _stopBot() {
        const config = vscode.workspace.getConfiguration('gatekeeper');
        const port = config.get<number>('httpPort') || 8765;
        
        // Kill our process if we started it
        if (botProcess && !botProcess.killed) {
            botProcess.kill();
            botProcess = undefined;
            log('Bot process stopped');
        }
        
        // Also try to kill any process on the port (in case started externally)
        try {
            const { execSync } = require('child_process');
            // Find and kill process on the port
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
            log(`Killed any process on port ${port}`);
        } catch {
            // Ignore errors
        }
        
        vscode.window.showInformationMessage('Extension stopped');
        
        // Wait a moment for the process to die
        await new Promise(resolve => setTimeout(resolve, 500));
        await this._sendStatus();
    }

    private async _testCommand(port: number) {
        log(`Testing command approval on port ${port}...`);
        
        // Notify UI we're waiting for approval
        this._panel.webview.postMessage({
            command: 'testWaiting',
        });
        
        try {
            const http = await import('http');
            const testCommand = 'echo "Connection test successful!"';
            const requestBody = JSON.stringify({
                requestId: `test-${Date.now()}`,
                command: testCommand,
                explanation: 'Test command from VS Code extension setup',
                goal: 'Verify approval flow is working',
            });
            
            const result = await new Promise<{approved: boolean; error?: string}>((resolve) => {
                const req = http.request(
                    { 
                        hostname: 'localhost', 
                        port, 
                        path: '/approve', 
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(requestBody),
                        },
                        timeout: 120000, // 2 minute timeout for approval
                    },
                    (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            log(`Approval response: ${data}`);
                            try {
                                const json = JSON.parse(data);
                                resolve({ approved: json.approved === true });
                            } catch (e) {
                                log(`JSON parse error: ${e}`);
                                resolve({ approved: false, error: 'Invalid response' });
                            }
                        });
                    }
                );
                req.on('error', (e) => {
                    log(`Connection error: ${e}`);
                    resolve({ approved: false, error: e.message });
                });
                req.on('timeout', () => {
                    log('Approval request timeout');
                    req.destroy();
                    resolve({ approved: false, error: 'Timeout waiting for approval' });
                });
                req.write(requestBody);
                req.end();
            });
            
            this._panel.webview.postMessage({
                command: 'testResult',
                approved: result.approved,
                error: result.error,
            });
            
            if (result.approved) {
                vscode.window.showInformationMessage('✅ Test command approved! Everything is working.');
            } else if (result.error) {
                vscode.window.showWarningMessage(`❌ Test failed: ${result.error}`);
            } else {
                vscode.window.showWarningMessage('❌ Test command was rejected.');
            }
            
        } catch (e) {
            log(`Test command exception: ${e}`);
            this._panel.webview.postMessage({ 
                command: 'testResult', 
                approved: false, 
                error: String(e) 
            });
        }
    }

    private async _findBotScript(): Promise<string | undefined> {
        // First check for embedded bot (bundled with extension)
        const embeddedBot = path.join(this._extensionUri.fsPath, 'bot', 'bot.py');
        if (fs.existsSync(embeddedBot)) {
            log(`Found embedded bot at ${embeddedBot}`);
            return embeddedBot;
        }

        // Check several possible locations
        const possiblePaths = [
            // In workspace
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            // Parent of extension (if installed from repo)
            path.join(this._extensionUri.fsPath, '..'),
            // User's home directory
            path.join(process.env.HOME || '', 'gatekeeper'),
            // Config setting
            vscode.workspace.getConfiguration('gatekeeper').get<string>('botPath'),
        ].filter(Boolean);

        for (const basePath of possiblePaths) {
            if (!basePath) continue;
            const botPath = path.join(basePath, 'bot.py');
            if (fs.existsSync(botPath)) {
                log(`Found bot at ${botPath}`);
                return botPath;
            }
        }

        log(`Bot script not found. Searched: embedded, workspace, parent dir, ~/gatekeeper, config`);
        return undefined;
    }

    private async _findPython(): Promise<string | undefined> {
        const { execSync } = await import('child_process');
        
        const pythonCommands = ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3'];
        
        // Check for venv in bot directory
        const botPath = await this._findBotScript();
        if (botPath) {
            const venvPython = path.join(path.dirname(botPath), '.venv', 'bin', 'python');
            if (fs.existsSync(venvPython)) {
                log(`Found Python venv at ${venvPython}`);
                return venvPython;
            }
        }
        
        // Check for venv in workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const workspaceVenv = path.join(workspaceRoot, '.venv', 'bin', 'python');
            if (fs.existsSync(workspaceVenv)) {
                log(`Found Python venv at ${workspaceVenv}`);
                return workspaceVenv;
            }
        }

        for (const cmd of pythonCommands) {
            try {
                execSync(`${cmd} --version`, { stdio: 'pipe' });
                log(`Found Python at ${cmd}`);
                return cmd;
            } catch {
                continue;
            }
        }

        log('Python not found');
        return undefined;
    }

    private _showError(message: string) {
        this._panel.webview.postMessage({ command: 'error', message });
        vscode.window.showErrorMessage(message);
    }

    private _update() {
        this._panel.webview.html = this._getHtmlForWebview();
        setTimeout(() => this._sendStatus(), 100);
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GateKeeper Setup</title>
    <style>
        :root {
            --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            max-width: 600px;
            margin: 0 auto;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        h1 {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
        }
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 24px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
        }
        .help-text {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        input {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--vscode-input-border, #3c3c3c);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            font-size: 14px;
            box-sizing: border-box;
        }
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .button-row {
            display: flex;
            gap: 10px;
            margin-top: 24px;
        }
        button {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: opacity 0.2s;
        }
        button:hover {
            opacity: 0.9;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            flex: 1;
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-danger {
            background: #d32f2f;
            color: white;
        }
        .btn-link {
            background: transparent;
            color: var(--vscode-textLink-foreground);
            padding: 0;
            text-decoration: underline;
        }
        .status-card {
            padding: 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .status-running {
            background: rgba(76, 175, 80, 0.1);
            border: 1px solid rgba(76, 175, 80, 0.3);
        }
        .status-stopped {
            background: rgba(255, 152, 0, 0.1);
            border: 1px solid rgba(255, 152, 0, 0.3);
        }
        .status-starting {
            background: rgba(255, 152, 0, 0.15);
            border: 1px solid rgba(255, 152, 0, 0.5);
        }
        .status-icon {
            font-size: 24px;
        }
        .status-text {
            flex: 1;
        }
        .status-title {
            font-weight: 600;
            margin-bottom: 2px;
        }
        .status-subtitle {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .steps {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 12px 16px;
            margin-bottom: 20px;
            border-radius: 0 4px 4px 0;
        }
        .steps h3 {
            margin: 0 0 8px 0;
            font-size: 14px;
        }
        .steps ol {
            margin: 0;
            padding-left: 20px;
        }
        .steps li {
            margin-bottom: 4px;
        }
        .error-message {
            background: rgba(244, 67, 54, 0.1);
            border: 1px solid rgba(244, 67, 54, 0.3);
            color: #f44336;
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 16px;
            display: none;
        }
        .success-message {
            background: rgba(76, 175, 80, 0.1);
            border: 1px solid rgba(76, 175, 80, 0.3);
            color: #4caf50;
            padding: 12px;
            border-radius: 4px;
            margin-bottom: 16px;
            display: none;
        }
        .advanced-toggle {
            margin-top: 16px;
            font-size: 13px;
        }
        .advanced-section {
            display: none;
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-input-border);
        }
        .advanced-section.show {
            display: block;
        }
    </style>
</head>
<body>
    <h1>�️ GateKeeper Setup</h1>
    <p class="subtitle">Approve VS Code Copilot commands from your phone</p>

    <div id="status-card" class="status-card status-stopped">
        <span class="status-icon">⚪</span>
        <div class="status-text">
            <div class="status-title">Not configured</div>
            <div class="status-subtitle">Enter your bot details below</div>
        </div>
    </div>

    <div id="error-message" class="error-message"></div>
    <div id="success-message" class="success-message"></div>

    <div class="steps">
        <h3>📡 Telegram Channel Setup (2 minutes)</h3>
        <ol>
            <li>Open <button class="btn-link" onclick="openBotFather()">@BotFather</button> on Telegram</li>
            <li>Send <code>/newbot</code> and follow prompts</li>
            <li>Copy your bot token below</li>
            <li>Start a chat with your new bot, send <code>/start</code></li>
            <li>Copy the Chat ID from the response</li>
        </ol>
    </div>

    <div id="setup-form">
        <div class="form-group">
            <label for="token">Bot Token</label>
            <div id="token-configured" style="display: none; margin-bottom: 8px;">
                <span style="color: var(--vscode-descriptionForeground);">🔐 Token configured: </span>
                <code id="token-masked"></code>
                <button class="btn-link" onclick="changeToken()" style="margin-left: 8px;">Change</button>
            </div>
            <input type="password" id="token" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz">
            <p class="help-text" id="token-help">Get this from @BotFather after creating your bot</p>
        </div>

        <div class="form-group">
            <label for="chatId">Your Chat ID</label>
            <input type="text" id="chatId" placeholder="123456789">
            <p class="help-text">Send /start to your bot to get this</p>
        </div>

        <div class="advanced-toggle">
            <button class="btn-link" onclick="toggleAdvanced()">⚙️ Advanced settings</button>
        </div>

        <div id="advanced-section" class="advanced-section">
            <div class="form-group">
                <label for="port">HTTP Port</label>
                <input type="number" id="port" value="8765">
                <p class="help-text">Port for the local approval server</p>
            </div>
            <div class="form-group">
                <label for="localDelay">Local Approval Delay (seconds)</label>
                <input type="number" id="localDelay" value="10" min="0" max="300">
                <p class="help-text">Wait this long for VS Code approval before sending to Telegram</p>
            </div>
        </div>

        <div class="button-row">
            <button id="start-btn" class="btn-primary" onclick="saveAndStart()">
                🚀 Start Approval Server
            </button>
            <button id="stop-btn" class="btn-danger" onclick="stopBot()" style="display: none;">
                ⏹️ Stop
            </button>
            <button id="test-btn" class="btn-secondary" onclick="testCommand()" style="display: none;">
                📱 Test Command
            </button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let isRunning = false;

        function openBotFather() {
            vscode.postMessage({ command: 'openBotFather' });
        }

        function toggleAdvanced() {
            document.getElementById('advanced-section').classList.toggle('show');
        }

        function saveAndStart() {
            const tokenInput = document.getElementById('token');
            const tokenConfigured = document.getElementById('token-configured');
            const token = tokenInput.value.trim();
            const chatId = document.getElementById('chatId').value.trim();
            const port = parseInt(document.getElementById('port').value) || 8765;
            const localApprovalDelay = parseInt(document.getElementById('localDelay').value) || 10;
            
            // Check if token is configured (input is hidden) or newly entered
            const useExistingToken = tokenConfigured.style.display !== 'none';

            hideMessages();

            if (!token && !useExistingToken) {
                showError('Please enter your bot token');
                return;
            }
            if (!chatId) {
                showError('Please enter your Chat ID');
                return;
            }

            document.getElementById('start-btn').disabled = true;
            document.getElementById('start-btn').textContent = '⏳ Starting...';

            // Send empty token to indicate "use existing"
            vscode.postMessage({ command: 'saveAndStart', token: token || '', chatId, port, localApprovalDelay, useExistingToken });
        }

        function stopBot() {
            vscode.postMessage({ command: 'stop' });
        }

        function changeToken() {
            document.getElementById('token-configured').style.display = 'none';
            document.getElementById('token').style.display = 'block';
            document.getElementById('token-help').style.display = 'block';
            document.getElementById('token').focus();
        }

        function testCommand() {
            const port = parseInt(document.getElementById('port').value) || 8765;
            console.log('testCommand clicked, port:', port);
            document.getElementById('test-btn').disabled = true;
            document.getElementById('test-btn').textContent = '📱 Waiting for Telegram...';
            hideMessages();
            showSuccess('Command sent to Telegram. Check your phone to approve/reject!');
            vscode.postMessage({ command: 'testConnection', port });
        }

        function showError(message) {
            const el = document.getElementById('error-message');
            el.textContent = '❌ ' + message;
            el.style.display = 'block';
        }

        function showSuccess(message) {
            const el = document.getElementById('success-message');
            el.textContent = '✅ ' + message;
            el.style.display = 'block';
        }

        function hideMessages() {
            document.getElementById('error-message').style.display = 'none';
            document.getElementById('success-message').style.display = 'none';
        }

        function updateUI(status) {
            isRunning = status.isRunning;
            const statusCard = document.getElementById('status-card');
            const startBtn = document.getElementById('start-btn');
            const stopBtn = document.getElementById('stop-btn');
            const testBtn = document.getElementById('test-btn');

            if (status.isStarting) {
                // Server is starting
                statusCard.className = 'status-card status-starting';
                statusCard.innerHTML = \`
                    <span class="status-icon">🟠</span>
                    <div class="status-text">
                        <div class="status-title">Starting...</div>
                        <div class="status-subtitle">Please wait while the server starts</div>
                    </div>
                \`;
                startBtn.style.display = 'block';
                startBtn.textContent = '⏳ Starting...';
                startBtn.disabled = true;
                stopBtn.style.display = 'none';
                testBtn.style.display = 'none';
            } else if (status.isRunning && status.hasToken) {
                // Server running and we have config
                statusCard.className = 'status-card status-running';
                statusCard.innerHTML = \`
                    <span class="status-icon">🟢</span>
                    <div class="status-text">
                        <div class="status-title">Server Running</div>
                        <div class="status-subtitle">Waiting for commands to approve</div>
                    </div>
                \`;
                startBtn.style.display = 'none';
                stopBtn.style.display = 'block';
                testBtn.style.display = 'block';
            } else if (status.serverResponding && !status.hasToken) {
                // Something is running on the port but we're not configured
                statusCard.className = 'status-card status-stopped';
                statusCard.innerHTML = \`
                    <span class="status-icon">⚠️</span>
                    <div class="status-text">
                        <div class="status-title">Server detected on port</div>
                        <div class="status-subtitle">Configure your bot details below</div>
                    </div>
                \`;
                startBtn.style.display = 'block';
                startBtn.textContent = '🚀 Start Approval Server';
                startBtn.disabled = false;
                stopBtn.style.display = 'block';
                testBtn.style.display = 'block';
            } else if (status.hasToken) {
                // Configured but not running
                statusCard.className = 'status-card status-stopped';
                statusCard.innerHTML = \`
                    <span class="status-icon">🟡</span>
                    <div class="status-text">
                        <div class="status-title">Configured but stopped</div>
                        <div class="status-subtitle">Click Start to begin</div>
                    </div>
                \`;
                startBtn.style.display = 'block';
                startBtn.textContent = '🚀 Start Approval Server';
                startBtn.disabled = false;
                stopBtn.style.display = 'none';
                testBtn.style.display = 'none';
            } else {
                // Not configured
                statusCard.className = 'status-card status-stopped';
                statusCard.innerHTML = \`
                    <span class="status-icon">⚪</span>
                    <div class="status-text">
                        <div class="status-title">Not configured</div>
                        <div class="status-subtitle">Enter your bot details below</div>
                    </div>
                \`;
                startBtn.style.display = 'block';
                startBtn.textContent = '🚀 Start Approval Server';
                startBtn.disabled = false;
                stopBtn.style.display = 'none';
                testBtn.style.display = 'none';
            }
        }

        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Received message:', message);
            switch (message.command) {
                case 'status':
                    if (message.chatId) document.getElementById('chatId').value = message.chatId;
                    if (message.port) document.getElementById('port').value = message.port;
                    if (message.localApprovalDelay !== undefined) document.getElementById('localDelay').value = message.localApprovalDelay;
                    // Show token status
                    if (message.hasToken && message.token) {
                        document.getElementById('token-configured').style.display = 'block';
                        document.getElementById('token-masked').textContent = message.token;
                        document.getElementById('token').style.display = 'none';
                        document.getElementById('token-help').style.display = 'none';
                    }
                    updateUI(message);
                    break;
                case 'error':
                    showError(message.message);
                    document.getElementById('start-btn').disabled = false;
                    document.getElementById('start-btn').textContent = '🚀 Start Approval Server';
                    break;
                case 'started':
                    hideMessages();
                    showSuccess('Server started! Send a command from Copilot to test.');
                    break;
                case 'connectionResult':
                    console.log('connectionResult received:', message);
                    document.getElementById('test-btn').disabled = false;
                    document.getElementById('test-btn').textContent = '� Test Command';
                    if (message.success) {
                        showSuccess('Connected! ' + (message.pending || 0) + ' pending approval(s)');
                    } else {
                        showError('Cannot connect to server');
                    }
                    break;
                case 'testWaiting':
                    console.log('testWaiting received');
                    document.getElementById('test-btn').disabled = true;
                    document.getElementById('test-btn').textContent = '📱 Waiting for Telegram...';
                    break;
                case 'testResult':
                    console.log('testResult received:', message);
                    document.getElementById('test-btn').disabled = false;
                    document.getElementById('test-btn').textContent = '📱 Test Command';
                    hideMessages();
                    if (message.approved) {
                        showSuccess('✅ Test command approved! Everything is working.');
                    } else if (message.error) {
                        showError('Test failed: ' + message.error);
                    } else {
                        showError('Test command was rejected.');
                    }
                    break;
            }
        });

        // Request initial status
        vscode.postMessage({ command: 'getStatus' });
    </script>
</body>
</html>`;
    }

    public dispose() {
        SetupPanel.currentPanel = undefined;
        if (this._statusInterval) {
            clearInterval(this._statusInterval);
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}

export function stopBotProcess() {
    if (botProcess && !botProcess.killed) {
        botProcess.kill();
        botProcess = undefined;
        log('Bot process stopped on deactivation');
    }
}

export function isBotRunning(): boolean {
    return botProcess !== undefined && !botProcess.killed;
}

export function isBotStarting(): boolean {
    return botStarting;
}

/**
 * Auto-register the MCP server with the correct extension path.
 * Called on extension activation to ensure mcp.json always points to the current version.
 */
export async function ensureMcpRegistration(context: vscode.ExtensionContext) {
    try {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        
        const extensionPath = context.extensionPath;
        const mcpServerPath = path.join(extensionPath, 'out', 'mcpServer.js');
        
        // Check if MCP server exists
        if (!fs.existsSync(mcpServerPath)) {
            return; // Not bundled, skip
        }
        
        // Path to VS Code's mcp.json (cross-platform)
        let mcpConfigPath: string;
        const platform = os.platform();
        if (platform === 'darwin') {
            mcpConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
        } else if (platform === 'win32') {
            mcpConfigPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
        } else {
            mcpConfigPath = path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
        }
        
        // Read existing config
        let mcpConfig: { servers: Record<string, any>; inputs?: any[] } = { servers: {}, inputs: [] };
        if (fs.existsSync(mcpConfigPath)) {
            try {
                const content = fs.readFileSync(mcpConfigPath, 'utf8');
                mcpConfig = JSON.parse(content);
            } catch {
                return; // Can't parse, don't overwrite
            }
        }
        
        // Check if already configured with correct path
        const existingServer = mcpConfig.servers?.['gatekeeper'];
        if (existingServer?.args?.[0] === mcpServerPath) {
            return; // Already correct
        }
        
        // Only update if gatekeeper entry exists (don't auto-create on first install)
        if (!existingServer) {
            return;
        }
        
        // Update path
        const config = vscode.workspace.getConfiguration('gatekeeper');
        const port = config.get<number>('httpPort') || 8765;
        
        mcpConfig.servers['gatekeeper'] = {
            type: 'stdio',
            command: 'node',
            args: [mcpServerPath],
            env: {
                GATEKEEPER_URL: `http://localhost:${port}`
            }
        };
        
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, '\t'));
        log(`Updated MCP server path to ${mcpServerPath}`);
        
        // Notify user to reload
        vscode.window.showInformationMessage(
            '🔧 GateKeeper MCP server path updated. Reload window to apply.',
            'Reload Window'
        ).then(selection => {
            if (selection === 'Reload Window') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
        
    } catch (error) {
        // Silent fail - this is convenience functionality
    }
}
