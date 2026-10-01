// 无第三方依赖的轻量词法着色器。仅由 code-highlight.ts 动态加载。
// 面向代码阅读，不执行源码，也不自动猜测语言；不模拟完整编译器语法树。
const keywordSets: Record<string, Set<string>> = {
  javascript: words("async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof var void while with yield"),
  typescript: words("abstract any as assert asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number of override private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield"),
  bash: words("if then else elif fi for while until do done case esac in function select time coproc export local readonly declare typeset source return exit break continue"),
  python: words("and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield"),
  css: words("important inherit initial unset revert auto none block flex grid relative absolute fixed sticky"),
  yaml: words("true false null yes no on off"),
  ini: words("true false"),
  sql: words("select from where insert into update delete create alter drop table join left right inner outer full cross on as and or not null is in exists between like union all distinct group by having order asc desc limit offset values set case when then else end count sum avg min max with recursive primary foreign key references index view begin commit rollback returning over partition cast true false"),
  go: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil"),
  rust: words("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while"),
  json: words("true false null"),
};

function words(text: string): Set<string> { return new Set(text.split(" ")); }
function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function span(kind: string, text: string): string {
  return `<span class="hljs-${kind}">${escape(text)}</span>`;
}

// 各候选模式按单次前进扫描；不使用带嵌套量词的模式。
const quoted = /"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?/.source;
const template = /`(?:\\[\s\S]|[^`\\])*`?/.source;
const triple = /"""[\s\S]*?(?:"""|$)|\x27\x27\x27[\s\S]*?(?:\x27\x27\x27|$)/.source;
const blockComment = /\/\*[\s\S]*?(?:\*\/|$)/.source;
const number = /\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:n|f32|f64|u\d+|i\d+)?\b/.source;
const identifier = /[$A-Za-z_][$\w]*\b/.source;

export function highlight(text: string, language: string): string {
  if (language === "diff") {
    return text.split(/(?<=\n)/).map((line) => {
      const kind = /^(?:@@|diff |index |---|\+\+\+)/.test(line) ? "meta"
        : line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : null;
      return kind ? span(kind, line) : escape(line);
    }).join("");
  }
  if (language === "markdown") {
    return replaceTokens(text, /^(?:#{1,6}[^\n]*|>[^\n]*)|`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\n)]+\)/gm,
      (token) => token.startsWith("#") ? "title" : token.startsWith(">") ? "quote" : "string");
  }
  if (language === "xml") {
    return replaceTokens(text, /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][^>]*(?:>|$)|&[\w#]+;/g,
      (token) => token.startsWith("<!--") ? "comment" : "name");
  }
  const hashComments = ["bash", "python", "yaml", "ini"].includes(language);
  const slashComments = ["javascript", "typescript", "go", "rust"].includes(language);
  const patterns = [
    ...(language === "python" ? [triple] : []),
    quoted,
    ...(["javascript", "typescript", "go", "bash"].includes(language) ? [template] : []),
    ...(!hashComments && language !== "json" ? [blockComment] : []),
    ...(hashComments ? [/#[^\n]*/.source] : []),
    ...(slashComments ? [/\/\/[^\n]*/.source] : []),
    ...(language === "sql" ? [/--[^\n]*/.source] : []),
    ...(language === "ini" ? [/^[ \t]*[;#][^\n]*|^\[[^\]\n]+\]/.source] : []),
    ...(language === "css" ? [/#[\da-fA-F]{3,8}\b|[.@][A-Za-z_-][\w-]*/.source] : []),
    ...(language === "bash" ? [/\$\{[^}\n]*\}|\$[A-Za-z_][\w]*|\$[\d?@#]/.source] : []),
    number, identifier,
  ];
  const keywords = keywordSets[language];
  return replaceTokens(text, new RegExp(patterns.join("|"), "gm"), (token, end) => {
    if (/^(?:#|\/\/|\/\*|--|[ \t]*;)/.test(token) && language !== "css") return "comment";
    if (/^["'`]/.test(token)) {
      return language === "json" && /^\s*:/.test(text.slice(end)) ? "attr" : "string";
    }
    if (/^\d/.test(token) || (language === "css" && token.startsWith("#"))) return "number";
    if (keywords?.has(language === "sql" ? token.toLowerCase() : token)) return "keyword";
    if ((language === "yaml" || language === "ini" || language === "css") && /^\s*[:=]/.test(text.slice(end))) return "attr";
    if (language === "ini" && token.trimStart().startsWith("[")) return "meta";
    if (language === "css" && /^[.@]/.test(token)) return "selector-class";
    if (token.startsWith("$")) return "name";
    if (/^\s*\(/.test(text.slice(end))) return "title";
    return null;
  });
}

function replaceTokens(text: string, pattern: RegExp, classify: (token: string, end: number) => string | null): string {
  let position = 0;
  const out: string[] = [];
  for (const match of text.matchAll(pattern)) {
    out.push(escape(text.slice(position, match.index)));
    position = match.index + match[0].length;
    const kind = classify(match[0], position);
    out.push(kind ? span(kind, match[0]) : escape(match[0]));
  }
  out.push(escape(text.slice(position)));
  return out.join("");
}
