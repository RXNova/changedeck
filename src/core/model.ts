import { randomUUID } from 'crypto';
import { HunkRange } from './partial';

export interface Changelist {
	id: string;
	name: string;
	/** Changelist description. Doubles as the draft commit message, as in JetBrains IDEs. */
	comment: string;
	/** Branch this changelist belongs to; it becomes active when that branch is checked out. */
	branch?: string;
	/** Color slot (1-based) chosen by the user; otherwise the list's position decides. */
	color?: number;
}

/** Hunks of a file left out of the next commit, as [start, end] base line ranges. */
export interface ExcludedHunks {
	base: string;
	ranges: [number, number][];
}

export interface PersistedState {
	version: 1;
	lists: Changelist[];
	activeId: string;
	assignments: Record<string, string>;
	included: string[];
	/** Files whose changes are split across changelists. Ranges are [start, end, listId] in base lines. */
	partials?: Record<string, { base: string; ranges: [number, number, string][] }>;
	excluded?: Record<string, ExcludedHunks>;
}

/** A file whose hunks belong to more than one changelist. */
export interface PartialFile {
	/** Blob id of the base (HEAD) version the ranges refer to. */
	base: string;
	ranges: HunkRange[];
}

/** A whole file, or (with `listId`) only the part of a partial file that belongs to one list. */
export interface FileRef {
	path: string;
	listId?: string;
}

export interface ReconcileInput {
	path: string;
	untracked: boolean;
}

export interface ReconcileOptions {
	/** Assign new untracked files to the active list instead of leaving them unversioned. */
	untrackedToActive: boolean;
	/** Paths whose repository has not reported status yet. Their assignments are kept even if absent. */
	isKnown: (path: string) => boolean;
	now?: number;
}

export const DEFAULT_LIST_NAME = 'Changes';
const PENDING_TTL_MS = 30_000;

/** Commit-selection key for the part of a partial file that belongs to one list. */
export function partKey(path: string, listId: string): string {
	return `${path}\u0000${listId}`;
}

function pathOfKey(key: string): string {
	const i = key.indexOf('\u0000');
	return i < 0 ? key : key.slice(0, i);
}

/**
 * Changelist state, independent of VS Code. A changed file is assigned to one list, or, when its
 * hunks are split across lists, it is a partial file that appears in each of them.
 * Untracked files stay unassigned ("Unversioned Files") unless moved explicitly.
 */
export class ChangelistModel {
	private lists: Changelist[] = [];
	private activeId = '';
	private readonly assignments = new Map<string, string>();
	private readonly included = new Set<string>();
	/** Assignments for files expected to appear soon (for example after unshelving). */
	private readonly pending = new Map<string, { id: string; until: number; hunksOnly: boolean }>();
	private readonly partials = new Map<string, PartialFile>();
	private readonly excluded = new Map<string, ExcludedHunks>();

	constructor(state?: PersistedState) {
		if (state && state.version === 1 && Array.isArray(state.lists) && state.lists.length > 0) {
			this.lists = state.lists.map(l => ({
				id: String(l.id), name: String(l.name), comment: String(l.comment ?? ''),
				...(typeof l.branch === 'string' && l.branch ? { branch: l.branch } : {}),
				...(typeof l.color === 'number' ? { color: l.color } : {}),
			}));
			for (const [path, e] of Object.entries(state.excluded ?? {})) {
				if (typeof e?.base === 'string' && Array.isArray(e.ranges) && e.ranges.length) { this.excluded.set(path, { base: e.base, ranges: e.ranges }); }
			}
			this.activeId = this.lists.some(l => l.id === state.activeId) ? state.activeId : this.lists[0].id;
			for (const [path, id] of Object.entries(state.assignments ?? {})) {
				if (this.get(id)) { this.assignments.set(path, id); }
			}
			for (const path of state.included ?? []) { this.included.add(path); }
			for (const [path, p] of Object.entries(state.partials ?? {})) {
				const ranges = (p.ranges ?? []).map(([start, end, listId]) => ({ start, end, listId })).filter(r => this.get(r.listId));
				if (typeof p.base === 'string' && new Set(ranges.map(r => r.listId)).size > 1) {
					this.partials.set(path, { base: p.base, ranges });
				}
			}
		} else {
			const list = { id: randomUUID(), name: DEFAULT_LIST_NAME, comment: '' };
			this.lists = [list];
			this.activeId = list.id;
		}
	}

	serialize(): PersistedState {
		return {
			version: 1,
			lists: this.lists.map(l => ({ ...l })),
			activeId: this.activeId,
			assignments: Object.fromEntries(this.assignments),
			included: [...this.included],
			excluded: Object.fromEntries(this.excluded),
			partials: Object.fromEntries([...this.partials].map(([path, p]) => [path, { base: p.base, ranges: p.ranges.map(r => [r.start, r.end, r.listId] as [number, number, string]) }])),
		};
	}

	all(): readonly Changelist[] { return this.lists; }
	get(id: string): Changelist | undefined { return this.lists.find(l => l.id === id); }
	get active(): Changelist { return this.get(this.activeId)!; }
	findByName(name: string): Changelist | undefined {
		const key = name.trim().toLocaleLowerCase();
		return this.lists.find(l => l.name.toLocaleLowerCase() === key);
	}

	/** The file's list, or for a partial file its primary list. */
	listOf(path: string): string | undefined { return this.assignments.get(path); }

	/** Every list holding changes of the file. */
	listsOf(path: string): string[] {
		const partial = this.partials.get(path);
		if (partial) { return [...new Set(partial.ranges.map(r => r.listId))]; }
		const id = this.assignments.get(path);
		return id !== undefined && this.get(id) ? [id] : [];
	}

	partialOf(path: string): PartialFile | undefined { return this.partials.get(path); }
	isPartial(path: string): boolean { return this.partials.has(path); }
	partialPaths(): string[] { return [...this.partials.keys()]; }

	/** Hunks of the file that are left out of the next commit. */
	excludedOf(path: string): ExcludedHunks | undefined { return this.excluded.get(path); }
	excludedPaths(): string[] { return [...this.excluded.keys()]; }

	/** Records which hunks are left out of the next commit. Returns true if anything changed. */
	setExcluded(path: string, base: string, ranges: [number, number][]): boolean {
		const previous = this.excluded.get(path);
		if (!ranges.length) { return this.excluded.delete(path); }
		if (previous && previous.base === base && JSON.stringify(previous.ranges) === JSON.stringify(ranges)) { return false; }
		this.excluded.set(path, { base, ranges });
		return true;
	}

	findByBranch(branch: string): Changelist | undefined { return this.lists.find(l => l.branch === branch); }

	/** Links a list to a branch (or unlinks it). A branch belongs to at most one list. */
	setBranch(id: string, branch: string | undefined): void {
		const list = this.require(id);
		if (branch) { for (const l of this.lists) { if (l.branch === branch) { delete l.branch; } } list.branch = branch; } else { delete list.branch; }
	}

	setColor(id: string, color: number | undefined): void {
		const list = this.require(id);
		if (color) { list.color = color; } else { delete list.color; }
	}

	/** Moves a list in front of another one, or to the end. */
	reorder(id: string, beforeId: string | undefined): void {
		const list = this.require(id);
		if (id === beforeId) { return; }
		const rest = this.lists.filter(l => l.id !== id);
		const index = beforeId === undefined ? -1 : rest.findIndex(l => l.id === beforeId);
		if (index < 0) { rest.push(list); } else { rest.splice(index, 0, list); }
		this.lists = rest;
	}

	/** Whether a file, or one list's part of a partial file, is checked for commit. */
	isIncluded(path: string, listId?: string): boolean {
		if (this.partials.has(path)) {
			return listId !== undefined
				? this.included.has(partKey(path, listId))
				: this.listsOf(path).every(id => this.included.has(partKey(path, id)));
		}
		return this.included.has(path);
	}

	/** Lists whose changes in the file are checked for commit. */
	includedLists(path: string): string[] {
		if (this.partials.has(path)) { return this.listsOf(path).filter(id => this.included.has(partKey(path, id))); }
		return this.included.has(path) ? this.listsOf(path) : [];
	}

	/** Pending target list for new hunks in a file (set while unshelving into it). */
	pendingListFor(path: string, now = Date.now()): string | undefined {
		const p = this.pending.get(path);
		return p && p.until > now && this.get(p.id) ? p.id : undefined;
	}

	validateName(name: string, exceptId?: string): string | undefined {
		const trimmed = name.trim();
		if (!trimmed) { return 'Enter a name.'; }
		const clash = this.findByName(trimmed);
		if (clash && clash.id !== exceptId) { return `A changelist named "${clash.name}" already exists.`; }
		return undefined;
	}

	create(name: string, comment = '', makeActive = false): Changelist {
		const error = this.validateName(name);
		if (error) { throw new Error(error); }
		const list = { id: randomUUID(), name: name.trim(), comment };
		this.lists.push(list);
		if (makeActive) { this.activeId = list.id; }
		return list;
	}

	edit(id: string, name: string, comment: string): void {
		const list = this.require(id);
		const error = this.validateName(name, id);
		if (error) { throw new Error(error); }
		list.name = name.trim();
		list.comment = comment;
	}

	setComment(id: string, comment: string): void {
		this.require(id).comment = comment;
	}

	setActive(id: string): void {
		this.require(id);
		this.activeId = id;
	}

	/** Deletes a list and moves its files to the active list. The active list cannot be deleted. */
	delete(id: string): void {
		this.require(id);
		if (id === this.activeId) { throw new Error('The active changelist cannot be deleted. Make another changelist active first.'); }
		for (const [path, listId] of this.assignments) {
			if (listId === id) { this.assignments.set(path, this.activeId); }
		}
		for (const [path, p] of this.pending) {
			if (p.id === id) { this.pending.delete(path); }
		}
		for (const path of [...this.partials.keys()]) { this.moveList(path, id, this.activeId); }
		this.lists = this.lists.filter(l => l.id !== id);
	}

	/** Moves files to a list. `undefined` unassigns them (back to Unversioned Files). */
	move(paths: Iterable<string>, id: string | undefined): void {
		if (id !== undefined) { this.require(id); }
		for (const path of paths) {
			if (this.partials.has(path)) {
				const wasIncluded = this.includedLists(path).length > 0;
				this.dropPartial(path);
				if (wasIncluded) { this.included.add(path); }
			}
			if (id === undefined) { this.assignments.delete(path); } else { this.assignments.set(path, id); }
		}
	}

	/** Moves one list's part of a partial file to another list. */
	moveList(path: string, fromId: string, toId: string): void {
		const partial = this.partials.get(path);
		if (!partial || fromId === toId) { return; }
		this.require(toId);
		const fromIncluded = this.included.has(partKey(path, fromId));
		this.included.delete(partKey(path, fromId));
		if (fromIncluded) { this.included.add(partKey(path, toId)); }
		this.setPartial(path, partial.base, partial.ranges.map(r => (r.listId === fromId ? { ...r, listId: toId } : r)));
	}

	/**
	 * Records which list owns each hunk of a file. With hunks in a single list the file stops
	 * being partial and is simply assigned to that list. Returns true if anything changed.
	 */
	setPartial(path: string, base: string, ranges: HunkRange[]): boolean {
		const valid = ranges.filter(r => this.get(r.listId));
		const lists = [...new Set(valid.map(r => r.listId))];
		const previous = this.partials.get(path);
		const before = this.listsOf(path);
		const wholeIncluded = !previous && this.included.has(path);

		if (lists.length <= 1) {
			if (!previous && (lists.length === 0 || this.assignments.get(path) === lists[0])) { return false; }
			const target = lists[0] ?? this.assignments.get(path) ?? this.activeId;
			const include = previous ? this.included.has(partKey(path, target)) || (!before.includes(target) && target === this.activeId) : this.included.has(path);
			this.dropPartial(path);
			this.assignments.set(path, target);
			if (include) { this.included.add(path); } else { this.included.delete(path); }
			return true;
		}

		const next: PartialFile = { base, ranges: valid };
		if (previous && previous.base === base && JSON.stringify(previous.ranges) === JSON.stringify(valid)) { return false; }
		this.partials.set(path, next);
		this.included.delete(path);
		for (const id of lists) {
			if (before.includes(id)) {
				if (wholeIncluded) { this.included.add(partKey(path, id)); }
			} else if (id === this.activeId) {
				// New changes in the active list are checked for commit, as for new files.
				this.included.add(partKey(path, id));
			}
		}
		for (const id of before) {
			if (!lists.includes(id)) { this.included.delete(partKey(path, id)); }
		}
		if (!lists.includes(this.assignments.get(path) ?? '')) { this.assignments.set(path, lists[0]); }
		return true;
	}

	private dropPartial(path: string): void {
		this.partials.delete(path);
		for (const key of [...this.included]) {
			if (key !== path && pathOfKey(key) === path) { this.included.delete(key); }
		}
	}

	/** Records where files that do not exist as changes yet should land once they show up. */
	expect(paths: Iterable<string>, id: string, now = Date.now()): void {
		this.require(id);
		for (const path of paths) {
			this.pending.set(path, { id, until: now + PENDING_TTL_MS, hunksOnly: false });
			this.assignments.set(path, id);
		}
	}

	/** For files that are already changed: new hunks that appear soon go to `id` (see pendingListFor). */
	expectHunks(paths: Iterable<string>, id: string, now = Date.now()): void {
		this.require(id);
		for (const path of paths) { this.pending.set(path, { id, until: now + PENDING_TTL_MS, hunksOnly: true }); }
	}

	setIncluded(refs: Iterable<string | FileRef>, include: boolean): void {
		for (const key of this.keysOf(refs)) {
			if (include) { this.included.add(key); } else { this.included.delete(key); }
		}
	}

	/** Replaces the commit selection. */
	setIncludedExactly(refs: Iterable<string | FileRef>): void {
		this.included.clear();
		for (const key of this.keysOf(refs)) { this.included.add(key); }
	}

	private keysOf(refs: Iterable<string | FileRef>): string[] {
		const keys: string[] = [];
		for (const ref of refs) {
			const { path, listId } = typeof ref === 'string' ? { path: ref, listId: undefined } : ref;
			if (!this.partials.has(path)) { keys.push(path); } else if (listId !== undefined) { keys.push(partKey(path, listId)); } else { keys.push(...this.listsOf(path).map(id => partKey(path, id))); }
		}
		return keys;
	}

	/**
	 * Brings assignments in line with the current set of changed files:
	 * new tracked changes go to the active list (and are included in the next commit),
	 * files that are no longer changed are forgotten.
	 * Returns true if anything changed.
	 */
	reconcile(changes: Iterable<ReconcileInput>, options: ReconcileOptions): boolean {
		const now = options.now ?? Date.now();
		let dirty = false;
		const present = new Set<string>();

		for (const { path, untracked } of changes) {
			present.add(path);
			const pending = this.pending.get(path);
			if (pending && !pending.hunksOnly) {
				this.pending.delete(path);
				if (this.get(pending.id) && this.assignments.get(path) !== pending.id) {
					this.assignments.set(path, pending.id);
					dirty = true;
				}
				continue;
			}
			const current = this.assignments.get(path);
			if (current !== undefined && this.get(current)) { continue; }
			if (untracked && !options.untrackedToActive) {
				if (current !== undefined) { this.assignments.delete(path); dirty = true; }
				continue;
			}
			this.assignments.set(path, this.activeId);
			this.included.add(path);
			dirty = true;
		}

		for (const path of [...this.assignments.keys()]) {
			if (present.has(path) || !options.isKnown(path)) { continue; }
			const pending = this.pending.get(path);
			if (pending && pending.until > now) { continue; }
			this.pending.delete(path);
			this.assignments.delete(path);
			dirty = true;
		}
		for (const path of [...this.partials.keys()]) {
			if (!present.has(path) && options.isKnown(path)) { this.partials.delete(path); dirty = true; }
		}
		for (const key of [...this.included]) {
			const path = pathOfKey(key);
			const stale = key !== path && !this.partials.has(path);
			if (stale || (!present.has(path) && options.isKnown(path))) {
				this.included.delete(key);
				dirty = true;
			}
		}
		for (const path of [...this.excluded.keys()]) {
			if (!present.has(path) && options.isKnown(path)) { this.excluded.delete(path); dirty = true; }
		}
		for (const [path, p] of [...this.pending]) {
			if (p.hunksOnly && p.until <= now) { this.pending.delete(path); }
		}
		return dirty;
	}

	private require(id: string): Changelist {
		const list = this.get(id);
		if (!list) { throw new Error('That changelist no longer exists.'); }
		return list;
	}
}
