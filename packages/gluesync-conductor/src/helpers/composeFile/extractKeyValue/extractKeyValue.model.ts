import {
  ComposeServiceFieldName,
  LongPort,
  LongVolume,
} from '../../../models/composeFile.model';

// Entries are strings (`host:container`) or, for volumes and ports, objects.
export type KeyValueEntry = string | LongVolume | LongPort;

export type ExtractKeyValue = (
  separator: string,
  value?: ReadonlyArray<KeyValueEntry> | Record<string, any>,
  // Tells the long-syntax objects apart: only volumes and ports have them
  field?: ComposeServiceFieldName,
) => Partial<Record<string, string | boolean | number | null | undefined>>;

export type CastObject = <T = Record<string, any>>(
  object: Record<string, any>,
) => T;
