import { join } from 'path';

import { GetRootPath } from './getRootPath.model';

const getRootPath: GetRootPath = (filename = '') =>
  join(process.env.PROJECT_CWD || '', filename);

export default getRootPath;
