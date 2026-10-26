import { ComposeFile, RawComposeFile } from '../../../models/composeFile.model';
import getRootPath from '../../getRootPath/getRootPath';
import ensureValidCompose from '../ensureValidCompose/ensureValidCompose';
import parseComposeFile from '../parseComposeFile/parseComposeFile';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

// Overload 1: raw === true
export function readComposeFile(
  options: Readonly<{
    filename?: string;
    raw: true;
  }>,
): Promise<Partial<RawComposeFile>>;

// Overload 2: raw === false or undefined
export function readComposeFile(
  options?: Readonly<{
    filename?: string;
    raw?: false;
  }>,
): Promise<Partial<ComposeFile>>;

// Overload 3: fallback union type for implementation
export function readComposeFile(
  options?: Readonly<{
    filename?: string;
    raw?: boolean;
  }>,
): Promise<Partial<RawComposeFile> | Partial<ComposeFile>>;

export async function readComposeFile({
  filename = dkrComposeFile,
  raw = false,
}: { filename?: string; raw?: boolean } = {}): Promise<
  Partial<RawComposeFile> | Partial<ComposeFile>
> {
  // A missing file reads as empty; an empty or corrupt one is restored or throws.
  const composeData =
    ((await ensureValidCompose(getRootPath({ filename }))) as
      | Partial<RawComposeFile>
      | undefined) ?? {};

  return raw ? composeData : parseComposeFile(composeData);
}
