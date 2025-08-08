export const conductorLabels = ['unique_id', 'versiontag', 'type'] as const;

export type ConductorLabels = (typeof conductorLabels)[number];

export const conductorServiceTypes = ['agent', 'module'] as const;

export type ConductorServiceTypes = (typeof conductorServiceTypes)[number];
