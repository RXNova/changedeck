// End-to-end test run inside a real VS Code window by scripts/integration.sh.
import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as git from '../core/git';
import type { ChangelistsApi } from '../extension';
import { UNVERSIONED } from '../state';

async function waitFor(what: string, condition: () => boolean, timeout = 15000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) { throw new Error(`Timed out waiting for: ${what}`); }
		await new Promise(r => setTimeout(r, 100));
	}
}

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export async function run(): Promise<void> {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = (p: string) => path.join(root, p);
	const ext = vscode.extensions.getExtension<ChangelistsApi>('rxnova.changedeck')!;
	const api = (await ext.activate())!;
	assert.ok(api, 'extension activated');
	const { state, commands, shelf } = api;
	const step = (s: string) => console.log(`[integration] ${s}`);

	step('repository discovered');
	await waitFor('repository', () => api.repos.count === 1);

	step('new changes go to the active list; untracked files stay unversioned');
	writeFileSync(file('a.txt'), 'a changed\n');
	writeFileSync(file('b.txt'), 'b changed\n');
	writeFileSync(file('u.txt'), 'untracked\n');
	await api.repos.refresh();
	await waitFor('changes', () => !!state.change(file('a.txt')) && !!state.change(file('b.txt')) && !!state.change(file('u.txt')));
	const active = state.model.active;
	assert.equal(state.ownerOf(file('a.txt')), active.id);
	assert.equal(state.ownerOf(file('b.txt')), active.id);
	assert.equal(state.ownerOf(file('u.txt')), UNVERSIONED);
	assert.ok(state.model.isIncluded(file('a.txt')));

	step('move a file to another changelist');
	const feature = state.mutate(m => m.create('Feature'));
	await vscode.commands.executeCommand('changelists.moveFilesTo', [{ change: state.change(file('b.txt')) }], feature.id);
	assert.equal(state.ownerOf(file('b.txt')), feature.id);

	step('commit only the checked file, with the untracked file added');
	state.mutate(m => m.setIncludedExactly([file('a.txt'), file('u.txt')]));
	assert.equal(await commands.commit({ message: 'Commit a and u', amend: false, push: false }), true);
	assert.deepEqual(sh(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['a.txt', 'u.txt']);
	await waitFor('a.txt committed', () => !state.change(file('a.txt')));
	assert.equal(state.ownerOf(file('b.txt')), feature.id, 'b.txt stays in Feature');

	step('shelve and unshelve back into the original changelist');
	const g = api.repos.git(root);
	const ref = await git.shelve(g, [state.change(file('b.txt'))!], 'Feature work', 'it-1');
	await shelf.setMeta('it-1', { name: 'Feature work', listName: 'Feature' });
	await shelf.reload();
	await api.repos.refresh();
	await waitFor('b.txt shelved', () => !state.change(file('b.txt')));
	assert.equal(readFileSync(file('b.txt'), 'utf8'), 'b\n');
	const node = shelf.all().find(s => s.ref.id === 'it-1');
	assert.ok(node, 'shelf listed');
	assert.equal(node.name, 'Feature work');
	await vscode.commands.executeCommand('changelists.unshelve', node);
	await waitFor('b.txt back', () => !!state.change(file('b.txt')));
	assert.equal(readFileSync(file('b.txt'), 'utf8'), 'b changed\n');
	assert.equal(state.ownerOf(file('b.txt')), state.model.findByName('Feature')!.id, 'unshelved into Feature');
	assert.equal((await git.listShelves(g)).length, 0, 'shelf deleted after unshelve');
	assert.ok(ref.sha);

	step('roll back from the tree');
	await vscode.workspace.getConfiguration('changelists').update('confirmRollback', false, vscode.ConfigurationTarget.Workspace);
	const owner = state.ownerOf(file('b.txt'));
	await vscode.commands.executeCommand('changelists.rollback', { type: 'file', owner, change: state.change(file('b.txt')) });
	await waitFor('b.txt rolled back', () => !state.change(file('b.txt')));
	assert.equal(readFileSync(file('b.txt'), 'utf8'), 'b\n');

	await partialFlow(api, root);
	await polishFlow(api, root);
	await panelFlow(api);
	await featureFlow(api, root);

	step('views and commands are wired up');
	await vscode.commands.executeCommand('changelists.changes.focus');
	await vscode.commands.executeCommand('changelists.commit.focus');
	await vscode.commands.executeCommand('changelists.shelf.focus');
	await vscode.commands.executeCommand('changelists.viewAsTree');
	await vscode.commands.executeCommand('changelists.viewAsList');
	step('all passed');
}

async function partialFlow(api: ChangelistsApi, root: string): Promise<void> {
	const { state, commands, shelf, tracker } = api;
	const step = (s: string) => console.log(`[integration] partial: ${s}`);
	const p = path.join(root, 'p.txt');
	const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
	writeFileSync(p, lines.join('\n') + '\n');
	sh(root, 'add', 'p.txt');
	sh(root, 'commit', '-qm', 'add p');
	await api.repos.refresh();

	const changes = state.model.findByName('Changes')!;
	const feature = state.model.findByName('Feature') ?? state.mutate(m => m.create('Feature'));
	state.mutate(m => m.setActive(changes.id));

	const doc = await vscode.workspace.openTextDocument(p);
	const editor = await vscode.window.showTextDocument(doc);
	const setLine = async (n: number, text: string) => {
		await editor.edit(e => e.replace(doc.lineAt(n).range, text));
		await doc.save();
	};

	step('an edit lands in the active list');
	await setLine(1, 'TWO');
	await api.repos.refresh();
	await waitFor('p.txt changed', () => state.ownerOf(p) === changes.id);

	step('an edit made while another list is active splits the file');
	state.mutate(m => m.setActive(feature.id));
	await setLine(8, 'NINE');
	await waitFor('p.txt partial', () => state.model.isPartial(p)).catch(e => {
		console.log('[integration] debug', JSON.stringify({
			change: state.change(p), cache: tracker.hunks(p), lists: state.model.listsOf(p), listOf: state.model.listOf(p),
			active: state.model.active.id, changes: changes.id, feature: feature.id, docPath: doc.uri.fsPath, text: doc.getText(),
		}));
		throw e;
	});
	assert.deepEqual(state.model.listsOf(p).sort(), [changes.id, feature.id].sort());
	assert.ok(state.filesOf(changes.id).some(c => c.path === p) && state.filesOf(feature.id).some(c => c.path === p), 'shown in both lists');
	const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
	assert.equal(lenses.length, 4, 'two code lenses per change: its list, and in or out of the commit');

	step('commit only the Feature part');
	state.mutate(m => m.setIncludedExactly([{ path: p, listId: feature.id }]));
	assert.equal(await commands.commit({ message: 'nine only', amend: false, push: false }), true);
	const head = sh(root, 'show', 'HEAD:p.txt');
	assert.match(head, /NINE/);
	assert.doesNotMatch(head, /TWO/);
	assert.match(readFileSync(p, 'utf8'), /TWO/);
	await waitFor('remaining change stays in Changes', () => !state.model.isPartial(p) && state.ownerOf(p) === changes.id);

	step('move a single change to another list');
	await setLine(4, 'FIVE');
	await waitFor('split again', () => state.model.isPartial(p));
	const entry = await tracker.refreshNow(p);
	const fiveIndex = entry!.hunks.findIndex(h => h.newStart === 4);
	assert.ok(fiveIndex >= 0);
	tracker.moveHunks(p, [fiveIndex], changes.id);
	await waitFor('collapsed into Changes', () => !state.model.isPartial(p) && state.ownerOf(p) === changes.id);

	step('roll back only one list\'s part');
	await setLine(6, 'SEVEN');
	await waitFor('split for rollback', () => state.model.isPartial(p));
	await vscode.commands.executeCommand('changelists.rollback', [{ change: state.change(p), list: feature.id }]);
	await waitFor('SEVEN rolled back', () => !/SEVEN/.test(readFileSync(p, 'utf8')));
	assert.match(readFileSync(p, 'utf8'), /TWO/);
	assert.match(readFileSync(p, 'utf8'), /FIVE/);

	step('shelve one list\'s part, keep editing, and unshelve back into it');
	await waitFor('editor reloaded', () => !doc.isDirty && !/SEVEN/.test(doc.getText()));
	await setLine(10, 'ELEVEN');
	await waitFor('split for shelve', () => state.model.isPartial(p));
	// Shelve through the same path as the Shelve command: operations run exclusively with change
	// tracking paused, so the file's in-between states while it is rewritten are never observed.
	await commands.exclusive('shelve', () => commands.shelveTargets([{ change: state.change(p)!, list: feature.id }], 'eleven', 'Feature'));
	await waitFor('ELEVEN shelved', () => !/ELEVEN/.test(readFileSync(p, 'utf8')) && !state.model.isPartial(p));
	await waitFor('editor reloaded after shelve', () => !/ELEVEN/.test(doc.getText()));
	await setLine(2, 'THREE');
	const node = shelf.all().find(s => s.name === 'eleven')!;
	assert.ok(node, 'the shelf is listed');
	await vscode.commands.executeCommand('changelists.unshelve', node);
	await waitFor('ELEVEN back', () => /ELEVEN/.test(readFileSync(p, 'utf8')));
	assert.match(readFileSync(p, 'utf8'), /THREE/);
	await waitFor('unshelved change is in Feature', () => state.model.isPartial(p) && state.model.listsOf(p).includes(feature.id)).catch(async e => {
		// What the tracker and the model think, for diagnosing platform differences.
		console.log('[integration] debug', JSON.stringify({
			change: state.change(p), partial: state.model.partialOf(p), listOf: state.model.listOf(p), lists: state.model.listsOf(p),
			active: state.model.active.id, changes: changes.id, feature: feature.id, pending: state.model.pendingListFor(p),
			cache: tracker.hunks(p), refreshed: await tracker.refreshNow(p),
			docDirty: doc.isDirty, docText: doc.getText(), disk: readFileSync(p, 'utf8'), eol: doc.eol,
		}));
		throw e;
	});
	const final = await tracker.refreshNow(p);
	const elevenIdx = final!.hunks.findIndex(h => h.newStart === 10);
	assert.equal(final!.lists[elevenIdx], feature.id);
	assert.notEqual(final!.lists[final!.hunks.findIndex(h => h.newStart === 1)], feature.id, 'TWO stays out of Feature');

	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function polishFlow(api: ChangelistsApi, root: string): Promise<void> {
	const { state, commands, tracker } = api;
	const step = (s: string) => console.log(`[integration] polish: ${s}`);
	const q = path.join(root, 'q.txt');
	const lines = Array.from({ length: 12 }, (_, i) => `q ${i + 1}`);
	writeFileSync(q, lines.join('\n') + '\n');
	sh(root, 'add', 'q.txt');
	sh(root, 'commit', '-qm', 'add q');
	await api.repos.refresh();
	const changes = state.model.findByName('Changes')!;
	const feature = state.model.findByName('Feature')!;

	state.mutate(m => m.setActive(changes.id));
	const doc = await vscode.workspace.openTextDocument(q);
	const editor = await vscode.window.showTextDocument(doc);
	const setLine = async (n: number, text: string) => { await editor.edit(e => e.replace(doc.lineAt(n).range, text)); await doc.save(); };
	await setLine(1, 'TWO');
	await api.repos.refresh();
	await waitFor('q changed', () => state.ownerOf(q) === changes.id);
	state.mutate(m => m.setActive(feature.id));
	await setLine(8, 'NINE');
	await waitFor('q split', () => state.model.isPartial(q));

	step('code actions offer moving the change under the cursor');
	const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', doc.uri, new vscode.Range(1, 0, 1, 0));
	assert.ok(actions.some(a => /Move change to changelist "Feature"/.test(a.title)), 'move action offered');

	step('splits survive HEAD moving outside VS Code (like a pull)');
	await tracker.paused(async () => {
		const upstream = [...lines]; upstream[4] = 'UPSTREAM';
		writeFileSync(q, readFileSync(q, 'utf8').replace('q 5\n', 'UPSTREAM\n'));
		const tmp = path.join(root, '.git', 'tmp-index');
		const env = { ...process.env, GIT_INDEX_FILE: tmp };
		const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: upstream.join('\n') + '\n', encoding: 'utf8' }).trim();
		execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
		execFileSync('git', ['update-index', '--cacheinfo', `100644,${blob},q.txt`], { cwd: root, env });
		const tree = execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
		const commit = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-m', 'upstream'], { cwd: root, encoding: 'utf8' }).trim();
		execFileSync('git', ['update-ref', 'HEAD', commit], { cwd: root });
		execFileSync('git', ['reset', '-q', '--', 'q.txt'], { cwd: root });
	});
	await api.repos.refresh();
	await waitFor('ranges carried over', () => {
		const e = tracker.hunks(q);
		return !!e && e.hunks.length === 2 && state.model.isPartial(q) && state.model.partialOf(q)!.base === sh(root, 'rev-parse', 'HEAD:q.txt').trim();
	});
	const carried = tracker.hunks(q)!;
	assert.deepEqual(carried.lists, [changes.id, feature.id], 'TWO stays in Changes, NINE in Feature');

	step('undo a partial rollback');
	await vscode.commands.executeCommand('changelists.rollback', [{ change: state.change(q), list: feature.id }]);
	await waitFor('NINE rolled back', () => !/NINE/.test(readFileSync(q, 'utf8')));
	const backups = () => sh(root, 'for-each-ref', 'refs/changelists/backup/').split('\n').filter(Boolean).length;
	const backupsBefore = backups();
	await vscode.commands.executeCommand('changelists.undoRollback');
	await waitFor('NINE restored', () => /NINE/.test(readFileSync(q, 'utf8')));
	await waitFor('split restored', () => state.model.isPartial(q) && state.model.listsOf(q).includes(feature.id));
	assert.equal(backups(), backupsBefore - 1, 'the undone backup is removed');

	step('concurrent commits run one after the other');
	state.mutate(m => m.setIncludedExactly([{ path: q, listId: changes.id }]));
	const before = Number(sh(root, 'rev-list', '--count', 'HEAD').trim());
	const results = await Promise.all([
		commands.commit({ message: 'first', amend: false, push: false, signoff: true }),
		commands.commit({ message: 'second', amend: false, push: false }),
	]);
	assert.deepEqual(results, [true, false], 'the second commit finds nothing selected');
	assert.equal(Number(sh(root, 'rev-list', '--count', 'HEAD').trim()), before + 1);
	assert.match(sh(root, 'log', '-1', '--format=%B'), /Signed-off-by:/);
	assert.match(sh(root, 'show', 'HEAD:q.txt'), /TWO/);
	assert.doesNotMatch(sh(root, 'show', 'HEAD:q.txt'), /NINE/);

	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function panelFlow(api: ChangelistsApi): Promise<void> {
	const { state, changes } = api;
	const step = (s: string) => console.log(`[integration] panel: ${s}`);

	step('the tree does not refresh while nothing changes');
	await new Promise(r => setTimeout(r, 1500));
	let refreshes = 0;
	const counter = changes.onDidChangeTreeData(() => { refreshes++; });
	await new Promise(r => setTimeout(r, 3000));
	counter.dispose();
	console.log(`[integration] idle tree refreshes in 3s: ${refreshes}`);
	assert.ok(refreshes <= 1, `the tree refreshed ${refreshes} times in 3 idle seconds`);

	step('tree nodes and context-menu arguments');
	await vscode.commands.executeCommand('changelists.changes.focus');
	const list = state.mutate(m => m.create('Tree List'));
	const roots = changes.getChildren();
	const node = roots.find(n => n.type === 'list' && n.list.id === list.id)!;
	assert.ok(node, 'new list shown in the tree');
	assert.equal(changes.getTreeItem(node).contextValue, 'changelist');
	const previous = state.model.active.id;
	await vscode.commands.executeCommand('changelists.setActive', node);
	assert.equal(state.model.active.id, list.id);
	state.mutate(m => { m.setActive(previous); m.delete(list.id); });

	step('commit message generation degrades gracefully without Copilot');
	state.mutate(m => m.setIncludedExactly([]));
	assert.equal(await api.commands.generateCommitMessage(), 'no-changes');
	const file = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'gen.txt');
	writeFileSync(file, 'generated\n');
	sh(path.dirname(file), 'add', 'gen.txt');
	await api.repos.refresh();
	await waitFor('gen.txt listed', () => !!state.change(file));
	state.mutate(m => m.setIncludedExactly([file]));
	const result = await api.commands.generateCommitMessage();
	assert.ok(result === 'no-model' || result === 'done', `unexpected result ${result}`);
}

async function featureFlow(api: ChangelistsApi, root: string): Promise<void> {
	const { state, commands, tracker, changes } = api;
	const step = (s: string) => console.log(`[integration] features: ${s}`);
	await vscode.workspace.getConfiguration('changelists').update('deleteEmptyChangelistAfterCommit', 'never', vscode.ConfigurationTarget.Workspace);
	const main = state.model.findByName('Changes')!;
	state.mutate(m => m.setActive(main.id));

	step('leave a single change out of a commit');
	const x = path.join(root, 'x.txt');
	const lines = Array.from({ length: 12 }, (_, i) => `x ${i + 1}`);
	writeFileSync(x, lines.join('\n') + '\n');
	sh(root, 'add', 'x.txt'); sh(root, 'commit', '-qm', 'add x');
	const edited = [...lines]; edited[1] = 'KEEP'; edited[9] = 'LATER';
	writeFileSync(x, edited.join('\n') + '\n');
	await api.repos.refresh();
	await waitFor('x changed', () => !!state.change(x));
	const entry = await tracker.refreshNow(x);
	assert.equal(entry!.hunks.length, 2);
	await vscode.commands.executeCommand('changelists.excludeChange', vscode.Uri.file(x), 1);
	assert.deepEqual(tracker.hunks(x)!.excluded, [false, true]);
	state.mutate(m => m.setIncludedExactly([x]));
	assert.equal(await commands.commit({ message: 'keep only', amend: false, push: false }), true);
	const head = sh(root, 'show', 'HEAD:x.txt');
	assert.match(head, /KEEP/);
	assert.doesNotMatch(head, /LATER/);
	assert.match(readFileSync(x, 'utf8'), /LATER/, 'left-out change stays in the working tree');
	await waitFor('exclusion cleared after commit', () => !state.model.excludedOf(x) && !!state.change(x));

	step('reorder changelists and set a color');
	const first = state.mutate(m => m.create('Order A'));
	const second = state.mutate(m => m.create('Order B'));
	state.mutate(m => m.reorder(second.id, first.id));
	const order = changes.getChildren().filter(n => n.type === 'list').map(n => (n.type === 'list' ? n.list.name : ''));
	assert.ok(order.indexOf('Order B') < order.indexOf('Order A'), 'tree follows the model order');
	state.mutate(m => m.setColor(first.id, 4));
	assert.equal(state.model.get(first.id)?.color, 4);

	step('a file in a non-active list is marked in the Explorer');
	state.mutate(m => m.move([x], first.id));
	const decorations = new (await import('../extras')).ChangelistFileDecorations(state);
	assert.match(decorations.provideFileDecoration(vscode.Uri.file(x))?.tooltip ?? '', /Order A/);
	decorations.dispose();
	state.mutate(m => m.move([x], main.id));

	step('add an unversioned file to .gitignore');
	const junk = path.join(root, 'junk.log');
	writeFileSync(junk, 'junk\n');
	await api.repos.refresh();
	await waitFor('junk listed', () => !!state.change(junk));
	await vscode.commands.executeCommand('changelists.addToGitignore', { type: 'file', owner: '__unversioned__', change: state.change(junk) });
	assert.match(readFileSync(path.join(root, '.gitignore'), 'utf8'), /^\/junk\.log$/m);
	await waitFor('junk ignored', () => !state.change(junk));

	step('a linked changelist becomes active when its branch is checked out');
	state.mutate(m => { m.setBranch(second.id, 'feature/linked'); m.setActive(main.id); });
	sh(root, 'checkout', '-q', '-b', 'feature/linked');
	await api.repos.refresh();
	await waitFor('linked list active', () => state.model.active.id === second.id);
	sh(root, 'checkout', '-q', 'main');
	await api.repos.refresh();
	state.mutate(m => m.setActive(main.id));

	step('Copilot helpers degrade gracefully without Copilot');
	const extra = path.join(root, 'y.txt');
	writeFileSync(extra, 'y\n'); sh(root, 'add', 'y.txt');
	await api.repos.refresh();
	await waitFor('two files in Changes', () => state.filesOf(main.id).length >= 2);
	assert.ok(['unavailable', 'nothing', 'done'].includes(await api.extras.suggestChangelists()));
	state.mutate(m => m.setIncludedExactly([x]));
	assert.ok(['unavailable', 'done'].includes(await api.extras.reviewChanges()));

	state.mutate(m => { m.delete(first.id); m.delete(second.id); });
}
