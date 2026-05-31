const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const base = __dirname;
const htmlPath = path.join(base, "index.html");
const mainPath = path.join(base, "personal-best.typ");

const html = fs.readFileSync(htmlPath, "utf8");
// Convert the HTML source directly to Typst with pandoc, so index.html stays the
// single source of truth and the two formats remain consistent. (Requires pandoc
// on PATH.)
let body = execFileSync("pandoc", [htmlPath, "-f", "html", "-t", "typst"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const coverFile = "Cover.jpg";

function htmlTextToTypst(text) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseStyle(style) {
  const out = {};
  for (const part of style.split(";")) {
    const [key, ...value] = part.split(":");
    if (!key || !value.length) continue;
    out[key.trim().toLowerCase()] = value.join(":").trim();
  }
  return out;
}

function pxToPt(value, fallback) {
  const match = String(value || "").match(/([\d.]+)px/i);
  if (!match) return fallback;
  return `${(Number(match[1]) * 0.75).toFixed(2).replace(/\.?0+$/, "")}pt`;
}

function inlineStyledParagraphs() {
  const re = /<p\b(?=[^>]*\bstyle="([^"]+)")[^>]*>([\s\S]*?)<\/p>/gi;
  const out = [];
  for (const match of html.matchAll(re)) {
    const text = htmlTextToTypst(match[2]);
    if (text) out.push({ text, style: parseStyle(match[1]) });
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceStandaloneLine(text, replacement) {
  body = body.replace(new RegExp(`(^|\\r?\\n)${escapeRegExp(text)}(?=\\r?\\n|$)`, "g"), `$1${replacement}`);
}

function firstStyleWidth(selectorRe, fallback) {
  const match = html.match(selectorRe);
  if (!match) return fallback;
  return parseStyle(match[1]).width || fallback;
}

const reviewsWidth = firstStyleWidth(/<div\b[^>]*style="([^"]*width:[^"]*)"[^>]*>\s*<p>若干年后/, "70%");
const imageWidths = new Map();
for (const match of html.matchAll(/<img\b([^>]*\bsrc="([^"]+)"[^>]*)>/gi)) {
  const attrs = match[1];
  const src = match[2];
  const styleMatch = attrs.match(/\bstyle="([^"]+)"/i);
  if (!styleMatch) continue;
  const width = parseStyle(styleMatch[1]).width;
  if (width) imageWidths.set(src, pxToPt(width, width));
}

// Drop the HTML title-page block from Pandoc output. The PDF uses a dedicated
// image-only cover page, followed by the generated outline and book content.
function consumeBracketed(text, start) {
  const open = text.indexOf("[", start);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

if (body.startsWith("#block[")) {
  const end = consumeBracketed(body, 0);
  if (end > 0) body = body.slice(end).trimStart();
}

let reviews = "";
const firstHeading = body.search(/\n= /);
if (firstHeading > 0) {
  reviews = body.slice(0, firstHeading).trim();
  body = body.slice(firstHeading + 1).trimStart();
}

let authorBio = "";
if (reviews.startsWith("#block[")) {
  const end = consumeBracketed(reviews, 0);
  if (end > 0) reviews = reviews.slice("#block[".length, end - 1).trim();
}
const authorSplit = reviews.indexOf("#horizontalrule");
if (authorSplit >= 0) {
  authorBio = reviews.slice(authorSplit + "#horizontalrule".length).trim();
  reviews = reviews.slice(0, authorSplit).trim();
}

// The praise quotes were separated by standalone <br/> -> lone "\" lines, which
// made every quote a continuation line and suppressed its first-line indent.
// Drop those so each quote is a clean, indentable paragraph.
reviews = reviews
  .replace(/^[ \t]*\\[ \t]*$/gm, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

// The author bio is one paragraph joined by "\" line breaks (legacy <br/>).
// Split it into separate paragraphs: the first stays unindented, the rest
// indent like normal body text.
authorBio = authorBio.replace(/ +\\ +/g, "\n\n");

// HTML div.box is emitted as #block[...]. The title-page block was removed
// above, so the remaining block calls are book callout boxes.
body = body.replaceAll("#block[", "#bookbox[");
body = body.replace(/#bookbox\[\s*\n#strong\[([^\]\n]+)\]/g, "#bookbox[\n#boxtitle[$1]");

// Keep existing images only. Missing images are represented by their captions
// so Typst does not fail compilation.
body = body.replace(
  /#figure\(image\("([^"]+)"(?:,\s*alt:\s*"([^"]*)")?\),\s*\n\s*caption:\s*\[\s*([^\]]*?)\s*\]\s*\)/gs,
  (match, src, alt, caption) => {
    const normalized = src.replaceAll("/", path.sep);
    const exists = fs.existsSync(path.join(base, normalized));
    const cap = (caption || alt || "").trim();
    if (exists) {
      return `#bookimage("${src}", ${imageWidths.get(src) ? imageWidths.get(src) : "82%"}, [${cap}])`;
    }
    return cap ? `#missing-image([${cap}])` : "";
  }
);

// Remove empty strong markers generated by malformed <b><ul> combinations.
body = body.replaceAll("#strong[]\n", "");
body = body.replaceAll("李开夏", "李开复");
body = body.replace(/^= /gm, "#pagebreak(weak: true)\n= ");
body = body.replace(/#bookbox\[\s*\n#pagebreak\(weak: true\)\s*\n= /g, "#bookbox[\n= ");

const styledParas = inlineStyledParagraphs();
for (const { text } of styledParas.filter((item) => (item.style["text-align"] || "").toLowerCase() === "right")) {
  replaceStandaloneLine(text, `#rightline[${text}]`);
}
for (const { text, style } of styledParas.filter((item) => (item.style["text-align"] || "").toLowerCase() !== "right")) {
  const align = (style["text-align"] || "").toLowerCase();
  const indent = (style["text-indent"] || "").replace(/\s+/g, "");
  const marginLeft = style["margin-left"];
  if (align === "center") {
    replaceStandaloneLine(text, `#centerline[${text}]`);
  } else if (indent === "0em" || indent === "0") {
    replaceStandaloneLine(text, `#noindentline[${text}]`);
  } else if (marginLeft) {
    replaceStandaloneLine(text, `#indentblock(${marginLeft})[${text}]`);
  }
}

body = body.replace(
  /#horizontalrule\s*\r?\n\s*#figure\(\s*\r?\n\s*align\(center\)\[#table\(\s*\r?\n\s*columns: \(50%, 50%\),\s*\r?\n\s*align: \(auto,auto,\),/,
  '#copyrightpage[\n#table(\n    columns: (50%, 50%),\n    stroke: none,\n    align: left,'
);
body = body.replace(
  /#copyrightpage\[\s*\r?\n#table\(\s*\r?\n\s*columns: \(50%, 50%\),/,
  '#copyrightpage[\n#table(\n    columns: (7em, auto),'
);
body = body.replace(/\s*\)\]\s*\r?\n\s*, kind: table\s*\r?\n\s*\)\s*$/s, "\n)]");
body = body.replace(
  /#pagebreak\(weak: true\)\s*\r?\n= 第1章/,
  `#pagebreak()\n#set page(\n  paper: "a4",\n  margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),\n  numbering: "1",\n  footer: context align(center)[#counter(page).display("1")]\n)\n#counter(page).update(1)\n= 第1章`
);

// The 代序 signature and its date are plain <p> in the HTML (no text-align),
// so they were not caught by the styled-paragraph pass above. Right-align them.
replaceStandaloneLine("宋健", "#rightline[宋健]");
replaceStandaloneLine("2005年7月15日", "#rightline[2005年7月15日]");

// The back-cover best.png figure carries a #strong caption, so the generic
// figure regex skipped it. Route it through the dedicated full-page layout.
body = body.replace(
  /#figure\(image\("best\.png"\),\s*\r?\n\s*caption:\s*\[([\s\S]*?)\]\s*\r?\n\)/,
  (_match, caption) => {
    const text = caption.trim().replace(/^#strong\[([\s\S]*)\]$/, "$1").trim();
    return `#bookimage("best.png", 82%, [${text}])`;
  }
);

// Tables: body cells left-aligned, header cells centered + bold, compact.
body = body.replace(/align: \((?:auto,)+\),/g, "align: left,");
body = body.replace(/table\.header\(([\s\S]*?)\),/g, (_match, inner) => {
  let styled = inner.replace(
    /table\.cell\(([^)\]]*)\)\[([\s\S]*?)\]/g,
    (_m, attrs, content) => {
      const base = attrs.replace(/,\s*$/, "").trim();
      return `table.cell(${base}, align: center)[#text(weight: "bold")[${content}]]`;
    }
  );
  styled = styled.replace(
    /(^|,)(\s*)\[([\s\S]*?)\](\s*)(?=,|$)/g,
    (_m, pre, lead, content, tail) =>
      `${pre}${lead}table.cell(align: center)[#text(weight: "bold")[${content}]]${tail}`
  );
  return `table.header(${styled}),`;
});

// Standalone 图/表 caption paragraphs that follow a table become figure captions.
body = body.replace(
  /(kind: table\s*\)\s*)((?:图|表)\d[^\r\n]*)/g,
  "$1#figcaption[$2]"
);

// Split the preface (代序 + 自序) off the front of the body so it can be placed
// before the table of contents. The first non-weak #pagebreak() is the page
// setup that introduces 第1章, i.e. the boundary between preface and main text.
const chapterStart = body.indexOf("= 第1章");
const setupStart = body.lastIndexOf("#pagebreak()", chapterStart);
const preface = body.slice(0, setupStart).trim();
const mainBody = body.slice(setupStart);

const main = String.raw`#let body-font = ("FZShuSong-Z01", "FangSong_GB2312", "SimSun")
#let title-font = ("FZHei-B01", "SimHei", "Microsoft YaHei")

#set page(
  paper: "a4",
  margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),
  footer: context align(center)[#counter(page).display("1")]
)
// Normalize the line box to exactly 1em so paragraph leading maps directly to a
// Word-style "N倍行高": line advance = 1em + leading. leading 1em => 2x.
#set text(font: body-font, size: 14pt, lang: "zh", top-edge: 0.8em, bottom-edge: -0.2em)
#set par(justify: true, first-line-indent: (amount: 2em, all: true), leading: 1em, spacing: 2em)
#set list(indent: 1.5em, body-indent: 0.7em, marker: text(size: 1.3em)[•])
#set enum(indent: 1.5em, body-indent: 0.7em)
#set table(inset: (x: 0.5em, y: 0.4em), stroke: 0.5pt + rgb("#c9c4b8"))
#set figure(numbering: none)

#show heading: it => {
  set text(font: title-font, weight: "regular")
  set par(first-line-indent: 0pt, justify: false)
  if it.level == 1 {
    v(0.4em)
    align(center)[#text(size: 25pt, it.body)]
    v(0.8em)
  } else if it.level == 2 {
    v(1.0em)
    align(center)[#text(size: 20pt, fill: rgb("#8a4b2a"), it.body)]
    v(0.35em)
  } else {
    v(0.8em)
    align(center)[#text(size: 16pt, it.body)]
    v(0.25em)
  }
}

#show strong: it => text(font: title-font, fill: rgb("#8a4b2a"), weight: "bold", it.body)

#let boxtitle(body) = {
  set par(first-line-indent: 0pt, justify: false)
  align(center)[#text(font: title-font, size: 15pt, weight: "bold", body)]
  v(0.25em)
}

#let bookbox(body) = block(
  width: 100%,
  inset: (x: 1.1em, y: 0.8em),
  outset: (y: 0.35em),
  radius: 6pt,
  stroke: 0.7pt + rgb("#d0cbc2"),
  fill: rgb("#f1f0ec"),
  breakable: true,
)[
  #set par(first-line-indent: 2em, justify: true, leading: 1em, spacing: 2em)
  #body
]

#let bookimage(src, width, caption) = {
  if src == "best.png" {
    pagebreak()
    set page(
      paper: "a4",
      margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),
      footer: none
    )
    align(horizon + center)[
      #block(width: 100%)[
        #align(center)[#image(src, width: width)]
        #v(0.7em)
        #set par(first-line-indent: 0pt, justify: false)
        #align(center)[#text(font: title-font, size: 11pt, weight: "bold", caption)]
      ]
    ]
  } else {
    figure(
      block(width: 100%)[
        #align(center)[#image(src, width: width)]
      ],
      caption: caption,
    )
  }
}

#let missing-image(caption) = {
  set par(first-line-indent: 0pt, justify: false)
  align(center)[#text(size: 0.8em, fill: rgb("#6b6b6b"), caption)]
}

#let figcaption(body) = {
  set par(first-line-indent: 0pt, justify: false)
  align(center)[#text(size: 0.8em, body)]
}

#show figure.caption: it => {
  set par(first-line-indent: 0pt, justify: false)
  align(center)[#text(size: 0.8em, it.body)]
}

#let horizontalrule = line(length: 100%, stroke: 0.5pt + rgb("#d9d4c5"))

#let rightline(body) = {
  set par(first-line-indent: 0pt, justify: false)
  align(right)[#body]
}

#let centerline(body) = {
  set par(first-line-indent: 0pt, justify: false)
  align(center)[#body]
}

#let noindentline(body) = {
  set par(first-line-indent: 0pt, justify: true)
  body
}

#let indentblock(amount, body) = {
  set par(first-line-indent: 0pt, justify: true)
  block(inset: (left: amount), width: 100%)[#body]
}

#let copyrightpage(body) = {
  pagebreak()
  set page(
    paper: "a4",
    margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),
    footer: none
  )
  set text(size: 10.5pt)
  set par(first-line-indent: 0pt, justify: false, leading: 0.55em)
  block(width: 82%)[#body]
}

#let cover-page = {
  set page(margin: 0mm, footer: none)
  place(top + left, image("${coverFile}", width: 100%, height: 100%, fit: "contain"))
  pagebreak()
}

#cover-page

#set page(
  paper: "a4",
  margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),
  footer: none
)

#align(horizon)[
  #block(width: 90%)[
    #set par(justify: true, first-line-indent: (amount: 2em, all: true), leading: 1em, spacing: 2em)
    ${reviews}
  ]
]
#pagebreak()

#align(horizon)[
  #block(width: 90%)[
    #set par(justify: true, first-line-indent: 2em, leading: 1em, spacing: 2em)
    ${authorBio}
  ]
]
#pagebreak()

#set page(
  paper: "a4",
  margin: (top: 24mm, bottom: 20mm, left: 22mm, right: 22mm),
  numbering: "i",
  footer: context align(center)[#counter(page).display("i")]
)
#counter(page).update(1)

#set par(justify: true, first-line-indent: (amount: 2em, all: true), leading: 1em, spacing: 2em)
${preface}

#pagebreak()
#set par(first-line-indent: 0pt, justify: false)
#align(center)[#text(font: title-font, size: 26pt)[目录]]
#v(1em)
#outline(title: none, depth: 3, indent: auto)

#set par(justify: true, first-line-indent: (amount: 2em, all: true), leading: 1em, spacing: 2em)
`;

fs.writeFileSync(mainPath, main + "\n" + mainBody, "utf8");
