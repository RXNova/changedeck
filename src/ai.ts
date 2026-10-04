import * as vscode from 'vscode';
import { log } from './log';

/** Thrown when no Copilot model is available; callers show a friendly hint instead of an error. */
export class NoModelError extends Error {
	constructor() { super('No GitHub Copilot model is available. Sign in to GitHub Copilot in VS Code, then try again.'); }
}

/** The Copilot model to use: the configured family if available, otherwise Copilot's default. */
export async function pickModel(): Promise<vscode.LanguageModelChat> {
	const family = vscode.workspace.getConfiguration('changelists.commitMessage').get<string>('modelFamily', '').trim();
	let models = await vscode.lm.selectChatModels({ vendor: 'copilot', ...(family ? { family } : {}) });
	if (!models.length && family) {
		log().warn(`No Copilot model of family "${family}"; using the default model`);
		models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	}
	if (!models.length) { throw new NoModelError(); }
	return models[0];
}

/** How much diff fits into a request to this model, in characters. */
export function diffBudget(model: vscode.LanguageModelChat): number {
	return Math.min(120_000, Math.max(8_000, model.maxInputTokens * 3 - 4_000));
}

/**
 * Sends one prompt and returns the full answer. `onText` receives the text so far while it
 * streams. Errors from Copilot are turned into messages a user can act on.
 */
export async function ask(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken, onText?: (text: string) => void): Promise<string> {
	try {
		const response = await model.sendRequest(
			[vscode.LanguageModelChatMessage.User(prompt)],
			{ justification: 'Changedeck sends your changes to GitHub Copilot to write about or organise them.' },
			token,
		);
		let text = '';
		for await (const fragment of response.text) {
			text += fragment;
			onText?.(text);
		}
		return text;
	} catch (e) {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (e instanceof vscode.LanguageModelError) {
			throw new Error(e.code === vscode.LanguageModelError.NoPermissions.name
				? 'Changedeck is not allowed to use GitHub Copilot. Allow it when VS Code asks, or in the Accounts menu under "Manage Language Model Access".'
				: e.code === vscode.LanguageModelError.Blocked.name
					? 'GitHub Copilot declined the request (rate limit or content filter). Try again in a moment.'
					: `GitHub Copilot could not answer: ${e.message}`);
		}
		throw e;
	}
}

/** Shows the "sign in to Copilot" hint for NoModelError; returns false for any other error. */
export function handledNoModel(e: unknown): boolean {
	if (!(e instanceof NoModelError)) { return false; }
	void vscode.window.showInformationMessage(e.message, 'Open Chat')
		.then(choice => { if (choice) { void vscode.commands.executeCommand('workbench.action.chat.open'); } });
	return true;
}
