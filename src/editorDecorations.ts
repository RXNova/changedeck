import * as vscode from 'vscode';
import { eligible, PartialTracker } from './partialTracker';
import { ChangelistState } from './state';

/** Number of changelist colors contributed in package.json (changelists.list1 ... listN). */
export const LIST_COLORS = 8;

/** The theme color of a changelist, by its position in the list of changelists. */
export function listColor(state: ChangelistState, listId: string): vscode.ThemeColor {
	return new vscode.ThemeColor(`changelists.list${colorSlot(state, listId) + 1}`);
}

/** Zero-based color slot of a list: the color the user chose, otherwise its position. */
export function colorSlot(state: ChangelistState, listId: string): number {
	const lists = state.model.all();
	const list = lists.find(l => l.id === listId);
	if (list?.color && list.color >= 1 && list.color <= LIST_COLORS) { return list.color - 1; }
	return Math.max(0, lists.findIndex(l => l.id === listId)) % LIST_COLORS;
}

export const COLOR_NAMES = ['Blue', 'Orange', 'Purple', 'Green', 'Pink', 'Teal', 'Yellow', 'Rust'];

/**
 * Marks each change in the editor with a stripe in its changelist's color, and offers
 * "Move change to …" actions in the light bulb.
 */
export class EditorDecorations implements vscode.CodeActionProvider, vscode.Disposable {
	static readonly kind = vscode.CodeActionKind.Refactor.append('changelist');
	private readonly types: vscode.TextEditorDecorationType[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly state: ChangelistState, private readonly tracker: PartialTracker) {
		for (let i = 1; i <= LIST_COLORS; i++) {
			const color = new vscode.ThemeColor(`changelists.list${i}`);
			this.types.push(vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				borderStyle: 'solid',
				borderWidth: '0 0 0 2px',
				borderColor: color,
				overviewRulerColor: color,
				overviewRulerLane: vscode.OverviewRulerLane.Left,
			}));
		}
		this.disposables.push(
			...this.types,
			vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, this, { providedCodeActionKinds: [EditorDecorations.kind] }),
			tracker.onDidChange(() => this.schedule()),
			state.onDidChange(() => this.schedule()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
			vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('changelists')) { this.schedule(); } }),
		);
		this.schedule();
	}

	private schedule(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => { this.timer = undefined; this.render(); }, 50);
	}

	private render(): void {
		const mode = vscode.workspace.getConfiguration('changelists').get<string>('editorMarkers', 'partial');
		for (const editor of vscode.window.visibleTextEditors) {
			const byColor: vscode.Range[][] = this.types.map(() => []);
			const file = editor.document.uri.fsPath;
			const entry = editor.document.uri.scheme === 'file' ? this.tracker.hunks(file) : undefined;
			const show = entry && mode !== 'never' && (mode === 'always' ? !!this.state.change(file) : this.state.model.isPartial(file));
			if (show) {
				const lastLine = Math.max(0, editor.document.lineCount - 1);
				entry.hunks.forEach((h, i) => {
					const index = colorSlot(this.state, entry.lists[i]);
					const first = Math.min(h.newStart, lastLine);
					const last = Math.min(Math.max(h.newEnd - 1, h.newStart), lastLine);
					byColor[index].push(new vscode.Range(first, 0, last, 0));
				});
			}
			this.types.forEach((type, i) => editor.setDecorations(type, byColor[i]));
		}
	}

	provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
		const file = doc.uri.fsPath;
		const change = this.state.change(file);
		if (!change || !eligible(change)) { return []; }
		const entry = this.tracker.hunks(file);
		if (!entry) { return []; }
		const indices = entry.hunks.flatMap((h, i) => {
			const first = h.newStart === h.newEnd ? Math.max(0, h.newStart - 1) : h.newStart;
			const last = h.newStart === h.newEnd ? h.newStart : h.newEnd - 1;
			return range.start.line <= last && range.end.line >= first ? [i] : [];
		});
		if (!indices.length) { return []; }
		const current = new Set(indices.map(i => entry.lists[i]));
		const what = indices.length === 1 ? 'change' : `${indices.length} changes`;
		const actions = this.state.model.all()
			.filter(l => !(current.size === 1 && current.has(l.id)))
			.slice(0, 6)
			.map(l => {
				const action = new vscode.CodeAction(`Move ${what} to changelist "${l.name}"`, EditorDecorations.kind);
				action.command = { command: 'changelists.moveHunksTo', title: action.title, arguments: [doc.uri, indices, l.id] };
				return action;
			});
		const anyIncluded = indices.some(i => !entry.excluded[i]);
		const toggle = new vscode.CodeAction(anyIncluded ? `Leave ${what} out of the next commit` : `Include ${what} in the next commit`, EditorDecorations.kind);
		toggle.command = { command: anyIncluded ? 'changelists.excludeChange' : 'changelists.includeChange', title: toggle.title, arguments: [doc.uri, indices] };
		actions.push(toggle);
		const other = new vscode.CodeAction(`Move ${what} to another changelist…`, EditorDecorations.kind);
		other.command = { command: 'changelists.moveChange', title: other.title, arguments: [doc.uri, indices] };
		actions.push(other);
		return actions;
	}

	dispose(): void {
		if (this.timer) { clearTimeout(this.timer); }
		this.disposables.forEach(d => d.dispose());
	}
}
