import * as vscode from 'vscode';

export class StatusTreeProvider implements vscode.TreeDataProvider<StatusItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StatusItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private isConnected: boolean = false;
    private pendingCount: number = 0;
    private isRunning: boolean = false;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    updateStatus(connected: boolean, pending: number, running: boolean): void {
        this.isConnected = connected;
        this.pendingCount = pending;
        this.isRunning = running;
        this.refresh();
    }

    getTreeItem(element: StatusItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: StatusItem): StatusItem[] {
        if (element) {
            return [];
        }

        const items: StatusItem[] = [];

        // Server status
        if (this.isRunning) {
            items.push(new StatusItem(
                'Server: Running',
                this.isConnected ? '🟢 Connected' : '🟡 Starting...',
                vscode.TreeItemCollapsibleState.None,
                'telegramApproval.testConnection'
            ));
        } else {
            items.push(new StatusItem(
                'Server: Stopped',
                '⚪ Not running',
                vscode.TreeItemCollapsibleState.None,
                'telegramApproval.setup'
            ));
        }

        // Pending approvals
        items.push(new StatusItem(
            `Pending Approvals: ${this.pendingCount}`,
            this.pendingCount > 0 ? '⏳ Waiting for response' : '✅ None',
            vscode.TreeItemCollapsibleState.None
        ));

        return items;
    }
}

export class ActionsTreeProvider implements vscode.TreeDataProvider<ActionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActionItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ActionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ActionItem): ActionItem[] {
        if (element) {
            return [];
        }

        return [
            new ActionItem(
                '$(gear) Setup / Configure',
                'Open setup panel',
                'telegramApproval.setup'
            ),
            new ActionItem(
                '$(play) Start Server',
                'Start the approval bot',
                'telegramApproval.startBot'
            ),
            new ActionItem(
                '$(terminal) Run with Approval',
                'Run a command with approval',
                'telegramApproval.runWithApproval'
            ),
            new ActionItem(
                '$(checklist) Manage Patterns',
                'Auto-approve patterns',
                'telegramApproval.managePatterns'
            ),
            new ActionItem(
                '$(plug) Test Connection',
                'Test server connection',
                'telegramApproval.testConnection'
            ),
            new ActionItem(
                '$(output) Show Logs',
                'View debug logs',
                'telegramApproval.showLogs'
            ),
        ];
    }
}

class StatusItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly description: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        commandId?: string
    ) {
        super(label, collapsibleState);
        this.description = description;
        if (commandId) {
            this.command = {
                command: commandId,
                title: label,
            };
        }
    }
}

class ActionItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly tooltip: string,
        commandId: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.tooltip = tooltip;
        this.command = {
            command: commandId,
            title: label,
        };
    }
}
