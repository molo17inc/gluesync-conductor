// Shared by the two Windows helpers (conductor self-recreate and full-stack
// restart). Both start the helper container DETACHED: the helper stops the very
// conductor that launched it, and an attached `docker run` client dies with
// that conductor (and can pass the termination on to the helper), which left
// the stack half recreated.

// Where the kit folder is mounted inside a helper container (C: is safer for
// HCS). It exists only in the helper: it must never reach a recreated
// container's environment, so `BASE_PATH` in a helper is always the host path.
export const HELPER_KIT_DIR = 'C:/update_context';

// True for HELPER_KIT_DIR written with either separator, any case and an
// optional trailing slash: a Conductor recreated by an older helper carries it
// as its own BASE_PATH.
export const isHelperKitDir = (value: string): boolean =>
  value.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() ===
  HELPER_KIT_DIR.toLowerCase();

// Where the helper writes its log, relative to the mounted kit folder. Nobody
// streams a detached helper's output, so the file is how support reads it
// afterwards.
export const HELPER_LOG_DIR = '.conductor/helper-logs';

// Unique and recognisable in `docker ps -a`
export const helperContainerName = (prefix: string): string =>
  `${prefix}-${Date.now()}`;

export type HelperStep = Readonly<{
  label: string;
  // One PowerShell command; a failing step does not stop the next one
  command: string;
}>;

type ScriptOptions = Readonly<{
  internalPath: string; // kit folder inside the helper
  name: string; // container name, also the log file name
  // `$env:` lines and the like, run before anything is logged
  preamble: ReadonlyArray<string>;
  steps: ReadonlyArray<HelperStep>;
}>;

/**
 * The pwsh script of a helper: the preamble, then each step with its output
 * (docker-compose writes to stderr as well) and its exit code appended to
 * `<kit>/.conductor/helper-logs/<name>.log` and still printed, so `docker logs`
 * works while the helper runs. A log that cannot be written never stops a step.
 */
export const buildHelperScript = ({
  internalPath,
  name,
  preamble,
  steps,
}: ScriptOptions): string => {
  const logFile = `${internalPath}/${HELPER_LOG_DIR}/${name}.log`;
  const tee = `Tee-Object -FilePath $log -Append -ErrorAction SilentlyContinue`;

  return [
    ...preamble,
    `$log='${logFile}'`,
    `New-Item -ItemType Directory -Force -Path (Split-Path $log) -ErrorAction SilentlyContinue | Out-Null`,
    `function Log($m) { ((Get-Date -Format o) + ' [${name}] ' + $m) | ${tee} }`,
    ...steps.flatMap(({ label, command }) => [
      `Log '${label}'`,
      `${command} 2>&1 | ${tee}`,
      `Log ('${label} exit code ' + $LASTEXITCODE)`,
    ]),
  ].join('; ');
};
