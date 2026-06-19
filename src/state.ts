import {
  FolderBlock,
  ParseResult,
  applyStates,
  parseFolders,
} from "./core";

export interface StoredFolder {
  path: string;
  name?: string;
  lines?: string[];
}

export interface StoredState {
  order: string[];
  disabled: StoredFolder[];
}

const STATE_KEY = "workspaceMaestro.folderState";

export function stateKey(): string {
  return STATE_KEY;
}

/** Build persisted state from a parsed workspace file. */
export function stateFromParse(parsed: ParseResult): StoredState {
  const folders = parsed.blocks.filter(
    (b): b is FolderBlock => b.kind === "folder",
  );
  return {
    order: folders.map((f) => f.path),
    disabled: folders
      .filter((f) => !f.enabledOriginal)
      .map((f) => ({
        path: f.path,
        name: f.name,
        lines: f.lines,
      })),
  };
}

/** Disabled folders from state that are no longer present in the parsed file. */
export function missingDisabled(
  parsed: ParseResult,
  state: StoredState,
): StoredFolder[] {
  const present = new Set(
    parsed.blocks
      .filter((b): b is FolderBlock => b.kind === "folder")
      .map((f) => f.path),
  );
  return state.disabled.filter((d) => !present.has(d.path));
}

/** Whether the file needs to be rewritten to bring back stored disabled folders. */
export function needsRestore(parsed: ParseResult, state: StoredState): boolean {
  return missingDisabled(parsed, state).length > 0;
}

function defaultDisabledLines(path: string, name?: string): string[] {
  if (name) {
    return [
      "// {",
      `// \t"name": "${name}",`,
      `// \t"path": "${path}"`,
      "// },",
    ];
  }
  return ["// {", `// \t"path": "${path}"`, "// },"];
}

export function createDisabledBlock(stored: StoredFolder): FolderBlock {
  const lines = stored.lines ?? defaultDisabledLines(stored.path, stored.name);
  return {
    kind: "folder",
    enabledOriginal: false,
    enabled: false,
    name: stored.name,
    path: stored.path,
    lines: [...lines],
  };
}

export interface FolderChanges {
  added: string[];
  removed: string[];
}

/**
 * Merge the on-disk workspace file with persisted state after VS Code edits
 * the `folders` array (add/remove/reformat). Returns `undefined` when the file
 * cannot be parsed; `text` is set only when the workspace file should be saved.
 */
export function reconcileWithState(
  text: string,
  state: StoredState,
  changes?: FolderChanges,
): { text?: string; state: StoredState } | undefined {
  const parsed = parseFolders(text);
  if (!parsed) {
    return undefined;
  }

  const nextState = applyFolderChanges(state, changes);

  if (!needsRestore(parsed, nextState)) {
    return {
      state: changes ? syncStateFromFile(nextState, parsed) : stateFromParse(parsed),
    };
  }

  const folderByPath = folderBlocksByPath(parsed);
  const disabledByPath = new Map(
    nextState.disabled.map((d) => [d.path, d]),
  );

  const rebuilt: FolderBlock[] = [];
  const seen = new Set<string>();

  for (const path of nextState.order) {
    seen.add(path);
    const active = folderByPath.get(path);
    const stored = disabledByPath.get(path);

    if (active?.enabledOriginal) {
      rebuilt.push(cloneFolderBlock(active));
      continue;
    }

    if (active && !active.enabledOriginal) {
      rebuilt.push(cloneFolderBlock(active));
      continue;
    }

    if (stored) {
      rebuilt.push(createDisabledBlock(stored));
    }
  }

  for (const [path, folder] of folderByPath) {
    if (seen.has(path) || !folder.enabledOriginal) {
      continue;
    }
    rebuilt.push(cloneFolderBlock(folder));
    if (!nextState.order.includes(path)) {
      nextState.order.push(path);
    }
  }

  const nextParsed: ParseResult = {
    ...parsed,
    blocks: rebuilt,
  };

  nextState.disabled = rebuilt
    .filter((f) => !f.enabledOriginal)
    .map((f) => ({
      path: f.path,
      name: f.name,
      lines: f.lines,
    }));

  const nextText = applyStates(nextParsed);
  if (nextText === text) {
    return { state: nextState };
  }

  return { text: nextText, state: nextState };
}

function folderBlocksByPath(parsed: ParseResult): Map<string, FolderBlock> {
  const map = new Map<string, FolderBlock>();
  for (const block of parsed.blocks) {
    if (block.kind === "folder") {
      map.set(block.path, block);
    }
  }
  return map;
}

function cloneFolderBlock(folder: FolderBlock): FolderBlock {
  return {
    ...folder,
    lines: [...folder.lines],
    enabled: folder.enabledOriginal,
  };
}

function applyFolderChanges(
  state: StoredState,
  changes?: FolderChanges,
): StoredState {
  const next: StoredState = {
    order: [...state.order],
    disabled: state.disabled.map((d) => ({
      ...d,
      lines: d.lines ? [...d.lines] : undefined,
    })),
  };

  if (!changes) {
    return next;
  }

  for (const path of changes.removed) {
    next.order = next.order.filter((p) => p !== path);
    next.disabled = next.disabled.filter((d) => d.path !== path);
  }

  for (const path of changes.added) {
    if (!next.order.includes(path)) {
      next.order.push(path);
    }
    next.disabled = next.disabled.filter((d) => d.path !== path);
  }

  return next;
}

/** Refresh disabled-folder line texts from the file while keeping structural edits. */
function syncStateFromFile(
  state: StoredState,
  parsed: ParseResult,
): StoredState {
  const fromFile = stateFromParse(parsed);
  const disabledByPath = new Map(fromFile.disabled.map((d) => [d.path, d]));
  return {
    order: state.order,
    disabled: state.disabled.map((d) => disabledByPath.get(d.path) ?? d),
  };
}
