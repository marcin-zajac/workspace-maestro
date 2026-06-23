import * as vscode from 'vscode';
import { parseFolders, applyStates, FolderBlock, ParseResult } from './core';
import {
	FolderChanges,
	StoredState,
	reconcileWithState,
	stateFromParse,
	stateKey,
} from './state';

let statusBarItem: vscode.StatusBarItem;
let extensionContext: vscode.ExtensionContext;
let isRestoring = false;
let isExtensionWriting = false;
let suppressWorkspaceSync = false;
let pendingFolderChanges: FolderChanges | undefined;

/** Set up the status-bar item, command, and the listeners that keep them current. */
export function activate(context: vscode.ExtensionContext) {
	try {
		extensionContext = context;

		const alignment =
			vscode.workspace
				.getConfiguration('workspaceMaestro')
				.get<string>('statusBarAlignment') === 'left'
				? vscode.StatusBarAlignment.Left
				: vscode.StatusBarAlignment.Right;

		statusBarItem = vscode.window.createStatusBarItem(alignment, 100);
		statusBarItem.command = 'workspaceMaestro.show';
		context.subscriptions.push(statusBarItem);

		context.subscriptions.push(
			vscode.commands.registerCommand('workspaceMaestro.show', showPicker)
		);

		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders((event) => {
				if (isExtensionWriting || isRestoring || suppressWorkspaceSync) {
					return;
				}
				pendingFolderChanges = {
					added: event.added.map(folderPath),
					removed: event.removed.map(folderPath),
				};
				void scheduleRestore();
			})
		);
		context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument((d) => {
				if (suppressWorkspaceSync || isExtensionWriting || isRestoring) {
					return;
				}
				if (isWorkspaceFile(d.uri)) {
					void scheduleRestore();
				}
			})
		);

		void refreshStatusBar();
		void scheduleRestore();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void vscode.window.showErrorMessage(
			`Workspace Maestro failed to activate: ${message}`
		);
		throw error;
	}
}

export function deactivate() {
	statusBarItem?.dispose();
}

/** Whether `uri` points at the active workspace's `.code-workspace` file. */
function isWorkspaceFile(uri: vscode.Uri | undefined): boolean {
	const wsFile = vscode.workspace.workspaceFile;
	return !!uri && !!wsFile && uri.toString() === wsFile.toString();
}

/** Workspace-relative path used in the `.code-workspace` file. */
function folderPath(folder: vscode.WorkspaceFolder): string {
	return vscode.workspace.asRelativePath(folder.uri, false);
}

function fullDocumentRange(doc: vscode.TextDocument): vscode.Range {
	const lastLine = Math.max(0, doc.lineCount - 1);
	return new vscode.Range(
		new vscode.Position(0, 0),
		doc.lineAt(lastLine).range.end
	);
}

function loadStoredState(): StoredState | undefined {
	return extensionContext.workspaceState.get<StoredState>(stateKey());
}

function saveStoredState(state: StoredState): void {
	void extensionContext.workspaceState.update(stateKey(), state);
}

/**
 * VS Code saves the workspace file asynchronously after folder changes. Wait a
 * tick so restore reads the updated file contents.
 */
async function scheduleRestore(): Promise<void> {
	try {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await restoreIfNeeded();
		await refreshStatusBar();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('Workspace Maestro restore failed:', error);
		void vscode.window.showErrorMessage(
			`Workspace Maestro restore failed: ${message}`
		);
	}
}

/**
 * When VS Code adds/removes folders it rewrites the workspace file and strips
 * `//` comments. Re-insert disabled folders from persisted state.
 */
async function restoreIfNeeded(): Promise<void> {
	if (isRestoring) {
		return;
	}

	const wsFile = vscode.workspace.workspaceFile;
	if (!wsFile || wsFile.scheme === 'untitled') {
		return;
	}

	let doc: vscode.TextDocument;
	try {
		doc = await vscode.workspace.openTextDocument(wsFile);
	} catch {
		return;
	}

	const parsed = parseFolders(doc.getText());
	if (!parsed) {
		return;
	}

	let state = loadStoredState();
	if (!state) {
		state = stateFromParse(parsed);
		saveStoredState(state);
		pendingFolderChanges = undefined;
		return;
	}

	const changes = pendingFolderChanges;
	pendingFolderChanges = undefined;

	const result = reconcileWithState(doc.getText(), state, changes);
	if (!result) {
		return;
	}

	saveStoredState(result.state);

	if (!result.text || result.text === doc.getText()) {
		return;
	}

	isRestoring = true;
	suppressWorkspaceSync = true;
	try {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, fullDocumentRange(doc), result.text);
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			return;
		}
		await doc.save();
	} finally {
		isRestoring = false;
		setTimeout(() => {
			suppressWorkspaceSync = false;
		}, 0);
	}
}

/**
 * Open and parse the active `.code-workspace` file, or return `undefined` when
 * there is no saved workspace file or it has no `folders` array.
 */
async function readWorkspace(): Promise<
	{ doc: vscode.TextDocument; parsed: ParseResult } | undefined
> {
	const wsFile = vscode.workspace.workspaceFile;
	if (!wsFile || wsFile.scheme === 'untitled') {
		return undefined;
	}
	let doc: vscode.TextDocument;
	try {
		doc = await vscode.workspace.openTextDocument(wsFile);
	} catch {
		return undefined;
	}
	const parsed = parseFolders(doc.getText());
	if (!parsed) {
		return undefined;
	}
	return { doc, parsed };
}

/** Refresh the `enabled/total` badge, hiding the item when there is nothing to show. */
async function refreshStatusBar() {
	if (!statusBarItem) {
		return;
	}
	const result = await readWorkspace();
	if (!result) {
		statusBarItem.hide();
		return;
	}
	const folders = result.parsed.blocks.filter(
		(b): b is FolderBlock => b.kind === 'folder'
	);
	const enabled = folders.filter((f) => f.enabledOriginal).length;
	statusBarItem.text = `$(folder-library) ${enabled}/${folders.length}`;
	statusBarItem.tooltip = 'Enable / disable workspace folders';
	statusBarItem.show();
}

/** Show the folder checklist and write the user's selection back to the file. */
async function showPicker() {
	const wsFile = vscode.workspace.workspaceFile;
	if (!wsFile) {
		vscode.window.showInformationMessage(
			'Open a multi-root workspace (.code-workspace file) to manage its folders.'
		);
		return;
	}
	if (wsFile.scheme === 'untitled') {
		vscode.window.showInformationMessage(
			'Save the workspace to a .code-workspace file first, then try again.'
		);
		return;
	}

	const result = await readWorkspace();
	if (!result) {
		vscode.window.showWarningMessage(
			'Could not find a "folders" array in the workspace file.'
		);
		return;
	}
	const { doc, parsed } = result;

	const folders = parsed.blocks.filter(
		(b): b is FolderBlock => b.kind === 'folder'
	);
	if (folders.length === 0) {
		vscode.window.showInformationMessage('No folders found in the workspace file.');
		return;
	}

	interface Item extends vscode.QuickPickItem {
		block: FolderBlock;
	}

	const items: Item[] = folders.map((f) => ({
		label: f.name ?? f.path,
		description: f.name && f.name !== f.path ? f.path : undefined,
		picked: f.enabledOriginal,
		block: f,
	}));

	const qp = vscode.window.createQuickPick<Item>();
	qp.title = 'Workspace Folders';
	qp.placeholder =
		'Checked = active · unchecked = commented out. Press Enter to apply.';
	qp.canSelectMany = true;
	qp.items = items;
	qp.selectedItems = items.filter((i) => i.picked);

	qp.onDidAccept(async () => {
		const selected = new Set(qp.selectedItems);
		for (const item of qp.items) {
			item.block.enabled = selected.has(item);
		}
		qp.hide();
		await writeWorkspace(doc, parsed);
		await refreshStatusBar();
	});
	qp.onDidHide(() => qp.dispose());
	qp.show();
}

/** Apply the parsed state to the document, saving only when the text changes. */
async function writeWorkspace(doc: vscode.TextDocument, parsed: ParseResult) {
	const newText = applyStates(parsed);
	if (newText === doc.getText()) {
		saveStoredState(stateFromParse(parsed));
		return;
	}
	isExtensionWriting = true;
	suppressWorkspaceSync = true;
	try {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, fullDocumentRange(doc), newText);
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			vscode.window.showErrorMessage('Failed to update the workspace file.');
			return;
		}
		await doc.save();
		saveStoredState(stateFromParse(parsed));
	} finally {
		isExtensionWriting = false;
		setTimeout(() => {
			suppressWorkspaceSync = false;
		}, 0);
	}
}
