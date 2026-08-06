import * as vscode from 'vscode';

interface MatchResult {
    fileName: string;
    line: number;
    column: number;
    lineText: string;
    uri: vscode.Uri;
}

const DIR_CONCURRENCY = 8;
const FILE_CONCURRENCY = 12;

class FileResultTreeItem extends vscode.TreeItem {
    constructor(
        public readonly fileName: string,
        public readonly uri: vscode.Uri,
        public readonly matches: MatchResult[]
    ) {
        super(fileName, vscode.TreeItemCollapsibleState.Expanded);
        this.description = `${matches.length} match${matches.length > 1 ? 'es' : ''}`;
        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = uri;
    }
}

class MatchResultTreeItem extends vscode.TreeItem {
    constructor(public readonly match: MatchResult) {
        super(match.lineText.trim(), vscode.TreeItemCollapsibleState.None);
        this.description = `line ${match.line + 1}`;
        this.iconPath = new vscode.ThemeIcon('symbol-property');
        
        this.command = {
            command: 'vscode.open',
            title: 'Open Match',
            arguments: [
                match.uri,
                {
                    selection: new vscode.Range(match.line, match.column, match.line, match.column),
                    preview: true
                }
            ]
        };
    }
}

class ISFSSearchTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private resultsMap: Map<string, MatchResult[]> = new Map();
    private uriMap: Map<string, vscode.Uri> = new Map();

    clear(): void {
        this.resultsMap.clear();
        this.uriMap.clear();
        this._onDidChangeTreeData.fire();
    }

    addMatches(fileUri: vscode.Uri, matches: MatchResult[]): void {
        if (matches.length === 0) return;
        const key = fileUri.path;
        this.resultsMap.set(key, matches);
        this.uriMap.set(key, fileUri);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const items: FileResultTreeItem[] = [];
            for (const [key, matches] of this.resultsMap.entries()) {
                const uri = this.uriMap.get(key)!;
                const fileName = key.split('/').pop() || key;
                items.push(new FileResultTreeItem(fileName, uri, matches));
            }
            return items;
        }

        if (element instanceof FileResultTreeItem) {
            return element.matches.map(m => new MatchResultTreeItem(m));
        }

        return [];
    }
}

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel("InterSystems Namespace Search");
    const treeProvider = new ISFSSearchTreeProvider();
    
    vscode.window.registerTreeDataProvider('isfsNamespaceSearchView', treeProvider);

    const clearCommand = vscode.commands.registerCommand('intersystems-namespace-search.clearResults', () => {
        treeProvider.clear();
        outputChannel.appendLine("Search results cleared.");
    });

    const searchCommand = vscode.commands.registerCommand('intersystems-namespace-search.searchInNamespace', async () => {
        const isfsFolders = vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'isfs' || f.uri.scheme === 'isfs-readonly'
        );

        if (!isfsFolders || isfsFolders.length === 0) {
            vscode.window.showErrorMessage("No active ISFS namespace found. Please connect to an InterSystems server.");
            return;
        }

        let selectedFolder = isfsFolders[0];
        if (isfsFolders.length > 1) {
            const picks = isfsFolders.map(f => ({
                label: f.name,
                description: `${f.uri.scheme}://${f.uri.authority}`,
                folder: f
            }));
            const selection = await vscode.window.showQuickPick(picks, { placeHolder: "Select Namespace / Server:" });
            if (!selection) return;
            selectedFolder = selection.folder;
        }

        const searchQuery = await vscode.window.showInputBox({
            prompt: "Search string",
            placeHolder: "e.g., SetTavla or test123"
        });
        if (!searchQuery) return;

        const locationInput = await vscode.window.showInputBox({
            prompt: "Search in (File mask or Package)",
            placeHolder: "e.g., WBLRSHOW*.int OR *.cls,*.int OR Tafnit.Universe.*",
            value: "*.cls,*.mac,*.int"
        });
        if (locationInput === undefined) return;

        const nameFilterRegex = convertLocationInputToRegex(locationInput);

        treeProvider.clear();
        outputChannel.clear();
        outputChannel.appendLine(`=== InterSystems Namespace Search ===`);
        outputChannel.appendLine(`Folder: ${selectedFolder.uri.toString()}`);
        outputChannel.appendLine(`Search text: "${searchQuery}"`);
        outputChannel.appendLine(`File mask: "${locationInput}"`);
        outputChannel.appendLine(`Resolved mask regex: ${nameFilterRegex}`);
        outputChannel.show(true);

        // Focus sidebar panel right away so user sees results appearing live
        vscode.commands.executeCommand('isfsNamespaceSearchView.focus');

        // Runs inside window.withProgress with location Notification to keep status visible without blocking UI
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Searching "${searchQuery}" in ${selectedFolder.name}...`,
            cancellable: true
        }, async (progress, token) => {
            const stats = { dirsListed: 0, dirErrors: 0, filesMatched: 0, filesRead: 0, readErrors: 0, totalMatches: 0 };

            try {
                progress.report({ message: 'Listing files...' });
                const targetFiles = await collectMatchingFiles(selectedFolder.uri, nameFilterRegex, token, outputChannel, stats);

                outputChannel.appendLine(`\nDirectories listed: ${stats.dirsListed} (errors: ${stats.dirErrors})`);
                outputChannel.appendLine(`Files matching mask: ${targetFiles.length}`);

                if (targetFiles.length === 0) {
                    outputChannel.appendLine(`\nNo files matched mask "${locationInput}".`);
                    vscode.window.showWarningMessage(`No files matched mask "${locationInput}".`);
                    return;
                }

                const searchRegex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                let processedCount = 0;

                await runWithConcurrency(targetFiles, FILE_CONCURRENCY, async (fileUri) => {
                    if (token.isCancellationRequested) return;
                    processedCount++;
                    stats.filesRead++;
                    
                    progress.report({
                        message: `Scanning ${processedCount} of ${targetFiles.length} files`,
                        increment: (1 / targetFiles.length) * 100
                    });

                    try {
                        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
                        const content = new TextDecoder('utf-8').decode(fileBytes);
                        const lines = content.split(/\r?\n/);
                        const fileMatches: MatchResult[] = [];

                        lines.forEach((lineText, lineIdx) => {
                            const regexCopy = new RegExp(searchRegex.source, searchRegex.flags);
                            let match: RegExpExecArray | null;
                            while ((match = regexCopy.exec(lineText)) !== null) {
                                const fileName = getFileNameFromUri(fileUri);
                                fileMatches.push({
                                    fileName,
                                    line: lineIdx,
                                    column: match.index,
                                    lineText,
                                    uri: fileUri
                                });
                                stats.totalMatches++;
                                if (!regexCopy.global) break;
                            }
                        });

                        if (fileMatches.length > 0) {
                            treeProvider.addMatches(fileUri, fileMatches);
                        }
                    } catch (readErr) {
                        stats.readErrors++;
                        outputChannel.appendLine(`Skip/Error reading ${fileUri.path}: ${readErr}`);
                    }
                }, token);

                outputChannel.appendLine(`\nFiles read: ${stats.filesRead} (read errors: ${stats.readErrors})`);
                outputChannel.appendLine(`Search complete. Found ${stats.totalMatches} total matches.`);

                if (stats.totalMatches === 0) {
                    vscode.window.showInformationMessage(
                        `Scanned ${targetFiles.length} matching files but found no occurrences of "${searchQuery}".`
                    );
                }
            } catch (err) {
                outputChannel.appendLine(`Execution error: ${err}`);
                vscode.window.showErrorMessage(`InterSystems Namespace Search failed: ${err}`);
            }
        });
    });

    context.subscriptions.push(searchCommand, clearCommand, outputChannel);
}

export function deactivate() {}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
    token: vscode.CancellationToken
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

async function collectMatchingFiles(
    dirUri: vscode.Uri,
    nameFilterRegex: RegExp,
    token: vscode.CancellationToken,
    outputChannel: vscode.OutputChannel,
    stats: { dirsListed: number; dirErrors: number; filesMatched: number }
): Promise<vscode.Uri[]> {
    const fileUris: vscode.Uri[] = [];

    async function walk(currentUri: vscode.Uri) {
        if (token.isCancellationRequested) return;

        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(currentUri);
            stats.dirsListed++;
        } catch (e) {
            stats.dirErrors++;
            outputChannel.appendLine(`Directory read failed for ${currentUri.path}: ${e}`);
            return;
        }

        const subDirs: vscode.Uri[] = [];
        for (const [name, type] of entries) {
            const childUri = vscode.Uri.joinPath(currentUri, name);
            if (type === vscode.FileType.Directory) {
                subDirs.push(childUri);
            } else if (type === vscode.FileType.File) {
                const relativePath = childUri.path.startsWith('/') ? childUri.path.substring(1) : childUri.path;
                if (nameFilterRegex.test(name) || nameFilterRegex.test(relativePath)) {
                    fileUris.push(childUri);
                    stats.filesMatched++;
                }
            }
        }

        await runWithConcurrency(subDirs, DIR_CONCURRENCY, walk, token);
    }

    await walk(dirUri);
    return fileUris;
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
    let result = mask;

    if (result.includes('.') && !result.endsWith('.cls') && !result.endsWith('.mac') && !result.endsWith('.int')) {
        const parts = result.split('.');
        const lastPart = parts.pop() || '.*';
        const packagePath = parts.join('/');
        result = `${packagePath}/${lastPart}`;
    }

    let regexStr = result
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    if (!mask.endsWith('.cls') && !mask.endsWith('.mac') && !mask.endsWith('.int')) {
        regexStr += '\\.(cls|mac|int)';
    }

    return regexStr;
}

function getFileNameFromUri(uri: vscode.Uri): string {
    return uri.path.split('/').pop() || 'Unknown';
}