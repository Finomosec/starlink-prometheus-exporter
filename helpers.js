'use strict';

/**
 * Konvertiert ein JSON-Objekt dynamisch in Prometheus-Metriken (Text-Format).
 * - Alle Metriken bekommen den übergebenen Prefix.
 * - Das Feld "id" wird nicht als eigene Metrik emittiert, sondern als Label an alle Metriken angehängt (falls vorhanden).
 * - Strings werden als <name>{value="<string>"} 1 erfasst.
 * - Zahlen werden mit ihrem Zahlenwert erfasst.
 * - Boolean-Werte werden als 1/0 erfasst.
 * - Arrays erzeugen pro Element einen Eintrag (bei primitiven Elementen als {value="..."} 1).
 * - Verschachtelte Namen werden snake_case verkettet.
 */
function jsonToPrometheus(data, prefix = 'starlink_') {
  const idLabel = (data && data.id != null) ? String(data.id) : undefined;

  const toSnake = (key) => {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')  // camelCase -> camel_case
      .replace(/[^a-zA-Z0-9_]/g, '_')          // nur erlaubte Zeichen
      .replace(/_{2,}/g, '_')                  // doppelte Unterstriche
      .replace(/^_+|_+$/g, '')                 // Trim underscores
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

  const emitSample = (metricName, extraLabels, value) => {
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

    // primitive Werte direkt ausgeben
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

    // Arrays
    if (Array.isArray(node)) {
      node.forEach((el, idx) => {
        if (el == null) return;
        if (typeof el === 'object') {
          // Rekursiv für Objekt-Elemente; Index als Label hinzufügen
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
              if (k === 'id') continue; // id nie als eigene Metrik
              rec(v, [...subPath, k], extraLabels);
            }
          };
          rec(el, [], { index: String(idx) });
        } else {
          // Primitive Array-Elemente
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

    // Objekt
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
