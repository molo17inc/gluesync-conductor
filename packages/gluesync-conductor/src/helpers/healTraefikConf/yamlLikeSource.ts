import { Document, ParsedNode, isMap, parseDocument } from 'yaml';

export type ParsedYaml = Document.Parsed<ParsedNode>;

/**
 * The parsed document, or why the text is not a YAML mapping. The text is
 * parsed as it is (CRLF included): the node ranges are offsets into it, which
 * is what the splicing in `yamlSplice` relies on. The document is only read,
 * never written back.
 */
export const parseYamlMapping = (text: string): ParsedYaml | string => {
  const doc = parseDocument(text);

  if (doc.errors.length > 0) {
    return `not valid YAML (${doc.errors[0].message.split('\n')[0]})`;
  }

  return isMap(doc.contents) ? doc : 'not a YAML mapping';
};
