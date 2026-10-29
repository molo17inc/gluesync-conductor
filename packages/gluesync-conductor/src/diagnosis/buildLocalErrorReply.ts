import { ComposeFileCorruptError } from '../helpers/composeFile/ensureValidCompose/composeFile.errors';
import describeFailure from '../helpers/describeFailure/describeFailure';
import {
  DiskFullError,
  isDiskFull,
} from '../helpers/file/safeWriteFile/safeWriteFile.errors';
import type { ErrorResponse, Require } from '../models/common.model';
import buildDiagnosis from './buildDiagnosis';
import { DiagnosisCode, DiagnosisParams } from './diagnosis.model';
import { DIAGNOSIS_CATALOG } from './diagnosisCatalog';

export type LocalErrorReply = Readonly<{
  statusCode: number;
  body: Require<ErrorResponse, 'diagnosis'>;
}>;

type LocalCause = Readonly<{ code: DiagnosisCode; params: DiagnosisParams }>;

const pathOf = (error: unknown): string | undefined => {
  const path = (error as { path?: unknown } | null)?.path;
  return typeof path === 'string' ? path : undefined;
};

// Only what the failing write knew goes in: a kernel ENOSPC carries no sizes.
const diskFullParams = (error: unknown): DiagnosisParams => {
  if (error instanceof DiskFullError) {
    return {
      path: error.path,
      neededBytes: error.needed,
      ...(error.available === undefined
        ? {}
        : { availableBytes: error.available }),
    };
  }
  const path = pathOf(error);
  return path === undefined ? {} : { path };
};

const classify = (error: unknown): LocalCause | undefined => {
  if (error instanceof ComposeFileCorruptError) {
    return {
      code: 'COMPOSE_FILE_CORRUPT',
      params: { path: error.path, problem: error.problem },
    };
  }
  return isDiskFull(error)
    ? { code: 'DISK_FULL', params: diskFullParams(error) }
    : undefined;
};

/**
 * Turns a failure of this install's own files (a full disk, a compose file
 * that is empty or corrupt) into the reply Conductor sends: the catalog's
 * status code, the structured `diagnosis`, and `details` with the raw cause.
 * `title` keeps the `error` text a route already used. Returns undefined when
 * the error is not one of these, so callers keep their existing handling.
 */
const buildLocalErrorReply = (
  error: unknown,
  title?: string,
): LocalErrorReply | undefined => {
  const cause = classify(error);

  if (!cause) {
    return undefined;
  }

  const diagnosis = buildDiagnosis(cause);

  return {
    statusCode: DIAGNOSIS_CATALOG[cause.code].httpStatus,
    body: {
      success: false,
      error: title ?? diagnosis.fallback.title,
      details: describeFailure(error),
      diagnosis,
    },
  };
};

export default buildLocalErrorReply;
