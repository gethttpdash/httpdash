'use strict';

/*
 * JSON that was cut short (a response version keeps only its first 64 KB): parsed up to its last
 * complete value, with the arrays and objects still open closed off, so a table can show the part
 * that was kept. Returns { value, partial: true } or undefined when nothing usable is there.
 */
(() => {
  const HD = (typeof window !== 'undefined' ? window : globalThis).HD;
  const OPEN = { '{': '}', '[': ']' };

  HD.parsePartialJson = (text) => {
    const s = String(text || '');
    const stack = [];
    let inString = false;
    let escaped = false;
    // The last place the text can be cut and closed: its index and the brackets open there.
    let cut = null;
    let prev = ''; // the last character outside strings that isn't white space
    const mark = (at) => { cut = { at, closers: stack.map((c) => OPEN[c]).reverse().join('') }; };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      // An array item just begun ("[{" or ",{") would be an empty one: the cut before it is better.
      else if (c === '{' || c === '[') { stack.push(c); if (prev !== ',' && prev !== '[') mark(i + 1); }
      else if (c === '}' || c === ']') { stack.pop(); if (stack.length) mark(i + 1); else return undefined; } // complete JSON: not partial
      else if (c === ',' && stack.length) mark(i);
      if (!/\s/.test(c)) prev = c;
    }
    if (!cut) return undefined;
    try {
      return { value: JSON.parse(s.slice(0, cut.at) + cut.closers), partial: true };
    } catch {
      return undefined;
    }
  };
})();
