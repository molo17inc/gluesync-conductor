import { conductorLabels } from '../../../models/conductor.model';
import { LabelPrefix } from '../../../models/composeFile.model';

import { GetCustomLabels } from './getCustomLabels.model';

const getCustomLabels: GetCustomLabels = labels =>
  conductorLabels.reduce(
    (acc, label) => ({
      ...acc,
      [label]: labels[`${LabelPrefix.CONDUCTOR}.${label}`] || undefined,
    }),
    {},
  );

export default getCustomLabels;
