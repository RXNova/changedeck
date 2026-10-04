import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { after, before, describe, it } from 'node:test';
import {
	applyPatch, commitFiles, createPatch, deleteShelf, Git, listShelves, rollback, shelfFiles,
	shelfNameFromSubject, shelve, showFile, unshelve,
} from '../core/git';
import { aggregate } from '../core/aggregate';
import { FileChange, RawChange, RawRepoState, Status } from '../core/types';

const roots: string[] = [];

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
}

function repo(): { root: string; git: Git; write: (p: string, s: string) => void; read: (p: string) => string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'cl-test-')));
	roots.push(root);
	sh(root, 'init', '-q', '-b', 'main');
	sh(root, 'config', 'user.email', 't@example.com');
	sh(root, 'config', 'user.name', 'Test');
	sh(root, 'config', 'commit.gpgsign', 'false');
	// Keep line endings as written, whatever the machine's Git default is (Windows converts to CRLF).
	sh(root, 'config', 'core.autocrlf', 'false');
	const write = (p: string, s: string) => {
		const full = join(root, p);
		mkdirSync(join(full, '..'), { recursive: true });
		writeFileSync(full, s);
	};
	const read = (p: string) => readFileSync(join(root, p), 'utf8');
	return { root, git: new Git('git', root), write, read };
}

/** Builds FileChanges from `git status`, the way the Git extension would report them. */
function status(root: string): Map<string, FileChange> {
	const out = sh(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
	const state: RawRepoState = { root, merge: [], index: [], workingTree: [], untracked: [] };
	const parts = out.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) { continue; }
		const x = entry[0], y = entry[1];
		const p = join(root, entry.slice(3));
		let orig: string | undefined;
		if (x === 'R' || x === 'C') { orig = join(root, parts[++i]); }
		if (x === '?') { state.untracked.push({ path: p, status: Status.UNTRACKED }); continue; }
		if ((x === 'U' || y === 'U') || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
			state.merge.push({ path: p, status: Status.BOTH_MODIFIED }); continue;
		}
		const idx: Record<string, number> = { M: Status.INDEX_MODIFIED, A: Status.INDEX_ADDED, D: Status.INDEX_DELETED, R: Status.INDEX_RENAMED, C: Status.INDEX_COPIED, T: Status.TYPE_CHANGED };
		const wt: Record<string, number> = { M: Status.MODIFIED, D: Status.DELETED, T: Status.TYPE_CHANGED, A: Status.INTENT_TO_ADD };
		if (x in idx) { state.index.push({ path: p, originalPath: orig, status: idx[x] } as RawChange); }
		if (y in wt) { state.workingTree.push({ path: p, status: wt[y] }); }
	}
	return aggregate(state);
}

function pick(root: string, ...rel: string[]): FileChange[] {
	const all = status(root);
	return rel.map(r => {
		const c = all.get(join(root, r));
		assert.ok(c, `expected ${r} to be changed`);
		return c;
	});
}

after(() => { for (const r of roots) { rmSync(r, { recursive: true, force: true }); } });

describe('commitFiles', () => {
	it('commits only the selected files and keeps other staged changes staged', async () => {
		const { root, git, write } = repo();
		write('a.txt', 'a1'); write('b.txt', 'b1'); write('c.txt', 'c1');
		sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');

		write('a.txt', 'a2'); write('b.txt', 'b2'); write('c.txt', 'c2'); write('new file.txt', 'n');
		sh(root, 'add', 'b.txt');

		await commitFiles(git, pick(root, 'a.txt', 'new file.txt'), 'feat: a\n\nbody line');

		assert.equal(sh(root, 'log', '-1', '--format=%B').trim(), 'feat: a\n\nbody line');
		assert.deepEqual(sh(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'new file.txt']);
		assert.equal(sh(root, 'diff', '--cached', '--name-only').trim(), 'b.txt');
		assert.equal(sh(root, 'diff', '--name-only').trim(), 'c.txt');
	});

	it('commits deletions and renames', async () => {
		const { root, git, write } = repo();
		write('old.txt', 'x'); write('gone.txt', 'g');
		sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		sh(root, 'mv', 'old.txt', 'renamed.txt');
		rmSync(join(root, 'gone.txt'));

		await commitFiles(git, pick(root, 'renamed.txt', 'gone.txt'), 'move');
		assert.equal(sh(root, 'status', '--porcelain').trim(), '');
		assert.deepEqual(sh(root, 'ls-files').trim().split('\n'), ['renamed.txt']);
	});

	it('amends the last commit, including message-only amends', async () => {
		const { root, git, write } = repo();
		write('a.txt', '1'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'first');
		write('a.txt', '2');
		await commitFiles(git, pick(root, 'a.txt'), 'first (amended)', { amend: true });
		assert.equal(sh(root, 'rev-list', '--count', 'HEAD').trim(), '1');
		await commitFiles(git, [], 'renamed message', { amend: true });
		assert.equal(sh(root, 'log', '-1', '--format=%s').trim(), 'renamed message');
		assert.equal(await git.lastCommitMessage(), 'renamed message');
	});

	it('handles the first commit in an empty repository', async () => {
		const { root, git, write } = repo();
		write('a.txt', '1'); write('b.txt', '2');
		await commitFiles(git, pick(root, 'a.txt'), 'root');
		assert.equal(sh(root, 'ls-files').trim(), 'a.txt');
	});

	it('treats special characters in file names literally', { skip: process.platform === 'win32' && '"*" is not a valid file name on Windows' }, async () => {
		const { root, git, write } = repo();
		write('x.txt', '0'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('*.txt', 'star'); write('x.txt', '1');
		await commitFiles(git, pick(root, '*.txt'), 'star');
		assert.equal(sh(root, 'show', '--name-only', '--format=', 'HEAD').trim(), '*.txt');
		assert.equal(sh(root, 'diff', '--name-only').trim(), 'x.txt');
	});

	it('refuses a partial commit during a merge but allows committing everything', async () => {
		const { root, git, write } = repo();
		write('a.txt', 'base\n'); write('b.txt', 'b\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		sh(root, 'checkout', '-qb', 'side'); write('a.txt', 'side\n'); sh(root, 'commit', '-qam', 'side');
		sh(root, 'checkout', '-q', 'main'); write('a.txt', 'main\n'); sh(root, 'commit', '-qam', 'main');
		try { sh(root, 'merge', '-q', 'side'); } catch { /* conflict expected */ }
		await assert.rejects(commitFiles(git, pick(root, 'a.txt'), 'merge'), /Resolve conflicts/);
		write('a.txt', 'resolved\n'); sh(root, 'add', 'a.txt');
		write('b.txt', 'b2\n');
		await assert.rejects(commitFiles(git, pick(root, 'a.txt'), 'merge'), /during a merge/);
		await commitFiles(git, pick(root, 'a.txt', 'b.txt'), 'merge', { coversAllChanges: true });
		assert.equal(sh(root, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ').length, 3);
	});
});

describe('rollback', () => {
	it('restores modified, deleted and renamed files, unstages added files, and reports untracked ones', async () => {
		const { root, git, write, read } = repo();
		write('m.txt', 'm'); write('d.txt', 'd'); write('r.txt', 'r'); write('keep.txt', 'k');
		sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('m.txt', 'changed'); sh(root, 'add', 'm.txt'); write('m.txt', 'changed twice');
		rmSync(join(root, 'd.txt'));
		sh(root, 'mv', 'r.txt', 'r2.txt');
		write('added.txt', 'a'); sh(root, 'add', 'added.txt');
		write('u.txt', 'u');
		write('keep.txt', 'local');

		const result = await rollback(git, pick(root, 'm.txt', 'd.txt', 'r2.txt', 'added.txt', 'u.txt'));
		assert.equal(read('m.txt'), 'm');
		assert.equal(read('d.txt'), 'd');
		assert.equal(read('r.txt'), 'r');
		assert.ok(!existsSync(join(root, 'r2.txt')));
		assert.equal(read('added.txt'), 'a', 'added file stays on disk');
		assert.deepEqual(result.untrackedToDelete, [join(root, 'u.txt')]);
		assert.equal(sh(root, 'status', '--porcelain').split('\n').filter(Boolean).sort().join('|'), ' M keep.txt|?? added.txt|?? u.txt');
	});
});

describe('shelf', () => {
	it('shelves selected files (tracked, staged and untracked), keeps the stash list clean, and unshelves them', async () => {
		const { root, git, write, read } = repo();
		write('a.txt', 'a'); write('b.txt', 'b'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'a-shelved'); write('b.txt', 'b-stays');
		write('dir/new.txt', 'brand new'); write('staged.txt', 's'); sh(root, 'add', 'staged.txt');
		sh(root, 'stash', 'push', '-q', '--', 'b.txt'); write('b.txt', 'b-stays');
		const userStash = sh(root, 'stash', 'list');

		const ref = await shelve(git, pick(root, 'a.txt', 'dir/new.txt', 'staged.txt'), 'My work', 'id1');
		assert.equal(read('a.txt'), 'a');
		assert.ok(!existsSync(join(root, 'dir/new.txt')));
		assert.ok(!existsSync(join(root, 'staged.txt')));
		assert.equal(read('b.txt'), 'b-stays', 'unselected file untouched');
		assert.equal(sh(root, 'stash', 'list'), userStash, 'user stash list unchanged');

		const shelves = await listShelves(git);
		assert.equal(shelves.length, 1);
		assert.equal(shelves[0].sha, ref.sha);
		assert.equal(shelfNameFromSubject(shelves[0].subject), 'My work');

		const files = await shelfFiles(git, ref.sha);
		assert.deepEqual(files.map(f => `${f.status}${f.untracked ? '?' : ''} ${f.path}`).sort(), ['A dir/new.txt'.replace('A ', 'A? '), 'A staged.txt', 'M a.txt'].sort());
		assert.equal((await showFile(git, ref.sha, 'a.txt'))?.toString(), 'a-shelved');
		assert.equal((await showFile(git, `${ref.sha}^3`, 'dir/new.txt'))?.toString(), 'brand new');
		assert.equal(await showFile(git, `${ref.sha}^1`, 'staged.txt'), undefined);

		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, false);
		assert.equal(read('a.txt'), 'a-shelved');
		assert.equal(read('dir/new.txt'), 'brand new');
		assert.equal(read('staged.txt'), 's');
		await deleteShelf(git, ref.ref);
		assert.equal((await listShelves(git)).length, 0);
	});

	it('reports conflicts when unshelving onto changed content', async () => {
		const { root, git, write, read } = repo();
		write('a.txt', 'line\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'shelved\n');
		const ref = await shelve(git, pick(root, 'a.txt'), 'x', 'id2');
		write('a.txt', 'other\n'); sh(root, 'commit', '-qam', 'other');
		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, true);
		assert.match(read('a.txt'), /<<<<<<<.*\n/);
	});

	it('merges into locally edited files instead of refusing', async () => {
		const { root, git, write, read } = repo();
		write('a.txt', 'line\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'shelved\n');
		const ref = await shelve(git, pick(root, 'a.txt'), 'x', 'id3');
		write('a.txt', 'local edit\n');
		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, true);
		assert.match(read('a.txt'), /<<<<<<< Current\nlocal edit\n=======\nshelved\n>>>>>>> Shelved/);
	});
});

describe('patches', () => {
	it('round-trips modified, added, deleted, untracked and binary files', async () => {
		const { root, git, write } = repo();
		write('m.txt', 'm\n'); write('d.txt', 'd\n');
		writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
		sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('m.txt', 'm2\n'); rmSync(join(root, 'd.txt')); write('u.txt', 'u\n');
		writeFileSync(join(root, 'bin.dat'), Buffer.from([9, 8, 7, 0]));

		const patch = await createPatch(git, pick(root, 'm.txt', 'd.txt', 'u.txt', 'bin.dat'));
		assert.match(patch, /diff --git a\/u\.txt b\/u\.txt/);
		assert.match(patch, /GIT binary patch/);
		const expected = sh(root, 'stash', 'create');
		sh(root, 'add', 'u.txt'); sh(root, 'reset', '-q', '--hard');

		await applyPatch(git, patch);
		assert.equal(readFileSync(join(root, 'm.txt'), 'utf8'), 'm2\n');
		assert.ok(!existsSync(join(root, 'd.txt')));
		assert.equal(readFileSync(join(root, 'u.txt'), 'utf8'), 'u\n');
		assert.deepEqual([...readFileSync(join(root, 'bin.dat'))], [9, 8, 7, 0]);
		assert.ok(expected);
	});
});

before(() => { execFileSync('git', ['--version']); });

// ---- Partial changelists --------------------------------------------------------------------

import { applyHunks, diffLines, matchEol, splitLines } from '../core/partial';
import { removeFromShelf, unshelveFile } from '../core/git';

/** Content of `file` with only the hunks whose index passes `keep`, as the extension computes it. */
async function partialContent(git: Git, root: string, rel: string, keep: (i: number) => boolean): Promise<{ content: string; remaining: string; hunks: number }> {
	const text = readFileSync(join(root, rel)).toString('latin1');
	const base = splitLines(matchEol((await git.readFiltered('HEAD', rel))!.toString('latin1'), text));
	const current = splitLines(text);
	const hunks = diffLines(base, current);
	return {
		content: applyHunks(base, current, hunks, keep),
		remaining: applyHunks(base, current, hunks, i => !keep(i)),
		hunks: hunks.length,
	};
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

describe('partial changelists', () => {
	it('commits only some hunks of a file and leaves the rest in the working tree', async () => {
		const { root, git, write, read } = repo();
		write('f.txt', TEN.join('\n') + '\n'); write('g.txt', 'g\n');
		sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		const edited = [...TEN]; edited[1] = 'TWO'; edited[8] = 'NINE';
		write('f.txt', edited.join('\n') + '\n'); write('g.txt', 'g2\n');
		sh(root, 'add', 'g.txt'); // unrelated staged change must survive

		const p = await partialContent(git, root, 'f.txt', i => i === 0);
		assert.equal(p.hunks, 2);
		await commitFiles(git, pick(root, 'f.txt'), 'first hunk', {}, new Map([[join(root, 'f.txt'), p.content]]));

		assert.equal(sh(root, 'show', 'HEAD:f.txt'), p.content);
		assert.match(sh(root, 'show', 'HEAD:f.txt'), /TWO/);
		assert.doesNotMatch(sh(root, 'show', 'HEAD:f.txt'), /NINE/);
		assert.equal(read('f.txt'), edited.join('\n') + '\n', 'working tree untouched');
		assert.equal(sh(root, 'diff', '--cached', '--name-only').trim(), 'g.txt', 'other staged file still staged, f.txt not staged');
		assert.match(sh(root, 'diff', '--', 'f.txt'), /\+NINE/);
		assert.doesNotMatch(sh(root, 'diff', '--', 'f.txt'), /TWO/);
	});

	it('works with CRLF files under core.autocrlf and keeps the executable bit', async () => {
		const { root, git, write } = repo();
		sh(root, 'config', 'core.autocrlf', 'true');
		write('w.txt', TEN.join('\r\n') + '\r\n');
		sh(root, 'add', '.'); sh(root, 'update-index', '--chmod=+x', 'w.txt'); sh(root, 'commit', '-qm', 'init');
		sh(root, 'checkout', '--', 'w.txt');
		const edited = [...TEN]; edited[0] = 'ONE'; edited[9] = 'TEN';
		write('w.txt', edited.join('\r\n') + '\r\n');

		const p = await partialContent(git, root, 'w.txt', i => i === 1);
		assert.equal(p.hunks, 2, 'line endings do not turn every line into a change');
		await commitFiles(git, pick(root, 'w.txt'), 'last line', {}, new Map([[join(root, 'w.txt'), p.content]]));
		const committed = sh(root, 'show', 'HEAD:w.txt');
		assert.ok(!committed.includes('\r'), 'stored with LF in the repository');
		assert.match(committed, /^line 1\n/);
		assert.match(committed, /\nTEN\n$/);
		assert.match(sh(root, 'ls-tree', 'HEAD', 'w.txt'), /^100755/);
	});

	it('creates a patch with only some hunks', async () => {
		const { root, git, write } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		const edited = [...TEN]; edited[1] = 'TWO'; edited[8] = 'NINE';
		write('f.txt', edited.join('\n') + '\n');
		const p = await partialContent(git, root, 'f.txt', i => i === 1);
		const patch = await createPatch(git, pick(root, 'f.txt'), new Map([[join(root, 'f.txt'), p.content]]));
		assert.match(patch, /\+NINE/);
		assert.doesNotMatch(patch, /TWO/);
	});

	it('shelves some hunks, keeps the others, and unshelves into the edited file by merging', async () => {
		const { root, git, write, read } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		const edited = [...TEN]; edited[1] = 'TWO'; edited[8] = 'NINE';
		write('f.txt', edited.join('\n') + '\n');

		const p = await partialContent(git, root, 'f.txt', i => i === 1);
		const ref = await shelve(git, pick(root, 'f.txt'), 'nine', 'p1', new Map([[join(root, 'f.txt'), { shelved: p.content, remaining: p.remaining }]]));
		assert.match(read('f.txt'), /TWO/);
		assert.doesNotMatch(read('f.txt'), /NINE/);
		assert.match((await showFile(git, ref.sha, 'f.txt'))!.toString(), /NINE/);
		assert.doesNotMatch((await showFile(git, ref.sha, 'f.txt'))!.toString(), /TWO/);

		// Keep editing another part of the file, then unshelve: stash apply would refuse, merge succeeds.
		write('f.txt', read('f.txt').replace('line 5', 'FIVE'));
		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, false);
		const merged = read('f.txt');
		assert.match(merged, /TWO/);
		assert.match(merged, /FIVE/);
		assert.match(merged, /NINE/);
	});

	it('restores the working tree if shelving fails', async () => {
		const { root, git, write, read } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		const edited = [...TEN]; edited[1] = 'TWO';
		write('f.txt', edited.join('\n') + '\n');
		const before = read('f.txt');
		// Shelving content equal to HEAD means git finds nothing to stash and fails.
		await assert.rejects(shelve(git, pick(root, 'f.txt'), 'x', 'p2', new Map([[join(root, 'f.txt'), { shelved: TEN.join('\n') + '\n', remaining: '' }]])));
		assert.equal(read('f.txt'), before);
	});

	it('unshelves single files and removes them from the shelf', async () => {
		const { root, git, write, read } = repo();
		write('a.txt', 'a\n'); write('b.txt', 'b\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'a2\n'); write('b.txt', 'b2\n'); write('u.txt', 'u\n');
		const ref = await shelve(git, pick(root, 'a.txt', 'b.txt', 'u.txt'), 'two files', 'p3');
		const files = await shelfFiles(git, ref.sha);

		const a = files.find(f => f.path === 'a.txt')!;
		assert.equal((await unshelveFile(git, ref.sha, a)).conflict, false);
		assert.equal(read('a.txt'), 'a2\n');
		const after = await removeFromShelf(git, ref, ['a.txt']);
		assert.ok(after.sha);
		const left = await shelfFiles(git, after.sha!);
		assert.deepEqual(left.map(f => f.path).sort(), ['b.txt', 'u.txt']);
		assert.equal(sh(root, 'stash', 'list'), '');

		const shelves = await listShelves(git);
		const rest = await removeFromShelf(git, shelves[0], ['b.txt', 'u.txt']);
		assert.equal(rest.sha, undefined, 'empty shelf is deleted');
		assert.equal((await listShelves(git)).length, 0);
	});

	it('reports a conflict when a shelved hunk overlaps a local edit', async () => {
		const { root, git, write, read } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('f.txt', TEN.join('\n').replace('line 3', 'SHELVED') + '\n');
		const ref = await shelve(git, pick(root, 'f.txt'), 'x', 'p4');
		write('f.txt', TEN.join('\n').replace('line 3', 'LOCAL') + '\n');
		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, true);
		assert.match(read('f.txt'), /<<<<<<< Current\nLOCAL\n=======\nSHELVED\n>>>>>>> Shelved/);
	});
});

// ---- Backups, commit options, lock handling --------------------------------------------------

import { createBackup, deleteBackup, restoreBackup } from '../core/git';

describe('backups', () => {
	it('undoes a rollback of modified, deleted, added and untracked files', async () => {
		const { root, git, write, read } = repo();
		write('m.txt', 'm\n'); write('d.txt', 'd\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('m.txt', 'm changed\n'); rmSync(join(root, 'd.txt')); write('added.txt', 'a\n'); sh(root, 'add', 'added.txt'); write('u.txt', 'u\n');
		const changes = pick(root, 'm.txt', 'd.txt', 'added.txt', 'u.txt');

		const backup = await createBackup(git, changes, 'b1', 'Rollback');
		assert.equal(sh(root, 'status', '--porcelain').split('\n').filter(Boolean).length, 4, 'backup does not touch the working tree');
		const result = await rollback(git, changes);
		for (const f of result.untrackedToDelete) { rmSync(f); }
		rmSync(join(root, 'added.txt'));
		assert.equal(read('m.txt'), 'm\n');
		assert.ok(existsSync(join(root, 'd.txt')));

		await restoreBackup(git, backup);
		assert.equal(read('m.txt'), 'm changed\n');
		assert.ok(!existsSync(join(root, 'd.txt')));
		assert.equal(read('added.txt'), 'a\n');
		assert.equal(read('u.txt'), 'u\n');
		await deleteBackup(git, backup);
		assert.equal(sh(root, 'for-each-ref', 'refs/changelists/backup/').trim(), '');
	});

	it('keeps only the most recent backups', async () => {
		const { root, git, write } = repo();
		write('m.txt', 'm\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('m.txt', 'x\n');
		for (let i = 0; i < 23; i++) { await createBackup(git, pick(root, 'm.txt'), `k${i}`, 'Rollback'); }
		assert.equal(sh(root, 'for-each-ref', 'refs/changelists/backup/').trim().split('\n').length, 20);
	});
});

describe('commit options', () => {
	it('signs off, overrides the author and skips hooks, also for partial commits', { skip: process.platform === 'win32' && 'hook scripts need a POSIX shell' }, async () => {
		const { root, git, write } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		const hook = join(root, '.git', 'hooks', 'pre-commit');
		writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
		write('f.txt', TEN.join('\n').replace('line 2', 'TWO').replace('line 9', 'NINE') + '\n');

		await assert.rejects(commitFiles(git, pick(root, 'f.txt'), 'blocked'), /hook says no/);
		const p = await partialContent(git, root, 'f.txt', i => i === 0);
		await assert.rejects(commitFiles(git, pick(root, 'f.txt'), 'blocked', {}, new Map([[join(root, 'f.txt'), p.content]])), /hook says no/);

		await commitFiles(git, pick(root, 'f.txt'), 'partial', { noVerify: true, signoff: true, author: 'Someone Else <else@example.com>' }, new Map([[join(root, 'f.txt'), p.content]]));
		assert.equal(sh(root, 'log', '-1', '--format=%an <%ae>').trim(), 'Someone Else <else@example.com>');
		assert.match(sh(root, 'log', '-1', '--format=%B'), /Signed-off-by: Test <t@example.com>/);
		await commitFiles(git, pick(root, 'f.txt'), 'whole', { noVerify: true });
		assert.equal(sh(root, 'status', '--porcelain').trim(), '');
	});
});

describe('index lock', () => {
	it('retries while another git process holds the index lock', async () => {
		const { root, git, write } = repo();
		write('a.txt', 'a\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'b\n');
		const lock = join(root, '.git', 'index.lock');
		writeFileSync(lock, '');
		setTimeout(() => rmSync(lock, { force: true }), 300);
		await commitFiles(git, pick(root, 'a.txt'), 'after lock');
		assert.equal(sh(root, 'log', '-1', '--format=%s').trim(), 'after lock');
	});

	it('logs every command', async () => {
		const { root, git } = repo();
		const seen: string[] = [];
		Git.logger = { command: (_r, args) => seen.push(args[0]) };
		try { await git.hasHead(); } finally { Git.logger = undefined; }
		assert.deepEqual(seen, ['rev-parse']);
		assert.ok(root);
	});
});

import { exportShelf, importShelf, listBackups, localBranches } from '../core/git';

describe('shelf export and import, backup listing', () => {
	it('round-trips a shelf through a patch file', async () => {
		const { root, git, write, read } = repo();
		write('a.txt', 'a\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'a2\n'); write('new.txt', 'n\n');
		const ref = await shelve(git, pick(root, 'a.txt', 'new.txt'), 'export me', 'e1');
		const patch = await exportShelf(git, ref.sha);
		assert.match(patch, /a\/a\.txt/);
		assert.match(patch, /new\.txt/);
		await deleteShelf(git, ref.ref);

		const imported = await importShelf(git, patch, 'imported', 'e2');
		assert.equal(sh(root, 'status', '--porcelain').trim(), '', 'import does not touch the working tree');
		assert.equal(shelfNameFromSubject(imported.subject), 'imported');
		assert.deepEqual((await shelfFiles(git, imported.sha)).map(f => f.path).sort(), ['a.txt', 'new.txt']);
		assert.equal((await unshelve(git, imported.sha)).conflicts, false);
		assert.equal(read('a.txt'), 'a2\n');
		assert.equal(read('new.txt'), 'n\n');
		await assert.rejects(importShelf(git, 'not a patch', 'x', 'e3'), /does not apply|No valid patches|contains no changes/i);
	});

	it('lists backups with their files, newest first, and local branches', async () => {
		const { root, git, write } = repo();
		write('a.txt', 'a\n'); write('b.txt', 'b\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		write('a.txt', 'a2\n'); write('b.txt', 'b2\n');
		await createBackup(git, pick(root, 'a.txt'), 'l1', 'Rollback');
		await createBackup(git, pick(root, 'a.txt', 'b.txt'), 'l2', 'Rollback');
		const backups = await listBackups(git);
		assert.equal(backups.length, 2);
		assert.deepEqual(backups.map(b => b.paths.length).sort(), [1, 2]);
		assert.equal(backups[0].label, 'Rollback');
		sh(root, 'branch', 'other');
		assert.deepEqual((await localBranches(git)).sort(), ['main', 'other']);
	});
});

import { gitIdentity } from '../core/git';

describe('git identity', () => {
	it('reads the configured name and email, and commits with a typed identity when none is configured', { skip: process.platform === 'win32' && 'uses /dev/null to hide the global Git config' }, async () => {
		const { root, git, write } = repo();
		assert.deepEqual(await gitIdentity(git), { name: 'Test', email: 't@example.com' });
		write('a.txt', 'a\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');

		// Simulate a machine without any Git identity.
		sh(root, 'config', '--unset', 'user.name'); sh(root, 'config', '--unset', 'user.email');
		const bare = new Git('git', root);
		const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
		const saved: Record<string, string | undefined> = {};
		for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
		try {
			assert.deepEqual(await gitIdentity(bare), { name: '', email: '' });
			write('a.txt', 'b\n');
			const who = { name: 'Typed Person', email: 'typed@example.com' };
			await commitFiles(bare, pick(root, 'a.txt'), 'typed identity', { author: `${who.name} <${who.email}>`, committer: who });
			assert.equal(sh(root, 'log', '-1', '--format=%an <%ae> / %cn <%ce>').trim(), 'Typed Person <typed@example.com> / Typed Person <typed@example.com>');
		} finally {
			for (const [k, v] of Object.entries(saved)) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
		}
	});
});

describe('line endings', () => {
	it('does not treat a CRLF/LF difference between Git and the working file as changes', async () => {
		const { root, git, write, read } = repo();
		write('f.txt', TEN.join('\n') + '\n'); sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'init');
		// Git now hands out CRLF, but the file on disk still has LF (as an editor set to LF would save it).
		sh(root, 'config', 'core.autocrlf', 'true');
		const edited = [...TEN]; edited[1] = 'TWO'; edited[8] = 'NINE';
		write('f.txt', edited.join('\n') + '\n');

		const p = await partialContent(git, root, 'f.txt', i => i === 0);
		assert.equal(p.hunks, 2, 'only the two real changes are hunks');
		await commitFiles(git, pick(root, 'f.txt'), 'first only', {}, new Map([[join(root, 'f.txt'), p.content]]));
		const head = sh(root, 'show', 'HEAD:f.txt');
		assert.match(head, /TWO/);
		assert.doesNotMatch(head, /NINE/);
		assert.ok(!head.includes('\r'));

		// Unshelving into an LF file merges cleanly instead of conflicting on every line.
		const ref = await shelve(git, pick(root, 'f.txt'), 'nine', 'eol1');
		write('f.txt', read('f.txt').replace(/\r\n/g, '\n').replace('line 5', 'FIVE'));
		const r = await unshelve(git, ref.sha);
		assert.equal(r.conflicts, false);
		assert.match(read('f.txt'), /FIVE/);
		assert.match(read('f.txt'), /NINE/);
	});
});
