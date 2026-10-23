/* eslint-disable no-underscore-dangle, global-require, import/no-dynamic-require, @typescript-eslint/no-var-requires -- hooks the CJS loader and requires the subject by path on purpose */
import Module from 'node:module';
import path from 'node:path';

type Load = (
  request: string,
  parent: Readonly<{ filename?: string }> | null,
  isMain: boolean,
) => unknown;

const loader = Module as unknown as { _load: Load };

const withoutExtension = (file: string): string =>
  file.replace(/\.(ts|js)$/, '').replace(/[/\\]index$/, '');

/**
 * Requires `subject` (absolute path) fresh, with some of its imports replaced.
 * Node's `mock.module` does not work under Yarn PnP, so this hooks the CJS
 * loader instead. A stub key is either a package name (`'docker-compose'`) or
 * an absolute path without extension; a TS default export is stubbed as
 * `{ default: fn }`. Only the subject's own imports are replaced.
 */
const loadWithStubs = <T>(
  subject: string,
  stubs: Readonly<Record<string, unknown>>,
): T => {
  const subjectFile = require.resolve(subject);
  const original = loader._load;
  const keys = new Map(
    Object.entries(stubs).map(([key, value]) => [
      path.isAbsolute(key) ? withoutExtension(key) : key,
      value,
    ]),
  );

  loader._load = function load(request, parent, isMain) {
    if (parent?.filename === subjectFile) {
      const key =
        request.startsWith('.') && parent.filename
          ? withoutExtension(
              path.resolve(path.dirname(parent.filename), request),
            )
          : request;
      if (keys.has(key)) {
        const stub = keys.get(key);
        return typeof stub === 'object' && stub !== null
          ? { __esModule: true, ...stub }
          : stub;
      }
    }
    return original.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[subjectFile];
    return require(subjectFile) as T;
  } finally {
    loader._load = original;
  }
};

export default loadWithStubs;
