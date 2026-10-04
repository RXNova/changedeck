// Prompts and response parsing for the Copilot helpers that organise changes. No VS Code here.
import { truncateDiff } from './commitPrompt';

export interface SplitProposal {
	name: string;
	description: string;
	files: string[];
}

/** Asks the model to group changed files into changelists and answer with JSON. */
export function buildSplitPrompt(diff: string, files: string[], existingLists: string[], maxDiffChars: number): string {
	return [
		'Group the changed files below into changelists. Each changelist should be one logical change that could be committed on its own (for example a refactoring, a bug fix, a feature, documentation, configuration).',
		'',
		'Rules:',
		'- Every file belongs to exactly one changelist. Use the file paths exactly as listed.',
		'- Prefer few, meaningful groups. If everything belongs together, return a single group.',
		'- Names are short (2 to 5 words), in the style of a task title.',
		'- The description is a one-sentence summary usable as a commit message subject.',
		existingLists.length ? `- Reuse one of these existing changelist names when it fits: ${existingLists.map(n => JSON.stringify(n)).join(', ')}.` : '',
		'- Answer with JSON only, in this shape: {"changelists":[{"name":"...","description":"...","files":["path", "..."]}]}',
		'',
		'Files:',
		...files.map(f => `- ${f}`),
		'',
		'Diff:',
		'```diff',
		truncateDiff(diff, maxDiffChars).trimEnd(),
		'```',
	].filter(l => l !== '').join('\n');
}

/**
 * Reads the model's answer. Unknown paths and duplicates are dropped; files the model forgot
 * are returned separately so the caller can leave them where they are.
 */
export function parseSplitResponse(text: string, knownFiles: string[]): { proposals: SplitProposal[]; unassigned: string[] } {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) { throw new Error('The model did not return a grouping.'); }
	let data: unknown;
	try { data = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('The model returned a grouping that could not be read.'); }
	const groups = (data as { changelists?: unknown }).changelists;
	if (!Array.isArray(groups)) { throw new Error('The model did not return a grouping.'); }

	const known = new Set(knownFiles);
	const taken = new Set<string>();
	const proposals: SplitProposal[] = [];
	for (const g of groups) {
		const name = typeof g?.name === 'string' ? g.name.trim().slice(0, 80) : '';
		const files = Array.isArray(g?.files) ? (g.files as unknown[]).filter((f): f is string => typeof f === 'string' && known.has(f) && !taken.has(f)) : [];
		if (!name || !files.length) { continue; }
		files.forEach(f => taken.add(f));
		const existing = proposals.find(p => p.name.toLowerCase() === name.toLowerCase());
		if (existing) { existing.files.push(...files); continue; }
		proposals.push({ name, description: typeof g.description === 'string' ? g.description.trim() : '', files });
	}
	return { proposals, unassigned: knownFiles.filter(f => !taken.has(f)) };
}

export function buildNamePrompt(diff: string, kind: 'changelist' | 'shelf', maxDiffChars: number): string {
	return [
		`Suggest a short name for a ${kind === 'shelf' ? 'set of shelved changes' : 'changelist'} containing the changes below.`,
		'Rules: 2 to 6 words, like a task title, no quotes, no trailing period. Output only the name.',
		'',
		'```diff',
		truncateDiff(diff, maxDiffChars).trimEnd(),
		'```',
	].join('\n');
}

export function cleanName(text: string): string {
	return text.trim().split('\n')[0].replace(/^["'`*\s]+|["'`*.\s]+$/g, '').slice(0, 80);
}

export function buildReviewPrompt(diff: string, maxDiffChars: number): string {
	return [
		'Review the changes below before they are committed. Be concise and concrete.',
		'',
		'Report, in Markdown:',
		'1. **Problems**: bugs, broken edge cases, security issues, leftover debug code. Quote the file and the line. If there are none, say so.',
		'2. **Suggestions**: at most five improvements worth making now.',
		'3. **Summary**: one or two sentences on what the change does.',
		'',
		'Do not restate the diff and do not praise.',
		'',
		'```diff',
		truncateDiff(diff, maxDiffChars).trimEnd(),
		'```',
	].join('\n');
}

/** Lines added in a diff that contain a TODO or FIXME marker, as "file: text". */
export function addedTodos(diff: string): string[] {
	const found: string[] = [];
	let file = '';
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
		if (line.startsWith('+') && !line.startsWith('+++') && /\b(TODO|FIXME)\b/.test(line)) { found.push(`${file}: ${line.slice(1).trim()}`); }
	}
	return found;
}
