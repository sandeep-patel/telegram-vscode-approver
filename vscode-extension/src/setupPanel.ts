import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { parse as parseJsonc, ParseError } from 'jsonc-parser';

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
                        await this._saveAndStart(message.token, message.chatId, message.port, message.localApprovalDelay, message.preventSleep, message.useExistingToken);
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
        const preventSleep = config.get<boolean>('preventSleep') ?? true;
        
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
            preventSleep,
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

    private async _saveAndStart(token: string, chatId: string, port: number, localApprovalDelay: number, preventSleep: boolean, useExistingToken: boolean = false) {
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

            // Validate port range (1024-65535; privileged ports require root)
            const portNum = Number(port);
            if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
                this._showError(`Invalid port ${port}. Use a number between 1024 and 65535 (ports below 1024 require root).`);
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
            await config.update('preventSleep', preventSleep, vscode.ConfigurationTarget.Global);
            await config.update('serverUrl', `http://localhost:${port}`, vscode.ConfigurationTarget.Global);
            await config.update('enabled', true, vscode.ConfigurationTarget.Global);

            log(`Saved configuration - ChatID: ${chatId}, Port: ${port}, Local Delay: ${localApprovalDelay}s, Prevent Sleep: ${preventSleep}`);

            // Start the bot
            await this._startBot(finalToken, chatId, port, preventSleep);

        } catch (error) {
            this._showError(`Failed to save settings: ${error}`);
        }
    }

    private async _startBot(token: string, chatId: string, port: number, preventSleep: boolean = true) {
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
            this._showError('Python 3.8+ not found. Please install Python 3 from https://www.python.org/downloads/');
            return;
        }

        log(`Starting bot with Python: ${pythonPath}`);
        log(`Bot script: ${botScriptPath}`);

        // Ensure Python dependencies are installed (auto-install on first run).
        // Returns the python interpreter to actually use (may be a managed venv).
        const runtimePython = await this._ensureBotDeps(pythonPath, botScriptPath);
        if (!runtimePython) {
            botStarting = false;
            this._sendStatus();
            return;
        }

        // Buffer the last bit of stderr so we can surface a useful error if the bot dies
        // before the health endpoint comes up.
        const stderrBuffer: string[] = [];
        const STDERR_BUFFER_MAX = 50; // keep last 50 lines

        // Start the bot process
        botProcess = spawn(runtimePython, [botScriptPath], {
            env: {
                ...process.env,
                TELEGRAM_BOT_TOKEN: token,
                TELEGRAM_CHAT_ID: chatId,
                APPROVAL_HTTP_PORT: String(port),
                PREVENT_SLEEP: preventSleep ? 'true' : 'false',
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
            stderrBuffer.push(output);
            if (stderrBuffer.length > STDERR_BUFFER_MAX) {
                stderrBuffer.splice(0, stderrBuffer.length - STDERR_BUFFER_MAX);
            }
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
            await this._registerMcpServer(runtimePython, botScriptPath, port);
        } else if (botProcess && !botProcess.killed) {
            // Process is running but server not responding
            log('Bot process running but server not responding to health checks');
            this._panel.webview.postMessage({ command: 'error', message: 'Server started but not responding to /health. Check GateKeeper logs.' });
        } else {
            // Process died before becoming healthy — translate stderr into a friendly error.
            const tail = stderrBuffer.join('\n');
            const friendly = this._diagnoseBotFailure(tail, port);
            this._panel.webview.postMessage({ command: 'error', message: friendly });
            vscode.window.showErrorMessage(friendly);
        }

        await this._sendStatus();
    }

    /**
     * Convert a chunk of bot stderr into a human-friendly error message that tells
     * the user exactly what to do. Falls back to a generic message with the tail
     * appended if no known pattern matches.
     */
    private _diagnoseBotFailure(stderrTail: string, port: number): string {
        const s = stderrTail.toLowerCase();

        if (s.includes('address already in use') || s.includes('eaddrinuse') || s.includes('errno 48') || s.includes('errno 98')) {
            const killHint = process.platform === 'win32'
                ? `netstat -ano | findstr :${port}  (then: taskkill /F /PID <pid>)`
                : `lsof -ti:${port} | xargs kill -9`;
            return `Port ${port} is already in use. Either change the port in GateKeeper Setup or stop the process using it (try: ${killHint}).`;
        }

        if (s.includes('conflict') && (s.includes('getupdates') || s.includes('terminated by other'))) {
            return 'Another instance of this bot is already polling Telegram (HTTP 409 Conflict). Stop any other running copies (other VS Code windows, docker containers, scripts) or revoke + recreate the token in @BotFather, then try again.';
        }

        if (s.includes('permission denied') && (s.includes("port") || s.includes('bind'))) {
            return `Permission denied binding to port ${port}. Pick a port above 1024 in GateKeeper Setup.`;
        }

        if (s.includes('unauthorized') || s.includes('401') || s.includes('invalid token')) {
            return 'Telegram rejected the bot token (401 Unauthorized). Get a fresh token from @BotFather and paste it in GateKeeper Setup → Change.';
        }

        if (s.includes('chat not found') || s.includes('chat_id is empty') || s.includes("bot can't initiate conversation")) {
            return 'Telegram could not deliver to your Chat ID. Open the bot in Telegram and send /start, then re-check the Chat ID in Setup.';
        }

        if (s.includes('network is unreachable') || s.includes('temporary failure in name resolution') || s.includes('getaddrinfo') || s.includes('connection refused') || s.includes('ssl') && s.includes('handshake')) {
            return 'Network error reaching Telegram. Check your internet connection / corporate proxy / firewall, then click Start again.';
        }

        if (s.includes('modulenotfounderror') || s.includes('no module named')) {
            const match = stderrTail.match(/No module named ['\"]([^'\"]+)['\"]/);
            const mod = match ? match[1] : 'a required module';
            return `Bot failed to import ${mod}. The auto-install may have been incomplete — try restarting (the managed venv will rebuild) or check GateKeeper logs.`;
        }

        if (s.includes('syntaxerror')) {
            return 'Python rejected the bot script (SyntaxError). Your Python version may be too old — install Python 3.8+ and restart.';
        }

        // Generic fallback: show the last few lines verbatim so the user has something to copy/paste.
        const lines = stderrTail.split('\n').filter(Boolean).slice(-5).join('\n');
        return lines
            ? `Bot exited before becoming ready. Last error output:\n${lines}\n\nSee GateKeeper logs for full details.`
            : 'Bot exited before becoming ready and produced no error output. See GateKeeper logs.';
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
                log(`Bundled MCP server not found at ${mcpServerPath} — skipping auto-registration`);
                vscode.window.showWarningMessage(
                    'GateKeeper: bundled MCP server (out/mcpServer.js) not found. Copilot integration will not work until the extension is rebuilt.'
                );
                return;
            }
            
            // Path to VS Code's mcp.json — derive from VS Code's own globalStorageUri so this
            // works for Code, Code - Insiders, Cursor, VSCodium, and portable installs.
            // globalStorageUri = <productUserDir>/globalStorage/<extId>  → go up two levels.
            let mcpConfigPath: string;
            try {
                const globalStorage = this._context.globalStorageUri.fsPath;
                const userDir = path.dirname(path.dirname(globalStorage));
                mcpConfigPath = path.join(userDir, 'mcp.json');
                log(`Derived mcp.json path from globalStorageUri: ${mcpConfigPath}`);
            } catch {
                // Fallback to platform-specific guess
                const platform = os.platform();
                if (platform === 'darwin') {
                    mcpConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
                } else if (platform === 'win32') {
                    mcpConfigPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'mcp.json');
                } else {
                    mcpConfigPath = path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
                }
                log(`Falling back to platform-default mcp.json path: ${mcpConfigPath}`);
            }
            
            // Read existing config or create new. mcp.json supports JSONC (comments,
            // trailing commas), so we MUST use a JSONC parser — not JSON.parse — or we
            // would refuse to parse and end up wiping the user's other MCP servers.
            let mcpConfig: { servers: Record<string, any>; inputs?: any[] } = { servers: {}, inputs: [] };
            if (fs.existsSync(mcpConfigPath)) {
                const content = fs.readFileSync(mcpConfigPath, 'utf8');
                const errors: ParseError[] = [];
                const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
                if (errors.length > 0 || typeof parsed !== 'object' || parsed === null) {
                    // Don't overwrite a file we couldn't safely parse — surface and bail.
                    const errMsg = errors.length > 0 ? `parse errors at offset(s) ${errors.map(e => e.offset).join(', ')}` : 'unexpected top-level value';
                    log(`Refusing to overwrite mcp.json: ${errMsg}`);
                    vscode.window.showWarningMessage(
                        `GateKeeper: could not safely parse ${mcpConfigPath} (${errMsg}). Fix the file manually or delete it, then click Start again. MCP not registered to avoid clobbering your other servers.`
                    );
                    return;
                }
                mcpConfig = parsed as typeof mcpConfig;
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
            vscode.window.showWarningMessage(
                `GateKeeper: MCP auto-registration failed (${error}). See GateKeeper logs. You can register it manually via VS Code's mcp.json.`
            );
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

        // Also try to kill any process on the port (in case started externally or our
        // child reference was lost). Branch on platform — lsof/xargs only exist on Unix.
        try {
            const { execSync } = require('child_process');
            if (process.platform === 'win32') {
                // Find PIDs listening on the port via netstat, then taskkill each.
                const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
                const pids = new Set<string>();
                for (const line of out.split(/\r?\n/)) {
                    const m = line.trim().match(/LISTENING\s+(\d+)$/i);
                    if (m) pids.add(m[1]);
                }
                for (const pid of pids) {
                    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
                }
                if (pids.size > 0) log(`Killed PIDs on port ${port}: ${[...pids].join(', ')}`);
            } else {
                execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
                log(`Killed any process on port ${port}`);
            }
        } catch {
            // Ignore errors — nothing was listening, or we lack permission.
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

    /**
     * Ensure bot dependencies are importable. Returns the python interpreter
     * to actually use to run the bot (which may be a managed venv we create
     * inside the extension's globalStorage). Returns undefined on failure.
     *
     * Strategy:
     *   1. If the given pythonPath can already import telegram/aiohttp/mcp → use it as-is.
     *   2. Otherwise locate or create a managed venv at <globalStorage>/venv,
     *      install requirements there, and return the venv's python.
     *      This avoids PEP 668 ("externally-managed-environment") errors on
     *      modern macOS/Linux system Pythons and avoids needing sudo.
     */
    private async _ensureBotDeps(pythonPath: string, botScriptPath: string): Promise<string | undefined> {
        const canImport = (py: string) => new Promise<boolean>((resolve) => {
            const check = spawn(py, ['-c', 'import telegram, aiohttp, mcp'], { stdio: 'pipe' });
            check.on('exit', (code) => resolve(code === 0));
            check.on('error', () => resolve(false));
        });

        // 1. Does the system python already have everything?
        if (await canImport(pythonPath)) {
            log(`Bot dependencies already installed on ${pythonPath}`);
            return pythonPath;
        }

        // 2. Check the managed venv (may already exist from a previous run)
        const venvDir = path.join(this._context.globalStorageUri.fsPath, 'venv');
        const venvPython = process.platform === 'win32'
            ? path.join(venvDir, 'Scripts', 'python.exe')
            : path.join(venvDir, 'bin', 'python');

        if (fs.existsSync(venvPython) && await canImport(venvPython)) {
            log(`Bot dependencies present in managed venv ${venvPython}`);
            return venvPython;
        }

        // 3. Locate requirements.txt (bundled next to bot.py)
        const reqPath = path.join(path.dirname(botScriptPath), 'requirements.txt');
        if (!fs.existsSync(reqPath)) {
            this._showError(`Cannot auto-install: requirements.txt not found at ${reqPath}`);
            return undefined;
        }

        log(`Bot dependencies missing — creating managed venv at ${venvDir}`);

        // Ensure parent directory exists
        const parent = path.dirname(venvDir);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

        const runStep = (cmd: string, args: string[], label: string) =>
            new Promise<boolean>((resolve) => {
                log(`Running: ${cmd} ${args.join(' ')}`);
                const proc = spawn(cmd, args, { stdio: 'pipe' });
                proc.stdout?.on('data', (d) => log(`[${label}] ${d.toString().trim()}`));
                proc.stderr?.on('data', (d) => log(`[${label}] ${d.toString().trim()}`));
                proc.on('exit', (code) => resolve(code === 0));
                proc.on('error', (err) => {
                    log(`[${label}] failed to spawn: ${err.message}`);
                    resolve(false);
                });
            });

        return await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'GateKeeper: setting up Python environment (first-run, ~30s)…',
                cancellable: false,
            },
            async (progress) => {
                // Create venv if missing
                if (!fs.existsSync(venvPython)) {
                    progress.report({ message: 'creating virtual environment' });
                    const created = await runStep(pythonPath, ['-m', 'venv', venvDir], 'venv');
                    if (!created || !fs.existsSync(venvPython)) {
                        this._showError(
                            `Failed to create venv at ${venvDir}. Ensure the 'venv' module is available (on Debian/Ubuntu: apt install python3-venv). See GateKeeper logs.`
                        );
                        return undefined;
                    }
                }

                // Upgrade pip inside the venv (best-effort)
                progress.report({ message: 'upgrading pip' });
                await runStep(venvPython, ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', 'pip'], 'pip');

                // Install requirements into the venv
                progress.report({ message: 'installing dependencies' });
                const installed = await runStep(
                    venvPython,
                    ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqPath],
                    'pip'
                );
                if (!installed) {
                    this._showError(
                        `pip install failed inside managed venv. Check GateKeeper logs. You can retry manually: ${venvPython} -m pip install -r ${reqPath}`
                    );
                    return undefined;
                }

                // Verify
                if (!(await canImport(venvPython))) {
                    this._showError('Dependencies installed but import check still failed. See GateKeeper logs.');
                    return undefined;
                }

                log(`Managed venv ready at ${venvPython}`);
                vscode.window.showInformationMessage('✅ GateKeeper: Python environment ready');
                return venvPython;
            }
        );
    }

    private async _findPython(): Promise<string | undefined> {
        const { execSync } = await import('child_process');

        const pythonCommands = ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'];

        // Returns the python path if it is >= 3.8, otherwise undefined.
        const versionOk = (cmd: string): string | undefined => {
            try {
                const out = execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
                const m = out.match(/Python\s+(\d+)\.(\d+)/i);
                if (!m) {
                    log(`Could not parse version from ${cmd}: ${out}`);
                    return undefined;
                }
                const major = parseInt(m[1], 10);
                const minor = parseInt(m[2], 10);
                if (major < 3 || (major === 3 && minor < 8)) {
                    log(`Python at ${cmd} is too old (${out}); need 3.8+`);
                    return undefined;
                }
                log(`Found Python at ${cmd} (${out})`);
                return cmd;
            } catch {
                return undefined;
            }
        };

        // Check for venv in bot directory
        const botPath = await this._findBotScript();
        if (botPath) {
            const venvPython = path.join(path.dirname(botPath), '.venv', 'bin', 'python');
            if (fs.existsSync(venvPython)) {
                const ok = versionOk(venvPython);
                if (ok) return ok;
            }
        }

        // Check for venv in workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceRoot) {
            const workspaceVenv = path.join(workspaceRoot, '.venv', 'bin', 'python');
            if (fs.existsSync(workspaceVenv)) {
                const ok = versionOk(workspaceVenv);
                if (ok) return ok;
            }
        }

        for (const cmd of pythonCommands) {
            const ok = versionOk(cmd);
            if (ok) return ok;
        }

        log('Python 3.8+ not found');
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
        .checkbox-group {
            margin-top: 12px;
        }
        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 8px;
            cursor: pointer;
            font-weight: normal;
        }
        .checkbox-label input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
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
            <div class="form-group checkbox-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="preventSleep" checked>
                    <span>☕ Prevent Mac from sleeping</span>
                </label>
                <p class="help-text">Keep your Mac awake while the server is running (macOS only)</p>
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
        let initialStatusReceived = false;  // Only update form fields on first status

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
            const preventSleep = document.getElementById('preventSleep').checked;
            
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
            vscode.postMessage({ command: 'saveAndStart', token: token || '', chatId, port, localApprovalDelay, preventSleep, useExistingToken });
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
                    // Only populate form fields on initial load to avoid overwriting user edits
                    if (!initialStatusReceived) {
                        initialStatusReceived = true;
                        if (message.chatId) document.getElementById('chatId').value = message.chatId;
                        if (message.port) document.getElementById('port').value = message.port;
                        if (message.localApprovalDelay !== undefined) document.getElementById('localDelay').value = message.localApprovalDelay;
                        if (message.preventSleep !== undefined) document.getElementById('preventSleep').checked = message.preventSleep;
                        // Show token status
                        if (message.hasToken && message.token) {
                            document.getElementById('token-configured').style.display = 'block';
                            document.getElementById('token-masked').textContent = message.token;
                            document.getElementById('token').style.display = 'none';
                            document.getElementById('token-help').style.display = 'none';
                        }
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
        
        // Read existing config. mcp.json supports JSONC — use a tolerant parser so we
        // don't bail on a file that VS Code itself accepts (and never overwrite on parse failure).
        let mcpConfig: { servers: Record<string, any>; inputs?: any[] } = { servers: {}, inputs: [] };
        if (fs.existsSync(mcpConfigPath)) {
            const content = fs.readFileSync(mcpConfigPath, 'utf8');
            const errors: ParseError[] = [];
            const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
            if (errors.length > 0 || typeof parsed !== 'object' || parsed === null) {
                log(`Skipping MCP path refresh: could not parse ${mcpConfigPath}`);
                return;
            }
            mcpConfig = parsed as typeof mcpConfig;
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
