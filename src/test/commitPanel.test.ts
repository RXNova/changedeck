// The Commit panel's script lives in an HTML template string, where a wrong escape only shows up
// as a broken panel at runtime. This test extracts the script, checks that it parses, and drives
// the author fields in a minimal fake DOM.
import { strict as assert } from 'assert';
import { describe, it } from 'node:test';
import Module = require('module');

interface FakeElement {
	value: string; checked: boolean; textContent: string; hidden: boolean; disabled: boolean;
	placeholder: string; title: string; readOnly: boolean;
	classList: { toggle(c: string, on: boolean): void; contains(c: string): boolean };
	listeners: Record<string, () => void>;
	addEventListener(type: string, fn: () => void): void;
	focus(): void;
}

function panelScript(): string {
	const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
	const original = loader._load;
	loader._load = (request, ...rest) => request === 'vscode'
		? { window: { registerWebviewViewProvider: () => ({ dispose() { /* nothing */ } }) }, commands: { executeCommand: async () => undefined } }
		: original(request, ...rest);
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { CommitView } = require('../commitView');
		const state = { onDidChange: () => ({ dispose() { /* nothing */ } }), model: { active: { id: 'a', name: 'A', comment: '' }, get: () => undefined }, included: () => [], ownerOf: () => 'a', repos: { count: 1 } };
		const view = new CommitView({ get: (_k: string, d: unknown) => d, update: async () => undefined }, state, async () => '', async () => ({ name: '', email: '' }), async () => true);
		const html: string = view.html();
		const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html);
		assert.ok(match, 'panel has an inline script');
		return match[1];
	} finally {
		loader._load = original;
	}
}

describe('Commit panel script', () => {
	it('parses and validates the author name and email fields', () => {
		const script = panelScript();
		const elements: Record<string, FakeElement> = {};
		const el = (id: string): FakeElement => elements[id] ??= {
			value: '', checked: false, textContent: '', hidden: false, disabled: false, placeholder: '', title: '', readOnly: false,
			classList: (() => { const set = new Set<string>(); return { toggle: (c: string, on: boolean) => { on ? set.add(c) : set.delete(c); }, contains: (c: string) => set.has(c) }; })(),
			listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, focus() { /* nothing */ },
		};
		const posted: { type: string; authorName?: string; authorEmail?: string }[] = [];
		const run = new Function('document', 'navigator', 'window', 'acquireVsCodeApi', script);
		let receive: (e: { data: unknown }) => void = () => undefined;
		const fakeWindow = { addEventListener(type: string, fn: (e: { data: unknown }) => void) { if (type === 'message') { receive = fn; } } };
		const created: (FakeElement & { className: string; append(): void })[] = [];
		const fakeDocument = {
			getElementById: el, activeElement: null,
			createElement: () => { const e = Object.assign(el(`created-${created.length}`), { className: '', append() { /* nothing */ } }); created.push(e); return e; },
		};
		Object.assign(el('authorNote'), { append() { /* nothing */ } });
		// Collects what is appended so the "Committing as ..." line can be read back as text.
		const as = el('committingAs') as FakeElement & { parts: string[]; append(...nodes: (string | FakeElement)[]): void };
		as.parts = [];
		as.append = (...nodes) => { as.parts.push(...nodes.map(n => (typeof n === 'string' ? n : n.textContent))); };
		// Like the DOM: assigning textContent replaces whatever was appended before.
		let ownText = '';
		Object.defineProperty(as, 'textContent', { get: () => ownText, set: (v: string) => { ownText = v; as.parts = []; } });
		const committingAs = () => ownText + as.parts.join('');
		run(fakeDocument, { platform: 'MacIntel' }, fakeWindow, () => ({ postMessage: (m: { type: string }) => posted.push(m) }));

		const type = (id: string, value: string) => { el(id).value = value; el(id).listeners.input(); };
		const check = (name: string, email: string, hint: string) => {
			type('authorName', name);
			type('authorEmail', email);
			assert.equal(el('authorHint').textContent, hint, `name "${name}", email "${email}"`);
			assert.equal(el('authorHint').hidden, !hint);
		};
		check('', '', '');
		check('Ada', '', "Enter the author's email too.");
		check('', 'ada@example.com', "Enter the author's name too.");
		check('Ada', 'not-an-email', 'Enter a valid email address.');
		check('Ada <x>', 'ada@example.com', 'The name cannot contain < or >.');
		check('Ada Lovelace', 'ada@example.com', '');
		const last = posted.filter(m => m.type === 'options').pop();
		assert.deepEqual([last?.authorName, last?.authorEmail], ['Ada Lovelace', 'ada@example.com']);

		// The Git identity is shown in the fields; editing them marks the commit as someone else's.
		const stateMessage = { type: 'state', files: 1, amend: false, busy: false, hasRepos: true, signoff: false, noVerify: false, authorName: '', authorEmail: '', gitName: 'Grace Hopper', gitEmail: 'grace@example.com' };
		receive({ data: stateMessage });
		assert.deepEqual([el('authorName').value, el('authorEmail').value], ['Grace Hopper', 'grace@example.com']);
		assert.match(el('authorNote').textContent, /Your Git identity/);
		assert.equal(committingAs(), 'Committing as Grace Hopper <grace@example.com>');
		assert.equal(el('authorHint').hidden, true);
		type('authorName', 'Ada Lovelace');
		assert.match(el('authorNote').textContent, /Different from your Git identity \(Grace Hopper\)/);
		const reset = [...created].reverse().find(e => e.textContent === 'Reset');
		assert.ok(reset, 'a Reset link is offered');
		reset.listeners.click();
		assert.deepEqual([el('authorName').value, el('authorEmail').value], ['Grace Hopper', 'grace@example.com'], 'Reset restores the Git identity');
		type('authorName', 'Ada Lovelace');
		assert.equal(committingAs(), 'Committing as Ada Lovelace <grace@example.com>', 'follows the fields');

		// An incomplete author blocks committing even with a message.
		el('message').value = 'A message';
		type('authorEmail', '');
		assert.equal(el('commit').disabled, true);
		assert.match(committingAs(), /Author is incomplete/);
		type('authorName', '');
		assert.match(committingAs(), /Git has no name and email configured/);
	});
});
