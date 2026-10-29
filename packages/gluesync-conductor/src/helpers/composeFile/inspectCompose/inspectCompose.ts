import { parse } from 'yaml';
import { InspectCompose } from './inspectCompose.model';

const isMapping = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const bad = (problem: string) => ({ problem });

/**
 * Tells a usable compose file from what a full disk or a killed write leaves
 * behind: empty, `null`, a list, cut-off YAML, or no services at all.
 */
const inspectCompose: InspectCompose = text => {
  if (text.trim() === '') {
    return bad('the file is empty');
  }

  const value = (() => {
    try {
      return { parsed: parse(text) as unknown };
    } catch (error) {
      return {
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  })();

  if ('failure' in value) {
    return bad(`not valid YAML: ${value.failure}`);
  }
  if (!isMapping(value.parsed)) {
    return bad('the top level is not a mapping');
  }
  if (!isMapping(value.parsed.services)) {
    return bad('there is no services section');
  }
  if (Object.keys(value.parsed.services).length === 0) {
    return bad('services is empty');
  }
  return { problem: null, value: value.parsed };
};

export default inspectCompose;
