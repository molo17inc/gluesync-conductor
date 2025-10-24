import { join } from 'path';

import { GetRootPath } from './getRootPath.model';

const getRootPath: GetRootPath = options =>
  join(
    process.env.PROJECT_CWD || options?.basePath || '',
    options?.filename || '',
  );

export default getRootPath;
