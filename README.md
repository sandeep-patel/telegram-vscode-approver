# GateKeeper - Remote Command Approval

Approve VS Code Copilot terminal commands from your phone! 📱✅

## Supported Channels

| Channel | Status |
|---------|--------|
| 📱 **Telegram** | ✅ Available |
| 💬 Slack | 🔜 Coming Soon |
| 💚 WhatsApp | 🔜 Coming Soon |
| 🎮 Discord | 🔜 Coming Soon |
| 📧 Email | 🔜 Coming Soon |
| 📲 SMS (Twilio) | 🔜 Coming Soon |
| 🔔 Pushover | 🔜 Coming Soon |
| 📨 Microsoft Teams | 🔜 Coming Soon |
| 🔗 Webhook (Custom) | 🔜 Coming Soon |

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  VS Code        │────▶│  GateKeeper      │────▶│  VS Code    │
│  Copilot        │     │  Server          │     │  Notification
│                 │     │                  │     │  (Local)    │
│                 │     │                  │     └──────┬──────┘
│                 │     │                  │            │
│                 │     │                  │     ┌──────▼──────┐
│                 │◀────│                  │◀────│  Telegram   │
└─────────────────┘     └──────────────────┘     │  (Fallback) │
                                                 └─────────────┘
```

### Local-First Approval Flow

1. Copilot wants to run a command
2. **VS Code notification appears immediately** with ✅ Approve / ❌ Reject
3. If no response within `localApprovalDelay` seconds (default: 10s)...
4. Command **escalates to Telegram**
5. Either channel can approve — **first response wins**

## Quick Start (Recommended) 🌟

The VS Code extension provides a simple setup UI — no manual configuration needed!

### 1. Create a Telegram Bot (1 minute)

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy your bot token

### 2. Install the Extension

```bash
cd gatekeeper/vscode-extension
npm install && npm run compile
npx vsce package
code --install-extension gatekeeper-remote-approval-*.vsix
```

### 3. Install Bot Dependencies

```bash
cd gatekeeper
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Configure via Extension UI

1. Click **GateKeeper** in the VS Code sidebar (shield icon)
2. Enter your bot token and chat ID
3. Click **🚀 Start Approval Server**

**Done!** The extension handles everything else.

---

## Alternative Setup Options

### Option A: Manual Bot Configuration

If you prefer manual setup:

```bash
# Configure the bot
cp config.json.example config.json
# Edit config.json with your bot token and chat ID

# Start the bot
python bot.py
```

### Option B: MCP Server Integration

For deeper Copilot agent integration, add the MCP server:

**`~/.vscode/settings.json`:**
```json
{
    "mcp": {
        "servers": {
            "gatekeeper": {
                "type": "stdio",
                "command": "/path/to/gatekeeper/.venv/bin/python",
                "args": ["/path/to/gatekeeper/approval_mcp_server.py"]
            }
        }
    }
}
```

This provides the `run_approved_command` tool for Copilot.

### Option C: Direct HTTP API

Any tool can request approval:

```bash
curl -X POST http://localhost:8765/approve \
  -H "Content-Type: application/json" \
  -d '{"command": "npm install", "explanation": "Install deps"}'
```

Response: `{"approved": true, "requestId": "..."}`

---

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
| `LOCAL_APPROVAL_DELAY` | Seconds to wait for VS Code approval before Telegram | `10` |

### config.json (Alternative)

```json
{
    "telegram_bot_token": "YOUR_TOKEN",
    "telegram_chat_id": 123456789,
    "http_port": 8765,
    "local_approval_delay": 10
}
```

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.gatekeeper.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.gatekeeper</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/.venv/bin/python</string>
        <string>/path/to/bot.py</string>
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

### Docker

```bash
docker-compose up -d
```

## Security

- HTTP server runs on localhost only
- Bot only accepts commands from your Chat ID  
- Bot token stored securely in VS Code secret storage (extension)
- Commands auto-reject after 5 minutes

## Architecture

```
gatekeeper/
├── bot.py                    # Telegram channel + HTTP server
├── approval_mcp_server.py    # MCP server for Copilot
├── config.json               # Bot configuration
├── requirements.txt          # Python dependencies
├── vscode-extension/         # VS Code extension
│   ├── src/
│   │   ├── extension.ts      # Main extension
│   │   ├── setupPanel.ts     # Setup UI
│   │   ├── approvalClient.ts # HTTP client
│   │   └── commandInterceptor.ts
│   └── package.json
└── README.md
```

## License

MIT
└── README.md
```

## License

MIT
