# Telegram Command Approval

Approve VS Code Copilot terminal commands from your phone via Telegram! 📱✅

## Features

- **Mobile Approval**: Approve or reject commands from anywhere via Telegram
- **Real-time Notifications**: Get instant alerts when Copilot wants to run a command
- **Quick Actions**: Approve all or reject all pending commands
- **Timeout Protection**: Commands auto-reject after 5 minutes of no response
- **Auto-Approve Patterns**: Define regex patterns for safe commands
- **Health Monitoring**: Status bar shows connection status and pending count
- **Output Logging**: Full debug logs available via command palette

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VS Code        │────▶│  Telegram Bot    │────▶│  Telegram   │
│  Copilot        │     │  (Python)        │     │  App        │
│                 │◀────│                  │◀────│  (Phone)    │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

1. Copilot wants to run a command
2. Command is sent to your Telegram
3. You tap ✅ Approve or ❌ Reject
4. VS Code continues or cancels

## Integration Options

### Option 1: MCP Server (Recommended) 🌟

The MCP server integrates directly with Copilot's agent mode. Add to your VS Code settings:

**`~/.vscode/settings.json`:**
```json
{
    "mcp": {
        "servers": {
            "telegram-approval": {
                "type": "stdio",
                "command": "/path/to/telegram-approval/.venv/bin/python",
                "args": ["/path/to/telegram-approval/approval_mcp_server.py"],
                "env": {
                    "TELEGRAM_APPROVAL_URL": "http://localhost:8765"
                }
            }
        }
    }
}
```

**MCP Tools Available:**
- `run_approved_command` - Run a command after Telegram approval
- `check_approval_server` - Verify bot is running

### Option 2: VS Code Extension

Use this extension for:
- **Manual command approval**: Run `Telegram Approval: Run Command with Approval`
- **Status monitoring**: See connection status in status bar
- **Configuration UI**: Easy setup via command palette
- **Bot management**: Start the bot directly from VS Code

### Option 3: Direct HTTP API

Any tool can request approval via HTTP:

```bash
curl -X POST http://localhost:8765/approve \
  -H "Content-Type: application/json" \
  -d '{
    "command": "rm -rf node_modules",
    "explanation": "Clean node_modules",
    "goal": "Fresh dependency install"
  }'
```

### Option 4: Extension API

Other extensions can import the approval function:

```typescript
import { requestApproval } from 'telegram-command-approval';

const approved = await requestApproval('npm install', {
    explanation: 'Install dependencies',
    goal: 'Project setup'
});

if (approved) {
    // Run the command
}
```

## Requirements

1. **Telegram Bot** - Create one via [@BotFather](https://t.me/BotFather)
2. **Python Bot Server** - Run the companion bot server

## Setup

### 1. Install the Bot Server

```bash
git clone https://github.com/patelsan/telegram-approval
cd telegram-approval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure

```bash
cp config.json.example config.json
# Edit config.json with your bot token and chat ID
```

### 3. Run the Bot

```bash
python bot.py
```

Or use `Telegram Approval: Start Bot` from the command palette.

### 4. Configure Extension

1. Open VS Code Settings
2. Search for "Telegram Approval"
3. Enable and set the server URL (default: `http://localhost:8765`)

## Extension Commands

| Command | Description |
|---------|-------------|
| `Telegram Approval: Configure` | Open settings quick pick |
| `Telegram Approval: Test Connection` | Verify bot is running |
| `Telegram Approval: Enable` | Turn on approval routing |
| `Telegram Approval: Disable` | Turn off approval routing |
| `Telegram Approval: Show Logs` | Open output channel |
| `Telegram Approval: Start Bot` | Start the Python bot |
| `Telegram Approval: Run Command with Approval` | Run a command with approval |
| `Telegram Approval: Manage Auto-Approve Patterns` | Add/remove safe patterns |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and Chat ID |
| `/status` | List pending approvals |
| `/approveall` | Approve all pending |
| `/rejectall` | Reject all pending |

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `telegramApproval.enabled` | Enable approval routing | `false` |
| `telegramApproval.serverUrl` | Bot HTTP server URL | `http://localhost:8765` |
| `telegramApproval.timeoutSeconds` | Approval timeout | `300` |
| `telegramApproval.autoApprovePatterns` | Regex patterns to auto-approve | `[]` |
| `telegramApproval.botPath` | Path to bot directory | `""` |
| `telegramApproval.mcpEnabled` | Use MCP server integration | `true` |

## Auto-Approve Patterns

Add regex patterns for commands that should auto-approve:

```json
{
    "telegramApproval.autoApprovePatterns": [
        "^(ls|pwd|cat|echo)\\b",
        "^git (status|log|diff)",
        "^npm (list|outdated)"
    ]
}
```

## Status Bar

The status bar shows:
- 🔔 **Connected**: Server is reachable
- ⚠️ **Disconnected**: Cannot reach server
- 🔕 **Disabled**: Extension is disabled
- **(N pending)**: Number of pending approvals

Click to open configuration.

## Security

- HTTP server runs on localhost only
- Bot only accepts commands from your Chat ID
- Commands timeout after 5 minutes
- Auto-approve patterns let you whitelist safe commands

## Troubleshooting

### Bot not responding?
1. Run `Telegram Approval: Test Connection`
2. Check `Telegram Approval: Show Logs`
3. Verify bot is running: `ps aux | grep bot.py`

### MCP tool not appearing?
1. Reload VS Code window
2. Check MCP server path in settings
3. Verify Python venv path

## Links

- [Full Documentation](https://github.com/patelsan/telegram-approval)
- [Report Issues](https://github.com/patelsan/telegram-approval/issues)

## License

MIT
