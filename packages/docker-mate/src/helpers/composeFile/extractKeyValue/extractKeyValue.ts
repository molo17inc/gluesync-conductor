import { CastObject, ExtractKeyValue } from './extractKeyValue.model';

export const castValue = (
  value: any,
): string | boolean | number | null | undefined => {
  const lowerValue = String(value).toLowerCase();

  if (lowerValue === 'true') {
    return true;
  }

  if (lowerValue === 'false') {
    return false;
  }

  if (lowerValue === 'null') {
    return null;
  }

  if (lowerValue === 'undefined') {
    return undefined;
  }

  const num = Number(lowerValue);

  return !isNaN(num) && lowerValue.trim() !== '' ? num : value;
};

export const castObject: CastObject = <T = Record<string, any>>(
  object: Record<string, any>,
) =>
  Object.entries(object).reduce(
    (acc, [key, value]) => ({
      ...acc,
      [key]: castValue(value),
    }),
    {},
  ) as T;

const extractKeyValue: ExtractKeyValue = (separator, array = []) =>
  array.reduce((acc, entry) => {
    const trimmedEntry = entry.trim();

    // Find the first separator in the entry
    const sepIndex = trimmedEntry.indexOf(separator);

    if (sepIndex === -1) {
      // If the separator doesn't exist, ignore the entry (or you can throw an error)
      return acc;
    }

    const key = trimmedEntry.slice(0, sepIndex).trim();
    const value = castValue(trimmedEntry.slice(sepIndex + 1).trim());

    return {
      ...acc,
      [key]: value,
    };
  }, {});

export default extractKeyValue;
