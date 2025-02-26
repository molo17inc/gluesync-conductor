import { readFile } from 'fs/promises';

import { parse } from 'yaml';

import { ReadYmlFile } from './readYmlFile.model';

import getRootPath from '../getRootPath/getRootPath';

const readYmlFile: ReadYmlFile = async filename => {
  const path = getRootPath(filename);

  const yamlFile = await readFile(path, 'utf8');

  return parse(yamlFile);
};

export default readYmlFile;
