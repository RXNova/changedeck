import * as vscode from 'vscode';
import { PartialTracker } from './partialTracker';
import { ChangelistState } from './state';

/**
 * Shows the changelist above each change of a file whose changes are split across changelists,
 * with a click to move that change elsewhere.
 */
export class ChangelistCodeLens implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this.emitter.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly state: ChangelistState, private readonly tracker: PartialTracker) {
		this.disposables.push(
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
			tracker.onDidChange(() => this.emitter.fire()),
			state.onDidChange(() => this.emitter.fire()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('changelists')) { this.emitter.fire(); } }),
		);
	}

	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const mode = vscode.workspace.getConfiguration('changelists').get<string>('codeLens', 'partial');
		if (mode === 'never') { return []; }
		const file = doc.uri.fsPath;
		const hasExclusions = !!this.state.model.excludedOf(file);
		if (mode === 'partial' && !this.state.model.isPartial(file) && !hasExclusions) { return []; }
		const entry = this.tracker.hunks(file);
		if (!entry) { return []; }
		const activeId = this.state.model.active.id;
		return entry.hunks.flatMap((h, i) => {
			const line = Math.min(h.newStart, Math.max(0, doc.lineCount - 1));
			const range = new vscode.Range(line, 0, line, 0);
			const listId = entry.lists[i];
			const name = this.state.model.get(listId)?.name ?? 'Unknown';
			const excluded = entry.excluded[i];
			return [
				new vscode.CodeLens(range, {
					title: `$(${listId === activeId ? 'circle-filled' : 'circle-outline'}) ${name}`,
					tooltip: 'Changelist of this change. Click to move it to another changelist.',
					command: 'changelists.moveChange',
					arguments: [doc.uri, i],
				}),
				new vscode.CodeLens(range, {
					title: excluded ? '$(circle-slash) Not in commit' : '$(check) In commit',
					tooltip: excluded ? 'This change is left out of the next commit. Click to include it.' : 'This change is part of the next commit when its file is checked. Click to leave it out.',
					command: excluded ? 'changelists.includeChange' : 'changelists.excludeChange',
					arguments: [doc.uri, i],
				}),
			];
		});
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.emitter.dispose();
	}
}
