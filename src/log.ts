import * as vscode from 'vscode';
import { Git } from './core/git';

let channel: vscode.LogOutputChannel | undefined;

/** The "Changedeck" output channel. Every git command and every error is written here. */
export function log(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Changedeck', { log: true });
		Git.logger = {
			command(root, args, exitCode, ms, stderr) {
				const line = `git ${args.map(quote).join(' ')}  (${ms} ms${exitCode ? `, exit ${exitCode}` : ''}) in ${root}`;
				if (exitCode) {
					channel!.warn(line);
					if (stderr.trim()) { channel!.warn(stderr.trim()); }
				} else {
					channel!.trace(line);
				}
			},
		};
	}
	return channel;
}

function quote(arg: string): string {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** Shows an error with a button that opens the log. */
export async function showError(message: string, error?: unknown): Promise<void> {
	log().error(message);
	if (error instanceof Error && error.stack) { log().debug(error.stack); }
	const choice = await vscode.window.showErrorMessage(message, 'Show Log');
	if (choice) { log().show(true); }
}

export function disposeLog(): void {
	Git.logger = undefined;
	channel?.dispose();
	channel = undefined;
}
