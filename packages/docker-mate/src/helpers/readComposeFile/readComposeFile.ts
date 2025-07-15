import readYmlFile from '../readYmlFile/readYmlFile';

import { ReadComposeFile } from './readComposeFile.model';
import { ComposeFile } from '../../models/composeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const readComposeFile: ReadComposeFile = (filename = dkrComposeFile) =>
  readYmlFile<ComposeFile>(filename);

export default readComposeFile;
