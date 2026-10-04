// Builds the prompt used to generate a commit message from the checked changes. No VS Code here.

export interface CommitPromptInput {
	/** Unified diff of exactly the changes that will be committed. */
	diff: string;
	/** Subjects of recent commits, newest first, to match the repository's style. */
	recentSubjects: string[];
	branch?: string;
	/** Name and description of the changelist being committed, if there is one. */
	listName?: string;
	listDescription?: string;
	/** Extra instructions from the user's settings. */
	instructions?: string;
	/** Upper bound for the diff part of the prompt, in characters. */
	maxDiffChars: number;
}

/**
 * Shortens a diff to fit `maxChars`, keeping every file's header and a fair share of its hunks so
 * that no file disappears entirely. Binary patches are replaced by a one-line note.
 */
export function truncateDiff(diff: string, maxChars: number): string {
	const files = diff.split(/(?=^diff --git )/m).filter(Boolean).map(part =>
		/^GIT binary patch$/m.test(part) ? part.split('\n')[0] + '\n(binary file changed)\n' : part);
	const total = files.reduce((n, f) => n + f.length, 0);
	if (total <= maxChars) { return files.join(''); }

	const share = Math.max(400, Math.floor(maxChars / Math.max(1, files.length)));
	let out = '';
	for (const file of files) {
		if (out.length >= maxChars) {
			out += `${file.split('\n')[0]}\n(more changes omitted)\n`;
			continue;
		}
		if (file.length <= share) { out += file; continue; }
		const cut = file.lastIndexOf('\n', share);
		out += file.slice(0, cut > 0 ? cut : share) + '\n(rest of this file\'s changes omitted)\n';
	}
	return out;
}

export function buildCommitPrompt(input: CommitPromptInput): string {
	const lines: string[] = [
		'Write a Git commit message for the changes below.',
		'',
		'Rules:',
		'- Describe what changed and why, based only on the diff.',
		'- First line: a summary in the imperative mood, at most 72 characters, no trailing period.',
		'- If the change needs more explanation, add a blank line and a short body wrapped at 72 characters. Use "-" bullets for separate points.',
		'- Match the style of the recent commits (for example a "type(scope):" prefix or ticket references) when they follow one.',
		'- Output only the commit message: no quotes, no code fences, no explanations.',
	];
	if (input.instructions?.trim()) {
		lines.push('', 'Additional instructions from the user:', input.instructions.trim());
	}
	if (input.recentSubjects.length) {
		lines.push('', 'Recent commits in this repository:', ...input.recentSubjects.slice(0, 15).map(s => `- ${s}`));
	}
	if (input.branch) { lines.push('', `Current branch: ${input.branch}`); }
	if (input.listName) {
		lines.push('', `The changes belong to the changelist "${input.listName}".`);
		if (input.listDescription?.trim()) { lines.push(`Changelist description: ${input.listDescription.trim()}`); }
	}
	lines.push('', 'Diff:', '```diff', truncateDiff(input.diff, input.maxDiffChars).trimEnd(), '```');
	return lines.join('\n');
}

/** Removes things models sometimes add despite the instructions (code fences, quotes). */
export function cleanCommitMessage(text: string): string {
	let t = text.trim();
	const fence = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
	if (fence) { t = fence[1].trim(); }
	if (/^".*"$/s.test(t) && !t.slice(1, -1).includes('"')) { t = t.slice(1, -1).trim(); }
	return t.replace(/[ \t]+$/gm, '');
}
