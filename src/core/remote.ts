// Turns a Git remote URL into the web page for opening a pull (or merge) request.

export interface RemoteInfo {
	host: string;
	owner: string;
	repo: string;
}

export function parseRemote(url: string): RemoteInfo | undefined {
	const u = url.trim();
	// git@host:owner/repo.git, ssh://git@host[:port]/owner/repo.git, https://[user@]host/owner/repo[.git]
	const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(u);
	const std = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u);
	const m = scp ?? std;
	if (!m) { return undefined; }
	const parts = m[2].split('/').filter(Boolean);
	if (parts.length < 2) { return undefined; }
	return { host: m[1], owner: parts.slice(0, -1).join('/'), repo: parts[parts.length - 1] };
}

/** URL of the "new pull request" page for a branch, or undefined for hosts we do not know. */
export function pullRequestUrl(remoteUrl: string, branch: string): string | undefined {
	const r = parseRemote(remoteUrl);
	if (!r) { return undefined; }
	const base = `https://${r.host}/${r.owner}/${r.repo}`;
	const b = encodeURIComponent(branch);
	if (r.host === 'github.com' || r.host.includes('github')) { return `${base}/compare/${b}?expand=1`; }
	if (r.host.includes('gitlab')) { return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}`; }
	if (r.host.includes('bitbucket')) { return `${base}/pull-requests/new?source=${b}`; }
	return undefined;
}
