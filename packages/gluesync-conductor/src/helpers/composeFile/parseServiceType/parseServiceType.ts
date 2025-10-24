import { conductorServiceTypes } from '../../../models/conductor.model';
import { ParseServiceType } from './parseServiceType.model';

const parseServiceType: ParseServiceType = value =>
  conductorServiceTypes.includes(value) ? value : null;

export default parseServiceType;
