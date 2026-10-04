import * as path from 'path';
import * as vscode from 'vscode';
import { aggregate } from './core/aggregate';
import { Git } from './core/git';
import { FileChange, RawChange } from './core/types';
import { API, Change, Repository } from './gitApi';

interface Tracked {
	repo: Repository;
	git: Git;
	/** Set once the repository has reported status, so missing files really mean "not changed". */
	ready: boolean;
	changes: Map<string, FileChange>;
	subscription: vscode.Disposable;
}

/** Follows every repository the Git extension opens and keeps a merged view of their changes. */
export class Repositories implements vscode.Disposable {
	private readonly tracked = new Map<string, Tracked>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;
	private timer: NodeJS.Timeout | undefined;

	constructor(readonly api: API) {
		this.disposables.push(
			api.onDidOpenRepository(r => this.open(r)),
			api.onDidCloseRepository(r => this.close(r)),
		);
		api.repositories.forEach(r => this.open(r));
	}

	get all(): Repository[] { return [...this.tracked.values()].map(t => t.repo); }
	get count(): number { return this.tracked.size; }

	/** Changes of all repositories, keyed by absolute path. */
	changes(): Map<string, FileChange> {
		const all = new Map<string, FileChange>();
		for (const t of this.tracked.values()) {
			for (const [p, c] of t.changes) { all.set(p, c); }
		}
		return all;
	}

	git(root: string): Git {
		const t = this.tracked.get(root);
		if (!t) { throw new Error(`No Git repository is open at ${root}.`); }
		return t.git;
	}

	repository(root: string): Repository | undefined {
		return this.tracked.get(root)?.repo;
	}

	/** The innermost repository containing a path. */
	repositoryOf(file: string): Repository | undefined {
		let best: Tracked | undefined;
		for (const [root, t] of this.tracked) {
			if (isInside(file, root) && (!best || root.length > best.repo.rootUri.fsPath.length)) { best = t; }
		}
		return best?.repo;
	}

	/** False while the repository owning the path has not reported status yet. */
	isKnown(file: string): boolean {
		const repo = this.repositoryOf(file);
		return !!repo && !!this.tracked.get(repo.rootUri.fsPath)?.ready;
	}

	async refresh(roots?: Iterable<string>): Promise<void> {
		const targets = roots ? [...new Set(roots)].map(r => this.tracked.get(r)).filter((t): t is Tracked => !!t) : [...this.tracked.values()];
		await Promise.all(targets.map(t => t.repo.status().catch(() => undefined)));
		targets.forEach(t => this.update(t));
		this.emitter.fire();
	}

	private open(repo: Repository): void {
		const root = repo.rootUri.fsPath;
		if (this.tracked.has(root)) { return; }
		const t: Tracked = {
			repo,
			git: new Git(this.api.git.path, root),
			ready: false,
			changes: new Map(),
			subscription: repo.state.onDidChange(() => { t.ready = true; this.update(t); this.schedule(); }),
		};
		this.tracked.set(root, t);
		t.ready = repo.state.HEAD !== undefined;
		this.update(t);
		this.schedule();
	}

	private close(repo: Repository): void {
		const root = repo.rootUri.fsPath;
		this.tracked.get(root)?.subscription.dispose();
		this.tracked.delete(root);
		this.schedule();
	}

	private update(t: Tracked): void {
		const s = t.repo.state;
		t.changes = aggregate({
			root: t.repo.rootUri.fsPath,
			merge: s.mergeChanges.map(raw),
			index: s.indexChanges.map(raw),
			workingTree: s.workingTreeChanges.map(raw),
			untracked: (s.untrackedChanges ?? []).map(raw),
		});
	}

	private schedule(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => { this.timer = undefined; this.emitter.fire(); }, 50);
	}

	dispose(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.tracked.forEach(t => t.subscription.dispose());
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}

function raw(c: Change): RawChange {
	const p = c.uri.fsPath;
	const original = c.originalUri.fsPath;
	return { path: p, originalPath: original !== p ? original : undefined, status: c.status };
}

export function isInside(file: string, dir: string): boolean {
	const rel = path.relative(dir, file);
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
