import * as vscode from 'vscode';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gatekeeper.mainView';
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    
    private isRunning: boolean = false;
    private isConnected: boolean = false;
    private pendingCount: number = 0;
    private hasToken: boolean = false;
    private isStarting: boolean = false;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'openSetup':
                    vscode.commands.executeCommand('gatekeeper.setup');
                    break;
                case 'startBot':
                    vscode.commands.executeCommand('gatekeeper.startBot');
                    break;
                case 'testConnection':
                    vscode.commands.executeCommand('gatekeeper.testConnection');
                    break;
                case 'showLogs':
                    vscode.commands.executeCommand('gatekeeper.showLogs');
                    break;
                case 'runWithApproval':
                    vscode.commands.executeCommand('gatekeeper.runWithApproval');
                    break;
                case 'managePatterns':
                    vscode.commands.executeCommand('gatekeeper.managePatterns');
                    break;
                case 'getStatus':
                    this._sendStatus();
                    break;
            }
        });

        // Send initial status
        setTimeout(() => this._sendStatus(), 100);
    }

    public updateStatus(connected: boolean, pending: number, running: boolean, hasToken: boolean, starting: boolean = false) {
        this.isConnected = connected;
        this.pendingCount = pending;
        this.isRunning = running;
        this.hasToken = hasToken;
        this.isStarting = starting;
        this._sendStatus();
    }

    private _sendStatus() {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'status',
                isConnected: this.isConnected,
                pendingCount: this.pendingCount,
                isRunning: this.isRunning,
                hasToken: this.hasToken,
                isStarting: this.isStarting,
            });
        }
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GateKeeper</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 12px;
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
        }
        h2 {
            font-size: 14px;
            margin: 0 0 12px 0;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .status-card {
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 16px;
        }
        .status-running {
            background: rgba(76, 175, 80, 0.15);
            border: 1px solid rgba(76, 175, 80, 0.3);
        }
        .status-stopped {
            background: rgba(255, 152, 0, 0.15);
            border: 1px solid rgba(255, 152, 0, 0.3);
        }
        .status-starting {
            background: rgba(255, 152, 0, 0.15);
            border: 1px solid rgba(255, 152, 0, 0.3);
        }
        .status-notconfigured {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-input-border);
        }
        .status-icon {
            font-size: 18px;
            margin-right: 8px;
        }
        .status-title {
            font-weight: 600;
            font-size: 13px;
        }
        .status-subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }
        .pending-badge {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            margin-left: 8px;
        }
        .actions {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        button {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 8px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            text-align: left;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            transition: background 0.15s;
        }
        button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .divider {
            height: 1px;
            background: var(--vscode-input-border);
            margin: 12px 0;
        }
        .section-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div id="status-card" class="status-card status-notconfigured">
        <span class="status-icon">⚪</span>
        <span class="status-title">Loading...</span>
    </div>

    <div class="actions">
        <button id="setup-btn" class="primary" onclick="send('openSetup')">
            ⚙️ Setup / Configure
        </button>
    </div>

    <div class="divider"></div>
    
    <div class="section-title">Quick Actions</div>
    <div class="actions">
        <button onclick="send('runWithApproval')">
            ▶️ Run Command with Approval
        </button>
        <button onclick="send('testConnection')">
            🔌 Test Connection
        </button>
        <button onclick="send('managePatterns')">
            📝 Manage Auto-Approve Patterns
        </button>
        <button onclick="send('showLogs')">
            📋 Show Logs
        </button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        function send(command) {
            vscode.postMessage({ command });
        }

        function updateUI(status) {
            const card = document.getElementById('status-card');
            const setupBtn = document.getElementById('setup-btn');
            
            let icon, title, subtitle, cardClass;
            
            if (status.isStarting) {
                icon = '🟠';
                title = 'Starting...';
                subtitle = 'Please wait while the server starts';
                cardClass = 'status-starting';
                setupBtn.textContent = '⏳ Starting...';
                setupBtn.disabled = true;
            } else if (status.isRunning || status.isConnected) {
                icon = '🟢';
                title = 'Server Running';
                subtitle = status.pendingCount > 0 
                    ? status.pendingCount + ' pending approval(s)' 
                    : 'Ready for approvals';
                cardClass = 'status-running';
                setupBtn.textContent = '⚙️ Configure';
                setupBtn.disabled = false;
            } else if (status.hasToken) {
                icon = '🟡';
                title = 'Server Stopped';
                subtitle = 'Click Setup to start';
                cardClass = 'status-stopped';
                setupBtn.textContent = '🚀 Start Server';
                setupBtn.disabled = false;
            } else {
                icon = '⚪';
                title = 'Not Configured';
                subtitle = 'Set up your Telegram bot';
                cardClass = 'status-notconfigured';
                setupBtn.textContent = '⚙️ Setup';
                setupBtn.disabled = false;
            }
            
            card.className = 'status-card ' + cardClass;
            card.innerHTML = \`
                <div style="display:flex;align-items:center;">
                    <span class="status-icon">\${icon}</span>
                    <span class="status-title">\${title}</span>
                    \${status.pendingCount > 0 ? '<span class="pending-badge">' + status.pendingCount + '</span>' : ''}
                </div>
                <div class="status-subtitle">\${subtitle}</div>
            \`;
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'status') {
                updateUI(message);
            }
        });

        // Request initial status
        send('getStatus');
    </script>
</body>
</html>`;
    }
}
