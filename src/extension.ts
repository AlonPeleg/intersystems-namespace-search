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

interface NamespaceDescriptor {
    id: string;
    label: string;
}

function getIsfsWorkspaceFolders(): vscode.WorkspaceFolder[] {
    return (
        vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'isfs' || f.uri.scheme === 'isfs-readonly'
        ) ?? []
    );
}

function getIsfsNamespaces(): NamespaceDescriptor[] {
    return getIsfsWorkspaceFolders().map(f => ({ id: f.uri.toString(), label: f.name }));
}

class ISFSSearchWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    // One search can now run per namespace tab at a time, so cancellation is
    // tracked per namespace instead of a single shared token.
    private _cancellationTokenSources = new Map<string, vscode.CancellationTokenSource>();

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

        const workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
            this.postNamespaceList();
        });
        webviewView.onDidDispose(() => {
            workspaceFoldersListener.dispose();
            this.cancelAllSearches();
        });

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'ready': {
                    this.postNamespaceList();
                    break;
                }
                case 'startSearch': {
                    const namespaceId: string | undefined = data.namespaceId;
                    if (!namespaceId) break;
                    this.cancelSearchForNamespace(namespaceId);
                    const source = new vscode.CancellationTokenSource();
                    this._cancellationTokenSources.set(namespaceId, source);
                    const useWildcards = data.useWildcards !== false;
                    this.executeThrottledSearch(data.query, data.masks, namespaceId, useWildcards, source);
                    break;
                }
                case 'stopSearch': {
                    if (data.namespaceId) this.cancelSearchForNamespace(data.namespaceId);
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

    private cancelSearchForNamespace(namespaceId: string) {
        const source = this._cancellationTokenSources.get(namespaceId);
        if (source) {
            source.cancel();
            source.dispose();
            this._cancellationTokenSources.delete(namespaceId);
        }
    }

    private cancelAllSearches() {
        for (const source of this._cancellationTokenSources.values()) {
            source.cancel();
            source.dispose();
        }
        this._cancellationTokenSources.clear();
    }

    private postNamespaceList() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'namespaceList', namespaces: getIsfsNamespaces() });
    }

    private async executeThrottledSearch(
        query: string,
        masks: string[],
        namespaceId: string,
        useWildcards: boolean,
        source: vscode.CancellationTokenSource
    ) {
        if (!this._view) return;
        const token = source.token;

        const isfsFolders = getIsfsWorkspaceFolders();
        const folder = isfsFolders.find(f => f.uri.toString() === namespaceId);

        if (!folder) {
            this._view.webview.postMessage({
                type: 'error',
                namespaceId,
                message: 'Selected namespace is no longer available. Please choose another namespace.'
            });
            this.postNamespaceList();
            this.forgetSearchIfCurrent(namespaceId, source);
            return;
        }

        // With wildcards on, '*' and '?' in the search text act as wildcards,
        // same as in the file mask field: '*' matches any run of characters
        // (e.g. "$zaccessor.*.getByList" matches "$zaccessor.Offer.getByList"),
        // '?' matches exactly one character. Everything else is escaped so
        // it's matched literally. With wildcards off, '*' and '?' are escaped
        // too, so code containing a literal '*' (e.g. $P(test,"*",1)) can
        // still be searched for as-is.
        const searchRegex = useWildcards
            ? new RegExp(
                query
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.'),
                'gi'
            )
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

        this._view.webview.postMessage({
            type: 'searchStarted',
            namespaceId,
            query,
            mask: masks.join(',')
        });

        try {
            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: 'Resolving target paths in parallel...'
            });

            const resolutionPromises = masks.map(m => resolveSingleMaskFast(folder.uri, m, token));
            const nestedResults = await Promise.all(resolutionPromises);

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', namespaceId, message: 'Search cancelled.' });
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
                    namespaceId,
                    message: 'Complete. No matching files found.',
                    totalMatches: 0
                });
                return;
            }

            this._view.webview.postMessage({
                type: 'statusUpdate',
                namespaceId,
                message: `Found ${targetFiles.length} file(s). Scanning...`
            });

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
                            namespaceId,
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
                            namespaceId,
                            message: `Scanned ${processed} / ${targetFiles.length} files...`
                        });
                    }
                }
            });

            if (token.isCancellationRequested) {
                this._view.webview.postMessage({ type: 'searchStopped', namespaceId, message: 'Search cancelled.' });
            } else {
                this._view.webview.postMessage({
                    type: 'searchCompleted',
                    namespaceId,
                    message: `Complete. Found ${totalMatches} match(es) across ${targetFiles.length} files.`,
                    totalMatches
                });
            }

        } catch (err: any) {
            this._view.webview.postMessage({ type: 'error', namespaceId, message: `Search error: ${err.message}` });
        } finally {
            this.forgetSearchIfCurrent(namespaceId, source);
        }
    }

    // Only clears the map entry if it still points at *this* run's token
    // source, so a fresh search kicked off for the same namespace while an
    // older one is still winding down (post-cancellation) isn't clobbered.
    private forgetSearchIfCurrent(namespaceId: string, source: vscode.CancellationTokenSource) {
        if (this._cancellationTokenSources.get(namespaceId) === source) {
            this._cancellationTokenSources.delete(namespaceId);
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

        .hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
            line-height: 1.4;
        }

        .checkbox-row {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            margin-top: 6px;
            font-size: 10px;
            font-weight: normal;
            text-transform: none;
            letter-spacing: normal;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            line-height: 1.4;
        }

        .checkbox-row input[type="checkbox"] {
            margin: 1px 0 0 0;
            flex-shrink: 0;
            cursor: pointer;
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

        /* Namespace picker: a compact dropdown button, better suited to a
           narrow sidebar than a row of tabs that needs horizontal scrolling.
           Each namespace still keeps its own independent search state (see
           nsState below) - this only changes how you pick which one is active. */
        .namespace-picker {
            position: relative;
        }

        .namespace-picker-btn {
            width: 100%;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            background: var(--vscode-dropdown-background, var(--vscode-input-background));
            color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
            padding: 5px 8px;
            font-size: 12px;
            border-radius: 2px;
            cursor: pointer;
        }

        .namespace-picker-btn:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .namespace-picker-btn.open,
        .namespace-picker-btn:focus {
            border-color: var(--vscode-focusBorder);
            outline: none;
        }

        .namespace-picker-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .namespace-picker-label {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 6px;
            overflow: hidden;
            min-width: 0;
        }

        .namespace-picker-label .label-text {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .namespace-picker-caret {
            flex-shrink: 0;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            transition: transform 0.1s ease;
        }

        .namespace-picker-btn.open .namespace-picker-caret {
            transform: rotate(180deg);
        }

        .namespace-dropdown {
            position: absolute;
            top: calc(100% + 3px);
            left: 0;
            right: 0;
            z-index: 20;
            background: var(--vscode-dropdown-background, var(--vscode-sideBar-background));
            border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.3)));
            border-radius: 3px;
            max-height: 200px;
            overflow-y: auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        }

        .namespace-option {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 8px;
            font-size: 12px;
            cursor: pointer;
        }

        .namespace-option .label-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .namespace-option:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .namespace-option.active {
            background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
            color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
        }

        .namespace-empty-option {
            padding: 7px 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .tab-searching-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--vscode-testing-iconQueued, #cca700);
            flex-shrink: 0;
            animation: tab-pulse 1s ease-in-out infinite;
        }

        @keyframes tab-pulse {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
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

        button.action-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
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
        <label>Namespace</label>
        <div class="namespace-picker" id="namespacePicker">
            <button type="button" id="namespacePickerBtn" class="namespace-picker-btn">
                <span id="namespacePickerLabel" class="namespace-picker-label"><span class="label-text">No namespace folders found</span></span>
                <span class="namespace-picker-caret">▾</span>
            </button>
            <div id="namespaceDropdown" class="namespace-dropdown" hidden></div>
        </div>
    </div>
    <div class="input-group">
        <label>Search Text</label>
        <input type="text" id="query" placeholder="Search term..." />
        <label class="checkbox-row">
            <input type="checkbox" id="useWildcardsCheckbox" checked />
            <span>Use wildcards (<code>*</code> = any characters, <code>?</code> = one character). Turn off to search for a literal <code>*</code> or <code>?</code>.</span>
        </label>
    </div>
    <div class="input-group">
        <label>File Mask / Package</label>
        <div id="masksContainer">
            <div class="mask-row">
                <input type="text" class="mask-input" value="*.cls,*.mac,*.int" placeholder="e.g. Tafnit.App.Portfolio*.cls" />
                <button type="button" class="icon-btn" id="addMaskBtn" title="Add mask">+</button>
            </div>
        </div>
        <div class="hint">Use <code>Pkg.Sub.*</code> to search inside a package and everything under it. A plain <code>NAME*</code> (no dot) only checks items directly at the namespace root, so it stays fast.</div>
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
        const namespacePickerEl = document.getElementById('namespacePicker');
        const namespacePickerBtn = document.getElementById('namespacePickerBtn');
        const namespacePickerLabel = document.getElementById('namespacePickerLabel');
        const namespaceDropdownEl = document.getElementById('namespaceDropdown');
        const queryInput = document.getElementById('query');
        const useWildcardsCheckbox = document.getElementById('useWildcardsCheckbox');
        const masksContainer = document.getElementById('masksContainer');
        const addMaskBtn = document.getElementById('addMaskBtn');
        const searchBtn = document.getElementById('searchBtn');
        const clearBtn = document.getElementById('clearBtn');
        const stopBtn = document.getElementById('stopBtn');
        const statusDiv = document.getElementById('status');
        const resultsDiv = document.getElementById('results');
        const historyContainer = document.getElementById('historyContainer');

        setupNamespacePicker();

        const DEFAULT_MASKS = ['*.cls,*.mac,*.int'];

        let namespaces = [];
        let activeNamespace = '';
        // Every namespace tab keeps its own independent state (query, masks,
        // in-flight/finished results, status text, and recent-search log) so
        // switching tabs never loses what's there, and a search kicked off in
        // one tab keeps running while you work in another.
        let nsState = {};

        function createDefaultNsState() {
            return {
                query: '',
                useWildcards: true,
                masks: DEFAULT_MASKS.slice(),
                resultsHtml: '',
                matchCount: 0,
                statusText: 'Ready',
                searching: false,
                activeSearchInfo: { query: '', mask: '' },
                history: []
            };
        }

        function getNsState(nsId) {
            if (!nsState[nsId]) nsState[nsId] = createDefaultNsState();
            return nsState[nsId];
        }

        const previousState = vscode.getState();
        if (previousState) {
            if (previousState.nsState) nsState = previousState.nsState;
            if (previousState.namespaces && Array.isArray(previousState.namespaces)) namespaces = previousState.namespaces;
            if (previousState.activeNamespace) activeNamespace = previousState.activeNamespace;

            if (activeNamespace && nsState[activeNamespace]) {
                const state = getNsState(activeNamespace);
                queryInput.value = state.query || '';
                useWildcardsCheckbox.checked = state.useWildcards !== false;
                restoreMaskInputs(state.masks && state.masks.length ? state.masks : DEFAULT_MASKS);
                resultsDiv.innerHTML = state.resultsHtml || '';
                statusDiv.textContent = state.statusText || 'Ready';
                renderHistoryFor(activeNamespace);
                updateSearchButtonsForActiveTab();
                attachListeners();
            }
            renderNamespacePicker();
        }

        // Ask the extension for the current (and always up to date) list of
        // open ISFS namespace folders. The response repopulates the tabs
        // without disturbing the active tab or any tab's state if it's still valid.
        vscode.postMessage({ type: 'ready' });

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
            // Keep the live inputs in sync with the active tab's own state
            // before persisting, so switching away never loses an in-progress edit.
            if (activeNamespace) {
                const state = getNsState(activeNamespace);
                state.query = queryInput.value;
                state.useWildcards = useWildcardsCheckbox.checked;
                state.masks = getMaskValues();
            }
            vscode.setState({ namespaces, activeNamespace, nsState });
        }

        function setNamespaces(list) {
            namespaces = Array.isArray(list) ? list : [];

            // Drop state for namespaces that are no longer open in the explorer.
            const validIds = new Set(namespaces.map(ns => ns.id));
            Object.keys(nsState).forEach(id => {
                if (!validIds.has(id)) delete nsState[id];
            });

            if (namespaces.length === 0) {
                activeNamespace = '';
                searchBtn.disabled = true;
                queryInput.value = '';
                resultsDiv.innerHTML = '';
                historyContainer.innerHTML = '';
                statusDiv.textContent = 'No ISFS namespace folders open.';
                renderNamespacePicker();
                saveState();
                return;
            }

            searchBtn.disabled = false;

            if (!activeNamespace || !validIds.has(activeNamespace)) {
                switchToNamespace(namespaces[0].id);
            } else {
                renderNamespacePicker();
                saveState();
            }
        }

        // Renders both the closed picker button (active namespace name, plus a
        // pulsing dot if that namespace has a search running) and the dropdown
        // list of every open namespace. A vertical list is a better fit for a
        // narrow sidebar than a row of tabs: full names are readable without
        // truncation or horizontal scrolling, and it scales to any number of
        // open namespaces. Each namespace still keeps its own independent
        // search state (see nsState) - this only changes how you pick one.
        function renderNamespacePicker() {
            const activeNs = namespaces.find(ns => ns.id === activeNamespace);

            namespacePickerLabel.innerHTML = '';
            const textSpan = document.createElement('span');
            textSpan.className = 'label-text';
            textSpan.textContent = activeNs
                ? activeNs.label
                : (namespaces.length === 0 ? 'No namespace folders found' : 'Select a namespace');
            namespacePickerLabel.appendChild(textSpan);

            if (activeNs && getNsState(activeNs.id).searching) {
                const dot = document.createElement('span');
                dot.className = 'tab-searching-dot';
                dot.title = 'Search in progress';
                namespacePickerLabel.appendChild(dot);
            }

            namespacePickerBtn.disabled = namespaces.length === 0;
            namespacePickerBtn.title = activeNs ? activeNs.label : '';

            renderNamespaceDropdownOptions();
        }

        function renderNamespaceDropdownOptions() {
            namespaceDropdownEl.innerHTML = '';

            if (namespaces.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'namespace-empty-option';
                empty.textContent = 'No ISFS namespace folders open.';
                namespaceDropdownEl.appendChild(empty);
                return;
            }

            namespaces.forEach(ns => {
                const option = document.createElement('div');
                option.className = 'namespace-option' + (ns.id === activeNamespace ? ' active' : '');
                option.title = ns.label;

                const textSpan = document.createElement('span');
                textSpan.className = 'label-text';
                textSpan.textContent = ns.label;
                option.appendChild(textSpan);

                if (getNsState(ns.id).searching) {
                    const dot = document.createElement('span');
                    dot.className = 'tab-searching-dot';
                    dot.title = 'Search in progress';
                    option.appendChild(dot);
                }

                option.addEventListener('click', () => {
                    closeNamespaceDropdown();
                    if (ns.id !== activeNamespace) switchToNamespace(ns.id);
                });

                namespaceDropdownEl.appendChild(option);
            });
        }

        function openNamespaceDropdown() {
            if (namespaces.length === 0) return;
            namespaceDropdownEl.hidden = false;
            namespacePickerBtn.classList.add('open');
        }

        function closeNamespaceDropdown() {
            namespaceDropdownEl.hidden = true;
            namespacePickerBtn.classList.remove('open');
        }

        function setupNamespacePicker() {
            namespacePickerBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (namespaceDropdownEl.hidden) {
                    openNamespaceDropdown();
                } else {
                    closeNamespaceDropdown();
                }
            });

            document.addEventListener('click', (e) => {
                if (!namespaceDropdownEl.hidden && !namespacePickerEl.contains(e.target)) {
                    closeNamespaceDropdown();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !namespaceDropdownEl.hidden) {
                    closeNamespaceDropdown();
                }
            });
        }

        function switchToNamespace(nsId) {
            activeNamespace = nsId;
            const state = getNsState(nsId);

            queryInput.value = state.query || '';
            useWildcardsCheckbox.checked = state.useWildcards !== false;
            restoreMaskInputs(state.masks && state.masks.length ? state.masks : DEFAULT_MASKS);
            resultsDiv.innerHTML = state.resultsHtml || '';
            statusDiv.textContent = state.statusText || 'Ready';
            renderHistoryFor(nsId);
            updateSearchButtonsForActiveTab();
            attachListeners();
            renderNamespacePicker();
            saveState();
        }

        function updateSearchButtonsForActiveTab() {
            const state = activeNamespace ? getNsState(activeNamespace) : null;
            const searching = !!(state && state.searching);
            searchBtn.style.display = searching ? 'none' : 'block';
            clearBtn.style.display = searching ? 'none' : 'block';
            stopBtn.style.display = searching ? 'block' : 'none';
        }

        function restoreMaskInputs(masks) {
            masksContainer.innerHTML = '';
            if (!masks || masks.length === 0) masks = DEFAULT_MASKS;

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
        useWildcardsCheckbox.addEventListener('change', saveState);
        addMaskBtn.addEventListener('click', () => {
            addMaskRow('', false);
            saveState();
        });

        searchBtn.addEventListener('click', () => {
            const query = queryInput.value.trim();
            const maskList = getMaskValues();
            const useWildcards = useWildcardsCheckbox.checked;

            if (!query) return;
            if (!activeNamespace) {
                statusDiv.textContent = 'Select a namespace to search in.';
                return;
            }

            const nsId = activeNamespace;
            archiveToHistory(nsId);

            const state = getNsState(nsId);
            state.query = query;
            state.useWildcards = useWildcards;
            state.masks = maskList;
            state.resultsHtml = '';
            state.matchCount = 0;
            state.statusText = 'Preparing search...';
            state.searching = true;
            state.activeSearchInfo = { query, mask: maskList.join(' | ') };

            resultsDiv.innerHTML = '';
            statusDiv.textContent = state.statusText;
            updateSearchButtonsForActiveTab();
            renderNamespacePicker();
            saveState();

            vscode.postMessage({ type: 'startSearch', query, masks: maskList, namespaceId: nsId, useWildcards });
        });

        clearBtn.addEventListener('click', () => {
            if (!activeNamespace) return;
            const state = getNsState(activeNamespace);
            state.resultsHtml = '';
            state.matchCount = 0;
            state.history = [];
            state.statusText = 'Ready';
            state.activeSearchInfo = { query: '', mask: '' };

            resultsDiv.innerHTML = '';
            statusDiv.textContent = 'Ready';
            renderHistoryFor(activeNamespace);
            saveState();
        });

        stopBtn.addEventListener('click', () => {
            if (!activeNamespace) return;
            vscode.postMessage({ type: 'stopSearch', namespaceId: activeNamespace });
        });

        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.type === 'namespaceList') {
                setNamespaces(msg.namespaces);
                return;
            }

            // Every other message is tagged with the namespace it belongs to,
            // since a search can be running in a tab that isn't the one
            // currently visible. Update that tab's own state, and only touch
            // the visible DOM when the message is for the active tab.
            const nsId = msg.namespaceId;
            if (!nsId) return;
            const state = getNsState(nsId);
            const isActive = nsId === activeNamespace;

            switch (msg.type) {
                case 'searchStarted':
                    state.searching = true;
                    state.statusText = 'Preparing search...';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    renderNamespacePicker();
                    saveState();
                    break;
                case 'statusUpdate':
                    state.statusText = msg.message;
                    if (isActive) statusDiv.textContent = msg.message;
                    saveState();
                    break;
                case 'addMatches': {
                    const el = buildFileMatchesElement(msg.fileName, msg.uri, msg.matches);
                    state.resultsHtml += el.outerHTML;
                    state.matchCount += msg.matches.length;
                    if (isActive) resultsDiv.appendChild(el);
                    saveState();
                    break;
                }
                case 'searchCompleted':
                    state.searching = false;
                    state.statusText = msg.message || 'Complete.';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    renderNamespacePicker();
                    saveState();
                    break;
                case 'searchStopped':
                case 'error':
                    state.searching = false;
                    state.statusText = msg.message || 'Stopped';
                    if (isActive) {
                        statusDiv.textContent = state.statusText;
                        updateSearchButtonsForActiveTab();
                    }
                    renderNamespacePicker();
                    saveState();
                    break;
            }
        });

        function archiveToHistory(nsId) {
            const state = getNsState(nsId);
            if (!state.matchCount) return;

            const now = new Date();
            const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const entry = {
                query: state.activeSearchInfo.query || state.query,
                mask: state.activeSearchInfo.mask || (state.masks || []).join(' | '),
                totalMatches: state.matchCount,
                timeStr,
                resultsHtml: state.resultsHtml
            };

            state.history.unshift(entry);

            if (nsId === activeNamespace) renderHistoryFor(nsId);
        }

        function renderHistoryFor(nsId) {
            historyContainer.innerHTML = '';
            const entries = getNsState(nsId).history || [];
            entries.forEach(entry => {
                historyContainer.appendChild(buildHistoryTabElement(nsId, entry));
            });
        }

        function buildHistoryTabElement(nsId, entry) {
            const details = document.createElement('details');
            details.className = 'history-tab';

            const summary = document.createElement('summary');

            const leftContainer = document.createElement('div');
            leftContainer.className = 'history-summary-left';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'history-title';
            titleSpan.textContent = '"' + entry.query + '"';

            const subSpan = document.createElement('span');
            subSpan.className = 'history-sub';
            subSpan.textContent = entry.mask + ' (' + entry.totalMatches + ' matches)';

            leftContainer.appendChild(titleSpan);
            leftContainer.appendChild(subSpan);

            const timeSpan = document.createElement('span');
            timeSpan.className = 'history-time';
            timeSpan.textContent = entry.timeStr;

            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'tab-clear-btn';
            deleteBtn.title = 'Clear entry';
            deleteBtn.textContent = '✕';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const state = getNsState(nsId);
                state.history = (state.history || []).filter(item => item !== entry);
                details.remove();
                saveState();
            });

            summary.appendChild(leftContainer);
            summary.appendChild(timeSpan);
            summary.appendChild(deleteBtn);

            const contentDiv = document.createElement('div');
            contentDiv.className = 'history-content';
            contentDiv.innerHTML = entry.resultsHtml;
            contentDiv.querySelectorAll('.match-item').forEach(item => {
                item.addEventListener('click', () => {
                    const uri = item.getAttribute('data-uri');
                    const line = parseInt(item.getAttribute('data-line'), 10);
                    const column = parseInt(item.getAttribute('data-column'), 10);
                    vscode.postMessage({ type: 'openMatch', uri, line, column });
                });
            });

            details.appendChild(summary);
            details.appendChild(contentDiv);

            return details;
        }

        function buildFileMatchesElement(fileName, uri, matches) {
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

            return details;
        }

        function attachListeners() {
            // Re-wires click handlers on the "Current Search" results pane after
            // it is restored verbatim from saved webview state (raw innerHTML
            // restores markup but not the listeners). Search History entries are
            // rebuilt fresh from data via buildHistoryTabElement, which already
            // attaches its own listeners, so nothing to do for those here.
            const items = resultsDiv.querySelectorAll('.match-item');
            items.forEach(item => {
                item.onclick = null;
                item.addEventListener('click', () => {
                    const uri = item.getAttribute('data-uri');
                    const line = parseInt(item.getAttribute('data-line'), 10);
                    const column = parseInt(item.getAttribute('data-column'), 10);
                    vscode.postMessage({ type: 'openMatch', uri, line, column });
                });
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

    // A mask with no package qualifier at all (no dots, e.g. "WBLR*") and a
    // literal prefix has nothing to narrow the search to beyond the root, so
    // rather than walking the entire namespace tree looking for it, treat it
    // as a same-level lookup: only the direct children of the namespace root
    // are checked. Un-packaged classes/routines live directly under the root
    // in ISFS, so this keeps a broad prefix like "WBLR*" fast instead of
    // scanning every package.
    // A mask that does contain a dot (e.g. "Tafnit.App.Something.*") is
    // resolved to its package folder below and searched recursively from there.
    // But a mask that STARTS with a wildcard (e.g. "*LRSHOW*") has no literal
    // prefix at all to anchor on - the match could be nested inside any
    // package - so it falls through to the full recursive walk below instead
    // of being wrongly restricted to just the root folder.
    const startsWithWildcard = cleanMask.startsWith('*') || cleanMask.startsWith('?');
    if (!cleanMask.includes('.') && !startsWithWildcard) {
        return await collectMatchingFilesShallow(rootFolderUri, rootFolderUri, nameFilterRegex, token);
    }

    const lastDotIndex = cleanMask.lastIndexOf('.');
    if (lastDotIndex <= 0) {
        // No package path could be derived at all (e.g. a mask starting with
        // a bare dot) - nothing to narrow the search to.
        return await collectMatchingFiles(rootFolderUri, rootFolderUri, nameFilterRegex, token);
    }

    // Walk down the package path one dot-segment at a time. A literal segment
    // (e.g. "App") is a direct, zero-cost path join - no directory listing
    // needed. Only a wildcarded segment (e.g. "*" in "Tafnit.*.UI.bl.*")
    // requires listing its parent directory, and even then only to fan out
    // over that one level's subdirectories - not to walk every file beneath
    // them. This means a pattern like "Tafnit.*.UI.bl.*" only lists Tafnit's
    // direct children and checks each for a "UI/bl" subpath, instead of
    // recursively walking the entire Tafnit tree (which is what made a
    // mid-path wildcard so slow before).
    const packagePath = cleanMask.substring(0, lastDotIndex);
    const segments = buildPathSegmentPlan(packagePath.split('.'));

    const candidateFolders = await resolveSegmentedFolders(rootFolderUri, segments, 0, token);
    if (candidateFolders.length === 0 || token.isCancellationRequested) return [];

    const nestedFileResults = await mapWithConcurrency(candidateFolders, DIR_CONCURRENCY, token, folderUri =>
        collectMatchingFiles(folderUri, rootFolderUri, nameFilterRegex, token)
    );

    const uniqueFiles = new Map<string, vscode.Uri>();
    for (const list of nestedFileResults) {
        // A batch cancelled partway through leaves later slots unset.
        if (!list) continue;
        for (const uri of list) uniqueFiles.set(uri.toString(), uri);
    }
    return Array.from(uniqueFiles.values());
}

interface PathSegmentMatcher {
    literal: string;
    isWildcard: boolean;
    regex?: RegExp;
}

function buildPathSegmentPlan(parts: string[]): PathSegmentMatcher[] {
    return parts.map(part => {
        if (!part.includes('*') && !part.includes('?')) {
            return { literal: part, isWildcard: false };
        }
        const pattern = part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return { literal: part, isWildcard: true, regex: new RegExp(`^${pattern}$`, 'i') };
    });
}

// Descends through the package-path segments, resolving to every concrete
// folder the pattern could point to. Literal segments narrow the path
// directly with no I/O; wildcard segments list just their parent directory
// to fan out over its subdirectories for the next segment.
async function resolveSegmentedFolders(
    currentUri: vscode.Uri,
    segments: PathSegmentMatcher[],
    index: number,
    token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    if (token.isCancellationRequested) return [];
    if (index >= segments.length) return [currentUri];

    const segment = segments[index];

    if (!segment.isWildcard) {
        const nextUri = vscode.Uri.joinPath(currentUri, segment.literal);
        return resolveSegmentedFolders(nextUri, segments, index + 1, token);
    }

    let entries: [string, vscode.FileType][];
    try {
        await sleep(PAUSE_BETWEEN_READS_MS);
        entries = await vscode.workspace.fs.readDirectory(currentUri);
    } catch {
        return [];
    }

    const matchingDirs = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && segment.regex!.test(name))
        .map(([name]) => vscode.Uri.joinPath(currentUri, name));

    const nestedResults = await mapWithConcurrency(matchingDirs, DIR_CONCURRENCY, token, dirUri =>
        resolveSegmentedFolders(dirUri, segments, index + 1, token)
    );

    const flattened: vscode.Uri[] = [];
    for (const list of nestedResults) {
        // A batch cancelled partway through leaves later slots unset.
        if (!list) continue;
        for (const uri of list) flattened.push(uri);
    }
    return flattened;
}

async function collectMatchingFilesShallow(
    dirUri: vscode.Uri,
    rootFolderUri: vscode.Uri,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken
): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];
    if (token.isCancellationRequested) return fileUris;

    let entries: [string, vscode.FileType][];
    try {
        await sleep(PAUSE_BETWEEN_READS_MS);
        entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
        return fileUris;
    }

    for (const [name, type] of entries) {
        if (token.isCancellationRequested) return fileUris;
        if (type !== vscode.FileType.File) continue;

        const childUri = vscode.Uri.joinPath(dirUri, name);
        let relativePath = childUri.path.substring(rootFolderUri.path.length);
        if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);

        if (nameFilterRegex.test(name) || nameFilterRegex.test(relativePath)) {
            fileUris.push(childUri);
        }
    }

    return fileUris;
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

// Same throttled-concurrency pattern as runWithConcurrency, but collects each
// call's return value instead of assuming void.
async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    token: vscode.CancellationToken,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
        while (index < items.length) {
            if (token.isCancellationRequested) return;
            const i = index++;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
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