import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../bin/structured-data-diff-checker.mjs';
import { compareGraphs } from '../src/index.mjs';

const cli = new URL('../bin/structured-data-diff-checker.mjs', import.meta.url).pathname;
const contexts = { schemaVersion: '1', contexts: { 'https://example.test/context': { '@vocab': 'https://example.test/vocab/' } } };
const entity = (id, extra = {}) => ({ '@id': id, '@type': 'Thing', name: 'Synthetic item', related: { '@id': 'urn:fixture:other' }, ...extra });
const graph = (...entities) => ({ '@context': 'https://example.test/context', '@graph': entities });
function run(before, after, contextMap = contexts) {
  const root = mkdtempSync(join(tmpdir(), 'jsonld-diff-'));
  try {
    writeFileSync(join(root, 'before.json'), JSON.stringify(before));
    writeFileSync(join(root, 'after.json'), JSON.stringify(after));
    writeFileSync(join(root, 'contexts.json'), JSON.stringify(contextMap));
    const out = spawnSync(process.execPath, [cli, '--root', root, '--before', 'before.json', '--after', 'after.json', '--contexts', 'contexts.json'], { encoding: 'utf8' });
    return { ...out, report: out.stdout ? JSON.parse(out.stdout) : null };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('object key order and entity order do not create a change', () => {
  const a = graph(entity('urn:fixture:a'), entity('urn:fixture:b'));
  const b = graph({ related: { '@id': 'urn:fixture:other' }, name: 'Synthetic item', '@type': 'Thing', '@id': 'urn:fixture:b' }, { related: { '@id': 'urn:fixture:other' }, name: 'Synthetic item', '@type': 'Thing', '@id': 'urn:fixture:a' });
  const out = run(a, b);
  assert.equal(out.status, 0);
  assert.equal(out.report.status, 'pass');
  assert.equal(out.report.summary.checked, 2);
  assert.deepEqual(out.report.findings, []);
});
test('removed stable entity is a failing diff with source ordinal, not raw ID', () => {
  const out = run(graph(entity('urn:fixture:private-a'), entity('urn:fixture:private-b')), graph(entity('urn:fixture:private-a')));
  assert.equal(out.status, 1);
  assert.ok(out.report.findings.some(f => f.ruleId === 'entity-removed' && f.location.file === '@before' && f.location.pointer === '/@graph/1'));
  assert.ok(!out.stdout.includes('private-b'));
});
test('changed type, scalar field and relationship have distinct findings', () => {
  const a = graph(entity('urn:fixture:a'));
  const b = graph(entity('urn:fixture:a', { '@type': 'Product', name: 'Updated', related: { '@id': 'urn:fixture:next' } }));
  const out = run(a, b);
  assert.equal(out.status, 1);
  assert.deepEqual(out.report.findings.map(f => f.ruleId), ['entity-fields-changed', 'entity-relationships-changed', 'entity-types-changed']);
  assert.ok(!out.stdout.includes('Updated'));
});
test('unmapped remote context stays incomplete without a network fetch', () => {
  const out = run(graph(entity('urn:fixture:a')), graph(entity('urn:fixture:a')), { schemaVersion: '1', contexts: {} });
  assert.equal(out.status, 2);
  assert.equal(out.report.status, 'incomplete');
  assert.ok(out.report.findings.some(f => f.ruleId === 'context-unknown'));
});
test('unknown option has empty stdout', () => {
  const out = spawnSync(process.execPath, [cli, '--unknown'], { encoding: 'utf8' });
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
});
test('empty string literal is a valid scalar value', () => {
  const out = run(graph(entity('urn:fixture:a', { name: '' })), graph(entity('urn:fixture:a', { name: '' })));
  assert.equal(out.status, 0);
  assert.deepEqual(out.report.findings, []);
});
test('mapped term aliases and unordered value arrays do not create a diff', () => {
  const map = { schemaVersion: '1', contexts: { 'https://example.test/context': { '@vocab': 'https://example.test/vocab/', title: 'https://example.test/vocab/name' } } };
  const a = graph(entity('urn:fixture:a', { name: ['first', 'second'] }));
  const b = graph({ '@id': 'urn:fixture:a', '@type': 'Thing', title: ['second', 'first'], related: { '@id': 'urn:fixture:other' } });
  assert.equal(run(a, b, map).status, 0);
});
test('duplicate stable IDs and unsupported nested values are incomplete', () => {
  const duplicate = run(graph(entity('urn:fixture:a'), entity('urn:fixture:a')), graph(entity('urn:fixture:a')));
  assert.equal(duplicate.status, 2);
  assert.ok(duplicate.report.findings.some(f => f.ruleId === 'entity-duplicate'));
  const nested = run(graph(entity('urn:fixture:a', { name: { text: 'value' } })), graph(entity('urn:fixture:a')));
  assert.equal(nested.status, 2);
  assert.ok(nested.report.findings.some(f => f.ruleId === 'entity-invalid'));
});
test('entity bound accepts 500 and refuses 501', () => {
  const items = Array.from({ length: 500 }, (_, i) => entity(`urn:fixture:${i}`));
  assert.equal(run(graph(...items), graph(...items)).status, 0);
  items.push(entity('urn:fixture:overflow'));
  const over = run(graph(...items), graph(...items));
  assert.equal(over.status, 2);
  assert.ok(over.report.findings.some(f => f.ruleId === 'record-limit'));
});
test('property bound accepts 10000 and refuses 10001', () => {
  const properties = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`p${i}`, i]));
  const a = graph({ '@id': 'urn:fixture:a', '@type': 'Thing', ...properties });
  assert.equal(compareGraphs(a, a, contexts).status, 'pass');
  a['@graph'][0].overflow = 1;
  const over = compareGraphs(a, a, contexts);
  assert.equal(over.status, 'incomplete');
  assert.ok(over.findings.some(f => f.ruleId === 'record-limit'));
});
test('valid relationship-array depth is accepted and one extra container is refused', () => {
  const a = graph(entity('urn:fixture:a', { related: [{ '@id': 'urn:fixture:other' }] }));
  assert.equal(run(a, a).status, 0);
  const deep = graph(entity('urn:fixture:a', { related: [{ '@id': 'urn:fixture:other', extra: {} }] }));
  const out = run(deep, a);
  assert.equal(out.status, 2);
  assert.ok(out.report.findings.some(f => f.ruleId === 'depth-limit'));
});
test('injected runtime boundary accepts 5000ms and refuses 5001ms', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonld-clock-'));
  try {
    writeFileSync(join(root, 'before.json'), JSON.stringify(graph(entity('urn:fixture:a'))));
    writeFileSync(join(root, 'after.json'), JSON.stringify(graph(entity('urn:fixture:a'))));
    writeFileSync(join(root, 'contexts.json'), JSON.stringify(contexts));
    const args = ['--root', root, '--before', 'before.json', '--after', 'after.json', '--contexts', 'contexts.json'];
    const invoke = clock => { let stdout = ''; const code = main(args, clock, { write: s => { stdout += s; } }, { write: () => {} }); return { code, stdout }; };
    let calls = 0;
    assert.equal(invoke(() => calls++ === 0 ? 100 : 5100).code, 0);
    calls = 0;
    const over = invoke(() => calls++ === 0 ? 100 : 5101);
    assert.equal(over.code, 2);
    assert.equal(over.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('symlinked release outside root cannot be read', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonld-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'jsonld-out-'));
  try {
    writeFileSync(join(outside, 'private.json'), 'PRIVATE_SENTINEL');
    symlinkSync(join(outside, 'private.json'), join(root, 'before.json'));
    writeFileSync(join(root, 'after.json'), JSON.stringify(graph(entity('urn:fixture:a'))));
    writeFileSync(join(root, 'contexts.json'), JSON.stringify(contexts));
    const out = spawnSync(process.execPath, [cli, '--root', root, '--before', 'before.json', '--after', 'after.json', '--contexts', 'contexts.json'], { encoding: 'utf8' });
    assert.equal(out.status, 2);
    assert.ok(JSON.parse(out.stdout).findings.some(f => f.ruleId === 'input-unavailable'));
    assert.ok(!`${out.stdout}${out.stderr}`.includes('PRIVATE_SENTINEL'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
test('input byte boundary and strict UTF-8 fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'jsonld-bytes-'));
  try {
    const base = JSON.stringify(graph(entity('urn:fixture:a')));
    writeFileSync(join(root, 'before.json'), base + ' '.repeat(262144 - Buffer.byteLength(base)));
    writeFileSync(join(root, 'after.json'), base);
    writeFileSync(join(root, 'contexts.json'), JSON.stringify(contexts));
    const invoke = () => spawnSync(process.execPath, [cli, '--root', root, '--before', 'before.json', '--after', 'after.json', '--contexts', 'contexts.json'], { encoding: 'utf8' });
    assert.equal(invoke().status, 0);
    writeFileSync(join(root, 'before.json'), base + ' '.repeat(262145 - Buffer.byteLength(base)));
    const large = invoke();
    assert.equal(large.status, 2);
    assert.ok(JSON.parse(large.stdout).findings.some(f => f.ruleId === 'input-too-large'));
    writeFileSync(join(root, 'before.json'), Buffer.from([0xff]));
    const invalid = invoke();
    assert.equal(invalid.status, 2);
    assert.ok(JSON.parse(invalid.stdout).findings.some(f => f.ruleId === 'input-unavailable'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
