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

## Features

- **One-Click Setup**: Enter bot token and chat ID, click Start — that's it!
- **Local-First Approval**: VS Code notification first, Telegram fallback
- **Interactive Q&A**: Copilot can ask questions, you answer from VS Code or phone
- **Race Condition Friendly**: Approve from VS Code OR Telegram — first wins
- **Mobile Approval**: Approve or reject commands from anywhere
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

1. Click the **GateKeeper** sidebar icon (shield) or run `GateKeeper: Setup`
2. Paste your bot token and chat ID
3. Click **🚀 Start Approval Server**

**Done!** The extension will start the approval server automatically.

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

### Ask User Flow (Interactive Q&A)

Copilot can also ask questions and get responses:

```
ask_user(
  question: "Which database should I use?",
  options: ["PostgreSQL", "MySQL", "SQLite"],
  context: "Setting up backend"
)
```

- **VS Code**: Shows quick-pick with options + custom input
- **Telegram**: Shows buttons + "✏️ Type custom answer..." option
- **First response wins**: Answer from either channel

## Extension Commands

| Command | Description |
|---------|-------------|
| `GateKeeper: Setup` | **Main setup UI** - configure and start the server |
| `GateKeeper: Configure` | Quick settings menu |
| `GateKeeper: Test Connection` | Verify server is running |
| `GateKeeper: Run Command with Approval` | Run a command with manual approval |
| `GateKeeper: Manage Auto-Approve Patterns` | Add/remove safe patterns |
| `GateKeeper: Show Logs` | Open debug output |

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
| `gatekeeper.enabled` | Enable approval routing | `false` |
| `gatekeeper.serverUrl` | Server HTTP URL | `http://localhost:8765` |
| `gatekeeper.timeoutSeconds` | Total approval timeout | `300` |
| `gatekeeper.localApprovalDelay` | Seconds to wait for VS Code approval before Telegram | `10` |
| `gatekeeper.autoApprovePatterns` | Regex patterns for commands to auto-approve | `[]` |

Example auto-approve safe read-only commands:

```json
{
    "gatekeeper.autoApprovePatterns": [
        "^ls\\b",
        "^git status\\b",
        "^pwd$"
    ]
}
```

## Configure Copilot to Use GateKeeper

By default, Copilot uses its built-in terminal tool. To make Copilot always use GateKeeper for command approval, add custom instructions:

### Option 1: User-Level (All Workspaces)

Add a user instruction file that VS Code applies to every workspace. Enable prompt/instruction files first:

```json
// settings.json
"chat.promptFiles": true
```

Then create a file in your VS Code user profile (macOS path shown; use the equivalent `Code/User/prompts/` folder on Windows/Linux):

`~/Library/Application Support/Code/User/prompts/gatekeeper.instructions.md`

```markdown
---
applyTo: "**"
---

## Terminal Commands

Always use `mcp_gatekeeper_run_approved_command` for terminal commands instead of `run_in_terminal`.
This enables approval flow when the GateKeeper server is running, or executes directly when not.
```

Alternatively, set it in `settings.json`:

```json
"github.copilot.chat.codeGeneration.instructions": [
  { "text": "Always use `mcp_gatekeeper_run_approved_command` for terminal commands instead of `run_in_terminal`." }
]
```

### Option 2: Workspace-Level (Per Project)

Create `.github/copilot-instructions.md` in your project root:

```markdown
## Terminal Commands

Always use `mcp_gatekeeper_run_approved_command` for all shell commands.
```

### Smart Fallback

The `run_approved_command` tool automatically detects server status:
- **Server running** → Approval flow (VS Code notification → Telegram fallback)
- **Server not running** → Executes directly (like built-in terminal)

This means you can safely configure Copilot to always use GateKeeper — it gracefully degrades when the server is offline.

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
            "gatekeeper": {
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

- **Python 3.10+** installed and on `PATH` ([download here](https://www.python.org/downloads/)) — required by the bundled `mcp` package
- That's it — the extension bundles the bot and **auto-installs its Python dependencies** (`python-telegram-bot`, `aiohttp`, `mcp`) the first time you click **Start Approval Server**.

## Troubleshooting

### Server not starting?
1. Check `GateKeeper: Show Logs` for errors
2. Verify Python is installed and **3.10 or newer**: `python3 --version`
   - Older? Install a newer one: `brew install python@3.12` (macOS) or grab the installer from python.org
3. Ensure bot dependencies are installed

### Not receiving messages?
1. Verify your Chat ID is correct
2. Make sure you started a chat with your bot
3. Check the bot token is valid

## Links

- [Full Documentation](https://github.com/patelsan/gatekeeper)
- [Report Issues](https://github.com/patelsan/gatekeeper/issues)

## License

MIT
