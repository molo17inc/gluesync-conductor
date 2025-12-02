import fs from 'fs';
import path from 'path';
import getRootPath from '../getRootPath/getRootPath';
import { readComposeFile } from '../composeFile/readComposeFile/readComposeFile';
import {
  RawComposeFile,
  RawComposeService,
} from '../../models/composeFile.model';
import { EnsureVolumeDirs } from './EnsureVolumeDirs.model';

const ensureVolumeDirs: EnsureVolumeDirs = async id => {
  const composeJson: RawComposeFile = await readComposeFile({ raw: true });
  const service: RawComposeService | undefined = composeJson.services?.[id];

  if (!service?.container_name) return;

  const rootPath = getRootPath({ basePath: process.env.BASE_PATH });
  const logsDir = path.join(rootPath, 'logs', service.container_name);
  const dataDir = path.join(rootPath, 'data', service.container_name);

  [logsDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

export default ensureVolumeDirs;
