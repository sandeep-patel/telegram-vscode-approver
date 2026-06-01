#!/usr/bin/env python3
"""Test script to verify the approval flow."""

import asyncio
import aiohttp
import sys
import pytest


@pytest.mark.asyncio
async def test_approval():
    """Send a test approval request."""
    url = "http://localhost:8765"
    
    # First check health
    print("Checking server health...")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{url}/health", timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    print(f"✅ Server is healthy: {data}")
                else:
                    print(f"❌ Server returned status {resp.status}")
                    return
    except aiohttp.ClientError as e:
        print(f"❌ Cannot connect to server: {e}")
        print("\nMake sure the GateKeeper server is running:")
        print("  python bot.py")
        return

    # Send test approval request
    print("\nSending test approval request...")
    print("Check your phone for the approval prompt!")
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{url}/approve",
                json={
                    "command": "echo 'Hello from test!'",
                    "explanation": "Test command to verify the approval flow",
                    "goal": "Verify GateKeeper approval is working",
                },
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                data = await resp.json()
                
                if data.get("approved"):
                    print("\n✅ Command APPROVED!")
                else:
                    print("\n❌ Command REJECTED or timed out")
                    
    except asyncio.TimeoutError:
        print("\n⏰ Request timed out after 60 seconds")
    except aiohttp.ClientError as e:
        print(f"\n❌ Request failed: {e}")


if __name__ == "__main__":
    asyncio.run(test_approval())
