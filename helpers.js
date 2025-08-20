'use strict';

/**
 * Dynamically converts a JSON object into Prometheus metrics (text format).
 * - All metrics receive the provided prefix.
 * - The "id" field is not emitted as its own metric, but added as a label to every metric (if present).
 * - String values are tracked as <name>{value="<string>"} 1.
 * - Numeric values are tracked with their numeric value.
 * - Boolean values are tracked as 1/0.
 * - Arrays emit one sample per element (primitive elements as {value="..."} 1).
 * - Nested object names are concatenated using snake_case.
 * - Emits #TYPE (gauge) headers for each metric once.
 */
function jsonToPrometheus(data, prefix = 'starlink_') {
  const idLabel = (data && data.id != null) ? String(data.id) : undefined;

  const toSnake = (key) => {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // camelCase -> camel_case
      .replace(/[^a-zA-Z0-9_]/g, '_')          // allowed chars only
      .replace(/_{2,}/g, '_')                  // collapse multiple underscores
      .replace(/^_+|_+$/g, '')                 // trim underscores
      .toLowerCase();
  };

  const isNumericLike = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return true;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n);
    }
    return false;
  };

  const toNumber = (v) => (typeof v === 'number' ? v : Number(v));

  const escLabel = (s) => String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const lines = [];
  const emittedHeaders = new Set(); // track which metric headers were emitted

  const ensureHeaders = (metricName) => {
    const full = `${prefix}${metricName}`;
    if (emittedHeaders.has(full)) return;
    lines.push(`# TYPE ${full} gauge`);
    emittedHeaders.add(full);
  };

  const emitSample = (metricName, extraLabels, value) => {
    ensureHeaders(metricName);
    const labels = Object.assign({}, extraLabels);
    if (idLabel !== undefined) labels.id = idLabel;
    const labelKeys = Object.keys(labels);
    const labelStr = labelKeys.length
      ? '{' + labelKeys.map(k => `${toSnake(k)}="${escLabel(labels[k])}"`).join(',') + '}'
      : '';
    lines.push(`${prefix}${metricName}${labelStr} ${value}`);
  };

  const walk = (node, path = []) => {
    if (node == null) return;

    const baseName = path.map(toSnake).join('_');

    // primitives
    if (typeof node !== 'object') {
      if (typeof node === 'boolean') {
        emitSample(baseName, {}, node ? 1 : 0);
        return;
      }
      if (isNumericLike(node)) {
        emitSample(baseName, {}, toNumber(node));
        return;
      }
      emitSample(baseName, { value: String(node) }, 1);
      return;
    }

    // arrays
    if (Array.isArray(node)) {
      node.forEach((el, idx) => {
        if (el == null) return;
        if (typeof el === 'object') {
          // recurse into object elements, add index label to descendants
          const rec = (obj, subPath, extraLabels) => {
            if (obj == null) return;
            if (typeof obj !== 'object') {
              const name = [...path, ...subPath].map(toSnake).join('_');
              if (typeof obj === 'boolean') {
                emitSample(name, extraLabels, obj ? 1 : 0);
              } else if (isNumericLike(obj)) {
                emitSample(name, extraLabels, toNumber(obj));
              } else {
                emitSample(name, Object.assign({ value: String(obj) }, extraLabels), 1);
              }
              return;
            }
            if (Array.isArray(obj)) {
              obj.forEach((v, i2) => {
                if (typeof v === 'object') {
                  rec(v, subPath, Object.assign({ index: String(i2) }, extraLabels));
                } else if (v != null) {
                  const name = [...path, ...subPath].map(toSnake).join('_');
                  if (typeof v === 'boolean') {
                    emitSample(name, Object.assign({ index: String(i2) }, extraLabels), v ? 1 : 0);
                  } else if (isNumericLike(v)) {
                    emitSample(name, Object.assign({ index: String(i2) }, extraLabels), toNumber(v));
                  } else {
                    emitSample(
                      name,
                      Object.assign({ index: String(i2), value: String(v) }, extraLabels),
                      1
                    );
                  }
                }
              });
              return;
            }
            for (const [k, v] of Object.entries(obj)) {
              if (k === 'id') continue; // never emit id as its own metric
              rec(v, [...subPath, k], extraLabels);
            }
          };
          rec(el, [], { index: String(idx) });
        } else {
          // primitive array elements
          if (typeof el === 'boolean') {
            emitSample(baseName, { index: String(idx) }, el ? 1 : 0);
          } else if (isNumericLike(el)) {
            emitSample(baseName, { index: String(idx) }, toNumber(el));
          } else {
            emitSample(baseName, { index: String(idx), value: String(el) }, 1);
          }
        }
      });
      return;
    }

    // object
    for (const [k, v] of Object.entries(node)) {
      if (k === 'id') continue;
      walk(v, [...path, k]);
    }
  };

  walk(data);
  return lines.join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
  jsonToPrometheus
};
