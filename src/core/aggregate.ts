import { ChangeKind, FileChange, RawRepoState, Status } from './types';

/**
 * Merges the separate status buckets the Git extension reports into one entry per path.
 * A file that is both staged and modified appears once. A staged rename is keyed by its new path.
 */
export function aggregate(state: RawRepoState): Map<string, FileChange> {
	const result = new Map<string, FileChange>();
	const entry = (path: string): FileChange => {
		let e = result.get(path);
		if (!e) {
			e = { path, repoRoot: state.root, kind: 'modified', newInIndex: false, untracked: false, conflicted: false };
			result.set(path, e);
		}
		return e;
	};

	for (const c of state.merge) {
		const e = entry(c.path);
		e.kind = 'conflicted';
		e.conflicted = true;
	}

	for (const c of state.index) {
		const e = entry(c.path);
		if (e.conflicted) { continue; }
		e.staged = true;
		switch (c.status) {
			case Status.INDEX_ADDED: e.kind = 'added'; e.newInIndex = true; break;
			case Status.INDEX_DELETED: e.kind = 'deleted'; break;
			case Status.INDEX_RENAMED:
				e.kind = 'renamed';
				e.newInIndex = true;
				if (c.originalPath && c.originalPath !== c.path) { e.originalPath = c.originalPath; }
				break;
			case Status.INDEX_COPIED:
				e.kind = 'copied';
				e.newInIndex = true;
				if (c.originalPath && c.originalPath !== c.path) { e.originalPath = c.originalPath; }
				break;
			case Status.TYPE_CHANGED: e.kind = 'typechange'; break;
			default: e.kind = 'modified';
		}
	}

	for (const c of [...state.workingTree, ...state.untracked]) {
		if (c.status === Status.IGNORED) { continue; }
		const existing = result.get(c.path);
		if (existing?.conflicted) { continue; }
		const e = existing ?? entry(c.path);
		const kind = worktreeKind(c.status);
		switch (c.status) {
			case Status.UNTRACKED:
				e.kind = 'untracked';
				e.untracked = true;
				break;
			case Status.INTENT_TO_ADD:
				e.kind = 'added';
				e.newInIndex = true;
				break;
			case Status.INTENT_TO_RENAME:
				e.kind = 'renamed';
				e.newInIndex = true;
				if (c.originalPath && c.originalPath !== c.path) { e.originalPath = c.originalPath; }
				break;
			case Status.DELETED:
				e.kind = 'deleted';
				break;
			default:
				// A modification on top of a staged add/rename/copy keeps the staged kind.
				if (!existing || existing.kind === 'modified') { e.kind = kind; }
		}
	}
	return result;
}

function worktreeKind(status: number): ChangeKind {
	switch (status) {
		case Status.DELETED: return 'deleted';
		case Status.UNTRACKED: return 'untracked';
		case Status.TYPE_CHANGED: return 'typechange';
		default: return 'modified';
	}
}
