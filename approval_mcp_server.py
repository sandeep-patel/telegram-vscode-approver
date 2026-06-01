#!/usr/bin/env python3
"""
MCP Server for GateKeeper - Remote Command Approval

This MCP server provides a tool that routes command execution through
remote approval (currently Telegram) before running.

Add to your VS Code settings.json:
{
    "mcp.servers": {
        "gatekeeper": {
            "type": "stdio",
            "command": "python",
            "args": ["/path/to/approval_mcp_server.py"]
        }
    }
}
"""

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime
from typing import Any

import aiohttp
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

# Configuration
APPROVAL_SERVER_URL = os.environ.get("GATEKEEPER_URL", "http://localhost:8765")
DEFAULT_TIMEOUT = int(os.environ.get("GATEKEEPER_TIMEOUT", "300"))

server = Server("gatekeeper")


async def is_server_running() -> bool:
    """Check if the approval server is running (quick health check)."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{APPROVAL_SERVER_URL}/health",
                timeout=aiohttp.ClientTimeout(total=2),  # Quick 2 second timeout
            ) as response:
                return response.status == 200
    except:
        return False


async def request_approval(
    command: str,
    explanation: str = "",
    goal: str = "",
    timeout: int = DEFAULT_TIMEOUT,
) -> bool:
    """Request approval from GateKeeper server."""
    request_id = f"{datetime.now().timestamp()}-{os.getpid()}"
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{APPROVAL_SERVER_URL}/approve",
                json={
                    "requestId": request_id,
                    "command": command,
                    "explanation": explanation,
                    "goal": goal,
                },
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as response:
                if response.status == 200:
                    data = await response.json()
                    return data.get("approved", False)
                else:
                    # Server error - default to reject
                    return False
    except asyncio.TimeoutError:
        return False
    except aiohttp.ClientError as e:
        # Connection error - check if server is running
        print(f"Connection error: {e}", file=sys.stderr)
        return False


async def run_command(
    command: str,
    cwd: str | None = None,
    timeout: int = 60,
) -> tuple[int, str, str]:
    """Run a shell command and return exit code, stdout, stderr."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout
        )
        
        return (
            proc.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "", "Command timed out"
    except Exception as e:
        return -1, "", str(e)


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="run_approved_command",
            description=(
                "Run a shell command with smart approval routing. "
                "If GateKeeper server is running → sends to phone for approval. "
                "If server is not running → executes directly (no approval needed). "
                "Use this for all terminal commands to enable remote approval when desired."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to run",
                    },
                    "explanation": {
                        "type": "string",
                        "description": "Brief explanation of what this command does",
                    },
                    "goal": {
                        "type": "string",
                        "description": "The goal this command achieves",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory for the command",
                    },
                    "approval_timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds for approval (default: 300)",
                        "default": 300,
                    },
                    "command_timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds for command execution (default: 60)",
                        "default": 60,
                    },
                },
                "required": ["command"],
            },
        ),
        Tool(
            name="check_approval_server",
            description="Check if the GateKeeper approval server is running and healthy",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """Handle tool calls."""
    
    if name == "check_approval_server":
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{APPROVAL_SERVER_URL}/health",
                    timeout=aiohttp.ClientTimeout(total=5),
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        return [TextContent(
                            type="text",
                            text=f"✅ Server is healthy\nPending approvals: {data.get('pending_approvals', 0)}",
                        )]
                    else:
                        return [TextContent(
                            type="text",
                            text=f"❌ Server returned status {response.status}",
                        )]
        except Exception as e:
            return [TextContent(
                type="text",
                text=f"❌ Cannot connect to approval server: {e}\n\nMake sure the server is running:\n  cd gatekeeper && python bot.py",
            )]

    elif name == "run_approved_command":
        command = arguments.get("command", "")
        explanation = arguments.get("explanation", "")
        goal = arguments.get("goal", "")
        cwd = arguments.get("cwd")
        approval_timeout = arguments.get("approval_timeout", DEFAULT_TIMEOUT)
        command_timeout = arguments.get("command_timeout", 60)

        if not command:
            return [TextContent(
                type="text",
                text="Error: command is required",
            )]

        # Check if server is running
        server_running = await is_server_running()
        
        if not server_running:
            # Server not running - execute directly without approval
            exit_code, stdout, stderr = await run_command(
                command=command,
                cwd=cwd,
                timeout=command_timeout,
            )
            
            output_parts = [f"⚡ Command executed directly (GateKeeper server not running, exit code: {exit_code})"]
            
            if stdout.strip():
                output_parts.append(f"\n**stdout:**\n```\n{stdout.strip()}\n```")
            
            if stderr.strip():
                output_parts.append(f"\n**stderr:**\n```\n{stderr.strip()}\n```")
            
            return [TextContent(
                type="text",
                text="\n".join(output_parts),
            )]

        # Server running - request approval
        approved = await request_approval(
            command=command,
            explanation=explanation,
            goal=goal,
            timeout=approval_timeout,
        )

        if not approved:
            return [TextContent(
                type="text",
                text=f"❌ Command rejected or approval timed out.\n\nCommand was:\n```\n{command}\n```",
            )]

        # Run the command
        exit_code, stdout, stderr = await run_command(
            command=command,
            cwd=cwd,
            timeout=command_timeout,
        )

        # Format output
        output_parts = [f"✅ Command approved and executed (exit code: {exit_code})"]
        
        if stdout.strip():
            output_parts.append(f"\n**stdout:**\n```\n{stdout.strip()}\n```")
        
        if stderr.strip():
            output_parts.append(f"\n**stderr:**\n```\n{stderr.strip()}\n```")

        return [TextContent(
            type="text",
            text="\n".join(output_parts),
        )]

    else:
        return [TextContent(
            type="text",
            text=f"Unknown tool: {name}",
        )]


async def main():
    """Run the MCP server."""
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    asyncio.run(main())
