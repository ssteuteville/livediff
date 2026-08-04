/**
 * Per-line syntax highlighting for the virtualized renderer.
 *
 * The classic renderer highlights whole files up front, which is most of why it costs a megabyte
 * and seconds of blocking work. Here only the rows on screen are ever highlighted — roughly sixty
 * — so the grammar can be fetched on demand and the work is small enough to do synchronously
 * during render.
 *
 * Highlighting is per line rather than per file: a virtualized view cannot highlight a file it has
 * not parsed, and parsing 20,000 lines to draw 60 defeats the point. The cost is that constructs
 * spanning lines — block comments, template literals — are coloured as if each line stood alone.
 */

import { MAX_HIGHLIGHT_LINE_CHARS } from "../shared/constants.ts";

const CORE = () => import("highlight.js/lib/core");

// hljs ships no grammar under these names; they are dialects of one it does ship.
const ALIAS = { jsx: "javascript", tsx: "typescript", vue: "xml" };

// Static specifiers so the bundler can see every grammar and split it into its own chunk. A
// computed import() would make it bundle all of highlight.js or none of it.
const GRAMMARS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/** One coloured run of a line. `cls` is a highlight.js token class, or "" for plain text. */
export interface Token {
  text: string;
  cls: string;
}

type GrammarName = keyof typeof GRAMMARS;
type Hljs = Awaited<ReturnType<typeof CORE>>["default"];

let hljs: Hljs | null = null;
const ready = new Set<GrammarName>();
const loading = new Map<GrammarName, Promise<boolean>>();

const isGrammar = (name: string): name is GrammarName => name in GRAMMARS;

/** The grammar name to register, or null when nothing can highlight this file. */
export function grammarFor(lang: string | undefined | null): GrammarName | null {
  if (!lang) return null;
  const name = ALIAS[lang as keyof typeof ALIAS] ?? lang;
  return isGrammar(name) ? name : null;
}

export function isReady(lang: string | undefined | null): boolean {
  const name = grammarFor(lang);
  return name !== null && ready.has(name);
}

/**
 * Fetch and register a grammar. Resolves true if the caller should re-render because something
 * newly became highlightable, false if there was nothing to do.
 */
export async function loadGrammar(lang: string | undefined | null): Promise<boolean> {
  const name = grammarFor(lang);
  if (!name || ready.has(name)) return false;
  const inFlight = loading.get(name);
  if (inFlight) return inFlight;

  const task = (async () => {
    const [core, grammar] = await Promise.all([
      hljs ? { default: hljs } : CORE(),
      GRAMMARS[name](),
    ]);
    hljs = core.default;
    hljs.registerLanguage(name, grammar.default as never);
    ready.add(name);
    loading.delete(name);
    return true;
  })().catch(() => {
    loading.delete(name);
    return false;
  });

  loading.set(name, task);
  return task;
}

// hljs emits HTML; the renderer needs tokens, so it can split one for a search match without
// re-parsing. The browser's own parser is the only correct reader of that HTML.
const scratch = typeof document === "undefined" ? null : document.createElement("div");

function toTokens(html: string, into: HTMLDivElement): Token[] {
  into.innerHTML = html;
  const tokens: Token[] = [];
  const walk = (node: Node, cls: string) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.nodeValue) tokens.push({ text: child.nodeValue, cls });
      } else {
        walk(child, (child as Element).className || cls);
      }
    }
  };
  walk(into, "");
  into.textContent = "";
  return tokens;
}

// Highlighting the same line twice is common — scrolling back, or a refetch that changed one file.
// Bounded so a long session cannot grow without limit.
const CACHE_LIMIT = 4000;
const cache = new Map<string, Token[]>();

/**
 * Tokenize one line, or return null when the grammar is not loaded yet and the caller should
 * render plain text. Never throws: a grammar that chokes on a line degrades to plain text.
 */
export function tokenize(text: string, lang: string | undefined | null): Token[] | null {
  const name = grammarFor(lang);
  if (!name || !ready.has(name) || !scratch || !hljs || !text) return null;
  // One row's token count is otherwise unbounded, which is how a single minified line put 40,058
  // nodes on the page. Null here means the caller renders one plain text node.
  if (text.length > MAX_HIGHLIGHT_LINE_CHARS) return null;

  const key = name + "\u0000" + text;
  const hit = cache.get(key);
  if (hit) return hit;

  let tokens: Token[];
  try {
    tokens = toTokens(
      hljs.highlight(text, { language: name, ignoreIllegals: true }).value,
      scratch,
    );
  } catch {
    return null;
  }

  const oldest = cache.keys().next().value;
  if (cache.size >= CACHE_LIMIT && oldest !== undefined) cache.delete(oldest);
  cache.set(key, tokens);
  return tokens;
}
