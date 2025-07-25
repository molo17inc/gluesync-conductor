import readYmlFile from '../../file/readYmlFile/readYmlFile';

import { ReadComposeFile } from './readComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const readComposeFile: ReadComposeFile = (filename = dkrComposeFile) =>
  readYmlFile(filename);

export default readComposeFile;
