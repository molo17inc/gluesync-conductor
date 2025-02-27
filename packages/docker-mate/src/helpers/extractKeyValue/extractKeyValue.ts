import { ExtractKeyValue } from './extractKeyValue.model';

const castValue = (
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

  if (!isNaN(Number(lowerValue)) && lowerValue.trim() !== '') {
    return Number(lowerValue);
  }

  return lowerValue;
};

const extractKeyValue: ExtractKeyValue = array =>
  array.reduce<Partial<Record<string, any>>>((acc, entry) => {
    const match = entry.match(/^([\w\d_-]+)\s*[:=]\s*["']?([^"'\n]+)["']?.*$/);

    if (match) {
      const [, key, value] = match;
      acc[key.trim()] = castValue(value.trim());
    }

    return acc;
  }, {});

export default extractKeyValue;
