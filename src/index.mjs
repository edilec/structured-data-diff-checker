export const TOOL_ID = 'structured-data-diff-checker';
export const LIMITS = Object.freeze({ inputBytes: 262144, contextBytes: 65536, entities: 500, properties: 10000, depth: 4, milliseconds: 5000 });
export const SEVERITY = Object.freeze({
  'input-unavailable': 'warning', 'input-invalid': 'warning', 'input-too-large': 'warning',
  'depth-limit': 'warning', 'record-limit': 'warning', 'timeout': 'warning',
  'context-unknown': 'warning', 'context-unsupported': 'warning', 'entity-invalid': 'warning', 'entity-duplicate': 'warning',
  'empty-graph': 'warning',
  'entity-added': 'error', 'entity-removed': 'error', 'entity-types-changed': 'error',
  'entity-fields-changed': 'error', 'entity-relationships-changed': 'error'
});
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, allowed) => obj(x) && Object.keys(x).every(k => allowed.includes(k));
const safe = x => typeof x === 'string' && x.length > 0 && x.length <= 240 && !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(x);
const absoluteIri = x => safe(x) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(x);
const canon = value => JSON.stringify(value);
export const finding = (ruleId, file, pointer, message) => {
  if (!Object.hasOwn(SEVERITY, ruleId)) throw Error('Unknown rule');
  return { ruleId, severity: SEVERITY[ruleId], message, location: { file, pointer } };
};
export function report(findings, checked = 0) {
  findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
  const status = findings.some(f => f.severity === 'warning') ? 'incomplete' : findings.length ? 'fail' : 'pass';
  return { schemaVersion: '1', tool: TOOL_ID, status, summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length }, findings };
}
export class ConfigError extends Error {}
export function validateContextMap(value) {
  if (!obj(value) || Object.keys(value).sort().join(',') !== 'contexts,schemaVersion' || value.schemaVersion !== '1' || !obj(value.contexts) || Object.keys(value.contexts).length > 100) throw new ConfigError('Invalid context map');
  for (const [iri, context] of Object.entries(value.contexts)) if (!absoluteIri(iri) || !validContext(context)) throw new ConfigError('Invalid context map');
  return value.contexts;
}
function validContext(context) {
  if (!obj(context) || Object.keys(context).length > 200) return false;
  return Object.entries(context).every(([term, iri]) => term === '@vocab' ? absoluteIri(iri) : safe(term) && !term.startsWith('@') && absoluteIri(iri));
}
class Issue extends Error { constructor(ruleId, file, pointer) { super(ruleId); this.ruleId = ruleId; this.file = file; this.pointer = pointer; } }
function contextFor(doc, contexts, role) {
  const raw = doc['@context'];
  if (typeof raw === 'string') {
    if (!Object.hasOwn(contexts, raw)) throw new Issue('context-unknown', role, '/@context');
    return contexts[raw];
  }
  if (validContext(raw)) return raw;
  throw new Issue('context-unsupported', role, '/@context');
}
function expand(term, context, role, pointer) {
  if (!safe(term)) throw new Issue('entity-invalid', role, pointer);
  if (Object.hasOwn(context, term)) return context[term];
  if (absoluteIri(term)) return term;
  if (context['@vocab']) return `${context['@vocab']}${term}`;
  throw new Issue('context-unknown', role, pointer);
}
function normalizeValues(value, role, pointer) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 1000) throw new Issue('record-limit', role, pointer);
  const scalar = x => x === null || typeof x === 'string' || typeof x === 'number' && Number.isFinite(x) || typeof x === 'boolean';
  if (values.every(scalar)) return ['field', values.map(canon).sort(cmp)];
  if (values.every(x => keys(x, ['@id']) && Object.keys(x).length === 1 && safe(x['@id']))) return ['relationship', values.map(x => x['@id']).sort(cmp)];
  throw new Issue('entity-invalid', role, pointer);
}
function normalize(doc, contexts, role, expired) {
  if (!keys(doc, ['@context', '@graph']) || !Array.isArray(doc['@graph'])) throw new Issue('input-invalid', role, '');
  if (doc['@graph'].length > LIMITS.entities) throw new Issue('record-limit', role, '/@graph');
  if (!doc['@graph'].length) throw new Issue('empty-graph', role, '/@graph');
  const context = contextFor(doc, contexts, role), entities = new Map();
  let propertyCount = 0;
  for (const [i, entity] of doc['@graph'].entries()) {
    if (expired()) throw new Issue('timeout', role, '');
    const pointer = `/@graph/${i}`;
    if (!obj(entity) || !safe(entity['@id']) || !Object.hasOwn(entity, '@type')) throw new Issue('entity-invalid', role, pointer);
    if (entities.has(entity['@id'])) throw new Issue('entity-duplicate', role, pointer);
    const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']];
    if (!types.length || !types.every(safe)) throw new Issue('entity-invalid', role, `${pointer}/@type`);
    const expandedTypes = [...new Set(types.map(x => expand(x, context, role, `${pointer}/@type`)))].sort(cmp);
    const fields = new Map(), relationships = new Map();
    for (const [key, value] of Object.entries(entity)) {
      if (key === '@id' || key === '@type') continue;
      if (key.startsWith('@')) throw new Issue('context-unsupported', role, pointer);
      const iri = expand(key, context, role, pointer);
      if (fields.has(iri) || relationships.has(iri)) throw new Issue('entity-invalid', role, pointer);
      const [kind, normalized] = normalizeValues(value, role, pointer);
      (kind === 'field' ? fields : relationships).set(iri, normalized);
      if (++propertyCount > LIMITS.properties) throw new Issue('record-limit', role, pointer);
    }
    entities.set(entity['@id'], { pointer, types: expandedTypes, fields, relationships });
  }
  return entities;
}
const mapFingerprint = map => canon([...map.entries()].sort(([a], [b]) => cmp(a, b)));
export function compareGraphs(before, after, contextMap, { deadline = Infinity, now = Date.now } = {}) {
  const expired = () => deadline !== Infinity && now() > deadline;
  try {
    const contexts = validateContextMap(contextMap);
    if (expired()) throw new Issue('timeout', '@before', '');
    const prior = normalize(before, contexts, '@before', expired);
    const current = normalize(after, contexts, '@after', expired);
    const findings = [];
    for (const [id, oldEntity] of prior) {
      if (expired()) throw new Issue('timeout', '@before', '');
      const next = current.get(id);
      if (!next) { findings.push(finding('entity-removed', '@before', oldEntity.pointer, 'Stable entity is absent from the later release')); continue; }
      if (canon(oldEntity.types) !== canon(next.types)) findings.push(finding('entity-types-changed', '@after', next.pointer, 'Entity types changed'));
      if (mapFingerprint(oldEntity.fields) !== mapFingerprint(next.fields)) findings.push(finding('entity-fields-changed', '@after', next.pointer, 'Entity scalar fields changed'));
      if (mapFingerprint(oldEntity.relationships) !== mapFingerprint(next.relationships)) findings.push(finding('entity-relationships-changed', '@after', next.pointer, 'Entity relationships changed'));
    }
    for (const [id, next] of current) if (!prior.has(id)) findings.push(finding('entity-added', '@after', next.pointer, 'Stable entity was added in the later release'));
    if (expired()) throw new Issue('timeout', '@before', '');
    return report(findings, new Set([...prior.keys(), ...current.keys()]).size);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error instanceof Issue) return report([finding(error.ruleId, error.file, error.pointer, 'Comparison evidence is incomplete')]);
    return report([finding('input-invalid', '@before', '', 'Comparison evidence is invalid')]);
  }
}
