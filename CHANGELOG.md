# Changelog

## 1.7.8

- Fixed: when Git converts line endings (`core.autocrlf`, the default on Windows) but a file on disk uses the other style, every line counted as changed. That broke splitting the file across changelists, partial commits, and unshelving into it. Line-ending-only differences are now ignored, as Git does.
- The tests no longer depend on the machine's Git line-ending defaults.

## 1.7.7

- Fixed: dragging files onto a changelist did nothing. The dragged files were carried in a way VS Code did not hand back on drop; they now travel as the extension's own data type. A failed drop is also reported instead of being ignored.
- Added a real drag-and-drop test (`npm run test:dnd`, macOS) that performs genuine drags in an isolated VS Code window.

## 1.7.6

- The Shelf section starts collapsed, so the Changes list gets most of the sidebar. It opens when you click it or shelve something.
- The Commit panel is more compact, so the Commit buttons stay visible without scrolling.
- In a split file, "N changes left out" is now counted per changelist instead of showing the file's total under every list.
- Screenshots in the README.

## 1.7.5

- The Commit panel's buttons and input boxes use the same 4px rounded corners as VS Code's own commit button and inputs.

## 1.7.4

- The Commit panel shows **Committing as Name <email>** above the Commit and Commit and Push buttons. It follows the author fields, and warns when the author is incomplete or Git has no identity configured.

## 1.7.3

- The author's Name and Email fields now show your current Git identity (from the repository's Git config). Edit them to commit as someone else for one commit; **Reset** restores your identity.
- If Git has no name and email configured, the values you enter are used as both author and committer, so the commit works.

## 1.7.2

- The author for one commit is now entered in two fields, **Name** and **Email**. Both are needed; a missing field or an invalid email is flagged and the Commit buttons stay disabled until it is fixed.

## 1.7.1

- The sidebar sections are back in their intended order: Changes, Commit, Shelf. (The sidebar got a new internal ID so that a previously saved layout no longer applies. If you had rearranged the sections yourself, arrange them once more.)

## 1.7.0

- The extension is now called **Changedeck**. Commands appear as "Changedeck: …" in the Command Palette, and the sidebar, log and settings section carry the new name. Setting and command IDs still start with `changelists.`, so existing settings and keybindings keep working.
- Because the extension ID changed, changelists saved by the old "Changelists" extension are not carried over. Shelves and rollback backups live in the Git repository and are still there.

## 1.6.2

- New extension icon: three floating changelist tiles, the top one lifted and checked for commit. The sidebar icon matches it.

## 1.6.0

**Commit**
- Leave single changes out of a commit: **In commit / Not in commit** above each change, the editor's right-click menu, or the light bulb.
- Before-commit checks: format, organize imports, warn about errors and new TODO/FIXME comments, and run a command that can cancel the commit.
- Option to open the pull request page after Commit and Push (GitHub, GitLab, Bitbucket).

**GitHub Copilot**
- **Suggest Changelists with Copilot** proposes how to split a list into separate changelists.
- **Suggest Name with Copilot** for changelists and shelves.
- **Review Checked Changes with Copilot** before committing.

**Changelists**
- Link a changelist to a branch; it becomes active when the branch is checked out. **Switch Branch…** can shelve and restore the linked list's changes.
- Drag changelists to reorder them, and give a list its own color.
- Files of non-active changelists are marked in the Explorer and on editor tabs.
- **Add to .gitignore** for unversioned files and folders.

**Shelf and rollback**
- **Rollback History…** restores the files of earlier rollbacks.
- **Compare with Current File**, **Export as Patch…** and **Import Patch to Shelf…**.

**Other**
- A Getting Started walkthrough on first install and a "What's new" note after updates.
- The Changes view lists changelists in your own order (the active one is no longer forced to the top).

## 1.5.1

- Removed the duplicate **Generate** link inside the Commit panel. Use the ✨ icon in the panel's title bar; it turns into a stop button while a message is being written.

## 1.5.0

- **Generate commit messages with GitHub Copilot.** Click **✨ Generate** in the Commit panel. The message is written from exactly the checked changes (including parts of split files), follows the style of your recent commits, and streams into the box; you can stop it at any time.
- New settings `changelists.commitMessage.instructions` and `changelists.commitMessage.modelFamily`.
- Requires VS Code 1.90 or newer.

## 1.4.0

- **Edit Changelist…** is split into **Rename Changelist…** (F2) and **Edit Description…**. Rename is a single step that opens with the current name selected.
- The Changes view stays a native VS Code tree (the 1.3.0 web view panel was reverted).

## 1.2.0

**Stability**
- Operations that change files or Git state (commit, rollback, shelve, unshelve, apply patch, add) run one at a time, and line tracking pauses while they run.
- Git commands are retried briefly when another Git process (such as VS Code's Git extension) holds the index lock.
- New **Changelists** output channel (**Changelists: Show Log**) records every Git command and error. Error messages have a **Show Log** button.
- **Rollback can be undone.** Rollback first saves a backup snapshot in Git. **Undo**, in the notification or as **Changelists: Undo Last Rollback**, restores the files and their changelists, and warns before overwriting files edited since. The last 20 backups are kept under `refs/changelists/backup/`.
- Split files keep their changelists when HEAD moves outside VS Code (pull, checkout, rebase). The ranges are carried over by diffing the old HEAD version against the new one.
- Warns before a partial commit replaces a file's staged version.
- Paths that differ only in case are matched on macOS and Windows. Fixed path handling in the partial diff view and Shelf view on Windows.
- The diff engine anchors on unique lines before running Myers' algorithm, so large, heavily edited files get exact changes instead of one big block.

**Features**
- Changes in the editor are marked with a stripe in their changelist's color (`changelists.editorMarkers`). Tree icons use the same colors, and you can customize the colors as `changelists.list1`–`changelists.list8`.
- Light bulb actions: "Move change to changelist …" for the change under the cursor or the changes in the selection.
- Commit message history (**History…** in the Commit panel, or **Changelists: Commit Message History…**).
- Commit options: Sign-off, Skip Git hooks, and an author override for one commit.
- **Unshelve Files…** lets you pick which files of a shelf to restore. You can also select several shelved files and unshelve them together.
- Keyboard shortcuts:
  - Move Change: ⌃⌥M on macOS, Alt+Shift+M on Windows and Linux (in the editor)
  - In the Changes view: Move ⌘⌥M / Ctrl+Alt+M, Rollback ⌘⌥Z / Ctrl+Alt+Z, Rename F2, Diff ⌘D / Ctrl+D
  - Focus commit message: ⌘⌥K / Ctrl+Alt+Shift+K
  - Switch active changelist: ⌘⌥⇧L / Ctrl+Alt+Shift+L
- Extension icon. The extension is now bundled into one file for faster startup.

## 1.1.0

- Partial changelists: a file's changes can be split across changelists, line by line.
- Commit, roll back, shelve, diff and create patches for one changelist's part of a file.
- Unshelving merges into files edited since they were shelved. **Unshelve This File** restores a single file.

## 1.0.0

- Changelists with an active list, drag and drop, per-file commit selection and a commit panel with amend and push.
- Shelf stored under `refs/changelists/shelf/`, rollback, patches, list and tree views, multi-root support.
