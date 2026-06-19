import * as jsonc from "jsonc-parser";

export interface FolderBlock {
  kind: "folder";
  enabledOriginal: boolean;
  enabled: boolean;
  name?: string;
  path: string;
  lines: string[];
}

export interface RawBlock {
  kind: "raw";
  lines: string[];
}

export type Block = FolderBlock | RawBlock;

export interface ParseResult {
  allLines: string[];
  openLine: number;
  closeLine: number;
  blocks: Block[];
}

/** Return the 0-based line index that a character offset falls on. */
function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
    }
  }
  return line;
}

/** Parse the workspace file text into an ordered list of folder / raw blocks. */
export function parseFolders(text: string): ParseResult | undefined {
  const root = jsonc.parseTree(text);
  if (!root) {
    return undefined;
  }
  const foldersNode = jsonc.findNodeAtLocation(root, ["folders"]);
  if (!foldersNode || foldersNode.type !== "array") {
    return undefined;
  }

  const allLines = text.split("\n");
  const openLine = offsetToLine(text, foldersNode.offset);
  const closeLine = offsetToLine(
    text,
    foldersNode.offset + foldersNode.length - 1,
  );

  const activeRanges = (foldersNode.children ?? []).map((child) => {
    const value = jsonc.getNodeValue(child) ?? {};
    return {
      startLine: offsetToLine(text, child.offset),
      endLine: offsetToLine(text, child.offset + child.length - 1),
      name: typeof value.name === "string" ? value.name : undefined,
      path: typeof value.path === "string" ? value.path : "",
    };
  });

  const blocks: Block[] = [];
  let i = openLine + 1;
  while (i < closeLine) {
    const active = activeRanges.find((r) => r.startLine === i);
    if (active) {
      blocks.push({
        kind: "folder",
        enabledOriginal: true,
        enabled: true,
        name: active.name,
        path: active.path,
        lines: allLines.slice(active.startLine, active.endLine + 1),
      });
      i = active.endLine + 1;
      continue;
    }

    const disabled = tryParseDisabledFolder(allLines, i, closeLine);
    if (disabled) {
      blocks.push({
        kind: "folder",
        enabledOriginal: false,
        enabled: false,
        name: disabled.name,
        path: disabled.path,
        lines: allLines.slice(i, disabled.endLine + 1),
      });
      i = disabled.endLine + 1;
      continue;
    }

    blocks.push({ kind: "raw", lines: [allLines[i]] });
    i++;
  }

  return { allLines, openLine, closeLine, blocks };
}

/**
 * Try to read a commented-out folder object starting at `startLine`.
 *
 * Returns the block bounds plus the parsed name/path, or `undefined` if the
 * lines are not a commented folder object (e.g. a section divider or any line
 * that is not part of a `// {`-style block).
 */
function tryParseDisabledFolder(
  lines: string[],
  startLine: number,
  closeLine: number,
): { endLine: number; name?: string; path: string } | undefined {
  const first = uncomment(lines[startLine]);
  if (first === null || !first.trimStart().startsWith("{")) {
    return undefined;
  }

  const inner: string[] = [];
  let end = -1;
  for (let j = startLine; j < closeLine; j++) {
    const stripped = uncomment(lines[j]);
    if (stripped === null) {
      return undefined;
    }
    inner.push(stripped);
    const trimmed = stripped.trimEnd().replace(/,\s*$/, "");
    if (trimmed.endsWith("}")) {
      end = j;
      break;
    }
  }
  if (end === -1) {
    return undefined;
  }

  const jsonText = inner.join("\n").trim().replace(/,\s*$/, "");
  const errors: jsonc.ParseError[] = [];
  const value = jsonc.parse(jsonText, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !value || typeof value.path !== "string") {
    return undefined;
  }

  return {
    endLine: end,
    name: typeof value.name === "string" ? value.name : undefined,
    path: value.path,
  };
}

/**
 * Strip a single leading line comment marker, preserving indentation that
 * comes before *and* inside the comment.
 *
 * Returns the un-commented content, or `null` if the line is not a `//` comment.
 */
export function uncomment(line: string): string | null {
  const m = line.match(/^(\s*)\/\/ ?(.*)$/);
  if (!m) {
    return null;
  }
  return m[1] + m[2];
}

/** Add a `// ` marker right after the leading whitespace. */
export function comment(line: string): string {
  return line.replace(/^(\s*)/, "$1// ");
}

/**
 * Comment or uncomment every folder whose desired state differs from its
 * original state, in place.
 */
function applyToggles(blocks: Block[]): void {
  for (const block of blocks) {
    if (block.kind !== "folder" || block.enabled === block.enabledOriginal) {
      continue;
    }
    block.lines = block.enabled
      ? block.lines.map((l) => uncomment(l) ?? l)
      : block.lines.map((l) => comment(l));
  }
}

/**
 * Ensure a comma separates consecutive enabled folders.
 *
 * Only missing commas are added; the trailing comma on the last enabled folder
 * is never stripped, because the user's convention keeps it when commented
 * folders follow and VS Code's JSONC parser tolerates it.
 */
function normalizeCommas(blocks: Block[]): void {
  const enabledFolders = blocks.filter(
    (b): b is FolderBlock => b.kind === "folder" && b.enabled,
  );
  enabledFolders.forEach((folder, idx) => {
    const hasLaterEnabled = idx < enabledFolders.length - 1;
    if (!hasLaterEnabled) {
      return;
    }
    const lastIdx = folder.lines.length - 1;
    const lastLine = folder.lines[lastIdx];
    if (!/,\s*$/.test(lastLine)) {
      folder.lines[lastIdx] = lastLine.replace(/\s*$/, "") + ",";
    }
  });
}

/**
 * Produce the full new file text after applying each folder block's desired
 * `enabled` state. Only the folder lines change; everything else is preserved
 * byte-for-byte.
 */
export function applyStates(parsed: ParseResult): string {
  const { allLines, openLine, closeLine, blocks } = parsed;

  applyToggles(blocks);
  normalizeCommas(blocks);

  const head = allLines.slice(0, openLine + 1);
  const tail = allLines.slice(closeLine);
  const body = blocks.flatMap((block) => block.lines);
  return [...head, ...body, ...tail].join("\n");
}
