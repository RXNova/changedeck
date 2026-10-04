// Opens the views on a sample repository and holds the window open for a screenshot (scripts/demo.sh).
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as git from '../core/git';
import type { ChangelistsApi } from '../extension';

export async function run(): Promise<void> {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = (p: string) => path.join(root, p);
	const api = (await vscode.extensions.getExtension<ChangelistsApi>('rxnova.changedeck')!.activate())!;
	while (api.repos.count === 0) { await new Promise(r => setTimeout(r, 100)); }
	const { state } = api;

	mkdirSync(file('src/auth'), { recursive: true });
	writeFileSync(file('src/auth/login.ts'), 'export const login = 2;\n');
	writeFileSync(file('src/auth/session.ts'), 'export const session = 1;\n');
	writeFileSync(file('README.md'), '# Demo\nUpdated docs\n');
	writeFileSync(file('src/api.ts'), 'export const api = 2;\n');
	writeFileSync(file('notes.txt'), 'scratch\n');
	await api.repos.refresh();
	while (!state.change(file('src/api.ts'))) { await new Promise(r => setTimeout(r, 100)); }

	const auth = state.mutate(m => m.create('Login refactor', 'Refactor login flow\n\nSplit session handling out of login.'));
	const docs = state.mutate(m => m.create('Docs'));
	state.mutate(m => {
		m.move([file('src/auth/login.ts'), file('src/auth/session.ts')], auth.id);
		m.move([file('README.md')], docs.id);
		m.setActive(auth.id);
		m.setIncludedExactly([file('src/auth/login.ts'), file('src/auth/session.ts')]);
	});
	writeFileSync(file('src/config.ts'), 'export const config = 2;\n');
	await api.repos.refresh();
	const config = state.change(file('src/config.ts'));
	if (config) {
		await git.shelve(api.repos.git(root), [config], 'Experiment: new config format', 'demo-1');
		await api.shelf.setMeta('demo-1', { name: 'Experiment: new config format', listName: 'Changes' });
		await api.shelf.reload();
	}
	await api.repos.refresh();

	// A file split across two changelists, open in the editor.
	const svc = file('src/service.ts');
	const original = [
		'export class Service {',
		'  private cache = new Map<string, string>();',
		'',
		'  get(key: string): string | undefined {',
		'    return this.cache.get(key);',
		'  }',
		'',
		'  set(key: string, value: string): void {',
		'    this.cache.set(key, value);',
		'  }',
		'',
		'  clear(): void {',
		'    this.cache.clear();',
		'  }',
		'}',
		'',
	];
	writeFileSync(svc, original.join('\n'));
	execFileSync('git', ['add', 'src/service.ts'], { cwd: root });
	execFileSync('git', ['commit', '-qm', 'service'], { cwd: root });
	await api.repos.refresh();
	const doc = await vscode.workspace.openTextDocument(svc);
	const editor = await vscode.window.showTextDocument(doc);
	await new Promise(r => setTimeout(r, 500));
	state.mutate(m => m.setActive(auth.id));
	await editor.edit(e => e.replace(doc.lineAt(4).range, '    return this.cache.get(key.trim());'));
	await doc.save();
	await new Promise(r => setTimeout(r, 600));
	state.mutate(m => m.setActive(docs.id));
	await editor.edit(e => e.insert(doc.lineAt(11).range.start, '  /** Removes every entry. */\n'));
	await doc.save();
	await new Promise(r => setTimeout(r, 600));
	state.mutate(m => m.setActive(auth.id));
	await api.repos.refresh();

	await vscode.commands.executeCommand('workbench.view.extension.changedeck');
	await vscode.commands.executeCommand('changelists.commit.focus');
	await vscode.commands.executeCommand('changelists.changes.focus');
	await vscode.window.showTextDocument(doc);
	await new Promise(r => setTimeout(r, Number(process.env.DEMO_MS ?? 15000)));
}
