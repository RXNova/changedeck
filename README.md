# Changedeck

**JetBrains-style changelists for Git, in VS Code.**

Group your changes into named lists, down to individual changes within a file. Commit only what you check, shelve work you want to put aside, and roll back or export changes as patches.

## Features

**Changelists**
- Create, rename, describe and delete changelists. There is always one *active* list, and new changes land there automatically.
- **Rename Changelist…** (F2 or right-click) opens with the current name selected, so you can type the new name straight away. Duplicate names are flagged as you type. **Edit Description…** edits the changelist's description, which is also its draft commit message.
- Move files between lists by dragging them, or with **Move to Another Changelist…** from the Changes view, Explorer or the editor tab.
- Deleting a list moves its files to the active list. Nothing is lost.
- Untracked files wait in **Unversioned Files** until you move them to a list, check them for a commit, or choose **Add to Git**.
- Works with several repositories in one window. A list can hold files from more than one repository.
- Lists, assignments, commit selections and drafts are saved per workspace and survive restarts.
- The status bar shows the active list. Click it to switch.
- Drag a changelist onto another to reorder them. **Set Color…** gives a list its own color.
- **Link to Branch…** ties a list to a branch: it becomes active whenever that branch is checked out. **Changedeck: Switch Branch…** can also shelve the linked list's changes when you leave a branch and bring them back when you return (`changelists.branch.shelveOnSwitch`).
- Files in a list other than the active one are marked in the Explorer and on editor tabs (◆, or ◐ for a split file).
- To search the Changes tree, focus it and press ⌥⌘F (Ctrl+Alt+F), VS Code's built-in tree find and filter.

**Partial changelists: one file in several lists**
- Changes are tracked line by line. If you edit a file while a different changelist is active, the new change goes to the active list, and the file then appears in both lists (marked *partial*).
- A change keeps its list while you keep editing it.
- Move a single change by right-clicking in the editor and choosing **Move Change to Another Changelist…**. It uses the change under the cursor, or every change touched by your selection. You can also use the light bulb (**Move change to changelist "…"**). In a split file, a label above each change shows its list; click the label to move that change.
- In a split file, each change is marked with a stripe in its changelist's color. The tree uses the same colors.
- If HEAD moves outside VS Code (pull, checkout, rebase), split files keep their changelists.
- Commit, roll back, shelve and create patches for one list's part of a file. **Show Diff** on a partial file shows only that list's changes.
- Each part has its own checkbox in the Changes view.
- **Leave single changes out of a commit:** right-click a change in the editor and choose **Leave Change Out of Commit**, or click **In commit / Not in commit** above it. The file's row shows how many changes are left out. They stay in your working tree for a later commit.
- Turn this off with `changelists.partialChangelists`. Every file then goes back to a single list.

**GitHub Copilot** (needs Copilot signed in; the relevant diff is sent to Copilot)
- **Suggest Changelists with Copilot** proposes how to split a list's files into separate changelists. You tick the groups you want before anything moves.
- **Suggest Name with Copilot** names a changelist or a shelf from its content.
- Generated commit messages and a pre-commit review, described under Commit.

**Commit**
- Check the files to commit in the Changes view. The **Commit** panel commits exactly those files, using their current contents. Anything else you staged stays staged and is not committed.
- The commit message is the changelist's comment, so each list keeps its own draft.
- **Commit Changelist** (✓ on a list) selects that list's files and moves you to the message box.
- **Amend last commit**, including amending only the message. **Commit and Push** (⌘/Ctrl+Shift+Enter in the message box). ⌘/Ctrl+Enter commits.
- Untracked files you check are added as part of the commit.
- The **✨** icon in the Commit panel's title bar (or **Changedeck: Generate Commit Message with Copilot**) writes the message with GitHub Copilot from exactly the changes you checked, including the parts of split files. It also looks at your recent commit subjects to match their style. The text streams into the box; while it is being written the icon becomes a stop button. You need to be signed in to GitHub Copilot in VS Code, and the first time, VS Code asks whether Changedeck may use Copilot. The diff of the checked changes is sent to Copilot.
- **Review Checked Changes with Copilot** (the speech-bubble icon in the Commit panel's title bar) opens a short review of what you are about to commit.
- **Before-commit checks** (settings under `changelists.beforeCommit`): format the checked files, organize imports, warn about errors and new TODO/FIXME comments, and run a command such as `npm run lint` that cancels the commit if it fails.
- **Options → Open the pull request page after Commit and Push** opens GitHub, GitLab or Bitbucket's new pull request page for the branch (or the GitHub Pull Requests extension's form if installed).
- **History…** reuses an earlier commit message.
- Above the Commit buttons, **Committing as Name <email>** shows who the commit will be made as.
- **Options:** Sign-off, Skip Git hooks, and the commit's author. The Name and Email fields show your Git identity; edit them to commit as someone else for one commit, and **Reset** puts your identity back. If Git has no name and email configured, what you enter there is used for the commit.
- Optionally deletes a changelist once its last file has been committed (`changelists.deleteEmptyChangelistAfterCommit`).

**Shelf**
- **Shelve Changes** on a list or on files saves the changes, including untracked and binary files, and reverts them in your working tree.
- **Unshelve** puts the changes back into the changelist they came from. **Unshelve to Changelist…** lets you pick another. If the files have been edited since, each file is merged 3-way. Changes that overlap get conflict markers, and the shelved copy is kept.
- **Unshelve This File**, or **Unshelve Files…** to pick several, restores single files from a shelf and removes them from it.
- Click a shelved file to see its diff, or use **Compare with Current File**. You can rename and delete shelved changes.
- **Export as Patch…** saves a shelf as a patch file, and **Import Patch to Shelf…** turns a patch into a shelf without touching your files. Use them to move work between machines.
- Shelved changes are stored as Git objects under `refs/changelists/shelf/*` in each repository. They never appear in `git stash list` and survive editor restarts and reinstalls.

**Other actions**
- **Rollback…** reverts files, folders or whole lists to HEAD. In a split file, only that list's changes are reverted. Added files are removed from Git but kept on disk. Unversioned files go to the trash.
- **Rollback History…** lists the saved backups so you can restore the files of an earlier rollback.
- **Add to .gitignore** on unversioned files and folders.
- **Rollback can be undone.** Click **Undo** in the notification, or run **Changedeck: Undo Last Rollback**. Files and their changelists come back. A backup snapshot is saved in Git before every rollback, and the last 20 are kept under `refs/changelists/backup/`.
- **Create Patch…** / **Copy as Patch to Clipboard** produce a `git apply`-compatible patch, including binary and untracked files. **Apply Patch…** applies one, falling back to a 3-way merge if needed.
- Click a file to see its diff against HEAD. Renames are shown with their old name.
- Show files as a flat list or as a folder tree.
- **Changedeck: Show Log** opens an output channel listing every Git command the extension ran, with full error output.
- Operations run one at a time and are retried briefly if another Git process holds the index lock.

## Keyboard shortcuts

| Action | macOS | Windows / Linux | Where |
|---|---|---|---|
| Move change under the cursor to another changelist | ⌃⌥M | Alt+Shift+M | Editor |
| Move selected files to another changelist | ⌘⌥M | Ctrl+Alt+M | Changes view |
| Roll back selection | ⌘⌥Z | Ctrl+Alt+Z | Changes view |
| Rename changelist | F2 | F2 | Changes view |
| Show diff | ⌘D | Ctrl+D | Changes view |
| Focus commit message | ⌘⌥K | Ctrl+Alt+Shift+K | Anywhere |
| Switch active changelist | ⌘⌥⇧L | Ctrl+Alt+Shift+L | Anywhere |

All shortcuts can be changed in **Keyboard Shortcuts** (search "Changedeck").

## Settings

| Setting | Default | |
|---|---|---|
| `changelists.viewMode` | `list` | `list` or `tree` |
| `changelists.showUnversionedFiles` | `true` | Show the Unversioned Files group |
| `changelists.untrackedFilesGoToActive` | `false` | Put new untracked files straight into the active list |
| `changelists.confirmRollback` | `true` | Ask before rolling back |
| `changelists.deleteShelfAfterUnshelve` | `true` | Delete shelved changes once they unshelve cleanly |
| `changelists.deleteEmptyChangelistAfterCommit` | `ask` | `ask`, `always` or `never` |
| `changelists.saveBeforeCommit` | `true` | Save open editors for the affected files before committing, shelving, rolling back or creating a patch |
| `changelists.showStatusBar` | `true` | Show the active changelist in the status bar |
| `changelists.partialChangelists` | `true` | Track changes line by line so one file can be split across changelists |
| `changelists.editorMarkers` | `partial` | Mark changes in the editor with their changelist's color: `partial`, `always` or `never` |
| `changelists.commitMessage.instructions` | | Extra instructions for generated commit messages, for example "Use Conventional Commits" |
| `changelists.commitMessage.modelFamily` | | Copilot model family to use, for example `gpt-4o`. Empty uses Copilot's default model |
| `changelists.beforeCommit.format` / `.organizeImports` | `false` | Format or organize imports in the checked files before committing |
| `changelists.beforeCommit.checkProblems` / `.checkTodos` | `false` | Ask before committing files with errors, or changes that add TODO/FIXME |
| `changelists.beforeCommit.command` | | Shell command to run before committing; a failure cancels the commit |
| `changelists.branch.shelveOnSwitch` | `ask` | Shelve a linked list's changes when **Switch Branch…** leaves its branch: `ask`, `always` or `never` |
| `changelists.explorerDecorations` | `true` | Mark files of non-active changelists in the Explorer and on tabs |
| `changelists.codeLens` | `partial` | Show each change's changelist above it in the editor: `partial` (only in split files), `always` or `never` |

## Requirements

- VS Code 1.90 or newer, with the built-in Git extension enabled.
- For generated commit messages: GitHub Copilot, signed in.
- Git 2.26 or newer.

Settings and command IDs keep the `changelists.` prefix.

## Limitations

- Only modified text files can be split. Added, deleted, renamed, binary and conflicted files, and files over 4 MB, always belong to a single changelist.
- When HEAD changes outside VS Code, a change made upstream on the same lines as one of your changes joins that change's changelist. If the old HEAD version is no longer in the repository (for example after aggressive garbage collection), the file goes back to a single list.
- A partial commit replaces the file's staged version with the committed content (you are asked first). Your working copy is not changed.
- **Undo** restores files and their changelists for the last rollback of the session. **Rollback History…** restores file contents of older ones, but not their changelists.
- Changes left out of a commit are forgotten if HEAD changes outside VS Code.
- **Suggest Changelists** groups whole files; it does not split a file's changes across lists.
- Before-commit formatting changes the whole file, so in a split file new formatting changes go to the active changelist.
- During a merge, cherry-pick or revert, Git only allows committing every changed file at once, so you must check all of them.

## Development

```sh
npm install
npm test                    # unit tests plus git integration tests against temporary repositories
npm run test:e2e            # end-to-end test in a downloaded VS Code (set VSCODE_EXECUTABLE to use your own)
./scripts/integration.sh    # macOS: the same end-to-end test in your installed VS Code
npm run package             # builds changedeck-<version>.vsix
```

Press F5 in VS Code to start an Extension Development Host.
