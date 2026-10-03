// Lazy chunk: highlight.js core with the languages offered in the "Syntax" menu.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import delphi from 'highlight.js/lib/languages/delphi';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import erlang from 'highlight.js/lib/languages/erlang';
import go from 'highlight.js/lib/languages/go';
import haskell from 'highlight.js/lib/languages/haskell';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lisp from 'highlight.js/lib/languages/lisp';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const languages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  delphi,
  diff,
  dockerfile,
  erlang,
  go,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lisp,
  lua,
  markdown,
  php,
  powershell,
  python,
  r,
  ruby,
  rust,
  scala,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, definition] of Object.entries(languages)) hljs.registerLanguage(name, definition);

/** Highlighting very large texts would freeze the tab; they stay plain. */
const MAX_CHARS = 200_000;

/**
 * hljs output only contains <span class="…">, </span> and HTML-escaped text. Splitting it at
 * newlines must close and re-open the spans that straddle a line break (block comments, ...).
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  for (const token of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+/g) ?? []) {
    if (token === '\n') {
      lines.push(current + '</span>'.repeat(open.length));
      current = open.join('');
    } else {
      if (token.startsWith('<span')) open.push(token);
      else if (token === '</span>') open.pop();
      current += token;
    }
  }
  lines.push(current + '</span>'.repeat(open.length));
  return lines;
}

/** Highlighted HTML for every line, or `null` when the text should stay plain. */
export function highlightLines(text: string, syntax: string): string[] | null {
  if (syntax === 'none' || text.length > MAX_CHARS) return null;
  try {
    const result =
      syntax === 'auto'
        ? hljs.highlightAuto(text)
        : hljs.highlight(text, { language: syntax, ignoreIllegals: true });
    return splitHighlighted(result.value);
  } catch {
    return null;
  }
}
