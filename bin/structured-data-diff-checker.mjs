#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_ID, LIMITS, finding, report, validateContextMap, compareGraphs } from '../src/index.mjs';

const usage = `Usage: ${TOOL_ID} --root DIR --before RELATIVE.json --after RELATIVE.json --contexts RELATIVE.json`;
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 240 && !isAbsolute(name) && !name.split(/[\\/]/).includes('..') && !/[\u0000-\u001f\u007f-\u009f]/.test(name);
const inside = (root, target) => { const rel = relative(root, target); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
function readJson(root, name, role, maxBytes, maxDepth, expired) {
  try {
    if (expired()) return { error: finding('timeout', role, '', 'Input reading exceeded its runtime limit') };
    const target = realpathSync(resolve(root, name));
    if (!inside(root, target) || !statSync(target).isFile()) throw Error();
    if (statSync(target).size > maxBytes) return { error: finding('input-too-large', role, '', 'Input exceeds its byte limit') };
    const bytes = readFileSync(target);
    if (bytes.length > maxBytes) return { error: finding('input-too-large', role, '', 'Input exceeds its byte limit') };
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const stack = [[value, 0]];
    while (stack.length) {
      if (expired()) return { error: finding('timeout', role, '', 'Input reading exceeded its runtime limit') };
      const [item, depth] = stack.pop();
      if (depth > maxDepth) return { error: finding('depth-limit', role, '', 'JSON nesting exceeds its limit') };
      if (item && typeof item === 'object') for (const child of Object.values(item)) if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
    return { value };
  } catch { return { error: finding('input-unavailable', role, '', 'Input could not be read, decoded, or parsed') }; }
}
export function main(argv, now = Date.now, output = process.stdout, error = process.stderr) {
  if (argv.length === 1 && argv[0] === '--help') { output.write(`${usage}\n`); return 0; }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--root', '--before', '--after', '--contexts'].includes(argv[i]) || !argv[i + 1] || Object.hasOwn(args, argv[i])) { error.write(`${usage}\n`); return 2; }
    args[argv[i]] = argv[i + 1];
  }
  if (Object.keys(args).length !== 4 || !['--before', '--after', '--contexts'].every(key => safeName(args[key]))) { error.write(`${usage}\n`); return 2; }
  let root;
  try { root = realpathSync(args['--root']); if (!statSync(root).isDirectory()) throw Error(); }
  catch { error.write('Root must be a readable directory\n'); return 2; }
  const deadline = now() + LIMITS.milliseconds;
  const expired = () => now() > deadline;
  const context = readJson(root, args['--contexts'], '@contexts', LIMITS.contextBytes, 3, expired);
  if (context.error) { error.write('Context configuration is unavailable or invalid\n'); return 2; }
  try { validateContextMap(context.value); }
  catch { error.write('Context configuration is unavailable or invalid\n'); return 2; }
  const before = readJson(root, args['--before'], '@before', LIMITS.inputBytes, LIMITS.depth, expired);
  const after = readJson(root, args['--after'], '@after', LIMITS.inputBytes, LIMITS.depth, expired);
  const issues = [before.error, after.error].filter(Boolean);
  const result = issues.length ? report(issues) : compareGraphs(before.value, after.value, context.value, { deadline, now });
  output.write(`${JSON.stringify(result)}\n`);
  error.write(`${result.status}: ${result.summary.checked} entities, ${result.findings.length} findings\n`);
  return result.status === 'pass' ? 0 : result.status === 'fail' ? 1 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
