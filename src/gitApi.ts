// The subset of the built-in Git extension's API (extensions/git/src/api/git.d.ts) this extension uses.
import { Disposable, Event, Uri } from 'vscode';

export interface Change {
	readonly uri: Uri;
	readonly originalUri: Uri;
	readonly renameUri: Uri | undefined;
	readonly status: number;
}

export interface Branch {
	readonly name?: string;
	readonly commit?: string;
	readonly upstream?: { readonly remote: string; readonly name: string };
}

export interface RepositoryState {
	readonly HEAD: Branch | undefined;
	readonly mergeChanges: Change[];
	readonly indexChanges: Change[];
	readonly workingTreeChanges: Change[];
	/** Present in newer VS Code versions when untracked changes are shown separately. */
	readonly untrackedChanges?: Change[];
	readonly onDidChange: Event<void>;
}

export interface Repository {
	readonly rootUri: Uri;
	readonly state: RepositoryState;
	status(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

export interface API {
	readonly state: 'uninitialized' | 'initialized';
	readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
	readonly git: { readonly path: string };
	readonly repositories: Repository[];
	readonly onDidOpenRepository: Event<Repository>;
	readonly onDidCloseRepository: Event<Repository>;
	toGitUri(uri: Uri, ref: string): Uri;
}

export interface GitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: Event<boolean>;
	getAPI(version: 1): API;
}

export type { Disposable };
