import fs from 'fs';
import path from 'path';
import getRootPath from '../getRootPath/getRootPath';
import { EnsureVolumeDirs } from './EnsureVolumeDirs.model';

const ensureVolumeDirs: EnsureVolumeDirs = async id => {
  const baseRoot = getRootPath();

  // Ensure all dirs are created under "<rootPath>/root-folder"
  const rootPath = path.join(baseRoot, 'root-folder');

  const logsDir = path.join(rootPath, 'logs', id);
  const dataDir = path.join(rootPath, 'data', id);

  [logsDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
};

export default ensureVolumeDirs;
