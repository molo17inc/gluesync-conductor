export type CollectLogsByScriptOptions = Readonly<{
  ticketId: string;
  email: string;
}>;

export type CollectLogsByScriptResult = Readonly<{
  success: boolean;
  output: string;
}>;

export type CollectLogsByScript = (
  options: CollectLogsByScriptOptions,
) => Promise<CollectLogsByScriptResult>;
