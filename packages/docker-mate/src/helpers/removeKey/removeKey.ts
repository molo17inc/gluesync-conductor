const removeKey = <T extends Record<string, any>>(
  obj: T,
  key: string,
): Omit<T, keyof T> => {
  // eslint-disable-next-line
  const { [key]: _, ...rest } = obj;

  return rest;
};

export default removeKey;
