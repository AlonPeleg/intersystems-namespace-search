// "Copy as Code Block": copies the selection (or the current line) with the colors of a light theme - by default
// InterSystems Default Light Modern, whatever theme the editor uses - in a light box, ready to paste into Outlook,
// Teams or Word. The plain text goes on the clipboard too, so pasting into a plain-text place (or into a Teams code
// block) gets just the code.
//
// Colors: the InterSystems Language Server colors ObjectScript with semantic tokens (ISC_*, COS_*, CLS_*, SQL_* ...).
// The tokens of the document are asked from VS Code, and each one is given the color the chosen theme sets for its
// type or the nearest supertype - the same rule VS Code uses on screen.
//
// Clipboard: VS Code's API only writes plain text, so the HTML goes through the system: PowerShell on Windows,
// osascript on macOS, xclip / wl-copy on Linux.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { buildCodeBlock, ColorSpan, parseJsonc, toCfHtml, tokenStyle } from './copyCodeHtml';

const CFG = 'isfsNamespaceSearch.copyCode';

interface ThemeColors { semantic: Record<string, any>; foreground: string; label: string; }
let themeCache: { key: string; colors: ThemeColors } | undefined;

/** The installed theme with this label (any extension), read once per label. */
function loadTheme(label: string): ThemeColors | undefined {
    if (themeCache?.key === label) return themeCache.colors;
    for (const ext of vscode.extensions.all) {
        const themes: any[] = ext.packageJSON?.contributes?.themes || [];
        const hit = themes.find(t => (t.label || t.id) === label);
        if (!hit) continue;
        const read = (file: string, depth: number): any => {
            const t = parseJsonc(fs.readFileSync(file, 'utf8'));
            if (t.include && depth < 5) {
                const base = read(path.join(path.dirname(file), t.include), depth + 1);
                return { ...base, ...t, colors: { ...base.colors, ...t.colors }, semanticTokenColors: { ...base.semanticTokenColors, ...t.semanticTokenColors } };
            }
            return t;
        };
        try {
            const t = read(path.join(ext.extensionPath, hit.path), 0);
            const colors: ThemeColors = {
                semantic: t.semanticTokenColors || {},
                foreground: (t.colors && t.colors['editor.foreground']) || (t.type === 'dark' || hit.uiTheme === 'vs-dark' ? '#d4d4d4' : '#000000'),
                label
            };
            themeCache = { key: label, colors };
            return colors;
        } catch { return undefined; }
    }
    return undefined;
}

/** Semantic token type -> supertype, from every extension that declares token types (the language server has 295). */
function superTypes(): Record<string, string | undefined> {
    const map: Record<string, string | undefined> = {};
    for (const ext of vscode.extensions.all) {
        for (const t of ext.packageJSON?.contributes?.semanticTokenTypes || []) if (t && t.id) map[t.id] = t.superType;
    }
    return map;
}

/** Color spans for lines [first, last] of the document, from its semantic tokens (empty when there are none). */
async function colorSpans(doc: vscode.TextDocument, first: number, last: number, theme: ThemeColors): Promise<{ spans: ColorSpan[][]; colored: boolean }> {
    const spans: ColorSpan[][] = [];
    for (let i = first; i <= last; i++) spans.push([]);
    let legend: vscode.SemanticTokensLegend | undefined, tokens: vscode.SemanticTokens | undefined;
    try {
        legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', doc.uri);
        tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
    } catch { /* no provider for this language */ }
    if (!legend || !tokens || !tokens.data || !tokens.data.length) return { spans, colored: false };
    const sup = superTypes();
    const cache = new Map<number, ReturnType<typeof tokenStyle>>();
    const d = tokens.data;
    let line = 0, char = 0, colored = false;
    for (let i = 0; i + 4 < d.length; i += 5) {
        const dl = d[i];
        line += dl;
        char = dl ? d[i + 1] : char + d[i + 1];
        if (line > last) break;
        if (line < first) continue;
        const type = d[i + 3];
        if (!cache.has(type)) cache.set(type, tokenStyle(legend.tokenTypes[type], theme.semantic, sup));
        const st = cache.get(type);
        if (!st) continue;
        spans[line - first].push({ start: char, end: char + d[i + 2], ...st });
        colored = true;
    }
    return { spans, colored };
}

/** Puts HTML (with a plain-text twin) on the system clipboard. Resolves false when it could not. */
function writeHtmlClipboard(fragment: string, text: string): Promise<boolean> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isfs-copy-'));
    const htmlFile = path.join(dir, 'code.html');
    const textFile = path.join(dir, 'code.txt');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    fs.writeFileSync(textFile, text, 'utf8');
    const run = (cmd: string, args: string[], input?: string) => new Promise<boolean>(resolve => {
        const child = execFile(cmd, args, { timeout: 15000, windowsHide: true }, err => resolve(!err));
        if (input !== undefined) { child.stdin?.end(input); }
    });
    let job: Promise<boolean>;
    if (process.platform === 'win32') {
        fs.writeFileSync(htmlFile, toCfHtml(fragment), 'ascii');
        const q = (p: string) => "'" + p.replace(/'/g, "''") + "'";
        const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$d = New-Object System.Windows.Forms.DataObject',
            '$d.SetData([System.Windows.Forms.DataFormats]::Html, [System.IO.File]::ReadAllText(' + q(htmlFile) + ', [System.Text.Encoding]::ASCII))',
            '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [System.IO.File]::ReadAllText(' + q(textFile) + ', [System.Text.Encoding]::UTF8))',
            '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)'
        ].join('; ');
        job = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    } else if (process.platform === 'darwin') {
        const html = '<html><body>' + fragment + '</body></html>';
        const hex = Buffer.from(html, 'ascii').toString('hex');
        const script = 'set t to (read POSIX file "' + textFile.replace(/"/g, '\\"') + '" as «class utf8»)\n' +
            'set the clipboard to {text:t, «class HTML»:«data HTML' + hex + '»}';
        job = run('osascript', ['-e', script]);
    } else {
        const html = '<html><body>' + fragment + '</body></html>';
        job = run('wl-copy', ['--type', 'text/html'], html).then(ok => ok || run('xclip', ['-selection', 'clipboard', '-t', 'text/html'], html));
    }
    return job.then(ok => { cleanup(); return ok; }, () => { cleanup(); return false; });
}

async function copyAsCodeBlock() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const cfg = vscode.workspace.getConfiguration(CFG);
    const sel = editor.selection;
    // Nothing selected: the current line (like Ctrl+C).
    const range = sel.isEmpty ? doc.lineAt(sel.active.line).range : new vscode.Range(sel.start, sel.end);
    const first = range.start.line;
    let last = range.end.line;
    if (last > first && range.end.character === 0) last--;          // a selection ending at the start of a line
    const lines: string[] = [];
    for (let l = first; l <= last; l++) {
        const full = doc.lineAt(l).text;
        const from = l === range.start.line ? range.start.character : 0;
        const to = l === range.end.line ? range.end.character : full.length;
        // A first line selected from its middle: keep its place (spaces) so the indentation lines up.
        lines.push((from ? ' '.repeat(from) : '') + full.slice(from, to));
    }

    const label = cfg.get<string>('theme', 'InterSystems Default Light Modern');
    const theme = loadTheme(label);
    let spans: ColorSpan[][] = lines.map(() => []);
    let colored = false;
    if (theme) ({ spans, colored } = await colorSpans(doc, first, last, theme));
    // Spans of a line cut at the selection: only what is inside it.
    if (!sel.isEmpty) {
        spans = spans.map((s, i) => {
            const l = first + i;
            const from = l === range.start.line ? range.start.character : 0;
            const to = l === range.end.line ? range.end.character : Number.MAX_SAFE_INTEGER;
            return s.map(x => ({ ...x, start: Math.max(x.start, from), end: Math.min(x.end, to) })).filter(x => x.end > x.start);
        });
    }

    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    const { html, text } = buildCodeBlock(lines, spans, {
        tabSize,
        dedent: cfg.get<boolean>('dedent', true),
        box: cfg.get<boolean>('box', true),
        background: cfg.get<string>('background', '#f6f8fa'),
        border: cfg.get<string>('border', '#d0d7de'),
        foreground: theme?.foreground || '#000000',
        fontSize: cfg.get<string>('fontSize', '10pt')
    });
    if (!text) return;
    const ok = await writeHtmlClipboard(html, text);
    if (!ok) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showWarningMessage('Copy as Code Block: could not put formatted code on the clipboard here; copied it as plain text.');
        return;
    }
    const n = text.split('\n').length;
    const how = !theme
        ? `the theme "${label}" is not installed, so without colors`
        : colored ? `in ${label} colors` : 'without colors (this document has no InterSystems coloring)';
    vscode.window.setStatusBarMessage(`$(check) Copied ${n} line${n === 1 ? '' : 's'} as a code block, ${how}`, 4000);
}

export function registerCopyCode(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('isfsNamespaceSearch.copyAsCodeBlock', copyAsCodeBlock));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration(CFG)) themeCache = undefined; }));
    context.subscriptions.push(vscode.extensions.onDidChange(() => { themeCache = undefined; }));
}
