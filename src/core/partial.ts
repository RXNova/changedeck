// Line-level change tracking for partial changelists. Pure functions, no VS Code or Git.
//
// A file's changes are split into hunks: maximal runs of changed lines between the base (HEAD)
// version and the current version. Each hunk is identified by its line range in the base, which
// does not move while the user edits the working copy, so a hunk keeps its changelist while the
// text around and inside it changes.

export interface Hunk {
	/** Range in the base, end exclusive. Empty (start === end) for a pure insertion. */
	baseStart: number;
	baseEnd: number;
	/** Range in the current text, end exclusive. Empty for a pure deletion. */
	newStart: number;
	newEnd: number;
}

/** A hunk's changelist, as persisted. Coordinates are base lines. */
export interface HunkRange {
	start: number;
	end: number;
	listId: string;
}

/** Splits text into lines so that `joinLines(splitLines(t)) === t` for every string. */
export function splitLines(text: string): string[] {
	return text.split('\n');
}

export function joinLines(lines: readonly string[]): string {
	return lines.join('\n');
}

/** Above this many edits within one region between anchors, that region is reported as one hunk. */
const MAX_EDIT_DISTANCE = 2000;

/**
 * Line diff. Lines that occur exactly once on each side are matched first (as in patience diff)
 * and split the problem into small regions, which are then diffed with Myers' algorithm. This
 * keeps large, heavily edited files fast and precise. Hunks are returned in order and never
 * overlap or touch.
 */
export function diffLines(base: readonly string[], current: readonly string[]): Hunk[] {
	// Intern lines so comparisons are integer comparisons.
	const ids = new Map<string, number>();
	const intern = (s: string) => { let id = ids.get(s); if (id === undefined) { ids.set(s, id = ids.size); } return id; };
	const a = Int32Array.from(base, intern);
	const b = Int32Array.from(current, intern);
	const deleted = new Uint8Array(a.length);
	const inserted = new Uint8Array(b.length);
	diffRegion(a, b, 0, a.length, 0, b.length, deleted, inserted);
	return toHunks(a.length, b.length, deleted, inserted);
}

function toHunks(n: number, m: number, deleted: Uint8Array, inserted: Uint8Array): Hunk[] {
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if ((i < n && deleted[i]) || (j < m && inserted[j])) {
			const si = i;
			const sj = j;
			let moved = true;
			while (moved) {
				moved = false;
				while (i < n && deleted[i]) { i++; moved = true; }
				while (j < m && inserted[j]) { j++; moved = true; }
			}
			hunks.push({ baseStart: si, baseEnd: i, newStart: sj, newEnd: j });
		} else {
			i++;
			j++;
		}
	}
	return hunks;
}

/** Marks deleted/inserted lines for a[aLo, aHi) against b[bLo, bHi). */
function diffRegion(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, deleted: Uint8Array, inserted: Uint8Array): void {
	while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++; }
	while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; }
	if (aLo === aHi || bLo === bHi) {
		deleted.fill(1, aLo, aHi);
		inserted.fill(1, bLo, bHi);
		return;
	}
	const anchors = uniqueAnchors(a, b, aLo, aHi, bLo, bHi);
	if (anchors.length) {
		let pa = aLo;
		let pb = bLo;
		for (const [i, j] of anchors) {
			diffRegion(a, b, pa, i, pb, j, deleted, inserted);
			pa = i + 1;
			pb = j + 1;
		}
		diffRegion(a, b, pa, aHi, pb, bHi, deleted, inserted);
		return;
	}
	if (!myers(a, b, aLo, aHi, bLo, bHi, deleted, inserted)) {
		deleted.fill(1, aLo, aHi);
		inserted.fill(1, bLo, bHi);
	}
}

/** Lines unique on both sides of the region, longest increasing run of their positions (patience). */
function uniqueAnchors(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number): [number, number][] {
	const countA = new Map<number, number>();
	for (let i = aLo; i < aHi; i++) { countA.set(a[i], (countA.get(a[i]) ?? 0) + 1); }
	const countB = new Map<number, number>();
	const posB = new Map<number, number>();
	for (let j = bLo; j < bHi; j++) { countB.set(b[j], (countB.get(b[j]) ?? 0) + 1); posB.set(b[j], j); }
	const pairs: [number, number][] = [];
	for (let i = aLo; i < aHi; i++) {
		if (countA.get(a[i]) === 1 && countB.get(a[i]) === 1) { pairs.push([i, posB.get(a[i])!]); }
	}
	if (!pairs.length) { return []; }
	// Longest increasing subsequence on the b positions (pairs are already ordered by a position).
	const tails: number[] = [];
	const prev = new Int32Array(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pairs[tails[mid]][1] < pairs[k][1]) { lo = mid + 1; } else { hi = mid; }
		}
		if (lo > 0) { prev[k] = tails[lo - 1]; }
		tails[lo] = k;
	}
	const result: [number, number][] = [];
	for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) { result.push(pairs[k]); }
	return result.reverse();
}

/** Myers' O(ND) diff of one region. Returns false if the edit distance exceeds the limit. */
function myers(a: Int32Array, b: Int32Array, aLo: number, aHi: number, bLo: number, bHi: number, deleted: Uint8Array, inserted: Uint8Array): boolean {
	const n = aHi - aLo;
	const m = bHi - bLo;
	const max = n + m;
	const off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;

	outer:
	for (let d = 0; d <= max; d++) {
		if (d > MAX_EDIT_DISTANCE) { return false; }
		// Snapshot of the furthest x per diagonal after step d-1, for k in [-d-1, d+1].
		trace.push(v.slice(off - d - 1, off + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x++; y++; }
			v[off + k] = x;
			if (x >= n && y >= m) { found = d; break outer; }
		}
	}

	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d];
		const at = (k: number) => prev[k + d + 1];
		const k = x - y;
		const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		if (prevK === k + 1) { inserted[bLo + prevY] = 1; } else { deleted[aLo + prevX] = 1; }
		x = prevX;
		y = prevY;
	}
	return true;
}

/** True if a hunk and a stored range overlap or touch, treating both as closed intervals. */
function touches(h: Hunk, r: { start: number; end: number }): boolean {
	return r.start <= h.baseEnd && h.baseStart <= r.end;
}

/** For each hunk, whether it overlaps or touches one of the stored base ranges. */
export function matchRanges(hunks: readonly Hunk[], stored: readonly { start: number; end: number }[]): boolean[] {
	return hunks.map(h => stored.some(r => touches(h, r)));
}

function overlap(h: Hunk, r: HunkRange): number {
	return Math.max(0, Math.min(h.baseEnd, r.end) - Math.max(h.baseStart, r.start));
}

/**
 * Gives every hunk a changelist. A hunk that overlaps or touches stored ranges keeps their list
 * (the one with the largest overlap if they disagree). A hunk that matches nothing is new and
 * goes to `fallback`, normally the active changelist.
 */
export function matchLists(hunks: readonly Hunk[], stored: readonly HunkRange[], fallback: string, isValid: (id: string) => boolean = () => true): string[] {
	return hunks.map(h => {
		let best: HunkRange | undefined;
		let bestOverlap = -1;
		for (const r of stored) {
			if (!isValid(r.listId) || !touches(h, r)) { continue; }
			const o = overlap(h, r);
			if (o > bestOverlap) { best = r; bestOverlap = o; }
		}
		return best?.listId ?? fallback;
	});
}

export function toRanges(hunks: readonly Hunk[], lists: readonly string[]): HunkRange[] {
	return hunks.map((h, i) => ({ start: h.baseStart, end: h.baseEnd, listId: lists[i] }));
}

/** The base with only the selected hunks applied. */
export function applyHunks(base: readonly string[], current: readonly string[], hunks: readonly Hunk[], selected: (index: number) => boolean): string {
	const out: string[] = [];
	let pos = 0;
	hunks.forEach((h, i) => {
		for (let k = pos; k < h.baseStart; k++) { out.push(base[k]); }
		if (selected(i)) {
			for (let k = h.newStart; k < h.newEnd; k++) { out.push(current[k]); }
		} else {
			for (let k = h.baseStart; k < h.baseEnd; k++) { out.push(base[k]); }
		}
		pos = h.baseEnd;
	});
	for (let k = pos; k < base.length; k++) { out.push(base[k]); }
	return joinLines(out);
}

/**
 * After the selected hunks were committed (so they became part of the base), returns the ranges
 * of the remaining hunks in the new base's coordinates.
 */
export function rangesAfterCommit(hunks: readonly Hunk[], lists: readonly string[], committed: (index: number) => boolean): HunkRange[] {
	const result: HunkRange[] = [];
	let delta = 0;
	hunks.forEach((h, i) => {
		if (committed(i)) {
			delta += (h.newEnd - h.newStart) - (h.baseEnd - h.baseStart);
		} else {
			result.push({ start: h.baseStart + delta, end: h.baseEnd + delta, listId: lists[i] });
		}
	});
	return result;
}

/**
 * Carries hunk ranges from an old base to a new base (for example after HEAD moved because of a
 * pull or checkout). `baseDiff` is the diff from the old base to the new one. Ranges in unchanged
 * regions shift; a range overlapping a change of the base grows to cover that change.
 */
export function mapRanges(baseDiff: readonly Hunk[], ranges: readonly HunkRange[]): HunkRange[] {
	const map = (pos: number, side: 'start' | 'end'): number => {
		let delta = 0;
		for (const h of baseDiff) {
			if (pos < h.baseStart || (pos === h.baseStart && side === 'start')) { break; }
			if (pos < h.baseEnd || (pos === h.baseEnd && side === 'start' && h.baseStart === h.baseEnd)) {
				return side === 'start' ? h.newStart : h.newEnd;
			}
			delta = h.newEnd - h.baseEnd;
		}
		return pos + delta;
	};
	return ranges.map(r => {
		const start = map(r.start, 'start');
		return { start, end: Math.max(start, map(r.end, 'end')), listId: r.listId };
	});
}

/** The list owning the most changed lines; used when a file's base changes and ranges can no longer be trusted. */
export function dominantList(ranges: readonly HunkRange[]): string | undefined {
	const weight = new Map<string, number>();
	for (const r of ranges) { weight.set(r.listId, (weight.get(r.listId) ?? 0) + Math.max(1, r.end - r.start)); }
	let best: string | undefined;
	let bestWeight = -1;
	for (const [id, w] of weight) { if (w > bestWeight) { best = id; bestWeight = w; } }
	return best;
}

/**
 * Returns `base` with the line endings `current` uses. Git can hand out the base with CRLF
 * (core.autocrlf) while the file on disk has LF, or the other way round; without this, every
 * line would count as changed. A file that mixes endings is left alone.
 */
export function matchEol(base: string, current: string): string {
	const crlf = (current.match(/\r\n/g) ?? []).length;
	const lf = (current.match(/\n/g) ?? []).length - crlf;
	if (crlf > 0 && lf > 0) { return base; }
	if (crlf === 0 && lf === 0) { return base; }
	const normalized = base.replace(/\r\n/g, '\n');
	return crlf > 0 ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/** Heuristic used by Git as well: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(text: string): boolean {
	return text.slice(0, 8000).includes('\0');
}
