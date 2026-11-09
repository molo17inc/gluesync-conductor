export type EnsureVolumeDirsOptions = Readonly<{
  // The kit directory as this process sees it (Linux); defaults to the
  // `/opt/gluesync-conductor/root-folder` the kit mounts
  rootFolder?: string;
}>;

export type EnsureVolumeDirs = (
  id: string,
  options?: EnsureVolumeDirsOptions,
) => Promise<void>;
