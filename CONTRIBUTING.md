# Contributing to Changedeck

## Building and running

```sh
npm install
npm run compile     # type-checks and bundles the extension into dist/
```

Press F5 in VS Code to start an Extension Development Host with the extension loaded.

## Tests

```sh
npm test                    # unit tests, plus Git tests against temporary repositories
npm run test:e2e            # end-to-end test in a downloaded VS Code (set VSCODE_EXECUTABLE to use your own)
./scripts/integration.sh    # macOS: the same end-to-end test in your installed VS Code
npm run test:dnd            # macOS: real drag and drop in an isolated VS Code window
```

CI runs the unit, Git and end-to-end tests on Linux, macOS and Windows for every push.

## Layout

| Path | What is there |
|---|---|
| `src/core/` | Logic with no VS Code dependency: the changelist model, the line diff, Git operations |
| `src/` | The VS Code side: views, commands, change tracking, the Commit panel |
| `src/test/` | Unit and Git tests |
| `src/integration/` | End-to-end tests and the scripts that drive a real VS Code window |
| `docs/` | The user guide and its images |

## Packaging

```sh
npm run package     # builds changedeck-<version>.vsix
```

## Screenshots

The images in the user guide come from a mock project (macOS):

```sh
FULL_DIR=/tmp/changedeck-full ./scripts/screenshots.sh
./scripts/crop-guide.sh /tmp/changedeck-full
```

Only the test window is captured.
