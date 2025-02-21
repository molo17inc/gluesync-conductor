const removeKey = <T extends Record<string, any>>(
  obj: T,
  key: string,
): Omit<T, keyof T> => {
  const { [key]: _, ...rest } = obj;

  return rest;
};

export default removeKey;
