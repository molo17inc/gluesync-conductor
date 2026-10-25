/**
 * Runs `fn` on each item one after the other (for work that must not run
 * concurrently, like compose commands on the same project) and resolves to
 * the results in order.
 */
const inSequence = <T, R>(
  items: ReadonlyArray<T>,
  fn: (item: T, index: number) => Promise<R>,
): Promise<ReadonlyArray<R>> =>
  items.reduce<Promise<ReadonlyArray<R>>>(
    async (previous, item, index) => [
      ...(await previous),
      await fn(item, index),
    ],
    Promise.resolve([]),
  );

export default inSequence;
