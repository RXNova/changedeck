import * as path from 'path';
import * as vscode from 'vscode';
import { Changelist, FileRef } from './core/model';
import { FileChange } from './core/types';
import { listColor } from './editorDecorations';
import { log } from './log';
import { ChangelistState, UNVERSIONED } from './state';

export type Node = ListNode | UnversionedNode | FolderNode | FileNode;

export interface ListNode { readonly type: 'list'; readonly list: Changelist }
export interface UnversionedNode { readonly type: 'unversioned' }
export interface FolderNode {
	readonly type: 'folder';
	readonly owner: string;
	readonly dir: string;
	readonly label: string;
	readonly files: FileChange[];
	readonly isRepo: boolean;
}
export interface FileNode { readonly type: 'file'; readonly owner: string; readonly change: FileChange }

/** Fragment on tree rows' resource URIs; see ChangelistFileDecorations. */
const TREE_FRAGMENT = 'changelists';
/** The tree's own mime type. VS Code fills it with internal row handles; listing it allows drops within the tree. */
const TREE_MIME = 'application/vnd.code.tree.changelists.changes';
/** Our payloads, as JSON text so they arrive unchanged however VS Code transports them. */
const FILES_MIME = 'application/vnd.changedeck.files';
const LISTS_MIME = 'application/vnd.changedeck.lists';

/** Reads a JSON payload that may arrive as text or as the original object. */
async function payload<T>(item: vscode.DataTransferItem | undefined): Promise<T | undefined> {
	if (!item) { return undefined; }
	const value: unknown = item.value;
	if (value && typeof value === 'object') { return value as T; }
	const text = typeof value === 'string' ? value : await item.asString();
	if (!text) { return undefined; }
	try { return JSON.parse(text) as T; } catch { return undefined; }
}

const KIND_LABEL: Record<FileChange['kind'], string> = {
	modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied',
	untracked: 'Unversioned', conflicted: 'Conflicted', typechange: 'Type changed',
};

export function isNode(value: unknown): value is Node {
	return !!value && typeof value === 'object' && ['list', 'unversioned', 'folder', 'file'].includes((value as Node).type);
}

export class ChangesView implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>, vscode.Disposable {
	readonly dragMimeTypes = [TREE_MIME, FILES_MIME, LISTS_MIME, 'text/uri-list'];
	readonly dropMimeTypes = [TREE_MIME, FILES_MIME, LISTS_MIME, 'text/uri-list'];

	private readonly emitter = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly view: vscode.TreeView<Node>;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly state: ChangelistState) {
		this.view = vscode.window.createTreeView('changelists.changes', {
			treeDataProvider: this,
			dragAndDropController: this,
			canSelectMany: true,
			manageCheckboxStateManually: true,
			showCollapseAll: true,
		});
		this.disposables.push(
			this.view,
			this.view.onDidChangeCheckboxState(e => this.onCheckbox(e)),
			state.onDidChange(() => this.refresh()),
		);
		this.refresh();
	}

	get visible(): boolean { return this.view.visible; }

	/** The nodes selected in the tree. */
	selection(): Node[] { return [...this.view.selection]; }

	refresh(): void {
		const total = new Set(this.state.allChanges().filter(c => this.state.model.listsOf(c.path).length).map(c => c.path)).size;
		this.view.badge = total ? { value: total, tooltip: `${total} changed file${total === 1 ? '' : 's'}` } : undefined;
		this.emitter.fire(undefined);
	}

	private get treeMode(): boolean {
		return vscode.workspace.getConfiguration('changelists').get('viewMode') === 'tree';
	}

	// ---- TreeDataProvider -------------------------------------------------------------------

	getChildren(node?: Node): Node[] {
		if (!node) {
			// Lists keep the order the user gave them (drag a list onto another to move it).
			const lists = this.state.model.all().map((list): Node => ({ type: 'list', list }));
			const showUnversioned = vscode.workspace.getConfiguration('changelists').get('showUnversionedFiles', true);
			if (showUnversioned && this.state.filesOf(UNVERSIONED).length) { lists.push({ type: 'unversioned' }); }
			return lists;
		}
		switch (node.type) {
			case 'list': return this.filesView(node.list.id, this.state.filesOf(node.list.id));
			case 'unversioned': return this.filesView(UNVERSIONED, this.state.filesOf(UNVERSIONED));
			case 'folder': return this.folderChildren(node.owner, node.dir, node.files);
			case 'file': return [];
		}
	}

	getParent(node: Node): Node | undefined {
		if (node.type === 'file' || node.type === 'folder') {
			return node.owner === UNVERSIONED ? { type: 'unversioned' } : { type: 'list', list: this.state.model.get(node.owner)! };
		}
		return undefined;
	}

	getTreeItem(node: Node): vscode.TreeItem {
		switch (node.type) {
			case 'list': return this.listItem(node.list);
			case 'unversioned': return this.unversionedItem();
			case 'folder': return this.folderItem(node);
			case 'file': return this.fileItem(node);
		}
	}

	private listItem(list: Changelist): vscode.TreeItem {
		const active = list.id === this.state.model.active.id;
		const files = this.state.filesOf(list.id);
		const label: vscode.TreeItemLabel = active ? { label: list.name, highlights: [[0, list.name.length]] } : { label: list.name };
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `list:${list.id}`;
		item.contextValue = active ? 'changelist.active' : 'changelist';
		item.iconPath = new vscode.ThemeIcon(active ? 'circle-filled' : 'circle-outline', listColor(this.state, list.id));
		const count = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'empty';
		item.description = [count, active ? 'active' : '', list.branch ? `⎇ ${list.branch}` : ''].filter(Boolean).join(' · ');
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**${escapeMd(list.name)}**${active ? ' (active)' : ''}\n\n${count}`);
		if (list.branch) { tooltip.appendMarkdown(`\n\nLinked to branch \`${list.branch}\`: becomes active when that branch is checked out.`); }
		if (list.comment.trim()) { tooltip.appendMarkdown('\n\n---\n\n').appendText(list.comment); }
		item.tooltip = tooltip;
		item.checkboxState = this.checkbox(files, list.id);
		return item;
	}

	private unversionedItem(): vscode.TreeItem {
		const files = this.state.filesOf(UNVERSIONED);
		const item = new vscode.TreeItem('Unversioned Files', vscode.TreeItemCollapsibleState.Collapsed);
		item.id = 'unversioned';
		item.contextValue = 'unversioned';
		item.iconPath = new vscode.ThemeIcon('question');
		item.description = `${files.length} file${files.length === 1 ? '' : 's'}`;
		item.tooltip = 'Files Git does not track yet. Move them to a changelist or check them to include them in a commit.';
		item.checkboxState = this.checkbox(files, UNVERSIONED);
		return item;
	}

	private folderItem(node: FolderNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
		item.id = `folder:${node.owner}:${node.dir}`;
		item.resourceUri = vscode.Uri.file(node.dir);
		item.iconPath = node.isRepo ? new vscode.ThemeIcon('repo') : vscode.ThemeIcon.Folder;
		item.contextValue = node.owner === UNVERSIONED ? 'folder.untracked' : 'folder';
		item.description = `${node.files.length}`;
		item.checkboxState = this.checkbox(node.files, node.owner);
		return item;
	}

	private fileItem(node: FileNode): vscode.TreeItem {
		const c = node.change;
		const uri = vscode.Uri.file(c.path).with({ fragment: TREE_FRAGMENT });
		const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
		item.id = `file:${node.owner}:${c.path}`;
		item.label = path.basename(c.path);
		const descriptions: string[] = [];
		if (!this.treeMode) {
			const dir = path.posix.dirname(this.state.relative(c));
			const prefix = this.state.repos.count > 1 ? this.state.repoLabel(c.repoRoot) : '';
			const where = [prefix, dir === '.' ? '' : dir].filter(Boolean).join(' › ');
			if (where) { descriptions.push(where); }
		}
		if (c.originalPath) { descriptions.push(`← ${path.relative(path.dirname(c.path), c.originalPath).split(path.sep).join('/')}`); }
		const partial = this.state.model.isPartial(c.path);
		if (partial) { descriptions.push('· partial'); }
		// Changes left out of the commit, counted for this list's part of a split file only.
		const excluded = this.state.model.excludedOf(c.path)?.ranges ?? [];
		const split = this.state.model.partialOf(c.path);
		const left = split
			? excluded.filter(([start, end]) => split.ranges.some(r => r.listId === node.owner && r.start <= end && start <= r.end)).length
			: excluded.length;
		if (left) { descriptions.push(`· ${left} change${left === 1 ? '' : 's'} left out`); }
		item.description = descriptions.join('  ');
		item.contextValue = c.untracked ? 'file.untracked' : partial ? 'file.partial' : 'file';
		let tooltip = `${c.path}\n${KIND_LABEL[c.kind]}${c.originalPath ? ` from ${c.originalPath}` : ''}`;
		if (partial) {
			const others = this.state.model.listsOf(c.path).filter(id => id !== node.owner).map(id => this.state.model.get(id)?.name).filter(Boolean);
			tooltip += `\nOnly some changes of this file are in this changelist. Other changes are in: ${others.join(', ')}`;
		}
		item.tooltip = tooltip;
		item.checkboxState = this.state.isIncluded(c, node.owner) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
		item.command = { command: 'changelists.openDiff', title: 'Show Diff', arguments: [node] };
		return item;
	}

	private checkbox(files: FileChange[], owner: string): vscode.TreeItemCheckboxState | undefined {
		if (!files.length) { return undefined; }
		return files.every(f => this.state.isIncluded(f, owner)) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
	}

	private filesView(owner: string, files: FileChange[]): Node[] {
		if (!this.treeMode) { return files.map(change => ({ type: 'file', owner, change })); }
		const roots = [...new Set(files.map(f => f.repoRoot))];
		if (roots.length > 1) {
			return roots.map(root => ({
				type: 'folder', owner, dir: root, label: this.state.repoLabel(root), isRepo: true,
				files: files.filter(f => f.repoRoot === root),
			}));
		}
		return roots.length ? this.folderChildren(owner, roots[0], files) : [];
	}

	/** Direct children of `dir`: sub-folders (with single-child chains compressed) first, then files. */
	private folderChildren(owner: string, dir: string, files: FileChange[]): Node[] {
		const folders = new Map<string, FileChange[]>();
		const direct: Node[] = [];
		for (const change of files) {
			const segments = path.relative(dir, change.path).split(path.sep);
			if (segments.length === 1) {
				direct.push({ type: 'file', owner, change });
			} else {
				folders.set(segments[0], [...(folders.get(segments[0]) ?? []), change]);
			}
		}
		const folderNodes: Node[] = [...folders.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, children]) => {
				let label = name;
				let full = path.join(dir, name);
				for (;;) {
					const next = commonChildDir(full, children);
					if (!next) { break; }
					label = `${label}/${next}`;
					full = path.join(full, next);
				}
				return { type: 'folder', owner, dir: full, label, files: children, isRepo: false };
			});
		return [...folderNodes, ...direct];
	}

	// ---- Checkboxes -------------------------------------------------------------------------

	private onCheckbox(e: vscode.TreeCheckboxChangeEvent<Node>): void {
		this.state.mutate(model => {
			for (const [node, checked] of e.items) {
				model.setIncluded(this.refsUnder(node), checked === vscode.TreeItemCheckboxState.Checked);
			}
		});
	}

	filesUnder(node: Node): FileChange[] {
		switch (node.type) {
			case 'list': return this.state.filesOf(node.list.id);
			case 'unversioned': return this.state.filesOf(UNVERSIONED);
			case 'folder': return node.files;
			case 'file': return [node.change];
		}
	}

	/** Files under a node, limited to the node's list for partial files. */
	refsUnder(node: Node): FileRef[] {
		const owner = this.ownerOfNode(node);
		return this.filesUnder(node).map(f => ({ path: f.path, listId: owner === UNVERSIONED ? undefined : owner }));
	}

	ownerOfNode(node: Node): string {
		switch (node.type) {
			case 'list': return node.list.id;
			case 'unversioned': return UNVERSIONED;
			default: return node.owner;
		}
	}

	// ---- Drag and drop ----------------------------------------------------------------------

	handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
		// Dragging only changelists reorders them; anything else moves files.
		if (source.length && source.every(n => n.type === 'list')) {
			data.set(LISTS_MIME, new vscode.DataTransferItem(JSON.stringify(source.map(n => (n as ListNode).list.id))));
			return;
		}
		const refs = source.flatMap(n => (n.type === 'list' ? [] : this.refsUnder(n)));
		const files = [...new Set(refs.map(r => r.path))];
		if (!files.length) { return; }
		data.set(FILES_MIME, new vscode.DataTransferItem(JSON.stringify(refs)));
		data.set('text/uri-list', new vscode.DataTransferItem(files.filter(f => this.state.change(f)?.kind !== 'deleted').map(f => vscode.Uri.file(f).toString()).join('\r\n')));
	}

	async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
		try {
			await this.drop(target, data);
		} catch (e) {
			log().error(`Drop failed: ${e instanceof Error ? e.stack ?? e.message : e}`);
			void vscode.window.showErrorMessage(`Could not move the dragged items: ${e instanceof Error ? e.message : e}`);
		}
	}

	private async drop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
		const lists = await payload<string[]>(data.get(LISTS_MIME));
		if (Array.isArray(lists)) {
			// Dropped on a list: move in front of it. Dropped on empty space or Unversioned Files: move to the end.
			if (target && target.type !== 'list' && target.type !== 'unversioned') { return; }
			const before = target?.type === 'list' ? target.list.id : undefined;
			this.state.mutate(m => { for (const id of lists) { if (m.get(id) && id !== before) { m.reorder(id, before); } } });
			return;
		}
		if (!target) { return; }
		let refs = await payload<FileRef[]>(data.get(FILES_MIME));
		if (!Array.isArray(refs)) {
			// Dragged from the Explorer or another view: plain file URIs.
			const uris = await data.get('text/uri-list')?.asString();
			if (!uris) { return; }
			refs = uris.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).flatMap(s => {
				try { return [{ path: vscode.Uri.parse(s, true).fsPath }]; } catch { return []; }
			});
		}
		const seen = new Set<string>();
		const targets = refs.flatMap(r => {
			const change = typeof r?.path === 'string' ? this.state.change(r.path) : undefined;
			const key = `${r?.path}\0${r?.listId ?? ''}`;
			if (!change || seen.has(key)) { return []; }
			seen.add(key);
			return [{ change, list: r.listId && this.state.model.isPartial(change.path) ? r.listId : undefined }];
		});
		if (!targets.length) {
			log().info('Drop ignored: none of the dragged files is a changed file');
			return;
		}
		log().info(`Moving ${targets.length} dragged file${targets.length === 1 ? '' : 's'} to ${this.ownerOfNode(target)}`);
		await vscode.commands.executeCommand('changelists.moveFilesTo', targets, this.ownerOfNode(target));
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}

/** If every file sits under one single sub-directory of `dir`, its name; used to compress folder chains. */
function commonChildDir(dir: string, files: FileChange[]): string | undefined {
	let common: string | undefined;
	for (const f of files) {
		const segments = path.relative(dir, f.path).split(path.sep);
		if (segments.length === 1) { return undefined; }
		if (common === undefined) { common = segments[0]; } else if (common !== segments[0]) { return undefined; }
	}
	return common;
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
