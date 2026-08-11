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
        vscode.window.registerWebviewViewProvider('isfsNamespaceSearchView', provider, {
            webviewOptions: {
                retainContextWhenHidden: true
            }
        })
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
                    this.executeThrottledSearch(data.query, data.masks, this._cancellationTokenSource.token);
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

    private async executeThrottledSearch(query: string, masks: string[], token: vscode.CancellationToken) {
        if (!this._view) return;

        const isfsFolders = vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'isfs' || f.uri.scheme === 'isfs-readonly'
        );

        if (!isfsFolders || isfsFolders.length === 0) {
            this._view.webview.postMessage({ type: 'error', message: 'No active ISFS workspace folder found.' });
            return;
        }

        const folder = isfsFolders[0];
        const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

        this._view.webview.postMessage({ type: 'searchStarted', query, mask: masks.join(',') });

        try {
            this._view.webview.postMessage({ type: 'statusUpdate', message: 'Resolving target paths in parallel...' });

            // Run independent resolution for each input mask concurrently
            const resolutionPromises = masks.map(m => resolveSingleMaskFast(folder.uri, m, token));
            const nestedResults = await Promise.all(resolutionPromises);

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', message: 'Search cancelled.' });
                return;
            }

            // Deduplicate files found across different mask inputs
            const uniqueFileMap = new Map<string, vscode.Uri>();
            for (const fileList of nestedResults) {
                for (const uri of fileList) {
                    uniqueFileMap.set(uri.toString(), uri);
                }
            }

            const targetFiles = Array.from(uniqueFileMap.values());

            if (targetFiles.length === 0) {
                this._view.webview.postMessage({
                    type: 'searchCompleted',
                    message: 'Complete. No matching files found.',
                    totalMatches: 0
                });
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
                    message: `Complete. Found ${totalMatches} match(es) across ${targetFiles.length} files.`,
                    totalMatches
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
        
        .mask-row {
            display: flex; gap: 4px; margin-bottom: 4px; align-items: center;
        }

        input[type="text"] {
            width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
            color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
            padding: 5px; font-size: 12px; border-radius: 2px; outline: none; flex: 1;
        }
        input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
        
        .icon-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none; padding: 4px 8px; font-size: 12px; cursor: pointer;
            border-radius: 2px; font-weight: bold; height: 26px; line-height: 1;
            display: flex; align-items: center; justify-content: center;
        }
        .icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

        .btn-row { display: flex; gap: 5px; margin-top: 6px; }
        button.action-btn {
            flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 6px; font-size: 12px; cursor: pointer; border-radius: 2px; font-weight: bold;
        }
        button.action-btn:hover { background: var(--vscode-button-hoverBackground); }
        button#stopBtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); display: none; }
        button#stopBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        button#clearBtn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
        button#clearBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        #status { font-size: 11px; margin: 10px 0; color: var(--vscode-descriptionForeground); font-style: italic; }
        
        .section-header {
            font-size: 11px; font-weight: bold; text-transform: uppercase; margin: 15px 0 6px 0;
            letter-spacing: 0.5px; opacity: 0.7; border-bottom: 1px solid var(--vscode-widget-border, #333);
            padding-bottom: 3px; display: flex; justify-content: space-between; align-items: center;
        }

        /* Collapsible File Details */
        details.file-group { margin-bottom: 8px; }
        details.file-group > summary.file-header {
            font-weight: bold; font-size: 12px;
            color: var(--vscode-symbolIcon-fileForeground, #3794ff);
            margin-bottom: 4px; word-break: break-all; cursor: pointer;
            user-select: none; list-style: none; display: flex; align-items: center;
        }
        details.file-group > summary.file-header::-webkit-details-marker { display: none; }
        details.file-group > summary.file-header::before {
            content: '▾'; display: inline-block; margin-right: 5px; font-size: 11px;
            transition: transform 0.1s ease;
        }
        details.file-group[open] > summary.file-header::before { transform: rotate(0deg); }
        details.file-group:not([open]) > summary.file-header::before { transform: rotate(-90deg); }

        .match-item {
            font-size: 11px; padding: 3px 6px; cursor: pointer; background: var(--vscode-list-hoverBackground);
            margin-bottom: 2px; border-radius: 2px; font-family: var(--vscode-editor-font-family); word-break: break-all;
        }
        .match-item:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .line-num { color: var(--vscode-descriptionForeground); font-size: 10px; margin-right: 5px; }

        details.history-tab {
            background: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.03));
            border: 1px solid var(--vscode-widget-border, #333);
            border-radius: 3px;
            margin-bottom: 6px;
            overflow: hidden;
        }
        details.history-tab > summary {
            padding: 6px 8px; font-size: 11px; font-weight: bold; cursor: pointer;
            display: flex; align-items: center; justify-content: space-between;
            user-select: none;
        }
        details.history-tab > summary:hover { background: var(--vscode-list-hoverBackground); }
        .history-title { font-weight: bold; color: var(--vscode-foreground); word-break: break-all; flex: 1; padding-right: 6px; }
        .history-time { font-weight: normal; opacity: 0.6; font-size: 10px; margin-right: 6px; white-space: nowrap; }
        .history-content { padding: 8px; border-top: 1px solid var(--vscode-widget-border, #333); }
        .tab-clear-btn {
            background: none; border: none; color: var(--vscode-descriptionForeground);
            cursor: pointer; padding: 2px 4px; font-size: 12px; border-radius: 2px;
            flex: 0; line-height: 1;
        }
        .tab-clear-btn:hover { color: var(--vscode-errorForeground, #f48771); background: var(--vscode-list-hoverBackground); }
    </style>
</head>
<body>
    <div class="input-group">
        <label>SEARCH TEXT</label>
        <input type="text" id="query" placeholder="Search term..." />
    </div>
    <div class="input-group">
        <label>FILE MASK / PACKAGE</label>
        <div id="masksContainer">
            <div class="mask-row">
                <input type="text" class="mask-input" value="*.cls,*.mac,*.int" placeholder="e.g. Tafnit.App.Portfolio*.cls" />
                <button type="button" class="icon-btn" id="addMaskBtn" title="Add another mask/package">+</button>
            </div>
        </div>
    </div>
    <div class="btn-row">
        <button id="searchBtn" class="action-btn">Search</button>
        <button id="clearBtn" class="action-btn">Clear All</button>
        <button id="stopBtn" class="action-btn">Stop</button>
    </div>

    <div id="status">Ready</div>

    <div class="section-header">Current Search</div>
    <div id="results"></div>

    <div class="section-header">Search History</div>
    <div id="historyContainer"></div>

    <script>
        const vscode = acquireVsCodeApi();
        const queryInput = document.getElementById('query');
        const masksContainer = document.getElementById('masksContainer');
        const addMaskBtn = document.getElementById('addMaskBtn');
        const searchBtn = document.getElementById('searchBtn');
        const clearBtn = document.getElementById('clearBtn');
        const stopBtn = document.getElementById('stopBtn');
        const statusDiv = document.getElementById('status');
        const resultsDiv = document.getElementById('results');
        const historyContainer = document.getElementById('historyContainer');

        let activeSearchInfo = { query: '', mask: '', totalMatches: 0 };

        // Restore state on panel reload
        const previousState = vscode.getState();
        if (previousState) {
            if (previousState.query !== undefined) queryInput.value = previousState.query;
            if (previousState.masks && Array.isArray(previousState.masks)) {
                restoreMaskInputs(previousState.masks);
            }
            if (previousState.resultsHtml !== undefined) resultsDiv.innerHTML = previousState.resultsHtml;
            if (previousState.historyHtml !== undefined) historyContainer.innerHTML = previousState.historyHtml;
            if (previousState.statusText !== undefined) statusDiv.textContent = previousState.statusText;
            if (previousState.activeSearchInfo) activeSearchInfo = previousState.activeSearchInfo;
            
            attachListeners();
        }

        function getMaskValues() {
            const inputs = document.querySelectorAll('.mask-input');
            const values = [];
            inputs.forEach(input => {
                const val = input.value.trim();
                if (val) values.push(val);
            });
            return values;
        }

        function saveState() {
            vscode.setState({
                query: queryInput.value,
                masks: getMaskValues(),
                resultsHtml: resultsDiv.innerHTML,
                historyHtml: historyContainer.innerHTML,
                statusText: statusDiv.textContent,
                activeSearchInfo
            });
        }

        function restoreMaskInputs(masks) {
            masksContainer.innerHTML = '';
            if (!masks || masks.length === 0) masks = ['*.cls,*.mac,*.int'];

            masks.forEach((maskValue, index) => {
                addMaskRow(maskValue, index === 0);
            });
        }

        function addMaskRow(value = '', isFirst = false) {
            const row = document.createElement('div');
            row.className = 'mask-row';

            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'mask-input';
            input.value = value;
            input.placeholder = 'e.g. Tafnit.App.Portfolio*.cls';
            input.addEventListener('input', saveState);

            row.appendChild(input);

            if (isFirst) {
                const addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'icon-btn';
                addBtn.textContent = '+';
                addBtn.title = 'Add another mask/package';
                addBtn.addEventListener('click', () => {
                    addMaskRow('', false);
                    saveState();
                });
                row.appendChild(addBtn);
            } else {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'icon-btn';
                removeBtn.textContent = '-';
                removeBtn.title = 'Remove this mask';
                removeBtn.addEventListener('click', () => {
                    row.remove();
                    saveState();
                });
                row.appendChild(removeBtn);
            }

            masksContainer.appendChild(row);
        }

        queryInput.addEventListener('input', saveState);
        addMaskBtn.addEventListener('click', () => {
            addMaskRow('', false);
            saveState();
        });

        searchBtn.addEventListener('click', () => {
            const query = queryInput.value.trim();
            const maskList = getMaskValues();

            if (!query) return;

            archiveCurrentSearchToHistory();

            resultsDiv.innerHTML = '';
            activeSearchInfo = { query, mask: maskList.join(','), totalMatches: 0 };
            saveState();

            vscode.postMessage({ type: 'startSearch', query, masks: maskList });
        });

        clearBtn.addEventListener('click', () => {
            resultsDiv.innerHTML = '';
            historyContainer.innerHTML = '';
            statusDiv.textContent = 'Ready';
            saveState();
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
                    clearBtn.style.display = 'none';
                    stopBtn.style.display = 'block';
                    saveState();
                    break;
                case 'statusUpdate':
                    statusDiv.textContent = msg.message;
                    saveState();
                    break;
                case 'addMatches':
                    renderFileMatches(resultsDiv, msg.fileName, msg.uri, msg.matches);
                    saveState();
                    break;
                case 'searchCompleted':
                    activeSearchInfo.totalMatches = msg.totalMatches || 0;
                    statusDiv.textContent = msg.message || 'Complete.';
                    searchBtn.style.display = 'block';
                    clearBtn.style.display = 'block';
                    stopBtn.style.display = 'none';
                    saveState();
                    break;
                case 'searchStopped':
                case 'error':
                    statusDiv.textContent = msg.message || 'Stopped';
                    searchBtn.style.display = 'block';
                    clearBtn.style.display = 'block';
                    stopBtn.style.display = 'none';
                    saveState();
                    break;
            }
        });

        function archiveCurrentSearchToHistory() {
            const currentMatches = resultsDiv.querySelectorAll('.match-item').length;
            if (currentMatches === 0) return;

            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const dateStr = now.toLocaleDateString([], { month: 'short', day: 'numeric' });

            const details = document.createElement('details');
            details.className = 'history-tab';

            const summary = document.createElement('summary');
            
            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = '"' + (activeSearchInfo.query || queryInput.value) + '" (' + currentMatches + ' matches)';

            const timeSpan = document.createElement('span');
            timeSpan.className = 'history-time';
            timeSpan.textContent = dateStr + ' ' + timeStr;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'tab-clear-btn';
            deleteBtn.title = 'Clear this entry';
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                details.remove();
                saveState();
            });

            summary.appendChild(titleSpan);
            summary.appendChild(timeSpan);
            summary.appendChild(deleteBtn);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'history-content';
            contentDiv.innerHTML = resultsDiv.innerHTML;

            details.appendChild(summary);
            details.appendChild(contentDiv);

            historyContainer.insertBefore(details, historyContainer.firstChild);
            attachListeners();
        }

        function renderFileMatches(container, fileName, uri, matches) {
            const details = document.createElement('details');
            details.className = 'file-group';
            // Collapsed by default (details.open is false)

            const summary = document.createElement('summary');
            summary.className = 'file-header';
            summary.textContent = '📄 ' + fileName + ' (' + matches.length + ')';
            details.appendChild(summary);

            matches.forEach(m => {
                const item = document.createElement('div');
                item.className = 'match-item';
                item.setAttribute('data-uri', m.uri);
                item.setAttribute('data-line', m.line);
                item.setAttribute('data-column', m.column);
                item.innerHTML = '<span class="line-num">:' + (m.line + 1) + '</span>' + escapeHtml(m.lineText);
                
                item.addEventListener('click', () => {
                    vscode.postMessage({ type: 'openMatch', uri: m.uri, line: m.line, column: m.column });
                });
                details.appendChild(item);
            });

            container.appendChild(details);
        }

        function attachListeners() {
            const items = document.querySelectorAll('.match-item');
            items.forEach(item => {
                item.onclick = null;
                item.addEventListener('click', () => {
                    const uri = item.getAttribute('data-uri');
                    const line = parseInt(item.getAttribute('data-line'), 10);
                    const column = parseInt(item.getAttribute('data-column'), 10);
                    vscode.postMessage({ type: 'openMatch', uri, line, column });
                });
            });

            const tabClearBtns = document.querySelectorAll('.tab-clear-btn');
            tabClearBtns.forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const tab = btn.closest('.history-tab');
                    if (tab) tab.remove();
                    saveState();
                };
            });
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

async function resolveSingleMaskFast(
    rootFolderUri: vscode.Uri,
    singleMask: string,
    token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    const cleanMask = singleMask.trim();
    if (!cleanMask) return [];

    const nameFilterRegex = convertLocationInputToRegex(cleanMask);

    // Direct hit check for single explicit class file
    if (!cleanMask.includes('*') && !cleanMask.includes('?') && cleanMask.endsWith('.cls')) {
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

    // Extract exact parent path for this specific mask
    let targetFolder: string | null = null;
    if (cleanMask.includes('.')) {
        const lastDotIndex = cleanMask.lastIndexOf('.');
        if (lastDotIndex > 0) {
            const packagePath = cleanMask.substring(0, lastDotIndex);
            const parts = packagePath.split('.');
            const staticParts: string[] = [];
            for (const part of parts) {
                if (part.includes('*') || part.includes('?')) break;
                staticParts.push(part);
            }
            if (staticParts.length > 0) {
                targetFolder = staticParts.join('/');
            }
        }
    }

    const startUri = targetFolder ? vscode.Uri.joinPath(rootFolderUri, targetFolder) : rootFolderUri;
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
        const parts = clean.split(',').map(p => convertSingleMaskToRegexStr(p.trim())).filter(Boolean);
        return new RegExp(`^(${parts.join('|')})$`, 'i');
    }

    return new RegExp(`^${convertSingleMaskToRegexStr(clean)}$`, 'i');
}

function convertSingleMaskToRegexStr(mask: string): string {
    let result = mask.trim();
    if (!result) return '';
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