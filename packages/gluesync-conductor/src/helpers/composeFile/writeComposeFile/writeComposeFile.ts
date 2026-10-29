import writeYmlFile from '../../file/writeYmlFile/writeYmlFile';

import getRootPath from '../../getRootPath/getRootPath';
import {
  isMainComposeFile,
  refreshLastGoodFrom,
} from '../composeBackup/composeBackup';
import { WriteComposeFile } from './writeComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'docker-compose.yml';

const writeComposeFile: WriteComposeFile = async (
  json,
  filename = dkrComposeFile,
) => {
  await writeYmlFile(json, filename);

  // Only a compose file that was just written and verified becomes the last-good one.
  const path = getRootPath({ filename });
  if (isMainComposeFile(path)) {
    await refreshLastGoodFrom(path);
  }
};

export default writeComposeFile;
