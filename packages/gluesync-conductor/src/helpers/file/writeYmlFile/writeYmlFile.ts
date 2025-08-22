import { writeFile } from 'fs/promises';

import { stringify } from 'yaml';

import { WriteYmlFile } from './writeYmlFile.model';

import getRootPath from '../../getRootPath/getRootPath';

const writeYmlFile: WriteYmlFile = async (json, filename) => {
  const parsedJson = stringify(json, { indent: 2 });

  const path = getRootPath(filename);

  await writeFile(path, parsedJson, 'utf8');
};

export default writeYmlFile;
