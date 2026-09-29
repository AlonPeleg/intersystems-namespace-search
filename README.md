# InterSystems Namespace Search

Studio-style tools for working on InterSystems IRIS code in VS Code, directly on the server:

- **Namespace Search**: fast Find in Files across a whole namespace, run on the server the way Studio does it.
- **Go To**: Studio's `Ctrl+G`. Jump to `label^routine`, `##class(Pkg.Cls).Method`, a line number and more.
- **Open Document (Tree / Flat)**: open any class or routine from a package tree or a flat list, and switch between them.
- **Code Log**: your own notes about documents, labels and methods, organised in folders, with a title and description for each.
- **Bookmarks**: mark lines with `Ctrl+F2`, jump between them with `F2`, and see them all in the sidebar. They follow your edits.

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

### Opening several files at once

Click the **checklist** button in the title bar to turn on checkbox mode:

- Click a file, or press `Ctrl+Enter` on the highlighted one, to tick it. Do the same again to untick it.
- Ticks are kept when you move between packages and when you switch Tree / Flat, so you can collect files from anywhere.
- VS Code shows a checkbox on every row. Clicking a package or `..` goes into it or up, rather than ticking it.
- Press **Enter** (or **OK**) to open every ticked file, each in its own tab.
- The title shows how many files are ticked. Clicking the button again turns checkbox mode off and clears the ticks.

### Keys while the picker is open

| Key | Action |
|---|---|
| `Ctrl+T` (or your open shortcut again) | Switch Tree / Flat |
| `Alt+Left` | Up one package |
| `Backspace` (filter empty) | Up one package |
| `Ctrl+H` | Back to the namespace root |
| `Ctrl+Enter` (checkbox mode) | Tick / untick the highlighted file |

These keys only work while this picker is open. Everywhere else they keep their usual VS Code behaviour.
Holding `Backspace` deletes your filter text and stops at the empty filter, so press it again to go up.
The **←** and **Home** buttons in the title bar do the same as the keys and stay visible however far you scroll.

Switching Flat → Tree starts at the namespace root. Switching Tree → Flat keeps your filter text.

## Bookmarks

Works in server-side (`isfs`) documents.

| Key | Action |
|---|---|
| `Ctrl+F2` | Toggle a bookmark on the current line (on every cursor's line, with multiple cursors) |
| `F2` | Jump to the next bookmark in this file (wraps around) |
| `Ctrl+Alt+F2` | Clear this file's bookmarks |

These keys only apply in `isfs` documents. Elsewhere `F2` is still Rename Symbol.

Bookmarked lines get a yellow marker in the gutter and on the scrollbar.
The **ISFS Bookmarks** sidebar lists them by namespace → document → bookmark. Each bookmark shows its label and offset
(e.g. `SetTavla+3`, or the class method it's in) and its line number. Click one to jump there.
The buttons on each row delete one bookmark, clear a document, or clear a whole namespace.

**Bookmarks follow the text.** Adding or deleting lines above a bookmark moves it with its line, and editing
the bookmarked line keeps it. Deleting the bookmarked line removes the bookmark.
This only tracks edits made in VS Code. If a document changes elsewhere (in Studio, or on the server), a bookmark can end up on a different line.

Bookmarks are saved per workspace.

### No preview tabs for server documents

A single click on an `isfs` document opens it as a regular tab rather than a preview tab (the one in *italics* that
the next file replaces). Turn this off with `isfsNamespaceSearch.pinIsfsEditors`. To get the same behaviour for all
files, use VS Code's own `workbench.editor.enablePreview: false` instead.

## Code Log: `Ctrl+Alt+L`

Its own sidebar icon; `Ctrl+Alt+L` opens it. Keep notes about server-side code: which documents belong to a project and what each
document, label and method does.

- **Folders and subfolders**, to any depth: any name, in Hebrew, English or both. **New Folder** in the panel's title bar
  creates a top-level folder; the folder icon on a folder row (or right-click → **New Subfolder**) creates one inside it.
- **Documents** (`.cls`, `.mac`, `.int`) sit in folders. Each has a **title** and a **description**.
- **Labels / methods / class methods** sit under their document, also with a title and description.

**Adding things**

- Right-click in a server-side document → **Add to Code Log...**. If the cursor is inside a label or method, you can add
  that member or the whole document, then pick a folder and give it a title. Adding only lets you pick an existing
  folder or subfolder; create folders in the panel.
- In the panel: **+** on a folder adds documents with the Tree / Flat picker (checkbox mode works, so you can add several).
  **+** on a document lists its labels or methods to pick from.
- Drag documents or subfolders onto another folder (or a subfolder onto empty space to make it a project), or right-click →
  **Move to Folder...**. **Copy to Folder...** makes a copy instead, with all its notes. Projects themselves can't be
  moved or copied. Right-click → **Remove** or **Rename** as needed.
- In the tree, an entry with a title shows the **title** as its main text and the document or method name beside it.

**Groups inside a document**

A document with many logged labels / methods can be organised into **groups**:

- Right-click a document → **New Group...**. Groups have a name (Hebrew / English) and a description, like everything else.
- Put members in a group by dragging them onto it, or right-click a member → **Move to Group...** (which can also
  create a new group). Members not in a group are listed after the groups.
- Drag members onto each other to reorder them, onto a group to join it, or onto the document to take them out of their group.
  Drag groups onto each other to reorder groups. Members stay within their own document.
- **+** on a group adds labels / methods straight into it. Each group shows a count badge and collapses like a folder.
- Removing a group keeps its members: they just become ungrouped.

**Details panel**

Select anything in the tree to see it in **Details** below: its namespace, folder path, document (and method), then its
title and description, which you edit there. Changes save as you type.
Text direction follows what you type, so Hebrew works as expected.

**Going to the code**

The **Go to code** arrow on a row (or button in Details) opens the document, or the document at that label or method.
Members are found by **name** when you click, so they still work after the code is edited.
This only works while that server and namespace is open in your workspace. Otherwise the entry is greyed out and
marked "(not open)", but it stays in the log.

**Projects**

Top-level folders are **projects**. They have their own icon and an emphasised name, so they stand out from subfolders.

**Saving, export and import**

The log is saved in VS Code on this computer.

- **Export** in the title bar saves the whole log as a JSON file.
- **Export Project** (the export icon on a project row, or right-click) saves just that project with its subfolders.
  Subfolders can't be exported on their own.
- **Import** in the title bar reads either kind of file:
  - a **project** you don't have yet is simply added;
  - a project with the same name as one of yours offers **Merge**, **Replace** (just that project) or **Add as a copy**;
  - a file with **several projects** (e.g. a whole-log export) shows a checklist of its projects, all ticked, each
    marked *new* or *already exists*. Untick any you don't want. If some ticked ones already exist, a second list asks
    which to **overwrite**; unticked ones are **merged** into yours. New ones are added, and projects that aren't in
    the file are never touched.

Export and import dialogs open on your Desktop and save to / read from your own computer.

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
| `isfsNamespaceSearch.pinIsfsEditors` | `true` | Open `isfs` documents as regular tabs, not preview tabs. |

## Credentials

This extension never asks for a password and never shows VS Code's "wants to sign in" dialog.

**Open Document** lists documents through your `isfs` namespace folder, using the connection the InterSystems extension
already made when you added the namespace. It needs no password of its own.
The flat list has to go through the folder one package at a time, so on a big namespace it fills in over a few seconds.
It's then kept for 3 minutes; the **Reload** button in the title bar refreshes it.

**Server-side search**, and a faster Open Document flat list, need to talk to the server directly. They use a password
when one is available without asking:

1. **`settings.json`** (`intersystems.servers`), or whatever the InterSystems ObjectScript extension provides.
   On 3.0.x that includes the password you typed for **Add Server Namespace to Workspace**.
2. **Server Manager's saved login**, if you've allowed this extension to use it: Accounts menu → *InterSystems Server
   Credentials* → your login → **Manage Trusted Extensions** → tick InterSystems Namespace Search.

Without one, search uses the slower local scan and Open Document uses the `isfs` folder. Both still work.

**InterSystems: Forget Stored Password...** removes a password saved by versions 1.4.1 and 1.4.2.

## Credits

Open Document's list queries and name validation are adapted from the
[InterSystems ObjectScript extension](https://github.com/intersystems-community/vscode-objectscript) (MIT).
See `THIRD_PARTY_NOTICES.md`.
