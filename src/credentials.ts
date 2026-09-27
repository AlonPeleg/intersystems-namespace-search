import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Passwords for talking to the server directly (fast Open Document flat
// list, server-side search). Found without ever asking, in this order:
//
//   1. settings.json / the InterSystems ObjectScript extension's own API.
//      (3.0.x also hands over the password you typed for "Add Server
//      Namespace to Workspace"; 3.8.x only hands over a plain-text one.)
//   2. Server Manager's saved login - only if you've already allowed this
//      extension to use it (Accounts menu > Manage Trusted Extensions).
//   3. A password stored by this extension (versions 1.4.1-1.4.2 could
//      save one).
//
// Nothing here prompts or triggers VS Code's "wants to sign in" dialog:
// without a password, Open Document lists through the isfs folder and
// search uses the local scan.
// ---------------------------------------------------------------------------

type Logger = (message: string) => void;

export type PasswordSource = 'settings' | 'serverManager' | 'secret';

export interface Credential {
    username: string;
    password: string;
    source: PasswordSource;
}

const AUTH_PROVIDER = 'intersystems-server-credentials'; // Server Manager's authentication provider
const STORED_KEYS = 'isfsNamespaceSearch.storedPasswordKeys';

let ctx: vscode.ExtensionContext | undefined;
const changedEmitter = new vscode.EventEmitter<void>();
/** Fires when a stored password is added or removed, so cached connections can be dropped. */
export const onDidChangeCredentials = changedEmitter.event;

function secretKey(serverName: string, username: string): string {
    return `isfsNamespaceSearch.password:${serverName.toLowerCase()}:${username.toLowerCase()}`;
}

export function isUnauthenticated(username: string | undefined): boolean {
    return !username || username.toLowerCase() === 'unknownuser';
}

export function basicAuthHeader(c: { username: string; password: string }): string {
    return 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64');
}

/**
 * The exact Server Manager account for this server + user. Without it,
 * newer VS Code versions show a picker of every InterSystems login
 * ("Sign in to pery-test with... / phoenix-29 with...").
 */
function serverManagerAccount(serverName: string, username: string): vscode.AuthenticationSessionAccountInformation {
    try {
        const api = vscode.extensions.getExtension('intersystems-community.servermanager')?.exports;
        const fromApi = api?.getAccount?.({ name: serverName, username });
        if (fromApi?.id) return fromApi;
    } catch {
        // fall through to the same format Server Manager uses
    }
    return { id: `${serverName}/${username}`, label: `${username} on ${serverName}` };
}

async function fromServerManager(serverName: string, username: string, log: Logger): Promise<string | undefined> {
    try {
        const account = serverManagerAccount(serverName, username);
        const session = await vscode.authentication.getSession(
            AUTH_PROVIDER,
            [serverName, username],
            { silent: true, account }
        );
        return session?.accessToken || undefined;
    } catch (e: any) {
        // Server Manager not installed, or the user cancelled / declined.
        log(`  Server Manager login for ${username}@${serverName} not available: ${e?.message || e}`);
        return undefined;
    }
}

async function deleteSecret(serverName: string, username: string) {
    if (!ctx) return;
    await ctx.secrets.delete(secretKey(serverName, username));
    const keys = ctx.globalState.get<{ server: string; user: string }[]>(STORED_KEYS, []);
    await ctx.globalState.update(
        STORED_KEYS,
        keys.filter((k) => secretKey(k.server, k.user) !== secretKey(serverName, username))
    );
    changedEmitter.fire();
}

/**
 * Finds a password for `username` on `serverName` without asking anything.
 * `provided` is whatever the InterSystems extension's API returned.
 */
export async function getCredential(
    serverName: string,
    username: string,
    provided: string | undefined,
    opts: { log: Logger }
): Promise<Credential | undefined> {
    if (provided) return { username, password: provided, source: 'settings' };

    const fromSm = await fromServerManager(serverName, username, opts.log);
    if (fromSm) return { username, password: fromSm, source: 'serverManager' };

    const secret = ctx ? await ctx.secrets.get(secretKey(serverName, username)) : undefined;
    if (secret) return { username, password: secret, source: 'secret' };

    return undefined;
}

/** Drops a password this extension stored (e.g. after the server rejected it). */
export async function forgetStoredPassword(serverName: string, username: string) {
    await deleteSecret(serverName, username);
}

export function registerCredentials(context: vscode.ExtensionContext) {
    ctx = context;
    context.subscriptions.push(
        changedEmitter,
        vscode.commands.registerCommand('isfsNamespaceSearch.clearStoredPassword', async () => {
            const keys = context.globalState.get<{ server: string; user: string }[]>(STORED_KEYS, []);
            if (!keys.length) {
                vscode.window.showInformationMessage('No passwords are stored by InterSystems Namespace Search.');
                return;
            }
            const picked = await vscode.window.showQuickPick(
                keys.map((k) => ({ label: k.server, description: k.user, key: k })),
                { placeHolder: 'Forget the stored password for which server?' }
            );
            if (!picked) return;
            await deleteSecret(picked.key.server, picked.key.user);
            vscode.window.showInformationMessage(`Forgot the stored password for ${picked.key.user}@${picked.key.server}.`);
        })
    );
}
