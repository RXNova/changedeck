import * as path from 'path';
import * as vscode from 'vscode';
import { listShelves, ShelfFile, shelfFiles, shelfNameFromSubject, ShelfRef, showFile } from './core/git';
import { log } from './log';
import { Repositories } from './repositories';

export const GIT_CONTENT_SCHEME = 'changelists-git';
const SHELF_FILE_SCHEME = 'changelists-shelf';
const META_KEY = 'changelists.shelfMeta';

/** `branch` is set when shelved by Switch Branch, so the changes come back with that branch. */
export interface ShelfMeta { name: string; listName?: string; branch?: string }

export interface ShelfNode {
	readonly type: 'shelf';
	readonly root: string;
	readonly ref: ShelfRef;
	readonly name: string;
	readonly listName?: string;
	readonly branch?: string;
}

export interface ShelfFileNode {
	readonly type: 'shelfFile';
	readonly shelf: ShelfNode;
	readonly file: ShelfFile;
}

export type ShelfTreeNode = ShelfNode | ShelfFileNode;

export function isShelfNode(value: unknown): value is ShelfNode {
	return !!value && typeof value === 'object' && (value as ShelfNode).type === 'shelf';
}

/** Lists shelved change sets of every open repository. */
export class ShelfView implements vscode.TreeDataProvider<ShelfTreeNode>, vscode.FileDecorationProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<ShelfTreeNode | undefined>();
	readonly onDidChangeTreeData = this.emitter.event;
	readonly view: vscode.TreeView<ShelfTreeNode>;
	private shelves: ShelfNode[] = [];
	private readonly files = new Map<string, Promise<ShelfFile[]>>();
	private readonly disposables: vscode.Disposable[] = [];
	private loading: Promise<void> | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly repos: Repositories) {
		this.view = vscode.window.createTreeView('changelists.shelf', { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
		this.disposables.push(
			this.view,
			vscode.window.registerFileDecorationProvider(this),
			vscode.workspace.registerTextDocumentContentProvider(GIT_CONTENT_SCHEME, new GitContentProvider(repos)),
		);
		void this.reload();
	}

	all(): ShelfNode[] { return this.shelves; }

	meta(id: string): ShelfMeta | undefined {
		return this.context.workspaceState.get<Record<string, ShelfMeta>>(META_KEY, {})[id];
	}

	async setMeta(id: string, meta: ShelfMeta | undefined): Promise<void> {
		const all = { ...this.context.workspaceState.get<Record<string, ShelfMeta>>(META_KEY, {}) };
		if (meta) { all[id] = meta; } else { delete all[id]; }
		await this.context.workspaceState.update(META_KEY, all);
	}

	reload(): Promise<void> {
		const run = async () => {
			const result: ShelfNode[] = [];
			for (const repo of this.repos.all) {
				const root = repo.rootUri.fsPath;
				try {
					for (const ref of await listShelves(this.repos.git(root))) {
						const meta = this.meta(ref.id);
						result.push({ type: 'shelf', root, ref, name: meta?.name ?? shelfNameFromSubject(ref.subject), listName: meta?.listName, branch: meta?.branch });
					}
				} catch (e) {
					log().error(`Could not list shelves in ${root}: ${e instanceof Error ? e.message : e}`);
				}
			}
			result.sort((a, b) => b.ref.date - a.ref.date);
			this.shelves = result;
			this.files.clear();
			this.view.badge = undefined;
			this.view.description = result.length ? `${result.length}` : undefined;
			this.emitter.fire(undefined);
		};
		this.loading = (this.loading ?? Promise.resolve()).then(run, run);
		return this.loading;
	}

	filesOf(shelf: ShelfNode): Promise<ShelfFile[]> {
		let p = this.files.get(shelf.ref.sha);
		if (!p) {
			p = shelfFiles(this.repos.git(shelf.root), shelf.ref.sha);
			this.files.set(shelf.ref.sha, p);
			p.catch(() => this.files.delete(shelf.ref.sha));
		}
		return p;
	}

	async getChildren(node?: ShelfTreeNode): Promise<ShelfTreeNode[]> {
		if (!node) { return this.shelves; }
		if (node.type === 'shelf') {
			const files = await this.filesOf(node);
			return files.sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ type: 'shelfFile', shelf: node, file }));
		}
		return [];
	}

	getTreeItem(node: ShelfTreeNode): vscode.TreeItem {
		if (node.type === 'shelf') {
			const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
			item.id = `shelf:${node.root}:${node.ref.id}`;
			item.contextValue = 'shelf';
			item.iconPath = new vscode.ThemeIcon('archive');
			const parts = [relativeTime(node.ref.date)];
			if (this.repos.count > 1) { parts.push(path.basename(node.root)); }
			item.description = parts.join(' · ');
			const date = new Date(node.ref.date).toLocaleString();
			item.tooltip = `${node.name}\nShelved ${date}${node.listName ? ` from "${node.listName}"` : ''}\n${node.root}`;
			return item;
		}
		const uri = vscode.Uri.file(path.join(node.shelf.root, ...node.file.path.split('/'))).with({ scheme: SHELF_FILE_SCHEME, query: node.file.status });
		const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
		item.id = `shelf:${node.shelf.root}:${node.shelf.ref.id}:${node.file.path}`;
		item.label = path.posix.basename(node.file.path);
		const dir = path.posix.dirname(node.file.path);
		item.description = dir === '.' ? '' : dir;
		item.contextValue = 'shelfFile';
		item.command = { command: 'changelists.openShelfDiff', title: 'Show Shelved Diff', arguments: [node] };
		return item;
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== SHELF_FILE_SCHEME) { return undefined; }
		switch (uri.query) {
			case 'A': return { badge: 'A', tooltip: 'Added', color: new vscode.ThemeColor('gitDecoration.addedResourceForeground') };
			case 'D': return { badge: 'D', tooltip: 'Deleted', color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground') };
			case 'M': return { badge: 'M', tooltip: 'Modified', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') };
			default: return undefined;
		}
	}

	/** Opens a diff of one shelved file against the commit it was shelved from. */
	async openDiff(node: ShelfFileNode): Promise<void> {
		const { shelf, file } = node;
		const sha = shelf.ref.sha;
		const left = file.untracked || file.status === 'A' ? emptyUri(shelf.root, file.path) : gitContentUri(shelf.root, `${sha}^1`, file.path);
		const right = file.status === 'D' ? emptyUri(shelf.root, file.path) : gitContentUri(shelf.root, file.untracked ? `${sha}^3` : sha, file.path);
		await vscode.commands.executeCommand('vscode.diff', left, right, `${path.posix.basename(file.path)} (Shelved: ${shelf.name})`, { preview: true });
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}

export function gitContentUri(root: string, rev: string, relPath: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GIT_CONTENT_SCHEME, path: '/' + relPath, query: JSON.stringify({ root, rev }) });
}

function emptyUri(root: string, relPath: string): vscode.Uri {
	return vscode.Uri.from({ scheme: GIT_CONTENT_SCHEME, path: '/' + relPath, query: JSON.stringify({ root, rev: '' }) });
}

class GitContentProvider implements vscode.TextDocumentContentProvider {
	constructor(private readonly repos: Repositories) { }

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const { root, rev } = JSON.parse(uri.query) as { root: string; rev: string };
		if (!rev) { return ''; }
		const content = await showFile(this.repos.git(root), rev, uri.path.slice(1));
		return content ? content.toString('utf8') : '';
	}
}

function relativeTime(ms: number): string {
	const seconds = Math.round((Date.now() - ms) / 1000);
	const units: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
	let value = seconds;
	for (const [size, unit] of units) {
		if (Math.abs(value) < size) { return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-Math.round(value), unit); }
		value /= size;
	}
	return '';
}
