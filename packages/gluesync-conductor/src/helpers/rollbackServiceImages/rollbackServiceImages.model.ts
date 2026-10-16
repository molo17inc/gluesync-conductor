export type RollbackOutcome = Readonly<{
  id: string;
  image: string;
  ok: boolean;
  error?: string;
}>;

export type RollbackServiceImages = (
  rollbacks: ReadonlyArray<Readonly<{ id: string; image: string }>>,
  options: Readonly<{ recreate: boolean }>,
) => Promise<ReadonlyArray<RollbackOutcome>>;
