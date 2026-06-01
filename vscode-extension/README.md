# Telegram Command Approval

Approve VS Code Copilot terminal commands from your phone via Telegram! 📱✅

## Features

- **One-Click Setup**: Enter bot token and chat ID, click Start — that's it!
- **Mobile Approval**: Approve or reject commands from anywhere via Telegram
- **Real-time Notifications**: Get instant alerts when Copilot wants to run a command
- **Quick Actions**: Approve all or reject all pending commands
- **Timeout Protection**: Commands auto-reject after 5 minutes of no response
- **Auto-Approve Patterns**: Define regex patterns for safe commands
- **Health Monitoring**: Status bar shows connection status and pending count

## Quick Start (2 Minutes)

### 1. Create a Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy your bot token (looks like `123456789:ABCdefGHI...`)

### 2. Get Your Chat ID

1. Start a chat with your new bot
2. Send `/start`
3. Copy the Chat ID from the response

### 3. Configure the Extension

1. Click the **TG Approval** status bar item (or run `Telegram Approval: Setup`)
2. Paste your bot token and chat ID
3. Click **🚀 Start Approval Server**

**Done!** The extension will start the approval server automatically.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VS Code        │────▶│  Built-in Bot    │────▶│  Telegram   │
│  Copilot        │     │  Server          │     │  App        │
│                 │◀────│                  │◀────│  (Phone)    │
└─────────────────┘     └──────────────────┘     └─────────────┘
```

1. Copilot wants to run a command
2. Command is sent to your Telegram
3. You tap ✅ Approve or ❌ Reject
4. VS Code continues or cancels

## Extension Commands

| Command | Description |
|---------|-------------|
| `Telegram Approval: Setup` | **Main setup UI** - configure and start the server |
| `Telegram Approval: Configure` | Quick settings menu |
| `Telegram Approval: Test Connection` | Verify bot is running |
| `Telegram Approval: Run Command with Approval` | Run a command with manual approval |
| `Telegram Approval: Manage Auto-Approve Patterns` | Add/remove safe patterns |
| `Telegram Approval: Show Logs` | Open debug output |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and Chat ID |
| `/status` | List pending approvals |
| `/approveall` | Approve all pending |
| `/rejectall` | Reject all pending |

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `telegramApproval.enabled` | Enable approval routing | `false` |
| `telegramApproval.serverUrl` | Bot HTTP server URL | `http://localhost:8765` |
| `telegramApproval.timeoutSeconds` | Approval timeout | `300` |
| `telegramApproval.autoApprovePatterns` | Regex patterns to auto-approve | `[]` |
| `telegramApproval.httpPort` | HTTP server port | `8765` |

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
- 🟢 **Running**: Server is active and connected
- 🟡 **Configured**: Server stopped, click to start
- ⚪ **Not configured**: Click to set up
- **(N pending)**: Number of pending approvals

## Advanced: MCP Server Integration

For deeper Copilot integration, you can also use the MCP server. Add to your VS Code settings:

```json
{
    "mcp": {
        "servers": {
            "telegram-approval": {
                "type": "stdio",
                "command": "/path/to/.venv/bin/python",
                "args": ["/path/to/approval_mcp_server.py"]
            }
        }
    }
}
```

This provides the `run_approved_command` tool for Copilot agent mode.

## Security

- HTTP server runs on localhost only
- Bot only accepts commands from your Chat ID
- Bot token stored securely in VS Code's secret storage
- Commands timeout after 5 minutes

## Requirements

- **Python 3.8+** with the telegram-approval bot package
- Clone the repo: `git clone https://github.com/patelsan/telegram-approval`
- Install deps: `cd telegram-approval && pip install -r requirements.txt`

## Troubleshooting

### Server not starting?
1. Check `Telegram Approval: Show Logs` for errors
2. Verify Python is installed: `python3 --version`
3. Ensure bot dependencies are installed

### Not receiving Telegram messages?
1. Verify your Chat ID is correct
2. Make sure you started a chat with your bot
3. Check the bot token is valid

## Links

- [Full Documentation](https://github.com/patelsan/telegram-approval)
- [Report Issues](https://github.com/patelsan/telegram-approval/issues)

## License

MIT
