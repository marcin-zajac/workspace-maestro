import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as jsonc from 'jsonc-parser';
import { parseFolders, applyStates } from '../out/core.js';
import {
	stateFromParse,
	reconcileWithState,
	missingDisabled,
} from '../out/state.js';

const REAL = join(
	dirname(fileURLToPath(import.meta.url)),
	'fixtures',
	'sample.code-workspace'
);

let failures = 0;
function check(name, cond, extra = '') {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name} ${extra}`);
	}
}

function activePaths(text) {
	const errors = [];
	const obj = jsonc.parse(text, errors, { allowTrailingComma: true });
	if (errors.length) {
		return { error: errors, paths: [] };
	}
	return { error: null, paths: (obj.folders ?? []).map((f) => f.path) };
}

const text = readFileSync(REAL, 'utf8');

console.log('parse the real workspace file');
const parsed = parseFolders(text);
check('found folders array', !!parsed);
const folders = parsed.blocks.filter((b) => b.kind === 'folder');
const enabled = folders.filter((f) => f.enabledOriginal).map((f) => f.path);
const disabled = folders.filter((f) => !f.enabledOriginal).map((f) => f.path);
const baseActive = activePaths(text).paths;
check('detected at least 1 folder', folders.length >= 1, `(got ${folders.length})`);
check(
	'enabled set matches raw parse',
	JSON.stringify(enabled) === JSON.stringify(baseActive),
	`parsed=${JSON.stringify(enabled)} raw=${JSON.stringify(baseActive)}`
);
check('enabled + disabled == total', enabled.length + disabled.length === folders.length);
check('disabled includes identity', disabled.includes('identity'));
check('disabled includes workspace-tools', disabled.includes('workspace-tools'));
check(
	'section dividers preserved as raw',
	parsed.blocks.some(
		(b) => b.kind === 'raw' && b.lines[0].includes('REPORTING')
	)
);

console.log('idempotency: no changes => identical bytes');
{
	const p = parseFolders(text);
	const out = applyStates(p);
	check('round-trip equals original', out === text, '(diff detected)');
}

console.log('enable a disabled folder (identity)');
{
	const p = parseFolders(text);
	p.blocks
		.filter((b) => b.kind === 'folder')
		.forEach((b) => {
			if (b.path === 'identity') b.enabled = true;
		});
	const out = applyStates(p);
	const { error, paths } = activePaths(out);
	check('output parses', !error, JSON.stringify(error));
	check('identity now active', paths.includes('identity'));
	check('previously-active folders still active', baseActive.every((p) => paths.includes(p)));
	check('one more active than before', paths.length === baseActive.length + 1, JSON.stringify(paths));
	check('settings block untouched', out.includes('"cSpell.words"'));
}

console.log('disable an enabled folder (main)');
{
	const p = parseFolders(text);
	p.blocks
		.filter((b) => b.kind === 'folder')
		.forEach((b) => {
			if (b.path === 'main') b.enabled = false;
		});
	const out = applyStates(p);
	const { error, paths } = activePaths(out);
	check('output parses', !error, JSON.stringify(error));
	check('main no longer active', !paths.includes('main'));
	check('one fewer active than before', paths.length === baseActive.length - 1, JSON.stringify(paths));
	check('main appears as comment', /\/\/\s*\{[\s\S]*?\/\/\s*"path": "main"/.test(out));
}

console.log('enable ALL folders');
{
	const p = parseFolders(text);
	p.blocks
		.filter((b) => b.kind === 'folder')
		.forEach((b) => (b.enabled = true));
	const out = applyStates(p);
	const { error, paths } = activePaths(out);
	check('output parses', !error, JSON.stringify(error));
	check('all folders active', paths.length === folders.length, `(got ${paths.length} of ${folders.length})`);
	check('no trailing comma on last folder', /"path": "workspace-tools"\s*\n\s*\}\s*\n\s*\]/.test(out), 'last folder still followed by comma');
}

console.log('disable ALL folders');
{
	const p = parseFolders(text);
	p.blocks
		.filter((b) => b.kind === 'folder')
		.forEach((b) => (b.enabled = false));
	const out = applyStates(p);
	const { error, paths } = activePaths(out);
	check('output parses', !error, JSON.stringify(error));
	check('0 active', paths.length === 0, `(got ${paths.length})`);
}

console.log('VS Code reformats workspace and strips comments');
{
	const state = stateFromParse(parsed);
	const vsCodeText = `{
	"folders": [
		{
			"path": "main"
		},
		{
			"name": "preferences",
			"path": "PPP-1543-main-preferences"
		},
		{
			"path": "new-module"
		}
	],
	"settings": {
		"cSpell.words": [
			"autodocs"
		]
	}
}`;
	const stripped = parseFolders(vsCodeText);
	check('comments stripped from file', missingDisabled(stripped, state).length > 0);
	const result = reconcileWithState(vsCodeText, state, {
		added: ['new-module'],
		removed: [],
	});
	check('reconcile produced text', !!result?.text);
	const restored = parseFolders(result.text);
	const allFolders = restored.blocks.filter((b) => b.kind === 'folder');
	const restoredDisabled = allFolders
		.filter((f) => !f.enabledOriginal)
		.map((f) => f.path);
	check('identity restored', restoredDisabled.includes('identity'));
	check('organization restored', restoredDisabled.includes('organization'));
	check('workspace-tools restored', restoredDisabled.includes('workspace-tools'));
	check('new-module stays active', activePaths(result.text).paths.includes('new-module'));
	check(
		'still parses',
		!activePaths(result.text).error,
		JSON.stringify(activePaths(result.text).error)
	);
}

console.log('VS Code removes a folder via UI');
{
	const state = stateFromParse(parsed);
	const vsCodeText = `{
	"folders": [
		{ "path": "main" }
	]
}`;
	const result = reconcileWithState(vsCodeText, state, {
		added: [],
		removed: ['PPP-1543-main-preferences'],
	});
	check('rewrite restores disabled folders after removal', !!result?.text);
	check(
		'removed folder dropped from state',
		!result.state.order.includes('PPP-1543-main-preferences')
	);
	check(
		'disabled folders still tracked',
		result.state.disabled.some((d) => d.path === 'identity')
	);
}

console.log('');
if (failures === 0) {
	console.log('ALL PASSED');
} else {
	console.log(`${failures} FAILED`);
	process.exit(1);
}
