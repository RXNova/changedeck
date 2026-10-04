import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ask, diffBudget, handledNoModel, pickModel } from './ai';
import { ChangesView, isNode } from './changesView';
import { Commands, Target } from './commands';
import { buildNamePrompt, buildReviewPrompt, buildSplitPrompt, cleanName, parseSplitResponse } from './core/aiSplit';
import * as git from './core/git';
import { FileChange } from './core/types';
import { COLOR_NAMES } from './editorDecorations';
import { log } from './log';
import { gitContentUri, isShelfNode, ShelfFileNode, ShelfNode, ShelfView } from './shelfView';
import { ChangelistState, UNVERSIONED } from './state';

/**
 * Commands beyond the core workflow: branch links, colors, .gitignore, rollback history,
 * shelf import/export, and the GitHub Copilot helpers.
 */
export class Extras implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	/** Last seen branch per repository, to notice checkouts. */
	private readonly branches = new Map<string, string | undefined>();

	constructor(
		private readonly state: ChangelistState,
		private readonly changes: ChangesView,
		private readonly shelf: ShelfView,
		private readonly commands: Commands,
	) {
		const exclusive = new Set(['changelists.switchBranch', 'changelists.rollbackHistory', 'changelists.importShelf', 'changelists.addToGitignore']);
		const reg = (id: string, fn: (...args: any[]) => unknown) =>
			this.disposables.push(vscode.commands.registerCommand(id, (...args: unknown[]) => commands.guard(() =>
				exclusive.has(id) ? commands.exclusive(id.replace('changelists.', ''), async () => fn.apply(this, args)) : fn.apply(this, args))));

		reg('changelists.setColor', this.setColor);
		reg('changelists.linkBranch', this.linkBranch);
		reg('changelists.unlinkBranch', (arg?: unknown) => { const id = commands.listArg(arg); if (id) { state.mutate(m => m.setBranch(id, undefined)); } });
		reg('changelists.switchBranch', this.switchBranch);
		reg('changelists.addToGitignore', this.addToGitignore);
		reg('changelists.rollbackHistory', this.rollbackHistory);
		reg('changelists.compareShelfWithCurrent', this.compareShelfWithCurrent);
		reg('changelists.exportShelf', this.exportShelf);
		reg('changelists.importShelf', this.importShelf);
		reg('changelists.suggestChangelists', this.suggestChangelists);
		reg('changelists.suggestName', this.suggestName);
		reg('changelists.suggestShelfName', this.suggestShelfName);
		reg('changelists.reviewChanges', this.reviewChanges);

		this.disposables.push(state.onDidChange(() => this.watchBranches()));
		this.watchBranches(true);
	}

	// ---- Branch links -----------------------------------------------------------------------

	/** Makes the changelist linked to a branch active when that branch gets checked out. */
	private watchBranches(initial = false): void {
		for (const repo of this.state.repos.all) {
			const root = repo.rootUri.fsPath;
			const branch = repo.state.HEAD?.name;
			const known = this.branches.has(root);
			const previous = this.branches.get(root);
			this.branches.set(root, branch);
			if (initial || !known || !branch || branch === previous) { continue; }
			const linked = this.state.model.findByBranch(branch);
			if (linked && linked.id !== this.state.model.active.id) {
				log().info(`Branch ${branch} checked out: activating changelist "${linked.name}"`);
				this.state.mutate(m => m.setActive(linked.id));
			}
		}
	}

	private currentBranch(): { root: string; branch: string } | undefined {
		const repos = this.state.repos.all;
		const editor = vscode.window.activeTextEditor?.document.uri;
		const repo = (editor?.scheme === 'file' ? this.state.repos.repositoryOf(editor.fsPath) : undefined) ?? repos[0];
		const branch = repo?.state.HEAD?.name;
		return repo && branch ? { root: repo.rootUri.fsPath, branch } : undefined;
	}

	private async linkBranch(arg?: unknown): Promise<void> {
		const id = this.commands.listArg(arg) ?? (await this.commands.pickList('Link Changelist to Branch'));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const current = this.currentBranch();
		if (!current) { throw new Error('No branch is checked out.'); }
		const branches = await git.localBranches(this.state.repos.git(current.root));
		const picked = await vscode.window.showQuickPick(
			branches.map(b => ({ label: b, description: b === current.branch ? 'current' : this.state.model.findByBranch(b) ? `linked to "${this.state.model.findByBranch(b)!.name}"` : '' })),
			{ title: `Link "${list.name}" to a Branch`, placeHolder: 'The changelist becomes active when this branch is checked out' },
		);
		if (!picked) { return; }
		this.state.mutate(m => {
			m.setBranch(list.id, picked.label);
			if (picked.label === current.branch) { m.setActive(list.id); }
		});
	}

	/**
	 * Checks out another branch and takes the changelists along: changes of the list linked to the
	 * branch being left are shelved (if enabled), and changes shelved for the target branch return.
	 */
	private async switchBranch(): Promise<void> {
		const root = await this.commands.pickRepo('Switch Branch in Repository');
		if (!root) { return; }
		const repo = this.state.repos.git(root);
		const from = this.state.repos.repository(root)?.state.HEAD?.name;
		const branches = (await git.localBranches(repo)).filter(b => b !== from);
		if (!branches.length) {
			void vscode.window.showInformationMessage('There is no other local branch to switch to.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			branches.map(b => ({ label: b, description: this.state.model.findByBranch(b) ? `changelist "${this.state.model.findByBranch(b)!.name}"` : '' })),
			{ title: 'Switch Branch', placeHolder: from ? `Currently on ${from}` : 'Choose a branch' },
		);
		if (!picked) { return; }
		const to = picked.label;

		const linked = from ? this.state.model.findByBranch(from) : undefined;
		const mode = vscode.workspace.getConfiguration('changelists.branch').get<string>('shelveOnSwitch', 'ask');
		if (linked && from && mode !== 'never') {
			const files = this.state.filesOf(linked.id).filter(c => c.repoRoot === root);
			if (files.length) {
				let shelve = mode === 'always';
				if (mode === 'ask') {
					const choice = await vscode.window.showInformationMessage(
						`Shelve the ${files.length} changed file${files.length === 1 ? '' : 's'} of "${linked.name}" and bring them back when you return to ${from}?`,
						{ modal: true }, 'Shelve and Switch', 'Take Changes Along');
					if (!choice) { return; }
					shelve = choice === 'Shelve and Switch';
				}
				if (shelve) {
					const targets: Target[] = files.map(change => ({ change, list: this.state.model.isPartial(change.path) ? linked.id : undefined }));
					await this.commands.shelveTargets(targets, `⎇ ${from}`, linked.name, from);
				}
			}
		}

		await repo.run(['checkout', to]);
		await this.commands.afterGitChange([root]);
		await this.shelf.reload();

		// Bring back what was shelved when this branch was left.
		for (const node of this.shelf.all().filter(s => s.root === root && s.branch === to)) {
			const listId = (node.listName && this.state.model.findByName(node.listName)?.id) || this.state.model.findByBranch(to)?.id || this.state.model.active.id;
			const files = await this.shelf.filesOf(node);
			await this.commands.expectFiles(files.map(f => path.join(root, ...f.path.split('/'))), listId);
			const result = await git.unshelve(repo, node.ref.sha);
			if (result.conflicts) {
				void vscode.window.showWarningMessage(`The changes shelved for ${to} conflicted with the branch. Resolve the conflict markers; the shelved copy was kept.`);
			} else {
				await git.deleteShelf(repo, node.ref.ref);
				await this.shelf.setMeta(node.ref.id, undefined);
			}
		}
		await this.commands.afterGitChange([root]);
		await this.shelf.reload();
	}

	// ---- Appearance and .gitignore ----------------------------------------------------------

	private async setColor(arg?: unknown): Promise<void> {
		const id = this.commands.listArg(arg) ?? (await this.commands.pickList('Set Changelist Color'));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const picked = await vscode.window.showQuickPick(
			[{ label: 'Automatic', description: 'by position', slot: 0 }, ...COLOR_NAMES.map((name, i) => ({ label: name, description: list.color === i + 1 ? 'current' : '', slot: i + 1 }))],
			{ title: `Color of "${list.name}"`, placeHolder: 'The colors can be changed in settings.json (workbench.colorCustomizations, changelists.list1 … list8)' },
		);
		if (picked) { this.state.mutate(m => m.setColor(list.id, picked.slot || undefined)); }
	}

	private async addToGitignore(arg?: unknown, all?: unknown): Promise<void> {
		const nodes = (Array.isArray(all) && all.length ? all : arg ? [arg] : this.changes.selection()).filter(isNode);
		const entries = new Map<string, Set<string>>();
		for (const node of nodes) {
			if (node.type === 'folder') {
				const root = node.files[0]?.repoRoot;
				if (root) { add(root, '/' + path.relative(root, node.dir).split(path.sep).join('/') + '/'); }
			} else {
				for (const c of this.changes.filesUnder(node)) {
					if (c.untracked && node.type === 'file') { add(c.repoRoot, '/' + this.state.relative(c)); }
				}
			}
		}
		function add(root: string, line: string): void { entries.set(root, (entries.get(root) ?? new Set()).add(line)); }
		if (!entries.size) {
			void vscode.window.showInformationMessage('Select unversioned files or folders to ignore.');
			return;
		}
		for (const [root, lines] of entries) {
			const file = path.join(root, '.gitignore');
			const existing = await fs.readFile(file, 'utf8').catch(() => '');
			const have = new Set(existing.split(/\r?\n/).map(l => l.trim()));
			const fresh = [...lines].filter(l => !have.has(l));
			if (fresh.length) {
				await fs.writeFile(file, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n');
			}
		}
		await this.commands.afterGitChange(entries.keys());
	}

	// ---- Rollback history -------------------------------------------------------------------

	private async rollbackHistory(): Promise<void> {
		const items: (vscode.QuickPickItem & { root: string; backup: git.BackupInfo })[] = [];
		for (const repo of this.state.repos.all) {
			const root = repo.rootUri.fsPath;
			for (const backup of await git.listBackups(this.state.repos.git(root))) {
				const names = backup.paths.map(p => path.posix.basename(p));
				items.push({
					root, backup,
					label: names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : ''),
					description: new Date(backup.date).toLocaleString() + (this.state.repos.count > 1 ? ` · ${path.basename(root)}` : ''),
					detail: backup.paths.join('  '),
				});
			}
		}
		if (!items.length) {
			void vscode.window.showInformationMessage('There are no rollback backups yet. A backup is saved each time you roll back.');
			return;
		}
		const picked = await vscode.window.showQuickPick(items.sort((a, b) => b.backup.date - a.backup.date), {
			title: 'Rollback History', placeHolder: 'Choose a rollback to restore the files as they were before it', matchOnDetail: true,
		});
		if (!picked) { return; }
		const ok = await vscode.window.showWarningMessage(
			`Restore ${picked.backup.paths.length} file${picked.backup.paths.length === 1 ? '' : 's'} to their state before this rollback?`,
			{ modal: true, detail: `Their current content will be overwritten:\n${picked.backup.paths.join('\n')}` }, 'Restore');
		if (ok !== 'Restore') { return; }
		try {
			await git.restoreBackup(this.state.repos.git(picked.root), picked.backup);
		} finally {
			await this.commands.afterGitChange([picked.root]);
		}
	}

	// ---- Shelf extras -----------------------------------------------------------------------

	private async compareShelfWithCurrent(node?: ShelfFileNode): Promise<void> {
		if (!node || node.type !== 'shelfFile') { return; }
		const { shelf, file } = node;
		const current = vscode.Uri.file(path.join(shelf.root, ...file.path.split('/')));
		const shelved = gitContentUri(shelf.root, file.status === 'D' ? '' : file.untracked ? `${shelf.ref.sha}^3` : shelf.ref.sha, file.path);
		await vscode.commands.executeCommand('vscode.diff', shelved, current, `${path.posix.basename(file.path)} (Shelved: ${shelf.name} ↔ Current)`, { preview: true });
	}

	private async exportShelf(node?: ShelfNode): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.commands.pickShelf('Export Shelved Changes');
		if (!shelf) { return; }
		const patch = await git.exportShelf(this.state.repos.git(shelf.root), shelf.ref.sha);
		const target = await vscode.window.showSaveDialog({
			title: 'Export Shelved Changes',
			defaultUri: vscode.Uri.file(path.join(shelf.root, `${shelf.name.replace(/[^\w.-]+/g, '_')}.patch`)),
			filters: { Patches: ['patch', 'diff'] },
		});
		if (!target) { return; }
		await vscode.workspace.fs.writeFile(target, Buffer.from(patch, 'utf8'));
		void vscode.window.showInformationMessage(`Exported "${shelf.name}" to ${path.basename(target.fsPath)}.`);
	}

	private async importShelf(): Promise<void> {
		const root = await this.commands.pickRepo('Import Patch to Shelf');
		if (!root) { return; }
		const [file] = await vscode.window.showOpenDialog({
			title: 'Import Patch to Shelf', canSelectMany: false, defaultUri: vscode.Uri.file(root),
			filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
		}) ?? [];
		if (!file) { return; }
		const name = await vscode.window.showInputBox({
			title: 'Import Patch to Shelf', prompt: 'Name for the shelved changes',
			value: path.basename(file.fsPath).replace(/\.(patch|diff)$/i, '').replace(/_/g, ' '),
			validateInput: v => v.trim() ? undefined : 'Enter a name.',
		});
		if (!name) { return; }
		const id = randomUUID();
		await git.importShelf(this.state.repos.git(root), await fs.readFile(file.fsPath, 'utf8'), name.trim(), id);
		await this.shelf.setMeta(id, { name: name.trim() });
		await this.shelf.reload();
		await vscode.commands.executeCommand('changelists.shelf.focus');
	}

	// ---- GitHub Copilot ---------------------------------------------------------------------

	/** Runs a Copilot request with a cancellable progress notification. Undefined if unavailable or cancelled. */
	private async withModel<T>(title: string, run: (model: vscode.LanguageModelChat, token: vscode.CancellationToken) => Promise<T>): Promise<T | undefined> {
		let model: vscode.LanguageModelChat;
		try { model = await pickModel(); } catch (e) { if (handledNoModel(e)) { return undefined; } throw e; }
		try {
			return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${title} (${model.name})…`, cancellable: true },
				(_p, token) => run(model, token));
		} catch (e) {
			if (e instanceof vscode.CancellationError) { return undefined; }
			throw e;
		}
	}

	private async diffOf(files: FileChange[], listId?: string): Promise<string> {
		return this.commands.selectionDiff(files.map(change => ({
			change, lists: listId && this.state.model.isPartial(change.path) ? [listId] : undefined,
		})));
	}

	/** Asks Copilot to group the changes of a list into changelists; the user reviews before anything moves. */
	async suggestChangelists(arg?: unknown): Promise<'done' | 'unavailable' | 'nothing'> {
		const listId = this.commands.listArg(arg) ?? this.state.model.active.id;
		const list = this.state.model.get(listId)!;
		// Whole files only: files split across lists stay as they are.
		const files = this.state.filesOf(listId).filter(c => !this.state.model.isPartial(c.path));
		if (files.length < 2) {
			void vscode.window.showInformationMessage(`"${list.name}" needs at least two files to split.`);
			return 'nothing';
		}
		const byRel = new Map(files.map(c => [this.state.relative(c), c]));
		const diff = await this.diffOf(files);
		const answer = await this.withModel('Grouping changes', (model, token) =>
			ask(model, buildSplitPrompt(diff, [...byRel.keys()], this.state.model.all().map(l => l.name), diffBudget(model)), token));
		if (answer === undefined) { return 'unavailable'; }
		const { proposals } = parseSplitResponse(answer, [...byRel.keys()]);
		if (proposals.length < 2 && proposals[0]?.name.toLowerCase() === list.name.toLowerCase()) {
			void vscode.window.showInformationMessage('Copilot suggests keeping these changes together.');
			return 'nothing';
		}
		if (!proposals.length) {
			void vscode.window.showInformationMessage('Copilot did not suggest a grouping.');
			return 'nothing';
		}
		const picked = await vscode.window.showQuickPick(
			proposals.map(p => ({ label: p.name, description: `${p.files.length} file${p.files.length === 1 ? '' : 's'}`, detail: `${p.description ? p.description + ' — ' : ''}${p.files.join(', ')}`, picked: true, proposal: p })),
			{ title: `Suggested Changelists for "${list.name}"`, canPickMany: true, placeHolder: 'Untick the groups you do not want. Files of unticked groups stay where they are.' },
		);
		if (!picked?.length) { return 'nothing'; }
		this.state.mutate(m => {
			for (const { proposal } of picked) {
				const target = m.findByName(proposal.name) ?? m.create(proposal.name, proposal.description);
				m.move(proposal.files.map(f => byRel.get(f)!.path), target.id);
			}
		});
		return 'done';
	}

	private async suggestName(arg?: unknown): Promise<void> {
		const id = this.commands.listArg(arg) ?? (await this.commands.pickList('Suggest Changelist Name'));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const files = this.state.filesOf(list.id);
		if (!files.length) {
			void vscode.window.showInformationMessage(`"${list.name}" has no changes to name it after.`);
			return;
		}
		const diff = await this.diffOf(files, list.id);
		const answer = await this.withModel('Suggesting a name', (model, token) => ask(model, buildNamePrompt(diff, 'changelist', diffBudget(model)), token));
		if (answer === undefined) { return; }
		const name = await vscode.window.showInputBox({
			title: 'Rename Changelist', prompt: 'Suggested by Copilot. Edit or press Enter to accept.', value: cleanName(answer),
			validateInput: v => this.state.model.validateName(v, list.id),
		});
		if (name?.trim() && name.trim() !== list.name) { this.state.mutate(m => m.edit(list.id, name.trim(), list.comment)); }
	}

	private async suggestShelfName(node?: ShelfNode): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.commands.pickShelf('Suggest Shelf Name');
		if (!shelf) { return; }
		const diff = await git.exportShelf(this.state.repos.git(shelf.root), shelf.ref.sha);
		const answer = await this.withModel('Suggesting a name', (model, token) => ask(model, buildNamePrompt(diff, 'shelf', diffBudget(model)), token));
		if (answer === undefined) { return; }
		const name = await vscode.window.showInputBox({
			title: 'Rename Shelved Changes', prompt: 'Suggested by Copilot. Edit or press Enter to accept.', value: cleanName(answer),
			validateInput: v => v.trim() ? undefined : 'Enter a name.',
		});
		if (!name?.trim()) { return; }
		await this.shelf.setMeta(shelf.ref.id, { name: name.trim(), listName: shelf.listName, branch: shelf.branch });
		await this.shelf.reload();
	}

	/** Asks Copilot to review the checked changes and opens the review as a Markdown document. */
	async reviewChanges(): Promise<'done' | 'unavailable' | 'nothing'> {
		const selection = this.state.selection();
		if (!selection.length) {
			void vscode.window.showInformationMessage('Check the changes to review first.');
			return 'nothing';
		}
		const diff = await this.commands.selectionDiff(selection);
		if (!diff.trim()) { return 'nothing'; }
		const answer = await this.withModel('Reviewing changes', (model, token) => ask(model, buildReviewPrompt(diff, diffBudget(model)), token));
		if (answer === undefined) { return 'unavailable'; }
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# Review of ${selection.length} checked file${selection.length === 1 ? '' : 's'}\n\n${answer.trim()}\n` });
		await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
		return 'done';
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}

/**
 * Shows in the Explorer and on editor tabs which changelist a file is in, for files outside the
 * active changelist (files in the active one are the normal case and stay unmarked).
 */
export class ChangelistFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<undefined>();
	readonly onDidChangeFileDecorations = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly state: ChangelistState) {
		this.disposables.push(
			vscode.window.registerFileDecorationProvider(this),
			state.onDidChange(() => this.emitter.fire(undefined)),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('changelists.explorerDecorations')) { this.emitter.fire(undefined); } }),
		);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'file') { return undefined; }
		const change = this.state.change(uri.fsPath);
		if (!change) { return undefined; }
		// Rows of the Changes tree carry this fragment: they get the plain Git status (the tree
		// already shows the changelist), and other providers' decorations do not apply to them.
		if (uri.fragment === TREE_FRAGMENT) {
			const status = STATUS[change.kind];
			return { badge: status.badge, tooltip: status.tooltip, color: new vscode.ThemeColor(status.color), propagate: false };
		}
		if (uri.fragment || !vscode.workspace.getConfiguration('changelists').get('explorerDecorations', true)) { return undefined; }
		const lists = this.state.model.listsOf(change.path).filter(id => id !== UNVERSIONED);
		const activeId = this.state.model.active.id;
		if (!lists.length || (lists.length === 1 && lists[0] === activeId)) { return undefined; }
		const names = lists.map(id => this.state.model.get(id)?.name).filter(Boolean);
		return {
			badge: lists.length > 1 ? '◐' : '◆',
			tooltip: lists.length > 1 ? `Changelists: ${names.join(', ')}` : `Changelist: ${names[0]}`,
			propagate: false,
		};
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}

/** Marks resource URIs of rows in the Changes tree. */
export const TREE_FRAGMENT = 'changelists';

const STATUS: Record<FileChange['kind'], { badge: string; tooltip: string; color: string }> = {
	modified: { badge: 'M', tooltip: 'Modified', color: 'gitDecoration.modifiedResourceForeground' },
	added: { badge: 'A', tooltip: 'Added', color: 'gitDecoration.addedResourceForeground' },
	deleted: { badge: 'D', tooltip: 'Deleted', color: 'gitDecoration.deletedResourceForeground' },
	renamed: { badge: 'R', tooltip: 'Renamed', color: 'gitDecoration.renamedResourceForeground' },
	copied: { badge: 'C', tooltip: 'Copied', color: 'gitDecoration.addedResourceForeground' },
	untracked: { badge: 'U', tooltip: 'Unversioned', color: 'gitDecoration.untrackedResourceForeground' },
	conflicted: { badge: '!', tooltip: 'Conflicted', color: 'gitDecoration.conflictingResourceForeground' },
	typechange: { badge: 'T', tooltip: 'Type changed', color: 'gitDecoration.modifiedResourceForeground' },
};

const VERSION_KEY = 'changelists.lastVersion';

/** After an update, offers the changelog once. A first install opens the walkthrough instead. */
export function announceVersion(context: vscode.ExtensionContext): void {
	const current = String(context.extension.packageJSON.version);
	const previous = context.globalState.get<string>(VERSION_KEY);
	if (previous === current) { return; }
	void context.globalState.update(VERSION_KEY, current);
	if (context.extensionMode !== vscode.ExtensionMode.Production) { return; }
	if (!previous) {
		void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#changelists.gettingStarted`, false);
		return;
	}
	void vscode.window.showInformationMessage(`Changedeck was updated to ${current}.`, "See What's New").then(choice => {
		if (choice) { void vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'CHANGELOG.md')); }
	});
}
