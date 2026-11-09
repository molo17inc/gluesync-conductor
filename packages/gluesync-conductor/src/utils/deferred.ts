/* eslint-disable functional/no-let -- the resolver is only reachable from inside the promise executor */

// eslint-disable-next-line functional/no-mixed-types
export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

/** A promise that is settled from outside; settling it twice keeps the first value. */
export const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolver => {
    resolve = resolver;
  });

  return { promise, resolve };
};

export default deferred;
