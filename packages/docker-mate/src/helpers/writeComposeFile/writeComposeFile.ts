import writeYmlFile from '../writeYmlFile/writeYmlFile';

import { WriteComposeFile } from './writeComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const writeComposeFile: WriteComposeFile = async (
  json,
  filename = dkrComposeFile,
) => {
  await writeYmlFile(json, filename);

  return;
};

export default writeComposeFile;
