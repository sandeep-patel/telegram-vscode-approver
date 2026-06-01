# Telegram Command Approval for VS Code Copilot

Approve VS Code Copilot terminal commands from your phone via Telegram! 📱✅

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

## Quick Start

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy your bot token (looks like `123456789:ABCdefGHI...`)

### 2. Install Dependencies

```bash
cd telegram-approval
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Configure the Bot

```bash
# Copy the example config
cp config.json.example config.json

# Edit config.json with your bot token
```

Or use environment variables:
```bash
export TELEGRAM_BOT_TOKEN="your-token-here"
```

### 4. Get Your Chat ID

```bash
# Start the bot (make sure venv is activated)
source .venv/bin/activate
python bot.py
```

Then in Telegram:
1. Start a chat with your bot
2. Send `/start`
3. Copy your Chat ID from the response
4. Add it to `config.json` or set `TELEGRAM_CHAT_ID`

### 5. Start the Bot

```bash
python bot.py
```

The bot will:
- Listen for Telegram commands on your bot
- Run an HTTP server on `localhost:8765` for approval requests

## Integration Options

### Which Should I Use?

| Use Case | Recommended |
|----------|-------------|
| **Copilot Agent Mode** | MCP Server (Option A) |
| **Manual approval UI** | VS Code Extension (Option B) |
| **Custom tooling** | HTTP API (Option C) |
| **All features** | MCP + Extension together |

### Option A: MCP Server (Recommended) 🌟

Add the MCP server to your VS Code settings for Copilot to use:

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

**Note:** Use the full path to the venv Python to ensure dependencies are available.

Now Copilot can use the `run_approved_command` tool!

### Option B: VS Code Extension

Build and install the VS Code extension for:
- **Status bar monitoring** - See connection status and pending approvals
- **Configuration UI** - Easy setup via command palette
- **Manual approval** - Run specific commands with approval
- **Bot management** - Start the bot directly from VS Code
- **Auto-approve patterns** - Whitelist safe commands

```bash
cd vscode-extension
npm install
npm run compile
npx vsce package  # Creates .vsix file
```

Install via: `code --install-extension telegram-command-approval-*.vsix`

**Extension Commands:**
| Command | Description |
|---------|-------------|
| `Telegram Approval: Configure` | Open settings |
| `Telegram Approval: Test Connection` | Verify bot status |
| `Telegram Approval: Start Bot` | Start Python bot |
| `Telegram Approval: Run Command with Approval` | Manual approval |
| `Telegram Approval: Manage Auto-Approve Patterns` | Pattern UI |
| `Telegram Approval: Show Logs` | Debug output |

**Extension Settings:**
```json
{
    "telegramApproval.enabled": true,
    "telegramApproval.serverUrl": "http://localhost:8765",
    "telegramApproval.timeoutSeconds": 300,
    "telegramApproval.autoApprovePatterns": ["^(ls|pwd|cat)\\b"],
    "telegramApproval.botPath": "/path/to/telegram-approval"
}
```

**API for Other Extensions:**
```typescript
import { requestApproval } from 'telegram-command-approval';

const approved = await requestApproval('npm install', {
    explanation: 'Install dependencies',
    goal: 'Project setup'
});
```

### Option C: Direct HTTP Integration

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

Response:
```json
{
    "approved": true,
    "requestId": "abc123"
}
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and your Chat ID |
| `/status` | List pending approval requests |
| `/approveall` | Approve all pending commands |
| `/rejectall` | Reject all pending commands |

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Your bot token from BotFather | Required |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Required |
| `APPROVAL_HTTP_PORT` | HTTP server port | `8765` |

### config.json

```json
{
    "telegram_bot_token": "YOUR_TOKEN",
    "telegram_chat_id": 123456789,
    "http_port": 8765
}
```

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.telegram-approval.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.telegram-approval</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/telegram-approval/.venv/bin/python</string>
        <string>/path/to/telegram-approval/bot.py</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>your-token</string>
        <key>TELEGRAM_CHAT_ID</key>
        <string>your-chat-id</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.telegram-approval.plist
```

### Docker

```bash
docker-compose up -d
```

## Security Notes

⚠️ **Important Security Considerations:**

1. **Local Only**: The HTTP server only listens on `localhost` by default
2. **Bot Token**: Keep your bot token secret - don't commit it to git
3. **Chat ID Restriction**: The bot only accepts commands from your Chat ID
4. **Timeout**: Commands automatically reject after 5 minutes of no response

## Troubleshooting

### Bot not responding?

1. Check if the bot is running: `ps aux | grep bot.py`
2. Test the health endpoint: `curl http://localhost:8765/health`
3. Check logs for errors

### Commands not appearing in Telegram?

1. Verify your Chat ID is correct
2. Make sure you started a chat with your bot
3. Check network connectivity

### MCP tool not appearing?

1. Reload VS Code window
2. Check MCP server configuration in settings
3. Verify Python path is correct

## Architecture

```
telegram-approval/
├── bot.py                    # Main Telegram bot + HTTP server
├── approval_mcp_server.py    # MCP server for VS Code integration
├── config.json               # Bot configuration
├── requirements.txt          # Python dependencies
├── vscode-extension/         # Optional VS Code extension
│   ├── src/
│   │   ├── extension.ts
│   │   ├── approvalClient.ts
│   │   └── commandInterceptor.ts
│   └── package.json
└── README.md
```

## License

MIT
