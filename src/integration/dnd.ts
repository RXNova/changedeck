// Sets up two changelists and waits while scripts/dnd-test.mjs performs a real drag and drop in
// the window (through the DevTools protocol). Reports what happened to a result file.
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangelistsApi } from '../extension';

const DIR = path.join(tmpdir(), 'changedeck-dnd');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<void> {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	rmSync(DIR, { recursive: true, force: true });
	mkdirSync(DIR, { recursive: true });
	const api = (await vscode.extensions.getExtension<ChangelistsApi>('pradeep.changedeck')!.activate())!;
	while (api.repos.count === 0) { await sleep(100); }
	const { state } = api;

	const a = path.join(root, 'alpha.txt');
	const b = path.join(root, 'beta.txt');
	writeFileSync(a, 'a\n'); writeFileSync(b, 'b\n');
	execFileSync('git', ['add', '.'], { cwd: root });
	execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
	writeFileSync(a, 'a2\n'); writeFileSync(b, 'b2\n');
	await api.repos.refresh();
	while (!state.change(a) || !state.change(b)) { await sleep(100); }
	const source = state.model.active;
	const target = state.mutate(m => m.create('DropTarget'));
	const third = state.mutate(m => m.create('Third'));
	await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	await vscode.commands.executeCommand('changelists.changes.focus');
	await sleep(1500);

	const snapshot = () => ({
		alpha: state.model.get(state.ownerOf(a))?.name,
		beta: state.model.get(state.ownerOf(b))?.name,
		order: state.model.all().map(l => l.name),
	});
	writeFileSync(path.join(DIR, 'ready'), JSON.stringify({ source: source.name, target: target.name, third: third.name }));

	// The driver writes "step-N" files; after each one, report the state.
	for (let stepNo = 1; stepNo <= 2; stepNo++) {
		for (let i = 0; i < 300; i++) {
			try { execFileSync('test', ['-f', path.join(DIR, `step-${stepNo}`)]); break; } catch { await sleep(100); }
		}
		await sleep(700);
		writeFileSync(path.join(DIR, `result-${stepNo}`), JSON.stringify(snapshot()));
	}
	await sleep(500);
}
