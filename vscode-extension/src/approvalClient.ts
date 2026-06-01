import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

interface ApprovalResponse {
    approved: boolean;
    requestId: string;
}

interface HealthResponse {
    status: string;
    pending_approvals: number;
}

export interface PendingRequest {
    requestId: string;
    command: string;
    explanation: string;
    goal: string;
    timestamp: string;
}

// Logger function that will be set by extension.ts
let logger: ((message: string, level?: 'info' | 'warn' | 'error') => void) | undefined;

export function setLogger(fn: (message: string, level?: 'info' | 'warn' | 'error') => void) {
    logger = fn;
}

function log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    if (logger) {
        logger(message, level);
    }
}

export class ApprovalClient {
    private serverUrl: string = 'http://localhost:8765';
    private timeoutSeconds: number = 300;

    constructor() {
        this.updateConfig();
    }

    updateConfig() {
        const config = vscode.workspace.getConfiguration('gatekeeper');
        this.serverUrl = config.get<string>('serverUrl') || 'http://localhost:8765';
        this.timeoutSeconds = config.get<number>('timeoutSeconds') || 300;
    }

    private async fetch(
        path: string,
        options: {
            method?: string;
            body?: string;
            timeout?: number;
        } = {}
    ): Promise<{ ok: boolean; data?: any; error?: string }> {
        return new Promise((resolve) => {
            const url = new URL(path, this.serverUrl);
            const isHttps = url.protocol === 'https:';
            const lib = isHttps ? https : http;

            const req = lib.request(
                url,
                {
                    method: options.method || 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    timeout: (options.timeout || this.timeoutSeconds) * 1000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            resolve({
                                ok: res.statusCode === 200,
                                data: parsed,
                            });
                        } catch {
                            resolve({
                                ok: false,
                                error: `Invalid JSON response: ${data}`,
                            });
                        }
                    });
                }
            );

            req.on('error', (e) => {
                log(`Request error: ${e.message}`, 'error');
                resolve({
                    ok: false,
                    error: e.message,
                });
            });

            req.on('timeout', () => {
                log('Request timed out', 'warn');
                req.destroy();
                resolve({
                    ok: false,
                    error: 'Request timed out',
                });
            });

            if (options.body) {
                req.write(options.body);
            }

            req.end();
        });
    }

    async testConnection(): Promise<{
        success: boolean;
        pendingApprovals?: number;
        error?: string;
    }> {
        const result = await this.fetch('/health', { timeout: 5 });

        if (result.ok && result.data) {
            const health = result.data as HealthResponse;
            return {
                success: true,
                pendingApprovals: health.pending_approvals,
            };
        }

        return {
            success: false,
            error: result.error || 'Unknown error',
        };
    }

    async requestApproval(
        command: string,
        options?: {
            explanation?: string;
            goal?: string;
            timeout?: number;
        }
    ): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('telegramApproval');
        
        if (!config.get<boolean>('enabled')) {
            // If disabled, auto-approve
            return true;
        }

        // Check auto-approve patterns
        const patterns = config.get<string[]>('autoApprovePatterns') || [];
        for (const pattern of patterns) {
            try {
                if (new RegExp(pattern).test(command)) {
                    log(`Command auto-approved by pattern: ${pattern}`);
                    return true;
                }
            } catch {
                log(`Invalid regex pattern: ${pattern}`, 'warn');
            }
        }

        // Generate request ID
        const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        log(`Requesting approval for command: ${command.substring(0, 100)}... [${requestId}]`);

        // Show notification that approval is pending
        const statusMessage = vscode.window.setStatusBarMessage(
            '$(sync~spin) Waiting for Telegram approval...'
        );

        try {
            const result = await this.fetch('/approve', {
                method: 'POST',
                body: JSON.stringify({
                    requestId,
                    command,
                    explanation: options?.explanation || '',
                    goal: options?.goal || '',
                }),
                timeout: options?.timeout || this.timeoutSeconds,
            });

            if (result.ok && result.data) {
                const response = result.data as ApprovalResponse;
                
                if (response.approved) {
                    log(`Command approved via Telegram [${requestId}]`);
                    vscode.window.showInformationMessage('✅ Command approved via Telegram');
                } else {
                    log(`Command rejected via Telegram [${requestId}]`, 'warn');
                    vscode.window.showWarningMessage('❌ Command rejected via Telegram');
                }
                
                return response.approved;
            }

            // Server error or timeout - show error and let user decide
            log(`Approval failed: ${result.error} [${requestId}]`, 'error');
            const action = await vscode.window.showWarningMessage(
                `Telegram approval failed: ${result.error}`,
                'Run Anyway',
                'Cancel'
            );

            return action === 'Run Anyway';

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            log(`Approval error: ${errorMessage} [${requestId}]`, 'error');
            
            const action = await vscode.window.showWarningMessage(
                `Telegram approval error: ${errorMessage}`,
                'Run Anyway',
                'Cancel'
            );

            return action === 'Run Anyway';
        } finally {
            statusMessage.dispose();
        }
    }

    async getPending(): Promise<PendingRequest[]> {
        const result = await this.fetch('/api/pending', { timeout: 5 });
        if (result.ok && result.data) {
            return result.data.pending || [];
        }
        return [];
    }

    async localApprove(requestId: string): Promise<boolean> {
        log(`Approving request locally: ${requestId}`);
        const result = await this.fetch(`/api/approve/${requestId}`, {
            method: 'POST',
            timeout: 5,
        });
        return result.ok;
    }

    async localReject(requestId: string): Promise<boolean> {
        log(`Rejecting request locally: ${requestId}`);
        const result = await this.fetch(`/api/reject/${requestId}`, {
            method: 'POST',
            timeout: 5,
        });
        return result.ok;
    }
}
