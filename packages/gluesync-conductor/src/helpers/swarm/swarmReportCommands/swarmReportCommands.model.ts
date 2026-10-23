export type SwarmReportCommand = Readonly<{
  cmd: string;
  args: ReadonlyArray<string>;
}>;

export type SwarmReportCommands = (
  namespace: string,
) => ReadonlyArray<SwarmReportCommand>;
