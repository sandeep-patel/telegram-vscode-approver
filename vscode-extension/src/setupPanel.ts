import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

let botProcess: ChildProcess | undefined;
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

    public static createOrShow(context: vscode.ExtensionContext) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SetupPanel.currentPanel) {
            SetupPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'telegramApprovalSetup',
            'Telegram Approval Setup',
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
                        await this._saveAndStart(message.token, message.chatId, message.port);
                        break;
                    case 'stop':
                        await this._stopBot();
                        break;
                    case 'testConnection':
                        await this._testConnection(message.port);
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
    }

    private async _sendStatus() {
        const config = vscode.workspace.getConfiguration('telegramApproval');
        const token = await this._context.secrets.get('telegramApproval.botToken') || '';
        const chatId = config.get<string>('chatId') || '';
        const port = config.get<number>('httpPort') || 8765;
        const isRunning = botProcess !== undefined && !botProcess.killed;

        this._panel.webview.postMessage({
            command: 'status',
            token: token ? '••••••••' + token.slice(-8) : '',
            hasToken: !!token,
            chatId,
            port,
            isRunning,
        });
    }

    private async _saveAndStart(token: string, chatId: string, port: number) {
        try {
            // Validate inputs
            if (!token || !token.includes(':')) {
                this._showError('Invalid bot token. Get one from @BotFather on Telegram.');
                return;
            }

            if (!chatId || isNaN(Number(chatId))) {
                this._showError('Invalid Chat ID. Send /start to your bot to get it.');
                return;
            }

            // Save token securely
            await this._context.secrets.store('telegramApproval.botToken', token);
            
            // Save other settings
            const config = vscode.workspace.getConfiguration('telegramApproval');
            await config.update('chatId', chatId, vscode.ConfigurationTarget.Global);
            await config.update('httpPort', port, vscode.ConfigurationTarget.Global);
            await config.update('serverUrl', `http://localhost:${port}`, vscode.ConfigurationTarget.Global);
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);

            log(`Saved configuration - ChatID: ${chatId}, Port: ${port}`);

            // Start the bot
            await this._startBot(token, chatId, port);

        } catch (error) {
            this._showError(`Failed to save settings: ${error}`);
        }
    }

    private async _startBot(token: string, chatId: string, port: number) {
        // Stop existing bot if running
        if (botProcess && !botProcess.killed) {
            botProcess.kill();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Find the bot script
        const botScriptPath = await this._findBotScript();
        if (!botScriptPath) {
            this._showError('Bot script not found. Please ensure the telegram-approval package is installed.');
            return;
        }

        // Find Python
        const pythonPath = await this._findPython();
        if (!pythonPath) {
            this._showError('Python not found. Please install Python 3.8+ and try again.');
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
            this._panel.webview.postMessage({ command: 'error', message: `Failed to start bot: ${error.message}` });
        });

        botProcess.on('exit', (code) => {
            log(`[Bot] Exited with code ${code}`);
            botProcess = undefined;
            this._sendStatus();
        });

        // Wait a moment for the bot to start
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (botProcess && !botProcess.killed) {
            this._panel.webview.postMessage({ command: 'started' });
            vscode.window.showInformationMessage('✅ Telegram Approval Bot started successfully!');
            log('Bot started successfully');
        }

        await this._sendStatus();
    }

    private async _stopBot() {
        if (botProcess && !botProcess.killed) {
            botProcess.kill();
            botProcess = undefined;
            log('Bot stopped');
            vscode.window.showInformationMessage('Bot stopped');
        }
        await this._sendStatus();
    }

    private async _testConnection(port: number) {
        try {
            const http = await import('http');
            const result = await new Promise<boolean>((resolve) => {
                const req = http.request(
                    { hostname: 'localhost', port, path: '/health', method: 'GET', timeout: 3000 },
                    (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => {
                            try {
                                const json = JSON.parse(data);
                                this._panel.webview.postMessage({
                                    command: 'connectionResult',
                                    success: true,
                                    pending: json.pending_approvals || 0,
                                });
                                resolve(true);
                            } catch {
                                resolve(false);
                            }
                        });
                    }
                );
                req.on('error', () => {
                    this._panel.webview.postMessage({
                        command: 'connectionResult',
                        success: false,
                    });
                    resolve(false);
                });
                req.on('timeout', () => {
                    req.destroy();
                    resolve(false);
                });
                req.end();
            });
        } catch {
            this._panel.webview.postMessage({ command: 'connectionResult', success: false });
        }
    }

    private async _findBotScript(): Promise<string | undefined> {
        // Check several possible locations
        const possiblePaths = [
            // In workspace
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            // Parent of extension (if installed from repo)
            path.join(this._extensionUri.fsPath, '..'),
            // User's home directory
            path.join(process.env.HOME || '', 'telegram-approval'),
            // Config setting
            vscode.workspace.getConfiguration('telegramApproval').get<string>('botPath'),
        ].filter(Boolean);

        for (const basePath of possiblePaths) {
            if (!basePath) continue;
            const botPath = path.join(basePath, 'bot.py');
            if (fs.existsSync(botPath)) {
                return botPath;
            }
        }

        // Check if we have an embedded bot
        const embeddedBot = path.join(this._extensionUri.fsPath, 'bot', 'bot.py');
        if (fs.existsSync(embeddedBot)) {
            return embeddedBot;
        }

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
                return venvPython;
            }
        }

        for (const cmd of pythonCommands) {
            try {
                execSync(`${cmd} --version`, { stdio: 'pipe' });
                return cmd;
            } catch {
                continue;
            }
        }

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
    <title>Telegram Approval Setup</title>
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
    <h1>📱 Telegram Approval Setup</h1>
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
        <h3>Quick Setup (2 minutes)</h3>
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
            <input type="password" id="token" placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz">
            <p class="help-text">Get this from @BotFather after creating your bot</p>
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
        </div>

        <div class="button-row">
            <button id="start-btn" class="btn-primary" onclick="saveAndStart()">
                🚀 Start Approval Server
            </button>
            <button id="stop-btn" class="btn-danger" onclick="stopBot()" style="display: none;">
                ⏹️ Stop
            </button>
            <button id="test-btn" class="btn-secondary" onclick="testConnection()" style="display: none;">
                🔍 Test
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
            const token = document.getElementById('token').value.trim();
            const chatId = document.getElementById('chatId').value.trim();
            const port = parseInt(document.getElementById('port').value) || 8765;

            hideMessages();

            if (!token) {
                showError('Please enter your bot token');
                return;
            }
            if (!chatId) {
                showError('Please enter your Chat ID');
                return;
            }

            document.getElementById('start-btn').disabled = true;
            document.getElementById('start-btn').textContent = '⏳ Starting...';

            vscode.postMessage({ command: 'saveAndStart', token, chatId, port });
        }

        function stopBot() {
            vscode.postMessage({ command: 'stop' });
        }

        function testConnection() {
            const port = parseInt(document.getElementById('port').value) || 8765;
            document.getElementById('test-btn').disabled = true;
            document.getElementById('test-btn').textContent = '⏳ Testing...';
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

        function updateUI(running, hasToken) {
            isRunning = running;
            const statusCard = document.getElementById('status-card');
            const startBtn = document.getElementById('start-btn');
            const stopBtn = document.getElementById('stop-btn');
            const testBtn = document.getElementById('test-btn');

            if (running) {
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
            } else if (hasToken) {
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
            switch (message.command) {
                case 'status':
                    if (message.chatId) document.getElementById('chatId').value = message.chatId;
                    if (message.port) document.getElementById('port').value = message.port;
                    updateUI(message.isRunning, message.hasToken);
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
                    document.getElementById('test-btn').disabled = false;
                    document.getElementById('test-btn').textContent = '🔍 Test';
                    if (message.success) {
                        showSuccess('Connected! ' + (message.pending || 0) + ' pending approval(s)');
                    } else {
                        showError('Cannot connect to server');
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
