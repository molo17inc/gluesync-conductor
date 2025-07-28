import { RawComposeFile } from '../../../models/composeFile.model';
import readYmlFile from '../../file/readYmlFile/readYmlFile';
import parseComposeFile from '../parseComposeFile/parseComposeFile';

import { ReadComposeFile } from './readComposeFile.model';

const dkrComposeFile = process.env.DKR_COMPOSE_FILE || 'compose.agents.yml';

const readComposeFile: ReadComposeFile = async (
  filename = dkrComposeFile,
  { raw = false } = {},
) => {
  const composeData =
    (await readYmlFile<Partial<RawComposeFile>>(filename)) || {};

  return raw ? composeData : parseComposeFile(composeData);
};

export default readComposeFile;
