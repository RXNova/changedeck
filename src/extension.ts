import * as vscode from 'vscode';
import { ChangesView } from './changesView';
import { ChangelistCodeLens } from './codeLens';
import { EditorDecorations } from './editorDecorations';
import { announceVersion, ChangelistFileDecorations, Extras } from './extras';
import { disposeLog, log } from './log';
import { Commands, PART_SCHEME } from './commands';
import { CommitView } from './commitView';
import { gitIdentity } from './core/git';
import { API, GitExtension } from './gitApi';
import { eligible, PartialTracker } from './partialTracker';
import { Repositories } from './repositories';
import { ShelfView } from './shelfView';
import { ChangelistState } from './state';

/** Returned from activate() so integration tests can drive the extension. */
export interface ChangelistsApi {
	state: ChangelistState;
	commands: Commands;
	shelf: ShelfView;
	tracker: PartialTracker;
	repos: Repositories;
	changes: ChangesView;
	extras: Extras;
	commitView: CommitView;
}

export async function activate(context: vscode.ExtensionContext): Promise<ChangelistsApi | undefined> {
	const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!extension) {
		void vscode.window.showErrorMessage('Changedeck needs the built-in Git extension, which is not installed.');
		return undefined;
	}
	const gitExtension = extension.isActive ? extension.exports : await extension.activate();

	if (gitExtension.enabled) {
		return setup(context, gitExtension.getAPI(1));
	}
	let started = false;
	context.subscriptions.push(gitExtension.onDidChangeEnablement(enabled => {
		if (enabled && !started) { started = true; setup(context, gitExtension.getAPI(1)); }
	}));
	void vscode.window.showWarningMessage('Changedeck is waiting for Git: the setting "git.enabled" is turned off.');
	return undefined;
}

function setup(context: vscode.ExtensionContext, api: API): ChangelistsApi {
	log().info(`Changedeck ${context.extension.packageJSON.version} started (Git ${api.git.path})`);
	const repos = new Repositories(api);
	const state = new ChangelistState(context, repos);
	const changes = new ChangesView(state);
	const shelf = new ShelfView(context, repos);
	const tracker = new PartialTracker(state, repos);
	const commands = new Commands(state, api, changes, shelf, tracker);
	const extras = new Extras(state, changes, shelf, commands);
	const fileDecorations = new ChangelistFileDecorations(state);
	announceVersion(context);
	const codeLens = new ChangelistCodeLens(state, tracker);
	const decorations = new EditorDecorations(state, tracker);
	const partProvider = vscode.workspace.registerTextDocumentContentProvider(PART_SCHEME, { provideTextDocumentContent: uri => commands.partContent(uri) });
	const identities = new Map<string, { identity: { name: string; email: string }; at: number }>();
	const commitView = new CommitView(
		context.workspaceState,
		state,
		async () => {
			const included = state.included();
			const root = included[0]?.repoRoot ?? repos.all[0]?.rootUri.fsPath;
			return root ? repos.git(root).lastCommitMessage() : '';
		},
		async () => {
			// Read from Git at most every 30 seconds per repository; the panel asks on every refresh.
			const root = state.included()[0]?.repoRoot ?? repos.all[0]?.rootUri.fsPath;
			if (!root) { return { name: '', email: '' }; }
			const cached = identities.get(root);
			if (cached && Date.now() - cached.at < 30_000) { return cached.identity; }
			const identity = await gitIdentity(repos.git(root));
			identities.set(root, { identity, at: Date.now() });
			return identity;
		},
		request => commands.commit(request),
	);
	commands.commitView = commitView;

	const statusBar = vscode.window.createStatusBarItem('changelists.active', vscode.StatusBarAlignment.Left, 50);
	statusBar.name = 'Active Changelist';
	statusBar.command = 'changelists.switchActive';
	const updateStatusBar = () => {
		const show = repos.count > 0 && vscode.workspace.getConfiguration('changelists').get('showStatusBar', true);
		if (!show) { statusBar.hide(); return; }
		const active = state.model.active;
		const count = state.filesOf(active.id).length;
		statusBar.text = `$(checklist) ${active.name}${count ? ` (${count})` : ''}`;
		statusBar.tooltip = `Active changelist: ${active.name}. New changes go here. Click to switch.`;
		statusBar.show();
	};

	// Shelves live in each repository, so reload them when repositories come and go.
	let knownRepos = '';
	const updateEditorContext = () => {
		const doc = vscode.window.activeTextEditor?.document;
		const change = doc?.uri.scheme === 'file' ? state.change(doc.uri.fsPath) : undefined;
		void vscode.commands.executeCommand('setContext', 'changelists.editorHasChanges', !!change);
		void vscode.commands.executeCommand('setContext', 'changelists.editorCanSplit', !!change && eligible(change));
	};

	const onChange = () => {
		updateStatusBar();
		updateEditorContext();
		void vscode.commands.executeCommand('setContext', 'changelists.hasRepositories', repos.count > 0);
		const current = repos.all.map(r => r.rootUri.fsPath).sort().join('\0');
		if (current !== knownRepos) { knownRepos = current; void shelf.reload(); }
	};
	onChange();

	context.subscriptions.push(
		repos, state, changes, shelf, tracker, commands, extras, fileDecorations, codeLens, decorations, partProvider, commitView, statusBar,
		{ dispose: disposeLog },
		state.onDidChange(onChange),
		vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
	);
	return { state, commands, shelf, repos, tracker, changes, extras, commitView };
}

export function deactivate(): void { /* everything is disposed through context.subscriptions */ }
