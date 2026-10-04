import { exec } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangesView, isNode } from './changesView';
import { CommitRequest, CommitView } from './commitView';
import * as git from './core/git';
import { PartialFile } from './core/model';
import { ask, diffBudget, handledNoModel, pickModel } from './ai';
import { addedTodos } from './core/aiSplit';
import { buildCommitPrompt, cleanCommitMessage } from './core/commitPrompt';
import { pullRequestUrl } from './core/remote';
import { rangesAfterCommit } from './core/partial';
import { FileChange } from './core/types';
import { eligible, PartSelection, PartialTracker } from './partialTracker';
import { API } from './gitApi';
import { ShelfFile } from './core/git';
import { isShelfNode, ShelfFileNode, ShelfNode, ShelfView } from './shelfView';
import { log, showError } from './log';
import { ChangelistState, UNVERSIONED } from './state';

const NEW_LIST = Symbol('new');
export const PART_SCHEME = 'changelists-part';

/** A file a command applies to; `list` limits it to that list's changes of a partial file. */
export interface Target {
	change: FileChange;
	list?: string;
}

interface RollbackRecord {
	backups: { root: string; backup: git.Backup }[];
	/** Which list (or list parts) each file was in, to put it back on undo. */
	lists: { path: string; listId?: string; partial?: PartialFile }[];
	/** Content hash of each file right after the rollback, to detect edits made since. */
	after: Map<string, string | undefined>;
}

async function hashFile(file: string): Promise<string | undefined> {
	try { return createHash('sha1').update(await fs.readFile(file)).digest('hex'); } catch { return undefined; }
}

export class Commands implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private lastRollback: RollbackRecord | undefined;
	private generating: vscode.CancellationTokenSource | undefined;
	commitView!: CommitView;

	constructor(
		private readonly state: ChangelistState,
		private readonly api: API,
		private readonly changes: ChangesView,
		private readonly shelf: ShelfView,
		private readonly tracker: PartialTracker,
	) {
		const exclusive = new Set([
			'changelists.commit', 'changelists.commitAndPush', 'changelists.rollback', 'changelists.shelve', 'changelists.unshelve',
			'changelists.unshelveTo', 'changelists.unshelveFile', 'changelists.unshelveFiles', 'changelists.applyPatch',
			'changelists.addToVcs', 'changelists.undoRollback', 'changelists.deleteShelf',
		]);
		const reg = (id: string, fn: (...args: any[]) => unknown) =>
			this.disposables.push(vscode.commands.registerCommand(id, (...args: unknown[]) => this.guard(() =>
				exclusive.has(id) && !id.startsWith('changelists.commit')
					? this.exclusive(id.replace('changelists.', ''), async () => fn.apply(this, args))
					: fn.apply(this, args))));

		reg('changelists.newChangelist', this.newChangelist);
		reg('changelists.renameChangelist', this.renameChangelist);
		reg('changelists.editDescription', this.editDescription);
		reg('changelists.deleteChangelist', this.deleteChangelist);
		reg('changelists.setActive', this.setActive);
		reg('changelists.switchActive', this.switchActive);
		reg('changelists.moveToChangelist', this.moveToChangelist);
		reg('changelists.moveFilesTo', this.moveFilesTo);
		reg('changelists.commitChangelist', this.commitChangelist);
		reg('changelists.commit', () => this.commitFromPalette(false));
		reg('changelists.commitAndPush', () => this.commitFromPalette(true));
		reg('changelists.rollback', this.rollback);
		reg('changelists.shelve', this.shelve);
		reg('changelists.unshelve', (n?: ShelfNode) => this.unshelve(n, false));
		reg('changelists.unshelveTo', (n?: ShelfNode) => this.unshelve(n, true));
		reg('changelists.deleteShelf', this.deleteShelf);
		reg('changelists.renameShelf', this.renameShelf);
		reg('changelists.openShelfDiff', (n: ShelfFileNode) => this.shelf.openDiff(n));
		reg('changelists.unshelveFile', this.unshelveFile);
		reg('changelists.unshelveFiles', this.unshelveFiles);
		reg('changelists.moveChange', this.moveChange);
		reg('changelists.excludeChange', (uri?: unknown, hunks?: unknown) => this.setChangeInCommit(uri, hunks, false));
		reg('changelists.includeChange', (uri?: unknown, hunks?: unknown) => this.setChangeInCommit(uri, hunks, true));
		reg('changelists.openDiff', this.openDiff);
		reg('changelists.openFile', this.openFile);
		reg('changelists.createPatch', this.createPatch);
		reg('changelists.copyPatch', this.copyPatch);
		reg('changelists.applyPatch', this.applyPatch);
		reg('changelists.addToVcs', this.addToVcs);
		reg('changelists.include', (a?: unknown, b?: unknown[]) => this.setIncluded(a, b, true));
		reg('changelists.exclude', (a?: unknown, b?: unknown[]) => this.setIncluded(a, b, false));
		reg('changelists.includeAll', () => this.state.mutate(m => m.setIncludedExactly(this.state.allChanges().filter(c => this.state.model.listsOf(c.path).length).map(c => c.path))));
		reg('changelists.excludeAll', () => this.state.mutate(m => m.setIncludedExactly([])));
		reg('changelists.viewAsTree', () => vscode.workspace.getConfiguration('changelists').update('viewMode', 'tree', vscode.ConfigurationTarget.Global));
		reg('changelists.viewAsList', () => vscode.workspace.getConfiguration('changelists').update('viewMode', 'list', vscode.ConfigurationTarget.Global));
		reg('changelists.showLog', () => log().show());
		reg('changelists.undoRollback', this.undoRollback);
		reg('changelists.moveHunksTo', (uri: vscode.Uri, indices: number[], listId: string) => this.tracker.moveHunks(uri.fsPath, indices, listId));
		reg('changelists.focusCommit', () => this.commitView.focus());
		reg('changelists.commitMessageHistory', () => this.commitView.pickFromHistory());
		reg('changelists.generateCommitMessage', () => this.generateCommitMessage());
		reg('changelists.stopGeneratingCommitMessage', () => this.generating?.cancel());
		reg('changelists.refresh', async () => { await this.state.repos.refresh(); await this.shelf.reload(); });
	}

	/** Shows errors from any command as a notification instead of failing silently. */
	async guard(fn: () => unknown): Promise<unknown> {
		try {
			return await fn();
		} catch (e) {
			void showError(e instanceof Error ? e.message : String(e), e);
			return undefined;
		}
	}

	private queue: Promise<unknown> = Promise.resolve();
	private queued = 0;

	/**
	 * Runs operations that change files or Git state one at a time, with line tracking paused,
	 * so a double click or two quick commands cannot interleave.
	 */
	exclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
		if (this.queued > 0) { log().info(`${label} is waiting for the previous operation to finish`); }
		this.queued++;
		const run = this.queue.then(async () => {
			log().info(label);
			try {
				return await this.tracker.paused(fn);
			} finally {
				this.queued--;
			}
		});
		this.queue = run.catch(() => undefined);
		return run;
	}

	// ---- Target resolution ------------------------------------------------------------------

	/**
	 * Files a command applies to. Tree commands receive (clicked, selection); Explorer and editor
	 * menus receive (uri, uris). With no arguments, the tree selection or the active editor is used.
	 * A partial file under a changelist node stands for that list's changes only.
	 */
	targets(arg?: unknown, all?: unknown): Target[] {
		let items: unknown[];
		if (Array.isArray(all) && all.length && (arg === undefined || all.includes(arg))) { items = all; } else if (arg !== undefined) { items = [arg]; } else {
			const editor = vscode.window.activeTextEditor?.document.uri;
			const selection = this.changes.visible ? this.changes.selection() : [];
			items = selection.length ? selection : editor ? [editor] : [];
		}
		const result = new Map<string, Target>();
		const add = (t: Target) => {
			const existing = result.get(t.change.path);
			if (!existing) { result.set(t.change.path, t); } else if (existing.list !== t.list) { result.set(t.change.path, { change: t.change }); }
		};
		for (const item of items) {
			if (Array.isArray(item)) { item.forEach(t => add(t as Target)); continue; }
			if (isNode(item)) {
				const owner = this.changes.ownerOfNode(item);
				for (const c of this.changes.filesUnder(item)) {
					add({ change: c, list: owner !== UNVERSIONED && this.state.model.isPartial(c.path) ? owner : undefined });
				}
			} else if (item instanceof vscode.Uri && item.scheme === 'file') {
				const c = this.state.change(item.fsPath);
				if (c) { add({ change: c }); }
			}
		}
		return [...result.values()];
	}

	changesOf(targets: Target[]): FileChange[] { return targets.map(t => t.change); }

	/**
	 * Splits partial targets: content for the targeted lists, the rest, and how hunks map to lists.
	 * Targets whose file turns out not to be partial are left out (they are handled as whole files).
	 */
	async partsOf(targets: { change: FileChange; lists?: string[] }[], forCommit = false): Promise<Map<string, PartSelection>> {
		const parts = new Map<string, PartSelection>();
		for (const t of targets) {
			if (!t.lists && !forCommit) { continue; }
			const sel = await this.tracker.selection(t.change, t.lists, forCommit);
			if (sel) { parts.set(t.change.path, sel); }
		}
		return parts;
	}

	listTargets(targets: Target[]): { change: FileChange; lists?: string[] }[] {
		return targets.map(t => ({ change: t.change, lists: t.list ? [t.list] : undefined }));
	}

	/** The changelist a command was invoked on, or (from a keyboard shortcut) the selected one. */
	listArg(arg: unknown): string | undefined {
		if (isNode(arg)) { return arg.type === 'list' ? arg.list.id : undefined; }
		const selection = this.changes.selection();
		if (arg === undefined && selection.length === 1) {
			const node = selection[0];
			if (node.type === 'list') { return node.list.id; }
		}
		return undefined;
	}

	byRepo<T extends FileChange | { change: FileChange }>(items: T[]): Map<string, T[]> {
		const map = new Map<string, T[]>();
		for (const item of items) {
			const root = 'change' in item ? item.change.repoRoot : (item as FileChange).repoRoot;
			const list = map.get(root) ?? [];
			list.push(item);
			map.set(root, list);
		}
		return map;
	}

	async saveDocuments(changes: FileChange[]): Promise<void> {
		if (!vscode.workspace.getConfiguration('changelists').get('saveBeforeCommit', true)) { return; }
		const paths = new Set(changes.map(c => c.path));
		await Promise.all(vscode.workspace.textDocuments
			.filter(d => d.isDirty && d.uri.scheme === 'file' && paths.has(d.uri.fsPath))
			.map(d => d.save()));
	}

	async afterGitChange(roots: Iterable<string>): Promise<void> {
		await this.state.repos.refresh(roots);
	}

	// ---- Changelists ------------------------------------------------------------------------

	private async askName(title: string, value = '', exceptId?: string): Promise<string | undefined> {
		const name = await vscode.window.showInputBox({
			title,
			prompt: 'Changelist name',
			value,
			validateInput: v => this.state.model.validateName(v, exceptId),
		});
		return name?.trim();
	}

	/** Asks for a name and creates the changelist. Returns its id. */
	async askNewChangelist(): Promise<string | undefined> {
		const name = await this.askName('New Changelist');
		if (!name) { return undefined; }
		const list = this.state.mutate(m => m.create(name));
		return list.id;
	}

	private async newChangelist(): Promise<void> {
		await this.askNewChangelist();
	}

	/** Renames a changelist in one step: the input opens with the current name selected. */
	private async renameChangelist(arg?: unknown): Promise<void> {
		const id = this.listArg(arg) ?? (await this.pickList('Rename Changelist'));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const name = await vscode.window.showInputBox({
			title: 'Rename Changelist',
			prompt: 'New name',
			value: list.name,
			valueSelection: [0, list.name.length],
			validateInput: v => this.state.model.validateName(v, list.id),
		});
		if (!name?.trim() || name.trim() === list.name) { return; }
		this.state.mutate(m => m.edit(list.id, name.trim(), list.comment));
	}

	/** Edits the changelist's description, which is also its draft commit message. */
	private async editDescription(arg?: unknown): Promise<void> {
		const id = this.listArg(arg) ?? (await this.pickList('Edit Changelist Description'));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const comment = await vscode.window.showInputBox({
			title: `Description of "${list.name}"`,
			prompt: 'Also used as the commit message for this changelist',
			value: list.comment,
		});
		if (comment === undefined) { return; }
		this.state.mutate(m => m.setComment(list.id, comment));
	}

	private async deleteChangelist(arg?: unknown): Promise<void> {
		const id = this.listArg(arg) ?? (await this.pickList('Delete Changelist', l => l.id !== this.state.model.active.id));
		const list = id && this.state.model.get(id);
		if (!list) { return; }
		const count = this.state.filesOf(list.id).length;
		if (count) {
			const ok = await vscode.window.showWarningMessage(
				`Delete changelist "${list.name}"?`,
				{ modal: true, detail: `Its ${count} file${count === 1 ? '' : 's'} will move to "${this.state.model.active.name}". No changes are lost.` },
				'Delete',
			);
			if (ok !== 'Delete') { return; }
		}
		this.state.mutate(m => m.delete(list.id));
	}

	private setActive(arg?: unknown): void {
		const id = this.listArg(arg);
		if (id) { this.state.mutate(m => m.setActive(id)); }
	}

	private async switchActive(): Promise<void> {
		const id = await this.pickList('Set Active Changelist', undefined, true);
		if (id) { this.state.mutate(m => m.setActive(id)); }
	}

	async pickList(title: string, filter?: (l: { id: string }) => boolean, allowNew = false): Promise<string | undefined> {
		type Item = vscode.QuickPickItem & { id: string | typeof NEW_LIST };
		const items: Item[] = this.state.model.all().filter(l => !filter || filter(l)).map(l => ({
			id: l.id,
			label: l.name,
			description: `${this.state.filesOf(l.id).length} files${l.id === this.state.model.active.id ? ' · active' : ''}`,
			detail: l.comment.split('\n')[0] || undefined,
		}));
		if (allowNew) { items.push({ id: NEW_LIST, label: '$(add) New Changelist...', alwaysShow: true }); }
		const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Choose a changelist', matchOnDetail: true });
		if (!picked) { return undefined; }
		return picked.id === NEW_LIST ? this.askNewChangelist() : picked.id;
	}

	private async moveToChangelist(arg?: unknown, all?: unknown): Promise<void> {
		const targets = this.targets(arg, all);
		if (!targets.length) {
			void vscode.window.showInformationMessage('Only changed files can be moved to a changelist.');
			return;
		}
		const owners = new Set(targets.map(t => t.list ?? this.state.ownerOf(t.change.path)));
		const current = owners.size === 1 && !targets.some(t => !t.list && this.state.model.isPartial(t.change.path)) ? [...owners][0] : undefined;
		const what = targets.length === 1 ? path.basename(targets[0].change.path) : `${targets.length} files`;
		const id = await this.pickList(`Move ${what} to Changelist`, l => l.id !== current, true);
		if (id) { await this.moveFilesTo(targets, id); }
	}

	/** Used by drag and drop as well. `UNVERSIONED` only takes untracked files back out of lists. */
	private async moveFilesTo(targets: Target[], owner: string): Promise<void> {
		if (!targets.length) { return; }
		if (owner === UNVERSIONED) {
			const untracked = targets.filter(t => t.change.untracked);
			if (untracked.length < targets.length) {
				void vscode.window.showInformationMessage('Only untracked files can be moved to Unversioned Files.');
			}
			this.state.mutate(m => m.move(untracked.map(t => t.change.path), undefined));
			return;
		}
		this.state.mutate(m => {
			for (const t of targets) {
				if (t.list && m.isPartial(t.change.path)) { m.moveList(t.change.path, t.list, owner); } else { m.move([t.change.path], owner); }
			}
		});
	}

	/** Moves the changes under the cursor (or selection) in the editor to another changelist. */
	private async moveChange(uriArg?: unknown, hunkArg?: unknown): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const uri = uriArg instanceof vscode.Uri ? uriArg : editor?.document.uri;
		if (!uri || uri.scheme !== 'file') { return; }
		const change = this.state.change(uri.fsPath);
		if (!change) {
			void vscode.window.showInformationMessage('This file has no changes.');
			return;
		}
		if (!eligible(change)) {
			// Added, deleted or renamed files can only move as a whole.
			await this.moveToChangelist(uri);
			return;
		}
		const entry = await this.tracker.refreshNow(uri.fsPath);
		if (!entry || !entry.hunks.length) { return; }

		let indices: number[];
		if (typeof hunkArg === 'number') {
			indices = [hunkArg];
		} else if (Array.isArray(hunkArg)) {
			indices = hunkArg.filter((i): i is number => typeof i === 'number');
		} else {
			const selections = editor && editor.document.uri.toString() === uri.toString() ? editor.selections : [];
			indices = entry.hunks.flatMap((h, i) => selections.some(sel => {
				const first = h.newStart === h.newEnd ? Math.max(0, h.newStart - 1) : h.newStart;
				const last = h.newStart === h.newEnd ? h.newStart : h.newEnd - 1;
				return sel.start.line <= last && sel.end.line >= first;
			}) ? [i] : []);
		}
		if (!indices.length) {
			void vscode.window.showInformationMessage('There is no change at the cursor. Place the cursor on a changed line, or select several.');
			return;
		}
		const lists = new Set(indices.map(i => entry.lists[i]));
		const current = lists.size === 1 ? [...lists][0] : undefined;
		const what = indices.length === 1 ? 'Change' : `${indices.length} Changes`;
		const id = await this.pickList(`Move ${what} to Changelist`, l => l.id !== current, true);
		if (id) { this.tracker.moveHunks(uri.fsPath, indices, id); }
	}

	/** Hunk indices under the cursor or selection of the editor showing `uri` (or the given ones). */
	async hunksAt(uriArg: unknown, hunkArg: unknown): Promise<{ file: string; indices: number[] } | undefined> {
		const editor = vscode.window.activeTextEditor;
		const uri = uriArg instanceof vscode.Uri ? uriArg : editor?.document.uri;
		if (!uri || uri.scheme !== 'file') { return undefined; }
		const change = this.state.change(uri.fsPath);
		if (!change || !eligible(change)) { return undefined; }
		const entry = await this.tracker.refreshNow(change.path);
		if (!entry) { return undefined; }
		if (typeof hunkArg === 'number') { return { file: change.path, indices: [hunkArg] }; }
		if (Array.isArray(hunkArg)) { return { file: change.path, indices: hunkArg.filter((i): i is number => typeof i === 'number') }; }
		const selections = editor && editor.document.uri.toString() === uri.toString() ? editor.selections : [];
		const indices = entry.hunks.flatMap((h, i) => selections.some(sel => {
			const first = h.newStart === h.newEnd ? Math.max(0, h.newStart - 1) : h.newStart;
			const last = h.newStart === h.newEnd ? h.newStart : h.newEnd - 1;
			return sel.start.line <= last && sel.end.line >= first;
		}) ? [i] : []);
		return { file: change.path, indices };
	}

	/** Leaves single changes of a file out of the next commit, or puts them back in. */
	private async setChangeInCommit(uriArg: unknown, hunkArg: unknown, include: boolean): Promise<void> {
		const at = await this.hunksAt(uriArg, hunkArg);
		if (!at) {
			void vscode.window.showInformationMessage('Single changes can only be left out of a commit in modified text files.');
			return;
		}
		if (!at.indices.length) {
			void vscode.window.showInformationMessage('There is no change at the cursor. Place the cursor on a changed line, or select several.');
			return;
		}
		this.tracker.setExcluded(at.file, at.indices, !include);
	}

	private setIncluded(arg: unknown, all: unknown, include: boolean): void {
		const targets = this.targets(arg, all);
		this.state.mutate(m => m.setIncluded(targets.map(t => ({ path: t.change.path, listId: t.list })), include));
	}

	// ---- Commit -----------------------------------------------------------------------------

	/** Selects exactly the changelist's files and moves focus to the commit message. */
	private async commitChangelist(arg?: unknown): Promise<void> {
		const id = this.listArg(arg) ?? (await this.pickList('Commit Changelist'));
		if (!id) { return; }
		const files = this.state.filesOf(id);
		if (!files.length) {
			void vscode.window.showInformationMessage(`"${this.state.model.get(id)?.name}" has no changes to commit.`);
			return;
		}
		this.state.mutate(m => m.setIncludedExactly(files.map(f => ({ path: f.path, listId: id }))));
		await this.commitView.focus(id);
	}

	private async commitFromPalette(push: boolean): Promise<void> {
		let message = this.commitView.message;
		if (!message.trim()) {
			const typed = await vscode.window.showInputBox({ title: 'Commit', prompt: 'Commit message', placeHolder: 'Describe the change' });
			if (!typed?.trim()) { return; }
			message = typed;
		}
		await this.commit(this.commitView.request(message, push));
	}

	/** Commits the checked files. Returns true on success. */
	async commit(request: CommitRequest): Promise<boolean> {
		return (await this.guard(() => this.exclusive('commit', async () => {
			const selection = this.state.selection();
			if (!request.message.trim()) { throw new Error('Enter a commit message.'); }
			if (!selection.length && !request.amend) { throw new Error('No files are selected. Check the files to commit in the Changes view.'); }

			const groups = this.byRepo(selection);
			if (request.amend) {
				if (groups.size > 1) { throw new Error('Amend works on one repository at a time. Select files from a single repository.'); }
				if (!groups.size) {
					const repos = this.state.repos.all;
					const root = repos.length === 1 ? repos[0].rootUri.fsPath : await this.pickRepo('Amend Commit in Repository');
					if (!root) { return false; }
					groups.set(root, []);
				}
			}

			const listsBefore = new Set(selection.flatMap(s => s.lists ?? this.state.model.listsOf(s.change.path)));
			this.commitView.setBusy(true);
			const done: string[] = [];
			try {
				await this.saveDocuments(selection.map(s => s.change));
				if (selection.length && !(await this.beforeCommit(selection))) { return false; }
				const partsByRoot = new Map<string, Map<string, PartSelection>>();
				for (const [root, items] of groups) { partsByRoot.set(root, await this.partsOf(items, true)); }

				// A partial commit resets the index entry of the file, so warn if it had staged content.
				const staged = [...partsByRoot.values()].flatMap(parts => [...parts.keys()]).filter(file => this.state.change(file)?.staged);
				if (staged.length) {
					const ok = await vscode.window.showWarningMessage(
						`${staged.map(f => path.basename(f)).join(', ')} ${staged.length === 1 ? 'has' : 'have'} staged changes.`,
						{ modal: true, detail: 'Committing only some changes of a file replaces its staged version with the committed one. Your working copy is not changed.' },
						'Commit',
					);
					if (ok !== 'Commit') { return false; }
				}

				const options = { amend: request.amend, signoff: request.signoff, noVerify: request.noVerify, author: request.author, committer: request.committer };
				await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Committing' }, async () => {
					for (const [root, items] of groups) {
						const repo = this.state.repos.git(root);
						const files = items.map(i => i.change);
						const parts = partsByRoot.get(root)!;
						const all = this.state.allChanges().filter(c => c.repoRoot === root);
						const coversAllChanges = !parts.size && all.every(c => files.some(f => f.path === c.path));
						const contents = new Map([...parts].map(([file, p]) => [file, p.content]));
						try {
							await git.commitFiles(repo, files, request.message, { ...options, coversAllChanges }, contents);
						} catch (e) {
							const where = groups.size > 1 ? ` in ${path.basename(root)}` : '';
							const already = done.length ? ` (Already committed in: ${done.map(r => path.basename(r)).join(', ')}.)` : '';
							throw new Error(`Commit failed${where}: ${e instanceof Error ? e.message : e}${already}`);
						}
						done.push(root);
						// The committed hunks are now part of HEAD: carry the other lists' hunks over to the new base.
						for (const [file, p] of parts) {
							const base = await git.blobIdOf(repo, file, p.content);
							const remaining = rangesAfterCommit(p.hunks, p.lists, p.selected);
							this.tracker.carryOver(file, base, remaining);
							this.state.update(m => m.setPartial(file, base, remaining));
							// What was left out stays in the working tree; it is no longer "excluded" for the next commit.
							this.state.update(m => m.setExcluded(file, base, []));
						}
					}
				});
			} finally {
				this.commitView.setBusy(false);
				await this.afterGitChange(groups.keys());
			}
			this.commitView.committed(request.message);

			if (request.push) {
				await this.push([...groups.keys()]);
				if (request.createPr) { for (const root of groups.keys()) { await this.openPullRequest(root); } }
			}
			void this.offerDeleteEmpty(listsBefore);
			return true;
		}))) === true;
	}

	/**
	 * Writes a commit message for the checked changes with a GitHub Copilot language model, streaming
	 * it into the message box. Running it again while it works stops it.
	 */
	async generateCommitMessage(): Promise<'done' | 'no-changes' | 'no-model' | 'cancelled'> {
		if (this.generating) {
			this.generating.cancel();
			return 'cancelled';
		}
		const selection = this.state.selection();
		if (!selection.length) {
			void vscode.window.showInformationMessage('Check the changes to commit first; the message is written from them.');
			return 'no-changes';
		}
		const settings = vscode.workspace.getConfiguration('changelists.commitMessage');
		let model: vscode.LanguageModelChat;
		try { model = await pickModel(); } catch (e) { if (handledNoModel(e)) { return 'no-model'; } throw e; }

		const diff = await this.selectionDiff(selection);
		if (!diff.trim()) {
			void vscode.window.showInformationMessage('The checked files have no changes to describe.');
			return 'no-changes';
		}
		const root = selection[0].change.repoRoot;
		const recent = (await this.state.repos.git(root).text(['log', '-n', '15', '--format=%s'], { okCodes: [128] })).split('\n').filter(Boolean);
		const target = this.commitView.target;
		const prompt = buildCommitPrompt({
			diff,
			recentSubjects: recent,
			branch: this.state.repos.repository(root)?.state.HEAD?.name,
			listName: target.name,
			listDescription: target.comment && !this.commitView.message.trim() ? target.comment : undefined,
			instructions: settings.get<string>('instructions', ''),
			maxDiffChars: diffBudget(model),
		});

		const cts = new vscode.CancellationTokenSource();
		this.generating = cts;
		this.commitView.setGenerating(true);
		log().info(`Generating a commit message with ${model.name} (${model.family}), ${diff.length} characters of diff`);
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Writing commit message with ${model.name}…`, cancellable: true }, async (_progress, token) => {
				token.onCancellationRequested(() => cts.cancel());
				const text = await ask(model, prompt, cts.token, partial => this.commitView.showGenerated(partial));
				const message = cleanCommitMessage(text);
				if (!message) { throw new Error('The model returned an empty message.'); }
				this.commitView.showGenerated(message);
			});
			return cts.token.isCancellationRequested ? 'cancelled' : 'done';
		} catch (e) {
			if (cts.token.isCancellationRequested || e instanceof vscode.CancellationError) { return 'cancelled'; }
			throw e;
		} finally {
			cts.dispose();
			this.generating = undefined;
			this.commitView.setGenerating(false);
		}
	}

	/** Unified diff of what the next commit contains (checked files, minus other lists' parts and left-out changes). */
	async selectionDiff(selection: { change: FileChange; lists?: string[] }[]): Promise<string> {
		await this.saveDocuments(selection.map(s => s.change));
		const diffs: string[] = [];
		for (const [root, items] of this.byRepo(selection)) {
			const parts = await this.partsOf(items, true);
			const contents = new Map([...parts].map(([file, p]) => [file, p.content]));
			diffs.push(await git.createPatch(this.state.repos.git(root), items.map(i => i.change), contents));
		}
		return diffs.join('');
	}

	/**
	 * Runs the configured before-commit steps on the checked files. Returns false if the user
	 * decided not to commit.
	 */
	private async beforeCommit(selection: { change: FileChange; lists?: string[] }[]): Promise<boolean> {
		const settings = vscode.workspace.getConfiguration('changelists.beforeCommit');
		const files = selection.map(s => s.change).filter(c => c.kind !== 'deleted');
		const organize = settings.get('organizeImports', false);
		const format = settings.get('format', false);

		if (organize || format) {
			for (const c of files) {
				const uri = vscode.Uri.file(c.path);
				let doc: vscode.TextDocument;
				try { doc = await vscode.workspace.openTextDocument(uri); } catch { continue; }
				if (organize) {
					const whole = new vscode.Range(0, 0, doc.lineCount, 0);
					const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, whole, vscode.CodeActionKind.SourceOrganizeImports.value, 1) ?? [];
					for (const action of actions) {
						if (action.edit) { await vscode.workspace.applyEdit(action.edit); }
						if (action.command) { await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? [])); }
					}
				}
				if (format) {
					const editor = vscode.workspace.getConfiguration('editor', uri);
					const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, {
						tabSize: editor.get<number>('tabSize', 4), insertSpaces: editor.get<boolean>('insertSpaces', true),
					});
					if (edits?.length) {
						const edit = new vscode.WorkspaceEdit();
						edit.set(uri, edits);
						await vscode.workspace.applyEdit(edit);
					}
				}
				if (doc.isDirty) { await doc.save(); }
			}
		}

		if (settings.get('checkProblems', false)) {
			const broken = files.filter(c => vscode.languages.getDiagnostics(vscode.Uri.file(c.path)).some(d => d.severity === vscode.DiagnosticSeverity.Error));
			if (broken.length) {
				const ok = await vscode.window.showWarningMessage(
					`${broken.length} checked file${broken.length === 1 ? ' has' : 's have'} errors.`,
					{ modal: true, detail: broken.map(c => this.state.relative(c)).join('\n') }, 'Commit Anyway');
				if (ok !== 'Commit Anyway') { return false; }
			}
		}

		if (settings.get('checkTodos', false)) {
			const todos = addedTodos(await this.selectionDiff(selection));
			if (todos.length) {
				const ok = await vscode.window.showWarningMessage(
					`The changes add ${todos.length} TODO or FIXME comment${todos.length === 1 ? '' : 's'}.`,
					{ modal: true, detail: todos.slice(0, 10).join('\n') + (todos.length > 10 ? '\n…' : '') }, 'Commit Anyway');
				if (ok !== 'Commit Anyway') { return false; }
			}
		}

		const command = settings.get<string>('command', '').trim();
		if (command) {
			for (const root of new Set(selection.map(s => s.change.repoRoot))) {
				log().info(`Before commit: ${command} (in ${root})`);
				const result = await new Promise<{ code: number; output: string }>(resolve => {
					exec(command, { cwd: root, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
						resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}` }));
				});
				if (result.output.trim()) { log().info(result.output.trim()); }
				if (result.code !== 0) {
					throw new Error(`The before-commit command failed (exit ${result.code}): ${command}\n${result.output.trim().split('\n').slice(-5).join('\n')}`);
				}
			}
		}
		return true;
	}

	/** Opens the page for creating a pull request of the current branch. */
	async openPullRequest(root: string): Promise<void> {
		const repo = this.state.repos.repository(root);
		const branch = repo?.state.HEAD?.name;
		if (!repo || !branch) { return; }
		if (vscode.extensions.getExtension('GitHub.vscode-pull-request-github')) {
			await vscode.commands.executeCommand('pr.create');
			return;
		}
		const remote = repo.state.HEAD?.upstream?.remote ?? 'origin';
		const url = (await this.state.repos.git(root).text(['remote', 'get-url', remote], { okCodes: [1, 2, 128] })).trim();
		const page = url ? pullRequestUrl(url, branch) : undefined;
		if (!page) {
			void vscode.window.showInformationMessage(`Pushed. Changedeck does not know the pull request page for ${url || 'this repository'}.`);
			return;
		}
		await vscode.env.openExternal(vscode.Uri.parse(page));
	}

	private async push(roots: string[]): Promise<void> {
		for (const root of roots) {
			const repo = this.state.repos.repository(root);
			if (!repo) { continue; }
			try {
				await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl, title: 'Pushing' }, async () => {
					const head = repo.state.HEAD;
					if (head?.upstream || !head?.name) {
						await repo.push();
					} else {
						await repo.push('origin', head.name, true);
					}
				});
			} catch (e) {
				void vscode.window.showErrorMessage(`Committed, but the push failed${roots.length > 1 ? ` in ${path.basename(root)}` : ''}: ${e instanceof Error ? e.message : e}`);
			}
		}
	}

	private async offerDeleteEmpty(listIds: Set<string>): Promise<void> {
		const mode = vscode.workspace.getConfiguration('changelists').get<string>('deleteEmptyChangelistAfterCommit', 'ask');
		if (mode === 'never') { return; }
		for (const id of listIds) {
			const list = this.state.model.get(id);
			if (!list || id === this.state.model.active.id || this.state.filesOf(id).length) { continue; }
			if (mode === 'ask') {
				const choice = await vscode.window.showInformationMessage(`Changelist "${list.name}" is now empty. Delete it?`, 'Delete', 'Keep');
				if (choice !== 'Delete') { continue; }
			}
			if (this.state.model.get(id) && !this.state.filesOf(id).length) { this.state.mutate(m => m.delete(id)); }
		}
	}

	async pickRepo(title: string): Promise<string | undefined> {
		const repos = this.state.repos.all;
		if (!repos.length) { throw new Error('No Git repository is open.'); }
		if (repos.length === 1) { return repos[0].rootUri.fsPath; }
		const picked = await vscode.window.showQuickPick(
			repos.map(r => ({ label: path.basename(r.rootUri.fsPath), description: r.rootUri.fsPath, root: r.rootUri.fsPath })),
			{ title },
		);
		return picked?.root;
	}

	// ---- Rollback ---------------------------------------------------------------------------

	private async rollback(arg?: unknown, all?: unknown): Promise<void> {
		const targets = this.targets(arg, all);
		if (!targets.length) { return; }
		const files = this.changesOf(targets);
		const untracked = files.filter(f => f.untracked).length;
		const added = files.filter(f => !f.untracked && (f.kind === 'added' || f.kind === 'copied')).length;
		const partialCount = targets.filter(t => t.list).length;
		if (vscode.workspace.getConfiguration('changelists').get('confirmRollback', true)) {
			const notes: string[] = ['Local changes to these files will be lost.'];
			if (partialCount) { notes.push(`In ${partialCount} file${partialCount === 1 ? '' : 's'} only this changelist's changes are rolled back; changes in other changelists stay.`); }
			if (added) { notes.push(`${added} added file${added === 1 ? '' : 's'} will be removed from Git but kept on disk.`); }
			if (untracked) { notes.push(`${untracked} unversioned file${untracked === 1 ? '' : 's'} will be moved to the trash.`); }
			const what = files.length === 1 ? `"${path.basename(files[0].path)}"` : `${files.length} files`;
			const ok = await vscode.window.showWarningMessage(`Roll back ${what}?`, { modal: true, detail: notes.join('\n') }, 'Rollback');
			if (ok !== 'Rollback') { return; }
		}
		await this.saveDocuments(files);
		const parts = await this.partsOf(this.listTargets(targets));
		const groups = this.byRepo(files.filter(f => !parts.has(f.path)));
		const roots = new Set([...groups.keys(), ...files.map(f => f.repoRoot)]);

		// Snapshot everything first so the rollback can be undone.
		const record: RollbackRecord = {
			backups: [],
			lists: files.map(f => ({ path: f.path, listId: this.state.model.listOf(f.path), partial: this.state.model.partialOf(f.path) })),
			after: new Map(),
		};
		for (const [root, changes] of this.byRepo(files)) {
			record.backups.push({ root, backup: await git.createBackup(this.state.repos.git(root), changes, randomUUID(), 'Rollback') });
		}
		try {
			for (const [file, p] of parts) {
				await fs.writeFile(file, Buffer.from(p.remaining, 'latin1'));
			}
			for (const [root, changes] of groups) {
				const result = await git.rollback(this.state.repos.git(root), changes);
				for (const file of result.untrackedToDelete) {
					await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true, recursive: false }).then(undefined, async () => {
						await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: false, recursive: false });
					});
				}
			}
		} finally {
			await this.afterGitChange(roots);
		}
		for (const f of files) { record.after.set(f.path, await hashFile(f.path)); }
		this.lastRollback = record;
		const what = files.length === 1 ? `"${path.basename(files[0].path)}"` : `${files.length} files`;
		void vscode.window.showInformationMessage(`Rolled back ${what}.`, 'Undo').then(choice => {
			if (choice) { void vscode.commands.executeCommand('changelists.undoRollback'); }
		});
	}

	/** Restores the files of the last rollback, and puts them back into their changelists. */
	private async undoRollback(): Promise<void> {
		const record = this.lastRollback;
		if (!record) {
			void vscode.window.showInformationMessage('There is no rollback to undo in this session.');
			return;
		}
		const edited: string[] = [];
		for (const [file, hash] of record.after) {
			if ((await hashFile(file)) !== hash) { edited.push(file); }
		}
		if (edited.length) {
			const ok = await vscode.window.showWarningMessage(
				`${edited.length} file${edited.length === 1 ? ' was' : 's were'} changed after the rollback.`,
				{ modal: true, detail: `Undoing will overwrite: ${edited.map(f => path.basename(f)).join(', ')}` },
				'Undo Anyway',
			);
			if (ok !== 'Undo Anyway') { return; }
		}
		await this.saveDocuments(record.lists.map(l => this.state.change(l.path)).filter((c): c is FileChange => !!c));
		for (const entry of record.lists) {
			if (entry.partial) { this.tracker.carryOver(entry.path, entry.partial.base, entry.partial.ranges); }
		}
		this.state.mutate(m => {
			for (const entry of record.lists) {
				const id = entry.listId && m.get(entry.listId) ? entry.listId : undefined;
				if (id) { m.expect([entry.path], id); }
			}
		});
		try {
			for (const { root, backup } of record.backups) {
				await git.restoreBackup(this.state.repos.git(root), backup);
			}
		} finally {
			await this.afterGitChange(record.backups.map(b => b.root));
		}
		for (const { root, backup } of record.backups) {
			await git.deleteBackup(this.state.repos.git(root), backup).catch(() => undefined);
		}
		this.lastRollback = undefined;
		void vscode.window.setStatusBarMessage('$(check) Rollback undone', 3000);
	}

	private async addToVcs(arg?: unknown, all?: unknown): Promise<void> {
		const files = this.changesOf(this.targets(arg, all)).filter(f => f.untracked);
		const groups = this.byRepo(files);
		try {
			for (const [root, changes] of groups) {
				await git.addFiles(this.state.repos.git(root), changes.map(c => c.path));
			}
		} finally {
			await this.afterGitChange(groups.keys());
		}
	}

	// ---- Shelf ------------------------------------------------------------------------------

	private async shelve(arg?: unknown, all?: unknown): Promise<void> {
		const targets = this.targets(arg, all);
		if (!targets.length) {
			void vscode.window.showInformationMessage('Select changed files or a changelist to shelve.');
			return;
		}
		const files = this.changesOf(targets);
		const owners = new Set(targets.map(t => t.list ?? this.state.ownerOf(t.change.path)));
		const listId = this.listArg(arg) ?? (owners.size === 1 ? [...owners][0] : undefined);
		const list = listId ? this.state.model.get(listId) : undefined;
		const name = await vscode.window.showInputBox({
			title: `Shelve ${files.length} file${files.length === 1 ? '' : 's'}`,
			prompt: 'Name for the shelved changes',
			value: list?.comment.split('\n')[0].trim() || list?.name || 'Shelved changes',
			validateInput: v => v.trim() ? undefined : 'Enter a name.',
		});
		if (!name) { return; }
		await this.shelveTargets(targets, name.trim(), list?.name);
		await vscode.commands.executeCommand('changelists.shelf.focus');
	}

	/** Shelves the targets (one list's part for partial files) under a name. */
	async shelveTargets(targets: Target[], name: string, listName?: string, branch?: string): Promise<void> {
		const files = this.changesOf(targets);
		await this.saveDocuments(files);
		const parts = await this.partsOf(this.listTargets(targets));
		const groups = this.byRepo(files);
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Shelving changes' }, async () => {
				for (const [root, changes] of groups) {
					const id = randomUUID();
					const partial = new Map(changes.filter(c => parts.has(c.path)).map(c => {
						const p = parts.get(c.path)!;
						return [c.path, { shelved: p.content, remaining: p.remaining }];
					}));
					await git.shelve(this.state.repos.git(root), changes, name, id, partial);
					await this.shelf.setMeta(id, { name, listName, ...(branch ? { branch } : {}) });
				}
			});
		} finally {
			await this.afterGitChange(groups.keys());
			await this.shelf.reload();
		}
	}

	async pickShelf(title: string): Promise<ShelfNode | undefined> {
		const shelves = this.shelf.all();
		if (!shelves.length) {
			void vscode.window.showInformationMessage('Nothing is shelved.');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			shelves.map(s => ({ label: s.name, description: new Date(s.ref.date).toLocaleString(), detail: s.listName ? `From "${s.listName}"` : undefined, shelf: s })),
			{ title },
		);
		return picked?.shelf;
	}

	private async unshelve(node: ShelfNode | undefined, chooseList: boolean): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.pickShelf('Unshelve');
		if (!shelf) { return; }

		let listId: string | undefined;
		if (chooseList) {
			listId = await this.pickList(`Unshelve "${shelf.name}" to Changelist`, undefined, true);
			if (!listId) { return; }
		} else if (shelf.listName) {
			listId = this.state.model.findByName(shelf.listName)?.id ?? this.state.mutate(m => m.create(shelf.listName!)).id;
		} else {
			listId = this.state.model.active.id;
		}

		const repo = this.state.repos.git(shelf.root);
		const files = await this.shelf.filesOf(shelf);
		await this.expectFiles(files.map(f => path.join(shelf.root, ...f.path.split('/'))), listId);

		let result: git.UnshelveResult;
		try {
			result = await git.unshelve(repo, shelf.ref.sha);
		} finally {
			await this.afterGitChange([shelf.root]);
		}
		if (result.conflicts) {
			void vscode.window.showWarningMessage(`"${shelf.name}" was unshelved with conflicts. Resolve them in the marked files. The shelved copy was kept.`);
		} else if (vscode.workspace.getConfiguration('changelists').get('deleteShelfAfterUnshelve', true)) {
			await git.deleteShelf(repo, shelf.ref.ref);
			await this.shelf.setMeta(shelf.ref.id, undefined);
		}
		await this.shelf.reload();
	}

	/**
	 * Prepares for files to receive unshelved changes in `listId`. Files without changes simply
	 * land in the list; files that are already changed get only the new hunks moved there.
	 */
	async expectFiles(paths: string[], listId: string): Promise<void> {
		const changed = paths.filter(p => this.state.change(p));
		const fresh = paths.filter(p => !this.state.change(p));
		await this.tracker.snapshot(changed);
		this.state.mutate(m => {
			m.expect(fresh, listId);
			m.expectHunks(changed, listId);
		});
	}

	/** Unshelves single files (the clicked one, or all selected shelved files). */
	private async unshelveFile(node?: ShelfFileNode, all?: ShelfFileNode[]): Promise<void> {
		const nodes = (Array.isArray(all) && all.length && (!node || all.includes(node)) ? all : node ? [node] : [...this.shelf.view.selection])
			.filter((n): n is ShelfFileNode => !!n && n.type === 'shelfFile');
		const byShelf = new Map<string, ShelfFileNode[]>();
		for (const n of nodes) {
			const key = `${n.shelf.root}\0${n.shelf.ref.ref}`;
			byShelf.set(key, [...(byShelf.get(key) ?? []), n]);
		}
		for (const group of byShelf.values()) { await this.unshelveFilesOf(group[0].shelf, group.map(n => n.file)); }
	}

	/** Lets the user pick which files of a shelf to unshelve. */
	private async unshelveFiles(node?: ShelfNode): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.pickShelf('Unshelve Files');
		if (!shelf) { return; }
		const files = await this.shelf.filesOf(shelf);
		const picked = await vscode.window.showQuickPick(
			files.map(f => ({ label: path.posix.basename(f.path), description: path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path), detail: f.untracked ? 'Unversioned' : { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed', U: 'Unmerged' }[f.status], picked: true, file: f })),
			{ title: `Unshelve Files from "${shelf.name}"`, canPickMany: true, placeHolder: 'Choose the files to unshelve' },
		);
		if (!picked?.length) { return; }
		await this.unshelveFilesOf(shelf, picked.map(p => p.file));
	}

	private async unshelveFilesOf(shelf: ShelfNode, files: ShelfFile[]): Promise<void> {
		const repo = this.state.repos.git(shelf.root);
		const listId = (shelf.listName && this.state.model.findByName(shelf.listName)?.id) || this.state.model.active.id;
		await this.expectFiles(files.map(f => path.join(shelf.root, ...f.path.split('/'))), listId);
		const done: string[] = [];
		const conflicts: string[] = [];
		try {
			for (const file of files) {
				if ((await git.unshelveFile(repo, shelf.ref.sha, file)).conflict) { conflicts.push(file.path); } else { done.push(file.path); }
			}
		} finally {
			await this.afterGitChange([shelf.root]);
		}
		if (done.length) {
			const left = await git.removeFromShelf(repo, shelf.ref, done);
			if (!left.sha) { await this.shelf.setMeta(shelf.ref.id, undefined); }
		}
		if (conflicts.length) {
			void vscode.window.showWarningMessage(`${conflicts.join(', ')} conflicted with your local changes. Resolve the conflict markers; ${conflicts.length === 1 ? 'that file stays' : 'those files stay'} on the shelf.`);
		}
		await this.shelf.reload();
	}

	private async deleteShelf(node?: ShelfNode): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.pickShelf('Delete Shelved Changes');
		if (!shelf) { return; }
		const ok = await vscode.window.showWarningMessage(`Delete shelved changes "${shelf.name}"?`, { modal: true, detail: 'This cannot be undone from the Shelf view.' }, 'Delete');
		if (ok !== 'Delete') { return; }
		await git.deleteShelf(this.state.repos.git(shelf.root), shelf.ref.ref);
		await this.shelf.setMeta(shelf.ref.id, undefined);
		await this.shelf.reload();
	}

	private async renameShelf(node?: ShelfNode): Promise<void> {
		const shelf = isShelfNode(node) ? node : await this.pickShelf('Rename Shelved Changes');
		if (!shelf) { return; }
		const name = await vscode.window.showInputBox({ title: 'Rename Shelved Changes', value: shelf.name, validateInput: v => v.trim() ? undefined : 'Enter a name.' });
		if (!name) { return; }
		await this.shelf.setMeta(shelf.ref.id, { name: name.trim(), listName: shelf.listName });
		await this.shelf.reload();
	}

	// ---- Open and diff ----------------------------------------------------------------------

	private async openDiff(arg?: unknown): Promise<void> {
		const target = this.targets(arg)[0];
		if (!target) { return; }
		const change = target.change;
		const uri = vscode.Uri.file(change.path);
		const name = path.basename(change.path);
		if (change.untracked || change.conflicted || change.kind === 'added') {
			await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
			return;
		}
		if (change.kind === 'deleted') {
			await vscode.commands.executeCommand('vscode.open', this.api.toGitUri(uri, 'HEAD'), { preview: true }, `${name} (Deleted)`);
			return;
		}
		const left = this.api.toGitUri(change.originalPath ? vscode.Uri.file(change.originalPath) : uri, 'HEAD');
		if (target.list && this.state.model.isPartial(change.path)) {
			// Only this changelist's changes, as they would be committed.
			const listName = this.state.model.get(target.list)?.name ?? '';
			const right = vscode.Uri.from({ scheme: PART_SCHEME, path: '/' + path.basename(change.path), query: JSON.stringify({ file: change.path, list: target.list, t: Date.now() }) });
			await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ ${listName})`, { preview: true });
			return;
		}
		await vscode.commands.executeCommand('vscode.diff', left, uri, `${name} (HEAD ↔ Working Tree)`, { preview: true });
	}

	/** Content for the right side of a partial diff: HEAD plus one list's changes. */
	async partContent(uri: vscode.Uri): Promise<string> {
		const { file, list } = JSON.parse(uri.query) as { file: string; list: string };
		const change = this.state.change(file);
		if (!change) { return ''; }
		const sel = await this.tracker.selection(change, [list]);
		return sel ? Buffer.from(sel.content, 'latin1').toString('utf8') : await fs.readFile(change.path, 'utf8');
	}

	private async openFile(arg?: unknown, all?: unknown): Promise<void> {
		for (const change of this.changesOf(this.targets(arg, all))) {
			if (change.kind === 'deleted') { continue; }
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(change.path), { preview: false });
		}
	}

	// ---- Patches ----------------------------------------------------------------------------

	private async buildPatch(targets: Target[]): Promise<string> {
		const files = this.changesOf(targets);
		await this.saveDocuments(files);
		const parts = await this.partsOf(this.listTargets(targets));
		const out: string[] = [];
		for (const [root, changes] of this.byRepo(files)) {
			const contents = new Map(changes.filter(c => parts.has(c.path)).map(c => [c.path, parts.get(c.path)!.content]));
			out.push(await git.createPatch(this.state.repos.git(root), changes, contents));
		}
		return out.join('');
	}

	private async createPatch(arg?: unknown, all?: unknown): Promise<void> {
		const targets = this.targets(arg, all);
		if (!targets.length) { return; }
		if (this.byRepo(this.changesOf(targets)).size > 1) { throw new Error('A patch can only contain files from one repository. Select files from a single repository.'); }
		const patch = await this.buildPatch(targets);
		const listId = this.listArg(arg);
		const base = (listId ? this.state.model.get(listId)?.name : undefined) ?? 'changes';
		const target = await vscode.window.showSaveDialog({
			title: 'Create Patch',
			defaultUri: vscode.Uri.file(path.join(targets[0].change.repoRoot, `${base.replace(/[^\w.-]+/g, '_')}.patch`)),
			filters: { Patches: ['patch', 'diff'] },
		});
		if (!target) { return; }
		await vscode.workspace.fs.writeFile(target, Buffer.from(patch, 'utf8'));
		const open = await vscode.window.showInformationMessage(`Patch saved to ${path.basename(target.fsPath)}.`, 'Open');
		if (open) { await vscode.commands.executeCommand('vscode.open', target); }
	}

	private async copyPatch(arg?: unknown, all?: unknown): Promise<void> {
		const targets = this.targets(arg, all);
		if (!targets.length) { return; }
		if (this.byRepo(this.changesOf(targets)).size > 1) { throw new Error('A patch can only contain files from one repository. Select files from a single repository.'); }
		await vscode.env.clipboard.writeText(await this.buildPatch(targets));
		void vscode.window.setStatusBarMessage(`$(check) Copied patch for ${targets.length} file${targets.length === 1 ? '' : 's'}`, 3000);
	}

	private async applyPatch(): Promise<void> {
		const root = await this.pickRepo('Apply Patch to Repository');
		if (!root) { return; }
		const [file] = await vscode.window.showOpenDialog({
			title: 'Apply Patch', canSelectMany: false, defaultUri: vscode.Uri.file(root),
			filters: { Patches: ['patch', 'diff'], 'All files': ['*'] },
		}) ?? [];
		if (!file) { return; }
		const patch = await fs.readFile(file.fsPath, 'utf8');
		try {
			const r = await git.applyPatch(this.state.repos.git(root), patch);
			void vscode.window.showInformationMessage(r.threeWay ? 'Patch applied with a 3-way merge. Check for conflicts.' : 'Patch applied.');
		} finally {
			await this.afterGitChange([root]);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
