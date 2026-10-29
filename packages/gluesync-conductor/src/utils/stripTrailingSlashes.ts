// Not a `/\/+$/` replace: that one is quadratic on a long run of slashes
const stripTrailingSlashes = (value: string): string =>
  value.slice(0, value.split('').findLastIndex(char => char !== '/') + 1);

export default stripTrailingSlashes;
