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

            const resolutionPromises = masks.map(m => resolveSingleMaskFast(folder.uri, m, token));
            const nestedResults = await Promise.all(resolutionPromises);

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', message: 'Search cancelled.' });
                return;
            }

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
        body {
            font-family: var(--vscode-font-family);
            padding: 8px 10px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-sideBar-background);
            box-sizing: border-box;
        }

        .input-group {
            margin-bottom: 10px;
        }

        label {
            display: block;
            font-size: 10px;
            font-weight: 600;
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }

        .mask-row {
            display: flex;
            gap: 4px;
            margin-bottom: 4px;
            align-items: center;
        }

        input[type="text"] {
            width: 100%;
            box-sizing: border-box;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, transparent);
            padding: 5px 7px;
            font-size: 12px;
            border-radius: 2px;
            outline: none;
            flex: 1;
        }

        input[type="text"]:focus {
            border-color: var(--vscode-focusBorder);
        }

        .icon-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 0;
            width: 24px;
            height: 24px;
            font-size: 13px;
            cursor: pointer;
            border-radius: 2px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .icon-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .btn-row {
            display: flex;
            gap: 6px;
            margin-top: 8px;
        }

        button.action-btn {
            flex: 1;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 5px 8px;
            font-size: 12px;
            cursor: pointer;
            border-radius: 2px;
            font-weight: 500;
        }

        button.action-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button#stopBtn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            display: none;
        }

        button#stopBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        button#clearBtn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button#clearBtn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        #status {
            font-size: 11px;
            margin: 8px 0 12px 0;
            color: var(--vscode-descriptionForeground);
        }

        .section-header {
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin: 14px 0 6px 0;
            color: var(--vscode-descriptionForeground);
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            padding-bottom: 4px;
        }

        /* Clean Results List */
        details.file-group {
            margin-bottom: 6px;
        }

        details.file-group > summary.file-header {
            font-size: 12px;
            font-weight: 500;
            color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
            padding: 3px 0;
            cursor: pointer;
            user-select: none;
            list-style: none;
            display: flex;
            align-items: center;
        }

        details.file-group > summary.file-header::-webkit-details-marker {
            display: none;
        }

        details.file-group > summary.file-header::before {
            content: '›';
            display: inline-block;
            margin-right: 6px;
            font-size: 12px;
            line-height: 1;
            transition: transform 0.1s ease;
        }

        details.file-group[open] > summary.file-header::before {
            transform: rotate(90deg);
        }

        .match-item {
            font-size: 11px;
            padding: 3px 6px 3px 16px;
            cursor: pointer;
            border-radius: 2px;
            font-family: var(--vscode-editor-font-family);
            word-break: break-all;
            line-height: 1.4;
            color: var(--vscode-foreground);
        }

        .match-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .line-num {
            color: var(--vscode-editorLineNumber-foreground, #858585);
            font-weight: normal;
            margin-right: 6px;
            user-select: none;
        }

        /* History Items */
        details.history-tab {
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            border-radius: 3px;
            margin-bottom: 6px;
            background: transparent;
        }

        details.history-tab > summary {
            padding: 6px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            user-select: none;
            gap: 6px;
        }

        details.history-tab > summary:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .history-summary-left {
            display: flex;
            flex-direction: column;
            gap: 2px;
            overflow: hidden;
            flex: 1;
        }

        .history-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .history-sub {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .history-time {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }

        .history-content {
            padding: 6px 8px 8px 8px;
            border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
        }

        .tab-clear-btn {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 11px;
            border-radius: 2px;
            line-height: 1;
        }

        .tab-clear-btn:hover {
            color: var(--vscode-errorForeground);
            background: var(--vscode-list-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="input-group">
        <label>Search Text</label>
        <input type="text" id="query" placeholder="Search term..." />
    </div>
    <div class="input-group">
        <label>File Mask / Package</label>
        <div id="masksContainer">
            <div class="mask-row">
                <input type="text" class="mask-input" value="*.cls,*.mac,*.int" placeholder="e.g. Tafnit.App.Portfolio*.cls" />
                <button type="button" class="icon-btn" id="addMaskBtn" title="Add mask">+</button>
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
                addBtn.title = 'Add mask';
                addBtn.addEventListener('click', () => {
                    addMaskRow('', false);
                    saveState();
                });
                row.appendChild(addBtn);
            } else {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'icon-btn';
                removeBtn.textContent = '✕';
                removeBtn.title = 'Remove mask';
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
            activeSearchInfo = { query, mask: maskList.join(' | '), totalMatches: 0 };
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
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const details = document.createElement('details');
            details.className = 'history-tab';

            const summary = document.createElement('summary');
            
            const leftContainer = document.createElement('div');
            leftContainer.className = 'history-summary-left';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = '"' + (activeSearchInfo.query || queryInput.value) + '"';

            const subSpan = document.createElement('span');
            subSpan.className = 'history-sub';
            const maskText = activeSearchInfo.mask || getMaskValues().join(' | ');
            subSpan.textContent = maskText + ' (' + currentMatches + ' matches)';

            leftContainer.appendChild(titleSpan);
            leftContainer.appendChild(subSpan);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'history-time';
            timeSpan.textContent = timeStr;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'tab-clear-btn';
            deleteBtn.title = 'Clear entry';
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                details.remove();
                saveState();
            });

            summary.appendChild(leftContainer);
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

            const summary = document.createElement('summary');
            summary.className = 'file-header';
            summary.textContent = fileName + ' (' + matches.length + ')';
            details.appendChild(summary);

            matches.forEach(m => {
                const item = document.createElement('div');
                item.className = 'match-item';
                item.setAttribute('data-uri', m.uri);
                item.setAttribute('data-line', m.line);
                item.setAttribute('data-column', m.column);
                item.innerHTML = '<span class="line-num">' + (m.line + 1) + '</span>' + escapeHtml(m.lineText);
                
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