/** Mirrors the `Status` enum of the built-in Git extension API (extensions/git/src/api/git.d.ts). */
export const Status = {
	INDEX_MODIFIED: 0,
	INDEX_ADDED: 1,
	INDEX_DELETED: 2,
	INDEX_RENAMED: 3,
	INDEX_COPIED: 4,
	MODIFIED: 5,
	DELETED: 6,
	UNTRACKED: 7,
	IGNORED: 8,
	INTENT_TO_ADD: 9,
	INTENT_TO_RENAME: 10,
	TYPE_CHANGED: 11,
	ADDED_BY_US: 12,
	ADDED_BY_THEM: 13,
	DELETED_BY_US: 14,
	DELETED_BY_THEM: 15,
	BOTH_ADDED: 16,
	BOTH_DELETED: 17,
	BOTH_MODIFIED: 18,
} as const;

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted' | 'typechange';

/** One changed file, merged from the index, working tree and merge buckets. Paths are absolute. */
export interface FileChange {
	path: string;
	repoRoot: string;
	/** Source path of a rename or copy. */
	originalPath?: string;
	kind: ChangeKind;
	/** True when the file is not in HEAD (staged add, intent-to-add, or the new side of a rename). */
	newInIndex: boolean;
	untracked: boolean;
	conflicted: boolean;
	/** True when the index differs from HEAD for this file. */
	staged?: boolean;
}

export interface RawChange {
	path: string;
	originalPath?: string;
	status: number;
}

export interface RawRepoState {
	root: string;
	merge: RawChange[];
	index: RawChange[];
	workingTree: RawChange[];
	untracked: RawChange[];
}
