import { join } from 'path';
import { readFile } from 'fs/promises';

import { parse } from 'yaml';

import { ReadComposeFile } from './readComposeFile.model';

const readComposeFile: ReadComposeFile = async (filename = 'compose.yml') => {
  const path = join(process.env.PROJECT_CWD as string, filename);

  const yamlFile = await readFile(path, 'utf8');

  return parse(yamlFile);
};

export default readComposeFile;
