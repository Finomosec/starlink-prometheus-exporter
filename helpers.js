'use strict';

/**
 * Dynamically converts a JSON object into Prometheus metrics (text format).
 * - All metrics receive the provided prefix.
 * - The "id" field is not emitted as its own metric, but added as a label to every metric (if present).
 * - String values are tracked as <metric>{value="<string>"} 1.
 * - Numeric values are tracked with their numeric value.
 * - Boolean values are tracked as 1/0.
 * - Arrays emit one sample per element (primitive elements as {value="..."} 1).
 * - Empty arrays emit a single sample with {value="none"} 1.
 * - Nested object names are NOT concatenated; instead:
 *     metric name = first path segment, remaining path joins into label {name="<rest_in_snake_case>"}.
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

  // derive metric name and "name" label from path
  const deriveMetric = (path) => {
    if (!path || path.length === 0) {
      return { metric: 'root', nameLabel: undefined };
    }
    const metric = toSnake(path[0]);
    const nameLabel = path.length > 1 ? path.slice(1).map(toSnake).join('_') : undefined;
    return { metric, nameLabel };
  };

  const emitPrimitiveAtPath = (path, extraLabels, valueNode) => {
    const { metric, nameLabel } = deriveMetric(path);
    const labels = Object.assign({}, extraLabels);
    if (nameLabel) labels.name = nameLabel;

    if (typeof valueNode === 'boolean') {
      emitSample(metric, labels, valueNode ? 1 : 0);
      return;
    }
    if (isNumericLike(valueNode)) {
      emitSample(metric, labels, toNumber(valueNode));
      return;
    }
    // strings or other primitives
    labels.value = String(valueNode);
    emitSample(metric, labels, 1);
  };

  const walk = (node, path = []) => {
    if (node == null) return;

    // primitives
    if (typeof node !== 'object') {
      emitPrimitiveAtPath(path, {}, node);
      return;
    }

    // arrays
    if (Array.isArray(node)) {
      if (node.length === 0) {
          // Emit a placeholder for empty arrays: metric derived from path, with name label (if any)
          const { metric, nameLabel } = deriveMetric(path);
          const labels = {};
          if (nameLabel) labels.name = nameLabel;
          labels.value = 'none';
          emitSample(metric, labels, 1);
          return;
        }

        node.forEach((el, idx) => {
          if (el == null) return;
          if (typeof el === 'object') {
            // Recurse into object elements, add index label to descendants
          const rec = (obj, subPath, extraLabels) => {
            if (obj == null) return;
            if (typeof obj !== 'object') {
              emitPrimitiveAtPath([...path, ...subPath], extraLabels, obj);
              return;
            }
            if (Array.isArray(obj)) {
              obj.forEach((v, i2) => {
                if (v == null) return;
                if (typeof v === 'object') {
                  rec(v, subPath, Object.assign({ index: String(i2) }, extraLabels));
                } else {
                  emitPrimitiveAtPath(
                    [...path, ...subPath],
                    Object.assign({ index: String(i2) }, extraLabels),
                    v
                  );
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
          emitPrimitiveAtPath(path, { index: String(idx) }, el);
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
