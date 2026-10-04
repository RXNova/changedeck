import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { applyHunks, diffLines, dominantList, Hunk, joinLines, mapRanges, matchLists, rangesAfterCommit, splitLines, toRanges } from '../core/partial';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
}

function mutate(lines: string[], rand: () => number, edits: number): string[] {
	const out = [...lines];
	for (let e = 0; e < edits; e++) {
		const pos = Math.floor(rand() * (out.length + 1));
		const op = rand();
		if (op < 0.33 && out.length) { out.splice(Math.min(pos, out.length - 1), 1 + Math.floor(rand() * 3)); } else if (op < 0.66) { out.splice(pos, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => `new ${Math.floor(rand() * 1000)}`)); } else if (out.length) { out[Math.min(pos, out.length - 1)] = `changed ${Math.floor(rand() * 1000)}`; }
	}
	// splitLines never yields an empty array: an empty file is [''].
	return out.length ? out : [''];
}

function checkHunks(base: string[], current: string[], hunks: Hunk[]): void {
	let lastBase = -1;
	let lastNew = -1;
	for (const h of hunks) {
		assert.ok(h.baseStart <= h.baseEnd && h.newStart <= h.newEnd, 'well-formed');
		assert.ok(h.baseStart > lastBase && h.newStart > lastNew, 'ordered, not touching');
		assert.ok(h.baseEnd > h.baseStart || h.newEnd > h.newStart, 'non-empty');
		lastBase = h.baseEnd;
		lastNew = h.newEnd;
	}
	assert.equal(applyHunks(base, current, hunks, () => true), joinLines(current), 'all hunks give current');
	assert.equal(applyHunks(base, current, hunks, () => false), joinLines(base), 'no hunks give base');
}

describe('splitLines/joinLines', () => {
	it('round-trips exactly, including CRLF and missing final newline', () => {
		for (const t of ['', 'a', 'a\n', 'a\r\nb\r\n', '\n\n', 'x\ny']) { assert.equal(joinLines(splitLines(t)), t); }
	});
});

describe('diffLines', () => {
	it('finds simple hunks', () => {
		assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [{ baseStart: 1, baseEnd: 2, newStart: 1, newEnd: 2 }]);
		assert.deepEqual(diffLines(['a', 'c'], ['a', 'b', 'c']), [{ baseStart: 1, baseEnd: 1, newStart: 1, newEnd: 2 }]);
		assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'c']), [{ baseStart: 1, baseEnd: 2, newStart: 1, newEnd: 1 }]);
		assert.deepEqual(diffLines(['a'], ['a']), []);
		assert.equal(diffLines(['1', 'x', '3', '4', '5', 'y', '7'], ['1', 'X', '3', '4', '5', 'Y', '7']).length, 2);
	});

	it('is exact on thousands of random edits', () => {
		const rand = rng(42);
		for (let round = 0; round < 3000; round++) {
			const base = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => `line ${i % 7 === 0 ? 'dup' : i}`);
			const current = mutate(base, rand, 1 + Math.floor(rand() * 6));
			checkHunks(base, current, diffLines(base, current));
		}
	});

	it('stays exact and fast for large, heavily changed files', () => {
		const rand = rng(7);
		const base = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
		const current = base.map(l => (rand() < 0.2 ? l + ' changed' : l));
		const start = Date.now();
		const hunks = diffLines(base, current);
		checkHunks(base, current, hunks);
		assert.ok(Date.now() - start < 5000, 'falls back instead of running away');
	});
});

describe('matchLists', () => {
	it('keeps a hunk in its list while it is edited, and sends new hunks to the fallback', () => {
		const base = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
		const v1 = ['1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8', '9'];
		const h1 = diffLines(base, v1);
		const stored = toRanges(h1, ['A', 'B']);

		// Grow the first hunk, add a new one at the end.
		const v2 = ['1', 'TWO', 'THREE', '4', '5', '6', 'SEVEN', '8', '9', 'ten'];
		const h2 = diffLines(base, v2);
		assert.deepEqual(matchLists(h2, stored, 'ACTIVE'), ['A', 'B', 'ACTIVE']);

		// Insert lines above everything: base coordinates do not move.
		const v3 = ['zero', ...v1];
		assert.deepEqual(matchLists(diffLines(base, v3), stored, 'ACTIVE'), ['ACTIVE', 'A', 'B']);
	});

	it('ignores ranges of deleted lists', () => {
		const h: Hunk[] = [{ baseStart: 1, baseEnd: 2, newStart: 1, newEnd: 2 }];
		assert.deepEqual(matchLists(h, [{ start: 1, end: 2, listId: 'gone' }], 'ACTIVE', id => id !== 'gone'), ['ACTIVE']);
	});

	it('picks the list with the largest overlap when hunks merge', () => {
		const h: Hunk[] = [{ baseStart: 0, baseEnd: 10, newStart: 0, newEnd: 10 }];
		assert.deepEqual(matchLists(h, [{ start: 0, end: 2, listId: 'A' }, { start: 3, end: 10, listId: 'B' }], 'X'), ['B']);
	});
});

describe('rangesAfterCommit', () => {
	it('matches a fresh diff after committing any subset of hunks', () => {
		const rand = rng(99);
		for (let round = 0; round < 2000; round++) {
			const base = Array.from({ length: 5 + Math.floor(rand() * 30) }, (_, i) => `l${i}`);
			const current = mutate(base, rand, 1 + Math.floor(rand() * 6));
			const hunks = diffLines(base, current);
			const lists = hunks.map(() => (rand() < 0.5 ? 'A' : 'B'));
			const committed = (i: number) => lists[i] === 'A';

			const newBase = splitLines(applyHunks(base, current, hunks, committed));
			const expected = rangesAfterCommit(hunks, lists, committed);
			const fresh = diffLines(newBase, current);
			assert.equal(fresh.length, expected.length, `round ${round}: same number of remaining hunks`);
			assert.deepEqual(matchLists(fresh, expected, 'NEW'), expected.map(r => r.listId), `round ${round}: lists carry over`);
		}
	});
});

describe('dominantList', () => {
	it('weights by changed lines', () => {
		assert.equal(dominantList([{ start: 0, end: 1, listId: 'A' }, { start: 5, end: 9, listId: 'B' }]), 'B');
		assert.equal(dominantList([]), undefined);
	});
});

describe('mapRanges', () => {
	it('carries ranges across a base that gained some of the hunks (same as an outside commit)', () => {
		const rand = rng(1234);
		for (let round = 0; round < 2000; round++) {
			const base = Array.from({ length: 5 + Math.floor(rand() * 30) }, (_, i) => `l${i}`);
			const current = mutate(base, rand, 1 + Math.floor(rand() * 6));
			const hunks = diffLines(base, current);
			const lists = hunks.map(() => (rand() < 0.5 ? 'A' : 'B'));
			const committed = (i: number) => lists[i] === 'A';
			const newBase = splitLines(applyHunks(base, current, hunks, committed));

			const mapped = mapRanges(diffLines(base, newBase), toRanges(hunks, lists).filter((_, i) => !committed(i)));
			const fresh = diffLines(newBase, current);
			assert.deepEqual(matchLists(fresh, mapped, 'NEW'), fresh.map(() => 'B'), `round ${round}`);
		}
	});

	it('shifts ranges below lines added upstream, and keeps ranges above them', () => {
		const diff = diffLines(['a', 'b', 'c', 'd'], ['x', 'y', 'a', 'b', 'c', 'd']);
		assert.deepEqual(mapRanges(diff, [{ start: 2, end: 3, listId: 'L' }]), [{ start: 4, end: 5, listId: 'L' }]);
		const below = diffLines(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd', 'e']);
		assert.deepEqual(mapRanges(below, [{ start: 1, end: 2, listId: 'L' }]), [{ start: 1, end: 2, listId: 'L' }]);
	});
});

describe('diffLines precision on rewrites', () => {
	it('stays precise when a large file has thousands of scattered edits', () => {
		const rand = rng(5);
		const base = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
		const current = base.map(l => (rand() < 0.2 ? l + ' changed' : l));
		const changedLines = current.filter((l, i) => l !== base[i]).length;
		const hunks = diffLines(base, current);
		const covered = hunks.reduce((n, h) => n + h.baseEnd - h.baseStart, 0);
		assert.equal(covered, changedLines, 'only the changed lines are in hunks');
	});
});
