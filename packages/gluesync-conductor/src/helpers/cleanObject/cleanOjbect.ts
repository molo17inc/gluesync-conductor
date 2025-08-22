const cleanObject = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj
      .map(cleanObject)
      .filter(
        item =>
          item !== null &&
          item !== undefined &&
          !(typeof item === 'object' && Object.keys(item).length === 0),
      );
  }

  if (typeof obj === 'object' && obj !== null) {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const cleaned = cleanObject(value);
      if (
        cleaned !== null &&
        cleaned !== undefined &&
        !(typeof cleaned === 'object' && Object.keys(cleaned).length === 0)
      ) {
        return { ...acc, [key]: cleaned };
      }
      return acc;
    }, {});
  }

  return obj;
};

export default cleanObject;
