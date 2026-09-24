# InterSystems Namespace Search

Studio-style tools for working on InterSystems IRIS code in VS Code, directly on the server:

- **Namespace Search**: fast Find in Files across a whole namespace, run on the server the way Studio does it.
- **Go To**: Studio's `Ctrl+G`. Jump to `label^routine`, `##class(Pkg.Cls).Method`, a line number and more.
- **Open Document (Tree / Flat)**: open any class or routine from a package tree or a flat list, and switch between them.

It works with the server-side (`isfs`) namespace folders you open through the InterSystems extensions
("Edit Code in Namespace"). It reuses that connection, so there is nothing extra to configure.

## Requirements

- [InterSystems ObjectScript](https://marketplace.visualstudio.com/items?itemName=intersystems-community.vscode-objectscript) extension (any version, including 3.0.x)
- A server-side namespace folder (`isfs://...`) open in your workspace
- IRIS or Caché 2017.2+ for server-side search (older servers fall back to a local scan automatically)

## Namespace Search: `Ctrl+Alt+S`

Opens the **ISFS Search** panel in the Activity Bar.

1. **Namespace**: pick which open namespace folder to search. Each namespace keeps its own search text, masks and results, so you can switch between them without losing anything.
2. **Search Text**: case-insensitive. With **Use wildcards** on, `*` matches any characters and `?` matches one. Turn it off to search for a literal `*` or `?`.
3. **File Mask / Package**: limit where to search.
   - `*.cls,*.mac,*.int`: by document type
   - `Pkg.Sub.*`: a package and everything under it
   - `NAME*` (no dot): only items directly at the namespace root, which keeps it fast
   - Press **+** to add more masks.
4. Press **Enter** or **Search**. **Stop** cancels a running search.

Click a result to see its matching lines, then click a line to open the document at that line.
**Search History** keeps your previous searches and their results.

### How it searches

By default the search runs **on the IRIS server** through the Atelier API. That's the same server-side search
Studio's Find in Files uses, so a whole namespace takes seconds.

It automatically falls back to a **local scan**, which lists folders and reads each file, when:

- the server connection can't be resolved,
- the server doesn't support server-side search, or
- the server's Atelier API version is below `serverSideSearchMinApiVersion` (default 4). Older versions were
  found to silently miss matches, so they're scanned locally to keep results complete.

To see which path a search took and why, open **View → Output → ISFS Namespace Search**.

## Go To: `Ctrl+Alt+G`

Studio's Go To dialog. It pre-fills with the reference under your cursor, or your selection.

| You type | It opens |
|---|---|
| `SetTavla^WBLRSHOWFF` | routine `WBLRSHOWFF` at label `SetTavla` |
| `SetTavla+3^WBLRSHOWFF` | 3 lines below that label |
| `$$call^My.Routine(x)` | `$$` and the arguments are ignored |
| `^WBLRSHOWFF` / `^WBLRSHOWFF.int` | the routine at the top, or that exact type |
| `+12^WBLRSHOWFF` | line 12 of the routine |
| `##class(My.App.Cls).Method` | the class, at that method |
| `My.App.Cls.cls` | the class, at the top |
| `SetTavla` / `SetTavla+3` | a label in the current file |
| `42` | line 42 of the current file |

With several namespaces open it asks which one to use. The current file's namespace is listed first, so **Enter** keeps you where you are.

## Open Document (Tree / Flat)

Command: **InterSystems: Open Document (Tree / Flat)** (`isfsNamespaceSearch.openDocument`).
It has no default shortcut. To put it on `Ctrl+Alt+O`, add this to your `keybindings.json`:

```json
{
  "key": "ctrl+alt+o",
  "command": "isfsNamespaceSearch.openDocument",
  "when": "vscode-objectscript.connectActive"
}
```

It has two views of the namespace's documents:

- **Tree**: browse package by package, like the InterSystems ObjectScript extension did up to 3.8.2.
- **Flat**: one filterable list of every document, like 3.8.3 and later.

You can also type a full document name with its extension (e.g. `My.App.Cls.cls`) in either view and press **Enter**.
The title-bar buttons show or hide **System**, **Generated** and **Mapped** documents.

### Keys while the picker is open

| Key | Action |
|---|---|
| `Ctrl+T` (or your open shortcut again) | Switch Tree / Flat |
| `Alt+Left` | Up one package |
| `Backspace` (filter empty) | Up one package |
| `Ctrl+H` | Back to the namespace root |

These keys only work while this picker is open. Everywhere else they keep their usual VS Code behaviour.
Holding `Backspace` deletes your filter text and stops at the empty filter, so press it again to go up.
The **←** and **Home** buttons in the title bar do the same as the keys and stay visible however far you scroll.

Switching Flat → Tree starts at the namespace root. Switching Tree → Flat keeps your filter text.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `isfsNamespaceSearch.useServerSideSearch` | `true` | Search on the IRIS server (fast). Off = always use the local scan. |
| `isfsNamespaceSearch.serverSideSearchMinApiVersion` | `4` | Servers below this Atelier API version use the local scan, for complete results. |
| `isfsNamespaceSearch.serverSearchMaxResults` | `5000` | Maximum matches requested per server-side search (the API's own default is 200). |
| `isfsNamespaceSearch.allowSelfSignedCert` | `false` | Accept a self-signed HTTPS certificate when talking to the server directly. Only for trusted dev servers. |
| `isfsNamespaceSearch.dirConcurrency` | `6` | Local scan: folder listings run in parallel. |
| `isfsNamespaceSearch.fileConcurrency` | `8` | Local scan: files read in parallel. |
| `isfsNamespaceSearch.pauseBetweenReadsMs` | `0` | Local scan: delay before each server read, to go easier on a busy server. |
| `isfsNamespaceSearch.openDocument.defaultMode` | `last` | Which view Open Document starts in: `last`, `tree` or `flat`. |

## Credentials

The extension talks to the server with the connection details the InterSystems ObjectScript extension provides.
Newer versions of that extension (3.8.x) only share a password stored in plain text in your `intersystems.servers` settings.
If searches fall back to the local scan, or Open Document says no password is available, store the password there.

## Credits

Open Document's list queries and name validation are adapted from the
[InterSystems ObjectScript extension](https://github.com/intersystems-community/vscode-objectscript) (MIT).
See `THIRD_PARTY_NOTICES.md`.
