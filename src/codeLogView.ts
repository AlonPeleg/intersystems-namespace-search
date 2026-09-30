import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// The Code Log "Details" panel: a webview with two main tabs - Overview (a
// status tree of the whole log) and Item (the selected entry's log: title,
// status, tags, Notes / Journal / To-do / Info). The page itself lives in
// media/codeLogView.js + .css; this class only hosts it and passes messages.
// ---------------------------------------------------------------------------

export class CodeLogView implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private lastState: unknown;
    private lastReason = 'update';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly onMessage: (msg: any) => void,
        private readonly getState: () => unknown
    ) {}

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        view.webview.html = this.html(view.webview, media);
        view.webview.onDidReceiveMessage((m) => {
            if (m?.type === 'ready') {
                // The page (re)loaded: give it the current log straight away.
                this.lastState = this.getState();
                this.post();
            }
            else this.onMessage(m);
        });
        view.onDidDispose(() => (this.view = undefined));
    }

    /** `reason` 'selection' tells the page to switch to the Item tab. */
    show(state: unknown, reason: 'selection' | 'update' = 'update') {
        this.lastState = state;
        this.lastReason = reason;
        this.post();
    }

    private post() {
        if (this.lastState === undefined) return;
        this.view?.webview.postMessage({ type: 'state', state: this.lastState, reason: this.lastReason });
    }

    private html(webview: vscode.Webview, media: vscode.Uri): string {
        const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codeLogView.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'codeLogView.js'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}
