import { readFile } from 'fs/promises';
import { parse } from 'yaml';

import { ReadYmlFile } from './readYmlFile.model';

import getRootPath from '../../getRootPath/getRootPath';

const readYmlFile: ReadYmlFile = async filename => {
  const path = getRootPath({ filename });

  try {
    const yamlFile = await readFile(path, 'utf8');
    return parse(yamlFile);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
};

export default readYmlFile;
