#!/usr/bin/env python3
"""
Telegram Bot for VS Code Copilot Command Approval

This bot receives command approval requests from VS Code and lets you
approve/reject them via Telegram inline buttons.
"""

import asyncio
import json
import os
import logging
from datetime import datetime
from typing import Dict, Optional
from dataclasses import dataclass, field

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)
from aiohttp import web

# Configure logging
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)


@dataclass
class PendingApproval:
    """Represents a pending command approval request."""
    request_id: str
    command: str
    explanation: str
    goal: str
    timestamp: datetime
    response_future: asyncio.Future = field(default_factory=asyncio.Future)


class ApprovalBot:
    """Telegram bot that handles command approval requests."""

    def __init__(self, token: str, chat_id: int, http_port: int = 8765):
        self.token = token
        self.chat_id = chat_id
        self.http_port = http_port
        self.pending_approvals: Dict[str, PendingApproval] = {}
        self.app: Optional[Application] = None
        self.web_app: Optional[web.Application] = None
        self.web_runner: Optional[web.AppRunner] = None

    async def start_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /start command."""
        message = update.message or update.effective_message
        if not message:
            return
        
        await message.reply_text(
            "🤖 *VS Code Copilot Approval Bot*\n\n"
            "I'll send you command approval requests from VS Code Copilot.\n"
            "You can approve or reject commands right from Telegram!\n\n"
            f"Your Chat ID: `{update.effective_chat.id}`\n\n"
            "Commands:\n"
            "/status - Show pending approvals\n"
            "/approveall - Approve all pending\n"
            "/rejectall - Reject all pending",
            parse_mode="Markdown",
        )

    async def status_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /status command - show pending approvals."""
        message = update.message or update.effective_message
        if not message:
            return
        
        if not self.pending_approvals:
            await message.reply_text("✅ No pending approvals")
            return

        text = f"📋 *{len(self.pending_approvals)} Pending Approval(s):*\n\n"
        for req_id, approval in self.pending_approvals.items():
            text += f"• `{approval.command[:50]}...`\n"
        
        await message.reply_text(text, parse_mode="Markdown")

    async def approve_all_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /approveall command."""
        message = update.message or update.effective_message
        if not message:
            return
        
        count = len(self.pending_approvals)
        for req_id in list(self.pending_approvals.keys()):
            await self._resolve_approval(req_id, True)
        await message.reply_text(f"✅ Approved {count} command(s)")

    async def reject_all_command(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /rejectall command."""
        message = update.message or update.effective_message
        if not message:
            return
        
        count = len(self.pending_approvals)
        for req_id in list(self.pending_approvals.keys()):
            await self._resolve_approval(req_id, False)
        await message.reply_text(f"❌ Rejected {count} command(s)")

    async def button_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle inline button presses."""
        query = update.callback_query
        await query.answer()

        data = query.data
        if not data:
            return

        parts = data.split(":", 1)
        if len(parts) != 2:
            return

        action, request_id = parts
        approved = action == "approve"

        if request_id in self.pending_approvals:
            approval = self.pending_approvals[request_id]
            await self._resolve_approval(request_id, approved)
            
            status = "✅ APPROVED" if approved else "❌ REJECTED"
            await query.edit_message_text(
                f"{status}\n\n"
                f"```\n{approval.command}\n```",
                parse_mode="Markdown",
            )
        else:
            await query.edit_message_text("⚠️ This approval request has expired.")

    async def _resolve_approval(self, request_id: str, approved: bool) -> None:
        """Resolve an approval request."""
        if request_id in self.pending_approvals:
            approval = self.pending_approvals.pop(request_id)
            if not approval.response_future.done():
                approval.response_future.set_result(approved)

    async def send_approval_request(
        self,
        request_id: str,
        command: str,
        explanation: str = "",
        goal: str = "",
    ) -> bool:
        """Send an approval request to Telegram and wait for response."""
        
        # Create keyboard with approve/reject buttons
        keyboard = [
            [
                InlineKeyboardButton("✅ Approve", callback_data=f"approve:{request_id}"),
                InlineKeyboardButton("❌ Reject", callback_data=f"reject:{request_id}"),
            ]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)

        # Format the message
        message = "🔐 *Command Approval Request*\n\n"
        
        if goal:
            message += f"📎 *Goal:* {goal}\n\n"
        
        if explanation:
            message += f"📝 *Explanation:* {explanation}\n\n"
        
        message += f"```bash\n{command}\n```"

        # Create pending approval
        approval = PendingApproval(
            request_id=request_id,
            command=command,
            explanation=explanation,
            goal=goal,
            timestamp=datetime.now(),
        )
        self.pending_approvals[request_id] = approval

        # Send message
        try:
            await self.app.bot.send_message(
                chat_id=self.chat_id,
                text=message,
                parse_mode="Markdown",
                reply_markup=reply_markup,
            )
        except Exception as e:
            logger.error(f"Failed to send Telegram message: {e}")
            self.pending_approvals.pop(request_id, None)
            return False

        # Wait for response with timeout
        try:
            result = await asyncio.wait_for(approval.response_future, timeout=300)  # 5 min timeout
            return result
        except asyncio.TimeoutError:
            logger.warning(f"Approval request {request_id} timed out")
            self.pending_approvals.pop(request_id, None)
            return False

    async def handle_http_request(self, request: web.Request) -> web.Response:
        """Handle HTTP approval requests from VS Code extension."""
        try:
            data = await request.json()
            
            request_id = data.get("requestId", str(datetime.now().timestamp()))
            command = data.get("command", "")
            explanation = data.get("explanation", "")
            goal = data.get("goal", "")

            if not command:
                return web.json_response({"error": "command is required"}, status=400)

            logger.info(f"Received approval request: {command[:50]}...")
            
            approved = await self.send_approval_request(
                request_id=request_id,
                command=command,
                explanation=explanation,
                goal=goal,
            )

            return web.json_response({
                "approved": approved,
                "requestId": request_id,
            })

        except json.JSONDecodeError:
            return web.json_response({"error": "Invalid JSON"}, status=400)
        except Exception as e:
            logger.error(f"Error handling request: {e}")
            return web.json_response({"error": str(e)}, status=500)

    async def health_check(self, request: web.Request) -> web.Response:
        """Health check endpoint."""
        return web.json_response({
            "status": "ok",
            "pending_approvals": len(self.pending_approvals),
        })

    async def start_http_server(self) -> None:
        """Start the HTTP server for receiving approval requests."""
        self.web_app = web.Application()
        self.web_app.router.add_post("/approve", self.handle_http_request)
        self.web_app.router.add_get("/health", self.health_check)

        self.web_runner = web.AppRunner(self.web_app)
        await self.web_runner.setup()
        
        site = web.TCPSite(self.web_runner, "localhost", self.http_port)
        await site.start()
        logger.info(f"HTTP server started on http://localhost:{self.http_port}")

    async def stop_http_server(self) -> None:
        """Stop the HTTP server."""
        if self.web_runner:
            await self.web_runner.cleanup()

    async def run(self) -> None:
        """Run the bot."""
        # Build the Telegram application
        self.app = Application.builder().token(self.token).build()

        # Add handlers
        self.app.add_handler(CommandHandler("start", self.start_command))
        self.app.add_handler(CommandHandler("status", self.status_command))
        self.app.add_handler(CommandHandler("approveall", self.approve_all_command))
        self.app.add_handler(CommandHandler("rejectall", self.reject_all_command))
        self.app.add_handler(CallbackQueryHandler(self.button_callback))

        # Initialize
        await self.app.initialize()
        await self.app.start()
        await self.app.updater.start_polling()

        # Start HTTP server
        await self.start_http_server()

        logger.info("Bot is running! Press Ctrl+C to stop.")
        
        # Keep running
        try:
            while True:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop_http_server()
            await self.app.updater.stop()
            await self.app.stop()
            await self.app.shutdown()


def main():
    """Main entry point."""
    # Load config from environment or config file
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    http_port = int(os.environ.get("APPROVAL_HTTP_PORT", "8765"))

    if not token or not chat_id:
        config_path = os.path.join(os.path.dirname(__file__), "config.json")
        if os.path.exists(config_path):
            with open(config_path) as f:
                config = json.load(f)
                token = token or config.get("telegram_bot_token")
                chat_id = chat_id or config.get("telegram_chat_id")
                http_port = config.get("http_port", http_port)

    if not token:
        print("Error: TELEGRAM_BOT_TOKEN not set")
        print("Set it via environment variable or in config.json")
        return 1

    if not chat_id:
        print("Error: TELEGRAM_CHAT_ID not set")
        print("Start the bot and send /start to get your chat ID")
        print("Then set it via environment variable or in config.json")
        # Still start the bot so user can get their chat ID
        chat_id = 0

    bot = ApprovalBot(token=token, chat_id=int(chat_id), http_port=http_port)
    
    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        logger.info("Extension by user")

    return 0


if __name__ == "__main__":
    exit(main())
