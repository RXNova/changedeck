import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { aggregate } from '../core/aggregate';
import { ChangelistModel, DEFAULT_LIST_NAME } from '../core/model';
import { Status } from '../core/types';

const known = { isKnown: () => true, untrackedToActive: false };
const tracked = (...paths: string[]) => paths.map(path => ({ path, untracked: false }));

describe('ChangelistModel', () => {
	it('starts with one active default list', () => {
		const m = new ChangelistModel();
		assert.equal(m.all().length, 1);
		assert.equal(m.active.name, DEFAULT_LIST_NAME);
	});

	it('assigns new changes to the active list and includes them', () => {
		const m = new ChangelistModel();
		const feature = m.create('Feature', '', true);
		assert.ok(m.reconcile(tracked('/a', '/b'), known));
		assert.equal(m.listOf('/a'), feature.id);
		assert.ok(m.isIncluded('/a'));
		assert.equal(m.reconcile(tracked('/a', '/b'), known), false, 'stable when nothing changed');
	});

	it('keeps explicit moves and forgets files that are no longer changed', () => {
		const m = new ChangelistModel();
		const other = m.create('Other');
		m.reconcile(tracked('/a', '/b'), known);
		m.move(['/b'], other.id);
		m.reconcile(tracked('/a', '/b'), known);
		assert.equal(m.listOf('/b'), other.id);
		m.reconcile(tracked('/a'), known);
		assert.equal(m.listOf('/b'), undefined);
		assert.ok(!m.isIncluded('/b'));
		m.reconcile(tracked('/a', '/b'), known);
		assert.equal(m.listOf('/b'), m.active.id, 'a file changed again lands in the active list');
	});

	it('does not forget files of repositories that have not reported status yet', () => {
		const m = new ChangelistModel();
		const other = m.create('Other');
		m.reconcile(tracked('/repo/a'), known);
		m.move(['/repo/a'], other.id);
		m.reconcile([], { ...known, isKnown: p => !p.startsWith('/repo/') });
		assert.equal(m.listOf('/repo/a'), other.id);
	});

	it('leaves untracked files unversioned unless configured or moved', () => {
		const m = new ChangelistModel();
		m.reconcile([{ path: '/u', untracked: true }], known);
		assert.equal(m.listOf('/u'), undefined);
		m.move(['/u'], m.active.id);
		m.reconcile([{ path: '/u', untracked: true }], known);
		assert.equal(m.listOf('/u'), m.active.id);
		m.reconcile([{ path: '/v', untracked: true }], { ...known, untrackedToActive: true });
		assert.equal(m.listOf('/v'), m.active.id);
	});

	it('routes expected files to their list when they appear', () => {
		const m = new ChangelistModel();
		const shelfList = m.create('Shelved');
		m.expect(['/s'], shelfList.id, 1000);
		m.reconcile([], { ...known, now: 2000 });
		assert.equal(m.listOf('/s'), shelfList.id, 'kept while pending');
		m.reconcile(tracked('/s'), { ...known, now: 3000 });
		assert.equal(m.listOf('/s'), shelfList.id);
		m.reconcile([], { ...known, now: 4000 });
		assert.equal(m.listOf('/s'), undefined, 'normal pruning once it has appeared');
	});

	it('moves files to the active list when a list is deleted, and protects the active list', () => {
		const m = new ChangelistModel();
		const other = m.create('Other');
		m.reconcile(tracked('/a'), known);
		m.move(['/a'], other.id);
		assert.throws(() => m.delete(m.active.id), /active/);
		m.delete(other.id);
		assert.equal(m.listOf('/a'), m.active.id);
		assert.equal(m.all().length, 1);
	});

	it('rejects duplicate names case-insensitively', () => {
		const m = new ChangelistModel();
		const a = m.create('Bugfix');
		assert.throws(() => m.create('bugfix'), /already exists/);
		m.edit(a.id, 'BUGFIX', 'desc');
		assert.equal(a.name, 'BUGFIX');
		assert.equal(a.comment, 'desc');
	});

	it('round-trips through serialization and drops assignments to missing lists', () => {
		const m = new ChangelistModel();
		const other = m.create('Other', 'msg', true);
		m.reconcile(tracked('/a'), known);
		const state = m.serialize();
		state.assignments['/ghost'] = 'missing-id';
		const n = new ChangelistModel(JSON.parse(JSON.stringify(state)));
		assert.equal(n.active.id, other.id);
		assert.equal(n.active.comment, 'msg');
		assert.equal(n.listOf('/a'), other.id);
		assert.equal(n.listOf('/ghost'), undefined);
		assert.ok(n.isIncluded('/a'));
	});
});

describe('aggregate', () => {
	it('merges index and working tree entries into one change per file', () => {
		const changes = aggregate({
			root: '/r',
			merge: [{ path: '/r/c', status: Status.BOTH_MODIFIED }],
			index: [
				{ path: '/r/a', status: Status.INDEX_MODIFIED },
				{ path: '/r/new', status: Status.INDEX_ADDED },
				{ path: '/r/to', originalPath: '/r/from', status: Status.INDEX_RENAMED },
				{ path: '/r/c', status: Status.INDEX_MODIFIED },
			],
			workingTree: [
				{ path: '/r/a', status: Status.MODIFIED },
				{ path: '/r/new', status: Status.MODIFIED },
				{ path: '/r/del', status: Status.DELETED },
				{ path: '/r/ita', status: Status.INTENT_TO_ADD },
			],
			untracked: [{ path: '/r/u', status: Status.UNTRACKED }],
		});
		const kind = (p: string) => changes.get(p)?.kind;
		assert.equal(changes.size, 7);
		assert.equal(kind('/r/a'), 'modified');
		assert.equal(kind('/r/new'), 'added');
		assert.equal(kind('/r/to'), 'renamed');
		assert.equal(changes.get('/r/to')?.originalPath, '/r/from');
		assert.equal(kind('/r/c'), 'conflicted');
		assert.equal(kind('/r/del'), 'deleted');
		assert.equal(kind('/r/ita'), 'added');
		assert.equal(changes.get('/r/u')?.untracked, true);
	});
});

describe('ChangelistModel partial files', () => {
	const r = (start: number, end: number, listId: string) => ({ start, end, listId });

	it('splits a file across lists, includes the active part, and collapses back', () => {
		const m = new ChangelistModel();
		const other = m.create('Other');
		const active = m.active.id;
		m.reconcile(tracked('/f'), known);
		m.move(['/f'], other.id);
		m.setIncluded(['/f'], false);

		assert.ok(m.setPartial('/f', 'base1', [r(1, 2, other.id), r(5, 6, active)]));
		assert.ok(m.isPartial('/f'));
		assert.deepEqual(m.listsOf('/f').sort(), [active, other.id].sort());
		assert.ok(m.isIncluded('/f', active), 'new changes in the active list are checked');
		assert.ok(!m.isIncluded('/f', other.id));
		assert.deepEqual(m.includedLists('/f'), [active]);
		assert.equal(m.setPartial('/f', 'base1', [r(1, 2, other.id), r(5, 6, active)]), false, 'no-op when unchanged');

		m.moveList('/f', active, other.id);
		assert.ok(!m.isPartial('/f'), 'collapses when one list is left');
		assert.equal(m.listOf('/f'), other.id);
		assert.ok(m.isIncluded('/f'), 'the moved part was checked, so the file is');
	});

	it('moves partial parts to the active list when a list is deleted', () => {
		const m = new ChangelistModel();
		const a = m.create('A');
		m.reconcile(tracked('/f'), known);
		m.setPartial('/f', 'b', [r(0, 1, a.id), r(3, 4, m.active.id)]);
		m.delete(a.id);
		assert.ok(!m.isPartial('/f'));
		assert.equal(m.listOf('/f'), m.active.id);
	});

	it('whole-file moves clear the split', () => {
		const m = new ChangelistModel();
		const a = m.create('A');
		const b = m.create('B');
		m.reconcile(tracked('/f'), known);
		m.setPartial('/f', 'b', [r(0, 1, a.id), r(3, 4, m.active.id)]);
		m.move(['/f'], b.id);
		assert.ok(!m.isPartial('/f'));
		assert.deepEqual(m.listsOf('/f'), [b.id]);
		assert.ok(m.isIncluded('/f'));
	});

	it('forgets the split when the file is no longer changed, and persists it otherwise', () => {
		const m = new ChangelistModel();
		const a = m.create('A');
		m.reconcile(tracked('/f', '/g'), known);
		m.setPartial('/f', 'b', [r(0, 1, a.id), r(3, 4, m.active.id)]);
		const restored = new ChangelistModel(JSON.parse(JSON.stringify(m.serialize())));
		assert.deepEqual(restored.partialOf('/f'), m.partialOf('/f'));
		assert.ok(restored.isIncluded('/f', m.active.id));
		m.reconcile(tracked('/g'), known);
		assert.ok(!m.isPartial('/f'));
		assert.ok(!m.isIncluded('/f', m.active.id));
	});

	it('routes new hunks of already changed files without reassigning them', () => {
		const m = new ChangelistModel();
		const a = m.create('A');
		m.reconcile(tracked('/f'), known);
		m.expectHunks(['/f'], a.id, 1000);
		m.reconcile(tracked('/f'), { ...known, now: 2000 });
		assert.equal(m.listOf('/f'), m.active.id, 'file assignment unchanged');
		assert.equal(m.pendingListFor('/f', 2000), a.id);
		m.reconcile(tracked('/f'), { ...known, now: 100_000 });
		assert.equal(m.pendingListFor('/f', 100_000), undefined);
	});
});

describe('ChangelistModel lists and exclusions', () => {
	it('reorders lists, links branches uniquely and stores colors', () => {
		const m = new ChangelistModel();
		const a = m.create('A');
		const b = m.create('B');
		const first = m.all()[0].id;
		m.reorder(b.id, first);
		assert.deepEqual(m.all().map(l => l.name), ['B', 'Changes', 'A']);
		m.reorder(b.id, undefined);
		assert.deepEqual(m.all().map(l => l.name), ['Changes', 'A', 'B']);

		m.setBranch(a.id, 'feature/x');
		m.setBranch(b.id, 'feature/x');
		assert.equal(m.findByBranch('feature/x')?.id, b.id);
		assert.equal(m.get(a.id)?.branch, undefined, 'a branch belongs to one list');
		m.setColor(a.id, 5);

		const restored = new ChangelistModel(JSON.parse(JSON.stringify(m.serialize())));
		assert.equal(restored.findByBranch('feature/x')?.name, 'B');
		assert.equal(restored.get(a.id)?.color, 5);
		assert.deepEqual(restored.all().map(l => l.name), ['Changes', 'A', 'B']);
	});

	it('remembers excluded hunks until the file is no longer changed', () => {
		const m = new ChangelistModel();
		m.reconcile(tracked('/f'), known);
		assert.ok(m.setExcluded('/f', 'b', [[3, 4]]));
		assert.equal(m.setExcluded('/f', 'b', [[3, 4]]), false);
		const restored = new ChangelistModel(JSON.parse(JSON.stringify(m.serialize())));
		assert.deepEqual(restored.excludedOf('/f'), { base: 'b', ranges: [[3, 4]] });
		m.reconcile([], known);
		assert.equal(m.excludedOf('/f'), undefined);
	});
});
