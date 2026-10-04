import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { buildCommitPrompt, cleanCommitMessage, truncateDiff } from '../core/commitPrompt';

const fileDiff = (name: string, lines: number) =>
	`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,${lines} @@\n` + Array.from({ length: lines }, (_, i) => `+line ${i} of ${name}`).join('\n') + '\n';

describe('truncateDiff', () => {
	it('leaves small diffs alone', () => {
		const d = fileDiff('a.ts', 3);
		assert.equal(truncateDiff(d, 10_000), d);
	});

	it('keeps every file header when shortening', () => {
		const d = fileDiff('a.ts', 2000) + fileDiff('b.ts', 2000) + fileDiff('c.ts', 5);
		const t = truncateDiff(d, 3000);
		assert.ok(t.length < 5000);
		for (const f of ['a.ts', 'b.ts', 'c.ts']) { assert.match(t, new RegExp(`diff --git a/${f.replace('.', '\\.')}`)); }
		assert.match(t, /omitted/);
	});

	it('replaces binary patches with a note', () => {
		const d = 'diff --git a/x.png b/x.png\nindex 1..2\nGIT binary patch\nliteral 10\nzcmV\n';
		assert.equal(truncateDiff(d, 10_000), 'diff --git a/x.png b/x.png\n(binary file changed)\n');
	});
});

describe('buildCommitPrompt', () => {
	it('includes the diff, recent commits, branch, changelist and user instructions', () => {
		const p = buildCommitPrompt({
			diff: fileDiff('a.ts', 2), recentSubjects: ['feat(api): add x', 'fix: y'], branch: 'main',
			listName: 'Login refactor', listDescription: 'Split session handling', instructions: 'Reference JIRA-1', maxDiffChars: 10_000,
		});
		assert.match(p, /```diff\ndiff --git a\/a\.ts/);
		assert.match(p, /- feat\(api\): add x/);
		assert.match(p, /Current branch: main/);
		assert.match(p, /changelist "Login refactor"/);
		assert.match(p, /Split session handling/);
		assert.match(p, /Reference JIRA-1/);
	});
});

describe('cleanCommitMessage', () => {
	it('strips fences, quotes and trailing spaces', () => {
		assert.equal(cleanCommitMessage('```\nAdd x  \n\n- detail\n```'), 'Add x\n\n- detail');
		assert.equal(cleanCommitMessage('"Fix the thing"'), 'Fix the thing');
		assert.equal(cleanCommitMessage('Keep "quoted" words'), 'Keep "quoted" words');
	});
});
