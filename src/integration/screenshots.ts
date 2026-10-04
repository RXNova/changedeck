// Builds a mock project with several changelists and walks through the features, pausing at each
// stage so scripts/screenshots.sh can capture the window. Run with: ./scripts/screenshots.sh
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as git from '../core/git';
import type { ChangelistsApi } from '../extension';

const STAGE_DIR = path.join(tmpdir(), 'changedeck-screenshots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Announces a stage and waits until the capture script has taken its screenshot. */
async function stage(name: string): Promise<void> {
	await sleep(900);
	writeFileSync(path.join(STAGE_DIR, 'stage'), name);
	const ack = path.join(STAGE_DIR, `ack-${name}`);
	for (let i = 0; i < 150 && !existsSync(ack); i++) { await sleep(100); }
}

const FILES: Record<string, string> = {
	'README.md': '# Shop API\n\nA small storefront API.\n\n## Running\n\n```sh\nnpm start\n```\n',
	'package.json': '{\n  "name": "shop-api",\n  "version": "2.3.0",\n  "scripts": { "start": "node dist/server.js", "test": "vitest" }\n}\n',
	'src/config.ts': 'export const config = {\n  port: 8080,\n  sessionTtlMinutes: 30,\n  currency: \'EUR\',\n};\n',
	'src/auth/login.ts': 'import { createSession } from \'./session\';\nimport { findUser, verifyPassword } from \'../db/users\';\n\nexport async function login(email: string, password: string) {\n  const user = await findUser(email);\n  if (!user || !verifyPassword(user, password)) {\n    throw new Error(\'Invalid credentials\');\n  }\n  return createSession(user.id);\n}\n',
	'src/auth/session.ts': 'import { randomUUID } from \'crypto\';\n\nconst sessions = new Map<string, string>();\n\nexport function createSession(userId: string): string {\n  const token = randomUUID();\n  sessions.set(token, userId);\n  return token;\n}\n\nexport function userOf(token: string): string | undefined {\n  return sessions.get(token);\n}\n',
	'src/cart/pricing.ts': 'export interface Line {\n  price: number;\n  quantity: number;\n}\n\nexport function lineTotal(line: Line): number {\n  return line.price * line.quantity;\n}\n\nexport function cartTotal(lines: Line[]): number {\n  return lines.reduce((sum, line) => sum + lineTotal(line), 0);\n}\n',
	'src/cart/pricing.test.ts': 'import { expect, test } from \'vitest\';\nimport { cartTotal } from \'./pricing\';\n\ntest(\'adds up lines\', () => {\n  expect(cartTotal([{ price: 2, quantity: 3 }])).toBe(6);\n});\n',
	'src/api/routes.ts': [
		'import { Router } from \'express\';',
		'import { login } from \'../auth/login\';',
		'import { cartTotal } from \'../cart/pricing\';',
		'import { loadCart } from \'../db/carts\';',
		'',
		'export const router = Router();',
		'',
		'router.post(\'/login\', async (req, res) => {',
		'  const token = await login(req.body.email, req.body.password);',
		'  res.json({ token });',
		'});',
		'',
		'router.get(\'/health\', (_req, res) => {',
		'  res.json({ ok: true });',
		'});',
		'',
		'router.get(\'/cart/:id/total\', async (req, res) => {',
		'  const cart = await loadCart(req.params.id);',
		'  res.json({ total: cartTotal(cart.lines) });',
		'});',
		'',
	].join('\n'),
};

export async function run(): Promise<void> {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const file = (p: string) => path.join(root, p);
	const sh = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
	const write = (p: string, content: string) => { mkdirSync(path.dirname(file(p)), { recursive: true }); writeFileSync(file(p), content); };
	rmSync(STAGE_DIR, { recursive: true, force: true });
	mkdirSync(STAGE_DIR, { recursive: true });

	const api = (await vscode.extensions.getExtension<ChangelistsApi>('rxnova.changedeck')!.activate())!;
	while (api.repos.count === 0) { await sleep(100); }
	const { state, tracker, shelf, commitView } = api;
	const config = vscode.workspace.getConfiguration('changelists');
	await config.update('confirmRollback', false, vscode.ConfigurationTarget.Workspace);
	await config.update('codeLens', 'always', vscode.ConfigurationTarget.Workspace);
	await config.update('editorMarkers', 'always', vscode.ConfigurationTarget.Workspace);

	// ---- The project and its first commit --------------------------------------------------
	for (const [p, content] of Object.entries(FILES)) { write(p, content); }
	sh('add', '.'); sh('commit', '-qm', 'Shop API');
	sh('checkout', '-q', '-b', 'feature/login');
	await api.repos.refresh();

	// ---- Shelves ---------------------------------------------------------------------------
	write('src/auth/session.ts', FILES['src/auth/session.ts'].replace('const sessions = new Map<string, string>();', 'const sessions = createRedisStore();'));
	write('src/auth/redis.ts', 'export function createRedisStore() {\n  return new Map<string, string>();\n}\n');
	await api.repos.refresh();
	while (!state.change(file('src/auth/session.ts')) || !state.change(file('src/auth/redis.ts'))) { await sleep(100); }
	await git.shelve(api.repos.git(root), [state.change(file('src/auth/session.ts'))!, state.change(file('src/auth/redis.ts'))!], 'Experiment: Redis sessions', 'shot-1');
	await shelf.setMeta('shot-1', { name: 'Experiment: Redis sessions', listName: 'Login refactor' });
	write('package.json', FILES['package.json'].replace('"vitest"', '"vitest run --coverage"'));
	await api.repos.refresh();
	while (!state.change(file('package.json'))) { await sleep(100); }
	await git.shelve(api.repos.git(root), [state.change(file('package.json'))!], 'Coverage in CI', 'shot-2');
	await shelf.setMeta('shot-2', { name: 'Coverage in CI', listName: 'Changes' });
	await shelf.reload();
	await api.repos.refresh();

	// ---- Changelists -----------------------------------------------------------------------
	const changes = state.model.active;
	const login = state.mutate(m => m.create('Login refactor', 'Refactor login flow\n\nValidate input first and keep sessions for 30 minutes.'));
	const cart = state.mutate(m => m.create('Fix cart rounding', 'Round cart totals to cents'));
	const docs = state.mutate(m => m.create('Docs', 'Document the API endpoints'));
	state.mutate(m => { m.setBranch(login.id, 'feature/login'); m.setActive(login.id); });

	// Login refactor: two whole files, plus the first change in routes.ts (typed in the editor).
	write('src/auth/login.ts', FILES['src/auth/login.ts'].replace('  const user = await findUser(email);', '  if (!email || !password) {\n    throw new Error(\'Email and password are required\');\n  }\n  const user = await findUser(email.trim().toLowerCase());'));
	write('src/auth/session.ts', FILES['src/auth/session.ts'].replace('  sessions.set(token, userId);', '  sessions.set(token, userId);\n  setTimeout(() => sessions.delete(token), 30 * 60_000);'));
	const routes = await vscode.workspace.openTextDocument(file('src/api/routes.ts'));
	const editor = await vscode.window.showTextDocument(routes);
	await sleep(600);
	await editor.edit(e => e.replace(routes.lineAt(8).range, '  const { email, password } = req.body;\n  const token = await login(email, password);'));
	await routes.save();
	await sleep(700);

	// Fix cart rounding: pricing files, plus the second change in routes.ts.
	state.mutate(m => m.setActive(cart.id));
	await editor.edit(e => e.replace(routes.lineAt(19).range, '  res.json({ total: cartTotal(cart.lines), currency: \'EUR\' });'));
	await routes.save();
	await sleep(700);
	write('src/cart/pricing.ts', FILES['src/cart/pricing.ts'].replace('  return line.price * line.quantity;', '  return Math.round(line.price * line.quantity * 100) / 100;'));
	write('src/cart/pricing.test.ts', FILES['src/cart/pricing.test.ts'] + '\ntest(\'rounds to cents\', () => {\n  expect(cartTotal([{ price: 0.1, quantity: 3 }])).toBe(0.3);\n});\n');

	// Docs, the default list and unversioned files.
	state.mutate(m => m.setActive(docs.id));
	write('README.md', FILES['README.md'] + '\n## Endpoints\n\n- `POST /login`\n- `GET /cart/:id/total`\n');
	state.mutate(m => m.setActive(changes.id));
	write('src/config.ts', FILES['src/config.ts'].replace('port: 8080', 'port: 3000'));
	write('notes.txt', 'Ask Sam about the session timeout.\n');
	write('.env.local', 'SESSION_SECRET=dev-only\n');
	await api.repos.refresh();
	while (!state.change(file('src/config.ts')) || !state.change(file('README.md'))) { await sleep(100); }
	state.mutate(m => {
		m.move([file('src/auth/login.ts'), file('src/auth/session.ts')], login.id);
		m.move([file('src/cart/pricing.ts'), file('src/cart/pricing.test.ts')], cart.id);
		m.move([file('README.md')], docs.id);
		m.move([file('src/config.ts')], changes.id);
		m.setActive(login.id);
		m.setIncludedExactly([file('src/auth/login.ts'), file('src/auth/session.ts'), { path: file('src/api/routes.ts'), listId: login.id }]);
	});
	await tracker.refreshNow(file('src/api/routes.ts'));

	// ---- Layout ----------------------------------------------------------------------------
	await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
	await vscode.commands.executeCommand('workbench.action.closePanel');
	await vscode.commands.executeCommand('notifications.clearAll');
	await vscode.commands.executeCommand('workbench.view.extension.changedeck');
	await vscode.commands.executeCommand('changelists.commit.focus');
	await vscode.commands.executeCommand('changelists.changes.focus');
	await vscode.window.showTextDocument(routes);
	await vscode.commands.executeCommand('notifications.clearAll');

	// 1. Everything at a glance.
	await stage('overview');

	// 2. Folder tree.
	await vscode.commands.executeCommand('changelists.viewAsTree');
	await stage('tree-view');
	await vscode.commands.executeCommand('changelists.viewAsList');

	// 3. One change left out of the commit.
	await vscode.commands.executeCommand('changelists.excludeChange', routes.uri, 0);
	await stage('leave-change-out');
	await vscode.commands.executeCommand('changelists.includeChange', routes.uri, 0);

	// 4. A split file's diff shows only one list's changes.
	await vscode.commands.executeCommand('changelists.openDiff', { type: 'file', owner: cart.id, change: state.change(file('src/api/routes.ts')) });
	await stage('partial-diff');
	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

	// 5. Commit options and author.
	await vscode.window.showTextDocument(routes);
	await sleep(600);
	await commitView.showOptions();
	await stage('commit-options');

	// 6. Switching the active changelist.
	void vscode.commands.executeCommand('changelists.switchActive');
	await stage('switch-active');
	await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

	// 7. The shelf, with a shelved file's diff.
	await commitView.showOptions(false);
	await vscode.commands.executeCommand('changelists.shelf.focus');
	await sleep(800);
	const shelved = shelf.all().find(s => s.ref.id === 'shot-1');
	if (shelved) {
		await shelf.view.reveal(shelved, { expand: true, select: true, focus: true });
		const children = await shelf.getChildren(shelved);
		const sessionFile = children.find(c => c.type === 'shelfFile' && c.file.path.endsWith('session.ts'));
		if (sessionFile && sessionFile.type === 'shelfFile') { await shelf.openDiff(sessionFile); }
	}
	await vscode.commands.executeCommand('changelists.shelf.focus');
	await sleep(1200);
	await stage('shelf');
	await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

	// 8. Rollback with Undo.
	await vscode.commands.executeCommand('changelists.changes.focus');
	await vscode.commands.executeCommand('changelists.rollback', { type: 'file', owner: docs.id, change: state.change(file('README.md')) });
	await stage('rollback-undo');
	await vscode.commands.executeCommand('changelists.undoRollback');
	await vscode.commands.executeCommand('notifications.clearAll');

	// 9. Markers in the Explorer.
	await vscode.commands.executeCommand('workbench.view.explorer');
	await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
	await vscode.window.showTextDocument(routes);
	await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
	await stage('explorer-markers');

	writeFileSync(path.join(STAGE_DIR, 'stage'), 'done');
	await sleep(500);
}
