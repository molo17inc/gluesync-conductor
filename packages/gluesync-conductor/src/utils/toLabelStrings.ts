const toLabelStrings = (
  labels: Readonly<object> | ReadonlyArray<string> | undefined,
): ReadonlyArray<string> => {
  if (!labels) {
    return [];
  }

  if (Array.isArray(labels)) {
    // Compose array form: ['key=value', ...]
    return labels.filter((l): l is string => typeof l === 'string');
  }

  if (typeof labels === 'object') {
    // Compose map form: { key: value, ... } -> ['key=value', ...]
    return Object.entries(labels as Record<string, unknown>).map(
      ([k, v]) => `${k}=${v}`,
    );
  }

  return [];
};

export default toLabelStrings;
