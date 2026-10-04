import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import { addedTodos, buildSplitPrompt, cleanName, parseSplitResponse } from '../core/aiSplit';
import { parseRemote, pullRequestUrl } from '../core/remote';

describe('pullRequestUrl', () => {
	it('understands the common remote URL forms and hosts', () => {
		assert.deepEqual(parseRemote('git@github.com:acme/app.git'), { host: 'github.com', owner: 'acme', repo: 'app' });
		assert.equal(pullRequestUrl('git@github.com:acme/app.git', 'feature/x'), 'https://github.com/acme/app/compare/feature%2Fx?expand=1');
		assert.equal(pullRequestUrl('https://user@github.com/acme/app', 'f'), 'https://github.com/acme/app/compare/f?expand=1');
		assert.equal(pullRequestUrl('ssh://git@gitlab.example.com:2222/group/sub/app.git', 'f'), 'https://gitlab.example.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=f');
		assert.equal(pullRequestUrl('https://bitbucket.org/acme/app.git', 'f'), 'https://bitbucket.org/acme/app/pull-requests/new?source=f');
		assert.equal(pullRequestUrl('https://example.com/acme/app.git', 'f'), undefined);
		assert.equal(pullRequestUrl('/local/path', 'f'), undefined);
	});
});

describe('parseSplitResponse', () => {
	const files = ['src/a.ts', 'src/b.ts', 'README.md'];

	it('reads JSON wrapped in prose or fences, and drops unknown or repeated files', () => {
		const text = 'Here you go:\n```json\n{"changelists":[{"name":"Refactor","description":"Split a","files":["src/a.ts","src/zzz.ts"]},{"name":"Docs","description":"Update docs","files":["README.md","src/a.ts"]},{"name":"refactor","files":["src/b.ts"]},{"name":"Empty","files":[]}]}\n```';
		const { proposals, unassigned } = parseSplitResponse(text, files);
		assert.deepEqual(proposals, [
			{ name: 'Refactor', description: 'Split a', files: ['src/a.ts', 'src/b.ts'] },
			{ name: 'Docs', description: 'Update docs', files: ['README.md'] },
		]);
		assert.deepEqual(unassigned, []);
	});

	it('reports files the model left out and rejects non-JSON answers', () => {
		const { unassigned } = parseSplitResponse('{"changelists":[{"name":"A","files":["src/a.ts"]}]}', files);
		assert.deepEqual(unassigned, ['src/b.ts', 'README.md']);
		assert.throws(() => parseSplitResponse('I cannot do that.', files), /did not return/);
		assert.throws(() => parseSplitResponse('{"changelists": [oops]}', files), /could not be read/);
	});

	it('lists files and existing lists in the prompt', () => {
		const p = buildSplitPrompt('diff --git a/src/a.ts b/src/a.ts\n+x\n', files, ['Bugfix'], 5000);
		assert.match(p, /- src\/a\.ts/);
		assert.match(p, /"Bugfix"/);
	});
});

describe('small helpers', () => {
	it('cleans suggested names', () => {
		assert.equal(cleanName('"Login refactor."\nextra'), 'Login refactor');
		assert.equal(cleanName('**Fix cache key**'), 'Fix cache key');
	});

	it('finds TODO and FIXME only in added lines', () => {
		const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,3 @@\n-// TODO old\n+// TODO: new thing\n+const a = 1; // FIXME later\n context TODO\n';
		assert.deepEqual(addedTodos(diff), ['x.ts: // TODO: new thing', 'x.ts: const a = 1; // FIXME later']);
	});
});
