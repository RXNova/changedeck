import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileChange } from './types';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const SHELF_REF_PREFIX = 'refs/changelists/shelf/';

export class GitError extends Error {
	constructor(readonly args: string[], readonly exitCode: number, readonly stdout: string, readonly stderr: string) {
		super(cleanMessage(stderr || stdout) || `git ${args[0]} failed with exit code ${exitCode}`);
	}
}

function cleanMessage(text: string): string {
	return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('hint:')).join('\n');
}

export interface RunOptions {
	input?: string | Buffer;
	env?: Record<string, string>;
	/** Exit codes that count as success besides 0. */
	okCodes?: number[];
}

export interface RunResult {
	stdout: Buffer;
	stderr: string;
	exitCode: number;
}

export interface GitLogger {
	command(root: string, args: string[], exitCode: number, ms: number, stderr: string): void;
}

const LOCK_RETRIES = 5;

function isLockError(e: unknown): boolean {
	return e instanceof GitError && /index\.lock|\.lock': File exists|Another git process seems to be running/i.test(e.stderr);
}

/** Runs git commands for one repository. Pathspecs are always literal, never globs. */
export class Git {
	/** Receives every command run, for the extension's output log. */
	static logger: GitLogger | undefined;

	constructor(readonly gitPath: string, readonly root: string) { }

	/**
	 * Runs git. If another git process (such as VS Code's own Git extension) holds the index lock,
	 * the command is retried a few times with a short back-off.
	 */
	async run(args: string[], options: RunOptions = {}): Promise<RunResult> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.runOnce(args, options);
			} catch (e) {
				if (attempt >= LOCK_RETRIES || !isLockError(e)) { throw e; }
				await new Promise(r => setTimeout(r, 100 * 2 ** attempt));
			}
		}
	}

	private runOnce(args: string[], options: RunOptions): Promise<RunResult> {
		const started = Date.now();
		return new Promise((resolve, reject) => {
			const child = spawn(this.gitPath, args, {
				cwd: this.root,
				env: {
					...process.env,
					GIT_LITERAL_PATHSPECS: '1',
					GIT_EDITOR: 'true',
					GIT_TERMINAL_PROMPT: '0',
					LC_ALL: 'C',
					...options.env,
				},
			});
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			child.stdout.on('data', (d: Buffer) => out.push(d));
			child.stderr.on('data', (d: Buffer) => err.push(d));
			child.on('error', reject);
			child.on('close', code => {
				const exitCode = code ?? -1;
				const stdout = Buffer.concat(out);
				const stderr = Buffer.concat(err).toString('utf8');
				Git.logger?.command(this.root, args, exitCode, Date.now() - started, stderr);
				if (exitCode === 0 || options.okCodes?.includes(exitCode)) {
					resolve({ stdout, stderr, exitCode });
				} else {
					reject(new GitError(args, exitCode, stdout.toString('utf8'), stderr));
				}
			});
			child.stdin.on('error', () => { /* git may exit before reading stdin; the exit code reports it */ });
			child.stdin.end(options.input ?? '');
		});
	}

	async text(args: string[], options?: RunOptions): Promise<string> {
		return (await this.run(args, options)).stdout.toString('utf8');
	}

	async revParse(rev: string): Promise<string | undefined> {
		const r = await this.run(['rev-parse', '-q', '--verify', `${rev}^{commit}`], { okCodes: [1] });
		const sha = r.stdout.toString('utf8').trim();
		return r.exitCode === 0 && sha ? sha : undefined;
	}

	async hasHead(): Promise<boolean> {
		return (await this.revParse('HEAD')) !== undefined;
	}

	/** Path inside the git directory, such as MERGE_HEAD, resolved correctly for worktrees. */
	async gitPathOf(name: string): Promise<string> {
		const p = (await this.text(['rev-parse', '--git-path', name])).trim();
		return path.resolve(this.root, p);
	}

	async inProgressOperation(): Promise<string | undefined> {
		for (const [file, label] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
			try {
				await fs.access(await this.gitPathOf(file));
				return label;
			} catch { /* not in progress */ }
		}
		return undefined;
	}

	rel(abs: string): string {
		return path.relative(this.root, abs).split(path.sep).join('/');
	}

	/** Mode and blob id of a file in a commit, or undefined if it is not there. */
	async entry(rev: string, relPath: string): Promise<{ mode: string; sha: string } | undefined> {
		const out = await this.text(['ls-tree', '-z', rev, '--', relPath], { okCodes: [128] });
		const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(out);
		return m ? { mode: m[1], sha: m[2] } : undefined;
	}

	/** A file's contents at a revision in working-tree form (line endings and filters applied). */
	async readFiltered(rev: string, relPath: string): Promise<Buffer | undefined> {
		const r = await this.run(['cat-file', '--filters', `${rev}:${relPath}`], { okCodes: [128] });
		return r.exitCode === 0 ? r.stdout : undefined;
	}

	/** A blob's contents in working-tree form, filtered as if it were at `relPath`. */
	async readBlobFiltered(sha: string, relPath: string): Promise<Buffer | undefined> {
		const r = await this.run(['cat-file', '--filters', `--path=${relPath}`, sha], { okCodes: [128] });
		return r.exitCode === 0 ? r.stdout : undefined;
	}

	async lastCommitMessage(): Promise<string> {
		if (!(await this.hasHead())) { return ''; }
		return (await this.text(['log', '-1', '--format=%B'])).replace(/\s+$/, '');
	}
}

function commitArgs(messageFile: string, options: CommitOptions): string[] {
	const args = ['commit', '--quiet', '--cleanup=strip', '-F', messageFile];
	if (options.amend) { args.push('--amend'); }
	if (options.signoff) { args.push('--signoff'); }
	if (options.noVerify) { args.push('--no-verify'); }
	if (options.author?.trim()) { args.push(`--author=${options.author.trim()}`); }
	return args;
}

function nul(paths: string[]): string {
	return paths.join('\0');
}

function unique<T>(values: Iterable<T>): T[] {
	return [...new Set(values)];
}

/** Every repository path a change touches: the file itself and, for a rename, its old path. */
export function pathspecsOf(git: Git, changes: FileChange[]): string[] {
	const specs: string[] = [];
	for (const c of changes) {
		specs.push(git.rel(c.path));
		if (c.kind === 'renamed' && c.originalPath) { specs.push(git.rel(c.originalPath)); }
	}
	return unique(specs);
}

export interface Identity {
	name: string;
	email: string;
}

/** The name and email Git would commit with in this repository; empty strings if not configured. */
export async function gitIdentity(git: Git): Promise<Identity> {
	const read = async (key: string) => (await git.text(['config', '--get', key], { okCodes: [1] })).trim();
	return { name: await read('user.name'), email: await read('user.email') };
}

function committerEnv(options: CommitOptions): Record<string, string> {
	return options.committer ? { GIT_COMMITTER_NAME: options.committer.name, GIT_COMMITTER_EMAIL: options.committer.email } : {};
}

export interface CommitOptions {
	amend?: boolean;
	/** Adds a Signed-off-by trailer. */
	signoff?: boolean;
	/** Skips the pre-commit and commit-msg hooks. */
	noVerify?: boolean;
	/** Overrides the author, "Name <email>". */
	author?: string;
	/** Committer to use when Git has no identity configured (otherwise Git refuses to commit). */
	committer?: Identity;
	/** Set when the selection covers every change in the repository; allows committing during a merge. */
	coversAllChanges?: boolean;
}

/**
 * Commits exactly the given files (their current working-tree content), leaving
 * anything else that is staged untouched. Untracked files are added first.
 */
export async function commitFiles(git: Git, changes: FileChange[], message: string, options: CommitOptions = {}, partial: PartialContents = new Map()): Promise<void> {
	const conflicted = changes.filter(c => c.conflicted);
	if (conflicted.length) {
		throw new Error(`Resolve conflicts first: ${conflicted.map(c => git.rel(c.path)).join(', ')}`);
	}
	if (!message.trim()) { throw new Error('Enter a commit message.'); }
	if (!changes.length && !options.amend) { throw new Error('Select at least one file to commit.'); }

	const operation = await git.inProgressOperation();
	if (operation && !options.coversAllChanges) {
		throw new Error(`Git does not allow committing only some files during a ${operation}. Include every changed file in this repository, or finish the ${operation} first.`);
	}

	if (partial.size) {
		if (operation) { throw new Error(`Only whole files can be committed during a ${operation}. Move all changes of each file to one changelist first.`); }
		await commitThroughTempIndex(git, changes, message, options, partial);
		return;
	}

	const untracked = changes.filter(c => c.untracked).map(c => git.rel(c.path));
	const specs = pathspecsOf(git, changes);

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'changelists-'));
	const messageFile = path.join(dir, 'COMMIT_EDITMSG');
	try {
		await fs.writeFile(messageFile, message, 'utf8');
		const args = commitArgs(messageFile, options);

		if (operation) {
			if (specs.length) {
				await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(specs) });
			}
			await git.run(args, { env: committerEnv(options) });
			return;
		}
		if (untracked.length) {
			await git.run(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(untracked) });
		}
		if (specs.length) {
			args.push('--only', '--pathspec-from-file=-', '--pathspec-file-nul');
			await git.run(args, { input: nul(specs), env: committerEnv(options) });
		} else {
			args.push('--only');
			await git.run(args, { env: committerEnv(options) });
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * Commits HEAD plus the selection from a temporary index, so partial file contents can be
 * committed without touching the working tree. `git commit` still runs hooks and signing.
 * Afterwards the real index entries of the committed paths are reset to the new HEAD, which
 * is what `git commit --only` does too.
 */
async function commitThroughTempIndex(git: Git, changes: FileChange[], message: string, options: CommitOptions, partial: PartialContents): Promise<void> {
	const hasHead = await git.hasHead();
	await withTempIndex(async (env, dir) => {
		await stageInto(git, env, hasHead ? 'HEAD' : undefined, changes, partial);
		const messageFile = path.join(dir, 'COMMIT_EDITMSG');
		await fs.writeFile(messageFile, message, 'utf8');
		await git.run(commitArgs(messageFile, options), { env: { ...env, ...committerEnv(options) } });
	});
	const specs = pathspecsOf(git, changes);
	if (specs.length) {
		await git.run(['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(specs) });
	}
}

/** Blob id a file's content would get in the repository (after clean filters). */
export async function blobIdOf(git: Git, file: string, content: string): Promise<string> {
	return (await git.text(['hash-object', '--stdin', `--path=${git.rel(file)}`], { input: Buffer.from(content, 'latin1') })).trim();
}

export async function addFiles(git: Git, paths: string[]): Promise<void> {
	if (!paths.length) { return; }
	await git.run(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nul(paths.map(p => git.rel(p))) });
}

export interface RollbackResult {
	/** Untracked files the caller should delete (sent to the trash by the UI). */
	untrackedToDelete: string[];
}

/**
 * Restores files to HEAD (both index and working tree). Files that are new in the index are
 * unstaged but kept on disk, as JetBrains IDEs do. Untracked files are returned for the caller to delete.
 */
export async function rollback(git: Git, changes: FileChange[]): Promise<RollbackResult> {
	const hasHead = await git.hasHead();
	const added = changes.filter(c => !c.untracked && (c.kind === 'added' || c.kind === 'copied' || !hasHead));
	const restore = changes.filter(c => !c.untracked && !added.includes(c));

	if (added.length) {
		await git.run(['rm', '--cached', '--quiet', '--force', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
			input: nul(added.map(c => git.rel(c.path))),
		});
	}
	if (restore.length) {
		await git.run(['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
			input: nul(pathspecsOf(git, restore)),
		});
	}
	return { untrackedToDelete: changes.filter(c => c.untracked).map(c => c.path) };
}

/**
 * Content to use for partially selected files, keyed by absolute path. The strings are
 * working-tree bytes in latin1 (one char per byte), so any ASCII-compatible encoding round-trips.
 */
export type PartialContents = Map<string, string>;

async function withTempIndex<T>(fn: (env: Record<string, string>, dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'changelists-'));
	try {
		return await fn({ GIT_INDEX_FILE: path.join(dir, 'index') }, dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

/**
 * Fills a temporary index with `base` plus the given changes: whole files from the working tree,
 * partial files from `partial`. The caller's `env` must point GIT_INDEX_FILE at that index.
 */
async function stageInto(git: Git, env: Record<string, string>, base: string | undefined, changes: FileChange[], partial: PartialContents): Promise<void> {
	await git.run(base ? ['read-tree', base] : ['read-tree', '--empty'], { env });
	const whole = changes.filter(c => !partial.has(c.path));
	const specs = pathspecsOf(git, whole);
	if (specs.length) {
		await git.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: nul(specs) });
	}
	for (const [file, content] of partial) {
		const rel = git.rel(file);
		const sha = (await git.text(['hash-object', '-w', '--stdin', `--path=${rel}`], { input: Buffer.from(content, 'latin1') })).trim();
		const mode = (base && (await git.entry(base, rel))?.mode) || '100644';
		await git.run(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], { env });
	}
}

/** Unified diff of the given changes against HEAD, including untracked, binary and partial files. */
export async function createPatch(git: Git, changes: FileChange[], partial: PartialContents = new Map()): Promise<string> {
	const base = (await git.hasHead()) ? 'HEAD' : undefined;
	return withTempIndex(async env => {
		await stageInto(git, env, base, changes, partial);
		const tree = (await git.text(['write-tree'], { env })).trim();
		const specs = pathspecsOf(git, changes);
		return git.text(['diff', '--binary', '--find-renames', base ?? EMPTY_TREE, tree, '--', ...specs]);
	});
}

export async function applyPatch(git: Git, patch: string): Promise<{ threeWay: boolean }> {
	try {
		await git.run(['apply', '--whitespace=nowarn', '-'], { input: patch });
		return { threeWay: false };
	} catch (e) {
		await git.run(['apply', '--3way', '--whitespace=nowarn', '-'], { input: patch });
		return { threeWay: true };
	}
}

// ---------------------------------------------------------------------------------------------
// Backups: a snapshot of files taken before a destructive operation (rollback), so it can be
// undone. A backup is a commit whose tree is HEAD plus the files' current contents, kept under
// refs/changelists/backup/<id>. The working tree and index are not touched.

export const BACKUP_REF_PREFIX = 'refs/changelists/backup/';
const MAX_BACKUPS = 20;

export interface Backup {
	ref: string;
	sha: string;
	/** Repository-relative paths covered by the backup; those missing from its tree did not exist. */
	paths: string[];
}

export async function createBackup(git: Git, changes: FileChange[], id: string, label: string): Promise<Backup> {
	const hasHead = await git.hasHead();
	const paths = pathspecsOf(git, changes);
	const sha = await withTempIndex(async env => {
		await stageInto(git, env, hasHead ? 'HEAD' : undefined, changes, new Map());
		const tree = (await git.text(['write-tree'], { env })).trim();
		const parents = hasHead ? ['-p', 'HEAD'] : [];
		return (await git.text(['commit-tree', tree, ...parents, '-m', `${label}\n\n${paths.join('\n')}`])).trim();
	});
	const ref = BACKUP_REF_PREFIX + id;
	await git.run(['update-ref', '-m', 'changelists: backup', ref, sha]);
	await pruneBackups(git);
	return { ref, sha, paths };
}

async function pruneBackups(git: Git): Promise<void> {
	const out = await git.text(['for-each-ref', '--sort=-creatordate', '--format=%(refname)', BACKUP_REF_PREFIX]);
	for (const ref of out.split('\n').filter(Boolean).slice(MAX_BACKUPS)) {
		await git.run(['update-ref', '-d', ref]);
	}
}

/**
 * Writes the backed-up contents back to the working tree. Files that did not exist when the
 * backup was taken are removed. Returns the absolute paths that were restored.
 */
export async function restoreBackup(git: Git, backup: Backup): Promise<string[]> {
	const restored: string[] = [];
	for (const rel of backup.paths) {
		const abs = path.join(git.root, ...rel.split('/'));
		const content = await git.readFiltered(backup.sha, rel);
		if (content === undefined) {
			await fs.rm(abs, { force: true });
		} else {
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, content);
			const entry = await git.entry(backup.sha, rel);
			if (entry?.mode === '100755') { await fs.chmod(abs, 0o755).catch(() => undefined); }
		}
		restored.push(abs);
	}
	return restored;
}

export interface BackupInfo extends Backup {
	date: number;
	label: string;
}

/** Backups in this repository, newest first. */
export async function listBackups(git: Git): Promise<BackupInfo[]> {
	const out = await git.text(['for-each-ref', '--sort=-creatordate', '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(contents)%01', BACKUP_REF_PREFIX]);
	return out.split('\x01').map(e => e.replace(/^\n/, '')).filter(Boolean).map(entry => {
		const [ref, sha, date, contents] = entry.split('\0');
		const [label, ...rest] = (contents ?? '').split('\n');
		return { ref, sha, date: Number(date) * 1000, label, paths: rest.map(l => l.trim()).filter(Boolean) };
	});
}

export async function deleteBackup(git: Git, backup: Backup): Promise<void> {
	await git.run(['update-ref', '-d', backup.ref]);
}

// ---------------------------------------------------------------------------------------------
// Shelf: each shelved change set is a stash commit kept under refs/changelists/shelf/<id>,
// so it never shows up in (or disturbs) the user's own `git stash list`.

export interface ShelfRef {
	id: string;
	ref: string;
	sha: string;
	date: number;
	subject: string;
}

export interface ShelfFile {
	path: string;
	status: 'A' | 'M' | 'D' | 'T' | 'U';
	/** True if the file was untracked when shelved (stored in the stash's third parent). */
	untracked: boolean;
}

export function shelfNameFromSubject(subject: string): string {
	return subject.replace(/^(WIP )?on [^:]*: /i, '');
}

/** Shelves the changes and reverts them in the working tree. Returns the new shelf ref. */
export interface PartialShelve {
	/** Content holding only the changes to shelve. */
	shelved: string;
	/** Content to leave in the working tree afterwards (the other lists' changes). */
	remaining: string;
}

/**
 * Shelves the changes and reverts them in the working tree. Returns the new shelf ref.
 * For partial files, only `shelved` goes to the shelf and `remaining` stays on disk.
 */
export async function shelve(git: Git, changes: FileChange[], name: string, id: string, partial: Map<string, PartialShelve> = new Map()): Promise<ShelfRef> {
	if (!changes.length) { throw new Error('Nothing to shelve.'); }
	const conflicted = changes.filter(c => c.conflicted);
	if (conflicted.length) { throw new Error(`Resolve conflicts first: ${conflicted.map(c => git.rel(c.path)).join(', ')}`); }
	if (!(await git.hasHead())) { throw new Error('Changes cannot be shelved before the first commit.'); }

	// Stash works on whole files: narrow partial files to the shelved changes first, and keep the
	// original bytes so they can be restored if anything fails.
	const originals = new Map<string, Buffer>();
	let stashed = false;
	try {
		for (const [file, p] of partial) {
			originals.set(file, await fs.readFile(file));
			await fs.writeFile(file, Buffer.from(p.shelved, 'latin1'));
		}
		const before = await git.revParse('refs/stash');
		await git.run(['stash', 'push', '--include-untracked', '--quiet', '-m', name, '--pathspec-from-file=-', '--pathspec-file-nul'], {
			input: nul(pathspecsOf(git, changes)),
		});
		const sha = await git.revParse('refs/stash');
		if (!sha || sha === before) { throw new Error('Git found no local changes to shelve in those files.'); }
		stashed = true;
		for (const [file, p] of partial) { await fs.writeFile(file, Buffer.from(p.remaining, 'latin1')); }
		return await keepShelf(git, sha, id);
	} catch (e) {
		if (!stashed) {
			for (const [file, bytes] of originals) { await fs.writeFile(file, bytes).catch(() => undefined); }
		}
		throw e;
	}
}

async function keepShelf(git: Git, sha: string, id: string): Promise<ShelfRef> {
	const ref = SHELF_REF_PREFIX + id;
	await git.run(['update-ref', '-m', 'changelists: shelve', ref, sha]);
	// Take it back off the user's stash list; the shelf ref keeps the commit alive.
	if ((await git.revParse('stash@{0}')) === sha) {
		await git.run(['stash', 'drop', '--quiet', 'stash@{0}']);
	}
	const subject = (await git.text(['log', '-1', '--format=%s', sha])).trim();
	return { id, ref, sha, date: Date.now(), subject };
}

export async function listShelves(git: Git): Promise<ShelfRef[]> {
	const out = await git.text(['for-each-ref', '--sort=-creatordate', '--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(subject)', SHELF_REF_PREFIX]);
	return out.split('\n').filter(Boolean).map(line => {
		const [ref, sha, date, subject] = line.split('\0');
		return { id: ref.slice(SHELF_REF_PREFIX.length), ref, sha, date: Number(date) * 1000, subject };
	});
}

export async function shelfFiles(git: Git, sha: string): Promise<ShelfFile[]> {
	const files: ShelfFile[] = [];
	const out = await git.text(['diff', '-z', '--name-status', '--no-renames', `${sha}^1`, sha]);
	const parts = out.split('\0');
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const status = parts[i].charAt(0) as ShelfFile['status'];
		files.push({ path: parts[i + 1], status, untracked: false });
	}
	if (await git.revParse(`${sha}^3`)) {
		const untracked = await git.text(['ls-tree', '-r', '-z', '--name-only', `${sha}^3`]);
		for (const p of untracked.split('\0').filter(Boolean)) {
			files.push({ path: p, status: 'A', untracked: true });
		}
	}
	return files;
}

export interface UnshelveResult {
	conflicts: boolean;
	output: string;
}

/**
 * Applies a shelf to the working tree. Conflicts leave markers in files and do not throw.
 * When files touched by the shelf have local changes (which `git stash apply` refuses), each file
 * is merged on its own with `git merge-file`, so shelved changes can go back into edited files.
 */
export async function unshelve(git: Git, sha: string): Promise<UnshelveResult> {
	try {
		const r = await git.run(['stash', 'apply', sha]);
		return { conflicts: false, output: r.stdout.toString('utf8') };
	} catch (e) {
		if (e instanceof GitError && e.exitCode === 1 && /CONFLICT/.test(e.stdout + e.stderr)) {
			return { conflicts: true, output: e.stdout };
		}
		if (e instanceof GitError && /would be overwritten|already exists/.test(e.stdout + e.stderr)) {
			const files = await shelfFiles(git, sha);
			let conflicts = false;
			for (const f of files) {
				if ((await unshelveFile(git, sha, f)).conflict) { conflicts = true; }
			}
			return { conflicts, output: '' };
		}
		throw e;
	}
}

/**
 * Restores one shelved file into the working tree by a 3-way merge with its current content.
 * A conflict leaves markers in text files; binary or deleted files with local edits are left alone.
 */
export async function unshelveFile(git: Git, sha: string, file: ShelfFile): Promise<{ conflict: boolean }> {
	const abs = path.join(git.root, ...file.path.split('/'));
	const local = await fs.readFile(abs).catch(() => undefined);
	const base = file.untracked ? undefined : await git.readFiltered(`${sha}^1`, file.path);
	const theirs = file.status === 'D' ? undefined : await git.readFiltered(file.untracked ? `${sha}^3` : sha, file.path);

	if (theirs === undefined) {
		// Shelved as deleted.
		if (local === undefined) { return { conflict: false }; }
		if (base && local.equals(base)) { await fs.rm(abs); return { conflict: false }; }
		return { conflict: true };
	}
	if (local === undefined || (base && local.equals(base)) || local.equals(theirs)) {
		await fs.mkdir(path.dirname(abs), { recursive: true });
		await fs.writeFile(abs, theirs);
		if (!file.untracked && file.status === 'A') { await addFiles(git, [abs]); }
		return { conflict: false };
	}
	if (local.includes(0) || theirs.includes(0) || (base && base.includes(0))) { return { conflict: true }; }

	return withTempIndex(async (_env, dir) => {
		const ours = path.join(dir, 'ours');
		const baseFile = path.join(dir, 'base');
		const theirsFile = path.join(dir, 'theirs');
		await fs.writeFile(ours, local);
		await fs.writeFile(baseFile, base ?? Buffer.alloc(0));
		await fs.writeFile(theirsFile, theirs);
		const r = await git.run(['merge-file', '-p', '-L', 'Current', '-L', 'Base', '-L', 'Shelved', ours, baseFile, theirsFile], {
			okCodes: Array.from({ length: 127 }, (_, i) => i + 1),
		});
		await fs.writeFile(abs, r.stdout);
		return { conflict: r.exitCode > 0 };
	});
}

/**
 * Rewrites a shelf without the given files (after they were unshelved one by one).
 * Returns `sha: undefined` if nothing is left, in which case the shelf ref was deleted.
 */
export async function removeFromShelf(git: Git, shelf: ShelfRef, relPaths: string[]): Promise<{ sha: string | undefined }> {
	const sha = shelf.sha;
	const base = `${sha}^1`;
	const index = `${sha}^2`;
	const untrackedCommit = await git.revParse(`${sha}^3`);
	const subject = (await git.text(['log', '-1', '--format=%B', sha])).trim();

	return withTempIndex(async env => {
		await git.run(['read-tree', sha], { env });
		for (const rel of relPaths) {
			const original = await git.entry(base, rel);
			if (original) {
				await git.run(['update-index', '--cacheinfo', `${original.mode},${original.sha},${rel}`], { env });
			} else {
				await git.run(['update-index', '--force-remove', '--', rel], { env });
			}
		}
		const tree = (await git.text(['write-tree'], { env })).trim();

		let untracked: string | undefined;
		if (untrackedCommit) {
			await git.run(['read-tree', untrackedCommit], { env });
			for (const rel of relPaths) { await git.run(['update-index', '--force-remove', '--', rel], { env }); }
			const utree = (await git.text(['write-tree'], { env })).trim();
			if (utree !== EMPTY_TREE) {
				untracked = (await git.text(['commit-tree', utree, '-m', `untracked files on ${subject}`])).trim();
			}
		}

		const baseTree = (await git.text(['rev-parse', `${base}^{tree}`])).trim();
		if (tree === baseTree && !untracked) {
			await deleteShelf(git, shelf.ref);
			return { sha: undefined };
		}
		const parents = ['-p', base, '-p', index, ...(untracked ? ['-p', untracked] : [])];
		const next = (await git.text(['commit-tree', tree, ...parents, '-m', subject])).trim();
		await git.run(['update-ref', '-m', 'changelists: unshelve files', shelf.ref, next, sha]);
		return { sha: next };
	});
}

/** A shelf as one patch file (tracked changes followed by the files that were untracked). */
export async function exportShelf(git: Git, sha: string): Promise<string> {
	let patch = await git.text(['diff', '--binary', `${sha}^1`, sha]);
	if (await git.revParse(`${sha}^3`)) {
		patch += await git.text(['diff', '--binary', EMPTY_TREE, `${sha}^3`]);
	}
	return patch;
}

/**
 * Creates a shelf from a patch without touching the working tree: the patch is applied to HEAD
 * in a temporary index and stored as a stash-shaped commit.
 */
export async function importShelf(git: Git, patch: string, name: string, id: string): Promise<ShelfRef> {
	if (!(await git.hasHead())) { throw new Error('A patch cannot be shelved before the first commit.'); }
	const sha = await withTempIndex(async env => {
		await git.run(['read-tree', 'HEAD'], { env });
		try {
			await git.run(['apply', '--cached', '--whitespace=nowarn', '-'], { env, input: patch });
		} catch (e) {
			throw new Error(`The patch does not apply to the current commit: ${e instanceof Error ? e.message : e}`);
		}
		const tree = (await git.text(['write-tree'], { env })).trim();
		const headTree = (await git.text(['rev-parse', 'HEAD^{tree}'])).trim();
		if (tree === headTree) { throw new Error('The patch contains no changes.'); }
		const branch = (await git.text(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		const index = (await git.text(['commit-tree', tree, '-p', 'HEAD', '-m', `index on ${branch}: ${name}`])).trim();
		return (await git.text(['commit-tree', tree, '-p', 'HEAD', '-p', index, '-m', `On ${branch}: ${name}`])).trim();
	});
	const ref = SHELF_REF_PREFIX + id;
	await git.run(['update-ref', '-m', 'changelists: import shelf', ref, sha]);
	const subject = (await git.text(['log', '-1', '--format=%s', sha])).trim();
	return { id, ref, sha, date: Date.now(), subject };
}

export async function localBranches(git: Git): Promise<string[]> {
	return (await git.text(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
}

export async function deleteShelf(git: Git, ref: string): Promise<void> {
	await git.run(['update-ref', '-d', ref]);
}

/** Contents of a file at a revision, or undefined if it does not exist there. */
export async function showFile(git: Git, rev: string, relPath: string): Promise<Buffer | undefined> {
	const r = await git.run(['show', `${rev}:${relPath}`], { okCodes: [128] });
	return r.exitCode === 0 ? r.stdout : undefined;
}
