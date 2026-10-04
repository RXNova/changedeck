// Cross-platform end-to-end test: creates a throwaway repository and runs src/integration in a
// downloaded copy of VS Code (or the one in $VSCODE_EXECUTABLE). Used by CI on Linux, macOS and Windows.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
	const root = path.resolve(__dirname, '..');
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'changelists-e2e-')));
	const repo = path.join(tmp, 'repo');
	fs.mkdirSync(path.join(repo, '.vscode'), { recursive: true });
	const git = (...args) => execFileSync('git', args, { cwd: repo });
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	git('config', 'commit.gpgsign', 'false');
	git('config', 'core.autocrlf', 'false');
	fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.vscode/\n');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
	fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
	git('add', '.');
	git('commit', '-qm', 'init');
	fs.writeFileSync(path.join(repo, '.vscode', 'settings.json'), '{}');

	const userDir = path.join(tmp, 'user');
	fs.mkdirSync(path.join(userDir, 'User'), { recursive: true });
	fs.writeFileSync(path.join(userDir, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'git.openRepositoryInParentFolders': 'always' }));

	try {
		await runTests({
			vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
			extensionDevelopmentPath: root,
			extensionTestsPath: path.join(root, 'out', 'integration', 'index'),
			launchArgs: [repo, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${userDir}`, `--extensions-dir=${path.join(tmp, 'ext')}`],
		});
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
	}
}

main().catch(e => { console.error(e); process.exit(1); });
