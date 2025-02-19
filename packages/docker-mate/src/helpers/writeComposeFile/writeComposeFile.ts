import { join } from 'path';
import { writeFile } from 'fs/promises';

import { stringify } from 'yaml';

import { ReadComposeFile } from './writeComposeFile.model';

const writeComposeFile: ReadComposeFile = async (
  json,
  filename = 'compose.yml',
) => {
  const parsedJson = stringify(json, { indent: 2 });

  const path = join(process.env.PROJECT_CWD as string, filename);

  await writeFile(path, parsedJson, 'utf8');

  return;
};

export default writeComposeFile;
