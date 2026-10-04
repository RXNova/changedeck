import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { applyHunks, diffLines, dominantList, Hunk, HunkRange, looksBinary, mapRanges, matchEol, matchLists, matchRanges, splitLines, toRanges } from './core/partial';
import { FileChange } from './core/types';
import { log } from './log';
import { Repositories } from './repositories';
import { ChangelistState } from './state';

/** Hunks of a file and the changelist of each. */
export interface FileHunks {
	/** Blob id of the HEAD version the hunks are relative to. */
	base: string;
	hunks: Hunk[];
	lists: string[];
	/** Hunks left out of the next commit. */
	excluded: boolean[];
}

/** Content of a partial file restricted to some lists, computed from disk. */
export interface PartSelection extends FileHunks {
	/** Base plus the hunks of the requested lists. */
	content: string;
	/** Base plus the hunks of all other lists. */
	remaining: string;
	selected: (index: number) => boolean;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export function partialEnabled(): boolean {
	return vscode.workspace.getConfiguration('changelists').get('partialChangelists', true);
}

/**
 * Keeps track of which changelist each hunk of a file belongs to, as the file is edited.
 *
 * Open editors of changed files are followed live. A hunk keeps its list while it is edited;
 * a hunk that appears where there was none goes to the active changelist, which is how a file
 * ends up split across lists (as in JetBrains IDEs). Partial files that are not open are
 * re-checked when Git reports changes.
 */
export class PartialTracker implements vscode.Disposable {
	private readonly cache = new Map<string, FileHunks>();
	private readonly bases = new Map<string, Promise<{ sha: string; bytes: Buffer } | undefined>>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly queue = new Map<string, Promise<void>>();
	/** Active changelist at the time of the first edit not yet processed, per file. */
	private readonly activeAtEdit = new Map<string, string>();
	private lastActive: string;
	/** Hunk ranges carried over to a new base by this extension (after a partial commit). */
	private readonly carried = new Map<string, { base: string; ranges: HunkRange[] }>();
	private readonly emitter = new vscode.EventEmitter<string>();
	/** Fires with a file path when its hunks or their lists change. */
	readonly onDidChange = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly state: ChangelistState, private readonly repos: Repositories) {
		this.lastActive = state.model.active.id;
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument(e => {
				if (e.document.uri.scheme === 'file' && e.contentChanges.length && !this.activeAtEdit.has(e.document.uri.fsPath)) {
					this.activeAtEdit.set(e.document.uri.fsPath, this.state.model.active.id);
				}
				this.schedule(e.document, 250);
			}),
			vscode.workspace.onDidOpenTextDocument(d => this.schedule(d, 0)),
			vscode.workspace.onDidCloseTextDocument(d => {
				const p = d.uri.fsPath;
				if (d.uri.scheme === 'file' && !this.state.model.isPartial(p) && !this.state.model.pendingListFor(p)) { this.cache.delete(p); }
			}),
			state.onDidChange(() => this.onStateChange()),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('changelists.partialChangelists') && !partialEnabled()) { this.collapseAll(); }
			}),
		);
		this.scheduleAll();
	}

	private pauseDepth = 0;
	private missed = false;

	/**
	 * Runs `fn` with tracking paused. Operations that rewrite files in steps (such as shelving part
	 * of a file) would otherwise be observed half-way. Everything is re-checked afterwards.
	 */
	async paused<T>(fn: () => Promise<T>): Promise<T> {
		this.pauseDepth++;
		try {
			return await fn();
		} finally {
			if (--this.pauseDepth === 0 && this.missed) {
				this.missed = false;
				this.scheduleAll();
			}
		}
	}

	/** Last computed hunks of a file (from its editor if open). */
	hunks(path: string): FileHunks | undefined { return this.cache.get(path); }

	/** Recomputes a file now and returns its hunks. */
	async refreshNow(path: string): Promise<FileHunks | undefined> {
		await this.enqueue(path, true);
		return this.cache.get(path);
	}

	/** Starts following files that are about to receive changes (for example before unshelving). */
	async snapshot(paths: string[]): Promise<void> {
		await Promise.all(paths.map(p => this.enqueue(p, true)));
	}

	/**
	 * Splits a file's current disk content: the hunks of the given lists (all lists if undefined),
	 * minus hunks excluded from the commit when `applyExclusions` is set. Returns undefined when
	 * that is simply the whole file, in which case callers treat it as a whole file.
	 */
	async selection(change: FileChange, listIds: readonly string[] | undefined, applyExclusions = false): Promise<PartSelection | undefined> {
		const model = this.state.model;
		const partial = model.partialOf(change.path);
		const exclusions = applyExclusions ? model.excludedOf(change.path) : undefined;
		if ((!partial || !listIds) && !exclusions) { return undefined; }
		if (!eligible(change)) { return undefined; }
		const base = await this.baseOf(change, true);
		if (!base) { return undefined; }
		const usePartial = partial && partial.base === base.sha ? partial : undefined;
		const useExclusions = exclusions && exclusions.base === base.sha ? exclusions : undefined;
		if ((!usePartial || !listIds) && !useExclusions) { return undefined; }

		const current = await fs.readFile(change.path);
		const text = current.toString('latin1');
		const baseText = matchEol(base.bytes.toString('latin1'), text);
		if (looksBinary(baseText) || looksBinary(text)) { return undefined; }
		const baseLines = splitLines(baseText);
		const lines = splitLines(text);
		const hunks = diffLines(baseLines, lines);
		const fileList = model.listOf(change.path) ?? model.active.id;
		const lists = usePartial ? matchLists(hunks, usePartial.ranges, model.active.id, id => !!model.get(id)) : hunks.map(() => fileList);
		const excluded = useExclusions ? matchRanges(hunks, useExclusions.ranges.map(([start, end]) => ({ start, end }))) : hunks.map(() => false);
		const wanted = usePartial && listIds ? new Set(listIds) : undefined;
		const selected = (i: number) => (!wanted || wanted.has(lists[i])) && !excluded[i];
		return {
			base: base.sha, hunks, lists, excluded, selected,
			content: applyHunks(baseLines, lines, hunks, selected),
			remaining: applyHunks(baseLines, lines, hunks, i => !selected(i)),
		};
	}

	/** Leaves the hunks at the given indices out of (or puts them back into) the next commit. */
	setExcluded(path: string, indices: number[], exclude: boolean): void {
		const entry = this.cache.get(path);
		if (!entry) { return; }
		const excluded = entry.excluded.map((e, i) => (indices.includes(i) ? exclude : e));
		this.cache.set(path, { ...entry, excluded });
		this.state.update(m => m.setExcluded(path, entry.base, excludedRanges(entry.hunks, excluded)));
		this.emitter.fire(path);
	}

	/** Reassigns the hunks at the given indices (of the cached hunks) to a list. */
	moveHunks(path: string, indices: number[], listId: string): void {
		const entry = this.cache.get(path);
		if (!entry) { return; }
		const lists = entry.lists.map((id, i) => (indices.includes(i) ? listId : id));
		this.cache.set(path, { ...entry, lists });
		this.state.update(m => m.setPartial(path, entry.base, toRanges(entry.hunks, lists)));
		this.emitter.fire(path);
	}

	/** Remembers where the remaining hunks of a file are after its base moved to `base`. */
	carryOver(path: string, base: string, ranges: HunkRange[]): void {
		this.carried.set(path, { base, ranges });
	}

	/** Base versions are cached per HEAD commit, so moving HEAD invalidates them. */
	private async baseKey(change: FileChange, verify: boolean): Promise<string> {
		const head = verify
			? await this.repos.git(change.repoRoot).revParse('HEAD') ?? ''
			: this.repos.repository(change.repoRoot)?.state.HEAD?.commit ?? '';
		return `${head}\0${change.path}`;
	}

	/** HEAD version of a file. `verify` asks Git for HEAD instead of trusting the possibly stale status. */
	private async baseOf(change: FileChange, verify = false): Promise<{ sha: string; bytes: Buffer } | undefined> {
		const key = await this.baseKey(change, verify);
		let p = this.bases.get(key);
		if (!p) {
			if (this.bases.size > 500) { this.bases.clear(); }
			const git = this.repos.git(change.repoRoot);
			const rel = git.rel(change.path);
			p = (async () => {
				const entry = await git.entry('HEAD', rel);
				if (!entry) { return undefined; }
				const bytes = await git.readFiltered('HEAD', rel);
				return bytes && bytes.length <= MAX_FILE_BYTES ? { sha: entry.sha, bytes } : undefined;
			})();
			p.catch(() => this.bases.delete(key));
			this.bases.set(key, p);
		}
		return p;
	}

	private schedule(doc: vscode.TextDocument, delay: number): void {
		if (doc.uri.scheme !== 'file' || !partialEnabled()) { return; }
		this.schedulePath(doc.uri.fsPath, delay);
	}

	private onStateChange(): void {
		if (this.state.model.active.id !== this.lastActive) {
			this.lastActive = this.state.model.active.id;
			// Settle edits made under the previous active list before any edit under the new one.
			for (const path of [...this.activeAtEdit.keys()]) {
				const t = this.timers.get(path);
				if (t) { clearTimeout(t); this.timers.delete(path); }
				void this.enqueue(path);
			}
		}
		this.scheduleAll();
	}

	private scheduleAll(): void {
		if (!partialEnabled()) { return; }
		const paths = new Set<string>([...this.state.model.partialPaths(), ...this.state.model.excludedPaths(), ...this.cache.keys()]);
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme === 'file' && !this.cache.has(doc.uri.fsPath) && this.repos.repositoryOf(doc.uri.fsPath)) { paths.add(doc.uri.fsPath); }
		}
		paths.forEach(p => this.schedulePath(p, 100));
	}

	private schedulePath(path: string, delay: number): void {
		const t = this.timers.get(path);
		if (t) { clearTimeout(t); }
		this.timers.set(path, setTimeout(() => { this.timers.delete(path); void this.enqueue(path); }, delay));
	}

	/** Runs updates of the same file one after another. */
	private enqueue(path: string, force = false): Promise<void> {
		const previous = this.queue.get(path) ?? Promise.resolve();
		const next = previous.then(() => this.update(path, force)).catch(e => log().error(`Line tracking failed for ${path}: ${e instanceof Error ? e.message : e}`));
		this.queue.set(path, next);
		void next.then(() => { if (this.queue.get(path) === next) { this.queue.delete(path); } });
		return next;
	}

	private async update(path: string, force: boolean): Promise<void> {
		if (!partialEnabled()) { return; }
		if (this.pauseDepth > 0 && !force) { this.missed = true; return; }
		const model = this.state.model;
		const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path);
		if (!force && !doc && !model.isPartial(path) && !model.excludedOf(path) && !this.cache.has(path)) { return; }
		const editList = this.activeAtEdit.get(path);
		this.activeAtEdit.delete(path);

		// Follow tracked files even before Git reports them as changed, so every hunk is attributed
		// to the list that was active when it was typed.
		const change = this.state.change(path);
		if (change && !eligible(change)) { this.forget(path); return; }
		const repo = change ? undefined : this.repos.repositoryOf(path);
		const subject: FileChange | undefined = change ?? (repo && {
			path, repoRoot: repo.rootUri.fsPath, kind: 'modified', newInIndex: false, untracked: false, conflicted: false,
		});
		if (!subject) { this.forget(path); return; }

		let base = await this.baseOf(subject).catch(() => undefined);
		const known = model.partialOf(path);
		if (base && known && known.base !== base.sha) { base = await this.baseOf(subject, true).catch(() => undefined); }
		// An editor's text counts only while it has unsaved edits. Otherwise the file on disk is the
		// truth: after Git rewrites a file (unshelve, rollback), the editor can lag behind or miss
		// the change, and its stale text would hide the new hunks.
		const onDisk = doc?.isDirty ? undefined : await fs.readFile(path, 'utf8').catch(() => undefined);
		const text = onDisk ?? doc?.getText();
		if (!base || text === undefined || text.length > MAX_FILE_BYTES) { this.forget(path); return; }
		const baseText = matchEol(base.bytes.toString('utf8'), text);
		if (looksBinary(baseText) || looksBinary(text)) { this.forget(path); return; }

		const baseLines = splitLines(baseText);
		const hunks = diffLines(baseLines, splitLines(text));
		let fallback = model.pendingListFor(path) ?? editList ?? model.active.id;
		const partial = model.partialOf(path);

		let stored: HunkRange[] | undefined;
		if (partial && partial.base === base.sha) {
			stored = partial.ranges;
		} else if (partial) {
			// HEAD moved outside this extension (pull, checkout, rebase...). Carry the ranges over by
			// diffing the old base against the new one; if the old base is gone, keep the main list.
			const main = dominantList(partial.ranges) ?? model.listOf(path) ?? model.active.id;
			const git = this.repos.git(subject.repoRoot);
			const old = await git.readBlobFiltered(partial.base, git.rel(path)).catch(() => undefined);
			const oldText = old?.toString('utf8');
			if (oldText !== undefined && !looksBinary(oldText)) {
				stored = mapRanges(diffLines(splitLines(oldText), baseLines), partial.ranges);
				fallback = model.pendingListFor(path) ?? editList ?? main;
				log().info(`Carried the changelists of ${git.rel(path)} over to the new HEAD`);
			} else {
				this.state.update(m => m.setPartial(path, base!.sha, [{ start: 0, end: 0, listId: main }]));
			}
		} else {
			const carried = this.carried.get(path);
			const previous = this.cache.get(path);
			if (carried && carried.base === base.sha) {
				stored = carried.ranges;
				this.carried.delete(path);
			} else if (previous && previous.base === base.sha) {
				stored = toRanges(previous.hunks, previous.lists);
			}
		}

		// Without history (first sight of an already changed file) everything belongs to the file's list.
		const lists = stored
			? matchLists(hunks, stored, fallback, id => !!model.get(id))
			: hunks.map(() => model.pendingListFor(path) ?? model.listOf(path) ?? fallback);
		// Exclusions from the commit follow their hunks the same way; they do not survive a base change.
		const storedExcluded = model.excludedOf(path);
		const excluded = storedExcluded && storedExcluded.base === base.sha
			? matchRanges(hunks, storedExcluded.ranges.map(([start, end]) => ({ start, end })))
			: hunks.map(() => false);
		const before = this.cache.get(path);
		this.cache.set(path, { base: base.sha, hunks, lists, excluded });
		if (change && hunks.length) { this.state.update(m => m.setPartial(path, base!.sha, toRanges(hunks, lists))); }
		if (change && storedExcluded) { this.state.update(m => m.setExcluded(path, base!.sha, excludedRanges(hunks, excluded))); }
		if (!before || JSON.stringify(before.hunks) !== JSON.stringify(hunks) || before.lists.join() !== lists.join() || before.excluded.join() !== excluded.join()) { this.emitter.fire(path); }
	}

	private forget(path: string): void {
		const had = this.cache.delete(path);
		if (this.state.model.excludedOf(path)) { this.state.update(m => m.setExcluded(path, '', [])); }
		if (this.state.model.isPartial(path)) {
			const partial = this.state.model.partialOf(path)!;
			const main = dominantList(partial.ranges) ?? this.state.model.listOf(path) ?? this.state.model.active.id;
			this.state.update(m => m.setPartial(path, partial.base, [{ start: 0, end: 0, listId: main }]));
		}
		if (had) { this.emitter.fire(path); }
	}

	private collapseAll(): void {
		for (const path of this.state.model.partialPaths()) { this.forget(path); }
		this.cache.clear();
	}

	dispose(): void {
		this.timers.forEach(t => clearTimeout(t));
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}

function excludedRanges(hunks: Hunk[], excluded: boolean[]): [number, number][] {
	return hunks.flatMap((h, i) => (excluded[i] ? [[h.baseStart, h.baseEnd] as [number, number]] : []));
}

/** Only plain modifications can be split: added, deleted, renamed or conflicted files move as a whole. */
export function eligible(change: FileChange): boolean {
	return change.kind === 'modified' && !change.untracked && !change.conflicted;
}
