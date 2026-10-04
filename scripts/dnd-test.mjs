// Real drag and drop test for the Changes tree. Launches an isolated VS Code window with the
// DevTools protocol enabled and performs genuine drag gestures inside that window only
// (your mouse is not used). macOS; run with: node scripts/dnd-test.mjs
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'changedeck-dnd-run-'));
const dir = join(tmpdir(), 'changedeck-dnd');
const port = 9339;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const repo = join(tmp, 'repo');
mkdirSync(join(repo, '.vscode'), { recursive: true });
const git = (...a) => execFileSync('git', a, { cwd: repo });
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, '.git', 'info', 'exclude'), '.vscode/\n');
writeFileSync(join(repo, '.vscode', 'settings.json'), '{}');
mkdirSync(join(tmp, 'user', 'User'), { recursive: true });
writeFileSync(join(tmp, 'user', 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'git.openRepositoryInParentFolders': 'always', 'workbench.startupEditor': 'none' }));

const code = process.env.CODE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const child = spawn(code, ['--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--remote-debugging-port=${port}`,
	'--user-data-dir', join(tmp, 'user'), '--extensions-dir', join(tmp, 'ext'),
	`--extensionDevelopmentPath=${here}`, `--extensionTestsPath=${join(here, 'out', 'integration', 'dnd')}`, repo], { stdio: 'ignore' });

let failed = false;
try {
	for (let i = 0; i < 400 && !existsSync(join(dir, 'ready')); i++) { await sleep(100); }
	if (!existsSync(join(dir, 'ready'))) { throw new Error('the window did not get ready'); }

	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find(t => t.type === 'page' && /Extension Development Host/.test(t.title)) ?? targets.find(t => t.type === 'page');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
	let id = 0;
	const pending = new Map();
	const waiters = [];
	ws.onmessage = e => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		if (msg.method) { for (const w of waiters.splice(0)) { if (w.method === msg.method) { w.resolve(msg.params); } else { waiters.push(w); } } }
	};
	const send = (method, params = {}) => new Promise(res => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
	const event = (method, ms = 5000) => new Promise((resolve, reject) => { waiters.push({ method, resolve }); setTimeout(() => reject(new Error(`no ${method} event`)), ms); });

	/** Center of the tree row whose label starts with `text`. */
	const rowCenter = async text => {
		const r = await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
			const rows = [...document.querySelectorAll('.monaco-list-row')];
			const row = rows.find(r => (r.querySelector('.monaco-highlighted-label, .label-name')?.textContent || '').trim().startsWith(${JSON.stringify(text)}));
			if (!row) { return { missing: rows.map(r => r.textContent.slice(0, 30)) }; }
			const b = row.getBoundingClientRect();
			return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
		})()` });
		const v = r.result.result.value;
		if (!v || v.missing) { throw new Error(`row "${text}" not found; rows: ${JSON.stringify(v?.missing)}`); }
		return v;
	};

	/** A genuine drag: press, move to start the drag, then drag events over the target and drop. */
	const drag = async (from, to) => {
		const a = await rowCenter(from);
		const b = await rowCenter(to);
		await send('Input.setInterceptDrags', { enabled: true });
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
		const intercepted = event('Input.dragIntercepted');
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + 6, y: a.y + 6, button: 'left', buttons: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + 14, y: a.y + 14, button: 'left', buttons: 1 });
		const { data } = await intercepted;
		await send('Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data });
		for (let i = 0; i < 4; i++) { await send('Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data }); await sleep(150); }
		await send('Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
		await send('Input.setInterceptDrags', { enabled: false });
		return data.items.map(i => i.mimeType);
	};

	const result = async n => {
		writeFileSync(join(dir, `step-${n}`), '');
		for (let i = 0; i < 100 && !existsSync(join(dir, `result-${n}`)); i++) { await sleep(100); }
		return JSON.parse(readFileSync(join(dir, `result-${n}`), 'utf8'));
	};

	const types = await drag('alpha.txt', 'DropTarget');
	console.log('drag carried types:', types.join(', '));
	const first = await result(1);
	console.log('after dragging alpha.txt onto DropTarget:', JSON.stringify(first));
	if (first.alpha !== 'DropTarget') { failed = true; console.log('FAIL: the file did not move'); } else { console.log('PASS: file moved to the list it was dropped on'); }

	await drag('Third', 'Changes');
	const second = await result(2);
	console.log('after dragging list Third onto Changes:', JSON.stringify(second.order));
	if (second.order[0] !== 'Third') { failed = true; console.log('FAIL: the list was not reordered'); } else { console.log('PASS: list reordered'); }
	ws.close();
} catch (e) {
	failed = true;
	console.log('ERROR:', e.message);
} finally {
	await sleep(1500);
	child.kill();
	rmSync(tmp, { recursive: true, force: true });
	rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
