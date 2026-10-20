/** What a container action replies with, kept so that a joined request can repeat it. */
export type ActionOutcome<Body = unknown> = Readonly<{
  statusCode: number;
  body: Body;
}>;

/** Identifies a request: the same action on the same ids is the same intent. */
export type ActionKey = Readonly<{
  action: string;
  ids: ReadonlyArray<string>;
}>;

export type RunningAction = Readonly<{
  action: string;
  ids: ReadonlyArray<string>;
  since: string;
}>;

export type GateEntry<Body> =
  /** No action was running: this request runs it. */
  | Readonly<{ kind: 'started'; outcome: Promise<ActionOutcome<Body>> }>
  /** The same action on the same ids is already running: this request gets its result. */
  | Readonly<{
      kind: 'joined';
      running: RunningAction;
      outcome: Promise<ActionOutcome<Body>>;
    }>
  /** A different action is running: the caller must refuse. */
  | Readonly<{ kind: 'busy'; running: RunningAction }>;

export type ActionGate<Body> = Readonly<{
  enter: (
    key: ActionKey,
    perform: () => Promise<ActionOutcome<Body>>,
  ) => GateEntry<Body>;
  current: () => RunningAction | undefined;
}>;
