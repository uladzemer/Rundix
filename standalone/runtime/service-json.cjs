// Bounded callers use this for config and provider frames. JSON.parse alone
// silently accepts duplicate keys (including escaped spellings of the same key).
const {TextDecoder} = require('node:util');
function parseStrict(bytes, {maxDepth = 64} = {}) {
  const text = new TextDecoder('utf-8', {fatal:true}).decode(bytes);
  let at = 0;
  const invalid = () => { throw Error('Invalid JSON.'); };
  const whitespace = () => { while (/[\t\n\r ]/.test(text[at] || '\0')) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') return JSON.parse(text.slice(start, at));
      if (char === '\\') at++;
      if (char.charCodeAt(0) < 32) invalid();
    }
    invalid();
  }
  function value(depth = 0) {
    if (depth > maxDepth) invalid();
    whitespace();
    const char = text[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      at++;
      const object = char === '{', result = object ? {} : [], keys = new Set(), end = object ? '}' : ']';
      whitespace();
      if (text[at] === end) { at++; return result; }
      for (;;) {
        whitespace();
        let key;
        if (object) {
          if (text[at] !== '"') invalid();
          key = string(); if (keys.has(key)) invalid(); keys.add(key);
          whitespace(); if (text[at++] !== ':') invalid();
        }
        const item = value(depth + 1);
        if (object) Object.defineProperty(result, key, {value:item, enumerable:true, configurable:true, writable:true});
        else result.push(item);
        whitespace();
        if (text[at] === end) { at++; return result; }
        if (text[at++] !== ',') invalid();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!token) invalid();
    at += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === 'number' && !Number.isFinite(result)) invalid();
    return result;
  }
  const result = value(); whitespace(); if (at !== text.length) invalid();
  return result;
}
module.exports = {parseStrict};
