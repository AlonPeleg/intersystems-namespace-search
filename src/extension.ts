import * as vscode from 'vscode';

interface MatchResult {
    fileName: string;
    line: number;
    column: number;
    lineText: string;
    uri: string;
}

const DIR_CONCURRENCY = 2;
const FILE_CONCURRENCY = 2;
const PAUSE_BETWEEN_READS_MS = 15;

export function activate(context: vscode.ExtensionContext) {
    const provider = new ISFSSearchWebviewProvider(context.extensionUri);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('isfsNamespaceSearchView', provider)
    );
}

export function deactivate() {}

class ISFSSearchWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _cancellationTokenSource?: vscode.CancellationTokenSource;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'startSearch': {
                    this.cancelCurrentSearch();
                    this._cancellationTokenSource = new vscode.CancellationTokenSource();
                    this.executeThrottledSearch(data.query, data.mask, this._cancellationTokenSource.token);
                    break;
                }
                case 'stopSearch': {
                    this.cancelCurrentSearch();
                    break;
                }
                case 'openMatch': {
                    const uri = vscode.Uri.parse(data.uri);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(doc, { preview: true });
                    const pos = new vscode.Position(data.line, data.column);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    break;
                }
            }
        });
    }

    private cancelCurrentSearch() {
        if (this._cancellationTokenSource) {
            this._cancellationTokenSource.cancel();
            this._cancellationTokenSource.dispose();
            this._cancellationTokenSource = undefined;
        }
    }

    private async executeThrottledSearch(query: string, mask: string, token: vscode.CancellationToken) {
        if (!this._view) return;

        const isfsFolders = vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'isfs' || f.uri.scheme === 'isfs-readonly'
        );

        if (!isfsFolders || isfsFolders.length === 0) {
            this._view.webview.postMessage({ type: 'error', message: 'No active ISFS workspace folder found.' });
            return;
        }

        const folder = isfsFolders[0];
        const nameFilterRegex = convertLocationInputToRegex(mask);
        const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

        this._view.webview.postMessage({ type: 'searchStarted' });

        try {
            this._view.webview.postMessage({ type: 'statusUpdate', message: 'Resolving target path...' });

            const targetFiles = await resolveFilesFast(folder.uri, mask, nameFilterRegex, token);

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', message: 'Search cancelled.' });
                return;
            }

            this._view.webview.postMessage({ type: 'statusUpdate', message: `Found ${targetFiles.length} file(s). Scanning...` });

            let processed = 0;
            let totalMatches = 0;

            await runWithConcurrency(targetFiles, FILE_CONCURRENCY, token, async (fileUri) => {
                if (token.isCancellationRequested) return;

                try {
                    await sleep(PAUSE_BETWEEN_READS_MS);

                    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder('utf-8').decode(fileBytes);
                    const lines = content.split(/\r?\n/);
                    const matches: MatchResult[] = [];

                    lines.forEach((lineText, lineIdx) => {
                        const regexCopy = new RegExp(searchRegex.source, searchRegex.flags);
                        let match: RegExpExecArray | null;
                        while ((match = regexCopy.exec(lineText)) !== null) {
                            const fileName = fileUri.path.split('/').pop() || 'Unknown';
                            matches.push({
                                fileName,
                                line: lineIdx,
                                column: match.index,
                                lineText: lineText.trim(),
                                uri: fileUri.toString()
                            });
                            totalMatches++;
                            if (!regexCopy.global) break;
                        }
                    });

                    if (matches.length > 0 && this._view && !token.isCancellationRequested) {
                        this._view.webview.postMessage({
                            type: 'addMatches',
                            fileName: fileUri.path.split('/').pop() || 'Unknown',
                            uri: fileUri.toString(),
                            matches
                        });
                    }
                } catch {
                    // Ignore transient file read errors
                } finally {
                    processed++;
                    if (this._view && processed % 5 === 0 && !token.isCancellationRequested) {
                        this._view.webview.postMessage({
                            type: 'statusUpdate',
                            message: `Scanned ${processed} / ${targetFiles.length} files...`
                        });
                    }
                }
            });

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', message: 'Search cancelled.' });
            } else {
                this._view.webview.postMessage({
                    type: 'searchCompleted',
                    message: `Complete. Found ${totalMatches} match(es) across ${targetFiles.length} files.`
                });
            }

        } catch (err: any) {
            this._view.webview.postMessage({ type: 'error', message: `Search error: ${err.message}` });
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background-color: var(--vscode-sideBar-background); }
        .input-group { margin-bottom: 8px; }
        label { display: block; font-size: 11px; margin-bottom: 3px; font-weight: bold; opacity: 0.8; }
        input[type="text"] {
            width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
            padding: 5px; font-size: 12px; border-radius: 2px; outline: none;
        }
        input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
        .btn-row { display: flex; gap: 5px; margin-top: 6px; }
        button {
            flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 6px; font-size: 12px; cursor: pointer; border-radius: 2px; font-weight: bold;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button#stopBtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); display: none; }
        button#stopBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        #status { font-size: 11px; margin: 10px 0; color: var(--vscode-descriptionForeground); font-style: italic; }
        .file-group { margin-bottom: 10px; }
        .file-header { font-weight: bold; font-size: 12px; color: var(--vscode-symbolIcon-fileForeground, #3794ff); margin-bottom: 2px; word-break: break-all; }
        .match-item {
            font-size: 11px; padding: 3px 6px; cursor: pointer; background: var(--vscode-list-hoverBackground);
            margin-bottom: 2px; border-radius: 2px; font-family: var(--vscode-editor-font-family); word-break: break-all;
        }
        .match-item:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .line-num { color: var(--vscode-descriptionForeground); font-size: 10px; margin-right: 5px; }
    </style>
</head>
<body>
    <div class="input-group">
        <label>SEARCH TEXT</label>
        <input type="text" id="query" placeholder="Search term..." />
    </div>
    <div class="input-group">
        <label>FILE MASK / PACKAGE</label>
        <input type="text" id="mask" value="*.cls,*.mac,*.int" placeholder="e.g. Tafnit.App.Portfolio*.cls" />
    </div>
    <div class="btn-row">
        <button id="searchBtn">Search</button>
        <button id="stopBtn">Stop</button>
    </div>

    <div id="status">Ready</div>
    <div id="results"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('query');
        const maskInput = document.getElementById('mask');
        const searchBtn = document.getElementById('searchBtn');
        const stopBtn = document.getElementById('stopBtn');
        const statusDiv = document.getElementById('status');
        const resultsDiv = document.getElementById('results');

        searchBtn.addEventListener('click', () => {
            const query = queryInput.value.trim();
            const mask = maskInput.value.trim();
            if (!query) return;

            resultsDiv.innerHTML = '';
            vscode.postMessage({ type: 'startSearch', query, mask });
        });

        stopBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'stopSearch' });
        });

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'searchStarted':
                    statusDiv.textContent = 'Preparing search...';
                    searchBtn.style.display = 'none';
                    stopBtn.style.display = 'block';
                    break;
                case 'statusUpdate':
                    statusDiv.textContent = msg.message;
                    break;
                case 'addMatches':
                    renderFileMatches(msg.fileName, msg.uri, msg.matches);
                    break;
                case 'searchCompleted':
                case 'searchStopped':
                case 'error':
                    statusDiv.textContent = msg.message || 'Stopped';
                    searchBtn.style.display = 'block';
                    stopBtn.style.display = 'none';
                    break;
            }
        });

        function renderFileMatches(fileName, uri, matches) {
            const group = document.createElement('div');
            group.className = 'file-group';

            const header = document.createElement('div');
            header.className = 'file-header';
            header.textContent = '📄 ' + fileName + ' (' + matches.length + ')';
            group.appendChild(header);

            matches.forEach(m => {
                const item = document.createElement('div');
                item.className = 'match-item';
                item.innerHTML = '<span class="line-num">:' + (m.line + 1) + '</span>' + escapeHtml(m.lineText);
                item.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openMatch', uri: m.uri, line: m.line, column: m.column });
                });
                group.appendChild(item);
            });

            resultsDiv.appendChild(group);
        }

        function escapeHtml(text) {
            return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
    </script>
</body>
</html>`;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function resolveFilesFast(
    rootFolderUri: vscode.Uri,
    mask: string,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    const cleanMask = mask.trim();

    // 1. Direct hit check if exact single class file (e.g., Tafnit.App.Portfolio.utils.cls)
    if (!cleanMask.includes('*') && !cleanMask.includes('?') && !cleanMask.includes(',') && cleanMask.endsWith('.cls')) {
        const filePath = cleanMask.replace(/\./g, '/').replace(/\/cls$/, '.cls');
        const directFileUri = vscode.Uri.joinPath(rootFolderUri, filePath);
        try {
            const stat = await vscode.workspace.fs.stat(directFileUri);
            if (stat.type === vscode.FileType.File) {
                return [directFileUri];
            }
        } catch {
            // Fall back to target dir walk if stat fails
        }
    }

    // 2. Extract parent directory path from dotted mask (e.g. Tafnit.App.Portfolio*.cls -> Tafnit/App)
    let directTargetFolder: string | null = null;
    if (cleanMask.includes('.')) {
        const firstMask = cleanMask.split(',')[0].trim();
        const lastDotIndex = firstMask.lastIndexOf('.');
        if (lastDotIndex > 0) {
            const packagePath = firstMask.substring(0, lastDotIndex); // Tafnit.App.Portfolio
            const parts = packagePath.split('.');
            const staticParts: string[] = [];
            for (const part of parts) {
                if (part.includes('*') || part.includes('?')) break;
                staticParts.push(part);
            }
            if (staticParts.length > 0) {
                directTargetFolder = staticParts.join('/');
            }
        }
    }

    const startUri = directTargetFolder ? vscode.Uri.joinPath(rootFolderUri, directTargetFolder) : rootFolderUri;
    return await collectMatchingFiles(startUri, rootFolderUri, nameFilterRegex, token);
}

async function collectMatchingFiles(
    startUri: vscode.Uri,
    rootFolderUri: vscode.Uri,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];

    async function walk(currentUri: vscode.Uri) {
        if (token.isCancellationRequested) return;

        let entries: [string, vscode.FileType][];
        try {
            await sleep(PAUSE_BETWEEN_READS_MS);
            entries = await vscode.workspace.fs.readDirectory(currentUri);
        } catch {
            return;
        }

        const subDirs: vscode.Uri[] = [];
        for (const [name, type] of entries) {
            if (token.isCancellationRequested) return;
            const childUri = vscode.Uri.joinPath(currentUri, name);
            if (type === vscode.FileType.Directory) {
                subDirs.push(childUri);
            } else if (type === vscode.FileType.File) {
                let relativePath = childUri.path.substring(rootFolderUri.path.length);
                if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);

                if (nameFilterRegex.test(name) || nameFilterRegex.test(relativePath)) {
                    fileUris.push(childUri);
                }
            }
        }

        await runWithConcurrency(subDirs, DIR_CONCURRENCY, token, walk);
    }

    await walk(startUri);
    return fileUris;
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    token: vscode.CancellationToken,
    fn: (item: T) => Promise<void>
): Promise<void> {
    let index = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            if (token.isCancellationRequested) return;
            const i = index++;
            await fn(items[i]);
        }
    });
    await Promise.all(workers);
}

function convertLocationInputToRegex(input: string): RegExp {
    let clean = input.trim();
    if (!clean) return /\.(cls|mac|int)$/i;

    if (clean.includes(',')) {
        const parts = clean.split(',').map(p => convertSingleMaskToRegexStr(p.trim()));
        return new RegExp(`^(${parts.join('|')})$`, 'i');
    }

    return new RegExp(`^${convertSingleMaskToRegexStr(clean)}$`, 'i');
}

function convertSingleMaskToRegexStr(mask: string): string {
    let result = mask.trim();
    const hasClassOrRoutineExt = /\.(cls|mac|int)$/i.test(result);

    if (result.includes('.')) {
        if (hasClassOrRoutineExt) {
            const lastDotIndex = result.lastIndexOf('.');
            const ext = result.substring(lastDotIndex);
            const packageAndName = result.substring(0, lastDotIndex);
            
            const slashPath = packageAndName.replace(/\./g, '/');
            return `.*${slashPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}\\${ext}`;
        } else {
            const parts = result.split('.');
            const slashPath = parts.join('/');
            let regexStr = slashPath
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.');
            
            regexStr += '(\\.(cls|mac|int))?';
            return `.*${regexStr}`;
        }
    }

    let regexStr = result
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    if (!hasClassOrRoutineExt) {
        regexStr += '\\.(cls|mac|int)';
    }

    return `.*${regexStr}`;
}