import { join } from 'path';
import { readFile } from 'fs/promises';

import { parse } from 'yaml';

import { ReadYmlFile } from './readYmlFile.model';

const readYmlFile: ReadYmlFile = async filename => {
  const path = join(process.env.PROJECT_CWD as string, filename);

  const yamlFile = await readFile(path, 'utf8');

  return parse(yamlFile);
};

export default readYmlFile;
