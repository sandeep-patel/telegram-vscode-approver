/**
 * Runs once when the user uninstalls the extension (VS Code invokes the
 * `vscode:uninstall` package.json script after removing the extension folder).
 *
 * Goal: remove the `gatekeeper` entry from every VS Code-family `mcp.json`
 * we can find, so the user isn't left with a dangling MCP server pointing at
 * a deleted file. Anything else in their mcp.json is left alone.
 *
 * This script must be self-contained — by the time it runs the extension's
 * node_modules are gone, so jsonc-parser is bundled in via esbuild.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseJsonc, ParseError, applyEdits, modify } from 'jsonc-parser';

const MCP_KEY = 'gatekeeper';

function candidateMcpPaths(): string[] {
    const home = os.homedir();
    const variants: string[] = [];

    if (process.platform === 'darwin') {
        const base = path.join(home, 'Library', 'Application Support');
        variants.push(
            path.join(base, 'Code', 'User', 'mcp.json'),
            path.join(base, 'Code - Insiders', 'User', 'mcp.json'),
            path.join(base, 'VSCodium', 'User', 'mcp.json'),
            path.join(base, 'Cursor', 'User', 'mcp.json'),
            path.join(base, 'Windsurf', 'User', 'mcp.json'),
        );
    } else if (process.platform === 'win32') {
        const base = path.join(home, 'AppData', 'Roaming');
        variants.push(
            path.join(base, 'Code', 'User', 'mcp.json'),
            path.join(base, 'Code - Insiders', 'User', 'mcp.json'),
            path.join(base, 'VSCodium', 'User', 'mcp.json'),
            path.join(base, 'Cursor', 'User', 'mcp.json'),
            path.join(base, 'Windsurf', 'User', 'mcp.json'),
        );
    } else {
        const base = path.join(home, '.config');
        variants.push(
            path.join(base, 'Code', 'User', 'mcp.json'),
            path.join(base, 'Code - Insiders', 'User', 'mcp.json'),
            path.join(base, 'VSCodium', 'User', 'mcp.json'),
            path.join(base, 'Cursor', 'User', 'mcp.json'),
            path.join(base, 'Windsurf', 'User', 'mcp.json'),
        );
    }

    return variants;
}

function removeGatekeeperFrom(mcpPath: string): void {
    let content: string;
    try {
        content = fs.readFileSync(mcpPath, 'utf-8');
    } catch {
        return; // file doesn't exist — nothing to clean
    }

    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
        // Don't risk corrupting a user-edited file we can't parse.
        return;
    }

    if (!parsed.servers || typeof parsed.servers !== 'object' || !(MCP_KEY in parsed.servers)) {
        return; // nothing to do
    }

    // Use jsonc-parser's `modify` to preserve formatting/comments in surrounding entries.
    const edits = modify(content, ['servers', MCP_KEY], undefined, {
        formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    if (edits.length === 0) {
        return;
    }

    const updated = applyEdits(content, edits);
    try {
        fs.writeFileSync(mcpPath, updated, 'utf-8');
    } catch {
        // Best-effort — swallow.
    }
}

function main(): void {
    for (const p of candidateMcpPaths()) {
        try {
            removeGatekeeperFrom(p);
        } catch {
            // Never throw — uninstall must always succeed.
        }
    }
}

main();
