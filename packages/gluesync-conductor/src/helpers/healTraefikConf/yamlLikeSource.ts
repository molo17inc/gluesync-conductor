import {
  Document,
  ParsedNode,
  ToStringOptions,
  isMap,
  parseDocument,
} from 'yaml';

export type ParsedYaml = Document.Parsed<ParsedNode>;

/** The parsed document, or why the text is not a YAML mapping. */
export const parseYamlMapping = (text: string): ParsedYaml | string => {
  // Line ends come back in `renderLikeSource`: the document is always LF
  const doc = parseDocument(text.replaceAll('\r\n', '\n'));

  if (doc.errors.length > 0) {
    return `not valid YAML (${doc.errors[0].message.split('\n')[0]})`;
  }

  return isMap(doc.contents) ? doc : 'not a YAML mapping';
};

// Same layout as the file had, so only the nodes that changed show in a diff.
const writeOptions = (text: string): ToStringOptions => {
  const indent = /^( {2,8})\S/m.exec(text)?.[1].length ?? 2;
  const indentSeq = !/^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1- /m.test(text);
  // `[a, b]` as the file writes it, not `[ a, b ]`
  const flowCollectionPadding = !/[[{][^\s\]}]/.test(text);

  return { indent, indentSeq, flowCollectionPadding, lineWidth: 0 };
};

// The library puts a blank line before a comment that ends the document
const keepTrailingComment = (
  doc: Readonly<ParsedYaml>,
  original: string,
  output: string,
): string => {
  const block = doc.comment
    ?.split('\n')
    .map(line => `#${line}`)
    .join('\n');

  return block &&
    original.includes(`\n${block}`) &&
    !original.includes(`\n\n${block}`)
    ? output.replace(`\n\n${block}`, `\n${block}`)
    : output;
};

/**
 * The document as text, laid out like `original` (indent, list style, line
 * ends, a comment that ends the file) so that a change shows only where it is.
 */
export const renderLikeSource = (
  doc: Readonly<ParsedYaml>,
  original: string,
): string => {
  const output = keepTrailingComment(
    doc,
    original.replaceAll('\r\n', '\n'),
    doc.toString(writeOptions(original)),
  );

  return original.includes('\r\n')
    ? output.replaceAll(/\r?\n/g, '\r\n')
    : output;
};
