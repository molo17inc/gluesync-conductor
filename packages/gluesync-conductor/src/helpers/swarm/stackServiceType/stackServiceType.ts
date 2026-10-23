import { LabelPrefix } from '../../../models/composeFile.model';
import toLabelStrings from '../../../utils/toLabelStrings';
import parseServiceType from '../../composeFile/parseServiceType/parseServiceType';
import inferServiceType from '../../inferServiceType/inferServiceType';
import {
  DeclaredStackServiceType,
  StackServiceType,
} from './stackServiceType.model';

const TYPE_PREFIX = `${LabelPrefix.CONDUCTOR}.type=`;

const typeIn = (
  labels: Parameters<typeof toLabelStrings>[0],
): ReturnType<DeclaredStackServiceType> => {
  const entry = toLabelStrings(labels).find(label =>
    label.startsWith(TYPE_PREFIX),
  );

  return entry ? parseServiceType(entry.slice(TYPE_PREFIX.length)) : null;
};

export const declaredStackServiceType: DeclaredStackServiceType = service =>
  typeIn(service?.labels) ?? typeIn(service?.deploy?.labels);

const stackServiceType: StackServiceType = (id, service) =>
  declaredStackServiceType(service) ??
  inferServiceType(id, service?.image) ??
  undefined;

export default stackServiceType;
