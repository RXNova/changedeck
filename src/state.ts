import * as path from 'path';
import * as vscode from 'vscode';
import { ChangelistModel, PersistedState } from './core/model';
import { FileChange } from './core/types';
import { Repositories } from './repositories';

/** Owner key of untracked files that are not in any changelist. */
export const UNVERSIONED = '__unversioned__';

const STATE_KEY = 'changelists.state';
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

/** The changelist model joined with live Git status. Views and commands read from here. */
export class ChangelistState implements vscode.Disposable {
	readonly model: ChangelistModel;
	private changes = new Map<string, FileChange>();
	/** Lower-cased path index for case-insensitive file systems (macOS, Windows). */
	private folded = new Map<string, FileChange>();
	private byOwner = new Map<string, FileChange[]>();
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];
	private saveTimer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext, readonly repos: Repositories) {
		this.model = new ChangelistModel(context.workspaceState.get<PersistedState>(STATE_KEY));
		this.disposables.push(
			repos.onDidChange(() => this.sync()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('changelists')) { this.sync(); }
			}),
		);
		this.sync();
	}

	/** Reconciles the model with Git status and notifies listeners. */
	sync(): void {
		this.changes = this.repos.changes();
		const untrackedToActive = vscode.workspace.getConfiguration('changelists').get<boolean>('untrackedFilesGoToActive', false);
		const dirty = this.model.reconcile(
			[...this.changes.values()].map(c => ({ path: c.path, untracked: c.untracked })),
			{ untrackedToActive, isKnown: p => this.repos.isKnown(p) },
		);
		this.rebuild();
		if (dirty) { this.save(); }
		this.emitter.fire();
	}

	/** Applies a model change, then saves and notifies. */
	mutate<T>(fn: (model: ChangelistModel) => T): T {
		const result = fn(this.model);
		this.rebuild();
		this.save();
		this.emitter.fire();
		return result;
	}

	/** Applies a model change that reports whether it changed anything; saves and notifies only then. */
	update(fn: (model: ChangelistModel) => boolean): boolean {
		if (!fn(this.model)) { return false; }
		this.rebuild();
		this.save();
		this.emitter.fire();
		return true;
	}

	/** Saves without notifying, debounced (used while typing the commit message). */
	saveSoon(): void {
		if (this.saveTimer) { clearTimeout(this.saveTimer); }
		this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.save(); }, 300);
	}

	allChanges(): FileChange[] { return [...this.changes.values()]; }
	/** The change for a path. On macOS and Windows, a path that differs only in case also matches. */
	change(file: string): FileChange | undefined {
		return this.changes.get(file) ?? (CASE_INSENSITIVE ? this.folded.get(file.toLowerCase()) : undefined);
	}

	ownerOf(file: string): string {
		const id = this.model.listOf(file);
		return id !== undefined && this.model.get(id) ? id : UNVERSIONED;
	}

	filesOf(owner: string): FileChange[] { return this.byOwner.get(owner) ?? []; }

	/** Files with any checked part. */
	included(): FileChange[] { return this.allChanges().filter(c => this.model.includedLists(c.path).length > 0 || this.model.isIncluded(c.path)); }

	/** Whether a file (in the context of the list it is shown under) is checked for commit. */
	isIncluded(c: FileChange, owner: string): boolean {
		return this.model.isPartial(c.path) ? this.model.isIncluded(c.path, owner) : this.model.isIncluded(c.path);
	}

	/**
	 * What the next commit contains: per file either everything (`lists` undefined) or only the
	 * changes of some lists of a partial file.
	 */
	selection(): { change: FileChange; lists?: string[] }[] {
		const result: { change: FileChange; lists?: string[] }[] = [];
		for (const c of this.allChanges()) {
			if (this.model.isPartial(c.path)) {
				const included = this.model.includedLists(c.path);
				if (!included.length) { continue; }
				result.push({ change: c, lists: included.length === this.model.listsOf(c.path).length ? undefined : included });
			} else if (this.model.isIncluded(c.path)) {
				result.push({ change: c });
			}
		}
		return result;
	}

	repoLabel(root: string): string { return path.basename(root); }

	/** Repository-relative display path using forward slashes. */
	relative(c: FileChange): string {
		return path.relative(c.repoRoot, c.path).split(path.sep).join('/');
	}

	private rebuild(): void {
		if (CASE_INSENSITIVE) { this.folded = new Map([...this.changes].map(([p, c]) => [p.toLowerCase(), c])); }
		const byOwner = new Map<string, FileChange[]>();
		const add = (owner: string, c: FileChange) => {
			let list = byOwner.get(owner);
			if (!list) { byOwner.set(owner, list = []); }
			list.push(c);
		};
		for (const c of this.changes.values()) {
			if (this.model.isPartial(c.path)) {
				this.model.listsOf(c.path).forEach(id => add(id, c));
				continue;
			}
			const owner = this.ownerOf(c.path);
			if (owner === UNVERSIONED && !c.untracked) { continue; }
			add(owner, c);
		}
		const key = (c: FileChange) => `${c.repoRoot}\0${this.relative(c).toLocaleLowerCase()}`;
		for (const list of byOwner.values()) { list.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0); }
		this.byOwner = byOwner;
	}

	private save(): void {
		void this.context.workspaceState.update(STATE_KEY, this.model.serialize());
	}

	dispose(): void {
		if (this.saveTimer) { clearTimeout(this.saveTimer); this.save(); }
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}
