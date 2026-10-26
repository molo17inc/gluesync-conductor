export type ComposeInspection = Readonly<{
  /** Why the text cannot be used as a compose file; null when it can. */
  problem: string | null;
  value?: Record<string, any>;
}>;

export type InspectCompose = (text: string) => ComposeInspection;
