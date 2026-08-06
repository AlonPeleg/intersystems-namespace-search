import * as vscode from 'vscode';

interface SearchResultItem extends vscode.QuickPickItem {
    uri: vscode.Uri;
    line: number;
    column: number;
}

// How many directories / files to process concurrently. isfs round-trips to the
// server, so doing this one-at-a-time is what made the old version feel "stuck".
const DIR_CONCURRENCY = 8;
const FILE_CONCURRENCY = 12;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel("InterSystems Namespace Search");

    let disposable = vscode.commands.registerCommand('intersystems-namespace-search.searchInNamespace', async () => {
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

        outputChannel.clear();
        outputChannel.appendLine(`=== InterSystems Namespace Search ===`);
        outputChannel.appendLine(`Folder: ${selectedFolder.uri.toString()}`);
        outputChannel.appendLine(`Search text: "${searchQuery}"`);
        outputChannel.appendLine(`File mask: "${locationInput}"`);
        outputChannel.appendLine(`Resolved mask regex: ${nameFilterRegex}`);
        outputChannel.show(true);

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Searching "${searchQuery}" in ${selectedFolder.name}...`,
            cancellable: true
        }, async (progress, token) => {
            const stats = { dirsListed: 0, dirErrors: 0, filesMatched: 0, filesRead: 0, readErrors: 0 };

            try {
                progress.report({ message: 'Listing files...' });
                const targetFiles = await collectMatchingFiles(selectedFolder.uri, nameFilterRegex, token, outputChannel, stats);

                outputChannel.appendLine(`\nDirectories listed: ${stats.dirsListed} (errors: ${stats.dirErrors})`);
                outputChannel.appendLine(`Files matching mask: ${targetFiles.length}`);

                if (targetFiles.length === 0) {
                    outputChannel.appendLine(`\nNo files matched the mask "${locationInput}". This means either:`);
                    outputChannel.appendLine(`  1. The mask doesn't match how your files are named/organized, or`);
                    outputChannel.appendLine(`  2. Directory listing failed (see dirErrors above / errors logged during listing).`);
                    vscode.window.showWarningMessage(`No files matched mask "${locationInput}". See output channel for details.`);
                    return;
                }

                const searchRegex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                const results: SearchResultItem[] = [];

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

                        lines.forEach((lineText, lineIdx) => {
                            const regexCopy = new RegExp(searchRegex.source, searchRegex.flags);
                            let match: RegExpExecArray | null;
                            while ((match = regexCopy.exec(lineText)) !== null) {
                                const fileName = getFileNameFromUri(fileUri);
                                results.push({
                                    label: `${fileName}:${lineIdx + 1}`,
                                    description: lineText.trim(),
                                    detail: fileUri.path,
                                    uri: fileUri,
                                    line: lineIdx,
                                    column: match.index
                                });
                                if (!regexCopy.global) break;
                            }
                        });
                    } catch (readErr) {
                        stats.readErrors++;
                        outputChannel.appendLine(`Skip/Error reading ${fileUri.path}: ${readErr}`);
                    }
                }, token);

                outputChannel.appendLine(`\nFiles read: ${stats.filesRead} (read errors: ${stats.readErrors})`);
                outputChannel.appendLine(`Search complete. Found ${results.length} total matches.`);

                if (results.length === 0) {
                    vscode.window.showInformationMessage(
                        `Scanned ${targetFiles.length} matching files but found no occurrences of "${searchQuery}". ` +
                        `If you expected matches, check the output channel — ${stats.readErrors} file(s) failed to read.`
                    );
                    return;
                }

                const selectedMatch = await vscode.window.showQuickPick(results, {
                    placeHolder: `Found ${results.length} matches. Select item to jump:`
                });

                if (selectedMatch) {
                    const doc = await vscode.workspace.openTextDocument(selectedMatch.uri);
                    const editor = await vscode.window.showTextDocument(doc);
                    const pos = new vscode.Position(selectedMatch.line, selectedMatch.column);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            } catch (err) {
                outputChannel.appendLine(`Execution error: ${err}`);
                vscode.window.showErrorMessage(`InterSystems Namespace Search failed: ${err}`);
            }
        });
    });

    context.subscriptions.push(disposable, outputChannel);
}

export function deactivate() {}

/**
 * Runs `fn` over `items` with at most `concurrency` in flight at once.
 * Plain per-item `await` in a for-loop is what made the previous version slow —
 * isfs round-trips to the server, so batching them in parallel matters a lot.
 */
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

/**
 * Walks the ISFS tree in parallel batches, logging every directory-listing
 * error instead of silently swallowing it (the old version's biggest blind spot).
 */
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