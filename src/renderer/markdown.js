import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import diff from 'highlight.js/lib/languages/diff';
import shell from 'highlight.js/lib/languages/shell';
import 'highlight.js/styles/github-dark.css';

[
  ['javascript', javascript],
  ['typescript', typescript],
  ['python', python],
  ['bash', bash],
  ['json', json],
  ['xml', xml],
  ['css', css],
  ['rust', rust],
  ['go', go],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['sql', sql],
  ['yaml', yaml],
  ['markdown', markdown],
  ['diff', diff],
  ['shell', shell],
].forEach(([name, language]) => hljs.registerLanguage(name, language));

const marked = new Marked(markedHighlight({
  emptyLangClass: 'hljs',
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const normalizedLang = typeof lang === 'string' ? lang.trim().split(/\s+/, 1)[0] : '';
    if (normalizedLang && hljs.getLanguage(normalizedLang)) return hljs.highlight(code, { language: normalizedLang }).value;
    return hljs.highlightAuto(code).value;
  },
}));

function renderBotMessage(div, text) {
  if (marked?.parse) div.innerHTML = marked.parse(text);
  else div.textContent = text;
}

export { renderBotMessage };
