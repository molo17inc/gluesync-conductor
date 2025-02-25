import { join } from 'path';
import { writeFile } from 'fs/promises';

import { stringify } from 'yaml';

import { WriteYmlFile } from './writeYmlFile.model';

const writeYmlFile: WriteYmlFile = async (json, filename) => {
  const parsedJson = stringify(json, { indent: 2 });

  const path = join(process.env.PROJECT_CWD as string, filename);

  await writeFile(path, parsedJson, 'utf8');

  return;
};

export default writeYmlFile;
