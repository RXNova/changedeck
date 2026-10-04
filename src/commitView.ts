import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ChangelistState } from './state';

export interface CommitRequest {
	message: string;
	amend: boolean;
	push: boolean;
	signoff?: boolean;
	noVerify?: boolean;
	author?: string;
	/** Committer to use when Git has no identity configured. */
	committer?: { name: string; email: string };
	/** After pushing, open the page for creating a pull request. */
	createPr?: boolean;
}

type FromWebview =
	| { type: 'ready' }
	| { type: 'message'; text: string }
	| { type: 'amend'; value: boolean }
	| { type: 'options'; signoff: boolean; noVerify: boolean; authorName: string; authorEmail: string; createPr: boolean }
	| { type: 'history' }
	| { type: 'commit'; message: string; push: boolean };

const HISTORY_KEY = 'changelists.commitMessages';
const SIGNOFF_KEY = 'changelists.signoff';
const CREATE_PR_KEY = 'changelists.createPr';
const MAX_HISTORY = 30;

/**
 * The commit message box. Its text is the comment of the changelist being committed
 * (the active one unless "Commit Changelist" picked another), so drafts survive restarts.
 */
export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private targetListId: string | undefined;
	private amend = false;
	private beforeAmend = '';
	private amendFilled: string | undefined;
	private busy = false;
	private postedTargetId: string | undefined;
	private noVerify = false;
	private generating = false;
	private identity = { name: '', email: '' };
	private authorName = '';
	private authorEmail = '';
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly memento: vscode.Memento,
		private readonly state: ChangelistState,
		private readonly lastCommitMessage: () => Promise<string>,
		/** The Git name and email of the repository being committed to. */
		private readonly gitIdentity: () => Promise<{ name: string; email: string }>,
		private readonly commit: (request: CommitRequest) => Promise<boolean>,
	) {
		this.disposables.push(
			vscode.window.registerWebviewViewProvider('changelists.commit', this, { webviewOptions: { retainContextWhenHidden: true } }),
			state.onDidChange(() => { this.post(); void this.refreshIdentity(); }),
		);
	}

	/** The changelist whose comment is the commit message. */
	get target() {
		const target = this.targetListId ? this.state.model.get(this.targetListId) : undefined;
		return target ?? this.state.model.active;
	}

	get message(): string { return this.target.comment; }

	/** A commit request with the options currently set in the panel. */
	request(message: string, push: boolean): CommitRequest {
		return { message, push, amend: this.amend, signoff: this.signoff, noVerify: this.noVerify, author: this.author, createPr: this.createPr,
			// With no Git identity configured, the typed author is also the committer.
			committer: !this.identity.name || !this.identity.email ? (this.author ? this.shownAuthor : undefined) : undefined,
		};
	}

	/** Points the message box at a changelist and reveals it. */
	async focus(listId?: string): Promise<void> {
		this.targetListId = listId;
		this.post(true);
		await vscode.commands.executeCommand('changelists.commit.focus');
		void this.view?.webview.postMessage({ type: 'focus' });
	}

	/** What the fields show: what the user typed, otherwise the Git identity. */
	private get shownAuthor(): { name: string; email: string } {
		return { name: this.authorName.trim() || this.identity.name, email: this.authorEmail.trim() || this.identity.email };
	}

	/** "Name <email>" for git when the fields differ from the Git identity; undefined to commit as oneself. */
	private get author(): string | undefined {
		const { name, email } = this.shownAuthor;
		if (!name || !email || (name === this.identity.name && email === this.identity.email)) { return undefined; }
		return `${name} <${email}>`;
	}

	/** Reads the Git identity again (it can differ per repository) and updates the fields. */
	async refreshIdentity(): Promise<void> {
		const identity = await this.gitIdentity().catch(() => ({ name: '', email: '' }));
		if (identity.name !== this.identity.name || identity.email !== this.identity.email) {
			this.identity = identity;
			this.post();
		}
	}

	private get signoff(): boolean { return this.memento.get(SIGNOFF_KEY, false); }
	private get createPr(): boolean { return this.memento.get(CREATE_PR_KEY, false); }

	history(): string[] { return this.memento.get<string[]>(HISTORY_KEY, []); }

	/** Lets the user pick an earlier commit message for the message box. */
	async pickFromHistory(): Promise<void> {
		const history = this.history();
		if (!history.length) {
			void vscode.window.showInformationMessage('No earlier commit messages yet.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			history.map(m => ({ label: m.split('\n')[0], detail: m.includes('\n') ? m.split('\n').slice(1).join(' ').trim() || undefined : undefined, message: m })),
			{ title: 'Commit Message History', placeHolder: 'Choose a message to reuse', matchOnDetail: true },
		);
		if (!picked) { return; }
		this.target.comment = picked.message;
		this.state.saveSoon();
		this.post(true);
		void this.view?.webview.postMessage({ type: 'focus' });
	}

	/** Called after a successful commit. */
	committed(message: string): void {
		const trimmed = message.trim();
		if (trimmed) {
			void this.memento.update(HISTORY_KEY, [trimmed, ...this.history().filter(m => m !== trimmed)].slice(0, MAX_HISTORY));
		}
		this.noVerify = false;
		this.authorName = '';
		this.authorEmail = '';
		void this.refreshIdentity();
		this.state.mutate(m => m.setComment(this.target.id, ''));
		this.targetListId = undefined;
		this.amend = false;
		this.beforeAmend = '';
		this.amendFilled = undefined;
		this.post(true);
	}

	/** Shows a (partial) generated message in the box; it becomes the changelist's draft. */
	showGenerated(text: string): void {
		this.target.comment = text;
		this.state.saveSoon();
		this.post(true);
	}

	/** While a message is being written, the box is read-only and the title icon becomes Stop. */
	setGenerating(generating: boolean): void {
		this.generating = generating;
		void vscode.commands.executeCommand('setContext', 'changelists.generatingMessage', generating);
		this.post();
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
		this.post();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		view.onDidChangeVisibility(() => { if (view.visible) { void this.refreshIdentity(); } }, undefined, this.disposables);
		void this.refreshIdentity();
		view.webview.onDidReceiveMessage((msg: FromWebview) => this.onMessage(msg), undefined, this.disposables);
		view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } }, undefined, this.disposables);
	}

	private async onMessage(msg: FromWebview): Promise<void> {
		switch (msg.type) {
			case 'ready':
				this.post(true);
				break;
			case 'message':
				this.target.comment = msg.text;
				this.state.saveSoon();
				break;
			case 'amend':
				this.amend = msg.value;
				if (msg.value) {
					this.beforeAmend = this.target.comment;
					this.amendFilled = undefined;
					if (!this.target.comment.trim()) {
						this.target.comment = this.amendFilled = await this.lastCommitMessage().catch(() => '');
					}
				} else if (this.amendFilled !== undefined && this.target.comment === this.amendFilled) {
					// Untouched pre-filled message: put the draft back.
					this.target.comment = this.beforeAmend;
				}
				this.state.saveSoon();
				this.post(true);
				break;
			case 'options':
				void this.memento.update(SIGNOFF_KEY, msg.signoff);
				void this.memento.update(CREATE_PR_KEY, msg.createPr);
				this.noVerify = msg.noVerify;
				this.authorName = msg.authorName;
				this.authorEmail = msg.authorEmail;
				break;
			case 'history':
				await this.pickFromHistory();
				break;
			case 'commit':
				this.target.comment = msg.message;
				this.state.saveSoon();
				await this.commit(this.request(msg.message, msg.push));
				break;
		}
	}

	/** Sends state to the webview. The message text is only replaced when `withMessage` is set. */
	private post(withMessage = false): void {
		if (!this.view) { return; }
		if (this.target.id !== this.postedTargetId) { withMessage = true; }
		this.postedTargetId = this.target.id;
		const included = this.state.included();
		const lists = new Set(included.map(c => this.state.ownerOf(c.path)));
		const listNames = [...lists].map(id => this.state.model.get(id)?.name ?? 'Unversioned Files');
		void this.view.webview.postMessage({
			type: 'state',
			message: withMessage ? this.target.comment : undefined,
			amend: this.amend,
			busy: this.busy,
			files: included.length,
			lists: listNames,
			target: this.target.name,
			hasRepos: this.state.repos.count > 0,
			signoff: this.signoff,
			createPr: this.createPr,
			noVerify: this.noVerify,
			authorName: this.authorName,
			authorEmail: this.authorEmail,
			gitName: this.identity.name,
			gitEmail: this.identity.email,
			hasHistory: this.history().length > 0,
			generating: this.generating,
		});
		this.view.description = this.target.name;
	}

	/** The panel's HTML. Not private so the script inside can be tested. */
	html(): string {
		const nonce = randomBytes(16).toString('base64');
		const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	body { padding: 8px 12px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
	textarea {
		width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical;
		color: var(--vscode-input-foreground); background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
		padding: 6px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
	}
	textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
	.row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
	.summary { color: var(--vscode-descriptionForeground); margin-top: 6px; overflow-wrap: anywhere; }
	#committingAs { margin-top: 2px; }
	#committingAs.warn { color: var(--vscode-editorWarning-foreground); }
	#committingAs b { color: var(--vscode-foreground); font-weight: 600; }
	label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
	.buttons { display: flex; gap: 6px; margin-top: 10px; }
	button {
		flex: 1; padding: 4px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; cursor: pointer;
		color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: inherit; font-size: inherit; line-height: 18px;
	}
	button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
	button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
	button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: 0.5; cursor: default; }
	button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
	.link { flex: none; background: none; border: none; color: var(--vscode-textLink-foreground); padding: 0; cursor: pointer; font: inherit; }
	.link:hover:not(:disabled) { background: none; text-decoration: underline; }
	.spacer { flex: 1; }
	details { margin-top: 8px; }
	summary { cursor: pointer; color: var(--vscode-descriptionForeground); user-select: none; }
	.options { display: grid; gap: 6px; margin-top: 6px; padding-left: 2px; }
	input[type=text] {
		width: 100%; box-sizing: border-box; padding: 3px 6px; border-radius: 4px;
		color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
		font-family: inherit; font-size: inherit;
	}
	input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
	.badge { color: var(--vscode-editorWarning-foreground); }
	fieldset.author { border: none; margin: 2px 0 0; padding: 0; display: grid; gap: 4px; min-width: 0; }
	fieldset.author legend { padding: 0; margin-bottom: 2px; color: var(--vscode-descriptionForeground); }
	input[type=text].invalid { border-color: var(--vscode-inputValidation-errorBorder); }
	.hint { color: var(--vscode-errorForeground); }
	.note { color: var(--vscode-descriptionForeground); }
	.note button { margin-left: 4px; }
</style>
</head>
<body>
	<textarea id="message" rows="4" aria-label="Commit message" placeholder="Commit message"></textarea>
	<div class="row">
		<label><input type="checkbox" id="amend"> Amend last commit</label>
		<span class="spacer"></span>
		<button class="link" id="history" title="Reuse an earlier commit message">History…</button>
	</div>
	<details id="optionsBox">
		<summary>Options<span id="optionsNote" class="badge"></span></summary>
		<div class="options">
			<label><input type="checkbox" id="signoff"> Sign-off (add Signed-off-by)</label>
			<label><input type="checkbox" id="noVerify"> Skip Git hooks for this commit</label>
			<label><input type="checkbox" id="createPr"> Open the pull request page after Commit and Push</label>
			<fieldset class="author">
				<legend>Author for this commit</legend>
				<input type="text" id="authorName" placeholder="Name" aria-label="Author name" autocomplete="off">
				<input type="text" id="authorEmail" placeholder="Email" aria-label="Author email" autocomplete="off" inputmode="email">
				<div class="note" id="authorNote"></div>
				<div class="hint" id="authorHint" role="alert" hidden></div>
			</fieldset>
		</div>
	</details>
	<div class="summary" id="summary" aria-live="polite"></div>
	<div class="summary" id="committingAs" aria-live="polite"></div>
	<div class="buttons">
		<button id="commit" title="Commit the checked files">Commit</button>
		<button id="push" class="secondary" title="Commit the checked files, then push">Commit and Push</button>
	</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const message = document.getElementById('message');
	const amend = document.getElementById('amend');
	const summary = document.getElementById('summary');
	const commitBtn = document.getElementById('commit');
	const pushBtn = document.getElementById('push');
	const historyBtn = document.getElementById('history');
	const signoff = document.getElementById('signoff');
	const noVerify = document.getElementById('noVerify');
	const authorName = document.getElementById('authorName');
	const authorEmail = document.getElementById('authorEmail');
	const authorHint = document.getElementById('authorHint');
	const authorNote = document.getElementById('authorNote');
	const committingAs = document.getElementById('committingAs');
	let gitName = '';
	let gitEmail = '';
	/** True when the fields name someone other than the Git identity. */
	function authorDiffers() {
		return authorName.value.trim() !== gitName || authorEmail.value.trim() !== gitEmail;
	}
	function resetAuthor() {
		authorName.value = gitName;
		authorEmail.value = gitEmail;
		sendOptions();
	}
	/** Empty when the author fields are both empty or both valid; otherwise what is missing. */
	function authorProblem() {
		const name = authorName.value.trim();
		const email = authorEmail.value.trim();
		if (!name && !email) { return ''; }
		if (!name) { return "Enter the author's name too."; }
		if (!email) { return "Enter the author's email too."; }
		if (/[<>]/.test(name)) { return 'The name cannot contain < or >.'; }
		if (!/^[^ @<>]+@[^ @<>]+[.][^ @<>]+$/.test(email)) { return 'Enter a valid email address.'; }
		return '';
	}
	const createPr = document.getElementById('createPr');
	createPr.addEventListener('change', () => sendOptions());
	const optionsNote = document.getElementById('optionsNote');
	function sendOptions() {
		vscode.postMessage({ type: 'options', signoff: signoff.checked, noVerify: noVerify.checked, authorName: authorName.value, authorEmail: authorEmail.value, createPr: createPr.checked });
		updateNote();
		update();
	}
	function updateNote() {
		const problem = authorProblem();
		const hasAuthor = authorName.value.trim() && authorEmail.value.trim() && !problem && authorDiffers();
		authorNote.textContent = '';
		if (!gitName && !gitEmail) {
			authorNote.textContent = 'Git has no name and email configured. Enter them here to commit.';
		} else if (authorDiffers()) {
			authorNote.textContent = 'Different from your Git identity (' + gitName + '). Applies to this commit only.';
			const reset = document.createElement('button');
			reset.className = 'link';
			reset.textContent = 'Reset';
			reset.addEventListener('click', resetAuthor);
			authorNote.append(reset);
		} else {
			authorNote.textContent = 'Your Git identity. Edit to commit as someone else.';
		}
		const active = [signoff.checked && 'sign-off', noVerify.checked && 'no hooks', hasAuthor && 'author', createPr.checked && 'pull request'].filter(Boolean);
		optionsNote.textContent = (active.length ? ' · ' + active.join(', ') : '') + (problem ? ' · author incomplete' : '');
		authorHint.hidden = !problem;
		authorHint.textContent = problem;
		authorName.classList.toggle('invalid', !!problem && (!authorName.value.trim() || /[<>]/.test(authorName.value)));
		authorEmail.classList.toggle('invalid', !!problem && !authorName.classList.contains('invalid'));

		// Above the buttons: who this commit will be made as.
		const name = authorName.value.trim();
		const email = authorEmail.value.trim();
		committingAs.textContent = '';
		committingAs.classList.toggle('warn', !!problem || !name || !email);
		if (name && email && !problem) {
			const who = document.createElement('b');
			who.textContent = name + ' <' + email + '>';
			committingAs.append('Committing as ', who);
		} else if (problem) {
			committingAs.textContent = 'Author is incomplete. Open Options to fix it.';
		} else {
			committingAs.textContent = 'Git has no name and email configured. Set them under Options.';
		}
	}
	signoff.addEventListener('change', sendOptions);
	noVerify.addEventListener('change', sendOptions);
	authorName.addEventListener('input', sendOptions);
	authorEmail.addEventListener('input', sendOptions);
	historyBtn.addEventListener('click', () => vscode.postMessage({ type: 'history' }));
	const isMac = navigator.platform.toUpperCase().includes('MAC');
	message.placeholder = 'Commit message (' + (isMac ? '⌘' : 'Ctrl') + '+Enter to commit)';
	let state = { files: 0, amend: false, busy: false, hasRepos: true };

	function update() {
		const canCommit = state.hasRepos && !state.busy && (state.files > 0 || state.amend) && message.value.trim().length > 0 && !authorProblem();
		commitBtn.disabled = !canCommit;
		pushBtn.disabled = !canCommit;
		commitBtn.textContent = state.busy ? 'Committing…' : (state.amend ? 'Amend Commit' : 'Commit');
		pushBtn.textContent = state.amend ? 'Amend and Push' : 'Commit and Push';
		const files = state.files === 1 ? '1 file' : state.files + ' files';
		summary.textContent = state.files
			? files + ' selected' + (state.lists && state.lists.length ? ' from ' + state.lists.join(', ') : '')
			: (state.amend ? 'Only the message will change' : 'No files selected. Check files in Changes.');
	}

	let timer;
	message.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(() => vscode.postMessage({ type: 'message', text: message.value }), 150);
		update();
	});
	amend.addEventListener('change', () => vscode.postMessage({ type: 'amend', value: amend.checked }));
	function commit(push) {
		if (commitBtn.disabled) { return; }
		clearTimeout(timer);
		vscode.postMessage({ type: 'commit', message: message.value, push });
	}
	commitBtn.addEventListener('click', () => commit(false));
	pushBtn.addEventListener('click', () => commit(true));
	message.addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(e.shiftKey); }
	});

	window.addEventListener('message', e => {
		const msg = e.data;
		if (msg.type === 'state') {
			state = msg;
			if (typeof msg.message === 'string' && msg.message !== message.value) { message.value = msg.message; }
			amend.checked = msg.amend;
			signoff.checked = msg.signoff;
			noVerify.checked = msg.noVerify;
			createPr.checked = !!msg.createPr;
			gitName = msg.gitName || '';
			gitEmail = msg.gitEmail || '';
			if (document.activeElement !== authorName) { authorName.value = msg.authorName || gitName; }
			if (document.activeElement !== authorEmail) { authorEmail.value = msg.authorEmail || gitEmail; }
			historyBtn.disabled = !msg.hasHistory;
			message.readOnly = !!msg.generating;
			updateNote();
			update();
		} else if (msg.type === 'focus') {
			message.focus();
		}
	});
	update();
	vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
